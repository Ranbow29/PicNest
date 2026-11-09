// window.picrand 薄封装：PicRand 原生 162 方法 + P4b 注入的 picnest-* 方法
const p = () => typeof window !== 'undefined' ? window.picrand || {} : {}

const invoke = (name, ...args) => {
  const fn = p()[name]
  if (!fn) throw new Error(`preload 缺少方法 ${name}（补丁未应用?）`)
  return fn(...args)
}

export const api = {
  // 原生
  getPaths: () => p().getPaths?.(),
  getAllFolders: () => p().getAllFolders?.() ?? [],
  addFolderByPath: (path) => invoke('addFolderByPath', path),
  syncFolderSnapshot: (path) => invoke('syncFolderSnapshot', path),
  startWatcher: (path) => invoke('startWatcher', path),
  generateThumbnailsBatch: (paths) => p().generateThumbnailsBatch?.(paths),
  generateTextThumbnails: (paths) => invoke('picnestTextThumbnails', paths),
  readText: (filePath) => invoke('picnestReadText', filePath),
  saveText: (filePath, content, expectedMtimeMs) => invoke('picnestSaveText', filePath, content, expectedMtimeMs),
  findDuplicates: (folderId, rel) => invoke('picnestFindDuplicates', folderId, rel),
  applyTransform: (filePath, opts) => invoke('picnestApplyTransform', filePath, opts),
  fillImageDims: (paths) => invoke('fillImageDims', paths),
  windowMinimize: () => p().windowMinimize?.(),
  windowMaximize: () => p().windowMaximize?.(),
  windowClose: () => p().windowClose?.(),
  windowToggleAlwaysOnTop: () => p().windowToggleAlwaysOnTop?.(),
  windowDragStart: () => p().windowDragStart?.(),
  windowMoveBy: (dx, dy) => p().windowMoveBy?.(dx, dy),
  windowDragEnd: () => p().windowDragEnd?.(),
  // PicNest 新增
  dirTree: (folderId) => invoke('picnestDirTree', folderId),
  dirStats: (folderId, rels) => invoke('picnestDirStats', folderId, rels),
  imagesByDir: (folderId, dirRel, offset, limit, sortMode = 'id', sortAsc, recursive = true) =>
    invoke('picnestImagesByDir', folderId, dirRel, offset, limit, sortMode, sortAsc, recursive),
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
  dirSort: (parentRel, parentAbsPath, mode) => invoke('picnestDirSort', parentRel, parentAbsPath, mode),
  dirSortRecursive: (rootAbsPath, rootRel, mode) => invoke('picnestDirSortRecursive', rootAbsPath, rootRel, mode),
  exportDir: (dirPath) => invoke('picnestExportDir', dirPath),
  dragBegin: (paths) => invoke('picnestDragBegin', paths),
  dragEnd: () => invoke('picnestDragEnd'),
}

// 本地文件（缩略图/原图）→ 可用的 img src
export function fileUrl(winPath) {
  if (!winPath) return ''
  const norm = winPath.replace(/\\/g, '/')
  return 'file:///' + norm.split('/').map(encodeURIComponent).join('/')
}
