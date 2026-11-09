<script setup>
// Wenku8 动效图标：24 单位自绘 + 三层错峰弹簧（p/q/r）+ 环境晃动。
// 图形几何按相位重排（滑块横移/侧栏 reflow/方块上浮）——移植自 Wenku8_Flutter
// archive_icon_fold_art.dart / archive_icon_motion.dart（GPL-2.0-or-later © MewX / mikufoxxx）。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { GESTURE_MS, layerAt, scheduleAmbient, iconShake } from '../lib/iconMotion'

const props = defineProps({
  name: { type: String, required: true },   // filter | layout | grid | contents | justified | pin | folder | sidebar
  size: { type: Number, default: 16 },
  ambient: { type: Boolean, default: false }, // 环境晃动（顶栏开）
  active: { type: Boolean, default: false },  // 选中态：填充加重
  stroke: { type: Number, default: 1.7 },
  open: { type: Boolean, default: false },    // folder 专用：展开态（前板下压开口）
  tint: { type: String, default: '' },        // folder 专用：染色（'' = currentColor）
  collapsed: { type: Boolean, default: false }, // sidebar 专用：收起态（分隔线左移、列内线淡出）
  mountShake: { type: Boolean, default: true }, // 挂载即晃一次（树上批量挂载可关）
})

const phase = ref(-1) // -1 = 静止
const root = ref(null)
let raf = 0
let cancelAmbient = null
let hostBtn = null
const onHostEnter = () => play()

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
/* 载入手势：图标挂载即晃一次。
   必要性：大图模式顶栏是另一套模板，漏斗/布局钮在大图期间被卸载；退出时它们新挂载，
   而晃动总线已在 closeLightbox 里 +1 过了 → 挂载晚于触发，监听不到（用户报"退出大图这两颗不晃"）。
   顺带首次启动全体开场一次，符合"状态跃迁盖一次章"的编排哲学。 */
let mountT = 0
onMounted(() => {
  // 悬停按整个按钮算：图标只占按钮一小块，鼠标掠过留白/文字也要动
  hostBtn = root.value?.closest('button') || null
  hostBtn?.addEventListener('mouseenter', onHostEnter)
  if (props.mountShake) mountT = setTimeout(play, 80) // 让挂载与布局稳定，手势读起来像同一拍
  if (!props.ambient) return
  const loop = () => { cancelAmbient = scheduleAmbient(() => { play(); loop() }, 3000, 6000) }
  loop()
})
onBeforeUnmount(() => {
  hostBtn?.removeEventListener('mouseenter', onHostEnter)
  clearTimeout(mountT); cancelAnimationFrame(raf); cancelAmbient?.()
})

// 集体晃动：总线 +1 时全体同步做一次手势
watch(iconShake, () => play())

// p/q/r 三相（Wenku8 语义：lead 主动 / follow 跟随 / trail 拖尾）
const p = computed(() => (phase.value < 0 ? 0 : layerAt(phase.value, 0)))
const q = computed(() => (phase.value < 0 ? 0 : layerAt(phase.value, 55)))
const r = computed(() => (phase.value < 0 ? 0 : layerAt(phase.value, 110)))
const act = computed(() => (props.active ? 1 : 0.35))

const clampArt = (v) => Math.max(-0.12, Math.min(v, 1))
</script>

<template>
  <svg
    ref="root"
    :width="size" :height="size" viewBox="0 0 24 24" class="anim-ico"
    :style="tint ? { color: tint } : null"
    fill="none" stroke="currentColor" :stroke-width="stroke"
    stroke-linecap="round" stroke-linejoin="round"
    @mouseenter="play" @mousedown="play"
  >
    <!-- filter：三根滑轨，滑块按 p/q/r 独立横移（Wenku8 原式：x = 8+5p / 16-5q / 10+4r） -->
    <g v-if="name === 'filter'">
      <template v-for="i in 3" :key="i">
        <template v-if="i === 1">
          <line x1="3.5" :y1="5.5" :x2="8 + 5 * p - 2.5" :y2="5.5" />
          <line :x1="8 + 5 * p + 2.5" :y1="5.5" x2="20.5" :y2="5.5" />
          <rect :x="8 + 5 * p - 1.3" :y="3.5" width="2.6" height="4" fill="currentColor" stroke="none" />
        </template>
        <template v-else-if="i === 2">
          <line x1="3.5" :y1="12" :x2="16 - 5 * q - 2.5" :y2="12" />
          <line :x1="16 - 5 * q + 2.5" :y1="12" x2="20.5" :y2="12" />
          <rect :x="16 - 5 * q - 1.3" :y="10" width="2.6" height="4" fill="currentColor" stroke="none" />
        </template>
        <template v-else>
          <line x1="3.5" :y1="18.5" :x2="10 + 4 * r - 2.5" :y2="18.5" />
          <line :x1="10 + 4 * r + 2.5" :y1="18.5" x2="20.5" :y2="18.5" />
          <rect :x="10 + 4 * r - 1.3" :y="16.5" width="2.6" height="4" fill="currentColor" stroke="none" />
        </template>
      </template>
    </g>

    <!-- layout：侧栏 ⇄ 顶栏 reflow（lead 拉宽，follow/trail 补位；不整体旋转缩放） -->
    <g v-else-if="name === 'layout'">
      <rect :x="3.5" y="4" :width="5.5 + 11.5 * clampArt(p)" :height="16 - 10.5 * clampArt(p)" />
      <rect :x="3.5" y="4" :width="5.5 + 11.5 * clampArt(p)" :height="16 - 10.5 * clampArt(p)"
            fill="currentColor" stroke="none" :opacity="0.08 + act * 0.13" />
      <rect :x="12 - 8.5 * clampArt(q)" :y="4 + 8.5 * clampArt(q)" :width="8.5 - 1.5 * clampArt(q)" :height="6.5 + clampArt(q)" />
      <rect :x="12 + 1.5 * clampArt(r)" :y="13.5 - clampArt(r)" :width="8.5 - 1.5 * clampArt(r)" :height="6.5 + clampArt(r)" />
    </g>

    <!-- grid：四格按行错峰上浮（d*2.8，首轮 1.3 被 Feb 判"幅度不够"），首格 active 填充 -->
    <g v-else-if="name === 'grid'">
      <template v-for="i in 4" :key="i">
        <rect
          :x="4 + (i - 1) % 2 * 10"
          :y="4 + Math.floor((i - 1) / 2) * 10 - [p, q, r, q][i - 1] * 2.8"
          width="6" height="6"
        />
        <rect v-if="i === 1"
              :x="4" :y="4 - p * 2.8" width="6" height="6"
              fill="currentColor" stroke="none" :opacity="0.14 + act * 0.12" />
      </template>
    </g>

    <!-- contents：面板随 p 轻抬，分隔线随 q 左右滑（详情开合语义） -->
    <g v-else-if="name === 'contents'">
      <rect :x="4.5" :y="5 - p * 0.8" width="15" height="14" />
      <line :x1="12 + 2.5 * q" :y1="5 - p * 0.8" :x2="12 + 2.5 * q" :y2="19 - p * 0.8" />
    </g>

    <!-- sidebar：左侧栏面板；幅度加码（面板 1.4 / 分隔线 2.4 / 短线 1.2），收起时分隔线大幅左移、列内线淡出 -->
    <g v-else-if="name === 'sidebar'">
      <rect :x="4.5" :y="5 - p * 1.4" width="15" height="14" />
      <line class="sb-divider" :class="{ collapsed }"
            :x1="10 + q * 2.4" :y1="5 - p * 1.4" :x2="10 + q * 2.4" :y2="19 - p * 1.4" />
      <line :x1="6.1 + q * 1.2" :x2="8.1 + q * 1.2" y1="9" y2="9" :style="{ opacity: collapsed ? 0 : 1 }" />
      <line :x1="6.1 + r * 1.2" :x2="8.1 + r * 1.2" y1="12.6" y2="12.6" :style="{ opacity: collapsed ? 0 : 1 }" />
    </g>

    <!-- justified：三行宽度随 p/q/r 伸缩（行自适应 reflow 语义） -->
    <g v-else-if="name === 'justified'">
      <rect :x="4" y="5" :width="8 + 8 * p" height="3.2" />
      <rect :x="4" y="10.4" :width="16 - 6 * q" height="3.2" />
      <rect :x="4" y="15.8" :width="11 + 5 * r" height="3.2" />
    </g>

    <!-- folder：Wenku8 折纸文件夹（描边版）——后纸随 q 上抽、前板随 p/展开态开合 -->
    <g v-else-if="name === 'folder'" :style="tint ? { color: tint } : null">
      <path
        :d="`M6 ${(4.6 - 2.6 * q).toFixed(2)} L15.8 ${(4.6 - 2.6 * q).toFixed(2)} L18.6 ${(7.4 - 2.6 * q).toFixed(2)} L18.6 ${(17.9 - 2.6 * q).toFixed(2)} L6 ${(17.9 - 2.6 * q).toFixed(2)} Z`"
        opacity="0.42"
      />
      <path
        :d="(() => {
          const o = (open ? 0.6 : 0) + p
          const y0 = 8.4 + 2.1 * o
          const y1 = 10 + 2.1 * o
          return `M3 ${y0.toFixed(2)} L8 ${y0.toFixed(2)} L10.4 ${y1.toFixed(2)} L21.5 ${y1.toFixed(2)} L19.7 20.2 L4.4 20.2 Z`
        })()"
      />
      <circle cx="6.2" cy="16.7" r="1.05" fill="currentColor" stroke="none" :opacity="0.55 + act * 0.3" />
      <line x1="9.2" y1="17.4" x2="12.5" y2="17.4" opacity="0.55" />
    </g>

    <!-- pin：四角星随 p 旋转 + 缩放（twinkle） -->
    <g v-else-if="name === 'pin'">
      <path
        d="M12 3.6l1.9 6.1 6.5 2.3-6.5 2.3L12 20.4l-1.9-6.1-6.5-2.3 6.5-2.3z"
        :style="{ transform: `rotate(${p * 22}deg) scale(${1 + p * 0.12})`, transformOrigin: '12px 12px' }"
      />
    </g>
  </svg>
</template>

<style scoped>
.anim-ico { display: block; overflow: visible; }
.anim-ico rect, .anim-ico line, .anim-ico path { will-change: transform; }
.sb-divider { transition: transform 0.26s var(--ease-overshoot); }
.sb-divider.collapsed { transform: translateX(-5.4px); }
</style>
