// 主题系统：auto（跟随系统）/ light / dark
// - 持久化 localStorage: picnest.theme
// - <html data-theme="light|dark"> 驱动 style.css 的 token 块
// - 首屏防闪白由 index.html 内联脚本处理，这里负责运行期切换与系统联动
import { ref, computed, watch } from 'vue'

const MODES = [
  { key: 'auto', label: '跟随系统' },
  { key: 'light', label: '暖砂' },
  { key: 'dark', label: '靛夜' },
  { key: 'mono-light', label: '灰白（低饱和）' },
  { key: 'mono-charcoal', label: '炭黑（低饱和）' },
  { key: 'mono-dark', label: '墨黑（低饱和）' },
]
const KEY = 'picnest.theme'
const saved = localStorage.getItem(KEY)
const mode = ref(MODES.some((m) => m.key === saved) ? saved : 'auto')
let touched = false
/* 启动后从 config.json 再对齐一次：localStorage 按 origin 隔离（dev 用 127.0.0.1、生产用 file://），
   只靠它会把「切换过运行方式」误当成丢主题。config 是跨 origin 的真相；首次运行把旧值迁过去。 */
;(async () => {
  try {
    const r = await window.picrand?.picnestThemeGet?.()
    if (!r?.ok) return
    const t = String(r.theme || '')
    if (t && MODES.some((m) => m.key === t)) {
      if (!touched && t !== mode.value) {
        mode.value = t
        localStorage.setItem(KEY, t)
      }
    } else if (!t) {
      window.picrand?.picnestThemeSet?.(mode.value)
    }
  } catch { /* 静默：主题不是主流程阻断项 */ }
})()

const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
const systemDark = ref(!!mq?.matches)
if (mq) {
  const onChange = (e) => { systemDark.value = !!e.matches }
  if (mq.addEventListener) mq.addEventListener('change', onChange)
  else if (mq.addListener) mq.addListener(onChange)
}

const resolved = computed(() => (mode.value === 'auto' ? (systemDark.value ? 'mono-dark' : 'mono-light') : mode.value))

function apply(v) {
  document.documentElement.dataset.theme = v
  document.documentElement.style.colorScheme = (v === 'light' || v === 'mono-light') ? 'light' : 'dark'
}
watch(resolved, apply, { immediate: true })

export function useTheme() {
  return {
    modes: MODES,
    mode,
    resolved,
    setMode(key) {
      if (!MODES.some((m) => m.key === key)) return
      touched = true
      mode.value = key
      localStorage.setItem(KEY, key)
      try { window.picrand?.picnestThemeSet?.(key) } catch { /* 静默 */ }
    },
  }
}
