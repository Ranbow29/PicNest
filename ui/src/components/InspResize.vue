<script setup>
// 详情浮岛尺寸手柄：左缘=宽度、顶边=高度、左上角=自由变换；支点固定在右下角
import { useLibrary } from '../stores/library'
const lib = useLibrary()
let drag = null

function start(kind, e) {
  if (e.button !== 0) return
  e.preventDefault()
  const host = e.currentTarget.parentElement
  const insp = host?.querySelector('.inspector')?.getBoundingClientRect()
  const hr = host?.getBoundingClientRect()
  if (!insp || !hr) return
  drag = {
    kind,
    x0: e.clientX,
    y0: e.clientY,
    w0: lib.inspectorWidth,
    /* 从当前显示高度起拖：窗口收缩后显示高度已被钳制，不能用存着的偏好值（会跳变） */
    h0: Math.round(insp.height),
    maxH: Math.max(240, Math.round(hr.height - 50)), // 顶边不越过 40px（窗控按钮下缘 39 之下）
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
  document.body.style.cursor = kind === 'both' ? 'nwse-resize' : kind === 'y' ? 'ns-resize' : 'col-resize'
  document.body.style.userSelect = 'none'
}
function onMove(e) {
  if (!drag) return
  const dx = e.clientX - drag.x0
  const dy = e.clientY - drag.y0
  if (drag.kind !== 'y') lib.setInspectorWidth(drag.w0 - dx) // 左缘向左拖 = 加宽
  if (drag.kind !== 'x') {
    const h = Math.min(drag.maxH, drag.h0 - dy) // 顶边向上拖 = 增高
    lib.setInspectorHeight(h >= drag.maxH - 2 ? 0 : h) // 拖到满高就回到自适应
  }
}
function onUp() {
  drag = null
  document.removeEventListener('mousemove', onMove)
  document.removeEventListener('mouseup', onUp)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}
function resetHeight() { lib.setInspectorHeight(0) }
</script>

<template>
  <div class="insp-grip l" :class="{ fixed: lib.inspectorHeight > 0 }" title="拖拽调整详情宽度"
       @mousedown="start('x', $event)" />
  <div class="insp-grip t" :class="{ fixed: lib.inspectorHeight > 0 }" title="拖拽调整详情高度（双击恢复满高）"
       @mousedown="start('y', $event)" @dblclick="resetHeight" />
  <div class="insp-grip c" :class="{ fixed: lib.inspectorHeight > 0 }" title="自由调整宽高（支点右下角，双击恢复满高）"
       @mousedown="start('both', $event)" @dblclick="resetHeight" />
</template>

<style scoped>
.insp-grip { position: absolute; z-index: 25; pointer-events: auto; }
/* 左缘：宽度 */
.insp-grip.l {
  top: 40px; bottom: 10px; right: calc(var(--insp-w, 296px) + 6px);
  width: 8px; cursor: col-resize;
}
.insp-grip.l.fixed { top: auto; bottom: 10px; height: var(--insp-h, 0px); }
/* 顶边：高度（避开左上角，交给自由变换柄） */
.insp-grip.t {
  top: 40px; height: 8px;
  left: calc(100% - var(--insp-w, 296px) - 10px + 16px);
  right: 10px; cursor: ns-resize;
}
.insp-grip.t.fixed { top: auto; bottom: calc(10px + var(--insp-h, 0px) - 4px); }
/* 左上角：自由变换（宽+高同时变，右下角不动） */
.insp-grip.c {
  top: 40px; right: calc(var(--insp-w, 296px) + 4px);
  width: 16px; height: 16px; cursor: nwse-resize; z-index: 26;
}
.insp-grip.c.fixed { top: auto; bottom: calc(10px + var(--insp-h, 0px) - 8px); }
.insp-grip:hover, .insp-grip:active { background: var(--accent-weak); }
.insp-grip.l:hover, .insp-grip.l:active { box-shadow: inset -1px 0 0 var(--accent); border-radius: 3px; }
.insp-grip.t:hover, .insp-grip.t:active { box-shadow: inset 0 -1px 0 var(--accent); border-radius: 3px; }
.insp-grip.c:hover, .insp-grip.c:active { box-shadow: inset 0 0 0 1px var(--accent); border-radius: 5px; }
</style>
