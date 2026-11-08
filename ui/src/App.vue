<script setup>
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useLibrary, extractDropUrls } from './stores/library'
import TitleBar from './components/TitleBar.vue'
import SideBar from './components/SideBar.vue'
import ImageGrid from './components/ImageGrid.vue'
import Inspector from './components/Inspector.vue'
import Lightbox from './components/Lightbox.vue'
import ContextMenu from './components/ContextMenu.vue'
import DuplicateDialog from './components/DuplicateDialog.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import TrashMenu from './components/TrashMenu.vue'
import ImportResultCard from './components/ImportResultCard.vue'
import ResizeHandle from './components/ResizeHandle.vue'

// ZCode 式嵌套结构：左栏底层(可拖宽) → 主面板工作区（浏览 ⇄ 大图双模式）→ 详情计划式浮岛(可收起可拖宽)
// 外部拖入 = 位置即意图：主展示区/树行/缝隙/资料库栏各自高亮 + 跟随光标的落点提示
const lib = useLibrary()
/* 复制/粘贴快捷键（输入框内保留原生行为；有文本选择时让浏览器复制文本） */
function isTypingTarget(el) {
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}
function onKeydown(e) {
  if (e.defaultPrevented) return // TitleBar 已处理（Esc 关布局/筛选弹板）
  const key = String(e.key || '').toLowerCase()
  if (key === 'escape') {
    /* 分层退出：输入框/灯箱/弹窗/右键菜单各有其主，都没有才清空选中 */
    if (isTypingTarget(e.target)) return
    if (lib.lightbox.open) return // Lightbox 自己处理（含裁剪态）
    if (lib.confirmDialog.open) { lib.resolveConfirm(false); return }
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
onMounted(() => {
  lib.init()
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('drop', clearDropUi, true)
  window.addEventListener('dragend', clearDropUi, true)
  window.addEventListener('dragleave', onWindowDragLeave, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('drop', clearDropUi, true)
  window.removeEventListener('dragend', clearDropUi, true)
  window.removeEventListener('dragleave', onWindowDragLeave, true)
})

function isExternal(e) {
  const types = [...(e.dataTransfer?.types || [])]
  return types.includes('Files') || types.includes('text/uri-list')
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
    <ResizeHandle store="sidebar" />
    <section class="main-panel">
      <TitleBar />
      <div class="main-inner">
        <!-- 浏览模式：网格 + 详情浮岛（v-show 保滚动位置） -->
        <div v-show="!lib.lightbox.open" class="browse" :style="{ '--insp-w': lib.inspectorWidth + 'px' }">
          <ImageGrid :class="{ 'insp-open': lib.viewer.showInspector }" />
          <Transition name="insp">
            <Inspector v-if="lib.viewer.showInspector" :style="{ '--insp-w': lib.inspectorWidth + 'px' }" />
          </Transition>
          <ResizeHandle v-if="lib.viewer.showInspector" store="inspector" invert />
        </div>
        <!-- 大图工作区：舞台 + 详情计划式浮岛（可收起，滑出动画） -->
        <template v-if="lib.lightbox.open">
          <Lightbox />
          <div class="insp-overlay" :style="{ '--insp-w': lib.inspectorWidth + 'px' }">
            <Transition name="insp">
              <Inspector v-if="lib.viewer.showInspector" :style="{ '--insp-w': lib.inspectorWidth + 'px' }" />
            </Transition>
            <ResizeHandle v-if="lib.viewer.showInspector" store="inspector" invert />
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
  <TrashMenu />
  <ImportResultCard />
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
  /* 四边留白 + 悬浮阴影：白窗体压在左栏之上（左缝 10px，其余 12px） */
  margin: 12px 12px 12px 10px; background: var(--panel-strong);
  border: 1px solid var(--border); border-radius: var(--radius-panel);
  box-shadow: var(--shadow-float), inset 0 1px 0 var(--panel-edge);
  overflow: hidden;
}
.main-inner { flex: 1; display: flex; min-height: 0; position: relative; } /* 头块自己让位玻璃顶栏 */
.browse { flex: 1; display: flex; min-height: 0; position: relative; }
/* 详情统一 overlay：悬浮于内容之上（滚动条自然到最右），两模式同位同尺寸
   top 64 = 让过 42px 玻璃顶栏 + 20px 拖尾渐隐（顶栏下缘 61，留 3px 呼吸） */
.browse :deep(.inspector), .insp-overlay :deep(.inspector) {
  position: absolute; top: 64px; right: 10px; bottom: 10px; z-index: 12;
  width: var(--insp-w, 296px); margin: 0; height: auto;
  max-height: none;
  pointer-events: auto;
}
/* 详情宽度拖拽柄：骑在浮岛左缘（原先贴着窗口右缘，方向反直觉） */
.browse > .resize-handle, .insp-overlay .resize-handle {
  position: absolute; top: 64px; bottom: 10px; right: calc(var(--insp-w, 296px) + 6px);
  width: 8px; height: auto; margin: 0; z-index: 13; pointer-events: auto;
}
.browse > .resize-handle:hover, .browse > .resize-handle:active,
.insp-overlay .resize-handle:hover, .insp-overlay .resize-handle:active {
  box-shadow: inset -1px 0 0 var(--accent); /* 高光线贴浮岛左缘 */
}
.insp-enter-active, .insp-leave-active { transition: transform 0.24s ease, opacity 0.24s ease; }
.insp-enter-from, .insp-leave-to { transform: translateX(40px); opacity: 0; }
/* 大图模式详情容器：必须 inset:0（缺 left 会收缩成手柄宽，overflow:hidden 裁掉整个面板）；
   pointer-events:none 让舞台拖拽/缩放照常，面板与拖宽手柄各自恢复 auto */
.insp-overlay {
  position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 15;
  display: flex; flex-direction: column;
  overflow: hidden;
  pointer-events: none;
}

</style>
