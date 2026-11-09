<script setup>
// 长任务浮条（文件夹整包查重等）：底部居中，显示进度与取消；不阻塞操作
import { computed } from 'vue'
import { useLibrary } from '../stores/library'

const lib = useLibrary()
const t = computed(() => lib.taskProgress)
const pct = computed(() => (t.value.total ? Math.min(100, Math.round((t.value.done / t.value.total) * 100)) : 0))
</script>

<template>
  <Teleport to="body">
    <Transition name="tp">
      <div v-if="t.visible" class="tp-pill">
        <span class="tp-spin" />
        <div class="tp-body">
          <div class="tp-label">{{ t.label }}<em v-if="t.total"> · {{ t.done }}/{{ t.total }}</em></div>
          <div class="tp-bar"><i :style="{ width: pct + '%' }" /></div>
        </div>
        <button v-if="t.cancelable" class="tp-btn" :disabled="t.canceling" @click="lib.cancelTask()">{{ t.canceling ? '停止中…' : '停止' }}</button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.tp-pill {
  position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
  z-index: 870; display: flex; align-items: center; gap: 12px;
  padding: 10px 14px; border-radius: 12px;
  background: var(--panel-strong); backdrop-filter: blur(var(--blur)) saturate(1.1);
  border: 1px solid var(--border); box-shadow: var(--shadow-float);
  min-width: 280px; max-width: min(520px, 80vw);
}
.tp-spin {
  width: 16px; height: 16px; flex: none; border-radius: 50%;
  border: 2px solid var(--border); border-top-color: var(--accent);
  animation: tp-spin 0.8s linear infinite;
}
@keyframes tp-spin { to { transform: rotate(360deg); } }
.tp-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.tp-label { font-size: 11.5px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tp-label em { font-style: normal; color: var(--text-2); font-variant-numeric: tabular-nums; }
.tp-bar { height: 3px; border-radius: 2px; background: var(--border); overflow: hidden; }
.tp-bar i { display: block; height: 100%; background: var(--accent); border-radius: 2px; transition: width 0.2s ease; }
.tp-btn {
  flex: none; border: 1px solid var(--border); background: transparent; color: var(--text);
  padding: 5px 12px; border-radius: 8px; font-size: 11.5px; cursor: pointer;
}
.tp-btn:hover { border-color: var(--accent); color: var(--accent); }
.tp-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.tp-enter-active, .tp-leave-active { transition: opacity 0.18s ease, transform 0.18s var(--ease-overshoot); }
.tp-enter-from, .tp-leave-to { opacity: 0; transform: translate(-50%, 8px); }
</style>
