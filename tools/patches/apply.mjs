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
  '  picnestImagesByDir: (folderId, dirRel, offset, limit, sortMode) => electron.ipcRenderer.invoke("picnest-images-by-dir", folderId, dirRel, offset, limit, sortMode),',
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
  '  picnestMoveImage: (filePath, targetDir) => electron.ipcRenderer.invoke("picnest-move-image", filePath, targetDir),',
  '  picnestMoveDir: (dirPath, targetDir) => electron.ipcRenderer.invoke("picnest-move-dir", dirPath, targetDir),',
  '  picnestDirOrderSet: (parentKey, names) => electron.ipcRenderer.invoke("picnest-dir-order-set", parentKey, names),',
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
  '  picnestCrop: (filePath, opts) => electron.ipcRenderer.invoke("picnest-crop", filePath, opts),',
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
