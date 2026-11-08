<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useLibrary } from '../stores/library'
import { api, fileUrl } from '../api'
import { startWindowDrag } from '../lib/winDrag'
import { waveSeq, waveDelay, replayWave } from '../lib/wave'
import FolderIcon from './FolderIcon.vue'

const lib = useLibrary()
const showLabels = computed(() => lib.hoverLabels !== false)

/* Wenku8 式全体动效：视图/排序/筛选/内容更新 → 首屏入场波重放（防抖合并连续变更） */
let waveTimer = null
watch(
  () => [lib.view, lib.currentDirRel, lib.sortMode, lib.sortAsc, lib.layout, lib.activeRootId, lib.images.length, JSON.stringify(lib.filters)],
  () => {
    clearTimeout(waveTimer)
    waveTimer = setTimeout(replayWave, 120)
  },
)


/* ---------- 视口与虚拟滚动 ---------- */
const viewport = ref(null)
const viewW = ref(0)
const viewH = ref(0)
const scrollTop = ref(0)
let ro = null, rafPending = false

onMounted(() => {
  ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      viewW.value = e.contentRect.width - RULER_W // 右缘留出概览滑尺
      viewH.value = e.contentRect.height
    }
  })
  if (viewport.value) {
    ro.observe(viewport.value)
    viewport.value.addEventListener('scroll', onScroll, { passive: true })
  }
})
onBeforeUnmount(() => {
  ro?.disconnect()
  viewport.value?.removeEventListener('scroll', onScroll)
})

function onScroll() {
  if (rafPending) return
  rafPending = true
  requestAnimationFrame(() => {
    scrollTop.value = viewport.value?.scrollTop || 0
    rafPending = false
  })
}


/* 图片拖拽 → 丢到侧栏文件夹 = 移动文件 */
function onViewportWheel(e) {
  if (!e.ctrlKey) return // 普通滚动交给原生
  e.preventDefault()
  const k = e.deltaY < 0 ? 1.08 : 1 / 1.08
  lib.zoom = Math.min(3.2, Math.max(0.6, lib.zoom * k))
}

function onCellDragStart(e, img) {
  const group = (lib.selectedPaths.length > 1 && lib.selectedPaths.includes(img.file_path))
    ? lib.selectedPaths.slice()
    : []
  e.dataTransfer.setData('application/x-picnest-file', img.file_path)
  if (group.length > 1) e.dataTransfer.setData('application/x-picnest-files', JSON.stringify(group))
  e.dataTransfer.effectAllowed = 'move'
}

/* ---------- 排列方式（Eagle 式）：名称/添加/修改/大小/尺寸/评分/随机 ---------- */
const sortedImages = computed(() => {
  const arr = [...lib.filteredImages]
  const mode = lib.sortMode, asc = lib.sortAsc ? 1 : -1
  if (mode === 'random') {
    let seed = lib.randomNonce * 9301 + 49297
    const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280 }
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1));[arr[i], arr[j]] = [arr[j], arr[i]] }
    return arr
  }
  const key = (a) => {
    switch (mode) {
      case 'added': return a.id || 0
      case 'mtime': return a.modify_time || 0
      case 'size': return a.file_size || 0
      case 'dims': return (a.width || 0) * (a.height || 0)
      case 'rating': return a.rating || 0
      default: return null
    }
  }
  if (mode === 'name') arr.sort((a, b) => asc * String(a.file_name).localeCompare(String(b.file_name), 'zh', { numeric: true }))
  else arr.sort((a, b) => asc * ((key(a) || 0) - (key(b) || 0)))
  return arr
})

/* ---------- 布局引擎：grid（等格）/ justified（自适应行高） ---------- */
const GAP = 14
const HEADER_H = 150 // 编辑排印头块实际高度：56 玻璃让位 + 标题 38 + 小标 14 + 间距 + 规则线（不足会压线）
const SUBFOLDER_STRIP_H = 172 // 文件夹视图顶部的子文件夹卡片条

/* 当前文件夹的直属子文件夹（Eagle 式卡片条；合并视图/非文件夹视图不显示） */
const currentFolderNode = computed(() => (lib.view === 'all' && lib.currentDirRel && !lib.selectionView
  ? lib.findNode(lib.tree?.tree, lib.currentDirRel)
  : null))
const subfolders = computed(() => currentFolderNode.value?.children || [])
const stripH = computed(() => (subfolders.value.length ? SUBFOLDER_STRIP_H : 0))
const contentTop = computed(() => HEADER_H + stripH.value + 10)

/* 卡片封面：每个子文件夹取一张图（缩略图优先） */
const covers = ref({})
let coverToken = 0
watch(
  () => [lib.activeRootId, lib.currentDirRel, subfolders.value.map((f) => f.rel).join('|')].join('::'),
  async () => {
    const list = subfolders.value
    const token = ++coverToken
    if (!list.length) { covers.value = {}; return }
    const out = {}
    await Promise.all(list.map(async (f) => {
      try {
        const rows = await api.imagesByDir(lib.activeRootId, f.rel, 0, 1, 'added', false)
        const im = rows?.[0]
        if (im) out[f.rel] = fileUrl(im.thumbnail_path && im.thumbnail_path !== 'SKIP' ? im.thumbnail_path : im.file_path)
      } catch { /* 单目录失败忽略 */ }
    }))
    if (token === coverToken) covers.value = out
  },
  { immediate: true }
)
function onSubClick(e, f) {
  const add = e.altKey || e.ctrlKey || e.metaKey
  if (e.shiftKey || add) lib.selectDir(f.rel, { shift: e.shiftKey, add })
  else lib.openDir(f.rel)
}

/* ---------- 编辑排印头块（Wenku8 式：衬线大标题 + 英文小标 + 规则线） ---------- */
const VIEW_EN = { all: 'LIBRARY', recent: 'RECENT', uncategorized: 'UNSORTED', random: 'RANDOM', trash: 'TRASH', search: 'SEARCH' }
const header = computed(() => {
  const viewEn = VIEW_EN[lib.view] || 'LIBRARY'
  if (lib.selectionView) {
    const n = lib.selectedDirs.length
    return { big: `已选定 ${n} 个文件夹`, caption: `${(lib.images.length || 0).toLocaleString()} IMAGES / ${n} FOLDERS` }
  }
  if (lib.view !== 'all') return { big: { all: '全部', recent: '最近使用', uncategorized: '未分类', random: '随机模式', trash: '回收站' }[lib.view], caption: `${(lib.images.length || 0).toLocaleString()} ITEMS / ${viewEn}` }
  if (!lib.currentDirRel) return { big: '全部', caption: `${(lib.images.length || 0).toLocaleString()} IMAGES / ${viewEn}` }
  const parts = lib.currentDirRel.split('/')
  return { big: parts[parts.length - 1], caption: `${(lib.images.length || 0).toLocaleString()} IMAGES / ${viewEn}` }
})

const items = computed(() => {
  lib.layoutTick // 依赖：尺寸回填后重排
  const W = viewW.value - 2 // 滚动条余量
  const imgs = sortedImages.value
  const out = []
  if (W <= 0 || !imgs.length) return out

  if (lib.layout === 'justified') {
    const targetH = Math.round(240 * lib.zoom)
    let y = contentTop.value, row = []
    let arSum = 0 // 行内宽高比之和
    const flushRow = (isLast) => {
      if (!row.length) return
      const avail = W - GAP * (row.length - 1)
      let h = avail / arSum
      if (isLast && h > targetH * 1.35) h = targetH // 末行不强行拉高
      let x = 0
      for (const it of row) {
        const w = Math.round(it.ar * h)
        out.push({ ...it.ref, x, y, w, h, ar: it.ar })
        x += w + GAP
      }
      y += Math.round(h) + GAP
      row = []
      arSum = 0
    }
    for (const img of imgs) {
      const w = img.width || 1, h = img.height || 1
      const ar = Math.max(0.2, Math.min(4, w / h)) // 极端比例钳制
      row.push({ ref: img, ar })
      arSum += ar
      if (arSum * targetH >= W) flushRow(false)
    }
    flushRow(true)
  } else if (lib.layout === 'masonry') {
    // 瀑布流：定列数，每张图放进最矮的列
    const targetColW = Math.round(220 * lib.zoom)
    const cols = Math.max(1, Math.floor((W + GAP) / (targetColW + GAP)))
    const colW = Math.floor((W - GAP * (cols - 1)) / cols)
    const colH = new Array(cols).fill(contentTop.value)
    for (const img of imgs) {
      const ar = Math.max(0.2, Math.min(4, (img.width || 1) / (img.height || 1)))
      let col = 0
      for (let c = 1; c < cols; c++) if (colH[c] < colH[col]) col = c
      const h = Math.round(colW / ar)
      out.push({ ...img, x: col * (colW + GAP), y: colH[col], w: colW, h })
      colH[col] += h + GAP
    }
  } else {
    const cell = Math.round(200 * lib.zoom)
    const step = cell + GAP
    const cols = Math.max(1, Math.floor((W + GAP) / step))
    const y0 = contentTop.value
    imgs.forEach((img, i) => {
      const col = i % cols, rowIdx = Math.floor(i / cols)
      out.push({ ...img, x: col * step, y: y0 + rowIdx * step, w: cell, h: cell })
    })
  }
  return out
})

const totalH = computed(() => {
  const it = items.value
  const top = contentTop.value
  if (!it.length) return top + 10
  const last = it[it.length - 1]
  return Math.max(last.y + last.h + 40, top + 10)
})

/* 可视窗口：二分找起点，向后扫到出界 */
const visible = computed(() => {
  const it = items.value
  if (!it.length) return []
  const top = scrollTop.value - 400
  const bottom = scrollTop.value + viewH.value + 400
  let lo = 0, hi = it.length - 1, start = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (it[mid].y + it[mid].h >= top) { start = mid; hi = mid - 1 }
    else lo = mid + 1
  }
  const out = []
  for (let i = start; i < it.length; i++) {
    if (it[i].y > bottom) break
    out.push({ ...it[i], gi: i }) // gi = 全局序号：入场波以真实位置排延迟（滚动补挂载不重放）
  }
  return out
})

/* ---------- ZCode 式概览滑尺（正文右缘、详情左侧）：canvas dash + 视口高亮 + 点击/拖拽跳转 ---------- */
const RULER_W = 26
const rulerEl = ref(null)
let rulerRAF = 0

function drawRuler() {
  const cv = rulerEl.value
  if (!cv) return
  const dpr = window.devicePixelRatio || 1
  const w = 28
  const h = cv.clientHeight || viewH.value
  if (!h) return
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr)
    cv.height = Math.round(h * dpr)
  }
  const ctx = cv.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  const it = items.value
  if (!it.length) return
  const css = getComputedStyle(document.documentElement)
  const accent = css.getPropertyValue('--accent').trim() || '#b4884b'

  /* ZCode 波浪式：轨道切 48 槽，槽 dash 宽度 = 该段图片平均宽度的轮廓；
     视口所在槽为金色指示 dash，邻近槽以 cos² 衰减抬升（波随滚动行进） */
  const SLOTS = 48
  const padTop = 66, padBottom = 14
  const trackH = Math.max(40, h - padTop - padBottom)
  const total = totalH.value || 1
  const slotH = trackH / SLOTS
  const sum = new Array(SLOTS).fill(0)
  const cnt = new Array(SLOTS).fill(0)
  for (const im of it) {
    const s = Math.max(0, Math.min(SLOTS - 1, Math.floor((im.y / total) * SLOTS)))
    sum[s] += im.w || 120
    cnt[s]++
  }
  const avg = sum.map((v, i) => (cnt[i] ? v / cnt[i] : 0))
  const maxAvg = Math.max(...avg) || 1

  const viewSlotF = ((scrollTop.value + viewH.value / 2) / total) * SLOTS
  ctx.lineCap = 'round'
  for (let i = 0; i < SLOTS; i++) {
    if (!cnt[i]) continue
    const dist = Math.abs(i - viewSlotF)
    const wave = Math.max(0, 1 - dist / 4.2)
    const lift = wave * wave /* cos² 近似 */
    const len = 5 + (avg[i] / maxAvg) * 6 + lift * 14
    const y = padTop + slotH * (i + 0.5)
    const x0 = (w - len) / 2
    ctx.strokeStyle = accent
    ctx.globalAlpha = 0.16 + lift * 0.78
    ctx.lineWidth = 1.5 + lift * 3.5
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + len, y); ctx.stroke()
  }
  ctx.globalAlpha = 1
  /* 视口指示：单条金色长 dash（ZCode 焦点线语义） */
  const iy = padTop + (Math.max(0, Math.min((scrollTop.value + viewH.value / 2) / total, 1))) * trackH
  ctx.strokeStyle = accent
  ctx.globalAlpha = 0.95
  ctx.lineWidth = 4
  ctx.beginPath(); ctx.moveTo(3, iy); ctx.lineTo(w - 3, iy); ctx.stroke()
  ctx.globalAlpha = 1
}
function queueRuler() {
  if (rulerRAF) return
  rulerRAF = requestAnimationFrame(() => { rulerRAF = 0; drawRuler() })
}
watch([scrollTop, totalH, viewH, viewW, () => items.value.length], queueRuler)
onMounted(queueRuler)

/* 滑尺交互：按下/拖拽 → 按比例跳转（即时，ZCode 同款） */
let dragRuler = false
function rulerJump(e) {
  const r = e.currentTarget.getBoundingClientRect()
  const padTop = 66, padBottom = 14
  const trackH = Math.max(40, r.height - padTop - padBottom)
  const frac = Math.max(0, Math.min((e.clientY - r.top - padTop) / trackH, 1))
  const target = frac * totalH.value - viewH.value / 2
  viewport.value.scrollTop = Math.max(0, Math.min(target, totalH.value - viewH.value))
}
function onRulerDown(e) {
  dragRuler = true
  try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 合成指针无法捕获，跳过 */ }
  rulerJump(e)
}
function onRulerMove(e) { if (dragRuler) rulerJump(e) }
function onRulerUp() { dragRuler = false }

/* ---------- 缩略图按需补齐（只对可视窗口，带超时兜底防子进程挂起） ---------- */
const inFlight = new Map() // path -> 时间戳
watch(visible, (vis) => {
  const now = Date.now()
  for (const [p, t] of inFlight) if (now - t > 25000) inFlight.delete(p) // 超时释放
  const need = vis.filter((i) => !i.thumbnail_path && !inFlight.has(i.file_path)).map((i) => i.file_path)
  if (!need.length) return
  for (const p of need) inFlight.set(p, now)
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 20000))
  Promise.race([api.generateThumbnailsBatch(need.slice(0, 80)), timeout]).then((res) => {
    const results = res?.results || []
    for (const r of results) {
      if (r?.thumbnail_path) {
        const img = lib.images.find((i) => i.file_path === r.file_path)
        if (img) {
          img.thumbnail_path = r.thumbnail_path
          if (r.width && (!img.width || !img.height)) { img.width = r.width; img.height = r.height }
        }
      }
      inFlight.delete(r?.file_path)
    }
    if (!results.length) for (const p of need) inFlight.delete(p) // 整批失败：立即释放重试
    lib.layoutTick++
  })
})

const cells = computed(() =>
  visible.value.map((img) => {
    // 取源策略：大格子/无缩略图 → 原图直链（gif 含动画；视频无图则占位），杜绝 ∘ 和糊图
    const isVideo = /\.(mp4|webm|mov|mkv|avi|flv|f4v)$/i.test(img.file_path)
    const isGif = /\.gif$/i.test(img.file_path)
    const hasThumb = img.thumbnail_path && img.thumbnail_path !== 'SKIP'
    const wantOriginal = (img.w > 500 || !hasThumb) && !isVideo
    const src = (hasThumb && !wantOriginal) ? fileUrl(img.thumbnail_path) : (isVideo ? '' : fileUrl(img.file_path))
    return {
      ...img,
      src,
      res: img.width && img.height ? `${img.width} × ${img.height}` : '',
      info: img.res ? `${img.file_name}  ${img.res}` : img.file_name,
    }
  })
)

/* 选择：Shift=范围（按 filteredImages 可见顺序），Alt/Ctrl=加选/减选 */
const selectedSet = computed(() => new Set(lib.selectedPaths))
function onCellClick(e, img) {
  lib.selectImage(img.file_path, { shift: e.shiftKey, add: e.altKey || e.ctrlKey || e.metaKey })
}
</script>

<template>
  <canvas ref="rulerEl" class="ov-ruler"
          @pointerdown.prevent="onRulerDown" @pointermove="onRulerMove"
          @pointerup="onRulerUp" @pointercancel="onRulerUp" />
  <div ref="viewport" class="grid-viewport" @wheel="onViewportWheel">
    <div class="canvas" :style="{ height: totalH + 'px' }" @click.self="lib.clearImageSelection()">
      <!-- 编辑排印头块：滚动时整体穿入玻璃顶栏（同 Wenku8） -->
      <header :key="'head-' + waveSeq" class="page-head wi" style="--d: 0ms" @mousedown="startWindowDrag">
        <h2 class="head-big">{{ header.big }}</h2>
        <div class="head-caption">{{ header.caption }}</div>
        <div class="head-rule"><i /></div>
      </header>

      <!-- 子文件夹卡片条（Eagle 式）：随内容滚动，位于头部与图片之间 -->
      <div v-if="subfolders.length" class="subfolders" :style="{ top: HEADER_H + 'px', height: stripH + 'px', right: lib.viewer.showInspector ? '312px' : '4px' }">
        <div class="sf-head">
          <span class="sf-title">子文件夹 <b>({{ subfolders.length }})</b></span>
          <label class="sf-toggle">
            <input type="checkbox" :checked="lib.showSubfolderContent" @change="lib.setShowSubfolderContent($event.target.checked)" />
            <span>显示子文件夹内容</span>
          </label>
        </div>
        <div class="sf-row">
          <div
            v-for="f in subfolders" :key="f.rel" class="sf-card"
            :class="{ sel: lib.selectedDirs.includes(f.rel) }"
            @click="onSubClick($event, f)"
            @contextmenu.prevent="lib.openDirMenu($event, { rel: f.rel, node: f })"
          >
            <div class="sf-cover">
              <img v-if="covers[f.rel]" :src="covers[f.rel]" draggable="false" loading="lazy" />
              <FolderIcon v-else :color="lib.dirMemory[f.rel]?.color || ''" :size="30" />
            </div>
            <div class="sf-name" :title="f.name">{{ f.name }}</div>
            <div class="sf-count">{{ f.total }} 个文件</div>
          </div>
        </div>
      </div>

      <div
        v-for="img in cells" :key="img.id + '-' + waveSeq"
        class="cell" :class="{ selected: selectedSet.has(img.file_path) }"
        :style="{ transform: `translate(${img.x}px, ${img.y + 0}px)`, width: img.w + 'px', height: img.h + 'px', '--d': waveDelay(img.gi) + 'ms' }"
        draggable="true"
        @dragstart="onCellDragStart($event, img)"
        @click="onCellClick($event, img)"
        @dblclick="lib.openLightbox(img.file_path)"
        @contextmenu.prevent="lib.openContextMenu($event, img)"
      >
        <div class="thumb wi" :class="{ nowi: img.gi >= 48 }">
          <img v-if="img.src" :src="img.src" loading="lazy" draggable="false" />
          <div v-else class="noimg">∘</div>
          <!-- PicRand 式悬停信息条：叠在图片内部底部，不占布局 -->
          <div v-if="showLabels" class="hover-overlay" :data-info="img.info" />
        </div>
      </div>
    </div>
    <div v-if="lib.loading" class="state overlay-state">载入中…</div>
    <div v-else-if="!lib.images.length" class="state overlay-state">{{ subfolders.length ? '此文件夹暂无直属图片' : '此文件夹暂无图片' }}</div>
  </div>
</template>

<style scoped>
/* ZCode 式概览滑尺：正文右缘、详情左侧 */
.ov-ruler {
  position: fixed; right: 10px; top: 74px; width: 28px; height: calc(100vh - 94px);
  z-index: 10; /* 钉死窗口右缘不随详情缩放；详情浮岛(12/15)打开时覆盖滑尺 */
  cursor: pointer; touch-action: none;
}
.grid-viewport {
  flex: 1; overflow-y: auto; overflow-x: hidden;
  transition: padding-right 0.2s ease;
  padding: 0 6px 20px 8px;
  position: relative;
}
/* 原生滚动条隐藏：概览滑尺接管其职能（残留即它） */
.grid-viewport { scrollbar-width: none; }
.grid-viewport::-webkit-scrollbar { width: 0; height: 0; }
.grid-viewport::-webkit-scrollbar-thumb { background: transparent; }
.canvas { position: relative; width: 100%; margin-right: 26px; } /* 右缘让位概览滑尺（详情在其右侧） */
.cell { position: absolute; top: 0; left: 0; cursor: default; will-change: transform; }
.thumb {
  position: relative; width: 100%; height: 100%;
  border-radius: 10px; overflow: hidden;
  background: var(--bg-2); border: 1px solid var(--border);
  transition: box-shadow 0.18s, border-color 0.18s, transform 0.18s;
}
.cell:hover .thumb { transform: translateY(-2px); box-shadow: var(--shadow); }
.cell.selected .thumb { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-weak); }
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.noimg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--text-2); font-size: 22px; }

/* PicRand 式悬停信息条：图片内部底部渐变，hover 淡入，不占布局 */
.hover-overlay {
  position: absolute; bottom: 0; left: 0; right: 0; height: 48px;
  display: flex; align-items: flex-end; justify-content: flex-end;
  padding: 6px 9px;
  background: var(--overlay-grad);
  opacity: 0; transition: opacity 0.15s ease;
  pointer-events: none;
}
.cell:hover .hover-overlay { opacity: 1; }
.hover-overlay::after {
  content: attr(data-info);
  color: var(--overlay-text);
  font-size: 12px;
  font-weight: 500;
  text-shadow: var(--overlay-halo);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  max-width: 100%;
}

.insp-open { padding-right: 304px; }
.state { padding: 40px; text-align: center; color: var(--text-2); font-size: 13px; }
.overlay-state { position: absolute; inset: 60px 0 auto 0; }

/* 编辑排印头块 */
.page-head { position: absolute; top: 0; left: 4px; right: 4px; padding: 56px 10px 0; }
.head-big {
  font-family: var(--font-serif); font-size: 30px; font-weight: 700;
  margin: 0 0 6px; letter-spacing: 2px;
}
.head-caption {
  font-size: 11px; letter-spacing: 4px; color: var(--text-2);
  text-transform: uppercase; margin-bottom: 10px;
}
.head-rule { display: flex; align-items: center; gap: 8px; margin-right: 36px; } /* 右侧让位概览滑尺 */
.head-rule i { flex: 1; height: 1px; background: var(--border); }
.head-rule::after { content: ''; width: 5px; height: 5px; background: var(--accent); }

/* ---- 子文件夹卡片条（Eagle 式） ---- */
.subfolders { position: absolute; left: 4px; right: 4px; padding: 0 10px; }
.sf-head { display: flex; align-items: center; justify-content: space-between; height: 30px; }
.sf-title { font-size: 12px; color: var(--text-2); letter-spacing: 0.5px; }
.sf-title b { color: var(--text); font-weight: 600; }
.sf-toggle {
  display: flex; align-items: center; gap: 6px;
  font-size: 11.5px; color: var(--text-2); cursor: pointer; user-select: none;
  padding: 3px 7px; border-radius: 7px; transition: background 0.15s, color 0.15s;
}
.sf-toggle:hover { background: var(--accent-weak); color: var(--text); }
.sf-toggle input { accent-color: var(--accent); cursor: pointer; }
.sf-row { display: flex; gap: 14px; height: 130px; overflow-x: auto; overflow-y: hidden; padding: 4px 2px 0; scrollbar-width: none; }
.sf-row::-webkit-scrollbar { display: none; }
.sf-card { flex: none; width: 168px; cursor: pointer; }
.sf-cover {
  height: 92px; border-radius: 10px; overflow: hidden;
  background: var(--bg-2); border: 1px solid var(--border);
  display: flex; align-items: center; justify-content: center;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
}
.sf-cover img { display: block; width: 100%; height: 100%; object-fit: cover; }
.sf-card:hover .sf-cover { border-color: var(--accent); transform: translateY(-2px); box-shadow: var(--shadow); }
.sf-card.sel .sf-cover { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-weak); }
.sf-name { margin-top: 7px; font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sf-count { margin-top: 2px; font-size: 11px; color: var(--text-2); }
</style>
