<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useLibrary, extractDropUrls } from '../stores/library'
import DirTreeItem from './DirTreeItem.vue'
import FolderIcon from './FolderIcon.vue'
import NamePromptDialog from './NamePromptDialog.vue'
import DirContextMenu from './DirContextMenu.vue'

const lib = useLibrary()
/* 从正文进入子文件夹后：祖先展开 + 选中行滚进树视口 */
let revealTimer = null
watch(() => lib.currentDirRel, async () => {
  await nextTick()
  clearTimeout(revealTimer)
  revealTimer = setTimeout(() => {
    document.querySelector('.tree .row.active')?.scrollIntoView({ block: 'nearest' })
  }, 160)
})

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
function onViewMenu(e, entry) {
  if (entry.key !== 'trash') return
  e.preventDefault()
  e.stopPropagation()
  lib.openTrashMenu(e)
}
/* 图片拖到「回收站」入口 = 软删 */
const trashOver = ref(false)
function isInternalImagesDT(e) {
  const t = [...(e.dataTransfer?.types || [])]
  return t.includes('application/x-picnest-file') || t.includes('application/x-picnest-files')
}
function onViewDragOver(e, entry) {
  if (entry.key !== 'trash' || !isInternalImagesDT(e)) return
  e.preventDefault()
  e.stopPropagation()
  e.dataTransfer.dropEffect = 'move'
  trashOver.value = true
  lib.setDropHint('trash', '移入回收站', e.clientX, e.clientY)
}
function onViewDragLeave(entry) {
  if (entry.key === 'trash') trashOver.value = false
}
async function onViewDrop(e, entry) {
  if (entry.key !== 'trash' || !isInternalImagesDT(e)) return
  e.preventDefault()
  e.stopPropagation()
  trashOver.value = false
  lib.clearDropHint()
  const multi = dtList(e.dataTransfer, 'application/x-picnest-files')
  const single = e.dataTransfer.getData('application/x-picnest-file')
  const paths = multi.length ? multi : (single ? [single] : [])
  if (paths.length) await lib.trashImages(paths)
}

/* 拖到侧栏空白 = 外部文件录进当前库根 / 内部目录移回根 */
async function dropToRoot(e) {
  e.stopPropagation()
  lib.clearDropHint()
  const types = [...(e.dataTransfer?.types || [])]
  if (types.includes('Files') || types.includes('text/uri-list')) {
    const paths = [...(e.dataTransfer.files || [])].map((f) => window.picrand.getFilePath?.(f)).filter(Boolean)
    const urls = extractDropUrls(e.dataTransfer)
    const target = { rootId: lib.activeRootId, rel: '' }
    if (paths.length) await lib.importDrop(paths, target)
    else if (urls.length) await lib.importUrls(urls, target)
    return
  }
  const srcDir = e.dataTransfer.getData('application/x-picnest-dir')
  const srcDirs = dtList(e.dataTransfer, 'application/x-picnest-dirs')
  /* 内部图片不再因拖到侧栏空白而进库根（避免拖动排序误落未分类）；文件夹仍可移回根 */
  if (srcDirs.length || srcDir) await lib.dropOnDirs(srcDirs.length ? srcDirs : [srcDir], '', 'into')
}

function dtList(dt, key) {
  try {
    const v = JSON.parse(dt.getData(key) || '[]')
    return Array.isArray(v) ? v.filter(Boolean) : []
  } catch { return [] }
}

/* 树空白点击 = 清空文件夹多选并退出合并视图 */
function clearTreeSelection() {
  lib.clearDirSelection()
  lib.exitSelectionView()
}

/* 拖到资料库行 = 录进对应资料库的库根（全部/未分类） */
function isExternalDT(e) {
  const types = [...(e.dataTransfer?.types || [])]
  return types.includes('Files') || types.includes('text/uri-list')
}
/* 侧栏空白：落当前库根（高亮当前资料库行） */
function onSidebarDragOver(e) {
  e.preventDefault()
  if (!isExternalDT(e)) return
  e.stopPropagation()
  const active = libs.value.find((x) => x.active)
  lib.setDropHint('lib', active ? `录入到「${active.name}」` : lib.mainDropLabel(), e.clientX, e.clientY, active ? active.id : null)
}
function onSidebarDragLeave(e) {
  if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth || e.clientY >= innerHeight) lib.clearDropHint()
}
function onLibDragOver(e, l) {
  e.preventDefault()
  if (!isExternalDT(e)) return
  e.stopPropagation()
  e.dataTransfer.dropEffect = 'copy'
  lib.setDropHint('lib', `录入到「${l.name}」`, e.clientX, e.clientY, l.id)
}
async function dropOnLib(e, l) {
  e.stopPropagation()
  lib.clearDropHint()
  if (!isExternalDT(e)) return
  const paths = [...(e.dataTransfer.files || [])].map((f) => window.picrand.getFilePath?.(f)).filter(Boolean)
  const urls = extractDropUrls(e.dataTransfer)
  const target = { rootId: l.id, rel: '' }
  if (paths.length) await lib.importDrop(paths, target)
  else if (urls.length) await lib.importUrls(urls, target)
}
</script>

<template>
  <aside
    class="sidebar" :style="{ width: lib.sidebarWidth + 'px' }"
    @dragover="onSidebarDragOver" @dragleave="onSidebarDragLeave" @drop.prevent="dropToRoot"
  >
    <div class="brand">
      <h1>图巢</h1>
      <span class="sub">PicNest</span>
    </div>

    <nav class="views">
      <div
        v-for="e in entries" :key="e.key"
        class="view-item" :class="{ active: !lib.selectionView && lib.view === e.key && (e.key !== 'all' || !lib.currentDirRel), disabled: !e.enabled, 'drop-trash': e.key === 'trash' && trashOver }"
        @click="e.enabled && lib.view !== e.key && lib.switchView(e.key)"
        @contextmenu="onViewMenu($event, e)"
        @dragover="onViewDragOver($event, e)" @dragleave="onViewDragLeave(e)" @drop.prevent="onViewDrop($event, e)"
      >
        <span class="label">{{ e.label }}</span>
        <span v-if="e.count != null" class="count">{{ e.count.toLocaleString() }}</span>
      </div>
    </nav>

    <!-- 根文件（资料库根）：每个根一个节点，点击回到库根；当前库高亮；右键 = 文件夹菜单 -->
    <div class="section-head">
      <span>根文件</span>
      <button class="add-btn lib-add" title="添加根文件（选择目录）" @click="pickFolder">⌂</button>
    </div>
    <div class="libs">
      <div v-for="l in libs" :key="l.id" class="lib-item" :class="{ active: l.active, 'drop-into': lib.dropHint.active && lib.dropHint.zone === 'lib' && lib.dropHint.key === l.id }"
           @click="lib.switchRoot(l.id)"
           @dragover="onLibDragOver($event, l)" @drop.prevent="dropOnLib($event, l)"
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
    <div v-else-if="!lib.tree" class="empty">还没有根文件，点 ⌂ 导入</div>
    <div v-else class="tree" @click.self="clearTreeSelection">
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
.view-item.drop-trash { background: rgba(194, 90, 77, 0.14); color: #cf6b5c; outline: 1.5px dashed #c25a4d; outline-offset: -2px; }
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
.lib-item.drop-into { background: var(--accent-weak); outline: 1.5px dashed var(--accent); outline-offset: -2px; }

.tree { flex: 1; overflow-y: auto; padding-bottom: 6px; }
.tree::-webkit-scrollbar { width: 6px; }
.tree::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

.scanning, .empty { padding: 12px; font-size: 12px; color: var(--text-2); }
.error { padding: 8px 12px; font-size: 11px; color: #e5484d; }
</style>
