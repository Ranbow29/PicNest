<script setup>
// 文件夹动效图标（Wenku8_Flutter archive_icon_fold_art 原版几何移植，GPL-2.0-or-later © MewX / mikufoxxx）：
// 后纸卡片随 q 上提（抽出感），前板随 p 下压（开口变大）；8 色填充。
// 环境自弹：只给「当前高亮文件夹」开（ambient 传入 true），频率 6-14s；其他文件夹仅 hover 手势。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { GESTURE_MS, layerAt, scheduleAmbient, iconShake } from '../lib/iconMotion'

const props = defineProps({
  color: { type: String, default: '' },   // '' = 默认金灰
  size: { type: Number, default: 18 },
  open: { type: Boolean, default: false }, // 展开态：前板下压（开口变大）
  ambient: { type: Boolean, default: false }, // 仅当前高亮文件夹为 true
})

const FILLS = {
  '': 'var(--folder-default, #c9a86c)', // 默认跟随主题（低饱和黑白主题下为灰）
  blue: '#5b9bd5', green: '#6dbf90', red: '#e57373',
  orange: '#f0a45c', purple: '#a48ad4', cyan: '#5bc4c4', pink: '#e88ab8',
}
const fill = computed(() => FILLS[props.color] || props.color || FILLS[''])

const phase = ref(-1)
let raf = 0
let cancelAmbient = null
function play() {
  cancelAnimationFrame(raf)
  const t0 = performance.now()
  const tick = (now) => {
    const t = (now - t0) / GESTURE_MS
    if (t >= 1) { phase.value = -1; return }
    phase.value = t
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
}

// 集体晃动：总线 +1 时同步手势
watch(iconShake, () => play())
function startAmbient() {
  if (cancelAmbient) return
  const loop = () => { cancelAmbient = scheduleAmbient(() => { play(); loop() }, 6000, 14000) }
  loop()
}
function stopAmbient() {
  cancelAmbient?.()
  cancelAmbient = null
}
// ambient 开关切换（高亮文件夹换人时，旧图标停摆新图标起弹）
watch(() => props.ambient, (v) => (v ? startAmbient() : stopAmbient()), { immediate: true })
onBeforeUnmount(() => { cancelAnimationFrame(raf); stopAmbient() })

const p = computed(() => (phase.value < 0 ? 0 : layerAt(phase.value, 0)))
const q = computed(() => (phase.value < 0 ? 0 : layerAt(phase.value, 55)))

// 后纸卡片（card 6, 4.6-2.6q, 12.6, 13.3, fold 2.8）
const cardY = computed(() => 4.6 - 2.6 * q.value)
// 前板：open = (open?0.6:0) + p → 各点 y 偏移 2.1*open
const lip = computed(() => (props.open ? 0.6 : 0) + p.value)
const lipY = (base) => base + 2.1 * lip.value
</script>

<template>
  <svg
    :width="size" :height="size" viewBox="0 0 24 24" class="folder-ico" :class="{ open }"
    fill="none" stroke-linecap="round" stroke-linejoin="round"
    @mouseenter="play"
  >
    <!-- 后纸卡片：随 q 上抽 -->
    <path
      :d="`M6 ${cardY} L15.8 ${cardY} L18.6 ${cardY + 2.8} L18.6 ${cardY + 13.3} L6 ${cardY + 13.3} Z`"
      :fill="fill" :stroke="fill" stroke-width="1.4" :opacity="0.4"
    />
    <!-- 前板：随 p/lip 开合 -->
    <path
      :d="`M3 ${lipY(8.4)} L8 ${lipY(8.4)} L10.4 ${lipY(10)} L21.5 ${lipY(10)} L19.7 20.2 L4.4 20.2 Z`"
      :fill="fill" :stroke="fill" stroke-width="1.4" :opacity="0.85"
    />
    <!-- 底部标记：点 + 短线（Wenku8 原位） -->
    <circle cx="6.2" cy="16.7" r="1.15" fill="#fff" opacity="0.95" stroke="none" />
    <line x1="9.2" y1="17.4" x2="12.5" y2="17.4" stroke="#fff" stroke-width="1.4" opacity="0.95" />
  </svg>
</template>

<style scoped>
.folder-ico { display: block; flex: none; overflow: visible; }
</style>
