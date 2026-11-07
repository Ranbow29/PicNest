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
  imagesByDir: (folderId, dirRel, offset, limit, sortMode = 'id') =>
    invoke('picnestImagesByDir', folderId, dirRel, offset, limit, sortMode),
  countAll: (folderId) => invoke('picnestCountAll', folderId),
  recent: (folderId, limit) => invoke('picnestRecent', folderId, limit),
  imageOpened: (filePath) => invoke('picnestImageOpened', filePath),
  dirMemoryGet: (key) => invoke('picnestDirMemoryGet', key),
  dirMemorySet: (key, patch) => invoke('picnestDirMemorySet', key, patch),
}

// 本地文件（缩略图/原图）→ 可用的 img src
export function fileUrl(winPath) {
  if (!winPath) return ''
  const norm = winPath.replace(/\\/g, '/')
  return 'file:///' + norm.split('/').map(encodeURIComponent).join('/')
}
