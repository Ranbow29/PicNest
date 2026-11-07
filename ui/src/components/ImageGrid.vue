<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useLibrary } from '../stores/library'
import { api, fileUrl } from '../api'

const lib = useLibrary()
const showLabels = computed(() => lib.hoverLabels !== false)

/* ---------- 视口与虚拟滚动 ---------- */
const viewport = ref(null)
const viewW = ref(0)
const viewH = ref(0)
const scrollTop = ref(0)
let ro = null, rafPending = false

onMounted(() => {
  ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      viewW.value = e.contentRect.width
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
  e.dataTransfer.setData('application/x-picnest-file', img.file_path)
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

/* ---------- 编辑排印头块（Wenku8 式：衬线大标题 + 英文小标 + 规则线） ---------- */
const VIEW_EN = { all: 'LIBRARY', recent: 'RECENT', random: 'RANDOM', trash: 'TRASH', search: 'SEARCH' }
const header = computed(() => {
  const viewEn = VIEW_EN[lib.view] || 'LIBRARY'
  if (lib.view !== 'all') return { big: { all: '全部', recent: '最近使用', random: '随机模式', trash: '回收站' }[lib.view], caption: `${(lib.images.length || 0).toLocaleString()} ITEMS / ${viewEn}` }
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
    let y = HEADER_H + 10, row = []
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
    const colH = new Array(cols).fill(HEADER_H + 10)
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
    const y0 = HEADER_H + 10
    imgs.forEach((img, i) => {
      const col = i % cols, rowIdx = Math.floor(i / cols)
      out.push({ ...img, x: col * step, y: y0 + rowIdx * step, w: cell, h: cell })
    })
  }
  return out
})

const totalH = computed(() => {
  const it = items.value
  if (!it.length) return 0
  const last = it[it.length - 1]
  return last.y + last.h + 40
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
    out.push(it[i])
  }
  return out
})

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
</script>

<template>
  <div ref="viewport" class="grid-viewport" @wheel="onViewportWheel">
    <div class="canvas" :style="{ height: totalH + 'px' }">
      <!-- 编辑排印头块：滚动时整体穿入玻璃顶栏（同 Wenku8） -->
      <header class="page-head">
        <h2 class="head-big">{{ header.big }}</h2>
        <div class="head-caption">{{ header.caption }}</div>
        <div class="head-rule"><i /></div>
      </header>
      <div
        v-for="img in cells" :key="img.id"
        class="cell" :class="{ selected: img.file_path === lib.selectedPath }"
        :style="{ transform: `translate(${img.x}px, ${img.y + 0}px)`, width: img.w + 'px', height: img.h + 'px' }"
        draggable="true"
        @dragstart="onCellDragStart($event, img)"
        @click="lib.select(img.file_path)"
        @dblclick="lib.openLightbox(img.file_path)"
        @contextmenu.prevent="lib.openContextMenu($event, img)"
      >
        <div class="thumb">
          <img v-if="img.src" :src="img.src" loading="lazy" draggable="false" />
          <div v-else class="noimg">∘</div>
          <!-- PicRand 式悬停信息条：叠在图片内部底部，不占布局 -->
          <div v-if="showLabels" class="hover-overlay" :data-info="img.info" />
        </div>
      </div>
    </div>
    <div v-if="lib.loading" class="state overlay-state">载入中…</div>
    <div v-else-if="!lib.images.length" class="state overlay-state">此文件夹暂无图片</div>
  </div>
</template>

<style scoped>
.grid-viewport {
  flex: 1; overflow-y: auto; overflow-x: hidden;
  transition: padding-right 0.2s ease;
  padding: 0 6px 20px 8px;
  position: relative;
}
.grid-viewport::-webkit-scrollbar { width: 8px; }
.grid-viewport::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
.canvas { position: relative; width: 100%; }
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
.page-head { position: absolute; top: 0; left: 4px; right: 4px; padding: 56px 10px 0; -webkit-app-region: drag; }
.head-big {
  font-family: var(--font-serif); font-size: 30px; font-weight: 700;
  margin: 0 0 6px; letter-spacing: 2px;
}
.head-caption {
  font-size: 11px; letter-spacing: 4px; color: var(--text-2);
  text-transform: uppercase; margin-bottom: 10px;
}
.head-rule { display: flex; align-items: center; gap: 8px; }
.head-rule i { flex: 1; height: 1px; background: var(--border); }
.head-rule::after { content: ''; width: 5px; height: 5px; background: var(--accent); }
</style>
