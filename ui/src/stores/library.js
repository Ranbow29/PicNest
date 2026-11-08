import { defineStore } from 'pinia'
import { deltaE76, deltaE2000, isGrayPalettes } from '../lib/eagleColor'
import { collectiveShake } from '../lib/iconMotion'
import { isTextPath } from '../lib/fileKinds'
import { api } from '../api'

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
    zoom: Number(localStorage.getItem('picnest.zoom')) || 1,          // 顶栏缩放滑条（持久化）
    sortMode: localStorage.getItem('picnest.sortMode') || 'name',    // name|added|mtime|size|dims|rating|random
    sortAsc: localStorage.getItem('picnest.sortAsc') !== '0',
    randomNonce: 0,       // 随机排序的种子换代
    layoutTick: 0,        // 尺寸回填后触发重排
    dimsFilling: false,
    thumbsFilling: false,
    lightbox: { open: false, path: null },
    contextMenu: { open: false, x: 0, y: 0, image: null },
    renaming: false,
    dupDialog: { open: false, items: [], targetRel: undefined, mode: 'files', count: 0, resolve: null },
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
    filters: {
      shapes: [],            // ['landscape','portrait','square','panoramaL','panoramaP','43','34','169','916','custom']
      customW: 4, customH: 3,
      ratings: [],           // [0-5]，0=尚未评分
      formats: [],           // 包含的扩展名（小写）
      formatEx: [],          // 排除的扩展名
      folders: [],           // 包含的子目录 rel
      color: { on: false, gray: false, value: null, accuracy: 20 },
    },
    palettes: {},            // file_path -> [{r,g,b,percent}]
    paletteBuild: { running: false, done: 0, total: 0 },
    colorDist: {},           // file_path -> d76（颜色命中排序用）
    sidebarWidth: Number(localStorage.getItem('picnest.sidebarWidth')) || 236,
    inspectorWidth: Number(localStorage.getItem('picnest.inspectorWidth')) || 296,
    inspectorHeight: Number(localStorage.getItem('picnest.inspectorHeight')) || 0, // 0 = 自适应满高
  }),

  getters: {
    activeRoot: (s) => s.roots.find((r) => r.id === s.activeRootId) || null,
    memoryKey: (s) => (s.activeRootId == null ? '' : `${s.activeRootId}/${s.currentDirRel ?? ''}`),
    canGoBack: (s) => s.navIndex > 0,
    canGoForward: (s) => s.navIndex >= 0 && s.navIndex < s.navHistory.length - 1,
    selected: (s) => s.images.find((i) => i.file_path === s.selectedPath) || null,
    filteredImages(s) {
      let arr = s.applyFilters(s.images)
      const c = s.filters.color
      if ((c.on || c.gray) && c.value && !c.gray) {
        arr = [...arr].sort((a, b) => (s.colorDist[a.file_path] ?? 100) - (s.colorDist[b.file_path] ?? 100))
      }
      return arr
    },
  },

  actions: {
    async init() {
      try {
        // 主进程种子导入是异步的；轮询等根出现
        for (let i = 0; i < 60 && !this.roots.length; i++) {
          this.roots = await api.getAllFolders()
          if (!this.roots.length) await new Promise((r) => setTimeout(r, 1500))
        }
        if (this.roots.length && this.activeRootId == null) {
          /* 记住上次使用的资料库；失效（被移除）则回退第一个 */
          const saved = Number(localStorage.getItem('picnest.activeRootId'))
          this.activeRootId = this.roots.some((r) => r.id === saved) ? saved : this.roots[0].id
          await this.refreshTree()
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
        }
        // 重启后恢复所有根的文件监听 + 后台增量同步（外部变动/录入永远可见）
        for (const r of this.roots) {
          if (!this._watchStarted) this._watchStarted = new Set()
          if (!this._watchStarted.has(r.path)) {
            this._watchStarted.add(r.path)
            api.startWatcher(r.path).catch(() => {})
            api.syncFolderSnapshot(r.path).then(() => { this.refreshTree(); this.loadImages() }).catch(() => {})
          }
        }
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
          if (data?.type === 'add' || data?.type === 'unlink') {
            if (Date.now() < (this.suppressSyncUntil || 0)) return // 内部移动已本地增量处理
            clearTimeout(this._deb)
            this._deb = setTimeout(() => { this.refreshTree(); this.loadImages() }, 600)
          }
        })
        // 色板后台构建/回填（颜色筛选与详情色板共用；此前无调用点=颜色筛选恒空，已修）
        this.ensurePalettes().catch(() => {})
      } catch (e) { this.error = String(e?.message || e) }
    },

    /* 资料库重命名：只改显示名（资料库区编辑入口；物理目录不动） */
    async renameLibrary(id, name) {
      const r = await api.renameLibrary(id, name)
      if (r?.ok) this.roots = this.roots.map((x) => (x.id === id ? { ...x, display_name: name } : x))
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
        await this.refreshTree()
        await this.openDir(null)
      } catch (e) {
        this.error = String(e?.message || e)
      } finally {
        this.scanning = false
        this.scanNote = ''
      }
    },

    async refreshTree() {
      if (this.activeRootId == null) return
      this.tree = await api.dirTree(this.activeRootId)
      this.counts = await window.picrand.picnestViewCounts(this.activeRootId)
      this.dirMemory = await api.dirMemoryGet('') // 全表缓存：树渲染读颜色/展开态零 IPC
    },

    /* 资料库切换：同 id 忽略；全链路键 = activeRootId，tree/counts/images 按 folderId 自动重建 */
    async switchRoot(id, opts = {}) {
      if (this.activeRootId === id) return
      if (this.lightbox.open) this.closeLightbox()
      collectiveShake()
      this.activeRootId = id
      this.currentDirRel = null
      this.view = 'all'
      this.selectionView = false
      this.dirMemory = {}
      this.clearDirSelection()
      this.clearImageSelection()
      localStorage.setItem('picnest.activeRootId', String(id))
      await this.refreshTree()
      await this.loadImages()
      if (opts.record !== false) this.recordNav(this.currentLocation())
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
      if (!list.length) return { ok: false, error: '资料库根不能删除' }
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
      if (!root) return { ok: false, error: '资料库不存在' }
      const tops = this.topLevelDirs(rels)
      const paths = tops.map((rel) => root.path + (rel ? '\\' + rel.split('/').join('\\') : ''))
      if (!paths.length) return { ok: false }
      const hasRoot = tops.includes('')
      this.clipboard = { kind: 'dirs', paths, count: paths.length, root: hasRoot }
      try { window.picrand.copyFilesToClipboard?.(paths) } catch { /* 静默 */ }
      const label = hasRoot
        ? `已复制资料库文件夹「${root.display_name || String(root.path).split(/[\\/]/).pop()}」`
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
      if (!targetDir) return { ok: false, error: '目标资料库不可用' }
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
          title: '复制资料库文件夹',
          message: '将复制整个资料库文件夹（仅图片/视频），可能需要较长时间。继续？',
          details: [
            `源：${clip.paths[0]}`,
            `目标：${targetDir}`,
          ],
          confirmText: '开始复制',
        })
        if (!ok) return { ok: false, canceled: true }
      }
      const agg = { ok: true, copied: 0, skipped: 0, failed: 0, unsupported: 0, replaced: 0, dirs: [], errors: [] }
      try {
        if (clip.kind === 'dirs') {
          for (const src of clip.paths) {
            const r = await this.mergeDirWithDupes(src, targetDir, t)
            if (r?.ok) {
              agg.dirs.push(r)
              agg.copied += r.copied || 0
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
        if (agg.copied > 0 || agg.dirs.length > 0) {
          const rootRec = this.roots.find((x) => x.id === t.rootId)
          if (rootRec) await api.syncFolderSnapshot(rootRec.path).catch(() => {})
          if (t.rootId === this.activeRootId) { await this.refreshTree(); await this.loadImages() }
        }
        const parts = []
        if (agg.copied) parts.push(`粘贴 ${agg.copied} 张`)
        if (agg.dirs.length) parts.push(`文件夹 ${agg.dirs.length} 个`)
        if (agg.skipped) parts.push(`跳过 ${agg.skipped}`)
        if (agg.replaced) parts.push(`替换旧图 ${agg.replaced}`)
        if (agg.failed) parts.push(`失败 ${agg.failed}`)
        let cross = ''
        if (t.rootId !== this.activeRootId) {
          const rec = this.roots.find((x) => x.id === t.rootId)
          const name = rec?.display_name || String(rec?.path || '').split(/[\\/]/).pop()
          cross = name ? ` → ${name}` : ''
        }
        const details = (agg.dirs || []).map((d) => ({ label: d.name, text: `粘贴 ${d.copied}${d.replaced ? ` · 替换 ${d.replaced}` : ''}${d.failed ? ` · 失败 ${d.failed}` : ''}` }))
        if (agg.errors.length) details.push({ label: '错误', text: agg.errors.join('；') })
        this.showNote((parts.length ? parts.join(' · ') : (agg.ok ? '没有可粘贴的内容' : '粘贴失败')) + cross, details, agg.ok ? 'ok' : 'error')
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
      await this.refreshTree()
      await this.loadImages()
      return { ...r, rel: newRel }
    },

    async sortDir(rel, mode) {
      const r = await api.dirSort(rel || '', this.absPathOf(rel), mode)
      if (r?.ok) await this.refreshTree()
      else if (r?.error) this.error = r.error
      return r
    },

    async sortDirRecursive(rel, mode) {
      const r = await api.dirSortRecursive(this.absPathOf(rel), rel || '', mode)
      if (r?.ok) await this.refreshTree()
      else if (r?.error) this.error = r.error
      return r
    },

    async exportDir(rel) {
      const r = await api.exportDir(this.absPathOf(rel))
      return r
    },
    /* 资料库区的绝对路径操作（不依赖当前活动库） */
    async mkdirInLibrary(rootId, name) {
      const root = this.roots.find((r) => r.id === rootId)
      if (!root) return { ok: false, error: '资料库不存在' }
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
    async exportLibrary(rootId) {
      const root = this.roots.find((r) => r.id === rootId)
      if (!root) return { ok: false, error: '资料库不存在' }
      return api.exportDir(root.path)
    },

    /* 文件夹统计（详情面板）：当前库 + 若干 rel，union 去重 */
    async dirStats(rels) {
      try { return await api.dirStats(this.activeRootId, rels) }
      catch (e) { return { ok: false, error: String(e?.message || e) } }
    },

    /* 文件夹记忆（颜色/展开态）：乐观更新本地 + 落 config.json */
    async patchDirMemory(rel, patch) {
      this.dirMemory = { ...this.dirMemory, [rel]: { ...(this.dirMemory[rel] || {}), ...patch } }
      try { await api.dirMemorySet(rel, patch) } catch { /* 静默 */ }
    },
    /* 从正文进入子文件夹：把左侧树的祖先层（含库根）展开，选中行随即可见 */
    async revealDir(rel) {
      if (!rel) return
      if (this.dirMemory['']?.expanded === false) await this.patchDirMemory('', { expanded: true })
      const parts = String(rel).split('/')
      for (let i = 1; i < parts.length; i++) {
        const p = parts.slice(0, i).join('/')
        if (!this.dirMemory[p]?.expanded) await this.patchDirMemory(p, { expanded: true })
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
      // 树上点文件夹 = 离开大图模式和特殊视图，跳进该目录浏览
      if (this.lightbox.open) this.closeLightbox()
      collectiveShake()
      this.selectionView = false
      this.view = 'all'
      localStorage.setItem('picnest.lastView', 'all')
      localStorage.setItem('picnest.lastDirRel', rel || '')
      this.currentDirRel = rel ?? null
      if (rel) await this.revealDir(rel)
      await this.loadImages()
      if (opts.record !== false) this.recordNav(this.currentLocation())
    },

    async switchView(v, opts = {}) {
      if (this.lightbox.open) this.closeLightbox()
      collectiveShake()
      this.clearDirSelection()
      this.selectionView = false
      this.view = v
      localStorage.setItem('picnest.lastView', v)
      if (v !== 'all') localStorage.setItem('picnest.lastDirRel', '')
      this.currentDirRel = null
      this.searchQuery = ''
      await this.loadImages()
      if (opts.record !== false) this.recordNav(this.currentLocation())
    },

    async loadImages() {
      if (this.activeRootId == null) return
      const gen = (this._loadGen = (this._loadGen || 0) + 1)
      this.loading = true
      try {
        let next = []
        if (this.view !== 'trash' && this.trashFolders.length) this.trashFolders = []
        if (this.selectionView && this.selectedDirs.length > 1) {
          /* 多选文件夹 = 合并内容视图（union 去重，全局排序） */
          next = await this.imagesInDirs(this.selectedDirs)
        } else if (this.view === 'recent') {
          next = await api.recent(this.activeRootId, 20000)
        } else if (this.view === 'random') {
          next = await window.picrand.picnestRandom(this.activeRootId, 300)
        } else if (this.view === 'trash') {
          this.trashFolders = await api.trashFolders(this.activeRootId)
          this.counts = await window.picrand.picnestViewCounts(this.activeRootId)
          next = await window.picrand.picnestTrashList(this.activeRootId)
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
          next = await api.imagesByDir(this.activeRootId, this.currentDirRel, 0, 100000, mode, asc, this.showSubfolderContent)
        }
        if (gen !== this._loadGen) return // 快速切换时丢弃过期结果
        this.images = next || []
        this.selectedPath = null
        this.selectedPaths = []
        this.selectionAnchor = null
        this.randomNonce++
        this.fillDimsInBackground()
        this.harvestThumbs().then(() => this.fillAllThumbsInBackground()) // 先收割存量，再单张串行补缺
      } catch (e) {
        if (gen === this._loadGen) this.error = String(e?.message || e)
      } finally {
        if (gen === this._loadGen) this.loading = false
      }
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
        await this.refreshTree()
        await this.loadImages()
        this.showNote(`已清空：文件夹 ${r.purgedFolders} 个 · 图片 ${r.purgedImages} 张`)
      } else this.error = '部分删除失败'
      return r
    },
    openTrashMenu(e) { this.trashMenu = { open: true, x: e.clientX, y: e.clientY } },
    closeTrashMenu() { this.trashMenu = { open: false, x: 0, y: 0 } },

    async restoreFromTrash(path) {
      try { await window.picrand.picnestTrashRestore(path) } catch { /* 静默 */ }
      this.images = this.images.filter((i) => i.file_path !== path)
      this.pruneImageSelection(path)
      await this.refreshTree()
    },

    async purgeFromTrash(path) {
      try { await window.picrand.picnestTrashPurge(path) } catch { /* 静默 */ }
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
      n += (f.color.on || f.color.gray) ? 1 : 0
      return n
    },
    clearFilters() {
      this.filters = { shapes: [], customW: 4, customH: 3, ratings: [], formats: [], formatEx: [], folders: [], color: { on: false, gray: false, value: null, accuracy: 20 } }
      this.colorDist = {}
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
      /* 对齐 Eagle 搜索窗实时版 $scope.colorFilter（用户体感那套，比主进程严格版宽）：
         ① 主色占比 <25% 淘汰 → ② pal[0]/pal[1] 精确相等 → ③ ratio>33 主色 DeltaE 双阈值
         → ④ 白底特例（主色>50 且近白，次色>8 即可参与）→ ⑤ 次色 ratio>33 DeltaE 双阈值 */
      const pal = this.palettes[img.file_path]
      const c = this.filters.color
      if (!pal || !pal.length) return false
      if (c.gray && isGrayPalettes(pal)) return true
      if (!c.value) return false
      const v = c.value
      /* 精确命中任意色板（点图自身色板/吸到同色）——不受占比门槛限制，原图必保 */
      for (const p of pal) {
        if (p.r === v[0] && p.g === v[1] && p.b === v[2]) { this.colorDist[img.file_path] = 0.01; return true }
      }
      const r0 = pal[0]?.percent ?? 0
      if (r0 < 25) return false
      const acc = c.accuracy ?? 20
      const test = (p, extra) => {
        const d2000 = deltaE2000(v, [p.r, p.g, p.b])
        const d76 = deltaE76(v, [p.r, p.g, p.b])
        if (d2000 < acc && d76 < acc + 50) { this.colorDist[img.file_path] = d76 + (extra || 0); return true }
        return false
      }
      if (r0 > 33 && test(pal[0])) return true
      if (r0 > 50 && pal[1] && (pal[1].percent ?? 0) > 8) {
        const white = deltaE2000([255, 255, 255], [pal[0].r, pal[0].g, pal[0].b])
        if (white < 5 && test(pal[1], 5)) return true
      }
      if (pal[1] && (pal[1].percent ?? 0) > 33 && test(pal[1])) return true
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
      if ((f.color.on || f.color.gray)) {
        this.colorDist = {}
        arr = arr.filter((i) => this.colorMatch(i))
      }
      return arr
    },

    // ---- 色板索引：渐进构建（分步防挂起）----
    async ensurePalettes() {
      if (this.paletteBuild.running) return
      this.paletteBuild.running = true
      try {
        for (let i = 0; i < 400; i++) {
          /* 文本没有色板：直接跳过（否则每轮都算一次、白耗 400 轮 IPC） */
          const missing = this.images.filter((x) => !this.palettes[x.file_path] && !isTextPath(x.file_path)).map((x) => x.file_path)
          if (!missing.length) { this.paletteBuild.done = this.paletteBuild.total = this.images.length; break }
          /* DB 真缺（NULL）的才现算；DB 里已有（含 SKIP）的直接回填内存。
             终止不依赖 processed——DB 全量时 build-step 返回 0 会误断循环（曾只剩 40/6673） */
          await window.picrand.picnestBuildPalettesStep(this.activeRootId, 40).catch(() => {})
          const got = await window.picrand.picnestGetPalettes(missing.slice(0, 40))
          Object.assign(this.palettes, got)
          /* 本批没回来的（提取失败 SKIP 等）标空数组，保证单调推进不绕圈 */
          for (const p of missing.slice(0, 40)) if (!this.palettes[p]) this.palettes[p] = []
          this.paletteBuild.done = Object.keys(this.palettes).length
          this.paletteBuild.total = this.images.length
          this.layoutTick++
        }
      } finally { this.paletteBuild.running = false }
    },

    // 缺宽高比的批量回填（自适应布局的原料），分批避免长阻塞
    async fillDimsInBackground() {
      if (this.dimsFilling) return
      this.dimsFilling = true
      try {
        for (let pass = 0; pass < 40; pass++) {
          /* 文本没有宽高（用缩略图 400×520 排版），别让尺寸回填空转 */
          const need = this.images.filter((i) => (!i.width || !i.height) && !isTextPath(i.file_path)).slice(0, 500).map((i) => i.file_path)
          if (!need.length) break
          const got = await api.fillImageDims(need)
          for (const img of this.images) {
            const d = got[img.file_path]
            if (d) { img.width = d.width; img.height = d.height }
          }
          this.layoutTick++ // 触发重排
          await new Promise((r) => setTimeout(r, 30))
        }
      } catch { /* 尺寸回填失败不阻塞 */ } finally {
        this.dimsFilling = false
      }
    },

    // 存量收割：缩略图文件可能已在缓存目录（PicRand md5 寻址），找回登记即可，零生成
    async harvestThumbs() {
      try {
        const missing = this.images.filter((i) => !i.thumbnail_path)
        for (let i = 0; i < missing.length; i += 500) {
          const chunk = missing.slice(i, i + 500)
          const found = await window.picrand.picnestThumbLookup(chunk.map((c) => c.file_path))
          let hit = 0
          for (const img of this.images) {
            const t = found[img.file_path]
            if (t && !img.thumbnail_path) { img.thumbnail_path = t; hit++ }
          }
          this.layoutTick++
          if (!hit && i + 500 < missing.length) continue
        }
      } catch { /* 静默 */ }
    },

    // 后台补缺：单张串行 + 超时兜底（PicRand 子进程管线偶发挂起会卡死信号量，单张只毒自己）
    async fillAllThumbsInBackground() {
      if (this.thumbsFilling) return
      this.thumbsFilling = true
      const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('thumb timeout')), ms))
      try {
        for (let round = 0; round < 8000; round++) {
          const one = this.images.find((i) => !i.thumbnail_path)
          if (!one) break
          try {
            const gen = isTextPath(one.file_path)
              ? api.generateTextThumbnails([one.file_path])
              : api.generateThumbnailsBatch([one.file_path])
            const res = await Promise.race([gen, timeout(20000)])
            const r = (res?.results || [])[0]
            if (r?.thumbnail_path) {
              one.thumbnail_path = r.thumbnail_path
              if (r.width && (!one.width || !one.height)) { one.width = r.width; one.height = r.height }
            } else {
              one.thumbnail_path = 'SKIP' // 生成失败（毒文件/不支持格式）：标记跳过，避免死循环
            }
          } catch { /* 超时：留在队列，下一轮轮到它时再试一次的机会由 SKIP 机制平衡 */ }
          this.layoutTick++
        }
      } finally { this.thumbsFilling = false }
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
        return r
      } catch (e) { return { ok: false, error: String(e?.message || e) } }
    },

    async saveMeta(path, patch) {
      try { await window.picrand.picnestSetImageMeta(path, patch) } catch { /* 静默 */ }
      const img = this.images.find((i) => i.file_path === path)
      if (img) Object.assign(img, patch)
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
        this.suppressWaveUntil = Date.now() + 800
        this.images = this.images.filter((i) => !set.has(i.file_path))
        /* 整批收缩选中（逐项 prune 在大批量下是 O(n·m)，Ctrl+A 之后会卡） */
        this.selectedPaths = this.selectedPaths.filter((p) => !set.has(p))
        if (this.selectionAnchor && set.has(this.selectionAnchor)) this.selectionAnchor = this.selectedPaths[this.selectedPaths.length - 1] || null
        if (this.selectedPath && set.has(this.selectedPath)) this.selectedPath = this.selectedPaths[this.selectedPaths.length - 1] || null
        if (this.lightbox.open && set.has(this.lightbox.path)) this.closeLightbox()
        await this.refreshTree()
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
        } else if (r?.error) {
          this.error = r.error
        }
        return r
      } catch (e) { return { ok: false, error: String(e?.message || e) } }
    },

    setSidebarWidth(w) {
      this.sidebarWidth = Math.min(440, Math.max(180, w))
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
      try {
        const r = await api.imagesReorder(this.activeRootId, this.currentDirRel, rest)
        if (!r?.ok) { if (r?.error) this.error = r.error; return r }
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
      if (r.downloaded) parts.push(`下载 ${r.downloaded} 张`)
      if (r.dirs?.length) parts.push(`文件夹 ${r.dirs.length} 个`)
      if (r.skipped) parts.push(`跳过 ${r.skipped}`)
      if (r.replaced) parts.push(`替换旧图 ${r.replaced}`)
      if (r.unsupported) parts.push(`不支持 ${r.unsupported}`)
      if (r.failed) parts.push(`失败 ${r.failed}`)
      const details = []
      for (const d of r.dirs || []) {
        const bits = []
        if (d.copied) bits.push(`录入 ${d.copied}`)
        if (d.skipped) bits.push(`跳过 ${d.skipped}`)
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
    },
    /* 缝隙落点：把新文件夹名插到指定序号（仅当前资料库可排序——dirOrder 以 rel 为键） */
    async insertOrderAt(parentRel, name, index) {
      await this.refreshTree()
      const node = parentRel ? this.findNode(this.tree?.tree, parentRel) : this.tree?.tree
      const names = (node?.children || []).map((c) => c.name).filter((n) => n !== name)
      const at = index == null ? names.length : Math.max(0, Math.min(index, names.length))
      names.splice(at, 0, name)
      await window.picrand.picnestDirOrderSet(parentRel || '__root__', names)
      await this.refreshTree()
    },

    async importUrls(urls, target) {
      await this.ensureReady()
      const t = this.normTarget(target)
      const targetDir = this.absOfTarget(t)
      try {
        if (!targetDir) {
          const fail = { ok: false, error: '目标资料库不可用' }
          this.reportImport(fail, t)
          return fail
        }
        const r = await window.picrand.picnestImportUrls(urls, targetDir)
        const agg = { ok: !!r?.ok, copied: 0, downloaded: r?.downloaded || 0, skipped: 0, failed: r?.failed || 0, unsupported: 0, dirs: [], errors: [], error: r?.error || '' }
        if (agg.downloaded) {
          const rootRec = this.roots.find((x) => x.id === t.rootId)
          if (rootRec) await api.syncFolderSnapshot(rootRec.path).catch(() => {})
          if (t.rootId === this.activeRootId) { await this.refreshTree(); await this.loadImages() }
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
      try {
        const scan = await window.picrand.picnestDirDupCheck(srcAbs, targetDir, t.rootId)
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
      return window.picrand.picnestImportDirCopy(srcAbs, targetDir, opts)
    },

    // 外部拖入：先全库查重（Eagle 式冲突弹窗），再复制进目标目录
    async importDrop(paths, target) {
      await this.ensureReady()
      const t = this.normTarget(target)
      const targetDir = this.absOfTarget(t)
      try {
        if (!targetDir) {
          const fail = { ok: false, error: '目标资料库不可用' }
          this.reportImport(fail, t)
          return fail
        }
        // Eagle 式：先查重，有冲突先弹对比卡
        const check = await window.picrand.picnestImportCheck(paths, t.rootId)
        let finalPaths = check?.clean || []
        const conflicts = check?.conflicts || []
        const dirs = check?.dirs || []
        let choice = null
        if (conflicts.length) {
          choice = await new Promise((resolve) => {
            this.dupDialog = { open: true, mode: 'files', items: conflicts, count: conflicts.length, targetRel: t.rel || null, resolve }
          })
          if (choice === 'keep-both') finalPaths = finalPaths.concat(conflicts.map((c) => c.path))
        }
        const agg = {
          ok: true, copied: 0, downloaded: 0, skipped: 0, failed: 0, unsupported: 0,
          unsupportedNames: [], dirs: [], errors: [], missing: check?.missing || [],
        }
        if (finalPaths.length) {
          const r = await window.picrand.picnestImportFiles(finalPaths, targetDir)
          if (r?.ok) {
            agg.copied += r.copied || 0
            agg.skipped += r.skipped || 0
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
          if (r?.ok) {
            agg.dirs.push(r)
            agg.copied += r.copied || 0
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
        const touched = agg.copied > 0
        if (touched) {
          const rootRec = this.roots.find((x) => x.id === t.rootId)
          if (rootRec) await api.syncFolderSnapshot(rootRec.path).catch(() => {})
          if (t.rootId === this.activeRootId) { await this.refreshTree(); await this.loadImages() }
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
      const destParent = pos === 'into' ? targetRel : (targetRel.includes('/') ? targetRel.split('/').slice(0, -1).join('/') : '')
      const srcParent = srcRel.includes('/') ? srcRel.split('/').slice(0, -1).join('/') : ''
      const srcName = srcRel.split('/').pop()
      const targetName = targetRel.split('/').pop()

      if (pos === 'into') {
        if (srcRel === targetRel || (targetRel + '/').startsWith(srcRel + '/')) return
        await this.moveDir(srcRel, destParent)
        await this.appendOrder(destParent, srcName)
      } else {
        if (srcRel === targetRel) return
        if (srcParent !== destParent) await this.moveDir(srcRel, destParent)
        await this.refreshTree()
        // 从最新树里取目标父级的现有顺序
        const node = destParent ? this.findNode(this.tree?.tree, destParent) : this.tree?.tree
        const names = (node?.children || []).map((c) => c.name).filter((n) => n !== srcName)
        const at = names.indexOf(targetName)
        names.splice(at < 0 ? names.length : at + (pos === 'after' ? 1 : 0), 0, srcName)
        await window.picrand.picnestDirOrderSet(destParent || '__root__', names)
        await this.refreshTree()
      }
    },

    /* 多选文件夹拖拽：整组移动（跳过根、自身、后代；父子同时选中只搬父级） */
    async dropOnDirs(srcRels, targetRel, pos) {
      const destParent = pos === 'into' ? targetRel : (targetRel.includes('/') ? targetRel.split('/').slice(0, -1).join('/') : '')
      const rels = this.topLevelDirs(srcRels).filter((r) => r !== '') // 父子同选只搬父级
      const valid = rels.filter((r) => r !== destParent && !(destParent && (destParent + '/').startsWith(r + '/')))
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
      const names = (node?.children || []).map((c) => c.name)
        .filter((n) => n !== targetName && !movedNames.includes(n))
      const at = names.indexOf(targetName)
      names.splice(at < 0 ? names.length : at + (pos === 'after' ? 1 : 0), 0, ...movedNames)
      await window.picrand.picnestDirOrderSet(destParent || '__root__', names)
      await this.refreshTree()
      return { ok: true, moved: movedNames.length }
    },

    async appendOrder(parentRel, name) {
      await this.refreshTree()
      const node = parentRel ? this.findNode(this.tree?.tree, parentRel) : this.tree?.tree
      const names = (node?.children || []).map((c) => c.name).filter((n) => n !== name)
      names.push(name)
      await window.picrand.picnestDirOrderSet(parentRel || '__root__', names)
      await this.refreshTree()
    },

    findNode(root, rel) {
      if (!root) return null
      if (root.rel === rel) return root
      for (const c of root.children || []) {
        const hit = this.findNode(c, rel)
        if (hit) return hit
      }
      return null
    },

    /* 图片多选：单击=单选；Shift=按当前可见顺序范围选；Alt/Ctrl=加选/减选（可与 Shift 叠加） */
    selectImage(path, opts = {}) {
      const shift = !!opts.shift
      const add = !!opts.add
      const list = this.filteredImages.map((i) => i.file_path)
      if (!this.selectionView) this.clearDirSelection()
      if (shift && this.selectionAnchor != null) {
        const a = list.indexOf(this.selectionAnchor)
        const b = list.indexOf(path)
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a]
          const range = list.slice(lo, hi + 1)
          this.selectedPaths = add ? [...new Set([...this.selectedPaths, ...range])] : range
          this.selectedPath = path
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
        return
      }
      this.selectedPaths = [path]
      this.selectedPath = path
      this.selectionAnchor = path
    },
    clearImageSelection() {
      this.selectedPath = null
      this.selectedPaths = []
      this.selectionAnchor = null
    },
    /* Ctrl+A：选中当前可见（筛选后）全部图片 */
    selectAllImages() {
      if (!this.images.length) return 0
      const list = this.filteredImages.map((i) => i.file_path)
      this.selectedPaths = list
      this.selectedPath = list[list.length - 1] || null
      this.selectionAnchor = list[0] || null
      if (!this.selectionView) this.clearDirSelection()
      return list.length
    },
    /* 框选：拖拽过程中直接写入选中集；add=保留按下前的底集（Shift 加选） */
    setImageSelection(paths, opts = {}) {
      if (!this.selectionView) this.clearDirSelection()
      const list = [...new Set((paths || []).filter(Boolean))]
      this.selectedPaths = opts.add ? [...new Set([...(opts.base || []), ...list])] : list
      this.selectionAnchor = this.selectedPaths[this.selectedPaths.length - 1] || null
      this.selectedPath = this.selectedPaths[this.selectedPaths.length - 1] || null
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
    openLightbox(path) {
      if (path) this.selectedPath = path
      if (this.selectedPath) {
        this.selectedPaths = [this.selectedPath]
        this.selectionAnchor = this.selectedPath
      }
      if (!this.selectionView) this.clearDirSelection()
      this.lightbox = { open: true, path: path || this.selectedPath }
      if (this.lightbox.path) this.markOpened(this.lightbox.path)
      this.viewer.rot = 0; this.viewer.flopX = false
      this.viewer.cropMode = false
      this.viewer.fitNonce++
      collectiveShake() // 进入大图：全体图标同步手势（与退出对称）
    },
    closeLightbox() {
      this.lightbox = { open: false, path: null }
      this.viewer.cropMode = false
      collectiveShake()
    },
    toggleInspector() {
      this.viewer.showInspector = !this.viewer.showInspector
      collectiveShake() // 详情展开/褪去 → 集体晃动
    },
    lightboxNav(dir) {
      const i = this.images.findIndex((x) => x.file_path === this.lightbox.path)
      if (i < 0) return
      const n = (i + dir + this.images.length) % this.images.length
      this.lightbox.path = this.images[n].file_path
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
    },
    async del(path) {
      /* 丢到回收站 = 应用内软删（deleted_at），文件原地保留 → 进回收站视图可还原。
         曾误接 PicRand delete-image（文件进系统回收站 + DB 行硬删）→ 回收站视图恒空 */
      try { await window.picrand.picnestRemove(path) } catch (e) { this.error = String(e?.message || e) }
      this.closeContextMenu()
      if (this.lightbox.open && this.lightbox.path === path) this.closeLightbox()
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
