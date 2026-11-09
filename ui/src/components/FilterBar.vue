<script setup>
import { computed, ref } from 'vue'
import { useLibrary } from '../stores/library'
import ColorPicker from './ColorPicker.vue'
import NamePromptDialog from './NamePromptDialog.vue'

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

function toggleIn(list, v) {
  const i = list.indexOf(v)
  if (i >= 0) list.splice(i, 1)
  else list.push(v)
}
function toggleShape(k) { toggleIn(f.value.shapes, k); lib.layoutTick++ }
function toggleRating(v) { toggleIn(f.value.ratings, v); lib.layoutTick++ }
function toggleTag(id) { toggleIn(f.value.tags, id); lib.layoutTick++ }
function toggleFormat(e, ex) {
  if (ex) toggleIn(f.value.formatEx, e)
  else toggleIn(f.value.formats, e)
  lib.layoutTick++
}
const tagManage = ref(false)
const tagsShown = computed(() => (tagManage.value ? lib.tags : lib.tags.filter((t) => t.count > 0)))
const tagRename = ref({ open: false, id: 0, name: '' })
const tagNote = ref('')
function startTagRename(t) {
  tagNote.value = ''
  tagRename.value = { open: true, id: t.id, name: t.name }
}
async function confirmTagRename(name) {
  const r = await lib.renameTag(tagRename.value.id, name)
  if (r?.ok) {
    tagRename.value.open = false
    tagNote.value = ''
  } else tagNote.value = r?.error || '重命名失败'
}
async function deleteTag(t) {
  const ok = await lib.askConfirm({
    title: `删除标签「${t.name}」？`,
    message: '会从所有图片移除此标签，图片文件不会动。',
    confirmText: '删除标签',
    danger: true,
  })
  if (!ok) return
  const r = await lib.deleteTag(t.id)
  tagNote.value = r?.ok ? '' : (r?.error || '删除失败')
  if (r?.ok) f.value.tags = f.value.tags.filter((id) => id !== t.id)
}

/* 颜色：色板真值取自 Eagle app.asar filter-item-color.html（12 预设 + none/gray + 自定义） */
const colorState = computed(() => f.value.color)
const EAGLE_PRESETS = ['#111111', '#FFFFFF', '#9E9E9E', '#A48057', '#FC85B3', '#FF2727', '#FFA34B', '#FFD534', '#47C595', '#51C4C4', '#2B76E7', '#6D50ED']
const hexText = computed(() => {
  if (!colorState.value.value) return '#000000'
  return '#' + colorState.value.value.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()
})
const hexInput = ref('')
function hexToRgb(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '')
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function pickHex(hex) {
  const rgb = hexToRgb(hex)
  if (!rgb) return
  colorState.value.value = rgb
  colorState.value.on = true
  lib.ensurePalettes().catch(() => {}) // 新入库/刚切换视图时兜底补齐，否则颜色筛选恒 0
  lib.layoutTick++
}
function pickPreset(hex) { pickHex(hex) }
function toggleGray() {
  colorState.value.gray = !colorState.value.gray
  if (colorState.value.gray) lib.ensurePalettes().catch(() => {})
  lib.layoutTick++
}
function clearColor() {
  colorState.value.on = false
  colorState.value.gray = false
  colorState.value.value = null
  hexInput.value = ''
  lib.layoutTick++
}
function onHexEnter() {
  if (hexInput.value) pickHex(hexInput.value.trim())
}
function clearSection(kind) {
  if (kind === 'shape') f.value.shapes = []
  if (kind === 'rating') f.value.ratings = []
  if (kind === 'tag') f.value.tags = []
  if (kind === 'format') { f.value.formats = []; f.value.formatEx = [] }
  lib.layoutTick++
}
</script>

<template>
  <div class="fpanel glass-card" @click.stop>
    <!-- 颜色 -->
    <div class="fsec wi" style="--d: 0ms">
      <div class="fsec-head"><i class="eyebrow">COLORS</i><span>颜色</span>
        <button v-if="colorState.on || colorState.gray" class="clear" @click="clearColor">清除</button>
      </div>
      <ColorPicker :model-value="colorState.value ? hexText : '#ffffff'" @update:model-value="pickHex" />
      <div class="color-row">
        <!-- Eagle 布局：无色（清除，斜杠）→ 灰度（纹理）→ 12 预设色 -->
        <button class="sw none" :class="{ on: !colorState.gray && !colorState.value }" title="无色（清除颜色筛选）" @click="clearColor"><i /></button>
        <button class="sw gray" :class="{ on: colorState.gray }" title="灰度（黑白）" @click="toggleGray" />
        <button v-for="hex in EAGLE_PRESETS" :key="hex" class="sw"
                :class="{ on: colorState.value && !colorState.gray && hexText === hex.toUpperCase() }"
                :style="{ background: hex }" :title="hex" @click="pickPreset(hex)" />
      </div>
      <div class="custom-row">
        <i class="cur-chip" :style="{ background: colorState.value ? hexText : '#ccc' }"></i>
        <input class="hex-in" v-model="hexInput" placeholder="#FF0000" spellcheck="false" maxlength="7"
               @keydown.enter="onHexEnter" @change="onHexEnter" />
      </div>
      <div class="acc-row">
        <span>准确度:</span>
        <input type="range" min="5" max="40" step="1" :value="colorState.accuracy ?? 20" @input="colorState.accuracy = Number($event.target.value); lib.layoutTick++" />
      </div>
    </div>

    <!-- 形状 -->
    <div class="fsec wi" style="--d: 80ms">
      <div class="fsec-head"><i class="eyebrow">SHAPE</i><span>形状</span>
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
    <div class="fsec wi" style="--d: 160ms">
      <div class="fsec-head"><i class="eyebrow">RATING</i><span>评分</span>
        <button v-if="f.ratings.length" class="clear" @click="clearSection('rating')">清除</button>
      </div>
      <div class="chips">
        <button v-for="d in ratingDefs" :key="d.v" class="chip" :class="{ on: f.ratings.includes(d.v) }" @click="toggleRating(d.v)">
          {{ d.label }}<em>{{ ratingCount(d.v) }}</em>
        </button>
      </div>
    </div>

    <!-- 标签 -->
    <div class="fsec wi" style="--d: 200ms">
      <div class="fsec-head"><i class="eyebrow">TAGS</i><span>标签</span>
        <button v-if="f.tags.length" class="clear" @click="clearSection('tag')">清除</button>
        <button v-if="lib.tags.length" class="clear" @click="tagManage = !tagManage">{{ tagManage ? '完成' : '管理' }}</button>
      </div>
      <div class="chips">
        <template v-for="t in tagsShown" :key="t.id">
          <button v-if="!tagManage" class="chip" :class="{ on: f.tags.includes(t.id) }" @click="toggleTag(t.id)">
            {{ t.name }}<em>{{ t.count }}</em>
          </button>
          <span v-else class="tag-admin">
            <button class="tag-admin-name" title="重命名标签" @click="startTagRename(t)">{{ t.name }}</button>
            <button class="tag-admin-del" title="删除标签" @click="deleteTag(t)">×</button>
          </span>
        </template>
        <span v-if="!tagsShown.length" class="tag-empty">暂无标签</span>
      </div>
      <div v-if="tagManage && tagsShown.length" class="hint-row">点标签改名 · × 删除标签</div>
      <div v-else-if="tagsShown.length" class="hint-row">多选为「任一标签」</div>
      <div v-if="tagNote" class="tag-note">{{ tagNote }}</div>
    </div>

    <!-- 格式 -->
    <div class="fsec wi" style="--d: 240ms">
      <div class="fsec-head"><i class="eyebrow">FORMAT</i><span>格式</span>
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

    <NamePromptDialog
      :visible="tagRename.open" title="重命名标签" :initial="tagRename.name"
      @confirm="confirmTagRename" @cancel="tagRename.open = false" />
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
.fsec-head { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--text-2); letter-spacing: 1px; padding-bottom: 6px; }
.fsec-head .eyebrow {
  font-style: normal; font-size: 9px; letter-spacing: 2px; color: var(--accent);
  opacity: 0.75; font-family: Consolas, monospace; padding-top: 1px;
}
.clear { border: none; background: transparent; color: var(--accent); font-size: 11px; cursor: pointer; }
.clear:hover { text-decoration: underline; }

.color-row { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin-bottom: 8px; }
/* Eagle 规格：20px 圆角 5 灰边框；选中白描边；none 斜杠、gray 底纹 */
.sw { position: relative; width: 20px; height: 20px; border-radius: 5px; border: 1px solid rgba(128, 128, 128, 0.3); cursor: pointer; transition: transform 0.12s, opacity 0.15s; opacity: 0.85; overflow: hidden; }
.sw:hover { transform: scale(1.12); opacity: 1; }
.sw.on { opacity: 1; border-color: #fff; box-shadow: 0 0 0 1.5px var(--accent); }
.sw.none { background: #ccc; }
.sw.none i { position: absolute; top: 50%; left: -4px; right: -4px; height: 1.5px; background: #6a6a6a; transform: rotate(-45deg); }
.sw.gray { background: repeating-linear-gradient(45deg, #ddd 0 3px, #888 3px 6px); }
.hex { font-family: Consolas, monospace; color: var(--text); font-weight: 600; }
.custom-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.cur-chip { width: 22px; height: 22px; border-radius: 6px; border: 1px solid var(--border); flex: none; }
.hex-in {
  flex: 1; height: 26px; padding: 0 8px; font-family: Consolas, monospace; font-size: 12px;
  border: 1px solid var(--border); border-radius: 7px; background: var(--bg-2); color: var(--text); outline: none;
}
.hex-in:focus { border-color: var(--accent); }
.acc-row { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--text-2); padding-bottom: 8px; }
.acc-row input { flex: 1; accent-color: var(--accent); }

.chips { display: flex; flex-wrap: wrap; gap: 8px; }
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
.tag-empty { font-size: 11.5px; color: var(--text-2); padding: 3px 0; }
.tag-admin {
  display: inline-flex; align-items: center; overflow: hidden;
  border: 1px solid var(--border); border-radius: 999px; background: var(--bg-2);
}
.tag-admin-name {
  border: none; background: transparent; color: var(--text); cursor: pointer;
  font-size: 11px; padding: 4px 3px 4px 9px;
}
.tag-admin-name:hover { color: var(--accent); }
.tag-admin-del {
  border: none; background: transparent; color: var(--text-2); cursor: pointer;
  font-size: 12px; line-height: 1; padding: 4px 8px 4px 2px;
}
.tag-admin-del:hover { color: #b4463b; }
.tag-note { padding-top: 4px; font-size: 10.5px; color: #b4463b; }
</style>
