// 邻图预解码滑窗池：看图静止 110ms 后静默预热相邻图片（N+1 / N-1 / N+2）的 2048px 预览路径、
// Chromium 异步解码（img.decode()）与离线预模糊氛围底，严格封顶 5 张控制显存。
import { api, fileUrl } from '../api'
import { isVideoPath, isTextPath, extOf } from './fileKinds'
import { renderAmbientBlur } from './ambientBlur'

export const PATH_CACHE_LIMIT = 128
export const DECODED_POOL_LIMIT = 5
export const PREFETCH_DEBOUNCE_MS = 110
export const NEIGHBOR_OFFSETS = [1, -1, 2]

const previewPathCache = new Map() // `${filePath}|${mtime}` -> previewDiskPath
const decodedPool = new Map()      // url -> HTMLImageElement
const inflightDecodes = new Map()  // url -> Promise<HTMLImageElement | null>
const urlsByFilePath = new Map()   // filePath -> Set<string>

let prefetchTimer = 0
let prefetchSeq = 0

const stats = {
  hits: 0,
  misses: 0,
}

function lruGet(map, key) {
  if (!map.has(key)) return undefined
  const val = map.get(key)
  map.delete(key)
  map.set(key, val)
  return val
}

function releaseImg(im) {
  if (!im) return
  try {
    im.onload = null
    im.onerror = null
    im.__decoded = false
    im.src = ''
  } catch {}
}

function lruSet(map, key, val, limit, onEvict) {
  if (map.has(key)) map.delete(key)
  map.set(key, val)
  while (map.size > limit) {
    const oldestKey = map.keys().next().value
    const oldestVal = map.get(oldestKey)
    map.delete(oldestKey)
    if (onEvict) onEvict(oldestKey, oldestVal)
  }
}

export function isPreviewableImage(filePath) {
  if (!filePath) return false
  if (isVideoPath(filePath) || isTextPath(filePath)) return false
  const ext = extOf(filePath)
  return ext !== '.gif' && ext !== '.svg'
}

export function getCachedPreviewPath(filePath, modifyTime = 0) {
  if (!filePath) return ''
  const key = `${filePath}|${modifyTime || 0}`
  return lruGet(previewPathCache, key) || ''
}

export function rememberPreviewPath(filePath, modifyTime = 0, previewDiskPath = '') {
  if (!filePath || !previewDiskPath) return
  const key = `${filePath}|${modifyTime || 0}`
  lruSet(previewPathCache, key, previewDiskPath, PATH_CACHE_LIMIT)
  let set = urlsByFilePath.get(filePath)
  if (!set) {
    set = new Set()
    urlsByFilePath.set(filePath, set)
  }
  set.add(fileUrl(previewDiskPath) + '?v=' + (modifyTime || 0))
}

export function getDecodedImage(url) {
  if (!url) return null
  const im = lruGet(decodedPool, url)
  if (im && im.__decoded && im.naturalWidth > 0) {
    stats.hits++
    return im
  }
  stats.misses++
  return null
}

export function decodeIntoPool(url, sourceFilePath = '') {
  if (!url) return Promise.resolve(null)
  const existing = lruGet(decodedPool, url)
  if (existing && existing.__decoded && existing.naturalWidth > 0) {
    return Promise.resolve(existing)
  }
  if (inflightDecodes.has(url)) return inflightDecodes.get(url)

  if (sourceFilePath) {
    let set = urlsByFilePath.get(sourceFilePath)
    if (!set) {
      set = new Set()
      urlsByFilePath.set(sourceFilePath, set)
    }
    set.add(url)
  }

  const job = new Promise((resolve) => {
    const im = new Image()
    im.decoding = 'async'
    im.__pooled = true
    im.__decoded = false
    im.__src = url

    const finishSuccess = () => {
      im.onload = null
      im.onerror = null
      if (!im.naturalWidth) {
        inflightDecodes.delete(url)
        resolve(null)
        return
      }
      im.__decoded = true
      lruSet(decodedPool, url, im, DECODED_POOL_LIMIT, (_evictedUrl, evictedImg) => {
        if (evictedImg !== im) releaseImg(evictedImg)
      })
      inflightDecodes.delete(url)
      resolve(im)
    }

    const finishError = () => {
      im.onload = null
      im.onerror = null
      im.__decoded = false
      inflightDecodes.delete(url)
      resolve(null)
    }

    im.onload = () => {
      if (typeof im.decode === 'function') {
        im.decode().then(finishSuccess).catch(finishSuccess)
      } else {
        finishSuccess()
      }
    }
    im.onerror = finishError
    im.src = url
  })

  inflightDecodes.set(url, job)
  return job
}

export function cancelNeighborPrefetch() {
  if (prefetchTimer) {
    clearTimeout(prefetchTimer)
    prefetchTimer = 0
  }
  prefetchSeq++
}

export function scheduleNeighborPrefetch(orderList, currentPath, lookupMeta, opts = {}) {
  cancelNeighborPrefetch()
  if (!Array.isArray(orderList) || orderList.length <= 1 || !currentPath) return
  const idx = orderList.indexOf(currentPath)
  if (idx < 0) return

  const seq = prefetchSeq
  const len = orderList.length
  const targets = []
  const seen = new Set([currentPath])
  for (const off of NEIGHBOR_OFFSETS) {
    const ni = ((idx + off) % len + len) % len
    const np = orderList[ni]
    if (np && !seen.has(np)) {
      seen.add(np)
      targets.push(np)
    }
  }
  if (!targets.length) return

  const delay = Number.isFinite(opts.delayMs) ? opts.delayMs : PREFETCH_DEBOUNCE_MS
  prefetchTimer = setTimeout(async () => {
    prefetchTimer = 0
    for (const p of targets) {
      if (seq !== prefetchSeq) return
      if (!isPreviewableImage(p)) continue
      try {
        const meta = typeof lookupMeta === 'function' ? lookupMeta(p) : null
        const mtime = meta?.modify_time || 0

        if (opts.ambient !== false && meta?.thumbnail_path && meta.thumbnail_path !== 'SKIP') {
          const thumbUrl = fileUrl(meta.thumbnail_path) + '?v=' + mtime
          renderAmbientBlur(thumbUrl, { size: 96, blur: 14 }).catch(() => {})
        }

        let previewDiskPath = getCachedPreviewPath(p, mtime)
        if (!previewDiskPath) {
          const res = await api.viewPreview(p)
          if (seq !== prefetchSeq) return
          if (!res?.ok || !res.path) continue
          previewDiskPath = res.path
          rememberPreviewPath(p, mtime, previewDiskPath)
        }

        const u = fileUrl(previewDiskPath) + '?v=' + mtime
        await decodeIntoPool(u, p)
      } catch { /* 静默：邻图预热失败不影响当前看图 */ }
    }
  }, delay)
}

export function invalidatePreviewCache(filePath) {
  if (!filePath) return
  const prefix = `${filePath}|`
  for (const k of [...previewPathCache.keys()]) {
    if (k.startsWith(prefix)) {
      previewPathCache.delete(k)
    }
  }
  const trackedUrls = urlsByFilePath.get(filePath)
  if (trackedUrls) {
    for (const u of trackedUrls) {
      const im = decodedPool.get(u)
      if (im) {
        decodedPool.delete(u)
        releaseImg(im)
      }
      inflightDecodes.delete(u)
    }
    urlsByFilePath.delete(filePath)
  }
}

export function clearDecodedPool() {
  cancelNeighborPrefetch()
  for (const im of decodedPool.values()) {
    releaseImg(im)
  }
  decodedPool.clear()
  inflightDecodes.clear()
}

export function getPreloadStats() {
  return {
    pathCacheSize: previewPathCache.size,
    decodedPoolSize: decodedPool.size,
    hits: stats.hits,
    misses: stats.misses,
  }
}
