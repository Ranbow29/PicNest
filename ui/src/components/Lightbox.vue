<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useLibrary } from '../stores/library'
import { fileUrl, api } from '../api'

// 大图工作区：正文内的编辑舞台（顶栏由 TitleBar 按模式变形；底部悬浮工具条 ZCode 输入口风格）
const lib = useLibrary()
const V = computed(() => lib.viewer)
const stageEl = ref(null)
const imgEl = ref(null)
const dragging = ref(false)
let lastX = 0, lastY = 0

const url = computed(() => {
  const img = lib.images.find((i) => i.file_path === lib.lightbox.path)
  return img?.file_path ? fileUrl(img.file_path) : ''
})
const meta = computed(() => lib.images.find((i) => i.file_path === lib.lightbox.path) || null)

function fitToWindow() {
  const img = meta.value
  if (!stageEl.value || !img?.width) { lib.viewer.scale = 1; return }
  const rect = stageEl.value.getBoundingClientRect()
  const inspW = lib.viewer.showInspector ? lib.inspectorWidth + 16 : 0
  const availW = Math.max(120, rect.width - inspW - 32)
  const availH = Math.max(120, rect.height - 110) /* 顶部玻璃 42 + 拖尾 + 底部工具条 */
  const swapped = lib.viewer.rot % 180 !== 0
  const iw = swapped ? img.height : img.width
  const ih = swapped ? img.width : img.height
  lib.viewer.scale = Math.min(availW / iw, availH / ih) || 1 /* 按工作区适配，可放大不超出 */
  lib.viewer.tx = 0; lib.viewer.ty = 0
}
function oneToOne() { lib.viewer.scale = 1; lib.viewer.tx = 0; lib.viewer.ty = 0 }
function dblClick() {
  if (Math.abs(lib.viewer.scale - 1) < 0.02) fitToWindow()
  else oneToOne()
}

watch(() => lib.viewer.fitNonce, () => nextTick(fitToWindow))
/* 缩放/平移/详情开合时：裁剪层跟随重映射（保持选区在图片上的相对位置） */
watch(() => [lib.viewer.scale, lib.viewer.tx, lib.viewer.ty, lib.viewer.showInspector], () => {
  if (!lib.viewer.cropMode) return
  const old = crop.value ? { ...crop.value } : null
  const oldW = layerRect.value?.width || (old ? old.w : 0)
  nextTick(() => {
    if (!imgEl.value) return
    const nr = imgEl.value.getBoundingClientRect()
    layerRect.value = nr
    if (old && oldW > 0) {
      const k = nr.width / oldW
      crop.value = { x: old.x * k, y: old.y * k, w: old.w * k, h: old.h * k }
    }
  })
})
watch(() => lib.lightbox.path, () => { lib.viewer.rot = 0; lib.viewer.flopX = false; nextTick(fitToWindow) })
onMounted(() => { nextTick(fitToWindow); window.addEventListener('keydown', onKey) })
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

function onWheel(e) {
  if (lib.viewer.cropMode) return // 裁切中禁缩放：图片矩形一变，裁剪框坐标体系就失配
  e.preventDefault()
    const k = e.deltaY < 0 ? 1.12 : 1 / 1.12
  lib.viewer.scale = Math.min(8, Math.max(0.05, lib.viewer.scale * k))
}
function onDown(e) {
  if (lib.viewer.cropMode) return // 裁切中禁用平移，由裁切层接管
  dragging.value = true; lastX = e.clientX; lastY = e.clientY
}
function onMove(e) {
  if (lib.viewer.cropMode) return // 裁切跟踪由 window 级监听独占（防双重处理）
  if (!dragging.value) return
  lib.viewer.tx += e.clientX - lastX
  lib.viewer.ty += e.clientY - lastY
  lastX = e.clientX; lastY = e.clientY
}
function onUp() { dragging.value = false }

/* ---------- 专业裁切（Eagle 式）：屏幕坐标系，比例锁定 + 8 向手柄 + 三分网格 ---------- */
const cropLayer = ref(null)      // 覆盖在 img 上的固定定位层
const layerRect = ref(null)      // 进入裁切时的 img 客户端矩形
const crop = ref(null)           // {x,y,w,h} 层内坐标
const cropAction = ref(null)     // null | draw | move | resize
const activeHandle = ref('')
const dragOff = ref({ x: 0, y: 0 })
const ratioLock = ref('free')    // free | orig | 1:1 | 4:3 | 16:9
const cropBusy = ref(false)
const cropNote = ref('')
const cropAsk = ref(false) // 应用后三选一：另存为副本 / 覆盖原图 / 取消

function askCrop() {
  const n = cropNatural.value
  if (!n || n.width < 8 || n.height < 8) return
  cropAsk.value = true
}

/* 另存为副本：新文件写进原图所在目录（物理文件夹=真源，索引自动收录），原图不动 */
async function cropSaveAs() {
  const img = meta.value
  const n = cropNatural.value
  if (!img || !n || n.width < 8 || n.height < 8) return
  cropBusy.value = true
  try {
    const r = await window.picrand.picnestCropAs(img.file_path, { left: n.left, top: n.top, width: n.width, height: n.height })
    if (r?.ok) {
      cropAsk.value = false
      lib.viewer.cropMode = false
      crop.value = null
      cropNote.value = `已另存 ✓ ${r.path.split('\\').pop()}（${r.width}×${r.height}）`
      const root = lib.roots.find((r0) => r0.path && img.file_path.startsWith(r0.path))
      if (root) { try { await api.syncFolderSnapshot(root.path) } catch { /* 静默 */ } }
      await lib.refreshTree()
      await lib.loadImages()
      /* 索引到达有延迟（sync 异步）：轮询等到新图入库再选中（loadImages 会清 selectedPath，须在其后） */
      for (let i = 0; i < 12; i++) {
        await new Promise((k) => setTimeout(k, 250))
        await lib.loadImages()
        const np = lib.images.find((x) => x.file_path === r.path)
        if (np) { lib.selectedPath = np.file_path; lib.lightbox.path = np.file_path; break }
      }
    } else {
      cropNote.value = r?.error || '另存失败'
    }
  } finally {
    cropBusy.value = false
    setTimeout(() => { cropNote.value = '' }, 4000)
  }
}

const dispScale = computed(() => {
  if (!layerRect.value || !meta.value?.width) return 1
  return layerRect.value.width / meta.value.width
})
const cropNatural = computed(() => {
  if (!crop.value || !meta.value) return null
  const ds = dispScale.value
  return { left: crop.value.x / ds, top: crop.value.y / ds, width: crop.value.w / ds, height: crop.value.h / ds }
})
const cropDimsText = computed(() => {
  const n = cropNatural.value
  if (!n) return ''
  return `${Math.round(n.width)} × ${Math.round(n.height)}`
})

function enterCrop() {
  lib.viewer.cropMode = true
  nextTick(() => {
    if (imgEl.value) {
      layerRect.value = imgEl.value.getBoundingClientRect()
      // Eagle 式：进入裁切 = 全图即选区，直接在原图上拖手柄往里收
      crop.value = { x: 0, y: 0, w: layerRect.value.width, h: layerRect.value.height }
    }
  })
}
function exitCrop() {
  lib.viewer.cropMode = false
  crop.value = null
  cropAction.value = null
}
function toggleCrop() {
  if (!lib.viewer.cropMode) {
    if (lib.viewer.rot % 180 !== 0 || lib.viewer.flopX) return
    enterCrop()
  } else exitCrop()
}

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
function handleAt(e) {
  if (!crop.value || !cropLayer.value) return null
  const r = cropLayer.value.getBoundingClientRect()
  const x = e.clientX - r.left, y = e.clientY - r.top
  const T = 9
  const c = crop.value
  const zones = {
    nw: [c.x, c.y], n: [c.x + c.w / 2, c.y], ne: [c.x + c.w, c.y],
    e: [c.x + c.w, c.y + c.h / 2], se: [c.x + c.w, c.y + c.h], s: [c.x + c.w / 2, c.y + c.h],
    sw: [c.x, c.y + c.h], w: [c.x, c.y + c.h / 2],
  }
  for (const h of HANDLES) {
    const [hx, hy] = zones[h]
    if (Math.abs(x - hx) <= T && Math.abs(y - hy) <= T) return h
  }
  return null
}
function insideRect(e) {
  if (!crop.value || !cropLayer.value) return false
  const r = cropLayer.value.getBoundingClientRect()
  const x = e.clientX - r.left, y = e.clientY - r.top
  return x >= crop.value.x && x <= crop.value.x + crop.value.w && y >= crop.value.y && y <= crop.value.y + crop.value.h
}
function clampCrop() {
  const L = layerRect.value
  const c = crop.value
  if (!L || !c) return
  c.x = Math.max(0, Math.min(c.x, L.width))
  c.y = Math.max(0, Math.min(c.y, L.height))
  c.w = Math.max(8, Math.min(c.w, L.width - c.x))
  c.h = Math.max(8, Math.min(c.h, L.height - c.y))
  applyRatio()
}
function applyRatio() {
  const c = crop.value
  if (!c || ratioLock.value === 'free' || !meta.value) return
  let ratio = 1
  if (ratioLock.value === 'orig') ratio = meta.value.width / meta.value.height
  else if (ratioLock.value === '1:1') ratio = 1
  else if (ratioLock.value === '4:3') ratio = 4 / 3
  else if (ratioLock.value === '16:9') ratio = 16 / 9
  if (cropAction.value === 'resize' && ['nw', 'ne', 'sw', 'se', 'n', 's'].includes(activeHandle.value)) c.h = Math.round(c.w / ratio)
  else if (cropAction.value === 'resize') c.w = Math.round(c.h * ratio)
  else c.h = Math.round(c.w / ratio)
}
function ratioChip(key) {
  ratioLock.value = key
  applyRatio()
  clampCrop()
}

function cropPointerDown(e) {
  /* 实时矩形：手动拖窗/任何漂移后旧快照会让整层错位（看着在框上、坐标已偏） */
  layerRect.value = imgEl.value?.getBoundingClientRect() || null
  const L = layerRect.value
  if (!L || !crop.value) return
  /* 手柄命中用未钳坐标 + 不做层内早退：框角贴图缘时，手柄露在图外的半边也能抓住 */
  const h = handleAt(e)
  if (h) {
    cropAction.value = 'resize'; activeHandle.value = h
    return
  }
  if (e.clientX < L.left || e.clientX > L.right || e.clientY < L.top || e.clientY > L.bottom) return
  if (insideRect(e)) {
    cropAction.value = 'move'
    dragOff.value = { x: (e.clientX - L.left) - crop.value.x, y: (e.clientY - L.top) - crop.value.y }
  }
  /* 无 draw：裁剪 = 拖动初始就有的框（用户规格），误触阴影区不再清空选区 */
}
function cropPointerMove(e) {
  if (!cropAction.value || !imgEl.value) return
  layerRect.value = imgEl.value.getBoundingClientRect() // 拖拽全程实时矩形：拖窗不脱靶
  const L = layerRect.value
  const lx = Math.max(0, Math.min(e.clientX - L.left, L.width))
  const ly = Math.max(0, Math.min(e.clientY - L.top, L.height))
  const c = crop.value
  if (cropAction.value === 'move') {
    c.x = Math.max(0, Math.min(lx - dragOff.value.x, L.width - c.w))
    c.y = Math.max(0, Math.min(ly - dragOff.value.y, L.height - c.h))
  } else if (cropAction.value === 'resize') {
    const h = activeHandle.value
    const fixedX = h.includes('w') ? c.x + c.w : c.x
    const fixedY = h.includes('n') ? c.y + c.h : c.y
    let x1 = lx, y1 = ly
    if (h === 'n' || h === 's') x1 = c.x + c.w
    if (h === 'e' || h === 'w') y1 = c.y + c.h
    /* 手柄不许穿过锚点（CSP 同款）：拖出图缘/越过锚点 → 钳在锚点旁 8px，不反转不塌缩，
       拖回来照常变换（此前 SE 角越过上边缘会瞬间反转成 8×8 = 「没法变换」） */
    const MIN = 8
    if (h.includes('e')) x1 = Math.max(fixedX + MIN, Math.min(x1, L.width))
    else if (h.includes('w')) x1 = Math.max(0, Math.min(x1, fixedX - MIN))
    if (h.includes('s')) y1 = Math.max(fixedY + MIN, Math.min(y1, L.height))
    else if (h.includes('n')) y1 = Math.max(0, Math.min(y1, fixedY - MIN))
    c.x = Math.min(fixedX, x1); c.y = Math.min(fixedY, y1)
    c.w = Math.abs(x1 - fixedX); c.h = Math.abs(y1 - fixedY)
    applyRatio()
    if (h === 'n') { c.y = fixedY - c.h }
    if (h === 'w') { c.x = fixedX - c.w }
    clampCrop()
  }
}
function cropPointerUp() { cropAction.value = null }
/* 全局跟踪：鼠标超出图片/裁剪层也不丢事件（工作区概念） */
window.addEventListener('mousemove', (e) => { if (cropAction.value) cropPointerMove(e) })
window.addEventListener('mouseup', () => { if (cropAction.value) cropPointerUp() })

async function applyCrop() {
  cropAsk.value = false
  const img = meta.value
  const n = cropNatural.value
  if (!img || !n || n.width < 8 || n.height < 8) return
  cropBusy.value = true
  try {
    const r = await window.picrand.picnestCrop(img.file_path, { left: n.left, top: n.top, width: n.width, height: n.height })
    if (r?.ok) {
      const img2 = lib.images.find((i) => i.file_path === img.file_path)
      if (img2) { img2.width = r.width; img2.height = r.height; img2.thumbnail_path = '' }
      delete lib.palettes[img.file_path]
      lib.viewer.cropMode = false
      crop.value = null
      /* toast 独立于裁剪条（crop-bar 随 cropMode 消失，曾把成功消息一起带走） */
      cropNote.value = `已裁切 ✓ ${r.width}×${r.height} 已入库（原图已备份）`
      lib.layoutTick++
      lib.fillAllThumbsInBackground()
    } else {
      cropNote.value = r?.error || '裁切失败'
    }
  } finally {
    cropBusy.value = false
    setTimeout(() => { cropNote.value = '' }, 4000)
  }
}

function onKey(e) {
  if (!lib.lightbox.open) return
  if (e.key === 'Escape') {
    if (cropAsk.value) { cropAsk.value = false }
    else if (lib.viewer.cropMode) { exitCrop() }
    else lib.closeLightbox()
  }
  else if (e.key === 'Enter' && lib.viewer.cropMode && crop.value) applyCrop()
  else if (e.key === 'ArrowLeft' && !lib.viewer.cropMode) lib.lightboxNav(-1)
  else if (e.key === 'ArrowRight' && !lib.viewer.cropMode) lib.lightboxNav(1)
  else if (e.key === '0') fitToWindow()
}
</script>

<template>
  <div
    ref="stageEl" class="viewer"
    @wheel="onWheel"
    @mousedown="onDown" @mousemove="onMove" @mouseup="onUp" @mouseleave="onUp"
  >
    <img
      ref="imgEl" :src="url" class="stage" draggable="false"
      :style="{
        transform: `translate(${lib.viewer.tx}px, ${lib.viewer.ty}px) scale(${lib.viewer.scale}) rotate(${lib.viewer.rot}deg)` + (lib.viewer.flopX ? ' scaleX(-1)' : ''),
        cursor: lib.viewer.cropMode ? 'default' : dragging ? 'grabbing' : 'grab',
      }"
      @dblclick="dblClick"
    />
    <!-- 专业裁切层：覆盖在图片上（外部压暗 + 三分网格 + 手柄） -->
    <div v-if="lib.viewer.cropMode && layerRect" ref="cropLayer" class="crop-layer"
         :style="{ left: layerRect.left + 'px', top: layerRect.top + 'px', width: layerRect.width + 'px', height: layerRect.height + 'px' }"
         @mousedown.prevent="cropPointerDown"
    >
      <div v-if="crop" class="crop-shade" :style="{ clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${crop.x}px ${crop.y}px, ${crop.x}px ${crop.y + crop.h}px, ${crop.x + crop.w}px ${crop.y + crop.h}px, ${crop.x + crop.w}px ${crop.y}px, ${crop.x}px ${crop.y}px)` }" />
      <div v-if="crop" class="crop-box" :style="{ left: crop.x + 'px', top: crop.y + 'px', width: crop.w + 'px', height: crop.h + 'px' }">
        <i v-for="gy in 2" :key="'gy' + gy" class="grid-line v" :style="{ left: (gy * 100) / 3 + '%' }" />
        <i v-for="gx in 2" :key="'gx' + gx" class="grid-line h" :style="{ top: (gx * 100) / 3 + '%' }" />
        <span v-for="h in HANDLES" :key="h" class="handle" :class="h" />
        <span class="dims">{{ cropDimsText }}</span>
      </div>
      
    </div>

    <!-- 裁切比例锁定 + 应用条 -->
    <div v-if="lib.viewer.cropMode" class="crop-bar glass-pill">
      <button v-for="r in [{ k: 'free', l: '自由' }, { k: 'orig', l: '原始' }, { k: '1:1', l: '1:1' }, { k: '4:3', l: '4:3' }, { k: '16:9', l: '16:9' }]"
              :key="r.k" class="dock-btn chip" :class="{ on: ratioLock === r.k }" @click="ratioChip(r.k)">{{ r.l }}</button>
      <i class="vsep" />
      <button class="dock-btn ok" :disabled="!crop || cropBusy" @click="askCrop">✓ 应用</button>
      <button class="dock-btn" @click="exitCrop">取消</button>
      <span v-if="cropNote" class="note">{{ cropNote }}</span>
    </div>

    <!-- 底部悬浮工具条（ZCode 输入口风格） -->
    <div class="dock glass-pill">
      <button class="dock-btn" title="上一张（←）" @click="lib.lightboxNav(-1)">‹</button>
      <button class="dock-btn" title="下一张（→）" @click="lib.lightboxNav(1)">›</button>
      <i class="vsep" />
      <button class="dock-btn" :class="{ on: lib.viewer.flopX }" title="水平翻转" @click="lib.viewer.flopX = !lib.viewer.flopX">⇋</button>
      <button class="dock-btn" :class="{ on: lib.viewer.rot % 360 !== 0 }" title="旋转 90°" @click="lib.viewer.rot = (lib.viewer.rot + 90) % 360; lib.viewer.fitNonce++">↻</button>
      <button class="dock-btn" :class="{ on: lib.viewer.cropMode }" :disabled="lib.viewer.rot % 180 !== 0 || lib.viewer.flopX"
              :title="lib.viewer.cropMode ? '退出裁切' : '裁切（旋转/翻转时不可用）'"
              @click="toggleCrop">⛶</button>
      <i class="vsep" />
      <button class="dock-btn wide" title="原始大小（1:1）" @click="oneToOne">1:1</button>
      <button class="dock-btn wide" title="缩放到窗口大小" @click="fitToWindow">⤢ 适应</button>
    </div>
    <div v-if="!url" class="empty">图片不存在</div>
    <!-- 裁剪结果 toast：不随 cropMode 消失（挂在舞台根层） -->
    <div v-if="cropNote" class="crop-toast">{{ cropNote }}</div>

    <!-- 应用裁剪：三选一（另存为副本 / 覆盖原图 / 取消） -->
    <div v-if="cropAsk" class="ask-veil" @mousedown.self="cropAsk = false">
      <div class="ask-card glass-card" @mousedown.stop>
        <div class="ask-title">裁剪结果如何保存？</div>
        <button class="ask-btn" :disabled="cropBusy" @click="cropSaveAs">
          <b>另存为副本</b><span>存进原图所在文件夹，自动入库</span>
        </button>
        <button class="ask-btn" :disabled="cropBusy" @click="applyCrop">
          <b>覆盖原图</b><span>原件自动备份，可找回</span>
        </button>
        <button class="ask-btn ghost" @click="cropAsk = false">取消</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.viewer {
  flex: 1; position: relative; overflow: hidden;
  display: flex; align-items: center; justify-content: center;
  background: var(--panel-strong);
}
.stage {
  /* 基础尺寸=原始像素，适配完全由 transform scale 负责（单一权威） */
  user-select: none;
  box-shadow: 0 20px 80px rgba(0, 0, 0, 0.35);
}
.glass-pill {
  position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%);
  z-index: 40; /* 高于 crop-layer(30)：裁剪时 应用/取消/比例/导航 按钮必须可点 */
  display: flex; align-items: center; gap: 4px;
  padding: 6px 10px; border-radius: 999px;
  background: var(--panel); backdrop-filter: blur(var(--blur)) saturate(1.2);
  border: 1px solid var(--border); box-shadow: var(--shadow);
}
.dock-btn {
  height: 32px; min-width: 32px; border: none; border-radius: 999px;
  background: transparent; color: var(--text-2); font-size: 13px;
  cursor: pointer; padding: 0 8px; transition: all 0.15s;
}
.dock-btn.wide { border-radius: 999px; }
.dock-btn:hover { background: var(--accent-weak); color: var(--text); }
.dock-btn.on { background: var(--accent-weak); color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.dock-btn.insp-toggle {
  width: 34px; height: 34px; border-radius: 50%;
  background: var(--accent); color: #fff; font-size: 14px;
  box-shadow: 0 2px 10px rgba(212, 169, 100, 0.4);
}
.dock-btn.insp-toggle:hover { filter: brightness(1.08); }
.dock-btn.ok { color: #6dbf90; }
.dock-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.vsep { width: 1px; height: 18px; background: var(--border); margin: 0 3px; }
.note { font-size: 11.5px; color: var(--accent); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 专业裁切层 */
.crop-layer { position: fixed; z-index: 30; cursor: default; }
.crop-shade { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.55); }
.crop-box { position: absolute; border: 1.5px solid #fff; box-shadow: 0 0 0 1px rgba(0,0,0,.4); cursor: move; }
.grid-line { position: absolute; background: rgba(255, 255, 255, 0.35); pointer-events: none; }
.grid-line.v { top: 0; bottom: 0; width: 1px; }
.grid-line.h { left: 0; right: 0; height: 1px; }
.handle {
  position: absolute; width: 11px; height: 11px;
  background: #fff; border: 1.5px solid var(--accent); border-radius: 2px;
}
.handle.nw { top: -6px; left: -6px; cursor: nwse-resize; }
.handle.n { top: -6px; left: 50%; margin-left: -5.5px; cursor: ns-resize; }
.handle.ne { top: -6px; right: -6px; cursor: nesw-resize; }
.handle.e { top: 50%; right: -6px; margin-top: -5.5px; cursor: ew-resize; }
.handle.se { bottom: -6px; right: -6px; cursor: nwse-resize; }
.handle.s { bottom: -6px; left: 50%; margin-left: -5.5px; cursor: ns-resize; }
.handle.sw { bottom: -6px; left: -6px; cursor: nesw-resize; }
.handle.w { top: 50%; left: -6px; margin-top: -5.5px; cursor: ew-resize; }
.dims {
  position: absolute; bottom: -26px; left: 50%; transform: translateX(-50%);
  font-size: 11px; color: #fff; background: rgba(0, 0, 0, 0.6);
  padding: 2px 8px; border-radius: 5px; white-space: nowrap;
}
.crop-hint {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  font-size: 13px; color: #fff; background: rgba(0, 0, 0, 0.5);
  padding: 8px 16px; border-radius: 9px; pointer-events: none;
}
.crop-bar { bottom: 70px; }
.crop-toast {
  position: absolute; top: 56px; left: 50%; transform: translateX(-50%);
  z-index: 45; padding: 7px 16px; border-radius: 999px;
  background: var(--panel-strong); border: 1px solid var(--accent);
  color: var(--accent); font-size: 12.5px; box-shadow: var(--shadow);
  animation: pop 0.18s ease;
}
/* 应用裁剪三选一对话框 */
.ask-veil {
  position: fixed; inset: 0; z-index: 60;
  background: rgba(0, 0, 0, 0.35); backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center;
}
.ask-card {
  display: flex; flex-direction: column; gap: 8px;
  min-width: 300px; padding: 16px 16px 14px; border-radius: 16px;
  background: var(--panel-strong); border: 1px solid var(--border);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.35);
  animation: pop 0.16s ease;
}
.ask-title { font-size: 13.5px; font-weight: 600; color: var(--text); padding-bottom: 2px; }
.ask-btn {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  border: 1px solid var(--border); border-radius: 10px; background: transparent;
  color: var(--text); padding: 9px 12px; cursor: pointer; text-align: left;
  transition: all 0.15s;
}
.ask-btn:hover { border-color: var(--accent); background: var(--accent-weak); }
.ask-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.ask-btn b { font-size: 13px; }
.ask-btn span { font-size: 11.5px; color: var(--text-2); }
.ask-btn.ghost { align-items: center; color: var(--text-2); border-style: dashed; }
.empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--text-2); }
</style>
