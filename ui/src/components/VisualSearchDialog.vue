<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useLibrary } from '../stores/library'
import { api, fileUrl } from '../api'

const lib = useLibrary()
const vs = computed(() => lib.visualSearch)
const isOpen = computed(() => vs.value.open)

// 当前选中的搜索任务
const currentTask = computed(() => {
  if (!vs.value.tasks.length) return null
  return vs.value.tasks.find((t) => t.id === vs.value.activeTaskId) || vs.value.tasks[0]
})

// 瀑布流列宽缩放 (160px ~ 420px)
const scale = computed({
  get: () => vs.value.scale || 240,
  set: (val) => { vs.value.scale = Math.max(160, Math.min(420, Number(val))) }
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

// 任务队列操作
function selectTask(task) {
  vs.value.activeTaskId = task.id
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
watch(() => currentTask.value?.id, (newId) => {
  if (!newId || !currentTask.value) return
  bbox.value = currentTask.value.bbox ? [...currentTask.value.bbox] : [0, 0, 1, 1]
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
      currentTask.value.results = []
      currentTask.value.bookmark = null
      triggerSearch(currentTask.value)
    }
  }, 350)
}

/* ================== 网络检索与分页 ================== */
async function triggerSearch(task, continueSearch = false) {
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
      pageSize: 50
    }

    const res = await api.visualSearchQuery(opts)
    if (!res?.ok) {
      task.error = res?.error || '检索失败'
    } else {
      if (continueSearch) {
        task.results = [...(task.results || []), ...(res.items || [])]
      } else {
        task.results = res.items || []
      }
      task.bookmark = res.bookmark || null
      if (res.queryMeta) {
        if (res.queryMeta.width) task.width = res.queryMeta.width
        if (res.queryMeta.height) task.height = res.queryMeta.height
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

/* ================== 卡片动作 (F: 递归搜索 / S: 存入未分类 / O: 原网) ================== */
// F: 递归搜索
function researchItem(item, e) {
  e?.stopPropagation()
  if (!item) return
  const newTask = lib.pushVisualSearchTask({
    title: item.title || '衍生图搜',
    thumbUrl: item.thumbUrl,
    dataUrl: item.largeUrl || item.thumbUrl,
    width: item.width,
    height: item.height,
  })
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

/* ================== 灯箱大图交互 (平移缩放、滚轮缩放、左右切图、快捷键) ================== */
const previewZoom = ref(1)
const previewTx = ref(0)
const previewTy = ref(0)
const isPreviewPanning = ref(false)
const previewNatW = ref(0)
const previewNatH = ref(0)
let previewPanStart = { x: 0, y: 0, tx: 0, ty: 0 }

function resetPreviewTransform() {
  previewZoom.value = 1
  previewTx.value = 0
  previewTy.value = 0
}

function openPreview(item) {
  if (!item) return
  previewItem.value = item
  previewNatW.value = item.width || 0
  previewNatH.value = item.height || 0
  resetPreviewTransform()
}

function closePreview() {
  previewItem.value = null
  resetPreviewTransform()
}

function onPreviewImgLoad(e) {
  const img = e?.target
  if (img && img.naturalWidth && img.naturalHeight) {
    previewNatW.value = img.naturalWidth
    previewNatH.value = img.naturalHeight
  }
}

function onPreviewWheel(e) {
  e.preventDefault()
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
  const nextZoom = Math.min(10, Math.max(0.1, previewZoom.value * factor))
  previewZoom.value = Number(nextZoom.toFixed(2))
}

function onPreviewMouseDown(e) {
  if (e.button !== 0 || e.target.closest('button')) return
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

function prevPreviewItem(e) {
  e?.stopPropagation()
  const list = currentTask.value?.results || []
  if (list.length <= 1) return
  const cur = previewIndex.value
  const prevIdx = (cur - 1 + list.length) % list.length
  openPreview(list[prevIdx])
}

function nextPreviewItem(e) {
  e?.stopPropagation()
  const list = currentTask.value?.results || []
  if (list.length <= 1) return
  const cur = previewIndex.value
  const nextIdx = (cur + 1) % list.length
  openPreview(list[nextIdx])
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
    return
  }

  // 2. 主视窗快捷键
  if (k === 'ESCAPE') {
    e.preventDefault()
    lib.closeVisualSearch()
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

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeyDown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeyDown)
  if (isAlwaysOnTop.value) {
    api.setAlwaysOnTop(false).catch(() => {})
  }
})
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="vs-modal-mask" @click.self="lib.closeVisualSearch()">
      <div class="vs-window glass-card">
        
        <!-- 顶栏控制区 -->
        <header class="vs-topbar">
          <div class="topbar-left">
            <span class="app-icon">📌</span>
            <span class="app-title">Pinterest 以图找图</span>
          </div>

          <div class="topbar-right">
            <!-- 瀑布流缩放滑块 -->
            <div class="scale-box" title="调节结果卡片大小">
              <button class="scale-btn" @click="scale -= 20">-</button>
              <input type="range" min="160" max="420" step="20" v-model.number="scale" class="scale-slider" />
              <button class="scale-btn" @click="scale += 20">+</button>
            </div>

            <!-- 置顶图钉 -->
            <button
              class="icon-btn"
              :class="{ active: isAlwaysOnTop }"
              :title="isAlwaysOnTop ? '取消置顶' : '置顶窗口（便于对照绘图）'"
              @click="toggleAlwaysOnTop"
            >
              📌
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
                <img :src="task.thumbUrl || task.dataUrl" class="queue-thumb" />
                <button class="queue-del-btn" title="移出队列" @click="removeTask(task, $event)">✕</button>
                <div v-if="task.loading" class="queue-spinner" />
              </div>

              <!-- 添加图片按钮 -->
              <button class="queue-add-btn" title="添加图片至队列" @click="openFilePicker">
                ＋
              </button>
              <input
                ref="fileInputRef"
                type="file"
                multiple
                accept="image/*"
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
                  <img
                    ref="cropImgRef"
                    :src="currentTask.thumbUrl || currentTask.dataUrl"
                    class="query-img"
                    @load="onImageLoaded"
                    @dragstart.prevent
                  />

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
          <main class="waterfall-container">
            
            <!-- 加载态骨架屏 -->
            <div v-if="currentTask?.loading && !currentTask.results?.length" class="skeleton-grid" :style="{ '--col-w': scale + 'px' }">
              <div v-for="i in 8" :key="i" class="skeleton-card" :style="{ height: 180 + (i % 3) * 60 + 'px' }" />
            </div>

            <!-- 错误提示 -->
            <div v-else-if="currentTask?.error" class="error-box">
              <div class="error-icon">⚠️</div>
              <div class="error-msg">{{ currentTask.error }}</div>
              <button class="retry-btn" @click="triggerSearch(currentTask)">重新检索</button>
            </div>

            <!-- 空结果提示 -->
            <div v-else-if="!currentTask?.loading && !currentTask?.results?.length" class="empty-box">
              <div class="empty-icon">🎨</div>
              <div class="empty-msg">未找到相似结果，请尝试调整框选区域或换张图片</div>
            </div>

            <!-- 结果瀑布流 (真 CSS Masonry) -->
            <div v-else class="waterfall-grid" :style="{ '--col-w': scale + 'px' }">
              <div
                v-for="item in currentTask?.results"
                :key="item.id"
                class="waterfall-card"
                @mouseenter="hoveredItem = item"
                @mouseleave="hoveredItem = null"
                @click="openPreview(item)"
              >
                <div class="card-media">
                  <img :src="item.thumbUrl" class="card-img" loading="lazy" />

                  <!-- 已保存徽标 -->
                  <span v-if="item.saved" class="saved-badge">
                    ✓ 已入库
                  </span>

                  <!-- 悬停操作浮层（对齐 PicNest 极简玻璃） -->
                  <div class="card-overlay">
                    <div class="action-dock">
                      <!-- 衍生递归搜索 (F) -->
                      <button
                        class="dock-btn search-f"
                        title="以此图继续搜索 (F)"
                        @click="researchItem(item, $event)"
                      >
                        🔍 图片搜索 F
                      </button>

                      <div class="dock-row">
                        <!-- 保存到图巢 (S) -->
                        <button
                          class="dock-btn save-s"
                          :class="{ saved: item.saved }"
                          :disabled="item.saved || savingMap[item.id]"
                          :title="item.saved ? '已存入图巢' : '保存到未分类 (S)'"
                          @click="saveItem(item, $event)"
                        >
                          <span v-if="savingMap[item.id]">⌛ 保存中…</span>
                          <span v-else-if="item.saved">✓ 已存</span>
                          <span v-else>💾 保存 S</span>
                        </button>

                        <!-- 原网直链 (O) -->
                        <button
                          class="dock-btn link-o"
                          title="在浏览器中查看原网页 (O)"
                          @click="openSource(item, $event)"
                        >
                          ↗ 来源 O
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- 简要说明（标题） -->
                <div class="card-meta" v-if="item.title">
                  <div class="card-title">{{ item.title }}</div>
                </div>
              </div>
            </div>

            <!-- 分页加载更多 -->
            <div v-if="currentTask?.bookmark && !currentTask?.loading" class="load-more-box">
              <button class="load-more-btn" @click="loadMore">加载更多相似图片…</button>
            </div>
            <div v-else-if="currentTask?.loading && currentTask?.results?.length" class="loading-more-hint">
              正在加载更多相似图片…
            </div>
          </main>
        </div>

        <!-- 灯箱大图预览层 (去旋转翻转裁剪，保留纯粹平移缩放、切图、搜图与存库) -->
        <div
          v-if="previewItem"
          class="preview-lightbox-layer"
          @wheel.prevent="onPreviewWheel"
          @click.self="closePreview"
        >
          <!-- 顶栏信息与关闭条 -->
          <div class="lightbox-topbar">
            <div class="topbar-info">
              <span class="index-pill" v-if="previewIndex >= 0">
                {{ previewIndex + 1 }} / {{ currentTask?.results?.length || 0 }}
              </span>
              <span class="res-pill" v-if="previewNatW && previewNatH">
                {{ previewNatW }} × {{ previewNatH }}
              </span>
              <span class="title-text" :title="previewItem.title">{{ previewItem.title || '灵感预览' }}</span>
            </div>
            <div class="topbar-actions">
              <button class="topbar-close-btn" title="退出预览 (Esc / 空格)" @click="closePreview">✕</button>
            </div>
          </div>

          <!-- 左右切图浮动箭头 (队列结果大于 1 张时展示) -->
          <button
            v-if="(currentTask?.results?.length || 0) > 1"
            class="lightbox-nav-btn prev"
            title="上一张 (← / A)"
            @click.stop="prevPreviewItem"
          >
            ‹
          </button>
          <button
            v-if="(currentTask?.results?.length || 0) > 1"
            class="lightbox-nav-btn next"
            title="下一张 (→ / D)"
            @click.stop="nextPreviewItem"
          >
            ›
          </button>

          <!-- 视图中心平移与缩放舞台 -->
          <div
            class="lightbox-stage"
            :class="{ panning: isPreviewPanning }"
            @mousedown="onPreviewMouseDown"
            @dblclick="togglePreviewZoom"
          >
            <img
              ref="previewImgRef"
              :src="previewItem.largeUrl || previewItem.thumbUrl"
              class="lightbox-img"
              :style="{
                transform: `translate3d(${previewTx}px, ${previewTy}px, 0) scale(${previewZoom})`
              }"
              @load="onPreviewImgLoad"
              @dragstart.prevent
            />
          </div>

          <!-- 底部悬浮药丸工具坞 (ZCode 极简磨砂风) -->
          <div class="lightbox-dock">
            <button class="dock-pill primary" title="以此图发起新搜索 (F)" @click="researchItem(previewItem)">
              🔍 图片搜索 F
            </button>
            <button
              class="dock-pill success"
              :class="{ saved: previewItem.saved }"
              :disabled="previewItem.saved || savingMap[previewItem.id]"
              title="保存至未分类 (S)"
              @click="saveItem(previewItem)"
            >
              <span v-if="savingMap[previewItem.id]">⌛ 保存中…</span>
              <span v-else-if="previewItem.saved">✓ 已存入未分类</span>
              <span v-else>💾 保存到未分类 S</span>
            </button>
            <button
              v-if="previewItem.sourceUrl"
              class="dock-pill"
              title="浏览器打开原网页 (O)"
              @click="openSource(previewItem)"
            >
              ↗ 来源 O
            </button>
            <button class="dock-pill zoom-reset" title="双击图片或点击此处重置缩放" @click="resetPreviewTransform">
              {{ Math.round(previewZoom * 100) }}%
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
  background: var(--panel-strong);
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
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.app-icon {
  font-size: 18px;
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

/* 右栏：结果瀑布流 (真 CSS Masonry，无撕裂空白) */
.waterfall-container {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  scroll-behavior: smooth;
  background: var(--panel-strong);
}

.waterfall-grid {
  column-width: var(--col-w, 240px);
  column-gap: 14px;
  width: 100%;
}

.waterfall-card {
  break-inside: avoid;
  margin-bottom: 14px;
  display: inline-block;
  width: 100%;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  cursor: pointer;
  box-shadow: var(--shadow-tile);
  transition: transform 0.22s cubic-bezier(0.2, 0.9, 0.3, 1), box-shadow 0.22s ease, border-color 0.18s;
  vertical-align: top;
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
  background: rgba(0, 0, 0, 0.2);
}

.card-img {
  width: 100%;
  height: auto;
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

/* 悬停浮层（对齐 PicNest 极简玻璃） */
.card-overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.04) 20%, rgba(0, 0, 0, 0.8) 100%);
  opacity: 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  padding: 10px;
  transition: opacity 0.2s ease;
  backdrop-filter: blur(2px);
}

.waterfall-card:hover .card-overlay {
  opacity: 1;
}

.action-dock {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dock-row {
  display: flex;
  gap: 6px;
}

.dock-btn {
  background: rgba(255, 255, 255, 0.18);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: #fff;
  border-radius: 7px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  text-align: center;
}

.dock-btn:hover {
  background: rgba(255, 255, 255, 0.3);
}

.dock-btn.search-f {
  background: rgba(59, 130, 246, 0.85);
  border-color: rgba(59, 130, 246, 0.95);
  font-weight: 500;
  box-shadow: 0 4px 12px rgba(59, 130, 246, 0.35);
}

.dock-btn.search-f:hover {
  background: #2563eb;
}

.dock-btn.save-s {
  flex: 1;
  background: rgba(16, 185, 129, 0.8);
  border-color: rgba(16, 185, 129, 0.9);
}

.dock-btn.save-s:hover {
  background: #059669;
}

.dock-btn.save-s.saved {
  background: rgba(16, 185, 129, 0.35);
  color: #a7f3d0;
  cursor: default;
}

.dock-btn.link-o {
  flex: 1;
}

.card-meta {
  padding: 8px 10px;
  background: var(--panel);
}

.card-title {
  font-size: 12px;
  color: var(--text);
  line-height: 1.4;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

/* 骨架屏 */
.skeleton-grid {
  column-width: var(--col-w, 240px);
  column-gap: 14px;
}

.skeleton-card {
  break-inside: avoid;
  margin-bottom: 14px;
  display: inline-block;
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

.title-text {
  max-width: 480px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.9;
}

.topbar-actions {
  pointer-events: auto;
}

.topbar-close-btn {
  background: rgba(18, 18, 24, 0.65);
  backdrop-filter: blur(14px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #fff;
  border-radius: 50%;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  cursor: pointer;
  transition: all 0.15s;
}

.topbar-close-btn:hover {
  background: rgba(239, 68, 68, 0.85);
  transform: scale(1.06);
}

/* 左右切图浮动箭头 */
.lightbox-nav-btn {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 10;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  background: rgba(18, 18, 24, 0.55);
  backdrop-filter: blur(14px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #fff;
  font-size: 28px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.18s cubic-bezier(0.2, 0.9, 0.3, 1);
}

.lightbox-nav-btn.prev {
  left: 20px;
}

.lightbox-nav-btn.next {
  right: 20px;
}

.lightbox-nav-btn:hover {
  background: rgba(255, 255, 255, 0.22);
  transform: translateY(-50%) scale(1.08);
}

/* 舞台与大图 */
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

.lightbox-img {
  max-width: 90vw;
  max-height: 86vh;
  width: auto;
  height: auto;
  object-fit: contain;
  pointer-events: none;
  border-radius: 8px;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.65);
  transform-origin: center center;
  transition: transform 0.15s cubic-bezier(0.2, 0.9, 0.3, 1);
}

.lightbox-stage.panning .lightbox-img {
  transition: none !important;
}

/* 底部悬浮药丸工具坞 */
.lightbox-dock {
  position: absolute;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(18, 18, 24, 0.82);
  backdrop-filter: blur(20px);
  padding: 8px 16px;
  border-radius: 28px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
}

.dock-pill {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #f3f4f6;
  border-radius: 18px;
  padding: 7px 14px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  transition: all 0.15s ease;
  white-space: nowrap;
}

.dock-pill:hover {
  background: rgba(255, 255, 255, 0.18);
  transform: translateY(-1px);
}

.dock-pill.primary {
  background: rgba(59, 130, 246, 0.85);
  border-color: rgba(59, 130, 246, 0.95);
  color: #fff;
  box-shadow: 0 4px 14px rgba(59, 130, 246, 0.35);
}

.dock-pill.primary:hover {
  background: #2563eb;
}

.dock-pill.success {
  background: rgba(16, 185, 129, 0.85);
  border-color: rgba(16, 185, 129, 0.95);
  color: #fff;
  box-shadow: 0 4px 14px rgba(16, 185, 129, 0.35);
}

.dock-pill.success:hover {
  background: #059669;
}

.dock-pill.success.saved {
  background: rgba(16, 185, 129, 0.3);
  border-color: rgba(16, 185, 129, 0.4);
  color: #a7f3d0;
  cursor: default;
  transform: none;
  box-shadow: none;
}

.dock-pill.zoom-reset {
  font-family: monospace;
  min-width: 52px;
  justify-content: center;
  opacity: 0.85;
}
</style>
