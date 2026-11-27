<script setup>
// 简报模式：全屏黑底演示（Eagle 语义）——单击下一张 / 右键菜单 / 滚轮缩放 / 拖拽平移 / ←→ / Esc 退出
// 视频全屏增强：视频上点击播放/暂停，视频外点击下一张，底部自动隐藏高质感播放控制栏，默认循环，支持快进退与倍速
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useLibrary } from '../stores/library'
import { fileUrl, api } from '../api'
import { isTextPath, isVideoPath, extOf } from '../lib/fileKinds'
import { renderAmbientBlur } from '../lib/ambientBlur'
import {
  isPreviewableImage,
  getCachedPreviewPath,
  rememberPreviewPath,
  decodeIntoPool,
  scheduleNeighborPrefetch,
  cancelNeighborPrefetch,
  clearDecodedPool,
  getPreloadStats,
} from '../lib/previewPreload'
import CanvasStage from './CanvasStage.vue'

const lib = useLibrary()
const videoCompatPath = ref('')
const url = computed(() => {
  const p = videoCompatPath.value || lib.brief.path
  return p ? fileUrl(p) : ''
})
let compatReqPath = ''
async function onVideoError() {
  const p = lib.brief.path
  if (!p || compatReqPath === p || videoCompatPath.value) return
  compatReqPath = p
  try {
    const r = await api.videoCompat(p)
    if (lib.brief.path === p && r?.ok && r.path) {
      videoCompatPath.value = r.path
      nextTick(() => { videoEl.value?.play?.().catch(() => {}) })
    }
  } catch { /* 静默 */ }
}
const kind = computed(() => {
  const p = lib.brief.path
  return isVideoPath(p) ? 'video' : isTextPath(p) ? 'text' : 'image'
})
const meta = computed(() => lib.images.find((i) => i.file_path === lib.brief.path) || null)
const isPsd = computed(() => extOf(lib.brief.path) === '.psd')
const orderList = computed(() => (lib.gridOrder?.length ? lib.gridOrder : lib.filteredImages.map((i) => i.file_path)))
const idx = computed(() => Math.max(0, orderList.value.indexOf(lib.brief.path)))
const briefEl = ref(null)
const mediaEl = ref(null)
const videoEl = ref(null)
const canvasStage = ref(null)
const psdFull = ref('')
const psdLoading = ref(false)
const psdError = ref('')
const imgDead = ref(false)
const previewPath = ref('')
const previewError = ref(false)

/* 视频播放状态与控制（默认循环播放，保留用户音量记忆） */
const vid = reactive({
  playing: true,
  cur: 0,
  dur: 0,
  volume: Number(localStorage.getItem('picnest.briefVolume') ?? 1),
  muted: localStorage.getItem('picnest.briefMuted') === '1',
  rate: 1.0,
  loop: true,
})
const showRateMenu = ref(false)
const rateOptions = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]
const isSeeking = ref(false)
const seekProgress = ref(0)
const bottomHover = ref(false)

function onVideoMeta(e) {
  const v = e.target
  vid.dur = v.duration || 0
  v.volume = vid.volume
  v.muted = vid.muted
  v.playbackRate = vid.rate
  v.loop = vid.loop
  if (vid.playing) {
    v.play().catch(() => { vid.playing = false })
  }
  nextTick(syncMediaTransform)
}
function onVideoTime(e) {
  if (pan.active) return // 拖拽平移中不触发响应式更新，防止 Vue diff 把正在平移的视频重置回起点
  if (!isSeeking.value) {
    vid.cur = e.target.currentTime || 0
  }
}
function togglePlay() {
  const v = videoEl.value
  if (!v) return
  if (v.paused) {
    v.play().then(() => { vid.playing = true }).catch(() => {})
  } else {
    v.pause()
    vid.playing = false
  }
}
function stepTime(sec) {
  const v = videoEl.value
  if (!v) return
  v.currentTime = Math.max(0, Math.min(vid.dur || 0, (v.currentTime || 0) + sec))
  vid.cur = v.currentTime
}
function setPlaybackRate(r) {
  vid.rate = r
  if (videoEl.value) videoEl.value.playbackRate = r
  showRateMenu.value = false
}
function toggleLoop() {
  vid.loop = !vid.loop
  if (videoEl.value) videoEl.value.loop = vid.loop
}
function toggleMute() {
  vid.muted = !vid.muted
  if (videoEl.value) videoEl.value.muted = vid.muted
  localStorage.setItem('picnest.briefMuted', vid.muted ? '1' : '0')
}
function onVolumeInput(e) {
  const val = Number(e.target.value)
  vid.volume = val
  vid.muted = val === 0
  if (videoEl.value) {
    videoEl.value.volume = val
    videoEl.value.muted = vid.muted
  }
  localStorage.setItem('picnest.briefVolume', String(val))
  localStorage.setItem('picnest.briefMuted', vid.muted ? '1' : '0')
}
function formatTime(s) {
  if (!s || isNaN(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

function onSeekDown(e) {
  if (e.button !== 0) return
  isSeeking.value = true
  updateSeek(e)
  window.addEventListener('pointermove', onSeekMove)
  window.addEventListener('pointerup', onSeekUp, { once: true })
}
function onSeekMove(e) {
  if (!isSeeking.value) return
  updateSeek(e)
}
function onSeekUp(e) {
  if (!isSeeking.value) return
  isSeeking.value = false
  window.removeEventListener('pointermove', onSeekMove)
  if (videoEl.value && vid.dur) {
    videoEl.value.currentTime = (seekProgress.value / 100) * vid.dur
    vid.cur = videoEl.value.currentTime
  }
}
function updateSeek(e) {
  const bar = e.currentTarget?.classList?.contains('vtrack') ? e.currentTarget : document.querySelector('.brief .vtrack')
  if (!bar) return
  const rect = bar.getBoundingClientRect()
  const pct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100))
  seekProgress.value = pct
  if (vid.dur) {
    vid.cur = (pct / 100) * vid.dur
  }
}

/* 简报显示 2048 视口预览，放大到 2× 才换原图：大图平移只合成小纹理 */
const useFull = computed(() => (lib.brief.scale || 1) >= 2)
const noCanvas = computed(() => {
  const ext = extOf(lib.brief.path)
  return ext === '.gif' || ext === '.svg' // 保留 GIF 动画 / SVG 矢量，不塞进 canvas
})
const thumbSrc = computed(() => {
  const m = meta.value
  return m?.thumbnail_path && m.thumbnail_path !== 'SKIP'
    ? fileUrl(m.thumbnail_path) + '?v=' + (m.modify_time || 0) : ''
})
const briefAmbientUrl = ref('')
let briefAmbNonce = 0
watch(thumbSrc, async (u) => {
  const nonce = ++briefAmbNonce
  if (!u) {
    briefAmbientUrl.value = ''
    return
  }
  const baked = await renderAmbientBlur(u, { size: 96, blur: 14 })
  if (nonce === briefAmbNonce) briefAmbientUrl.value = baked || u
}, { immediate: true })
const canvasFullSrc = computed(() => {
  const m = meta.value
  if (!m) return ''
  if (isPsd.value) return psdFull.value ? fileUrl(psdFull.value) + '?v=' + (m.modify_time || 0) : ''
  return url.value
})
const canvasPreviewSrc = computed(() => {
  const m = meta.value
  if (previewPath.value && !previewError.value) {
    return fileUrl(previewPath.value) + '?v=' + (m?.modify_time || 0)
  }
  return thumbSrc.value || canvasFullSrc.value
})
watch(() => lib.brief.path, async (p) => {
  imgDead.value = false
  psdFull.value = ''
  psdError.value = ''
  videoCompatPath.value = ''
  compatReqPath = ''
  showRateMenu.value = false
  isSeeking.value = false
  vid.cur = 0
  vid.playing = true
  psdLoading.value = extOf(p) === '.psd'
  if (!psdLoading.value) return
  try {
    const res = await api.psdPreview(p)
    if (lib.brief.path !== p) return
    if (res?.ok && res.path) {
      const fullUrl = fileUrl(res.path) + '?v=' + (meta.value?.modify_time || 0)
      await new Promise((resolve, reject) => {
        const im = new Image()
        im.decoding = 'async'
        im.onload = () => { if (im.decode) im.decode().then(resolve).catch(resolve); else resolve() }
        im.onerror = () => reject(new Error('PSD 原图加载失败'))
        im.src = fullUrl
      })
      if (lib.brief.path === p) psdFull.value = res.path
    } else {
      psdError.value = res?.error || 'PSD 原图渲染失败'
    }
  } catch (e) {
    if (lib.brief.path === p) psdError.value = String(e?.message || e)
  } finally {
    if (lib.brief.path === p) psdLoading.value = false
  }
}, { immediate: true })
let briefPreviewNonce = 0
watch(() => lib.brief.path, async (p) => {
  const nonce = ++briefPreviewNonce
  previewError.value = false
  if (!isPreviewableImage(p)) {
    previewPath.value = ''
    cancelNeighborPrefetch()
    return
  }
  const mtime = meta.value?.modify_time || 0
  const cached = getCachedPreviewPath(p, mtime)
  if (cached) {
    previewPath.value = cached
    decodeIntoPool(fileUrl(cached) + '?v=' + mtime, p)
    scheduleNeighborPrefetch(orderList.value, p, (fp) => lib.imageMap.get(fp))
    return
  }
  previewPath.value = ''
  try {
    const res = await api.viewPreview(p)
    if (nonce !== briefPreviewNonce || lib.brief.path !== p || !res?.ok || !res.path) return
    const curMtime = meta.value?.modify_time || 0
    rememberPreviewPath(p, curMtime, res.path)
    const u = fileUrl(res.path) + '?v=' + curMtime
    await decodeIntoPool(u, p)
    if (nonce === briefPreviewNonce && lib.brief.path === p) {
      previewPath.value = res.path
      scheduleNeighborPrefetch(orderList.value, p, (fp) => lib.imageMap.get(fp))
    }
  } catch (e) { /* 预览失败不阻塞原图 */ }
}, { immediate: true })

const mediaStyle = computed(() => ({
  cursor: kind.value === 'video' ? 'pointer' : 'grab',
}))

/* 本地实时视口与容器矩形缓存：拖拽与滚轮缩放同步直写 GPU 合成层，0 rAF 延迟，静止防抖回写 store */
const live = { tx: lib.brief.tx || 0, ty: lib.brief.ty || 0, scale: lib.brief.scale || 1 }
const briefRect = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
let briefRO = null
let briefResizeRaf = 0
let storeSyncTimer = 0

function updateBriefRect() {
  const el = briefEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  briefRect.left = r.left
  briefRect.top = r.top
  briefRect.width = r.width
  briefRect.height = r.height
}
function ensureBriefRect() {
  if (!briefRect.width || !briefRect.height) updateBriefRect()
  return briefRect
}
function syncTransformNow(tx, ty, scale = live.scale) {
  if (kind.value === 'image' && !noCanvas.value && canvasStage.value?.drawAt) {
    canvasStage.value.drawAt(tx, ty, scale)
    return
  }
  const el = kind.value === 'video' ? videoEl.value : mediaEl.value
  if (el) el.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`
}
function syncMediaTransform() {
  const el = kind.value === 'video' ? videoEl.value : mediaEl.value
  if (el) {
    el.style.transform = `translate3d(${live.tx}px, ${live.ty}px, 0) scale(${live.scale})`
  }
}
function commitLiveToStore() {
  if (storeSyncTimer) { clearTimeout(storeSyncTimer); storeSyncTimer = 0 }
  if (lib.brief.tx !== live.tx) lib.brief.tx = live.tx
  if (lib.brief.ty !== live.ty) lib.brief.ty = live.ty
  if (lib.brief.scale !== live.scale) lib.brief.scale = live.scale
}
function scheduleStoreSync(delay = 80) {
  if (storeSyncTimer) clearTimeout(storeSyncTimer)
  storeSyncTimer = setTimeout(() => {
    storeSyncTimer = 0
    commitLiveToStore()
  }, delay)
}

watch(() => [lib.brief.tx, lib.brief.ty, lib.brief.scale, kind.value], ([tx, ty, sc]) => {
  if (pan.active) return
  if (
    Math.abs((tx ?? 0) - live.tx) > 1e-3
    || Math.abs((ty ?? 0) - live.ty) > 1e-3
    || Math.abs((sc ?? 1) - live.scale) > 1e-6
  ) {
    live.tx = tx ?? 0
    live.ty = ty ?? 0
    live.scale = sc ?? 1
  }
  syncTransformNow(live.tx, live.ty, live.scale)
})
watch(() => lib.brief.path, () => {
  if (storeSyncTimer) { clearTimeout(storeSyncTimer); storeSyncTimer = 0 }
  live.tx = lib.brief.tx || 0
  live.ty = lib.brief.ty || 0
  live.scale = lib.brief.scale || 1
})
function next() { lib.briefNav(1) }
function prev() { lib.briefNav(-1) }

/* 平移：pointermove 同步直写 GPU 层（零 rAF 排队），松手写回 brief.tx/ty */
const pan = { active: false, pointerId: null, x0: 0, y0: 0, tx0: 0, ty0: 0, tx: 0, ty: 0, moved: false }
function applyPan(tx, ty) {
  live.tx = tx
  live.ty = ty
  syncTransformNow(tx, ty, live.scale)
}
/* ---- Ken Burns 缓慢推拉运镜 + 自动轮播（幻灯片） ---- */
const kenBurnsOn = ref(localStorage.getItem('picnest.briefKenBurnsV2') === '1')
const autoPlay = ref(false)
const intervalSec = ref(Number(localStorage.getItem('picnest.briefInterval')) || 5)
const topRightHover = ref(false)
let autoTimer = null

const isUnzoomed = computed(() => Math.abs((lib.brief.scale || 1) - 1) < 0.01 && !(lib.brief.tx || 0) && !(lib.brief.ty || 0))
const kbClass = computed(() => (kenBurnsOn.value && isUnzoomed.value && kind.value === 'image' ? `kb kb-${idx.value % 4}` : ''))

function toggleKenBurns() {
  kenBurnsOn.value = !kenBurnsOn.value
  localStorage.setItem('picnest.briefKenBurnsV2', kenBurnsOn.value ? '1' : '0')
}
function toggleAutoPlay() {
  autoPlay.value = !autoPlay.value
  resetAutoTimer()
}
function cycleInterval() {
  const list = [3, 5, 8]
  const cur = list.indexOf(intervalSec.value)
  intervalSec.value = list[(cur + 1) % list.length]
  localStorage.setItem('picnest.briefInterval', String(intervalSec.value))
  resetAutoTimer()
}
function stepAutoNext() {
  if (!lib.brief.open || pan.active) return
  const list = orderList.value
  if (!list.length) return
  if (idx.value >= list.length - 1) {
    lib.brief.path = list[0]
    lib.brief.scale = 1; lib.brief.tx = 0; lib.brief.ty = 0
  } else {
    lib.briefNav(1)
  }
}
function resetAutoTimer() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null }
  if (autoPlay.value && lib.brief.open) {
    autoTimer = setInterval(stepAutoNext, intervalSec.value * 1000)
  }
}
watch(() => [lib.brief.open, lib.brief.path], ([open]) => {
  if (!open || kind.value !== 'video') {
    // 退出简报模式或切离视频时：主动释放 D3D11 视频硬件解码器管线与显存交换链
    if (videoEl.value) {
      try {
        videoEl.value.pause()
        videoEl.value.removeAttribute('src')
        videoEl.value.load()
      } catch (e) {}
    }
  }
  if (!open) {
    autoPlay.value = false; topRightHover.value = false; bottomHover.value = false; showRateMenu.value = false
  }
  resetAutoTimer()
})
function onBriefPointerMove(e) {
  if (pan.active) return
  const r = ensureBriefRect()
  const w = r.width || window.innerWidth
  const h = r.height || window.innerHeight
  topRightHover.value = e.clientY <= 72 && (w - e.clientX) <= 320
  bottomHover.value = (h - e.clientY) <= 80
}

let downTarget = null
function onDown(e) {
  if (e.button !== 0) return
  if (e.target.closest?.('.brief-x') || e.target.closest?.('.brief-ctl-bar') || e.target.closest?.('.brief-video-dock')) return
  if (storeSyncTimer) { clearTimeout(storeSyncTimer); storeSyncTimer = 0 }
  downTarget = e.target
  pan.active = true
  pan.pointerId = e.pointerId ?? null
  pan.x0 = e.clientX; pan.y0 = e.clientY
  pan.tx0 = live.tx; pan.ty0 = live.ty
  pan.tx = pan.tx0; pan.ty = pan.ty0
  pan.moved = false
  canvasStage.value?.setInteractive?.(true)
  if (pan.pointerId != null) {
    try { briefEl.value?.setPointerCapture?.(pan.pointerId) } catch {}
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
}
function onMove(e) {
  if (!pan.active) return
  if (pan.pointerId != null && e.pointerId != null && e.pointerId !== pan.pointerId) return
  const ev = e.getCoalescedEvents?.().at(-1) || e
  const dx = ev.clientX - pan.x0, dy = ev.clientY - pan.y0
  if (!pan.moved && dx * dx + dy * dy < 12.25) return
  if (!pan.moved) {
    pan.moved = true
    briefEl.value?.classList.add('is-panning')
  }
  pan.tx = pan.tx0 + dx
  pan.ty = pan.ty0 + dy
  applyPan(pan.tx, pan.ty)
}
function onUp(e) {
  if (!pan.active) return
  if (pan.pointerId != null && e?.pointerId != null && e.pointerId !== pan.pointerId) return
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  window.removeEventListener('pointercancel', onUp)
  const moved = !!pan.moved
  pan.active = false
  briefEl.value?.classList.remove('is-panning')
  if (pan.pointerId != null) {
    try {
      if (briefEl.value?.hasPointerCapture?.(pan.pointerId)) {
        briefEl.value.releasePointerCapture(pan.pointerId)
      }
    } catch {}
    pan.pointerId = null
  }
  canvasStage.value?.setInteractive?.(false)
  if (moved) {
    live.tx = pan.tx
    live.ty = pan.ty
    commitLiveToStore()
  } else {
    // 未拖拽平移，单击意图判定：
    // 若在视频模式下且点击发生在视频画面本身上：暂停/启动播放
    // 若点击在视频外部黑色背景舞台：切到下一张
    if (kind.value === 'video') {
      const isVideoSelf = downTarget && (downTarget.tagName === 'VIDEO' || downTarget === videoEl.value)
      if (isVideoSelf) {
        togglePlay()
        return
      }
    }
    next() // 视频外背景 / 图片模式单击 = 切下一张
  }
}
function onWheel(e) {
  const s0 = live.scale || 1
  const s1 = Math.min(8, Math.max(0.2, s0 * (e.deltaY < 0 ? 1.12 : 1 / 1.12)))
  if (s1 === s0) return
  const wasPan = pan.active
  if (wasPan) {
    live.tx = pan.tx
    live.ty = pan.ty
  }
  const rect = ensureBriefRect()
  const px = e.clientX - (rect.left + rect.width / 2)
  const py = e.clientY - (rect.top + rect.height / 2)
  live.tx = px - (s1 / s0) * (px - (live.tx || 0))
  live.ty = py - (s1 / s0) * (py - (live.ty || 0))
  live.scale = s1
  syncTransformNow(live.tx, live.ty, s1)
  if (wasPan) {
    pan.x0 = e.clientX
    pan.y0 = e.clientY
    pan.tx0 = live.tx
    pan.ty0 = live.ty
    pan.tx = live.tx
    pan.ty = live.ty
  }
  scheduleStoreSync(80)
}
function onContext(e) {
  const m = lib.images.find((i) => i.file_path === lib.brief.path)
  if (!m) return
  lib.openContextMenu({ clientX: e.clientX, clientY: e.clientY, preventDefault() {} }, m)
}
function onFsChange() {
  if (!document.fullscreenElement && lib.brief.open) lib.closeBrief()
}
function onBriefKey(e) {
  if (!lib.brief.open) return
  if (kind.value === 'video') {
    if (e.key === ' ') {
      e.preventDefault()
      togglePlay()
    } else if (e.key === 'j' || e.key === 'J' || e.key === 'ArrowDown') {
      e.preventDefault()
      stepTime(-5)
    } else if (e.key === 'l' || e.key === 'L' || e.key === 'ArrowUp') {
      e.preventDefault()
      stepTime(5)
    }
  }
}

onMounted(() => {
  updateBriefRect()
  try {
    briefRO = new ResizeObserver(() => {
      if (briefResizeRaf) cancelAnimationFrame(briefResizeRaf)
      briefResizeRaf = requestAnimationFrame(() => { briefResizeRaf = 0; updateBriefRect() })
    })
    if (briefEl.value) briefRO.observe(briefEl.value)
  } catch {}
  window.addEventListener('resize', updateBriefRect)
  document.addEventListener('fullscreenchange', onFsChange)
  window.addEventListener('keydown', onBriefKey)
  window.__picBriefPerf = () => ({
    scale: live.scale,
    tx: live.tx,
    ty: live.ty,
    perf: canvasStage.value?.getPerfStats?.() || null,
    preload: getPreloadStats(),
  })
})
onBeforeUnmount(() => {
  cancelNeighborPrefetch()
  if (!lib.lightbox.open) clearDecodedPool()
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null }
  if (briefResizeRaf) cancelAnimationFrame(briefResizeRaf)
  if (storeSyncTimer) { clearTimeout(storeSyncTimer); storeSyncTimer = 0 }
  briefRO?.disconnect()
  briefRO = null
  window.removeEventListener('resize', updateBriefRect)
  document.removeEventListener('fullscreenchange', onFsChange)
  window.removeEventListener('keydown', onBriefKey)
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  window.removeEventListener('pointercancel', onUp)
  pan.active = false
  delete window.__picBriefPerf
})
</script>

<template>
  <Teleport to="body">
    <div v-if="lib.brief.open" ref="briefEl" class="brief" :class="{ 'ctl-show': topRightHover }"
         :style="{ cursor: kind === 'image' ? 'grab' : 'default' }"
         @pointermove="onBriefPointerMove"
         @wheel.prevent="onWheel" @pointerdown="onDown" @contextmenu.prevent="onContext">
      <!-- 氛围底：切图时离线预模糊烘焙为极小 JPEG 底图 + 深暗角，切图交叉淡化 -->
      <Transition name="bamb">
        <div v-if="kind === 'image' && briefAmbientUrl" :key="briefAmbientUrl" class="brief-amb" :style="{ backgroundImage: `url(&quot;${briefAmbientUrl}&quot;)` }" />
      </Transition>
      <div class="brief-vignette" />
      <div :key="lib.brief.path" class="brief-stage-wrap" :class="kbClass">
        <CanvasStage v-if="kind === 'image' && !imgDead && !noCanvas"
          ref="canvasStage" :class="{ gray: lib.grayscaleMode }"
          :preview-src="canvasPreviewSrc" :full-src="canvasFullSrc" :fallback-src="thumbSrc"
          :width="meta?.width || 0" :height="meta?.height || 0"
          :scale="lib.brief.scale || 1" :tx="lib.brief.tx || 0" :ty="lib.brief.ty || 0"
          :use-full="useFull" fit-mode @error="imgDead = true" />
        <img v-else-if="kind === 'image' && !imgDead" ref="mediaEl" :src="url" :class="{ gray: lib.grayscaleMode }"
             :style="mediaStyle" draggable="false" alt="" @error="imgDead = true" />
        <video v-else-if="kind === 'video'" ref="videoEl" :src="url"
               :class="{ gray: lib.grayscaleMode }" :style="mediaStyle"
               playsinline
               @loadedmetadata="onVideoMeta" @timeupdate="onVideoTime"
               @play="vid.playing = true" @pause="vid.playing = false" @ended="vid.playing = false"
               @error="onVideoError" />
        <div v-else class="brief-empty">
          <template v-if="kind === 'image'">图片加载失败<br /><span>← → 仍可切到下一张</span></template>
          <template v-else>
            {{ kind === 'text' ? '文本文件暂不支持简报模式' : '该文件暂不支持简报模式' }}<br />
            <span>← → 仍可切到下一张</span>
          </template>
        </div>
      </div>
      <div v-if="isPsd && (psdLoading || psdError)" class="brief-note">
        {{ psdError || 'PSD 原图渲染中，先显示缩略图…' }}
      </div>
      <div class="brief-count"><b>{{ String(idx + 1).padStart(2, '0') }}</b><span> / {{ orderList.length }}</span></div>
      <div class="brief-progress"><i :style="{ width: (orderList.length ? ((idx + 1) / orderList.length) * 100 : 0) + '%' }" /></div>
      <div class="brief-hint">←/A D→ 切换 · 单击视频暂停/启动 · 单击视频外切下一张 · 移至底部浮现控制条 · Esc 退出</div>

      <!-- 右上角隐形悬浮控制条：鼠标移至右上角才缓慢浮现 -->
      <div class="brief-ctl-bar" @mousedown.stop @click.stop>
        <button class="bctl-btn" :class="{ on: autoPlay }" title="自动轮播幻灯片" @click="toggleAutoPlay">
          {{ autoPlay ? '❚❚ 轮播中' : '▶ 自动轮播' }}
        </button>
        <button class="bctl-btn chip" title="切换轮播间隔（3s / 5s / 8s）" @click="cycleInterval">{{ intervalSec }}s</button>
        <button class="bctl-btn" :class="{ on: kenBurnsOn }" title="未缩放时缓慢推拉运镜（Ken Burns）" @click="toggleKenBurns">✦ 运镜</button>
        <button class="brief-x" title="退出简报全屏（Esc）" @click.stop="lib.closeBrief()">✕</button>
      </div>

      <!-- 底部视频控制栏：移入底部平滑浮现，移出隐藏；彻底砍掉上下一张 ‹ › 按钮 -->
      <div v-if="kind === 'video'" class="brief-video-dock" :class="{ 'dock-show': bottomHover || showRateMenu }"
           @pointerdown.stop @click.stop>
        <div class="dock glass-pill video-dock dock-clear">
          <button class="dock-btn step" title="后退 5 秒（J）" @click="stepTime(-5)">-5s</button>
          <button class="dock-btn play" :title="vid.playing ? '暂停（空格）' : '播放（空格）'" @click="togglePlay">
            {{ vid.playing ? '❚❚' : '▶' }}
          </button>
          <button class="dock-btn step" title="快进 5 秒（L）" @click="stepTime(5)">+5s</button>
          <span class="vtime cur">{{ formatTime(vid.cur) }}</span>
          <div class="vtrack" @pointerdown="onSeekDown">
            <i class="vfill" :style="{ width: (isSeeking ? seekProgress : (vid.dur ? (vid.cur / vid.dur) * 100 : 0)) + '%' }" />
            <i class="vhead" :style="{ left: (isSeeking ? seekProgress : (vid.dur ? (vid.cur / vid.dur) * 100 : 0)) + '%' }" />
          </div>
          <span class="vtime dim">{{ formatTime(vid.dur) }}</span>
          <i class="vsep" />
          <div class="vol-wrap">
            <button class="dock-btn vol-btn" :title="vid.muted ? '静音中（点击恢复）' : '静音'" @click="toggleMute">
              {{ vid.muted || vid.volume === 0 ? '🔇' : '♪' }}
            </button>
            <input type="range" class="vol-slider" min="0" max="1" step="0.05"
                   :value="vid.muted ? 0 : vid.volume" @input="onVolumeInput" title="音量调节" />
          </div>
          <div class="rate-wrap">
            <button class="dock-btn rate-btn" title="播放倍速" @click="showRateMenu = !showRateMenu">
              {{ vid.rate === 1.0 ? '1.0x' : vid.rate + 'x' }}
            </button>
            <div v-if="showRateMenu" class="rate-menu">
              <button
                v-for="r in rateOptions"
                :key="r"
                class="rate-opt"
                :class="{ on: vid.rate === r }"
                @click.stop="setPlaybackRate(r)"
              >
                {{ r === 1.0 ? '1.0x 正常' : r + 'x' }}
              </button>
            </div>
          </div>
          <button class="dock-btn" :class="{ on: vid.loop }" :title="vid.loop ? '循环播放：已开启' : '循环播放：已关闭'" @click="toggleLoop">↻</button>
          <button class="dock-btn" title="退出简报全屏（Esc / ⛶）" @click="lib.closeBrief()">⛶</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.brief {
  position: fixed; inset: 0; z-index: 890; /* 低于右键菜单(900)/确认卡(950)，便于在简报里操作 */
  display: flex; align-items: center; justify-content: center;
  background: #0b0b0d; cursor: default; user-select: none; overflow: hidden;
  touch-action: none;
}
.brief.is-panning,
.brief.is-panning * {
  cursor: grabbing !important;
}
.brief.is-panning .brief-stage-wrap {
  animation-play-state: paused !important;
}
.brief img, .brief video {
  max-width: 100vw; max-height: 100vh; object-fit: contain; display: block;
  transform-origin: center center; will-change: transform; user-select: none;
  border-radius: 0; box-shadow: none; /* 沉浸模式：图片不做浮岛 */
}
.brief img.gray, .brief video.gray { filter: grayscale(1); }
.brief :deep(.canvas-stage.gray) { filter: grayscale(1); }
.brief-empty { color: #8d877c; font-size: 14px; line-height: 2; text-align: center; }
.brief-empty span { font-size: 11.5px; opacity: 0.7; }
.brief-note {
  position: fixed; top: 44px; left: 50%; transform: translateX(-50%); z-index: 2;
  padding: 5px 10px; border-radius: 8px; pointer-events: none;
  background: rgba(20, 18, 14, 0.62); color: #e8e2d6; font-size: 11.5px;
}
/* ---- 氛围底：离线预模糊后的影院 Ambilight 光晕，切图交叉淡化，拖动零实时模糊开销 ---- */
.brief-amb {
  position: absolute; inset: -15%; z-index: 0; pointer-events: none;
  background-size: cover; background-position: center;
  filter: saturate(1.6) brightness(0.55);
  opacity: 0.85;
  transform: translateZ(0);
}
.bamb-enter-active, .bamb-leave-active { transition: opacity 0.9s ease; }
.bamb-enter-from, .bamb-leave-to { opacity: 0 !important; }
.brief-vignette {
  position: absolute; inset: 0; z-index: 0; pointer-events: none;
  background: radial-gradient(ellipse 70% 65% at 50% 50%, transparent 35%, rgba(0, 0, 0, 0.55) 100%);
}
/* ---- 舞台与 Ken Burns 缓慢推拉运镜（仅在 1x 未缩放平移时生效，一缩放立即归零） ---- */
.brief-stage-wrap {
  position: absolute; inset: 0; z-index: 1;
  display: flex; align-items: center; justify-content: center;
  pointer-events: auto;
}
.brief-stage-wrap.kb { will-change: transform; }
.brief-stage-wrap.kb-0 { animation: kb-move-0 14s cubic-bezier(0.22, 0.6, 0.36, 1) forwards; }
.brief-stage-wrap.kb-1 { animation: kb-move-1 14s cubic-bezier(0.22, 0.6, 0.36, 1) forwards; }
.brief-stage-wrap.kb-2 { animation: kb-move-2 14s cubic-bezier(0.22, 0.6, 0.36, 1) forwards; }
.brief-stage-wrap.kb-3 { animation: kb-move-3 14s cubic-bezier(0.22, 0.6, 0.36, 1) forwards; }
@keyframes kb-move-0 { from { transform: scale(1) translate3d(0, 0, 0); } to { transform: scale(1.068) translate3d(-1.1%, -0.7%, 0); } }
@keyframes kb-move-1 { from { transform: scale(1.068) translate3d(1.1%, -0.6%, 0); } to { transform: scale(1) translate3d(0, 0, 0); } }
@keyframes kb-move-2 { from { transform: scale(1) translate3d(0, 0, 0); } to { transform: scale(1.065) translate3d(1.0%, 0.8%, 0); } }
@keyframes kb-move-3 { from { transform: scale(1.065) translate3d(-1.0%, 0.7%, 0); } to { transform: scale(1) translate3d(0, 0, 0); } }
.brief img.gray, .brief video.gray { filter: grayscale(1); }
.brief-count {
  position: fixed; top: 16px; left: 24px; z-index: 2; color: #d9d3c7;
  font-family: var(--font-serif); pointer-events: none;
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.6);
}
.brief-count b { font-size: 22px; font-weight: 600; letter-spacing: 1px; }
.brief-count span { font-size: 12px; opacity: 0.55; letter-spacing: 1px; }
/* 底部进度细线：当前位置 / 总数 */
.brief-progress {
  position: fixed; left: 0; right: 0; bottom: 0; height: 2px; z-index: 2;
  background: rgba(255, 255, 255, 0.06); pointer-events: none;
}
.brief-progress i {
  display: block; height: 100%;
  background: linear-gradient(90deg, transparent, var(--accent));
  box-shadow: 0 0 10px var(--accent);
  transition: width 0.5s var(--ease-overshoot);
}
/* 操作提示：进场 4s 后自动淡出，不打扰观看 */
.brief-hint {
  position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 2;
  color: #b9b3a7; font-size: 11.5px; letter-spacing: 0.5px;
  padding: 6px 14px; border-radius: 999px;
  background: rgba(0, 0, 0, 0.32); backdrop-filter: blur(12px);
  pointer-events: none; white-space: nowrap;
  animation: hint-fade 5s ease forwards;
}
@keyframes hint-fade { 0%, 75% { opacity: 0.85; } 100% { opacity: 0; } }
/* 右上角控制条：默认完全透明隐身，鼠标移到右上角才缓慢浮现 */
.brief-ctl-bar {
  position: fixed; top: 12px; right: 14px; z-index: 3;
  display: flex; align-items: center; gap: 6px;
  padding: 4px 6px; border-radius: 999px;
  background: rgba(20, 18, 16, 0.34);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  opacity: 0; visibility: hidden; transform: translateY(-6px);
  pointer-events: none;
  transition: opacity 0.45s cubic-bezier(0.22, 1, 0.36, 1), transform 0.45s cubic-bezier(0.22, 1, 0.36, 1), visibility 0s linear 0.45s;
}
.brief.ctl-show .brief-ctl-bar,
.brief-ctl-bar:hover {
  opacity: 1; visibility: visible; transform: translateY(0); pointer-events: auto;
  transition: opacity 0.45s cubic-bezier(0.22, 1, 0.36, 1), transform 0.45s cubic-bezier(0.22, 1, 0.36, 1), visibility 0s linear 0s;
}
.bctl-btn {
  height: 28px; padding: 0 10px; border: none; border-radius: 999px;
  background: transparent; color: #c7c0b4; font-size: 11.5px; cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.bctl-btn.chip { padding: 0 8px; font-variant-numeric: tabular-nums; }
.bctl-btn:hover { background: rgba(255, 255, 255, 0.12); color: #fff; }
.bctl-btn.on { background: rgba(212, 169, 100, 0.22); color: #e5be7d; box-shadow: inset 0 0 0 1px rgba(212, 169, 100, 0.45); }
.brief-x {
  width: 28px; height: 28px;
  border: none; border-radius: 50%; background: rgba(255, 255, 255, 0.06);
  color: #b9b3a7; font-size: 12.5px; cursor: pointer;
}
.brief-x:hover { background: rgba(255, 255, 255, 0.16); color: #fff; }

/* 底部全屏视频浮动控制条：默认全透，鼠标靠近底部才平滑浮现 */
.brief-video-dock {
  position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%);
  z-index: 10; pointer-events: none;
  transition: opacity 0.35s cubic-bezier(0.22, 1, 0.36, 1), transform 0.35s cubic-bezier(0.22, 1, 0.36, 1), visibility 0s linear 0.35s;
  opacity: 0; visibility: hidden; transform: translateX(-50%) translateY(14px) scale(0.96);
}
.brief-video-dock.dock-show,
.brief-video-dock:hover {
  opacity: 1; visibility: visible; transform: translateX(-50%) translateY(0) scale(1);
  pointer-events: auto;
  transition: opacity 0.35s cubic-bezier(0.22, 1, 0.36, 1), transform 0.35s cubic-bezier(0.22, 1, 0.36, 1), visibility 0s linear 0s;
}
.dock {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 8px; border-radius: 999px;
  background: rgba(20, 18, 16, 0.65);
  backdrop-filter: blur(16px) saturate(1.2);
  -webkit-backdrop-filter: blur(16px) saturate(1.2);
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  pointer-events: auto;
}
.dock-btn {
  height: 32px; min-width: 32px; border: none; border-radius: 999px;
  background: transparent; color: #d0c8be; font-size: 13px;
  cursor: pointer; padding: 0 8px; transition: all 0.15s;
  display: flex; align-items: center; justify-content: center;
}
.dock-btn:hover { background: rgba(255, 255, 255, 0.12); color: #fff; transform: translateY(-1px); }
.dock-btn:active { transform: scale(0.94); }
.dock-btn.on { background: rgba(212, 169, 100, 0.22); color: #e5be7d; box-shadow: inset 0 0 0 1px rgba(212, 169, 100, 0.45); }
.dock-btn.play { color: var(--accent, #d4a964); font-size: 12px; }
.dock-btn.step { font-family: Consolas, monospace; font-size: 11px; min-width: 30px; padding: 0 4px; letter-spacing: -0.5px; }
.vtime { font-family: Consolas, monospace; font-size: 11px; color: #e6dfd3; min-width: 32px; text-align: center; }
.vtime.dim { opacity: 0.55; }
.vtrack {
  position: relative; width: 140px; height: 16px; display: flex; align-items: center;
  cursor: pointer; margin: 0 4px;
}
.vtrack::before {
  content: ''; position: absolute; left: 0; right: 0; height: 4px;
  background: rgba(255, 255, 255, 0.16); border-radius: 2px;
}
.vfill {
  position: absolute; left: 0; height: 4px;
  background: var(--accent, #d4a964); border-radius: 2px; pointer-events: none;
}
.vhead {
  position: absolute; width: 10px; height: 10px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
  transform: translateX(-50%); pointer-events: none; transition: transform 0.1s;
}
.vtrack:hover .vhead { transform: translateX(-50%) scale(1.3); }
.vsep { width: 1px; height: 18px; background: rgba(255, 255, 255, 0.12); margin: 0 3px; }
.vol-wrap { display: flex; align-items: center; gap: 4px; }
.vol-slider {
  width: 58px; height: 4px; -webkit-appearance: none; appearance: none;
  background: rgba(255, 255, 255, 0.2); border-radius: 2px; outline: none; cursor: pointer;
}
.vol-slider::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 10px; height: 10px; border-radius: 50%;
  background: #fff; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,0.5);
}
.rate-wrap { position: relative; display: flex; align-items: center; }
.dock-btn.rate-btn { font-family: Consolas, monospace; font-size: 11.5px; min-width: 38px; padding: 0 6px; }
.rate-menu {
  position: absolute; bottom: calc(100% + 10px); left: 50%; transform: translateX(-50%);
  display: flex; flex-direction: column; gap: 2px; padding: 6px; min-width: 84px;
  background: rgba(22, 20, 18, 0.92); backdrop-filter: blur(14px);
  border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6); z-index: 20;
}
.rate-opt {
  padding: 5px 8px; border: none; border-radius: 6px; background: transparent;
  color: #d0c8be; font-size: 11.5px; text-align: left; cursor: pointer;
  white-space: nowrap; font-family: Consolas, monospace; transition: background 0.12s;
}
.rate-opt:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }
.rate-opt.on { background: rgba(212, 169, 100, 0.2); color: var(--accent, #d4a964); font-weight: 600; }
</style>
