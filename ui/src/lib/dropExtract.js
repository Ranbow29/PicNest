import { api } from '../api'
import { extractDropUrls } from '../stores/library'

const CHUNK_BYTES = 1024 * 1024 // 1MB 分块，兼容大体积 PSD / 视频

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf)
  if (!bytes.length) return ''
  const parts = []
  const sliceLen = 0x8000
  for (let i = 0; i < bytes.length; i += sliceLen) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + sliceLen)))
  }
  return btoa(parts.join(''))
}

function readAllDirEntries(dirEntry) {
  return new Promise((resolve, reject) => {
    const reader = dirEntry.createReader()
    const out = []
    const step = () => {
      reader.readEntries(
        (batch) => {
          if (!batch || !batch.length) resolve(out)
          else {
            out.push(...batch)
            step()
          }
        },
        (err) => reject(err)
      )
    }
    step()
  })
}

function entryToFile(fileEntry) {
  return new Promise((resolve, reject) => {
    fileEntry.file(resolve, reject)
  })
}

async function stageSingleFile(batchId, relPath, file) {
  const size = Number(file.size || 0)
  if (size === 0) {
    const r = await api.stageDropChunk(batchId, relPath, false, '')
    return r?.path || null
  }
  let writtenPath = null
  for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
    const slice = file.slice(offset, Math.min(size, offset + CHUNK_BYTES))
    const buf = await slice.arrayBuffer()
    const b64 = arrayBufferToBase64(buf)
    const r = await api.stageDropChunk(batchId, relPath, offset > 0, b64)
    if (r?.path) writtenPath = r.path
  }
  return writtenPath
}

async function stageDirRecursive(batchId, relDir, dirEntry) {
  const mk = await api.stageDropMkdir(batchId, relDir)
  const dirDiskPath = mk?.path || null
  const children = await readAllDirEntries(dirEntry)
  for (const ch of children) {
    const childRel = `${relDir}/${ch.name}`
    if (ch.isDirectory) {
      await stageDirRecursive(batchId, childRel, ch)
    } else if (ch.isFile) {
      const f = await entryToFile(ch)
      await stageSingleFile(batchId, childRel, f)
    }
  }
  return dirDiskPath
}

/**
 * 同步捕获 DataTransfer（避免 await 后浏览器清空 items），并在缺少真实磁盘路径时
 * 将 WebView2 外部拖入的文件/文件夹分块落盘到临时暂存区供 importDrop 使用。
 */
export async function handleExternalDrop(e, lib, target) {
  const dt = e?.dataTransfer
  if (!dt) return

  const directPaths = [...(dt.files || [])]
    .map((f) => {
      const p = window.picrand?.getFilePath?.(f) ?? f?.path
      return typeof p === 'string' && p.trim() ? p : null
    })
    .filter(Boolean)

  const urls = extractDropUrls(dt)

  // 若环境可直接取到物理路径，直接导入无需中转
  if (directPaths.length) {
    await lib.importDrop(directPaths, target)
    return
  }

  const entries = []
  const looseFiles = []
  if (dt.items?.length) {
    for (const it of [...dt.items]) {
      if (it.kind !== 'file') continue
      const ent = it.webkitGetAsEntry?.() || null
      if (ent) entries.push(ent)
      else {
        const f = it.getAsFile?.()
        if (f) looseFiles.push(f)
      }
    }
  }
  if (!entries.length && !looseFiles.length && dt.files?.length) {
    looseFiles.push(...dt.files)
  }

  if (!entries.length && !looseFiles.length) {
    if (urls.length) await lib.importUrls(urls, target)
    return
  }

  const begin = await api.stageDropBegin()
  if (!begin?.ok || !begin.batchId) {
    if (urls.length) await lib.importUrls(urls, target)
    return
  }

  const batchId = begin.batchId
  try {
    const stagedPaths = []
    for (const ent of entries) {
      if (ent.isDirectory) {
        const dp = await stageDirRecursive(batchId, ent.name, ent)
        if (dp) stagedPaths.push(dp)
      } else if (ent.isFile) {
        const f = await entryToFile(ent)
        const fp = await stageSingleFile(batchId, ent.name || f.name, f)
        if (fp) stagedPaths.push(fp)
      }
    }
    for (const f of looseFiles) {
      const fp = await stageSingleFile(batchId, f.name, f)
      if (fp) stagedPaths.push(fp)
    }
    if (stagedPaths.length) {
      await lib.importDrop(stagedPaths, target)
    } else if (urls.length) {
      await lib.importUrls(urls, target)
    }
  } finally {
    await api.stageDropCleanup(batchId).catch?.(() => {})
  }
}
