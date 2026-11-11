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

// 检索引擎选择
const engine = computed({
  get: () => vs.value.engine || 'pinterest',
  set: (val) => {
    vs.value.engine = val
    if (currentTask.value) {
      currentTask.value.results = []
      currentTask.value.bookmark = null
      triggerSearch(currentTask.value)
    }
  }
})

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
      engine: String(engine.value || 'pinterest'),
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

/* ================== 卡片动作 (F: 递归搜索 / S: 一键存库 / O: 原网) ================== */
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

// S: 保存到图巢
const savingMap = ref({})
async function saveItem(item, e) {
  e?.stopPropagation()
  if (!item || item.saved || savingMap.value[item.id]) return
  savingMap.value[item.id] = true

  try {
    const rootId = lib.activeRootId
    const rel = lib.currentDirRel || ''
    const res = await api.visualSearchSave({
      src: item.origUrl || item.largeUrl,
      origUrl: item.origUrl,
      largeUrl: item.largeUrl,
      thumbUrl: item.thumbUrl,
      title: item.title || '灵感采集',
      sourceUrl: item.sourceUrl,
      engine: item.engine,
      rootId,
      rel
    })

    if (res?.ok) {
      item.saved = true
      lib.syncCurrentDir() // 刷新当前网格
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

/* ================== 键盘快捷键 (F / S / O / Esc / 方向键) ================== */
function onGlobalKeyDown(e) {
  if (!isOpen.value) return
  const tag = (e.target?.tagName || '').toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return

  const k = e.key.toUpperCase()

  if (k === 'ESCAPE') {
    e.preventDefault()
    if (previewItem.value) {
      previewItem.value = null
    } else {
      lib.closeVisualSearch()
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
      previewItem.value = hoveredItem.value
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
            <span class="app-title">以图找图</span>

            <!-- 检索引擎小标 -->
            <div class="engine-tabs">
              <button
                class="tab-btn"
                :class="{ active: engine === 'pinterest' }"
                @click="engine = 'pinterest'"
              >
                📌 Pinterest Lens
              </button>
              <button
                class="tab-btn"
                :class="{ active: engine === 'huaban' }"
                @click="engine = 'huaban'"
              >
                🌸 花瓣网
              </button>
              <button
                class="tab-btn"
                :class="{ active: engine === 'hybrid' }"
                @click="engine = 'hybrid'"
              >
                🔀 聚合视图
              </button>
            </div>
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

          <!-- 中栏：原图与局部框选 (CropViewport, ~350px) -->
          <section class="crop-viewport">
            <div class="viewport-card">
              <div class="crop-container" ref="cropContainerRef">
                <template v-if="currentTask">
                  <img
                    ref="cropImgRef"
                    :src="currentTask.thumbUrl || currentTask.dataUrl"
                    class="query-img"
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
                </template>

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

            <!-- 结果瀑布流 -->
            <div v-else class="waterfall-grid" :style="{ '--col-w': scale + 'px' }">
              <div
                v-for="item in currentTask?.results"
                :key="item.id"
                class="waterfall-card"
                @mouseenter="hoveredItem = item"
                @mouseleave="hoveredItem = null"
                @click="previewItem = item"
              >
                <div class="card-media">
                  <img :src="item.thumbUrl" class="card-img" loading="lazy" />
                  
                  <!-- 引擎标记 -->
                  <span class="engine-badge" :class="item.engine">
                    {{ item.engine === 'pinterest' ? 'Pinterest' : '花瓣' }}
                  </span>

                  <!-- 已保存徽标 -->
                  <span v-if="item.saved" class="saved-badge">
                    ✓ 已入库
                  </span>

                  <!-- 悬停操作浮层 -->
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
                          :title="item.saved ? '已存入图巢' : '保存到图巢当前文件夹 (S)'"
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

                <!-- 简要说明 -->
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

        <!-- 高清原图快速放大预览弹层 -->
        <div v-if="previewItem" class="preview-layer" @click.self="previewItem = null">
          <div class="preview-box">
            <img :src="previewItem.largeUrl || previewItem.thumbUrl" class="preview-img" />
            <div class="preview-bar">
              <span class="preview-title">{{ previewItem.title || '灵感预览' }}</span>
              <div class="preview-actions">
                <button class="dock-btn" @click="researchItem(previewItem)">🔍 图片搜索 F</button>
                <button class="dock-btn" :disabled="previewItem.saved" @click="saveItem(previewItem)">
                  {{ previewItem.saved ? '✓ 已保存' : '💾 保存到图巢 S' }}
                </button>
                <button class="dock-btn" @click="openSource(previewItem)">↗ 原网查看 O</button>
                <button class="dock-btn close" @click="previewItem = null">✕</button>
              </div>
            </div>
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
  background: rgba(0, 0, 0, 0.72);
  backdrop-filter: blur(16px);
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
  background: var(--bg-card, #1c1c24);
  border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
  border-radius: 16px;
  box-shadow: 0 32px 80px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--text-normal, #f3f4f6);
}

/* 顶栏控制区 */
.vs-topbar {
  height: 52px;
  padding: 0 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
  background: rgba(255, 255, 255, 0.02);
  user-select: none;
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: 14px;
}

.app-icon {
  font-size: 18px;
}

.app-title {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.engine-tabs {
  display: flex;
  background: rgba(0, 0, 0, 0.25);
  padding: 3px;
  border-radius: 8px;
  gap: 2px;
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.tab-btn {
  background: transparent;
  border: none;
  color: var(--text-muted, #9ca3af);
  font-size: 12.5px;
  padding: 5px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.tab-btn:hover {
  color: #fff;
  background: rgba(255, 255, 255, 0.06);
}

.tab-btn.active {
  color: #fff;
  background: var(--color-primary, #3b82f6);
  font-weight: 500;
  box-shadow: 0 2px 8px rgba(59, 130, 246, 0.35);
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.scale-box {
  display: flex;
  align-items: center;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 6px;
  padding: 2px 6px;
  gap: 6px;
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.scale-btn {
  background: transparent;
  border: none;
  color: #9ca3af;
  cursor: pointer;
  padding: 0 4px;
  font-size: 14px;
}

.scale-slider {
  width: 90px;
  height: 4px;
  accent-color: var(--color-primary, #3b82f6);
  cursor: pointer;
}

.icon-btn {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  padding: 6px 10px;
  color: #9ca3af;
  cursor: pointer;
  font-size: 13px;
  transition: all 0.15s;
}

.icon-btn.active {
  background: rgba(59, 130, 246, 0.2);
  color: #60a5fa;
  border-color: rgba(59, 130, 246, 0.4);
}

.queue-counter {
  font-size: 12px;
  color: #9ca3af;
  background: rgba(255, 255, 255, 0.06);
  padding: 3px 8px;
  border-radius: 12px;
}

.close-btn {
  background: transparent;
  border: none;
  color: #9ca3af;
  font-size: 16px;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
}

.close-btn:hover {
  background: rgba(239, 68, 68, 0.2);
  color: #f87171;
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
  border-right: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
  background: rgba(0, 0, 0, 0.15);
  overflow-y: auto;
  padding: 10px 8px;
  transition: background 0.15s;
}

.queue-sidebar.drop-active {
  background: rgba(59, 130, 246, 0.15);
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
  background: #111;
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
  border-color: #3b82f6;
  box-shadow: 0 0 12px rgba(59, 130, 246, 0.6);
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
  background: rgba(0, 0, 0, 0.55);
  border: 2px solid #3b82f6;
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
  border: 1px dashed rgba(255, 255, 255, 0.2);
  background: transparent;
  color: #9ca3af;
  font-size: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s;
}

.queue-add-btn:hover {
  border-color: #3b82f6;
  color: #3b82f6;
  background: rgba(59, 130, 246, 0.08);
}

/* 中栏：原图与框选 (CropViewport, ~360px) */
.crop-viewport {
  width: 360px;
  border-right: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
  background: rgba(0, 0, 0, 0.08);
  display: flex;
  flex-direction: column;
  padding: 14px;
}

.viewport-card {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.crop-container {
  position: relative;
  flex: 1;
  max-height: 560px;
  background: rgba(0, 0, 0, 0.35);
  border-radius: 10px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
}

.query-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  display: block;
}

/* 裁剪遮罩与矩形框 */
.crop-mask {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
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
  color: #9ca3af;
}

.action-pill {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #d1d5db;
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.action-pill:hover,
.action-pill.active {
  background: rgba(59, 130, 246, 0.2);
  color: #60a5fa;
  border-color: rgba(59, 130, 246, 0.4);
}

.res-text {
  font-family: monospace;
}

.task-info {
  margin-top: 8px;
  font-size: 12px;
  color: #9ca3af;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 右栏：结果瀑布流 (ResultWaterfall) */
.waterfall-container {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.waterfall-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--col-w, 240px), 1fr));
  grid-auto-flow: dense;
  gap: 14px;
}

.waterfall-card {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
  border-radius: 10px;
  overflow: hidden;
  cursor: pointer;
  transition: transform 0.18s ease, box-shadow 0.18s ease;
  display: flex;
  flex-direction: column;
}

.waterfall-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.4);
  border-color: rgba(255, 255, 255, 0.2);
}

.card-media {
  position: relative;
  width: 100%;
  background: #111;
  overflow: hidden;
}

.card-img {
  width: 100%;
  height: auto;
  display: block;
}

.engine-badge {
  position: absolute;
  top: 8px;
  left: 8px;
  font-size: 10.5px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(4px);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.saved-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  font-size: 10.5px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(16, 185, 129, 0.9);
  color: #fff;
  font-weight: 500;
  box-shadow: 0 2px 6px rgba(16, 185, 129, 0.4);
}

/* 悬停浮层 */
.card-overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(0,0,0,0.1) 40%, rgba(0,0,0,0.85) 100%);
  opacity: 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  padding: 10px;
  transition: opacity 0.15s ease;
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
  background: rgba(255, 255, 255, 0.2);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.25);
  color: #fff;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
  text-align: center;
}

.dock-btn:hover {
  background: rgba(255, 255, 255, 0.35);
}

.dock-btn.search-f {
  background: rgba(59, 130, 246, 0.7);
  border-color: rgba(59, 130, 246, 0.8);
  font-weight: 500;
}

.dock-btn.search-f:hover {
  background: rgba(59, 130, 246, 0.9);
}

.dock-btn.save-s {
  flex: 1;
  background: rgba(16, 185, 129, 0.7);
  border-color: rgba(16, 185, 129, 0.8);
}

.dock-btn.save-s:hover {
  background: rgba(16, 185, 129, 0.9);
}

.dock-btn.save-s.saved {
  background: rgba(16, 185, 129, 0.4);
  cursor: default;
}

.dock-btn.link-o {
  flex: 1;
}

.card-meta {
  padding: 8px 10px;
  font-size: 12px;
  color: #d1d5db;
}

.card-title {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 骨架屏 */
.skeleton-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--col-w, 240px), 1fr));
  gap: 14px;
}

.skeleton-card {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 10px;
  position: relative;
  overflow: hidden;
}

.skeleton-card::after {
  content: '';
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.06), transparent);
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
  color: #9ca3af;
  gap: 10px;
}

.empty-icon,
.error-icon {
  font-size: 44px;
}

.retry-btn {
  background: #3b82f6;
  border: none;
  color: #fff;
  border-radius: 6px;
  padding: 6px 14px;
  font-size: 13px;
  cursor: pointer;
}

.load-more-box {
  display: flex;
  justify-content: center;
  margin-top: 24px;
  margin-bottom: 12px;
}

.load-more-btn {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: #e5e7eb;
  padding: 8px 20px;
  border-radius: 20px;
  cursor: pointer;
  font-size: 13px;
  transition: all 0.15s;
}

.load-more-btn:hover {
  background: rgba(59, 130, 246, 0.2);
  border-color: #3b82f6;
  color: #60a5fa;
}

.loading-more-hint {
  text-align: center;
  color: #9ca3af;
  font-size: 13px;
  margin-top: 16px;
}

/* 放大预览层 */
.preview-layer {
  position: fixed;
  inset: 0;
  z-index: 10000;
  background: rgba(0, 0, 0, 0.85);
  backdrop-filter: blur(12px);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: fadeIn 0.12s ease-out;
}

.preview-box {
  max-width: 85vw;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  background: #181820;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.preview-img {
  max-width: 80vw;
  max-height: 75vh;
  object-fit: contain;
  display: block;
  background: #0d0d12;
}

.preview-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: rgba(255, 255, 255, 0.03);
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.preview-title {
  font-size: 13px;
  color: #e5e7eb;
  max-width: 400px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.preview-actions {
  display: flex;
  gap: 8px;
}
</style>
