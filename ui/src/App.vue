<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useLibrary, extractDropUrls } from './stores/library'
import { isExternalDT, isNativeDragOutActive, markNativeDragOut, endNativeDragOut } from './lib/dnd'
import TitleBar from './components/TitleBar.vue'
import SideBar from './components/SideBar.vue'
import ImageGrid from './components/ImageGrid.vue'
import Inspector from './components/Inspector.vue'
import Lightbox from './components/Lightbox.vue'
import ContextMenu from './components/ContextMenu.vue'
import DuplicateDialog from './components/DuplicateDialog.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import DupFinder from './components/DupFinder.vue'
import BriefMode from './components/BriefMode.vue'
import TrashMenu from './components/TrashMenu.vue'
import ImportResultCard from './components/ImportResultCard.vue'
import TaskProgress from './components/TaskProgress.vue'
import PluginManager from './components/PluginManager.vue'
import HelpDialog from './components/HelpDialog.vue'
import UpdateDialog from './components/UpdateDialog.vue'
import { api } from './api.js'
import { refreshPluginThemes } from './lib/plugins'
import ResizeHandle from './components/ResizeHandle.vue'
import InspResize from './components/InspResize.vue'

// ZCode 式嵌套结构：左栏底层(可拖宽) → 主面板工作区（浏览 ⇄ 大图双模式）→ 详情计划式浮岛(可收起可拖宽)
// 外部拖入 = 位置即意图：主展示区/树行/缝隙/资料库栏各自高亮 + 跟随光标的落点提示
const lib = useLibrary()

const updateDialogRef = ref(null)
let silentUpdateTimer = null

// 自动检测更新 (启动 5 秒后静默检测)
async function checkForUpdatesSilently() {
  try {
    if (updateDialogRef.value?.isOpen?.()) return
    const res = await api.checkUpdate()
    if (res?.ok && res.hasUpdate) {
      const skipped = localStorage.getItem('picnest.skipUpdateTag')
      if (skipped === res.latestVersion) return
      updateDialogRef.value?.open(res)
    }
  } catch (e) {}
}

// 手动检查更新 (由帮助页或全局触发，全程使用奶玻璃 UpdateDialog 展示状态)
async function checkForUpdatesManual(ev) {
  const opts = (ev && typeof ev === 'object' && 'detail' in ev) ? (ev.detail || {}) : (ev || {})
  return await updateDialogRef.value?.runManualCheck?.(opts)
}

window.__picnestCheckUpdate__ = checkForUpdatesManual

/* 详情固定高度 = 用户偏好，但必须随窗口收缩钳制：否则最大化时设的 1137px 在窗口变矮后
   会从底部往上顶出视口（顶部内容被窗控盖住）。只影响显示，不改用户存的值；窗口放大后恢复。 */
const browseEl = ref(null)
const browseH = ref(Math.max(0, window.innerHeight - 30))
const inspEffH = computed(() => {
  const h = Number(lib.inspectorHeight) || 0
  if (h <= 0) return 0
  const max = Math.max(240, Math.round((browseH.value || 0) - 50))
  return Math.min(h, max)
})
let browseRO = null
/* 复制/粘贴快捷键（输入框内保留原生行为；有文本选择时让浏览器复制文本） */
function isTypingTarget(el) {
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}
function onKeydown(e) {
  if (e.defaultPrevented) return // TitleBar 已处理（Esc 关布局/筛选弹板）
  /* 简报模式：全屏演示优先接管键盘 */
  if (lib.brief.open) {
    const k = e.key
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey
    const lk = String(k || '').toLowerCase()
    if (k === 'Escape') { e.preventDefault(); lib.closeBrief(); return }
    if (k === 'ArrowLeft' || (plain && lk === 'a')) { e.preventDefault(); lib.briefNav(-1); return }
    if (k === 'ArrowRight' || k === ' ' || (plain && lk === 'd')) { e.preventDefault(); lib.briefNav(1); return }
    return
  }
  const key = String(e.key || '').toLowerCase()
  if (key === 'escape') {
    /* 分层退出：输入框/灯箱/弹窗/右键菜单各有其主，都没有才清空选中 */
    if (isTypingTarget(e.target)) return
    if (updateDialogRef.value?.isOpen?.()) { e.preventDefault(); updateDialogRef.value.close(); return }
    if (lib.helpOpen) { e.preventDefault(); lib.closeHelp(); return }
    if (lib.pluginsOpen) { e.preventDefault(); lib.closePlugins(); return }
    if (lib.lightbox.open) return // Lightbox 自己处理（含裁剪态）
    if (lib.confirmDialog.open) { lib.resolveConfirm(false); return }
    if (lib.dupFinder.open) { lib.closeDupFinder(); return }
    if (lib.dupDialog.open) return // 重复三选一必须显式选择
    if (lib.dirMenu.open) { lib.closeDirMenu(); return }
    if (lib.contextMenu.open) { lib.closeContextMenu(); return }
    if (lib.filterBarOpen) return
    lib.clearSelections()
    return
  }
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
  if (isTypingTarget(e.target)) return
  if (lib.confirmDialog.open || lib.dupDialog.open) return
  if (key === 'a') {
    if (lib.lightbox.open || lib.dirMenu.open || lib.contextMenu.open) return
    e.preventDefault()
    lib.selectAllImages()
    return
  }
  if (key !== 'c' && key !== 'v') return
  if (key === 'c') {
    if (String(window.getSelection?.() || '').trim()) return
    const r = lib.copySelection()
    if (r?.ok) e.preventDefault()
  } else {
    if (!lib.clipboard?.kind) return
    e.preventDefault()
    lib.paste()
  }
}
function clearDropUi() { lib.clearDropHint() }
function onWindowDragLeave(e) { if (!e.relatedTarget) lib.clearDropHint() }
/* 原生拖出媒体文件：拖回 PicNest 内的落回事件必须吞掉，不能当成“外部录入”再导一遍 */
function onNativeDragOutOver(e) {
  if (!isNativeDragOutActive() || !isExternalDT(e)) return
  e.preventDefault()
  e.stopImmediatePropagation()
  if (e.type === 'drop') lib.clearDropHint()
}
onMounted(() => {
  lib.init()
  refreshPluginThemes().catch(() => {}) // 启动时应用已启用的主题插件
  window.addEventListener('picnest-check-update-trigger', checkForUpdatesManual)
  silentUpdateTimer = setTimeout(checkForUpdatesSilently, 5000)
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('drop', clearDropUi, true)
  window.addEventListener('dragend', clearDropUi, true)
  window.addEventListener('dragleave', onWindowDragLeave, true)
  window.addEventListener('dragenter', onNativeDragOutOver, true)
  window.addEventListener('dragover', onNativeDragOutOver, true)
  window.addEventListener('drop', onNativeDragOutOver, true)
  /* 主进程把拖拽升级为原生文件拖出后，标记开始；结束后延迟清标记 */
  window.picrand?.onPicnestDragOutStart?.(() => markNativeDragOut())
  window.picrand?.onPicnestDragOutEnd?.(() => setTimeout(endNativeDragOut, 500))
  /* 窗口尺寸变化 → 详情固定高度的显示上限跟着走（grip 与浮岛共用 --insp-h） */
  try {
    browseRO = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect?.height
      if (h) browseH.value = h
    })
    if (browseEl.value) browseRO.observe(browseEl.value)
  } catch { /* 旧内核无 RO 时退回 window.innerHeight 估算 */ }
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('drop', clearDropUi, true)
  window.removeEventListener('dragend', clearDropUi, true)
  window.removeEventListener('dragleave', onWindowDragLeave, true)
  window.removeEventListener('dragenter', onNativeDragOutOver, true)
  window.removeEventListener('dragover', onNativeDragOutOver, true)
  window.removeEventListener('drop', onNativeDragOutOver, true)
  if (silentUpdateTimer) clearTimeout(silentUpdateTimer)
  window.removeEventListener('picnest-check-update-trigger', checkForUpdatesManual)
  browseRO?.disconnect()
})

function isExternal(e) {
  return isExternalDT(e)
}
/* 主展示区兜底：子区（树行/资料库行）会 stopPropagation 抢占各自落点 */
function onDragEnter(e) {
  if (!isExternal(e)) return
  lib.setDropHint('main', lib.mainDropLabel(), e.clientX, e.clientY)
}
function onDragOver(e) {
  if (!isExternal(e)) return
  e.preventDefault()
  lib.setDropHint('main', lib.mainDropLabel(), e.clientX, e.clientY)
}
function onDragLeave(e) {
  if (!lib.dropHint.active) return
  if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth || e.clientY >= innerHeight) lib.clearDropHint()
}
async function onDrop(e) {
  if (!isExternal(e)) return
  lib.clearDropHint()
  const paths = [...(e.dataTransfer.files || [])].map((f) => window.picrand.getFilePath?.(f)).filter(Boolean)
  const urls = extractDropUrls(e.dataTransfer)
  if (!paths.length && !urls.length) return
  /* 主展示区落点 = 当前浏览文件夹（非文件夹视图 → 库根 = 全部/未分类） */
  const target = lib.dropTarget()
  if (paths.length) await lib.importDrop(paths, target)
  else if (urls.length) await lib.importUrls(urls, target)
}
const chipStyle = computed(() => {
  const x = Math.max(8, Math.min(lib.dropHint.x + 18, innerWidth - 260))
  const y = Math.max(8, Math.min(lib.dropHint.y + 20, innerHeight - 46))
  return { left: x + 'px', top: y + 'px' }
})
</script>

<template>
  <div
    class="shell"
    @dragenter="onDragEnter" @dragover="onDragOver" @dragleave="onDragLeave" @drop.prevent="onDrop"
  >
    <SideBar />
    <ResizeHandle v-if="!lib.sidebarCollapsed" store="sidebar" />
    <section class="main-panel">
      <TitleBar />
      <div class="main-inner">
        <!-- 浏览模式：网格 + 详情浮岛（灯箱时保留布局只隐身，滚动位置不丢，与简报退出一致） -->
        <div class="browse" ref="browseEl"
             :class="{ 'lb-behind': lib.lightbox.open, 'insp-h-fixed': lib.inspectorHeight > 0, 'insp-open': lib.viewer.showInspector }"
             :style="{ '--insp-w': lib.inspectorWidth + 'px', '--insp-h': inspEffH + 'px' }">
          <ImageGrid />
          <Transition name="insp">
            <Inspector v-if="lib.viewer.showInspector" :style="{ '--insp-w': lib.inspectorWidth + 'px' }" />
          </Transition>
          <InspResize v-if="lib.viewer.showInspector" />
        </div>
        <!-- 大图工作区：舞台 + 详情计划式浮岛（可收起，滑出动画） -->
        <template v-if="lib.lightbox.open">
          <Lightbox />
          <div class="insp-overlay" :class="{ 'insp-h-fixed': lib.inspectorHeight > 0 }"
               :style="{ '--insp-w': lib.inspectorWidth + 'px', '--insp-h': inspEffH + 'px' }">
            <Transition name="insp">
              <Inspector v-if="lib.viewer.showInspector" :style="{ '--insp-w': lib.inspectorWidth + 'px' }" />
            </Transition>
            <InspResize v-if="lib.viewer.showInspector" />
          </div>
        </template>
      </div>
    </section>
  </div>
  <div v-if="lib.dropHint.active" class="drop-chip" :style="chipStyle">
    <b>松开</b><span>{{ lib.dropHint.label }}</span>
  </div>
  <ContextMenu />
  <DuplicateDialog />
  <ConfirmDialog />
  <DupFinder />
  <BriefMode />
  <TrashMenu />
  <ImportResultCard />
  <TaskProgress />
  <PluginManager />
  <HelpDialog />
  <UpdateDialog ref="updateDialogRef" />
</template>

<style scoped>
.shell { display: flex; height: 100%; position: relative; }
.drop-chip {
  position: fixed; z-index: 760; pointer-events: none;
  display: flex; align-items: center; gap: 8px;
  padding: 6px 11px; border-radius: 8px;
  background: var(--panel-strong); border: 1px solid var(--accent);
  color: var(--accent); font-size: 12px; font-weight: 600;
  box-shadow: var(--shadow); white-space: nowrap;
  animation: chip-in 0.16s var(--ease-overshoot);
}
.drop-chip b { font-size: 10px; letter-spacing: 1px; opacity: 0.7; }
@keyframes chip-in { from { opacity: 0; transform: translateY(4px) scale(0.96); } to { opacity: 1; transform: none; } }
.main-panel {
  flex: 1; min-width: 0; display: flex; flex-direction: column;
  position: relative;
  /* 四边留白 + 悬浮阴影：白窗体压在左栏之上
     上/右 8px（让右上角窗控按钮贴角、行为正常），下 22 / 左 20 保留孤岛水带 */
  margin: 8px 8px 22px 20px; background: var(--panel-strong);
  border: 1px solid var(--border); border-radius: var(--radius-panel);
  box-shadow: var(--shadow-float), inset 0 1px 0 var(--panel-edge);
  overflow: hidden;
}
.main-inner { flex: 1; display: flex; min-height: 0; position: relative; } /* 头块自己让位玻璃顶栏 */
.browse { flex: 1; display: flex; min-height: 0; position: relative; --insp-reserve: 0px; }
.browse.lb-behind { position: absolute; inset: 0; visibility: hidden; pointer-events: none; }
.browse.insp-open { --insp-reserve: calc(var(--insp-w, 296px) + 16px); }
/* 详情统一 overlay：悬浮于内容之上（滚动条自然到最右），两模式同位同尺寸
   top 40 = 顶缘压进玻璃顶栏 2px（高于顶栏），但停在右上角窗控按钮下缘 39 之下 1px；
   z-index 24：玻璃层 20 < 详情 24 < 裁剪层 30 < 栏内容/按钮 45，拖尾不会盖住岛顶；裁剪时返回/窗控优先 */
.browse :deep(.inspector), .insp-overlay :deep(.inspector) {
  position: absolute; top: 40px; right: 10px; bottom: 10px; z-index: 24;
  width: var(--insp-w, 296px); margin: 0; height: auto;
  max-height: none;
  pointer-events: auto;
}
/* 详情高度可调：右下角固定为支点，顶边上移（0 = 自适应满高） */
.browse.insp-h-fixed :deep(.inspector), .insp-overlay.insp-h-fixed :deep(.inspector) {
  top: auto; height: var(--insp-h, auto);
}
.insp-enter-active, .insp-leave-active { transition: transform 0.24s ease, opacity 0.24s ease; }
.insp-enter-from, .insp-leave-to { transform: translateX(40px); opacity: 0; }
/* 大图模式详情容器：必须 inset:0（缺 left 会收缩成手柄宽，overflow:hidden 裁掉整个面板）；
   pointer-events:none 让舞台拖拽/缩放照常，面板与拖宽手柄各自恢复 auto */
.insp-overlay {
  position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 22;
  display: flex; flex-direction: column;
  overflow: hidden;
  pointer-events: none;
}

</style>
