<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useLibrary } from '../stores/library'
import { useTheme } from '../lib/theme'

/* ==========================================================================
   Obsidian Prism 专属光学层（高潮浓彩版）：
   1. 全画布潮汐五彩淡光 (Tidal Prism Veil)：静息时低饱和薄雾沉在底边 22%；
      点选画作/切目录时，从点击列位置 (focusX) 泛起高浓宝石潮汐，平滑涌升至顶栏 94%
      并带一条微珠光潮锋浪冠 (crest)，柔和吻合玻璃顶栏后缓缓退潮归于 0fps 休眠。
      全程超慢层流无抖动，绝不给画作偏色，不闪烁刺眼。
   2. 按钮指针镜面反光委托 (Pointer Specular Delegate)：单监听 rAF 节流写入按钮 --px / --py。
   光学灵感致谢：RMvdesi/obsidian-prism (GPL-3.0)
   ========================================================================== */
const lib = useLibrary()
const { resolved } = useTheme()

const isDark = computed(() => resolved.value === 'obsidian-dark')
const hostEl = ref(null)
const canvasEl = ref(null)

const SPECTRUM_DARK = [
  [66, 133, 244],   // Cobalt #4285F4
  [155, 114, 203],  // Iris   #9B72CB
  [234, 67, 53],    // Coral  #EA4335
  [251, 188, 4],    // Amber  #FBBC04
  [52, 168, 83],    // Emerald #34A853
]
const SPECTRUM_LIGHT = [
  [37, 99, 235],    // Royal Cobalt #2563EB
  [124, 58, 237],   // Vivid Iris   #7C3AED
  [234, 67, 53],    // Coral        #EA4335
  [217, 119, 6],    // Deep Amber   #D97706
  [5, 150, 105],    // Emerald      #059669
]

const IDLE_REACH = 0.22
const PEAK_REACH = 0.94
const RISE_MS = 920
const HOLD_MS = 180
const FRAME_MS = 28 // ~35fps 上限，兼顾流畅涨落与低功耗

let rafId = 0
let lastDrawAt = 0
let prevStepAt = 0
let risingUntil = 0
let holdUntil = 0
let tide = 0 // 连续潮位 0 (底边 22%) -> 1 (满潮 94%)
let flood = 0 // 涌潮动量 0 -> 1，托起浪冠光泽
let focusX = 0.5
let targetFocusX = 0.5
let lastTriggerAt = 0
let reduced = false
let ro = null
let panelEl = null
let cssW = 0
let cssH = 0
let imgData = null

function smoothstep(v) {
  const t = Math.max(0, Math.min(1, v))
  return t * t * (3 - 2 * t)
}

function sampleSpectrum(t, dark, out) {
  const bank = dark ? SPECTRUM_DARK : SPECTRUM_LIGHT
  const n = bank.length
  let u = (t - Math.floor(t)) * n
  const i = Math.floor(u) % n
  const j = (i + 1) % n
  u -= Math.floor(u)
  const a = bank[i]
  const b = bank[j]
  out[0] = a[0] + (b[0] - a[0]) * u
  out[1] = a[1] + (b[1] - a[1]) * u
  out[2] = a[2] + (b[2] - a[2]) * u
}

function syncCanvasSize() {
  const host = hostEl.value
  const cv = canvasEl.value
  if (!host || !cv) return false
  cssW = host.clientWidth || 0
  cssH = host.clientHeight || 0
  if (cssW <= 0 || cssH <= 0) return false
  const bw = Math.max(96, Math.min(280, Math.round(cssW / 4.2)))
  const bh = Math.max(72, Math.min(200, Math.round(cssH / 4.2)))
  if (cv.width !== bw || cv.height !== bh) {
    cv.width = bw
    cv.height = bh
    imgData = null
  }
  return true
}

function syncPanelTideVar() {
  const p = panelEl || hostEl.value?.parentElement
  if (!p) return
  if (tide > 0.01) p.style.setProperty('--op-tide', tide.toFixed(3))
  else p.style.removeProperty('--op-tide')
}

const rgbTmp = [0, 0, 0]

function renderFrame(now) {
  const cv = canvasEl.value
  if (!cv) return
  if (cv.width <= 0 || cv.height <= 0) {
    if (!syncCanvasSize()) return
  }
  const ctx = cv.getContext('2d')
  if (!ctx) return

  const w = cv.width
  const h = cv.height
  if (!imgData || imgData.width !== w || imgData.height !== h) {
    imgData = ctx.createImageData(w, h)
  }
  const data = imgData.data
  const dark = isDark.value
  const timeSec = now * 0.001

  // 潮汐高度（22% -> 94%）与选图涌潮浓度（暗夜 0.25 -> 0.62 / 冷晶 0.21 -> 0.48）
  const baseReach = IDLE_REACH + (PEAK_REACH - IDLE_REACH) * tide
  const idleAlpha = dark ? 0.25 : 0.21
  const surgeAlpha = dark ? 0.62 : 0.48
  const peakAlpha = idleAlpha + (surgeAlpha - idleAlpha) * Math.pow(tide, 0.82)
  const maxReachMargin = Math.min(1, baseReach * 1.18 + 0.06)
  const tBlend = smoothstep(tide)

  for (let py = 0; py < h; py++) {
    const uvY = 1 - py / h // 0 在底边, 1 在顶边
    if (uvY > maxReachMargin) {
      const rowOff = py * w * 4
      data.fill(0, rowOff, rowOff + w * 4)
      continue
    }

    for (let px = 0; px < w; px++) {
      const uvX = px / w
      const dx = uvX - focusX
      const localReach = Math.max(0.16, baseReach * (1 - 0.16 * dx * dx * tide))
      const yNorm = uvY / localReach
      if (yNorm > 1.24) {
        const idx = (py * w + px) * 4
        data[idx] = 0
        data[idx + 1] = 0
        data[idx + 2] = 0
        data[idx + 3] = 0
        continue
      }

      // 超慢层流丝绸波形，无抖动刺眼感
      const waveA = Math.sin(uvX * 3.1 - timeSec * 0.18)
      const waveB = Math.sin(uvX * 5.2 + timeSec * 0.12 + 1.1)
      const curtain = 0.78 + 0.14 * waveA + 0.08 * waveB
      const jut = (waveA * 0.65 + waveB * 0.35) * (0.048 + 0.036 * tide)
      const hJut = Math.max(0, yNorm + jut)

      const edgeFade = uvX < 0.14
        ? 0.56 + 0.44 * smoothstep(uvX / 0.14)
        : (uvX > 0.86 ? 0.56 + 0.44 * smoothstep((1 - uvX) / 0.14) : 1)

      const idleBody = Math.exp(-hJut * hJut * 2.35)
      const surgeBody = Math.pow(Math.max(0, 1 - smoothstep(hJut / 1.06)), 1.25)
      const body = idleBody + (surgeBody - idleBody) * tBlend

      const crestCenter = 0.74 + 0.08 * flood
      const crestDist = (hJut - crestCenter) / 0.21
      const crest = Math.exp(-crestDist * crestDist) * tide * (0.38 + 0.30 * flood)

      const field = Math.min(1.12, (body + crest) * curtain * edgeFade)
      if (field < 0.006) {
        const idx = (py * w + px) * 4
        data[idx] = 0
        data[idx + 1] = 0
        data[idx + 2] = 0
        data[idx + 3] = 0
        continue
      }

      // 极缓五彩宝石光谱采样 + 浪冠微珠光折射
      const pPhase = uvX * 1.02 - timeSec * 0.045 + 0.16 * yNorm - 0.08 * tide
      sampleSpectrum(pPhase, dark, rgbTmp)

      const pearlMix = Math.min(0.22, crest * (dark ? 0.24 : 0.14))
      const r = rgbTmp[0] + (255 - rgbTmp[0]) * pearlMix
      const g = rgbTmp[1] + (255 - rgbTmp[1]) * pearlMix
      const b = rgbTmp[2] + (255 - rgbTmp[2]) * pearlMix

      // 细腻空间抖动消除 8-bit 渐变色带
      const dither = (((px * 73 + py * 179) & 15) / 15 - 0.5) * 1.1
      const alphaByte = Math.max(0, Math.min(255, Math.round(Math.min(peakAlpha, field * peakAlpha) * 255 + dither)))

      const idx = (py * w + px) * 4
      data[idx] = r & 255
      data[idx + 1] = g & 255
      data[idx + 2] = b & 255
      data[idx + 3] = alphaByte
    }
  }

  ctx.putImageData(imgData, 0, 0)
  syncPanelTideVar()
}

function stopLoop() {
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
}

function stepLoop(now) {
  rafId = 0
  if (document.visibilityState === 'hidden') return

  const dt = prevStepAt > 0 ? Math.min(0.05, Math.max(0.001, (now - prevStepAt) * 0.001)) : 0.016
  prevStepAt = now

  const isRising = now < risingUntil
  const isHolding = !isRising && now < holdUntil
  if (isRising) {
    tide += (1 - tide) * (1 - Math.exp(-dt * 4.8))
    flood += (1 - flood) * (1 - Math.exp(-dt * 6.5))
  } else if (isHolding) {
    tide += (1 - tide) * (1 - Math.exp(-dt * 2.4))
    flood *= Math.exp(-dt * 3.2)
  } else {
    tide *= Math.exp(-dt * 1.85)
    flood *= Math.exp(-dt * 4.0)
    if (tide < 0.006) {
      tide = 0
      flood = 0
    }
  }
  focusX += (targetFocusX - focusX) * (1 - Math.exp(-dt * 6.0))

  if (now - lastDrawAt >= FRAME_MS || (!isRising && !isHolding && tide === 0)) {
    lastDrawAt = now
    renderFrame(now)
  }

  if (!reduced && (isRising || isHolding || tide > 0)) {
    rafId = requestAnimationFrame(stepLoop)
  } else {
    prevStepAt = 0
  }
}

function triggerTide(xRatio = null) {
  const now = performance.now()
  if (typeof xRatio === 'number' && Number.isFinite(xRatio)) {
    targetFocusX = Math.max(0.14, Math.min(0.86, xRatio))
    if (tide < 0.05) focusX = targetFocusX
  }
  lastTriggerAt = now
  if (reduced) {
    tide = 0
    flood = 0
    renderFrame(now)
    return
  }
  risingUntil = now + RISE_MS
  holdUntil = risingUntil + HOLD_MS
  if (!rafId && document.visibilityState !== 'hidden') {
    prevStepAt = now
    rafId = requestAnimationFrame(stepLoop)
  }
}

function onPanelClick(e) {
  const card = e.target?.closest?.('.cell, .sf-card')
  if (!card || !hostEl.value) return
  const rect = hostEl.value.getBoundingClientRect()
  const xRatio = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5
  triggerTide(xRatio)
}

/* ---- 能力 B：按钮指针镜面反光轻量委托 (rAF 节流写 --px / --py) ---- */
const BTN_SEL = [
  '.titlebar .tool',
  '.titlebar .wc',
  '.titlebar .nav-arrow',
  '.titlebar .ctl.back',
  '.titlebar .theme-opt',
  '.titlebar .vo-cell',
  '.sidebar .view-item',
  '.sidebar .lib-item',
  '.sidebar .plugin-entry',
  '.inspector .actions button',
  '.inspector .move-btn',
].join(', ')

let ptRaf = 0
let ptEvent = null
let activeBtn = null

function flushPointer() {
  ptRaf = 0
  const e = ptEvent
  ptEvent = null
  if (!e) return
  const target = e.target?.closest?.(BTN_SEL)
  if (!target) {
    if (activeBtn) {
      activeBtn.style.removeProperty('--px')
      activeBtn.style.removeProperty('--py')
      activeBtn = null
    }
    return
  }
  if (activeBtn && activeBtn !== target) {
    activeBtn.style.removeProperty('--px')
    activeBtn.style.removeProperty('--py')
  }
  activeBtn = target
  const r = target.getBoundingClientRect()
  if (r.width > 0 && r.height > 0) {
    target.style.setProperty('--px', Math.round(e.clientX - r.left) + 'px')
    target.style.setProperty('--py', Math.round(e.clientY - r.top) + 'px')
  }
}

function onPointerMove(e) {
  ptEvent = e
  if (!ptRaf) ptRaf = requestAnimationFrame(flushPointer)
}

function onVisibility() {
  if (document.visibilityState === 'hidden') {
    stopLoop()
    prevStepAt = 0
  } else {
    const now = performance.now()
    renderFrame(now)
    if (!reduced && (now < holdUntil || tide > 0) && !rafId) {
      prevStepAt = now
      rafId = requestAnimationFrame(stepLoop)
    }
  }
}

watch(() => [lib.selectedPath, lib.selectedPaths?.length], ([p, len]) => {
  if ((p || len) && performance.now() - lastTriggerAt > 90) {
    triggerTide(0.5)
  }
})
watch(() => [lib.view, lib.currentDirRel], () => {
  triggerTide(0.5)
})
watch(resolved, () => {
  triggerTide(0.5)
})

onMounted(() => {
  reduced = !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
  panelEl = hostEl.value?.parentElement || null
  syncCanvasSize()
  if (hostEl.value && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      if (syncCanvasSize()) renderFrame(performance.now())
    })
    ro.observe(hostEl.value)
  }
  panelEl?.addEventListener('click', onPanelClick, { passive: true })
  document.addEventListener('pointermove', onPointerMove, { passive: true })
  document.addEventListener('visibilitychange', onVisibility)
  triggerTide(0.5)
})

onBeforeUnmount(() => {
  stopLoop()
  if (ptRaf) { cancelAnimationFrame(ptRaf); ptRaf = 0 }
  ro?.disconnect()
  panelEl?.removeEventListener('click', onPanelClick)
  panelEl?.style.removeProperty('--op-tide')
  panelEl = null
  document.removeEventListener('pointermove', onPointerMove)
  document.removeEventListener('visibilitychange', onVisibility)
  if (activeBtn) {
    activeBtn.style.removeProperty('--px')
    activeBtn.style.removeProperty('--py')
    activeBtn = null
  }
})
</script>

<template>
  <div ref="hostEl" class="obsidian-horizon" aria-hidden="true">
    <canvas ref="canvasEl" class="oh-canvas" />
  </div>
</template>

<style scoped>
.obsidian-horizon {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
  border-radius: inherit;
  -webkit-mask-image: linear-gradient(180deg, transparent 0%, rgba(0, 0, 0, 0.74) 7%, #000 19%, #000 100%);
          mask-image: linear-gradient(180deg, transparent 0%, rgba(0, 0, 0, 0.74) 7%, #000 19%, #000 100%);
}
.oh-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
