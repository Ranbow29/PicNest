import { createApp } from 'vue'
import { createPinia } from 'pinia'

function isCaptureWindow() {
  if (typeof window === 'undefined') return false
  const winLabel = String(window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label || '')
  if (winLabel.startsWith('capture-')) return true
  if (window.__PICNEST_CAPTURE__) return true
  const qs = new URLSearchParams(window.location.search)
  if (qs.get('mode') === 'capture') return true
  const hs = new URLSearchParams(String(window.location.hash || '').replace(/^#/, ''))
  return hs.get('mode') === 'capture'
}

function isPinWindow() {
  if (typeof window === 'undefined') return false
  const winLabel = String(window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label || '')
  if (winLabel.startsWith('pin-')) return true
  if (window.__PICNEST_PIN__) return true
  const qs = new URLSearchParams(window.location.search)
  if (qs.get('mode') === 'pin') return true
  const hs = new URLSearchParams(String(window.location.hash || '').replace(/^#/, ''))
  return hs.get('mode') === 'pin'
}

if (isCaptureWindow()) {
  import('./components/CaptureOverlay.vue').then(({ default: CaptureOverlay }) => {
    createApp(CaptureOverlay).mount('#app')
  })
} else if (isPinWindow()) {
  import('./components/PinOverlay.vue').then(({ default: PinOverlay }) => {
    createApp(PinOverlay).mount('#app')
  })
} else {
  Promise.all([
    import('./App.vue'),
    import('./style.css'),
    import('./themes/acid-print.css'),
    import('./themes/endfield.css'),
    import('./themes/obsidian-prism.css'),
  ]).then(([{ default: App }]) => {
    // PicRand 主进程会拦截窗口关闭并发 confirm-close；M0 阶段直接应答放行
    window.picrand?.onConfirmClose?.(() => window.picrand.respondCloseConfirm(true))
    // 超大文件夹确认框：默认放行（5 万文件阈值，后续做成设置项）
    window.picrand?.onConfirmOversize?.(() => window.picrand.respondOversizeConfirm(true))

    createApp(App).use(createPinia()).mount('#app')
  })
}
