<script setup>
import { computed, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useLibrary, extractDropUrls } from '../stores/library'
import { api, fileUrl } from '../api'
import { waveSeq, waveDelay, replayWave } from '../lib/wave'
import { isExternalDT as isDnDExternal } from '../lib/dnd'
import { isVideoPath, isTextPath, extOf } from '../lib/fileKinds'
import { useTheme } from '../lib/theme'
import FolderIcon from './FolderIcon.vue'

const lib = useLibrary()
const showLabels = computed(() => lib.hoverLabels !== false)
const { resolved: themeResolved } = useTheme() // 概览滑尺是 canvas：换主题要重画取新 --accent

/* Wenku8 式全体动效：视图/排序/筛选/内容更新 → 首屏入场波重放（防抖合并连续变更） */
let waveTimer = null
watch(
  () => [lib.view, lib.currentDirRel, lib.sortMode, lib.sortAsc, lib.layout, lib.activeRootId, lib.images.length, JSON.stringify(lib.filters)],
  () => {
    if (Date.now() < (lib.suppressWaveUntil || 0)) return // 拖动排序/移动的本地更新不重放入场波
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

/* 拖拽：窗口内是普通 HTML5 内部排序/移动（高亮落点），拖出窗口由主进程升级为原生文件拖拽。 */
/* 默认拖影会把整张卡片（大图 + 浮层）快照一遍，拖起来容易顿；用 96px 小画布当拖影更跟手。 */
function setCellDragImage(e) {
  try {
    const el = e.currentTarget?.querySelector?.('.thumb img')
    const c = dragImageEl.value
    if (!el || !c || !el.complete || !el.naturalWidth || !el.naturalHeight) return
    const size = 96
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, size, size)
    const ar = el.naturalWidth / el.naturalHeight
    let sx = 0, sy = 0, sw = el.naturalWidth, sh = el.naturalHeight
    if (ar > 1) { sw = el.naturalHeight; sx = (el.naturalWidth - sw) / 2 }
    else { sh = el.naturalWidth; sy = (el.naturalHeight - sh) / 2 }
    ctx.drawImage(el, sx, sy, sw, sh, 0, 0, size, size)
    e.dataTransfer.setDragImage(c, size / 2, size / 2)
  } catch { /* 跨域/未解码时用浏览器默认拖影 */ }
}

function onCellDragStart(e, img) {
  dragging.value = true
  const group = (lib.selectedPaths.length > 1 && lib.selectedPaths.includes(img.file_path))
    ? lib.selectedPaths.slice()
    : []
  e.dataTransfer.setData('application/x-picnest-file', img.file_path)
  e.dataTransfer.setData('text/plain', img.file_path)
  if (group.length > 1) e.dataTransfer.setData('application/x-picnest-files', JSON.stringify(group))
  e.dataTransfer.effectAllowed = 'move'
  setCellDragImage(e)
  /* 窗口内继续 HTML5 内部拖拽；主进程轮询光标，拖出窗口后升级为原生文件拖拽 */
  try { api.dragBegin(group.length > 1 ? group : [img.file_path]) } catch (err) { console.error('[drag-begin]', err) }
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

/* 当前层子文件夹（Eagle 式卡片条；合并视图不显示；全部视图显示库根顶层） */
const currentFolderNode = computed(() => {
  if (lib.view !== 'all' || lib.selectionView) return null
  if (lib.currentDirRel) return lib.findNode(lib.tree?.tree, lib.currentDirRel)
  return lib.tree?.tree || null
})
const subfolders = computed(() => currentFolderNode.value?.children || [])
const trashFolders = computed(() => (lib.view === 'trash' ? lib.trashFolders : []))
const SF_CARD_W = 168
const SF_CARD_H = 136
const SF_GAP = 14
const SF_HEAD_H = 30
const stripMode = computed(() => {
  if (lib.view === 'trash') return trashFolders.value.length ? 'trash' : ''
  return subfolders.value.length ? 'sub' : ''
})
/* 卡片按可用宽度换行铺满（全部视图 32 个也能全部看到，不靠横向滚动）
   viewW 已扣掉 grid-viewport 的 padding（含详情让位与本列自身右边距），这里不再重复扣详情宽度 */
const sfColumns = computed(() => {
  const avail = Math.max(SF_CARD_W, (viewW.value || 0) - 28)
  return Math.max(1, Math.floor((avail + SF_GAP) / (SF_CARD_W + SF_GAP)))
})
const stripH = computed(() => {
  if (!stripMode.value) return 0
  const n = stripMode.value === 'trash' ? trashFolders.value.length : subfolders.value.length
  const rows = Math.max(1, Math.ceil(n / sfColumns.value))
  return SF_HEAD_H + rows * (SF_CARD_H + SF_GAP) + 4
})
const contentTop = computed(() => HEADER_H + stripH.value + 10)
const fmtTrashDate = (ms) => {
  if (!ms) return ''
  const d = new Date(ms > 1e12 ? ms : ms * 1000)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/* 卡片封面：每个子文件夹取一张图（缩略图优先） */
const covers = ref({})
let coverToken = 0
watch(
  () => [
    lib.activeRootId,
    lib.currentDirRel,
    subfolders.value.map((f) => f.rel).join('|'),
    subfolders.value.map((f) => lib.dirMemory[f.rel]?.cover || '').join('|'),
  ].join('::'),
  async () => {
    const list = subfolders.value
    const token = ++coverToken
    if (!list.length) { covers.value = {}; return }
    const out = {}
    await Promise.all(list.map(async (f) => {
      try {
        const mem = lib.dirMemory[f.rel] || {}
        if (mem.cover) { out[f.rel] = fileUrl(mem.coverThumb || mem.cover); return } // 手动设置的封面优先
        /* 取前几张挑封面：文本/视频没有缩略图时会退化成裂图，宁可回落到文件夹图标 */
        const rows = await api.imagesByDir(lib.activeRootId, f.rel, 0, 6, 'added', false)
        const pick = (rows || []).find((im) => im.thumbnail_path && im.thumbnail_path !== 'SKIP')
          || (rows || []).find((im) => !isTextPath(im.file_path) && !isVideoPath(im.file_path))
        if (pick) out[f.rel] = fileUrl(pick.thumbnail_path && pick.thumbnail_path !== 'SKIP' ? pick.thumbnail_path : pick.file_path)
      } catch { /* 单目录失败忽略 */ }
    }))
    if (token === coverToken) covers.value = out
  },
  { immediate: true }
)
function onSubClick(e, f) {
  const add = e.altKey || e.ctrlKey || e.metaKey
  /* 正文卡片：单击/Shift/Alt 只选中并更新详情，不切中央网格；双击才进入 */
  lib.selectDir(f.rel, { shift: e.shiftKey, add, preview: false })
}
function onSubDblClick(e, f) {
  if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return
  lib.openDir(f.rel)
}

/* ---------- 编辑排印头块（Wenku8 式：衬线大标题 + 英文小标 + 规则线） ---------- */
const VIEW_EN = { all: 'LIBRARY', recent: 'RECENT', uncategorized: 'UNSORTED', random: 'RANDOM', trash: 'TRASH', search: 'SEARCH' }
const header = computed(() => {
  const viewEn = VIEW_EN[lib.view] || 'LIBRARY'
  if (lib.selectionView) {
    const n = lib.selectedDirs.length
    return { big: `已选定 ${n} 个文件夹`, caption: `${(lib.images.length || 0).toLocaleString()} IMAGES / ${n} FOLDERS` }
  }
  if (lib.view !== 'all') {
    const n = lib.view === 'trash' ? (lib.images.length + (lib.trashFolders?.length || 0)) : lib.images.length
    return { big: { all: '全部', recent: '最近使用', uncategorized: '未分类', random: '随机模式', trash: '回收站' }[lib.view], caption: `${n.toLocaleString()} ITEMS / ${viewEn}` }
  }
  if (!lib.currentDirRel) return { big: '全部', caption: `${(lib.images.length || 0).toLocaleString()} IMAGES / ${viewEn}` }
  const parts = lib.currentDirRel.split('/')
  return { big: lib.dispName(parts[parts.length - 1]), caption: `${(lib.images.length || 0).toLocaleString()} IMAGES / ${viewEn}` }
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
    // 瀑布流：定列数，每张图放进最矮的列（高度差在容差内时优先按从左到右排，避免同尺寸图因几像素误差穿插乱序）
    const targetColW = Math.round(220 * lib.zoom)
    const cols = Math.max(1, Math.floor((W + GAP) / (targetColW + GAP)))
    const colW = Math.floor((W - GAP * (cols - 1)) / cols)
    const colH = new Array(cols).fill(contentTop.value)
    const slack = Math.max(12, Math.round(colW * 0.12))
    const placed = []
    for (const img of imgs) {
      const ar = Math.max(0.2, Math.min(4, (img.width || 1) / (img.height || 1)))
      let minH = colH[0]
      for (let c = 1; c < cols; c++) if (colH[c] < minH) minH = colH[c]
      let col = 0
      for (let c = 0; c < cols; c++) {
        if (colH[c] <= minH + slack) { col = c; break }
      }
      const h = Math.round(colW / ar)
      placed.push({ ...img, col, x: col * (colW + GAP), y: colH[col], w: colW, h })
      colH[col] += h + GAP
    }
    // 按画面视觉阅读顺序（从上到下分行带、同行带内严格从左到右）重排 items，使 Shift 范围选与视觉位置一致
    placed.sort((a, b) => a.y - b.y || a.x - b.x)
    let band = []
    const usedCols = new Set()
    let bandThresholdSum = 0
    const flushBand = () => {
      if (!band.length) return
      band.sort((a, b) => a.x - b.x)
      for (const it of band) out.push(it)
      band = []
      usedCols.clear()
      bandThresholdSum = 0
    }
    for (const it of placed) {
      const span = Math.max(it.h * 0.55, colW * 0.55)
      if (!band.length) {
        band.push(it)
        usedCols.add(it.col)
        bandThresholdSum = it.y + span
        continue
      }
      const avgThresholdY = bandThresholdSum / band.length
      if (usedCols.has(it.col) || it.y > avgThresholdY) {
        flushBand()
      }
      band.push(it)
      usedCols.add(it.col)
      bandThresholdSum += it.y + span
    }
    flushBand()
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
/* 回写当前画面实际视觉顺序：Shift 范围连选、灯箱左右翻页、「应用为手动排序」均严格按画面从上到下、从左到右的 WYSIWYG 顺序 */
watch(
  [items, sortedImages],
  ([it, arr]) => {
    lib.gridOrder = (it && it.length ? it : arr).map((i) => i.file_path)
  },
  { immediate: true },
)

const totalH = computed(() => {
  const it = items.value
  const top = contentTop.value
  if (!it.length) return top + 10
  let maxBottom = top
  for (let i = Math.max(0, it.length - 24); i < it.length; i++) {
    const b = it[i].y + it[i].h
    if (b > maxBottom) maxBottom = b
  }
  return Math.max(maxBottom + 40, top + 10)
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
  const from = Math.max(0, start - 20)
  const out = []
  for (let i = from; i < it.length; i++) {
    if (it[i].y > bottom + 360) break
    if (it[i].y + it[i].h >= top && it[i].y <= bottom) {
      out.push({ ...it[i], gi: i }) // gi = 全局序号：入场波以真实位置排延迟（滚动补挂载不重放）
    }
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
watch(themeResolved, queueRuler) // 换主题：滑尺按新 accent 重绘
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
/* 大格子显示图：1024px 有界缓存（主进程生成）；没有时先用 400 缩略图，到了再换 */
function requestDisplayThumbs(vis) {
  const big = (vis || []).filter((i) =>
    i.w > 500 && !isTextPath(i.file_path) && !isVideoPath(i.file_path) && !/\.gif$/i.test(i.file_path) &&
    i.thumbnail_path && i.thumbnail_path !== 'SKIP')
  if (big.length) lib.ensureDisplayThumbs(big.map((i) => ({ path: i.file_path, mtime: i.modify_time || 0 })))
}
watch(() => visible.value.map((i) => `${i.file_path}:${i.thumbnail_path || ''}:${i.modify_time || 0}`).join('|'),
  () => requestDisplayThumbs(visible.value))
watch(visible, (vis) => {
  requestDisplayThumbs(vis)
  const now = Date.now()
  for (const [p, t] of inFlight) if (now - t > 25000) inFlight.delete(p) // 超时释放
  const need = vis.filter((i) => !i.thumbnail_path && !inFlight.has(i.file_path)).map((i) => i.file_path)
  if (!need.length) return
  for (const p of need) inFlight.set(p, now)
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 20000))
  /* 文本走 SVG 文字缩略图管线；图片/视频走原生 sharp/poster 管线 */
  const textNeed = need.filter((p) => isTextPath(p)).slice(0, 80)
  const imgNeed = need.filter((p) => !isTextPath(p)).slice(0, 80)
  const jobs = []
  if (imgNeed.length) jobs.push(Promise.race([api.generateThumbnailsBatch(imgNeed), timeout]))
  if (textNeed.length) jobs.push(Promise.race([api.generateTextThumbnails(textNeed), timeout]))
  Promise.all(jobs).then((list) => {
    const results = list.flatMap((r) => r?.results || [])
    for (const r of results) {
      if (r?.thumbnail_path) {
        const img = lib.images.find((i) => i.file_path === r.file_path)
        if (img) {
          img.thumbnail_path = r.thumbnail_path
          if (r.width && (!img.width || !img.height)) { img.width = r.width; img.height = r.height }
        }
      } else if (r?.file_path && isTextPath(r.file_path)) {
        const img = lib.images.find((i) => i.file_path === r.file_path)
        if (img) img.thumbnail_path = 'SKIP' // 文本缩略图失败：停止重试，格子里显示文档占位
      }
      inFlight.delete(r?.file_path)
    }
    if (!results.length) for (const p of need) inFlight.delete(p) // 整批失败：立即释放重试
    lib.layoutTick++
  })
})

/* 图片加载兜底：显示图/缩略图失败逐级降级（1024 显示图 → 400 缩略图 → 原图重试一次 → 占位可点重试）。
   网格不再直接解码原图（Chromium 解码缓存预算下 10MB+ PNG 会偶发失败），原图只留给灯箱。 */
const imgFix = reactive({}) // path -> { mode: 'thumb' | 'original' | 'error', n?: number }
function onCellImgError(cell) {
  const p = cell.file_path
  const hasThumb = !!(cell.thumbnail_path && cell.thumbnail_path !== 'SKIP')
  const cur = imgFix[p] || { n: 0 }
  if (cell.srcKind === 'display' || cell.srcKind === 'original') {
    imgFix[p] = hasThumb ? { ...cur, mode: 'thumb' } : (cur.n ? { ...cur, mode: 'error' } : { ...cur, mode: 'original', n: 1 })
  } else if (cell.srcKind === 'thumb') {
    imgFix[p] = cur.n ? { ...cur, mode: 'error' } : { ...cur, mode: 'original', n: 1 }
  } else {
    imgFix[p] = { ...cur, mode: 'error' }
  }
}
function retryCellImg(cell) {
  const cur = imgFix[cell.file_path] || {}
  imgFix[cell.file_path] = { mode: 'original', n: (cur.n || 0) + 1 }
}

const cells = computed(() =>
  visible.value.map((img) => {
    // 取源策略：文本/视频不直链；gif 大格保留原图动画；其余优先 1024 显示图 → 400 缩略图 → 原图
    const isVideo = isVideoPath(img.file_path)
    const isText = isTextPath(img.file_path)
    const isGif = /\.gif$/i.test(img.file_path)
    const hasThumb = img.thumbnail_path && img.thumbnail_path !== 'SKIP'
    const ver = img.modify_time || 0
    const disp = lib.displayThumbs[img.file_path]
    const hasDisplay = !!(disp && disp.p && disp.m === ver)
    const fx = imgFix[img.file_path]
    const withVer = (u) => (u ? `${u}?v=${ver}` : '')
    let src = ''
    let srcKind = ''
    if (isText) {
      if (hasThumb) { src = withVer(fileUrl(img.thumbnail_path)); srcKind = 'thumb' }
    } else if (isVideo) {
      src = ''
    } else if (fx?.mode === 'error') {
      src = ''
      srcKind = 'error'
    } else if (fx?.mode === 'thumb' && hasThumb) {
      src = withVer(fileUrl(img.thumbnail_path)) + (fx.n ? `&r=${fx.n}` : '')
      srcKind = 'thumb'
    } else if (fx?.mode === 'original') {
      src = withVer(fileUrl(img.file_path)) + (fx.n ? `&r=${fx.n}` : '')
      srcKind = 'original'
    } else if (isGif && img.w > 500) {
      src = withVer(fileUrl(img.file_path))
      srcKind = 'original'
    } else if (hasDisplay) {
      src = withVer(fileUrl(disp.p))
      srcKind = 'display'
    } else if (hasThumb) {
      src = withVer(fileUrl(img.thumbnail_path))
      srcKind = 'thumb'
    } else {
      src = withVer(fileUrl(img.file_path))
      srcKind = 'original'
    }
    const sizeText = (n) => !n ? '' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B'
    const res = isText
      ? ['文本', extOf(img.file_path).slice(1).toUpperCase(), sizeText(img.file_size)].filter(Boolean).join(' · ')
      : (isVideo ? '视频' : (img.width && img.height ? `${img.width} × ${img.height}` : ''))
    return {
      ...img,
      src,
      srcKind,
      isText,
      isVideo,
      extLabel: isText ? extOf(img.file_path).slice(1).toUpperCase() : '',
      res,
      info: res ? `${lib.dispName(img.file_name)}  ${res}` : lib.dispName(img.file_name),
    }
  })
)

/* 选择：Shift=范围（按 filteredImages 可见顺序），Alt/Ctrl=加选/减选 */
const selectedSet = computed(() => new Set(lib.selectedPaths))
function onCellClick(e, img) {
  lib.selectImage(img.file_path, { shift: e.shiftKey, add: e.altKey || e.ctrlKey || e.metaKey })
}

/* ---------- 框选：空白处按住拖拽，命中格子实时写入选中；Shift=加选 ---------- */
const canvasEl = ref(null)
const marquee = ref(null) // { x, y, w, h }
let mq = null // { startX, startY, clientX, clientY, x0, y0, x1, y1, moved, add, base }
let mqRAF = 0
let mqSuppressClickUntil = 0

function mqUpdate() {
  const el = canvasEl.value
  if (!el || !mq) return
  const r = el.getBoundingClientRect()
  mq.x1 = Math.max(0, Math.min(mq.clientX - r.left, r.width))
  mq.y1 = Math.max(0, Math.min(mq.clientY - r.top, totalH.value))
  const x = Math.min(mq.x0, mq.x1), y = Math.min(mq.y0, mq.y1)
  const w = Math.abs(mq.x1 - mq.x0), h = Math.abs(mq.y1 - mq.y0)
  marquee.value = { x, y, w, h }
  const hit = []
  for (const it of items.value) {
    if (it.x < x + w && it.x + it.w > x && it.y < y + h && it.y + it.h > y) hit.push(it.file_path)
  }
  lib.setImageSelection(hit, { add: mq.add, base: mq.base })
}
/* 贴近视口上下缘时持续滚动（按住不动也滚） */
function mqScrollStep() {
  const vp = viewport.value
  if (!vp || !mq) return false
  const vr = vp.getBoundingClientRect()
  const m = 34, speed = 22
  let d = 0
  if (mq.clientY < vr.top + m) d = -speed * Math.min(1, (vr.top + m - mq.clientY) / m)
  else if (mq.clientY > vr.bottom - m) d = speed * Math.min(1, (mq.clientY - (vr.bottom - m)) / m)
  if (!d) return false
  const before = vp.scrollTop
  vp.scrollTop = Math.max(0, Math.min(before + d, vp.scrollHeight - vp.clientHeight))
  return vp.scrollTop !== before
}
function mqTick() {
  mqRAF = 0
  const vp = viewport.value
  if (!mq?.moved || !vp) return
  if (mqScrollStep()) mqUpdate()
  const vr = vp.getBoundingClientRect()
  const near = mq.clientY < vr.top + 34 || mq.clientY > vr.bottom - 34
  if (near) mqRAF = requestAnimationFrame(mqTick)
}
function onMarqueeDown(e) {
  if (e.button !== 0 || !canvasEl.value) return
  const r = canvasEl.value.getBoundingClientRect()
  mq = {
    startX: e.clientX, startY: e.clientY,
    clientX: e.clientX, clientY: e.clientY,
    x0: e.clientX - r.left, y0: e.clientY - r.top,
    x1: e.clientX - r.left, y1: e.clientY - r.top,
    moved: false, add: e.shiftKey, base: e.shiftKey ? lib.selectedPaths.slice() : [],
  }
  try { canvasEl.value.setPointerCapture(e.pointerId) } catch { /* 合成指针无法捕获 */ }
  window.addEventListener('pointermove', onMarqueeMove)
  window.addEventListener('pointerup', onMarqueeUp, { once: true })
}
function onMarqueeMove(e) {
  if (!mq) return
  if (!mq.moved) {
    if (Math.hypot(e.clientX - mq.startX, e.clientY - mq.startY) < 4) return
    mq.moved = true
  }
  mq.clientX = e.clientX
  mq.clientY = e.clientY
  mqUpdate()
  if (!mqRAF) mqRAF = requestAnimationFrame(mqTick)
}
function onMarqueeUp() {
  window.removeEventListener('pointermove', onMarqueeMove)
  if (mqRAF) cancelAnimationFrame(mqRAF)
  mqRAF = 0
  if (mq?.moved) mqSuppressClickUntil = Date.now() + 320 // 拖拽后的 click 不再当“点空白”
  mq = null
  marquee.value = null
}
onBeforeUnmount(onMarqueeUp)

/* ---------- 拖动：格内排序 / 拖进子文件夹卡片 ---------- */
const reorderLineEl = ref(null)
let reorderCtx = null // { path, before, x, y, h }：插入线跟随最近的图（普通变量，拖动时直接改 DOM，避免整组件重渲染）
function setReorderLine(ctx) {
  reorderCtx = ctx
  const el = reorderLineEl.value
  if (!el) return
  if (!ctx) { el.style.display = 'none'; return }
  el.style.display = 'block'
  el.style.left = ctx.x + 'px'
  el.style.top = ctx.y + 'px'
  el.style.height = ctx.h + 'px'
}
const subDropRel = ref(null)
const dragging = ref(false) // 图片拖动中：禁用卡片悬停上浮，避免拖拽时整片网格抖动
const dragImageEl = ref(null) // 常驻 DOM 的 96px 小画布：detached canvas 在 Windows 上可能被 setDragImage 忽略
function dtTypes(e) { return [...(e.dataTransfer?.types || [])] }
function isExternalDT(e) { return isDnDExternal(e) }
function isInternalImageDT(e) { const t = dtTypes(e); return t.includes('application/x-picnest-file') || t.includes('application/x-picnest-files') }
function isInternalDirDT(e) { const t = dtTypes(e); return t.includes('application/x-picnest-dir') || t.includes('application/x-picnest-dirs') }
function dtList(dt, key) {
  try {
    const v = JSON.parse(dt.getData(key) || '[]')
    return Array.isArray(v) ? v.filter(Boolean) : []
  } catch { return [] }
}
function internalImages(e) {
  const multi = dtList(e.dataTransfer, 'application/x-picnest-files')
  if (multi.length) return multi
  const single = e.dataTransfer.getData('application/x-picnest-file')
  return single ? [single] : []
}
function internalDirs(e) {
  const multi = dtList(e.dataTransfer, 'application/x-picnest-dirs')
  if (multi.length) return multi
  const single = e.dataTransfer.getData('application/x-picnest-dir')
  return single ? [single] : []
}
/* 画布级排序：按光标最近图片算插入位置（不要求正落在格子上，缝隙也能排）。
   dragover 可能高于屏幕刷新率，重算插入线用 rAF 合并到每帧一次，拖起来更跟手。 */
let reorderRAF = 0
let reorderPointer = null

function updateReorderAt(cx, cy) {
  /* 只扫可视区（含 400px 缓冲）：大库几万张时不必每帧遍历全部 items */
  const list = visible.value.length ? visible.value : items.value
  if (!list.length) { setReorderLine(null); return }
  let best = null, bestD = Infinity
  for (const item of list) {
    const dx = cx - (item.x + item.w / 2)
    const dy = cy - (item.y + item.h / 2)
    const d = dx * dx + dy * dy
    if (d < bestD) { bestD = d; best = item }
  }
  if (!best) { setReorderLine(null); return }
  const mid = best.x + best.w / 2
  const prev = reorderCtx
  let before
  if (prev && prev.path === best.file_path) {
    /* 光标在同一张卡里小幅移动时不要来回翻边：中点附近留死区，否则插入线会左右跳。 */
    const dead = Math.max(6, Math.min(14, best.w * 0.04))
    if (prev.before && cx > mid + dead) before = false
    else if (!prev.before && cx < mid - dead) before = true
    else before = prev.before
    if (prev.before === before) return
  } else {
    before = cx < mid
  }
  setReorderLine({
    path: best.file_path,
    before,
    x: before ? best.x - 12 : best.x + best.w + 8,
    y: best.y - 3,
    h: best.h + 6,
  })
}

function flushReorder(clientX, clientY) {
  if (reorderRAF) { cancelAnimationFrame(reorderRAF); reorderRAF = 0 }
  reorderPointer = null
  const el = canvasEl.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  updateReorderAt(clientX - rect.left, clientY - rect.top)
}

function onCanvasDragOver(e) {
  if (!isInternalImageDT(e) || !lib.canReorder()) return
  e.preventDefault()
  e.stopPropagation()
  e.dataTransfer.dropEffect = 'move'
  reorderPointer = { x: e.clientX, y: e.clientY }
  if (reorderRAF) return
  reorderRAF = requestAnimationFrame(() => {
    reorderRAF = 0
    const p = reorderPointer
    const el = canvasEl.value
    if (!p || !el) return
    const rect = el.getBoundingClientRect()
    updateReorderAt(p.x - rect.left, p.y - rect.top)
  })
}
function onCanvasDragLeave(e) {
  const rect = e.currentTarget.getBoundingClientRect()
  if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
    if (reorderRAF) { cancelAnimationFrame(reorderRAF); reorderRAF = 0 }
    reorderPointer = null
    setReorderLine(null)
  }
}
async function onCanvasDrop(e) {
  if (!isInternalImageDT(e)) return // 外部拖入交给全窗 shell
  e.preventDefault()
  e.stopPropagation()
  /* 松手前把最后一帧的插入位置补算出来，避免 rAF 还没跑就 drop 导致插到旧位置 */
  flushReorder(e.clientX, e.clientY)
  const ctx = reorderCtx
  const paths = internalImages(e)
  setReorderLine(null)
  dragging.value = false
  if (!lib.canReorder()) {
    /* 非手动排序模式：不写 sort_order，保护已有手动排序 */
    lib.showNote('拖动换位需先切换到「手动排序」', [], 'muted')
    return
  }
  if (ctx && paths.length) await lib.reorderImages(paths, ctx.path, ctx.before)
}
/* 点正文空白：取消图片选中，改为选中当前文件夹（库根则选中库） */
function onBackgroundClick() {
  if (Date.now() < mqSuppressClickUntil) return // 框选松手后的合成 click
  if (mq?.moved) return
  if (lib.view === 'all') lib.selectDir(lib.currentDirRel || '', {})
  else lib.clearImageSelection()
}
function onSubDragOver(e, f) {
  if (!isExternalDT(e) && !isInternalImageDT(e) && !isInternalDirDT(e)) return
  e.preventDefault()
  e.stopPropagation()
  e.dataTransfer.dropEffect = isExternalDT(e) ? 'copy' : 'move'
  subDropRel.value = f.rel
  if (isExternalDT(e)) lib.setDropHint('dir', `录入到「${lib.dispName(f.name)}」`, e.clientX, e.clientY)
}
function onSubDragLeave(f) {
  if (subDropRel.value === f.rel) subDropRel.value = null
}
async function onSubDrop(e, f) {
  e.preventDefault()
  e.stopPropagation()
  const rel = f.rel
  subDropRel.value = null
  if (isExternalDT(e)) {
    lib.clearDropHint()
    const paths = [...(e.dataTransfer.files || [])].map((x) => window.picrand.getFilePath?.(x)).filter(Boolean)
    const urls = extractDropUrls(e.dataTransfer)
    const target = { rootId: lib.activeRootId, rel }
    if (paths.length) await lib.importDrop(paths, target)
    else if (urls.length) await lib.importUrls(urls, target)
    return
  }
  if (isInternalImageDT(e)) {
    const files = internalImages(e)
    if (files.length) await lib.moveImages(files, rel)
    return
  }
  if (isInternalDirDT(e)) {
    const dirs = internalDirs(e)
    if (dirs.length) await lib.dropOnDirs(dirs, rel, 'into')
  }
}
function clearDragUi() {
  if (reorderRAF) { cancelAnimationFrame(reorderRAF); reorderRAF = 0 }
  reorderPointer = null
  setReorderLine(null)
  subDropRel.value = null
  dragging.value = false
  try { api.dragEnd() } catch (err) { console.error('[drag-end]', err) }
}
/* 双击打开灯箱：抓取当前卡片屏幕坐标，供灯箱做 FLIP 共享元素放大过渡 */
function onCellDblClick(e, img) {
  const el = e.currentTarget?.querySelector?.('.thumb') || e.currentTarget
  const r = el?.getBoundingClientRect?.()
  const rect = r && r.width > 0 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null
  lib.openLightbox(img.file_path, rect)
}
/* 卡片 3D 微倾 + 柔光镜面跟随：直接写当前 DOM 节点的 CSS 变量，不触发 Vue 响应式重渲染 */
function onCellTiltMove(e) {
  if (!lib.cardTilt3D || dragging.value) return
  const el = e.currentTarget
  const r = el.getBoundingClientRect()
  if (!r.width || !r.height) return
  const px = (e.clientX - r.left) / r.width
  const py = (e.clientY - r.top) / r.height
  el.style.setProperty('--rx', ((0.5 - py) * 7.2).toFixed(2) + 'deg')
  el.style.setProperty('--ry', ((px - 0.5) * 7.2).toFixed(2) + 'deg')
  el.style.setProperty('--gx', (px * 100).toFixed(1) + '%')
  el.style.setProperty('--gy', (py * 100).toFixed(1) + '%')
}
function onCellTiltLeave(e) {
  const el = e.currentTarget
  el.style.removeProperty('--rx')
  el.style.removeProperty('--ry')
}
onMounted(() => window.addEventListener('dragend', clearDragUi))
onBeforeUnmount(() => window.removeEventListener('dragend', clearDragUi))
</script>

<template>
  <canvas ref="rulerEl" class="ov-ruler"
          @pointerdown.prevent="onRulerDown" @pointermove="onRulerMove"
          @pointerup="onRulerUp" @pointercancel="onRulerUp" />
  <canvas ref="dragImageEl" class="drag-image" width="96" height="96" />
  <div ref="viewport" class="grid-viewport" @wheel="onViewportWheel">
    <div ref="canvasEl" class="canvas" :class="{ dragging, 'tilt-on': lib.cardTilt3D }" :style="{ height: totalH + 'px' }"
         @click.self="onBackgroundClick"
         @pointerdown.self="onMarqueeDown"
         @dragover="onCanvasDragOver" @dragleave="onCanvasDragLeave" @drop="onCanvasDrop">
      <!-- 编辑排印头块：滚动时整体穿入玻璃顶栏（同 Wenku8） -->
      <header :key="'head-' + waveSeq" class="page-head wi" style="--d: 0ms">
        <h2 class="head-big">{{ header.big }}</h2>
        <div class="head-caption">{{ header.caption }}</div>
        <div class="head-rule"><i /></div>
      </header>

      <!-- 子文件夹 / 已删除文件夹卡片条：随内容滚动，位于头部与图片之间 -->
      <div v-if="stripMode" class="subfolders" :style="{ top: HEADER_H + 'px', height: stripH + 'px' }">
        <template v-if="stripMode === 'sub'">
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
              :class="{ sel: lib.selectedDirs.includes(f.rel), 'drop-into': subDropRel === f.rel }"
              @click="onSubClick($event, f)"
              @dblclick="onSubDblClick($event, f)"
              @dragover="onSubDragOver($event, f)" @dragleave="onSubDragLeave(f)" @drop="onSubDrop($event, f)"
              @contextmenu.prevent="lib.openDirMenu($event, { rel: f.rel, node: f })"
            >
              <div class="sf-cover">
                <img v-if="covers[f.rel]" :src="covers[f.rel]" :class="{ gray: lib.grayscaleMode }" draggable="false" loading="lazy" decoding="async" @error="$event.target.style.visibility='hidden'" />
                <FolderIcon v-else :color="lib.dirMemory[f.rel]?.color || ''" :size="30" />
              </div>
              <div class="sf-name" :title="lib.dispName(f.name) + ' · 双击进入'">{{ lib.dispName(f.name) }}</div>
              <div class="sf-count">{{ f.total }} 个文件</div>
            </div>
          </div>
        </template>
        <template v-else>
          <div class="sf-head">
            <span class="sf-title">已删除文件夹 <b>({{ trashFolders.length }})</b></span>
          </div>
          <div class="sf-row trash-row">
            <div v-for="tf in trashFolders" :key="tf.id" class="sf-card trash-card">
              <div class="sf-cover trash-cover">
                <FolderIcon :color="lib.dirMemory[tf.rel]?.color || ''" :size="28" />
              </div>
              <div class="sf-name" :title="tf.rel">{{ lib.dispName(tf.name) }}</div>
              <div class="sf-count">{{ tf.image_count }} 个文件 · {{ fmtTrashDate(tf.deleted_at) }}</div>
              <div class="tf-actions">
                <button class="tf-btn" @click="lib.restoreTrashFolder(tf.id)">还原</button>
                <button class="tf-btn danger" @click="lib.purgeTrashFolder(tf.id, tf.name)">彻底删除</button>
              </div>
            </div>
          </div>
        </template>
      </div>

      <!-- 框选矩形（空白拖拽） -->
      <div v-if="marquee" class="marquee"
           :style="{ left: marquee.x + 'px', top: marquee.y + 'px', width: marquee.w + 'px', height: marquee.h + 'px' }" />

      <!-- 拖动排序插入线（画布级，缝隙也可命中；直接改 DOM，不走 Vue 重渲染） -->
      <div ref="reorderLineEl" class="reorder-line" style="display: none" />

      <div
        v-for="img in cells" :key="img.id + '-' + waveSeq"
        class="cell" :class="{ selected: selectedSet.has(img.file_path) }"
        :data-cell-path="img.file_path"
        :style="{ transform: `translate(${img.x}px, ${img.y + 0}px)`, width: img.w + 'px', height: img.h + 'px', '--d': waveDelay(img.gi) + 'ms' }"
        draggable="true"
        @dragstart="onCellDragStart($event, img)"
        @click="onCellClick($event, img)"
        @dblclick="onCellDblClick($event, img)"
        @pointermove="onCellTiltMove"
        @pointerleave="onCellTiltLeave"
        @contextmenu.prevent="lib.openContextMenu($event, img)"
      >
        <div class="thumb wi" :class="{ nowi: img.gi >= 48, gray: lib.grayscaleMode }">
          <img v-if="img.src" :src="img.src" loading="lazy" decoding="async" draggable="false" @error="onCellImgError(img)" />
          <div v-else-if="img.isText" class="docph">
            <b>{{ img.extLabel }}</b>
            <span>{{ lib.dispName(img.file_name) }}</span>
          </div>
          <div v-else-if="img.srcKind === 'error'" class="noimg broken" title="加载失败，点击重试" @click.stop="retryCellImg(img)">⟳</div>
          <div v-else class="noimg">{{ img.isVideo ? '▶' : '∘' }}</div>
          <!-- PicRand 式悬停信息条：叠在图片内部底部，不占布局 -->
          <div v-if="showLabels" class="hover-overlay" :data-info="img.info" />
        </div>
      </div>
    </div>
    <div v-if="lib.loading" class="state overlay-state">载入中…</div>
    <div v-else-if="!lib.images.length && !(lib.view === 'trash' && trashFolders.length)" class="state overlay-state">
      {{ lib.view === 'trash' ? '回收站是空的' : (subfolders.length ? '此文件夹暂无直属图片' : '此文件夹暂无图片') }}
    </div>
  </div>
</template>

<style scoped>
/* ZCode 式概览滑尺：正文右缘、详情左侧 */
.ov-ruler {
  position: fixed; right: 6px; top: 70px; width: 28px; height: calc(100vh - 100px); /* 主面板 上/右 8px、下 22px：右缘 10px 内缩、底部 8px 内缩、顶栏下 20px */
  z-index: 10; /* 钉死窗口右缘不随详情缩放；详情浮岛(12/15)打开时覆盖滑尺 */
  cursor: pointer; touch-action: none;
}
/* 拖影画布必须留在 DOM 里：detached canvas 在 Windows 上可能被 setDragImage 忽略，退回整卡拖影 */
.drag-image { position: fixed; left: -200px; top: -200px; width: 96px; height: 96px; pointer-events: none; }
.grid-viewport {
  flex: 1; overflow-y: auto; overflow-x: hidden;
  transition: padding-right 0.2s ease;
  padding: 0 calc(6px + var(--insp-reserve, 0px)) 20px 26px; /* 右缘：滑尺 6 + 详情浮岛让位 */
  position: relative;
}
/* 原生滚动条隐藏：概览滑尺接管其职能（残留即它） */
.grid-viewport { scrollbar-width: none; }
.grid-viewport::-webkit-scrollbar { width: 0; height: 0; }
.grid-viewport::-webkit-scrollbar-thumb { background: transparent; }
.canvas { position: relative; width: 100%; margin-right: 26px; user-select: none; } /* 右缘让位概览滑尺（详情在其右侧） */
.cell { position: absolute; top: 0; left: 0; cursor: default; will-change: transform; perspective: 820px; }
.thumb {
  position: relative; width: 100%; height: 100%;
  border-radius: 12px; overflow: hidden;
  background: var(--bg-2); border: 1px solid var(--border);
  box-shadow: var(--shadow-tile);
  transform-style: preserve-3d;
  transition: box-shadow 0.24s ease, border-color 0.18s, transform 0.22s cubic-bezier(0.2, 0.9, 0.3, 1);
}
/* 浮岛 3D 柔光掠影：随鼠标位置扫过卡片表面 */
.thumb::before {
  content: ''; position: absolute; inset: 0; z-index: 2; border-radius: inherit; pointer-events: none;
  background: radial-gradient(
    circle 155px at var(--gx, 50%) var(--gy, 25%),
    rgba(255, 255, 255, 0.28) 0%,
    rgba(255, 255, 255, 0.08) 42%,
    transparent 74%
  );
  opacity: 0; transition: opacity 0.24s ease;
  mix-blend-mode: overlay;
}
/* 浮岛顶缘：一线玻璃高光 + 极淡整圈内描边（只有 ::after 能压在 img 之上） */
.thumb::after {
  content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  box-shadow: inset 0 1px 0 var(--tile-edge), inset 0 0 0 1px rgba(255, 255, 255, 0.08);
}
.cell:hover .thumb {
  transform: translateY(-3px);
  box-shadow: var(--shadow-tile-hover);
}
.canvas.tilt-on .cell:hover .thumb {
  transform: translateY(-3px) rotateX(var(--rx, 0deg)) rotateY(var(--ry, 0deg)) scale(1.012);
}
.canvas.tilt-on .cell:hover .thumb::before { opacity: 1; }
.canvas.dragging .cell:hover .thumb::before { opacity: 0; }
.cell.selected .thumb {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 6px var(--accent-weak), var(--shadow-tile);
}
.cell.selected:hover .thumb {
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 6px var(--accent-weak), var(--shadow-tile-hover);
}
/* 拖动图片时禁用悬停上浮与过渡：否则拖过每张卡都会抬起/落下，整片网格看起来在抖 */
.canvas.dragging .cell .thumb { transition: none; }
.canvas.dragging .cell:hover .thumb { transform: none; box-shadow: var(--shadow-tile); }
.canvas.dragging .cell.selected:hover .thumb {
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 6px var(--accent-weak), var(--shadow-tile);
}
.canvas.dragging .cell:hover .hover-overlay { opacity: 0; }
.reorder-line {
  position: absolute; width: 3px; border-radius: 2px;
  background: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-weak);
  pointer-events: none; z-index: 5;
}
.marquee {
  position: absolute; z-index: 6; pointer-events: none;
  border: 1px solid var(--accent); border-radius: 3px;
  background: var(--accent-weak);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.06) inset;
}
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.thumb.gray img, .sf-cover img.gray { filter: grayscale(1); }
.noimg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--text-2); font-size: 22px; }
.noimg.broken { cursor: pointer; color: var(--accent); font-size: 20px; opacity: 0.75; }
.noimg.broken:hover { opacity: 1; background: var(--accent-weak); }
/* 文本文件占位卡（文字缩略图还没生成时）：牛皮纸底 + 后缀徽标，避免裂图 */
.docph {
  position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  padding: 12px; background: linear-gradient(160deg, #f7f3ea 0%, #eee7d9 100%); color: #6b604f;
}
.docph b {
  font-family: var(--font-mono, Consolas, monospace); font-size: 12px; letter-spacing: 1px;
  padding: 2px 8px; border: 1px solid #cfc4ae; border-radius: 6px; background: rgba(255, 255, 255, 0.5);
}
.docph span {
  max-width: 100%; font-size: 11px; color: #8a7c68; text-align: center;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

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
.head-rule i { flex: 1; height: 1px; background: linear-gradient(90deg, var(--accent) 0, var(--border) 72px, var(--border) 70%, transparent); transform-origin: left; animation: rule-grow 0.9s cubic-bezier(0.18, 0.72, 0.18, 1) both; }
@keyframes rule-grow { from { transform: scaleX(0); opacity: 0; } to { transform: scaleX(1); opacity: 1; } }
.head-rule::after { content: ''; width: 5px; height: 5px; background: var(--accent); transform: rotate(45deg); }

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
.sf-row { display: flex; flex-wrap: wrap; gap: 14px; padding: 4px 2px 0; align-content: flex-start; }
.sf-card { flex: none; width: 168px; height: 136px; cursor: pointer; }
.sf-cover {
  height: 92px; border-radius: 12px; overflow: hidden;
  background: var(--bg-2); border: 1px solid var(--border);
  box-shadow: var(--shadow-tile);
  display: flex; align-items: center; justify-content: center;
  transition: border-color 0.18s, box-shadow 0.24s ease, transform 0.26s var(--ease-overshoot);
}
.sf-cover img { display: block; width: 100%; height: 100%; object-fit: cover; }
.sf-card:hover .sf-cover { border-color: var(--accent); transform: translateY(-3px); box-shadow: var(--shadow-tile-hover); }
.sf-card.sel .sf-cover { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent), 0 0 0 6px var(--accent-weak), var(--shadow-tile); }
.sf-card.drop-into .sf-cover { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-weak); background: var(--accent-weak); }
.sf-name { margin-top: 7px; font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sf-count { margin-top: 2px; font-size: 11px; color: var(--text-2); }

/* 回收站文件夹卡片 */
.trash-card { width: 168px; }
.trash-cover { height: 62px; }
.trash-card .sf-name { margin-top: 5px; }
.tf-actions { display: flex; gap: 6px; margin-top: 6px; }
.tf-btn {
  flex: 1; border: 1px solid var(--border); background: transparent; color: var(--text-2);
  border-radius: 7px; font-size: 11px; padding: 4px 0; cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.tf-btn:hover { background: var(--accent-weak); color: var(--accent); border-color: var(--accent); }
.tf-btn.danger { color: #c25a4d; }
.tf-btn.danger:hover { background: rgba(194, 90, 77, 0.12); border-color: #c25a4d; }
</style>
