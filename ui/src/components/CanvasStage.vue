<script setup>
// 双轨零重绘舞台：
// 1. 常规/2048 预览及 <=3200 原图：直接驱动独立 GPU 合成层 <img>（translate3d + scale，0 重绘）
// 2. 超大图（>3200px）高倍放大：Overscan 缓冲 Canvas + GPU 平移缩放，仅拖出 320px 缓冲区或静止锐化时重绘
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getDecodedImage, decodeIntoPool } from '../lib/previewPreload'

const props = defineProps({
  previewSrc: { type: String, default: '' },
  fullSrc: { type: String, default: '' },
  fallbackSrc: { type: String, default: '' },
  width: { type: Number, default: 0 },
  height: { type: Number, default: 0 },
  scale: { type: Number, default: 1 },
  tx: { type: Number, default: 0 },
  ty: { type: Number, default: 0 },
  useFull: { type: Boolean, default: false },
  fitMode: { type: Boolean, default: false },
})
const emit = defineEmits(['error'])

const OVERSCAN_THRESHOLD = 3200
const PAD = 320
const MAX_CANVAS_DIM = 6144
const FULL_RELEASE_MS = 2500

const stageEl = ref(null)
const gpuImgEl = ref(null)
const canvasEl = ref(null)

let ctx = null
let ro = null
let stageW = 0
let stageH = 0
let dpr = 1
let interactive = false
let refineTimer = 0
let fullReleaseTimer = 0

const imgs = { preview: null, full: null, fallback: null }
const ready = { preview: false, full: false, fallback: false }
const failed = { preview: false, full: false, fallback: false }
const loadSrc = { preview: '', full: '', fallback: '' }
const view = { scale: props.scale || 1, tx: props.tx || 0, ty: props.ty || 0 }

let lastMode = '' // '' | 'gpu' | 'overscan'
let lastGpuSrc = ''
let lastGpuW = 0
let lastGpuH = 0
let gpuVisible = false
let overscanVisible = false

const painted = {
  valid: false,
  tx: 0,
  ty: 0,
  scale: 1,
  mw: 0,
  mh: 0,
  src: '',
  high: false,
}

const perfStats = {
  lastMs: 0,
  zeroRepaint: true,
  repaints: 0,
  moves: 0,
  mode: 'gpu',
}

function clearImg(kind) {
  loadSrc[kind] = ''
  const old = imgs[kind]
  if (old && !old.__pooled) {
    old.onload = null
    old.onerror = null
    old.src = ''
  }
  imgs[kind] = null
  ready[kind] = false
}

function load(kind, src) {
  if (!src) {
    clearImg(kind)
    syncView()
    return
  }
  if (loadSrc[kind] === src && (ready[kind] || !failed[kind])) return
  loadSrc[kind] = src

  if (kind === 'preview') {
    const pooled = getDecodedImage(src)
    if (pooled) {
      const old = imgs.preview
      if (old && !old.__pooled) {
        old.onload = null
        old.onerror = null
        old.src = ''
      }
      imgs.preview = pooled
      ready.preview = true
      failed.preview = false
      syncView()
      return
    }
    const old = imgs.preview
    if (old && !old.__pooled) {
      old.onload = null
      old.onerror = null
      old.src = ''
    }
    imgs.preview = null
    ready.preview = false
    failed.preview = false
    decodeIntoPool(src).then((im) => {
      if (loadSrc.preview !== src) return
      if (im) {
        imgs.preview = im
        ready.preview = true
        failed.preview = false
        syncView()
      } else {
        imgs.preview = null
        ready.preview = false
        failed.preview = true
        syncView()
        maybeError()
      }
    })
    return
  }

  const old = imgs[kind]
  if (old && !old.__pooled) {
    old.onload = null
    old.onerror = null
    old.src = ''
  }
  const im = new Image()
  im.__src = src
  im.decoding = 'async'
  im.onload = () => {
    if (imgs[kind] !== im) return
    const mark = () => {
      if (imgs[kind] !== im) return
      ready[kind] = true
      failed[kind] = false
      syncView()
    }
    if (im.decode) im.decode().then(mark).catch(mark)
    else mark()
  }
  im.onerror = () => {
    if (imgs[kind] !== im) return
    ready[kind] = false
    failed[kind] = true
    syncView()
    maybeError()
  }
  imgs[kind] = im
  ready[kind] = false
  failed[kind] = false
  im.src = src
}

function maybeError() {
  if (failed.preview && props.fullSrc && !imgs.full && !failed.full) {
    load('full', props.fullSrc)
    return
  }
  const req = []
  if (props.previewSrc) req.push('preview')
  if (props.fallbackSrc) req.push('fallback')
  if (props.fullSrc) req.push('full')
  if (req.length && req.every((k) => failed[k])) emit('error')
}

function pickSource() {
  if (props.useFull && ready.full) return imgs.full
  if (ready.preview) return imgs.preview
  if (ready.fallback) return imgs.fallback
  if (ready.full) return imgs.full
  return null
}

function shouldUseOverscan(img) {
  if (!props.useFull || !img || img !== imgs.full || !ready.full) return false
  return Math.max(img.naturalWidth || 0, img.naturalHeight || 0) > OVERSCAN_THRESHOLD
}

function scheduleRefine(delay = 85) {
  if (refineTimer) clearTimeout(refineTimer)
  refineTimer = setTimeout(() => {
    refineTimer = 0
    const img = pickSource()
    if (!shouldUseOverscan(img)) return
    const mw = props.width || img.naturalWidth
    const mh = props.height || img.naturalHeight
    const effScale = computeEffScale(mw, mh)
    if (!(effScale > 0)) return
    if (
      !painted.valid
      || !painted.high
      || Math.abs(view.tx - painted.tx) > 0.5
      || Math.abs(view.ty - painted.ty) > 0.5
      || Math.abs(effScale - painted.scale) > 1e-4
    ) {
      paintOverscan(img, mw, mh, effScale, 'high')
    }
  }, delay)
}

function computeEffScale(mw, mh) {
  let sc = view.scale || 1
  if (props.fitMode && stageW > 0 && stageH > 0 && mw > 0 && mh > 0) {
    sc *= Math.min(1, stageW / mw, stageH / mh)
  }
  return sc
}

function setGpuVisible(show) {
  const el = gpuImgEl.value
  if (!el || gpuVisible === show) return
  gpuVisible = show
  el.style.visibility = show ? 'visible' : 'hidden'
}

function setOverscanVisible(show) {
  const el = canvasEl.value
  if (!el || overscanVisible === show) return
  overscanVisible = show
  el.style.visibility = show ? 'visible' : 'hidden'
  if (!show) {
    el.style.transform = 'translate3d(0px, 0px, 0)'
    painted.valid = false
    if (el.width || el.height) {
      el.width = 0
      el.height = 0
    }
    ctx = null
  }
}

function ensureOverscanBacking() {
  const el = canvasEl.value
  if (!el || stageW <= 0 || stageH <= 0) return false
  const CW = stageW + PAD * 2
  const CH = stageH + PAD * 2
  const effDpr = Math.min(dpr, MAX_CANVAS_DIM / CW, MAX_CANVAS_DIM / CH)
  const pw = Math.max(1, Math.round(CW * effDpr))
  const ph = Math.max(1, Math.round(CH * effDpr))
  if (el.width !== pw || el.height !== ph || !ctx) {
    el.width = pw
    el.height = ph
    ctx = el.getContext('2d')
    painted.valid = false
  }
  if (!ctx) return false
  ctx.setTransform(effDpr, 0, 0, effDpr, 0, 0)
  return true
}

function paintOverscan(img, mw, mh, effScale, quality) {
  const el = canvasEl.value
  if (!el || !ensureOverscanBacking()) return
  const CW = stageW + PAD * 2
  const CH = stageH + PAD * 2

  ctx.clearRect(0, 0, CW, CH)
  const dw = mw * effScale
  const dh = mh * effScale
  const dx = stageW / 2 + PAD + (view.tx || 0) - dw / 2
  const dy = stageH / 2 + PAD + (view.ty || 0) - dh / 2
  const left = Math.max(0, dx)
  const top = Math.max(0, dy)
  const right = Math.min(CW, dx + dw)
  const bottom = Math.min(CH, dy + dh)

  if (right > left && bottom > top) {
    const sx = (left - dx) / effScale
    const sy = (top - dy) / effScale
    const sw = (right - left) / effScale
    const sh = (bottom - top) / effScale
    const kx = img.naturalWidth / mw
    const ky = img.naturalHeight / mh
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = quality === 'high' ? 'high' : 'low'
    ctx.drawImage(img, sx * kx, sy * ky, sw * kx, sh * ky, left, top, right - left, bottom - top)
  }

  el.style.transform = 'translate3d(0px, 0px, 0)'
  painted.valid = true
  painted.tx = view.tx || 0
  painted.ty = view.ty || 0
  painted.scale = effScale
  painted.mw = mw
  painted.mh = mh
  painted.src = img.__src || ''
  painted.high = quality === 'high'
  perfStats.repaints++
  perfStats.zeroRepaint = false
}

function syncView() {
  const t0 = performance.now()
  if (!stageW || !stageH) {
    const el = stageEl.value
    if (el) {
      stageW = el.clientWidth
      stageH = el.clientHeight
      dpr = window.devicePixelRatio || 1
    }
  }
  if (stageW <= 0 || stageH <= 0) return

  const img = pickSource()
  if (!img || !img.naturalWidth || !img.naturalHeight) {
    setGpuVisible(false)
    setOverscanVisible(false)
    return
  }

  const mw = props.width || img.naturalWidth
  const mh = props.height || img.naturalHeight
  // 防御检查：旋转或裁剪过渡期宽高比冲突时不错位拉伸
  if (img.naturalWidth && img.naturalHeight && mw && mh) {
    const naturalRatio = img.naturalWidth / img.naturalHeight
    const targetRatio = mw / mh
    if (Math.abs(naturalRatio - targetRatio) > 0.08) {
      setGpuVisible(false)
      setOverscanVisible(false)
      return
    }
  }

  const effScale = computeEffScale(mw, mh)
  if (!(effScale > 0)) return

  if (shouldUseOverscan(img)) {
    lastMode = 'overscan'
    perfStats.mode = 'overscan'
    setGpuVisible(false)
    setOverscanVisible(true)
    const el = canvasEl.value
    const src = img.__src || ''

    const sameSurface = painted.valid
      && painted.src === src
      && painted.mw === mw
      && painted.mh === mh

    if (sameSurface && Math.abs(effScale - painted.scale) < 1e-6) {
      const offX = (view.tx || 0) - painted.tx
      const offY = (view.ty || 0) - painted.ty
      if (Math.abs(offX) <= PAD - 24 && Math.abs(offY) <= PAD - 24) {
        el.style.transform = `translate3d(${offX}px, ${offY}px, 0)`
        perfStats.zeroRepaint = true
        if (!interactive && !painted.high) scheduleRefine(50)
      } else {
        paintOverscan(img, mw, mh, effScale, interactive ? 'low' : 'high')
        if (interactive) scheduleRefine(90)
      }
    } else if (sameSurface) {
      const ratio = effScale / painted.scale
      const cx = (view.tx || 0) - painted.tx * ratio
      const cy = (view.ty || 0) - painted.ty * ratio
      if (ratio > 1.85 || ratio < 0.52) {
        paintOverscan(img, mw, mh, effScale, 'low')
        scheduleRefine(75)
      } else {
        el.style.transform = `translate3d(${cx}px, ${cy}px, 0) scale(${ratio})`
        perfStats.zeroRepaint = true
        scheduleRefine(75)
      }
    } else {
      paintOverscan(img, mw, mh, effScale, interactive ? 'low' : 'high')
      if (interactive) scheduleRefine(85)
    }
  } else {
    lastMode = 'gpu'
    perfStats.mode = 'gpu'
    if (refineTimer) {
      clearTimeout(refineTimer)
      refineTimer = 0
    }
    setOverscanVisible(false)
    const g = gpuImgEl.value
    if (g) {
      const src = img.__src || ''
      if (lastGpuSrc !== src) {
        lastGpuSrc = src
        g.src = src
      }
      if (lastGpuW !== mw || lastGpuH !== mh) {
        lastGpuW = mw
        lastGpuH = mh
        g.style.width = `${mw}px`
        g.style.height = `${mh}px`
        g.style.marginLeft = `${-mw / 2}px`
        g.style.marginTop = `${-mh / 2}px`
      }
      g.style.transform = `translate3d(${view.tx || 0}px, ${view.ty || 0}px, 0) scale(${effScale})`
      setGpuVisible(true)
    }
    perfStats.zeroRepaint = true
  }

  perfStats.moves++
  perfStats.lastMs = +(performance.now() - t0).toFixed(3)
}

function resize() {
  const el = stageEl.value
  if (!el) return
  dpr = window.devicePixelRatio || 1
  const w = el.clientWidth
  const h = el.clientHeight
  if (w !== stageW || h !== stageH) {
    stageW = w
    stageH = h
    painted.valid = false
  }
  syncView()
}

function drawAt(tx, ty, scale) {
  view.tx = tx
  view.ty = ty
  if (Number.isFinite(scale)) view.scale = scale
  syncView()
}

function setInteractive(active) {
  const next = !!active
  if (interactive === next) return
  interactive = next
  if (!next && lastMode === 'overscan' && !painted.high) {
    scheduleRefine(40)
  }
}

function getPerfStats() {
  return { ...perfStats }
}

watch(() => [props.previewSrc, props.fallbackSrc], ([p, f], oldVal) => {
  if (oldVal && (oldVal[0] !== p || oldVal[1] !== f)) {
    if (oldVal[0] !== p && (!p || !getDecodedImage(p))) clearImg('preview')
    if (oldVal[1] !== f) clearImg('fallback')
    painted.valid = false
  }
  load('preview', p)
  load('fallback', f)
  syncView()
}, { immediate: true })

watch(() => props.fullSrc, (s, oldS) => {
  if (fullReleaseTimer) {
    clearTimeout(fullReleaseTimer)
    fullReleaseTimer = 0
  }
  if (oldS && oldS !== s) {
    clearImg('full')
    painted.valid = false
  }
  if (s && props.useFull) load('full', s)
  syncView()
}, { immediate: true })

watch(() => props.useFull, (u) => {
  if (fullReleaseTimer) {
    clearTimeout(fullReleaseTimer)
    fullReleaseTimer = 0
  }
  if (u && props.fullSrc) {
    load('full', props.fullSrc)
    syncView()
  } else if (!u && imgs.full) {
    // 滞回释放：缩回窗口尺寸时延迟 2.5s 再卸载巨图位图，避免临界倍率反复推拉时二次解码卡顿
    syncView()
    fullReleaseTimer = setTimeout(() => {
      fullReleaseTimer = 0
      if (!props.useFull && imgs.full) {
        clearImg('full')
        painted.valid = false
        syncView()
      }
    }, FULL_RELEASE_MS)
  } else {
    syncView()
  }
})

watch(() => [props.scale, props.tx, props.ty], ([s, x, y]) => {
  view.scale = s ?? 1
  view.tx = x ?? 0
  view.ty = y ?? 0
  syncView()
})

watch(() => [props.width, props.height], () => {
  painted.valid = false
  syncView()
})

onMounted(() => {
  resize()
  try {
    ro = new ResizeObserver(resize)
    if (stageEl.value) ro.observe(stageEl.value)
  } catch { /* 老内核无 RO */ }
  window.addEventListener('resize', resize)
})

onBeforeUnmount(() => {
  if (refineTimer) { clearTimeout(refineTimer); refineTimer = 0 }
  if (fullReleaseTimer) { clearTimeout(fullReleaseTimer); fullReleaseTimer = 0 }
  ro?.disconnect()
  ro = null
  window.removeEventListener('resize', resize)
  if (canvasEl.value) {
    canvasEl.value.width = 0
    canvasEl.value.height = 0
  }
  if (gpuImgEl.value) {
    gpuImgEl.value.src = ''
  }
  clearImg('preview')
  clearImg('full')
  clearImg('fallback')
  ctx = null
})

defineExpose({ drawAt, setInteractive, getPerfStats })
</script>

<template>
  <div ref="stageEl" class="canvas-stage" aria-hidden="true">
    <img ref="gpuImgEl" class="gpu-img" draggable="false" alt="" />
    <canvas ref="canvasEl" class="overscan-canvas" />
  </div>
</template>

<style scoped>
.canvas-stage {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  user-select: none;
  contain: layout style paint;
}
.gpu-img {
  position: absolute;
  left: 50%;
  top: 50%;
  display: block;
  max-width: none;
  max-height: none;
  transform-origin: center center;
  will-change: transform;
  backface-visibility: hidden;
  pointer-events: none;
  user-select: none;
  visibility: hidden;
}
.overscan-canvas {
  position: absolute;
  left: -320px;
  top: -320px;
  width: calc(100% + 640px);
  height: calc(100% + 640px);
  display: block;
  transform-origin: center center;
  will-change: transform;
  backface-visibility: hidden;
  pointer-events: none;
  user-select: none;
  visibility: hidden;
}
</style>
