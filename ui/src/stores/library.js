import { defineStore } from 'pinia'
import { deltaE76, deltaE2000, isGrayPalettes } from '../lib/eagleColor'
import { collectiveShake } from '../lib/iconMotion'
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
    searchQuery: '',
    currentDirRel: null,  // null=全部；''=根层；'a/b'=子目录
    images: [],
    loading: false,
    scanning: false,
    scanNote: '',
    error: '',
    selectedPath: null,
    hoverLabels: true,    // 网格悬停显字（M5 视图选项可关）
    layout: 'grid',       // grid | justified（M5 视图选项扩展瀑布流/列表）
    zoom: 1,              // 顶栏缩放滑条：网格=格子大小，自适应=目标行高
    sortMode: localStorage.getItem('picnest.sortMode') || 'name',    // name|added|mtime|size|dims|rating|random
    sortAsc: localStorage.getItem('picnest.sortAsc') !== '0',
    randomNonce: 0,       // 随机排序的种子换代
    layoutTick: 0,        // 尺寸回填后触发重排
    dimsFilling: false,
    thumbsFilling: false,
    lightbox: { open: false, path: null },
    contextMenu: { open: false, x: 0, y: 0, image: null },
    renaming: false,
    dupDialog: { open: false, items: [], targetRel: undefined, resolve: null },
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
  }),

  getters: {
    activeRoot: (s) => s.roots.find((r) => r.id === s.activeRootId) || null,
    memoryKey: (s) => (s.activeRootId == null ? '' : `${s.activeRootId}/${s.currentDirRel ?? ''}`),
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
          await this.openDir(null)
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
            clearTimeout(this._deb)
            this._deb = setTimeout(() => { this.refreshTree(); this.loadImages() }, 600)
          }
        })
        // 色板后台构建/回填（颜色筛选与详情色板共用；此前无调用点=颜色筛选恒空，已修）
        this.ensurePalettes().catch(() => {})
      } catch (e) { this.error = String(e?.message || e) }
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
    async switchRoot(id) {
      if (this.activeRootId === id) return
      if (this.lightbox.open) this.closeLightbox()
      collectiveShake()
      this.activeRootId = id
      this.currentDirRel = null
      this.view = 'all'
      this.dirMemory = {}
      localStorage.setItem('picnest.activeRootId', String(id))
      await this.refreshTree()
      await this.loadImages()
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

    /* 文件夹记忆（颜色/展开态）：乐观更新本地 + 落 config.json */
    async patchDirMemory(rel, patch) {
      this.dirMemory = { ...this.dirMemory, [rel]: { ...(this.dirMemory[rel] || {}), ...patch } }
      try { await api.dirMemorySet(rel, patch) } catch { /* 静默 */ }
    },

    async openDir(rel) {
      // 树上点文件夹 = 离开大图模式和特殊视图，跳进该目录浏览
      if (this.lightbox.open) this.closeLightbox()
      collectiveShake()
      this.view = 'all'
      this.currentDirRel = rel ?? null
      await this.loadImages()
    },

    async switchView(v) {
      if (this.lightbox.open) this.closeLightbox()
      collectiveShake()
      this.view = v
      this.currentDirRel = null
      this.searchQuery = ''
      await this.loadImages()
    },

    async loadImages() {
      if (this.activeRootId == null) return
      this.loading = true
      try {
        if (this.view === 'recent') {
          this.images = await api.recent(this.activeRootId, 20000)
        } else if (this.view === 'random') {
          this.images = await window.picrand.picnestRandom(this.activeRootId, 300)
        } else if (this.view === 'trash') {
          this.images = await window.picrand.picnestTrashList(this.activeRootId)
        } else if (this.view === 'uncategorized') {
          /* 未分类 = 库根层散图（不在任何子文件夹），排序面板可用 */
          this.images = await api.imagesByDir(this.activeRootId, '__loose__', 0, 100000, this.sortMode, this.sortAsc)
        } else if (this.view === 'search') {
          this.images = this.searchQuery ? await window.picrand.picnestSearch(this.activeRootId, this.searchQuery, 300) : []
        } else {
          /* 全部 = 最新入库流（新图置顶，与文件夹视图彻底分开；忽略升降序开关锁死最新在前）
             文件夹 = 排序器正常排序（sortMode + sortAsc 全生效） */
          const inAll = this.view === 'all' && !this.currentDirRel
          this.images = await api.imagesByDir(this.activeRootId, this.currentDirRel, 0, 100000, inAll ? 'added' : this.sortMode, inAll ? false : this.sortAsc)
        }
        this.selectedPath = null
        this.randomNonce++
        this.fillDimsInBackground()
        this.harvestThumbs().then(() => this.fillAllThumbsInBackground()) // 先收割存量，再单张串行补缺
      } catch (e) {
        this.error = String(e?.message || e)
      } finally {
        this.loading = false
      }
    },

    async doSearch(q) {
      this.view = 'search'
      this.searchQuery = q
      await this.loadImages()
    },

    async rerollRandom() {
      await this.loadImages()
    },

    async restoreFromTrash(path) {
      try { await window.picrand.picnestTrashRestore(path) } catch { /* 静默 */ }
      this.images = this.images.filter((i) => i.file_path !== path)
      await this.refreshTree()
    },

    async purgeFromTrash(path) {
      try { await window.picrand.picnestTrashPurge(path) } catch { /* 静默 */ }
      this.images = this.images.filter((i) => i.file_path !== path)
      await this.refreshTree()
    },

    resolveDupDialog(choice) {
      if (this.dupDialog.resolve) this.dupDialog.resolve(choice)
      this.dupDialog = { open: false, items: [], targetRel: undefined, resolve: null }
    },

    async removeFromLibrary(path) {
      /* 从库中移除 = 只摘索引（DB 行删除），文件原地保留——曾误接软删（会进回收站视图） */
      try { await window.picrand.dbDeleteImage(path) } catch { /* 静默 */ }
      this.images = this.images.filter((i) => i.file_path !== path)
      if (this.selectedPath === path) this.selectedPath = null
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
          const missing = this.images.filter((x) => !this.palettes[x.file_path]).map((x) => x.file_path)
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
          const need = this.images.filter((i) => !i.width || !i.height).slice(0, 500).map((i) => i.file_path)
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
            const res = await Promise.race([api.generateThumbnailsBatch([one.file_path]), timeout(20000)])
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
      try {
        const r = await window.picrand.picnestMoveImage(filePath, targetDir)
        if (r?.ok) {
          this.images = this.images.filter((i) => i.file_path !== filePath)
          if (this.selectedPath === filePath) this.selectedPath = null
          this.refreshTree()
        }
        return r
      } catch (e) { return { ok: false, error: String(e?.message || e) } }
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
          // 当前目录若在被移走的子树里，修正到新路径
          const srcPrefix = srcRel + '/'
          const fix = (rel) => (rel === srcRel || rel?.startsWith(srcPrefix)
            ? (dstRel ? dstRel + '/' + rel.slice(srcPrefix.length) : rel.slice(srcPrefix.length))
            : rel)
          this.currentDirRel = fix(this.currentDirRel)
          if (dstRel === this.currentDirRel || (this.currentDirRel || '').startsWith(dstRel + '/')) this.currentDirRel = dstRel || null
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

    setSort(mode, asc) {
      if (mode !== undefined) this.sortMode = mode
      if (asc !== undefined) this.sortAsc = asc
      if (this.sortMode === 'random') this.randomNonce++
      localStorage.setItem('picnest.sortMode', this.sortMode)
      localStorage.setItem('picnest.sortAsc', this.sortAsc ? '1' : '0')
      /* 文件夹视图排序实时生效（SQL 排序需重查）；全部视图固定最新置顶，不受排序影响 */
      if (this.currentDirRel) this.loadImages()
    },

    async importUrls(urls, targetRel) {
      await this.ensureReady()
      const rel = targetRel !== undefined ? targetRel : (this.view === 'all' ? this.currentDirRel : null)
      const targetDir = this.tree.rootPath + (rel ? '\\' + rel.split('/').join('\\') : '')
      try {
        const r = await window.picrand.picnestImportUrls(urls, targetDir)
        if (r?.ok && r.downloaded) setTimeout(() => { this.refreshTree(); this.loadImages() }, 600)
        return r
      } catch (e) { return { ok: false, error: String(e?.message || e) } }
    },

    // 外部拖入：文件复制进目标目录（watcher 自动入库），目录返回待登记
    // 就绪守卫：init 是异步轮询，启动头两秒 tree 可能为空
    async ensureReady() {
      for (let i = 0; i < 40 && (!this.tree || !this.roots.length); i++) {
        await new Promise((r) => setTimeout(r, 250))
      }
      if (!this.tree && this.activeRootId != null) await this.refreshTree()
    },

    // 外部拖入：先全库查重（Eagle 式冲突弹窗），再复制进目标目录
    async importDrop(paths, targetRel) {
      await this.ensureReady()
      const rel = targetRel !== undefined ? targetRel : (this.view === 'all' ? this.currentDirRel : null)
      const targetDir = this.tree.rootPath + (rel ? '\\' + rel.split('/').join('\\') : '')
      try {
        // Eagle 式：先查重，有冲突先弹对比卡
        const check = await window.picrand.picnestImportCheck(paths, this.activeRootId)
        let finalPaths = check?.clean || paths
        const conflicts = check?.conflicts || []
        let choice = null
        if (conflicts.length) {
          choice = await new Promise((resolve) => {
            this.dupDialog = { open: true, items: conflicts, targetRel: rel, resolve }
          })
          if (choice === 'use-existing') {
            finalPaths = finalPaths // 冲突文件不复制，库里已有
          } else if (choice === 'keep-both') {
            finalPaths = finalPaths.concat(conflicts.map((c) => c.path))
          }
        }
        if (!finalPaths.length) {
          await this.refreshTree()
          return { ok: true, copied: 0, skipped: conflicts.length, dirs: [] }
        }
        const r = await window.picrand.picnestImportFiles(finalPaths, targetDir)
        if (r?.ok) {
          if (conflicts.length && choice === 'use-existing') r.skipped = (r.skipped || 0) + conflicts.length
          for (const d of r.dirs || []) await this.addRootByPath(d) // 拖进来的是文件夹 → 登记为新根
          // 一律增量扫描入库（跳过重复时盘上可能仍有未索引文件；watcher 只管后续外部变动）
          {
            const rootPath = this.tree.rootPath
            await api.syncFolderSnapshot(rootPath).catch(() => {})
            await this.refreshTree()
            await this.loadImages()
          }
        }
        return r
      } catch (e) { return { ok: false, error: String(e?.message || e) } }
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

    select(path) {
      this.selectedPath = path
    },

    async markOpened(filePath) {
      try { await api.imageOpened(filePath) } catch { /* 静默 */ }
    },

    /* ---- M3: 灯箱 / 右键菜单 / 详情操作 ---- */
    openLightbox(path) {
      if (path) this.selectedPath = path
      this.lightbox = { open: true, path: path || this.selectedPath }
      if (this.lightbox.path) this.markOpened(this.lightbox.path)
      this.viewer.rot = 0; this.viewer.flopX = false
      this.viewer.cropMode = false
      this.viewer.fitNonce++
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
      this.markOpened(this.lightbox.path)
    },
    openContextMenu(e, image) {
      this.contextMenu = { open: true, x: e.clientX, y: e.clientY, image }
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
      if (this.selectedPath === path) this.selectedPath = null
      if (this.counts) this.counts.trash = (this.counts.trash ?? 0) + 1
    },
  },
})
