<script setup>
import { computed, ref, watch, nextTick } from 'vue'
import { useLibrary } from '../stores/library'
import { fileUrl } from '../api'
import { isTextPath, isVideoPath } from '../lib/fileKinds'

// 右侧详情浮窗（Eagle 式）：图片单选 / 图片多选 / 文件夹单选 / 文件夹多选 四态
const lib = useLibrary()
const img = computed(() => lib.selected)

/* ---------- 选择模式 ---------- */
const dirNodes = computed(() => (lib.selectedDirs || [])
  .map((rel) => ({ rel, node: rel ? lib.findNode(lib.tree?.tree, rel) : lib.tree?.tree }))
  .filter((d) => d.node))
const mode = computed(() => {
  /* 图片选中优先于文件夹（多选合并视图里点图 → 图详情；清空图选 → 回到文件夹详情） */
  if (lib.selectedPaths.length > 1) return 'multi'
  if (img.value) return 'img'
  if (dirNodes.value.length) return dirNodes.value.length > 1 ? 'dirs' : 'dir'
  return 'empty'
})
const singleDir = computed(() => (dirNodes.value.length === 1 ? dirNodes.value[0] : null))
const isTextImg = computed(() => !!img.value && isTextPath(img.value.file_path))
const isVideoImg = computed(() => !!img.value && isVideoPath(img.value.file_path))

const fmtSize = (n) => {
  if (!n) return '—'
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB'
  if (n > 1048576) return (n / 1048576).toFixed(2) + ' MB'
  if (n > 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}
const fmtDate = (ms) => {
  if (!ms) return '—'
  const d = new Date(ms > 1e12 ? ms : ms * 1000)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const fmtFolderDate = (ms) => fmtDate(ms)
const extLabel = (p) => (p ? (p.split('.').pop() || '').toUpperCase() : '')
const fullSrc = (im) => fileUrl(im.file_path) + '?v=' + (im.modify_time || 0)
const thumbSrc = (im) => {
  const ver = im.modify_time || 0
  if (im.thumbnail_path && im.thumbnail_path !== 'SKIP') {
    return fileUrl(im.thumbnail_path) + '?v=' + ver
  }
  if (isTextPath(im.file_path) || isVideoPath(im.file_path)) return '' // 文本/视频无缩略图时不直链
  return fileUrl(im.file_path) + '?v=' + ver
}

/* ---------- 单选图片 ---------- */
const editingName = ref(false)
const nameDraft = ref('')
const nameInput = ref(null)
watch(() => lib.selectedPath, () => { editingName.value = false })
watch(() => lib.renaming, (v) => { if (v) startEdit() })
function startEdit() {
  if (!img.value) return
  nameDraft.value = lib.dispName(img.value.file_name).replace(/\.[^.]+$/, '')
  editingName.value = true
  lib.renaming = false
  nextTick(() => { nameInput.value?.focus(); nameInput.value?.select() })
}
async function commitName() {
  if (!editingName.value || !img.value) return
  editingName.value = false
  const old = img.value.file_path
  const orig = img.value.file_name
  const displayStem = lib.dispName(orig).replace(/\.[^.]+$/, '')
  if (nameDraft.value.trim() && nameDraft.value !== displayStem) {
    /* 显示层可能隐藏了 01_ 前缀，改名时把前缀原样接回去，避免一次重命名打乱物理排序 */
    await lib.renameImage(old, lib.renameTarget(orig, nameDraft.value.trim()))
  }
}

/* 注释 / URL（Eagle 式输入框，防抖保存） */
const meta = ref({ annotation: '', url: '' })
const loadedFor = ref('')
watch(() => lib.selectedPath, async (p) => {
  meta.value = { annotation: '', url: '' }
  loadedFor.value = p || ''
  if (!p) return
  try { meta.value = await window.picrand.picnestGetImageMeta(p) } catch { /* 静默 */ }
}, { immediate: true })
let saveTimer = null
function queueSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    if (img.value && loadedFor.value === img.value.file_path) {
      lib.saveMeta(img.value.file_path, { annotation: meta.value.annotation, url: meta.value.url })
    }
  }, 600)
}

/* 色板：灯箱里的详情是另一个 Inspector 实例（新挂载）→ 必须 immediate 才能拿到当前选中项；
   缓存里的空数组（ensurePalettes 对 SKIP/失败项标的）不能当作“已有色板”，否则永远显示 — */
const palette = ref([])
const paletteLoading = ref(false)
/* 预览图加载兜底：原图失败→缩略图；缩略图也失败→后缀占位（大图 PNG 偶发解码失败） */
const previewFallback = ref(false)
const previewDead = ref(false)
function onPreviewError() {
  const im = img.value
  if (!previewFallback.value && im?.thumbnail_path && im.thumbnail_path !== 'SKIP') {
    previewFallback.value = true
    return
  }
  previewDead.value = true
}
watch(() => lib.selectedPath, () => { previewFallback.value = false; previewDead.value = false })
watch(() => lib.selectedPath, async (p) => {
  palette.value = []
  if (!p) return
  if (isTextPath(p)) { paletteLoading.value = false; return } // 文本无色板，不白跑 IPC
  const cached = lib.palettes[p]
  if (Array.isArray(cached) && cached.length) {
    palette.value = cached.slice(0, 9).map((c) => c.color
      ? { color: c.color, ratio: c.ratio }
      : { color: [c.r, c.g, c.b], ratio: c.percent })
    paletteLoading.value = false
    return
  }
  paletteLoading.value = true
  try {
    const r = await window.picrand.computeColorAnalysis(p)
    const dom = r?.dominantColors || []
    /* 回写 store：详情现算的色板也要进索引，否则点这里色板做「精确命中保原图」时查不到自己 */
    if (dom.length) lib.palettes[p] = dom.map((c) => ({ r: c.r, g: c.g, b: c.b, percent: c.percent }))
    palette.value = dom.slice(0, 9).map((c) => ({ color: [c.r, c.g, c.b], ratio: c.percent }))
  } catch { palette.value = [] } finally { paletteLoading.value = false }
}, { immediate: true })

const sections = ref({ info: true, palette: true, rating: true, tags: true, folder: true, locate: true })
const toggle = (k) => { sections.value[k] = !sections.value[k] }

/* 点色板 = 以此色筛选 */
function filterByPaletteColor(color) {
  const c = lib.filters.color
  const rgb = [...color]
  if (c.value && c.value.join() === rgb.join()) {
    c.value = null; c.on = false
  } else {
    c.value = rgb; c.on = true; c.gray = false
  }
  lib.layoutTick++
}

/* 文件夹移动（单选） */
const moveOpen = ref(false)
const moveNote = ref('')
const moveNoteErr = ref(false)
watch(() => lib.selectedPath, () => { moveOpen.value = false; moveNote.value = '' })
async function doMove(e) {
  const rel = e.target.value
  if (!img.value) return
  const r = await lib.moveImage(img.value.file_path, rel)
  moveNote.value = r?.ok ? '已移动 ✓' : (r?.error || '移动失败')
  moveNoteErr.value = !r?.ok
  if (r?.ok) setTimeout(() => { moveNote.value = '' }, 2000)
}

/* 图片真实所在目录（相对库根）：递归浏览/合并视图里 currentDirRel 是视图位置，不是图片所在夹 */
function relOfImage(filePath) {
  const root = String(lib.tree?.rootPath || '').replace(/[\\/]+$/, '')
  const p = String(filePath || '').replace(/\//g, '\\')
  if (!root || !p.toLowerCase().startsWith((root + '\\').toLowerCase())) return null
  const rest = p.slice(root.length).replace(/^[\\/]+/, '')
  const idx = rest.lastIndexOf('\\')
  return idx > 0 ? rest.slice(0, idx).split('\\').join('/') : ''
}
const folderName = computed(() => {
  const rel = img.value ? relOfImage(img.value.file_path) : null
  if (rel === null) return lib.dispName(lib.tree?.tree?.name || '')
  return rel ? lib.dispName(rel.split('/').pop()) : lib.dispName(lib.tree?.tree?.name || '库根')
})
async function copyPath() {
  if (!img.value) return
  try { await navigator.clipboard.writeText(img.value.file_path) } catch { /* 静默 */ }
}
async function copyFile() {
  if (!img.value) return
  try { await window.picrand.copyFilesToClipboard?.([img.value.file_path]) } catch { /* 静默 */ }
}

/* ---------- 多选图片 ---------- */
const multiImages = computed(() => {
  const map = new Map(lib.images.map((i) => [i.file_path, i]))
  return lib.selectedPaths.map((p) => map.get(p)).filter(Boolean)
})
const stackImgs = computed(() => multiImages.value.slice(-4))
function stackStyle(i) {
  const n = stackImgs.value.length
  const off = i - (n - 1) / 2
  return {
    transform: `translate(-50%, -50%) translateX(${off * 24}px) rotate(${off * 6}deg)`,
    zIndex: i + 1,
  }
}
const multiSize = computed(() => multiImages.value.reduce((s, i) => s + (i.file_size || 0), 0))
const multiFormats = computed(() => {
  const set = new Set(multiImages.value.map((i) => extLabel(i.file_path)))
  return set.size === 1 ? [...set][0] : '混合'
})
const multiRating = computed(() => {
  const rs = multiImages.value.map((i) => i.rating || 0)
  return rs.length && rs.every((r) => r === rs[0]) ? rs[0] : -1
})
/* 所选图片所在文件夹（去重；同样按 file_path 反推，不跟视图位置） */
const multiFolders = computed(() => {
  const map = new Map()
  for (const im of multiImages.value) {
    const rel = relOfImage(im.file_path) || ''
    map.set(rel, rel ? rel.split('/').pop() : (lib.tree?.tree?.name || '库根'))
  }
  return [...map.entries()].map(([rel, name]) => ({ rel, name: lib.dispName(name) }))
})

/* ---------- 标签 ---------- */
const tagById = computed(() => new Map(lib.tags.map((t) => [t.id, t])))
const imageTagList = computed(() => (lib.imageTags[img.value?.id] || [])
  .map((id) => tagById.value.get(id)).filter(Boolean))
const multiCommonTags = computed(() => {
  const ids = multiImages.value.map((i) => i.id)
  if (!ids.length) return []
  const common = new Set(lib.imageTags[ids[0]] || [])
  for (const id of ids.slice(1)) {
    const cur = new Set(lib.imageTags[id] || [])
    for (const t of [...common]) if (!cur.has(t)) common.delete(t)
  }
  return [...common].map((id) => tagById.value.get(id)).filter(Boolean)
})
const tagDraft = ref('')
function tagTargetIds() {
  if (mode.value === 'multi') return multiImages.value.map((i) => i.id)
  if (mode.value === 'img' && img.value) return [img.value.id]
  return []
}
async function addCurrentTag() {
  const name = tagDraft.value.trim()
  const ids = tagTargetIds()
  if (!name || !ids.length) return
  const r = await lib.addTagToImages(ids, name)
  if (r?.ok) tagDraft.value = ''
}
async function removeCurrentTag(tag) {
  const ids = tagTargetIds()
  if (!ids.length || !tag?.id) return
  await lib.removeTagFromImages(ids, tag.id)
}
watch(() => lib.selectedPath, () => { tagDraft.value = '' })
const multiMeta = ref({ annotation: '', url: '' })
const multiNote = ref('')
watch(() => lib.selectedPaths.join('|'), () => {
  multiMeta.value = { annotation: '', url: '' }
  multiNote.value = ''
  moveOpen.value = false
  moveNote.value = ''
})
async function applyMultiMeta(field) {
  const val = String(multiMeta.value[field] || '').trim()
  if (!val || !multiImages.value.length) return
  const n = multiImages.value.length
  for (const im of multiImages.value) await lib.saveMeta(im.file_path, { [field]: val })
  multiMeta.value[field] = ''
  multiNote.value = `已应用到 ${n} 个文件`
  setTimeout(() => { if (multiNote.value === `已应用到 ${n} 个文件`) multiNote.value = '' }, 2400)
}
async function rateMulti(s) {
  const target = multiRating.value === s ? 0 : s
  await Promise.all(multiImages.value.map((im) => lib.rate(im.file_path, target)))
  multiNote.value = target ? `已设为 ${target} 星` : '已清除评分'
  setTimeout(() => { multiNote.value = '' }, 2000)
}
async function doMultiMove(e) {
  const rel = e.target.value
  const paths = multiImages.value.map((i) => i.file_path)
  if (!paths.length) return
  const r = await lib.moveImages(paths, rel)
  multiNote.value = `已移动 ${r?.moved || 0}${r?.failed ? ` · 失败 ${r.failed}` : ''}`
  setTimeout(() => { multiNote.value = '' }, 2600)
}
async function copyMultiFiles() {
  if (!multiImages.value.length) return
  try { await window.picrand.copyFilesToClipboard?.(multiImages.value.map((i) => i.file_path)) } catch { /* 静默 */ }
}
async function copyMultiPaths() {
  if (!multiImages.value.length) return
  try { await navigator.clipboard.writeText(multiImages.value.map((i) => i.file_path).join('\n')) } catch { /* 静默 */ }
}

/* ---------- 文件夹单选/多选 ---------- */
const folderStats = ref({ loading: false, count: 0, size: 0, createdAt: 0, error: '' })
watch(
  () => (dirNodes.value.length ? `${mode.value}|${dirNodes.value.map((d) => d.rel).join('|')}|${lib.activeRootId}` : ''),
  async () => {
    if (!dirNodes.value.length) return
    folderStats.value = { ...folderStats.value, loading: true, error: '' }
    const rels = dirNodes.value.map((d) => d.rel)
    const r = await lib.dirStats(rels)
    if (r?.ok) folderStats.value = { loading: false, count: r.count, size: r.size, createdAt: r.createdAt || 0, error: '' }
    else folderStats.value = { loading: false, count: 0, size: 0, createdAt: 0, error: r?.error || '统计失败' }
  },
  { immediate: true }
)

const folderNameDraft = ref('')
const nameDirRel = ref('')
watch(singleDir, (d) => {
  nameDirRel.value = d?.rel || ''
  folderNameDraft.value = lib.dispName(d?.node?.name || '')
}, { immediate: true })
async function commitFolderName() {
  const rel = nameDirRel.value
  if (!rel) return
  const node = lib.findNode(lib.tree?.tree, rel)
  const oldName = node?.name || ''
  const oldDisplay = lib.dispName(oldName)
  const name = folderNameDraft.value.trim()
  if (!name || name === oldDisplay) { folderNameDraft.value = oldDisplay; return }
  /* 显示层隐藏的 01_ 前缀要接回去，改名不打乱物理文件夹顺序 */
  const target = lib.renameTarget(oldName, name)
  const r = await lib.renameDir(rel, target)
  if (r?.ok) {
    nameDirRel.value = r.rel
    folderNameDraft.value = lib.dispName(r.name)
  } else {
    folderNameDraft.value = oldDisplay
    lib.error = r?.error || '重命名失败'
  }
}
function resetFolderName() { folderNameDraft.value = lib.dispName(singleDir.value?.node?.name || '') }

const dirDesc = ref('')
let descTimer = null
watch(() => (singleDir.value ? singleDir.value.rel : null), (rel) => {
  clearTimeout(descTimer)
  dirDesc.value = rel == null ? '' : (lib.dirMemory[rel]?.desc || '')
}, { immediate: true })
function queueDirDesc() {
  clearTimeout(descTimer)
  const rel = singleDir.value?.rel
  if (rel == null) return
  descTimer = setTimeout(() => {
    if (singleDir.value?.rel === rel) lib.patchDirMemory(rel, { desc: dirDesc.value })
  }, 600)
}

const exportNote = ref('')
async function exportFolder() {
  if (!singleDir.value) return
  const r = await lib.exportDir(singleDir.value.rel)
  if (r?.ok) {
    exportNote.value = `已导出 ${r.count} 个文件`
    setTimeout(() => { exportNote.value = '' }, 2600)
  } else if (!r?.canceled) {
    exportNote.value = r?.error || '导出失败'
  }
}
</script>

<template>
  <aside class="inspector">
    <!-- ========== 单选图片 ========== -->
    <template v-if="mode === 'img' && img">
      <div class="preview">
        <img v-if="!previewDead && !isTextImg && !isVideoImg" :src="previewFallback ? thumbSrc(img) : fullSrc(img)"
             :class="{ gray: lib.grayscaleMode }" loading="lazy" decoding="async" draggable="false" @error="onPreviewError" />
        <img v-else-if="!previewDead && img.thumbnail_path && img.thumbnail_path !== 'SKIP'" :src="thumbSrc(img)"
             :class="{ gray: lib.grayscaleMode }" loading="lazy" decoding="async" draggable="false" @error="onPreviewError" />
        <div v-else class="preview-doc">{{ previewDead ? '无法预览' : extLabel(img.file_path) }}</div>
      </div>

      <input
        v-if="editingName" ref="nameInput" v-model="nameDraft"
        class="name-input" @keyup.enter="commitName" @blur="commitName" @keyup.esc="editingName = false"
      />
      <div v-else class="name" title="点击重命名" @click="startEdit">{{ lib.dispName(img.file_name) }}</div>

      <input class="line-input" placeholder="添加注释" v-model="meta.annotation" @input="queueSave" />

      <div class="sec">
        <div class="sec-head" @click="toggle('info')"><span>基本信息</span><i>{{ sections.info ? '▾' : '▸' }}</i></div>
        <div v-show="sections.info" class="sec-body">
          <div class="kv"><span>尺寸</span><b>{{ isTextImg ? '文本' : (img.width || '—') + ' × ' + (img.height || '—') }}</b></div>
          <div class="kv"><span>文件大小</span><b>{{ fmtSize(img.file_size) }}</b></div>
          <div class="kv"><span>格式</span><b>{{ extLabel(img.file_path) }}</b></div>
          <div class="kv"><span>修改日期</span><b>{{ fmtDate(img.modify_time) }}</b></div>
        </div>
      </div>

      <div class="sec" v-if="!isTextImg && !isVideoImg">
        <div class="sec-head" @click="toggle('palette')"><span>色板</span><i>{{ sections.palette ? '▾' : '▸' }}</i></div>
        <div v-show="sections.palette" class="sec-body">
          <div v-if="paletteLoading" class="muted">分析中…</div>
          <div v-else-if="palette.length" class="swatches">
            <i v-for="(c, i) in palette" :key="i"
               :class="{ on: lib.filters.color.value && lib.filters.color.value.join() === c.color.join() }"
               :style="{ background: `rgb(${c.color?.[0] ?? 128},${c.color?.[1] ?? 128},${c.color?.[2] ?? 128})` }"
               :title="(c.ratio != null ? c.ratio + '% · ' : '') + '点击筛选此色'" @click="filterByPaletteColor(c.color)" />
          </div>
          <div v-else class="muted">—</div>
        </div>
      </div>

      <div class="sec">
        <div class="sec-head" @click="toggle('rating')"><span>评分</span><i>{{ sections.rating ? '▾' : '▸' }}</i></div>
        <div v-show="sections.rating" class="sec-body">
          <div class="stars">
            <i v-for="s in 5" :key="s" class="star" :class="{ on: (img.rating || 0) >= s }" @click="lib.rate(img.file_path, (img.rating || 0) === s ? 0 : s)">★</i>
          </div>
        </div>
      </div>

      <div class="sec">
        <div class="sec-head" @click="toggle('tags')"><span>标签</span><i>{{ sections.tags ? '▾' : '▸' }}</i></div>
        <div v-show="sections.tags" class="sec-body">
          <div class="tag-list">
            <span v-for="t in imageTagList" :key="t.id" class="tag-chip">
              <span class="tag-name">{{ t.name }}</span><button class="tag-x" title="移除标签" @click.stop="removeCurrentTag(t)">×</button>
            </span>
            <span v-if="!imageTagList.length" class="muted">暂无标签</span>
          </div>
          <div class="tag-add">
            <input v-model="tagDraft" list="picnest-tag-suggestions" maxlength="60" placeholder="添加标签，回车确认" @keydown.enter.prevent="addCurrentTag" />
            <button :disabled="!tagDraft.trim()" @click="addCurrentTag">＋</button>
          </div>
          <datalist id="picnest-tag-suggestions">
            <option v-for="t in lib.tags" :key="t.id" :value="t.name" />
          </datalist>
        </div>
      </div>

      <div class="sec">
        <div class="sec-head" @click="toggle('folder')"><span>文件夹</span><i>{{ sections.folder ? '▾' : '▸' }}</i></div>
        <div v-show="sections.folder" class="sec-body">
          <div class="folder-row">
            <span class="folder-chip">{{ folderName }}</span>
            <button class="move-btn" @click="moveOpen = !moveOpen">{{ moveOpen ? '收起' : '移动到…' }}</button>
          </div>
          <select v-if="moveOpen" class="move-select" @change="doMove($event)">
            <option value="" disabled selected>选择目标文件夹…</option>
            <option value="">（库根目录）</option>
            <option v-for="d in lib.flatDirs()" :key="d.rel" :value="d.rel">{{ '　'.repeat(d.depth) + lib.dispName(d.name) }}（{{ d.total }}）</option>
          </select>
          <div v-if="moveNote" class="move-note" :class="{ err: moveNoteErr }">{{ moveNote }}</div>
        </div>
      </div>

      <div class="sec">
        <div class="sec-head" @click="toggle('locate')"><span>操作</span><i>{{ sections.locate ? '▾' : '▸' }}</i></div>
        <div v-show="sections.locate" class="sec-body">
          <div class="actions">
            <button @click="startEdit">重命名（F2）</button>
            <button @click="lib.reveal(img.file_path)">在资源管理器中显示</button>
            <button @click="copyFile">复制文件</button>
            <button @click="copyPath">复制路径</button>
          </div>
          <div class="del-note">删除请右键图片 → 删除（防误触）</div>
        </div>
      </div>
    </template>

    <!-- ========== 多选图片 ========== -->
    <template v-else-if="mode === 'multi'">
      <div class="stack">
        <div v-for="(im, i) in stackImgs" :key="im.file_path" class="stack-card" :style="stackStyle(i)">
          <img v-if="thumbSrc(im)" :src="thumbSrc(im)" :class="{ gray: lib.grayscaleMode }" draggable="false" />
          <div v-else class="stack-doc">{{ extLabel(im.file_path) }}</div>
        </div>
      </div>
      <div class="multi-count">已选 {{ multiImages.length }} 个文件</div>

      <input class="line-input" placeholder="添加注释（应用到全部）" v-model="multiMeta.annotation"
             @keyup.enter="applyMultiMeta('annotation')" @blur="applyMultiMeta('annotation')" />
      <div v-if="multiNote" class="move-note">{{ multiNote }}</div>

      <div class="sec">
        <div class="sec-head" @click="toggle('info')"><span>基本信息</span><i>{{ sections.info ? '▾' : '▸' }}</i></div>
        <div v-show="sections.info" class="sec-body">
          <div class="kv"><span>文件数</span><b>{{ multiImages.length }}</b></div>
          <div class="kv"><span>文件大小</span><b>{{ fmtSize(multiSize) }}</b></div>
          <div class="kv"><span>格式</span><b>{{ multiFormats }}</b></div>
        </div>
      </div>

      <div class="sec">
        <div class="sec-head" @click="toggle('rating')"><span>评分</span><i>{{ sections.rating ? '▾' : '▸' }}</i></div>
        <div v-show="sections.rating" class="sec-body">
          <div class="stars">
            <i v-for="s in 5" :key="s" class="star" :class="{ on: multiRating >= s }" @click="rateMulti(s)">★</i>
          </div>
          <div v-if="multiRating < 0" class="muted">多个评分</div>
        </div>
      </div>

      <div class="sec">
        <div class="sec-head" @click="toggle('tags')"><span>标签</span><i>{{ sections.tags ? '▾' : '▸' }}</i></div>
        <div v-show="sections.tags" class="sec-body">
          <div class="tag-list">
            <span v-for="t in multiCommonTags" :key="t.id" class="tag-chip">
              <span class="tag-name">{{ t.name }}</span><button class="tag-x" title="从全部移除" @click.stop="removeCurrentTag(t)">×</button>
            </span>
            <span v-if="!multiCommonTags.length" class="muted">无共同标签</span>
          </div>
          <div class="tag-add">
            <input v-model="tagDraft" list="picnest-tag-suggestions" maxlength="60" placeholder="给全部添加标签…" @keydown.enter.prevent="addCurrentTag" />
            <button :disabled="!tagDraft.trim()" @click="addCurrentTag">＋</button>
          </div>
          <datalist id="picnest-tag-suggestions">
            <option v-for="t in lib.tags" :key="t.id" :value="t.name" />
          </datalist>
        </div>
      </div>

      <div class="sec">
        <div class="sec-head" @click="toggle('folder')"><span>文件夹</span><i>{{ sections.folder ? '▾' : '▸' }}</i></div>
        <div v-show="sections.folder" class="sec-body">
          <div class="folder-row wrap">
            <span v-for="f in multiFolders" :key="f.rel" class="folder-chip" :title="f.rel || '库根'">{{ f.name }}</span>
            <button class="move-btn" @click="moveOpen = !moveOpen">{{ moveOpen ? '收起' : '移动到…' }}</button>
          </div>
          <select v-if="moveOpen" class="move-select" @change="doMultiMove($event)">
            <option value="" disabled selected>全部移到目标文件夹…</option>
            <option value="">（库根目录）</option>
            <option v-for="d in lib.flatDirs()" :key="d.rel" :value="d.rel">{{ '　'.repeat(d.depth) + lib.dispName(d.name) }}（{{ d.total }}）</option>
          </select>
        </div>
      </div>

      <div class="sec">
        <div class="sec-head" @click="toggle('locate')"><span>操作</span><i>{{ sections.locate ? '▾' : '▸' }}</i></div>
        <div v-show="sections.locate" class="sec-body">
          <div class="actions">
            <button @click="copyMultiFiles">复制 {{ multiImages.length }} 个文件</button>
            <button @click="copyMultiPaths">复制全部路径</button>
          </div>
          <div class="del-note">删除请右键图片 → 删除（防误触）</div>
        </div>
      </div>
    </template>

    <!-- ========== 文件夹（单选 / 多选） ========== -->
    <template v-else-if="mode === 'dir' || mode === 'dirs'">
      <template v-if="mode === 'dir' && singleDir">
        <input v-if="singleDir.rel" class="line-input folder-name" v-model="folderNameDraft"
               @keyup.enter="commitFolderName" @blur="commitFolderName" @keyup.esc="resetFolderName" />
        <div v-else class="folder-title">{{ lib.dispName(singleDir.node.name) }}</div>
        <div v-if="!singleDir.rel" class="folder-note">根目录（编辑请在根文件区）</div>
        <textarea v-if="singleDir.rel" class="line-input desc" placeholder="描述" v-model="dirDesc" @input="queueDirDesc"></textarea>
      </template>
      <template v-else>
        <div class="folder-title">多个标题</div>
        <div class="multi-count">已选 {{ dirNodes.length }} 个文件夹</div>
      </template>

      <div class="sec">
        <div class="sec-head" @click="toggle('info')"><span>基本信息</span><i>{{ sections.info ? '▾' : '▸' }}</i></div>
        <div v-show="sections.info" class="sec-body">
          <div class="kv"><span>文件数</span><b>{{ folderStats.loading ? '…' : folderStats.count }}</b></div>
          <div class="kv"><span>占用空间</span><b>{{ folderStats.loading ? '…' : fmtSize(folderStats.size) }}</b></div>
          <div v-if="mode === 'dir'" class="kv"><span>添加日期</span><b>{{ folderStats.loading ? '…' : fmtFolderDate(folderStats.createdAt) }}</b></div>
          <div v-if="folderStats.error" class="muted">{{ folderStats.error }}</div>
        </div>
      </div>

      <div v-if="mode === 'dir'" class="sec">
        <div class="sec-head" @click="toggle('locate')"><span>操作</span><i>{{ sections.locate ? '▾' : '▸' }}</i></div>
        <div v-show="sections.locate" class="sec-body">
          <div class="actions">
            <button @click="exportFolder">导出文件夹（含子文件夹）</button>
          </div>
          <div v-if="exportNote" class="move-note">{{ exportNote }}</div>
        </div>
      </div>
    </template>

    <div v-else class="empty-tip">点选图片或文件夹查看详情</div>
  </aside>
</template>

<style scoped>
.inspector {
  width: var(--insp-w, 296px); flex: none; margin: 46px 10px 10px 0; /* 46px = 让出玻璃顶栏 */
  background: linear-gradient(180deg, var(--panel-insp-top) 0%, var(--panel-insp-mid) 46%, var(--panel-insp-low) 74%, var(--panel-insp-bot) 100%);
  backdrop-filter: blur(22px) saturate(1.12);
  -webkit-backdrop-filter: blur(22px) saturate(1.12);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-float), inset 0 1px 0 var(--panel-edge); /* 悬浮于正文之上 */
  overflow-y: auto; overflow-x: hidden;
  animation: slide-in 0.22s ease;
}
@keyframes slide-in { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
.inspector { scrollbar-width: none; }
.inspector::-webkit-scrollbar { display: none; }

.preview { margin: 10px; border-radius: 10px; overflow: hidden; background: var(--bg-2); border: 1px solid var(--border); }
.preview img { display: block; width: 100%; max-height: 240px; object-fit: contain; }
.preview img.gray, .stack-card img.gray { filter: grayscale(1); }
.preview-doc {
  height: 170px; display: flex; align-items: center; justify-content: center;
  background: linear-gradient(160deg, #f7f3ea 0%, #eee7d9 100%);
  color: #6b604f; font-family: Consolas, monospace; font-size: 13px; letter-spacing: 1px;
}

.name { padding: 0 12px 10px; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: text; }
.name:hover { color: var(--accent); }
.name-input {
  margin: 0 10px 10px; width: calc(100% - 20px);
  border: 1px solid var(--accent); border-radius: 8px;
  background: var(--bg-2); color: var(--text);
  font-size: 13px; font-weight: 600; padding: 7px 9px; outline: none;
}
.line-input {
  display: block; margin: 0 10px 8px; width: calc(100% - 20px);
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg-2); color: var(--text);
  font-size: 12px; padding: 7px 9px; outline: none;
  transition: border-color .15s;
}
.line-input:focus { border-color: var(--accent); }
.line-input::placeholder { color: var(--text-2); }

.tag-list { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-height: 22px; }
.tag-chip {
  display: inline-flex; align-items: center; gap: 2px; max-width: 100%;
  padding: 3px 4px 3px 9px; border-radius: 999px;
  background: var(--accent-weak); color: var(--accent); font-size: 11.5px; line-height: 1.4;
}
.tag-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag-x {
  flex: none; border: none; background: transparent; color: inherit; opacity: 0.65;
  font-size: 13px; line-height: 1; padding: 0 3px; cursor: pointer;
}
.tag-x:hover { opacity: 1; }
.tag-add { display: flex; gap: 6px; margin-top: 8px; }
.tag-add input {
  flex: 1; min-width: 0; height: 28px; padding: 0 8px; outline: none;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg-2); color: var(--text); font-size: 12px;
}
.tag-add input:focus { border-color: var(--accent); }
.tag-add button {
  flex: none; width: 28px; height: 28px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg-2); color: var(--text-2); cursor: pointer; font-size: 14px;
}
.tag-add button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.tag-add button:disabled { opacity: 0.4; cursor: default; }

.sec { border-top: 1px solid var(--border); }
.sec-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 9px 12px; font-size: 12px; color: var(--text-2); cursor: pointer; letter-spacing: 1px;
}
.sec-head:hover { color: var(--text); }
.sec-head i { font-style: normal; font-size: 10px; }
.sec-body { padding: 2px 12px 10px; }
.kv { display: flex; justify-content: space-between; padding: 3px 0; font-size: 12px; }
.kv span { color: var(--text-2); }
.kv b { font-weight: 500; font-variant-numeric: tabular-nums; }

.folder-chip {
  display: inline-block; padding: 4px 10px; border-radius: 8px;
  background: var(--accent-weak); color: var(--accent); font-size: 12px;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.folder-row { display: flex; align-items: center; gap: 8px; }
.folder-row.wrap { flex-wrap: wrap; }
.move-btn {
  border: 1px solid var(--border); background: transparent; color: var(--text-2);
  padding: 4px 8px; border-radius: 8px; font-size: 11px; cursor: pointer;
  transition: background .15s, color .15s;
}
.move-btn:hover { background: var(--accent-weak); color: var(--accent); }
.move-select {
  margin-top: 8px; width: 100%;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg-2); color: var(--text); font-size: 12px; padding: 6px; outline: none;
}
.move-note { margin: 6px 10px; font-size: 11px; color: var(--accent); }
.move-note.err { color: #d24b4b; }

.swatches { display: flex; gap: 4px; }
.swatches i { flex: 1; height: 22px; border-radius: 5px; border: 1px solid var(--border); cursor: pointer; transition: transform 0.12s; }
.swatches i:hover { transform: translateY(-2px); border-color: var(--accent); }
.swatches i.on { border-color: #fff; box-shadow: 0 0 0 1.5px var(--accent); }

.stars { display: flex; gap: 4px; font-size: 19px; line-height: 1; }
.star { color: var(--border); cursor: pointer; transition: color .12s, transform .12s; }
.star:hover { transform: scale(1.15); }
.star.on { color: var(--accent); }

.actions { display: flex; flex-direction: column; gap: 6px; }
.actions button {
  border: 1px solid var(--border); background: transparent; color: var(--text);
  padding: 7px 10px; border-radius: 8px; font-size: 12px; text-align: left; cursor: pointer;
  transition: background .15s, border-color .15s;
}
.actions button:hover { background: var(--accent-weak); border-color: var(--accent); }
.del-note { margin-top: 8px; font-size: 11px; color: var(--text-2); opacity: .8; }
.muted { color: var(--text-2); font-size: 12px; }
.empty-tip { padding: 40px 16px; text-align: center; color: var(--text-2); font-size: 12px; }

/* ---- 多选图片：扇形堆叠预览 ---- */
.stack { position: relative; height: 148px; margin: 14px 10px 0; }
.stack-card {
  position: absolute; left: 50%; top: 50%;
  width: 52%; height: 100%;
  border-radius: 10px; overflow: hidden;
  border: 1px solid var(--border); background: var(--bg-2);
  box-shadow: var(--shadow);
}
.stack-card img { display: block; width: 100%; height: 100%; object-fit: cover; }
.stack-doc {
  width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
  background: linear-gradient(160deg, #f7f3ea, #eee7d9); color: #6b604f;
  font-family: Consolas, monospace; font-size: 11px; letter-spacing: 1px;
}
.multi-count { padding: 11px 12px 12px; text-align: center; font-size: 13px; font-weight: 600; }

/* ---- 文件夹详情 ---- */
.folder-title { padding: 14px 12px 10px; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.folder-name { margin: 12px 10px 8px; font-weight: 600; }
.folder-note { padding: 0 12px 8px; font-size: 11px; color: var(--text-2); }
.desc { min-height: 64px; resize: vertical; font-family: inherit; line-height: 1.5; margin-bottom: 10px; }
</style>
