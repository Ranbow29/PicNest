<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useLibrary } from '../stores/library'

/* 录入汇总结果卡：主行报数，点开看明细（文件夹/不支持/失败）；悬停停留，6.5s 自动收起 */
const lib = useLibrary()
const r = computed(() => lib.importResult)
const open = ref(false)
const hover = ref(false)
let timer = null

function clear() { clearTimeout(timer); timer = null }
function arm() {
  clear()
  if (!r.value.open) return
  timer = setTimeout(() => { if (!hover.value) dismiss() }, 6500)
}
function dismiss() {
  clear()
  lib.importResult = { ...lib.importResult, open: false }
}
function toggle() {
  if (!r.value.details.length) return dismiss()
  open.value = !open.value
}
watch(() => r.value.nonce, () => { open.value = false; arm() })
onMounted(arm)
onBeforeUnmount(clear)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="r.open"
      class="imp-card" :class="r.tone"
      @mouseenter="hover = true; clear()"
      @mouseleave="hover = false; arm()"
    >
      <div v-if="open && r.details.length" class="imp-details">
        <div v-for="(d, i) in r.details" :key="i" class="line">
          <span class="k" :title="d.label">{{ d.label }}</span>
          <span class="v">{{ d.text }}</span>
        </div>
      </div>
      <div class="imp-bar">
        <i class="dot" />
        <button class="summary" :title="open ? '收起明细' : '查看明细'" @click="toggle">{{ r.summary }}</button>
        <button v-if="r.details.length" class="caret" :class="{ open }" @click="toggle">▾</button>
        <button class="close" title="关闭" @click="dismiss">✕</button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.imp-card {
  position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
  z-index: 700; width: max-content; max-width: min(560px, 86vw);
  background: var(--panel-strong); backdrop-filter: blur(var(--blur));
  border: 1px solid var(--border); border-radius: 12px;
  box-shadow: var(--shadow); overflow: hidden;
  animation: imp-in 0.26s var(--ease-overshoot) both;
}
@keyframes imp-in {
  from { opacity: 0; transform: translate(-50%, 12px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}
.imp-card.ok { border-color: var(--accent); }
.imp-card.error { border-color: #cf6b5c; }
.imp-bar { display: flex; align-items: center; gap: 9px; padding: 10px 12px 10px 14px; }
.dot {
  width: 7px; height: 7px; border-radius: 50%; flex: none;
  background: var(--accent); box-shadow: 0 0 0 3px var(--accent-weak);
}
.imp-card.muted .dot { background: var(--text-2); box-shadow: 0 0 0 3px var(--border); }
.imp-card.error .dot { background: #cf6b5c; box-shadow: 0 0 0 3px rgba(207, 107, 92, 0.18); }
.summary {
  border: none; background: transparent; padding: 0; cursor: pointer;
  color: var(--text); font-size: 12.5px; font-weight: 600; font-family: inherit;
  text-align: left; line-height: 1.35;
}
.summary:hover { color: var(--accent); }
.imp-card.error .summary:hover { color: #cf6b5c; }
.caret {
  border: none; background: transparent; color: var(--text-2); cursor: pointer;
  font-size: 11px; padding: 0 2px; transition: transform 0.18s;
}
.caret.open { transform: rotate(180deg); }
.close {
  margin-left: 4px; border: none; background: transparent; color: var(--text-2);
  font-size: 11px; cursor: pointer; padding: 2px 3px; border-radius: 5px;
}
.close:hover { color: var(--text); background: var(--accent-weak); }
.imp-details {
  max-height: 172px; overflow-y: auto; padding: 11px 14px 9px;
  border-bottom: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 6px;
  animation: det-in 0.18s ease both;
}
@keyframes det-in { from { opacity: 0; } to { opacity: 1; } }
.imp-details::-webkit-scrollbar { width: 6px; }
.imp-details::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.line { display: flex; gap: 10px; font-size: 11.5px; line-height: 1.5; }
.line .k {
  flex: none; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--accent); font-weight: 600;
}
.line .v { color: var(--text-2); word-break: break-all; }
</style>
