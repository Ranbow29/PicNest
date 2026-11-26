import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen as tauriListen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { ref } from 'vue'
import { pluginUnsupported } from './lib/plugins'

const EAGLE_UNSUPPORTED_ERROR = '当前版本暂不支持导入 Eagle 库 (.library)，请选择普通图片文件夹'
const THUMB_REPAIR_UNSUPPORTED_ERROR = '当前 Tauri 运行时暂不支持批量修复缩略图，请使用单文件预览重新生成缓存'
const unsupported = (error) => ({ ok: false, unsupported: true, error })

const isTauri = () => typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
const _mediaPort = ref(0)
const _mediaNonce = ref('')
let _apiPort = 0
const portsReady = typeof window !== 'undefined' && isTauri()
  ? Promise.all([
      tauriInvoke('get_media_port').then((access) => {
        if (access?.port) _mediaPort.value = access.port
        if (access?.nonce) _mediaNonce.value = access.nonce
      }).catch(() => {}),
      tauriInvoke('get_api_port')
        .then((port) => { if (port) _apiPort = port })
        .catch(() => {})
    ])
  : Promise.resolve()
/* 图库取数序号：每次 imagesByDir 自增，后端据此放弃已被顶掉的旧请求 */
let _imgSeq = 0
const nextImgSeq = () => ++_imgSeq

/* 并发闸门：WebView 对同一 origin 只有 6 条连接。缩略图生成/色板构建这种
   秒级命令一旦并发铺开，导航查询就得排队——实测 images_by_dir 后端 12ms，
   却被排到 1.3 秒才回来。长命令限并发，把连接留给交互。 */
const makeGate = (limit) => {
  let running = 0
  const queue = []
  return async (fn) => {
    if (running >= limit) await new Promise((r) => queue.push(r))
    running++
    try { return await fn() } finally {
      running--
      const next = queue.shift()
      if (next) next()
    }
  }
}
const thumbGate = makeGate(1)
const paletteGate = makeGate(1)
const dimsGate = makeGate(1)

// 注入全局兜底防崩与无缝桥接代理
if (typeof window !== 'undefined' && isTauri()) {
  const sendDiag = (msg) => { try { tauriInvoke('diag_event', { msg: String(msg) }).catch(() => {}) } catch {} }
  window.addEventListener('error', (ev) => sendDiag(`window.error: ${ev?.message || ev} @ ${ev?.filename || ''}:${ev?.lineno || 0}`))
  window.addEventListener('unhandledrejection', (ev) => sendDiag(`unhandledrejection: ${ev?.reason?.message || ev?.reason || 'unknown'}`))

  // Tauri 无边框窗口拖动接管：替代 Electron 的 CSS -webkit-app-region: drag
  window.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return
    if (document.body?.classList?.contains('picnest-dragging-out')) return
    const target = ev.target
    if (!target || typeof target.closest !== 'function') return
    const dragRoot = target.closest('.titlebar .bar-content, .sidebar .brand')
    if (!dragRoot) return
    if (target.closest('button, a, input, textarea, select, option, label, [role="button"], [contenteditable="true"], [data-no-drag], .no-drag, .vo-wrap, .zoom-slider, .search, .bar-controls, .win-btn')) return
    let cur = target
    while (cur && cur !== document.body) {
      try {
        const st = window.getComputedStyle(cur)
        const ar = st.getPropertyValue('app-region') || st.getPropertyValue('-webkit-app-region') || st.webkitAppRegion || ''
        if (String(ar).trim() === 'no-drag') return
      } catch {}
      if (cur === dragRoot) break
      cur = cur.parentElement
    }
    const win = getCurrentWindow()
    if (ev.detail >= 2) {
      ev.preventDefault()
      win.toggleMaximize().catch(() => {})
      return
    }
    win.startDragging().catch(() => {})
  })
  const safeInvoke = async (cmd, args = {}) => {
    try {
      return await tauriInvoke(cmd, args)
    } catch (e) {
      console.warn(`[PicNest-Rust] ${cmd} 调用失败:`, e)
      return null
    }
  }

  const subscribe = (event, cb) => {
    if (typeof cb !== 'function') return () => {}
    let unlisten = null
    let cancelled = false
    tauriListen(event, (ev) => cb(ev?.payload || {})).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    }).catch(() => {})
    return () => { cancelled = true; if (unlisten) unlisten() }
  }

  window.picrand = new Proxy({
    diagEvent: async (msg) => await safeInvoke('diag_event', { msg: String(msg) }),
    selectFolders: async () => await safeInvoke('select_folders'),
    picnestViewCounts: async (folderId) => (await safeInvoke('view_counts', { folderId })) || { all: 0, recent: 0, trash: 0, uncategorized: 0 },
    syncFolderSnapshot: async (path) => await safeInvoke('sync_folder_snapshot', { path }),
    syncDirSnapshot: async (folderId, dirPath) => await safeInvoke('sync_dir_snapshot', { folderId, dirPath }),
    startWatcher: async () => ({ ok: true }),
    picnestRootMetaLoad: async (rootId) => await safeInvoke('root_meta_load', { rootId }),
    picnestRootMetaSave: async (rootId) => await safeInvoke('root_meta_save', { rootId }),
    picnestRootMetaEnsure: async (rootId) => await safeInvoke('root_meta_ensure', { rootId }),
    picnestDirMemoryGet: async (key) => await safeInvoke('dir_memory_get', { key: key ?? null }),
    picnestDirMemoryRootGet: async (rootId) => (await safeInvoke('dir_memory_root_get', { rootId })) || {},
    picnestDirMemorySet: async (rootId, rel, patch) => await safeInvoke('dir_memory_set', { rootId, rel, patch }),
    picnestThumbsMissing: async (folderId) => {
      const result = await safeInvoke('thumbs_missing', { folderId })
      if (result?.ok && Number.isFinite(Number(result.count))) return { ok: true, count: Math.max(0, Math.trunc(Number(result.count))) }
      // 调用方把 count=0 当作“无需修复”；检测失败必须走明确的修复失败分支。
      return { ok: false, count: 1, error: result?.error || '无法检查缺失缩略图' }
    },
    picnestRepairThumbs: async () => unsupported(THUMB_REPAIR_UNSUPPORTED_ERROR),
    picnestRepairThumbsCancel: async () => unsupported(THUMB_REPAIR_UNSUPPORTED_ERROR),
    generateThumbnailsBatch: async (paths) => thumbGate(async () => (await safeInvoke('generate_thumbnails_batch', { paths })) || { results: [] }),
    picnestDisplayThumbs: async (paths) => (await safeInvoke('generate_display_thumbs_batch', { paths })) || { results: [] },
    picnestTrashFolders: async (folderId) => (await safeInvoke('trash_folders', { folderId })) || [],
    picnestTrashList: async (folderId) => (await safeInvoke('trash_list', { folderId })) || [],
    picnestRemove: async (filePath) => !!(await safeInvoke('trash_remove_image', { filePath })),
    picnestTrashRestore: async (filePath) => !!(await safeInvoke('trash_restore_image', { filePath })),
    picnestTrashPurge: async (filePath) => !!(await safeInvoke('trash_purge_image', { filePath })),
    picnestDeleteDir: (dirPath, rel, rootId) => tauriInvoke('delete_dir', { dirPath, rel, rootId }),
    picnestTrashRestoreFolder: (id) => tauriInvoke('trash_restore_folder', { id }),
    picnestTrashPurgeFolder: (id) => tauriInvoke('trash_purge_folder', { id }),
    picnestTrashRestoreAll: (folderId) => tauriInvoke('trash_restore_all', { folderId }),
    picnestTrashPurgeAll: (folderId) => tauriInvoke('trash_purge_all', { folderId }),
    picnestVisualSearchQuery: async (opts) => await safeInvoke('visual_search_query', { opts }),
    picnestVisualSearchSave: async (item) => await safeInvoke('visual_search_save', { item }),
    /* 查重相关的调用不能用 safeInvoke：它把错误吞成 null，
       界面只能显示“未知错误 / 扫描失败”，查不动。这里把真实错误带回来。 */
    picnestFindDuplicates: async (folderId, rel) => {
      try {
        return await tauriInvoke('find_duplicates', { folder_id: folderId, folderId, rel: rel ?? null })
      } catch (e) {
        return { ok: false, error: String(e?.message || e) }
      }
    },
    picnestAiTest: async () => {
      try {
        return await tauriInvoke('ai_test')
      } catch (e) {
        return { ok: false, error: String(e?.message || e) }
      }
    },
    picnestAiDupScan: async (rootId, rel, maxPairs) => {
      try {
        return await tauriInvoke('ai_dup_scan', {
          rootId, rel: rel ?? null, maxPairs: maxPairs ?? 40,
        })
      } catch (e) {
        return { ok: false, error: String(e?.message || e) }
      }
    },
    picnestAiDupContinue: async (rootId, rel, maxPairs) => {
      try {
        return await tauriInvoke('ai_dup_continue', {
          rootId, rel: rel ?? null, maxPairs: maxPairs ?? 40,
        })
      } catch (e) {
        return { ok: false, error: String(e?.message || e) }
      }
    },
    /* 清理缩略图缓存里的孤儿文件（图已删、缩略图还在）。限流调用 */
    cleanupOrphanThumbs: async (limit = 400) => {
      try { return await tauriInvoke('cleanup_orphan_thumbs', { limit }) }
      catch (e) { return { ok: false, error: String(e?.message || e) } }
    },
    picnestDupCancel: async () => await safeInvoke('dup_cancel'),
    picnestAiDupCancel: async () => await safeInvoke('ai_dup_cancel'),
    onPicnestAiDupProgress: (cb) => {      let cancelled = false
      let unlisten = null
      tauriListen('picnest-ai-dup-progress', (ev) => cb(ev?.payload || {})).then((fn) => { unlisten = fn; if (cancelled) fn() })
      return () => { cancelled = true; if (unlisten) unlisten() }
    },
    /* 自动更新：下载进度（received/speed）与安装阶段（stage/text），绑到 UpdateDialog */
    onPicnestUpdateProgress: (cb) => {
      let cancelled = false
      let unlisten = null
      tauriListen('picnest-update-progress', (ev) => cb(ev?.payload || {})).then((fn) => { unlisten = fn; if (cancelled) fn() })
      return () => { cancelled = true; if (unlisten) unlisten() }
    },
    onPicnestUpdateStatus: (cb) => {
      let cancelled = false
      let unlisten = null
      tauriListen('picnest-update-status', (ev) => cb(ev?.payload || {})).then((fn) => { unlisten = fn; if (cancelled) fn() })
      return () => { cancelled = true; if (unlisten) unlisten() }
    },
    picnestAiConfigGet: async () => await safeInvoke('ai_config_get'),
    picnestAiConfigSet: async (opts) => {
      try { return await tauriInvoke('ai_config_set', { opts }) }
      catch (e) { return { ok: false, error: String(e?.message || e) } }
    },
    picnestAiModels: async (opts) => {
      try { return await tauriInvoke('ai_models', { opts }) }
      catch (e) { return { ok: false, error: String(e?.message || e) } }
    },
    picnestTagsList: async (folderId) => (await safeInvoke('tags_list', { folderId })) || { ok: true, tags: [], imageTags: {} },
    picnestTagAssign: async (opts) => (await safeInvoke('tag_assign', {
      imageIds: opts?.imageIds || [],
      name: opts?.name ?? null,
      tagId: opts?.tagId ?? null,
      action: opts?.action || 'add',
    })) || { ok: false },
    picnestTagRename: async (opts) => (await safeInvoke('tag_rename', {
      tagId: opts?.tagId || 0,
      name: opts?.name || '',
    })) || { ok: false },
    picnestTagDelete: async (tagId) => (await safeInvoke('tag_delete', { tagId })) || { ok: false },
    setImageRating: async (filePath, rating) => await safeInvoke('set_image_rating', { filePath, rating }),
    dbDeleteImage: async (filePath) => await safeInvoke('db_delete_image', { filePath }),
    picnestReveal: async (filePath) => await safeInvoke('picnest_reveal', { filePath }),
    picnestSearch: async (folderId, query, limit) => (await safeInvoke('picnest_search', { folderId, query, limit })) || [],
    picnestRandom: async (folderId, limit) => (await safeInvoke('picnest_random', { folderId, limit })) || [],
    picnestDirOrderGet: () => tauriInvoke('dir_order_get'),
    picnestDirOrderSet: (folderId, parentKey, names) => tauriInvoke('dir_order_set', { folderId, parentKey, names }),
    picnestMoveImage: (filePath, targetDir) => tauriInvoke('move_image', { filePath, targetDir }),
    picnestMoveDir: (dirPath, targetDir) => tauriInvoke('move_dir', { dirPath, targetDir }),
    picnestPhysicalOrderImages: () => null,
    picnestPhysicalOrderDirs: () => null,
    picnestStripOrderPrefixes: () => null,
    /* 手动触发版：把当前顺序写进文件名（先 dryRun 预览，再执行）。 */
    picnestWriteOrderToFilenames: (folderId, dirRel, orderedPaths, dryRun) =>
      tauriInvoke('write_order_to_filenames', { folderId, dirRel, orderedPaths, dryRun }),
    /* 库 → 磁盘：整个文件夹（含子文件夹）的图片顺序 → 文件名前缀 */
    picnestSyncFolderToDisk: (folderId, dirRel, dryRun) =>
      tauriInvoke('sync_folder_to_disk', { folderId, dirRel, dryRun }),
    picnestRenameImage: (filePath, newName) => tauriInvoke('rename_image', { filePath, newName }),
    picnestRenameDir: (oldPath, newName, oldRel, parentRel) => tauriInvoke('rename_dir', { oldPath, newName, oldRel, parentRel }),
    picnestRenameLibrary: (id, name, opts) => tauriInvoke('rename_library', { id, name, opts }),
    picnestGetImageMeta: async (filePath) => (await safeInvoke('get_image_meta', { filePath })) || { annotation: '', url: '' },
    picnestSetImageMeta: (filePath, patch) => tauriInvoke('set_image_meta', { filePath, patch }),
    computeColorAnalysis: async (filePath) => (await safeInvoke('compute_color_analysis', { filePath })) || { dominantColors: [] },
    picnestBuildPalettesStep: async (folderId, limit) => paletteGate(async () => (await safeInvoke('build_palettes_step', { folderId, limit })) || { ok: true, processed: 0 }),
    picnestGetPalettes: async (paths) => (await safeInvoke('get_palettes', { paths })) || {},
    picnestVideoCompat: async (filePath) => await safeInvoke('video_compat', { filePath }),
    picnestVideoPreview: async (filePath) => {
      const result = await safeInvoke('video_preview', { filePath })
      return result || { ok: false, error: '视频预览调用失败' }
    },
    picnestSetAlwaysOnTop: async (flag) => !!(await safeInvoke('set_always_on_top', { flag: !!flag })),
    picnestEagleInspect: async (path) => {
      const result = await safeInvoke('eagle_inspect', { path })
      // SideBar 在 null/异常时会继续扫描；检测故障必须 fail-closed。
      if (typeof result?.eagle === 'boolean' && typeof result?.ok === 'boolean') return result
      return { eagle: true, ok: false, error: 'Eagle 库检测失败，已停止按普通文件夹扫描' }
    },
    picnestEagleCopy: async () => unsupported(EAGLE_UNSUPPORTED_ERROR),
    picnestEagleFinish: async () => unsupported(EAGLE_UNSUPPORTED_ERROR),
    picnestEagleCancel: async () => unsupported(EAGLE_UNSUPPORTED_ERROR),
    picnestPluginsList: async () => pluginUnsupported(),
    picnestPluginThemeCss: async () => pluginUnsupported(),
    picnestPluginSetEnabled: async () => pluginUnsupported(),
    picnestPluginPickFolder: async () => pluginUnsupported(),
    picnestPluginInstallFolder: async () => pluginUnsupported(),
    picnestPluginUninstall: async () => pluginUnsupported(),
    picnestPluginRegistryFetch: async () => pluginUnsupported(),
    picnestPluginInstallRegistry: async () => pluginUnsupported(),
    picnestPluginEntryHtml: async () => pluginUnsupported(),
    picnestPluginQueryImages: async () => pluginUnsupported(),
    picnestPluginStorageGet: async () => pluginUnsupported(),
    picnestPluginStorageSet: async () => pluginUnsupported(),
    picnestPluginFetch: async () => pluginUnsupported(),
    picnestRemoveRoot: (folderId) => tauriInvoke('remove_root', { folderId }),
    picnestApplyTransform: (filePath, opts) => tauriInvoke('apply_transform', { filePath, opts }),
    picnestCrop: (filePath, opts) => tauriInvoke('crop_image', { filePath, opts }),
    picnestCropAs: (filePath, opts) => tauriInvoke('crop_image_as', { filePath, opts }),
    copyFilesToClipboard: (paths) => tauriInvoke('copy_files_to_clipboard', { paths: paths || [] }),
    picnestCopyImages: (paths, targetDir) => tauriInvoke('copy_images', { paths: paths || [], targetDir }),
    picnestImagesReorder: (folderId, dirRel, orderedPaths) => tauriInvoke('images_reorder', { folderId, dirRel: dirRel ?? '', orderedPaths }),
    picnestPsdPreview: (filePath) => tauriInvoke('psd_preview', { filePath }),
    picnestViewPreview: (filePath) => tauriInvoke('view_preview', { filePath }),
    fillImageDims: (paths) => tauriInvoke('fill_image_dims', { paths }),
    picnestThumbLookup: async () => ({}),
    picnestReadText: async (filePath) => (await safeInvoke('read_text', { filePath })) || { ok: false, error: '读取失败' },
    picnestSaveText: async (filePath, content, expectedMtimeMs) => (await safeInvoke('save_text', { filePath, content, expectedMtimeMs })) || { ok: false, error: '保存失败' },
    picnestDragBegin: (opts) => safeInvoke('drag_begin', {
      filePaths: Array.isArray(opts) ? opts : (opts?.filePaths || (typeof opts === 'string' && opts ? [opts] : [])),
    }),
    picnestDragEnd: () => safeInvoke('drag_end'),
    picnestImportCheck: (paths, folderId, targetDir) => tauriInvoke('import_check', { paths: paths || [], folderId, targetDir: targetDir || null }),
    picnestImportFiles: (paths, targetDir, replaceOld = null) => tauriInvoke('import_files', { paths: paths || [], targetDir, replaceOld }),
    picnestImportUrls: (urls, targetDir) => tauriInvoke('import_urls', { urls: urls || [], targetDir }),
    picnestDirDupCheck: (srcDir, targetDir, folderId) => tauriInvoke('dir_dup_check', { srcDir, targetDir, folderId }),
    picnestDirDupCancel: () => safeInvoke('dir_dup_cancel'),
    picnestImportDirCopy: (srcDir, targetDir, opts) => tauriInvoke('import_dir_copy', { srcDir, targetDir, opts }),
    onPicnestDirDupProgress: (cb) => {
      if (typeof cb !== 'function') return () => {}
      let unlisten = null
      let cancelled = false
      tauriListen('picnest-dir-dup-progress', (ev) => cb(ev?.payload || {})).then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      }).catch(() => {})
      return () => { cancelled = true; if (unlisten) unlisten() }
    },
    onPicnestDragOutStart: (cb) => {
      if (typeof cb !== 'function') return () => {}
      let unlisten = null
      let cancelled = false
      tauriListen('picnest-drag-out-start', () => cb()).then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      }).catch(() => {})
      return () => { cancelled = true; if (unlisten) unlisten() }
    },
    onPicnestDragOutEnd: (cb) => {
      if (typeof cb !== 'function') return () => {}
      let unlisten = null
      let cancelled = false
      tauriListen('picnest-drag-out-end', () => cb()).then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      }).catch(() => {})
      return () => { cancelled = true; if (unlisten) unlisten() }
    },
    onPicnestDragWheel: (cb) => {
      if (typeof cb !== 'function') return () => {}
      let unlisten = null
      let cancelled = false
      tauriListen('picnest-drag-wheel', (ev) => {
        const delta = ev?.payload?.delta
        if (typeof delta === 'number' && delta !== 0) cb(delta)
      }).then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      }).catch(() => {})
      return () => { cancelled = true; if (unlisten) unlisten() }
    },
    onDbSync: (cb) => subscribe('sync-db', cb),
    onPicnestDupProgress: (cb) => subscribe('picnest-dup-progress', cb),
    onPicnestSeed: () => () => {},
    onPicnestEagleProgress: () => () => {},
    onPicnestThumbRepairProgress: () => () => {},
    onPicnestStripPrefixProgress: () => () => {},
    onConfirmClose: () => () => {},
    onConfirmOversize: () => () => {},
    respondCloseConfirm: async () => true,
    respondOversizeConfirm: async () => true,
    picnestRmSeed: async () => unsupported('当前 Tauri 运行时没有种子导入通道'),
    picnestThemeGet: async () => unsupported('主题由当前 WebView 的本地存储维护'),
    picnestThemeSet: async () => unsupported('主题由当前 WebView 的本地存储维护'),
    windowIsAlwaysOnTop: async () => !!(await safeInvoke('window_is_always_on_top')),
    picnestCollectGetToken: async () => await safeInvoke('collect_get_token'),
    picnestCollectResetToken: async () => await safeInvoke('collect_reset_token'),
    picnestCollectSetRoot: async (rootId) => await safeInvoke('collect_set_root', { rootId }),
    openWithDefault: async (p) => await safeInvoke('open_external', { url: p }),
    getFilePath: (f) => (typeof f?.path === 'string' && f.path ? f.path : null),
    picnestAppVersion: async () => await safeInvoke('app_version'),
  }, {
    get(target, prop) {
      if (prop in target) return target[prop]
      return (...args) => {
        return Promise.resolve(null)
      }
    }
  })
}

const p = () => typeof window !== 'undefined' ? window.picrand || {} : {}

const invoke = async (name, ...args) => {
  if (isTauri()) {
    await portsReady
    switch (name) {
      case 'getPaths':
        return await tauriInvoke('get_paths')
      case 'getAllFolders':
        return await tauriInvoke('get_all_folders')
      case 'addFolderByPath':
        return await tauriInvoke('add_folder_by_path', { path: args[0] })
      case 'syncFolderSnapshot':
        return await tauriInvoke('sync_folder_snapshot', { path: args[0] })
      case 'startWatcher':
        return { ok: true, automatic: true }
      case 'windowMinimize':
        return await tauriInvoke('window_minimize')
      case 'windowMaximize':
        return await tauriInvoke('window_maximize')
      case 'windowClose':
        return await tauriInvoke('window_close')
      case 'windowToggleAlwaysOnTop':
        return await tauriInvoke('window_toggle_always_on_top')
      case 'windowIsAlwaysOnTop':
        return await tauriInvoke('window_is_always_on_top')
      case 'picnestReadText':
        return await tauriInvoke('read_text', { filePath: args[0] })
      case 'picnestSaveText':
        return await tauriInvoke('save_text', { filePath: args[0], content: args[1], expectedMtimeMs: args[2] ?? null })
      case 'picnestDragBegin': {
        const raw = args[0]
        const filePaths = Array.isArray(raw) ? raw : (raw?.filePaths || (typeof raw === 'string' && raw ? [raw] : []))
        return await tauriInvoke('drag_begin', { filePaths })
      }
      case 'picnestDragEnd':
        return await tauriInvoke('drag_end')
      case 'picnestDirTree':
        return await tauriInvoke('dir_tree', { folderId: args[0] })
      case 'picnestDirStats':
        return await tauriInvoke('dir_stats', { folderId: args[0], rels: args[1] || [] })
      case 'picnestImagesByDir':
        return await tauriInvoke('images_by_dir', {
          folderId: args[0],
          dirRel: args[1] || '',
          offset: args[2] || 0,
          limit: args[3] || 100,
          sortMode: args[4],
          sortAsc: args[5],
          recursive: args[6],
          reqSeq: args[7] || 0,
        })
      case 'picnestDirCovers':
        return await tauriInvoke('dir_covers', {
          folderId: args[0],
          rels: args[1] || [],
          perDir: args[2] ?? null,
        })
      case 'picnestCountAll':
        return await tauriInvoke('count_all', { folderId: args[0] })
      case 'picnestRecent':
        return await tauriInvoke('recent', { folderId: args[0], limit: args[1] })
      case 'picnestImageOpened':
        return await tauriInvoke('image_opened', { filePath: args[0] })
      case 'picnestDeleteDir':
        return await tauriInvoke('delete_dir', { dirPath: args[0], rel: args[1], rootId: args[2] })
      case 'picnestMkdir':
        return await tauriInvoke('mkdir', { parentPath: args[0], name: args[1] })
      case 'picnestAppVersion':
        return await tauriInvoke('app_version')
      case 'picnestDirMemoryGet':
        return await tauriInvoke('dir_memory_get', { key: args[0] ?? null })
      case 'picnestThumbsMissing':
        return await tauriInvoke('thumbs_missing', { folderId: args[0] })
      case 'picnestEagleInspect':
        return await tauriInvoke('eagle_inspect', { path: args[0] })
      case 'picnestSetAlwaysOnTop':
        return await tauriInvoke('set_always_on_top', { flag: !!args[0] })
      case 'picnestOpenExternal':
        return await tauriInvoke('open_external', { url: args[0] })
      /* 自动更新：Rust 侧 updater.rs，对齐旧版 argon 的 GitHub Releases 流程 */
      case 'picnestCheckUpdate':
        return await tauriInvoke('check_update', { apiUrl: args[0]?.apiUrl ?? null })
      case 'picnestDownloadUpdate':
        return await tauriInvoke('download_update', {
          url: args[0]?.url ?? null,
          fileName: args[0]?.fileName ?? null,
          expectedSha256: args[0]?.expectedSha256 ?? null,
        })
      case 'picnestCancelDownloadUpdate':
        return await tauriInvoke('cancel_download_update')
      case 'picnestQuitAndInstall': {
        // 前端 UpdateDialog 传的是 { zipPath }，旧版也接受裸字符串
        const a = args[0]
        const zip = typeof a === 'string' ? a : (a?.zipPath ?? a?.filePath ?? null)
        return await tauriInvoke('quit_and_install', { filePath: zip, zipPath: zip })
      }
      case 'picnestDirMemoryRootGet':
        return await tauriInvoke('dir_memory_root_get', { rootId: args[0] })
      case 'picnestDirMemorySet':
        return await tauriInvoke('dir_memory_set', { rootId: args[0], rel: args[1], patch: args[2] })
      case 'picnestDirMemoryRename':
        return await tauriInvoke('dir_memory_rename', { rootId: args[0], oldRel: args[1], newRel: args[2] })
      case 'picnestRemoveRoot':
        return await tauriInvoke('remove_root', { folderId: args[0] })
      case 'picnestApplyTransform':
        return await tauriInvoke('apply_transform', { filePath: args[0], opts: args[1] })
      case 'picnestCrop':
        return await tauriInvoke('crop_image', { filePath: args[0], opts: args[1] })
      case 'picnestCropAs':
        return await tauriInvoke('crop_image_as', { filePath: args[0], opts: args[1] })
      case 'picnestCopyImages':
        return await tauriInvoke('copy_images', { paths: args[0] || [], targetDir: args[1] })
      case 'copyFilesToClipboard':
        return await tauriInvoke('copy_files_to_clipboard', { paths: args[0] || [] })
      case 'picnestTextThumbnails':
        return await tauriInvoke('generate_text_thumbnails', { paths: args[0] || [] })
      case 'picnestImagesReorder':
        return await tauriInvoke('images_reorder', { folderId: args[0], dirRel: args[1] ?? '', orderedPaths: args[2] })
      case 'picnestPsdPreview':
        return await tauriInvoke('psd_preview', { filePath: args[0] })
      case 'picnestVideoPreview':
        return await tauriInvoke('video_preview', { filePath: args[0] })
      case 'picnestViewPreview':
        return await tauriInvoke('view_preview', { filePath: args[0] })
      case 'picnestDirOrderGet':
        return await tauriInvoke('dir_order_get')
      case 'picnestDirOrderSet':
        return await tauriInvoke('dir_order_set', { folderId: args[0], parentKey: args[1], names: args[2] })
      case 'picnestDirSort':
        return await tauriInvoke('dir_sort', { parentRel: args[0], parentAbsPath: args[1], mode: args[2] })
      case 'picnestDirSortRecursive':
        return await tauriInvoke('dir_sort_recursive', { rootAbsPath: args[0], rootRel: args[1], mode: args[2] })
      case 'picnestExportDir':
        return await tauriInvoke('export_dir', { dirPath: args[0], stripPrefix: !!args[1] })
      case 'picnestMoveImage':
        return await tauriInvoke('move_image', { filePath: args[0], targetDir: args[1] })
      case 'picnestMoveDir':
        return await tauriInvoke('move_dir', { dirPath: args[0], targetDir: args[1] })
      /* 2026-11-14：physical_order_images / physical_order_dirs / strip_order_prefixes 已移除。
         它们靠改文件名表达顺序，而且每次改名都把 thumbnail_path 置 NULL（整库灰卡的元凶）。 */
      case 'picnestRenameImage':
        return await tauriInvoke('rename_image', { filePath: args[0], newName: args[1] })
      case 'picnestRenameDir':
        return await tauriInvoke('rename_dir', { oldPath: args[0], newName: args[1], oldRel: args[2], parentRel: args[3] })
      case 'picnestRenameLibrary':
        return await tauriInvoke('rename_library', { id: args[0], name: args[1], opts: args[2] })
      case 'picnestRemove':
        return await tauriInvoke('trash_remove_image', { filePath: args[0] })
      case 'picnestTrashFolders':
        return (await tauriInvoke('trash_folders', { folderId: args[0] }).catch(() => null)) || []
      case 'picnestTrashList':
        return (await tauriInvoke('trash_list', { folderId: args[0] }).catch(() => null)) || []
      case 'picnestTrashRestore':
        return await tauriInvoke('trash_restore_image', { filePath: args[0] })
      case 'picnestTrashPurge':
        return await tauriInvoke('trash_purge_image', { filePath: args[0] })
      case 'picnestTrashRestoreFolder':
        return await tauriInvoke('trash_restore_folder', { id: args[0] }).catch((e) => ({ ok: false, error: String(e?.message || e) }))
      case 'picnestTrashPurgeFolder':
        return await tauriInvoke('trash_purge_folder', { id: args[0] }).catch((e) => ({ ok: false, error: String(e?.message || e) }))
      case 'picnestTrashRestoreAll':
        return await tauriInvoke('trash_restore_all', { folderId: args[0] }).catch((e) => ({ ok: false, error: String(e?.message || e) }))
      case 'picnestTrashPurgeAll':
        return await tauriInvoke('trash_purge_all', { folderId: args[0] }).catch((e) => ({ ok: false, error: String(e?.message || e) }))
      case 'fillImageDims':
        return await tauriInvoke('fill_image_dims', { paths: args[0] })
      case 'picnestThumbLookup':
        return {}
      case 'picnestGetPalettes':
        return (await tauriInvoke('get_palettes', { paths: args[0] }).catch(() => null)) || {}
      case 'picnestBuildPalettesStep':
        return (await tauriInvoke('build_palettes_step', { folderId: args[0], limit: args[1] }).catch(() => null)) || { ok: true, processed: 0 }
      case 'picnestTagsList':
        return (await tauriInvoke('tags_list', { folderId: args[0] }).catch(() => null)) || { ok: true, tags: [], imageTags: {} }
      case 'picnestTagAssign':
        return (await tauriInvoke('tag_assign', {
          imageIds: args[0]?.imageIds || [],
          name: args[0]?.name ?? null,
          tagId: args[0]?.tagId ?? null,
          action: args[0]?.action || 'add',
        }).catch(() => null)) || { ok: false }
      case 'picnestTagRename':
        return (await tauriInvoke('tag_rename', {
          tagId: args[0]?.tagId || 0,
          name: args[0]?.name || '',
        }).catch(() => null)) || { ok: false }
      case 'picnestTagDelete':
        return (await tauriInvoke('tag_delete', { tagId: args[0] }).catch(() => null)) || { ok: false }
      case 'setImageRating':
        return await tauriInvoke('set_image_rating', { filePath: args[0], rating: args[1] }).catch(() => false)
      case 'dbDeleteImage':
        return await tauriInvoke('db_delete_image', { filePath: args[0] }).catch(() => false)
      case 'picnestReveal':
        return await tauriInvoke('picnest_reveal', { filePath: args[0] }).catch(() => false)
      case 'picnestSearch':
        return (await tauriInvoke('picnest_search', { folderId: args[0], query: args[1], limit: args[2] }).catch(() => null)) || []
      case 'picnestRandom':
        return (await tauriInvoke('picnest_random', { folderId: args[0], limit: args[1] }).catch(() => null)) || []
      case 'picnestRootMetaLoad':
        return await tauriInvoke('root_meta_load', { rootId: args[0] }).catch(() => null)
      case 'picnestRootMetaSave':
        return await tauriInvoke('root_meta_save', { rootId: args[0] }).catch(() => null)
      case 'picnestRootMetaEnsure':
        return await tauriInvoke('root_meta_ensure', { rootId: args[0] }).catch(() => null)
      case 'picnestVisualSearchQuery':
        return await tauriInvoke('visual_search_query', { opts: args[0] })
      case 'picnestVisualSearchSave':
        return await tauriInvoke('visual_search_save', { item: args[0] })
      case 'picnestFindDuplicates':
        return await tauriInvoke('find_duplicates', { folderId: args[0], folder_id: args[0], rel: args[1] ?? null })
      case 'picnestDupCancel':
        return await tauriInvoke('dup_cancel')
      case 'picnestAiConfigGet':
        return await tauriInvoke('ai_config_get')
      case 'picnestAiConfigSet':
        return await tauriInvoke('ai_config_set', { opts: args[0] })
      case 'picnestAiModels':
        return await tauriInvoke('ai_models', { opts: args[0] })
      case 'picnestAiTest':
        return await tauriInvoke('ai_test')
      case 'picnestAiDupScan':
        return await tauriInvoke('ai_dup_scan', { rootId: args[0], root_id: args[0], rel: args[1] ?? null, maxPairs: args[2] ?? 40, max_pairs: args[2] ?? 40 })
      case 'picnestAiDupContinue':
        return await tauriInvoke('ai_dup_continue', { rootId: args[0], root_id: args[0], rel: args[1] ?? null, maxPairs: args[2] ?? 40, max_pairs: args[2] ?? 40 })
      case 'picnestAiDupCancel':
        return await tauriInvoke('ai_dup_cancel')
      default:
        console.warn(`[PicNest-Rust] 暂未接入的 Tauri 命令: ${name}`, args)
        return null
    }
  }
  const fn = p()[name]
  if (!fn) throw new Error(`preload 缺少方法 ${name}（补丁未应用?）`)
  return fn(...args)
}

export const api = {
  // 原生
  getPaths: () => isTauri() ? tauriInvoke('get_paths') : p().getPaths?.(),
  getAllFolders: () => isTauri() ? tauriInvoke('get_all_folders') : (p().getAllFolders?.() ?? []),
  addFolderByPath: (path) => invoke('addFolderByPath', path),
  syncFolderSnapshot: (path) => invoke('syncFolderSnapshot', path),
  syncDirSnapshot: (folderId, dirPath) => p().syncDirSnapshot?.(folderId, dirPath),
  startWatcher: (path) => invoke('startWatcher', path),
  generateThumbnailsBatch: (paths) => p().generateThumbnailsBatch?.(paths),
  /* 1024 高清显示图（第二档）：网格大格子用，避免为了清晰去解码原图。
     不过 thumbGate：那是给 400 缩略图排队用的，共用一个门会让 1024 等缩略图批量跑完，
     等到超时就把结果丢掉。后端内部本来就限 2 线程，不需要再加门。 */
  picnestDisplayThumbs: (paths) => p().picnestDisplayThumbs?.(paths),
  generateTextThumbnails: (paths) => invoke('picnestTextThumbnails', paths),
  readText: (filePath) => invoke('picnestReadText', filePath),
  saveText: (filePath, content, expectedMtimeMs) => invoke('picnestSaveText', filePath, content, expectedMtimeMs),
  findDuplicates: (folderId, rel) => invoke('picnestFindDuplicates', folderId, rel),
  applyTransform: (filePath, opts) => invoke('picnestApplyTransform', filePath, opts),
  fillImageDims: (paths) => dimsGate(() => invoke('fillImageDims', paths)),
  windowMinimize: () => isTauri() ? tauriInvoke('window_minimize') : p().windowMinimize?.(),
  windowMaximize: () => isTauri() ? tauriInvoke('window_maximize') : p().windowMaximize?.(),
  windowClose: () => isTauri() ? tauriInvoke('window_close') : p().windowClose?.(),
  windowToggleAlwaysOnTop: () => isTauri() ? tauriInvoke('window_toggle_always_on_top') : p().windowToggleAlwaysOnTop?.(),
  windowDragStart: () => p().windowDragStart?.(),
  windowMoveBy: (dx, dy) => p().windowMoveBy?.(dx, dy),
  windowDragEnd: () => p().windowDragEnd?.(),
  // PicNest 新增
  dirTree: (folderId) => invoke('picnestDirTree', folderId),
  dirStats: (folderId, rels) => invoke('picnestDirStats', folderId, rels),
  // 导航取数走本地 HTTP：实测切目录瞬间 Tauri IPC 会被宿主侧阻塞（后端 12ms、往返 0.9–1.9s），
  // 而同一时刻 HTTP 通道 4–47ms。IPC 继续负责写操作与事件。
  imagesByDir: async (folderId, dirRel, offset, limit, sortMode = 'id', sortAsc, recursive, signal) => {
    if (isTauri() && (!_apiPort || !_mediaNonce.value)) {
      await portsReady
    }
    const port = _apiPort || _mediaPort.value
    if (isTauri() && port && _mediaNonce.value) {
      try {
        const q = new URLSearchParams({
          folder: String(folderId),
          rel: dirRel || '',
          offset: String(offset || 0),
          limit: String(limit || 100000),
          sort: sortMode || 'manual',
        })
        // 不传时与命令侧 unwrap_or 默认保持一致：asc=false、rec=true
        if (typeof sortAsc === 'boolean') q.set('asc', sortAsc ? '1' : '0')
        if (typeof recursive === 'boolean') q.set('rec', recursive ? '1' : '0')
        q.set('nonce', _mediaNonce.value)
        const r = await fetch(`http://127.0.0.1:${port}/api/images?${q}`, { cache: 'no-store', signal })
        if (r.ok) {
          const v = await r.json()
          if (Array.isArray(v)) return v
        }
      } catch (e) {
        if (e && e.name === 'AbortError') return null // 被新一次切换取消了，不当地错误处理
      }
    }
    return invoke('picnestImagesByDir', folderId, dirRel, offset, limit, sortMode, sortAsc, recursive ?? true, nextImgSeq())
  },
  // 子文件夹封面：一次 IPC 拿一批目录的候选图
  dirCovers: (folderId, rels, perDir = 6) => invoke('picnestDirCovers', folderId, rels, perDir),
  imagesReorder: (folderId, dirRel, orderedPaths) => invoke('picnestImagesReorder', folderId, dirRel, orderedPaths),
  countAll: (folderId) => invoke('picnestCountAll', folderId),
  recent: (folderId, limit) => invoke('picnestRecent', folderId, limit),
  imageOpened: (filePath) => invoke('picnestImageOpened', filePath),
  dirMemoryGet: (key) => invoke('picnestDirMemoryGet', key),
  dirMemorySet: (rootId, rel, patch) => invoke('picnestDirMemorySet', rootId, rel, patch),
  dirMemoryRootGet: (rootId) => invoke('picnestDirMemoryRootGet', rootId),
  dirMemoryRename: (rootId, oldRel, newRel) => invoke('picnestDirMemoryRename', rootId, oldRel, newRel),
  // 资料库文件夹管理
  mkdir: (parentPath, name) => invoke('picnestMkdir', parentPath, name),
  deleteDir: (dirPath, rel, rootId) => invoke('picnestDeleteDir', dirPath, rel, rootId),
  trashFolders: (folderId) => invoke('picnestTrashFolders', folderId),
  trashRestoreFolder: (id) => invoke('picnestTrashRestoreFolder', id),
  trashPurgeFolder: (id) => invoke('picnestTrashPurgeFolder', id),
  trashRestoreAll: (folderId) => invoke('picnestTrashRestoreAll', folderId),
  trashPurgeAll: (folderId) => invoke('picnestTrashPurgeAll', folderId),
  renameLibrary: (id, name, opts) => invoke('picnestRenameLibrary', id, name, opts),
  renameDir: (oldPath, newName, oldRel, parentRel) => invoke('picnestRenameDir', oldPath, newName, oldRel, parentRel),
  dirOrderSet: (folderId, parentKey, names) => invoke('picnestDirOrderSet', folderId, parentKey, names),
  dirSort: (parentRel, parentAbsPath, mode) => invoke('picnestDirSort', parentRel, parentAbsPath, mode),
  dirSortRecursive: (rootAbsPath, rootRel, mode) => invoke('picnestDirSortRecursive', rootAbsPath, rootRel, mode),
  exportDir: (dirPath, stripPrefix) => invoke('picnestExportDir', dirPath, !!stripPrefix),
  dragBegin: (paths) => invoke('picnestDragBegin', paths),
  dragEnd: () => invoke('picnestDragEnd'),
  onDragWheel: (cb) => p().onPicnestDragWheel?.(cb) || (() => {}),
  stageDropBegin: () => isTauri() ? tauriInvoke('stage_drop_begin') : null,
  stageDropMkdir: (batchId, relPath) => isTauri() ? tauriInvoke('stage_drop_mkdir', { batchId, relPath }) : null,
  stageDropChunk: (batchId, relPath, append, b64) => isTauri() ? tauriInvoke('stage_drop_chunk', { batchId, relPath, append, b64 }) : null,
  stageDropCleanup: (batchId) => isTauri() ? tauriInvoke('stage_drop_cleanup', { batchId }) : null,
  psdPreview: (filePath) => invoke('picnestPsdPreview', filePath),
  videoPreview: (filePath) => invoke('picnestVideoPreview', filePath),
  videoCompat: (filePath) => window.picrand?.picnestVideoCompat?.(filePath),
  viewPreview: (filePath) => invoke('picnestViewPreview', filePath),
  // 视觉搜索（以图找图）
  visualSearchQuery: (opts) => invoke('picnestVisualSearchQuery', opts),
  visualSearchSave: (opts) => invoke('picnestVisualSearchSave', opts),
  setAlwaysOnTop: (flag) => invoke('picnestSetAlwaysOnTop', flag),
  // 自动更新
  appVersion: () => invoke('picnestAppVersion'),
  openExternal: (url) => invoke('picnestOpenExternal', url),
  checkUpdate: (opts) => invoke('picnestCheckUpdate', opts),
  downloadUpdate: (opts) => invoke('picnestDownloadUpdate', opts),
  cancelDownloadUpdate: () => invoke('picnestCancelDownloadUpdate'),
  quitAndInstall: (opts) => invoke('picnestQuitAndInstall', opts),
  onUpdateProgress: (cb) => p().onPicnestUpdateProgress?.(cb),
  onUpdateStatus: (cb) => p().onPicnestUpdateStatus?.(cb),
}

// 本地文件（缩略图/原图/视频）→ 可用的 HTTP 并发流 src（绕过 WebView2 asset.localhost 单线程回调阻塞）

/* 文件系统监听回调：库内目录有新增/删除/改名时触发（Rust 侧已做 600ms 防抖） */
export async function onFsDirChanged(cb) {
  if (!isTauri()) return () => {}
  try {
    return await tauriListen('fs-dir-changed', (ev) => {
      try { cb(ev?.payload) } catch { /* 静默 */ }
    })
  } catch {
    return () => {}
  }
}

export function fileUrl(winPath) {
  if (!winPath) return ''
  if (isTauri()) {
    if (_mediaPort.value && _mediaNonce.value) {
      return `http://127.0.0.1:${_mediaPort.value}/m/${encodeURIComponent(_mediaNonce.value)}/${encodeURIComponent(winPath)}`
    }
    return ''
  }
  const norm = winPath.replace(/\\/g, '/')
  return 'file:///' + norm.split('/').map(encodeURIComponent).join('/')
}
