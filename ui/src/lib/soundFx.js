// 零依赖 Web Audio 物理拟真交互音效：
// 1. 放入回收站：4 段带通滤波纸张纤维折皱脉冲 + 柔和低频落篓微震（全程 ~220ms）
// 2. 还原：两声温润上扬三角波微泛音（全程 ~140ms）
// 内置 180ms 冷却防叠加与无 Web Audio 静默降级

const STORAGE_KEY = 'picnest.soundFx'
const COOLDOWN_MS = 180

let audioCtx = null
let noiseBuffer = null
let lastTrashAt = 0
let lastRestoreAt = 0
let lastPurgeAt = 0

function getAudioContext() {
  if (typeof window === 'undefined') return null
  const Ctor = window.AudioContext || window.webkitAudioContext
  if (typeof Ctor !== 'function') return null
  if (!audioCtx) {
    audioCtx = new Ctor()
  }
  if (audioCtx && audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
    audioCtx.resume().catch(() => {})
  }
  return audioCtx
}

function getNoiseBuffer(ctx) {
  if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) return noiseBuffer
  const len = Math.max(1, Math.floor(ctx.sampleRate * 0.35))
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) {
    // 略带暖色调的粉化混合白噪声，避免数字嘶嘶声刺耳
    const w = Math.random() * 2 - 1
    data[i] = i > 0 ? data[i - 1] * 0.22 + w * 0.78 : w
  }
  noiseBuffer = buf
  return buf
}

export function isSoundEnabled() {
  try {
    return typeof localStorage === 'undefined' ? true : localStorage.getItem(STORAGE_KEY) !== '0'
  } catch {
    return true
  }
}

/**
 * 播放轻柔拟真的物理揉纸入篓声（macOS Finder / Eagle 风格）。
 * @param {{ force?: boolean }} [opts]
 * @returns {boolean} 是否实际触发播放
 */
export function playTrashSound(opts = {}) {
  if (!opts.force && !isSoundEnabled()) return false
  const nowMs = Date.now()
  if (nowMs - lastTrashAt < COOLDOWN_MS) return false

  try {
    const ctx = getAudioContext()
    if (!ctx) return false
    lastTrashAt = nowMs

    const t0 = ctx.currentTime + 0.005
    const master = ctx.createGain()
    master.gain.setValueAtTime(0.28, t0)

    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(6400, t0)

    master.connect(lp)
    lp.connect(ctx.destination)

    const buf = getNoiseBuffer(ctx)
    // 层 1：4 段纸张纤维折皱脉冲（窸-咔嚓）
    const bursts = [
      { offset: 0.0,   freq: 1450, q: 2.5, dur: 0.038, peak: 0.52 },
      { offset: 0.034, freq: 2550, q: 3.1, dur: 0.032, peak: 0.68 },
      { offset: 0.072, freq: 1900, q: 2.8, dur: 0.044, peak: 0.58 },
      { offset: 0.118, freq: 3100, q: 3.4, dur: 0.028, peak: 0.44 },
    ]

    for (let i = 0; i < bursts.length; i++) {
      const b = bursts[i]
      const jitter = (Math.random() - 0.5) * 0.006
      const st = t0 + Math.max(0, b.offset + jitter)

      const src = ctx.createBufferSource()
      src.buffer = buf

      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.setValueAtTime(b.freq * (0.95 + Math.random() * 0.1), st)
      bp.Q.setValueAtTime(b.q, st)

      const env = ctx.createGain()
      env.gain.setValueAtTime(0.0001, st)
      env.gain.linearRampToValueAtTime(b.peak, st + 0.0025)
      env.gain.exponentialRampToValueAtTime(0.0001, st + b.dur)

      src.connect(bp)
      bp.connect(env)
      env.connect(master)

      src.start(st, (i * 0.06) % 0.18, b.dur + 0.01)
      src.stop(st + b.dur + 0.015)
    }

    // 层 2：落入纸篓微震（轻柔低频扫频触底）
    const thumpStart = t0 + 0.095
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(175, thumpStart)
    osc.frequency.exponentialRampToValueAtTime(86, thumpStart + 0.068)

    const thumpEnv = ctx.createGain()
    thumpEnv.gain.setValueAtTime(0.0001, thumpStart)
    thumpEnv.gain.linearRampToValueAtTime(0.09, thumpStart + 0.006)
    thumpEnv.gain.exponentialRampToValueAtTime(0.0001, thumpStart + 0.072)

    osc.connect(thumpEnv)
    thumpEnv.connect(master)
    osc.start(thumpStart)
    osc.stop(thumpStart + 0.08)

    return true
  } catch {
    return false
  }
}

/**
 * 播放轻盈上扬回弹音（用于从回收站还原及开启音效反馈）。
 * @param {{ force?: boolean }} [opts]
 * @returns {boolean} 是否实际触发播放
 */
export function playRestoreSound(opts = {}) {
  if (!opts.force && !isSoundEnabled()) return false
  const nowMs = Date.now()
  if (nowMs - lastRestoreAt < COOLDOWN_MS) return false

  try {
    const ctx = getAudioContext()
    if (!ctx) return false
    lastRestoreAt = nowMs

    const t0 = ctx.currentTime + 0.005
    const notes = [
      { offset: 0.0,   freq: 523.25, dur: 0.065, peak: 0.09 },
      { offset: 0.048, freq: 783.99, dur: 0.085, peak: 0.11 },
    ]
    for (const n of notes) {
      const st = t0 + n.offset
      const osc = ctx.createOscillator()
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(n.freq, st)

      const env = ctx.createGain()
      env.gain.setValueAtTime(0.0001, st)
      env.gain.linearRampToValueAtTime(n.peak, st + 0.006)
      env.gain.exponentialRampToValueAtTime(0.0001, st + n.dur)

      osc.connect(env)
      env.connect(ctx.destination)
      osc.start(st)
      osc.stop(st + n.dur + 0.01)
    }

    return true
  } catch {
    return false
  }
}

/**
 * 播放沉稳干脆的「彻底删除 / 清空回收站」碎纸清空音（全程 ~260ms）。
 * @param {{ force?: boolean }} [opts]
 * @returns {boolean} 是否实际触发播放
 */
export function playPurgeSound(opts = {}) {
  if (!opts.force && !isSoundEnabled()) return false
  const nowMs = Date.now()
  if (nowMs - lastPurgeAt < COOLDOWN_MS) return false

  try {
    const ctx = getAudioContext()
    if (!ctx) return false
    lastPurgeAt = nowMs

    const t0 = ctx.currentTime + 0.005
    const master = ctx.createGain()
    master.gain.setValueAtTime(0.3, t0)

    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(6800, t0)

    master.connect(lp)
    lp.connect(ctx.destination)

    const buf = getNoiseBuffer(ctx)
    // 层 1：3 段紧密高频碎纸脉冲
    const shreds = [
      { offset: 0.0,   freq: 2200, q: 3.2, dur: 0.042, peak: 0.56 },
      { offset: 0.044, freq: 3600, q: 3.2, dur: 0.036, peak: 0.66 },
      { offset: 0.092, freq: 1600, q: 3.2, dur: 0.052, peak: 0.52 },
    ]
    for (let i = 0; i < shreds.length; i++) {
      const b = shreds[i]
      const st = t0 + b.offset
      const src = ctx.createBufferSource()
      src.buffer = buf

      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.setValueAtTime(b.freq, st)
      bp.Q.setValueAtTime(b.q, st)

      const env = ctx.createGain()
      env.gain.setValueAtTime(0.0001, st)
      env.gain.linearRampToValueAtTime(b.peak, st + 0.003)
      env.gain.exponentialRampToValueAtTime(0.0001, st + b.dur)

      src.connect(bp)
      bp.connect(env)
      env.connect(master)

      src.start(st, (i * 0.07) % 0.18, b.dur + 0.01)
      src.stop(st + b.dur + 0.015)
    }

    // 层 2：低频清空落定音（135Hz -> 58Hz, 95ms）
    const endStart = t0 + 0.115
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(135, endStart)
    osc.frequency.exponentialRampToValueAtTime(58, endStart + 0.095)

    const oscEnv = ctx.createGain()
    oscEnv.gain.setValueAtTime(0.0001, endStart)
    oscEnv.gain.linearRampToValueAtTime(0.12, endStart + 0.008)
    oscEnv.gain.exponentialRampToValueAtTime(0.0001, endStart + 0.105)

    osc.connect(oscEnv)
    oscEnv.connect(master)
    osc.start(endStart)
    osc.stop(endStart + 0.115)

    return true
  } catch {
    return false
  }
}

export function __resetSoundCooldownForTest() {
  lastTrashAt = 0
  lastRestoreAt = 0
  lastPurgeAt = 0
  audioCtx = null
  noiseBuffer = null
}
