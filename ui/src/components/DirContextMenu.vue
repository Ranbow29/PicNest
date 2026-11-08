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

const FOLDER_COLORS = [
  { key: '', css: '#c9a86c', label: '默认' },
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
  run(() => {
    ask.value = { title: '新建子文件夹', initial: '', run: async (name) => {
      const r = await lib.mkdirIn(rel, name)
      if (r?.ok) lib.patchDirMemory(rel, { expanded: true })
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
  run(() => {
    ask.value = { title: '重命名文件夹', initial: nameOf(rel), selectBase: true, run: (name) => lib.renameDir(rel, name) }
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
  run(async () => {
    lib.scanning = true
    lib.scanNote = '导出中…'
    try {
      const r = await lib.exportDir(rel)
      if (r?.ok) lib.scanNote = `已导出 ${r.count} 张 → ${r.dest}`
      else if (r?.canceled) lib.scanNote = ''
      else lib.scanNote = r?.error || '导出失败'
    } finally {
      lib.scanning = false
      setTimeout(() => { if (!lib.scanning) lib.scanNote = '' }, 4000)
    }
  })
}
function sortLevel(mode) { run(() => lib.sortDir(relOf(menu.value.rel), mode)) }
function sortRecursive(mode) { run(() => lib.sortDirRecursive(relOf(menu.value.rel), mode)) }
function setColor(key) {
  const rel = relOf(menu.value.rel)
  run(() => lib.patchDirMemory(rel, { color: key }))
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
        <button class="mi" @click="newSub">新建子文件夹</button>
        <button v-if="!isLib" class="mi" @click="newSibling">新建文件夹</button>
        <button v-if="!isLib" class="mi" @click="rename">重命名</button>

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

        <div class="mi group" @click.stop="toggle('color')">
          <span>图标颜色</span><i class="caret" :class="{ on: colorOpen }">▸</i>
        </div>
        <div v-if="colorOpen" class="swatch-row" @click.stop>
          <button v-for="c in FOLDER_COLORS" :key="c.key" class="sw"
                  :class="{ on: (lib.dirMemory[menu.rel]?.color || '') === c.key }"
                  :style="{ background: c.css }" :title="c.label || c.key"
                  @click="setColor(c.key)" />
        </div>
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
.caret { font-style: normal; font-size: 10px; transition: transform 0.15s; }
.caret.on { transform: rotate(90deg); }
.swatch-row { display: flex; gap: 6px; padding: 4px 10px 8px; }
.sw { width: 18px; height: 18px; border-radius: 6px; border: 1px solid rgba(128, 128, 128, 0.35); cursor: pointer; transition: transform 0.12s; }
.sw:hover { transform: scale(1.15); }
.sw.on { box-shadow: 0 0 0 2px var(--accent); }
</style>
