<template>
  <Teleport to="body">
    <div v-if="visible" class="up-layer" @click.self="onMaskClick">
      <div class="up-card" role="dialog" aria-modal="true" aria-label="图巢版本更新">
        <!-- 顶部标题栏 -->
        <div class="up-head">
          <div class="up-icon" :class="mode">
            <!-- 检查中旋转图标 -->
            <svg v-if="mode === 'checking' || installing" viewBox="0 0 24 24" class="up-svg spin" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            <!-- 已是最新勾号 -->
            <svg v-else-if="mode === 'latest'" viewBox="0 0 24 24" class="up-svg" fill="none" stroke="currentColor" stroke-width="2.2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            <!-- 错误感叹号 -->
            <svg v-else-if="mode === 'error'" viewBox="0 0 24 24" class="up-svg" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <!-- 发现新版火箭/上传箭头 -->
            <svg v-else viewBox="0 0 24 24" class="up-svg" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
          </div>

          <div class="up-titles">
            <div v-if="mode === 'checking'" class="up-title">正在检查新版本…</div>
            <div v-else-if="mode === 'latest'" class="up-title">当前已是最新版本</div>
            <div v-else-if="mode === 'error'" class="up-title">检查更新遇到问题</div>
            <div v-else class="up-title">
              发现新版本 <span class="up-ver-badge">v{{ updateInfo?.latestVersion || '' }}</span>
            </div>

            <div class="up-sub">
              <span>当前版本 v{{ updateInfo?.currentVersion || currentVer || '0.1.0' }}</span>
              <template v-if="mode === 'available' && updateInfo?.publishedAt">
                <span class="up-dot">·</span>
                <span>发布于 {{ formatDate(updateInfo.publishedAt) }}</span>
              </template>
            </div>
          </div>

          <button class="up-close" :disabled="installing" @click="requestClose" title="关闭 (Esc)">✕</button>
        </div>

        <!-- 状态 1：正在检查 -->
        <div v-if="mode === 'checking'" class="up-state-box">
          <div class="up-state-text">正在连接 GitHub Releases 获取最新版本信息，请稍候…</div>
        </div>

        <!-- 状态 2：已是最新版本 -->
        <div v-else-if="mode === 'latest'" class="up-state-box">
          <div class="up-state-text">
            你正在使用的 <b>PicNest 图巢 v{{ updateInfo?.currentVersion || currentVer }}</b> 已经是最新正式版。
          </div>
          <div v-if="updateInfo?.message" class="up-state-hint">{{ updateInfo.message }}</div>
        </div>

        <!-- 状态 3：检查失败 -->
        <div v-else-if="mode === 'error'" class="up-state-box">
          <div class="up-err-banner">⚠️ {{ errorMessage || '无法连接到 GitHub 更新服务器' }}</div>
          <div class="up-state-hint">
            若处于无代理或受限网络环境，可直接点击下方「前往 GitHub 手动下载」在浏览器中查看最新便携包。
          </div>
        </div>

        <!-- 状态 4：发现新版本（含下载与安装流程） -->
        <template v-else-if="mode === 'available'">
          <!-- 更新日志 -->
          <div class="up-notes-wrap">
            <div class="up-notes-label">
              <span>{{ updateInfo?.releaseName || '版本更新说明' }}</span>
              <span v-if="updateInfo?.assetSize" class="up-size-tag">
                便携包 {{ formatBytes(updateInfo.assetSize) }}
              </span>
            </div>
            <div class="up-notes-body" v-html="renderedNotes"></div>
          </div>

          <!-- SHA-256 摘要提示 -->
          <div v-if="updateInfo?.expectedSha256" class="up-sha-row" :title="updateInfo.expectedSha256">
            <span class="up-sha-tag">SHA-256 校验保护</span>
            <code>{{ updateInfo.expectedSha256.slice(0, 16) }}…{{ updateInfo.expectedSha256.slice(-8) }}</code>
          </div>

          <!-- 下载进度条与解压状态 -->
          <div v-if="downloading || downloadFinished || installing" class="up-prog-wrap">
            <div class="up-prog-track">
              <div
                class="up-prog-bar"
                :class="{ done: downloadFinished, busy: installing }"
                :style="{ width: installing ? '100%' : `${progress.percent}%` }"
              ></div>
            </div>
            <div class="up-prog-meta">
              <span v-if="installing" class="up-status-text">
                ⏳ {{ installStageText || '正在解压并启动热替换跳板…' }}
              </span>
              <span v-else-if="downloadFinished" class="up-done-text">
                ✓ 下载完成并通过完整性校验，可随时重启替换
              </span>
              <span v-else>
                已下载 {{ formatBytes(progress.received) }}
                <template v-if="progress.total > 0"> / {{ formatBytes(progress.total) }} ({{ progress.percent }}%)</template>
              </span>

              <span v-if="downloading && !downloadFinished && progress.speed > 0" class="up-speed">
                {{ formatBytes(progress.speed) }}/s
              </span>
            </div>
          </div>

          <!-- 错误横幅 -->
          <div v-if="errorMessage" class="up-err-banner up-err-inline">
            ⚠️ {{ errorMessage }}
          </div>

          <!-- 取消下载二次确认条 -->
          <div v-if="confirmingCancel" class="up-confirm-bar">
            <span>正在下载更新包，确定要中止下载吗？</span>
            <div class="up-confirm-btns">
              <button class="up-btn up-btn-sec up-btn-sm" @click="confirmingCancel = false">继续下载</button>
              <button class="up-btn up-btn-danger up-btn-sm" @click="confirmAbortAndClose">中止并关闭</button>
            </div>
          </div>
        </template>

        <!-- 底部按钮栏 -->
        <div class="up-foot">
          <!-- 检查中 -->
          <template v-if="mode === 'checking'">
            <div class="up-spacer"></div>
            <button class="up-btn up-btn-sec" @click="closeImmediate">后台运行</button>
          </template>

          <!-- 已是最新 -->
          <template v-else-if="mode === 'latest'">
            <button class="up-btn up-btn-text" @click="openReleasePage">前往 GitHub Releases ↗</button>
            <div class="up-spacer"></div>
            <button class="up-btn up-btn-prim" @click="closeImmediate">知道了</button>
          </template>

          <!-- 检查错误 -->
          <template v-else-if="mode === 'error'">
            <button class="up-btn up-btn-text" @click="openReleasePage">前往 GitHub 手动下载 ↗</button>
            <div class="up-spacer"></div>
            <button class="up-btn up-btn-sec" @click="closeImmediate">关闭</button>
            <button class="up-btn up-btn-prim" @click="runManualCheck()">重试检查</button>
          </template>

          <!-- 发现新版本：阶段 1 待下载 -->
          <template v-else-if="!downloading && !downloadFinished && !installing">
            <button class="up-btn up-btn-text" @click="skipVersion">跳过此版本</button>
            <button class="up-btn up-btn-text" @click="openReleasePage" title="在浏览器中打开 GitHub Release 页面手动下载">
              浏览器下载 ↗
            </button>
            <div class="up-spacer"></div>
            <button class="up-btn up-btn-sec" @click="closeImmediate">稍后提醒</button>
            <button class="up-btn up-btn-prim" @click="startDownload">
              {{ errorMessage ? '重新下载更新' : '立即下载更新' }}
            </button>
          </template>

          <!-- 发现新版本：阶段 2 下载中 -->
          <template v-else-if="downloading && !downloadFinished">
            <button class="up-btn up-btn-text" @click="openReleasePage">浏览器下载 ↗</button>
            <div class="up-spacer"></div>
            <button class="up-btn up-btn-sec" @click="cancelDownload">取消下载</button>
            <button class="up-btn up-btn-prim" disabled>正在下载 ({{ progress.percent }}%)…</button>
          </template>

          <!-- 发现新版本：阶段 3 下载完成 / 正在安装重启 -->
          <template v-else-if="downloadFinished || installing">
            <button class="up-btn up-btn-sec" :disabled="installing" @click="closeImmediate">稍后重启</button>
            <div class="up-spacer"></div>
            <button class="up-btn up-btn-prim up-btn-ready" :disabled="installing" @click="installAndRestart">
              {{ installing ? '正在解压并重启…' : '立即重启并替换新版本 🚀' }}
            </button>
          </template>
        </div>

        <!-- 底部常驻引导小字与 GitHub 开源仓库跳转链接 -->
        <div class="up-guide-bar">
          <span class="up-guide-tip">💡 提示：手动「检查新版本」位于顶栏「?」帮助面板底部</span>
          <button class="up-repo-link" @click="openRepoPage" title="在浏览器中打开 PicNest GitHub 开源主页">
            https://github.com/Ranbow29/PicNest ↗
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { api } from '../api.js'

const visible = ref(false)
// mode: 'checking' | 'latest' | 'error' | 'available'
const mode = ref('available')
const currentVer = ref('0.1.0')
const updateInfo = ref(null)
const downloading = ref(false)
const downloadFinished = ref(false)
const installing = ref(false)
const installStageText = ref('')
const downloadedFilePath = ref('')
const errorMessage = ref('')
const confirmingCancel = ref(false)

const progress = ref({
  received: 0,
  total: 0,
  percent: 0,
  speed: 0
})

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let n = Number(bytes)
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
    if (Number.isNaN(d.getTime())) return isoStr
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  } catch {
    return isoStr
  }
}

const renderedNotes = computed(() => {
  const raw = String(updateInfo.value?.releaseNotes || '暂无详细更新说明。')
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/^#### (.*$)/gim, '<div class="md-h3">$1</div>')
    .replace(/^### (.*$)/gim, '<div class="md-h3">$1</div>')
    .replace(/^## (.*$)/gim, '<div class="md-h2">$1</div>')
    .replace(/^\s*[-*]\s+(.*$)/gim, '<div class="md-li">• $1</div>')
    .replace(/\r?\n/g, '<br>')
})

function resetDownloadState() {
  downloading.value = false
  downloadFinished.value = false
  installing.value = false
  installStageText.value = ''
  downloadedFilePath.value = ''
  errorMessage.value = ''
  confirmingCancel.value = false
  progress.value = { received: 0, total: 0, percent: 0, speed: 0 }
}

// 静默检查发现新版本时直接打开 available 视图
function open(info) {
  resetDownloadState()
  updateInfo.value = info
  if (info?.currentVersion) currentVer.value = info.currentVersion
  mode.value = 'available'
  visible.value = true
}

// 手动检查更新：完整流转 checking -> available / latest / error
async function runManualCheck(opts = {}) {
  resetDownloadState()
  mode.value = 'checking'
  visible.value = true
  try {
    const res = await api.checkUpdate({ manual: true, ...opts })
    if (res?.currentVersion) currentVer.value = res.currentVersion
    updateInfo.value = res || null
    if (res?.ok) {
      mode.value = res.hasUpdate ? 'available' : 'latest'
    } else {
      mode.value = 'error'
      errorMessage.value = res?.error || '检查更新失败，请稍后重试'
    }
    return res
  } catch (err) {
    mode.value = 'error'
    errorMessage.value = String(err?.message || err)
    return { ok: false, error: errorMessage.value }
  }
}

function closeImmediate() {
  confirmingCancel.value = false
  visible.value = false
}

function requestClose() {
  if (installing.value) return
  if (downloading.value) {
    confirmingCancel.value = true
    return
  }
  closeImmediate()
}

async function confirmAbortAndClose() {
  confirmingCancel.value = false
  await cancelDownload()
  visible.value = false
}

function onMaskClick() {
  if (downloading.value || installing.value) return
  closeImmediate()
}

function skipVersion() {
  if (updateInfo.value?.latestVersion) {
    localStorage.setItem('picnest.skipUpdateTag', updateInfo.value.latestVersion)
  }
  closeImmediate()
}

async function openReleasePage() {
  const url = updateInfo.value?.htmlUrl || 'https://github.com/Ranbow29/PicNest/releases'
  await api.openExternal(url)
}

async function openRepoPage() {
  await api.openExternal('https://github.com/Ranbow29/PicNest')
}

async function startDownload() {
  if (!updateInfo.value?.assetUrl) {
    errorMessage.value = '该版本暂未附带自动更新 ZIP 包，请点击「浏览器下载」手动获取'
    return
  }
  downloading.value = true
  downloadFinished.value = false
  errorMessage.value = ''
  confirmingCancel.value = false
  progress.value = { received: 0, total: updateInfo.value.assetSize || 0, percent: 0, speed: 0 }

  try {
    const res = await api.downloadUpdate({
      url: updateInfo.value.assetUrl,
      fileName: updateInfo.value.assetName || `PicNest-v${updateInfo.value.latestVersion}-windows-x64.zip`,
      expectedSha256: updateInfo.value.expectedSha256 || null
    })

    if (res?.ok) {
      downloading.value = false
      downloadFinished.value = true
      downloadedFilePath.value = res.filePath
    } else {
      downloading.value = false
      if (!res?.cancelled) {
        errorMessage.value = res?.error || '下载更新包失败'
      }
    }
  } catch (err) {
    downloading.value = false
    errorMessage.value = String(err?.message || err)
  }
}

async function cancelDownload() {
  try {
    await api.cancelDownloadUpdate()
  } catch (e) {}
  downloading.value = false
  confirmingCancel.value = false
  errorMessage.value = '已取消下载'
}

async function installAndRestart() {
  if (!downloadedFilePath.value || installing.value) return
  installing.value = true
  installStageText.value = '正在校验并异步解压更新包…'
  errorMessage.value = ''

  try {
    const res = await api.quitAndInstall({
      zipPath: downloadedFilePath.value
    })
    if (!res?.ok) {
      installing.value = false
      errorMessage.value = res?.error || '启动热替换进程失败'
    }
  } catch (err) {
    installing.value = false
    errorMessage.value = String(err?.message || err)
  }
}

let unbindProgress = null
let unbindStatus = null

onMounted(async () => {
  try {
    const vRes = await api.appVersion()
    if (vRes?.version) currentVer.value = vRes.version
  } catch (e) {}

  if (api.onUpdateProgress) {
    unbindProgress = api.onUpdateProgress((p) => {
      if (p) progress.value = p
    })
  }
  if (api.onUpdateStatus) {
    unbindStatus = api.onUpdateStatus((s) => {
      if (s?.text) installStageText.value = s.text
    })
  }
})

onUnmounted(() => {
  if (typeof unbindProgress === 'function') unbindProgress()
  if (typeof unbindStatus === 'function') unbindStatus()
})

defineExpose({
  open,
  runManualCheck,
  close: requestClose,
  isOpen: () => visible.value
})
</script>

<style scoped>
.up-layer {
  position: fixed;
  inset: 0;
  z-index: 960;
  background: rgba(20, 18, 14, 0.42);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
}

.up-card {
  width: min(500px, 92vw);
  background: var(--panel-strong);
  backdrop-filter: blur(var(--blur)) saturate(1.1);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: var(--shadow-float);
  color: var(--text);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: up-pop 0.2s var(--ease-overshoot);
}

@keyframes up-pop {
  from { opacity: 0; transform: translateY(10px) scale(0.97); }
  to { opacity: 1; transform: none; }
}

.up-head {
  padding: 16px 18px 13px;
  display: flex;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid var(--border);
}

.up-icon {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: var(--accent-weak);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.up-icon.latest {
  background: rgba(46, 160, 110, 0.14);
  color: #2ea06e;
}
.up-icon.error {
  background: rgba(194, 90, 77, 0.14);
  color: #c25a4d;
}

.up-svg {
  width: 20px;
  height: 20px;
}
.up-svg.spin {
  animation: up-spin 1.2s linear infinite;
}
@keyframes up-spin {
  to { transform: rotate(360deg); }
}

.up-titles {
  flex: 1;
  min-width: 0;
}
.up-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 8px;
}
.up-ver-badge {
  font-size: 12px;
  font-weight: 600;
  padding: 1px 8px;
  border-radius: 99px;
  background: var(--accent-weak);
  color: var(--accent);
  border: 1px solid var(--border);
}
.up-sub {
  font-size: 11.5px;
  color: var(--text-2);
  margin-top: 2px;
}
.up-dot {
  margin: 0 5px;
}

.up-close {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
  cursor: pointer;
}
.up-close:hover:not(:disabled) {
  background: var(--accent-weak);
  color: var(--text);
}
.up-close:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.up-state-box {
  padding: 20px 20px 18px;
  font-size: 13px;
  line-height: 1.65;
  color: var(--text);
}
.up-state-text b {
  color: var(--accent);
}
.up-state-hint {
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--text-2);
}

.up-notes-wrap {
  padding: 14px 18px 10px;
  display: flex;
  flex-direction: column;
}
.up-notes-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  margin-bottom: 7px;
}
.up-size-tag {
  font-weight: 500;
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 6px;
  background: var(--bg-2);
  color: var(--text-2);
}

.up-notes-body {
  max-height: 210px;
  overflow-y: auto;
  font-size: 12.5px;
  line-height: 1.68;
  color: var(--text);
  padding: 10px 13px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  user-select: text;
  scrollbar-width: thin;
}
:deep(.md-h2) {
  font-weight: 700;
  font-size: 13px;
  margin: 6px 0 3px;
  color: var(--accent);
}
:deep(.md-h3) {
  font-weight: 600;
  font-size: 12.5px;
  margin: 5px 0 2px;
  color: var(--text);
}
:deep(.md-li) {
  padding-left: 6px;
}
:deep(code) {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--panel-strong);
  font-family: Consolas, monospace;
  font-size: 11px;
}

.up-sha-row {
  padding: 0 18px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-2);
}
.up-sha-tag {
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(46, 160, 110, 0.13);
  color: #2ea06e;
  font-weight: 600;
}
.up-sha-row code {
  font-family: Consolas, monospace;
  color: var(--text-2);
}

.up-prog-wrap {
  padding: 4px 18px 12px;
}
.up-prog-track {
  width: 100%;
  height: 7px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 99px;
  overflow: hidden;
}
.up-prog-bar {
  height: 100%;
  background: var(--accent);
  border-radius: 99px;
  transition: width 0.2s ease;
}
.up-prog-bar.done {
  background: #2ea06e;
}
.up-prog-bar.busy {
  background: linear-gradient(90deg, var(--accent), #2ea06e, var(--accent));
  background-size: 200% 100%;
  animation: up-shimmer 1.4s linear infinite;
}
@keyframes up-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: 0 0; }
}

.up-prog-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11.5px;
  color: var(--text-2);
  margin-top: 6px;
}
.up-done-text {
  color: #2ea06e;
  font-weight: 600;
}
.up-status-text {
  color: var(--accent);
  font-weight: 600;
}
.up-speed {
  font-family: Consolas, monospace;
}

.up-err-banner {
  padding: 9px 12px;
  border-radius: 8px;
  border: 1px solid rgba(194, 90, 77, 0.35);
  background: rgba(194, 90, 77, 0.09);
  color: #c25a4d;
  font-size: 12px;
  line-height: 1.5;
}
.up-err-inline {
  margin: 0 18px 12px;
}

.up-confirm-bar {
  margin: 0 18px 12px;
  padding: 9px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-2);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
}
.up-confirm-btns {
  display: flex;
  gap: 6px;
}

.up-foot {
  padding: 12px 18px;
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
}
.up-spacer {
  flex: 1;
}

.up-btn {
  padding: 6px 13px;
  font-size: 12px;
  font-weight: 600;
  border-radius: 8px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.15s ease;
}
.up-btn-sm {
  padding: 4px 10px;
  font-size: 11.5px;
}
.up-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.up-btn-text {
  background: transparent;
  color: var(--text-2);
  padding: 6px 8px;
}
.up-btn-text:hover {
  color: var(--text);
  background: var(--accent-weak);
}

.up-btn-sec {
  background: var(--bg-2);
  border-color: var(--border);
  color: var(--text);
}
.up-btn-sec:hover:not(:disabled) {
  background: var(--accent-weak);
  border-color: var(--accent);
}

.up-btn-prim {
  background: var(--accent);
  color: #fff;
}
.up-btn-prim:hover:not(:disabled) {
  filter: brightness(1.08);
}

.up-btn-ready {
  background: #2ea06e;
  color: #fff;
}

.up-btn-danger {
  background: #c25a4d;
  color: #fff;
}

.up-guide-bar {
  padding: 8px 18px 10px;
  background: var(--bg-2);
  border-top: 1px dashed var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 11px;
  color: var(--text-2);
}

.up-guide-tip {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.up-repo-link {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
  flex-shrink: 0;
}

.up-repo-link:hover {
  filter: brightness(1.1);
}
</style>
