<script setup>
// 名称输入对话框：新建/重命名共用（Enter 确认，Esc 取消）
import { ref, watch, nextTick } from 'vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
  title: { type: String, default: '名称' },
  initial: { type: String, default: '' },
  selectBase: { type: Boolean, default: false }, // 重命名场景：选中去掉扩展名的主名
})
const emit = defineEmits(['confirm', 'cancel'])

const input = ref('')
const el = ref(null)

watch(() => props.visible, async (v) => {
  if (!v) return
  input.value = props.initial
  await nextTick()
  el.value?.focus()
  if (props.selectBase && props.initial) {
    const dot = props.initial.lastIndexOf('.')
    el.value.setSelectionRange(0, dot > 0 ? dot : props.initial.length)
  } else {
    el.value.select()
  }
})

function confirm() {
  const v = input.value.trim()
  if (!v) return
  emit('confirm', v)
}
function onKey(e) {
  if (e.key === 'Enter') confirm()
  else if (e.key === 'Escape') emit('cancel')
}
</script>

<template>
  <div v-if="visible" class="np-veil" @mousedown.self="emit('cancel')">
    <div class="np-card glass-card" @mousedown.stop>
      <div class="np-title">{{ title }}</div>
      <input ref="el" v-model="input" class="np-input" spellcheck="false"
             @keydown="onKey" />
      <div class="np-row">
        <button class="np-btn ghost" @click="emit('cancel')">取消</button>
        <button class="np-btn ok" :disabled="!input.trim()" @click="confirm">确定</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.np-veil {
  position: fixed; inset: 0; z-index: 920;
  background: rgba(0, 0, 0, 0.35); backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center;
}
.np-card {
  width: 320px; padding: 16px; border-radius: 16px;
  background: var(--panel-strong); border: 1px solid var(--border);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.35);
  animation: npop 0.16s ease;
}
@keyframes npop { from { transform: translateY(6px) scale(0.98); opacity: 0; } to { transform: none; opacity: 1; } }
.np-title { font-size: 13.5px; font-weight: 600; color: var(--text); margin-bottom: 10px; }
.np-input {
  width: 100%; height: 32px; padding: 0 10px; margin-bottom: 12px;
  border: 1px solid var(--border); border-radius: 9px;
  background: var(--bg-2); color: var(--text); font-size: 13px; outline: none;
}
.np-input:focus { border-color: var(--accent); }
.np-row { display: flex; justify-content: flex-end; gap: 8px; }
.np-btn {
  height: 30px; padding: 0 16px; border-radius: 9px; border: 1px solid var(--border);
  background: transparent; color: var(--text-2); font-size: 12.5px; cursor: pointer;
  transition: all 0.15s;
}
.np-btn.ok { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
.np-btn.ok:hover { filter: brightness(1.08); }
.np-btn.ghost:hover { color: var(--text); border-color: var(--text-2); }
.np-btn:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
