<script setup>
import { computed } from 'vue'
import { useLibrary } from '../stores/library'

const lib = useLibrary()
const menu = computed(() => lib.contextMenu)

/* 视口钳制定位：innerWidth 不是模板作用域标识（曾渲染成 NaNpx → 菜单钉在左上角） */
const pos = computed(() => ({
  left: Math.max(4, Math.min(menu.value.x ?? 0, window.innerWidth - 230)) + 'px',
  top: Math.max(4, Math.min(menu.value.y ?? 0, window.innerHeight - 280)) + 'px',
}))

const items = computed(() => {
  if (!menu.value.image) return []
  if (lib.view === 'trash') {
    return [
      { key: 'restore', label: '还原到原文件夹', run: () => lib.restoreFromTrash(menu.value.image.file_path) },
      { key: 'reveal', label: '在文件管理器打开', run: () => lib.reveal(menu.value.image.file_path) },
      { sep: true },
      { key: 'purge', label: '彻底删除（丢回收站）', danger: true, run: () => lib.purgeFromTrash(menu.value.image.file_path) },
    ]
  }
  return [
    { key: 'open', label: '打开（灯箱）', run: () => lib.openLightbox(menu.value.image.file_path) },
    { key: 'reveal', label: '在文件管理器打开', run: () => lib.reveal(menu.value.image.file_path) },
    { key: 'rename', label: '重命名', run: () => { lib.selectedPath = menu.value.image.file_path; lib.renaming = true } },
    { key: 'copy', label: '复制', run: () => {
      const path = menu.value.image.file_path
      const paths = (lib.selectedPaths.length > 1 && lib.selectedPaths.includes(path))
        ? lib.selectedPaths.slice()
        : [path]
      lib.copyFiles(paths)
    } },
    ...(lib.clipboard?.kind && lib.currentDirRel ? [{
      key: 'paste', label: '粘贴到当前文件夹',
      run: () => lib.paste({ rootId: lib.activeRootId, rel: lib.currentDirRel }),
    }] : []),
    { key: 'copypath', label: '复制文件路径', run: async () => { try { await navigator.clipboard.writeText(menu.value.image.file_path) } catch {} } },
    { key: 'remove', label: '从库中移除（文件保留）', run: () => lib.removeFromLibrary(menu.value.image.file_path) },
    { sep: true },
    { key: 'del', label: '丢到回收站', danger: true, run: () => lib.del(menu.value.image.file_path) },
  ]
})

function run(item) {
  item.run?.()
  if (!item.sep) lib.closeContextMenu()
}
function onLeave() { lib.closeContextMenu() }
</script>

<template>
  <Teleport to="body">
    <div v-if="menu.open" class="menu-layer" @click="onLeave" @contextmenu.prevent="onLeave">
      <div class="menu glass-card" :style="pos">
        <button
          v-for="(it, i) in items" :key="i"
          class="mi" :class="{ danger: it.danger, sep: it.sep }"
          @click.stop="it.sep ? null : run(it)"
        >
          <span v-if="it.sep" class="sep-line" />
          <template v-else>{{ it.label }}</template>
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.menu-layer { position: fixed; inset: 0; z-index: 900; }
.glass-card {
  position: fixed; min-width: 200px; padding: 5px;
  background: var(--panel-strong); backdrop-filter: blur(var(--blur));
  border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow);
  animation: pop .14s ease;
}
@keyframes pop { from { transform: scale(.96); opacity: 0; } to { transform: none; opacity: 1; } }
.mi {
  display: block; width: 100%; border: none; background: transparent;
  padding: 8px 12px; border-radius: 8px; text-align: left;
  color: var(--text); font-size: 12.5px; cursor: pointer;
  transition: background .12s;
}
.mi:hover { background: var(--accent-weak); }
.mi.danger { color: #d24b4b; }
.mi.danger:hover { background: rgba(210, 75, 75, 0.12); }
.sep-line { display: block; height: 1px; margin: 4px 2px; background: var(--border); }
</style>
