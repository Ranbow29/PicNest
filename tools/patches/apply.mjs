// PicNest 主进程/preload 补丁脚本（幂等，改前自动备份 .bak，重放安全）
// 用法: node tools/patches/apply.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const MAIN = path.join(ROOT, 'app', 'resources', 'app', 'out', 'main', 'index.js')
const PRELOAD = path.join(ROOT, 'app', 'resources', 'app', 'out', 'preload', 'index.js')

let src = fs.readFileSync(MAIN, 'utf8')
if (!fs.existsSync(MAIN + '.bak')) {
  fs.writeFileSync(MAIN + '.bak', src)
  console.log('[bak] 已创建 index.js.bak（PicRand 2.77.0 原始副本）')
}

/* ---- 主进程替换型补丁 ---- */
const patches = [
  {
    id: 'P1a', desc: 'isDev 支持 PICNEST_DEV=1 环境变量',
    from: 'const isDev = !electron.app.isPackaged;',
    to: 'const isDev = process.env.PICNEST_DEV === "1" || !electron.app.isPackaged; /* PicNest:P1a */',
  },
  {
    id: 'P1b', desc: '正式模式数据目录 → AppData/Roaming/PicNest（隔离 Steam 版数据）',
    from: 'const dataDir = isDev ? path.join(process.cwd(), "_internal_data") : path.join(electron.app.getPath("userData"));',
    to: 'const dataDir = isDev ? path.join(process.cwd(), "_internal_data") : path.join(electron.app.getPath("appData"), "PicNest"); /* PicNest:P1b */',
  },
  {
    id: 'P1c', desc: 'userData 在单实例锁之前指向 PicNest（避免与运行中的 PicRand 抢锁）',
    from: 'const gotLock = electron.app.requestSingleInstanceLock();',
    to: 'electron.app.setPath("userData", path.join(electron.app.getPath("appData"), "PicNest")); /* PicNest:P1c */\nconst gotLock = electron.app.requestSingleInstanceLock();',
  },
  {
    id: 'P2', desc: '摘除 Steam 状态上报（无 DRM 门禁）',
    from: 'void initSteamStatus();',
    to: 'void 0; /* PicNest:P2 steam disabled */',
  },
  {
    id: 'P3a', desc: '窗口标题 → PicNest 图巢',
    from: 'title: "PicRand",',
    to: 'title: "PicNest 图巢", /* PicNest:P3a */',
  },
  {
    id: 'P3b', desc: '启动背景色跟随系统明暗',
    from: 'let bgColor = "#1a1a2e";',
    to: 'let bgColor = electron.nativeTheme && electron.nativeTheme.shouldUseDarkColors ? "#1a1a2e" : "#f4efe7"; /* PicNest:P3b */',
  },
  {
    id: 'P3c', desc: 'dev 加载 127.0.0.1:5173（IPv4，绕 ::1/代理怪癖）',
    from: 'if (isDev) mainWindow.loadURL("http://localhost:5173");',
    to: 'if (isDev) mainWindow.loadURL("http://127.0.0.1:5173"); /* PicNest:P3c */',
  },
  {
    id: 'P8a', desc: 'scan/sync 读取 deleted_at（软删除行不参与 removed）',
    from: 'const dbRows = getDb().prepare("SELECT file_path FROM images WHERE folder_id = ?").all(folderId);',
    to: 'const dbRows = getDb().prepare("SELECT file_path, deleted_at FROM images WHERE folder_id = ?").all(folderId); /* PicNest:P8a */',
  },
  {
    id: 'P8b', desc: 'scan-folder 不删除软删除行（回收站）',
    from: 'for (const dp of dbPathSet) {\n      if (!scannedPaths.has(dp)) removed.push(dp);\n    }',
    to: 'for (const dr of dbRows) {\n      if (dr.deleted_at == null && !scannedPaths.has(dr.file_path)) removed.push(dr.file_path);\n    } /* PicNest:P8b */',
  },
  {
    id: 'P8c', desc: 'sync-folder-snapshot 读取 deleted_at（软删除行不参与 removed）',
    from: 'const dbRows = getDb().prepare("SELECT file_path FROM images WHERE folder_id = ?").all(folderId);',
    to: 'const dbRows = getDb().prepare("SELECT file_path, deleted_at FROM images WHERE folder_id = ?").all(folderId); /* PicNest:P8c */',
  },
  {
    id: 'P8d', desc: 'sync-folder-snapshot 不删除软删除行（回收站/文件夹回收条目）',
    from: 'for (const dp of dbPathSet) {\n      if (!currentPaths.has(dp)) {\n        removed.push(dp);\n      }\n    }',
    to: 'for (const dr of dbRows) {\n      if (dr.deleted_at == null && !currentPaths.has(dr.file_path)) {\n        removed.push(dr.file_path);\n      }\n    } /* PicNest:P8d */',
  },
  {
    id: 'P9a', desc: 'scan-worker 收录文本类（txt/md/log/json/csv/ini/yaml…）',
    from: "const exts = new Set(['.jpg','.jpeg','.png','.gif','.bmp','.webp','.tiff','.tif','.avif','.svg','.psd','.heic','.heif','.mp4','.webm','.mov','.mkv','.avi','.flv','.f4v'])",
    to: "const exts = new Set(['.jpg','.jpeg','.png','.gif','.bmp','.webp','.tiff','.tif','.avif','.svg','.psd','.heic','.heif','.mp4','.webm','.mov','.mkv','.avi','.flv','.f4v','.txt','.md','.markdown','.log','.json','.jsonc','.csv','.tsv','.ini','.cfg','.conf','.yaml','.yml']); /* PicNest:P9a */",
  },
  {
    id: 'P9b', desc: 'watcher-worker 监听文本类变动',
    from: "const IMAGE_EXTS = new Set(['.jpg','.jpeg','.png','.gif','.bmp','.webp','.tiff','.tif','.avif','.svg','.psd','.heic','.heif','.mp4','.webm','.mov','.mkv','.avi','.flv','.f4v']);",
    to: "const IMAGE_EXTS = new Set(['.jpg','.jpeg','.png','.gif','.bmp','.webp','.tiff','.tif','.avif','.svg','.psd','.heic','.heif','.mp4','.webm','.mov','.mkv','.avi','.flv','.f4v','.txt','.md','.markdown','.log','.json','.jsonc','.csv','.tsv','.ini','.cfg','.conf','.yaml','.yml']); /* PicNest:P9b */",
  },
  {
    id: 'P9c', desc: 'SUPPORTED_EXTS 收录文本类（格式筛选不被主进程过滤掉）',
    from: 'const SUPPORTED_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".tif", ".avif", ".svg", ".psd", ".heic", ".heif", ".mp4", ".webm", ".mov", ".mkv", ".avi", ".flv", ".f4v"];',
    to: 'const SUPPORTED_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".tif", ".avif", ".svg", ".psd", ".heic", ".heif", ".mp4", ".webm", ".mov", ".mkv", ".avi", ".flv", ".f4v", ".txt", ".md", ".markdown", ".log", ".json", ".jsonc", ".csv", ".tsv", ".ini", ".cfg", ".conf", ".yaml", ".yml"]; /* PicNest:P9c */',
  },
  {
    /* 注意：index.js 里有三份同形模板（oversize / scan / stats）。P9a 只替换到第一份（oversize），
       真正决定入库的是 scan 模板这份（第二个匹配）——用独立标记再打一次。 */
    id: 'P9d', desc: 'scan-worker（真正入库那份）收录文本类',
    from: "const exts = new Set(['.jpg','.jpeg','.png','.gif','.bmp','.webp','.tiff','.tif','.avif','.svg','.psd','.heic','.heif','.mp4','.webm','.mov','.mkv','.avi','.flv','.f4v'])",
    to: "const exts = new Set(['.jpg','.jpeg','.png','.gif','.bmp','.webp','.tiff','.tif','.avif','.svg','.psd','.heic','.heif','.mp4','.webm','.mov','.mkv','.avi','.flv','.f4v','.txt','.md','.markdown','.log','.json','.jsonc','.csv','.tsv','.ini','.cfg','.conf','.yaml','.yml']); /* PicNest:P9d */",
  },
  {
    id: 'P9e', desc: 'stats-worker 统计文本文件（文件夹文件数/占用空间）',
    from: "const exts = new Set(['.jpg','.jpeg','.png','.gif','.bmp','.webp','.tiff','.tif','.avif','.svg','.psd','.heic','.heif','.mp4','.webm','.mov','.mkv','.avi','.flv','.f4v'])",
    to: "const exts = new Set(['.jpg','.jpeg','.png','.gif','.bmp','.webp','.tiff','.tif','.avif','.svg','.psd','.heic','.heif','.mp4','.webm','.mov','.mkv','.avi','.flv','.f4v','.txt','.md','.markdown','.log','.json','.jsonc','.csv','.tsv','.ini','.cfg','.conf','.yaml','.yml']); /* PicNest:P9e */",
  },
]

let ok = 0, skip = 0, fail = 0
for (const p of patches) {
  if (src.includes(`/* PicNest:${p.id}`)) { skip++; continue }
  if (!src.includes(p.from)) { fail++; console.error(`[FAIL] ${p.id} 找不到原文`); continue }
  src = src.replace(p.from, p.to)
  ok++; console.log(`[ok]   ${p.id} ${p.desc}`)
}

/* ---- P4: 追加型补丁（picnest-handlers.js 整块，重放=更新到最新） ---- */
const HANDLERS_SRC = path.join(ROOT, 'tools', 'patches', 'picnest-handlers.js')
const P4_HEAD = '/* ==== PicNest:P4'
const P4_TAIL = '/* ==== /PicNest:P4 ==== */'
const handlersNew = fs.readFileSync(HANDLERS_SRC, 'utf8')
const start = src.indexOf(P4_HEAD)
if (start !== -1) {
  const end = src.indexOf(P4_TAIL)
  if (end === -1) { console.error('[FAIL] P4 标记不完整'); process.exit(1) }
  src = src.slice(0, start) + handlersNew + src.slice(end + P4_TAIL.length)
  console.log('[ok]   P4-handlers 已更新为最新内容')
} else {
  src = src + '\n' + handlersNew + '\n'
  console.log('[ok]   P4-handlers 已追加（dir-tree / images-by-dir / recent / dir-memory / seed / last_opened_at）')
}

fs.writeFileSync(MAIN, src)

/* ---- P4b: preload 桥接（重放=更新到最新） ---- */
let psrc = fs.readFileSync(PRELOAD, 'utf8')
if (!fs.existsSync(PRELOAD + '.bak')) fs.writeFileSync(PRELOAD + '.bak', psrc)
const P4B_RE = /Object\.assign\(api, \{ \/\* PicNest:P4b \*\/[\s\S]*?\n\}\);\n/
if (P4B_RE.test(psrc)) {
  psrc = psrc.replace(P4B_RE, '')
  console.log('[ok]   P4b-preload 旧块已移除，重注入最新')
}
const anchor = 'electron.contextBridge.exposeInMainWorld("picrand", api);'
if (!psrc.includes(anchor)) { console.error('[FAIL] P4b 找不到 preload 暴露点'); process.exit(1) }
const bridge = [
  'Object.assign(api, { /* PicNest:P4b */',
  '  picnestDirTree: (folderId) => electron.ipcRenderer.invoke("picnest-dir-tree", folderId),',
  '  picnestDirStats: (folderId, rels) => electron.ipcRenderer.invoke("picnest-dir-stats", folderId, rels),',
  '  picnestImagesByDir: (folderId, dirRel, offset, limit, sortMode, sortAsc, recursive) => electron.ipcRenderer.invoke("picnest-images-by-dir", folderId, dirRel, offset, limit, sortMode, sortAsc, recursive),',
  '  picnestImagesReorder: (folderId, dirRel, orderedPaths) => electron.ipcRenderer.invoke("picnest-images-reorder", folderId, dirRel, orderedPaths),',
  '  picnestCountAll: (folderId) => electron.ipcRenderer.invoke("picnest-count-all", folderId),',
  '  picnestRecent: (folderId, limit) => electron.ipcRenderer.invoke("picnest-recent", folderId, limit),',
  '  picnestImageOpened: (filePath) => electron.ipcRenderer.invoke("picnest-image-opened", filePath),',
  '  picnestDirMemoryGet: (key) => electron.ipcRenderer.invoke("picnest-dir-memory-get", key),',
  '  picnestDirMemorySet: (key, patch) => electron.ipcRenderer.invoke("picnest-dir-memory-set", key, patch),',
  '  onPicnestSeed: (cb) => electron.ipcRenderer.on("picnest-seed", (_e, d) => cb(d)),',
  '  picnestRmSeed: () => electron.ipcRenderer.invoke("picnest-rm-seed"),',
  '  picnestReveal: (filePath) => electron.ipcRenderer.invoke("picnest-reveal", filePath),',
  '  picnestSetImageMeta: (filePath, patch) => electron.ipcRenderer.invoke("picnest-set-image-meta", filePath, patch),',
  '  picnestGetImageMeta: (filePath) => electron.ipcRenderer.invoke("picnest-get-image-meta", filePath),',
  '  picnestRenameImage: (filePath, newName) => electron.ipcRenderer.invoke("picnest-rename-image", filePath, newName),',
  '  picnestThumbLookup: (paths) => electron.ipcRenderer.invoke("picnest-thumb-lookup", paths),',
  '  picnestReadText: (filePath) => electron.ipcRenderer.invoke("picnest-read-text", filePath),',
  '  picnestSaveText: (filePath, content, expectedMtimeMs) => electron.ipcRenderer.invoke("picnest-save-text", filePath, content, expectedMtimeMs),',
  '  picnestTextThumbnails: (paths) => electron.ipcRenderer.invoke("picnest-text-thumbnails", paths),',
  '  picnestFindDuplicates: (folderId, rel) => electron.ipcRenderer.invoke("picnest-find-duplicates", folderId, rel),',
  '  picnestAiConfigGet: () => electron.ipcRenderer.invoke("picnest-ai-config-get"),',
  '  picnestAiConfigSet: (opts) => electron.ipcRenderer.invoke("picnest-ai-config-set", opts),',
  '  picnestAiTest: () => electron.ipcRenderer.invoke("picnest-ai-test"),',
  '  picnestAiModels: (opts) => electron.ipcRenderer.invoke("picnest-ai-models", opts),',
  '  picnestAiDupScan: (folderId, rel, maxPairs) => electron.ipcRenderer.invoke("picnest-ai-dup-scan", folderId, rel, maxPairs),',
  '  picnestAiDupCancel: () => electron.ipcRenderer.invoke("picnest-ai-dup-cancel"),',
  '  onPicnestAiDupProgress: (cb) => electron.ipcRenderer.on("picnest-ai-dup-progress", (_e, d) => cb(d)),',
  '  picnestApplyTransform: (filePath, opts) => electron.ipcRenderer.invoke("picnest-apply-transform", filePath, opts),',
  '  onPicnestDupProgress: (cb) => electron.ipcRenderer.on("picnest-dup-progress", (_e, d) => cb(d)),',
  '  picnestMoveImage: (filePath, targetDir) => electron.ipcRenderer.invoke("picnest-move-image", filePath, targetDir),',
  '  picnestMoveDir: (dirPath, targetDir) => electron.ipcRenderer.invoke("picnest-move-dir", dirPath, targetDir),',
  '  picnestDirOrderSet: (folderId, parentKey, names) => electron.ipcRenderer.invoke("picnest-dir-order-set", folderId, parentKey, names),',
  '  picnestViewCounts: (folderId) => electron.ipcRenderer.invoke("picnest-view-counts", folderId),',
  '  picnestRandom: (folderId, limit) => electron.ipcRenderer.invoke("picnest-random", folderId, limit),',
  '  picnestTrashList: (folderId) => electron.ipcRenderer.invoke("picnest-trash-list", folderId),',
  '  picnestTrashRestore: (filePath) => electron.ipcRenderer.invoke("picnest-trash-restore", filePath),',
  '  picnestTrashPurge: (filePath) => electron.ipcRenderer.invoke("picnest-trash-purge", filePath),',
  '  picnestRemove: (filePath) => electron.ipcRenderer.invoke("picnest-remove", filePath),',
  '  picnestSearch: (folderId, q, limit) => electron.ipcRenderer.invoke("picnest-search", folderId, q, limit),',
  '  picnestImportFiles: (paths, targetDir) => electron.ipcRenderer.invoke("picnest-import-files", paths, targetDir),',
  '  picnestBuildPalettesStep: (folderId, step) => electron.ipcRenderer.invoke("picnest-build-palettes-step", folderId, step),',
  '  picnestGetPalettes: (paths) => electron.ipcRenderer.invoke("picnest-get-palettes", paths),',
  '  picnestImportUrls: (urls, targetDir) => electron.ipcRenderer.invoke("picnest-import-urls", urls, targetDir),',
  '  picnestImportCheck: (paths, folderId) => electron.ipcRenderer.invoke("picnest-import-check", paths, folderId),',
  '  picnestImportDirCopy: (srcDir, targetDir, opts) => electron.ipcRenderer.invoke("picnest-import-dir-copy", srcDir, targetDir, opts),',
  '  picnestDirDupCheck: (srcDir, targetDir, folderId) => electron.ipcRenderer.invoke("picnest-dir-dup-check", srcDir, targetDir, folderId),',
  '  picnestCopyImages: (paths, targetDir) => electron.ipcRenderer.invoke("picnest-copy-images", paths, targetDir),',
  '  picnestCrop: (filePath, opts) => electron.ipcRenderer.invoke("picnest-crop", filePath, opts),',
  '  picnestCropAs: (filePath, opts) => electron.ipcRenderer.invoke("picnest-crop-as", filePath, opts),',
  '  picnestMkdir: (parentPath, name) => electron.ipcRenderer.invoke("picnest-mkdir", parentPath, name),',
  '  picnestDeleteDir: (dirPath, rel, rootId) => electron.ipcRenderer.invoke("picnest-delete-dir", dirPath, rel, rootId),',
  '  picnestTrashFolders: (folderId) => electron.ipcRenderer.invoke("picnest-trash-folders", folderId),',
  '  picnestTrashRestoreFolder: (id) => electron.ipcRenderer.invoke("picnest-trash-restore-folder", id),',
  '  picnestTrashPurgeFolder: (id) => electron.ipcRenderer.invoke("picnest-trash-purge-folder", id),',
  '  picnestTrashRestoreAll: (folderId) => electron.ipcRenderer.invoke("picnest-trash-restore-all", folderId),',
  '  picnestTrashPurgeAll: (folderId) => electron.ipcRenderer.invoke("picnest-trash-purge-all", folderId),',
  '  picnestRenameLibrary: (id, name) => electron.ipcRenderer.invoke("picnest-rename-library", id, name),',
  '  picnestRemoveRoot: (id) => electron.ipcRenderer.invoke("picnest-remove-root", id),',
  '  picnestCollectSetRoot: (id) => electron.ipcRenderer.invoke("picnest-collect-set-root", id),',
  '  picnestCollectInfo: () => electron.ipcRenderer.invoke("picnest-collect-info"),',
  '  picnestRenameDir: (oldPath, newName, oldRel, parentRel) => electron.ipcRenderer.invoke("picnest-rename-dir", oldPath, newName, oldRel, parentRel),',
  '  picnestDirSort: (parentRel, parentAbsPath, mode) => electron.ipcRenderer.invoke("picnest-dir-sort", parentRel, parentAbsPath, mode),',
  '  picnestDirSortRecursive: (rootAbsPath, rootRel, mode) => electron.ipcRenderer.invoke("picnest-dir-sort-recursive", rootAbsPath, rootRel, mode),',
  '  picnestExportDir: (dirPath) => electron.ipcRenderer.invoke("picnest-export-dir", dirPath),',
  '  windowDragStart: () => electron.ipcRenderer.send("picnest-window-drag-start"),',
  '  windowMoveBy: (dx, dy) => electron.ipcRenderer.send("picnest-window-move", dx, dy),',
  '  windowDragEnd: () => electron.ipcRenderer.send("picnest-window-drag-end"),',
  '  windowBounds: () => electron.ipcRenderer.invoke("picnest-window-bounds"),',
  '});',
].join('\n')
psrc = psrc.replace(anchor, bridge + '\n' + anchor)
fs.writeFileSync(PRELOAD, psrc)
console.log('[ok]   P4b-preload 已注入 picnest-* 桥接方法')

console.log(`\n完成: 替换 ${ok} / 跳过 ${skip} / 失败 ${fail} → main + preload`)
process.exit(fail ? 1 : 0)
