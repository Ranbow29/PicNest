<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

const info = reactive({
  id: 0,
  width: 200,
  height: 200,
  scaleFactor: 1,
  pngUrl: '',
})

const loaded = ref(false)
const zoom = ref(1)
const opacity = ref(1)
const flipX = ref(false)
const grayscale = ref(false)
const clickThrough = ref(false)
const throughHotkey = ref('Alt+Shift+P')
const isDragging = ref(false)
const hudText = ref('')
const ctxMenu = reactive({ open: false, x: 0, y: 0 })

let hudTimer = 0
let readySent = false
let unlistenThrough = null
let unlistenThroughHotkey = null
let unlistenDragState = null

let dragPointerId = -1
let dragTracksLbutton = false
let dragStartMs = 0
let dragBeginPromise = null

let zoomInFlight = false
let pendingZoomFactor = 1
let zoomAnchorRx = 0.5
let zoomAnchorRy = 0.5

function flashHud(msg, ms = 1300) {
  hudText.value = msg
  if (hudTimer) clearTimeout(hudTimer)
  hudTimer = setTimeout(() => {
    hudText.value = ''
  }, ms)
}

function applyThroughUiState(enabled) {
  const next = !!enabled
  if (clickThrough.value === next) return
  clickThrough.value = next
  ctxMenu.open = false
  if (next) {
    flashHud(`鼠标穿透已开 · 按 ${throughHotkey.value} 切换 / 托盘可解除`, 2400)
  } else {
    flashHud('已解除鼠标穿透 ✓', 1400)
  }
}

async function setClickThrough(enabled) {
  ctxMenu.open = false
  const next = !!enabled
  clickThrough.value = next
  flashHud(
    next ? `鼠标穿透已开 · 按 ${throughHotkey.value} 切换 / 托盘可解除` : '已解除鼠标穿透 ✓',
    next ? 2400 : 1400,
  )
  try {
    await invoke('pin_set_click_through', { enabled: next, alpha: null })
  } catch {
    flashHud('切换穿透失败')
  }
}

async function markReady() {
  if (readySent) return
  readySent = true
  loaded.value = true
  try {
    await invoke('pin_ready')
  } catch {}
}

const imgStyle = computed(() => ({
  transform: flipX.value ? 'scaleX(-1)' : 'none',
  filter: grayscale.value ? 'grayscale(1)' : 'none',
}))

const ctxMenuStyle = computed(() => {
  const maxX = Math.max(4, (window.innerWidth || 160) - 166)
  const maxY = Math.max(4, (window.innerHeight || 160) - 210)
  return {
    left: `${Math.max(4, Math.min(ctxMenu.x, maxX))}px`,
    top: `${Math.max(4, Math.min(ctxMenu.y, maxY))}px`,
  }
})

async function flushZoom() {
  if (zoomInFlight) return
  zoomInFlight = true
  try {
    while (Math.abs(pendingZoomFactor - 1) > 1e-4) {
      const f = pendingZoomFactor
      pendingZoomFactor = 1
      const res = await invoke('pin_zoom_by', {
        factor: f,
        anchorRx: zoomAnchorRx,
        anchorRy: zoomAnchorRy,
      })
      if (res?.percent) {
        flashHud(`${res.percent}%`)
      }
    }
  } catch {} finally {
    zoomInFlight = false
    if (Math.abs(pendingZoomFactor - 1) > 1e-4) {
      flushZoom()
    }
  }
}

function queueZoomBy(factor, rx, ry) {
  pendingZoomFactor *= factor
  zoomAnchorRx = Math.max(0, Math.min(1, Number.isFinite(rx) ? rx : 0.5))
  zoomAnchorRy = Math.max(0, Math.min(1, Number.isFinite(ry) ? ry : 0.5))
  flushZoom()
}

function stepZoomAnchored(factor, rx = 0.5, ry = 0.5) {
  queueZoomBy(factor, rx, ry)
}

async function applyOpacity(nextAlpha) {
  opacity.value = Math.max(0.2, Math.min(1.0, Number(nextAlpha.toFixed(2))))
  try {
    await invoke('pin_set_opacity', { alpha: opacity.value })
  } catch {}
  flashHud(`透明度 ${Math.round(opacity.value * 100)}%`)
}

function toggleFlip() {
  ctxMenu.open = false
  flipX.value = !flipX.value
  flashHud(flipX.value ? '水平镜像：开' : '水平镜像：关')
}

function toggleGrayscale() {
  ctxMenu.open = false
  grayscale.value = !grayscale.value
  flashHud(grayscale.value ? '灰度明度：开' : '灰度明度：关')
}

async function resetView() {
  ctxMenu.open = false
  flipX.value = false
  grayscale.value = false
  zoom.value = 1
  opacity.value = 1
  pendingZoomFactor = 1
  try {
    await invoke('pin_set_opacity', { alpha: 1.0 })
    await invoke('pin_reset_size')
  } catch {}
  flashHud('已重置 100%')
}

async function runAction(action) {
  ctxMenu.open = false
  try {
    const res = await invoke('pin_action', { action })
    if (!res?.ok) {
      if (!res?.canceled) flashHud(res?.error || '操作失败')
      return
    }
    if (action === 'copy') flashHud('已复制到剪贴板 ✓')
    else if (action === 'save_to_picnest') flashHud('已入库 PicNest ✓')
    else if (action === 'save_as') flashHud('已保存 ✓')
  } catch {
    flashHud('操作失败')
  }
}

function closePin() {
  ctxMenu.open = false
  invoke('pin_action', { action: 'close' }).catch(() => {})
}

function closeAllPins() {
  ctxMenu.open = false
  invoke('pin_close_all').catch(() => {})
}

function detachDragListeners() {
  window.removeEventListener('pointermove', onWindowPointerMove)
  window.removeEventListener('pointerup', onWindowPointerUp)
}

async function finishDrag() {
  detachDragListeners()
  const pendingBegin = dragBeginPromise
  dragBeginPromise = null
  if (pendingBegin) {
    try {
      const res = await pendingBegin
      if (res && !res.dragging) {
        isDragging.value = false
        dragTracksLbutton = false
        dragPointerId = -1
        return
      }
    } catch {}
  }
  try {
    await invoke('pin_drag_end')
  } catch {}
  isDragging.value = false
  dragTracksLbutton = false
  dragPointerId = -1
}

function onWindowPointerMove(e) {
  if (!isDragging.value || dragTracksLbutton) return
  if (typeof e?.pointerId === 'number' && dragPointerId >= 0 && e.pointerId !== dragPointerId) return
  if (Date.now() - dragStartMs < 140) return
  if (e.buttons === 0 && (typeof e.pressure !== 'number' || e.pressure === 0)) {
    finishDrag()
  }
}

function onWindowPointerUp(e) {
  if (!isDragging.value) return
  if (typeof e?.pointerId === 'number' && dragPointerId >= 0 && e.pointerId !== dragPointerId) return
  finishDrag()
}

function startDrag(e) {
  if (e.button === 2 || e.button === 5) return
  if (e.pointerType === 'mouse' && e.button !== 0) return
  e.preventDefault()
  if (isDragging.value) {
    finishDrag()
    return
  }
  isDragging.value = true
  dragTracksLbutton = false
  dragStartMs = Date.now()
  dragPointerId = e.pointerId
  window.addEventListener('pointermove', onWindowPointerMove, { passive: true })
  window.addEventListener('pointerup', onWindowPointerUp)
  const p = invoke('pin_drag_begin')
    .then((res) => {
      if (!res?.ok || !res.dragging) {
        isDragging.value = false
        dragTracksLbutton = false
        detachDragListeners()
      } else {
        isDragging.value = true
        dragTracksLbutton = !!res.tracksLbutton
      }
      return res
    })
    .catch(() => {
      isDragging.value = false
      dragTracksLbutton = false
      detachDragListeners()
      return null
    })
  dragBeginPromise = p
}

function onPointerDown(e) {
  if (e.button === 2) return
  if (ctxMenu.open) ctxMenu.open = false
  if (clickThrough.value) return
  if (e.target.closest?.('.pin-bar, .pin-ctx')) return
  startDrag(e)
}

function onContextMenu(e) {
  e.preventDefault()
  if (isDragging.value) {
    finishDrag()
    return
  }
  ctxMenu.x = e.clientX
  ctxMenu.y = e.clientY
  ctxMenu.open = true
}

function onWheel(e) {
  ctxMenu.open = false
  if (e.altKey) {
    const step = e.deltaY < 0 ? 0.07 : -0.07
    applyOpacity(opacity.value + step)
    return
  }
  const factor = e.deltaY < 0 ? 1.07 : 1 / 1.07
  const rx = isDragging.value ? 0.5 : e.clientX / Math.max(1, window.innerWidth || 1)
  const ry = isDragging.value ? 0.5 : e.clientY / Math.max(1, window.innerHeight || 1)
  queueZoomBy(factor, rx, ry)
}

function onKeyDown(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    if (isDragging.value) {
      finishDrag()
      return
    }
    if (ctxMenu.open) {
      ctxMenu.open = false
      return
    }
    closePin()
    return
  }
  if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    const k = String(e.key || '').toLowerCase()
    if (k === 'h') {
      e.preventDefault()
      toggleFlip()
      return
    }
    if (k === 'g') {
      e.preventDefault()
      toggleGrayscale()
      return
    }
    if (k === 't') {
      e.preventDefault()
      setClickThrough(!clickThrough.value)
      return
    }
    if (k === '0' || k === '1') {
      e.preventDefault()
      resetView()
      return
    }
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const lk = String(e.key || '').toLowerCase()
    if (lk === 'c') {
      e.preventDefault()
      runAction('copy')
      return
    }
    if (lk === 's') {
      e.preventDefault()
      runAction('save_as')
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      runAction('save_to_picnest')
    }
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKeyDown)
  listen('picnest:pin-through', (ev) => {
    if (ev?.payload?.fromSelf) return
    applyThroughUiState(!!ev?.payload?.enabled)
  }).then((fn) => {
    unlistenThrough = fn
  }).catch(() => {})
  listen('picnest:through-hotkey-changed', (ev) => {
    const hk = String(ev?.payload?.hotkey || '').trim()
    if (hk) throughHotkey.value = hk
  }).then((fn) => {
    unlistenThroughHotkey = fn
  }).catch(() => {})
  listen('picnest:pin-drag-state', (ev) => {
    const dragging = !!ev?.payload?.dragging
    isDragging.value = dragging
    dragTracksLbutton = dragging && !!ev?.payload?.tracksLbutton
    if (!dragging) {
      detachDragListeners()
      dragPointerId = -1
    }
  }).then((fn) => {
    unlistenDragState = fn
  }).catch(() => {})
  try {
    const res = await invoke('pin_get_info')
    if (!res?.ok || !res.pngUrl) {
      closePin()
      return
    }
    info.id = Number(res.id || 0)
    info.width = Math.max(40, Number(res.width || 200))
    info.height = Math.max(40, Number(res.height || 200))
    info.scaleFactor = Number(res.scaleFactor || 1)
    info.pngUrl = String(res.pngUrl)
    if (res.throughHotkey) throughHotkey.value = String(res.throughHotkey)
    if (Number.isFinite(Number(res.opacity))) opacity.value = Number(res.opacity)
    if (res.clickThrough) applyThroughUiState(true)
  } catch {
    closePin()
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
  detachDragListeners()
  if (typeof unlistenThrough === 'function') unlistenThrough()
  if (typeof unlistenThroughHotkey === 'function') unlistenThroughHotkey()
  if (typeof unlistenDragState === 'function') unlistenDragState()
  if (hudTimer) clearTimeout(hudTimer)
})
</script>

<template>
  <div
    class="pin-root"
    :class="{ 'is-through': clickThrough }"
    @pointerdown="onPointerDown"
    @dblclick.stop="closePin"
    @wheel.prevent="onWheel"
    @contextmenu="onContextMenu"
  >
    <img
      v-if="info.pngUrl"
      :src="info.pngUrl"
      class="pin-img"
      :style="imgStyle"
      draggable="false"
      alt=""
      @load="markReady"
      @error="closePin"
    />

    <!-- 悬停顶部极简功能条 -->
    <div v-if="loaded && !clickThrough" class="pin-bar" @pointerdown.stop @dblclick.stop>
      <button class="pb-btn" :class="{ on: flipX }" title="水平镜像 (H)" @click="toggleFlip">⇄</button>
      <button class="pb-btn" :class="{ on: grayscale }" title="灰度观察 (G)" @click="toggleGrayscale">◐</button>
      <button class="pb-btn txt" :class="{ on: clickThrough }" :title="`鼠标穿透描图 (T · 按 ${throughHotkey} 解除)`" @click="setClickThrough(true)">穿透</button>
      <button class="pb-btn" title="降低透明度 (Alt+滚轮)" @click="applyOpacity(opacity - 0.12)">−</button>
      <button class="pb-btn" title="提高透明度 (Alt+滚轮)" @click="applyOpacity(opacity + 0.12)">+</button>
      <i class="pb-sep" />
      <button class="pb-btn txt" title="复制 (Ctrl+C)" @click="runAction('copy')">复制</button>
      <button class="pb-btn txt gold" title="入库 PicNest (Ctrl+Enter)" @click="runAction('save_to_picnest')">入库</button>
      <button class="pb-btn close" title="关闭贴图 (Esc / 双击)" @click="closePin">✕</button>
    </div>

    <div v-if="hudText" class="pin-hud">{{ hudText }}</div>

    <!-- 右键快捷菜单 -->
    <div v-if="ctxMenu.open && !clickThrough" class="pin-ctx" :style="ctxMenuStyle" @pointerdown.stop @dblclick.stop>
      <button class="pm-item" @click="toggleFlip">
        <span>水平镜像</span><b>{{ flipX ? '✓ H' : 'H' }}</b>
      </button>
      <button class="pm-item" @click="toggleGrayscale">
        <span>灰度观察</span><b>{{ grayscale ? '✓ G' : 'G' }}</b>
      </button>
      <button class="pm-item" @click="setClickThrough(true)">
        <span>鼠标穿透描图</span><b>T</b>
      </button>
      <button class="pm-item" @click="resetView">
        <span>重置 100%</span><b>0</b>
      </button>
      <div class="pm-sep" />
      <button class="pm-item" @click="runAction('copy')">
        <span>复制图片</span><b>Ctrl+C</b>
      </button>
      <button class="pm-item" @click="runAction('save_to_picnest')">
        <span>入库 PicNest</span><b>Ctrl+↵</b>
      </button>
      <button class="pm-item" @click="runAction('save_as')">
        <span>另存为 PNG…</span><b>Ctrl+S</b>
      </button>
      <div class="pm-sep" />
      <button class="pm-item danger" @click="closePin">
        <span>关闭此贴图</span><b>Esc</b>
      </button>
      <button class="pm-item danger" @click="closeAllPins">
        <span>关闭全部贴图</span><b />
      </button>
    </div>
  </div>
</template>

<style scoped>
.pin-root {
  position: fixed;
  inset: 0;
  overflow: hidden;
  background: #14161a;
  user-select: none;
  touch-action: none;
  -webkit-user-drag: none;
  cursor: grab;
  box-shadow: inset 0 0 0 1.5px rgba(79, 163, 255, 0.55);
  font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
}
.pin-root.is-through {
  box-shadow: inset 0 0 0 1.5px rgba(255, 203, 71, 0.58);
}
.pin-root:active {
  cursor: grabbing;
}
.pin-img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: fill;
  pointer-events: none;
  transition: transform 0.12s ease, filter 0.12s ease;
}

.pin-bar {
  position: fixed;
  top: 6px;
  right: 6px;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px 5px;
  border-radius: 7px;
  background: rgba(18, 20, 24, 0.84);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.42);
  opacity: 0;
  transform: translateY(-3px);
  transition: opacity 0.15s ease, transform 0.15s ease;
  touch-action: none;
  -webkit-user-drag: none;
  cursor: default;
}
.pin-root:hover .pin-bar {
  opacity: 1;
  transform: translateY(0);
}
.pb-sep {
  width: 1px;
  height: 13px;
  background: rgba(255, 255, 255, 0.16);
  margin: 0 2px;
}
.pb-btn {
  height: 21px;
  min-width: 21px;
  padding: 0 4px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #dbe2ee;
  font-size: 12px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s, color 0.12s;
}
.pb-btn.txt {
  font-size: 11px;
  padding: 0 6px;
}
.pb-btn:hover {
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
}
.pb-btn.on {
  background: rgba(79, 163, 255, 0.28);
  color: #7cc0ff;
}
.pb-btn.gold {
  color: #eec887;
}
.pb-btn.close:hover {
  background: #e5484d;
  color: #fff;
}

.pin-hud {
  position: fixed;
  left: 50%;
  bottom: 10px;
  transform: translateX(-50%);
  z-index: 6;
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(16, 18, 22, 0.88);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: #f0f4fa;
  font-size: 11px;
  white-space: nowrap;
  pointer-events: none;
}

.pin-ctx {
  position: fixed;
  z-index: 10;
  width: 158px;
  max-height: calc(100vh - 8px);
  overflow-y: auto;
  padding: 4px;
  border-radius: 8px;
  background: rgba(20, 22, 27, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.15);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.55);
  display: flex;
  flex-direction: column;
  gap: 1px;
  cursor: default;
}
.pm-item {
  width: 100%;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: #e4e9f2;
  font-size: 11.5px;
  padding: 5px 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.pm-item b {
  font-weight: 500;
  font-size: 10.5px;
  color: #8f98a8;
  font-family: Consolas, monospace;
}
.pm-item:hover {
  background: rgba(79, 163, 255, 0.22);
  color: #fff;
}
.pm-item.danger:hover {
  background: rgba(229, 72, 77, 0.28);
  color: #ffb4b6;
}
.pm-sep {
  height: 1px;
  background: rgba(255, 255, 255, 0.1);
  margin: 3px 4px;
}
</style>
