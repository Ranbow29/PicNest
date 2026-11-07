<script setup>
// 拖拽调宽手柄：侧栏/详情通用
const props = defineProps({ store: { type: String, required: true }, invert: { type: Boolean, default: false } })
import { useLibrary } from '../stores/library'
const lib = useLibrary()

let startX = 0, startW = 0
function onDown(e) {
  startX = e.clientX
  startW = props.store === 'sidebar' ? lib.sidebarWidth : lib.inspectorWidth
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}
function onMove(e) {
  const delta = e.clientX - startX
  const w = props.invert ? startW - delta : startW + delta
  ;(props.store === 'sidebar' ? lib.setSidebarWidth : lib.setInspectorWidth)(w)
}
function onUp() {
  document.removeEventListener('mousemove', onMove)
  document.removeEventListener('mouseup', onUp)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}
</script>

<template>
  <div class="resize-handle" @mousedown.prevent="onDown" />
</template>

<style scoped>
.resize-handle {
  width: 6px; flex: none; cursor: col-resize;
  background: transparent; opacity: 0;
  transition: opacity 0.18s, background 0.18s;
}
.resize-handle:hover, .resize-handle:active {
  opacity: 1; background: var(--accent-weak);
  box-shadow: inset 1px 0 0 var(--accent);
}
.resize-handle:hover, .resize-handle:active { background: var(--accent-weak); }
</style>
