// 离线预模糊氛围底工具：切图时一次性把 400px 缩略图模糊并烘焙成极小 JPEG DataURL（~2-4KB）
// 避免灯箱与简报模式在每帧拖拽/缩放合成时承担 120% 全屏实时 filter: blur(92px) 的 GPU 填充税

const CACHE_LIMIT = 32
const blurCache = new Map()
const inflight = new Map()

function cacheGet(key) {
  if (!blurCache.has(key)) return undefined
  const val = blurCache.get(key)
  blurCache.delete(key)
  blurCache.set(key, val)
  return val
}

function cacheSet(key, val) {
  if (blurCache.has(key)) blurCache.delete(key)
  blurCache.set(key, val)
  while (blurCache.size > CACHE_LIMIT) {
    const oldest = blurCache.keys().next().value
    blurCache.delete(oldest)
  }
}

function loadImage(src, useCors) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.decoding = 'async'
    if (useCors) img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('ambient load error'))
    img.src = src
  })
}

/**
 * 将缩略图离线烘焙为轻量预模糊底图。
 * @param {string} src
 * @param {{ size?: number, blur?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function renderAmbientBlur(src, opts = {}) {
  if (!src) return ''
  const size = Math.max(32, Math.min(192, Number(opts.size) || 96))
  const blur = Math.max(2, Math.min(32, Number(opts.blur) || 14))
  const cacheKey = `${size}:${blur}:${src}`
  const hit = cacheGet(cacheKey)
  if (hit !== undefined) return hit
  if (inflight.has(cacheKey)) return inflight.get(cacheKey)

  const job = (async () => {
    let canvas = null
    let tiny = null
    try {
      let img
      try {
        img = await loadImage(src, true)
      } catch {
        // 某些来源不支持 CORS 时，直接降级返回原始图 URL（不阻塞显示）
        return src
      }
      if (!img.naturalWidth || !img.naturalHeight) return src

      canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      if (!ctx) return src

      // 保持与 background-size: cover 一致的裁切比例，并外扩边距消除边缘暗框
      const iw = img.naturalWidth
      const ih = img.naturalHeight
      const scale = Math.max(size / iw, size / ih)
      const dw = iw * scale
      const dh = ih * scale
      const dx = (size - dw) / 2
      const dy = (size - dh) / 2

      if ('filter' in ctx) {
        const pad = Math.ceil(blur * 1.35)
        ctx.filter = `blur(${blur}px)`
        ctx.drawImage(img, dx - pad, dy - pad, dw + pad * 2, dh + pad * 2)
        ctx.filter = 'none'
      } else {
        tiny = document.createElement('canvas')
        tiny.width = 20
        tiny.height = 20
        const tctx = tiny.getContext('2d')
        if (!tctx) return src
        tctx.imageSmoothingEnabled = true
        tctx.imageSmoothingQuality = 'low'
        tctx.drawImage(img, 0, 0, 20, 20)
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(tiny, 0, 0, size, size)
      }

      const dataUrl = canvas.toDataURL('image/jpeg', 0.72)
      if (dataUrl && dataUrl.startsWith('data:image/')) {
        cacheSet(cacheKey, dataUrl)
        return dataUrl
      }
      return src
    } catch {
      return src
    } finally {
      if (tiny) { tiny.width = 0; tiny.height = 0 }
      if (canvas) { canvas.width = 0; canvas.height = 0 }
      inflight.delete(cacheKey)
    }
  })()

  inflight.set(cacheKey, job)
  return job
}
