<template>
  <div v-if="visible" class="update-mask" @click.self="onMaskClick">
    <div class="update-card" role="dialog" aria-modal="true">
      <!-- 顶部装饰与图标 -->
      <div class="card-header">
        <div class="icon-bubble">
          <svg viewBox="0 0 24 24" class="up-svg" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
        </div>
        <div class="title-group">
          <div class="main-title">
            发现新版本 <span>v{{ updateInfo?.latestVersion || '' }}</span>
          </div>
          <div class="sub-title">
            当前版本 v{{ updateInfo?.currentVersion || '0.1.0' }}
            <span v-if="updateInfo?.publishedAt" class="dot">·</span>
            <span v-if="updateInfo?.publishedAt">{{ formatDate(updateInfo.publishedAt) }}</span>
          </div>
        </div>
        <button class="close-btn" @click="close" title="稍后提醒">✕</button>
      </div>

      <!-- 更新日志展示区 -->
      <div class="changelog-box">
        <div class="changelog-title">更新说明</div>
        <div class="changelog-content" v-html="renderedNotes"></div>
      </div>

      <!-- 资产包信息 -->
      <div v-if="updateInfo?.assetSize" class="asset-meta">
        便携安装包大小: {{ formatBytes(updateInfo.assetSize) }}
      </div>

      <!-- 下载进度展示区 -->
      <div v-if="downloading || downloadFinished" class="progress-section">
        <div class="progress-bar-bg">
          <div
            class="progress-bar-fill"
            :style="{ width: `${progress.percent}%` }"
            :class="{ finished: downloadFinished }"
          ></div>
        </div>
        <div class="progress-labels">
          <span v-if="!downloadFinished">
            {{ formatBytes(progress.received) }} / {{ formatBytes(progress.total) }} ({{ progress.percent }}%)
          </span>
          <span v-else class="finish-text">✨ 下载完成，准备就绪</span>
          <span v-if="!downloadFinished && progress.speed > 0" class="speed">
            {{ formatBytes(progress.speed) }}/s
          </span>
        </div>
      </div>

      <!-- 错误提示 -->
      <div v-if="errorMessage" class="error-tip">
        ⚠️ {{ errorMessage }}
      </div>

      <!-- 底部操作按钮 -->
      <div class="card-actions">
        <!-- 阶段 1: 待下载 -->
        <template v-if="!downloading && !downloadFinished">
          <button class="action-btn text-btn" @click="skipVersion">跳过此版本</button>
          <div class="action-spacer"></div>
          <button class="action-btn sec-btn" @click="close">稍后提醒</button>
          <button class="action-btn prim-btn" @click="startDownload">
            立即下载更新
          </button>
        </template>

        <!-- 阶段 2: 下载中 -->
        <template v-else-if="downloading && !downloadFinished">
          <div class="action-spacer"></div>
          <button class="action-btn sec-btn" @click="cancelDownload">取消</button>
          <button class="action-btn prim-btn disabled" disabled>
            正在下载...
          </button>
        </template>

        <!-- 阶段 3: 下载完成，准备重启 -->
        <template v-else-if="downloadFinished">
          <button class="action-btn sec-btn" @click="close">稍后重启</button>
          <div class="action-spacer"></div>
          <button class="action-btn prim-btn finish-btn" @click="installAndRestart">
            立即重启生效 🚀
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { api } from '../api.js'

const props = defineProps({
  // 可外部传入，也可由内部 store/全局事件驱动
})

const visible = ref(false)
const updateInfo = ref(null)
const downloading = ref(false)
const downloadFinished = ref(false)
const downloadedFilePath = ref('')
const errorMessage = ref('')

const progress = ref({
  received: 0,
  total: 0,
  percent: 0,
  speed: 0
})

// 格式化字节
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatDate(isoStr) {
  if (!isoStr) return ''
  try {
    const d = new Date(isoStr)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  } catch {
    return isoStr
  }
}

// 简单的 Markdown 转 HTML 渲染
const renderedNotes = computed(() => {
  const raw = updateInfo.value?.releaseNotes || '暂无详细更新说明。'
  let html = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // 粗体
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    // 标题
    .replace(/^### (.*$)/gim, '<div class="md-h3">$1</div>')
    .replace(/^## (.*$)/gim, '<div class="md-h2">$1</div>')
    // 列表项
    .replace(/^\s*-\s+(.*$)/gim, '<div class="md-li">• $1</div>')
    // 换行
    .replace(/\n/g, '<br>')
  return html
})

// 打开弹窗
function open(info) {
  updateInfo.value = info
  downloading.value = false
  downloadFinished.value = false
  downloadedFilePath.value = ''
  errorMessage.value = ''
  progress.value = { received: 0, total: 0, percent: 0, speed: 0 }
  visible.value = true
}

// 关闭弹窗
function close() {
  if (downloading.value) {
    if (!confirm('正在下载更新包，确认退出下载吗？')) return
    cancelDownload()
  }
  visible.value = false
}

function onMaskClick() {
  // 下载中不误关
  if (downloading.value) return
  close()
}

// 跳过此版本
function skipVersion() {
  if (updateInfo.value?.latestVersion) {
    localStorage.setItem('picnest.skipUpdateTag', updateInfo.value.latestVersion)
  }
  visible.value = false
}

// 开始下载
async function startDownload() {
  if (!updateInfo.value?.assetUrl) {
    errorMessage.value = '未找到可下载的更新包，请前往官网手动下载'
    return
  }
  downloading.value = true
  errorMessage.value = ''

  try {
    const res = await api.downloadUpdate({
      url: updateInfo.value.assetUrl,
      fileName: updateInfo.value.assetName || `PicNest-v${updateInfo.value.latestVersion}-windows-x64.zip`
    })

    if (res?.ok) {
      downloading.value = false
      downloadFinished.value = true
      downloadedFilePath.value = res.filePath
    } else {
      downloading.value = false
      errorMessage.value = res?.error || '下载更新包失败'
    }
  } catch (err) {
    downloading.value = false
    errorMessage.value = String(err?.message || err)
  }
}

// 取消下载
async function cancelDownload() {
  try {
    await api.cancelDownloadUpdate()
  } catch (e) {}
  downloading.value = false
  errorMessage.value = '已取消下载'
}

// 重启安装
async function installAndRestart() {
  if (!downloadedFilePath.value) return
  try {
    const res = await api.quitAndInstall({
      zipPath: downloadedFilePath.value
    })
    if (!res?.ok) {
      errorMessage.value = res?.error || '启动替换进程失败'
    }
  } catch (err) {
    errorMessage.value = String(err?.message || err)
  }
}

// 监听下载进度
let unbindProgress = null
onMounted(() => {
  if (api.onUpdateProgress) {
    unbindProgress = api.onUpdateProgress((p) => {
      progress.value = p
    })
  }
})

onUnmounted(() => {
  if (typeof unbindProgress === 'function') unbindProgress()
})

// 暴露给父组件通过 ref 调用
defineExpose({
  open,
  close
})
</script>

<style scoped>
.update-mask {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: fadeIn 0.22s ease-out;
}

.update-card {
  width: 480px;
  max-width: 90vw;
  background: var(--bg-panel, #ffffff);
  border: 1px solid var(--border-soft, rgba(0, 0, 0, 0.08));
  border-radius: 14px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.22), 0 0 0 1px rgba(255, 255, 255, 0.15) inset;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: popIn 0.25s cubic-bezier(0.18, 0.89, 0.32, 1.28);
}

.card-header {
  padding: 18px 20px 14px;
  display: flex;
  align-items: center;
  gap: 14px;
  border-bottom: 1px solid var(--border-soft, rgba(0, 0, 0, 0.06));
}

.icon-bubble {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: var(--accent-light, #fef4e2);
  color: var(--accent, #d49a37);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.up-svg {
  width: 22px;
  height: 22px;
}

.title-group {
  flex: 1;
  min-width: 0;
}
.main-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-main, #222);
}
.main-title span {
  color: var(--accent, #d49a37);
  margin-left: 4px;
}

.sub-title {
  font-size: 12px;
  color: var(--text-muted, #888);
  margin-top: 2px;
}
.dot {
  margin: 0 4px;
}

.close-btn {
  background: transparent;
  border: none;
  font-size: 16px;
  color: var(--text-muted, #999);
  cursor: pointer;
  padding: 6px;
  border-radius: 6px;
  line-height: 1;
}
.close-btn:hover {
  background: var(--bg-hover, rgba(0, 0, 0, 0.05));
  color: var(--text-main, #333);
}

.changelog-box {
  padding: 14px 20px;
  max-height: 220px;
  display: flex;
  flex-direction: column;
}
.changelog-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-muted, #777);
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.changelog-content {
  flex: 1;
  overflow-y: auto;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-main, #333);
  padding: 10px 12px;
  background: var(--bg-input, rgba(0, 0, 0, 0.03));
  border-radius: 8px;
  user-select: text;
}
:deep(.md-h2) {
  font-weight: 600;
  font-size: 13.5px;
  margin: 6px 0 2px;
  color: var(--accent, #d49a37);
}
:deep(.md-h3) {
  font-weight: 600;
  font-size: 13px;
  margin: 4px 0 2px;
}
:deep(.md-li) {
  padding-left: 6px;
}

.asset-meta {
  padding: 0 20px 10px;
  font-size: 12px;
  color: var(--text-muted, #888);
}

.progress-section {
  padding: 4px 20px 14px;
}
.progress-bar-bg {
  width: 100%;
  height: 8px;
  background: var(--border-soft, rgba(0, 0, 0, 0.08));
  border-radius: 4px;
  overflow: hidden;
}
.progress-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent, #d49a37), #f5be58);
  border-radius: 4px;
  transition: width 0.2s ease;
}
.progress-bar-fill.finished {
  background: #39c5bb;
}
.progress-labels {
  display: flex;
  justify-content: space-between;
  font-size: 11.5px;
  color: var(--text-muted, #777);
  margin-top: 6px;
}
.finish-text {
  color: #2bb1a7;
  font-weight: 500;
}

.error-tip {
  margin: 0 20px 12px;
  padding: 8px 12px;
  background: rgba(220, 53, 69, 0.1);
  color: #dc3545;
  border-radius: 6px;
  font-size: 12px;
}

.card-actions {
  padding: 14px 20px;
  background: var(--bg-sub, rgba(0, 0, 0, 0.02));
  border-top: 1px solid var(--border-soft, rgba(0, 0, 0, 0.06));
  display: flex;
  align-items: center;
  gap: 10px;
}

.action-spacer {
  flex: 1;
}

.action-btn {
  padding: 7px 15px;
  font-size: 13px;
  border-radius: 8px;
  cursor: pointer;
  border: 1px solid transparent;
  font-weight: 500;
  transition: all 0.18s ease;
}

.text-btn {
  background: transparent;
  color: var(--text-muted, #888);
  padding: 7px 8px;
}
.text-btn:hover {
  color: var(--text-main, #333);
}

.sec-btn {
  background: var(--bg-hover, rgba(0, 0, 0, 0.05));
  border-color: var(--border-soft, rgba(0, 0, 0, 0.08));
  color: var(--text-main, #444);
}
.sec-btn:hover {
  background: var(--bg-active, rgba(0, 0, 0, 0.09));
}

.prim-btn {
  background: linear-gradient(135deg, var(--accent, #d49a37), #bf8426);
  color: #fff;
  box-shadow: 0 2px 8px rgba(212, 154, 55, 0.35);
}
.prim-btn:hover {
  filter: brightness(1.08);
  transform: translateY(-1px);
}
.prim-btn:active {
  transform: translateY(0);
}
.prim-btn.disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none;
}
.finish-btn {
  background: linear-gradient(135deg, #39c5bb, #25a097);
  box-shadow: 0 2px 10px rgba(57, 197, 187, 0.4);
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes popIn {
  from {
    opacity: 0;
    transform: scale(0.94) translateY(8px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}
</style>
