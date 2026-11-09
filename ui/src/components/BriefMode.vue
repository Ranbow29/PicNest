<script setup>
// 简报模式：全屏黑底演示（Eagle 语义）——单击下一张 / 右键菜单 / 滚轮缩放 / 拖拽平移 / ←→ / Esc 退出
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useLibrary } from '../stores/library'
import { fileUrl } from '../api'
import { isTextPath, isVideoPath } from '../lib/fileKinds'

const lib = useLibrary()
const url = computed(() => (lib.brief.path ? fileUrl(lib.brief.path) : ''))
const kind = computed(() => {
  const p = lib.brief.path
  return isVideoPath(p) ? 'video' : isTextPath(p) ? 'text' : 'image'
})
const idx = computed(() => Math.max(0, lib.images.findIndex((i) => i.file_path === lib.brief.path)))
const dragging = ref(false)
let drag = null

const mediaStyle = computed(() => ({
  transform: `translate(${lib.brief.tx || 0}px, ${lib.brief.ty || 0}px) scale(${lib.brief.scale || 1})`,
  cursor: dragging.value ? 'grabbing' : 'grab',
}))
function next() { lib.briefNav(1) }
function prev() { lib.briefNav(-1) }

function onDown(e) {
  if (e.button !== 0) return
  if (e.target.closest?.('.brief-x')) return
  drag = { x0: e.clientX, y0: e.clientY, tx0: lib.brief.tx || 0, ty0: lib.brief.ty || 0, moved: false }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp, { once: true })
}
function onMove(e) {
  if (!drag) return
  const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0
  if (!drag.moved && Math.hypot(dx, dy) < 4) return
  drag.moved = true
  dragging.value = true
  lib.brief.tx = drag.tx0 + dx
  lib.brief.ty = drag.ty0 + dy
}
function onUp() {
  window.removeEventListener('pointermove', onMove)
  const moved = !!drag?.moved
  drag = null
  dragging.value = false
  if (!moved) next() // 没拖动 = 单击切下一张
}
function onWheel(e) {
  const b = lib.brief
  const s0 = b.scale || 1
  const s1 = Math.min(8, Math.max(0.2, s0 * (e.deltaY < 0 ? 1.12 : 1 / 1.12)))
  if (s1 === s0) return
  /* 以光标为锚点缩放 */
  const rect = e.currentTarget.getBoundingClientRect()
  const px = e.clientX - (rect.left + rect.width / 2)
  const py = e.clientY - (rect.top + rect.height / 2)
  b.tx = px - (s1 / s0) * (px - (b.tx || 0))
  b.ty = py - (s1 / s0) * (py - (b.ty || 0))
  b.scale = s1
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
})
</script>

<template>
  <Teleport to="body">
    <div v-if="lib.brief.open" class="brief"
         @wheel.prevent="onWheel" @pointerdown="onDown" @contextmenu.prevent="onContext">
      <img v-if="kind === 'image'" :src="url" :class="{ gray: lib.grayscaleMode }"
           :style="mediaStyle" draggable="false" alt="" />
      <video v-else-if="kind === 'video'" :src="url" autoplay muted loop playsinline
             :class="{ gray: lib.grayscaleMode }" :style="mediaStyle" />
      <div v-else class="brief-empty">
        {{ kind === 'text' ? '文本文件暂不支持简报模式' : '该文件暂不支持简报模式' }}<br />
        <span>← → 仍可切到下一张</span>
      </div>
      <div class="brief-count">{{ idx + 1 }} / {{ lib.images.length }}</div>
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
.brief-empty { color: #8d877c; font-size: 14px; line-height: 2; text-align: center; }
.brief-empty span { font-size: 11.5px; opacity: 0.7; }
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
