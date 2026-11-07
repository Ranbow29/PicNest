<script setup>
import { ref, computed } from 'vue'
import { useLibrary, extractDropUrls } from '../stores/library'

const props = defineProps({ node: { type: Object, required: true }, depth: { type: Number, default: 0 } })
defineEmits(['open'])
const lib = useLibrary()
const expanded = ref(false)
const dropMark = ref('') // '' | 'before' | 'after' | 'into'

const isActive = computed(() => lib.currentDirRel === props.node.rel)

function onDragStart(e) {
  e.dataTransfer.setData('application/x-picnest-dir', props.node.rel)
  e.dataTransfer.effectAllowed = 'move'
}
function onDragOver(e) {
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  const r = e.currentTarget.getBoundingClientRect()
  const y = e.clientY - r.top
  const types = [...(e.dataTransfer?.types || [])]
  dropMark.value = types.includes('Files') || types.includes('text/uri-list')
    ? 'into' // 外部拖入：整行都是目标
    : y < r.height * 0.3 ? 'before' : y > r.height * 0.7 ? 'after' : 'into'
}
function onDragLeave() { dropMark.value = '' }
async function onDrop(e) {
  e.stopPropagation()
  const mark = dropMark.value
  dropMark.value = ''
  const types = [...(e.dataTransfer?.types || [])]
  // 外部拖入（Eagle 式）：文件/浏览器图片 → 录进这个文件夹
  if (types.includes('Files') || types.includes('text/uri-list')) {
    const paths = [...(e.dataTransfer.files || [])].map((f) => window.picrand.getFilePath?.(f)).filter(Boolean)
    const urls = extractDropUrls(e.dataTransfer)
    if (paths.length) await lib.importDrop(paths, props.node.rel)
    else if (urls.length) await lib.importUrls(urls, props.node.rel)
    return
  }
  const srcDir = e.dataTransfer.getData('application/x-picnest-dir')
  const srcFile = e.dataTransfer.getData('application/x-picnest-file')
  if (srcDir) {
    if ((props.node.rel + '/').startsWith(srcDir + '/')) return // 不能丢进自己的后代
    await lib.dropOnDir(srcDir, props.node.rel, mark || 'into')
  } else if (srcFile) {
    await lib.moveImage(srcFile, props.node.rel)
  }
}
</script>

<template>
  <div class="dir-item">
    <div
      class="row" :class="{ active: isActive, into: dropMark === 'into' }"
      :style="{ paddingLeft: 6 + depth * 13 + 'px' }"
      draggable="true"
      @click="$emit('open', node)" @dblclick="expanded = !expanded"
      @dragstart="onDragStart" @dragover="onDragOver" @dragleave="onDragLeave" @drop.prevent="onDrop"
    >
      <!-- 嵌套参考线：每层一条竖线，落在该层缩进位 -->
      <i v-for="g in depth" :key="g" class="guide" :style="{ left: 13 + (g - 1) * 13 + 'px' }" />
      <i v-if="dropMark === 'before'" class="drop-line top" />
      <i v-if="dropMark === 'after'" class="drop-line bottom" />
      <span class="caret" :class="{ open: expanded, leaf: !node.children?.length }" @click.stop="expanded = !expanded">▸</span>
      <span class="icon">▾</span>
      <span class="name" :title="node.name">{{ node.name }}</span>
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
  height: 26px; margin: 0 6px; padding-right: 8px;
  border-radius: 7px; cursor: default; transition: background 0.15s;
}
.row:hover { background: var(--accent-weak); }
.row.active {
  background: var(--accent-weak); font-weight: 600;
}
.row.active .name { color: var(--accent); }
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
.icon { flex: none; font-size: 10px; color: var(--accent); }
.name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
.count { flex: none; font-size: 10.5px; color: var(--text-2); font-variant-numeric: tabular-nums; }
</style>
