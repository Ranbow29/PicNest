<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useLibrary } from '../stores/library'
import { api, fileUrl } from '../api'
import { getFormatBadge } from '../lib/fileKinds'

const lib = useLibrary()
const vs = computed(() => lib.visualSearch)
const isOpen = computed(() => vs.value.open)

// 提取任务格式徽标 (PSD / GIF / MP4 / WEBP 等，对齐 Eagle 设计)
function getTaskBadge(task) {
  if (!task) return ''
  const p = task.filePath || task.name || ''
  return getFormatBadge(p)
}

// 当前选中的搜索任务
const currentTask = computed(() => {
  if (!vs.value.tasks.length) return null
  return vs.value.tasks.find((t) => t.id === vs.value.activeTaskId) || vs.value.tasks[0]
})

// 瀑布流列宽缩放 (160px ~ 520px，支持 Ctrl+滚轮 自由调节)
const scale = computed({
  get: () => vs.value.scale || 240,
  set: (val) => { vs.value.scale = Math.max(160, Math.min(520, Number(val))) }
})

// 专精 Pinterest Lens 视觉检索 (已移除效果不佳的花瓣网与聚合切换)
const engine = 'pinterest'

// 图片加载完成后提取真实分辨率
function onImageLoaded(e) {
  const img = e.target
  if (img && img.naturalWidth && img.naturalHeight && currentTask.value) {
    if (!currentTask.value.width) currentTask.value.width = img.naturalWidth
    if (!currentTask.value.height) currentTask.value.height = img.naturalHeight
  }
}

// 窗口置顶状态
const isAlwaysOnTop = ref(false)
async function toggleAlwaysOnTop() {
  isAlwaysOnTop.value = !isAlwaysOnTop.value
  vs.value.alwaysOnTop = isAlwaysOnTop.value
  try {
    await api.setAlwaysOnTop(isAlwaysOnTop.value)
  } catch (e) {}
}

// 悬停卡片与放大预览状态
const hoveredItem = ref(null)
const previewItem = ref(null)
const waterfallEl = ref(null)
const waterfallWidth = ref(800)
let waterfallResizeObserver = null

// 监听 waterfallEl 尺寸以精确计算列数
watch(waterfallEl, (el) => {
  if (waterfallResizeObserver) {
    waterfallResizeObserver.disconnect()
    waterfallResizeObserver = null
  }
  if (el) {
    waterfallWidth.value = el.clientWidth || 800
    waterfallResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        waterfallWidth.value = entry.contentRect.width
      }
    })
    waterfallResizeObserver.observe(el)
  }
})

// 根据可用宽度与 scale 动态计算列数
const columnCount = computed(() => {
  const availableW = Math.max(120, (waterfallWidth.value || 800) - 32)
  const colW = scale.value || 240
  const gap = 14
  return Math.max(1, Math.floor((availableW + gap) / (colW + gap)))
})

// 确定性贪心分列 (对齐 Eagle 原生算法，按宽高比预占位，彻底杜绝 CSS Multi-column 重排乱跳与位置篡改)
const columnData = computed(() => {
  const count = columnCount.value
  const cols = Array.from({ length: count }, () => [])
  const colHeights = Array(count).fill(0)
  const results = currentTask.value?.results || []

  for (let i = 0; i < results.length; i++) {
    const item = results[i]
    let minCol = 0
    let minH = colHeights[0]
    for (let c = 1; c < count; c++) {
      if (colHeights[c] < minH) {
        minH = colHeights[c]
        minCol = c
      }
    }
    cols[minCol].push(item)
    const ratio = (item.height && item.width) ? (item.height / item.width) : 1.3
    colHeights[minCol] += ratio * 100 + 14
  }
  return cols
})

// 任务队列操作与滚动记忆
function selectTask(task) {
  if (currentTask.value && waterfallEl.value) {
    currentTask.value.scrollTop = waterfallEl.value.scrollTop
  }
  vs.value.activeTaskId = task.id
  nextTick(() => {
    if (waterfallEl.value && typeof task.scrollTop === 'number') {
      waterfallEl.value.scrollTop = task.scrollTop
    }
  })
  if (!task.results?.length && !task.loading) {
    triggerSearch(task)
  }
}

function removeTask(task, e) {
  e?.stopPropagation()
  lib.removeVisualSearchTask(task.id)
}

const fileInputRef = ref(null)
function openFilePicker() {
  fileInputRef.value?.click()
}

function onFilePicked(e) {
  const files = Array.from(e.target.files || [])
  if (!files.length) return
  files.forEach((f) => {
    if (f.path) {
      lib.pushVisualSearchTask({ filePath: f.path, name: f.name })
    } else {
      const reader = new FileReader()
      reader.onload = (re) => {
        lib.pushVisualSearchTask({ dataUrl: re.target.result, name: f.name })
      }
      reader.readAsDataURL(f)
    }
  })
  e.target.value = ''
}

// 队列侧栏拖拽添加
const isQueueDraggingOver = ref(false)
function onQueueDrop(e) {
  isQueueDraggingOver.value = false
  const dt = e.dataTransfer
  if (!dt) return
  const files = Array.from(dt.files || [])
  files.forEach((f) => {
    if (f.path) {
      lib.pushVisualSearchTask({ filePath: f.path, name: f.name })
    } else {
      const reader = new FileReader()
      reader.onload = (re) => {
        lib.pushVisualSearchTask({ dataUrl: re.target.result, name: f.name })
      }
      reader.readAsDataURL(f)
    }
  })
}

/* ================== 框选裁剪 (ROI Bounding Box) ================== */
const cropImgRef = ref(null)
const cropContainerRef = ref(null)
const bbox = ref([0, 0, 1, 1]) // [x, y, w, h] 归一化坐标 0..1
let cropDebounceTimer = null

// 监听活动任务变化，重置或还原其 bbox
watch(() => currentTask.value?.id, async (newId) => {
  if (!newId || !currentTask.value) return
  bbox.value = currentTask.value.bbox ? [...currentTask.value.bbox] : [0, 0, 1, 1]
  // 针对 PSD / 视频，若前端尚无有效缩略图，异步预拉取预览以瞬显画面
  if (currentTask.value.filePath && !currentTask.value.thumbUrl) {
    const ext = currentTask.value.filePath.slice(currentTask.value.filePath.lastIndexOf('.')).toLowerCase()
    if (ext === '.psd') {
      try {
        const r = await api.psdPreview(currentTask.value.filePath)
        if (r?.ok && r?.path) {
          currentTask.value.thumbUrl = fileUrl(r.path)
        }
      } catch (e) {}
    } else if (['.mp4', '.webm', '.mov', '.mkv', '.avi', '.flv', '.f4v'].includes(ext)) {
      try {
        const r = await api.videoPreview(currentTask.value.filePath)
        if (r?.ok && r?.path) {
          currentTask.value.thumbUrl = fileUrl(r.path)
        }
      } catch (e) {}
    }
  }
  if (!currentTask.value.results?.length && !currentTask.value.loading) {
    triggerSearch(currentTask.value)
  }
}, { immediate: true })

function resetBbox() {
  bbox.value = [0, 0, 1, 1]
  if (currentTask.value) currentTask.value.bbox = [0, 0, 1, 1]
  onBboxChanged()
}

// 拖拽手柄逻辑
const cropDragging = ref(null) // null | 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'w' | 'e'
let dragStartPos = { x: 0, y: 0 }
let startBbox = [0, 0, 1, 1]

function startDrag(handle, e) {
  e.preventDefault()
  e.stopPropagation()
  cropDragging.value = handle
  dragStartPos = { x: e.clientX, y: e.clientY }
  startBbox = [...bbox.value]
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragEnd)
}

function onDragMove(e) {
  if (!cropDragging.value || !cropContainerRef.value) return
  const rect = cropContainerRef.value.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return

  const dx = (e.clientX - dragStartPos.x) / rect.width
  const dy = (e.clientY - dragStartPos.y) / rect.height

  let [bx, by, bw, bh] = [...startBbox]

  if (cropDragging.value === 'move') {
    bx = Math.max(0, Math.min(1 - bw, bx + dx))
    by = Math.max(0, Math.min(1 - bh, by + dy))
  } else {
    // 调整四角 / 四边手柄
    if (cropDragging.value.includes('w')) {
      const newBx = Math.max(0, Math.min(startBbox[0] + startBbox[2] - 0.05, startBbox[0] + dx))
      bw = startBbox[0] + startBbox[2] - newBx
      bx = newBx
    }
    if (cropDragging.value.includes('e')) {
      bw = Math.max(0.05, Math.min(1 - startBbox[0], startBbox[2] + dx))
    }
    if (cropDragging.value.includes('n')) {
      const newBy = Math.max(0, Math.min(startBbox[1] + startBbox[3] - 0.05, startBbox[1] + dy))
      bh = startBbox[1] + startBbox[3] - newBy
      by = newBy
    }
    if (cropDragging.value.includes('s')) {
      bh = Math.max(0.05, Math.min(1 - startBbox[1], startBbox[3] + dy))
    }
  }

  bbox.value = [bx, by, bw, bh]
}

function onDragEnd() {
  cropDragging.value = null
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
  if (currentTask.value) {
    currentTask.value.bbox = [...bbox.value]
  }
  onBboxChanged()
}

function onBboxChanged() {
  if (cropDebounceTimer) clearTimeout(cropDebounceTimer)
  cropDebounceTimer = setTimeout(() => {
    if (currentTask.value) {
      // 渐进式刷新（对齐 Eagle）：不清空现有卡片，仅重设分页游标并在后台静默重查，消除白屏跳变
      currentTask.value.bookmark = null
      triggerSearch(currentTask.value, false, true)
    }
  }, 320)
}

/* ================== 网络检索与分页 ================== */
async function triggerSearch(task, continueSearch = false, isRequery = false) {
  if (!task || task.loading) return
  task.loading = true
  task.error = null

  try {
    const cleanBbox = task.bbox
      ? [Number(task.bbox[0] ?? 0), Number(task.bbox[1] ?? 0), Number(task.bbox[2] ?? 1), Number(task.bbox[3] ?? 1)]
      : [0, 0, 1, 1]
    const opts = {
      filePath: String(task.filePath || ''),
      dataUrl: String(task.dataUrl || ''),
      bbox: cleanBbox,
      bookmark: continueSearch && task.bookmark ? String(task.bookmark) : null,
      engine: 'pinterest',
      pageSize: 200
    }

    const res = await api.visualSearchQuery(opts)
    if (!res?.ok) {
      task.error = res?.error || '检索失败'
    } else {
      if (continueSearch) {
        task.results = [...(task.results || []), ...(res.items || [])]
      } else {
        // 成功获取新数据后整体原子替换，杜绝白屏与黑边闪烁
        task.results = res.items || []
        if (isRequery && waterfallEl.value) {
          waterfallEl.value.scrollTop = 0
        }
      }
      task.bookmark = res.bookmark || null
      if (res.queryMeta) {
        if (res.queryMeta.width) task.width = res.queryMeta.width
        if (res.queryMeta.height) task.height = res.queryMeta.height
        if (res.queryMeta.thumbUrl) task.thumbUrl = res.queryMeta.thumbUrl
      }
    }
  } catch (err) {
    task.error = String(err?.message || err)
  } finally {
    task.loading = false
  }
}

function loadMore() {
  if (currentTask.value && currentTask.value.bookmark && !currentTask.value.loading) {
    triggerSearch(currentTask.value, true)
  }
}

// 瀑布流无限滚动与位置记忆：向下滚自动加载下一页，同时记录当前任务滚动偏置
function onWaterfallScroll(e) {
  const el = e?.target
  if (!el) return
  if (currentTask.value) {
    currentTask.value.scrollTop = el.scrollTop
  }
  if (!currentTask.value?.bookmark || currentTask.value.loading) return
  const dist = el.scrollHeight - el.scrollTop - el.clientHeight
  if (dist < 400) {
    loadMore()
  }
}

/* ================== 卡片动作 (F: 递归搜索 / S: 存入未分类 / O: 原网) ================== */
// F: 递归搜索 (紧贴当前任务后面插入，保证连续创作上下文)
function researchItem(item, e) {
  e?.stopPropagation()
  if (!item) return
  const curId = currentTask.value?.id
  const newTask = lib.pushVisualSearchTask({
    title: item.title || '衍生图搜',
    thumbUrl: item.thumbUrl,
    dataUrl: item.largeUrl || item.thumbUrl,
    width: item.width,
    height: item.height,
  }, curId)
  triggerSearch(newTask)
}

// S: 保存到未分类（直接存入库根 loose 散图，杜绝丢失与报错）
const savingMap = ref({})
async function saveItem(item, e) {
  e?.stopPropagation()
  if (!item || item.saved || savingMap.value[item.id]) return
  savingMap.value[item.id] = true

  try {
    const rootId = lib.activeRootId
    const res = await api.visualSearchSave({
      src: item.origUrl || item.largeUrl || item.thumbUrl,
      origUrl: item.origUrl,
      largeUrl: item.largeUrl,
      thumbUrl: item.thumbUrl,
      title: item.title || '灵感采集',
      sourceUrl: item.sourceUrl,
      engine: 'pinterest',
      rootId,
      rel: '' // 强制保存至未分类
    })

    if (res?.ok) {
      item.saved = true
      // 安全刷新当前网格视图（修复此前不存在 syncCurrentDir 的函数未定义异常）
      if (typeof lib.loadImages === 'function') {
        lib.loadImages()
      }
    } else {
      alert(res?.error || '保存失败')
    }
  } catch (err) {
    alert(String(err?.message || err))
  } finally {
    delete savingMap.value[item.id]
  }
}

// O: 原网打开
function openSource(item, e) {
  e?.stopPropagation()
  if (item?.sourceUrl) {
    api.openExternal(item.sourceUrl)
  }
}

/* ================== 灯箱大图交互 (双层渐进加载、平滑切图预拉取、靠近浮现工具坞) ================== */
const previewZoom = ref(1)
const previewTx = ref(0)
const previewTy = ref(0)
const isPreviewPanning = ref(false)
const previewNatW = ref(0)
const previewNatH = ref(0)
const isDockHover = ref(false)
const isHighResLoaded = ref(false)
let dockHoverTimer = null
let previewPanStart = { x: 0, y: 0, tx: 0, ty: 0 }

function resetPreviewTransform() {
  previewZoom.value = 1
  previewTx.value = 0
  previewTy.value = 0
}

// 静默预加载相邻 3 张大图到浏览器缓存，切图体验对齐 Eagle 60fps 丝滑秒开
function preloadNeighbors(curIdx) {
  const list = currentTask.value?.results || []
  if (!list.length || curIdx < 0) return
  const toPreload = [curIdx + 1, curIdx + 2, curIdx - 1]
  for (const idx of toPreload) {
    if (idx >= 0 && idx < list.length) {
      const it = list[idx]
      const url = it.largeUrl || it.origUrl
      if (url) {
        const preImg = new Image()
        preImg.src = url
      }
    }
  }
}

function openPreview(item) {
  if (!item) return
  previewItem.value = item
  previewNatW.value = item.width || 0
  previewNatH.value = item.height || 0
  isHighResLoaded.value = false
  resetPreviewTransform()
  nextTick(() => {
    preloadNeighbors(previewIndex.value)
  })
}

function closePreview() {
  previewItem.value = null
  isHighResLoaded.value = false
  resetPreviewTransform()
}

// 刷新当前大图 (按 R 或点击刷新，规避 Pinterest CDN 偶然 504)
function reloadCurrentPreview() {
  if (!previewItem.value) return
  isHighResLoaded.value = false
  const cur = previewItem.value
  const base = cur.largeUrl || cur.origUrl || cur.thumbUrl
  const sep = base.includes('?') ? '&' : '?'
  cur.largeUrl = base.split('?_t=')[0] + sep + '_t=' + Date.now()
}

// 靠近底部自动展开工具坞 (PicNest 极简沉浸规范：平时隐身，鼠标移到底部区域立即展开)
function onLightboxPointerMove(e) {
  const fromBottom = window.innerHeight - e.clientY
  if (fromBottom <= 100) {
    if (dockHoverTimer) clearTimeout(dockHoverTimer)
    isDockHover.value = true
  } else if (isDockHover.value) {
    if (dockHoverTimer) clearTimeout(dockHoverTimer)
    dockHoverTimer = setTimeout(() => {
      isDockHover.value = false
    }, 350)
  }
}

function onPreviewHighResLoad(e) {
  isHighResLoaded.value = true
  const img = e?.target
  if (img && img.naturalWidth && img.naturalHeight) {
    previewNatW.value = img.naturalWidth
    previewNatH.value = img.naturalHeight
  }
}

function onPreviewHighResError() {
  isHighResLoaded.value = false
}

function onPreviewWheel(e) {
  e.preventDefault()
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
  const nextZoom = Math.min(10, Math.max(0.1, previewZoom.value * factor))
  previewZoom.value = Number(nextZoom.toFixed(2))
}

function onPreviewMouseDown(e) {
  if (e.button !== 0 || e.target.closest('button, .lightbox-dock, .lightbox-topbar')) return
  e.preventDefault()
  isPreviewPanning.value = true
  previewPanStart = { x: e.clientX, y: e.clientY, tx: previewTx.value, ty: previewTy.value }
  window.addEventListener('mousemove', onPreviewMouseMove)
  window.addEventListener('mouseup', onPreviewMouseUp)
}

function onPreviewMouseMove(e) {
  if (!isPreviewPanning.value) return
  previewTx.value = previewPanStart.tx + (e.clientX - previewPanStart.x)
  previewTy.value = previewPanStart.ty + (e.clientY - previewPanStart.y)
}

function onPreviewMouseUp() {
  isPreviewPanning.value = false
  window.removeEventListener('mousemove', onPreviewMouseMove)
  window.removeEventListener('mouseup', onPreviewMouseUp)
}

function togglePreviewZoom() {
  if (previewZoom.value === 1) {
    previewZoom.value = 2.0
  } else {
    resetPreviewTransform()
  }
}

const previewIndex = computed(() => {
  if (!previewItem.value || !currentTask.value?.results?.length) return -1
  return currentTask.value.results.findIndex((i) => i.id === previewItem.value.id)
})

let lastNavTime = 0
function nextPreviewItem(e) {
  e?.stopPropagation()
  const now = Date.now()
  if (now - lastNavTime < 80) return // 80ms 防抖，过滤键盘连发引起的快速轮播跳帧
  lastNavTime = now

  const list = currentTask.value?.results || []
  if (!list.length) return
  const cur = previewIndex.value
  if (cur < 0) return

  // 提前 5 张静默预拉取下一页，避免用户按 D 一张一张看时产生卡顿
  if (cur >= list.length - 6 && currentTask.value?.bookmark && !currentTask.value.loading) {
    loadMore()
  }

  // 杜绝跑马灯循环：到达末尾时停在最后一张（等待新图追加，而非突兀跳回第 1 张）
  if (cur < list.length - 1) {
    openPreview(list[cur + 1])
  } else if (currentTask.value?.bookmark && !currentTask.value.loading) {
    loadMore()
  }
}

function prevPreviewItem(e) {
  e?.stopPropagation()
  const now = Date.now()
  if (now - lastNavTime < 80) return
  lastNavTime = now

  const list = currentTask.value?.results || []
  if (!list.length) return
  const cur = previewIndex.value
  if (cur > 0) {
    openPreview(list[cur - 1])
  }
}

/* ================== 键盘快捷键 (F / S / O / Esc / 方向键) ================== */
function onGlobalKeyDown(e) {
  if (!isOpen.value) return
  const tag = (e.target?.tagName || '').toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return

  const k = e.key.toUpperCase()

  // 1. 灯箱大图预览态快捷键
  if (previewItem.value) {
    if (k === 'ESCAPE' || k === ' ') {
      e.preventDefault()
      closePreview()
      return
    }
    if (e.key === 'ArrowLeft' || k === 'A') {
      e.preventDefault()
      prevPreviewItem()
      return
    }
    if (e.key === 'ArrowRight' || k === 'D') {
      e.preventDefault()
      nextPreviewItem()
      return
    }
    if (k === 'F') {
      e.preventDefault()
      researchItem(previewItem.value)
      return
    }
    if (k === 'S') {
      e.preventDefault()
      saveItem(previewItem.value)
      return
    }
    if (k === 'O') {
      e.preventDefault()
      openSource(previewItem.value)
      return
    }
    if (k === 'R') {
      e.preventDefault()
      reloadCurrentPreview()
      return
    }
    return
  }

  // 2. 主视窗快捷键 (支持 R / F5 / Ctrl+R 无白屏刷新当前任务)
  if (k === 'ESCAPE') {
    e.preventDefault()
    lib.closeVisualSearch()
    return
  }

  if (k === 'R' || e.key === 'F5' || (e.ctrlKey && k === 'R')) {
    e.preventDefault()
    if (currentTask.value) {
      triggerSearch(currentTask.value, false, true)
    }
    return
  }

  // 悬停卡片时的快捷键
  if (hoveredItem.value) {
    if (k === 'F') {
      e.preventDefault()
      researchItem(hoveredItem.value)
      return
    }
    if (k === 'S') {
      e.preventDefault()
      saveItem(hoveredItem.value)
      return
    }
    if (k === 'O') {
      e.preventDefault()
      openSource(hoveredItem.value)
      return
    }
    if (k === ' ') {
      e.preventDefault()
      openPreview(hoveredItem.value)
      return
    }
  }

  // 队列快速切换 (上/下键)
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const tasks = vs.value.tasks
    if (tasks.length <= 1) return
    const curIdx = tasks.findIndex((t) => t.id === vs.value.activeTaskId)
    const nextIdx = e.key === 'ArrowUp'
      ? (curIdx - 1 + tasks.length) % tasks.length
      : (curIdx + 1) % tasks.length
    e.preventDefault()
    selectTask(tasks[nextIdx])
  }
}

// Ctrl + 滚轮无极缩放瀑布流卡片 (对齐 Eagle 原生插件交互规范)
function onWindowWheel(e) {
  if (!isOpen.value || previewItem.value) return
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault()
    e.stopPropagation()
    const step = Math.max(-40, Math.min(40, e.deltaY))
    scale.value = Math.max(160, Math.min(520, scale.value - step))
  }
}

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeyDown)
  window.addEventListener('wheel', onWindowWheel, { passive: false })
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeyDown)
  window.removeEventListener('wheel', onWindowWheel)
  waterfallResizeObserver?.disconnect()
  if (isAlwaysOnTop.value) {
    api.setAlwaysOnTop(false).catch(() => {})
  }
})
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="vs-modal-mask">
      <div class="vs-window glass-card">
        
        <!-- 顶栏控制区 -->
        <header class="vs-topbar">
          <div class="topbar-left" data-no-drag>
            <svg class="app-icon-svg" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="17" x2="12" y2="22"/>
              <path d="M5 17h14v-2l-2-3V5a2 2 0 0 0-2-2h-6a2 2 0 0 0-2 2v7l-2 3v2z"/>
            </svg>
            <span class="app-title">Pinterest 以图找图</span>
          </div>

          <div class="topbar-right" data-no-drag>
            <!-- 瀑布流缩放滑块 (支持 Ctrl+滚轮) -->
            <div class="scale-box" title="调节结果卡片大小 (可按住 Ctrl 滚轮缩放)">
              <button class="scale-btn" @click="scale -= 20">-</button>
              <input type="range" min="160" max="520" step="20" v-model.number="scale" class="scale-slider" />
              <button class="scale-btn" @click="scale += 20">+</button>
            </div>

            <!-- 刷新检索 (R / F5) -->
            <button
              class="icon-btn refresh-btn"
              :class="{ spinning: currentTask?.loading }"
              title="刷新当前检索 (R / F5)"
              @click="currentTask && triggerSearch(currentTask, false, true)"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="23 4 23 10 17 10"/>
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
              </svg>
            </button>

            <!-- 置顶图钉 (纯单色无固有色 SVG) -->
            <button
              class="icon-btn pin-btn"
              :class="{ active: isAlwaysOnTop }"
              :title="isAlwaysOnTop ? '取消置顶' : '置顶窗口（便于对照绘图）'"
              @click="toggleAlwaysOnTop"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="17" x2="12" y2="22"/>
                <path d="M5 17h14v-2l-2-3V5a2 2 0 0 0-2-2h-6a2 2 0 0 0-2 2v7l-2 3v2z"/>
              </svg>
            </button>

            <!-- 队列计数 -->
            <span class="queue-counter" v-if="vs.tasks.length">
              队列 {{ vs.tasks.length }} 张
            </span>

            <!-- 关闭按钮 -->
            <button class="close-btn" title="关闭 (Esc)" @click="lib.closeVisualSearch()">
              ✕
            </button>
          </div>
        </header>

        <!-- 主体三栏视窗 -->
        <div class="vs-body">
          
          <!-- 左栏：多图排队队列 (QueueSidebar, ~72px) -->
          <aside
            class="queue-sidebar"
            :class="{ 'drop-active': isQueueDraggingOver }"
            @dragover.prevent="isQueueDraggingOver = true"
            @dragleave.prevent="isQueueDraggingOver = false"
            @drop.prevent="onQueueDrop"
          >
            <div class="queue-list">
              <div
                v-for="task in vs.tasks"
                :key="task.id"
                class="queue-item"
                :class="{ active: task.id === currentTask?.id }"
                @click="selectTask(task)"
                :title="task.name"
              >
                <img v-if="task.thumbUrl || task.dataUrl" :src="task.thumbUrl || task.dataUrl" class="queue-thumb" />
                <div v-else class="queue-thumb queue-thumb-fallback">
                  <span class="fallback-icon">{{ getTaskBadge(task) || 'IMG' }}</span>
                </div>
                <!-- 左上角格式小标 (PSD / GIF / MP4 / WEBP 等，对齐 Eagle 设计) -->
                <span v-if="getTaskBadge(task)" class="queue-format-badge">{{ getTaskBadge(task) }}</span>
                <button class="queue-del-btn" title="移出队列" @click="removeTask(task, $event)">✕</button>
                <div v-if="task.loading" class="queue-spinner" />
              </div>

              <!-- 添加图片/视频/PSD按钮 -->
              <button class="queue-add-btn" title="添加图片/视频/PSD至队列" @click="openFilePicker">
                ＋
              </button>
              <input
                ref="fileInputRef"
                type="file"
                multiple
                accept="image/*,video/*,.psd,.webp,.gif,.mp4,.webm,.mov,.mkv,.avi,.flv"
                style="display: none"
                @change="onFilePicked"
              />
            </div>
          </aside>

          <!-- 中栏：原图与局部框选 (CropViewport, 自适应图片尺寸，杜绝黑边干扰) -->
          <section class="crop-viewport">
            <div class="viewport-card">
              <div class="crop-stage-wrapper">
                <div v-if="currentTask" class="crop-container" ref="cropContainerRef">
                  <!-- 视口左上角格式小标 -->
                  <span v-if="getTaskBadge(currentTask)" class="crop-format-badge">{{ getTaskBadge(currentTask) }}</span>
                  <img
                    v-if="currentTask.thumbUrl || currentTask.dataUrl"
                    ref="cropImgRef"
                    :src="currentTask.thumbUrl || currentTask.dataUrl"
                    class="query-img"
                    @load="onImageLoaded"
                    @dragstart.prevent
                  />
                  <div v-else class="query-loading-placeholder">
                    <div class="queue-spinner" />
                    <span>{{ getTaskBadge(currentTask) ? `${getTaskBadge(currentTask)} 画面解析中…` : '图片加载中…' }}</span>
                  </div>

                  <!-- 裁剪框与外围遮罩 -->
                  <div
                    class="crop-mask"
                    :style="{
                      clipPath: `polygon(
                        0 0, 100% 0, 100% 100%, 0 100%, 0 0,
                        ${bbox[0] * 100}% ${bbox[1] * 100}%,
                        ${bbox[0] * 100}% ${(bbox[1] + bbox[3]) * 100}%,
                        ${(bbox[0] + bbox[2]) * 100}% ${(bbox[1] + bbox[3]) * 100}%,
                        ${(bbox[0] + bbox[2]) * 100}% ${bbox[1] * 100}%,
                        ${bbox[0] * 100}% ${bbox[1] * 100}%
                      )`
                    }"
                  />

                  <!-- 裁剪选区矩形与手柄 -->
                  <div
                    class="crop-rect"
                    :style="{
                      left: `${bbox[0] * 100}%`,
                      top: `${bbox[1] * 100}%`,
                      width: `${bbox[2] * 100}%`,
                      height: `${bbox[3] * 100}%`
                    }"
                    @mousedown="startDrag('move', $event)"
                  >
                    <!-- 4 角手柄 -->
                    <span class="handle nw" @mousedown="startDrag('nw', $event)" />
                    <span class="handle ne" @mousedown="startDrag('ne', $event)" />
                    <span class="handle sw" @mousedown="startDrag('sw', $event)" />
                    <span class="handle se" @mousedown="startDrag('se', $event)" />
                    <!-- 4 边手柄 -->
                    <span class="handle n" @mousedown="startDrag('n', $event)" />
                    <span class="handle s" @mousedown="startDrag('s', $event)" />
                    <span class="handle w" @mousedown="startDrag('w', $event)" />
                    <span class="handle e" @mousedown="startDrag('e', $event)" />
                  </div>
                </div>

                <div v-else class="empty-query">
                  从左侧选择或拖入图片
                </div>
              </div>

              <!-- 选区控制栏 -->
              <div class="crop-actions">
                <button
                  class="action-pill"
                  :class="{ active: bbox[0] === 0 && bbox[1] === 0 && bbox[2] === 1 && bbox[3] === 1 }"
                  @click="resetBbox"
                  title="恢复搜索整张图片"
                >
                  全图
                </button>
                <span class="res-text" v-if="currentTask?.width && currentTask?.height">
                  <b v-if="getTaskBadge(currentTask)" class="format-tag">{{ getTaskBadge(currentTask) }}</b>
                  {{ currentTask.width }} × {{ currentTask.height }}
                </span>
                <span class="status-text" v-if="currentTask?.loading">
                  检索中…
                </span>
              </div>

              <!-- 任务标题/文件名 -->
              <div class="task-info" v-if="currentTask">
                <span class="task-name" :title="currentTask.name">{{ currentTask.name }}</span>
              </div>
            </div>
          </section>

          <!-- 右栏：瀑布流结果与卡片 (ResultWaterfall, flex-1) -->
          <main class="waterfall-container" ref="waterfallEl" @scroll.passive="onWaterfallScroll">
            <!-- 渐进式刷新顶部流动进度条 (对齐 Eagle 原生交互，无白屏跳动) -->
            <div v-if="currentTask?.loading" class="waterfall-top-progress">
              <div class="progress-bar-glow" />
            </div>

            <!-- 加载态骨架屏 (仅首次空数据时展示，对齐列排布) -->
            <div v-if="currentTask?.loading && !currentTask.results?.length" class="waterfall-columns">
              <div v-for="c in columnCount" :key="c" class="waterfall-col">
                <div v-for="i in 3" :key="i" class="skeleton-card" :style="{ aspectRatio: (1 / (1.2 + ((i + c) % 3) * 0.3)).toString() }" />
              </div>
            </div>

            <!-- 错误提示 -->
            <div v-else-if="currentTask?.error" class="error-box">
              <div class="error-icon">⚠️</div>
              <div class="error-msg">{{ currentTask.error }}</div>
              <button class="retry-btn" @click="triggerSearch(currentTask, false, true)">重新检索</button>
            </div>

            <!-- 空结果提示 -->
            <div v-else-if="!currentTask?.loading && !currentTask?.results?.length" class="empty-box">
              <div class="empty-icon">🎨</div>
              <div class="empty-msg">未找到相似结果，请尝试调整框选区域或换张图片</div>
            </div>

            <!-- 结果瀑布流 (确定性贪心分列，杜绝 CSS Multi-column 重排乱跳与位置篡改) -->
            <div
              v-else
              class="waterfall-columns"
              :class="{ 'waterfall-refreshing': currentTask?.loading && currentTask?.results?.length }"
            >
              <div
                v-for="(col, colIdx) in columnData"
                :key="colIdx"
                class="waterfall-col"
              >
                <div
                  v-for="item in col"
                  :key="item.id"
                  class="waterfall-card"
                  @mouseenter="hoveredItem = item"
                  @mouseleave="hoveredItem = null"
                  @click="openPreview(item)"
                >
                  <div
                    class="card-media"
                    :style="{ aspectRatio: `${item.width || 474} / ${item.height || 600}` }"
                  >
                    <img :src="item.thumbUrl" class="card-img" loading="lazy" />

                    <!-- 已保存徽标 -->
                    <span v-if="item.saved" class="saved-badge">
                      ✓ 已入库
                    </span>

                    <!-- 悬停操作浮层（上部点击开大图，底部全宽自适应操作条） -->
                    <div class="card-overlay">
                      <div class="card-preview-zone" @click="openPreview(item)" />
                      <div class="card-actions-bar" @click.stop>
                        <!-- 1. 保存到未分类 (S) -->
                        <button
                          class="card-action-btn"
                          :class="{ saved: item.saved }"
                          :disabled="item.saved || savingMap[item.id]"
                          @click="saveItem(item, $event)"
                        >
                          <svg v-if="savingMap[item.id]" class="dock-svg spin" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/></svg>
                          <svg v-else-if="item.saved" class="dock-svg ok" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                          <svg v-else class="dock-svg" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                          <span class="dock-tooltip">{{ item.saved ? '已存入未分类' : '保存 S' }}</span>
                        </button>

                        <i class="card-action-vsep" />

                        <!-- 2. 以图找图 (F) -->
                        <button
                          class="card-action-btn"
                          @click="researchItem(item, $event)"
                        >
                          <svg class="dock-svg" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M4 8V4h4"/><path d="M20 8V4h-4"/><path d="M4 16v4h4"/><path d="M20 16v4h-4"/>
                            <circle cx="11.5" cy="11.5" r="3.2"/><line x1="13.8" y1="13.8" x2="18" y2="18"/>
                          </svg>
                          <span class="dock-tooltip">以图找图 F</span>
                        </button>

                        <i class="card-action-vsep" v-if="item.sourceUrl" />

                        <!-- 3. 在浏览器中打开原网页 (O) -->
                        <button
                          v-if="item.sourceUrl"
                          class="card-action-btn"
                          @click="openSource(item, $event)"
                        >
                          <svg class="dock-svg" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                          </svg>
                          <span class="dock-tooltip">在 Pinterest 打开 O</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 滚动流式加载指示器 -->
            <div v-if="currentTask?.loading && currentTask?.results?.length" class="loading-more-hint">
              正在加载更多相似图片…
            </div>
          </main>
        </div>

        <!-- 灯箱大图预览层 (去旋转翻转裁剪，靠底悬浮展开，纯净单色图标与快捷键气泡) -->
        <div
          v-if="previewItem"
          class="preview-lightbox-layer"
          :class="{ 'dock-show': isDockHover }"
          @mousemove="onLightboxPointerMove"
          @wheel.prevent="onPreviewWheel"
          @click.self="closePreview"
        >
          <!-- 顶栏信息与返回条 (退出进入左上角作为返回上一级，右上角放纯单色图钉) -->
          <div class="lightbox-topbar">
            <div class="topbar-info" data-no-drag>
              <!-- 左上角返回上一级按钮 -->
              <button class="topbar-back-btn" title="返回上一级 (Esc / 空格)" @click="closePreview">
                <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="19" y1="12" x2="5" y2="12"/>
                  <polyline points="12 19 5 12 12 5"/>
                </svg>
                <span class="back-text">返回</span>
              </button>
              <i class="topbar-vsep" />
              <span class="index-pill" v-if="previewIndex >= 0">
                {{ previewIndex + 1 }} / {{ currentTask?.results?.length || 0 }}
              </span>
              <span class="res-pill" v-if="previewNatW && previewNatH">
                {{ previewNatW }} × {{ previewNatH }}
              </span>
              <span
                class="zoom-pill"
                title="双击图片或点击此处在 100% / 适应之间切换"
                @click="togglePreviewZoom"
              >
                {{ Math.round(previewZoom * 100) }}%
              </span>
              <span class="title-text" :title="previewItem.title">{{ previewItem.title || '灵感预览' }}</span>
            </div>
            <div class="topbar-actions" data-no-drag>
              <!-- 重新载入大图 (R) -->
              <button
                class="topbar-pin-btn"
                title="重新载入高清原图 (R)"
                @click="reloadCurrentPreview"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="23 4 23 10 17 10"/>
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                </svg>
              </button>

              <!-- 右上角不带固有色的置顶图钉 -->
              <button
                class="topbar-pin-btn"
                :class="{ active: isAlwaysOnTop }"
                :title="isAlwaysOnTop ? '取消置顶' : '置顶窗口（便于对照绘图）'"
                @click="toggleAlwaysOnTop"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="12" y1="17" x2="12" y2="22"/>
                  <path d="M5 17h14v-2l-2-3V5a2 2 0 0 0-2-2h-6a2 2 0 0 0-2 2v7l-2 3v2z"/>
                </svg>
              </button>
            </div>
          </div>

          <!-- 视图中心平移与缩放舞台 (双层渐进加载：底层缩略图瞬显杜绝黑屏，顶层原图淡入覆盖) -->
          <div
            class="lightbox-stage"
            :class="{ panning: isPreviewPanning }"
            @mousedown="onPreviewMouseDown"
            @dblclick="togglePreviewZoom"
          >
            <div
              class="lightbox-img-wrapper"
              :style="{
                transform: `translate3d(${previewTx}px, ${previewTy}px, 0) scale(${previewZoom})`
              }"
            >
              <!-- 底层：已在瀑布流缓存的缩略图，0ms 瞬显 -->
              <img
                :src="previewItem.thumbUrl"
                class="lightbox-layer-thumb"
                @dragstart.prevent
              />
              <!-- 顶层：异步原图/大图，加载完成平滑淡入覆盖 -->
              <img
                ref="previewImgRef"
                :src="previewItem.largeUrl || previewItem.origUrl || previewItem.thumbUrl"
                class="lightbox-layer-highres"
                :class="{ loaded: isHighResLoaded }"
                @load="onPreviewHighResLoad"
                @error="onPreviewHighResError"
                @dragstart.prevent
              />
            </div>
          </div>

          <!-- 底部悬浮工具坞 (参考 PicNest 灯箱极简单色图标，靠近展开，居中减少鼠标位移) -->
          <div class="lightbox-dock glass-pill" @mouseenter="isDockHover = true">
            <!-- 1. 保存到未分类 (S) -->
            <button
              class="dock-action-btn"
              :class="{ saved: previewItem.saved }"
              :disabled="previewItem.saved || savingMap[previewItem.id]"
              @click="saveItem(previewItem)"
            >
              <svg v-if="savingMap[previewItem.id]" class="dock-svg spin" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/></svg>
              <svg v-else-if="previewItem.saved" class="dock-svg ok" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              <svg v-else class="dock-svg" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              <span class="dock-tooltip">{{ previewItem.saved ? '已存入未分类' : '保存到未分类 S' }}</span>
            </button>

            <!-- 2. 以图找图 (F) -->
            <button class="dock-action-btn" @click="researchItem(previewItem)">
              <svg class="dock-svg" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 8V4h4"/><path d="M20 8V4h-4"/><path d="M4 16v4h4"/><path d="M20 16v4h-4"/>
                <circle cx="11.5" cy="11.5" r="3.2"/><line x1="13.8" y1="13.8" x2="18" y2="18"/>
              </svg>
              <span class="dock-tooltip">以图找图 F</span>
            </button>

            <!-- 3. 在 Pinterest 打开 (O) -->
            <button v-if="previewItem.sourceUrl" class="dock-action-btn" @click="openSource(previewItem)">
              <svg class="dock-svg" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
              </svg>
              <span class="dock-tooltip">在 Pinterest 打开 O</span>
            </button>

            <i class="dock-vsep" />

            <!-- 4. 上一张 (A / ←) -->
            <button
              class="dock-action-btn"
              :disabled="previewIndex <= 0"
              @click.stop="prevPreviewItem"
            >
              <svg class="dock-svg" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
              <span class="dock-tooltip">上一张 A</span>
            </button>

            <!-- 5. 下一张 (D / →) -->
            <button
              class="dock-action-btn"
              :disabled="previewIndex >= (currentTask?.results?.length || 0) - 1 && !currentTask?.bookmark"
              @click.stop="nextPreviewItem"
            >
              <svg class="dock-svg" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
              <span class="dock-tooltip">下一张 D</span>
            </button>

            <i class="dock-vsep" />

            <!-- 6. 退出预览 (Esc / 空格) -->
            <button class="dock-action-btn" @click="closePreview">
              <svg class="dock-svg" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
              <span class="dock-tooltip">退出预览 Esc</span>
            </button>
          </div>
        </div>

      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.vs-modal-mask {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.68);
  backdrop-filter: blur(14px);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: fadeIn 0.15s ease-out;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.vs-window {
  width: 92vw;
  max-width: 1560px;
  height: 88vh;
  min-height: 640px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: var(--shadow-float);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--text);
}

/* 顶栏控制区 */
.vs-topbar {
  height: 52px;
  padding: 0 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  user-select: none;
  -webkit-app-region: drag; /* 接入 Windows 原生窗口拖拽移动循环 */
}

.vs-topbar button,
.vs-topbar input,
.vs-topbar .scale-box,
.vs-topbar [data-no-drag] {
  -webkit-app-region: no-drag;
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.app-icon-svg {
  color: var(--accent);
}

.app-title {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.3px;
  color: var(--text);
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.scale-box {
  display: flex;
  align-items: center;
  background: var(--bg-2);
  border-radius: 6px;
  padding: 2px 6px;
  gap: 6px;
  border: 1px solid var(--border);
}

.scale-btn {
  background: transparent;
  border: none;
  color: var(--text-2);
  cursor: pointer;
  padding: 0 4px;
  font-size: 14px;
  line-height: 1;
}

.scale-slider {
  width: 90px;
  height: 4px;
  accent-color: var(--accent);
  cursor: pointer;
}

.icon-btn {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
  color: var(--text-2);
  cursor: pointer;
  font-size: 13px;
  transition: all 0.15s;
}

.icon-btn:hover {
  background: var(--accent-weak);
  color: var(--accent);
}

.icon-btn.active {
  background: var(--accent-weak);
  color: var(--accent);
  border-color: var(--accent);
}

.refresh-btn.spinning svg {
  animation: spin 0.8s linear infinite;
}

.queue-counter {
  font-size: 12px;
  color: var(--text-2);
  background: var(--bg-2);
  padding: 3px 8px;
  border-radius: 12px;
  border: 1px solid var(--border);
}

.close-btn {
  background: transparent;
  border: none;
  color: var(--text-2);
  font-size: 16px;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
}

.close-btn:hover {
  background: rgba(239, 68, 68, 0.18);
  color: #ef4444;
}

/* 主体三栏布局 */
.vs-body {
  flex: 1;
  display: flex;
  overflow: hidden;
}

/* 左栏：队列 (QueueSidebar, ~72px) */
.queue-sidebar {
  width: 72px;
  border-right: 1px solid var(--border);
  background: var(--bg);
  overflow-y: auto;
  padding: 10px 8px;
  transition: background 0.15s;
}

.queue-sidebar.drop-active {
  background: var(--accent-weak);
}

.queue-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
}

.queue-item {
  position: relative;
  width: 52px;
  height: 52px;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  border: 2px solid transparent;
  transition: all 0.15s ease;
  background: var(--bg-2);
  box-shadow: var(--shadow-tile);
}

.queue-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.queue-thumb-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-hover, rgba(255, 255, 255, 0.06));
}

.fallback-icon {
  font-family: var(--font-mono, Consolas, monospace);
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted);
}

.queue-format-badge {
  position: absolute;
  top: 3px;
  left: 3px;
  z-index: 2;
  padding: 1px 4px;
  font-family: var(--font-mono, Consolas, monospace);
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.4px;
  color: rgba(255, 255, 255, 0.95);
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 3px;
  pointer-events: none;
}

.crop-format-badge {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 5;
  padding: 2px 6px;
  font-family: var(--font-mono, Consolas, monospace);
  font-size: 10.5px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.5px;
  color: rgba(255, 255, 255, 0.95);
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  pointer-events: none;
}

.format-tag {
  font-family: var(--font-mono, Consolas, monospace);
  font-size: 10px;
  font-weight: 700;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--bg-hover, rgba(255, 255, 255, 0.08));
  border: 1px solid var(--border);
  margin-right: 4px;
}

.query-loading-placeholder {
  width: 100%;
  height: 240px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-muted);
  font-size: 12px;
}

.queue-item:hover {
  transform: scale(1.04);
}

.queue-item.active {
  border-color: var(--accent);
  box-shadow: 0 0 10px var(--accent-weak);
}

.queue-del-btn {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  border: none;
  font-size: 10px;
  display: none;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.queue-item:hover .queue-del-btn {
  display: flex;
}

.queue-del-btn:hover {
  background: #ef4444;
}

.queue-spinner {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  border: 2px solid var(--accent);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.queue-add-btn {
  width: 52px;
  height: 52px;
  border-radius: 8px;
  border: 1px dashed var(--border);
  background: transparent;
  color: var(--text-2);
  font-size: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s;
}

.queue-add-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-weak);
}

/* 中栏：原图与框选 (CropViewport, 弹性宽度与自适应尺寸) */
.crop-viewport {
  width: 380px;
  min-width: 300px;
  max-width: 480px;
  border-right: 1px solid var(--border);
  background: var(--bg-2);
  display: flex;
  flex-direction: column;
  padding: 14px;
  flex-shrink: 0;
}

.viewport-card {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.crop-stage-wrapper {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  user-select: none;
  background: transparent;
}

.crop-container {
  position: relative;
  display: inline-block;
  line-height: 0;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: var(--shadow-float);
  max-width: 100%;
  max-height: 100%;
}

.query-img {
  display: block;
  max-width: 100%;
  max-height: calc(88vh - 160px);
  width: auto;
  height: auto;
  object-fit: contain;
  border-radius: 8px;
  pointer-events: none;
}

/* 裁剪遮罩与矩形框 */
.crop-mask {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.62);
  pointer-events: none;
}

.crop-rect {
  position: absolute;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4), inset 0 0 0 1px rgba(0, 0, 0, 0.4);
  cursor: move;
  box-sizing: border-box;
}

/* 手柄定义 */
.handle {
  position: absolute;
  width: 12px;
  height: 12px;
  background: #fff;
  border: 1px solid #000;
  border-radius: 2px;
}

.handle.nw { top: -6px; left: -6px; cursor: nwse-resize; }
.handle.ne { top: -6px; right: -6px; cursor: nesw-resize; }
.handle.sw { bottom: -6px; left: -6px; cursor: nesw-resize; }
.handle.se { bottom: -6px; right: -6px; cursor: nwse-resize; }

.handle.n { top: -6px; left: calc(50% - 6px); cursor: ns-resize; }
.handle.s { bottom: -6px; left: calc(50% - 6px); cursor: ns-resize; }
.handle.w { left: -6px; top: calc(50% - 6px); cursor: ew-resize; }
.handle.e { right: -6px; top: calc(50% - 6px); cursor: ew-resize; }

.crop-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-2);
}

.action-pill {
  background: var(--panel);
  border: 1px solid var(--border);
  color: var(--text-2);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.action-pill:hover,
.action-pill.active {
  background: var(--accent-weak);
  color: var(--accent);
  border-color: var(--accent);
}

.res-text {
  font-family: monospace;
}

.task-info {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 右栏：结果瀑布流 (确定性贪心分列，杜绝 CSS Multi-column 重排与跳动) */
.waterfall-container {
  flex: 1;
  position: relative;
  overflow-y: auto;
  padding: 16px;
  background: var(--bg-2);
}

/* 渐进式刷新顶部流动进度条 (对齐 Eagle 原生交互规范) */
.waterfall-top-progress {
  position: sticky;
  top: -16px;
  left: -16px;
  right: -16px;
  margin: -16px -16px 12px -16px;
  height: 2.5px;
  background: rgba(255, 255, 255, 0.05);
  overflow: hidden;
  z-index: 30;
}

.progress-bar-glow {
  width: 45%;
  height: 100%;
  background: linear-gradient(90deg, transparent, var(--accent, #6366f1), transparent);
  animation: progressGlow 1.2s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}

@keyframes progressGlow {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(300%); }
}

.waterfall-columns {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  width: 100%;
  transition: opacity 0.25s ease;
}

.waterfall-columns.waterfall-refreshing {
  opacity: 0.82;
  filter: saturate(0.92);
}

.waterfall-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.waterfall-card {
  width: 100%;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  cursor: pointer;
  box-shadow: var(--shadow-tile);
  transition: transform 0.22s cubic-bezier(0.2, 0.9, 0.3, 1), box-shadow 0.22s ease, border-color 0.18s;
  position: relative;
}

.waterfall-card:hover {
  transform: translateY(-4px);
  box-shadow: var(--shadow-tile-hover);
  border-color: var(--accent);
}

.card-media {
  position: relative;
  width: 100%;
  overflow: hidden;
  background: rgba(128, 128, 128, 0.08);
}

.card-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.3s ease;
}

.waterfall-card:hover .card-img {
  transform: scale(1.02);
}

.saved-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  font-size: 10.5px;
  padding: 3px 8px;
  border-radius: 6px;
  background: rgba(16, 185, 129, 0.92);
  color: #fff;
  font-weight: 500;
  box-shadow: 0 2px 8px rgba(16, 185, 129, 0.4);
  backdrop-filter: blur(4px);
  z-index: 2;
}

/* 悬停浮层：上部大图预览区，底部全宽自适应操作条 (对齐 Eagle 原生交互规范，随卡片缩放自动等分延展) */
.card-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  opacity: 0;
  transition: opacity 0.16s ease-in-out;
  pointer-events: none;
}

.waterfall-card:hover .card-overlay {
  opacity: 1;
  pointer-events: auto;
}

.card-preview-zone {
  flex: 1;
  width: 100%;
  cursor: pointer;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.02) 50%, rgba(0, 0, 0, 0.28) 100%);
}

.card-actions-bar {
  height: 44px;
  width: 100%;
  display: flex;
  align-items: center;
  background: linear-gradient(to top, rgba(14, 14, 20, 0.94) 0%, rgba(14, 14, 20, 0.78) 100%);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border-top: 1px solid rgba(255, 255, 255, 0.12);
  overflow: visible;
  position: relative;
}

.card-action-btn {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.88);
  cursor: pointer;
  position: relative;
  transition: background 0.15s ease, color 0.15s ease;
  padding: 0;
}

.card-action-btn:hover {
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
}

.card-action-btn:active {
  background: rgba(255, 255, 255, 0.22);
}

.card-action-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.card-action-btn.saved {
  color: #34d399;
}

.card-action-btn .dock-svg {
  width: 18px;
  height: 18px;
}

.card-action-vsep {
  width: 1px;
  height: 20px;
  background: rgba(255, 255, 255, 0.12);
  flex-shrink: 0;
}

.card-action-btn .dock-tooltip {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%) translateY(4px);
  background: rgba(10, 10, 14, 0.92);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  color: #fff;
  font-size: 11px;
  padding: 4px 8px;
  border-radius: 4px;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: all 0.15s ease;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.1);
  z-index: 10;
}

.card-action-btn:hover .dock-tooltip {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

/* 骨架屏 */
.skeleton-card {
  width: 100%;
  background: var(--panel);
  border-radius: 12px;
  position: relative;
  overflow: hidden;
}

.skeleton-card::after {
  content: '';
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.08), transparent);
  animation: shimmer 1.4s infinite;
}

@keyframes shimmer {
  100% { transform: translateX(100%); }
}

/* 空态与错误态 */
.empty-box,
.error-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 60%;
  color: var(--text-2);
  gap: 10px;
}

.empty-icon,
.error-icon {
  font-size: 44px;
}

.retry-btn {
  background: var(--accent);
  border: none;
  color: #fff;
  border-radius: 6px;
  padding: 6px 14px;
  font-size: 13px;
  cursor: pointer;
  transition: opacity 0.15s;
}

.retry-btn:hover {
  opacity: 0.9;
}

.load-more-box {
  display: flex;
  justify-content: center;
  margin-top: 24px;
  margin-bottom: 12px;
}

.load-more-btn {
  background: var(--panel);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 8px 20px;
  border-radius: 20px;
  cursor: pointer;
  font-size: 13px;
  transition: all 0.15s;
}

.load-more-btn:hover {
  background: var(--accent-weak);
  border-color: var(--accent);
  color: var(--accent);
}

.loading-more-hint {
  text-align: center;
  color: var(--text-2);
  font-size: 13px;
  margin-top: 16px;
}

/* ================== 灯箱大图预览层 (去旋转翻转裁剪，沉浸平移缩放、切图、搜图与存库) ================== */
.preview-lightbox-layer {
  position: fixed;
  inset: 0;
  z-index: 10000;
  background: rgba(0, 0, 0, 0.82);
  backdrop-filter: blur(20px);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  user-select: none;
  animation: fadeIn 0.14s ease-out;
}

/* 顶栏信息与关闭条 */
.lightbox-topbar {
  position: absolute;
  top: 16px;
  left: 20px;
  right: 20px;
  z-index: 10;
  display: flex;
  justify-content: space-between;
  align-items: center;
  pointer-events: none;
}

.topbar-info {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  background: rgba(18, 18, 24, 0.65);
  backdrop-filter: blur(14px);
  padding: 6px 14px;
  border-radius: 20px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #f3f4f6;
  font-size: 13px;
}

.index-pill {
  font-weight: 600;
  color: #fff;
}

.res-pill {
  font-family: monospace;
  opacity: 0.75;
  font-size: 12px;
}

.zoom-pill {
  font-family: monospace;
  font-size: 12px;
  background: rgba(255, 255, 255, 0.1);
  padding: 1px 7px;
  border-radius: 6px;
  color: #60a5fa;
  cursor: pointer;
  transition: all 0.15s;
  user-select: none;
}

.zoom-pill:hover {
  background: rgba(59, 130, 246, 0.25);
  color: #93c5fd;
  transform: translateY(-1px);
}

.title-text {
  max-width: 480px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.9;
}

/* 顶栏信息与返回条 (退出进入左上角作为返回上一级，右上角放纯单色图钉) */
.lightbox-topbar {
  position: absolute;
  top: 16px;
  left: 20px;
  right: 20px;
  z-index: 10;
  display: flex;
  justify-content: space-between;
  align-items: center;
  pointer-events: none;
  -webkit-app-region: drag; /* 支持大图顶栏拖拽窗口 */
}

.lightbox-topbar .topbar-info,
.lightbox-topbar .topbar-actions,
.lightbox-topbar button,
.lightbox-topbar [data-no-drag] {
  pointer-events: auto;
  -webkit-app-region: no-drag;
}

.topbar-back-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: transparent;
  border: none;
  color: #f3f4f6;
  cursor: pointer;
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  transition: all 0.15s;
}

.topbar-back-btn:hover {
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
  transform: translateX(-1px);
}

.back-text {
  font-size: 13px;
  line-height: 1;
}

.topbar-vsep {
  width: 1px;
  height: 14px;
  background: rgba(255, 255, 255, 0.18);
  margin: 0 2px;
}

.topbar-pin-btn {
  background: rgba(18, 18, 24, 0.65);
  backdrop-filter: blur(14px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.85);
  border-radius: 50%;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s;
}

.topbar-pin-btn:hover {
  background: rgba(255, 255, 255, 0.2);
  transform: scale(1.06);
}

.topbar-pin-btn.active {
  background: var(--accent-weak);
  color: var(--accent);
  border-color: var(--accent);
  box-shadow: 0 0 10px var(--accent-weak);
}

/* 舞台与大图 (双层渐进加载：底层缩略图瞬显杜绝黑屏，顶层原图淡入覆盖) */
.lightbox-stage {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  cursor: grab;
}

.lightbox-stage.panning {
  cursor: grabbing;
}

.lightbox-img-wrapper {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  max-width: 90vw;
  max-height: 86vh;
  border-radius: 8px;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.65);
  transform-origin: center center;
  transition: transform 0.15s cubic-bezier(0.2, 0.9, 0.3, 1);
  user-select: none;
}

.lightbox-stage.panning .lightbox-img-wrapper {
  transition: none !important;
}

.lightbox-layer-thumb {
  max-width: 90vw;
  max-height: 86vh;
  width: auto;
  height: auto;
  object-fit: contain;
  border-radius: 8px;
  pointer-events: none;
  display: block;
  z-index: 1;
}

.lightbox-layer-highres {
  position: absolute;
  inset: 0;
  margin: auto;
  max-width: 90vw;
  max-height: 86vh;
  width: 100%;
  height: 100%;
  object-fit: contain;
  border-radius: 8px;
  pointer-events: none;
  opacity: 0;
  z-index: 2;
  transition: opacity 0.22s cubic-bezier(0.2, 0, 0, 1);
}

.lightbox-layer-highres.loaded {
  opacity: 1;
}

/* 底部悬浮工具坞 (尺寸放大，纯净单色图标与快捷键气泡，靠近展开) */
.lightbox-dock {
  position: absolute;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%) translateY(12px) scale(0.96);
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 5px;
  background: rgba(18, 18, 24, 0.78);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.5);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.35s cubic-bezier(0.22, 1, 0.36, 1), transform 0.35s cubic-bezier(0.22, 1, 0.36, 1);
  user-select: none;
}

.preview-lightbox-layer.dock-show .lightbox-dock,
.lightbox-dock:hover {
  opacity: 1;
  transform: translateX(-50%) translateY(0) scale(1);
  pointer-events: auto;
}

.dock-action-btn {
  height: 38px;
  width: 42px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: rgba(255, 255, 255, 0.85);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  position: relative;
  transition: all 0.15s ease;
  padding: 0;
}

.dock-action-btn:hover {
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
  transform: translateY(-1px);
}

.dock-action-btn:active {
  transform: scale(0.92);
}

.dock-action-btn:disabled {
  opacity: 0.28;
  cursor: not-allowed;
  pointer-events: none;
}

.dock-action-btn.saved {
  color: #34d399;
}

.dock-svg {
  width: 19px;
  height: 19px;
  display: block;
}

.dock-svg.spin {
  animation: spin 0.8s linear infinite;
}

.dock-svg.ok {
  color: #34d399;
}

.dock-vsep {
  width: 1px;
  height: 18px;
  background: rgba(255, 255, 255, 0.14);
  margin: 0 4px;
}

/* 按钮悬浮气泡 Tooltip (对齐图二极简黑底圆角) */
.dock-tooltip {
  position: absolute;
  bottom: calc(100% + 9px);
  left: 50%;
  transform: translateX(-50%) translateY(4px);
  background: rgba(16, 16, 22, 0.95);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: #f3f4f6;
  font-size: 11.5px;
  padding: 4px 9px;
  border-radius: 6px;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.14s ease, transform 0.14s ease;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
  z-index: 60;
}

.dock-action-btn:hover .dock-tooltip {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
</style>
