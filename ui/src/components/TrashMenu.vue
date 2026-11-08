<script setup>
import { computed } from 'vue'
import { useLibrary } from '../stores/library'

/* 回收站右键菜单：一键还原 / 清空回收站 */
const lib = useLibrary()
const menu = computed(() => lib.trashMenu)
const count = computed(() => lib.counts?.trash ?? 0)
const pos = computed(() => ({
  left: Math.max(4, Math.min(menu.value.x ?? 0, window.innerWidth - 240)) + 'px',
  top: Math.max(4, Math.min(menu.value.y ?? 0, window.innerHeight - 120)) + 'px',
}))
function run(fn) {
  lib.closeTrashMenu()
  fn()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="menu.open" class="tm-layer" @click="lib.closeTrashMenu()" @contextmenu.prevent="lib.closeTrashMenu()">
      <div class="tm" :style="pos" @click.stop>
        <button class="mi" @click="run(() => lib.restoreAllTrash())">一键还原全部（{{ count }}）</button>
        <button class="mi danger" @click="run(() => lib.purgeAllTrash())">清空回收站</button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.tm-layer { position: fixed; inset: 0; z-index: 900; }
.tm {
  position: fixed; min-width: 210px; padding: 5px;
  background: var(--panel-strong); backdrop-filter: blur(var(--blur));
  border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow);
  animation: tmpop 0.14s ease;
}
@keyframes tmpop { from { transform: translateY(-4px); opacity: 0; } to { transform: none; opacity: 1; } }
.mi {
  display: flex; align-items: center; width: 100%;
  border: none; background: transparent; color: var(--text);
  padding: 8px 10px; border-radius: 8px; font-size: 12.5px; cursor: pointer; text-align: left;
  transition: background 0.12s;
}
.mi:hover { background: var(--accent-weak); }
.mi.danger { color: #c25a4d; }
.mi.danger:hover { background: rgba(194, 90, 77, 0.12); }
</style>
