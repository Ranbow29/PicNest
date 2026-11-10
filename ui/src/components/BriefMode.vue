<script setup>
// 简报模式：全屏黑底演示（Eagle 语义）——单击下一张 / 右键菜单 / 滚轮缩放 / 拖拽平移 / ←→ / Esc 退出
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useLibrary } from '../stores/library'
import { fileUrl, api } from '../api'
import { isTextPath, isVideoPath, extOf } from '../lib/fileKinds'
import CanvasStage from './CanvasStage.vue'

const lib = useLibrary()
const url = computed(() => (lib.brief.path ? fileUrl(lib.brief.path) : ''))
const kind = computed(() => {
  const p = lib.brief.path
  return isVideoPath(p) ? 'video' : isTextPath(p) ? 'text' : 'image'
})
const meta = computed(() => lib.images.find((i) => i.file_path === lib.brief.path) || null)
const isPsd = computed(() => extOf(lib.brief.path) === '.psd')
const orderList = computed(() => (lib.gridOrder?.length ? lib.gridOrder : lib.filteredImages.map((i) => i.file_path)))
const idx = computed(() => Math.max(0, orderList.value.indexOf(lib.brief.path)))
const dragging = ref(false)
const mediaEl = ref(null)
const canvasStage = ref(null)
const psdFull = ref('')
const psdLoading = ref(false)
const psdError = ref('')
const imgDead = ref(false)
const previewPath = ref('')
const previewError = ref(false)
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
watch(() => lib.brief.path, async (p) => {
  previewPath.value = ''
  previewError.value = false
  const ext = extOf(p)
  if (!p || isVideoPath(p) || isTextPath(p) || ext === '.gif' || ext === '.svg') return
  try {
    const res = await api.viewPreview(p)
    if (lib.brief.path !== p || !res?.ok || !res.path) return
    const u = fileUrl(res.path) + '?v=' + (meta.value?.modify_time || 0)
    await new Promise((resolve, reject) => {
      const im = new Image()
      im.decoding = 'async'
      im.onload = () => { if (im.decode) im.decode().then(resolve).catch(resolve); else resolve() }
      im.onerror = () => reject(new Error('preview load failed'))
      im.src = u
    })
    if (lib.brief.path === p) previewPath.value = res.path
  } catch (e) { /* 预览失败不阻塞原图 */ }
}, { immediate: true })

const mediaStyle = computed(() => ({
  transform: `translate3d(${lib.brief.tx || 0}px, ${lib.brief.ty || 0}px, 0) scale(${lib.brief.scale || 1})`,
  cursor: dragging.value ? 'grabbing' : 'grab',
}))
function next() { lib.briefNav(1) }
function prev() { lib.briefNav(-1) }

/* 平移：拖动期间 rAF + 直接改媒体 transform，松手才写回 brief.tx/ty */
const pan = { active: false, x0: 0, y0: 0, tx0: 0, ty0: 0, tx: 0, ty: 0, raf: 0, moved: false }
function applyPan(tx, ty) {
  if (kind.value === 'image' && canvasStage.value?.drawAt) {
    canvasStage.value.drawAt(tx, ty, lib.brief.scale || 1)
    return
  }
  const el = mediaEl.value
  if (el) el.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${lib.brief.scale || 1})`
}
/* ---- Ken Burns 缓慢推拉运镜 + 自动轮播（幻灯片） ---- */
const kenBurnsOn = ref(localStorage.getItem('picnest.briefKenBurns') !== '0')
const autoPlay = ref(false)
const intervalSec = ref(Number(localStorage.getItem('picnest.briefInterval')) || 5)
const topRightHover = ref(false)
let autoTimer = null

const isUnzoomed = computed(() => Math.abs((lib.brief.scale || 1) - 1) < 0.01 && !(lib.brief.tx || 0) && !(lib.brief.ty || 0) && !dragging.value)
const kbClass = computed(() => (kenBurnsOn.value && isUnzoomed.value && kind.value === 'image' ? `kb kb-${idx.value % 4}` : ''))

function toggleKenBurns() {
  kenBurnsOn.value = !kenBurnsOn.value
  localStorage.setItem('picnest.briefKenBurns', kenBurnsOn.value ? '1' : '0')
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
  if (!lib.brief.open || dragging.value) return
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
  if (!open) { autoPlay.value = false; topRightHover.value = false }
  resetAutoTimer()
})
function onBriefPointerMove(e) {
  topRightHover.value = e.clientY <= 72 && (window.innerWidth - e.clientX) <= 320
}

function onDown(e) {
  if (e.button !== 0) return
  if (e.target.closest?.('.brief-x') || e.target.closest?.('.brief-ctl-bar')) return
  pan.active = true
  pan.x0 = e.clientX; pan.y0 = e.clientY
  pan.tx0 = lib.brief.tx || 0; pan.ty0 = lib.brief.ty || 0
  pan.tx = pan.tx0; pan.ty = pan.ty0
  pan.moved = false
  dragging.value = false
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp, { once: true })
}
function onMove(e) {
  if (!pan.active) return
  const dx = e.clientX - pan.x0, dy = e.clientY - pan.y0
  if (!pan.moved && Math.hypot(dx, dy) < 4) return
  if (!pan.moved) { pan.moved = true; dragging.value = true }
  pan.tx = pan.tx0 + dx
  pan.ty = pan.ty0 + dy
  if (pan.raf) return
  pan.raf = requestAnimationFrame(() => {
    pan.raf = 0
    if (pan.active) applyPan(pan.tx, pan.ty)
  })
}
function onUp() {
  window.removeEventListener('pointermove', onMove)
  const moved = !!pan.moved
  if (pan.raf) { cancelAnimationFrame(pan.raf); pan.raf = 0 }
  pan.active = false
  dragging.value = false
  if (moved) {
    lib.brief.tx = pan.tx
    lib.brief.ty = pan.ty
  } else {
    next() // 没拖动 = 单击切下一张
  }
}
function onWheel(e) {
  const b = lib.brief
  const s0 = b.scale || 1
  const s1 = Math.min(8, Math.max(0.2, s0 * (e.deltaY < 0 ? 1.12 : 1 / 1.12)))
  if (s1 === s0) return
  const wasPan = pan.active
  /* 拖动中滚轮：先落当前位移，锚点缩放后重设 pan 基准，避免下一次 pointermove 用旧 base 回弹 */
  if (wasPan) { b.tx = pan.tx; b.ty = pan.ty }
  const rect = e.currentTarget.getBoundingClientRect()
  const px = e.clientX - (rect.left + rect.width / 2)
  const py = e.clientY - (rect.top + rect.height / 2)
  b.tx = px - (s1 / s0) * (px - (b.tx || 0))
  b.ty = py - (s1 / s0) * (py - (b.ty || 0))
  b.scale = s1
  if (wasPan) {
    if (pan.raf) { cancelAnimationFrame(pan.raf); pan.raf = 0 }
    pan.x0 = e.clientX
    pan.y0 = e.clientY
    pan.tx0 = b.tx
    pan.ty0 = b.ty
    pan.tx = b.tx
    pan.ty = b.ty
    applyPan(pan.tx, pan.ty)
  }
}
function onContext(e) {
  const m = lib.images.find((i) => i.file_path === lib.brief.path)
  if (!m) return
  lib.openContextMenu({ clientX: e.clientX, clientY: e.clientY, preventDefault() {} }, m)
}
function onFsChange() {
  if (!document.fullscreenElement && lib.brief.open) lib.closeBrief()
}
onMounted(() => document.addEventListener('fullscreenchange', onFsChange))
onBeforeUnmount(() => {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null }
  document.removeEventListener('fullscreenchange', onFsChange)
  window.removeEventListener('pointermove', onMove)
  if (pan.raf) { cancelAnimationFrame(pan.raf); pan.raf = 0 }
  pan.active = false
})
</script>

<template>
  <Teleport to="body">
    <div v-if="lib.brief.open" class="brief" :class="{ 'ctl-show': topRightHover }"
         :style="{ cursor: dragging ? 'grabbing' : (kind === 'image' ? 'grab' : 'default') }"
         @pointermove="onBriefPointerMove"
         @wheel.prevent="onWheel" @pointerdown="onDown" @contextmenu.prevent="onContext">
      <!-- 氛围底：当前图模糊放大铺满黑场 + 深暗角，切图交叉淡化 -->
      <Transition name="bamb">
        <div v-if="kind === 'image' && thumbSrc" :key="thumbSrc" class="brief-amb" :style="{ backgroundImage: `url(&quot;${thumbSrc}&quot;)` }" />
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
        <video v-else-if="kind === 'video'" ref="mediaEl" :src="url" autoplay muted loop playsinline
               :class="{ gray: lib.grayscaleMode }" :style="mediaStyle" />
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
      <div class="brief-hint">←/A D→ 切换 · 滚轮缩放 · 拖拽平移 · 单击下一张 · 右上角悬停唤出轮播/运镜 · Esc 退出</div>
      <!-- 右上角隐形悬浮控制条：鼠标移至右上角才缓慢浮现 -->
      <div class="brief-ctl-bar" @mousedown.stop @click.stop>
        <button class="bctl-btn" :class="{ on: autoPlay }" title="自动轮播幻灯片" @click="toggleAutoPlay">
          {{ autoPlay ? '❚❚ 轮播中' : '▶ 自动轮播' }}
        </button>
        <button class="bctl-btn chip" title="切换轮播间隔（3s / 5s / 8s）" @click="cycleInterval">{{ intervalSec }}s</button>
        <button class="bctl-btn" :class="{ on: kenBurnsOn }" title="未缩放时缓慢推拉运镜（Ken Burns）" @click="toggleKenBurns">✦ 运镜</button>
        <button class="brief-x" title="退出（Esc）" @click.stop="lib.closeBrief()">✕</button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.brief {
  position: fixed; inset: 0; z-index: 890; /* 低于右键菜单(900)/确认卡(950)，便于在简报里操作 */
  display: flex; align-items: center; justify-content: center;
  background: #0b0b0d; cursor: default; user-select: none; overflow: hidden;
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
/* ---- 氛围底：黑场里透出当前图的色彩光晕（影院 Ambilight 式），切图交叉淡化 ---- */
.brief-amb {
  position: absolute; inset: -15%; z-index: 0; pointer-events: none;
  background-size: cover; background-position: center;
  filter: blur(90px) saturate(1.6) brightness(0.55);
  opacity: 0.85;
  animation: bamb-breathe 22s ease-in-out infinite alternate;
}
@keyframes bamb-breathe { from { transform: scale(1); } to { transform: scale(1.1) rotate(1.5deg); } }
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
  pointer-events: none; will-change: transform;
}
.brief-stage-wrap.kb-0 { animation: kb-move-0 14s cubic-bezier(0.22, 0.6, 0.36, 1) forwards; }
.brief-stage-wrap.kb-1 { animation: kb-move-1 14s cubic-bezier(0.22, 0.6, 0.36, 1) forwards; }
.brief-stage-wrap.kb-2 { animation: kb-move-2 14s cubic-bezier(0.22, 0.6, 0.36, 1) forwards; }
.brief-stage-wrap.kb-3 { animation: kb-move-3 14s cubic-bezier(0.22, 0.6, 0.36, 1) forwards; }
@keyframes kb-move-0 { from { transform: scale(1) translate3d(0, 0, 0); } to { transform: scale(1.068) translate3d(-1.1%, -0.7%, 0); } }
@keyframes kb-move-1 { from { transform: scale(1.068) translate3d(1.1%, -0.6%, 0); } to { transform: scale(1) translate3d(0, 0, 0); } }
@keyframes kb-move-2 { from { transform: scale(1) translate3d(0, 0, 0); } to { transform: scale(1.065) translate3d(1.0%, 0.8%, 0); } }
@keyframes kb-move-3 { from { transform: scale(1.065) translate3d(-1.0%, 0.7%, 0); } to { transform: scale(1) translate3d(0, 0, 0); } }
.brief img, .brief video { filter: drop-shadow(0 24px 60px rgba(0, 0, 0, 0.55)); }
.brief img.gray, .brief video.gray { filter: grayscale(1) drop-shadow(0 24px 60px rgba(0, 0, 0, 0.55)); }
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
  opacity: 0; transform: translateY(-6px);
  pointer-events: none;
  transition: opacity 0.45s cubic-bezier(0.22, 1, 0.36, 1), transform 0.45s cubic-bezier(0.22, 1, 0.36, 1);
}
.brief.ctl-show .brief-ctl-bar,
.brief-ctl-bar:hover {
  opacity: 1; transform: translateY(0); pointer-events: auto;
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
</style>
