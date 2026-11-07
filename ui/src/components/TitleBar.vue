<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useLibrary } from '../stores/library'
import FilterBar from './FilterBar.vue'
import { api } from '../api'

// 主面板顶栏 = 顶部玻璃条（内容从其底下穿过），按模式变形：
// 浏览模式（面包屑/筛选/布局排列/缩放/搜索） ⇄ 大图模式（返回/序号/缩放）；窗控圆形按钮内联右端
const lib = useLibrary()

const title = computed(() => {
  const names = { all: '全部', recent: '最近使用', random: '随机模式', trash: '回收站', search: '搜索' }
  if (lib.view !== 'all') return { main: names[lib.view] || lib.view, trail: [] }
  if (!lib.currentDirRel) return { main: '全部', trail: [] }
  const parts = lib.currentDirRel.split('/')
  return { main: parts[parts.length - 1], trail: parts.slice(0, -1) }
})

const LAYOUTS = [
  { key: 'grid', icon: '▦', label: '网格' },
  { key: 'justified', icon: '▤', label: '自适应' },
  { key: 'masonry', icon: '▥', label: '瀑布流' },
]
const layoutMeta = computed(() => LAYOUTS.find((l) => l.key === lib.layout) || LAYOUTS[0])
const panelOpen = ref(false)
function togglePanel() { panelOpen.value = !panelOpen.value; lib.filterBarOpen = false }
function toggleFilterBar() { lib.filterBarOpen = !lib.filterBarOpen; panelOpen.value = false }
function closePanel(e) {
  if (!e.target.closest('.vo-wrap') && !e.target.closest('.funnel-pop')) {
    panelOpen.value = false
    lib.filterBarOpen = false
  }
}
onMounted(() => {
  document.addEventListener('click', closePanel)
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', closePanel)
  window.removeEventListener('keydown', onKey)
})

const SORTS = [
  { key: 'name', label: '标题' },
  { key: 'added', label: '添加日期' },
  { key: 'mtime', label: '修改日期' },
  { key: 'size', label: '文件大小' },
  { key: 'dims', label: '尺寸' },
  { key: 'rating', label: '评分' },
  { key: 'random', label: '随机模式' },
]
const sortLabel = computed(() => (SORTS.find((x) => x.key === lib.sortMode) || SORTS[0]).label)

/* 搜索：输入即搜（防抖 350ms），清空回全部 */
const searchText = ref('')
let searchTimer = null
watch(searchText, (v) => {
  clearTimeout(searchTimer)
  if (!v.trim()) {
    if (lib.view === 'search') { lib.view = 'all'; lib.searchQuery = ''; lib.loadImages() }
    return
  }
  searchTimer = setTimeout(() => lib.doSearch(v.trim()), 350)
})

function onKey(e) {
  if (e.ctrlKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
    if (lib.lightbox.open) return
    e.preventDefault()
    lib.filterBarOpen = !lib.filterBarOpen
    if (lib.filterBarOpen) panelOpen.value = false
  }
}
</script>

<template>
  <header class="titlebar glass">
    <!-- ============ 大图工作模式 ============ -->
    <template v-if="lib.lightbox.open">
      <button class="ctl back" title="返回浏览（Esc）" @click="lib.closeLightbox()">←</button>
      <span class="pos">{{ lib.images.findIndex((i) => i.file_path === lib.lightbox.path) + 1 }} / {{ lib.images.length }}</span>
      <div class="zoom-slider">
        <input type="range" min="0.05" max="8" step="0.01" :value="lib.viewer.scale" @input="lib.viewer.scale = Number($event.target.value)" />
        <span class="zpct">{{ Math.round(lib.viewer.scale * 100) }}%</span>
      </div>
      <div class="spacer" />
    </template>

    <!-- ============ 浏览模式 ============ -->
    <template v-else>
      <div class="left">
        <span class="crumb-root">全部</span>
        <template v-if="title.trail.length || title.main !== '全部'">
          <span class="sep">›</span>
          <span v-for="(t, i) in title.trail" :key="i" class="crumb">{{ t }}</span>
          <span class="sep" v-if="title.trail.length">›</span>
          <span class="crumb current">{{ title.main }}</span>
        </template>
        <span v-if="lib.activeFilterCount()" class="count">筛选结果 ({{ lib.filteredImages.length.toLocaleString() }})</span>
        <span v-else-if="lib.images.length" class="count">{{ lib.images.length.toLocaleString() }} 张</span>
      </div>
      <div class="vo-wrap">
        <button class="tool funnel" :class="{ on: lib.filterBarOpen }" title="筛选工具 Ctrl+Shift+F" @click.stop="toggleFilterBar">
          ⧩<i v-if="lib.activeFilterCount()" class="badge">{{ lib.activeFilterCount() }}</i>
        </button>
        <FilterBar v-if="lib.filterBarOpen" class="funnel-pop" />
      </div>
      <div class="vo-wrap">
        <button class="tool" :class="{ on: panelOpen }" :title="`布局：${layoutMeta.label} · 排列：${sortLabel}`" @click.stop="togglePanel">
          {{ layoutMeta.icon }}
        </button>
        <div v-if="panelOpen" class="vo-panel glass-card" @click.stop>
          <div class="vo-row">
            <span class="vo-label">布局方式</span>
            <div class="vo-opts">
              <button v-for="l in LAYOUTS" :key="l.key" class="vo-opt" :class="{ on: lib.layout === l.key }" @click="lib.layout = l.key">{{ l.label }}</button>
            </div>
          </div>
          <div class="vo-row">
            <span class="vo-label">排列方式</span>
            <div class="vo-opts wrap">
              <button v-for="o in SORTS" :key="o.key" class="vo-opt" :class="{ on: lib.sortMode === o.key }" @click="lib.setSort(o.key)">{{ o.label }}</button>
              <button class="vo-opt dir" @click="lib.setSort(undefined, !lib.sortAsc)">{{ lib.sortAsc ? '↑ 升序' : '↓ 降序' }}</button>
            </div>
          </div>
        </div>
      </div>
      <div class="zoom-slider">
        <input type="range" min="0.6" max="3.2" step="0.05" :value="lib.zoom" @input="lib.zoom = Number($event.target.value)" />
      </div>
      <div v-if="lib.view !== 'trash'" class="search">
        <span class="s-icon">⌕</span>
        <input v-model="searchText" placeholder="搜索…" spellcheck="false" />
      </div>
    </template>

    <div class="spacer" />
    <!-- 窗控 + 详情开关：圆形亮色，内联右端（与其他窗口右上角对齐） -->
    <div class="bar-controls">
      <button class="wc" :class="{ on: lib.viewer.showInspector }" title="详情面板（收起/放出）" @click="lib.viewer.showInspector = !lib.viewer.showInspector">◧</button>
      <button class="wc" title="置顶" @click="api.windowToggleAlwaysOnTop()">✦</button>
      <button class="wc" title="最小化" @click="api.windowMinimize()">─</button>
      <button class="wc" title="最大化" @click="api.windowMaximize()">▢</button>
      <button class="wc close" title="关闭" @click="api.windowClose()">✕</button>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  height: 42px; flex: none; display: flex; align-items: center;
  -webkit-app-region: drag;
  background: linear-gradient(180deg, var(--glass-strong) 0%, var(--glass-weak) 100%);
  backdrop-filter: blur(26px) saturate(1.25);
  -webkit-backdrop-filter: blur(26px) saturate(1.25);
  position: relative; z-index: 20;
}
.left { display: flex; align-items: center; gap: 6px; padding-left: 16px; min-width: 0; overflow: hidden; }
.crumb-root { font-size: 12px; color: var(--text-2); }
.sep { color: var(--text-2); font-size: 11px; }
.crumb { font-size: 12px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.crumb.current { color: var(--text); font-weight: 600; }
.count { margin-left: 8px; font-size: 11px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.pos { font-size: 12.5px; color: var(--text-2); font-variant-numeric: tabular-nums; padding: 0 6px; }
.zoom-slider { display: flex; align-items: center; gap: 6px; }
.zoom-slider input { width: 130px; accent-color: var(--accent); height: 3px; }
.zpct { font-size: 11.5px; color: var(--text-2); width: 40px; font-variant-numeric: tabular-nums; }
.spacer { flex: 1; height: 100%; }

.tool {
  height: 28px; min-width: 28px; border: none; border-radius: 8px;
  background: transparent; color: var(--text-2); font-size: 13px; cursor: pointer;
  transition: all 0.15s; padding: 0 7px;
}
.tool:hover { background: var(--accent-weak); color: var(--text); }
.tool.on {
  background: var(--accent-weak); color: var(--accent); font-weight: 600;
  box-shadow: inset 0 0 0 1px var(--accent);
}
.vo-wrap { position: relative; -webkit-app-region: no-drag; }
button.tool.funnel { position: relative; }
button.tool.funnel .badge {
  position: absolute; top: -3px; right: -3px;
  min-width: 14px; height: 14px; border-radius: 7px;
  background: var(--accent); color: #fff; font-size: 9px; font-style: normal;
  display: flex; align-items: center; justify-content: center; padding: 0 3px;
}
.funnel-pop { position: absolute; top: 50px; right: 4px; z-index: 50; border-radius: 16px; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.28); }
.vo-panel {
  position: absolute; top: 50px; right: 4px; z-index: 50; width: 300px; border-radius: 16px; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.28);
  background: var(--panel); backdrop-filter: blur(var(--blur)) saturate(1.2);
}
@keyframes pop { from { transform: translateY(-4px); opacity: 0; } to { transform: none; opacity: 1; } }
.vo-row { display: flex; align-items: flex-start; gap: 10px; padding: 6px 0; }
.vo-label { flex: none; width: 56px; font-size: 12px; color: var(--text-2); padding-top: 5px; }
.vo-opts { display: flex; gap: 6px; flex-wrap: nowrap; }
.vo-opts.wrap { flex-wrap: wrap; }
.vo-opt {
  border: 1px solid var(--border); background: transparent; color: var(--text-2);
  padding: 5px 10px; border-radius: 8px; font-size: 12px; cursor: pointer;
  transition: all 0.15s;
}
.vo-opt:hover { border-color: var(--accent); color: var(--text); }
.vo-opt.on { background: var(--accent-weak); border-color: var(--accent); color: var(--accent); font-weight: 600; }
.vo-opt.dir { margin-left: auto; }

.search {
  display: flex; align-items: center; gap: 4px;
  border: 1px solid var(--border); border-radius: 9px;
  background: var(--bg-2); padding: 0 8px; height: 28px;
  transition: border-color 0.15s;
}
.search:focus-within { border-color: var(--accent); }
.s-icon { color: var(--text-2); font-size: 13px; }
.search input { width: 150px; border: none; background: transparent; outline: none; color: var(--text); font-size: 12px; }
.search input::placeholder { color: var(--text-2); }

/* 窗控 + 详情开关：圆形亮色内联 */
.bar-controls { display: flex; align-items: center; gap: 8px; padding-right: 12px; -webkit-app-region: no-drag; }
.wc {
  width: 30px; height: 30px; border-radius: 50%;
  border: 1px solid var(--border); background: var(--panel-inspector);
  color: var(--text-2); font-size: 12px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s;
}
.wc:hover { background: var(--accent-weak); color: var(--accent); border-color: var(--accent); }
.wc.on { background: var(--accent-weak); color: var(--accent); border-color: var(--accent); font-weight: 600; }
.wc.close:hover { background: #e5484d; color: #fff; border-color: #e5484d; }
</style>
