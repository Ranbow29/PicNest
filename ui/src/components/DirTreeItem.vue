<script setup>
import { ref, computed, watch } from 'vue'
import { useLibrary, extractDropUrls } from '../stores/library'
import { isExternalDT, dndTypes } from '../lib/dnd'
import AnimIcon from './AnimIcon.vue'
import { folderTint } from '../lib/folderColors'

const props = defineProps({ node: { type: Object, required: true }, depth: { type: Number, default: 0 } })
const emit = defineEmits(['open'])
const lib = useLibrary()
const expanded = ref(false)
const dropMark = ref('') // '' | 'before' | 'after' | 'into'

const rel = computed(() => props.node.rel || '')
const mem = computed(() => lib.dirMemory[rel.value] || {})
const colorKey = computed(() => mem.value.color || '')
const isActive = computed(() => lib.currentDirRel === props.node.rel)

/* 展开态持久化（dirMemory[rel].expanded）；顶层默认展开一次 */
watch(() => props.node, () => {
  if (mem.value.expanded !== undefined) expanded.value = !!mem.value.expanded
}, { immediate: true })
/* 自动展开祖先（从正文子文件夹卡片进入时）需要响应 dirMemory 变化 */
watch(() => mem.value.expanded, (v) => {
  if (v !== undefined) expanded.value = !!v
})

function toggleExpand() {
  expanded.value = !expanded.value
  lib.patchDirMemory(rel.value, { expanded: expanded.value })
}

function onContextMenu(e) {
  /* 根行 = 资料库本身：编辑只在资料库区，文件夹树根行不提供编辑菜单 */
  if (!rel.value) return
  if (!lib.selectedDirs.includes(rel.value)) lib.selectDir(rel.value, {})
  lib.openDirMenu(e, { rel: rel.value, node: props.node })
}
/* 单击=打开并单选；Shift=范围多选（不打开）；Alt/Ctrl=加选/减选（不打开） */
function onClick(e) {
  const add = e.altKey || e.ctrlKey || e.metaKey
  lib.selectDir(rel.value, { shift: e.shiftKey, add })
  if (!e.shiftKey && !add) emit('open', props.node)
}

function dtList(dt, key) {
  try {
    const v = JSON.parse(dt.getData(key) || '[]')
    return Array.isArray(v) ? v.filter(Boolean) : []
  } catch { return [] }
}
function onDragStart(e) {
  const rel = props.node.rel
  const group = (lib.selectedDirs.length > 1 && lib.selectedDirs.includes(rel))
    ? lib.selectedDirs.filter((r) => r !== '')
    : []
  e.dataTransfer.setData('application/x-picnest-dir', rel)
  if (group.length > 1) e.dataTransfer.setData('application/x-picnest-dirs', JSON.stringify(group))
  e.dataTransfer.effectAllowed = 'move'
}
function isInternalImagesDT(e) {
  const t = dndTypes(e)
  return t.includes('application/x-picnest-file') || t.includes('application/x-picnest-files')
}
function onDragOver(e) {
  /* 图片拖入：只认文件夹行、只做“放进文件夹”，不提供上/下缝隙插入，避免手滑进父级/未分类 */
  if (isInternalImagesDT(e)) {
    if (!props.node.rel) { dropMark.value = ''; e.dataTransfer.dropEffect = 'none'; return } // 库根行不接图片
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    dropMark.value = 'into'
    return
  }
  e.preventDefault()
  const external = isExternalDT(e) // 内部拖拽优先：text/uri-list 是浏览器自动附带的，不能当外部文件
  e.dataTransfer.dropEffect = external ? 'copy' : 'move'
  /* 根行不是可排序项：内部文件夹只能“移入库根”，外部文件/文件夹录入库根；
     不允许在根行做 before/after，否则会把根名与同名子文件夹混淆并写坏顶层顺序 */
  if (!props.node.rel) {
    e.stopPropagation()
    dropMark.value = 'into'
    if (external) lib.setDropHint('dir', dragHintLabel('into'), e.clientX, e.clientY)
    return
  }
  const r = e.currentTarget.getBoundingClientRect()
  const y = e.clientY - r.top
  /* 外部拖入与内部文件夹拖动同规则：上/下 30% = 缝隙插入，中间 = 放进该文件夹 */
  dropMark.value = y < r.height * 0.3 ? 'before' : y > r.height * 0.7 ? 'after' : 'into'
  if (external) {
    e.stopPropagation() // 抢占落点：主展示区/侧栏空白不再覆盖
    lib.setDropHint('dir', dragHintLabel(dropMark.value), e.clientX, e.clientY)
  }
}
function onDragLeave() { dropMark.value = '' }

/* 缝隙落点：父级文件夹 + 插入序号（文件夹按此排序；图片落进该层父级） */
function parentRelOf(r) { return r.includes('/') ? r.slice(0, r.lastIndexOf('/')) : '' }
function gapTarget(mark) {
  const parentRel = parentRelOf(props.node.rel)
  const parent = parentRel ? lib.findNode(lib.tree?.tree, parentRel) : lib.tree?.tree
  const siblings = parent?.children || []
  const i = siblings.findIndex((c) => c.name === props.node.name)
  const index = mark === 'before' ? Math.max(0, i) : (i < 0 ? siblings.length : i + 1)
  return { rootId: lib.activeRootId, rel: parentRel, index }
}
function dragHintLabel(mark) {
  if (mark === 'into') return `录入到「${lib.dispName(props.node.name)}」`
  const t = gapTarget(mark)
  const root = lib.roots.find((r) => r.id === lib.activeRootId)
  const base = t.rel ? lib.dispName(t.rel.split('/').pop()) : (root?.display_name || '库根')
  return `插入到「${base}」第 ${t.index + 1} 位`
}
async function onDrop(e) {
  e.stopPropagation()
  lib.clearDropHint()
  const internalImages = isInternalImagesDT(e)
  const mark = internalImages ? 'into' : dropMark.value
  dropMark.value = ''
  if (internalImages && !props.node.rel) return // 库根行不接图片（走侧栏「未分类」入口）
  // 外部拖入（Eagle 式）：文件/文件夹 → 按落点录入
  if (isExternalDT(e)) {
    const paths = [...(e.dataTransfer.files || [])].map((f) => window.picrand.getFilePath?.(f)).filter(Boolean)
    const urls = extractDropUrls(e.dataTransfer)
    const target = (mark === 'before' || mark === 'after')
      ? gapTarget(mark)
      : { rootId: lib.activeRootId, rel: props.node.rel }
    if (paths.length) await lib.importDrop(paths, target)
    else if (urls.length) await lib.importUrls(urls, target)
    return
  }
  const srcDir = e.dataTransfer.getData('application/x-picnest-dir')
  const srcDirs = dtList(e.dataTransfer, 'application/x-picnest-dirs')
  const srcFile = e.dataTransfer.getData('application/x-picnest-file')
  const srcFiles = dtList(e.dataTransfer, 'application/x-picnest-files')
  if (srcDirs.length || srcDir) {
    await lib.dropOnDirs(srcDirs.length ? srcDirs : [srcDir], props.node.rel, mark || 'into')
  } else if (srcFiles.length || srcFile) {
    const destRel = (mark === 'before' || mark === 'after') ? parentRelOf(props.node.rel) : props.node.rel
    await lib.moveImages(srcFiles.length ? srcFiles : [srcFile], destRel)
  }
}
</script>

<template>
  <div class="dir-item">
    <div
      class="row" :class="{ active: isActive, into: dropMark === 'into', selected: lib.selectedDirs.includes(rel) }"
      :style="{ paddingLeft: 6 + depth * 13 + 'px' }"
      :draggable="!!node.rel"
      @click="onClick" @dblclick="toggleExpand"
      @dragstart="onDragStart" @dragover="onDragOver" @dragleave="onDragLeave" @drop.prevent="onDrop"
      @contextmenu.prevent="onContextMenu"
    >
      <!-- 嵌套参考线：每层一条竖线，落在该层缩进位 -->
      <i v-for="g in depth" :key="g" class="guide" :style="{ left: 13 + (g - 1) * 13 + 'px' }" />
      <i v-if="dropMark === 'before'" class="drop-line top" />
      <i v-if="dropMark === 'after'" class="drop-line bottom" />
      <span class="caret" :class="{ open: expanded, leaf: !node.children?.length }" @click.stop="toggleExpand">▸</span>
      <AnimIcon name="folder" :size="17" :open="expanded" :tint="folderTint(colorKey)" :mount-shake="false" :stroke="1.6" :active="isActive" />
      <span class="name" :title="lib.dispName(node.name)">{{ lib.dispName(node.name) }}</span>
      <span class="count">{{ node.total }}</span>
    </div>
    <template v-if="expanded">
      <DirTreeItem v-for="c in node.children" :key="c.rel" :node="c" :depth="depth + 1" @open="$emit('open', $event)" />
    </template>
  </div>
</template>

<style scoped>
.row {
  position: relative;
  display: flex; align-items: center; gap: 5px;
  height: 26px; margin: 0 4px 0 6px; padding-right: 6px;
  border-radius: 7px; cursor: default; transition: background 0.15s, color 0.15s;
}
.row:hover { background: var(--accent-weak); }
.row:hover .count { opacity: 1; }
.row.active {
  background: var(--accent-weak);
  background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 20%, transparent), var(--accent-weak) 70%);
  font-weight: 600;
  box-shadow: inset 0 0 0 1px var(--accent-weak);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 26%, transparent);
}
.row.active::after {
  content: ''; position: absolute; left: 0; top: 6px; bottom: 6px;
  width: 3px; border-radius: 0 3px 3px 0; background: var(--accent); pointer-events: none;
}
.row.active .name { color: var(--accent); }
.row.active .count { color: var(--accent); opacity: 1; }
.row.active :deep(.folder-ico) { filter: drop-shadow(0 0 3px var(--accent-weak)); }
.row.selected { background: var(--accent-weak); }
.row.selected::before {
  content: ''; position: absolute; left: -1px; top: 5px; bottom: 5px;
  width: 2.5px; border-radius: 2px; background: var(--accent); pointer-events: none;
}
.row.into { background: var(--accent-weak); outline: 1.5px dashed var(--accent); outline-offset: -2px; }
.guide {
  position: absolute; top: -13px; bottom: -13px; width: 1px;
  background: var(--border); pointer-events: none;
}
.drop-line {
  position: absolute; left: 4px; right: 4px; height: 2px;
  background: var(--accent); border-radius: 1px; pointer-events: none; z-index: 2;
}
.drop-line.top { top: -1px; }
.drop-line.bottom { bottom: -1px; }
.caret {
  position: relative; z-index: 1;
  width: 13px; flex: none; text-align: center; color: var(--text-2);
  font-size: 10px; transition: transform 0.18s; cursor: pointer;
  background: transparent;
}
.caret.open { transform: rotate(90deg); }
.caret.leaf { visibility: hidden; }
.name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
.count { flex: none; font-size: 10.5px; color: var(--text-2); font-variant-numeric: tabular-nums; opacity: 0.72; transition: opacity 0.15s; }
</style>
