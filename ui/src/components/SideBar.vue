<script setup>
import { computed, ref } from 'vue'
import { useLibrary, extractDropUrls } from '../stores/library'
import DirTreeItem from './DirTreeItem.vue'
import FolderIcon from './FolderIcon.vue'
import NamePromptDialog from './NamePromptDialog.vue'
import DirContextMenu from './DirContextMenu.vue'

const lib = useLibrary()

const entries = computed(() => [
  { key: 'all', label: '全部', count: lib.counts.all ?? 0, enabled: true },
  { key: 'recent', label: '最近使用', count: lib.counts.recent ?? 0, enabled: true },
  { key: 'uncategorized', label: '未分类', count: lib.counts.uncategorized ?? 0, enabled: true },
  { key: 'random', label: '随机模式', count: null, enabled: true },
  { key: 'trash', label: '回收站', count: lib.counts.trash ?? 0, enabled: true },
])

const libs = computed(() => (lib.roots || []).map((r) => ({
  ...r,
  name: r.display_name || r.path.split(/[\\/]/).pop(),
  active: r.id === lib.activeRootId,
})))

const askNewFolder = ref(false)

async function newFolderInRoot(name) {
  const r = await lib.mkdirIn('', name)
  if (r?.ok) {
    lib.patchDirMemory('', { expanded: true })
    if (r.rel) lib.patchDirMemory(r.rel, { expanded: true })
  }
}

async function pickFolder() {
  const p = window.picrand
  const picked = await p.selectFolders?.()
  const path = Array.isArray(picked) ? picked[0] : picked
  if (path) await lib.addRootByPath(path)
}

function openNode(node) {
  lib.openDir(node.rel || null) // 树根 → null(全部)；子目录 → rel
}

/* 拖到侧栏空白 = 外部文件录进库根 / 内部目录移回根 */
async function dropToRoot(e) {
  e.stopPropagation()
  const types = [...(e.dataTransfer?.types || [])]
  if (types.includes('Files') || types.includes('text/uri-list')) {
    const paths = [...(e.dataTransfer.files || [])].map((f) => window.picrand.getFilePath?.(f)).filter(Boolean)
    const urls = extractDropUrls(e.dataTransfer)
    if (paths.length) await lib.importDrop(paths, '')
    else if (urls.length) await lib.importUrls(urls, '')
    return
  }
  const srcDir = e.dataTransfer.getData('application/x-picnest-dir')
  const srcFile = e.dataTransfer.getData('application/x-picnest-file')
  if (srcDir) await lib.moveDir(srcDir, '')
  else if (srcFile) await lib.moveImage(srcFile, '')
}
</script>

<template>
  <aside
    class="sidebar" :style="{ width: lib.sidebarWidth + 'px' }"
    @dragover.prevent @drop.prevent="dropToRoot"
  >
    <div class="brand">
      <h1>图巢</h1>
      <span class="sub">PicNest</span>
    </div>

    <nav class="views">
      <div
        v-for="e in entries" :key="e.key"
        class="view-item" :class="{ active: lib.view === e.key && (e.key !== 'all' || !lib.currentDirRel), disabled: !e.enabled }"
        @click="e.enabled && lib.view !== e.key && lib.switchView(e.key)"
      >
        <span class="label">{{ e.label }}</span>
        <span v-if="e.count != null" class="count">{{ e.count.toLocaleString() }}</span>
      </div>
    </nav>

    <!-- 资料库：每个根一个节点，点击切换；当前库高亮；右键 = 文件夹菜单 -->
    <div class="section-head">
      <span>资料库</span>
      <button class="add-btn lib-add" title="添加资料库（选择目录）" @click="pickFolder">⌂</button>
    </div>
    <div class="libs">
      <div v-for="l in libs" :key="l.id" class="lib-item" :class="{ active: l.active }"
           @click="lib.switchRoot(l.id)"
           @contextmenu.prevent.stop="lib.openDirMenu($event, { rel: '', node: l, isLibrary: true, absPath: l.path })">
        <FolderIcon :color="lib.dirMemory['']?.color || ''" :size="17" />
        <span class="label">{{ l.name }}</span>
        <span class="count">{{ l.active ? (lib.counts.all ?? 0).toLocaleString() : '' }}</span>
      </div>
    </div>

    <div class="section-head">
      <span>文件夹</span>
      <button class="add-btn" title="当前库根下新建文件夹" @click="askNewFolder = true">＋</button>
    </div>

    <div v-if="lib.scanning" class="scanning">{{ lib.scanNote }}</div>
    <div v-else-if="!lib.tree" class="empty">还没有资料库，点 ⌂ 导入</div>
    <div v-else class="tree">
      <DirTreeItem :node="lib.tree.tree" :depth="0" @open="openNode" />
    </div>

    <div v-if="lib.error" class="error">{{ lib.error }}</div>

    <NamePromptDialog :visible="askNewFolder" title="在库根新建文件夹"
                      @confirm="(v) => { askNewFolder = false; newFolderInRoot(v) }"
                      @cancel="askNewFolder = false" />
  </aside>
  <DirContextMenu />
</template>

<style scoped>
.sidebar {
  /* 左侧栏 = 底层（不是浮岛卡）：主面板浮在它上面，ZCode 同构；宽度可拖 */
  flex: none; display: flex; flex-direction: column;
  padding: 14px 8px 10px; overflow: hidden;
}
.brand { display: flex; align-items: baseline; gap: 10px; padding: 2px 10px 12px; border-bottom: 1px solid var(--border); }
.brand h1 { font-family: var(--font-serif); font-size: 21px; margin: 0; letter-spacing: 6px; }
.brand .sub { font-size: 11px; color: var(--text-2); letter-spacing: 2px; }

.views { display: flex; flex-direction: column; gap: 2px; padding: 8px 0; }
.view-item {
  display: flex; align-items: center; height: 32px; padding: 0 10px;
  border-radius: 9px; color: var(--text-2); transition: background 0.15s, color 0.15s;
}
.view-item:hover:not(.disabled) { background: var(--accent-weak); color: var(--text); }
.view-item.active { background: var(--accent-weak); color: var(--accent); font-weight: 600; }
.view-item.disabled { opacity: 0.45; }
.label { flex: 1; font-size: 13px; }
.count { font-size: 11px; font-variant-numeric: tabular-nums; }

.section-head {
  display: flex; align-items: center; padding: 10px 10px 6px;
  font-size: 11px; color: var(--text-2); letter-spacing: 1px;
}
.head-btns { margin-left: auto; display: flex; gap: 2px; }
.add-btn {
  width: 22px; height: 22px; border: none; border-radius: 6px;
  background: transparent; color: var(--text-2); cursor: pointer; font-size: 13px;
}
.head-btns .add-btn { margin-left: 0; }
.add-btn.lib-add { font-size: 12px; }
.add-btn:hover { background: var(--accent-weak); color: var(--accent); }

/* 资料库节点区 */
.libs { display: flex; flex-direction: column; gap: 2px; padding: 0 4px 4px; }
.lib-item {
  display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px;
  border-radius: 9px; color: var(--text-2); cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.lib-item:hover { background: var(--accent-weak); color: var(--text); }
.lib-item.active { background: var(--accent-weak); color: var(--accent); font-weight: 600; }
.lib-item .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lib-item .count { font-size: 11px; font-variant-numeric: tabular-nums; }

.tree { flex: 1; overflow-y: auto; padding-bottom: 6px; }
.tree::-webkit-scrollbar { width: 6px; }
.tree::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

.scanning, .empty { padding: 12px; font-size: 12px; color: var(--text-2); }
.error { padding: 8px 12px; font-size: 11px; color: #e5484d; }
</style>
