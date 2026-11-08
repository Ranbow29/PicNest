<script setup>
import { onMounted, ref } from 'vue'
import { useLibrary, extractDropUrls } from './stores/library'
import TitleBar from './components/TitleBar.vue'
import SideBar from './components/SideBar.vue'
import ImageGrid from './components/ImageGrid.vue'
import Inspector from './components/Inspector.vue'
import Lightbox from './components/Lightbox.vue'
import ContextMenu from './components/ContextMenu.vue'
import DuplicateDialog from './components/DuplicateDialog.vue'
import ResizeHandle from './components/ResizeHandle.vue'

// ZCode 式嵌套结构：左栏底层(可拖宽) → 主面板工作区（浏览 ⇄ 大图双模式）→ 详情计划式浮岛(可收起可拖宽)
// 全窗口兜底拖入：外部文件 → 当前浏览目录（树行/侧栏各自的 drop 会 stopPropagation 优先接管）
const lib = useLibrary()
onMounted(() => lib.init())

const importOver = ref(false)
const importNote = ref('')
function isExternal(e) {
  const types = [...(e.dataTransfer?.types || [])]
  return types.includes('Files') || types.includes('text/uri-list')
}
function onDragEnter(e) { if (isExternal(e)) importOver.value = true }
function onDragOver(e) { if (isExternal(e)) e.preventDefault() }
function onDragLeave(e) {
  if (!importOver.value) return
  if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth || e.clientY >= innerHeight) importOver.value = false
}
async function onDrop(e) {
  if (!importOver.value && !isExternal(e)) return
  importOver.value = false
  if (!isExternal(e)) return
  const paths = [...(e.dataTransfer.files || [])].map((f) => window.picrand.getFilePath?.(f)).filter(Boolean)
  const urls = extractDropUrls(e.dataTransfer)
  if (!paths.length && !urls.length) return
  let r = null
  if (paths.length) r = await lib.importDrop(paths)
  else if (urls.length) r = await lib.importUrls(urls)
  if (r?.ok && ((r.copied || 0) + (r.downloaded || 0) + (r.dirs?.length || 0) > 0)) {
    const parts = []
    if (r.copied) parts.push(`录入 ${r.copied} 张`)
    if (r.downloaded) parts.push(`下载 ${r.downloaded} 张`)
    if (r.skipped) parts.push(`跳过重复 ${r.skipped}`)
    if (r.dirs?.length) parts.push(`新文件夹 ${r.dirs.length} 个`)
    importNote.value = parts.join(' · ')
  } else if (r?.error) {
    importNote.value = r.error
  } else if (r?.ok) {
    importNote.value = '没有可录入的内容'
  } else if (r) {
    importNote.value = r.error || '录入失败'
  }
  if (importNote.value) setTimeout(() => { importNote.value = '' }, 2600)
}
</script>

<template>
  <div
    class="shell"
    @dragenter="onDragEnter" @dragover="onDragOver" @dragleave="onDragLeave" @drop.prevent="onDrop"
  >
    <div v-if="importOver" class="import-veil"><span>松开录入</span></div>
    <div v-if="importNote" class="import-note">{{ importNote }}</div>

    <SideBar />
    <ResizeHandle store="sidebar" />
    <section class="main-panel">
      <TitleBar />
      <div class="main-inner">
        <!-- 浏览模式：网格 + 详情浮岛（v-show 保滚动位置） -->
        <div v-show="!lib.lightbox.open" class="browse">
          <ImageGrid :class="{ 'insp-open': lib.viewer.showInspector }" />
          <Transition name="insp">
            <Inspector v-if="lib.viewer.showInspector" :style="{ '--insp-w': lib.inspectorWidth + 'px' }" />
          </Transition>
          <ResizeHandle v-if="lib.viewer.showInspector" store="inspector" invert />
        </div>
        <!-- 大图工作区：舞台 + 详情计划式浮岛（可收起，滑出动画） -->
        <template v-if="lib.lightbox.open">
          <Lightbox />
          <div class="insp-overlay">
            <Transition name="insp">
              <Inspector v-if="lib.viewer.showInspector" :style="{ '--insp-w': lib.inspectorWidth + 'px' }" />
            </Transition>
            <ResizeHandle v-if="lib.viewer.showInspector" store="inspector" invert />
          </div>
        </template>
      </div>
    </section>
  </div>
  <ContextMenu />
  <DuplicateDialog />
</template>

<style scoped>
.shell { display: flex; height: 100%; position: relative; }
.import-veil {
  position: absolute; inset: 0; z-index: 60;
  background: var(--accent-weak); backdrop-filter: blur(2px);
  border: 2px dashed var(--accent); border-radius: 14px; margin: 10px;
  display: flex; align-items: center; justify-content: center;
  pointer-events: none;
}
.import-veil span { font-size: 15px; color: var(--accent); font-weight: 700; letter-spacing: 3px; }
.import-note {
  position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
  z-index: 61; padding: 9px 18px; border-radius: 10px;
  background: var(--panel-strong); border: 1px solid var(--accent); color: var(--accent);
  font-size: 12.5px; box-shadow: var(--shadow); pointer-events: none;
}
.main-panel {
  flex: 1; min-width: 0; display: flex; flex-direction: column;
  position: relative;
  margin: 8px 8px 8px 4px; background: var(--panel-strong);
  border: 1px solid var(--border); border-radius: var(--radius-panel);
  box-shadow: var(--shadow); overflow: hidden;
}
.main-inner { flex: 1; display: flex; min-height: 0; position: relative; } /* 头块自己让位玻璃顶栏 */
.browse { flex: 1; display: flex; min-height: 0; position: relative; }
/* 详情统一 overlay：悬浮于内容之上（滚动条自然到最右），两模式同位同尺寸
   top 64 = 让过 42px 玻璃顶栏 + 20px 拖尾渐隐（顶栏下缘 61，留 3px 呼吸） */
.browse :deep(.inspector), .insp-overlay :deep(.inspector) {
  position: absolute; top: 64px; right: 8px; bottom: 8px; z-index: 12;
  width: var(--insp-w, 296px); margin: 0; height: auto;
  max-height: none;
  pointer-events: auto;
}
.insp-overlay .resize-handle { margin: 64px 0 8px 0; pointer-events: auto; z-index: 12; }
.browse .resize-handle { margin: 64px 0 8px 0; z-index: 12; }
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
