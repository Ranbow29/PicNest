<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useLibrary } from '../stores/library'
import { isTextPath, isVideoPath } from '../lib/fileKinds'
import FilterBar from './FilterBar.vue'
import { api } from '../api'
import AnimIcon from './AnimIcon.vue'
import { collectiveShake, springAt, GESTURE_MS, iconShake } from '../lib/iconMotion'
import { useTheme } from '../lib/theme'

// 主题：auto/light/dark（lib/theme.js 驱动 <html data-theme>）
const theme = useTheme()
const themeOpen = ref(false)
const themeLabel = computed(() => {
  const m = theme.modes.find((x) => x.key === theme.mode.value) || theme.modes[0]
  return m.key === 'auto' ? `跟随系统（${theme.resolved.value === 'mono-dark' ? '墨黑' : '灰白'}）` : m.label
})
const themeGlyph = computed(() => {
  const v = theme.resolved.value
  if (v.startsWith('mono-')) return '◐'
  return v === 'dark' ? '☾' : '☀'
})
/* 主题图标手势：与顶栏其他 AnimIcon 同一套弹簧（挂载/悬停/按下/集体晃动/换主题） */
const themePhase = ref(-1)
let themeRaf = 0
function playTheme() {
  cancelAnimationFrame(themeRaf)
  const t0 = performance.now()
  const tick = (now) => {
    const t = (now - t0) / GESTURE_MS
    if (t >= 1) { themePhase.value = -1; return }
    themePhase.value = t
    themeRaf = requestAnimationFrame(tick)
  }
  themeRaf = requestAnimationFrame(tick)
}
const themeGlyphStyle = computed(() => {
  if (themePhase.value < 0) return {}
  const s = springAt(themePhase.value)
  return { transform: `rotate(${(s * 16).toFixed(2)}deg) scale(${(1 + s * 0.1).toFixed(3)})` }
})
watch(iconShake, playTheme)
watch(() => theme.resolved.value, playTheme)

// 主面板顶栏 = 顶部玻璃条（内容从其底下穿过），按模式变形：
// 浏览模式（面包屑/筛选/布局排列/缩放/搜索） ⇄ 大图模式（返回/序号/缩放）；窗控圆形按钮内联右端
const lib = useLibrary()

const VIEW_NAMES = { recent: '最近使用', random: '随机模式', trash: '回收站', search: '搜索', uncategorized: '未分类' }
/* 面包屑：全部 → 各级祖先 → 当前；全部/祖先可点击跳回 */
const crumbs = computed(() => {
  const out = [{ label: '全部', view: 'all', rel: null }]
  if (lib.view !== 'all') {
    out.push({ label: VIEW_NAMES[lib.view] || lib.view, view: lib.view, current: true })
    return out
  }
  const parts = String(lib.currentDirRel || '').split('/').filter(Boolean)
  parts.forEach((p, i) => out.push({ label: lib.dispName(p), view: 'all', rel: parts.slice(0, i + 1).join('/') }))
  if (!parts.length) out[0].current = true
  else out[out.length - 1].current = true
  return out
})

const LAYOUTS = [
  { key: 'grid', icon: '▦', label: '网格' },
  { key: 'justified', icon: '▤', label: '自适应' },
  { key: 'masonry', icon: '▥', label: '瀑布流' },
]
const layoutMeta = computed(() => LAYOUTS.find((l) => l.key === lib.layout) || LAYOUTS[0])
const lightboxKind = computed(() => {
  const p = lib.lightbox.path
  return isVideoPath(p) ? 'video' : isTextPath(p) ? 'text' : 'image'
})
const panelOpen = ref(false)
const topPinned = ref(false)
async function refreshTopPinned() { try { topPinned.value = !!(await window.picrand.windowIsAlwaysOnTop()) } catch { /* 静默 */ } }
async function toggleTop() { api.windowToggleAlwaysOnTop(); await refreshTopPinned() }
onMounted(refreshTopPinned)
function togglePanel() { panelOpen.value = !panelOpen.value; lib.filterBarOpen = false; themeOpen.value = false; collectiveShake() }
function toggleFilterBar() { lib.filterBarOpen = !lib.filterBarOpen; panelOpen.value = false; themeOpen.value = false; collectiveShake() }
function toggleThemePanel() { themeOpen.value = !themeOpen.value; panelOpen.value = false; lib.filterBarOpen = false; collectiveShake() }
function pickTheme(key) { theme.setMode(key); themeOpen.value = false; collectiveShake() }
function closePanel(e) {
  if (!e.target.closest('.vo-wrap') && !e.target.closest('.funnel-pop')) {
    if (panelOpen.value || lib.filterBarOpen || themeOpen.value) collectiveShake()
    panelOpen.value = false
    lib.filterBarOpen = false
    themeOpen.value = false
  }
}
let themeMountT = 0
onMounted(() => {
  document.addEventListener('click', closePanel)
  window.addEventListener('keydown', onKey)
  themeMountT = setTimeout(playTheme, 80) // 与 AnimIcon 同拍：挂载即晃一次
})
onBeforeUnmount(() => {
  document.removeEventListener('click', closePanel)
  window.removeEventListener('keydown', onKey)
  clearTimeout(themeMountT)
  cancelAnimationFrame(themeRaf)
})

const SORTS = [
  { key: 'manual', label: '手动排序' }, // 默认/最常用：物理顺序与拖动换位都以它为准
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
  if (e.key === 'Escape') {
    if (lib.lightbox.open || lib.brief.open) return // 大图/简报模式自己处理 Esc
    if (panelOpen.value || lib.filterBarOpen || themeOpen.value) {
      e.preventDefault() // 告诉 App 这一下 Esc 已被消费，不再清空选中
      panelOpen.value = false
      lib.filterBarOpen = false
      themeOpen.value = false
      collectiveShake()
    }
    return
  }
  if (e.ctrlKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
    if (lib.lightbox.open) return
    e.preventDefault()
    lib.filterBarOpen = !lib.filterBarOpen
    if (lib.filterBarOpen) { panelOpen.value = false; themeOpen.value = false }
  }
}
</script>

<template>
  <header class="titlebar" :class="{ 'lb-clear': lib.lightbox.open }">
    <div class="glass"></div>
    <div class="drag-surface">
    <div class="bar-content">
    <!-- ============ 大图工作模式 ============ -->
    <template v-if="lib.lightbox.open">
      <button class="ctl back" title="返回浏览（Esc）" @click="lib.closeLightbox()">←</button>
      <span class="pos">{{ lib.images.findIndex((i) => i.file_path === lib.lightbox.path) + 1 }} / {{ lib.images.length }}</span>
      <div class="zoom-slider" v-if="lightboxKind === 'image'">
        <span class="z-sign">−</span>
        <input type="range" min="0.05" max="8" step="0.01" :value="lib.viewer.scale" @input="lib.viewer.scale = Number($event.target.value)" />
        <span class="z-sign">＋</span>
        <span class="zpct">{{ Math.round(lib.viewer.scale * 100) }}%</span>
      </div>
      <span v-else-if="lightboxKind === 'text'" class="zoom-label">文本编辑</span>
      <span v-else class="zoom-label">视频</span>
      <div class="spacer" />
    </template>

    <!-- ============ 浏览模式 ============ -->
    <template v-else>
      <div class="left">
        <button class="nav-arrow" :disabled="!lib.canGoBack" title="返回上一个文件夹" @click="lib.goBack()">←</button>
        <button class="nav-arrow" :disabled="!lib.canGoForward" title="前进到撤回前的文件夹" @click="lib.goForward()">→</button>
        <template v-if="lib.selectionView">
          <span class="crumb current">已选定 {{ lib.selectedDirs.length }} 个文件夹</span>
        </template>
        <template v-else>
          <template v-for="(c, i) in crumbs" :key="i">
            <span v-if="i" class="sep">›</span>
            <button v-if="!c.current" class="crumb-link"
                    @click="c.view === 'all' ? lib.openDir(c.rel) : lib.switchView(c.view)">{{ c.label }}</button>
            <span v-else class="crumb current">{{ c.label }}</span>
          </template>
        </template>
        <span v-if="lib.activeFilterCount()" class="count">筛选结果 ({{ lib.filteredImages.length.toLocaleString() }})</span>
        <span v-else-if="lib.view === 'trash' && (lib.images.length + lib.trashFolders.length)" class="count">{{ (lib.images.length + lib.trashFolders.length).toLocaleString() }} 项</span>
        <span v-else-if="lib.images.length" class="count">{{ lib.images.length.toLocaleString() }} 张</span>
      </div>
      <div class="vo-wrap">
        <button class="tool funnel" :class="{ on: lib.filterBarOpen }" title="筛选工具 Ctrl+Shift+F" @click.stop="toggleFilterBar">
          <AnimIcon name="filter" :size="15" /><i v-if="lib.activeFilterCount()" class="badge">{{ lib.activeFilterCount() }}</i>
        </button>
        <FilterBar v-if="lib.filterBarOpen" class="funnel-pop" />
      </div>
      <div class="vo-wrap">
        <button class="tool" :class="{ on: panelOpen }" :title="`布局：${layoutMeta.label} · 排列：${sortLabel}`" @click.stop="togglePanel">
          <AnimIcon :name="layoutMeta.key === 'grid' ? 'grid' : layoutMeta.key === 'masonry' ? 'layout' : 'justified'" :size="15" />
        </button>
        <div v-if="panelOpen" class="vo-panel glass-card" @click.stop>
          <div class="vo-cap">布局方式</div>
          <div class="seg3" :style="{ '--seg-i': Math.max(0, LAYOUTS.findIndex((l) => l.key === lib.layout)) }">
            <i class="seg-thumb" />
            <button v-for="l in LAYOUTS" :key="l.key" class="seg-cell" :class="{ on: lib.layout === l.key }" @click="lib.setLayout(l.key)">
              <AnimIcon :name="l.key === 'grid' ? 'grid' : l.key === 'masonry' ? 'layout' : 'justified'" :size="15" />{{ l.label }}
            </button>
          </div>
          <div class="vo-cap">
            <span>排列方式</span>
            <button v-if="lib.sortMode !== 'random' && lib.sortMode !== 'manual'" class="vo-dir" @click="lib.setSort(undefined, !lib.sortAsc)">{{ lib.sortAsc ? '↑ 升序' : '↓ 降序' }}</button>
          </div>
          <div class="vo-grid c4">
            <button v-for="o in SORTS" :key="o.key" class="vo-cell sm" :class="{ on: lib.sortMode === o.key }" @click="lib.setSort(o.key)">{{ o.label }}</button>
            <button class="vo-cell sm apply-manual"
                    :disabled="lib.sortMode === 'manual' || !lib.gridOrder.length || lib.view === 'trash'"
                    :title="lib.sortMode === 'manual' ? '当前已经是手动排序' : '按当前显示顺序写入手动排序，并重命名原文件（会先确认）'"
                    @click="lib.applyGridOrderToManual()">{{ lib.sortMode === 'manual' ? '已是手动排序' : '应用为手动排序' }}</button>
          </div>
        </div>
      </div>
      <button class="tool num-btn" :class="{ on: lib.hideOrderNumbers }"
              :title="lib.hideOrderNumbers ? '隐藏排序编号：开（01_ 前缀只影响磁盘名）' : '隐藏排序编号：关（显示真实文件名）'"
              @click.stop="lib.toggleHideOrderNumbers()">01</button>
      <div class="vo-wrap">
        <button class="tool theme-btn" :class="{ on: themeOpen || theme.mode.value !== 'auto' }" :title="`主题：${themeLabel}`"
                @click.stop="toggleThemePanel" @mouseenter="playTheme" @mousedown="playTheme">
          <span class="theme-glyph" :style="themeGlyphStyle">{{ themeGlyph }}</span>
        </button>
        <div v-if="themeOpen" class="vo-panel glass-card theme-panel" @click.stop>
          <div class="vo-cap">主题</div>
          <template v-for="m in theme.modes" :key="m.key">
            <div v-if="m.key === 'mono-light'" class="theme-sep" />
            <button class="theme-opt" :class="{ on: theme.mode.value === m.key }" @click="pickTheme(m.key)">
              <span>{{ m.label }}</span><i v-if="theme.mode.value === m.key">✓</i>
            </button>
          </template>
          <div class="theme-hint">跟随系统随 Windows 明暗切换；黑白主题只改界面，不改变图片</div>
        </div>
      </div>
      <button class="tool help-btn" title="帮助与使用说明" @click.stop="lib.openHelp()">?</button>
      <div class="zoom-slider">
        <span class="z-sign">−</span>
        <input type="range" min="0.6" max="3.2" step="0.05" :value="lib.zoom" @input="lib.setZoom(Number($event.target.value))" />
        <span class="z-sign">＋</span>
      </div>
      <div v-if="lib.view !== 'trash'" class="search">
        <span class="s-icon">⌕</span>
        <input v-model="searchText" placeholder="搜索…" spellcheck="false" />
      </div>
    </template>

    <div class="spacer" />
    <!-- 窗控 + 详情开关：圆形亮色，内联右端（与其他窗口右上角对齐） -->
    <div class="bar-controls">
      <button class="wc" :class="{ on: lib.sidebarCollapsed }" :title="lib.sidebarCollapsed ? '展开左边栏' : '收起左边栏'" @click="lib.toggleSidebar()"><AnimIcon name="sidebar" :size="14" :collapsed="lib.sidebarCollapsed" /></button>
      <button class="wc" :class="{ on: lib.viewer.showInspector }" title="详情面板（收起/放出）" @click="lib.toggleInspector()"><AnimIcon name="contents" :size="14" /></button>
      <button class="wc" :class="{ on: topPinned }" :title="topPinned ? '取消置顶（当前置顶中）' : '置顶窗口'" @click="toggleTop"><AnimIcon name="pin" :size="14" :active="topPinned" /></button>
      <button class="wc" title="最小化" @click="api.windowMinimize()">─</button>
      <button class="wc" title="最大化" @click="api.windowMaximize()">▢</button>
      <button class="wc close" title="关闭" @click="api.windowClose()">✕</button>
    </div>
    </div>
    </div><!-- /drag-surface -->
  </header>
</template>

<style scoped>
.titlebar {
  position: absolute; top: 0; left: 0; right: 0;
  height: 42px;
  /* 不建 z 上下文：玻璃 20 < 详情浮岛 24 < 栏内容/窗控 26（Feb 指定详情压在顶栏之上、按钮之下） */
}
/* 纯视觉玻璃层：不背 app-region（不进拖拽位图），backdrop-filter 决不能与 drag 同体 */
.glass {
  position: absolute; inset: 0; pointer-events: none; z-index: 20;
  background: linear-gradient(180deg, var(--glass-strong) 0%, var(--glass-weak) 100%);
  backdrop-filter: blur(26px) saturate(1.25);
  -webkit-backdrop-filter: blur(26px) saturate(1.25);
}
/* 拖拽命中面：透明底层；实际标题栏拖动由 .bar-content 的 -webkit-app-region 交给 Windows 原生循环 */
.drag-surface {
  position: absolute; inset: 0;
}
/* 玻璃拖尾：栏体下方 20px 继续模糊渐隐——内容“溶”进顶栏（Wenku8 式） */
.titlebar::after {
  content: '';
  position: absolute; top: 42px; left: 0; right: 0; height: 20px; z-index: 20;
  backdrop-filter: blur(26px) saturate(1.25);
  -webkit-backdrop-filter: blur(26px) saturate(1.25);
  background: linear-gradient(180deg, var(--glass-weak), transparent);
  pointer-events: none;
}
/* 大图模式：顶栏不铺玻璃，只留一条自上而下渐隐的柔光罩——图片压到顶栏下时控件仍读得清 */
.titlebar.lb-clear .glass {
  background: linear-gradient(180deg, var(--glass-strong) 0%, var(--glass-weak) 55%, transparent 100%);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
.titlebar.lb-clear::after { display: none; }
.bar-content {
  /* 45 > 裁剪层 30 / 裁剪条 40：裁剪时左上返回与右上窗控必须可点 */
  position: relative; z-index: 45; height: 42px; display: flex; align-items: center;
  -webkit-app-region: drag; /* 交给 Windows 原生标题栏移动循环：拖动窗口不再逐帧 IPC */
}
/* 拖拽区里的交互控件必须显式挖空，否则会被当成标题栏 */
.bar-content button, .bar-content input, .bar-content a,
.bar-content .vo-wrap, .bar-content .zoom-slider, .bar-content .search,
.bar-content .bar-controls, .bar-content [data-no-drag] { -webkit-app-region: no-drag; }
.left { display: flex; align-items: center; gap: 6px; padding-left: 16px; min-width: 0; overflow: hidden; }
.nav-arrow {
  width: 24px; height: 24px; flex: none; border: none; border-radius: 7px;
  display: flex; align-items: center; justify-content: center;
  background: transparent; color: var(--text-2); font-size: 14px; line-height: 1;
  cursor: pointer; transition: background 0.15s, color 0.15s;
}
.nav-arrow:hover:not(:disabled) { background: var(--accent-weak); color: var(--accent); }
.nav-arrow:disabled { opacity: 0.28; cursor: default; }
.crumb-link {
  border: none; background: transparent; padding: 2px 3px; border-radius: 5px;
  color: var(--text-2); font-size: 12px; cursor: pointer;
  max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}
.crumb-link:hover { background: var(--accent-weak); color: var(--accent); }
.crumb-root { font-size: 12px; color: var(--text-2); }
.sep { color: var(--text-2); font-size: 11px; }
.crumb { font-size: 12px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.crumb.current { color: var(--text); font-weight: 600; }
.count { display: inline-block; min-width: 126px; margin-left: 8px; font-size: 11px; color: var(--text-2); font-variant-numeric: tabular-nums; /* 实测到 10,000 需 125px：位数进位不推挤右侧按钮 */ }
.pos { font-size: 12.5px; color: var(--text-2); font-variant-numeric: tabular-nums; padding: 0 6px; }
.zoom-label { font-size: 11px; letter-spacing: 2px; color: var(--text-2); padding: 0 8px; }
/* 灯箱返回钮（此前无任何样式，裸按钮） */
.ctl.back {
  height: 28px; min-width: 30px; margin-left: 16px; padding: 0 8px;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg-2); color: var(--text-2); font-size: 13px; cursor: pointer;
  transition: all 0.15s;
}
.ctl.back:hover { border-color: var(--accent); color: var(--text); }
.zoom-slider { display: flex; align-items: center; gap: 6px; }
.z-sign { font-size: 12px; color: var(--text-2); }
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
.vo-wrap { position: relative; display: flex; align-items: center; }
.help-btn { min-width: 28px; font-weight: 700; font-size: 14px; }
/* 隐藏排序编号开关：物理排序的 01_ 前缀只在显示层隐藏 */
.num-btn { font-family: Consolas, var(--font-mono, monospace); font-size: 11px; letter-spacing: 0.3px; min-width: 30px; }
/* ---- 主题选择 ---- */
.theme-btn {
  padding: 0 7px; min-width: 29px;
  display: inline-flex; align-items: center; justify-content: center;
}
.theme-glyph {
  font-family: 'Segoe UI Symbol', var(--font-sans); font-size: 15px; line-height: 1;
  display: inline-block; transform-origin: 50% 50%; will-change: transform;
}
.theme-panel { width: 196px; padding: 4px 8px 8px; }
.theme-opt {
  display: flex; align-items: center; justify-content: space-between; width: 100%;
  border: none; background: transparent; color: var(--text);
  padding: 8px 10px; border-radius: 8px; font-size: 12.5px; cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.theme-opt:hover { background: var(--accent-weak); }
.theme-opt.on { color: var(--accent); font-weight: 600; }
.theme-sep { height: 1px; margin: 5px 8px; background: var(--border); }
.theme-hint { padding: 6px 10px 2px; font-size: 10.5px; line-height: 1.5; color: var(--text-2); opacity: 0.8; }
button.tool.funnel { position: relative; }
button.tool.funnel .badge {
  position: absolute; top: -3px; right: -3px;
  min-width: 14px; height: 14px; border-radius: 7px;
  background: var(--accent); color: #fff; font-size: 9px; font-style: normal;
  display: flex; align-items: center; justify-content: center; padding: 0 3px;
}
.funnel-pop { position: absolute; top: 50px; left: 0; z-index: 50; border-radius: 16px; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.28); }
.vo-panel {
  position: absolute; top: 50px; left: 0; z-index: 50; width: 300px; border-radius: 16px; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.28);
  background: var(--panel); backdrop-filter: blur(var(--blur)) saturate(1.2);
  padding: 4px 14px 8px;
}
@keyframes pop { from { transform: translateY(-4px); opacity: 0; } to { transform: none; opacity: 1; } }
/* 分组标题 + 网格：布局 3 列图标格，排列 4 列紧凑格，升降序在组标题右侧 */
.vo-cap {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 11.5px; color: var(--text-2); letter-spacing: 1px; padding: 7px 2px 6px;
}
.vo-dir { border: none; background: transparent; color: var(--accent); font-size: 11px; cursor: pointer; padding: 0; letter-spacing: 0; }
.vo-dir:hover { text-decoration: underline; }
.vo-grid { display: grid; gap: 6px; }
.vo-grid.c4 { grid-template-columns: repeat(4, 1fr); padding-bottom: 4px; }
/* 玻璃分段钮（Wenku8 GlassChoiceGroup 语义）：滑动指示器 + 过冲曲线 */
.seg3 {
  position: relative; display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 0; padding: 4px; border: 1px solid var(--border); border-radius: 12px;
  background: var(--bg-2);
}
.seg-thumb {
  position: absolute; top: 4px; bottom: 4px; left: 4px;
  width: calc((100% - 8px) / 3);
  transform: translateX(calc(var(--seg-i, 0) * 100%));
  transition: transform 280ms var(--ease-overshoot);
  background: var(--accent-weak); border: 1px solid var(--accent); border-radius: 9px;
  pointer-events: none;
}
.seg-cell {
  position: relative; z-index: 1;
  display: flex; flex-direction: column; align-items: center; gap: 3px;
  border: none; background: transparent; color: var(--text-2);
  border-radius: 9px; padding: 7px 4px; font-size: 12px; cursor: pointer;
  transition: color 0.15s;
}
.seg-cell i { font-style: normal; font-size: 15px; line-height: 1; }
.seg-cell:hover { color: var(--text); }
.seg-cell.on { color: var(--accent); font-weight: 600; }
.vo-cell {
  display: flex; flex-direction: column; align-items: center; gap: 3px;
  border: 1px solid var(--border); background: transparent; color: var(--text-2);
  border-radius: 10px; padding: 8px 4px 7px; font-size: 12px; cursor: pointer;
  transition: all 0.15s;
}
.vo-cell i { font-style: normal; font-size: 15px; line-height: 1; }
.vo-cell:hover { border-color: var(--accent); color: var(--text); }
.vo-cell.on { background: var(--accent-weak); border-color: var(--accent); color: var(--accent); font-weight: 600; }
.vo-cell.sm { flex-direction: row; justify-content: center; padding: 6px 2px; }
.vo-cell.apply-manual { grid-column: 1 / -1; margin-top: 2px; border-style: dashed; font-size: 11.5px; }
.vo-cell.apply-manual:disabled { opacity: 0.45; cursor: not-allowed; }

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
.bar-controls { display: flex; align-items: center; gap: 2px; padding-right: 10px; }
.wc {
  width: 34px; height: 34px; border-radius: 8px;
  border: none; background: transparent;
  color: var(--text-2); font-size: 12px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s;
}
.wc:hover { background: var(--accent-weak); color: var(--text); }
.wc.on { background: var(--accent-weak); color: var(--accent); font-weight: 600; box-shadow: inset 0 0 0 1px var(--accent); }
.wc.close:hover { background: #e5484d; color: #fff; }
</style>
