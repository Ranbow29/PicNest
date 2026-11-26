// PicNest 通用动效导演层 (Motion Director)
// 为风格主题提供 4 条语义化动效通道，与核心业务逻辑彻底解耦：
//   1. bladeSweep / scanSweep / prismSweep — 换肤切镜光带
//   2. originFrame                          — 空间锚点取景框（从点击缩略图坐标拉镜至全屏舞台）
//   3. sidebarPulse                         — 保留扩展通道
//   4. coldEntrance                         — 开版因果序列（挂 data-stage="boot" 定时自动卸载）
import { reactive } from 'vue'

export const motionState = reactive({
  bladeSeq: 0,
  bladeActive: false,
  scanSeq: 0,
  scanActive: false,
  prismSeq: 0,
  prismActive: false,
  frameSeq: 0,
  frameActive: false,
  frameRect: null,
  frameTag: '',
  pulseSeq: 0,
  pulseActive: false,
  pulseY: 160,
  pulseX: 240,
})

let bladeT = 0
let scanT = 0
let prismT = 0
let frameT = 0
let pulseT = 0
let bootT = 0

function isReduced() {
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
}

function isStyledMotion() {
  const m = document.documentElement.dataset.motion
  return (m === 'acid' || m === 'mech' || m === 'prism') && !isReduced()
}

/* Channel 1A: 酸性印刷丝网刮墨刀锋光带（与 ViewTransition 斜切 polygon 420ms 严格同步） */
export function playBladeSweep() {
  if (isReduced()) return
  motionState.bladeSeq += 1
  motionState.bladeActive = true
  clearTimeout(bladeT)
  bladeT = setTimeout(() => { motionState.bladeActive = false }, 460)
}

/* Channel 1B: 终末工业精密水平激光扫描游标（与 ViewTransition inset 360ms 严格同步） */
export function playScanSweep() {
  if (isReduced()) return
  motionState.scanSeq += 1
  motionState.scanActive = true
  clearTimeout(scanT)
  scanT = setTimeout(() => { motionState.scanActive = false }, 400)
}

/* Channel 1C: 黑曜棱镜四色柔光光谱折射横扫（与 ViewTransition inset 420ms 严格同步） */
export function playPrismSweep() {
  if (isReduced()) return
  motionState.prismSeq += 1
  motionState.prismActive = true
  clearTimeout(prismT)
  prismT = setTimeout(() => { motionState.prismActive = false }, 460)
}

/* Channel 2: 空间锚点取景框（双击缩略图进灯箱时从源卡片坐标高速拉满舞台） */
export function triggerOriginFrame(rect, tag = '') {
  if (!isStyledMotion() || !rect || !rect.width || !rect.height) return
  motionState.frameRect = {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
  motionState.frameTag = String(tag || 'VIEW').toUpperCase()
  motionState.frameSeq += 1
  motionState.frameActive = true
  clearTimeout(frameT)
  frameT = setTimeout(() => { motionState.frameActive = false }, 260)
}

/* Channel 3: 侧栏目录 → 主画布横向引导脉冲（保留通道） */
export function emitSidebarPulse(y, x) {
  if (!isStyledMotion()) return
  const clampedY = Math.max(48, Math.min(window.innerHeight - 24, Math.round(y || 160)))
  const clampedX = Math.max(120, Math.min(460, Math.round(x || 240)))
  motionState.pulseY = clampedY
  motionState.pulseX = clampedX
  motionState.pulseSeq += 1
  motionState.pulseActive = true
  clearTimeout(pulseT)
  pulseT = setTimeout(() => { motionState.pulseActive = false }, 280)
}

/* Channel 4: 开版因果序列（挂 data-stage="boot" 560ms 后自动卸载） */
export function startColdEntrance() {
  if (isReduced()) return
  const root = document.documentElement
  root.dataset.stage = 'boot'
  clearTimeout(bootT)
  bootT = setTimeout(() => {
    if (root.dataset.stage === 'boot') delete root.dataset.stage
  }, 560)
}
