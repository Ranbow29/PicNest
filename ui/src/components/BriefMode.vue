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
function onDown(e) {
  if (e.button !== 0) return
  if (e.target.closest?.('.brief-x')) return
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
  document.removeEventListener('fullscreenchange', onFsChange)
  window.removeEventListener('pointermove', onMove)
  if (pan.raf) { cancelAnimationFrame(pan.raf); pan.raf = 0 }
  pan.active = false
})
</script>

<template>
  <Teleport to="body">
    <div v-if="lib.brief.open" class="brief"
         :style="{ cursor: dragging ? 'grabbing' : (kind === 'image' ? 'grab' : 'default') }"
         @wheel.prevent="onWheel" @pointerdown="onDown" @contextmenu.prevent="onContext">
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
      <div v-if="isPsd && (psdLoading || psdError)" class="brief-note">
        {{ psdError || 'PSD 原图渲染中，先显示缩略图…' }}
      </div>
      <div class="brief-count">{{ idx + 1 }} / {{ orderList.length }}</div>
      <div class="brief-hint">←/A D→ 切换 · 滚轮缩放 · 拖拽平移 · 单击下一张 · 右键菜单 · Esc 退出</div>
      <button class="brief-x" title="退出（Esc）" @click.stop="lib.closeBrief()">✕</button>
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
.brief-count {
  position: fixed; top: 18px; left: 22px; color: #b9b3a7;
  font: 12px Consolas, monospace; opacity: 0.65; pointer-events: none;
}
.brief-hint {
  position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
  color: #8d877c; font-size: 11.5px; letter-spacing: 0.5px;
  opacity: 0.6; pointer-events: none; white-space: nowrap;
}
.brief-x {
  position: fixed; top: 12px; right: 14px; width: 30px; height: 30px;
  border: none; border-radius: 9px; background: rgba(255, 255, 255, 0.06);
  color: #b9b3a7; font-size: 13px; cursor: pointer; z-index: 2;
}
.brief-x:hover { background: rgba(255, 255, 255, 0.14); color: #fff; }
</style>
