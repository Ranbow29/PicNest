// 入场波编排（移植自 Wenku8_Flutter archive_wave/archive_motion，GPL-2.0-or-later © MewX / mikufoxxx）
// 规格：520ms 共享时钟 easeOutCubic；每项墨水窗口 0.35，按索引距焦点 1/24 步进；位移 (-8,-6) 衰减。
// 用法：容器加 class="wave" + 每个直接子项 style="--d: Nms"（waveDelay 计算）；重放 = waveSeq.value++（子项 :key 变化重挂载即重放）。
import { ref } from 'vue'

export const WAVE_DURATION = 520

export const waveSeq = ref(0) // 全体重放计数：+1 → 消费方重建 wave 子树

// 第 i 项（相对焦点 focus）的动画延迟 ms：inkStart = clamp((i - focus + 8) / 24, 0, 0.65)
export function waveDelay(i, focus = 0) {
  const start = Math.max(0, Math.min((i - focus + 8) / 24, 0.65))
  return Math.round(start * WAVE_DURATION)
}

// 触发一次全体重放
export function replayWave() {
  waveSeq.value++
}
