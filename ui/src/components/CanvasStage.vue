<script setup>
// Clean-room canvas 视图：只画可视区域，不把整幅大图交给 DOM 合成。
// previewSrc 用于适配/低倍，fullSrc 在高倍按需加载；两者都失败时用 fallbackSrc。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

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

const canvasEl = ref(null)
let ctx = null
let ro = null
let raf = 0
let dpr = 1
const imgs = { preview: null, full: null, fallback: null }
const ready = { preview: false, full: false, fallback: false }
const failed = { preview: false, full: false, fallback: false }
let view = { scale: props.scale || 1, tx: props.tx || 0, ty: props.ty || 0 }

function schedule() {
  if (raf) return
  raf = requestAnimationFrame(() => { raf = 0; draw() })
}
function load(kind, src) {
  if (!src) { ready[kind] = false; return }
  if (imgs[kind]?.__src === src) return
  const im = new Image()
  im.__src = src
  im.decoding = 'async'
  im.onload = () => {
    const mark = () => { ready[kind] = true; failed[kind] = false; schedule() }
    if (im.decode) im.decode().then(mark).catch(mark)
    else mark()
  }
  im.onerror = () => { ready[kind] = false; failed[kind] = true; schedule(); maybeError() }
  imgs[kind] = im
  ready[kind] = false
  failed[kind] = false
  im.src = src
}
function maybeError() {
  const req = []
  if (props.previewSrc) req.push('preview')
  if (props.fallbackSrc) req.push('fallback')
  if (props.useFull && props.fullSrc) req.push('full')
  if (req.length && req.every((k) => failed[k])) emit('error')
}
function source() {
  if (props.useFull && ready.full) return imgs.full
  if (ready.preview) return imgs.preview
  if (ready.fallback) return imgs.fallback
  if (ready.full) return imgs.full
  return null
}
function resize() {
  const el = canvasEl.value
  if (!el) return
  dpr = window.devicePixelRatio || 1
  const w = Math.max(1, Math.round(el.clientWidth * dpr))
  const h = Math.max(1, Math.round(el.clientHeight * dpr))
  if (el.width !== w || el.height !== h) {
    el.width = w
    el.height = h
  }
  ctx = el.getContext('2d')
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  schedule()
}
function drawAt(tx, ty, scale) {
  view.tx = tx
  view.ty = ty
  if (Number.isFinite(scale)) view.scale = scale
  schedule()
}
function draw() {
  const el = canvasEl.value
  if (!el || !ctx) return
  const W = el.clientWidth
  const H = el.clientHeight
  ctx.clearRect(0, 0, W, H)
  const img = source()
  if (!img || !img.naturalWidth || !img.naturalHeight) return
  const mw = props.width || img.naturalWidth
  const mh = props.height || img.naturalHeight
  // 防御检查：旋转或裁剪后，如果缓存纹理的宽高比与目标宽高比严重冲突（例如横竖颠倒），
  // 坚决不执行拉伸错位绘制，等待新朝向纹理载入完成
  if (img.naturalWidth && img.naturalHeight && mw && mh) {
    const naturalRatio = img.naturalWidth / img.naturalHeight
    const targetRatio = mw / mh
    if (Math.abs(naturalRatio - targetRatio) > 0.08) return
  }
  let sc = view.scale || 1
  if (props.fitMode) sc *= Math.min(1, W / mw, H / mh)
  if (!(sc > 0)) return
  const dw = mw * sc
  const dh = mh * sc
  const dx = W / 2 + (view.tx || 0) - dw / 2
  const dy = H / 2 + (view.ty || 0) - dh / 2
  const left = Math.max(0, dx)
  const top = Math.max(0, dy)
  const right = Math.min(W, dx + dw)
  const bottom = Math.min(H, dy + dh)
  if (right <= left || bottom <= top) return
  const sx = (left - dx) / sc
  const sy = (top - dy) / sc
  const sw = (right - left) / sc
  const sh = (bottom - top) / sc
  const kx = img.naturalWidth / mw
  const ky = img.naturalHeight / mh
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, sx * kx, sy * ky, sw * kx, sh * ky, left, top, right - left, bottom - top)
}

watch(() => [props.previewSrc, props.fallbackSrc], ([p, f]) => {
  load('preview', p)
  load('fallback', f)
}, { immediate: true })
watch(() => props.fullSrc, (s) => {
  if (s && props.useFull) load('full', s)
}, { immediate: true })
watch(() => props.useFull, (u) => {
  if (u && props.fullSrc) load('full', props.fullSrc)
})
watch(() => [props.scale, props.tx, props.ty], ([s, x, y]) => {
  view.scale = s ?? 1
  view.tx = x ?? 0
  view.ty = y ?? 0
  schedule()
})
watch(() => [props.width, props.height], () => schedule())

onMounted(() => {
  resize()
  try {
    ro = new ResizeObserver(resize)
    if (canvasEl.value) ro.observe(canvasEl.value)
  } catch { /* 老内核无 RO */ }
  window.addEventListener('resize', resize)
})
onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
  ro?.disconnect()
  ro = null
  window.removeEventListener('resize', resize)
})
defineExpose({ drawAt })
</script>

<template>
  <canvas ref="canvasEl" class="canvas-stage" aria-hidden="true" />
</template>

<style scoped>
.canvas-stage {
  position: absolute; inset: 0; width: 100%; height: 100%;
  display: block; pointer-events: none; user-select: none;
}
</style>
