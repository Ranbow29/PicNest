// QQ 式截图矢量标注与涂鸦引擎（全物理像素坐标系）：
// 支持矩形 / 椭圆 / 实心渐宽箭头 / 二次贝塞尔平滑画笔 / 离屏缓存可撤销马赛克 / 多行文字 / 递增序号圆章
// 所有标注非破坏性存为矢量对象，支持无限步撤销重做，并在提交时 1:1 合成无损 PNG。

export const ANNOT_COLORS = ['#ff4d4f', '#faad14', '#52c41a', '#1677ff', '#ffffff', '#1f1f1f']

export const STROKE_SIZES = [
  { key: 'sm', label: '细', stroke: 2, font: 16, mosaic: 8 },
  { key: 'md', label: '中', stroke: 4, font: 22, mosaic: 14 },
  { key: 'lg', label: '粗', stroke: 7, font: 32, mosaic: 22 },
]

export const ANNOT_TOOLS = [
  { key: 'rect', label: '矩形', icon: '▭' },
  { key: 'ellipse', label: '椭圆', icon: '◯' },
  { key: 'arrow', label: '箭头', icon: '↗' },
  { key: 'pen', label: '画笔', icon: '✎' },
  { key: 'mosaic', label: '马赛克', icon: '▦' },
  { key: 'text', label: '文字', icon: 'T' },
  { key: 'step', label: '序号', icon: '①' },
]

export function sizePresetOf(key) {
  return STROKE_SIZES.find((s) => s.key === key) || STROKE_SIZES[1]
}

export function normalizeRect(x1, y1, x2, y2) {
  const x = Math.min(x1, x2)
  const y = Math.min(y1, y2)
  const w = Math.abs(x2 - x1)
  const h = Math.abs(y2 - y1)
  return { x, y, w, h }
}

/**
 * 懒生成并缓存全屏马赛克画布（按 blockSize 缓存），避免绘制或拖动时反复全屏像素采样。
 */
export function getMosaicLayer(bgCanvas, blockSize, mosaicCache) {
  if (!bgCanvas || !bgCanvas.width || !bgCanvas.height) return null
  const b = Math.max(4, Math.round(blockSize || 14))
  if (mosaicCache && mosaicCache.has(b)) return mosaicCache.get(b)

  const bw = Math.max(1, Math.ceil(bgCanvas.width / b))
  const bh = Math.max(1, Math.ceil(bgCanvas.height / b))

  const tiny = document.createElement('canvas')
  tiny.width = bw
  tiny.height = bh
  const tctx = tiny.getContext('2d')
  if (!tctx) return null
  tctx.imageSmoothingEnabled = true
  tctx.imageSmoothingQuality = 'low'
  tctx.drawImage(bgCanvas, 0, 0, bw, bh)

  const full = document.createElement('canvas')
  full.width = bgCanvas.width
  full.height = bgCanvas.height
  const fctx = full.getContext('2d')
  if (!fctx) {
    tiny.width = 0
    tiny.height = 0
    return null
  }
  fctx.imageSmoothingEnabled = false
  fctx.drawImage(tiny, 0, 0, bgCanvas.width, bgCanvas.height)

  tiny.width = 0
  tiny.height = 0
  if (mosaicCache) mosaicCache.set(b, full)
  return full
}

export function clearMosaicCache(mosaicCache) {
  if (!mosaicCache) return
  for (const cv of mosaicCache.values()) {
    try {
      cv.width = 0
      cv.height = 0
    } catch {}
  }
  mosaicCache.clear()
}

function drawSmoothStrokePath(ctx, points) {
  if (!points || points.length === 0) return
  ctx.beginPath()
  if (points.length === 1) {
    ctx.moveTo(points[0].x, points[0].y)
    ctx.lineTo(points[0].x + 0.01, points[0].y + 0.01)
    return
  }
  ctx.moveTo(points[0].x, points[0].y)
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2
    const midY = (points[i].y + points[i + 1].y) / 2
    ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY)
  }
  const last = points[points.length - 1]
  ctx.lineTo(last.x, last.y)
}

function drawSolidArrow(ctx, x1, y1, x2, y2, strokeWidth, color) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy)
  if (len < 4) return

  const angle = Math.atan2(dy, dx)
  const headLen = Math.min(len * 0.58, Math.max(14, strokeWidth * 4.4))
  const headHalfW = Math.max(7, strokeWidth * 2.35)
  const neckHalfW = Math.max(2.2, strokeWidth * 0.92)
  const tailHalfW = Math.max(0.9, strokeWidth * 0.25)

  const neckX = len - headLen * 0.72
  const wingX = len - headLen

  ctx.save()
  ctx.translate(x1, y1)
  ctx.rotate(angle)
  ctx.beginPath()
  ctx.moveTo(0, -tailHalfW)
  ctx.lineTo(neckX, -neckHalfW)
  ctx.lineTo(wingX, -headHalfW)
  ctx.lineTo(len, 0)
  ctx.lineTo(wingX, headHalfW)
  ctx.lineTo(neckX, neckHalfW)
  ctx.lineTo(0, tailHalfW)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
  ctx.restore()
}

function isLightColor(hex) {
  const s = String(hex || '').replace('#', '')
  if (s.length !== 6) return false
  const r = parseInt(s.slice(0, 2), 16)
  const g = parseInt(s.slice(2, 4), 16)
  const b = parseInt(s.slice(4, 6), 16)
  return (r * 0.299 + g * 0.587 + b * 0.114) > 186
}

export function drawShape(ctx, shape, bgCanvas, mosaicCache) {
  if (!shape || !ctx) return
  const color = shape.color || '#ff4d4f'
  const strokeWidth = Math.max(1, Number(shape.strokeWidth) || 4)

  if (shape.type === 'rect') {
    const r = normalizeRect(shape.x1, shape.y1, shape.x2, shape.y2)
    if (r.w < 1 && r.h < 1) return
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = strokeWidth
    ctx.lineJoin = 'round'
    ctx.strokeRect(r.x, r.y, r.w, r.h)
    ctx.restore()
    return
  }

  if (shape.type === 'ellipse') {
    const r = normalizeRect(shape.x1, shape.y1, shape.x2, shape.y2)
    if (r.w < 1 && r.h < 1) return
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = strokeWidth
    ctx.beginPath()
    ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
    return
  }

  if (shape.type === 'arrow') {
    drawSolidArrow(ctx, shape.x1, shape.y1, shape.x2, shape.y2, strokeWidth, color)
    return
  }

  if (shape.type === 'pen') {
    if (!shape.points?.length) return
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = strokeWidth
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    drawSmoothStrokePath(ctx, shape.points)
    ctx.stroke()
    ctx.restore()
    return
  }

  if (shape.type === 'mosaic') {
    if (!shape.points?.length || !bgCanvas) return
    const layer = getMosaicLayer(bgCanvas, shape.blockSize || 14, mosaicCache)
    if (!layer) return
    const brushW = Math.max(12, strokeWidth * 5.2)

    // 计算轨迹包围盒，只用局部小离屏画布做 mask 合成，4K 屏依然 144Hz 零卡顿
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const pt of shape.points) {
      if (pt.x < minX) minX = pt.x
      if (pt.y < minY) minY = pt.y
      if (pt.x > maxX) maxX = pt.x
      if (pt.y > maxY) maxY = pt.y
    }
    const pad = Math.ceil(brushW / 2) + 2
    const rx = Math.max(0, Math.floor(minX - pad))
    const ry = Math.max(0, Math.floor(minY - pad))
    const rw = Math.min(bgCanvas.width - rx, Math.ceil(maxX + pad) - rx)
    const rh = Math.min(bgCanvas.height - ry, Math.ceil(maxY + pad) - ry)
    if (rw <= 0 || rh <= 0) return

    const tmp = document.createElement('canvas')
    tmp.width = rw
    tmp.height = rh
    const tctx = tmp.getContext('2d')
    if (tctx) {
      tctx.translate(-rx, -ry)
      tctx.lineCap = 'round'
      tctx.lineJoin = 'round'
      tctx.lineWidth = brushW
      tctx.strokeStyle = '#000'
      drawSmoothStrokePath(tctx, shape.points)
      tctx.stroke()

      tctx.globalCompositeOperation = 'source-in'
      tctx.setTransform(1, 0, 0, 1, 0, 0)
      tctx.drawImage(layer, rx, ry, rw, rh, 0, 0, rw, rh)
      ctx.drawImage(tmp, rx, ry)
    }
    tmp.width = 0
    tmp.height = 0
    return
  }

  if (shape.type === 'text') {
    const content = String(shape.text || '')
    if (!content.trim()) return
    const fontSize = Math.max(12, Number(shape.fontSize) || 22)
    const lineH = Math.round(fontSize * 1.28)
    const lines = content.split(/\r?\n/)
    ctx.save()
    ctx.font = `600 ${fontSize}px 'Segoe UI', 'Microsoft YaHei', sans-serif`
    ctx.textBaseline = 'top'
    ctx.lineJoin = 'round'
    ctx.lineWidth = Math.max(2, Math.round(fontSize / 8))
    ctx.strokeStyle = isLightColor(color) ? 'rgba(0, 0, 0, 0.55)' : 'rgba(0, 0, 0, 0.25)'
    ctx.fillStyle = color
    for (let i = 0; i < lines.length; i++) {
      const ly = shape.y + i * lineH
      ctx.strokeText(lines[i], shape.x, ly)
      ctx.fillText(lines[i], shape.x, ly)
    }
    ctx.restore()
    return
  }

  if (shape.type === 'step') {
    const radius = Math.max(11, Math.round(10 + strokeWidth * 1.8))
    const numStr = String(shape.num ?? 1)
    ctx.save()
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)'
    ctx.shadowBlur = 6
    ctx.shadowOffsetY = 2
    ctx.beginPath()
    ctx.arc(shape.x, shape.y, radius, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()

    ctx.shadowColor = 'transparent'
    ctx.lineWidth = 1.5
    ctx.strokeStyle = isLightColor(color) ? 'rgba(0, 0, 0, 0.35)' : 'rgba(255, 255, 255, 0.85)'
    ctx.stroke()

    ctx.fillStyle = isLightColor(color) ? '#1f1f1f' : '#ffffff'
    ctx.font = `700 ${Math.round(radius * 1.08)}px 'Segoe UI', Consolas, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(numStr, shape.x, shape.y + 0.5)
    ctx.restore()
  }
}

export function renderAnnotations(ctx, shapes, activeShape, bgCanvas, clipRect, mosaicCache) {
  if (!ctx || !ctx.canvas) return
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  const list = activeShape ? [...(shapes || []), activeShape] : (shapes || [])
  if (!list.length) return

  ctx.save()
  if (clipRect && clipRect.w > 0 && clipRect.h > 0) {
    ctx.beginPath()
    ctx.rect(clipRect.x, clipRect.y, clipRect.w, clipRect.h)
    ctx.clip()
  }
  for (const s of list) {
    drawShape(ctx, s, bgCanvas, mosaicCache)
  }
  ctx.restore()
}

export function offsetShapes(shapes, dx, dy) {
  if (!Array.isArray(shapes) || (!dx && !dy)) return shapes
  return shapes.map((s) => {
    if (s.type === 'rect' || s.type === 'ellipse' || s.type === 'arrow') {
      return { ...s, x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy }
    }
    if (s.type === 'pen' || s.type === 'mosaic') {
      return { ...s, points: (s.points || []).map((p) => ({ x: p.x + dx, y: p.y + dy })) }
    }
    if (s.type === 'text' || s.type === 'step') {
      return { ...s, x: s.x + dx, y: s.y + dy }
    }
    return s
  })
}

export function nextStepNumber(shapes) {
  let maxNum = 0
  for (const s of shapes || []) {
    if (s.type === 'step' && Number.isFinite(s.num)) {
      maxNum = Math.max(maxNum, s.num)
    }
  }
  return maxNum + 1
}

export function exportAnnotatedPngBase64(bgCanvas, sel, shapes, mosaicCache) {
  if (!bgCanvas || !sel || sel.w < 1 || sel.h < 1) return ''
  const w = Math.max(1, Math.round(sel.w))
  const h = Math.max(1, Math.round(sel.h))
  const sx = Math.max(0, Math.round(sel.x))
  const sy = Math.max(0, Math.round(sel.y))

  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const ctx = out.getContext('2d')
  if (!ctx) return ''

  ctx.drawImage(bgCanvas, sx, sy, w, h, 0, 0, w, h)
  if (shapes && shapes.length) {
    ctx.save()
    ctx.translate(-sx, -sy)
    for (const s of shapes) {
      drawShape(ctx, s, bgCanvas, mosaicCache)
    }
    ctx.restore()
  }

  const dataUrl = out.toDataURL('image/png')
  out.width = 0
  out.height = 0
  const idx = dataUrl.indexOf(',')
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl
}

export function cloneShape(shape) {
  if (!shape || typeof shape !== 'object') return shape
  if (Array.isArray(shape.points)) {
    return {
      ...shape,
      points: shape.points.map((p) => ({ x: p.x, y: p.y })),
    }
  }
  return { ...shape }
}

export function cloneShapes(shapes) {
  if (!Array.isArray(shapes)) return []
  return shapes.map(cloneShape)
}

export function sizeKeyForShape(shape) {
  if (!shape) return 'md'
  let targetVal = Number(shape.strokeWidth) || 4
  let field = 'stroke'
  if (shape.type === 'text') {
    targetVal = Number(shape.fontSize) || 22
    field = 'font'
  } else if (shape.type === 'mosaic') {
    if (Number.isFinite(Number(shape.blockSize))) {
      targetVal = Number(shape.blockSize)
      field = 'mosaic'
    }
  }
  let best = STROKE_SIZES[1]
  let bestDiff = Infinity
  for (const s of STROKE_SIZES) {
    const d = Math.abs((s[field] || 0) - targetVal)
    if (d < bestDiff) {
      bestDiff = d
      best = s
    }
  }
  return best.key
}

export function measureTextBounds(shape, ctx) {
  const fontSize = Math.max(12, Number(shape?.fontSize) || 22)
  const lineH = Math.round(fontSize * 1.28)
  const lines = String(shape?.text || '').split(/\r?\n/)
  let maxW = 0

  if (ctx && typeof ctx.measureText === 'function') {
    ctx.save()
    ctx.font = `600 ${fontSize}px 'Segoe UI', 'Microsoft YaHei', sans-serif`
    for (const line of lines) {
      const m = ctx.measureText(line)
      if (m && Number.isFinite(m.width)) {
        maxW = Math.max(maxW, m.width)
      }
    }
    ctx.restore()
  } else {
    for (const line of lines) {
      let w = 0
      for (const ch of line) {
        w += ch.charCodeAt(0) > 127 ? fontSize : fontSize * 0.6
      }
      maxW = Math.max(maxW, w)
    }
  }

  return {
    x: Number(shape?.x) || 0,
    y: Number(shape?.y) || 0,
    w: Math.max(fontSize, Math.ceil(maxW)),
    h: Math.max(lineH, lines.length * lineH),
  }
}

export function getShapeBounds(shape, ctx) {
  if (!shape) return null
  const strokeWidth = Math.max(1, Number(shape.strokeWidth) || 4)

  if (shape.type === 'rect' || shape.type === 'ellipse' || shape.type === 'arrow') {
    return normalizeRect(shape.x1, shape.y1, shape.x2, shape.y2)
  }

  if (shape.type === 'pen' || shape.type === 'mosaic') {
    const pts = shape.points
    if (!Array.isArray(pts) || !pts.length) return null
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const pt of pts) {
      if (pt.x < minX) minX = pt.x
      if (pt.y < minY) minY = pt.y
      if (pt.x > maxX) maxX = pt.x
      if (pt.y > maxY) maxY = pt.y
    }
    const half = shape.type === 'mosaic'
      ? Math.max(6, strokeWidth * 2.6)
      : Math.max(2, strokeWidth / 2)
    return {
      x: minX - half,
      y: minY - half,
      w: Math.max(1, maxX - minX + half * 2),
      h: Math.max(1, maxY - minY + half * 2),
    }
  }

  if (shape.type === 'text') {
    return measureTextBounds(shape, ctx)
  }

  if (shape.type === 'step') {
    const radius = Math.max(11, Math.round(10 + strokeWidth * 1.8))
    return {
      x: shape.x - radius,
      y: shape.y - radius,
      w: radius * 2,
      h: radius * 2,
    }
  }

  return null
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  if (lenSq <= 1e-6) return Math.hypot(px - x1, py - y1)
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

function minDistToPolyline(px, py, points) {
  if (!Array.isArray(points) || !points.length) return Infinity
  if (points.length === 1) {
    return Math.hypot(px - points[0].x, py - points[0].y)
  }
  let best = Infinity
  for (let i = 0; i < points.length - 1; i++) {
    const d = distToSegment(px, py, points[i].x, points[i].y, points[i + 1].x, points[i + 1].y)
    if (d < best) best = d
  }
  return best
}

export function hitTestShape(shape, px, py, ctx, tol = 8) {
  if (!shape) return false
  const strokeWidth = Math.max(1, Number(shape.strokeWidth) || 4)

  if (shape.type === 'rect') {
    const r = normalizeRect(shape.x1, shape.y1, shape.x2, shape.y2)
    const edgeTol = Math.max(tol, strokeWidth / 2 + 5)
    if (r.w < 24 || r.h < 24) {
      return px >= r.x - edgeTol && px <= r.x + r.w + edgeTol && py >= r.y - edgeTol && py <= r.y + r.h + edgeTol
    }
    const dTop = distToSegment(px, py, r.x, r.y, r.x + r.w, r.y)
    const dRight = distToSegment(px, py, r.x + r.w, r.y, r.x + r.w, r.y + r.h)
    const dBottom = distToSegment(px, py, r.x + r.w, r.y + r.h, r.x, r.y + r.h)
    const dLeft = distToSegment(px, py, r.x, r.y + r.h, r.x, r.y)
    return Math.min(dTop, dRight, dBottom, dLeft) <= edgeTol
  }

  if (shape.type === 'ellipse') {
    const r = normalizeRect(shape.x1, shape.y1, shape.x2, shape.y2)
    const rx = r.w / 2
    const ry = r.h / 2
    const cx = r.x + rx
    const cy = r.y + ry
    const edgeTol = Math.max(tol, strokeWidth / 2 + 5)
    if (rx < 12 || ry < 12) {
      return Math.hypot(px - cx, py - cy) <= Math.max(rx, ry) + edgeTol
    }
    const nx = (px - cx) / rx
    const ny = (py - cy) / ry
    const d = Math.hypot(nx, ny)
    if (d === 0) return false
    const gradLen = Math.hypot(nx / rx, ny / ry)
    if (gradLen <= 1e-6) return false
    const dist = Math.abs(d - 1) / gradLen
    return dist <= edgeTol
  }

  if (shape.type === 'arrow') {
    const dSeg = distToSegment(px, py, shape.x1, shape.y1, shape.x2, shape.y2)
    const dTip = Math.hypot(px - shape.x2, py - shape.y2)
    return Math.min(dSeg, dTip) <= Math.max(tol, strokeWidth * 1.6 + 6)
  }

  if (shape.type === 'pen') {
    return minDistToPolyline(px, py, shape.points) <= Math.max(tol, strokeWidth / 2 + 6)
  }

  if (shape.type === 'mosaic') {
    const brushHalf = Math.max(12, strokeWidth * 5.2) / 2
    return minDistToPolyline(px, py, shape.points) <= Math.max(tol, brushHalf + 4)
  }

  if (shape.type === 'text') {
    const b = measureTextBounds(shape, ctx)
    const pad = Math.max(6, tol * 0.75)
    return px >= b.x - pad && px <= b.x + b.w + pad && py >= b.y - pad && py <= b.y + b.h + pad
  }

  if (shape.type === 'step') {
    const radius = Math.max(11, Math.round(10 + strokeWidth * 1.8))
    return Math.hypot(px - shape.x, py - shape.y) <= radius + Math.max(4, tol * 0.6)
  }

  return false
}

export function hitTestShapes(shapes, px, py, ctx, tol = 8) {
  if (!Array.isArray(shapes) || !shapes.length) return -1
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (hitTestShape(shapes[i], px, py, ctx, tol)) {
      return i
    }
  }
  return -1
}

export function getShapeHandles(shape) {
  if (!shape) return []
  if (shape.type === 'rect' || shape.type === 'ellipse') {
    const r = normalizeRect(shape.x1, shape.y1, shape.x2, shape.y2)
    return [
      { id: 'nw', x: r.x, y: r.y, cursor: 'nwse-resize' },
      { id: 'ne', x: r.x + r.w, y: r.y, cursor: 'nesw-resize' },
      { id: 'se', x: r.x + r.w, y: r.y + r.h, cursor: 'nwse-resize' },
      { id: 'sw', x: r.x, y: r.y + r.h, cursor: 'nesw-resize' },
    ]
  }
  if (shape.type === 'arrow') {
    return [
      { id: 'start', x: shape.x1, y: shape.y1, cursor: 'grab' },
      { id: 'end', x: shape.x2, y: shape.y2, cursor: 'grab' },
    ]
  }
  return []
}

export function hitTestShapeHandle(shape, px, py, tol = 10) {
  const handles = getShapeHandles(shape)
  for (const h of handles) {
    if (Math.hypot(px - h.x, py - h.y) <= tol) {
      return h
    }
  }
  return null
}

export function clampTranslateDelta(bounds, sel, dx, dy) {
  if (!bounds || !sel || sel.w <= 0 || sel.h <= 0) return { dx, dy }
  let minDx
  let maxDx
  if (bounds.w <= sel.w) {
    minDx = sel.x - bounds.x
    maxDx = sel.x + sel.w - (bounds.x + bounds.w)
  } else {
    minDx = sel.x + 16 - (bounds.x + bounds.w)
    maxDx = sel.x + sel.w - 16 - bounds.x
  }
  let minDy
  let maxDy
  if (bounds.h <= sel.h) {
    minDy = sel.y - bounds.y
    maxDy = sel.y + sel.h - (bounds.y + bounds.h)
  } else {
    minDy = sel.y + 16 - (bounds.y + bounds.h)
    maxDy = sel.y + sel.h - 16 - bounds.y
  }
  const cdx = Math.max(minDx, Math.min(maxDx, dx))
  const cdy = Math.max(minDy, Math.min(maxDy, dy))
  return { dx: Math.round(cdx), dy: Math.round(cdy) }
}

export function translateShape(shape, dx, dy) {
  if (!shape) return shape
  if (!dx && !dy) return cloneShape(shape)
  if (shape.type === 'rect' || shape.type === 'ellipse' || shape.type === 'arrow') {
    return {
      ...shape,
      x1: shape.x1 + dx,
      y1: shape.y1 + dy,
      x2: shape.x2 + dx,
      y2: shape.y2 + dy,
    }
  }
  if (shape.type === 'pen' || shape.type === 'mosaic') {
    return {
      ...shape,
      points: (shape.points || []).map((p) => ({ x: p.x + dx, y: p.y + dy })),
    }
  }
  if (shape.type === 'text' || shape.type === 'step') {
    return {
      ...shape,
      x: shape.x + dx,
      y: shape.y + dy,
    }
  }
  return cloneShape(shape)
}

export function resizeShapeByHandle(origShape, handleId, px, py, shiftKey = false) {
  if (!origShape) return origShape
  if (origShape.type === 'arrow') {
    const isStart = handleId === 'start'
    const ax = isStart ? origShape.x2 : origShape.x1
    const ay = isStart ? origShape.y2 : origShape.y1
    let nx = px
    let ny = py
    if (shiftKey) {
      const len = Math.hypot(nx - ax, ny - ay)
      if (len >= 1) {
        const angle = Math.round(Math.atan2(ny - ay, nx - ax) / (Math.PI / 4)) * (Math.PI / 4)
        nx = ax + Math.cos(angle) * len
        ny = ay + Math.sin(angle) * len
      }
    }
    return isStart
      ? { ...origShape, x1: nx, y1: ny, x2: ax, y2: ay }
      : { ...origShape, x1: ax, y1: ay, x2: nx, y2: ny }
  }

  if (origShape.type === 'rect' || origShape.type === 'ellipse') {
    const r = normalizeRect(origShape.x1, origShape.y1, origShape.x2, origShape.y2)
    let ax = r.x
    let ay = r.y
    if (handleId === 'nw') {
      ax = r.x + r.w
      ay = r.y + r.h
    } else if (handleId === 'ne') {
      ax = r.x
      ay = r.y + r.h
    } else if (handleId === 'se') {
      ax = r.x
      ay = r.y
    } else if (handleId === 'sw') {
      ax = r.x + r.w
      ay = r.y
    }
    let nx = px
    let ny = py
    if (shiftKey) {
      const dx = nx - ax
      const dy = ny - ay
      const side = Math.max(Math.abs(dx), Math.abs(dy))
      nx = ax + (dx >= 0 ? side : -side)
      ny = ay + (dy >= 0 ? side : -side)
    }
    return {
      ...origShape,
      x1: ax,
      y1: ay,
      x2: nx,
      y2: ny,
    }
  }

  return cloneShape(origShape)
}

export function drawShapeSelection(ctx, shape, { hovered = false, selected = false, scale = 1 } = {}) {
  if (!ctx || !shape) return
  if (!hovered && !selected) return
  const s = Math.max(1, Number(scale) || 1)
  const b = getShapeBounds(shape, ctx)
  if (!b) return
  const p = Math.round(5 * s)
  const bx = b.x - p
  const by = b.y - p
  const bw = b.w + p * 2
  const bh = b.h + p * 2

  if (hovered && !selected) {
    ctx.save()
    ctx.lineWidth = 1.5 * s
    ctx.strokeStyle = 'rgba(79, 163, 255, 0.78)'
    ctx.setLineDash([5 * s, 4 * s])
    ctx.strokeRect(bx, by, bw, bh)
    ctx.restore()
    return
  }

  ctx.save()
  const dash = [5 * s, 3.5 * s]
  const boxAlpha = shape.type === 'arrow' ? 0.45 : 0.95

  // Subtle dark halo for legibility on bright backgrounds
  ctx.lineWidth = 2.6 * s
  ctx.strokeStyle = `rgba(0, 0, 0, ${shape.type === 'arrow' ? 0.22 : 0.38})`
  ctx.setLineDash(dash)
  ctx.strokeRect(bx, by, bw, bh)

  // Bright dashed outline
  ctx.lineWidth = 1.5 * s
  ctx.strokeStyle = `rgba(79, 163, 255, ${boxAlpha})`
  ctx.setLineDash(dash)
  ctx.strokeRect(bx, by, bw, bh)
  ctx.restore()

  const handles = getShapeHandles(shape)
  if (!handles.length) return
  const radius = 4.5 * s
  ctx.save()
  ctx.setLineDash([])
  for (const h of handles) {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.4)'
    ctx.shadowBlur = 4 * s
    ctx.shadowOffsetY = 1 * s
    ctx.beginPath()
    ctx.arc(h.x, h.y, radius, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()

    ctx.shadowColor = 'transparent'
    ctx.lineWidth = 1.8 * s
    ctx.strokeStyle = '#2b7de9'
    ctx.stroke()
  }
  ctx.restore()
}
