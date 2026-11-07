<script setup>
import { computed, ref } from 'vue'
import { useLibrary } from '../stores/library'

// Eagle 式筛选面板：全部能力内联平铺（挂在漏斗按钮下，与 ▦ 分布面板互斥）
const lib = useLibrary()
const f = computed(() => lib.filters)

const shapeDefs = [
  { key: 'landscape', label: '横图' },
  { key: 'portrait', label: '竖图' },
  { key: 'square', label: '方形' },
  { key: 'panoramaL', label: '细长横图' },
  { key: 'panoramaP', label: '细长竖图' },
  { key: '43', label: '4:3' },
  { key: '34', label: '3:4' },
  { key: '169', label: '16:9' },
  { key: '916', label: '9:16' },
]
function shapeCount(key) {
  return lib.images.filter((i) => {
    const w = i.width || 0, h = i.height || 0
    if (!w || !h) return false
    switch (key) {
      case 'landscape': return w > h
      case 'portrait': return h > w
      case 'square': return w === h
      case 'panoramaL': return w > h && w / h >= 2.5
      case 'panoramaP': return h > w && h / w >= 2.5
      case '43': return w / h === 4 / 3
      case '34': return w / h === 3 / 4
      case '169': return w / h === 16 / 9
      case '916': return w / h === 9 / 16
      default: return false
    }
  }).length
}
const ratingDefs = [
  { v: 0, label: '尚未评分' },
  { v: 1, label: '★' }, { v: 2, label: '★★' }, { v: 3, label: '★★★' }, { v: 4, label: '★★★★' }, { v: 5, label: '★★★★★' },
]
function ratingCount(v) { return lib.images.filter((i) => (i.rating || 0) === v).length }
const formatDefs = computed(() => {
  const map = new Map()
  for (const i of lib.images) {
    const e = (i.file_name.split('.').pop() || '').toLowerCase()
    map.set(e, (map.get(e) || 0) + 1)
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1])
})
const formatSearch = ref('')
const formatDefsShown = computed(() => formatDefs.value.filter(([e]) => !formatSearch.value || e.includes(formatSearch.value.toLowerCase())))
const folderDefs = computed(() => lib.flatDirs().map((d) => ({ ...d, count: d.total })))

function toggleIn(list, v) {
  const i = list.indexOf(v)
  if (i >= 0) list.splice(i, 1)
  else list.push(v)
}
function toggleShape(k) { toggleIn(f.value.shapes, k); lib.layoutTick++ }
function toggleRating(v) { toggleIn(f.value.ratings, v); lib.layoutTick++ }
function toggleFormat(e, ex) {
  if (ex) toggleIn(f.value.formatEx, e)
  else toggleIn(f.value.formats, e)
  lib.layoutTick++
}
function toggleFolder(rel) { toggleIn(f.value.folders, rel); lib.layoutTick++ }

/* 颜色：预设 + 灰度 + 准确度 */
const colorState = computed(() => f.value.color)
const GRAY_PRESETS = [
  [236, 236, 236], [198, 198, 198], [140, 140, 140], [86, 86, 86], [26, 26, 26],
]
const COLOR_PRESETS = [
  [235, 87, 87], [242, 153, 74], [246, 214, 78], [109, 191, 144], [84, 158, 235],
  [104, 109, 224], [155, 81, 224], [88, 178, 193], [214, 129, 168], [141, 104, 66],
]
const hexText = computed(() => {
  if (!colorState.value.value) return '#000000'
  return '#' + colorState.value.value.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()
})
function pickPreset(v) {
  colorState.value.value = v
  colorState.value.on = true
  lib.layoutTick++
}
function toggleGray() {
  colorState.value.gray = !colorState.value.gray
  lib.layoutTick++
}
function clearColor() {
  colorState.value.on = false
  colorState.value.gray = false
  colorState.value.value = null
  lib.layoutTick++
}
function clearSection(kind) {
  if (kind === 'shape') f.value.shapes = []
  if (kind === 'rating') f.value.ratings = []
  if (kind === 'format') { f.value.formats = []; f.value.formatEx = [] }
  if (kind === 'folders') f.value.folders = []
  lib.layoutTick++
}
</script>

<template>
  <div class="fpanel glass-card" @click.stop>
    <!-- 颜色 -->
    <div class="fsec">
      <div class="fsec-head">
        <span>颜色</span>
        <button v-if="colorState.on || colorState.gray" class="clear" @click="clearColor">清除</button>
      </div>
      <div class="color-row">
        <button class="sw gray" :class="{ on: colorState.gray }" title="灰度（黑白）" @click="toggleGray">∅</button>
        <button v-for="(p, i) in GRAY_PRESETS" :key="'g' + i" class="sw"
                :class="{ on: colorState.value && !colorState.gray && colorState.value.join() === p.join() }"
                :style="{ background: `rgb(${p.join(',')})` }" @click="pickPreset(p)" />
        <i class="sep" />
        <button v-for="(c, i) in COLOR_PRESETS" :key="'c' + i" class="sw"
                :class="{ on: colorState.value && colorState.value.join() === c.join() }"
                :style="{ background: `rgb(${c.join(',')})` }" @click="pickPreset(c)" />
      </div>
      <div class="acc-row">
        <span>准确度</span>
        <input type="range" min="3" max="60" :value="colorState.accuracy" @input="colorState.accuracy = Number($event.target.value); lib.layoutTick++" />
        <b class="hex">{{ hexText }}</b>
      </div>
    </div>

    <!-- 形状 -->
    <div class="fsec">
      <div class="fsec-head">
        <span>形状</span>
        <button v-if="f.shapes.length" class="clear" @click="clearSection('shape')">清除</button>
      </div>
      <div class="chips">
        <button v-for="d in shapeDefs" :key="d.key" class="chip" :class="{ on: f.shapes.includes(d.key) }" @click="toggleShape(d.key)">
          {{ d.label }}<em>{{ shapeCount(d.key) }}</em>
        </button>
        <button class="chip" :class="{ on: f.shapes.includes('custom') }" @click="toggleShape('custom')">
          自定
          <input class="num" type="number" min="1" v-model.number="f.customW" @click.stop @change="lib.layoutTick++" /> :
          <input class="num" type="number" min="1" v-model.number="f.customH" @click.stop @change="lib.layoutTick++" />
        </button>
      </div>
    </div>

    <!-- 评分 -->
    <div class="fsec">
      <div class="fsec-head">
        <span>评分</span>
        <button v-if="f.ratings.length" class="clear" @click="clearSection('rating')">清除</button>
      </div>
      <div class="chips">
        <button v-for="d in ratingDefs" :key="d.v" class="chip" :class="{ on: f.ratings.includes(d.v) }" @click="toggleRating(d.v)">
          {{ d.label }}<em>{{ ratingCount(d.v) }}</em>
        </button>
      </div>
    </div>

    <!-- 格式 -->
    <div class="fsec">
      <div class="fsec-head">
        <span>格式</span>
        <button v-if="f.formats.length || f.formatEx.length" class="clear" @click="clearSection('format')">清除</button>
      </div>
      <div class="fmt-search">⌕ <input v-model="formatSearch" placeholder="搜索..." spellcheck="false" /></div>
      <div class="fmt-list">
        <button v-for="[e, n] in formatDefsShown" :key="e" class="fmt" :class="{ on: f.formats.includes(e), ex: f.formatEx.includes(e) }"
                @click="toggleFormat(e, false)" @contextmenu.prevent="toggleFormat(e, true)">
          <span class="mono">{{ e }}</span><em>{{ n }}</em><i v-if="f.formatEx.includes(e)" class="ex-mark">排除</i>
        </button>
        <div class="hint-row">选择 <b>左键</b> · 排除 <b>右键</b></div>
      </div>
    </div>

    <!-- 文件夹 -->
    <div class="fsec">
      <div class="fsec-head">
        <span>文件夹</span>
        <button v-if="f.folders.length" class="clear" @click="clearSection('folders')">清除</button>
      </div>
      <div class="fmt-list">
        <button v-for="d in folderDefs" :key="d.rel" class="fmt" :class="{ on: f.folders.includes(d.rel) }" @click="toggleFolder(d.rel)">
          <span>{{ '　'.repeat(d.depth) + d.name }}</span><em>{{ d.count }}</em>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fpanel {
  width: 320px; max-height: 66vh; overflow-y: auto;
  padding: 4px 14px 12px; border-radius: 16px; background: var(--panel); backdrop-filter: blur(var(--blur)) saturate(1.2); box-shadow: 0 18px 50px rgba(0, 0, 0, 0.28);
  scrollbar-width: none;
}
.fpanel::-webkit-scrollbar { display: none; }
.fsec { padding: 8px 0 4px; border-bottom: 1px solid var(--border); }
.fsec:last-child { border-bottom: none; }
.fsec-head { display: flex; align-items: center; justify-content: space-between; font-size: 11.5px; color: var(--text-2); letter-spacing: 1px; padding-bottom: 6px; }
.clear { border: none; background: transparent; color: var(--accent); font-size: 11px; cursor: pointer; }
.clear:hover { text-decoration: underline; }

.color-row { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin-bottom: 8px; }
.sw { width: 22px; height: 22px; border-radius: 6px; border: 1px solid var(--border); cursor: pointer; transition: transform 0.12s; }
.sw:hover { transform: scale(1.12); }
.sw.on { outline: 2px solid var(--accent); outline-offset: 1px; }
.sw.gray { color: var(--text-2); font-size: 11px; background: var(--bg-2); }
.sep { width: 1px; height: 18px; background: var(--border); margin: 0 2px; }
.acc-row { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--text-2); }
.acc-row input { flex: 1; accent-color: var(--accent); }
.hex { font-family: Consolas, monospace; color: var(--text); font-weight: 600; }

.chips { display: flex; flex-wrap: wrap; gap: 5px; }
.chip {
  display: inline-flex; align-items: center; gap: 5px;
  border: 1px solid var(--border); background: transparent; color: var(--text-2);
  padding: 5px 12px; border-radius: 999px; font-size: 12px; cursor: pointer;
  transition: all 0.15s;
}
.chip:hover { border-color: var(--accent); color: var(--text); }
.chip.on { background: var(--accent-weak); border-color: var(--accent); color: var(--accent); font-weight: 600; }
.chip em { font-style: normal; font-size: 10.5px; opacity: 0.75; font-variant-numeric: tabular-nums; }
.chip .num { width: 40px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg-2); color: var(--text); padding: 1px 4px; font-size: 11px; }

.fmt-search { display: flex; align-items: center; gap: 6px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2); padding: 4px 8px; margin-bottom: 6px; font-size: 12px; color: var(--text-2); }
.fmt-search input { flex: 1; border: none; background: transparent; outline: none; color: var(--text); font-size: 12px; }
.fmt-list { max-height: 150px; overflow-y: auto; scrollbar-width: none; }
.fmt-list::-webkit-scrollbar { display: none; }
.fmt {
  display: flex; align-items: center; gap: 8px; width: 100%;
  border: none; background: transparent; color: var(--text);
  padding: 5px 8px; border-radius: 7px; font-size: 12px; cursor: pointer; text-align: left;
  transition: background 0.12s;
}
.fmt:hover { background: var(--accent-weak); }
.fmt.on { color: var(--accent); font-weight: 600; }
.fmt.ex { color: #d24b4b; text-decoration: line-through; }
.fmt span { flex: 1; }
.fmt em { font-style: normal; color: var(--text-2); font-size: 11px; font-variant-numeric: tabular-nums; }
.mono { font-family: Consolas, monospace; }
.ex-mark { font-style: normal; font-size: 10px; color: #d24b4b; border: 1px solid #d24b4b; border-radius: 4px; padding: 0 3px; }
.hint-row { padding: 6px 8px 0; font-size: 11px; color: var(--text-2); }
.hint-row b { color: var(--text); }
</style>
