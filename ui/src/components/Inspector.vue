<script setup>
import { computed, ref, watch, nextTick } from 'vue'
import { useLibrary } from '../stores/library'
import { fileUrl } from '../api'

// 右侧详情浮窗（Eagle 式：可编辑名/注释/URL/文件夹；删除只在右键菜单，防单点误触）
const lib = useLibrary()
const img = computed(() => lib.selected)

const fmtSize = (n) => {
  if (!n) return '—'
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
const extOf = (p) => (p ? (p.split('.').pop() || '').toUpperCase() : '')

/* 名称编辑（Eagle F2 式：点击变输入框，Enter/失焦提交） */
const editingName = ref(false)
const nameDraft = ref('')
const nameInput = ref(null)
watch(() => lib.selectedPath, () => { editingName.value = false })
watch(() => lib.renaming, (v) => { if (v) startEdit() })
function startEdit() {
  if (!img.value) return
  nameDraft.value = img.value.file_name.replace(/\.[^.]+$/, '')
  editingName.value = true
  lib.renaming = false
  nextTick(() => { nameInput.value?.focus(); nameInput.value?.select() })
}
async function commitName() {
  if (!editingName.value || !img.value) return
  editingName.value = false
  const old = img.value.file_path
  if (nameDraft.value.trim() && nameDraft.value !== img.value.file_name.replace(/\.[^.]+$/, '')) {
    await lib.renameImage(old, nameDraft.value.trim())
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
})
let saveTimer = null
function queueSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    if (img.value && loadedFor.value === img.value.file_path) {
      lib.saveMeta(img.value.file_path, { annotation: meta.value.annotation, url: meta.value.url })
    }
  }, 600)
}

/* 色板 */
const palette = ref([])
const paletteLoading = ref(false)
watch(() => lib.selectedPath, async (p) => {
  palette.value = []
  if (!p) return
  // 优先读颜色筛选的索引缓存（零延迟），没有才现算；两路统一映射成 {color, ratio}
  // （此前缓存路径是 {r,g,b,percent} 裸形状，模板读 .color 直接炸 → 点色板筛选全灭）
  if (lib.palettes[p]) {
    palette.value = lib.palettes[p].slice(0, 9).map((c) => c.color
      ? { color: c.color, ratio: c.ratio }
      : { color: [c.r, c.g, c.b], ratio: c.percent })
    paletteLoading.value = false
    return
  }
  paletteLoading.value = true
  try {
    const r = await window.picrand.computeColorAnalysis(p)
    const dom = r?.dominantColors || []
    palette.value = dom.slice(0, 9).map((c) => ({ color: [c.r, c.g, c.b], ratio: c.percent }))
  } catch { palette.value = [] } finally { paletteLoading.value = false }
})

const sections = ref({ info: true, palette: true, rating: true, folder: true, locate: true })
const toggle = (k) => { sections.value[k] = !sections.value[k] }

/* 点色板 = 以此色筛选（来自图自身色板 → 精确匹配分支必命中本图，吸色场景正解） */
function filterByPaletteColor(color) {
  const c = lib.filters.color
  const rgb = [...color]
  if (c.value && c.value.join() === rgb.join()) {
    c.value = null; c.on = false // 再点一次取消
  } else {
    c.value = rgb; c.on = true; c.gray = false
  }
  lib.layoutTick++
}

/* 文件夹移动（真物理移动） */
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

const folderName = computed(() => {
  if (!lib.currentDirRel) return lib.tree?.tree?.name || ''
  return lib.currentDirRel.split('/').pop()
})
async function copyPath() {
  if (!img.value) return
  try { await navigator.clipboard.writeText(img.value.file_path) } catch { /* 静默 */ }
}
async function copyFile() {
  if (!img.value) return
  try { await window.picrand.copyFilesToClipboard?.([img.value.file_path]) } catch { /* 静默 */ }
}
</script>

<template>
  <aside class="inspector">
    <template v-if="img">
      <div class="preview">
        <img :src="fileUrl(img.file_path)" loading="lazy" draggable="false" />
      </div>

      <!-- 可编辑名称：单击进入输入框（等价 Eagle F2/重命名） -->
      <input
        v-if="editingName" ref="nameInput" v-model="nameDraft"
        class="name-input" @keyup.enter="commitName" @blur="commitName" @keyup.esc="editingName = false"
      />
      <div v-else class="name" title="点击重命名" @click="startEdit">{{ img.file_name }}</div>

      <input class="line-input" placeholder="添加注释" v-model="meta.annotation" @input="queueSave" />
      <input class="line-input" placeholder="http://" v-model="meta.url" @input="queueSave" />

      <div class="sec">
        <div class="sec-head" @click="toggle('info')"><span>基本信息</span><i>{{ sections.info ? '▾' : '▸' }}</i></div>
        <div v-show="sections.info" class="sec-body">
          <div class="kv"><span>尺寸</span><b>{{ img.width || '—' }} × {{ img.height || '—' }}</b></div>
          <div class="kv"><span>文件大小</span><b>{{ fmtSize(img.file_size) }}</b></div>
          <div class="kv"><span>格式</span><b>{{ extOf(img.file_path) }}</b></div>
          <div class="kv"><span>修改日期</span><b>{{ fmtDate(img.modify_time) }}</b></div>
        </div>
      </div>

      <div class="sec">
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
        <div class="sec-head" @click="toggle('folder')"><span>文件夹</span><i>{{ sections.folder ? '▾' : '▸' }}</i></div>
        <div v-show="sections.folder" class="sec-body">
          <div class="folder-row">
            <span class="folder-chip">{{ folderName }}</span>
            <button class="move-btn" @click="moveOpen = !moveOpen">{{ moveOpen ? '收起' : '移动到…' }}</button>
          </div>
          <select v-if="moveOpen" class="move-select" @change="doMove($event)">
            <option value="" disabled selected>选择目标文件夹…</option>
            <option value="">（库根目录）</option>
            <option v-for="d in lib.flatDirs()" :key="d.rel" :value="d.rel">{{ '　'.repeat(d.depth) + d.name }}（{{ d.total }}）</option>
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

    <div v-else class="empty-tip">点选一张图查看详情</div>
  </aside>
</template>

<style scoped>
.inspector {
  width: var(--insp-w, 296px); flex: none; margin: 46px 8px 8px 0; /* 46px = 让出玻璃顶栏 */
  background: var(--panel-inspector); border: 1px solid var(--border);
  border-radius: var(--radius); box-shadow: var(--shadow);
  overflow-y: auto; overflow-x: hidden;
  animation: slide-in 0.22s ease;
}
@keyframes slide-in { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
/* 隐藏右侧长滚动条（保留滚动能力） */
.inspector { scrollbar-width: none; }
.inspector::-webkit-scrollbar { display: none; }

.preview { margin: 10px; border-radius: 10px; overflow: hidden; background: var(--bg-2); border: 1px solid var(--border); }
.preview img { display: block; width: 100%; max-height: 240px; object-fit: contain; }

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
}
.folder-row { display: flex; align-items: center; gap: 8px; }
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
.move-note { margin-top: 6px; font-size: 11px; color: var(--accent); }
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
</style>
