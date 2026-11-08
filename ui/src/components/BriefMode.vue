<script setup>
// 简报模式：全屏黑底演示（Eagle 语义），单击下一张 / 右键上一张 / ←→ / Esc 退出
import { computed, onMounted, onBeforeUnmount } from 'vue'
import { useLibrary } from '../stores/library'
import { fileUrl } from '../api'
import { isTextPath, isVideoPath } from '../lib/fileKinds'

const lib = useLibrary()
const url = computed(() => (lib.brief.path ? fileUrl(lib.brief.path) : ''))
const kind = computed(() => {
  const p = lib.brief.path
  return isVideoPath(p) ? 'video' : isTextPath(p) ? 'text' : 'image'
})
const idx = computed(() => Math.max(0, lib.images.findIndex((i) => i.file_path === lib.brief.path)))
function next() { lib.briefNav(1) }
function prev() { lib.briefNav(-1) }
function onFsChange() {
  if (!document.fullscreenElement && lib.brief.open) lib.closeBrief()
}
onMounted(() => document.addEventListener('fullscreenchange', onFsChange))
onBeforeUnmount(() => document.removeEventListener('fullscreenchange', onFsChange))
</script>

<template>
  <Teleport to="body">
    <div v-if="lib.brief.open" class="brief" @click="next" @contextmenu.prevent="prev">
      <img v-if="kind === 'image'" :src="url" :class="{ gray: lib.grayscaleMode }" draggable="false" alt="" />
      <video v-else-if="kind === 'video'" :src="url" autoplay muted loop playsinline :class="{ gray: lib.grayscaleMode }" />
      <div v-else class="brief-empty">
        {{ kind === 'text' ? '文本文件暂不支持简报模式' : '该文件暂不支持简报模式' }}<br />
        <span>← → 仍可切到下一张</span>
      </div>
      <div class="brief-count">{{ idx + 1 }} / {{ lib.images.length }}</div>
      <div class="brief-hint">← → 切换 · 单击下一张 · 右键上一张 · Esc 退出</div>
      <button class="brief-x" title="退出（Esc）" @click.stop="lib.closeBrief()">✕</button>
    </div>
  </Teleport>
</template>

<style scoped>
.brief {
  position: fixed; inset: 0; z-index: 990;
  display: flex; align-items: center; justify-content: center;
  background: #0b0b0d; cursor: default; user-select: none;
}
.brief img, .brief video { max-width: 100vw; max-height: 100vh; object-fit: contain; display: block; }
.brief .gray { filter: grayscale(1); }
.brief-empty { color: #8d877c; font-size: 14px; line-height: 2; text-align: center; }
.brief-empty span { font-size: 11.5px; opacity: 0.7; }
.brief-count {
  position: fixed; top: 18px; left: 22px; color: #b9b3a7;
  font: 12px Consolas, monospace; opacity: 0.65; pointer-events: none;
}
.brief-hint {
  position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
  color: #8d877c; font-size: 11.5px; letter-spacing: 0.5px;
  opacity: 0.6; pointer-events: none; white-space: nowrap;
}
.brief-x {
  position: fixed; top: 12px; right: 14px; width: 30px; height: 30px;
  border: none; border-radius: 9px; background: rgba(255, 255, 255, 0.06);
  color: #b9b3a7; font-size: 13px; cursor: pointer;
}
.brief-x:hover { background: rgba(255, 255, 255, 0.14); color: #fff; }
</style>
