<script setup>
// 资料库文件夹右键菜单：新建(子)文件夹 / 重命名 / 排序 / 移动到… / 导出 / 图标颜色
import { computed, ref } from 'vue'
import { useLibrary } from '../stores/library'
import NamePromptDialog from './NamePromptDialog.vue'

const lib = useLibrary()
const menu = computed(() => lib.dirMenu)

/* 视口钳制定位（窗口尺寸不可在模板作用域直接引用，会变 NaNpx） */
const pos = computed(() => ({
  left: Math.max(4, Math.min(menu.value.x ?? 0, window.innerWidth - 250)) + 'px',
  top: Math.max(4, Math.min(menu.value.y ?? 0, window.innerHeight - 430)) + 'px',
}))

const sortOpen = ref(false)
const colorOpen = ref(false)
const ask = ref(null) // { title, initial, selectBase, run(name) }
const isLib = computed(() => !!menu.value.node?.isLibrary) // 资料库根：不提供重命名/移动（保 DB 登记一致性）
// openDirMenu 传入的是 { rel, node, isLibrary?, absPath? } 包装层；实际节点在 .node
const menuNode = computed(() => menu.value.node?.node || menu.value.node || null)

const FOLDER_COLORS = [
  { key: '', css: 'var(--folder-default, #c9a86c)', label: '默认' },
  { key: 'blue', css: '#5b9bd5' },
  { key: 'green', css: '#6dbf90' },
  { key: 'red', css: '#e57373' },
  { key: 'orange', css: '#f0a45c' },
  { key: 'purple', css: '#a48ad4' },
  { key: 'cyan', css: '#5bc4c4' },
  { key: 'pink', css: '#e88ab8' },
]

function relOf(rel) { return rel || '' }
function parentRelOf(rel) { return rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '' }
function nameOf(rel) { return rel ? rel.split('/').pop() : (lib.tree?.rootPath || '').split('\\').pop() }

function run(fn) {
  lib.closeDirMenu()
  sortOpen.value = false
  colorOpen.value = false
  fn()
}
function toggle(which) {
  sortOpen.value = which === 'sort' ? !sortOpen.value : false
  colorOpen.value = which === 'color' ? !colorOpen.value : false
}

function newSub() {
  const rel = relOf(menu.value.rel)
  const isLibrary = isLib.value
  const rootId = menuNode.value?.id
  run(() => {
    ask.value = { title: '新建子文件夹', initial: '', run: async (name) => {
      const r = isLibrary ? await lib.mkdirInLibrary(rootId, name) : await lib.mkdirIn(rel, name)
      if (r?.ok && !isLibrary) lib.patchDirMemory(rel, { expanded: true })
    } }
  })
}
function newSibling() {
  const parent = parentRelOf(relOf(menu.value.rel))
  run(() => {
    ask.value = { title: parent ? '新建文件夹（同级）' : '在库根新建文件夹', initial: '', run: (name) => lib.mkdirIn(parent, name) }
  })
}
function rename() {
  const rel = relOf(menu.value.rel)
  const oldName = nameOf(rel)
  run(() => {
    ask.value = { title: '重命名文件夹', initial: lib.dispName(oldName), selectBase: true, run: (name) => lib.renameDir(rel, lib.renameTarget(oldName, name)) }
  })
}
function renameLib() {
  const node = menuNode.value || {}
  if (!node.id) return
  const current = String(node.path || '').split(/[\\/]/).pop() || node.display_name || node.name || ''
  run(() => {
    ask.value = { title: '重命名根文件夹（磁盘目录）', initial: current, selectBase: false, run: (name) => lib.renameLibrary(node.id, name) }
  })
}
/* 根文件 → 在文件管理器中打开（shell.openPath 打开目录本身，不是“显示所在位置”） */
function revealLib() {
  const p = menuNode.value?.path || menu.value.node?.absPath || ''
  if (!p) return
  run(async () => {
    const err = await window.picrand.openWithDefault(p).catch((e) => String(e?.message || e))
    if (err) lib.showNote(`打开失败：${err}`, [], 'error')
  })
}
/* 移出根文件：只解除登记，磁盘文件夹与文件保留；回收站非空先拦住 */
async function removeLib() {
  const node = menuNode.value || {}
  if (!node.id) return
  const name = node.display_name || node.name || ''
  run(async () => {
    let stats = { all: 0, trash: 0 }
    try { stats = await window.picrand.picnestViewCounts(node.id) } catch { /* 取不到就按 0 展示 */ }
    if ((stats.trash || 0) > 0) {
      lib.showNote(`「${name}」的回收站还有 ${stats.trash} 项`, ['先切到该根文件 → 回收站，清空或还原后再移出'], 'error')
      return
    }
    const ok = await lib.askConfirm({
      title: '移出根文件',
      message: `把「${name}」从根文件列表移出？`,
      details: [
        `图巢内索引 ${Number(stats.all || 0).toLocaleString()} 张图片；评分、注释、色板等图巢数据会一并清除`,
        '不再被任何图片引用的标签会一并删除；其他根文件仍在使用的标签保留',
        '磁盘上的原始文件夹与文件不会被删除，之后可重新添加回来',
        '其他根文件不受影响',
      ],
      confirmText: '移出',
      danger: true,
    })
    if (!ok) return
    const r = await lib.removeRoot(node.id)
    if (r?.ok) lib.showNote(`已移出根文件「${name}」（磁盘文件保留）`, [], 'ok')
    else lib.showNote(r?.error || '移出失败', [], 'error')
  })
}
async function moveTo() {
  const rel = relOf(menu.value.rel)
  const srcAbs = lib.absPathOf(rel)
  run(async () => {
    try {
      const picked = await window.picrand.selectFolders()
      const dst = Array.isArray(picked) ? picked[0] : picked
      if (!dst) return
      await window.picrand.picnestMoveDir(srcAbs, dst)
      await lib.refreshTree()
      await lib.loadImages()
    } catch { /* 静默 */ }
  })
}
function exportDir() {
  const rel = relOf(menu.value.rel)
  const isLibrary = isLib.value
  const rootId = menuNode.value?.id
  run(async () => {
    lib.scanning = true
    lib.scanNote = '导出中…'
    try {
      const r = isLibrary ? await lib.exportLibrary(rootId) : await lib.exportDir(rel)
      if (r?.ok) lib.scanNote = `已导出 ${r.count} 张 → ${r.dest}`
      else if (r?.canceled) lib.scanNote = ''
      else lib.scanNote = r?.error || '导出失败'
    } finally {
      lib.scanning = false
      setTimeout(() => { if (!lib.scanning) lib.scanNote = '' }, 4000)
    }
  })
}
/* 查重：文件夹行 = 查该子树；资料库行 = 查全库（始终不跨资料库） */
function findDupes() {
  const isLibrary = isLib.value
  const rel = isLibrary ? '' : relOf(menu.value.rel)
  const rootId = isLibrary ? menuNode.value?.id : lib.activeRootId
  run(() => lib.openDupFinder(rootId, rel))
}
/* 缩略图修复：资料库行 = 整个根；只补「缺图/缓存被清」的，已有缩略图不动 */
function repairThumbs() {
  const rootId = isLib.value ? menuNode.value?.id : lib.activeRootId
  run(() => lib.repairThumbs(rootId))
}
/* 一键清除整个根目录的 01_ 排序前缀（文件+文件夹，确认后改磁盘名） */
function stripPrefixes() {
  const rootId = isLib.value ? menuNode.value?.id : lib.activeRootId
  run(() => lib.stripOrderPrefixes(rootId))
}
/* 全局开关：手动排序时把顺序同步成文件名数字前缀（默认真改磁盘，谨慎开启） */
function togglePhysOrder() {
  run(() => lib.togglePhysicalOrder())
}
function sortLevel(mode) {
  const rel = relOf(menu.value.rel)
  const isLibrary = isLib.value
  const rootId = menuNode.value?.id
  run(() => (isLibrary ? lib.sortLibrary(rootId, mode) : lib.sortDir(rel, mode)))
}
function sortRecursive(mode) {
  const rel = relOf(menu.value.rel)
  const isLibrary = isLib.value
  const rootId = menuNode.value?.id
  run(() => (isLibrary ? lib.sortLibraryRecursive(rootId, mode) : lib.sortDirRecursive(rel, mode)))
}
function colorTargets() {
  if (isLib.value) return ['']
  const rel = relOf(menu.value.rel)
  if (!rel) return []
  return (lib.selectedDirs.length > 1 && lib.selectedDirs.includes(rel))
    ? [...new Set(lib.selectedDirs.filter(Boolean))]
    : [rel]
}
const colorCurrent = computed(() => {
  const vals = colorTargets().map((r) => lib.dirMemory[r]?.color || '')
  return vals.length && vals.every((v) => v === vals[0]) ? vals[0] : '__mixed__'
})
function setColor(key) {
  const rels = colorTargets()
  if (!rels.length) return
  run(async () => {
    for (const rel of rels) await lib.patchDirMemory(rel, { color: key })
  })
}
const fmtSize = (n) => {
  if (!n) return '—'
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB'
  if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB'
  if (n > 1024) return (n / 1024).toFixed(0) + ' KB'
  return n + ' B'
}
function deleteDir() {
  const rel = relOf(menu.value.rel)
  if (!rel) return
  const useSelection = lib.selectedDirs.length > 1 && lib.selectedDirs.includes(rel)
  const rels = lib.topLevelDirs(useSelection ? lib.selectedDirs : [rel]).filter((r) => r !== '')
  if (!rels.length) return
  const names = rels.map((r) => lib.dispName(r.split('/').pop()))
  run(async () => {
    const stats = await lib.dirStats(rels)
    const ok = await lib.askConfirm({
      title: rels.length > 1 ? `删除 ${rels.length} 个文件夹` : '删除文件夹',
      message: rels.length > 1 ? `确定删除这 ${rels.length} 个文件夹？` : `确定删除「${names[0]}」？`,
      details: [
        stats?.ok ? `${stats.count} 个文件 · ${fmtSize(stats.size)}` : '无法读取文件夹统计',
        rels.length > 1 ? `包含：${names.join('、')}` : '',
        '整个文件夹会移入图巢回收站（可在回收站视图还原）。',
      ].filter(Boolean),
      confirmText: '移入回收站',
      danger: true,
    })
    if (ok) await lib.deleteDirs(rels)
  })
}
const hasClip = computed(() => !!lib.clipboard?.kind)
/* 复制：右键行属于多选时复制整个选区（穿透由 store.topLevelDirs 负责） */
function copyItem() {
  const rel = relOf(menu.value.rel)
  const isLibrary = isLib.value
  const rootId = menuNode.value?.id
  const useSelection = !isLibrary && lib.selectedDirs.length > 1 && lib.selectedDirs.includes(rel)
  const sel = [...lib.selectedDirs]
  run(() => {
    if (isLibrary) lib.copyDirsFrom(rootId, [''])
    else lib.copyDirsFrom(lib.activeRootId, useSelection ? sel : [rel])
  })
}
function pasteItem() {
  const rel = relOf(menu.value.rel)
  const isLibrary = isLib.value
  const rootId = menuNode.value?.id
  run(() => {
    if (isLibrary) lib.paste({ rootId, rel: '' })
    else lib.paste({ rootId: lib.activeRootId, rel })
  })
}

const sortItems = [
  { label: '标题（当前层级） A→Z', mode: 'name_asc' },
  { label: '标题（当前层级） Z→A', mode: 'name_desc' },
  { label: '标题（全部层级） A→Z', mode: 'name_asc', rec: true },
  { label: '标题（全部层级） Z→A', mode: 'name_desc', rec: true },
  { label: '修改时间 新→旧', mode: 'mtime_desc' },
  { label: '修改时间 旧→新', mode: 'mtime_asc' },
]
</script>

<template>
  <Teleport to="body">
    <div v-if="menu.open" class="dm-layer" @click="lib.closeDirMenu()" @contextmenu.prevent="lib.closeDirMenu()">
      <div class="dm glass-card" :style="pos" @click.stop>
        <button v-if="isLib" class="mi" @click="revealLib">在文件管理器中打开</button>
        <button class="mi" @click="newSub">新建子文件夹</button>
        <button v-if="isLib" class="mi" @click="renameLib">重命名根文件…</button>
        <button v-if="!isLib" class="mi" @click="newSibling">新建文件夹</button>
        <button v-if="!isLib" class="mi" @click="rename">重命名</button>
        <button class="mi" @click="copyItem">{{ isLib ? '复制根文件' : '复制' }}</button>
        <button v-if="hasClip" class="mi" @click="pasteItem">粘贴到此{{ isLib ? '根文件' : '文件夹' }}</button>

        <div class="mi group" @click.stop="toggle('sort')">
          <span>排序</span><i class="caret" :class="{ on: sortOpen }">▸</i>
        </div>
        <template v-if="sortOpen">
          <button v-for="s in sortItems" :key="s.label" class="mi sub" @click="s.rec ? sortRecursive(s.mode) : sortLevel(s.mode)">
            {{ s.label }}
          </button>
        </template>

        <button v-if="!isLib" class="mi" @click="moveTo">移动到…</button>
        <button class="mi" @click="exportDir">导出（含子文件夹）</button>
        <button class="mi" @click="findDupes">查找重复…</button>
        <button v-if="isLib" class="mi" @click="repairThumbs">修复缩略图…</button>
        <button v-if="isLib" class="mi" @click="stripPrefixes">清除排序编号…</button>
        <button class="mi" title="手动排序时把顺序写成文件名数字前缀（会真实改名）" @click="togglePhysOrder">{{ lib.physicalOrder ? '✓ ' : '' }}排序同步文件名</button>

        <div class="mi group" @click.stop="toggle('color')">
          <span>图标颜色</span><i class="caret" :class="{ on: colorOpen }">▸</i>
        </div>
        <div v-if="colorOpen" class="swatch-row" @click.stop>
          <button v-for="c in FOLDER_COLORS" :key="c.key" class="sw"
                  :class="{ on: colorCurrent === c.key }"
                  :style="{ background: c.css }" :title="c.label || c.key"
                  @click="setColor(c.key)" />
        </div>

        <button v-if="isLib" class="mi danger" @click="removeLib">移出根文件…</button>
        <button v-if="!isLib" class="mi danger" @click="deleteDir">删除文件夹…</button>
      </div>
    </div>

    <NamePromptDialog :visible="!!ask" :title="ask?.title || ''" :initial="ask?.initial || ''"
                      :select-base="ask?.selectBase || false"
                      @confirm="(v) => { const a = ask; ask = null; a?.run(v) }"
                      @cancel="ask = null" />
  </Teleport>
</template>

<style scoped>
.dm-layer { position: fixed; inset: 0; z-index: 900; }
.dm {
  position: fixed; min-width: 220px; padding: 5px;
  background: var(--panel-strong); backdrop-filter: blur(var(--blur));
  border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow);
  animation: dmpop 0.14s ease;
  max-height: 70vh; overflow-y: auto; scrollbar-width: none;
}
.dm::-webkit-scrollbar { display: none; }
@keyframes dmpop { from { transform: translateY(-4px); opacity: 0; } to { transform: none; opacity: 1; } }
.mi {
  display: flex; align-items: center; justify-content: space-between; width: 100%;
  border: none; background: transparent; color: var(--text);
  padding: 8px 10px; border-radius: 8px; font-size: 12.5px; cursor: pointer; text-align: left;
  transition: background 0.12s;
}
.mi:hover { background: var(--accent-weak); }
.mi.group { color: var(--text-2); }
.mi.sub { padding-left: 22px; font-size: 12px; color: var(--text-2); }
.mi.sub:hover { color: var(--text); }
.mi.danger { color: #c25a4d; margin-top: 2px; }
.mi.danger:hover { background: rgba(194, 90, 77, 0.12); }
.caret { font-style: normal; font-size: 10px; transition: transform 0.15s; }
.caret.on { transform: rotate(90deg); }
.swatch-row { display: flex; gap: 6px; padding: 4px 10px 8px; }
.sw { width: 18px; height: 18px; border-radius: 6px; border: 1px solid rgba(128, 128, 128, 0.35); cursor: pointer; transition: transform 0.12s; }
.sw:hover { transform: scale(1.15); }
.sw.on { box-shadow: 0 0 0 2px var(--accent); }
</style>
