<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import {
  ANNOT_COLORS,
  ANNOT_TOOLS,
  STROKE_SIZES,
  sizePresetOf,
  sizeKeyForShape,
  cloneShape,
  cloneShapes,
  getShapeBounds,
  hitTestShapes,
  hitTestShapeHandle,
  clampTranslateDelta,
  translateShape,
  resizeShapeByHandle,
  drawShapeSelection,
  renderAnnotations,
  nextStepNumber,
  exportAnnotatedPngBase64,
  clearMosaicCache,
} from '../lib/captureAnnot'

let sessionId = 0
let monIdx = 0

const bgCanvas = ref(null)
const annotCanvas = ref(null)
const magCanvas = ref(null)
const toolbarEl = ref(null)
const textInputRef = ref(null)

const ready = ref(false)
const busy = ref(false)
const colorToast = ref('')
let toastTimer = 0

const mon = reactive({
  width: window.innerWidth,
  height: window.innerHeight,
  scaleFactor: 1,
  targetDir: '',
  windows: [],
})

const vp = reactive({
  cssW: window.innerWidth,
  cssH: window.innerHeight,
})

// mode: 'hover' | 'drawing' | 'selected' | 'moving' | 'resizing' | 'annotating' | 'moving-shape' | 'resizing-shape'
const mode = ref('hover')
const hoverRect = ref(null)
const sel = reactive({ x: 0, y: 0, w: 0, h: 0 })
const cursor = reactive({ px: -1, py: -1, cx: -1, cy: -1, hex: '#000000', rgb: '0, 0, 0' })

// 标注状态（全部存物理像素坐标）
const activeTool = ref('')
const activeSize = ref('md')
const activeColor = ref('#ff4d4f')
const shapes = ref([])
const undoStack = ref([])
const redoStack = ref([])
const selectedIdx = ref(-1)
const hoveredIdx = ref(-1)
const hoveredHandleCursor = ref('')
const textEditor = reactive({ open: false, editIndex: -1, px: 0, py: 0, cx: 0, cy: 0, text: '' })

const selectedShape = computed(() => (selectedIdx.value >= 0 ? shapes.value[selectedIdx.value] || null : null))
const showSubbar = computed(() => toolbarLayout.value.show && (!!activeTool.value || !!selectedShape.value))
const subbarHasColor = computed(() => {
  const t = activeTool.value || selectedShape.value?.type
  return !!t && t !== 'mosaic'
})

let bgCtx = null
let annotCtx = null
let dragInfo = null
let activeShape = null
const mosaicCache = new Map()

function updateVp() {
  vp.cssW = window.innerWidth || 1
  vp.cssH = window.innerHeight || 1
}

function toPhysX(clientX) {
  const r = mon.width / (vp.cssW || 1)
  return Math.max(0, Math.min(mon.width - 1, Math.round(clientX * r)))
}
function toPhysY(clientY) {
  const r = mon.height / (vp.cssH || 1)
  return Math.max(0, Math.min(mon.height - 1, Math.round(clientY * r)))
}
function toCssRect(r) {
  if (!r || r.w <= 0 || r.h <= 0) return null
  const sx = (vp.cssW || 1) / (mon.width || 1)
  const sy = (vp.cssH || 1) / (mon.height || 1)
  return {
    left: r.x * sx,
    top: r.y * sy,
    width: r.w * sx,
    height: r.h * sy,
  }
}

const cssToPhysScale = computed(() => (mon.width || 1) / (vp.cssW || 1))
const physToCssScale = computed(() => (vp.cssW || 1) / (mon.width || 1))

const activeBox = computed(() => {
  if (mode.value === 'hover') {
    return hoverRect.value || { x: 0, y: 0, w: mon.width, h: mon.height }
  }
  return sel
})

const boxCss = computed(() => toCssRect(activeBox.value))

const badgeStyle = computed(() => {
  const b = boxCss.value
  if (!b) return { display: 'none' }
  const top = b.top >= 28 ? b.top - 26 : b.top + 6
  const left = Math.max(6, Math.min(vp.cssW - 140, b.left))
  return { left: `${left}px`, top: `${top}px` }
})

const toolbarLayout = computed(() => {
  const b = boxCss.value
  const activeModes = ['selected', 'annotating', 'moving-shape', 'resizing-shape']
  if (!b || !activeModes.includes(mode.value)) {
    return { show: false, left: 0, top: 0, subAbove: false }
  }
  const barW = Math.min(vp.cssW - 16, 652)
  const barH = 38
  const subH = (activeTool.value || selectedShape.value) ? 36 : 0
  const totalH = barH + subH + 6
  let subAbove = false
  let top = b.top + b.height + 8
  if (top + totalH > vp.cssH - 8) {
    if (b.top - totalH - 8 >= 8) {
      top = b.top - barH - 8
      subAbove = true
    } else {
      top = Math.max(8, b.top + b.height - totalH - 8)
    }
  }
  const left = Math.max(8, Math.min(vp.cssW - barW - 8, b.left + b.width - barW))
  return { show: true, left, top, subAbove }
})

const toolbarStyle = computed(() => {
  if (!toolbarLayout.value.show) return { display: 'none' }
  return { left: `${toolbarLayout.value.left}px`, top: `${toolbarLayout.value.top}px` }
})

const subbarStyle = computed(() => {
  if (!showSubbar.value) return { display: 'none' }
  const top = toolbarLayout.value.subAbove
    ? toolbarLayout.value.top - 36
    : toolbarLayout.value.top + 42
  return { left: `${toolbarLayout.value.left}px`, top: `${Math.max(8, top)}px` }
})

const selCursorStyle = computed(() => {
  if (mode.value === 'hover' || mode.value === 'drawing' || activeTool.value) return 'crosshair'
  if (mode.value === 'moving-shape') return 'grabbing'
  if (mode.value === 'resizing-shape') return dragInfo?.handleCursor || 'nwse-resize'
  if (hoveredHandleCursor.value) return hoveredHandleCursor.value
  if (hoveredIdx.value >= 0) return 'grab'
  return 'move'
})

const showMagnifier = computed(() => {
  if (!ready.value) return false
  if (cursor.px < 0 || cursor.py < 0) return false
  return mode.value === 'hover' || mode.value === 'drawing' || mode.value === 'resizing'
})

const magStyle = computed(() => {
  if (!showMagnifier.value) return { display: 'none' }
  const w = 132
  const h = 174
  let left = cursor.cx + 18
  let top = cursor.cy + 18
  if (left + w > vp.cssW - 8) left = cursor.cx - w - 18
  if (top + h > vp.cssH - 8) top = cursor.cy - h - 18
  left = Math.max(8, left)
  top = Math.max(8, top)
  return { left: `${left}px`, top: `${top}px` }
})

const textEditorStyle = computed(() => {
  if (!textEditor.open) return { display: 'none' }
  const preset = sizePresetOf(activeSize.value)
  const cssFont = Math.max(12, Math.round(preset.font * physToCssScale.value))
  const maxW = Math.max(140, (sel.x + sel.w - textEditor.px) * physToCssScale.value)
  return {
    maxWidth: `${maxW}px`,
    fontSize: `${cssFont}px`,
    color: activeColor.value,
  }
})

function redrawAnnotations() {
  if (!annotCtx || !bgCanvas.value) return
  const clip = mode.value === 'hover' ? null : sel
  const visibleShapes = (textEditor.open && textEditor.editIndex >= 0)
    ? shapes.value.filter((_, idx) => idx !== textEditor.editIndex)
    : shapes.value
  renderAnnotations(annotCtx, visibleShapes, activeShape, bgCanvas.value, clip, mosaicCache)

  if (mode.value !== 'hover') {
    const scale = cssToPhysScale.value
    if (
      hoveredIdx.value >= 0
      && hoveredIdx.value !== selectedIdx.value
      && mode.value === 'selected'
      && !activeTool.value
      && !textEditor.open
      && shapes.value[hoveredIdx.value]
    ) {
      drawShapeSelection(annotCtx, shapes.value[hoveredIdx.value], { hovered: true, scale })
    }
    if (
      selectedIdx.value >= 0
      && shapes.value[selectedIdx.value]
      && !(textEditor.open && textEditor.editIndex === selectedIdx.value)
    ) {
      drawShapeSelection(annotCtx, shapes.value[selectedIdx.value], { selected: true, scale })
    }
  }
}

function hitWindowAt(px, py) {
  for (const w of mon.windows) {
    if (px >= w.x && px < w.x + w.width && py >= w.y && py < w.y + w.height) {
      return { x: w.x, y: w.y, w: w.width, h: w.height }
    }
  }
  return null
}

function clampToSelX(px) {
  return Math.max(sel.x, Math.min(sel.x + sel.w, px))
}
function clampToSelY(py) {
  return Math.max(sel.y, Math.min(sel.y + sel.h, py))
}

function updateMagnifier(px, py) {
  if (!bgCtx) return
  try {
    const data = bgCtx.getImageData(px, py, 1, 1).data
    const r = data[0], g = data[1], b = data[2]
    cursor.rgb = `${r}, ${g}, ${b}`
    cursor.hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()

    const mc = magCanvas.value
    const bg = bgCanvas.value
    if (!mc || !bg) return
    const mctx = mc.getContext('2d')
    if (!mctx) return
    const half = 7
    mctx.fillStyle = '#0f0f12'
    mctx.fillRect(0, 0, mc.width, mc.height)
    mctx.imageSmoothingEnabled = false

    const sx = Math.max(0, px - half)
    const sy = Math.max(0, py - half)
    const ex = Math.min(mon.width, px + half + 1)
    const ey = Math.min(mon.height, py + half + 1)
    const sw = ex - sx
    const sh = ey - sy
    const dx = (sx - (px - half)) * 8
    const dy = (sy - (py - half)) * 8
    if (sw > 0 && sh > 0) {
      mctx.drawImage(bg, sx, sy, sw, sh, dx, dy, sw * 8, sh * 8)
    }

    mctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'
    mctx.lineWidth = 1
    mctx.strokeRect(half * 8 + 0.5, 0.5, 7, mc.height - 1)
    mctx.strokeRect(0.5, half * 8 + 0.5, mc.width - 1, 7)
    mctx.strokeStyle = '#ffcb47'
    mctx.strokeRect(half * 8 + 0.5, half * 8 + 0.5, 7, 7)
  } catch {}
}

function pushHistory(snapshot) {
  undoStack.value.push(snapshot)
  if (undoStack.value.length > 80) {
    undoStack.value.shift()
  }
  redoStack.value = []
}

function selectPointerMode() {
  commitTextEditor()
  activeTool.value = ''
  hoveredHandleCursor.value = ''
  redrawAnnotations()
}

function syncStyleFromShape(shape) {
  if (!shape) return
  if (shape.color) activeColor.value = shape.color
  activeSize.value = sizeKeyForShape(shape)
}

function selectShape(idx) {
  selectedIdx.value = idx
  hoveredHandleCursor.value = ''
  if (idx >= 0 && shapes.value[idx]) {
    syncStyleFromShape(shapes.value[idx])
  }
  redrawAnnotations()
}

function toggleTool(key) {
  commitTextEditor()
  activeTool.value = activeTool.value === key ? '' : key
  if (activeTool.value) {
    selectedIdx.value = -1
    hoveredIdx.value = -1
    hoveredHandleCursor.value = ''
  }
  redrawAnnotations()
}

function applySizeChange(sizeKey) {
  activeSize.value = sizeKey
  if (selectedIdx.value >= 0 && !textEditor.open && shapes.value[selectedIdx.value]) {
    const s = shapes.value[selectedIdx.value]
    const preset = sizePresetOf(sizeKey)
    pushHistory(cloneShapes(shapes.value))
    if (s.type === 'text') {
      s.fontSize = preset.font
    } else if (s.type === 'mosaic') {
      s.strokeWidth = preset.stroke
      s.blockSize = preset.mosaic
    } else {
      s.strokeWidth = preset.stroke
    }
    redrawAnnotations()
  }
}

function applyColorChange(color) {
  activeColor.value = color
  if (selectedIdx.value >= 0 && !textEditor.open && shapes.value[selectedIdx.value] && shapes.value[selectedIdx.value].type !== 'mosaic') {
    pushHistory(cloneShapes(shapes.value))
    shapes.value[selectedIdx.value].color = color
    redrawAnnotations()
  }
}

function deleteSelectedShape() {
  if (selectedIdx.value < 0 || !shapes.value[selectedIdx.value]) return
  pushHistory(cloneShapes(shapes.value))
  shapes.value.splice(selectedIdx.value, 1)
  selectedIdx.value = -1
  hoveredIdx.value = -1
  hoveredHandleCursor.value = ''
  redrawAnnotations()
}

function undo() {
  commitTextEditor()
  if (!undoStack.value.length) return
  redoStack.value.push(cloneShapes(shapes.value))
  shapes.value = undoStack.value.pop()
  if (selectedIdx.value >= shapes.value.length) selectedIdx.value = -1
  hoveredIdx.value = -1
  hoveredHandleCursor.value = ''
  redrawAnnotations()
}

function redo() {
  commitTextEditor()
  if (!redoStack.value.length) return
  undoStack.value.push(cloneShapes(shapes.value))
  shapes.value = redoStack.value.pop()
  if (selectedIdx.value >= shapes.value.length) selectedIdx.value = -1
  hoveredIdx.value = -1
  hoveredHandleCursor.value = ''
  redrawAnnotations()
}

function openTextEditorForEdit(idx) {
  const s = shapes.value[idx]
  if (!s || s.type !== 'text') return
  if (textEditor.open && textEditor.editIndex < 0 && !String(textEditor.text || '').trim()) {
    textEditor.open = false
    textEditor.text = ''
  }
  selectShape(idx)
  const scale = physToCssScale.value
  const cx = Math.max(8, Math.min(vp.cssW - 168, Math.round(s.x * scale)))
  const cy = Math.max(8, Math.min(vp.cssH - 76, Math.round(s.y * scale)))
  textEditor.open = true
  textEditor.editIndex = idx
  textEditor.px = s.x
  textEditor.py = s.y
  textEditor.cx = cx
  textEditor.cy = cy
  textEditor.text = String(s.text || '')
  redrawAnnotations()
  nextTick(() => {
    const el = textInputRef.value
    if (el) {
      el.focus?.()
      const end = el.value?.length ?? 0
      el.setSelectionRange?.(end, end)
      requestAnimationFrame(() => el.focus?.())
    }
  })
}

function commitTextEditor() {
  if (!textEditor.open) return
  const editIdx = textEditor.editIndex
  const content = String(textEditor.text || '').trimEnd()
  textEditor.open = false
  textEditor.editIndex = -1
  textEditor.text = ''
  const preset = sizePresetOf(activeSize.value)

  if (editIdx >= 0 && shapes.value[editIdx]) {
    const orig = shapes.value[editIdx]
    if (!content.trim()) {
      pushHistory(cloneShapes(shapes.value))
      shapes.value.splice(editIdx, 1)
      selectedIdx.value = -1
    } else if (
      orig.text !== content
      || orig.color !== activeColor.value
      || orig.fontSize !== preset.font
    ) {
      pushHistory(cloneShapes(shapes.value))
      shapes.value[editIdx] = {
        ...orig,
        text: content,
        color: activeColor.value,
        fontSize: preset.font,
      }
    }
    redrawAnnotations()
    return
  }

  if (!content.trim()) {
    redrawAnnotations()
    return
  }
  pushHistory(cloneShapes(shapes.value))
  shapes.value.push({
    type: 'text',
    x: textEditor.px,
    y: textEditor.py,
    text: content,
    color: activeColor.value,
    fontSize: preset.font,
  })
  redrawAnnotations()
}

function cancelTextEditor() {
  textEditor.open = false
  textEditor.editIndex = -1
  textEditor.text = ''
  redrawAnnotations()
}

function applyShiftConstraint(x1, y1, x2, y2, tool) {
  if (tool === 'rect' || tool === 'ellipse') {
    const dx = x2 - x1
    const dy = y2 - y1
    const side = Math.max(Math.abs(dx), Math.abs(dy))
    return {
      x2: x1 + (dx >= 0 ? side : -side),
      y2: y1 + (dy >= 0 ? side : -side),
    }
  }
  if (tool === 'arrow') {
    const dx = x2 - x1
    const dy = y2 - y1
    const len = Math.hypot(dx, dy)
    if (len < 1) return { x2, y2 }
    const snappedAngle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
    return {
      x2: x1 + Math.cos(snappedAngle) * len,
      y2: y1 + Math.sin(snappedAngle) * len,
    }
  }
  return { x2, y2 }
}

function onPointerMove(e) {
  const cx = e.clientX
  const cy = e.clientY
  const px = toPhysX(cx)
  const py = toPhysY(cy)
  cursor.cx = cx
  cursor.cy = cy
  cursor.px = px
  cursor.py = py

  if (mode.value === 'hover') {
    hoverRect.value = hitWindowAt(px, py)
    updateMagnifier(px, py)
    return
  }

  if (mode.value === 'annotating' && activeShape) {
    const cpx = clampToSelX(px)
    const cpy = clampToSelY(py)
    if (activeShape.type === 'rect' || activeShape.type === 'ellipse' || activeShape.type === 'arrow') {
      if (e.shiftKey) {
        const pt = applyShiftConstraint(activeShape.x1, activeShape.y1, cpx, cpy, activeShape.type)
        activeShape.x2 = clampToSelX(pt.x2)
        activeShape.y2 = clampToSelY(pt.y2)
      } else {
        activeShape.x2 = cpx
        activeShape.y2 = cpy
      }
      redrawAnnotations()
    } else if (activeShape.type === 'pen' || activeShape.type === 'mosaic') {
      const pts = activeShape.points
      const last = pts[pts.length - 1]
      if (!last || Math.hypot(cpx - last.x, cpy - last.y) >= 2) {
        pts.push({ x: cpx, y: cpy })
        redrawAnnotations()
      }
    }
    return
  }

  if (mode.value === 'moving-shape' && dragInfo) {
    const { dx, dy } = clampTranslateDelta(
      dragInfo.origBounds,
      sel,
      px - dragInfo.startPx,
      py - dragInfo.startPy,
    )
    if (dx !== 0 || dy !== 0) dragInfo.moved = true
    shapes.value[dragInfo.shapeIdx] = translateShape(dragInfo.origShape, dx, dy)
    redrawAnnotations()
    return
  }

  if (mode.value === 'resizing-shape' && dragInfo) {
    const cpx = clampToSelX(px)
    const cpy = clampToSelY(py)
    dragInfo.moved = true
    shapes.value[dragInfo.shapeIdx] = resizeShapeByHandle(
      dragInfo.origShape,
      dragInfo.handleId,
      cpx,
      cpy,
      e.shiftKey,
    )
    redrawAnnotations()
    return
  }

  if (mode.value === 'selected' && !activeTool.value && !textEditor.open && !dragInfo) {
    const handleTol = Math.max(9, Math.round(10 * cssToPhysScale.value))
    const hitSel = selectedIdx.value >= 0 ? shapes.value[selectedIdx.value] : null
    const hh = hitSel ? hitTestShapeHandle(hitSel, px, py, handleTol) : null
    hoveredHandleCursor.value = hh ? hh.cursor : ''

    if (hh) {
      if (hoveredIdx.value !== selectedIdx.value) {
        hoveredIdx.value = selectedIdx.value
        redrawAnnotations()
      }
    } else {
      const inside = px >= sel.x && px <= sel.x + sel.w && py >= sel.y && py <= sel.y + sel.h
      const hitTol = Math.max(8, Math.round(8 * cssToPhysScale.value))
      const hit = inside ? hitTestShapes(shapes.value, px, py, annotCtx, hitTol) : -1
      if (hit !== hoveredIdx.value) {
        hoveredIdx.value = hit
        redrawAnnotations()
      }
    }
  } else if (hoveredHandleCursor.value) {
    hoveredHandleCursor.value = ''
  }

  if (!dragInfo) return

  if (mode.value === 'drawing') {
    const x1 = Math.min(dragInfo.startPx, px)
    const y1 = Math.min(dragInfo.startPy, py)
    const x2 = Math.max(dragInfo.startPx, px)
    const y2 = Math.max(dragInfo.startPy, py)
    sel.x = x1
    sel.y = y1
    sel.w = Math.max(1, x2 - x1 + 1)
    sel.h = Math.max(1, y2 - y1 + 1)
    updateMagnifier(px, py)
  } else if (mode.value === 'moving') {
    const dx = px - dragInfo.startPx
    const dy = py - dragInfo.startPy
    sel.x = Math.max(0, Math.min(mon.width - sel.w, dragInfo.orig.x + dx))
    sel.y = Math.max(0, Math.min(mon.height - sel.h, dragInfo.orig.y + dy))
    if (shapes.value.length) redrawAnnotations()
  } else if (mode.value === 'resizing') {
    const h = dragInfo.handle
    const o = dragInfo.orig
    let left = o.x
    let top = o.y
    let right = o.x + o.w
    let bottom = o.y + o.h
    if (h.includes('w')) left = Math.min(right - 4, px)
    if (h.includes('e')) right = Math.max(left + 4, px + 1)
    if (h.includes('n')) top = Math.min(bottom - 4, py)
    if (h.includes('s')) bottom = Math.max(top + 4, py + 1)
    sel.x = Math.max(0, left)
    sel.y = Math.max(0, top)
    sel.w = Math.max(4, Math.min(mon.width - sel.x, right - sel.x))
    sel.h = Math.max(4, Math.min(mon.height - sel.y, bottom - sel.y))
    updateMagnifier(px, py)
    if (shapes.value.length) redrawAnnotations()
  }
}

function onStageDown(e) {
  if (e.button === 2) return
  if (e.button !== 0 || busy.value) return
  if (e.target.closest?.('.cap-toolbar, .cap-subbar, .cap-text-wrap, .cap-text-box')) return

  const px = toPhysX(e.clientX)
  const py = toPhysY(e.clientY)

  if (mode.value === 'hover') {
    dragInfo = {
      startPx: px,
      startPy: py,
      startCx: e.clientX,
      startCy: e.clientY,
      hoverSnap: hoverRect.value || { x: 0, y: 0, w: mon.width, h: mon.height },
    }
    mode.value = 'drawing'
    sel.x = px
    sel.y = py
    sel.w = 1
    sel.h = 1
    window.addEventListener('pointerup', onWinUp, { once: true })
    return
  }

  if (mode.value === 'selected') {
    if (textEditor.open) {
      commitTextEditor()
      return
    }
    const insideSel = px >= sel.x && px <= sel.x + sel.w && py >= sel.y && py <= sel.y + sel.h

    if (activeTool.value) {
      if (!insideSel) return
      selectedIdx.value = -1
      hoveredIdx.value = -1
      hoveredHandleCursor.value = ''

      const preset = sizePresetOf(activeSize.value)
      if (activeTool.value === 'step') {
        pushHistory(cloneShapes(shapes.value))
        shapes.value.push({
          type: 'step',
          x: px,
          y: py,
          color: activeColor.value,
          strokeWidth: preset.stroke,
          num: nextStepNumber(shapes.value),
        })
        redrawAnnotations()
        return
      }
      if (activeTool.value === 'text') {
        e.preventDefault()
        const maxCx = Math.max(8, vp.cssW - 168)
        const maxCy = Math.max(8, vp.cssH - 76)
        textEditor.open = true
        textEditor.editIndex = -1
        textEditor.px = px
        textEditor.py = py
        textEditor.cx = Math.min(e.clientX, maxCx)
        textEditor.cy = Math.min(e.clientY, maxCy)
        textEditor.text = ''
        redrawAnnotations()
        nextTick(() => {
          textInputRef.value?.focus?.()
          requestAnimationFrame(() => textInputRef.value?.focus?.())
        })
        return
      }

      mode.value = 'annotating'
      if (activeTool.value === 'rect' || activeTool.value === 'ellipse' || activeTool.value === 'arrow') {
        activeShape = {
          type: activeTool.value,
          x1: px,
          y1: py,
          x2: px,
          y2: py,
          color: activeColor.value,
          strokeWidth: preset.stroke,
        }
      } else if (activeTool.value === 'pen') {
        activeShape = {
          type: 'pen',
          points: [{ x: px, y: py }],
          color: activeColor.value,
          strokeWidth: preset.stroke,
        }
      } else if (activeTool.value === 'mosaic') {
        activeShape = {
          type: 'mosaic',
          points: [{ x: px, y: py }],
          strokeWidth: preset.stroke,
          blockSize: preset.mosaic,
        }
      }
      window.addEventListener('pointerup', onWinUp, { once: true })
      return
    }

    // 指针模式：优先检测当前选中批注的角点/端点手柄
    if (selectedIdx.value >= 0 && shapes.value[selectedIdx.value]) {
      const handleTol = Math.max(9, Math.round(10 * cssToPhysScale.value))
      const hh = hitTestShapeHandle(shapes.value[selectedIdx.value], px, py, handleTol)
      if (hh) {
        dragInfo = {
          shapeIdx: selectedIdx.value,
          handleId: hh.id,
          handleCursor: hh.cursor,
          origShape: cloneShape(shapes.value[selectedIdx.value]),
          beforeSnapshot: cloneShapes(shapes.value),
          moved: false,
        }
        mode.value = 'resizing-shape'
        window.addEventListener('pointerup', onWinUp, { once: true })
        return
      }
    }

    if (insideSel) {
      const hitTol = Math.max(8, Math.round(8 * cssToPhysScale.value))
      const hitIdx = hitTestShapes(shapes.value, px, py, annotCtx, hitTol)
      if (hitIdx >= 0) {
        selectShape(hitIdx)
        dragInfo = {
          shapeIdx: hitIdx,
          startPx: px,
          startPy: py,
          origShape: cloneShape(shapes.value[hitIdx]),
          origBounds: getShapeBounds(shapes.value[hitIdx], annotCtx),
          beforeSnapshot: cloneShapes(shapes.value),
          moved: false,
        }
        mode.value = 'moving-shape'
        window.addEventListener('pointerup', onWinUp, { once: true })
        return
      }

      if (selectedIdx.value >= 0) {
        selectedIdx.value = -1
        hoveredHandleCursor.value = ''
        redrawAnnotations()
      }
      dragInfo = { startPx: px, startPy: py, orig: { ...sel } }
      mode.value = 'moving'
      window.addEventListener('pointerup', onWinUp, { once: true })
    } else {
      if (selectedIdx.value >= 0) {
        selectedIdx.value = -1
        hoveredHandleCursor.value = ''
        redrawAnnotations()
      }
      if (!shapes.value.length) {
        // 无标注时，选区外直接开启新框选；已有标注时避免误操作丢失画作
        dragInfo = {
          startPx: px,
          startPy: py,
          startCx: e.clientX,
          startCy: e.clientY,
          hoverSnap: hitWindowAt(px, py) || { x: 0, y: 0, w: mon.width, h: mon.height },
        }
        mode.value = 'drawing'
        sel.x = px
        sel.y = py
        sel.w = 1
        sel.h = 1
        window.addEventListener('pointerup', onWinUp, { once: true })
      }
    }
  }
}

function onHandleDown(handle, e) {
  if (e.button !== 0 || busy.value) return
  e.stopPropagation()
  commitTextEditor()
  dragInfo = {
    handle,
    startPx: toPhysX(e.clientX),
    startPy: toPhysY(e.clientY),
    orig: { ...sel },
  }
  mode.value = 'resizing'
  window.addEventListener('pointerup', onWinUp, { once: true })
}

function onWinUp(e) {
  if (mode.value === 'moving-shape' || mode.value === 'resizing-shape') {
    if (dragInfo?.moved && dragInfo.beforeSnapshot) {
      pushHistory(dragInfo.beforeSnapshot)
    }
    mode.value = 'selected'
    dragInfo = null
    redrawAnnotations()
    return
  }

  if (mode.value === 'annotating') {
    if (activeShape) {
      let valid = false
      if (activeShape.type === 'rect' || activeShape.type === 'ellipse' || activeShape.type === 'arrow') {
        valid = Math.hypot(activeShape.x2 - activeShape.x1, activeShape.y2 - activeShape.y1) >= 4
      } else if (activeShape.type === 'pen' || activeShape.type === 'mosaic') {
        valid = activeShape.points.length >= 1
      }
      if (valid) {
        pushHistory(cloneShapes(shapes.value))
        shapes.value.push(activeShape)
      }
      activeShape = null
      redrawAnnotations()
    }
    mode.value = 'selected'
    return
  }

  if (mode.value === 'drawing' && dragInfo) {
    const moved = Math.hypot(e.clientX - dragInfo.startCx, e.clientY - dragInfo.startCy)
    if (moved < 5) {
      const snap = dragInfo.hoverSnap
      sel.x = snap.x
      sel.y = snap.y
      sel.w = snap.w
      sel.h = snap.h
    }
    mode.value = 'selected'
    redrawAnnotations()
  } else if (mode.value === 'moving' || mode.value === 'resizing') {
    mode.value = 'selected'
  }
  dragInfo = null
}

function onSelDblClick(e) {
  if (busy.value || mode.value !== 'selected') return
  const px = toPhysX(e.clientX)
  const py = toPhysY(e.clientY)
  if (!activeTool.value || activeTool.value === 'text') {
    const hitTol = Math.max(8, Math.round(8 * cssToPhysScale.value))
    const hitIdx = hitTestShapes(shapes.value, px, py, annotCtx, hitTol)
    if (hitIdx >= 0 && shapes.value[hitIdx]?.type === 'text') {
      openTextEditorForEdit(hitIdx)
      return
    }
  }
  if (!activeTool.value) {
    commitAction('copy')
  }
}

function onContextMenu(e) {
  e.preventDefault()
  if (busy.value) return
  if (textEditor.open) {
    cancelTextEditor()
    return
  }
  if (activeTool.value) {
    activeTool.value = ''
    redrawAnnotations()
    return
  }
  if (selectedIdx.value >= 0) {
    selectShape(-1)
    return
  }
  if (mode.value !== 'hover') {
    mode.value = 'hover'
    dragInfo = null
    activeShape = null
    shapes.value = []
    undoStack.value = []
    redoStack.value = []
    selectedIdx.value = -1
    hoveredIdx.value = -1
    hoveredHandleCursor.value = ''
    redrawAnnotations()
    hoverRect.value = hitWindowAt(cursor.px, cursor.py)
  } else {
    cancelCapture()
  }
}

async function cancelCapture() {
  if (busy.value) return
  busy.value = true
  try { await invoke('capture_cancel') } catch {}
}

async function commitAction(action) {
  if (busy.value) return
  commitTextEditor()
  const box = mode.value === 'hover'
    ? (hoverRect.value || { x: 0, y: 0, w: mon.width, h: mon.height })
    : { ...sel }
  if (!box || box.w < 2 || box.h < 2) return
  busy.value = true
  try {
    let annotatedPngB64 = null
    if (shapes.value.length > 0 && bgCanvas.value) {
      annotatedPngB64 = exportAnnotatedPngBase64(bgCanvas.value, box, shapes.value, mosaicCache)
    }
    await invoke('capture_commit', {
      sessionId,
      monIdx,
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.w),
      height: Math.round(box.h),
      action,
      annotatedPngB64,
    })
  } catch {
    busy.value = false
  }
}

function flashToast(msg) {
  colorToast.value = msg
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { colorToast.value = '' }, 1600)
}

function onKeyDown(e) {
  if (textEditor.open) {
    if (e.key === 'Escape') {
      e.preventDefault()
      cancelTextEditor()
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      commitTextEditor()
    }
    return
  }

  if (e.key === 'Escape') {
    e.preventDefault()
    if (selectedIdx.value >= 0) {
      selectShape(-1)
      return
    }
    if (activeTool.value) {
      activeTool.value = ''
      redrawAnnotations()
      return
    }
    cancelCapture()
    return
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && mode.value === 'selected' && selectedIdx.value >= 0) {
    e.preventDefault()
    deleteSelectedShape()
    return
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const lk = String(e.key || '').toLowerCase()
    if (lk === 'z') {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
      return
    }
    if (lk === 'y') {
      e.preventDefault()
      redo()
      return
    }
  }
  if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'v' || e.key === 'V') && mode.value === 'selected') {
    e.preventDefault()
    selectPointerMode()
    return
  }
  if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'p' || e.key === 'P') && mode.value === 'selected') {
    e.preventDefault()
    commitAction('pin')
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    if (e.ctrlKey || e.metaKey) commitAction('save_to_picnest')
    else commitAction('copy')
    return
  }
  if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
    if (showMagnifier.value && cursor.hex) {
      e.preventDefault()
      invoke('capture_copy_text', { text: cursor.hex }).then((r) => {
        if (r?.ok) flashToast(`已复制色值 ${cursor.hex}`)
      }).catch(() => {})
    }
    return
  }
  if (mode.value === 'selected' && !activeTool.value) {
    const step = e.shiftKey ? 10 : 1
    let dx = 0
    let dy = 0
    if (e.key === 'ArrowLeft') dx = -step
    else if (e.key === 'ArrowRight') dx = step
    else if (e.key === 'ArrowUp') dy = -step
    else if (e.key === 'ArrowDown') dy = step

    if (dx || dy) {
      e.preventDefault()
      if (selectedIdx.value >= 0 && shapes.value[selectedIdx.value]) {
        const cur = shapes.value[selectedIdx.value]
        const clamped = clampTranslateDelta(getShapeBounds(cur, annotCtx), sel, dx, dy)
        if (clamped.dx || clamped.dy) {
          if (!e.repeat) pushHistory(cloneShapes(shapes.value))
          shapes.value[selectedIdx.value] = translateShape(cur, clamped.dx, clamped.dy)
          redrawAnnotations()
        }
      } else {
        sel.x = Math.max(0, Math.min(mon.width - sel.w, sel.x + dx))
        sel.y = Math.max(0, Math.min(mon.height - sel.h, sel.y + dy))
        if (shapes.value.length) redrawAnnotations()
      }
    }
  }
}

onMounted(async () => {
  updateVp()
  window.addEventListener('resize', updateVp)
  window.addEventListener('keydown', onKeyDown)

  try {
    const sess = await invoke('capture_get_session')
    if (!sess?.ok) {
      await cancelCapture()
      return
    }
    sessionId = Number(sess.sessionId || 0)
    monIdx = Number(sess.monIdx || 0)
    mon.width = sess.width
    mon.height = sess.height
    mon.scaleFactor = sess.scaleFactor || 1
    mon.windows = Array.isArray(sess.windows) ? sess.windows : []
    mon.targetDir = sess.targetDir || ''

    const loadBitmap = (useCors) => new Promise((resolve, reject) => {
      const im = new Image()
      if (useCors) im.crossOrigin = 'anonymous'
      im.decoding = 'sync'
      im.onload = () => resolve(im)
      im.onerror = reject
      im.src = sess.bmpUrl
    })

    let img
    try {
      img = await loadBitmap(true)
    } catch {
      img = await loadBitmap(false)
    }
    if (img.decode) {
      try { await img.decode() } catch {}
    }

    const c = bgCanvas.value
    if (c) {
      c.width = mon.width
      c.height = mon.height
      bgCtx = c.getContext('2d', { willReadFrequently: true })
      bgCtx?.drawImage(img, 0, 0, mon.width, mon.height)
    }
    const ac = annotCanvas.value
    if (ac) {
      ac.width = mon.width
      ac.height = mon.height
      annotCtx = ac.getContext('2d')
    }
    ready.value = true
    await invoke('capture_ready')
  } catch {
    await cancelCapture()
  }
})

onBeforeUnmount(() => {
  if (toastTimer) clearTimeout(toastTimer)
  clearMosaicCache(mosaicCache)
  window.removeEventListener('resize', updateVp)
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('pointerup', onWinUp)
})
</script>

<template>
  <div
    class="cap-root"
    :class="{ 'is-selected': mode === 'selected', 'is-annot': !!activeTool }"
    @pointermove="onPointerMove"
    @pointerdown="onStageDown"
    @contextmenu="onContextMenu"
  >
    <canvas ref="bgCanvas" class="cap-bg" />
    <canvas ref="annotCanvas" class="cap-annot" />

    <!-- 选区/窗口吸附高亮框：用大 box-shadow 做周围暗罩，拖动零全屏重绘 -->
    <div
      v-if="ready && boxCss"
      class="cap-sel"
      :class="{ hover: mode === 'hover', annotating: !!activeTool }"
      :style="{
        left: `${boxCss.left}px`,
        top: `${boxCss.top}px`,
        width: `${boxCss.width}px`,
        height: `${boxCss.height}px`,
        cursor: selCursorStyle,
      }"
      @dblclick.stop="onSelDblClick($event)"
    >
      <template v-if="mode === 'selected' || mode === 'annotating' || mode === 'moving-shape' || mode === 'resizing-shape'">
        <i v-for="h in ['nw','n','ne','e','se','s','sw','w']" :key="h"
           class="cap-handle" :class="h" @pointerdown="onHandleDown(h, $event)" />
      </template>
    </div>

    <!-- 物理像素尺寸胶囊 -->
    <div v-if="ready && boxCss" class="cap-badge" :style="badgeStyle">
      {{ activeBox.w }} × {{ activeBox.h }}
    </div>

    <!-- 实时文本输入框 -->
    <div
      v-if="textEditor.open"
      class="cap-text-wrap"
      :style="{ left: `${textEditor.cx}px`, top: `${textEditor.cy}px` }"
      @pointerdown.stop
    >
      <textarea
        ref="textInputRef"
        v-model="textEditor.text"
        class="cap-text-box"
        :style="textEditorStyle"
        rows="2"
        placeholder="输入文字…"
      />
      <div class="cap-text-hint">Ctrl+Enter 或点击空白处确认 · Esc 取消</div>
    </div>

    <!-- 像素放大镜 + 取色器 -->
    <div v-if="showMagnifier" class="cap-mag" :style="magStyle">
      <canvas ref="magCanvas" class="cap-mag-cv" width="120" height="120" />
      <div class="cap-mag-info">
        <div class="mag-row"><span>({{ cursor.px }}, {{ cursor.py }})</span></div>
        <div class="mag-row">
          <i class="mag-swatch" :style="{ background: cursor.hex }" />
          <b>{{ cursor.hex }}</b>
        </div>
        <div class="mag-hint">按 C 复制色值 · 右键取消</div>
      </div>
    </div>

    <!-- 选区主工具条（选择/拖拽 + 7 大标注工具 + 撤销重做 + 导出） -->
    <div v-if="toolbarLayout.show" ref="toolbarEl" class="cap-toolbar" :style="toolbarStyle" @pointerdown.stop>
      <button
        class="ct-btn tool"
        :class="{ on: !activeTool }"
        title="选择 / 拖拽批注 (V)"
        @click="selectPointerMode"
      >
        ↖
      </button>
      <button
        v-for="t in ANNOT_TOOLS"
        :key="t.key"
        class="ct-btn tool"
        :class="{ on: activeTool === t.key }"
        :title="t.label"
        @click="toggleTool(t.key)"
      >
        {{ t.icon }}
      </button>
      <i class="ct-sep" />
      <button class="ct-btn tool" :disabled="!undoStack.length" title="撤销 (Ctrl+Z)" @click="undo">↶</button>
      <button class="ct-btn tool" :disabled="!redoStack.length" title="重做 (Ctrl+Y)" @click="redo">↷</button>
      <i class="ct-sep" />
      <button class="ct-btn pin" title="钉在桌面置顶参考 (P)" @click="commitAction('pin')">
        📌 贴图
      </button>
      <button class="ct-btn picnest" title="直接保存到 PicNest 当前文件夹 (Ctrl+Enter)" @click="commitAction('save_to_picnest')">
        入库 PicNest
      </button>
      <button class="ct-btn" title="另存为 PNG 文件" @click="commitAction('save_as')">另存为</button>
      <button class="ct-btn ghost" title="取消 (Esc)" @click="cancelCapture">✕</button>
      <button class="ct-btn ok" title="复制到剪贴板 (Enter)" @click="commitAction('copy')">✓ 复制</button>
    </div>

    <!-- 二级属性微条（粗细/字号 + 6 色板 + 选中删除） -->
    <div v-if="showSubbar" class="cap-subbar" :style="subbarStyle" @pointerdown.stop.prevent>
      <button
        v-for="s in STROKE_SIZES"
        :key="s.key"
        class="cs-size"
        :class="{ on: activeSize === s.key }"
        :title="`${s.label}号`"
        @click="applySizeChange(s.key)"
      >
        <i :style="{ width: (s.stroke * 2 + 2) + 'px', height: (s.stroke * 2 + 2) + 'px' }" />
      </button>
      <template v-if="subbarHasColor">
        <i class="ct-sep" />
        <button
          v-for="c in ANNOT_COLORS"
          :key="c"
          class="cs-color"
          :class="{ on: activeColor === c }"
          :style="{ background: c }"
          :title="c"
          @click="applyColorChange(c)"
        />
      </template>
      <span v-else class="cs-mosaic-tip">马赛克（可 Ctrl+Z 撤销）</span>
      <template v-if="selectedShape && !textEditor.open">
        <i class="ct-sep" />
        <span v-if="selectedShape.type === 'text'" class="cs-mosaic-tip">双击改字</span>
        <button class="cs-del" title="删除选中批注 (Delete)" @click="deleteSelectedShape">删除</button>
      </template>
    </div>

    <div v-if="colorToast" class="cap-toast">{{ colorToast }}</div>
  </div>
</template>

<style scoped>
.cap-root {
  position: fixed;
  inset: 0;
  overflow: hidden;
  user-select: none;
  cursor: crosshair;
  background: #000;
  font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
}
.cap-root.is-annot {
  cursor: crosshair;
}
.cap-bg,
.cap-annot {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  display: block;
  pointer-events: none;
}
.cap-annot {
  z-index: 1;
}
.cap-sel {
  position: fixed;
  box-shadow: 0 0 0 99999px rgba(0, 0, 0, 0.46);
  outline: 1.5px solid #4fa3ff;
  cursor: move;
  z-index: 2;
}
.cap-sel.hover,
.cap-sel.annotating {
  cursor: crosshair;
}
.cap-sel.hover {
  outline: 2px solid #4fa3ff;
}
.cap-handle {
  position: absolute;
  width: 9px;
  height: 9px;
  background: #fff;
  border: 1.5px solid #2b7de9;
  border-radius: 2px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
}
.cap-handle.nw { top: -5px; left: -5px; cursor: nwse-resize; }
.cap-handle.n  { top: -5px; left: 50%; margin-left: -4.5px; cursor: ns-resize; }
.cap-handle.ne { top: -5px; right: -5px; cursor: nesw-resize; }
.cap-handle.e  { top: 50%; right: -5px; margin-top: -4.5px; cursor: ew-resize; }
.cap-handle.se { bottom: -5px; right: -5px; cursor: nwse-resize; }
.cap-handle.s  { bottom: -5px; left: 50%; margin-left: -4.5px; cursor: ns-resize; }
.cap-handle.sw { bottom: -5px; left: -5px; cursor: nesw-resize; }
.cap-handle.w  { top: 50%; left: -5px; margin-top: -4.5px; cursor: ew-resize; }

.cap-badge {
  position: fixed;
  z-index: 5;
  padding: 3px 8px;
  border-radius: 5px;
  background: rgba(18, 20, 24, 0.85);
  color: #f3f5f8;
  font-size: 11.5px;
  font-family: Consolas, monospace;
  pointer-events: none;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.cap-text-wrap {
  position: fixed;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 4px;
  pointer-events: auto;
}

.cap-text-box {
  display: block;
  min-width: 140px;
  padding: 3px 6px;
  border: 1.5px dashed rgba(79, 163, 255, 0.9);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.38);
  font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
  font-weight: 600;
  line-height: 1.28;
  outline: none;
  resize: both;
  cursor: text;
  user-select: text;
  -webkit-user-select: text;
  pointer-events: auto;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.65);
}

.cap-text-hint {
  font-size: 10.5px;
  color: rgba(255, 255, 255, 0.78);
  background: rgba(18, 20, 24, 0.82);
  padding: 2px 7px;
  border-radius: 4px;
  width: max-content;
  pointer-events: none;
}

.cap-mag {
  position: fixed;
  z-index: 6;
  width: 132px;
  padding: 6px;
  border-radius: 8px;
  background: rgba(18, 20, 24, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.16);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.5);
  pointer-events: none;
  color: #e8ecf2;
}
.cap-mag-cv {
  width: 120px;
  height: 120px;
  display: block;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.12);
}
.cap-mag-info {
  margin-top: 5px;
  font-size: 10.5px;
  font-family: Consolas, monospace;
  line-height: 1.35;
}
.mag-row {
  display: flex;
  align-items: center;
  gap: 5px;
}
.mag-swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  display: inline-block;
}
.mag-hint {
  color: #9ba3b0;
  font-size: 9.5px;
  margin-top: 2px;
}

.cap-toolbar,
.cap-subbar {
  position: fixed;
  z-index: 8;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  border-radius: 9px;
  background: rgba(20, 22, 27, 0.93);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.48);
}
.cap-subbar {
  height: 30px;
  padding: 3px 8px;
  gap: 6px;
}
.ct-sep {
  width: 1px;
  height: 18px;
  background: rgba(255, 255, 255, 0.14);
  margin: 0 2px;
}
.ct-btn {
  height: 28px;
  padding: 0 9px;
  border: none;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.07);
  color: #e7ebf2;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.14s, color 0.14s, transform 0.1s;
}
.ct-btn.tool {
  width: 28px;
  padding: 0;
  font-size: 14px;
  background: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.ct-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.16); }
.ct-btn.tool.on {
  background: rgba(79, 163, 255, 0.25);
  color: #6ab5ff;
  box-shadow: inset 0 0 0 1px rgba(79, 163, 255, 0.6);
}
.ct-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.ct-btn:active:not(:disabled) { transform: scale(0.95); }
.ct-btn.pin {
  background: rgba(114, 137, 218, 0.24);
  color: #cad8ff;
  border: 1px solid rgba(114, 137, 218, 0.35);
}
.ct-btn.pin:hover {
  background: rgba(114, 137, 218, 0.38);
  color: #fff;
}
.ct-btn.picnest {
  background: linear-gradient(135deg, #d4a964, #b8843f);
  color: #16120c;
  font-weight: 600;
}
.ct-btn.picnest:hover { filter: brightness(1.08); }
.ct-btn.ok {
  background: #2f80ed;
  color: #fff;
  font-weight: 600;
}
.ct-btn.ok:hover { background: #3c8df7; }
.ct-btn.ghost {
  padding: 0 8px;
  color: #b7becb;
}

.cs-size {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 5px;
  background: transparent;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.cs-size i {
  display: block;
  border-radius: 50%;
  background: #aeb6c4;
}
.cs-size:hover { background: rgba(255, 255, 255, 0.12); }
.cs-size.on { background: rgba(79, 163, 255, 0.24); }
.cs-size.on i { background: #6ab5ff; }

.cs-color {
  width: 15px;
  height: 15px;
  border: 1.5px solid rgba(255, 255, 255, 0.35);
  border-radius: 50%;
  cursor: pointer;
  padding: 0;
  transition: transform 0.12s;
}
.cs-color:hover { transform: scale(1.15); }
.cs-color.on {
  transform: scale(1.18);
  box-shadow: 0 0 0 2px #4fa3ff;
}
.cs-mosaic-tip {
  font-size: 11px;
  color: #aeb6c4;
}
.cs-del {
  height: 22px;
  padding: 0 8px;
  border: 1px solid rgba(255, 92, 96, 0.38);
  border-radius: 5px;
  background: rgba(255, 77, 79, 0.16);
  color: #ff9c9e;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.14s, color 0.14s;
}
.cs-del:hover {
  background: rgba(255, 77, 79, 0.34);
  color: #fff;
}

.cap-toast {
  position: fixed;
  top: 18px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 12;
  padding: 6px 14px;
  border-radius: 999px;
  background: rgba(20, 22, 27, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.16);
  color: #fff;
  font-size: 12px;
  pointer-events: none;
}
</style>
