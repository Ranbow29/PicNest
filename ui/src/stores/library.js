import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import { deltaE76, deltaE2000, isGrayPalettes } from '../lib/eagleColor'
import { collectiveShake } from '../lib/iconMotion'
import { emitPluginEvent } from '../lib/plugins'
import { isTextPath } from '../lib/fileKinds'
import { playTrashSound, playRestoreSound, playPurgeSound } from '../lib/soundFx'
import { api, fileUrl, onFsDirChanged } from '../api'

/* 诊断上报：走已缓存的 invoke。以前每次调用都 dynamic import('@tauri-apps/api/core')，
   一次导航要付 3~4 次模块解析 + IPC。
   2026-11-14：又发现原版 Electron 根本没有这套 diag 上报（grep 原版 api.js/store 为 0 命中），
   属于新版独有的纯冗余：一次导航多 4–5 次 IPC 往返，IPC 堵塞时还会跟着排队。
   现在默认不发：要开就在 DevTools 里 `localStorage.picnestDebug = '1'` 再刷新。 */
let _diagEnabled = null
const diagEnabled = () => {
  if (_diagEnabled === null) {
    try { _diagEnabled = localStorage.getItem('picnestDebug') === '1' } catch { _diagEnabled = false }
  }
  return _diagEnabled
}

let _diagInvoke = null
export function diagLog(msg) {
  if (!diagEnabled()) return
  try {
    const p = window.picrand?.diagEvent
    if (typeof p === 'function') { p(String(msg)); return }
    if (_diagInvoke === null) {
      const inv = window.__TAURI_INTERNALS__?.invoke
      _diagInvoke = typeof inv === 'function' ? inv : false
    }
    if (_diagInvoke) {
      const r = _diagInvoke('diag_event', { msg: String(msg) })
      if (r && typeof r.catch === 'function') r.catch(() => {})
    }
  } catch { /* 诊断永不影响主流程 */ }
}

// 图巢核心状态：根文件夹（物理目录）→ 派生目录树 → 子目录图片
// 从拖拽数据里提取图片 URL（浏览器拖图入库，Eagle 同款细节）
export function extractDropUrls(dt) {
  const urls = new Set()
  const httpRe = new RegExp('^https?://', 'i')
  try {
    const uri = dt.getData('text/uri-list')
    for (const line of (uri || '').split(String.fromCharCode(10))) {
      const u = line.trim()
      if (u && !u.startsWith('#') && httpRe.test(u)) urls.add(u)
    }
  } catch { /* silent */ }
  try {
    const html = dt.getData('text/html')
    if (html) {
      const doc = new DOMParser().parseFromString(html, 'text/html')
      for (const img of doc.querySelectorAll('img[src]')) {
        const u = img.getAttribute('src') || ''
        if (httpRe.test(u)) urls.add(u)
      }
    }
  } catch { /* silent */ }
  return [...urls]
}

function aiPriceDefault() {
  const v = Number(localStorage.getItem('picnest.aiPricePerM') || 0)
  return Number.isFinite(v) && v > 0 ? v : 0
}

function defaultAiDupState() {
  return {
    configLoaded: false, baseUrl: '', model: '', hasKey: false, encrypted: true,
    models: [], modelsLoading: false, modelsError: '',
    // 勾选状态要持久化：之前写死 false，每次重开 app 都回到未勾选，
    // 而「开始 AI 查重」按钮的条件是 `!hasKey || !allowed`，于是永久置灰，
    // 表现就是“AI 查重根本不走 AI”。
    allowed: (() => {
      try { return localStorage.getItem('picnest.aiDupAllowed') === '1' } catch { return false }
    })(),
    maxPairs: 40, pricePerM: aiPriceDefault(),
    loading: false, testing: false, canceling: false,
    note: '', noteErr: false,
    progress: { phase: '', done: 0, total: 0, candidates: 0 },
    groups: [], stats: null, error: '',
  }
}

/* 查重保留规则：不同后缀是否各留一张（jpg/jpeg 视为同一种） */
function dupExtKey(filePath) {
  const base = String(filePath || '').split(/[\\/]/).pop() || ''
  const m = /\.([A-Za-z0-9]+)$/.exec(base)
  let e = m ? m[1].toLowerCase() : '(none)'
  if (e === 'jpeg' || e === 'jpe' || e === 'jfif') e = 'jpg'
  if (e === 'tif') e = 'tiff'
  return e
}
function dupPickKeeper(files, mode) {
  if (!files?.length) return null
  if (mode === 'newest') return files.reduce((a, b) => ((b.mtime || 0) > (a.mtime || 0) ? b : a), files[0])
  if (mode === 'oldest') return files.reduce((a, b) => ((b.mtime || 0) < (a.mtime || 0) ? b : a), files[0])
  if (mode === 'largest') return files.reduce((a, b) => ((b.size || 0) > (a.size || 0) ? b : a), files[0])
  return files[0]
}
function dupKeepers(files, mode, preserveExt) {
  if (!files?.length) return []
  if (!preserveExt) return [dupPickKeeper(files, mode)].filter(Boolean)
  const byExt = new Map()
  for (const f of files) {
    const k = dupExtKey(f.path)
    if (!byExt.has(k)) byExt.set(k, [])
    byExt.get(k).push(f)
  }
  return [...byExt.values()].map((arr) => dupPickKeeper(arr, mode)).filter(Boolean)
}
function dupPreserveDefault() {
  try { return localStorage.getItem('picnest.dupPreserveExt') !== '0' } catch { return true }
}

/* 位置的唯一指纹：根 / 视图 / 目录 / 多选文件夹。
   只要它变了，说明界面已经换了地方，旧 images 就不能再画到网格上。 */
function locKeyOf(s) {
  const sel = s.selectionView && s.selectedDirs?.length ? s.selectedDirs.join('|') : ''
  return `${s.activeRootId}::${s.view}::${s.currentDirRel ?? ''}::${sel}`
}

/* 非响应式模块级颜色距离表：避免 filteredImages getter 在计算时改写 Pinia state 引起响应式依赖抖动 */
let _colorDistMap = Object.create(null)

export const useLibrary = defineStore('library', {
  state: () => ({
    roots: [],            // [{id, path, display_name}]
    activeRootId: null,
    tree: null,           // {rootPath, tree: {name, rel, count, total, children}}
    counts: { all: 0 },
    dirMemory: {},           // rel -> { color?, expanded? }（refreshTree 时全表缓存）
    dirMenu: { open: false, x: 0, y: 0, rel: '', node: null },
    view: 'all',          // all | recent | random | trash | search
    navHistory: [],       // 浏览历史 [{rootId, view, rel}]（后退/前进）
    navIndex: -1,
    searchQuery: '',
    currentDirRel: null,  // null=全部；''=根层；'a/b'=子目录
    images: [],
    gridOrder: [],           // 当前网格实际显示顺序（ImageGrid 回写；「应用为手动排序」用）
    loading: false,
    scanning: false,
    scanNote: '',
    error: '',
    selectedPath: null,
    selectedPaths: [],        // 多选（Shift 范围 / Alt 加选）；selectedPath = 主选中（详情/大图）
    selectionAnchor: null,    // Shift 范围锚点
    selectedDirs: [],         // 文件夹多选（rel）
    dirAnchor: null,
    selectionView: false,     // 多选文件夹 → 网格显示所选文件夹的合并内容
    hoverLabels: true,    // 网格悬停显字（M5 视图选项可关）
    showSubfolderContent: localStorage.getItem('picnest.showSubfolderContent') !== '0', // 文件夹视图：是否包含子文件夹图片
    layout: localStorage.getItem('picnest.layout') || 'grid',       // grid | justified | masonry（持久化）
    /* 2026-11-14：排序支持写进文件名（physicalOrder 开关），所以界面也需要能把 01_ 前缀隐藏起来。
       hideOrderNumbers 默认开：磁盘名保留前缀，界面只显示后面的真名。 */
    hideOrderNumbers: localStorage.getItem('picnest.hideOrderNumbers') !== '0',
    zoom: Number(localStorage.getItem('picnest.zoom')) || 1,          // 顶栏缩放滑条（持久化）
    sortMode: localStorage.getItem('picnest.sortMode') || 'manual',    // manual 默认/最重要；name|added|mtime|size|dims|rating|random
    /* 拖动排序后自动写文件名（只改名字，不动内容）。**默认关**：
       排序默认只存元数据；想要磁盘名也跟着排，右击根文件勾「排序同步文件名」。 */
    physicalOrder: localStorage.getItem('picnest.physicalOrder') === '1',
    /* 收到新图后，把目标文件夹提到同级第一位。只写 picnest_dir_order，不改文件名。
       关掉就回到“新目录排最后、靠拖拽调”。 */
    autoPinOnImport: localStorage.getItem('picnest.autoPinOnImport') !== '0',
    sortAsc: localStorage.getItem('picnest.sortAsc') !== '0',
    randomNonce: 0,       // 随机排序的种子换代
    layoutTick: 0,        // 尺寸回填后触发重排
    /* 当前 images 数组到底属于哪个位置：切目录/切视图后立刻失配，
       网格据此停止渲染旧图（宁可空白骨架，也不能让新标题配旧图）。 */
    loadedLocKey: '',
    /* 最近看过的目录列表缓存（键=根|视图|目录）：切回上一个文件夹时直接秒出，
       不再走「先 60 行再补全量」的中间态，避免列表条数跳变导致的不跟手。
       使用 markRaw 避免 Pinia 对 LRU Map 做深层响应式代理追踪 */
    _listCache: markRaw(new Map()),
    _inflightAbort: null,
    /* 切换后超过 200ms 还没拿到数据才算「慢」：快切换时保留旧图无缝替换，
       不让网格闪成骨架屏 */
    pendingSlow: false,
    dimsFilling: false,
    thumbsFilling: false,
    lightbox: { open: false, path: null },
    brief: { open: false, path: null, scale: 1, tx: 0, ty: 0 }, // 简报模式（全屏演示）
    grayscaleMode: localStorage.getItem('picnest.grayscale') === '1', // 黑白预览（全局显示开关）
    cardTilt3D: localStorage.getItem('picnest.cardTilt3D') === '1', // 网格卡片 3D 视差微倾 + 柔光掠影（默认关闭，个性化开启）
    soundFx: localStorage.getItem('picnest.soundFx') !== '0', // 交互音效（移入回收站与还原提示音，默认开启）
    showMascots: (() => {
      try {
        const s = localStorage.getItem('picnest.mascots')
        if (s !== null) return s === '1'
        return String(localStorage.getItem('picnest.theme') || '').startsWith('obsidian-')
      } catch { return false }
    })(), // 侧栏底部像素双宠伴侣（小紫猫 & 小克）
    docPrivacyMode: localStorage.getItem('picnest.docPrivacyMode') !== '0', // 文档隐私折叠（默认开启：保护敏感文档隐私，未显式设为 '0' 即生效）
    contextMenu: { open: false, x: 0, y: 0, image: null },
    renaming: false,
    dupDialog: { open: false, items: [], targetRel: undefined, mode: 'files', count: 0, resolve: null },
    dupFinder: { open: false, rootId: null, rel: '', mode: 'exact', loading: false, canceling: false, canceled: false, progress: { done: 0, total: 0 }, groups: [], stats: null, error: '', selected: [], preserveExt: true, ai: defaultAiDupState() },
    taskProgress: { visible: false, kind: '', label: '', done: 0, total: 0, cancelable: false, canceling: false }, // 长任务浮条（文件夹查重/缩略图修复）
    confirmDialog: { open: false, title: '', message: '', details: [], confirmText: '确定', danger: false, resolve: null },
    importResult: { open: false, nonce: 0, summary: '', details: [], tone: 'ok' }, // 录入汇总结果卡
    clipboard: { kind: '', paths: [], count: 0, root: false }, // 应用内复制剪贴板（kind: dirs | files）
    trashFolders: [],       // 回收站里的文件夹条目（文件夹形式软删）
    trashMenu: { open: false, x: 0, y: 0 },
    suppressSyncUntil: 0,   // 内部移动/排序后短暂忽略 watcher 触发的全量刷新
    suppressWaveUntil: 0,   // 内部移动/排序时抑制入场波动画
    dropHint: { active: false, zone: '', label: '', x: 0, y: 0, key: null }, // 外部拖入落点提示（分区高亮 + 跟随光标）
    viewer: { scale: 1, tx: 0, ty: 0, rot: 0, flopX: false, showInspector: false, /* 初始收起：让用户先看图，详情随点随开 */ cropMode: false, fitNonce: 0 },
    filterBarOpen: false,
    pluginsOpen: false,          // 插件库面板
    helpOpen: false,             // 帮助 / 使用说明
    visualSearch: {
      open: false,
      tasks: [],
      activeTaskId: null,
      engine: 'pinterest',       // 'pinterest' | 'huaban' | 'hybrid'
      scale: 240,                // 瀑布流卡片宽度 160 ~ 420
      alwaysOnTop: false,
    },
    filters: {
      shapes: [],            // ['landscape','portrait','square','panoramaL','panoramaP','43','34','169','916','custom']
      customW: 4, customH: 3,
      ratings: [],           // [0-5]，0=尚未评分
      formats: [],           // 包含的扩展名（小写）
      formatEx: [],          // 排除的扩展名
      folders: [],           // 包含的子目录 rel
      tags: [],              // 标签 id（任一命中）
      color: { on: false, gray: false, value: null, accuracy: 20 },
    },
    tags: [],                // [{id,name,count}] 当前根
    imageTags: {},           // imageId -> [tagId]（当前根，不含回收站）
    palettes: {},            // file_path -> [{r,g,b,percent}]
    displayThumbs: {},       // file_path -> { p: 1024px 显示图路径|'' , m: modify_time }（网格大格用）
    paletteBuild: { running: false, done: 0, total: 0 },
    /* v2 布局：文件夹区加宽到 264；旧版存过的窄宽度（<264）一次性迁移抬升，之后尊重用户拖拽值 */
    sidebarWidth: (() => { const w = Number(localStorage.getItem('picnest.sidebarWidth')) || 0; if (localStorage.getItem('picnest.sidebarLayoutV') !== '2') { localStorage.setItem('picnest.sidebarLayoutV', '2'); if (w && w < 264) { localStorage.setItem('picnest.sidebarWidth', '264'); return 264 } } return w || 264 })(),
    sidebarCollapsed: localStorage.getItem('picnest.sidebarCollapsed') === '1', // 左边栏收起态（持久化）
    inspectorWidth: Number(localStorage.getItem('picnest.inspectorWidth')) || 296,
    inspectorHeight: Number(localStorage.getItem('picnest.inspectorHeight')) || 0, // 0 = 自适应满高
  }),

  getters: {
    activeRoot: (s) => s.roots.find((r) => r.id === s.activeRootId) || null,
    /* 网格数据是否对得上当前面包屑：对不上就当作「还没载入」 */
    gridFresh: (s) => s.loadedLocKey !== '' && s.loadedLocKey === locKeyOf(s),
    gridPending: (s) => !(s.loadedLocKey !== '' && s.loadedLocKey === locKeyOf(s)),
    memoryKey: (s) => (s.activeRootId == null ? '' : `${s.activeRootId}/${s.currentDirRel ?? ''}`),
    canGoBack: (s) => s.navIndex > 0,
    canGoForward: (s) => s.navIndex >= 0 && s.navIndex < s.navHistory.length - 1,
    imageMap: (s) => new Map((s.images || []).map((img) => [img.file_path, img])),
    selected(s) {
      return (s.selectedPath && this.imageMap.get(s.selectedPath)) || null
    },
    filteredImages(s) {
      let arr = s.applyFilters(s.images)
      const c = s.filters.color
      if ((c.on || c.gray) && c.value && !c.gray) {
        arr = [...arr].sort((a, b) => (_colorDistMap[a.file_path] ?? 100) - (_colorDistMap[b.file_path] ?? 100))
      }
      return arr
    },
  },

  actions: {
    async init() {
      const diag = diagLog
      if (typeof window !== 'undefined') window.__picnestStore = this
      /* 2026-11-16：默认回到「关」。之前那次一次性把老配置翻成了 '1'，这里翻回来（只跑一次）。 */
      try {
        if (localStorage.getItem('picnest.physicalOrderOffV3') !== '1') {
          localStorage.setItem('picnest.physicalOrderOffV3', '1')
          localStorage.setItem('picnest.physicalOrder', '0')
          this.physicalOrder = false
        }
      } catch {}
      if (typeof window !== 'undefined') window.__picnestLib = this
      diag('init() start')
      /* 启动后延迟清一次孤儿缩略图（防止历史包袱积成磁盘风暴）。
         延迟 30s 避开首屏；限流 400 个/次，不会成为新的 IO 峰值。 */
      setTimeout(() => {
        window.picrand?.cleanupOrphanThumbs?.(400).catch(() => {})
      }, 30000)
      try {
        // 主进程种子导入是异步的；轮询等根出现
        for (let i = 0; i < 60 && !this.roots.length; i++) {
          this.roots = await api.getAllFolders()
          if (!this.roots.length) await new Promise((r) => setTimeout(r, 1500))
        }
        diag(`roots loaded count=${this.roots.length}`)
        /* 文件系统监听：库内目录有新增/删除/改名时自动同步。
           以前只在「切进目录 1.2 秒后」扫一次，停在目录里丢图不会自己更新。
           现在交给 Rust 侧的 ReadDirectoryChangesW（不轮询、不读文件内容）。 */
        // 防抖后的真实同步（事件合并到 150ms 窗口后只跑一次）
        const findRelInTree = (node, targetRel) => {
          if (!node || !targetRel) return null
          const targetLow = String(targetRel).toLowerCase()
          const stack = [node]
          while (stack.length) {
            const curNode = stack.pop()
            if (curNode.rel && String(curNode.rel).toLowerCase() === targetLow) {
              return curNode.rel
            }
            if (Array.isArray(curNode.children)) {
              for (const child of curNode.children) stack.push(child)
            }
          }
          return null
        }
        const runFsSync = async () => {
          if (this._fsSyncing) {
            this._fsSyncTimer = setTimeout(runFsSync, 150)
            return
          }
          const needReload = !!this._fsNeedReloadImages
          this._fsNeedReloadImages = false
          this._fsSyncing = true
          try {
            try { this._listCache?.clear() } catch {}
            await this.refreshTree()
            const cur = this.currentDirRel
            if (cur) {
              const matched = findRelInTree(this.tree?.tree, cur)
              if (!matched) {
                // 当前正在浏览的文件夹被外部删除/重命名/移走 → 自动退回最近的现存父目录或库根
                const parts = cur.split('/')
                let fallbackRel = null
                for (let i = parts.length - 1; i >= 1; i--) {
                  const cand = parts.slice(0, i).join('/')
                  const hit = findRelInTree(this.tree?.tree, cand)
                  if (hit) { fallbackRel = hit; break }
                }
                await this.openDir(fallbackRel)
                return
              }
            }
            if (needReload) {
              const curRel = this.currentDirRel || ''
              const abs = this.absPathOf(curRel)
              if (abs) {
                await api.syncDirSnapshot(this.activeRootId, abs).catch(() => {})
              }
              await this.loadImages()
            }
          } catch { /* 静默 */ } finally {
            this._fsSyncing = false
            try { this._fsPendingDirs?.clear() } catch {}
          }
        }
        try {
          onFsDirChanged(async (payload) => {
            const dirs = Array.isArray(payload?.dirs) ? payload.dirs : []
            if (!dirs.length) return
            // 内部操作（改名/拖拽同步）期间抑制：否则改名产生的事件会把刚写好的顺序又盖回去
            if (this._suppressFsSyncUntil && Date.now() < this._suppressFsSyncUntil) return
            const root = String(this.activeRoot?.path || '')
            if (!root) return
            const norm = (x) => String(x).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
            const rn = norm(root)
            const rels = []
            for (const d of dirs) {
              const dn = norm(d)
              if (dn === rn) rels.push('')
              else if (dn.startsWith(rn + '/')) rels.push(dn.slice(rn.length + 1))
            }
            if (!rels.length) return
            const cur = String(this.currentDirRel || '').toLowerCase()
            const affected = (this.view === 'all' && !cur) ||
              (this.view === 'uncategorized' && rels.includes('')) ||
              rels.some((r) => r === cur || (cur && cur.startsWith(r + '/')) || (r && r.startsWith(cur + '/')))
            if (affected) this._fsNeedReloadImages = true
            /* 只要变动落在当前库内，总是触发防抖同步刷新目录树与计数；仅按需决定是否重载主网格 */
            if (!this._fsPendingDirs) this._fsPendingDirs = new Set()
            for (const r of rels) this._fsPendingDirs.add(r)
            if (this._fsSyncTimer) clearTimeout(this._fsSyncTimer)
            this._fsSyncTimer = setTimeout(() => runFsSync(), 150)
          })
        } catch { /* 监听失败不影响主流程 */ }
        if (this.roots.length && this.activeRootId == null) {
          /* 记住上次使用的资料库；失效（被移除）则回退第一个 */
          const saved = Number(localStorage.getItem('picnest.activeRootId'))
          this.activeRootId = this.roots.some((r) => r.id === saved) ? saved : this.roots[0].id
          this.syncCollectRoot()
          const rootIdInit = this.activeRootId
          diag(`refreshTree(${rootIdInit}) start`)
          await this.refreshTree()
          diag('refreshTree done')
          /* 恢复上次浏览位置：视图 + 文件夹（目录已不存在则回退全部） */
          const savedView = localStorage.getItem('picnest.lastView') || 'all'
          const savedDir = localStorage.getItem('picnest.lastDirRel') || ''
          const dirExists = (() => {
            if (!savedDir) return true
            const walk = (node) => {
              if (!node) return false
              if (node.rel === savedDir) return true
              return (node.children || []).some(walk)
            }
            return walk(this.tree && this.tree.tree)
          })()
          if (savedView === 'all' && savedDir && dirExists) await this.openDir(savedDir)
          else if (savedView !== 'all' && ['recent', 'random', 'trash', 'uncategorized'].includes(savedView)) await this.switchView(savedView)
          else await this.openDir(null)
          /* 元数据兼容/同步放后台异步执行，不阻塞首屏出图 */
          setTimeout(() => {
            window.picrand?.picnestRootMetaEnsure?.(rootIdInit)?.then((res) => {
              if (res?.imported && this.activeRootId === rootIdInit) {
                this.refreshTree().catch(() => {})
                this.refreshTags().catch(() => {})
              }
            }).catch(() => {})
          }, 1200)
        }
        // 重启后恢复所有根的文件监听 + 后台增量同步（外部变动/录入永远可见）
        for (const r of this.roots) {
          if (!this._watchStarted) this._watchStarted = new Set()
          if (!this._watchStarted.has(r.path)) {
            this._watchStarted.add(r.path)
            api.startWatcher(r.path).catch(() => {})
            api.syncFolderSnapshot(r.path).then((changed) => {
              if (changed) { this.refreshTree(); this.loadImages() }
            }).catch(() => {})
          }
        }
        this.refreshTags().catch(() => {})
        // 主进程推送种子导入（验收钩子）：走正常导入链路
        window.picrand?.onPicnestSeed?.((d) => {
          if (d?.path) this.addRootByPath(d.path).then(() => window.picrand.picnestRmSeed?.())
        })
        // 主进程推送：文件增删 → 刷新树与当前视图；缩略图更新 → 原位替换
        window.picrand?.onDbSync?.((data) => {
          if (data?.type === 'thumb-update') {
            const img = this.images.find((i) => i.file_path === data.file_path)
            if (img && !img.thumbnail_path) img.thumbnail_path = data.thumbnail_path
            return
          }
          if (data?.type === 'dirs-changed') {
            if (data.rootId == null || Number(data.rootId) === Number(this.activeRootId)) {
              clearTimeout(this._deb)
              this._deb = setTimeout(() => this.refreshTree(), 300)
            }
            return
          }
          if (data?.type === 'add' || data?.type === 'unlink') {
            if (Date.now() < (this.suppressSyncUntil || 0)) return // 内部移动已本地增量处理
            clearTimeout(this._deb)
            this._deb = setTimeout(() => { this.refreshTree(); this.loadImages(); this.refreshTags() }, 600)
          }
        })
        // 查重扫描进度（主进程逐文件 MD5）
        window.picrand?.onPicnestDupProgress?.((d) => {
          if (this.dupFinder.open) this.dupFinder.progress = { done: d?.done || 0, total: d?.total || 0 }
        })
        window.picrand?.onPicnestDirDupProgress?.((d) => {
          const t = this.taskProgress
          if (!t.visible || t.kind !== 'dirDup') return
          t.done = d?.done || 0
          t.total = d?.total || 0
        })
        window.picrand?.onPicnestThumbRepairProgress?.((d) => {
          const t = this.taskProgress
          if (!t.visible || t.kind !== 'thumbs') return
          t.done = d?.done || 0
          t.total = d?.total || 0
        })
        window.picrand?.onPicnestStripPrefixProgress?.((d) => {
          const t = this.taskProgress
          if (!t.visible || t.kind !== 'stripPrefix') return
          t.done = d?.done || 0
          t.total = d?.total || 0
        })
        window.picrand?.onPicnestAiDupProgress?.((d) => {
          if (!this.dupFinder.open || !this.dupFinder.ai.loading) return
          this.dupFinder.ai.progress = { ...this.dupFinder.ai.progress, ...(d || {}) }
        })
        // 色板后台构建/回填（若 loadImages 尚未启动才兜底拉起）
        if (!this.paletteBuild.running) this.ensurePalettes().catch(() => {})
      } catch (e) { this.error = String(e?.message || e) }
    },

    /* 采集服务默认目标根：跟随当前活动根（主进程本地服务用） */
    syncCollectRoot() {
      try { window.picrand?.picnestCollectSetRoot?.(this.activeRootId ?? null) } catch { /* 静默 */ }
    },

    /* 移出根文件：只解除图巢登记，磁盘文件保留（回收站非空由主进程拦住） */
    async removeRoot(id) {
      const root = this.roots.find((r) => r.id === id)
      if (!root) return { ok: false, error: '根文件不存在' }
      const r = await window.picrand.picnestRemoveRoot(id)
      if (!r?.ok) { if (r?.error) this.error = r.error; return r }
      this.roots = this.roots.filter((x) => x.id !== id)
      /* 浏览历史里属于该根的位置全部作废 */
      if (this.navHistory.some((h) => h.rootId === id)) {
        this.navHistory = this.navHistory.filter((h) => h.rootId !== id)
        this.navIndex = Math.min(this.navIndex, this.navHistory.length - 1)
      }
      if (this.activeRootId === id) {
        const next = this.roots[0] || null
        if (this.lightbox.open) this.closeLightbox()
        this.selectionView = false
        this.searchQuery = ''
        this.currentDirRel = null
        this.view = 'all'
        this.dirMemory = {}
        this.clearDirSelection()
        this.clearImageSelection()
        localStorage.setItem('picnest.lastView', 'all')
        localStorage.removeItem('picnest.lastDirRel')
        if (next) {
          this.activeRootId = next.id
          this.syncCollectRoot()
          localStorage.setItem('picnest.activeRootId', String(next.id))
          await this.refreshTree()
          await this.loadImages()
          api.startWatcher(next.path).catch(() => {}) // 被移出的根若正在被监听，切到新根
        } else {
          this.activeRootId = null
          this.syncCollectRoot()
          localStorage.removeItem('picnest.activeRootId')
          this.tree = null
          this.images = []
          this.counts = { all: 0 }
        }
      }
      this.refreshTags().catch(() => {})
      return r
    },

    /* 资料库重命名：只改显示名（资料库区编辑入口；物理目录不动） */
    async renameLibrary(id, name, opts = {}) {
      const old = this.roots.find((x) => x.id === id)
      const oldPath = old?.path || ''
      const r = await api.renameLibrary(id, name, opts)
      if (r?.ok) {
        this.roots = this.roots.map((x) => (x.id === id
          ? { ...x, path: r.path || x.path, display_name: r.display_name || r.name || name }
          : x))
        if (r.displayOnly) return r
        if (this._watchStarted && oldPath && r.path && oldPath !== r.path) {
          this._watchStarted.delete(oldPath)
          this._watchStarted.add(r.path)
        }
        if (this.activeRootId === id && oldPath && r.path && oldPath !== r.path) {
          const oldNorm = oldPath.replace(/[\\/]+$/, '').toLowerCase()
          const next = {}
          for (const [rel, mem] of Object.entries(this.dirMemory || {})) {
            const cover = mem?.cover
            if (typeof cover === 'string' && cover.toLowerCase().startsWith(oldNorm + '\\')) {
              next[rel] = { ...mem, cover: r.path + cover.slice(oldPath.length) }
            } else {
              next[rel] = mem
            }
          }
          this.dirMemory = next
        }
        if (r.path && (r.wasWatching || this.activeRootId === id)) {
          try { await window.picrand.startWatcher(r.path) } catch { /* 静默 */ }
        }
        if (this.activeRootId === id) {
          await this.refreshTree()
          await this.loadImages()
        }
      } else if (oldPath && this.activeRootId === id) {
        // 主进程在改名前已停掉 watcher；失败时恢复旧路径监听
        try { await window.picrand.startWatcher(oldPath) } catch { /* 静默 */ }
      }
      return r
    },

    async addRootByPath(p) {
      this.scanning = true
      this.scanNote = '登记文件夹…'
      try {
        const r = await api.addFolderByPath(p)
        if (!r?.id) throw new Error('登记失败（路径无效或已存在）')
        this.scanNote = '扫描文件中…（首次会建立缩略图缓存）'
        await api.syncFolderSnapshot(p)
        if (!this._watchStarted) this._watchStarted = new Set()
        this._watchStarted.add(p)
        await api.startWatcher(p)
        this.roots = await api.getAllFolders()
        this.activeRootId = r.id
        this.syncCollectRoot()
        /* 根目录里可能有 .picnest/meta.json（标签/文件夹色/手动排序）：有则恢复，无则创建 */
        let meta = null
        try { meta = await window.picrand?.picnestRootMetaLoad?.(r.id) } catch { /* 静默 */ }
        await this.refreshTree()
        await this.openDir(null)
        this.refreshTags().catch(() => {})
        if (meta?.ok && meta.created && meta.counts) {
          const c = meta.counts
          const bits = []
          if (c.tags) bits.push(`标签 ${c.tags}`)
          if (c.tagLinks) bits.push(`标签关联 ${c.tagLinks}`)
          if (c.images) bits.push(`图片元数据 ${c.images}`)
          if (c.dirs) bits.push(`文件夹色 ${c.dirs}`)
          if (c.dirOrder) bits.push(`文件夹排序 ${c.dirOrder}`)
          if (c.imageOrder) bits.push(`图片排序 ${c.imageOrder}`)
          if (bits.length) this.showNote(`已从根文件恢复元数据：${bits.join(' · ')}`)
        }
      } catch (e) {
        this.error = String(e?.message || e)
      } finally {
        this.scanning = false
        this.scanNote = ''
      }
    },

    async refreshTree() {
      const rootId = this.activeRootId
      if (rootId == null) return
      const [tree, counts, dirMemory] = await Promise.all([
        api.dirTree(rootId),
        window.picrand.picnestViewCounts(rootId),
        api.dirMemoryRootGet(rootId),
      ])
      if (this.activeRootId !== rootId && this.activeRoot?.id !== rootId) return
      this.tree = tree
      this.counts = counts
      this.dirMemory = dirMemory // 当前根切片（rel 键）：树渲染读颜色/展开态零 IPC
    },

    /* 资料库切换：同 id 忽略；全链路键 = activeRootId，tree/counts/images 按 folderId 自动重建 */
    async switchRoot(id, opts = {}) {
      if (this.activeRootId === id) {
        /* 再点当前资料库 = 回到它的库根（全部视图 + 根目录） */
        if (this.lightbox.open) this.closeLightbox()
        this.selectionView = false
        this.clearDirSelection()
        this.clearImageSelection()
        await this.openDir(null, opts)
        return
      }
      if (this.lightbox.open) this.closeLightbox()
      collectiveShake()
      this.activeRootId = id
      this.syncCollectRoot()
      this.currentDirRel = null
      this.view = 'all'
      this.selectionView = false
      this.dirMemory = {}
      this.clearDirSelection()
      this.clearImageSelection()
      localStorage.setItem('picnest.activeRootId', String(id))
      await this.refreshTree()
      await this.loadImages()
      this.syncCaptureTargetDir()
      this.refreshTags().catch(() => {})
      if (opts.record !== false) this.recordNav(this.currentLocation())
      setTimeout(() => {
        window.picrand?.picnestRootMetaEnsure?.(id)?.then((res) => {
          if (res?.imported && this.activeRootId === id) {
            this.refreshTree().catch(() => {})
            this.refreshTags().catch(() => {})
          }
        }).catch(() => {})
      }, 1000)
    },

    /* ---- 资料库文件夹管理 ---- */
    absPathOf(rel) {
      const root = this.tree?.rootPath
      if (!root) return ''
      return rel ? root + '\\' + rel.split('/').join('\\') : root
    },

    async mkdirIn(parentRel, name) {
      const parentAbs = this.absPathOf(parentRel)
      const r = await api.mkdir(parentAbs, name)
      if (!r?.ok) { if (r?.error) this.error = r.error; return r }
      const root = this.tree.rootPath
      const newRel = parentRel ? parentRel + '/' + r.name : r.name
      const root0 = this.roots.find((x) => x.id === this.activeRootId)
      if (root0) { try { await api.syncFolderSnapshot(root0.path) } catch { /* 静默 */ } }
      await this.refreshTree()
      await this.loadImages()
      return { ...r, rel: newRel }
    },

    /* 顶层文件夹过滤：父文件夹已选中时不再重复处理其后代；资料库根 '' 覆盖全部 */
    topLevelDirs(rels) {
      const list = [...new Set((rels || []).filter((r) => r !== null && r !== undefined))]
      if (list.includes('')) return ['']
      return list.filter((r) => !list.some((o) => o !== r && r.startsWith(o + '/')))
    },
    showNote(summary, details = [], tone = 'ok') {
      this.importResult = { open: true, nonce: Date.now(), summary, details, tone }
    },

    /* 删除文件夹（多选穿透：父子同选只删父级；资料库根不可删） */
    async deleteDirs(rels) {
      if (!this.tree) return { ok: false, error: '无目录树' }
      const list = this.topLevelDirs(rels).filter((r) => r !== '')
      if (!list.length) return { ok: false, error: '根文件不能删除' }
      let deleted = 0, failed = 0, files = 0
      for (const rel of list) {
        try {
          const r = await api.deleteDir(this.absPathOf(rel), rel, this.activeRootId)
          if (r?.ok) { deleted++; files += r.count || 0 } else failed++
        } catch (e) { failed++ }
      }
      const inAny = (x) => list.some((rel) => x === rel || (x || '').startsWith(rel + '/'))
      if (inAny(this.currentDirRel)) {
        const hit = list.find((rel) => this.currentDirRel === rel || (this.currentDirRel || '').startsWith(rel + '/'))
        this.currentDirRel = hit && hit.includes('/') ? hit.slice(0, hit.lastIndexOf('/')) : null
      }
      this.selectedDirs = this.selectedDirs.filter((x) => !inAny(x))
      if (this.dirAnchor != null && inAny(this.dirAnchor)) this.dirAnchor = null
      if (this.selectionView && this.selectedDirs.length < 2) this.selectionView = false
      await this.refreshTree()
      await this.loadImages()
      if (deleted > 0 && this.soundFx) playTrashSound()
      this.showNote(`已删除 ${deleted} 个文件夹${failed ? ` · 失败 ${failed}` : ''}（图巢回收站可还原）`, [], failed ? 'error' : 'ok')
      return { ok: failed === 0, deleted, failed, files }
    },
    async deleteDir(rel) { return this.deleteDirs([rel]) },

    /* ---- 复制 / 粘贴（应用内剪贴板 + 系统剪贴板；父子同选按父级穿透） ---- */
    copyFiles(paths) {
      const list = [...new Set((paths || []).filter(Boolean))]
      if (!list.length) return { ok: false }
      this.clipboard = { kind: 'files', paths: list, count: list.length, root: false }
      try { window.picrand.copyFilesToClipboard?.(list) } catch { /* 静默 */ }
      this.showNote(`已复制 ${list.length} 张图片 · Ctrl+V 粘贴`)
      return { ok: true, count: list.length }
    },
    copyDirsFrom(rootId, rels) {
      const root = this.roots.find((r) => r.id === rootId)
      if (!root) return { ok: false, error: '根文件不存在' }
      const tops = this.topLevelDirs(rels)
      const paths = tops.map((rel) => root.path + (rel ? '\\' + rel.split('/').join('\\') : ''))
      if (!paths.length) return { ok: false }
      const hasRoot = tops.includes('')
      this.clipboard = { kind: 'dirs', paths, count: paths.length, root: hasRoot }
      try { window.picrand.copyFilesToClipboard?.(paths) } catch { /* 静默 */ }
      const label = hasRoot
        ? `已复制根文件「${root.display_name || String(root.path).split(/[\\/]/).pop()}」`
        : `已复制 ${paths.length} 个文件夹`
      this.showNote(`${label} · Ctrl+V 粘贴`)
      return { ok: true, count: paths.length, root: hasRoot }
    },
    copySelection() {
      /* 图片优先：合并视图里点图后 Ctrl+C 复制图片，而不是底下的文件夹 */
      if (this.selectedPaths.length) return this.copyFiles(this.selectedPaths)
      if (this.selectedDirs.length) return this.copyDirsFrom(this.activeRootId, this.selectedDirs)
      return { ok: false }
    },
    pasteTarget() {
      if (this.selectedDirs.length === 1) return { rootId: this.activeRootId, rel: this.selectedDirs[0] }
      return { rootId: this.activeRootId, rel: this.currentDirRel || '' }
    },
    async paste(target) {
      const clip = this.clipboard
      if (!clip?.kind) return { ok: false, error: '剪贴板为空' }
      const t = this.normTarget(target || this.pasteTarget())
      const targetDir = this.absOfTarget(t)
      if (!targetDir) return { ok: false, error: '目标根文件不可用' }
      /* 自包含预检（避免确认后才发现不可粘贴） */
      const norm = (p) => String(p).replace(/[\\/]+$/, '').toLowerCase()
      const dstNorm = norm(targetDir)
      if (clip.kind === 'dirs' && clip.paths.some((src) => {
        const s = norm(src)
        return dstNorm === s || dstNorm.startsWith(s + '\\') || dstNorm.startsWith(s + '/')
      })) {
        this.showNote('不能把文件夹粘贴进自身或其子目录', [], 'error')
        return { ok: false, error: '目标在源文件夹内' }
      }
      if (clip.kind === 'dirs' && clip.root) {
        const ok = await this.askConfirm({
          title: '复制根文件',
          message: '将复制整个根文件（仅图片/视频），可能需要较长时间。继续？',
          details: [
            `源：${clip.paths[0]}`,
            `目标：${targetDir}`,
          ],
          confirmText: '开始复制',
        })
        if (!ok) return { ok: false, canceled: true }
      }
      const agg = { ok: true, copied: 0, registered: 0, skipped: 0, failed: 0, unsupported: 0, replaced: 0, dirs: [], errors: [] }
      try {
        if (clip.kind === 'dirs') {
          for (const src of clip.paths) {
            const r = await this.mergeDirWithDupes(src, targetDir, t)
            if (r?.canceled) { agg.ok = false; agg.canceled = true; break }
            if (r?.ok) {
              agg.dirs.push(r)
              agg.copied += r.copied || 0
              agg.registered += r.registered || 0
              agg.skipped += r.skipped || 0
              agg.failed += r.failed || 0
              agg.unsupported += r.unsupported || 0
              agg.replaced += r.replaced || 0
              if (t.rootId === this.activeRootId && r.created) await this.insertOrderAt(t.rel, r.name, null)
            } else {
              agg.ok = false
              agg.failed++
              agg.errors.push(`${(String(src).split(/[\\/]/).pop() || src)}：${r?.error || '复制失败'}`)
            }
          }
        } else {
          const r = await window.picrand.picnestCopyImages([...clip.paths], targetDir)
          if (r?.ok || r?.copied) {
            agg.copied += r.copied || 0
            agg.failed += r.failed || 0
            if (!r?.ok) agg.ok = false
          } else {
            agg.ok = false
            agg.errors.push(r?.error || '复制失败')
          }
        }
        if (agg.copied > 0 || agg.registered > 0 || agg.dirs.length > 0) {
          const rootRec = this.roots.find((x) => x.id === t.rootId)
          if (rootRec) await api.syncFolderSnapshot(rootRec.path).catch(() => {})
          if (t.rootId === this.activeRootId) { await this.refreshTree(); await this.loadImages() }
        }
        const parts = []
        if (agg.copied) parts.push(`粘贴 ${agg.copied} 张`)
        if (agg.registered) parts.push(`补录 ${agg.registered} 张`)
        if (agg.dirs.length) parts.push(`文件夹 ${agg.dirs.length} 个`)
        if (agg.skipped) parts.push(`已在库中（跳过重复） ${agg.skipped} 张`)
        if (agg.replaced) parts.push(`替换旧图 ${agg.replaced}`)
        if (agg.failed) parts.push(`失败 ${agg.failed}`)
        if (agg.canceled) parts.push('已取消')
        let cross = ''
        if (t.rootId !== this.activeRootId) {
          const rec = this.roots.find((x) => x.id === t.rootId)
          const name = rec?.display_name || String(rec?.path || '').split(/[\\/]/).pop()
          cross = name ? ` → ${name}` : ''
        }
        const details = (agg.dirs || []).map((d) => ({ label: d.name, text: `粘贴 ${d.copied}${d.replaced ? ` · 替换 ${d.replaced}` : ''}${d.failed ? ` · 失败 ${d.failed}` : ''}` }))
        if (agg.errors.length) details.push({ label: '错误', text: agg.errors.join('；') })
        this.showNote((parts.length ? parts.join(' · ') : (agg.ok ? '没有可粘贴的内容' : '粘贴失败')) + cross, details, agg.canceled ? 'muted' : (agg.ok ? 'ok' : 'error'))
        return agg
      } catch (e) {
        const r = { ok: false, error: String(e?.message || e) }
        this.showNote(r.error, [], 'error')
        return r
      }
    },

    async renameDir(rel, newName) {
      const oldAbs = this.absPathOf(rel)
      const parentRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
      const r = await api.renameDir(oldAbs, newName, rel, parentRel)
      if (!r?.ok) { if (r?.error) this.error = r.error; return r }
      const newRel = parentRel ? parentRel + '/' + r.name : r.name
      const root0 = this.roots.find((x) => x.id === this.activeRootId)
      if (root0) { try { await api.syncFolderSnapshot(root0.path) } catch { /* 静默 */ } }
      if (this.currentDirRel === rel || (this.currentDirRel || '').startsWith(rel + '/')) {
        this.currentDirRel = newRel + this.currentDirRel.slice(rel.length)
      }
      /* 多选 rel 同步迁移（选区不指向旧路径） */
      const fixSel = (x) => (x === rel ? newRel : (x || '').startsWith(rel + '/') ? newRel + x.slice(rel.length) : x)
      this.selectedDirs = this.selectedDirs.map(fixSel)
      if (this.dirAnchor != null) this.dirAnchor = fixSel(this.dirAnchor)
      /* dirMemory 的根内键整体搬家（主进程同时同步封面绝对路径），再重新取切片 */
      try { await api.dirMemoryRename(this.activeRootId, rel, newRel) } catch { /* 静默 */ }
      this.dirMemory = await api.dirMemoryRootGet(this.activeRootId)
      this.scheduleRootMetaSave()
      await this.refreshTree()
      await this.loadImages()
      return { ...r, rel: newRel }
    },

    async sortDir(rel, mode) {
      const r = await api.dirSort(rel || '', this.absPathOf(rel), mode)
      if (r?.ok) { await this.refreshTree(); this.scheduleRootMetaSave() }
      else if (r?.error) this.error = r.error
      return r
    },

    async resetDirOrder(rootId, rel) {
      const rid = rootId || this.activeRootId
      try {
        await api.dirOrderSet(rid, rel || '', [])
        await this.refreshTree()
        this.showNote('已重置文件夹为 01_ 02_ 自然顺序', [], 'ok')
      } catch (e) {
        this.showNote(String(e?.message || e), [], 'error')
      }
    },

    async sortDirRecursive(rel, mode) {
      const r = await api.dirSortRecursive(this.absPathOf(rel), rel || '', mode)
      if (r?.ok) { await this.refreshTree(); this.scheduleRootMetaSave() }
      else if (r?.error) this.error = r.error
      return r
    },

    async exportDir(rel, stripPrefix = false) {
      const r = await api.exportDir(this.absPathOf(rel), stripPrefix)
      return r
    },
    /* 资料库区的绝对路径操作（不依赖当前活动库） */
    async mkdirInLibrary(rootId, name) {
      const root = this.roots.find((r) => r.id === rootId)
      if (!root) return { ok: false, error: '根文件不存在' }
      const r = await api.mkdir(root.path, name)
      if (!r?.ok) { if (r?.error) this.error = r.error; return r }
      try { await api.syncFolderSnapshot(root.path) } catch { /* 静默 */ }
      if (rootId === this.activeRootId) { await this.refreshTree(); await this.loadImages() }
      return r
    },
    async sortLibrary(rootId, mode) {
      const root = this.roots.find((r) => r.id === rootId)
      if (!root) return { ok: false }
      const r = await api.dirSort('', root.path, mode)
      if (r?.ok && rootId === this.activeRootId) await this.refreshTree()
      return r
    },
    async sortLibraryRecursive(rootId, mode) {
      const root = this.roots.find((r) => r.id === rootId)
      if (!root) return { ok: false }
      const r = await api.dirSortRecursive(root.path, '', mode)
      if (r?.ok && rootId === this.activeRootId) await this.refreshTree()
      return r
    },
    async exportLibrary(rootId, stripPrefix = false) {
      const root = this.roots.find((r) => r.id === rootId)
      if (!root) return { ok: false, error: '根文件不存在' }
      return api.exportDir(root.path, stripPrefix)
    },

    /* 文件夹统计（详情面板）：当前库 + 若干 rel，union 去重 */
    async dirStats(rels) {
      try { return await api.dirStats(this.activeRootId, rels) }
      catch (e) { return { ok: false, error: String(e?.message || e) } }
    },

    /* 文件夹记忆（颜色/展开态/封面）：乐观更新本地 + 落当前根的 config 命名空间 */
    async patchDirMemory(rel, patch) {
      this.dirMemory = { ...this.dirMemory, [rel]: { ...(this.dirMemory[rel] || {}), ...patch } }
      try { await api.dirMemorySet(this.activeRootId, rel, patch) } catch { /* 静默 */ }
      this.scheduleRootMetaSave()
    },
    /* 根文件本地元数据落盘（防抖；移出/退出时还会有主进程兜底） */
    scheduleRootMetaSave(delay = 1200) {
      if (this.activeRootId == null) return
      clearTimeout(this._metaSaveTimer)
      const rid = this.activeRootId
      this._metaSaveTimer = setTimeout(() => {
        try { window.picrand?.picnestRootMetaSave?.(rid) } catch { /* 静默 */ }
      }, delay)
    },
    async flushRootMeta() {
      clearTimeout(this._metaSaveTimer)
      if (this.activeRootId == null) return null
      try { return await window.picrand?.picnestRootMetaSave?.(this.activeRootId) } catch { return null }
    },
    /* 同步到文件夹（库 → 磁盘）：把当前文件夹（含所有子文件夹）的图片顺序写成文件名前缀。
       手动触发、先预览。这是旧「排序同步文件名」的正确形态。 */
    async syncFolderToDisk(rel, opts = {}) {
      if (this.activeRootId == null) return { ok: false, error: '未选资料库' }
      const target = rel == null ? (this.currentDirRel || '') : rel
      if (!target) return { ok: false, error: '请先选一个文件夹（库根不支持）' }
      let plan = null
      try {
        plan = await window.picrand.picnestSyncFolderToDisk(this.activeRootId, target, true)
      } catch (e) {
        return { ok: false, error: String(e?.message || e) }
      }
      if (!plan?.ok) return { ok: false, error: plan?.error || '预览失败' }
      if (!plan.changed) {
        this.showNote('这个文件夹里的文件名已经是库里的顺序，不需要同步')
        return { ok: true, changed: 0 }
      }
      const sample = (plan.preview || []).slice(0, 4).map((x) => `${x.old}  →  ${x.new}`)
      const details = [...sample]
      if (plan.changed > sample.length) details.push(`…共 ${plan.changed} 个（此处只列前 ${sample.length} 个）`)
      details.push(`扫描了 ${plan.dirs} 个子文件夹`)
      details.push('只改文件名前的数字前缀；缩略图缓存会一起迁移，不会变灰卡')
      const ok = await this.askConfirm({
        title: `把库里的顺序写入磁盘文件名？（${plan.changed} 张）`,
        message: '这是「库 → 磁盘」：按图巢里当前的排列，给文件加上 01_ 数字前缀，让资源管理器里看到的顺序和图巢一致。',
        details,
        confirmText: '写入文件名',
      })
      if (!ok) return { ok: false, canceled: true }
      this.taskProgress = { visible: true, kind: 'rename', label: '正在同步到文件夹', done: 0, total: plan.changed, cancelable: false, canceling: false }
      try {
        const r = await window.picrand.picnestSyncFolderToDisk(this.activeRootId, target, false)
        try { this._listCache?.clear() } catch {}
        await this.refreshTree()
        await this.loadImages()
        const parts = [`已改 ${r?.renamed || 0} 个文件名`]
        if (r?.failed) parts.push(`失败 ${r.failed}`)
        this.showNote(parts.join(' · '), (r?.errors || []).slice(0, 3).map((t) => ({ label: '失败', text: t })), r?.failed ? 'error' : 'ok')
        return r || { ok: false }
      } catch (e) {
        this.showNote(String(e?.message || e), [], 'error')
        return { ok: false, error: String(e?.message || e) }
      } finally {
        this.taskProgress.visible = false
      }
    },

    /* 把当前顺序写进文件名（手动触发，先预览再执行）。
       这是替代旧「排序同步文件名」开关的正路：低频、可控、带缩略图缓存迁移。 */
    async writeOrderToFilenames() {
      if (this.activeRootId == null) return { ok: false, error: '未选资料库' }
      const dirRel = this.currentDirRel || ''
      if (!dirRel) return { ok: false, error: '请先进一个文件夹（库根不支持写文件名）' }
      const paths = this.images.map((i) => i.file_path).filter(Boolean)
      if (!paths.length) return { ok: false, error: '当前视图没有图片' }

      // 1) 预览（不碰磁盘）
      let plan = null
      try {
        plan = await window.picrand.picnestWriteOrderToFilenames(this.activeRootId, dirRel, paths, true)
      } catch (e) {
        return { ok: false, error: String(e?.message || e) }
      }
      if (!plan?.ok) return { ok: false, error: plan?.error || '预览失败' }
      if (!plan.changed) {
        this.showNote('文件名已经是当前顺序，不需要修改')
        return { ok: true, changed: 0 }
      }

      // 2) 确认
      const sample = (plan.preview || []).slice(0, 4).map((x) => `${x.old}  →  ${x.new}`)
      const details = [...sample]
      if (plan.changed > sample.length) details.push(`…共 ${plan.changed} 个（此处只列前 ${sample.length} 个）`)
      details.push('只改文件名前的数字前缀；缩略图缓存会一起迁移，不会变灰卡')
      const ok = await this.askConfirm({
        title: `把顺序写进文件名？（${plan.changed} / ${plan.total}）`,
        message: '文件内容不动，只调整名字前面的 01_ 数字前缀，让资源管理器里看到的顺序和图巢一致。',
        details,
        confirmText: '写入文件名',
      })
      if (!ok) return { ok: false, canceled: true }

      // 3) 执行
      this.taskProgress = { visible: true, kind: 'rename', label: '正在写入文件名', done: 0, total: plan.changed, cancelable: false, canceling: false }
      try {
        const r = await window.picrand.picnestWriteOrderToFilenames(this.activeRootId, dirRel, paths, false)
        // 路径全变了：目录列表 LRU 必须作废，否则会继续展示旧文件名
        try { this._listCache?.clear() } catch {}
        await this.refreshTree()
        await this.loadImages()
        const parts = [`已改 ${r?.renamed || 0} 个文件名`]
        if (r?.failed) parts.push(`失败 ${r.failed}`)
        this.showNote(parts.join(' · '), (r?.errors || []).slice(0, 3).map((t) => ({ label: '失败', text: t })), r?.failed ? 'error' : 'ok')
        return r || { ok: false }
      } catch (e) {
        this.showNote(String(e?.message || e), [], 'error')
        return { ok: false, error: String(e?.message || e) }
      } finally {
        this.taskProgress.visible = false
      }
    },

    /* 物理排序开关（默认关）：开启后，拖动排序停下来 800ms 会自动把顺序写成文件名数字前缀。
       注意：只改文件名、不动内容；缩略图缓存会跟着迁移；只处理当前这一层。 */
    togglePhysicalOrder() {
      this.physicalOrder = !this.physicalOrder
      localStorage.setItem('picnest.physicalOrder', this.physicalOrder ? '1' : '0')
      this.showNote(
        this.physicalOrder
          ? '已开启：拖动排序后会自动把顺序写成文件名数字前缀（只改名字，不动内容）'
          : '已关闭：排序只存在图巢里，不改磁盘文件名',
      )
    },
    /* 拖完顺序或新图入库 → 防抖 800ms → 自动写文件名。打断、出错都静默，不影响拖拽体验。 */
    schedulePhysicalSync(targetRootId = null, targetRel = null) {
      if (!this.physicalOrder) return
      clearTimeout(this._physSyncTimer)
      this._physSyncTimer = setTimeout(() => {
        this.syncOrderToFilesSilent(targetRootId, targetRel).catch(() => {})
      }, 800)
    },
    /* 静默版：不弹预览不弹确认（开关已授权）。
       关键：改名后**不能整表 loadImages**（会清选中、重置滚动、重放入场波），
       而是用后端返回的 map 在本地替换路径字段——旧版纪律里的「增量优先」。 */
    async syncOrderToFilesSilent(targetRootId = null, targetRel = null) {
      if (!this.physicalOrder) return null
      const rid = targetRootId ?? this.activeRootId
      const rel = targetRel !== null && targetRel !== undefined ? targetRel : (this.currentDirRel ?? '')
      if (rid == null) return null
      /* 库根/未分类/回收站不做自动改名：那里一次会重编所有子目录的号，
         而且没有“所属文件夹”这个概念，改了反而奇怪。 */
      if (!rel) return null
      if (this.view === 'trash' || this.selectionView) return null

      const isCurrentView = rid === this.activeRootId && (rel || '') === (this.currentDirRel || '')
      let paths = []
      if (isCurrentView) {
        paths = this.images.map((i) => i.file_path).filter(Boolean)
      } else {
        try {
          const list = await api.imagesByDir(rid, rel, 0, 10000, 'id', false, false)
          paths = (list || []).map((x) => x.file_path).filter(Boolean)
        } catch {
          return null
        }
      }
      if (!paths.length) return null
      try {
        // 改名会触发大量文件事件；期间屏蔽 watcher 回写，避免“写完又被旧顺序覆盖”
        this._suppressFsSyncUntil = Date.now() + 6000
        const r = await window.picrand.picnestWriteOrderToFilenames(rid, rel, paths, false)
        const map = Array.isArray(r?.map) ? r.map : []
        if (!map.length) return r
        if (isCurrentView) {
          // 本地增量：只改 file_path / thumbnail_path，不动数组顺序、不清选中
          const byOld = new Map(map.map((x) => [x.old, x]))
          let touched = false
          for (const img of this.images) {
            const hit = byOld.get(img.file_path)
            if (!hit) continue
            img.file_path = hit.new
            // 文件名/显示名也得跟着换，否则界面上还是旧名字（要等重进目录才刷新）
            img.file_name = String(hit.new).split(/[\\/]/).pop()
            if (hit.thumb) img.thumbnail_path = hit.thumb
            touched = true
          }
          if (touched) {
            this.suppressWaveUntil = Date.now() + 700
            this.layoutTick++
          }
        }
        // 列表缓存里存的是旧路径，必须作废（下次进目录重新查）
        try { this._listCache?.clear() } catch {}
        return r
      } catch {
        return null
      } finally {
        this._suppressFsSyncUntil = Date.now() + 1500
      }
    },
    fixRelsAfterDirRename(map) {
      if (!Array.isArray(map) || !map.length) return
      const fix = (rel) => {
        if (rel == null) return rel
        for (const m of map) {
          if (rel === m.oldRel) return m.newRel
          if (rel.startsWith(m.oldRel + '/')) return m.newRel + rel.slice(m.oldRel.length)
        }
        return rel
      }
      this.currentDirRel = fix(this.currentDirRel)
      this.selectedDirs = this.selectedDirs.map(fix)
      if (this.dirAnchor != null) this.dirAnchor = fix(this.dirAnchor)
    },
    /* 文件夹顺序已改为纯元数据（picnest_dir_order）；以前的「同步到文件名」已废弃。 */
    async syncDirOrderPhysical() { return null },
    /* 缩略图批量修复（缺图/缓存被清）：后台生成，进度浮条可停止 */
    async repairThumbs(rootId = this.activeRootId) {
      const rid = rootId
      if (rid == null) return { ok: false }
      let n = 0
      try { n = Number((await window.picrand.picnestThumbsMissing(rid))?.count) || 0 } catch { /* 静默 */ }
      if (!n) { this.showNote('缩略图已齐，无需修复'); return { ok: true, total: 0 } }
      const ok = await this.askConfirm({
        title: `补 ${n} 张缩略图？`,
        message: '缺失的缩略图会用原图重新生成；文件较大时会花一些时间，可随时停止。',
        confirmText: '开始生成',
      })
      if (!ok) return { ok: false, canceled: true }
      this.taskProgress = { visible: true, kind: 'thumbs', label: '正在生成缩略图', done: 0, total: n, cancelable: true, canceling: false }
      try {
        const r = await window.picrand.picnestRepairThumbs(rid)
        if (!r?.ok) { this.showNote(r?.error || '缩略图生成失败', [], 'error'); return r }
        if (rid === this.activeRootId) await this.loadImages()
        const parts = [`缩略图补成 ${r.generated || 0} 张`]
        if (r.failed) parts.push(`失败 ${r.failed}`)
        if (r.canceled) parts.push('已停止')
        this.showNote(parts.join(' · '), (r.failedNames || []).length ? [{ label: '失败样本', text: r.failedNames.join('、') }] : [], r.failed ? 'error' : 'ok')
        return r
      } catch (e) {
        this.showNote(String(e?.message || e), [], 'error')
        return { ok: false, error: String(e?.message || e) }
      } finally {
        this.taskProgress.visible = false
      }
    },
    /* 清除 01_ 排序编号的功能已废弃（2026-11-14）：排序不再写进文件名，也就无需清除。
       保留空实现，避免旧引用报错。 */
    async stripOrderPrefixes() {
      this.showNote('排序已不再修改文件名，「清除排序编号」已移除', [], 'muted')
      return { ok: false, removed: true }
    },
    /* 把图片设为其所在文件夹的封面（子文件夹卡片用；库根散图没有卡片） */
    async setFolderCover(filePath, thumbPath) {
      const root = this.activeRoot
      if (!root?.path) return { ok: false, error: '无根文件' }
      const rp = String(root.path).replace(/\//g, '\\').replace(/\\+$/, '')
      const pp = String(filePath || '').replace(/\//g, '\\')
      if (!pp.toLowerCase().startsWith(rp.toLowerCase() + '\\')) return { ok: false, error: '文件不在当前根目录' }
      const rel = pp.slice(rp.length + 1).split('\\').slice(0, -1).join('/')
      if (!rel) {
        this.showNote('库根散图不能设为子文件夹封面', [], 'muted')
        return { ok: false }
      }
      const thumb = thumbPath && thumbPath !== 'SKIP' ? thumbPath : ''
      await this.patchDirMemory(rel, { cover: filePath, coverThumb: thumb })
      this.showNote(`已把「${rel.split('/').pop()}」的封面换掉`)
      return { ok: true, rel }
    },
    async clearFolderCover(rel) {
      if (!rel) return { ok: false }
      await this.patchDirMemory(rel, { cover: '', coverThumb: '' })
      this.showNote(`已恢复「${rel.split('/').pop()}」的自动封面`)
      return { ok: true, rel }
    },
    /* 保存旋转/翻转到原图：写回后失效缩略图/色板，并刷新自身与可能的封面 */
    async applyImageTransform() {
      if (!this.lightbox.open) return { ok: false }
      const p = this.lightbox.path
      const img = this.images.find((i) => i.file_path === p)
      if (!img) return { ok: false, error: '图片不在当前列表' }
      const rot = this.viewer.rot % 360
      const flopX = !!this.viewer.flopX
      if (!rot && !flopX) return { ok: true, changed: false }
      const r = await window.picrand.picnestApplyTransform(p, { rot, flopX })
      if (!r?.ok) return r
      /* 注意：宽高在 Lightbox 等新纹理预解码完成的那一刻原子更新，避免提前改动造成旧纹理瞬时拉伸留白 */
      if (r.size) img.file_size = r.size
      if (r.modify_time) img.modify_time = r.modify_time
      else img.modify_time = Math.floor(Date.now() / 1000)
      img.thumbnail_path = ''
      delete this.palettes[p]
      api.generateThumbnailsBatch([p]).then(async (res) => {
        const hit = (res?.results || [])[0]
        const thumb = hit?.thumbnail_path || ''
        if (thumb) { img.thumbnail_path = thumb; this.layoutTick++ }
        for (const [rel, mem] of Object.entries(this.dirMemory)) {
          if (mem.cover === p) await this.patchDirMemory(rel, { coverThumb: thumb })
        }
      }).catch(() => {})
      return r
    },
    /* 从正文进入子文件夹：把左侧树的祖先层（含库根）展开，选中行随即可见（内存即时生效，后台静默持久化，不阻塞出图） */
    revealDir(rel) {
      if (!rel) return
      if (this.dirMemory['']?.expanded === false) {
        this.dirMemory[''] = { ...this.dirMemory[''], expanded: true }
        this.patchDirMemory('', { expanded: true }).catch(() => {})
      }
      const parts = String(rel).split('/')
      for (let i = 1; i < parts.length; i++) {
        const p = parts.slice(0, i).join('/')
        if (!this.dirMemory[p]?.expanded) {
          this.dirMemory[p] = { ...this.dirMemory[p], expanded: true }
          this.patchDirMemory(p, { expanded: true }).catch(() => {})
        }
      }
    },

    /* ---- 浏览历史（后退/前进）：位置 = 资料库 + 视图 + 文件夹 ---- */
    currentLocation() {
      return {
        rootId: this.activeRootId,
        view: this.view,
        rel: this.view === 'all' ? (this.currentDirRel ?? null) : null,
      }
    },
    recordNav(loc) {
      if (!loc) return
      const next = { rootId: loc.rootId ?? this.activeRootId, view: loc.view || 'all', rel: loc.rel ?? null }
      const cur = this.navHistory[this.navIndex]
      if (cur && cur.rootId === next.rootId && cur.view === next.view && cur.rel === next.rel) return
      this.navHistory = this.navHistory.slice(0, this.navIndex + 1)
      this.navHistory.push(next)
      if (this.navHistory.length > 100) this.navHistory = this.navHistory.slice(-100)
      this.navIndex = this.navHistory.length - 1
      emitPluginEvent('view-changed', { rootId: next.rootId, view: next.view, rel: next.rel || '' })
    },
    async applyNav(loc) {
      if (!loc) return
      if (loc.rootId != null && loc.rootId !== this.activeRootId) {
        await this.switchRoot(loc.rootId, { record: false })
      }
      if (loc.view === 'all') await this.openDir(loc.rel ?? null, { record: false })
      else await this.switchView(loc.view, { record: false })
    },
    async goBack() {
      if (this.navIndex <= 0) return
      this.navIndex--
      await this.applyNav(this.navHistory[this.navIndex])
    },
    async goForward() {
      if (this.navIndex < 0 || this.navIndex >= this.navHistory.length - 1) return
      this.navIndex++
      await this.applyNav(this.navHistory[this.navIndex])
    },

    async openDir(rel, opts = {}) {
      diagLog(`openDir rel=${rel || '(root)'}`)
      // 树上点文件夹 = 离开大图模式和特殊视图，跳进该目录浏览
      if (this.lightbox.open) this.closeLightbox()
      this.selectionView = false
      this.view = 'all'
      this.currentDirRel = rel ?? null
      /* 集体晃动 + lastDirRel 持久化不影响这一帧的内容：前者会同步唤醒树上每个图标
         的 watcher，后者是同步 storage 写。挪到导航启动之后跑，点击到首帧之间不再有它们。 */
      const shakeAndRemember = () => {
        /* 2026-11-14：切目录时不再调 collectiveShake()。
           实测：它让树上 60+ 个 AnimIcon 同时重启动画，宿主（Tauri 主线程）CPU 被烧到 70–80%，
           Win32 消息泵阻塞 0.6–3s，真实鼠标点击延迟 1.3–3.3s（就是「连续换几次文件夹就变慢」）。
           卡片入场波（.wi）不需要它，保留不动。 */
        try {
          localStorage.setItem('picnest.lastView', 'all')
          localStorage.setItem('picnest.lastDirRel', rel || '')
        } catch {}
      }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(shakeAndRemember)
      else setTimeout(shakeAndRemember, 0)
      if (rel) this.revealDir(rel)
      this.syncCaptureTargetDir()
      await this.loadImages()
      if (opts.record !== false) this.recordNav(this.currentLocation())
      clearTimeout(this._syncDirTimer)
      const syncRootId = this.activeRootId
      const syncRel = rel ?? null
      const absDir = syncRel
        ? this.absPathOf(syncRel)
        : (this.roots.find((x) => x.id === syncRootId)?.path || '')
      if (syncRootId != null && absDir) {
        /* 1.2 秒后的补偿同步：用户此时往往已经开始滚动/看图了，
           一跑就是 sync + 可能 refreshTree + 全量取数，那就卡一下。
           改成 3 秒，并且在用户正在交互（最近 1.5 秒内有滚动）时再往后推。 */
        const runSync = (delay) => {
          this._syncDirTimer = setTimeout(() => {
            const busy = this._lastInteractAt && Date.now() - this._lastInteractAt < 1500
            if (busy) { runSync(800); return }
            api.syncDirSnapshot?.(syncRootId, absDir).then((changed) => {
              if (changed && this.activeRootId === syncRootId && this.view === 'all' && (this.currentDirRel ?? null) === syncRel) {
                this.refreshTree()
                this.loadImages()
              }
            }).catch(() => {})
          }, delay)
        }
        runSync(3000)
      }
    },
    async syncActiveRootOnFocus() {
      const now = Date.now()
      // 回窗全库快照代价很高（一次 sync + 可能 3 次 IPC + 全量取数）。
      // 原来 6 秒节流意味着“切出去再回来”几乎必跑；放宽到 30 秒，
      // 且页面不可见时不跑。
      if (this._focusSyncBusy || (this._lastFocusSyncAt && now - this._lastFocusSyncAt < 30000)) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      const root = this.roots.find((x) => x.id === this.activeRootId)
      if (!root?.path) return
      this._focusSyncBusy = true
      this._lastFocusSyncAt = now
      try {
        const changed = await api.syncFolderSnapshot(root.path)
        if (changed && this.activeRootId === root.id) {
          await this.refreshTree()
          await this.loadImages()
        }
      } catch { /* 静默 */ }
      finally { this._focusSyncBusy = false }
    },

    async switchView(v, opts = {}) {
      /* 防连点：视图切换会触发全库取数（实测 10774 张约 70ms）。
         连点 10 次就是 10 次全量查询，消息泵直接被砸出 200ms。
         同视图直接返回；不同视图做 160ms 防抖，只跑最后一次。 */
      if (this.view === v && !opts.force) return
      if (this._switchTimer) clearTimeout(this._switchTimer)
      // 被取消的上一次调用必须 resolve，否则外部的 await 会永久挂着
      if (this._switchResolve) {
        const prev = this._switchResolve
        this._switchResolve = null
        prev()
      }
      const run = async () => {
        this._switchTimer = null
        if (this.lightbox.open) this.closeLightbox()
        // 切视图后用户会立刻滚动，不再叠一层图标动画
        this.clearDirSelection()
        this.selectionView = false
        this.view = v
        localStorage.setItem('picnest.lastView', v)
        if (v !== 'all') localStorage.setItem('picnest.lastDirRel', '')
        this.currentDirRel = null
        this.searchQuery = ''
        // 平滑无感过渡：不强制置空 this.images，保留现有视觉渲染直至新数据到达
        this.selectedPath = null
        this.selectedPaths = []
        this.selectionAnchor = null
        this.syncCaptureTargetDir()
        await this.loadImages()
        if (opts.record !== false) this.recordNav(this.currentLocation())
      }
      // 首屏/程序化切换（带 record:false）不等防抖窗口，立刻执行
      if (opts.immediate || opts.record === false) return run()
      await new Promise((resolve) => {
        this._switchResolve = resolve
        this._switchTimer = setTimeout(() => {
          this._switchResolve = null
          run().then(resolve, resolve)
        }, 160)
      })
    },

    /* 目录列表缓存（LRU，最多 12 个位置） */
    _lcGet(key) {
      const c = this._listCache
      if (!c || !c.has(key)) return null
      const v = c.get(key)
      c.delete(key)
      c.set(key, v)
      return v
    },
    _lcSet(key, list) {
      const c = this._listCache
      if (!c) return list
      c.delete(key)
      c.set(key, list)
      while (c.size > 12) c.delete(c.keys().next().value)
      return list
    },
    _lcHas(key) { return !!(this._listCache && this._listCache.has(key)) },

    /* 先把首屏需要的缩略图解码好，再换屏。
       直接换数据会让新格子先以灰底占位出现（图还没解码完），
       原版之所以“点一下图就跟着出”，就是因为它从来没有这个中间态。 */
    async _preloadFirst(items, n = 24, budgetMs = 450) {
      const urls = []
      for (const it of (items || []).slice(0, n)) {
        const p = it && it.thumbnail_path
        if (p && p !== 'SKIP') urls.push(fileUrl(p))
      }
      if (!urls.length) return
      const jobs = urls.map((u) => new Promise((res) => {
        const im = new Image()
        im.onload = () => res()
        im.onerror = () => res()
        im.src = u
      }))
      await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, budgetMs))])
    },

    loadImages(opts = {}) {
      if (this.activeRootId == null) return Promise.resolve()
      clearTimeout(this._loadImagesDebounceTimer)
      /* 原版就是直接 await，不经过 setTimeout。
         套一层定时器会让整次导航排在主线程空闲之后（实测被拖 715ms），
         而取数本身只需要 0–2ms。去掉。 */
      return this._doLoadImages()
    },

    async _doLoadImages() {
      if (this.activeRootId == null) return
      const diag = diagLog
      const gen = (this._loadGen = (this._loadGen || 0) + 1)
      const tLoadStart = performance.now()
      const reqKey = locKeyOf(this) // 这次请求代表的到底是哪个位置
      /* 新一次切换先把上一次没跑完的请求打掉，否则快速连点会堆成一队，
         最后那一次只能排在后面（实测会拖到 1 秒以上） */
      try { this._inflightAbort && this._inflightAbort.abort() } catch {}
      const ac = new AbortController()
      this._inflightAbort = ac
      clearTimeout(this._slowPendingTimer)
      this.pendingSlow = false
      this._slowPendingTimer = setTimeout(() => {
        if (gen === this._loadGen) this.pendingSlow = true
      }, 200)
      this.loading = true
      diag(`loadImages start gen=${gen} view=${this.view} dir=${this.currentDirRel}`)
      try {
        let next = []
        let deltaCached = false // 命中缓存时已经画过了，不必再预解码
        if (this.view !== 'trash' && this.trashFolders?.length) this.trashFolders = []
        if (this.selectionView && this.selectedDirs.length > 1) {
          /* 多选文件夹 = 合并内容视图（union 去重，全局排序） */
          next = await this.imagesInDirs(this.selectedDirs)
        } else if (this.view === 'recent') {
          next = await api.recent(this.activeRootId, 20000)
        } else if (this.view === 'random') {
          next = await window.picrand.picnestRandom(this.activeRootId, 300)
        } else if (this.view === 'trash') {
          const [tFolders, tCounts, tList] = await Promise.all([
            api.trashFolders(this.activeRootId),
            window.picrand.picnestViewCounts(this.activeRootId),
            window.picrand.picnestTrashList(this.activeRootId),
          ])
          if (gen !== this._loadGen) { diag(`loadImages stale gen=${gen} cur=${this._loadGen}`); return }
          this.trashFolders = tFolders || []
          this.counts = tCounts
          next = tList
        } else if (this.view === 'uncategorized') {
          /* 未分类 = 库根层散图（不在任何子文件夹），排序面板可用 */
          next = await api.imagesByDir(this.activeRootId, '__loose__', 0, 100000, this.sortMode, this.sortAsc)
        } else if (this.view === 'search') {
          next = this.searchQuery ? await window.picrand.picnestSearch(this.activeRootId, this.searchQuery, 300) : []
        } else {
          /* 全部 = 非手动时锁最新入库；手动排序允许在全部视图换位（新图 0 置前） */
          const inAll = this.view === 'all' && !this.currentDirRel
          const manualAll = inAll && this.sortMode === 'manual'
          const mode = manualAll ? 'manual' : (inAll ? 'added' : this.sortMode)
          const asc = manualAll ? this.sortAsc : (inAll ? false : this.sortAsc)
          /* 首屏优先：先取前 60 行立刻出图，全量再补。
             用户点开文件夹第一眼只看得到头顶几张，等 6000 行没有意义。 */
          const cached = this._lcGet(reqKey)
          if (cached && cached.length) {
            /* 回切：先把上次的全量摆上去（零延迟、不跳动）
               核对请求不阻塞——实测它偶尔会被浏览器那端卡 1～2 秒，
               不能让一次“确认无变化”把整个加载挂在那里等。 */
            this.images = cached
            this.loadedLocKey = reqKey
            this.loading = false
            next = cached
            deltaCached = true
            api.imagesByDir(this.activeRootId, this.currentDirRel, 0, 100000, mode, asc, this.showSubfolderContent, ac.signal)
              .then((fresh) => {
                if (gen !== this._loadGen) return
                if (!Array.isArray(fresh) || !fresh.length) return
                const same = fresh.length === cached.length
                  && fresh[0]?.id === cached[0]?.id && fresh[fresh.length - 1]?.id === cached[cached.length - 1]?.id
                if (same) return
                this.images = fresh.map(markRaw)
                this._lcSet(reqKey, this.images)
              })
              .catch(() => {})
          } else {
          /* 单次全量，不再“先 60 再补”：那个中间态会让列表条数从 60 跳到 N，
             网格和滚动条跟着重排一次，观感上就是“跳一下”。
             我们取全量本来就只要几毫秒（全部视图 88ms），不值得为省那点首屏而换来一次重排。 */
          const full = await api.imagesByDir(this.activeRootId, this.currentDirRel, 0, 100000, mode, asc, this.showSubfolderContent, ac.signal)
          if (gen !== this._loadGen) { diag(`loadImages stale gen=${gen} cur=${this._loadGen}`); return }
          if (!Array.isArray(full)) return // 被取消
          next = full
          }
          if (!Array.isArray(next) || !next.length) this._lcSet(reqKey, [])
          else if (!this._lcHas(reqKey)) this._lcSet(reqKey, next)
        }
        if (gen !== this._loadGen) { diag(`loadImages stale gen=${gen} cur=${this._loadGen}`); return } // 快速切换时丢弃过期结果
        diag(`loadImages got ${next?.length ?? 0} items gen=${gen}`)
        // 预解码交给网格层的换屏闸门，store 不再阻塞（否则点击后要等半秒才跳）
        this.images = (next || []).map(markRaw)
        this.loadedLocKey = reqKey // 数据已就位，网格现在可以重新画了
        this.selectedPath = null
        this.selectedPaths = []
        this.selectionAnchor = null
        this.randomNonce++
        clearTimeout(this._bgTasksTimer)
        this._bgTasksTimer = setTimeout(() => {
          if (gen !== this._loadGen) return
          /* 后台补全挪到浏览器空闲时做：进场瞬间只负责把数据画出来，
             尺寸回填/色板/缩略图不许和用户抢主线程——否则「切个文件夹」要等一两秒才落定。 */
          const idle = window.requestIdleCallback || ((cb) => setTimeout(() => cb({ timeRemaining: () => 8 }), 300))
          try { if (this._bgIdleId && window.cancelIdleCallback) window.cancelIdleCallback(this._bgIdleId) } catch {}
          this._bgIdleId = idle(() => {
            if (gen !== this._loadGen) return
            this.fillDimsInBackground()
            /* 色板：每轮要改 600 条响应式数据，而每次修改都会让 masonry 重算网格；
               实测 2000 张里只有 10 张缺尺寸 —— 大目录默认不算色板，只在开了颜色筛选时才算 */
            if (this.images.length <= 800 || this.filters.color.on || this.filters.color.gray) {
              this.ensurePalettes().catch(() => {})
            }
            /* 不再做全局缩略图预填：网格已按可见区自行补图，全局预填只会
               把 IPC 连接占满、拖慢导航（实测 images_by_dir 从 20ms 排到 2s）。 */
            this.harvestThumbs()
          }, { timeout: 2500 })
        }, 600)
      } catch (e) {
        diag(`loadImages ERROR: ${e?.message || e}`)
        if (gen === this._loadGen) {
          this.error = String(e?.message || e)
          // 失败也要结束「待载入」态，否则骨架会永远停在那里
          this.loadedLocKey = reqKey
        }
      } finally {
        if (gen === this._loadGen) {
          const cost = Math.round(performance.now() - tLoadStart)
          if (cost > 400) diag(`SLOW load ${cost}ms dir=${this.currentDirRel} images=${this.images.length} head=${this._lcHas(reqKey) ? 'cached' : 'fresh'}`)
          clearTimeout(this._slowPendingTimer)
          this.pendingSlow = false
          this.loading = false
          diag(`loadImages finally loading=false gen=${gen}`)
        }
      }
    },

    /* 网格重排合并器：尺寸回填 / 缩略图收割 / 加载降级都会改 layoutTick，
       逐次自增会让万图网格反复全量重排（实测一次几十毫秒 × 数十次 = 数秒卡顿），
       窗口期内只触发一次。 */
    bumpLayout(delay = 220) {
      if (this._layoutBumpTimer) return
      this._layoutBumpTimer = setTimeout(() => {
        this._layoutBumpTimer = null
        this.layoutTick++
      }, delay)
    },

    /* 标签：当前根的全量标签 + 图片关联；筛选面板与详情共用 */
    async refreshTags() {
      if (this.activeRootId == null) {
        this.tags = []
        this.imageTags = {}
        return
      }
      try {
        const r = await window.picrand.picnestTagsList(this.activeRootId)
        if (!r?.ok) return
        this.tags = Array.isArray(r.tags) ? r.tags : []
        this.imageTags = r.imageTags || {}
        const usable = new Set(this.tags.filter((t) => t.count > 0).map((t) => t.id))
        this.filters.tags = (this.filters.tags || []).filter((id) => usable.has(id))
      } catch { /* 静默：标签不是主流程阻断项 */ }
    },
    async addTagToImages(imageIds, name) {
      const ids = (imageIds || []).filter((x) => Number.isInteger(Number(x)) && Number(x) > 0)
      if (!ids.length) return { ok: false, error: '没有目标图片' }
      const r = await window.picrand.picnestTagAssign({ imageIds: ids, name, action: 'add' })
      if (r?.ok) { await this.refreshTags(); this.scheduleRootMetaSave() }
      return r
    },
    async removeTagFromImages(imageIds, tagId) {
      const ids = (imageIds || []).filter((x) => Number.isInteger(Number(x)) && Number(x) > 0)
      if (!ids.length || !tagId) return { ok: false, error: '没有目标标签' }
      const r = await window.picrand.picnestTagAssign({ imageIds: ids, tagId, action: 'remove' })
      if (r?.ok) { await this.refreshTags(); this.scheduleRootMetaSave() }
      return r
    },
    async renameTag(tagId, name) {
      const r = await window.picrand.picnestTagRename({ tagId, name })
      if (r?.ok) { await this.refreshTags(); this.scheduleRootMetaSave() }
      return r
    },
    async deleteTag(tagId) {
      const r = await window.picrand.picnestTagDelete(tagId)
      if (r?.ok) { await this.refreshTags(); this.scheduleRootMetaSave() }
      return r
    },

    /* 多选文件夹的合并内容：逐目录取递归图片 → 按 file_path 去重 → 全局排序 */
    async imagesInDirs(rels) {
      const lists = await Promise.all((rels || []).map((rel) =>
        api.imagesByDir(this.activeRootId, rel, 0, 100000, this.sortMode, this.sortAsc).catch(() => [])))
      const seen = new Set()
      const merged = []
      for (const list of lists) {
        for (const im of list || []) {
          if (seen.has(im.file_path)) continue
          seen.add(im.file_path)
          merged.push(im)
        }
      }
      const mode = this.sortMode
      const dir = this.sortAsc ? 1 : -1
      merged.sort((a, b) => {
        let r
        if (mode === 'name') r = String(a.file_name || '').localeCompare(String(b.file_name || ''), 'zh')
        else if (mode === 'size') r = (a.file_size || 0) - (b.file_size || 0)
        else if (mode === 'mtime') r = (a.modify_time || 0) - (b.modify_time || 0)
        else r = (a.id || 0) - (b.id || 0) // added / 其余回退入库序
        return r * dir || String(a.file_path).localeCompare(String(b.file_path))
      })
      return merged
    },

    async doSearch(q) {
      this.view = 'search'
      this.searchQuery = q
      await this.loadImages()
    },

    async rerollRandom() {
      await this.loadImages()
    },

    /* ---- 回收站：文件夹条目（图巢内部，文件夹形式）/ 一键还原 / 清空 ---- */
    async restoreTrashFolder(id) {
      const r = await api.trashRestoreFolder(id)
      if (r?.ok) {
        if (this.soundFx) playRestoreSound()
        await this.refreshTree()
        await this.loadImages()
        this.showNote(`已还原文件夹「${r.name || ''}」`)
      } else if (r?.error) this.error = r.error
      return r
    },
    async purgeTrashFolder(id, name) {
      const ok = await this.askConfirm({
        title: '彻底删除文件夹',
        message: `确定彻底删除「${name || '该文件夹'}」？`,
        details: ['文件夹会移入 Windows 回收站作为最后保险，并从图巢回收站移除。'],
        confirmText: '彻底删除',
        danger: true,
      })
      if (!ok) return { ok: false, canceled: true }
      const r = await api.trashPurgeFolder(id)
      if (r?.ok) {
        if (this.soundFx) playPurgeSound()
        await this.refreshTree()
        await this.loadImages()
        this.showNote('已彻底删除文件夹')
      } else if (r?.error) this.error = r.error
      return r
    },
    async restoreAllTrash() {
      if (!this.activeRootId) return
      await this.refreshTree()
      const n = this.counts?.trash || 0
      if (!n) { this.showNote('回收站是空的'); return }
      const ok = await this.askConfirm({
        title: '一键还原回收站',
        message: `确定还原回收站中的全部 ${n} 项？`,
        details: ['文件夹会回到原来的位置（重名时自动加序号），图片会回到原文件夹。'],
        confirmText: '全部还原',
      })
      if (!ok) return
      const r = await api.trashRestoreAll(this.activeRootId)
      if (r?.ok) {
        if (this.soundFx) playRestoreSound()
        await this.refreshTree()
        await this.loadImages()
        this.showNote(`已还原 ${r.restoredFolders} 个文件夹 · ${r.restoredImages} 张图片`)
      } else this.error = '部分还原失败'
      return r
    },
    async purgeAllTrash() {
      if (!this.activeRootId) return
      await this.refreshTree()
      const n = this.counts?.trash || 0
      if (!n) { this.showNote('回收站是空的'); return }
      const ok = await this.askConfirm({
        title: '清空回收站',
        message: `确定清空回收站中的全部 ${n} 项？`,
        details: ['文件夹与图片会移入 Windows 回收站作为最后保险，并从图巢索引移除。'],
        confirmText: '清空回收站',
        danger: true,
      })
      if (!ok) return
      const r = await api.trashPurgeAll(this.activeRootId)
      if (r?.ok) {
        if (this.soundFx) playPurgeSound()
        await this.refreshTree()
        await this.loadImages()
        this.showNote(`已清空：文件夹 ${r.purgedFolders} 个 · 图片 ${r.purgedImages} 张`)
      } else this.error = '部分删除失败'
      return r
    },
    openTrashMenu(e) { this.trashMenu = { open: true, x: e.clientX, y: e.clientY } },
    closeTrashMenu() { this.trashMenu = { open: false, x: 0, y: 0 } },

    async restoreFromTrash(path) {
      let restoredOk = false
      try {
        const r = await window.picrand.picnestTrashRestore(path)
        restoredOk = r !== false && r?.ok !== false
      } catch { /* 静默 */ }
      if (restoredOk && this.soundFx) playRestoreSound()
      this.images = this.images.filter((i) => i.file_path !== path)
      this.pruneImageSelection(path)
      await this.refreshTree()
    },

    async purgeFromTrash(path) {
      let purgedOk = false
      try {
        const r = await window.picrand.picnestTrashPurge(path)
        purgedOk = r !== false && r?.ok !== false
      } catch { /* 静默 */ }
      if (purgedOk && this.soundFx) playPurgeSound()
      this.images = this.images.filter((i) => i.file_path !== path)
      this.pruneImageSelection(path)
      await this.refreshTree()
    },
    /* 回收站多选批量还原：右键入口，逐张恢复（非破坏性，不弹确认） */
    async restoreSelectedFromTrash() {
      this.closeContextMenu()
      const list = [...new Set(this.selectedPaths)]
      if (!list.length) return
      if (list.length === 1) return this.restoreFromTrash(list[0])
      let ok = 0, failed = 0
      for (const p of list) {
        try {
          const r = await window.picrand.picnestTrashRestore(p)
          if (r === false) failed++
          else ok++
        } catch (e) { failed++ }
      }
      if (ok) {
        if (this.soundFx) playRestoreSound()
        const set = new Set(list)
        this.images = this.images.filter((i) => !set.has(i.file_path))
        this.selectedPaths = this.selectedPaths.filter((p) => !set.has(p))
        if (this.selectionAnchor && set.has(this.selectionAnchor)) this.selectionAnchor = this.selectedPaths[this.selectedPaths.length - 1] || null
        if (this.selectedPath && set.has(this.selectedPath)) this.selectedPath = this.selectedPaths[this.selectedPaths.length - 1] || null
        await this.refreshTree()
        this.showNote(`已还原 ${ok} 张${failed ? ` · 失败 ${failed}` : ''}`)
      }
      return { ok: failed === 0, restored: ok, failed }
    },
    /* 回收站多选批量彻底删除：进 Windows 回收站 + 清图巢索引，先确认 */
    async purgeSelectedFromTrash() {
      this.closeContextMenu()
      const list = [...new Set(this.selectedPaths)]
      if (!list.length) return
      if (list.length === 1) return this.purgeFromTrash(list[0])
      const ok = await this.askConfirm({
        title: `彻底删除 ${list.length} 张图片？`,
        message: '文件会移入 Windows 回收站作为最后保险，并从图巢索引移除。',
        details: [
          ...list.slice(0, 5).map((p) => p.split(/[\\/]/).pop()),
          ...(list.length > 5 ? [`…等 ${list.length} 张`] : []),
        ],
        confirmText: '彻底删除',
        danger: true,
      })
      if (!ok) return
      let done = 0, failed = 0
      for (const p of list) {
        try {
          const r = await window.picrand.picnestTrashPurge(p)
          if (r === false) failed++
          else done++
        } catch (e) { failed++ }
      }
      if (done) {
        if (this.soundFx) playPurgeSound()
        const set = new Set(list)
        this.images = this.images.filter((i) => !set.has(i.file_path))
        this.selectedPaths = this.selectedPaths.filter((p) => !set.has(p))
        if (this.selectionAnchor && set.has(this.selectionAnchor)) this.selectionAnchor = this.selectedPaths[this.selectedPaths.length - 1] || null
        if (this.selectedPath && set.has(this.selectedPath)) this.selectedPath = this.selectedPaths[this.selectedPaths.length - 1] || null
        await this.refreshTree()
        this.showNote(`已彻底删除 ${done} 张${failed ? ` · 失败 ${failed}` : ''}`)
      }
      return { ok: failed === 0, purged: done, failed }
    },

    resolveDupDialog(choice) {
      if (this.dupDialog.resolve) this.dupDialog.resolve(choice)
      this.dupDialog = { open: false, items: [], targetRel: undefined, mode: 'files', count: 0, resolve: null }
    },

    /* 通用确认框（Promise<boolean>） */
    askConfirm(opts = {}) {
      return new Promise((resolve) => {
        this.confirmDialog = {
          open: true,
          title: opts.title || '确认',
          message: opts.message || '',
          details: opts.details || [],
          confirmText: opts.confirmText || '确定',
          danger: !!opts.danger,
          resolve,
        }
      })
    },
    resolveConfirm(v) {
      if (this.confirmDialog.resolve) this.confirmDialog.resolve(!!v)
      this.confirmDialog = { open: false, title: '', message: '', details: [], confirmText: '确定', danger: false, resolve: null }
    },

    /* ---- 重复文件查找（精确 MD5 / AI 相似；仅当前资料库；右键入口） ---- */
    openDupFinder(rootId, rel) {
      const rid = rootId ?? this.activeRootId
      this.closeDirMenu()
      this.dupFinder = {
        open: true, rootId: rid, rel: rel || '', mode: 'exact', loading: true, canceling: false, canceled: false,
        progress: { done: 0, total: 0 }, groups: [], stats: null, error: '', selected: [],
        preserveExt: dupPreserveDefault(),
        ai: defaultAiDupState(),
      }
      this.runDupScan()
      this.loadAiConfig()
    },
    async runDupScan() {
      const f = this.dupFinder
      const rid = f.rootId, rel = f.rel
      f.canceled = false
      try {
        const r = await window.picrand.picnestFindDuplicates(rid, rel)
        if (!this.dupFinder.open || this.dupFinder.rootId !== rid || this.dupFinder.rel !== rel) return
        if (r?.canceled) {
          this.dupFinder.canceled = true
          this.dupFinder.groups = []
          this.dupFinder.stats = null
          return
        }
        if (!r?.ok) { this.dupFinder.error = r?.error || '扫描失败'; return }
        this.dupFinder.groups = r.groups || []
        this.dupFinder.stats = r.stats || null
      } catch (e) {
        if (this.dupFinder.open) this.dupFinder.error = String(e?.message || e)
      } finally {
        if (this.dupFinder.open && this.dupFinder.rootId === rid && this.dupFinder.rel === rel) {
          this.dupFinder.loading = false
          this.dupFinder.canceling = false
        }
      }
    },
    async dupCancel() {
      const f = this.dupFinder
      if (!f.loading || f.canceling) return
      f.canceling = true
      try { await window.picrand.picnestDupCancel() } catch { /* 静默 */ }
    },
    async loadAiConfig() {
      try {
        const r = await window.picrand.picnestAiConfigGet()
        if (!this.dupFinder.open) return
        const a = this.dupFinder.ai
        a.configLoaded = true
        if (r?.ok) {
          if (!a.baseUrl) a.baseUrl = r.baseUrl || 'https://api.openai.com/v1'
          if (!a.model) a.model = r.model || 'gpt-4o-mini'
          a.hasKey = !!r.hasKey
          a.encrypted = r.encrypted !== false
        }
      } catch (e) {
        if (this.dupFinder.open) this.dupFinder.ai.configLoaded = true
      }
    },
    async fetchAiModels(apiKey = '') {
      const ai = this.dupFinder.ai
      if (ai.modelsLoading) return
      const base = String(ai.baseUrl || '').trim()
      if (!/^https?:\/\//i.test(base)) { ai.models = []; ai.modelsError = '请先填写 API 地址'; return }
      ai.modelsLoading = true
      ai.modelsError = ''
      try {
        const r = await window.picrand.picnestAiModels({ baseUrl: base, apiKey: String(apiKey || '').trim() })
        if (!this.dupFinder.open || this.dupFinder.ai !== ai) return
        if (String(ai.baseUrl || '').trim() !== base) return // 等待期间改过地址，丢弃旧列表
        if (!r?.ok) {
          ai.models = []
          ai.modelsError = r?.error || '获取模型列表失败，可手动填写模型名'
          return
        }
        ai.models = Array.isArray(r.models) ? r.models : []
        if (!ai.models.length) ai.modelsError = '接口返回了空模型列表，可手动填写模型名'
        else if (!ai.model) ai.model = ai.models[0]
      } catch (e) {
        if (this.dupFinder.open && this.dupFinder.ai === ai && String(ai.baseUrl || '').trim() === base) {
          ai.modelsError = String(e?.message || e)
        }
      } finally {
        if (this.dupFinder.ai === ai) ai.modelsLoading = false
      }
    },
    setDupMode(mode) {
      const m = mode === 'ai' ? 'ai' : 'exact'
      if (this.dupFinder.mode === m) return
      /* 切页签时停掉正在跑的精确扫描，避免结果回来又覆盖面板 */
      if (this.dupFinder.loading) this.dupCancel()
      this.dupFinder.mode = m
      this.dupFinder.selected = []
      if (m !== 'ai') return
      const ai = this.dupFinder.ai
      const fetchIfReady = () => {
        if (!this.dupFinder.open || this.dupFinder.mode !== 'ai') return
        if (ai.hasKey && !ai.models.length && !ai.modelsLoading) this.fetchAiModels('')
      }
      if (!ai.configLoaded) this.loadAiConfig().then(fetchIfReady)
      else fetchIfReady()
    },
    async saveAiConfig(opts = {}) {
      const ai = this.dupFinder.ai
      if (ai.testing) return { ok: false, error: '正在测试连接，请稍候再保存' }
      ai.testing = true
      ai.noteErr = false
      ai.note = '保存中…'
      try {
        const r = await window.picrand.picnestAiConfigSet({
          baseUrl: opts.baseUrl, model: opts.model, apiKey: opts.apiKey,
        })
        if (!r?.ok) { ai.note = r?.error || '保存失败'; ai.noteErr = true; return r }
        ai.hasKey = !!r.hasKey
        ai.encrypted = r.encrypted !== false
        ai.baseUrl = String(opts.baseUrl || ai.baseUrl).trim()
        ai.model = String(opts.model || ai.model).trim()
        ai.note = '已保存，正在测试连接…'
        const t = await window.picrand.picnestAiTest()
        if (t?.ok) {
          ai.note = '连接成功：视觉模型可用'
          ai.noteErr = false
        } else {
          ai.note = '保存成功，但测试失败：' + (t?.error || '未知错误')
          ai.noteErr = true
        }
        // 保存后顺带刷新模型列表；失败只显示在模型栏，不覆盖连接测试结果
        this.fetchAiModels('').catch(() => {})
        return r
      } catch (e) {
        ai.note = String(e?.message || e)
        ai.noteErr = true
        return { ok: false, error: ai.note }
      } finally { ai.testing = false }
    },
    persistAiAllowed(v) {
      this.dupFinder.ai.allowed = !!v
      try { localStorage.setItem('picnest.aiDupAllowed', v ? '1' : '0') } catch {}
    },
    /* 在已有扫描结果上继续查下一批（不重扫全库、不重算哈希） */
    async aiFindDuplicatesMore() {
      const f = this.dupFinder
      const ai = f.ai
      if (ai.loading || ai.testing) return
      if (!ai.hasKey) { ai.error = '请先在 AI 设置里保存 API Key'; return }
      ai.loading = true
      ai.error = ''
      const rid = f.rootId, rel = f.rel
      try {
        const r = await window.picrand.picnestAiDupContinue(rid, rel, ai.maxPairs)
        if (!this.dupFinder.open || this.dupFinder.rootId !== rid || this.dupFinder.rel !== rel) return
        if (!r?.ok) { ai.error = r?.error || '继续查重失败'; return }
        ai.groups = r.groups || []
        ai.stats = r.stats || null
      } catch (e) {
        ai.error = String(e?.message || e)
      } finally {
        ai.loading = false
      }
    },
    async aiFindDuplicates() {
      const f = this.dupFinder
      const ai = f.ai
      if (ai.loading || ai.testing) return
      if (!ai.hasKey) { ai.error = '请先在 AI 设置里保存 API Key'; return }
      if (!ai.allowed) { ai.error = '请先勾选「允许上传候选缩略图」'; return }
      ai.loading = true
      ai.canceling = false
      ai.error = ''
      ai.note = ''
      ai.groups = []
      ai.stats = null
      ai.progress = { phase: '', done: 0, total: 0, candidates: 0 }
      f.selected = []
      const rid = f.rootId, rel = f.rel
      try {
        const r = await window.picrand.picnestAiDupScan(rid, rel, ai.maxPairs)
        if (!this.dupFinder.open || this.dupFinder.rootId !== rid || this.dupFinder.rel !== rel) return
        if (!r?.ok) {
          if (r?.error !== '已取消') ai.error = r?.error || 'AI 查重失败'
          return
        }
        ai.groups = r.groups || []
        ai.stats = r.stats || null
      } catch (e) {
        if (this.dupFinder.open) ai.error = String(e?.message || e)
      } finally {
        ai.loading = false
        ai.canceling = false
      }
    },
    async aiCancel() {
      const ai = this.dupFinder.ai
      if (!ai.loading) return
      ai.canceling = true
      try { await window.picrand.picnestAiDupCancel() } catch { /* 静默 */ }
    },
    closeDupFinder() {
      if (this.dupFinder.ai?.loading) this.aiCancel()
      if (this.dupFinder.loading) this.dupCancel()
      this.dupFinder = {
        open: false, rootId: null, rel: '', mode: 'exact', loading: false, canceling: false, canceled: false,
        progress: { done: 0, total: 0 }, groups: [], stats: null, error: '', selected: [],
        preserveExt: dupPreserveDefault(),
        ai: defaultAiDupState(),
      }
    },
    toggleDupSelected(path) {
      const i = this.dupFinder.selected.indexOf(path)
      if (i >= 0) this.dupFinder.selected.splice(i, 1)
      else this.dupFinder.selected.push(path)
    },
    /* 快捷保留：first | newest | oldest | largest（AI 组尺寸不同，"最大"有意义） */
    setDupPreserveExt(v) {
      this.dupFinder.preserveExt = !!v
      try { localStorage.setItem('picnest.dupPreserveExt', v ? '1' : '0') } catch { /* 静默 */ }
    },
    /* AI 查重费用估算的单价（元/百万 tokens）；0=不估算，只显示上传量 */
    setAiPricePerM(v) {
      const n = Math.max(0, Number(v) || 0)
      this.dupFinder.ai.pricePerM = n
      try { localStorage.setItem('picnest.aiPricePerM', String(n)) } catch { /* 静默 */ }
    },
    dupKeep(gi, mode) {
      const groups = this.dupFinder.mode === 'ai' ? this.dupFinder.ai.groups : this.dupFinder.groups
      const g = groups[gi]
      if (!g?.files?.length) return
      const files = g.files
      const keepers = new Set(dupKeepers(files, mode, this.dupFinder.preserveExt).map((f) => f.path))
      const inGroup = new Set(files.map((f) => f.path))
      this.dupFinder.selected = this.dupFinder.selected.filter((p) => !inGroup.has(p))
        .concat(files.filter((f) => !keepers.has(f.path)).map((f) => f.path))
    },
    /* 一键处理全部组：按规则保留，其余全部勾选；会覆盖当前勾选 */
    dupKeepAll(mode) {
      const groups = this.dupFinder.mode === 'ai' ? this.dupFinder.ai.groups : this.dupFinder.groups
      if (!groups?.length) return
      const keepers = new Set()
      for (const g of groups) {
        for (const f of dupKeepers(g.files, mode, this.dupFinder.preserveExt)) keepers.add(f.path)
      }
      const selected = []
      for (const g of groups) {
        for (const f of g.files) if (!keepers.has(f.path)) selected.push(f.path)
      }
      this.dupFinder.selected = [...new Set(selected)]
    },
    async applyDupTrash() {
      const paths = [...this.dupFinder.selected]
      if (!paths.length) return
      const n = paths.length
      const names = paths.slice(0, 5).map((p) => p.split(/[\\/]/).pop())
      const ok = await this.askConfirm({
        title: `移入回收站 ${n} 张？`,
        message: '重复文件会移入图巢回收站，可随时还原；磁盘上的原文件保留。',
        details: [...names, ...(n > 5 ? [`…等 ${n} 张`] : [])],
        confirmText: '移入回收站',
        danger: true,
      })
      if (!ok) return
      const r = await this.trashImages(paths)
      if (!r?.moved) return
      const gone = new Set(paths)
      const isAi = this.dupFinder.mode === 'ai'
      const srcGroups = isAi ? this.dupFinder.ai.groups : this.dupFinder.groups
      const groups = srcGroups
        .map((g) => ({ ...g, files: g.files.filter((f) => !gone.has(f.path)) }))
        .filter((g) => g.files.length > 1)
        .map((g) => {
          const files = g.files
          const wasted = g.ai
            ? Math.max(0, files.reduce((s, f) => s + (f.size || 0), 0) - Math.max(0, ...files.map((f) => f.size || 0)))
            : (g.size || 0) * (files.length - 1)
          return { ...g, count: files.length, wasted }
        })
        .sort((a, b) => b.wasted - a.wasted || b.count - a.count)
      if (isAi) {
        this.dupFinder.ai.groups = groups
        const stats = { ...(this.dupFinder.ai.stats || {}) }
        stats.groups = groups.length
        stats.files = groups.reduce((s, g) => s + g.count, 0)
        stats.wasted = groups.reduce((s, g) => s + g.wasted, 0)
        this.dupFinder.ai.stats = stats
      } else {
        this.dupFinder.groups = groups
        const stats = { ...(this.dupFinder.stats || {}) }
        stats.groups = groups.length
        stats.files = groups.reduce((s, g) => s + g.count, 0)
        stats.wasted = groups.reduce((s, g) => s + g.wasted, 0)
        this.dupFinder.stats = stats
      }
      this.dupFinder.selected = []
    },

    async removeFromLibrary(path) {
      /* 从库中移除 = 只摘索引（DB 行删除），文件原地保留——曾误接软删（会进回收站视图） */
      try { await window.picrand.dbDeleteImage(path) } catch { /* 静默 */ }
      this.images = this.images.filter((i) => i.file_path !== path)
      this.pruneImageSelection(path)
      await this.refreshTree()
    },

    // ---- Eagle 式筛选管线（形状/评分/格式/文件夹/颜色）----
    activeFilterCount() {
      const f = this.filters
      let n = 0
      n += f.shapes.length ? 1 : 0
      n += f.ratings.length ? 1 : 0
      n += (f.formats.length || f.formatEx.length) ? 1 : 0
      n += f.folders.length ? 1 : 0
      n += f.tags.length ? 1 : 0
      n += (f.color.on || f.color.gray) ? 1 : 0
      return n
    },
    clearFilters() {
      this.filters = { shapes: [], customW: 4, customH: 3, ratings: [], formats: [], formatEx: [], folders: [], tags: [], color: { on: false, gray: false, value: null, accuracy: 20 } }
      _colorDistMap = Object.create(null)
    },
    shapeMatch(img) {
      const w = img.width || 0, h = img.height || 0
      if (!w || !h) return false
      const f = this.filters
      if (f.shapes.includes('landscape') && w > h) return true
      if (f.shapes.includes('portrait') && h > w) return true
      if (f.shapes.includes('square') && w === h) return true
      if (f.shapes.includes('panoramaL') && w > h && w / h >= 2.5) return true
      if (f.shapes.includes('panoramaP') && h > w && h / w >= 2.5) return true
      if (f.shapes.includes('43') && w / h === 4 / 3) return true
      if (f.shapes.includes('34') && w / h === 3 / 4) return true
      if (f.shapes.includes('169') && w / h === 16 / 9) return true
      if (f.shapes.includes('916') && w / h === 9 / 16) return true
      if (f.shapes.includes('custom') && f.customW && f.customH && w / h === f.customW / f.customH) return true
      return false
    },
    colorMatch(img) {
      /* 合并旧版未聚类的细桶色板，并在归一化占比后按准确度 (5..40) 做 CIEDE2000 + DeltaE76 匹配 */
      const rawPal = this.palettes[img.file_path]
      const c = this.filters.color
      if (!rawPal || !rawPal.length) return false
      if (c.gray && isGrayPalettes(rawPal)) return true
      if (!c.value) return false
      const v = c.value
      /* 精确命中任意色板（点图自身色板/吸到同色）——不受占比门槛限制，原图必保 */
      for (const p of rawPal) {
        if (p.r === v[0] && p.g === v[1] && p.b === v[2]) { _colorDistMap[img.file_path] = 0.01; return true }
      }
      /* 兼容旧 SQLite 中未合并的 24-step 细桶色板（主色 < 22%）：按欧氏距离 < 48 贪心合并并按可观测总占比归一化 */
      let pal = rawPal
      if ((rawPal[0]?.percent ?? 0) < 22 && rawPal.length > 1) {
        const sorted = [...rawPal].sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))
        const totalObserved = sorted.reduce((s, x) => s + (x.percent ?? 0), 0)
        const clusters = []
        for (const p of sorted) {
          const pct = p.percent ?? 0
          let hit = null
          for (const cl of clusters) {
            const dr = p.r - cl.r, dg = p.g - cl.g, db = p.b - cl.b
            if (dr * dr + dg * dg + db * db < 48 * 48) { hit = cl; break }
          }
          if (hit) {
            const w = hit.percent + pct
            if (w > 0) {
              hit.r = Math.round((hit.r * hit.percent + p.r * pct) / w)
              hit.g = Math.round((hit.g * hit.percent + p.g * pct) / w)
              hit.b = Math.round((hit.b * hit.percent + p.b * pct) / w)
              hit.percent = w
            }
          } else {
            clusters.push({ r: p.r, g: p.g, b: p.b, percent: pct })
          }
        }
        clusters.sort((a, b) => b.percent - a.percent)
        const scale = totalObserved > 5 && totalObserved < 65 ? 85 / totalObserved : 1
        pal = clusters.map((cl) => ({ r: cl.r, g: cl.g, b: cl.b, percent: Math.min(100, cl.percent * scale) }))
      }
      const r0 = pal[0]?.percent ?? 0
      const acc = c.accuracy ?? 20
      const d76Limit = acc * 2.2 + 25
      const test = (p, extra) => {
        const d2000 = deltaE2000(v, [p.r, p.g, p.b])
        const d76 = deltaE76(v, [p.r, p.g, p.b])
        if (d2000 < acc && d76 < d76Limit) {
          _colorDistMap[img.file_path] = d76 + (extra || 0)
          return true
        }
        return false
      }
      if (r0 > 20 && test(pal[0])) return true
      if (r0 > 45 && pal[1] && (pal[1].percent ?? 0) > 6) {
        const white = deltaE2000([255, 255, 255], [pal[0].r, pal[0].g, pal[0].b])
        if (white < 8 && test(pal[1], 5)) return true
      }
      if (pal[1] && (pal[1].percent ?? 0) > 20 && test(pal[1], 4)) return true
      if (acc >= 26 && pal[2] && (pal[2].percent ?? 0) >= 12 && test(pal[2], 10)) return true
      return false
    },
    applyFilters(images) {
      const f = this.filters
      let arr = images
      if (f.shapes.length) arr = arr.filter((i) => this.shapeMatch(i))
      if (f.ratings.length) arr = arr.filter((i) => f.ratings.includes(i.rating || 0))
      if (f.formats.length) arr = arr.filter((i) => f.formats.includes((i.file_name.split('.').pop() || '').toLowerCase()))
      if (f.formatEx.length) arr = arr.filter((i) => !f.formatEx.includes((i.file_name.split('.').pop() || '').toLowerCase()))
      if (f.folders.length) {
        const root = this.tree?.rootPath || ''
        arr = arr.filter((i) => f.folders.some((rel) => i.file_path.startsWith(root + '\\' + rel.split('/').join('\\'))))
      }
      if (f.tags.length) {
        const picked = new Set(f.tags)
        arr = arr.filter((i) => (this.imageTags[i.id] || []).some((id) => picked.has(id)))
      }
      if (f.color && (f.color.on || f.color.gray)) {
        _colorDistMap = Object.create(null)
        arr = arr.filter((i) => this.colorMatch(i))
      }
      return arr
    },

    /* 网格大格显示图：1024px 有界缓存（有则用，没有让主进程生成；失败退回 400 缩略图） */
    async ensureDisplayThumbs(items) {
      const need = []
      for (const it of items || []) {
        if (!it?.path) continue
        const e = this.displayThumbs[it.path]
        if (e && e.m === (it.mtime || 0)) continue // 已请求（成功/失败/进行中）
        need.push(it)
      }
      if (!need.length) return
      for (const it of need) this.displayThumbs[it.path] = { p: null, m: it.mtime || 0 }
      try {
        const r = await window.picrand.picnestDisplayThumbs(need.map((x) => x.path))
        const got = new Map((r?.results || []).map((x) => [x.file_path, x.thumbnail_path]))
        for (const it of need) this.displayThumbs[it.path] = { p: got.get(it.path) || '', m: it.mtime || 0 }
      } catch {
        for (const it of need) this.displayThumbs[it.path] = { p: '', m: it.mtime || 0 }
      }
      this.layoutTick++
    },

    // ---- 色板索引：渐进构建（分步防挂起）----
    async ensurePalettes() {
      const myGen = (this._palGen = (this._palGen || 0) + 1)
      this.paletteBuild.running = true
      try {
        const todo = this.images.filter((x) => !this.palettes[x.file_path] && !isTextPath(x.file_path))
        if (!todo.length) { this.paletteBuild.done = this.paletteBuild.total = this.images.length; return }
        const waitFrame = () => new Promise((r) => setTimeout(r, 80))
        let doneCount = this.images.length - todo.length
        this.paletteBuild.total = this.images.length
        this.paletteBuild.done = doneCount
        for (let pos = 0; pos < Math.min(todo.length, 600); pos += 100) {
          if (myGen !== this._palGen) break
          const batchItems = todo.slice(pos, pos + 100)
          const batchPaths = batchItems.map((x) => x.file_path)
          /* 色板不改变卡片尺寸/排布，绝对不要触发 layoutTick++ 造成上万格瀑布流反复重排！ */
          await window.picrand.picnestBuildPalettesStep(this.activeRootId, 100).catch(() => {})
          if (myGen !== this._palGen) break
          const got = await window.picrand.picnestGetPalettes(batchPaths)
          if (myGen !== this._palGen) break
          const patch = {}
          for (const item of batchItems) {
            const p = got?.[item.file_path]
            if (p) patch[item.file_path] = p
            else if (item.thumbnail_path) patch[item.file_path] = []
          }
          if (Object.keys(patch).length) Object.assign(this.palettes, patch)
          doneCount += batchItems.length
          this.paletteBuild.done = Math.min(this.images.length, doneCount)
          await waitFrame()
        }
      } finally {
        if (myGen === this._palGen) this.paletteBuild.running = false
      }
    },

    // 缺宽高比的批量回填（自适应布局的原料），分批避免长阻塞
    async fillDimsInBackground() {
      if (this.dimsFilling) return
      const gen = this._loadGen
      this.dimsFilling = true
      try {
        for (let pass = 0; pass < 4; pass++) {
          if (gen !== this._loadGen) break
          /* 文本没有宽高（用缩略图 400×520 排版），别让尺寸回填空转 */
          const need = this.images.filter((i) => (!i.width || !i.height) && !isTextPath(i.file_path)).slice(0, 120).map((i) => i.file_path)
          if (!need.length) break
          const got = await api.fillImageDims(need)
          if (gen !== this._loadGen) break
          let changed = false
          for (const img of this.images) {
            const d = got[img.file_path]
            if (d) { img.width = d.width; img.height = d.height; changed = true }
          }
          if (changed) this.bumpLayout() // 仅尺寸真有变化时触发重排（合并触发）
          await new Promise((r) => setTimeout(r, 50))
        }
      } catch { /* 尺寸回填失败不阻塞 */ } finally {
        this.dimsFilling = false
      }
    },

    // 存量收割：缩略图文件可能已在缓存目录（PicRand md5 寻址），找回登记即可，零生成
    async harvestThumbs() {
      const gen = this._loadGen
      try {
        const missing = this.images.filter((i) => !i.thumbnail_path).slice(0, 2000)
        for (let i = 0; i < missing.length; i += 500) {
          if (gen !== this._loadGen) break // 用户已切走，停止收割
          const chunk = missing.slice(i, i + 500)
          const found = await window.picrand.picnestThumbLookup(chunk.map((c) => c.file_path))
          let hit = 0
          for (const img of chunk) {
            const t = found?.[img.file_path]
            if (t && !img.thumbnail_path) { img.thumbnail_path = t; hit++ }
          }
          if (hit > 0) this.bumpLayout()
        }
      } catch { /* 静默 */ }
    },

    // 后台补缺：批量生成 + 非响应式跳过记录，防止万图逐个改写触发 Vue 全量重排卡死
    async fillAllThumbsInBackground() {
      if (this.thumbsFilling) return
      const gen = this._loadGen
      this.thumbsFilling = true
      if (!this._thumbSkipSet) this._thumbSkipSet = new Set()
      const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('thumb timeout')), ms))
      let dirty = 0
      try {
        const queue = this.images.filter(
          (i) => !i.thumbnail_path && !isTextPath(i.file_path) && !this._thumbSkipSet.has(i.file_path),
        )
        const byPath = new Map(queue.map((i) => [i.file_path, i]))
        for (let idx = 0; idx < queue.length && idx < 160; idx += 8) {
          if (gen !== this._loadGen) break
          const batch = queue.slice(idx, idx + 8).filter((one) => one && !one.thumbnail_path)
          if (!batch.length) continue
          const paths = batch.map((one) => one.file_path)
          try {
            const res = await Promise.race([api.generateThumbnailsBatch(paths), timeout(25000)])
            if (gen !== this._loadGen) break
            const gotMap = new Map()
            for (const r of res?.results || []) {
              if (r?.file_path && r?.thumbnail_path) gotMap.set(r.file_path, r)
            }
            for (const p of paths) {
              const r = gotMap.get(p)
              const item = byPath.get(p)
              if (r && item) {
                item.thumbnail_path = r.thumbnail_path
                if (r.width && (!item.width || !item.height)) { item.width = r.width; item.height = r.height }
                dirty++
              } else {
                this._thumbSkipSet.add(p)
              }
            }
          } catch { /* 超时：下轮跳过，不影响其余 */ }
          if (dirty >= 24) {
            this.layoutTick++
            dirty = 0
          }
          await new Promise((r) => setTimeout(r, 60))
        }
      } finally {
        if (dirty > 0 && gen === this._loadGen) this.layoutTick++
        this.thumbsFilling = false
      }
    },

    async renameImage(oldPath, newName) {
      try {
        const r = await window.picrand.picnestRenameImage(oldPath, newName)
        if (!r?.ok) return r
        const img = this.images.find((i) => i.file_path === oldPath)
        if (img) {
          img.file_path = r.file_path
          img.file_name = r.file_path.split('\\').pop().split('/').pop()
        }
        if (this.selectedPath === oldPath) this.selectedPath = r.file_path
        this.selectedPaths = this.selectedPaths.map((p) => (p === oldPath ? r.file_path : p))
        if (this.selectionAnchor === oldPath) this.selectionAnchor = r.file_path
        if (this.lightbox.path === oldPath) this.lightbox.path = r.file_path
        this.fillAllThumbsInBackground() // 新路径无缩略图，补
        this.scheduleRootMetaSave()
        return r
      } catch (e) { return { ok: false, error: String(e?.message || e) } }
    },

    async saveMeta(path, patch) {
      try { await window.picrand.picnestSetImageMeta(path, patch) } catch { /* 静默 */ }
      const img = this.images.find((i) => i.file_path === path)
      if (img) Object.assign(img, patch)
      this.scheduleRootMetaSave()
    },

    // 物理移动文件到本库内另一目录（详情面板文件夹编辑）
    async moveImage(filePath, targetRel) {
      if (!this.tree) return { ok: false, error: '无目录树' }
      const targetDir = this.tree.rootPath + (targetRel ? '\\' + targetRel.split('/').join('\\') : '')
      this.suppressSyncUntil = Date.now() + 3000
      this.suppressWaveUntil = Date.now() + 1500
      try {
        const r = await window.picrand.picnestMoveImage(filePath, targetDir)
        if (r?.ok) {
          if (r.moved !== false) {
            this.images = this.images.filter((i) => i.file_path !== filePath)
            this.pruneImageSelection(filePath)
          }
          this.refreshTree()
          this.scheduleRootMetaSave()
        }
        return r
      } catch (e) { return { ok: false, error: String(e?.message || e) } }
    },

    // 多选图片批量物理移动（本地增量移除；watcher 触发被短暂抑制，不整表刷新）
    async moveImages(filePaths, targetRel) {
      if (!this.tree) return { ok: false, error: '无目录树' }
      const targetDir = this.tree.rootPath + (targetRel ? '\\' + targetRel.split('/').join('\\') : '')
      const n = (filePaths || []).length
      this.suppressSyncUntil = Date.now() + Math.max(3000, n * 400)
      this.suppressWaveUntil = Date.now() + 3000
      let moved = 0, failed = 0
      for (const p of filePaths || []) {
        try {
          const r = await window.picrand.picnestMoveImage(p, targetDir)
          if (r?.ok) {
            if (r.moved !== false) {
              moved++
              this.images = this.images.filter((i) => i.file_path !== p)
              this.pruneImageSelection(p)
            }
          } else failed++
        } catch (e) { failed++ }
      }
      if (moved) {
        this.suppressSyncUntil = Date.now() + 2000
        this.suppressWaveUntil = Date.now() + 1200
        await this.refreshTree()
        this.scheduleRootMetaSave()
        if (this.physicalOrder) {
          this.schedulePhysicalSync()
          if (targetRel != null) {
            this.schedulePhysicalSync(this.activeRootId, targetRel)
          }
        }
      }
      return { ok: failed === 0, moved, failed }
    },

    /* 拖到回收站：软删（文件原地保留），本地增量移除，不整表刷新 */
    async trashImages(paths) {
      if (this.view === 'trash') return { ok: false, error: '已在回收站' }
      const list = [...new Set((paths || []).filter(Boolean))]
      if (!list.length) return { ok: false }
      const set = new Set(list)
      let ok = 0, failed = 0
      for (const p of list) {
        try {
          await window.picrand.picnestRemove(p)
          ok++
        } catch (e) { failed++ }
      }
      if (ok) {
        if (this.soundFx) playTrashSound()
        this.suppressWaveUntil = Date.now() + 800
        this.images = this.images.filter((i) => !set.has(i.file_path))
        /* 整批收缩选中（逐项 prune 在大批量下是 O(n·m)，Ctrl+A 之后会卡） */
        this.selectedPaths = this.selectedPaths.filter((p) => !set.has(p))
        if (this.selectionAnchor && set.has(this.selectionAnchor)) this.selectionAnchor = this.selectedPaths[this.selectedPaths.length - 1] || null
        if (this.selectedPath && set.has(this.selectedPath)) this.selectedPath = this.selectedPaths[this.selectedPaths.length - 1] || null
        if (this.lightbox.open && set.has(this.lightbox.path)) this.closeLightbox()
        if (this.brief.open && set.has(this.brief.path)) this.closeBrief()
        await this.refreshTree()
        this.scheduleRootMetaSave()
        this.showNote(`已移入回收站 ${ok} 张${failed ? ` · 失败 ${failed}` : ''}`)
      }
      return { ok: failed === 0, moved: ok, failed }
    },

    // 目录树的扁平清单（移动目标选择器用）
    flatDirs() {
      const out = []
      const walk = (n, depth) => {
        if (n.rel) out.push({ rel: n.rel, name: n.name, total: n.total, depth })
        for (const c of n.children || []) walk(c, depth + 1)
      }
      if (this.tree?.tree) walk(this.tree.tree, 0)
      return out
    },

    // 拖拽：物理移动目录到另一目录（含显示态修复）
    async moveDir(srcRel, dstRel) {
      if (!this.tree) return { ok: false }
      const root = this.tree.rootPath
      const srcPath = root + '\\' + srcRel.split('/').join('\\')
      const dstPath = dstRel ? root + '\\' + dstRel.split('/').join('\\') : root
      try {
        const r = await window.picrand.picnestMoveDir(srcPath, dstPath)
        if (r?.ok) {
          /* 移动后 rel 迁移：目录本身 → dstRel/原名；子树 → 新前缀（当前浏览位置与多选同步） */
          const srcPrefix = srcRel + '/'
          const base = srcRel.split('/').pop()
          const newRel = dstRel ? dstRel + '/' + base : base
          const fix = (rel) => {
            if (rel == null) return rel
            if (rel === srcRel) return newRel
            if (rel.startsWith(srcPrefix)) return newRel + '/' + rel.slice(srcPrefix.length)
            return rel
          }
          this.currentDirRel = fix(this.currentDirRel)
          this.selectedDirs = this.selectedDirs.map((x) => fix(x))
          if (this.dirAnchor != null) this.dirAnchor = fix(this.dirAnchor)
          await this.refreshTree()
          await this.loadImages()
          this.scheduleRootMetaSave()
        } else if (r?.error) {
          this.error = r.error
        }
        return r
      } catch (e) { return { ok: false, error: String(e?.message || e) } }
    },

    setSidebarWidth(w) {
      this.sidebarWidth = Math.min(560, Math.max(200, w))
      localStorage.setItem('picnest.sidebarWidth', String(this.sidebarWidth))
    },
    setInspectorWidth(w) {
      this.inspectorWidth = Math.min(480, Math.max(240, w))
      localStorage.setItem('picnest.inspectorWidth', String(this.inspectorWidth))
    },
    /* 详情高度：0 = 自适应满高；>0 = 固定高度（右下角为支点，顶边上移/下移） */
    setInspectorHeight(h) {
      this.inspectorHeight = h > 0 ? Math.min(2000, Math.max(220, Math.round(h))) : 0
      localStorage.setItem('picnest.inspectorHeight', String(this.inspectorHeight))
    },

    setSort(mode, asc) {
      const prev = this.sortMode
      if (mode !== undefined) this.sortMode = mode
      if (asc !== undefined) this.sortAsc = asc
      if (this.sortMode === 'random') this.randomNonce++
      localStorage.setItem('picnest.sortMode', this.sortMode)
      localStorage.setItem('picnest.sortAsc', this.sortAsc ? '1' : '0')
      /* 文件夹/合并视图实时重查；全部视图只有 manual 参与排序，切进/切出 manual 时重查 */
      if (this.currentDirRel || this.selectionView || this.view === 'all') {
        if (this.currentDirRel || this.selectionView || this.sortMode === 'manual' || prev === 'manual') this.loadImages()
      }
    },
    /* 把当前网格显示顺序（含筛选/前端排序）固化成手动排序：按所在文件夹分组写 sort_order */
    async applyGridOrderToManual() {
      const paths = [...(this.gridOrder || [])].filter(Boolean)
      if (!paths.length) return { ok: false, error: '当前视图没有图片' }
      if (this.view === 'trash') return { ok: false, error: '回收站不支持手动排序' }
      const rid = this.activeRootId
      const filtered = this.activeFilterCount() > 0 || !!this.searchQuery
      const total = paths.length
      /* 把当前显示顺序固化成手动排序。只写 images.sort_order，磁盘文件名一动不动。 */
      const ok = await this.askConfirm({
        title: '应用为手动排序？',
        message: '按当前显示顺序写入手动排序，只存在图巢的元数据里，不会改磁盘文件名。',
        details: [
          `共 ${total} 张${filtered ? '（当前筛选/搜索只处理这些）' : ''}`,
          '原有 01_ 这类文件名前缀不会再被添加或替换',
        ],
        confirmText: '应用',
      })
      if (!ok) return { ok: false, canceled: true }
      const rootPath = String(this.tree?.rootPath || this.activeRoot?.path || '')
      const rootParts = rootPath.split(/[\\/]/).filter(Boolean)
      const groups = new Map()
      for (const p of paths) {
        let rel = ''
        if (rootParts.length) {
          const parts = String(p).split(/[\\/]/).filter(Boolean)
          const relParts = parts.slice(rootParts.length)
          relParts.pop() // 去掉文件名
          rel = relParts.join('/')
        } else {
          rel = this.currentDirRel || ''
        }
        if (!groups.has(rel)) groups.set(rel, [])
        groups.get(rel).push(p)
      }
      /* 纯 DB 写 sort_order；不再有物理改名这条路 */
      let applied = 0, failed = 0
      const renamed = 0
      {
        for (const [rel, list] of groups) {
          try {
            const r = await api.imagesReorder(rid, rel, list)
            if (r?.ok) applied += list.length
            else failed++
          } catch { failed++ }
        }
      }
      if (!applied) return { ok: false, error: '写入手动排序失败' }
      this.sortMode = 'manual'
      localStorage.setItem('picnest.sortMode', 'manual')
      await this.loadImages()
      this.showNote(`已应用为手动排序 ${applied} 张${failed ? ` · 失败 ${failed}` : ''}`)
      this.schedulePhysicalSync()
      return { ok: failed === 0, applied, renamed, failed }
    },
    /* 图片拖动排序：仅文件夹视图；写入 sort_order 并切到手动排序 */
    canReorder() {
      /* 只有手动排序模式才允许换位：其他排序模式下画面顺序是临时的，
         若允许拖动会按当前画面重建 sort_order，直接覆盖掉已有手动排序 */
      return !this.selectionView && this.view === 'all' && this.sortMode === 'manual' && !this.lightbox.open
    },
    async reorderImages(srcPaths, targetPath, before = true) {
      if (!this.canReorder()) return { ok: false, error: '请先切换到「手动排序」再拖动换位' }
      const set = new Set(srcPaths || [])
      if (!targetPath || set.has(targetPath)) return { ok: true, moved: false }
      const list = this.images.map((i) => i.file_path)
      const moving = list.filter((p) => set.has(p))
      if (!moving.length) return { ok: false }
      const rest = list.filter((p) => !set.has(p))
      let idx = rest.indexOf(targetPath)
      if (idx < 0) idx = rest.length
      else if (!before) idx += 1
      rest.splice(idx, 0, ...moving)
      const keep = this.selectedPaths.slice()
      // 拖拽后的自动改名也会产生文件事件，同步期间先抑制 watcher 回写
      this._suppressFsSyncUntil = Date.now() + 6000
      try {
        const r = await api.imagesReorder(this.activeRootId, this.currentDirRel ?? '', rest)
        if (!r?.ok) { if (r?.error) this.error = r.error; return r }
        /* 只存顺序；文件名不再被程序动 */
        /* 本地增量换序：只替换数组与排序模式，不整表 loadImages（不重放入场波、不清选中） */
        const map = new Map(this.images.map((i) => [i.file_path, i]))
        const nextOrder = rest.map((p) => map.get(p)).filter(Boolean)
        this.suppressWaveUntil = Date.now() + 700
        this.sortMode = 'manual'
        localStorage.setItem('picnest.sortMode', 'manual')
        this.images = nextOrder
        this.layoutTick++
        const exist = new Set(nextOrder.map((i) => i.file_path))
        this.selectedPaths = keep.filter((p) => exist.has(p))
        this.selectedPath = this.selectedPaths[this.selectedPaths.length - 1] || null
        this.selectionAnchor = this.selectedPath
        this.showNote('已调整顺序（手动排序）')
        this.scheduleRootMetaSave()
        /* 开关开着就自动落地到文件名（防抖 800ms，连续拖拽只跑最后一次） */
        this.schedulePhysicalSync()
        return r
      } catch (e) {
        const err = { ok: false, error: String(e?.message || e) }
        this.error = err.error
        return err
      }
    },
    setLayout(key) {
      this.layout = key
      localStorage.setItem('picnest.layout', key)
    },
    /* 显示名：隐藏排序编号时把 01_ 前缀藏起来（磁盘名不变） */
    dispName(name) {
      const s = String(name || '')
      return this.hideOrderNumbers ? s.replace(/^(?:\d{2,3})_+/, '') : s
    },
    orderPrefix(name) {
      const m = /^((?:\d{2,3})_+)/.exec(String(name || ''))
      return m ? m[1] : ''
    },
    /* 重命名目标名：隐藏编号时把旧前缀接回去，否则重命名会把排序编号弄丢 */
    renameTarget(oldName, name) {
      const n = String(name || '')
      return this.hideOrderNumbers ? this.orderPrefix(oldName) + n : n
    },
    toggleHideOrderNumbers() {
      this.hideOrderNumbers = !this.hideOrderNumbers
      localStorage.setItem('picnest.hideOrderNumbers', this.hideOrderNumbers ? '1' : '0')
      this.layoutTick++
    },
    setShowSubfolderContent(v) {
      this.showSubfolderContent = !!v
      localStorage.setItem('picnest.showSubfolderContent', v ? '1' : '0')
      if (this.view === 'all' && !this.selectionView) this.loadImages()
    },
    setZoom(z) {
      this.zoom = z
      clearTimeout(this._zoomSaveT)
      this._zoomSaveT = setTimeout(() => localStorage.setItem('picnest.zoom', String(this.zoom)), 300)
    },

    /* ---- 录入：位置即意图（Feb 2026-11-09 定）
       目标描述 { rootId, rel, index? }：
       - 主展示区/窗口空白 → 当前浏览文件夹（非文件夹视图 → 库根 = 全部/未分类）
       - 树行 → 该文件夹；树行缝隙 → 该层父级（文件夹按 index 插入排序）
       - 资料库栏 → 该库根 ---- */
    normTarget(target) {
      if (target && typeof target === 'object') {
        return {
          rootId: target.rootId ?? this.activeRootId,
          rel: String(target.rel || '').replace(/^\/+|\/+$/g, ''),
          index: Number.isInteger(target.index) ? target.index : null,
        }
      }
      const rel = typeof target === 'string' ? target : (this.view === 'all' ? (this.currentDirRel || '') : '')
      return { rootId: this.activeRootId, rel: String(rel || '').replace(/^\/+|\/+$/g, ''), index: null }
    },
    dropTarget() {
      return { rootId: this.activeRootId, rel: this.view === 'all' ? (this.currentDirRel || '') : '' }
    },
    /* 主展示区落点文案：文件夹名 或 库名·未分类 */
    mainDropLabel() {
      if (this.view === 'all' && this.currentDirRel) return `录入到「${this.currentDirRel.split('/').pop()}」`
      const root = this.roots.find((r) => r.id === this.activeRootId)
      const name = root?.display_name || String(root?.path || '').split(/[\\/]/).pop() || '当前库'
      return `录入到「${name}」· 未分类`
    },
    setDropHint(zone, label, x, y, key) {
      this.dropHint = { active: true, zone, label: label || '', x: x || 0, y: y || 0, key: key ?? null }
      /* 心跳超时：拖拽过程中持续续命，松开/离开窗口后 450ms 自动消失 */
      clearTimeout(this._dropHintTimer)
      this._dropHintTimer = setTimeout(() => this.clearDropHint(), 450)
    },
    clearDropHint() {
      clearTimeout(this._dropHintTimer)
      this._dropHintTimer = null
      if (this.dropHint.active) this.dropHint = { active: false, zone: '', label: '', x: 0, y: 0, key: null }
    },
    absOfTarget(t) {
      const root = this.roots.find((r) => r.id === t.rootId)
      const rootPath = root?.path || (t.rootId === this.activeRootId ? this.tree?.rootPath : '')
      if (!rootPath) return ''
      return rootPath + (t.rel ? '\\' + t.rel.split('/').join('\\') : '')
    },
    /* 录入结果 → 汇总卡（成功/跳过/不支持/失败 + 明细） */
    reportImport(r, t) {
      const parts = []
      if (r.copied) parts.push(`录入 ${r.copied} 张`)
      if (r.registered) parts.push(`补录 ${r.registered} 张`)
      if (r.downloaded) parts.push(`下载 ${r.downloaded} 张`)
      if (r.dirs?.length) parts.push(`文件夹 ${r.dirs.length} 个`)
      if (r.skipped) parts.push(`已在库中（跳过重复） ${r.skipped} 张`)
      if (r.replaced) parts.push(`替换旧图 ${r.replaced}`)
      if (r.unsupported) parts.push(`不支持 ${r.unsupported}`)
      if (r.failed) parts.push(`失败 ${r.failed}`)
      if (r.canceled) parts.push('已取消')
      const details = []
      for (const d of r.dirs || []) {
        const bits = []
        if (d.copied) bits.push(`录入 ${d.copied}`)
        if (d.registered) bits.push(`补录 ${d.registered}`)
        if (d.skipped) bits.push(`已在库中 ${d.skipped}`)
        if (d.replaced) bits.push(`替换 ${d.replaced}`)
        if (d.unsupported) bits.push(`不支持 ${d.unsupported}`)
        if (d.failed) bits.push(`失败 ${d.failed}`)
        details.push({ label: d.name || '文件夹', text: bits.join(' · ') || '没有可录入的图片' })
      }
      if (r.unsupportedNames?.length) {
        const more = r.unsupported > r.unsupportedNames.length ? ' …' : ''
        details.push({ label: '不支持', text: r.unsupportedNames.join('、') + more })
      }
      if (r.missing?.length) details.push({ label: '找不到', text: r.missing.length + ' 个路径已失效' })
      if (r.errors?.length) details.push({ label: '错误', text: r.errors.join('；') })
      /* 跨库录入时标明去向（当前库不标，位置本身可见） */
      let crossNote = ''
      if (t && t.rootId !== this.activeRootId) {
        const rec = this.roots.find((x) => x.id === t.rootId)
        if (rec) {
          const name = rec.display_name || String(rec.path || '').split(/[\\/]/).pop()
          crossNote = name ? ` → ${name}` : ''
        }
      }
      this.importResult = {
        open: true,
        nonce: Date.now(),
        summary: (parts.length ? parts.join(' · ') : (r.error || (r.ok ? '没有可录入的内容' : '录入失败'))) + crossNote,
        details,
        tone: r.ok ? (parts.length ? 'ok' : 'muted') : 'error',
      }
      /* 新图落地 → 把目标文件夹提到同级第一位（只改 picnest_dir_order，不改文件名）。
         以前这件事只能靠给文件夹名加 01_ 前缀，现在不需要了。 */
      const landed = (r.copied || 0) + (r.registered || 0) + (r.downloaded || 0) + (r.replaced || 0)
      // t.index 不为空 = 用户明确拖到了某个缝隙位置，那个位置比“置顶”优先
      if (landed > 0 && t?.rel && t.index == null) {
        this.pinDirAfterImport(t.rootId, t.rel).catch(() => {})
      }
    },
    /* 缝隙落点：把新文件夹名插到指定序号（仅当前资料库可排序——dirOrder 以 rel 为键） */
    async insertOrderAt(parentRel, name, index) {
      await this.refreshTree()
      const node = parentRel ? this.findNode(this.tree?.tree, parentRel) : this.tree?.tree
      const names = (node?.children || []).map((c) => c.name).filter((n) => n !== name)
      const at = index == null ? names.length : Math.max(0, Math.min(index, names.length))
      names.splice(at, 0, name)
      await window.picrand.picnestDirOrderSet(this.activeRootId, parentRel || '__root__', names)
      await this.refreshTree()
      this.scheduleRootMetaSave()
      await this.syncDirOrderPhysical(parentRel, names)
    },

    /* 把某个目录提到同级第一位：只写 picnest_dir_order，一行文件名都不动。
       这是替代「给文件夹名加 01_ 前缀」的正路。 */
    async pinDir(parentRel, name, opts = {}) {
      if (!name || this.activeRootId == null) return null
      await this.refreshTree()
      const node = parentRel ? this.findNode(this.tree?.tree, parentRel) : this.tree?.tree
      const siblings = (node?.children || []).map((c) => c.name)
      if (!siblings.length) return null
      // 名字必须和树上完全一致（磁盘是大写 SR、rel 是小写 sr，不能拿 rel 猜）
      if (!siblings.includes(name)) return null
      if (siblings[0] === name) return siblings // 已在首位，不用写库
      const names = siblings.filter((n) => n !== name)
      names.unshift(name)
      try {
        await window.picrand.picnestDirOrderSet(this.activeRootId, parentRel || '__root__', names)
      } catch { return null }
      await this.refreshTree()
      if (opts.notify) this.showNote(`已把「${this.dispName(name)}」置顶（只改顺序元数据，未动文件名）`)
      return names
    },

    /* 新图落地后把目标文件夹置顶（autoPinOnImport 可关）。失败不影响导入结果。 */
    async pinDirAfterImport(rootId, rel) {
      if (!this.autoPinOnImport || !rel) return null
      if (rootId != null && rootId !== this.activeRootId) return null
      try {
        await this.refreshTree()
        /* 用树里的真实节点名（磁盘大小写为准）。注意 t.rel 常来自 DB 的 dir_rel，
           而那个是小写（06_gbf/sr），树里是 06_GBF/SR —— 所以先精确，再不区分大小写。 */
        const tree = this.tree?.tree
        let node = this.findNode(tree, rel)
        if (!node) {
          const want = String(rel).toUpperCase()
          const walk = (n) => {
            if (!n) return null
            if (String(n.rel || '').toUpperCase() === want) return n
            for (const c of n.children || []) {
              const r = walk(c)
              if (r) return r
            }
            return null
          }
          node = walk(tree)
        }
        const name = node?.name
        if (!name) return null
        /* parentRel 必须从节点的真实 rel 派生：传入的 t.rel 常是 DB 的 dir_rel（全小写），
           拿它去用 findNode 找父节点会找不到，导致置顶静默失效。
           picnest_dir_order 的 key 也是用磁盘真实大小写 rel 拼的（dir_tree 里 format!("{}|{}")）。 */
        const nodeRel = String(node.rel || '')
        const cut = nodeRel.lastIndexOf('/')
        const parentRel = cut < 0 ? '' : nodeRel.slice(0, cut)
        return await this.pinDir(parentRel, name)
      } catch { return null }
    },

    async importUrls(urls, target) {
      await this.ensureReady()
      const t = this.normTarget(target)
      const targetDir = this.absOfTarget(t)
      try {
        if (!targetDir) {
          const fail = { ok: false, error: '目标根文件不可用' }
          this.reportImport(fail, t)
          return fail
        }
        const r = await window.picrand.picnestImportUrls(urls, targetDir)
        const agg = { ok: !!r?.ok, copied: 0, downloaded: r?.downloaded || 0, skipped: 0, failed: r?.failed || 0, unsupported: 0, dirs: [], errors: [], error: r?.error || '' }
        if (agg.downloaded) {
          const rootRec = this.roots.find((x) => x.id === t.rootId)
          if (rootRec) await api.syncFolderSnapshot(rootRec.path).catch(() => {})
          if (t.rootId === this.activeRootId) {
            await this.refreshTree()
            await this.loadImages()
            if (this.physicalOrder) {
              if ((t.rel || '') === (this.currentDirRel || '')) {
                this.schedulePhysicalSync()
              } else {
                this.schedulePhysicalSync(t.rootId, t.rel || '')
              }
            }
          } else if (this.physicalOrder) {
            this.schedulePhysicalSync(t.rootId, t.rel || '')
          }
        }
        this.reportImport(agg, t)
        return agg
      } catch (e) {
        const r = { ok: false, error: String(e?.message || e) }
        this.reportImport(r, t)
        return r
      }
    },

    // 外部拖入：文件→复制进目标目录；文件夹→复制为目标下的同名子文件夹（保留结构）
    // 就绪守卫：init 是异步轮询，启动头两秒 tree 可能为空
    async ensureReady() {
      for (let i = 0; i < 40 && (!this.tree || !this.roots.length); i++) {
        await new Promise((r) => setTimeout(r, 250))
      }
      if (!this.tree && this.activeRootId != null) await this.refreshTree()
    },

    /* 文件夹放入：先做库内查重（MD5）→ 有重复弹三选一（跳过旧/覆盖旧/都保留）→ 按策略合并复制。
       同名目标文件夹合并，不再新开 (n)；返回主进程明细（含 created/replaced）。 */
    async mergeDirWithDupes(srcAbs, targetDir, t) {
      let opts = {}
      /* 整包查重改为流式异步：大文件夹扫描期间给一个可取消的进度浮条 */
      this.taskProgress = { visible: true, kind: 'dirDup', label: '正在检查文件夹重复', done: 0, total: 0, cancelable: true, canceling: false }
      try {
        const scan = await window.picrand.picnestDirDupCheck(srcAbs, targetDir, t.rootId)
        this.taskProgress.visible = false
        if (scan?.canceled) return { ok: false, canceled: true, error: '已取消' }
        if (scan?.ok && scan.count > 0) {
          const choice = await new Promise((resolve) => {
            this.dupDialog = {
              open: true,
              mode: 'merge',
              items: (scan.items || []).slice(0, 8),
              count: scan.count,
              targetRel: t.rel || null,
              resolve,
            }
          })
          opts = {
            dupChecked: true,
            policy: choice === 'use-new' ? 'replace' : (choice === 'keep-both' ? 'keep-both' : 'skip'),
            dupes: (scan.items || []).map((i) => ({ src: i.src, old: i.existing?.file_path || '' })),
          }
        }
      } catch (e) { /* 查重失败：按普通合并处理 */ }
      finally { this.taskProgress.visible = false }
      return window.picrand.picnestImportDirCopy(srcAbs, targetDir, opts)
    },
    async cancelTask() {
      const t = this.taskProgress
      if (!t.visible || !t.cancelable || t.canceling) return
      t.canceling = true
      try {
        if (t.kind === 'thumbs') await window.picrand.picnestRepairThumbsCancel()
        else await window.picrand.picnestDirDupCancel()
      } catch { /* 静默 */ }
    },

    // 外部拖入：先全库查重（Eagle 式冲突弹窗），再复制进目标目录
    async importDrop(paths, target) {
      await this.ensureReady()
      const t = this.normTarget(target)
      const targetDir = this.absOfTarget(t)
      try {
        if (!targetDir) {
          const fail = { ok: false, error: '目标根文件不可用' }
          this.reportImport(fail, t)
          return fail
        }
        // Eagle 式：先查重，有冲突先弹对比卡（带上当前 targetDir 以便盘查未录入本地幽灵文件）
        const check = await window.picrand.picnestImportCheck(paths, t.rootId, targetDir)
        let finalPaths = check?.clean || []
        const conflicts = check?.conflicts || []
        const dirs = check?.dirs || []
        let choice = null
        if (conflicts.length) {
          choice = await new Promise((resolve) => {
            this.dupDialog = { open: true, mode: 'files', items: conflicts, count: conflicts.length, targetRel: t.rel || null, resolve }
          })
          if (choice === 'keep-both' || choice === 'use-new') {
            finalPaths = finalPaths.concat(conflicts.map((c) => c.path))
          }
        }
        const agg = {
          ok: true, copied: 0, registered: 0, downloaded: 0, skipped: 0, replaced: 0, failed: 0, unsupported: 0,
          unsupportedNames: [], dirs: [], errors: [], missing: check?.missing || [],
        }
        if (finalPaths.length) {
          const replaceOld = choice === 'use-new'
            ? conflicts.map((c) => c.existing?.file_path).filter(Boolean)
            : null
          const r = await window.picrand.picnestImportFiles(finalPaths, targetDir, replaceOld)
          if (r?.ok) {
            agg.copied += r.copied || 0
            agg.registered += r.registered || 0
            agg.skipped += r.skipped || 0
            agg.replaced += r.replaced || 0
            agg.failed += r.failed || 0
            agg.unsupported += r.unsupported || 0
            if (r.unsupportedNames?.length) agg.unsupportedNames.push(...r.unsupportedNames)
          } else {
            agg.ok = false
            agg.error = r?.error || '复制失败'
          }
        }
        if (choice === 'use-existing') agg.skipped += conflicts.length
        /* 文件夹：复制为子文件夹（合并/跳过/序号由主进程处理）；缝隙落点按 index 插入排序 */
        let idx = t.index
        for (const d of dirs) {
          const r = await this.mergeDirWithDupes(d, targetDir, t)
          if (r?.canceled) { agg.canceled = true; break }
          if (r?.ok) {
            agg.dirs.push(r)
            agg.copied += r.copied || 0
            agg.registered += r.registered || 0
            agg.skipped += r.skipped || 0
            agg.failed += r.failed || 0
            agg.unsupported += r.unsupported || 0
            agg.replaced = (agg.replaced || 0) + (r.replaced || 0)
            if (r.unsupportedNames?.length) agg.unsupportedNames.push(...r.unsupportedNames)
            if (t.rootId === this.activeRootId && r.created) {
              await this.insertOrderAt(t.rel, r.name, idx)
              if (idx != null) idx += 1
            }
          } else {
            agg.failed += 1
            agg.errors.push(`${(d.split(/[\\/]/).pop() || d)}：${r?.error || '复制失败'}`)
          }
        }
        const touched = agg.copied > 0 || agg.registered > 0 || agg.replaced > 0
        if (touched) {
          const rootRec = this.roots.find((x) => x.id === t.rootId)
          if (rootRec) await api.syncFolderSnapshot(rootRec.path).catch(() => {})
          if (t.rootId === this.activeRootId) {
            await this.refreshTree()
            await this.loadImages()
            if (this.physicalOrder) {
              if ((t.rel || '') === (this.currentDirRel || '')) {
                this.schedulePhysicalSync()
              } else {
                this.schedulePhysicalSync(t.rootId, t.rel || '')
              }
            }
          } else if (this.physicalOrder) {
            this.schedulePhysicalSync(t.rootId, t.rel || '')
          }
        }
        this.reportImport(agg, t)
        return agg
      } catch (e) {
        const r = { ok: false, error: String(e?.message || e) }
        this.reportImport(r, t)
        return r
      }
    },

    // 拖拽排序/移动三段式落点：before / after / into
    async dropOnDir(srcRel, targetRel, pos) {
      if (!srcRel) return
      if (pos !== 'into' && !targetRel) return // 根行只能 into（移入库根），不能排序
      const destParent = pos === 'into' ? targetRel : (targetRel.includes('/') ? targetRel.split('/').slice(0, -1).join('/') : '')
      const srcParent = srcRel.includes('/') ? srcRel.split('/').slice(0, -1).join('/') : ''
      const srcName = srcRel.split('/').pop()
      const targetName = targetRel.split('/').pop()

      if (pos === 'into') {
        if (srcRel === targetRel || (targetRel + '/').startsWith(srcRel + '/')) return
        const moved = await this.moveDir(srcRel, destParent)
        if (!moved?.ok) return
        await this.appendOrder(destParent, srcName)
      } else {
        if (srcRel === targetRel || (targetRel + '/').startsWith(srcRel + '/')) return
        if (srcParent !== destParent) {
          const moved = await this.moveDir(srcRel, destParent)
          if (!moved?.ok) return
        }
        await this.refreshTree()
        // 从最新树里取目标父级的现有顺序
        const node = destParent ? this.findNode(this.tree?.tree, destParent) : this.tree?.tree
        const names = (node?.children || []).map((c) => c.name).filter((n) => n !== srcName)
        const at = names.indexOf(targetName)
        names.splice(at < 0 ? names.length : at + (pos === 'after' ? 1 : 0), 0, srcName)
        await window.picrand.picnestDirOrderSet(this.activeRootId, destParent || '__root__', names)
        await this.refreshTree()
      }
    },

    /* 多选文件夹拖拽：整组移动（跳过根、自身、后代；父子同时选中只搬父级） */
    async dropOnDirs(srcRels, targetRel, pos) {
      const destParent = pos === 'into' ? targetRel : (targetRel.includes('/') ? targetRel.split('/').slice(0, -1).join('/') : '')
      const rels = this.topLevelDirs(srcRels).filter((r) => r !== '') // 父子同选只搬父级
      const valid = rels.filter((r) => r !== destParent && r !== targetRel && !(destParent && (destParent + '/').startsWith(r + '/')))
      if (!valid.length) return { ok: true, moved: 0 }

      if (pos === 'into') {
        let moved = 0
        for (const rel of valid) {
          const r = await this.moveDir(rel, destParent)
          if (r?.ok) {
            moved++
            await this.appendOrder(destParent, rel.split('/').pop())
          }
        }
        return { ok: true, moved }
      }

      const targetName = targetRel.split('/').pop()
      const movedNames = []
      for (const rel of valid) {
        const srcParent = rel.includes('/') ? rel.split('/').slice(0, -1).join('/') : ''
        if (srcParent !== destParent) {
          const r = await this.moveDir(rel, destParent)
          if (!r?.ok) continue
        }
        movedNames.push(rel.split('/').pop())
      }
      if (!movedNames.length) return { ok: true, moved: 0 }
      await this.refreshTree()
      const node = destParent ? this.findNode(this.tree?.tree, destParent) : this.tree?.tree
      // 目标名必须留在 names 里才能算插入位；只过滤被移动项
      const names = (node?.children || []).map((c) => c.name).filter((n) => !movedNames.includes(n))
      const at = names.indexOf(targetName)
      names.splice(at < 0 ? names.length : at + (pos === 'after' ? 1 : 0), 0, ...movedNames)
      await window.picrand.picnestDirOrderSet(this.activeRootId, destParent || '__root__', names)
      await this.refreshTree()
      this.scheduleRootMetaSave()
      await this.syncDirOrderPhysical(destParent, names)
      return { ok: true, moved: movedNames.length }
    },

    async appendOrder(parentRel, name) {
      await this.refreshTree()
      const node = parentRel ? this.findNode(this.tree?.tree, parentRel) : this.tree?.tree
      const names = (node?.children || []).map((c) => c.name).filter((n) => n !== name)
      names.push(name)
      await window.picrand.picnestDirOrderSet(this.activeRootId, parentRel || '__root__', names)
      await this.refreshTree()
      this.scheduleRootMetaSave()
      await this.syncDirOrderPhysical(parentRel, names)
    },

    /* 树上按 rel 找节点。先精确匹配（绝大多数情况），找不到再做一次不区分大小写的回退：
       DB 的 dir_rel 是全小写（06_gbf/sr），而树节点 rel 来自磁盘真实大小写（06_GBF/SR），
       拿 DB 风格 rel 来查会静默落到 null（曾经导致新建文件夹插序、置顶全部无效）。 */
    findNode(root, rel) {
      if (!root || rel == null) return null
      const exact = (n) => {
        if (!n) return null
        if (n.rel === rel) return n
        for (const c of n.children || []) {
          const h = exact(c)
          if (h) return h
        }
        return null
      }
      const hit = exact(root)
      if (hit) return hit
      const want = String(rel).toUpperCase()
      const ci = (n) => {
        if (!n) return null
        if (String(n.rel || '').toUpperCase() === want) return n
        for (const c of n.children || []) {
          const h = ci(c)
          if (h) return h
        }
        return null
      }
      return ci(root)
    },

    /* 图片多选：单击=单选；Shift=按当前可见顺序范围选；Alt/Ctrl=加选/减选（可与 Shift 叠加） */
    emitSelectionEvent() {
      emitPluginEvent('selection-changed', {
        paths: [...this.selectedPaths], dirs: [...this.selectedDirs],
        rootId: this.activeRootId, view: this.view, rel: this.currentDirRel || '',
      })
    },
    selectImage(path, opts = {}) {
      const shift = !!opts.shift
      const add = !!opts.add
      /* 按画面实际视觉顺序（gridOrder）做 Shift 范围选，兼容瀑布流/自适应行高与前端即时排序 */
      const list = this.gridOrder?.length ? this.gridOrder : this.filteredImages.map((i) => i.file_path)
      if (!this.selectionView) this.clearDirSelection()
      if (shift && this.selectionAnchor != null) {
        const a = list.indexOf(this.selectionAnchor)
        const b = list.indexOf(path)
        if (a >= 0 && b >= 0) {
          // 保留鼠标选择方向：从下往上框选时 selectedPaths 也按从下往上的顺序，
          // 否则多选叠图按 slice(-4) 永远取到列表最底部 4 个。
          const range = a <= b ? list.slice(a, b + 1) : list.slice(b, a + 1).reverse()
          this.selectedPaths = add ? [...new Set([...this.selectedPaths, ...range])] : range
          this.selectedPath = path
          this.emitSelectionEvent()
          return
        }
      }
      if (add) {
        const i = this.selectedPaths.indexOf(path)
        if (i >= 0) {
          this.selectedPaths.splice(i, 1)
          if (this.selectedPath === path) this.selectedPath = this.selectedPaths[this.selectedPaths.length - 1] || null
        } else {
          this.selectedPaths.push(path)
          this.selectedPath = path
        }
        this.selectionAnchor = path
        this.emitSelectionEvent()
        return
      }
      this.selectedPaths = [path]
      this.selectedPath = path
      this.selectionAnchor = path
      this.emitSelectionEvent()
    },
    clearImageSelection() {
      this.selectedPath = null
      this.selectedPaths = []
      this.selectionAnchor = null
      this.emitSelectionEvent()
    },
    /* Ctrl+A：选中当前可见（筛选后）全部图片 */
    selectAllImages() {
      if (!this.images.length) return 0
      const list = this.gridOrder?.length ? [...this.gridOrder] : this.filteredImages.map((i) => i.file_path)
      this.selectedPaths = list
      this.selectedPath = list[list.length - 1] || null
      this.selectionAnchor = list[0] || null
      if (!this.selectionView) this.clearDirSelection()
      this.emitSelectionEvent()
      return list.length
    },
    /* 框选：拖拽过程中直接写入选中集；add=保留按下前的底集（Shift 加选） */
    setImageSelection(paths, opts = {}) {
      if (!this.selectionView) this.clearDirSelection()
      const list = [...new Set((paths || []).filter(Boolean))]
      this.selectedPaths = opts.add ? [...new Set([...(opts.base || []), ...list])] : list
      this.selectionAnchor = this.selectedPaths[this.selectedPaths.length - 1] || null
      this.selectedPath = this.selectedPaths[this.selectedPaths.length - 1] || null
      this.emitSelectionEvent()
    },
    /* Esc：清空图片/文件夹选中；合并视图要退回原浏览文件夹 */
    clearSelections() {
      const wasMerged = this.selectionView
      const had = this.selectedPaths.length > 0 || this.selectedDirs.length > 0 || wasMerged
      this.clearImageSelection()
      this.clearDirSelection()
      if (wasMerged) {
        this.selectionView = false
        this.loadImages()
      }
      return had
    },
    /* 图片从当前列表消失（删除/移走）时收缩多选，主选中顺延到最后一项 */
    pruneImageSelection(path) {
      this.selectedPaths = this.selectedPaths.filter((p) => p !== path)
      if (this.selectionAnchor === path) this.selectionAnchor = this.selectedPaths[this.selectedPaths.length - 1] || null
      if (this.selectedPath === path) this.selectedPath = this.selectedPaths[this.selectedPaths.length - 1] || null
    },
    /* 文件夹多选：可见顺序 = 展开态下的树遍历（根行默认展开，与 DirTreeItem 一致） */
    flatVisibleDirs() {
      const out = []
      const mem = this.dirMemory || {}
      const walk = (n, depth) => {
        out.push(n.rel)
        const open = mem[n.rel]?.expanded ?? depth === 0
        if (open) for (const c of n.children || []) walk(c, depth + 1)
      }
      if (this.tree?.tree) walk(this.tree.tree, 0)
      return out
    },
    selectDir(rel, opts = {}) {
      const shift = !!opts.shift
      const add = !!opts.add
      this.clearImageSelection()
      const list = this.flatVisibleDirs()
      do {
        if (shift && this.dirAnchor != null) {
          const a = list.indexOf(this.dirAnchor)
          const b = list.indexOf(rel)
          if (a >= 0 && b >= 0) {
            const [lo, hi] = a < b ? [a, b] : [b, a]
            const range = list.slice(lo, hi + 1)
            this.selectedDirs = add ? [...new Set([...this.selectedDirs, ...range])] : range
            break
          }
        }
        if (add) {
          const i = this.selectedDirs.indexOf(rel)
          if (i >= 0) this.selectedDirs.splice(i, 1)
          else this.selectedDirs.push(rel)
          this.dirAnchor = rel
          break
        }
        this.selectedDirs = [rel]
        this.dirAnchor = rel
      } while (false)
      /* 多选文件夹 → 网格合并内容视图；降到 1 个 → 退出并回到原浏览
         正文卡片传 preview:false：只选中并让详情显示，不切中央网格 */
      if (opts.preview === false) return
      const multi = this.selectedDirs.length > 1
      if (multi) {
        this.selectionView = true
        this.loadImages()
      } else if (this.selectionView) {
        this.selectionView = false
        this.loadImages()
      }
    },
    exitSelectionView() {
      if (!this.selectionView) return
      this.selectionView = false
      this.loadImages()
    },
    clearDirSelection() {
      this.selectedDirs = []
      this.dirAnchor = null
    },
    select(path) {
      this.selectImage(path)
    },

    async markOpened(filePath) {
      try { await api.imageOpened(filePath) } catch { /* 静默 */ }
    },

    /* ---- M3: 灯箱 / 右键菜单 / 详情操作 ---- */
    openLightbox(path, originRect = null) {
      if (this.brief.open) this.closeBrief()
      const targetPath = path || this.selectedPath
      /* 在切换到灯箱前抓取网格缩略图的屏幕坐标（FLIP 共享元素过渡起点） */
      let rect = originRect
      if (!rect && targetPath && !this.lightbox.open && typeof document !== 'undefined') {
        const cells = document.querySelectorAll('.grid-viewport .cell[data-cell-path]')
        for (const el of cells) {
          if (el.dataset.cellPath === targetPath) {
            const sub = el.querySelector('.thumb') || el
            const r = sub.getBoundingClientRect()
            if (r.width > 0 && r.height > 0) rect = { left: r.left, top: r.top, width: r.width, height: r.height }
            break
          }
        }
      }
      this.lightboxOrigin = rect ? { ...rect, path: targetPath, at: Date.now() } : null
      if (path) this.selectedPath = path
      if (this.selectedPath) {
        this.selectedPaths = [this.selectedPath]
        this.selectionAnchor = this.selectedPath
      }
      if (!this.selectionView) this.clearDirSelection()
      this.lightbox = { open: true, path: targetPath }
      if (this.lightbox.path) this.markOpened(this.lightbox.path)
      emitPluginEvent('image-opened', { path: this.lightbox.path })
      this.viewer.rot = 0; this.viewer.flopX = false
      this.viewer.cropMode = false
      this.viewer.fitNonce++
      /* 进入大图不再 collectiveShake()：紧接着就是看图/缩放，
         图标全体动画会把首帧拖到几十毫秒。 */
    },
    closeLightbox() {
      const closedPath = this.lightbox.path
      this.lightbox = { open: false, path: null }
      this.viewer.cropMode = false
      /* 退出大图时重置视图状态。之前 scale/tx/ty 留着上次的值（实测关完后 scale 停在 0.58），
         下次打开会用错位缩放做动画，也让 FLIP 起点算不准。 */
      this.viewer.scale = 1
      this.viewer.tx = 0
      this.viewer.ty = 0
      if (closedPath) emitPluginEvent('image-closed', { path: closedPath })
      /* 2026-11-15：退出大图不再调 collectiveShake()。
         实测关闭瞬间消息泵会有 3×28ms 的卡（图标全体重播 640ms 动画造成），
         而退出后用户往往立刻拖窗口/滚网格，那阵卡就直接被感知为“拖拽发滞”。 */
    },

    /* ---- 简报模式（全屏演示，Eagle 语义） / 黑白预览（全局显示开关） ---- */
    toggleGrayscale() {
      this.grayscaleMode = !this.grayscaleMode
      localStorage.setItem('picnest.grayscale', this.grayscaleMode ? '1' : '0')
    },
    toggleCardTilt3D() {
      this.cardTilt3D = !this.cardTilt3D
      localStorage.setItem('picnest.cardTilt3D', this.cardTilt3D ? '1' : '0')
    },
    toggleMascots() {
      this.showMascots = !this.showMascots
      try { localStorage.setItem('picnest.mascots', this.showMascots ? '1' : '0') } catch {}
    },
    toggleSoundFx() {
      this.soundFx = !this.soundFx
      try { localStorage.setItem('picnest.soundFx', this.soundFx ? '1' : '0') } catch {}
      if (this.soundFx) playRestoreSound({ force: true })
    },
    syncCaptureTargetDir() {
      try {
        const root = this.roots.find((x) => x.id === this.activeRootId)
        let dir = root?.path || null
        if (this.view === 'all' && this.currentDirRel) {
          dir = this.absPathOf(this.currentDirRel) || dir
        }
        api.captureSetTargetDir?.(dir)?.catch?.(() => {})
      } catch {}
    },
    autoEnableMascotsIfUnset() {
      try {
        if (localStorage.getItem('picnest.mascots') === null) this.showMascots = true
      } catch {}
    },
    toggleDocPrivacyMode() {
      this.docPrivacyMode = !this.docPrivacyMode
      localStorage.setItem('picnest.docPrivacyMode', this.docPrivacyMode ? '1' : '0')
    },
    openBrief(path, fromLightbox = false) {
      this.closeContextMenu()
      this._briefFromLightbox = fromLightbox || this.lightbox.open
      if (this.lightbox.open) this.closeLightbox()
      const p = path || this.selectedPath || this.images[0]?.file_path || null
      if (!p) return
      this.brief = { open: true, path: p, scale: 1, tx: 0, ty: 0 }
      try {
        const pr = document.documentElement.requestFullscreen?.()
        if (pr?.catch) pr.catch(() => {})
      } catch (e) {}
    },
    closeBrief() {
      const returnPath = this.brief.path
      const fromLb = this._briefFromLightbox
      this._briefFromLightbox = false
      this.brief = { open: false, path: null, scale: 1, tx: 0, ty: 0 }
      try {
        if (document.fullscreenElement) {
          const pr = document.exitFullscreen?.()
          if (pr?.catch) pr.catch(() => {})
        }
      } catch (e) {}
      if (fromLb && returnPath) {
        this.openLightbox(returnPath)
      }
    },
    briefNav(dir) {
      const list = this.gridOrder?.length ? this.gridOrder : this.filteredImages.map((x) => x.file_path)
      if (!list.length) return
      const i = list.indexOf(this.brief.path)
      const n = ((i < 0 ? 0 : i) + dir + list.length) % list.length
      this.brief = { open: true, path: list[n], scale: 1, tx: 0, ty: 0 }
    },

    /* ---- 移入未分类：物理移到库根并保留索引（替代“从库中移除”，避免幽灵文件） ---- */
    async moveToUncategorized(paths) {
      const list = [...new Set((paths || []).filter(Boolean))]
      if (!list.length) return { ok: false }
      const rootPath = this.tree?.rootPath
      if (!rootPath) return { ok: false, error: '无根文件' }
      const norm = (p) => String(p).replace(/\//g, '\\').toLowerCase()
      const root = norm(rootPath).replace(/\\+$/, '')
      const dirOf = (p) => { const s = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')); return s < 0 ? '' : p.slice(0, s) }
      const todo = [], already = []
      for (const p of list) {
        if (norm(dirOf(p)) === root) already.push(p)
        else todo.push(p)
      }
      let moved = 0, failed = 0
      if (todo.length) {
        const r = await this.moveImages(todo, '')
        moved = r?.moved || 0
        failed = r?.failed || 0
        /* 当前就在库根/未分类/最近等非文件夹视图：移过去后仍应显示，重新加载一次 */
        if (moved && !this.currentDirRel) await this.loadImages()
      }
      const parts = []
      if (moved) parts.push(`已移入未分类 ${moved} 张`)
      if (already.length) parts.push(`已在未分类 ${already.length} 张`)
      if (failed) parts.push(`失败 ${failed} 张`)
      if (this.brief.open && moved) this.closeBrief() // 路径已变，简报里的旧路径失效
      if (this.lightbox.open && moved) this.closeLightbox()
      this.showNote(parts.join(' · ') || '没有可移动的文件', [], failed ? 'error' : 'ok')
      return { ok: failed === 0, moved, failed, already: already.length }
    },
    openPlugins() { this.pluginsOpen = true },
    closePlugins() { this.pluginsOpen = false },
    openHelp() { this.helpOpen = true },
    closeHelp() { this.helpOpen = false },
    openVisualSearch(items = []) {
      const tasks = (items || []).map((it) => {
        const isStr = typeof it === 'string'
        const fp = isStr ? it : it.filePath
        const name = isStr ? it.split(/[\\/]/).pop() : (it.name || it.title || 'query')
        const normFp = fp ? fp.replace(/\\/g, '/').toLowerCase() : ''
        const existing = normFp ? this.images.find((im) => im.file_path && im.file_path.replace(/\\/g, '/').toLowerCase() === normFp) : null
        let thumb = ''
        if (existing?.thumbnail_path && existing.thumbnail_path !== 'SKIP') {
          thumb = fileUrl(existing.thumbnail_path)
        } else if (fp) {
          const ext = fp.slice(fp.lastIndexOf('.')).toLowerCase()
          if (ext === '.psd' || ['.mp4', '.webm', '.mov', '.mkv', '.avi', '.flv', '.f4v'].includes(ext)) {
            thumb = '' // 特殊格式交由后端以图找图管线生成真实预览帧
          } else {
            thumb = fileUrl(fp)
          }
        } else {
          thumb = it.thumbUrl || it.dataUrl || ''
        }
        return {
          id: crypto.randomUUID(),
          name,
          filePath: fp || '',
          dataUrl: !isStr ? (it.dataUrl || '') : '',
          thumbUrl: thumb,
          width: it.width || existing?.width || null,
          height: it.height || existing?.height || null,
          bbox: [0, 0, 1, 1],
          results: [],
          bookmark: null,
          loading: false,
          error: null,
        }
      })
      if (!this.visualSearch.open) {
        this.visualSearch.tasks = tasks
        this.visualSearch.activeTaskId = tasks[0]?.id || null
        this.visualSearch.open = true
      } else {
        if (tasks.length) {
          const firstNewId = tasks[0].id
          this.visualSearch.tasks.push(...tasks)
          this.visualSearch.activeTaskId = firstNewId
        }
      }
    },
    openVisualSearchForSelected() {
      const activePath = this.lightbox?.open && this.lightbox?.path
        ? this.lightbox.path
        : (this.selected?.file_path || this.selectedPath)
      if (this.selectedPaths.length > 0) {
        this.openVisualSearch(this.selectedPaths)
      } else if (activePath) {
        this.openVisualSearch([activePath])
      }
    },
    closeVisualSearch() {
      this.visualSearch.open = false
    },
    pushVisualSearchTask(taskOpts, insertAfterId = null) {
      const fp = taskOpts.filePath || ''
      const normFp = fp ? fp.replace(/\\/g, '/').toLowerCase() : ''
      const existing = normFp ? this.images.find((im) => im.file_path && im.file_path.replace(/\\/g, '/').toLowerCase() === normFp) : null
      let thumb = taskOpts.thumbUrl || taskOpts.dataUrl || ''
      if (!thumb && existing?.thumbnail_path && existing.thumbnail_path !== 'SKIP') {
        thumb = fileUrl(existing.thumbnail_path)
      } else if (!thumb && fp) {
        const ext = fp.slice(fp.lastIndexOf('.')).toLowerCase()
        if (ext === '.psd' || ['.mp4', '.webm', '.mov', '.mkv', '.avi', '.flv', '.f4v'].includes(ext)) {
          thumb = ''
        } else {
          thumb = fileUrl(fp)
        }
      }
      const newTask = {
        id: crypto.randomUUID(),
        name: taskOpts.name || taskOpts.title || (fp ? fp.split(/[\\/]/).pop() : 'query'),
        filePath: fp,
        dataUrl: taskOpts.dataUrl || '',
        thumbUrl: thumb,
        width: taskOpts.width || existing?.width || null,
        height: taskOpts.height || existing?.height || null,
        bbox: [0, 0, 1, 1],
        results: [],
        bookmark: null,
        loading: false,
        error: null,
        scrollTop: 0,
      }
      if (insertAfterId) {
        const idx = this.visualSearch.tasks.findIndex((t) => t.id === insertAfterId)
        if (idx !== -1) {
          this.visualSearch.tasks.splice(idx + 1, 0, newTask)
        } else {
          this.visualSearch.tasks.push(newTask)
        }
      } else {
        this.visualSearch.tasks.push(newTask)
      }
      this.visualSearch.activeTaskId = newTask.id
      this.visualSearch.open = true
      return newTask
    },
    removeVisualSearchTask(taskId) {
      const idx = this.visualSearch.tasks.findIndex((t) => t.id === taskId)
      if (idx === -1) return
      this.visualSearch.tasks.splice(idx, 1)
      if (this.visualSearch.activeTaskId === taskId) {
        if (this.visualSearch.tasks.length > 0) {
          const nextIdx = Math.min(idx, this.visualSearch.tasks.length - 1)
          this.visualSearch.activeTaskId = this.visualSearch.tasks[nextIdx].id
        } else {
          this.visualSearch.activeTaskId = null
        }
      }
    },
    toggleSidebar() {
      this.sidebarCollapsed = !this.sidebarCollapsed
      localStorage.setItem('picnest.sidebarCollapsed', this.sidebarCollapsed ? '1' : '0')
      // 侧栏开合靠自身宽度动画表达，不再叠图标手势（连点时会被感知为发滞）
    },
    toggleInspector() {
      this.viewer.showInspector = !this.viewer.showInspector
    },
    lightboxNav(dir) {
      const list = this.gridOrder?.length ? this.gridOrder : this.filteredImages.map((x) => x.file_path)
      if (!list.length) return
      const i = list.indexOf(this.lightbox.path)
      if (i < 0) return
      const n = (i + dir + list.length) % list.length
      this.lightbox.path = list[n]
      this.selectedPath = this.lightbox.path
      this.selectedPaths = [this.lightbox.path]
      this.selectionAnchor = this.lightbox.path
      this.markOpened(this.lightbox.path)
    },
    openContextMenu(e, image) {
      this.contextMenu = { open: true, x: e.clientX, y: e.clientY, image }
      if (!this.selectionView) this.clearDirSelection()
      if (!this.selectedPaths.includes(image.file_path)) {
        this.selectedPaths = [image.file_path]
        this.selectionAnchor = image.file_path
      }
      this.selectedPath = image.file_path
    },
    openDirMenu(e, node) {
      this.dirMenu = { open: true, x: e.clientX, y: e.clientY, rel: node.rel || '', node }
    },
    closeDirMenu() {
      this.dirMenu = { open: false, x: 0, y: 0, rel: '', node: null }
    },
    closeContextMenu() {
      this.contextMenu = { open: false, x: 0, y: 0, image: null }
    },
    async reveal(path) {
      try { await window.picrand.picnestReveal(path) } catch { /* 静默 */ }
    },
    async rate(path, rating) {
      try { await window.picrand.setImageRating(path, rating) } catch { /* 静默 */ }
      const img = this.images.find((i) => i.file_path === path)
      if (img) img.rating = rating
      this.scheduleRootMetaSave()
    },
    async del(path) {
      /* 丢到回收站 = 应用内软删（deleted_at），文件原地保留 → 进回收站视图可还原。
         曾误接 PicRand delete-image（文件进系统回收站 + DB 行硬删）→ 回收站视图恒空 */
      let removedOk = false
      try {
        const r = await window.picrand.picnestRemove(path)
        removedOk = r !== false && r?.ok !== false
      } catch (e) { this.error = String(e?.message || e) }
      if (removedOk && this.soundFx) playTrashSound()
      this.closeContextMenu()
      if (this.lightbox.open && this.lightbox.path === path) this.closeLightbox()
      if (this.brief.open && this.brief.path === path) this.closeBrief()
      // watcher unlink → sync-db → 统一刷新；这里先本地摘除保证即时反馈
      this.images = this.images.filter((i) => i.file_path !== path)
      this.pruneImageSelection(path)
      if (this.counts) this.counts.trash = (this.counts.trash ?? 0) + 1
    },
    /* 多选批量软删（右键菜单入口）：先确认数量与前几个文件名，再走 trashImages */
    async delSelected() {
      this.closeContextMenu()
      const paths = this.selectedPaths.slice()
      if (!paths.length) return
      if (paths.length === 1) return this.del(paths[0])
      if (this.view === 'trash') return { ok: false, error: '回收站里不能重复删除' }
      const ok = await this.askConfirm({
        title: `移入回收站 ${paths.length} 张图片？`,
        message: '文件会移到图巢回收站，可随时还原；磁盘上的原文件保留。',
        details: [
          ...paths.slice(0, 5).map((p) => p.split(/[\\/]/).pop()),
          ...(paths.length > 5 ? [`…等 ${paths.length} 张`] : []),
        ],
        confirmText: '移入回收站',
        danger: true,
      })
      if (!ok) return
      return this.trashImages(paths)
    },
  },
})
