// PicNest 主进程/preload 补丁脚本（幂等，改前自动备份 .bak，重放安全）
// 用法: node tools/patches/apply.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const MAIN = path.join(ROOT, 'app', 'resources', 'app', 'out', 'main', 'index.js')
const PRELOAD = path.join(ROOT, 'app', 'resources', 'app', 'out', 'preload', 'index.js')
const SOURCE_DIR = path.join(ROOT, 'source', 'picrand-2.77.0')

// 若 app/resources/app/out 尚不存在（全新克隆环境），自动从 source/ 源码镜像初始化
if (!fs.existsSync(MAIN) && fs.existsSync(SOURCE_DIR)) {
  console.log('[init] 未在 app/resources/app 检测到主进程，正在从 source/picrand-2.77.0 自动初始化...')
  const targetAppDir = path.join(ROOT, 'app', 'resources', 'app')
  fs.mkdirSync(path.join(targetAppDir, 'out', 'main'), { recursive: true })
  fs.mkdirSync(path.join(targetAppDir, 'out', 'preload'), { recursive: true })
  fs.cpSync(SOURCE_DIR, targetAppDir, { recursive: true })
  console.log('[init] 源码镜像初始化完毕！')
}

// 干净 clone 只有源码镜像，没有 Electron 运行时/依赖；提醒开发者按 README 准备 app/
const hasRuntimeExe = ['PicNest.exe', 'PicRand.exe'].some((n) => fs.existsSync(path.join(ROOT, 'app', n)))
if (!hasRuntimeExe || !fs.existsSync(path.join(ROOT, 'app', 'resources', 'app', 'node_modules'))) {
  console.warn('[warn] 未检测到 app 可执行文件或 app/resources/app/node_modules：apply 只生成源码与补丁，当前不能直接启动。')
  console.warn('[warn] 请按 README「开发者构建 → 准备 app/ 运行时」先放入便携包或 PicRand 2.77.0 运行时。')
}

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
    id: 'P1b', desc: '正式模式数据目录 → AppData/Roaming/PicNest（支持 PICNEST_USER_DATA 覆盖）',
    from: 'const dataDir = isDev ? path.join(process.cwd(), "_internal_data") : path.join(electron.app.getPath("userData"));',
    to: 'const dataDir = process.env.PICNEST_USER_DATA || (isDev ? path.join(process.cwd(), "_internal_data") : path.join(electron.app.getPath("appData"), "PicNest")); /* PicNest:P1b */',
  },
  {
    id: 'P1c', desc: 'userData 在单实例锁之前指向 PicNest（支持 PICNEST_USER_DATA 隔离测试）',
    from: 'const gotLock = electron.app.requestSingleInstanceLock();',
    to: 'electron.app.setPath("userData", process.env.PICNEST_USER_DATA || path.join(electron.app.getPath("appData"), "PicNest")); /* PicNest:P1c */\nconst gotLock = electron.app.requestSingleInstanceLock();',
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
  {
    /* 缩略图缓存目录不能叫 dataDir/cache：Windows 大小写不敏感，会和 Chromium 自己的
       Cache（Cache_Data）撞在同一目录，浏览器缓存清理时连缩略图一起蒸发（实测生产 340MB
       只剩 Cache_Data）。挪到 picnest-thumbs，旧文件由 picnestMigrateThumbCacheDir 搬过去。 */
    id: 'P10', desc: '缩略图缓存目录 → dataDir/picnest-thumbs（避开 Chromium Cache 目录）',
    from: 'const cacheDir = path.join(dataDir, "cache");',
    to: 'const cacheDir = path.join(dataDir, "picnest-thumbs"); /* PicNest:P10 */',
  },
  {
    /* scan 工作线程原本不跳过 . 开头的目录/文件；根目录里的 .picnest/meta.json 会被当文本图片入库。
       补一行 dot 过滤（P9d 的 worker 模板里只有这一处 walk(dir)）。 */
    id: 'P9f', desc: 'scan-worker 跳过 . 开头的隐藏目录/文件（.picnest 元数据目录不入库）',
    from: '    if (entry.isDirectory()) { walk(path.join(dir, entry.name)); continue }',
    to: '    if (entry.name.startsWith(".")) continue\n    if (entry.isDirectory()) { walk(path.join(dir, entry.name)); continue } /* PicNest:P9f */',
  },
  {
    id: 'P11a', desc: '应用名 PicRand → PicNest（任务栏/托盘/崩溃报告）',
    from: 'electron.app.setName("PicRand");',
    to: 'electron.app.setName("PicNest"); /* PicNest:P11a */\ntry { electron.app.setAppUserModelId("PicNest"); } catch (e) {}',
  },
  {
    id: 'P11b', desc: '托盘 tooltip → PicNest 图巢',
    from: 'tray.setToolTip("PicRand");',
    to: 'tray.setToolTip("PicNest 图巢"); /* PicNest:P11b */',
  },
  {
    id: 'P11c', desc: '托盘菜单「显示 PicRand」→「显示 PicNest 图巢」',
    from: '{ label: "显示 PicRand", click: () => showWindow() },',
    to: '{ label: "显示 PicNest 图巢", click: () => showWindow() }, /* PicNest:P11c */',
  },
  {
    id: 'P11d', desc: 'crashReporter productName/companyName → PicNest',
    from: 'crashReporter.start({ productName: "PicRand", companyName: "PicRand", submitURL: "", uploadToServer: false });',
    to: 'crashReporter.start({ productName: "PicNest", companyName: "PicNest", submitURL: "", uploadToServer: false }); /* PicNest:P11d */',
  },
  {
    id: 'P11e', desc: '子进程探针 wmic 进程名 → PicNest.exe',
    from: 'wmic process where "name=\'PicRand.exe\'" get ProcessId,CommandLine /format:list',
    to: 'wmic process where "name=\'PicNest.exe\'" get ProcessId,CommandLine /format:list /* PicNest:P11e */',
  },
  {
    /* 参考板是原 PicRand 的功能，PicNest 没做：托盘菜单里这几项点了也没有意义，直接移除。 */
    id: 'P12', desc: '托盘菜单移除未实现的「参考板」四项',
    from: `    { type: "separator" },
    { label: "新建参考板", click: async () => {
      const result = await electron.dialog.showOpenDialog({
        properties: ["openFile"],
        filters: [{ name: "图片", extensions: ["jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif", "ico", "heic", "heif", "avif", "svg", "psd", "mp4", "webm", "mov", "mkv", "avi", "flv", "f4v"] }]
      });
      if (result.canceled || !result.filePaths[0]) return;
      const [cx, cy] = computeCascadePos();
      createRefWin(crypto.randomUUID(), result.filePaths[0], cx, cy).catch(() => {
      });
    } },
    { type: "separator" },
    { label: "隐藏所有参考板", click: () => _refBoardWindows("hide") },
    { label: "显示所有参考板", click: () => _refBoardWindows("show") },
    { label: "关闭所有参考板", click: () => _refBoardWindows("close") },
    { type: "separator" },`,
    to: `    { type: "separator" }, /* PicNest:P12 参考板未实现，托盘菜单移除 */`,
  },
  {
    /* PicNest 的两段式退出：点主窗口关闭只隐藏到托盘（图2 的隐藏区），
       托盘菜单「退出」才会 allowClose + app.quit 彻底结束进程。 */
    id: 'P13a', desc: '关闭主窗口 = 隐藏到托盘（托盘「退出」才彻底退出）',
    from: `  mainWindow.on("close", async (event) => {
    if (allowClose) return;
    event.preventDefault();
    mainWindow?.webContents.send("confirm-close");
  });`,
    to: `  mainWindow.on("close", (event) => {
    if (allowClose) return;
    /* PicNest:P13a 关闭主窗口只隐藏到托盘；托盘菜单「退出」才彻底退出 */
    event.preventDefault();
    mainWindow?.hide();
  });`,
  },
  {
    /* 原 window-all-closed 先 cleanupOnExit/closeDatabase，任一步抛错都会跳过 tray.destroy
       和 app.exit，表现为窗口没了、托盘图标和进程还挂在后台。先收托盘，再做兜底清理，最后必退。 */
    id: 'P13b', desc: 'window-all-closed 先销毁托盘并保证进程退出',
    from: `electron.app.on("window-all-closed", () => {
  cleanupOnExit();
  closeDatabase();
  if (tray) {
    try {
      tray.destroy();
    } catch {
    }
    tray = null;
  }
  if (process.platform !== "darwin") electron.app.exit(0);
});`,
    to: `electron.app.on("window-all-closed", () => {
  /* PicNest:P13b 先收托盘、兜住清理异常，再强制退出；任一步抛错都不能把托盘/进程留在后台 */
  allowClose = true;
  if (tray) {
    try {
      tray.destroy();
    } catch {
    }
    tray = null;
  }
  try {
    cleanupOnExit();
  } catch {
  }
  try {
    closeDatabase();
  } catch {
  }
  if (process.platform !== "darwin") electron.app.exit(0);
});`,
  },
]

let ok = 0, skip = 0, fail = 0
for (const p of patches) {
  if (src.includes(`/* PicNest:${p.id}`)) { skip++; continue }
  if (!src.includes(p.from)) { fail++; console.error(`[FAIL] ${p.id} 找不到原文`); continue }
  src = src.replace(p.from, p.to)
  ok++; console.log(`[ok]   ${p.id} ${p.desc}`)
}

/* ---- P11f: 应用 package.json 名称与版本 → PicNest（任务栏/系统显示名/自动更新版本真源） ---- */
try {
  const ROOTPKG = path.join(ROOT, 'package.json')
  const rootVer = fs.existsSync(ROOTPKG) ? (JSON.parse(fs.readFileSync(ROOTPKG, 'utf8')).version || '0.1.0') : '0.1.0'
  const APPPKG = path.join(ROOT, 'app', 'resources', 'app', 'package.json')
  const pkg = JSON.parse(fs.readFileSync(APPPKG, 'utf8'))
  const changed = pkg.name !== 'picnest' || pkg.productName !== 'PicNest' || pkg.description !== 'PicNest 图巢' || pkg.author !== 'PicNest' || pkg.version !== rootVer
  pkg.name = 'picnest'
  pkg.productName = 'PicNest'
  pkg.description = 'PicNest 图巢'
  pkg.author = 'PicNest'
  pkg.version = rootVer
  if (changed) {
    fs.writeFileSync(APPPKG, JSON.stringify(pkg, null, 2))
    console.log(`[ok]   P11f package.json 应用名 → PicNest (v${rootVer})`)
  }
} catch (e) { console.warn('[skip] P11f package.json:', e.message) }

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
  '  picnestDirMemorySet: (rootId, rel, patch) => electron.ipcRenderer.invoke("picnest-dir-memory-set", rootId, rel, patch),',
  '  picnestDirMemoryRootGet: (rootId) => electron.ipcRenderer.invoke("picnest-dir-memory-root-get", rootId),',
  '  picnestDirMemoryRename: (rootId, oldRel, newRel) => electron.ipcRenderer.invoke("picnest-dir-memory-rename", rootId, oldRel, newRel),',
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
  '  picnestDupCancel: () => electron.ipcRenderer.invoke("picnest-dup-cancel"),',
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
  '  picnestTagsList: (folderId) => electron.ipcRenderer.invoke("picnest-tags-list", folderId),',
  '  picnestTagAssign: (opts) => electron.ipcRenderer.invoke("picnest-tag-assign", opts),',
  '  picnestTagRename: (opts) => electron.ipcRenderer.invoke("picnest-tag-rename", opts),',
  '  picnestTagDelete: (tagId) => electron.ipcRenderer.invoke("picnest-tag-delete", tagId),',
  '  picnestEagleInspect: (p) => electron.ipcRenderer.invoke("picnest-eagle-inspect", p),',
  '  picnestEagleCopy: (opts) => electron.ipcRenderer.invoke("picnest-eagle-copy", opts),',
  '  picnestEagleFinish: (opts) => electron.ipcRenderer.invoke("picnest-eagle-finish", opts),',
  '  picnestEagleCancel: () => electron.ipcRenderer.invoke("picnest-eagle-cancel"),',
  '  onPicnestEagleProgress: (cb) => electron.ipcRenderer.on("picnest-eagle-progress", (_e, d) => cb(d)),',
  '  picnestImportUrls: (urls, targetDir) => electron.ipcRenderer.invoke("picnest-import-urls", urls, targetDir),',
  '  picnestImportCheck: (paths, folderId) => electron.ipcRenderer.invoke("picnest-import-check", paths, folderId),',
  '  picnestImportDirCopy: (srcDir, targetDir, opts) => electron.ipcRenderer.invoke("picnest-import-dir-copy", srcDir, targetDir, opts),',
  '  picnestDirDupCheck: (srcDir, targetDir, folderId) => electron.ipcRenderer.invoke("picnest-dir-dup-check", srcDir, targetDir, folderId),',
  '  picnestDirDupCancel: () => electron.ipcRenderer.invoke("picnest-dir-dup-cancel"),',
  '  onPicnestDirDupProgress: (cb) => electron.ipcRenderer.on("picnest-dir-dup-progress", (_e, d) => cb(d)),',
  '  picnestThumbsMissing: (folderId) => electron.ipcRenderer.invoke("picnest-thumbs-missing", folderId),',
  '  picnestDisplayThumbs: (paths) => electron.ipcRenderer.invoke("picnest-display-thumbs", paths),',
  '  picnestPsdPreview: (filePath) => electron.ipcRenderer.invoke("picnest-psd-preview", filePath),',
  '  picnestViewPreview: (filePath) => electron.ipcRenderer.invoke("picnest-view-preview", filePath),',
  '  picnestRepairThumbs: (folderId) => electron.ipcRenderer.invoke("picnest-repair-thumbs", folderId),',
  '  picnestRepairThumbsCancel: () => electron.ipcRenderer.invoke("picnest-repair-thumbs-cancel"),',
  '  onPicnestThumbRepairProgress: (cb) => electron.ipcRenderer.on("picnest-thumb-repair-progress", (_e, d) => cb(d)),',
  '  picnestThemeGet: () => electron.ipcRenderer.invoke("picnest-theme-get"),',
  '  picnestThemeSet: (theme) => electron.ipcRenderer.invoke("picnest-theme-set", theme),',
  '  picnestRootMetaSave: (rootId) => electron.ipcRenderer.invoke("picnest-root-meta-save", rootId),',
  '  picnestRootMetaLoad: (rootId) => electron.ipcRenderer.invoke("picnest-root-meta-load", rootId),',
  '  picnestRootMetaEnsure: (rootId) => electron.ipcRenderer.invoke("picnest-root-meta-ensure", rootId),',
  '  picnestPhysicalOrderImages: (folderId, orderedPaths) => electron.ipcRenderer.invoke("picnest-physical-order-images", folderId, orderedPaths),',
  '  picnestPhysicalOrderDirs: (folderId, parentRel, names) => electron.ipcRenderer.invoke("picnest-physical-order-dirs", folderId, parentRel, names),',
  '  picnestStripOrderPrefixes: (rootId) => electron.ipcRenderer.invoke("picnest-strip-order-prefixes", rootId),',
  '  onPicnestStripPrefixProgress: (cb) => electron.ipcRenderer.on("picnest-strip-prefix-progress", (_e, d) => cb(d)),',
  '  picnestPluginsList: () => electron.ipcRenderer.invoke("picnest-plugins-list"),',
  '  picnestPluginSetEnabled: (id, on) => electron.ipcRenderer.invoke("picnest-plugin-set-enabled", id, on),',
  '  picnestPluginUninstall: (id) => electron.ipcRenderer.invoke("picnest-plugin-uninstall", id),',
  '  picnestPluginPickFolder: () => electron.ipcRenderer.invoke("picnest-plugin-pick-folder"),',
  '  picnestPluginInstallFolder: (srcDir) => electron.ipcRenderer.invoke("picnest-plugin-install-folder", srcDir),',
  '  picnestPluginEntryHtml: (id) => electron.ipcRenderer.invoke("picnest-plugin-entry-html", id),',
  '  picnestPluginThemeCss: (id) => electron.ipcRenderer.invoke("picnest-plugin-theme-css", id),',
  '  picnestPluginStorageGet: (id) => electron.ipcRenderer.invoke("picnest-plugin-storage-get", id),',
  '  picnestPluginStorageSet: (id, value) => electron.ipcRenderer.invoke("picnest-plugin-storage-set", id, value),',
  '  picnestPluginQueryImages: (opts) => electron.ipcRenderer.invoke("picnest-plugin-query-images", opts),',
  '  picnestPluginFetch: (url, init) => electron.ipcRenderer.invoke("picnest-plugin-fetch", url, init),',
  '  picnestPluginRegistryFetch: (url) => electron.ipcRenderer.invoke("picnest-plugin-registry-fetch", url),',
  '  picnestPluginInstallRegistry: (entry) => electron.ipcRenderer.invoke("picnest-plugin-install-registry", entry),',
  '  picnestCopyImages: (paths, targetDir) => electron.ipcRenderer.invoke("picnest-copy-images", paths, targetDir),',
  '  picnestDragBegin: (paths) => electron.ipcRenderer.send("picnest-drag-begin", paths),',
  '  picnestDragEnd: () => electron.ipcRenderer.send("picnest-drag-end"),',
  '  onPicnestDragOutStart: (cb) => electron.ipcRenderer.on("picnest-drag-out-start", () => cb()),',
  '  onPicnestDragOutEnd: (cb) => electron.ipcRenderer.on("picnest-drag-out-end", () => cb()),',
  '  picnestCrop: (filePath, opts) => electron.ipcRenderer.invoke("picnest-crop", filePath, opts),',
  '  picnestCropAs: (filePath, opts) => electron.ipcRenderer.invoke("picnest-crop-as", filePath, opts),',
  '  picnestMkdir: (parentPath, name) => electron.ipcRenderer.invoke("picnest-mkdir", parentPath, name),',
  '  picnestDeleteDir: (dirPath, rel, rootId) => electron.ipcRenderer.invoke("picnest-delete-dir", dirPath, rel, rootId),',
  '  picnestTrashFolders: (folderId) => electron.ipcRenderer.invoke("picnest-trash-folders", folderId),',
  '  picnestTrashRestoreFolder: (id) => electron.ipcRenderer.invoke("picnest-trash-restore-folder", id),',
  '  picnestTrashPurgeFolder: (id) => electron.ipcRenderer.invoke("picnest-trash-purge-folder", id),',
  '  picnestTrashRestoreAll: (folderId) => electron.ipcRenderer.invoke("picnest-trash-restore-all", folderId),',
  '  picnestTrashPurgeAll: (folderId) => electron.ipcRenderer.invoke("picnest-trash-purge-all", folderId),',
  '  picnestRenameLibrary: (id, name, opts) => electron.ipcRenderer.invoke("picnest-rename-library", id, name, opts),',
  '  picnestRemoveRoot: (id) => electron.ipcRenderer.invoke("picnest-remove-root", id),',
  '  picnestCollectSetRoot: (id) => electron.ipcRenderer.invoke("picnest-collect-set-root", id),',
  '  picnestCollectInfo: () => electron.ipcRenderer.invoke("picnest-collect-info"),',
  '  picnestAppVersion: () => electron.ipcRenderer.invoke("picnest-app-version"),',
  '  picnestOpenExternal: (url) => electron.ipcRenderer.invoke("picnest-open-external", url),',
  '  picnestCheckUpdate: (opts) => electron.ipcRenderer.invoke("picnest-check-update", opts),',
  '  picnestDownloadUpdate: (opts) => electron.ipcRenderer.invoke("picnest-download-update", opts),',
  '  picnestCancelDownloadUpdate: () => electron.ipcRenderer.invoke("picnest-cancel-download-update"),',
  '  picnestQuitAndInstall: (opts) => electron.ipcRenderer.invoke("picnest-quit-and-install", opts),',
  '  onPicnestUpdateProgress: (cb) => { const fn = (_e, d) => cb(d); electron.ipcRenderer.on("picnest-update-download-progress", fn); return () => electron.ipcRenderer.removeListener("picnest-update-download-progress", fn); },',
  '  onPicnestUpdateStatus: (cb) => { const fn = (_e, d) => cb(d); electron.ipcRenderer.on("picnest-update-status", fn); return () => electron.ipcRenderer.removeListener("picnest-update-status", fn); },',
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
