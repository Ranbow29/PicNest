<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useLibrary, extractDropUrls } from '../stores/library'
import { isExternalDT as isDnDExternal } from '../lib/dnd'
import DirTreeItem from './DirTreeItem.vue'
import FolderIcon from './FolderIcon.vue'
import NamePromptDialog from './NamePromptDialog.vue'
import DirContextMenu from './DirContextMenu.vue'
import EagleImportWizard from './EagleImportWizard.vue'

const lib = useLibrary()
const eagleImport = ref(null)
const eagleChecking = ref(false)
let eagleCheckTimer = null
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

/* 视图分两档：「全部」独占一行（主入口），其余四个并成 2×2 网格，省出两行高度给文件夹树 */
const primaryEntry = computed(() => entries.value[0])
const gridEntries = computed(() => entries.value.slice(1))
function isEntryActive(e) {
  return !lib.selectionView && lib.view === e.key && (e.key !== 'all' || !lib.currentDirRel)
}

const libs = computed(() => (lib.roots || []).map((r) => ({
  ...r,
  name: r.display_name || r.path.split(/[\\/]/).pop(),
  active: r.id === lib.activeRootId,
})))
/* 根文件区可折叠：折叠时只露出当前库，一库多根时腾出纵向空间给文件夹树（持久化） */
const rootsFolded = ref(localStorage.getItem('picnest.rootsFolded') === '1')
function toggleRootsFolded() {
  rootsFolded.value = !rootsFolded.value
  localStorage.setItem('picnest.rootsFolded', rootsFolded.value ? '1' : '0')
}
const visibleLibs = computed(() => (rootsFolded.value ? libs.value.filter((l) => l.active) : libs.value))

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
  if (!path) return
  // 只有选中的目录是 Eagle .library 才弹迁移向导；普通文件夹保持原加根流程
  clearTimeout(eagleCheckTimer)
  eagleCheckTimer = setTimeout(() => { eagleChecking.value = true }, 350)
  try {
    const info = await window.picrand.picnestEagleInspect?.(path)
    if (info?.eagle) {
      if (!info.ok) { lib.showNote(info.error || 'Eagle 库检测失败', [], 'error'); return }
      eagleImport.value = info
      return
    }
  } catch { /* 检测失败按普通文件夹处理 */ } finally {
    clearTimeout(eagleCheckTimer)
    eagleChecking.value = false
  }
  await lib.addRootByPath(path)
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
/* 图片拖到「回收站」= 软删；拖到「未分类」= 移到库根（与回收站同为显式落点，避免手滑误落） */
const trashOver = ref(false)
const uncatOver = ref(false)
function isInternalImagesDT(e) {
  const t = [...(e.dataTransfer?.types || [])]
  return t.includes('application/x-picnest-file') || t.includes('application/x-picnest-files')
}
function onViewDragOver(e, entry) {
  if (!isInternalImagesDT(e)) return
  if (entry.key === 'trash') {
    e.preventDefault(); e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    trashOver.value = true; uncatOver.value = false
    lib.setDropHint('trash', '移入回收站', e.clientX, e.clientY)
  } else if (entry.key === 'uncategorized') {
    e.preventDefault(); e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    uncatOver.value = true; trashOver.value = false
    lib.setDropHint('uncat', '移入未分类', e.clientX, e.clientY)
  }
}
function onViewDragLeave(entry) {
  if (entry.key === 'trash') trashOver.value = false
  if (entry.key === 'uncategorized') uncatOver.value = false
}
async function onViewDrop(e, entry) {
  if (!isInternalImagesDT(e)) return
  if (entry.key !== 'trash' && entry.key !== 'uncategorized') return
  e.preventDefault()
  e.stopPropagation()
  trashOver.value = false
  uncatOver.value = false
  lib.clearDropHint()
  const multi = dtList(e.dataTransfer, 'application/x-picnest-files')
  const single = e.dataTransfer.getData('application/x-picnest-file')
  const paths = multi.length ? multi : (single ? [single] : [])
  if (!paths.length) return
  if (entry.key === 'trash') await lib.trashImages(paths)
  else await lib.moveToUncategorized(paths)
}

/* 拖到侧栏空白 = 外部文件录进当前库根 / 内部目录移回根 */
async function dropToRoot(e) {
  e.stopPropagation()
  lib.clearDropHint()
  if (isDnDExternal(e)) {
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

/* 拖到资料库行 = 录进对应资料库的库根（全部/未分类）；内部文件夹拖到当前库行 = 移回库根 */
function isExternalDT(e) {
  return isDnDExternal(e)
}
function isInternalDirsDT(e) {
  const t = [...(e.dataTransfer?.types || [])]
  return t.includes('application/x-picnest-dir') || t.includes('application/x-picnest-dirs')
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
  const internalDirs = isInternalDirsDT(e)
  if (!isExternalDT(e) && !internalDirs) return
  if (internalDirs && !l.active) return // 只允许移回当前库根，不跨库搬文件夹
  e.preventDefault()
  e.stopPropagation()
  e.dataTransfer.dropEffect = internalDirs ? 'move' : 'copy'
  lib.setDropHint('lib', internalDirs ? `移到根文件「${l.name}」` : `录入到「${l.name}」`, e.clientX, e.clientY, l.id)
}
async function dropOnLib(e, l) {
  e.stopPropagation()
  lib.clearDropHint()
  const internalDirs = isInternalDirsDT(e)
  if (internalDirs) {
    if (!l.active) return
    const one = e.dataTransfer.getData('application/x-picnest-dir')
    let list = []
    try { list = JSON.parse(e.dataTransfer.getData('application/x-picnest-dirs') || '[]') } catch { /* 静默 */ }
    if (!Array.isArray(list) || !list.length) list = one ? [one] : []
    if (list.length) await lib.dropOnDirs(list.filter(Boolean), '', 'into')
    return
  }
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
    class="sidebar" :class="{ collapsed: lib.sidebarCollapsed }"
    :style="{ width: (lib.sidebarCollapsed ? 0 : lib.sidebarWidth) + 'px' }"
    @dragover="onSidebarDragOver" @dragleave="onSidebarDragLeave" @drop.prevent="dropToRoot"
  >
    <div class="brand">
      <h1>图巢</h1>
      <span class="sub">PicNest</span>
    </div>

    <nav class="views">
      <div
        class="view-item primary" :class="{ active: isEntryActive(primaryEntry) }"
        @click="lib.view !== primaryEntry.key && lib.switchView(primaryEntry.key)"
      >
        <svg class="v-ico" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1.2" /><rect x="9" y="2" width="5" height="5" rx="1.2" /><rect x="2" y="9" width="5" height="5" rx="1.2" /><rect x="9" y="9" width="5" height="5" rx="1.2" /></svg>
        <span class="label">{{ primaryEntry.label }}</span>
        <span class="count">{{ primaryEntry.count.toLocaleString() }}</span>
      </div>
      <div class="view-grid">
        <div
          v-for="e in gridEntries" :key="e.key"
          class="view-item chip" :class="{ active: isEntryActive(e), disabled: !e.enabled, 'drop-trash': e.key === 'trash' && trashOver, 'drop-uncat': e.key === 'uncategorized' && uncatOver }"
          :title="e.count != null ? `${e.label} · ${e.count.toLocaleString()}` : e.label"
          @click="e.enabled && lib.view !== e.key && lib.switchView(e.key)"
          @contextmenu="onViewMenu($event, e)"
          @dragover="onViewDragOver($event, e)" @dragleave="onViewDragLeave(e)" @drop.prevent="onViewDrop($event, e)"
        >
          <svg v-if="e.key === 'recent'" class="v-ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.8" /><path d="M8 4.8V8l2.2 1.4" /></svg>
          <svg v-else-if="e.key === 'uncategorized'" class="v-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5.5 8 2.5l5.5 3v5L8 13.5l-5.5-3z" /><path d="M2.5 5.5 8 8.5l5.5-3M8 8.5v5" /></svg>
          <svg v-else-if="e.key === 'random'" class="v-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5h2.5c3 0 4 7 7 7H14M2 11.5h2.5c1.2 0 2-1 2.7-2.3M9 6.6c.7-1.2 1.5-2.1 2.5-2.1H14" /><path d="m12.3 2.8 1.7 1.7-1.7 1.7M12.3 9.8l1.7 1.7-1.7 1.7" /></svg>
          <svg v-else class="v-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.3 4.5l.7 9h6l.7-9" /></svg>
          <span class="label">{{ e.label }}</span>
          <span v-if="e.count != null" class="count">{{ e.count.toLocaleString() }}</span>
        </div>
      </div>
    </nav>

    <!-- 根文件（资料库根）：每个根一个节点，点击回到库根；当前库高亮；右键 = 文件夹菜单；标题可折叠 -->
    <div class="section-head foldable" @click="toggleRootsFolded" :title="rootsFolded ? '展开全部根文件' : '只显示当前根文件'">
      <span class="sh-caret" :class="{ open: !rootsFolded }">▸</span>
      <span>根文件</span>
      <span v-if="libs.length > 1" class="sh-badge">{{ libs.length }}</span>
      <button class="add-btn lib-add" title="添加根文件（支持 Eagle .library）" @click.stop="pickFolder">⌂</button>
    </div>
    <div class="libs">
      <div v-for="l in visibleLibs" :key="l.id" class="lib-item" :class="{ active: l.active, 'drop-into': lib.dropHint.active && lib.dropHint.zone === 'lib' && lib.dropHint.key === l.id }"
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
      <DirTreeItem v-for="c in (lib.tree.tree.children || [])" :key="c.rel" :node="c" :depth="0" @open="openNode" />
      <div v-if="!(lib.tree.tree.children || []).length" class="empty">暂无子文件夹</div>
    </div>

    <div v-if="lib.error" class="error">{{ lib.error }}</div>

    <div class="sb-foot">
      <button class="plugin-entry" title="插件库（主题 / 界面插件）" @click="lib.openPlugins()">
        <span class="pe-ico">🧩</span><span>插件库</span>
      </button>
    </div>

    <NamePromptDialog :visible="askNewFolder" title="在库根新建文件夹"
                      @confirm="(v) => { askNewFolder = false; newFolderInRoot(v) }"
                      @cancel="askNewFolder = false" />
    <EagleImportWizard v-if="eagleImport" :info="eagleImport" @close="eagleImport = null" />
    <div v-if="eagleChecking" class="eagle-check">
      <div class="eagle-check-card"><span class="eagle-check-spin" />正在读取 Eagle 库…</div>
    </div>
  </aside>
  <DirContextMenu />
</template>

<style scoped>
.sidebar {
  /* 左侧栏 = 底层（不是浮岛卡）：主面板浮在它上面，ZCode 同构；宽度可拖 */
  flex: none; display: flex; flex-direction: column;
  padding: 10px 8px 8px; overflow: hidden;
  transition: width 0.24s var(--ease-overshoot), padding 0.2s ease, opacity 0.18s ease;
  /* 底子顶部白色渐变：从栏顶亮起，150px 内渐隐回 --bg（范围对齐品牌区+「全部」行） */
  background: linear-gradient(180deg, var(--sidebar-glow) 0, rgba(255, 255, 255, 0) 150px);
}
.sidebar.collapsed { padding-left: 0; padding-right: 0; opacity: 0; pointer-events: none; }
.brand { display: flex; align-items: baseline; gap: 8px; padding: 1px 10px 8px; border-bottom: 1px solid var(--border); user-select: none; -webkit-app-region: drag; }
.brand h1 { font-family: var(--font-serif); font-size: 19px; margin: 0; letter-spacing: 4px; }
.brand .sub { font-size: 10px; color: var(--text-2); letter-spacing: 1.5px; }

/* ---- 视图区：主入口一行 + 2×2 小卡网格 ---- */
.views { display: flex; flex-direction: column; gap: 4px; padding: 7px 2px 6px; }
.view-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; container-type: inline-size; }
/* 侧栏拖窄时逐级让位：先藏图标，再藏数字，保证「最近使用」等标签完整 */
@container (max-width: 236px) { .view-item.chip .v-ico { display: none; } }
@container (max-width: 196px) { .view-item.chip .count { display: none; } }
.view-item {
  position: relative;
  display: flex; align-items: center; gap: 7px; height: 28px; padding: 0 9px;
  border-radius: 8px; color: var(--text-2); cursor: pointer;
  transition: background 0.15s, color 0.15s, box-shadow 0.15s;
}
.view-item.chip {
  height: 27px; padding: 0 8px; gap: 6px; min-width: 0;
  background: var(--panel);
  background: color-mix(in srgb, var(--panel-strong) 45%, transparent);
  box-shadow: inset 0 0 0 1px var(--border);
}
.view-item.chip .label { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.view-item.chip .count { opacity: 0.8; }
.view-item:hover:not(.disabled) { background: var(--accent-weak); color: var(--text); }
.view-item.active { background: var(--accent-weak); color: var(--accent); font-weight: 600; box-shadow: inset 0 0 0 1px var(--accent-weak); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 38%, transparent); }
.view-item.primary.active::before {
  content: ''; position: absolute; left: 0; top: 7px; bottom: 7px; width: 3px;
  border-radius: 0 3px 3px 0; background: var(--accent);
}
.view-item.drop-trash { background: rgba(194, 90, 77, 0.14); color: #cf6b5c; outline: 1.5px dashed #c25a4d; outline-offset: -2px; }
.view-item.drop-uncat { background: var(--accent-weak); color: var(--accent); outline: 1.5px dashed var(--accent); outline-offset: -2px; }
.view-item.disabled { opacity: 0.45; }
.v-ico {
  flex: none; width: 14px; height: 14px;
  fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round;
  opacity: 0.85;
}
.label { flex: 1; min-width: 0; font-size: 12.5px; }
.count { font-size: 10.5px; font-variant-numeric: tabular-nums; }

.section-head {
  display: flex; align-items: center; gap: 5px; padding: 6px 6px 4px 10px;
  font-size: 10.5px; color: var(--text-2); letter-spacing: 1px;
}
.section-head.foldable { cursor: pointer; border-radius: 6px; }
.section-head.foldable:hover { color: var(--text); }
.sh-caret { width: 9px; font-size: 9px; transition: transform 0.18s var(--ease-overshoot); margin-left: -4px; }
.sh-caret.open { transform: rotate(90deg); }
.sh-badge {
  padding: 0 5px; min-width: 16px; height: 15px; line-height: 15px; text-align: center;
  border-radius: 8px; background: var(--accent-weak); color: var(--accent);
  font-size: 9.5px; letter-spacing: 0; font-variant-numeric: tabular-nums;
}
.head-btns { margin-left: auto; display: flex; gap: 2px; }
.add-btn {
  margin-left: auto;
  width: 22px; height: 22px; border: none; border-radius: 6px;
  background: transparent; color: var(--text-2); cursor: pointer; font-size: 13px;
}
.head-btns .add-btn { margin-left: 0; }
.add-btn.lib-add { font-size: 12px; }
.add-btn:hover { background: var(--accent-weak); color: var(--accent); }

/* 资料库节点区 */
.libs { display: flex; flex-direction: column; gap: 1px; padding: 0 4px 2px; }
.lib-item {
  display: flex; align-items: center; gap: 7px; height: 28px; padding: 0 9px;
  border-radius: 8px; color: var(--text-2); cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.lib-item:hover { background: var(--accent-weak); color: var(--text); }
.lib-item.active { background: var(--accent-weak); color: var(--accent); font-weight: 600; }
.lib-item .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lib-item .count { font-size: 11px; font-variant-numeric: tabular-nums; }
.lib-item.drop-into { background: var(--accent-weak); outline: 1.5px dashed var(--accent); outline-offset: -2px; }

/* 文件夹树：占满剩余高度；上下边缘渐隐，滚动时不会被硬切 */
.tree {
  flex: 1; min-height: 120px; overflow-y: auto; padding: 4px 0 10px;
  -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 8px, #000 calc(100% - 14px), transparent 100%);
          mask-image: linear-gradient(180deg, transparent 0, #000 8px, #000 calc(100% - 14px), transparent 100%);
}
.tree::-webkit-scrollbar { width: 6px; }
.tree::-webkit-scrollbar-thumb { background: transparent; border-radius: 3px; }
.tree:hover::-webkit-scrollbar-thumb { background: var(--border); }

.scanning, .empty { padding: 12px; font-size: 12px; color: var(--text-2); }
.error { padding: 8px 12px; font-size: 11px; color: #e5484d; }
/* 底栏：插件库入口压成一条细栏，不再占一块虚线大按钮 */
.sb-foot {
  flex: none; display: flex; align-items: center; gap: 4px;
  margin: 2px -2px 0; padding-top: 6px; border-top: 1px solid var(--border);
}
.plugin-entry {
  display: flex; align-items: center; gap: 6px;
  height: 26px; padding: 0 9px;
  border: none; border-radius: 7px;
  background: transparent; color: var(--text-2); font-size: 11.5px; cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.plugin-entry:hover { color: var(--accent); background: var(--accent-weak); }
.pe-ico { font-size: 13px; line-height: 1; }
.eagle-check { position: fixed; inset: 0; z-index: 910; display: flex; align-items: center; justify-content: center; pointer-events: none; }
.eagle-check-card {
  display: flex; align-items: center; gap: 9px; padding: 10px 14px;
  border: 1px solid var(--border); border-radius: 10px;
  background: var(--panel-strong); color: var(--text); font-size: 12px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.22);
}
.eagle-check-spin {
  width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid var(--border); border-top-color: var(--accent);
  animation: eagle-spin 0.8s linear infinite;
}
@keyframes eagle-spin { to { transform: rotate(360deg); } }
</style>
