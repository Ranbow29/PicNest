#!/usr/bin/env node
// Eagle 库 → PicNest 文件夹树迁移（默认 dry-run；--apply 才写文件）
// 不修改 Eagle 原库；目标根名默认取 <library>.library 去掉 .library。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const argv = process.argv.slice(2)
const has = (k) => argv.includes('--' + k)
const val = (k, def) => {
  const i = argv.indexOf('--' + k)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}
const APPLY = has('apply')
const JSON_ONLY = has('json')
const DRY = !APPLY
const settingsPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Eagle', 'Settings')
function detectLibrary() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    if (s.rootDir) return s.rootDir
    if (s.libraryHistory?.[0]) return s.libraryHistory[0]
  } catch (e) {}
  return ''
}
const LIB = path.resolve(val('library', detectLibrary()))
if (!LIB || !fs.existsSync(LIB)) {
  console.error('找不到 Eagle 库，请用 --library 指定 .library 目录')
  process.exit(2)
}
const metaPath = path.join(LIB, 'metadata.json')
const imagesDir = path.join(LIB, 'images')
if (!fs.existsSync(metaPath) || !fs.existsSync(imagesDir)) {
  console.error('不是有效的 Eagle 库（缺 metadata.json 或 images/）：' + LIB)
  process.exit(2)
}
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
const libName = path.basename(LIB).replace(/\.library$/i, '') || 'Eagle'
const targetBase = path.resolve(val('target-base', path.join(process.cwd(), 'PicNestMigration')))
const targetRoot = path.resolve(val('target', path.join(targetBase, libName)))
const manifestPath = path.resolve(val('manifest', targetRoot + '.manifest.json'))
const supported = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'tif', 'tiff', 'svg', 'txt', 'md', 'markdown', 'log', 'json', 'jsonc', 'csv', 'tsv', 'ini', 'cfg', 'conf', 'yaml', 'yml', 'mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'])

function hash(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8)
}
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
function safeName(raw, max = 80) {
  let s = String(raw || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '')
  if (!s) s = '_'
  if (RESERVED.test(s)) s = '_' + s
  if (s.length > max) s = s.slice(0, max - 10) + '~' + hash(s)
  return s
}
function safeFile(raw, ext) {
  let base = String(raw || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '')
  if (!base) base = '_'
  if (RESERVED.test(base)) base = '_' + base
  if (base.length > 150) base = base.slice(0, 140) + '~' + hash(base)
  return base + (ext || '')
}

// 1) Eagle 文件夹树 → 目标 rel（清理非法字符并处理同级重名）
const folderById = new Map()
const usedTop = new Set()
const targetDirs = new Set()
function walkFolders(nodes, parentRel) {
  const used = new Set()
  for (const n of nodes || []) {
    const base = safeName(n.name, 80)
    let name = base
    let k = 2
    while (used.has(name.toLowerCase())) name = `${base} (${k++})`
    used.add(name.toLowerCase())
    const rel = parentRel ? parentRel + '/' + name : name
    if (!parentRel) usedTop.add(name.toLowerCase())
    folderById.set(n.id, rel)
    targetDirs.add(rel)
    walkFolders(n.children, rel)
  }
}
walkFolders(meta.folders, '')
function uniqueTop(base) {
  let name = base
  let k = 2
  while (usedTop.has(name.toLowerCase())) name = `${base} (${k++})`
  usedTop.add(name.toLowerCase())
  return name
}
const unfiledRel = uniqueTop('_未分类')
const orphanRel = unfiledRel + '/' + safeName('失效文件夹', 80)
targetDirs.add(unfiledRel)
targetDirs.add(orphanRel)

// 2) 逐项生成目标路径
const dirs = fs.readdirSync(imagesDir).filter((d) => d.endsWith('.info'))
const usedPaths = new Set()
const items = []
let skippedDeleted = 0, missingSource = 0, multiFolder = 0, multiPartial = 0, unfiled = 0, orphan = 0
let tagItems = 0, urlItems = 0, annotationItems = 0, ratingItems = 0
const uniqueTags = new Set()
let conflictCount = 0, unsupportedCount = 0, sourceBytes = 0, targetCopies = 0
let missingFolderRefs = 0

for (const infoName of dirs) {
  const itemDir = path.join(imagesDir, infoName)
  let m
  try { m = JSON.parse(fs.readFileSync(path.join(itemDir, 'metadata.json'), 'utf8')) } catch (e) { continue }
  if (m.isDeleted) { skippedDeleted++; continue }
  let entries
  try {
    entries = fs.readdirSync(itemDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name !== 'metadata.json' && !/_thumbnail\.[^.]+$/i.test(e.name) && !e.name.startsWith('.'))
  } catch (e) { entries = [] }
  const ext = String(m.ext || '').toLowerCase()
  const srcEntry = entries.find((e) => path.extname(e.name).slice(1).toLowerCase() === ext) || entries[0]
  if (!srcEntry) { missingSource++; continue }
  const srcPath = path.join(itemDir, srcEntry.name)
  const srcExt = path.extname(srcEntry.name)
  const st = fs.statSync(srcPath)
  sourceBytes += st.size
  let base = String(m.name || path.basename(srcEntry.name, srcExt)).trim()
  if (srcExt && base.toLowerCase().endsWith(srcExt.toLowerCase())) base = base.slice(0, -srcExt.length)
  const fileName = safeFile(base, srcExt)
  const ids = Array.isArray(m.folders) ? m.folders : []
  const known = ids.map((id) => folderById.get(id)).filter(Boolean)
  const unknown = ids.filter((id) => !folderById.has(id))
  if (unknown.length) missingFolderRefs += unknown.length
  let rels = known
  if (!rels.length) {
    if (ids.length) { rels = [orphanRel]; orphan++ }
    else { rels = [unfiledRel]; unfiled++ }
  }
  if (rels.length > 1) multiFolder++
  if (known.length && unknown.length) multiPartial++
  const targets = []
  for (const rel of rels) {
    const dir = path.join(targetRoot, rel.split('/').join(path.sep))
    const extPart = path.extname(fileName)
    const stem = extPart ? fileName.slice(0, -extPart.length) : fileName
    let candidate = fileName
    let n = 2
    let conflicted = false
    while (usedPaths.has(path.join(dir, candidate).toLowerCase())) {
      candidate = `${stem} (${n++})${extPart}`
      conflicted = true
    }
    if (conflicted) conflictCount++
    usedPaths.add(path.join(dir, candidate).toLowerCase())
    targets.push({ rel, file: candidate, path: path.join(dir, candidate) })
    targetCopies++
  }
  const fileExt = srcExt.slice(1).toLowerCase()
  const isSupported = supported.has(fileExt)
  if (!isSupported) unsupportedCount++
  const itemTags = Array.isArray(m.tags) ? m.tags : []
  if (itemTags.length) tagItems++
  for (const t of itemTags) uniqueTags.add(String(t))
  if (m.url) urlItems++
  if (m.annotation) annotationItems++
  if (m.star) ratingItems++
  items.push({
    id: m.id, name: m.name, ext: m.ext, size: st.size, width: m.width, height: m.height,
    tags: itemTags, url: m.url || '', annotation: m.annotation || '', star: m.star || 0,
    source: srcPath, targets, supported: isSupported,
  })
}

const bytesPerCopy = items.reduce((s, it) => s + it.size * it.targets.length, 0)
function freeBytes(p) {
  let cur = path.resolve(p)
  while (!fs.existsSync(cur) && path.dirname(cur) !== cur) cur = path.dirname(cur)
  try { const s = fs.statfsSync(cur); return s.bavail * s.bsize } catch (e) { return 0 }
}
const free = freeBytes(targetBase)
const exists = fs.existsSync(targetRoot)
const summary = {
  mode: APPLY ? 'apply' : 'dry-run',
  library: LIB,
  targetRoot,
  manifestPath,
  libraryName: libName,
  items: items.length,
  skippedDeleted,
  missingSource,
  targetCopies,
  sourceBytes,
  copyBytes: bytesPerCopy,
  sourceGB: +(sourceBytes / 1073741824).toFixed(2),
  copyGB: +(bytesPerCopy / 1073741824).toFixed(2),
  freeGB: +(free / 1073741824).toFixed(1),
  folders: folderById.size,
  targetDirs: targetDirs.size,
  multiFolder,
  multiPartial,
  unfiled,
  orphan,
  missingFolderRefs,
  conflicts: conflictCount,
  unsupported: unsupportedCount,
  tagItems,
  urlItems,
  annotationItems,
  ratingItems,
  uniqueTags: uniqueTags.size,
  targetExists: exists,
}
console.log(JSON.stringify(summary, null, 1))
if (JSON_ONLY) process.exit(0)

if (DRY) {
  const byExt = new Map()
  for (const it of items) { const e = String(it.ext || '').toLowerCase(); byExt.set(e, (byExt.get(e) || 0) + 1) }
  console.log('exts', JSON.stringify([...byExt.entries()].sort((a, b) => b[1] - a[1])))
  console.log('sample targets:')
  for (const it of items.slice(0, 5)) console.log(' ', it.name, '->', it.targets.map((t) => t.rel + '/' + t.file).join(' | '))
  console.log('dry-run only. Re-run with --apply to copy files.')
  process.exit(0)
}

if (exists) {
  const content = fs.readdirSync(targetRoot)
  if (content.length) {
    console.error('目标目录已存在且非空，拒绝覆盖：' + targetRoot)
    process.exit(3)
  }
}
if (free < bytesPerCopy + 2 * 1024 * 1024 * 1024) {
  console.error(`目标磁盘空间不足：需要 ${summary.copyGB} GB，可用 ${summary.freeGB} GB`)
  process.exit(4)
}

fs.mkdirSync(targetRoot, { recursive: true })
for (const rel of targetDirs) fs.mkdirSync(path.join(targetRoot, rel.split('/').join(path.sep)), { recursive: true })

const jobs = []
for (const it of items) for (const t of it.targets) jobs.push({ src: it.source, dst: t.path, size: it.size })
let next = 0, done = 0, filesCopied = 0, bytesCopied = 0
const failures = []
const t0 = Date.now()
async function worker() {
  while (true) {
    const i = next++
    if (i >= jobs.length) return
    const j = jobs[i]
    try {
      await fsp.copyFile(j.src, j.dst, fs.constants.COPYFILE_EXCL)
      const st = await fsp.stat(j.src)
      await fsp.utimes(j.dst, st.atime, st.mtime).catch(() => {})
      filesCopied++
      bytesCopied += j.size
      done++
      if (done % 200 === 0 || done === jobs.length) {
        const sec = (Date.now() - t0) / 1000
        console.log(`copied ${done}/${jobs.length} · ${(bytesCopied / 1073741824).toFixed(2)} GB · ${sec.toFixed(0)}s`)
      }
    } catch (e) {
      failures.push({ src: j.src, dst: j.dst, error: String(e?.message || e) })
      done++
    }
  }
}
await Promise.all(Array.from({ length: 4 }, worker))
const manifest = {
  version: 1,
  sourceLibrary: LIB,
  sourceLibraryName: libName,
  targetRoot,
  createdAt: new Date().toISOString(),
  folders: Object.fromEntries(folderById),
  unfiledRel,
  orphanRel,
  items,
  failures,
}
fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1))
console.log(JSON.stringify({
  ...summary,
  mode: 'apply',
  copied: filesCopied,
  bytesCopied,
  failed: failures.length,
  elapsedSec: Math.round((Date.now() - t0) / 1000),
  manifestPath,
}, null, 1))
if (failures.length) process.exit(5)
