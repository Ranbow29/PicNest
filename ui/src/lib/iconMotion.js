// 图标手势动效引擎（移植自 Wenku8_Flutter archive_icon_motion，GPL-2.0-or-later © MewX / mikufoxxx）
// 规格：640ms 完整手势；弹簧关键帧 t=[0,.10,.36,.64,.82,1] v=[0,-.12,1,-.20,.065,0]；
// 分段 easeInOutCubic；三层错峰 lead 0 / follow 55ms / trail 110ms；状态曲线 Cubic(.18,1.28,.32,1)。

export const GESTURE_MS = 640
const KF_T = [0, 0.1, 0.36, 0.64, 0.82, 1]
const KF_V = [0, -0.12, 1, -0.2, 0.065, 0]

// 集体晃动总线：页面切换/换文件夹/关面板/收窗体时 +1，所有动效图标同时做一次手势
import { ref } from 'vue'
export const iconShake = ref(0)
/* 节流：每个图标要跑 640ms 逐帧动画（60 个图标约 2280 次响应式更新），
   连点按钮时动画首尾相接，主线程就一直被占着 —— 表现就是“多点几下就卡住”。
   400ms 内的后续触发直接丢弃，单次点击手感不变。 */
let lastShakeAt = 0
const SHAKE_MIN_GAP = 400
export function collectiveShake() {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  if (now - lastShakeAt < SHAKE_MIN_GAP) return
  lastShakeAt = now
  iconShake.value++
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

// t ∈ [0,1] → 弹簧值（分段关键帧插值）
export function springAt(t) {
  if (t <= 0) return KF_V[0]
  if (t >= 1) return KF_V[KF_V.length - 1]
  for (let i = 1; i < KF_T.length; i++) {
    if (t <= KF_T[i]) {
      const k = (t - KF_T[i - 1]) / (KF_T[i] - KF_T[i - 1])
      return KF_V[i - 1] + (KF_V[i] - KF_V[i - 1]) * easeInOutCubic(k)
    }
  }
  return 0
}

// 错峰层相位：delayMs ∈ {0, 55, 110} → 该层在 t 时刻的弹簧值
export function layerAt(t, delayMs) {
  const d = delayMs / GESTURE_MS
  const tt = t <= d ? 0 : (t - d) / (1 - d)
  return springAt(tt)
}

// 环境动效调度：静止 idleMs 后随机触发一次（一次只跑一个，返回 cancel）
export function scheduleAmbient(fn, minMs = 2600, maxMs = 5200) {
  const t = setTimeout(fn, minMs + Math.random() * (maxMs - minMs))
  return () => clearTimeout(t)
}
