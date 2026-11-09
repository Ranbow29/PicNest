<script setup>
import { computed } from 'vue'
import { useLibrary } from '../stores/library'

/* 通用确认框：危险操作用红色主按钮；Promise<boolean> 由 store.askConfirm 返回 */
const lib = useLibrary()
const dlg = computed(() => lib.confirmDialog)
</script>

<template>
  <Teleport to="body">
    <div v-if="dlg.open" class="cf-layer" @click.self="lib.resolveConfirm(false)">
      <div class="cf-card" :class="{ danger: dlg.danger }">
        <div class="cf-head">{{ dlg.title }}</div>
        <div v-if="dlg.message" class="cf-msg">{{ dlg.message }}</div>
        <div v-if="dlg.details.length" class="cf-details">
          <div v-for="(d, i) in dlg.details" :key="i" class="cf-line">{{ d }}</div>
        </div>
        <div class="cf-foot">
          <button class="cf-btn" @click="lib.resolveConfirm(false)">取消</button>
          <button class="cf-btn primary" @click="lib.resolveConfirm(true)">{{ dlg.confirmText }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cf-layer {
  position: fixed; inset: 0; z-index: 950;
  background: rgba(12, 11, 16, 0.5); backdrop-filter: blur(3px);
  display: flex; align-items: center; justify-content: center;
}
.cf-card {
  width: min(420px, 88vw);
  background: var(--panel-strong); backdrop-filter: blur(var(--blur));
  border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow);
  padding: 18px 18px 14px;
  animation: cf-in 0.18s var(--ease-overshoot);
}
@keyframes cf-in { from { opacity: 0; transform: translateY(8px) scale(0.97); } to { opacity: 1; transform: none; } }
.cf-head { font-size: 14px; font-weight: 700; }
.cf-card.danger .cf-head { color: #cf6b5c; }
.cf-msg { margin-top: 10px; font-size: 12.5px; line-height: 1.55; color: var(--text); }
.cf-details { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
.cf-line { font-size: 11.5px; line-height: 1.5; color: var(--text-2); }
.cf-foot { margin-top: 18px; display: flex; justify-content: flex-end; gap: 10px; }
.cf-btn {
  border: 1px solid var(--border); background: transparent; color: var(--text);
  padding: 8px 18px; border-radius: 9px; font-size: 12.5px; cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.cf-btn:hover { background: var(--accent-weak); border-color: var(--accent); }
.cf-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
.cf-btn.primary:hover { filter: brightness(1.06); }
.cf-card.danger .cf-btn.primary { background: #c25a4d; border-color: #c25a4d; }
</style>
