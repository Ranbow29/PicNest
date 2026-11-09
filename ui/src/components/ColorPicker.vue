<script setup>
// Eagle 式取色面板：SV 渐变方块 + 竖直色相条（真源：Eagle filter-item-color.html 的 colorpicker 区）
import { ref, watch } from 'vue'

const props = defineProps({ modelValue: { type: String, default: '#ffffff' } })
const emit = defineEmits(['update:modelValue'])

const hsv = ref([0, 0, 1]) // h 0-360 · s 0-1 · v 0-1
const svEl = ref(null)
const hueEl = ref(null)
const canEyeDrop = typeof window !== 'undefined' && 'EyeDropper' in window

// 屏幕吸色（Chromium 原生 EyeDropper；Esc 取消）
async function pickFromScreen() {
  try {
    const res = await new EyeDropper().open()
    if (res?.sRGBHex) emit('update:modelValue', res.sRGBHex.toUpperCase())
  } catch { /* 用户取消 */ }
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '')
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('').toUpperCase()
}
function hsvToRgb(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6
    return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255
  }
  return [f(5), f(3), f(1)]
}
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  let h = 0
  if (d) {
    if (max === r) h = ((g - b) / d + 6) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
  }
  return [h, max ? d / max : 0, max]
}

function emitHsv() {
  emit('update:modelValue', rgbToHex(...hsvToRgb(...hsv.value)))
}

// 外部值（色板/hex 输入/图吸色）→ 同步 HSV；规避自触发回环
watch(() => props.modelValue, (hex) => {
  const rgb = hexToRgb(hex)
  if (!rgb) return
  if (rgbToHex(...hsvToRgb(...hsv.value)) === rgbToHex(...rgb)) return
  hsv.value = rgbToHsv(...rgb)
}, { immediate: true })

function dragTrack(el, e, onPick) {
  el.setPointerCapture(e.pointerId)
  const rect = el.getBoundingClientRect()
  const apply = (ev) => onPick(
    Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)),
    Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height)),
  )
  apply(e)
  const move = (ev) => apply(ev)
  const up = () => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', up)
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
}
function svDrag(e) {
  dragTrack(svEl.value, e, (x, y) => { hsv.value = [hsv.value[0], x, 1 - y]; emitHsv() })
}
function hueDrag(e) {
  dragTrack(hueEl.value, e, (_x, y) => { hsv.value = [y * 359.9, hsv.value[1], hsv.value[2]]; emitHsv() })
}
</script>

<template>
  <div class="cp">
    <div class="cp-row">
      <div class="sv" ref="svEl" :style="{ background: `hsl(${hsv[0]}, 100%, 50%)` }"
           @pointerdown.prevent="svDrag">
        <div class="sv-white"></div>
        <div class="sv-black"></div>
        <i class="dot" :style="{ left: `calc(${hsv[1] * 100}% - 5px)`, top: `calc(${(1 - hsv[2]) * 100}% - 5px)` }"></i>
      </div>
      <div class="hue" ref="hueEl" @pointerdown.prevent="hueDrag">
        <i class="hue-dot" :style="{ top: `calc(${(hsv[0] / 360) * 100}% - 4px)` }"></i>
      </div>
    </div>
    <button v-if="canEyeDrop" class="eyedrop" title="从屏幕吸取颜色（吸管）" @click="pickFromScreen">⌖ 屏幕吸色</button>
  </div>
</template>

<style scoped>
.cp { margin-bottom: 8px; }
.cp-row { display: flex; gap: 8px; justify-content: center; margin-bottom: 6px; }
.sv {
  position: relative; width: 150px; height: 150px; border-radius: 10px; cursor: crosshair; /* 正方形：CSP/Eagle 惯例 */
  border: 1px solid var(--border); overflow: hidden; touch-action: none;
}
.sv-white { position: absolute; inset: 0; background: linear-gradient(90deg, #fff, transparent); }
.sv-black { position: absolute; inset: 0; background: linear-gradient(0deg, #000, transparent); }
.sv .dot {
  position: absolute; width: 10px; height: 10px; border-radius: 50%;
  border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5), inset 0 0 0 1px rgba(0, 0, 0, 0.3);
  pointer-events: none;
}
.hue {
  position: relative; width: 16px; height: 150px; border-radius: 8px; cursor: ns-resize;
  background: linear-gradient(180deg, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%);
  border: 1px solid var(--border); touch-action: none;
}
.hue-dot {
  position: absolute; left: 2px; right: 2px; height: 8px; border-radius: 4px;
  border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5); pointer-events: none;
}
.eyedrop {
  width: 100%; height: 26px; border: 1px solid var(--border); border-radius: 7px;
  background: var(--bg-2); color: var(--text-2); font-size: 12px; cursor: pointer;
  transition: all 0.15s;
}
.eyedrop:hover { border-color: var(--accent); color: var(--text); }
</style>
