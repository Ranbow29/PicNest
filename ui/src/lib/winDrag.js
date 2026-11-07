// 手动拖窗：-webkit-app-region: drag 在本环境（Electron 33）物理命中测试不可靠——
// no-drag 子元素被浏览器进程的拖拽位图无视，按钮全部变成拖窗。
// → 顶栏/头块不再声明任何 app-region，mousedown 后用 screenX/Y 增量 + IPC setPosition 移窗。
import { api } from '../api'

let dragging = null

// 只接受空白处起拖：交互控件一律放行给 DOM
function isInteractive(el) {
  return el.closest('button, input, textarea, a, .search, .vo-wrap, .bar-controls, .zoom-slider, [data-no-drag]')
}

export function startWindowDrag(e) {
  if (e.button !== 0 || dragging) return
  if (isInteractive(e.target)) return
  // 最大化状态下不起拖（原生标题栏此时会把窗口拉回还原态，我们简化为不动）
  if (window.outerWidth >= window.screen.availWidth && window.outerHeight >= window.screen.availHeight) return
  e.preventDefault() // 防止拖动时选中文字
  // 宽高基线由主进程在 drag-start 时用自己的 getBounds() 冻结（渲染层 outerWidth
  // 与主进程 bounds 在非 100% DPI 下有 ±px 映射差，逐帧断言会慢性膨胀）
  api.windowDragStart()
  dragging = {
    startX: e.screenX, startY: e.screenY,
  }
  const onMove = (ev) => {
    if (!dragging) return
    api.windowMoveBy(
      Math.round(ev.screenX - dragging.startX),
      Math.round(ev.screenY - dragging.startY),
    )
  }
  const onUp = () => {
    dragging = null
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    api.windowDragEnd() // 恢复 resizable（手势期被冻结）
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

// 双击空白处切换最大化/还原（原生标题栏惯例）；落在控件上的双击不劫持
export function onBarDblclick(e) {
  if (isInteractive(e.target)) return
  api.windowMaximize()
}
