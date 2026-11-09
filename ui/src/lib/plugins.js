// 插件宿主公共设施：事件总线 + 主题插件注入。
// 事件总线不依赖 store（避免循环引用），store 关键动作 emit，插件面板订阅。
const listeners = new Set()

export function emitPluginEvent(name, payload = {}) {
  for (const fn of [...listeners]) {
    try { fn(name, payload) } catch { /* 单个订阅失败不影响主流程 */ }
  }
}

export function onPluginEvent(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/* theme 插件：启用后把 CSS 注入 <head>；每次刷新先清空旧插件样式 */
export async function refreshPluginThemes() {
  for (const el of [...document.querySelectorAll('style[data-picnest-plugin]')]) el.remove()
  try {
    const r = await window.picrand?.picnestPluginsList?.()
    if (!r?.ok) return
    for (const p of r.plugins || []) {
      if (!p.enabled || p.type !== 'theme' || p.error) continue
      const t = await window.picrand.picnestPluginThemeCss(p.id)
      if (!t?.ok || !t.css) continue
      const style = document.createElement('style')
      style.dataset.picnestPlugin = p.id
      style.textContent = t.css
      document.head.appendChild(style)
    }
  } catch { /* 主题插件失败不阻塞启动 */ }
}
