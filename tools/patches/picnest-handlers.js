;
/* ==== PicNest:P4 appended handlers — 源文件在 tools/patches/picnest-handlers.js，改后重跑 apply.mjs ==== */

/* P5/P5b: 列迁移（懒执行——模块加载时 db 未初始化，首次用到时补列，幂等） */
let _picnestMigrated = false;
function picnestMigrate() {
  if (_picnestMigrated) return;
  try {
    getDb().exec("ALTER TABLE images ADD COLUMN last_opened_at INTEGER DEFAULT 0");
  } catch (e) {}
  try {
    getDb().exec("ALTER TABLE images ADD COLUMN annotation TEXT DEFAULT ''");
  } catch (e) {}
  try {
    getDb().exec("ALTER TABLE images ADD COLUMN url TEXT DEFAULT ''");
  } catch (e) {}
  try {
    getDb().exec("ALTER TABLE images ADD COLUMN deleted_at INTEGER DEFAULT NULL");
  } catch (e) {}
  try {
    getDb().exec("ALTER TABLE images ADD COLUMN palettes TEXT DEFAULT NULL");
  } catch (e) {}
  try {
    getDb().exec("ALTER TABLE images ADD COLUMN trash_group INTEGER DEFAULT NULL");
  } catch (e) {}
  try {
    getDb().exec(`CREATE TABLE IF NOT EXISTS picnest_trash_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER NOT NULL,
      rel TEXT NOT NULL,
      abs_path TEXT NOT NULL,
      trash_path TEXT NOT NULL,
      name TEXT NOT NULL,
      image_count INTEGER DEFAULT 0,
      size INTEGER DEFAULT 0,
      deleted_at INTEGER NOT NULL
    )`);
  } catch (e) {}
  try { picnestMigrateTextThumbs() } catch (e) {}
  try { picnestMigrateDirOrderKeys() } catch (e) {}
  _picnestMigrated = true;
}
/* 一次性（幂等）清掉旧版文本缩略图：v1 是 400px 直出，大格子下糊；v2 改 800px 重画 */
function picnestMigrateTextThumbs() {
  try {
    const db = getDb();
    const rows = db.prepare("SELECT id, file_path, thumbnail_path FROM images WHERE thumbnail_path IS NOT NULL AND thumbnail_path NOT IN ('', 'SKIP')").all();
    const upd = db.prepare("UPDATE images SET thumbnail_path = '' WHERE id = ?");
    for (const r of rows) {
      if (!PICNEST_TEXT_EXTS.has(path.extname(r.file_path).toLowerCase())) continue;
      if (String(r.thumbnail_path).endsWith(PICNEST_TEXT_THUMB_VER + ".webp")) continue;
      try { if (String(r.thumbnail_path).startsWith(cacheDir)) fs.unlinkSync(r.thumbnail_path) } catch (e) {}
      try { upd.run(r.id) } catch (e) {}
    }
  } catch (e) {}
}

function picnestLikeEscape(s) {
  return String(s).replace(/[\\%_]/g, (m) => "\\" + m);
}

function picnestDirMemoryRead() {
  try {
    const c = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return c.picnestDirMemory || {};
  } catch (e) {
    return {};
  }
}

function picnestDirMemoryWrite(map) {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch (e) {}
  c.picnestDirMemory = map;
  fs.writeFileSync(configPath, JSON.stringify(c, null, 2));
}

/* 目录树：从 images.file_path 派生物理子目录层级 + 递归计数 */
electron.ipcMain.handle("picnest-dir-tree", (_event, folderId) => {
  const root = getDb().prepare("SELECT path FROM folders WHERE id = ?").get(folderId);
  if (!root) return null;
  const rootNorm = root.path.split(/[\\/]+/).join("/");
  const rootDir = { name: path.basename(root.path) || root.path, rel: "", direct: 0, children: {} };
  const dirAt = new Map([["", rootDir]]);
  const rows = getDb().prepare("SELECT file_path FROM images WHERE folder_id = ? AND deleted_at IS NULL").all(folderId);
  for (const r of rows) {
    const abs = r.file_path.split(/[\\/]+/).join("/");
    if (!abs.startsWith(rootNorm + "/")) continue;
    const rel = abs.slice(rootNorm.length + 1);
    const idx = rel.lastIndexOf("/");
    if (idx < 0) continue; /* 根目录散图不算子目录 */
    const dirRel = rel.slice(0, idx);
    if (!dirAt.has(dirRel)) {
      const parts = dirRel.split("/");
      let cur = "";
      for (const part of parts) {
        const parentKey = cur;
        cur = cur ? cur + "/" + part : part;
        if (!dirAt.has(cur)) dirAt.set(cur, (dirAt.get(parentKey).children[part] = { name: part, rel: cur, direct: 0, children: {} }));
        dirAt.set(cur, dirAt.get(cur));
      }
    }
    dirAt.get(dirRel).direct++;
  }
  /* 合并文件系统真实目录：空文件夹也可见（文件夹管理的前提）；图片计数不受影响 */
  const walkFs = (abs, node) => {
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
      let child = node.children[ent.name];
      if (!child) child = node.children[ent.name] = { name: ent.name, direct: 0, children: {} };
      walkFs(path.join(abs, ent.name), child);
    }
  };
  walkFs(root.path, rootDir);
  function toNode(n, rel) {
    const children = Object.values(n.children).map((c) => toNode(c, rel ? rel + "/" + c.name : c.name));
    const order = (picnestDirOrderRead()[picnestOrderKey(folderId, rel)]) || [];
    const rank = (name) => { const i = order.indexOf(name); return i < 0 ? 1e9 + name.length : i; };
    children.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, "zh"));
    let total = n.direct;
    for (const c of children) total += c.total;
    return { name: n.name, rel, count: n.direct, total, children };
  }
  return { rootPath: root.path, tree: toNode(rootDir, ""), orphanFiles: rows.length - Object.values(dirAt).reduce((s, d) => s + d.direct, 0) };
});

/* 文件夹统计（详情面板：单选/多选文件夹 → 文件数/占用空间/添加日期；union 去重，rel "" = 库根） */
electron.ipcMain.handle("picnest-dir-stats", (_event, folderId, rels) => {
  try {
    const root = getDb().prepare("SELECT path FROM folders WHERE id = ?").get(folderId);
    if (!root) return { ok: false, error: "资料库不存在" };
    const sep = root.path.includes("\\") ? "\\" : "/";
    const list = Array.isArray(rels) && rels.length ? rels : [""];
    const pats = list.map((rel) => {
      const r = String(rel || "").replace(/^\/+|\/+$/g, "");
      return r
        ? picnestLikeEscape(root.path + sep + r.split("/").join(sep) + sep) + "%"
        : picnestLikeEscape(root.path + sep) + "%";
    });
    const where = pats.map(() => "file_path LIKE ? ESCAPE '\\'").join(" OR ");
    const row = getDb().prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(file_size), 0) AS size
       FROM images WHERE folder_id = ? AND deleted_at IS NULL AND (${where})`
    ).get(folderId, ...pats);
    /* 添加日期 = 物理目录创建时间（图片行没有 added_at 列） */
    let createdAt = 0;
    if (list.length === 1) {
      try {
        const r0 = String(list[0] || "").replace(/^\/+|\/+$/g, "");
        const abs = r0 ? path.join(root.path, r0.split("/").join(sep)) : root.path;
        const st = fs.statSync(abs);
        createdAt = st.birthtimeMs || st.mtimeMs || 0;
      } catch (e) { /* 目录不存在时忽略 */ }
    }
    return { ok: true, count: row?.count || 0, size: row?.size || 0, createdAt };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

/* 某子目录下的图片分页（dirRel 用 "/" 分隔，"" = 根层直属文件） */
electron.ipcMain.handle("picnest-images-by-dir", (_event, folderId, dirRel, offset, limit, sortMode, sortAsc, recursive) => {
  picnestMigrate();
  const root = getDb().prepare("SELECT path FROM folders WHERE id = ?").get(folderId);
  if (!root) return [];
  const sep = root.path.includes("\\") ? "\\" : "/";
  const rootEsc = picnestLikeEscape(root.path + sep);
  let pattern = picnestLikeEscape(root.path + sep + (dirRel && dirRel !== "__loose__" ? dirRel.split("/").join(sep) + sep : "")) + "%";
  const looseOnly = dirRel === "__loose__";
  if (looseOnly) pattern = rootEsc + "%";
  /* recursive=false：只要该层直属图片（空 dirRel = 库根直属） */
  const directOnly = recursive === false && dirRel !== "__loose__";
  const directBase = root.path + sep + (dirRel ? dirRel.split("/").join(sep) + sep : "");
  const deeperPattern = directOnly
    ? picnestLikeEscape(directBase) + "%" + picnestLikeEscape(sep) + "%"
    : null;
  /* 排序：name/added/mtime/size 走 SQL（sortAsc 控制方向），dims/rating 等暂回退 id ASC。
     全部视图（dirRel 空）由渲染层强制传 added → id DESC = 最新入库置顶 */
  const dirWord = (ascDefault) => (sortAsc === undefined || sortAsc === null ? ascDefault : sortAsc) ? "ASC" : "DESC";
  const order = sortMode === "manual" ? "(sort_order = 0) DESC, sort_order ASC, id DESC"
    : sortMode === "name" ? `file_name COLLATE NOCASE ${dirWord(true)}`
    : sortMode === "added" ? `id ${dirWord(false)}`
    : sortMode === "mtime" ? `modify_time ${dirWord(false)}`
    : sortMode === "size" ? `file_size ${dirWord(false)}`
    : "id ASC";
  const rows = looseOnly
    ? getDb().prepare(
      `SELECT id, file_path, file_name, file_size, modify_time, width, height, thumbnail_path, is_favorite
       FROM images WHERE folder_id = ? AND deleted_at IS NULL AND file_path LIKE ? ESCAPE '\\' AND file_path NOT LIKE ? ESCAPE '\\' ORDER BY ${order} LIMIT ? OFFSET ?`
    ).all(folderId, pattern, rootEsc + "%" + picnestLikeEscape(sep) + "%", limit, offset)
    : directOnly
      ? getDb().prepare(
        `SELECT id, file_path, file_name, file_size, modify_time, width, height, thumbnail_path, is_favorite
         FROM images WHERE folder_id = ? AND deleted_at IS NULL AND file_path LIKE ? ESCAPE '\\' AND file_path NOT LIKE ? ESCAPE '\\' ORDER BY ${order} LIMIT ? OFFSET ?`
      ).all(folderId, pattern, deeperPattern, limit, offset)
      : getDb().prepare(
        `SELECT id, file_path, file_name, file_size, modify_time, width, height, thumbnail_path, is_favorite
         FROM images WHERE folder_id = ? AND deleted_at IS NULL AND file_path LIKE ? ESCAPE '\\' ORDER BY ${order} LIMIT ? OFFSET ?`
      ).all(folderId, pattern, limit, offset);
  const valid = [];
  for (const img of rows) {
    const ext = path.extname(img.file_path).toLowerCase();
    const isText = PICNEST_TEXT_EXTS.has(ext);
    /* 文本被外部改过：源文件 mtime 晚于纸面缩略图 → 判失效，删缓存等渲染层重画 */
    if (isText && img.thumbnail_path) {
      try {
        const srcMs = fs.statSync(img.file_path).mtimeMs;
        const thumbMs = fs.statSync(img.thumbnail_path).mtimeMs;
        if (srcMs > thumbMs + 1500) {
          try { fs.unlinkSync(img.thumbnail_path) } catch (e) {}
          try { getDb().prepare("UPDATE images SET thumbnail_path = '' WHERE id = ?").run(img.id) } catch (e) {}
          img.thumbnail_path = "";
        }
      } catch (e) { /* 文件/缩略图缺失下面统一处理 */ }
    }
    if (img.thumbnail_path && !fs.existsSync(img.thumbnail_path)) img.thumbnail_path = "";
    /* 文本不走 discover：旧版 md5.webp 可能是 v1 残留，交给 v2 生成器重画 */
    if (!img.thumbnail_path && !isText) img.thumbnail_path = discoverThumbnailPath(img.file_path) || "";
    if (!fs.existsSync(img.file_path)) { deleteImageByPath(img.file_path); continue; }
    valid.push(img);
  }
  return valid;
});

/* 全部 / 最近使用 */
electron.ipcMain.handle("picnest-count-all", (_event, folderId) => {
  return getDb().prepare("SELECT COUNT(*) AS c FROM images WHERE folder_id = ? AND deleted_at IS NULL").get(folderId).c;
});
electron.ipcMain.handle("picnest-recent", (_event, folderId, limit) => {
  picnestMigrate();
  return getDb().prepare(
    `SELECT id, file_path, file_name, file_size, modify_time, width, height, thumbnail_path, is_favorite, last_opened_at
     FROM images WHERE folder_id = ? AND deleted_at IS NULL AND last_opened_at > 0 ORDER BY last_opened_at DESC LIMIT ?`
  ).all(folderId, limit);
});
electron.ipcMain.handle("picnest-image-opened", (_event, filePath) => {
  picnestMigrate();
  getDb().prepare("UPDATE images SET last_opened_at = ? WHERE file_path = ?").run(Date.now(), filePath);
  return true;
});

/* P5b: 注释/URL 列（幂等，为 Inspector 与 Eagle 迁移预留） */
try { getDb().exec("ALTER TABLE images ADD COLUMN annotation TEXT DEFAULT ''"); } catch (e) {}
try { getDb().exec("ALTER TABLE images ADD COLUMN url TEXT DEFAULT ''"); } catch (e) {}

electron.ipcMain.handle("picnest-reveal", (_event, filePath) => {
  electron.shell.showItemInFolder(filePath);
  return true;
});
electron.ipcMain.handle("picnest-set-image-meta", (_event, filePath, patch) => {
  picnestMigrate();
  const allow = ["annotation", "url"];
  for (const k of allow) {
    if (k in patch) getDb().prepare(`UPDATE images SET ${k} = ? WHERE file_path = ?`).run(String(patch[k] ?? ""), filePath);
  }
  return true;
});
electron.ipcMain.handle("picnest-get-image-meta", (_event, filePath) => {
  picnestMigrate();
  return getDb().prepare("SELECT annotation, url FROM images WHERE file_path = ?").get(filePath) || { annotation: "", url: "" };
});

/* 缩略图存量收割：按 PicRand 的 md5 缓存寻址规则查现有缩略图文件，不生成，只找回 */
electron.ipcMain.handle("picnest-thumb-lookup", (_event, paths) => {
  const out = {};
  for (const fp of paths) {
    try {
      const ext = path.extname(fp).toLowerCase();
      const hashName = crypto.createHash("md5").update(fp).digest("hex") + ext;
      const candidates = [hashName, hashName.replace(ext, ".webp"), hashName.replace(ext, ".jpg")];
      for (const c of candidates) {
        const p = path.join(cacheDir, c);
        if (fs.existsSync(p)) { out[fp] = p; break; }
      }
    } catch (e) { /* 单个失败不影响其它 */ }
  }
  return out;
});

/* 文本类白名单（渲染层同名判定见 ui/src/lib/fileKinds.js，两侧需同步） */
const PICNEST_TEXT_EXTS = new Set([".txt", ".md", ".markdown", ".log", ".json", ".jsonc", ".csv", ".tsv", ".ini", ".cfg", ".conf", ".yaml", ".yml"]);

/* ---- 文本类：读取 / 保存 / 文字缩略图 ---- */
const PICNEST_TEXT_MAX_BYTES = 2 * 1024 * 1024;
/* 缩略图版本：2 倍渲染（800×1040）保证大格子下文字不糊；版本号进缓存名，旧图自动失效 */
const PICNEST_TEXT_THUMB_VER = "-v2";
function picnestTextThumbPath(fp) {
  return path.join(cacheDir, crypto.createHash("md5").update(fp).digest("hex") + PICNEST_TEXT_THUMB_VER + ".webp");
}
function picnestDecodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { content: buf.subarray(3).toString("utf8"), encoding: "UTF-8 BOM" };
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { content: buf.subarray(2).toString("utf16le"), encoding: "UTF-16LE" };
  try { new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, Math.min(buf.length, 65536))); return { content: new TextDecoder("utf-8").decode(buf), encoding: "UTF-8" }; } catch (e) { /* 非 UTF-8：按 GB18030 */ }
  try { return { content: new TextDecoder("gb18030").decode(buf), encoding: "GB18030" }; } catch (e) { /* 再退 UTF-8 宽松 */ }
  return { content: buf.toString("utf8"), encoding: "UTF-8" };
}
function picnestTextThumbSvg(title, extLabel, meta, lines) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  /* 按显示宽度裁剪（CJK 记 2 单位）：800px 画布、19px 等宽，62 单位约 707px，不越过右缘 */
  const clipW = (s, maxU) => {
    let u = 0, out = "";
    for (const ch of String(s)) {
      u += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
      if (u > maxU) return out + "…";
      out += ch;
    }
    return out;
  };
  const rows = lines.slice(0, 26).map((l, i) => `<text x="44" y="${152 + i * 32}" font-family="Microsoft YaHei, Consolas, monospace" font-size="19" fill="#3d372f">${esc(clipW(l.replace(/\t/g, "  ").trimEnd(), 62))}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1040">
    <rect width="800" height="1040" fill="#f7f3ea"/>
    <rect width="800" height="80" fill="#ece4d5"/>
    <text x="36" y="50" font-family="Microsoft YaHei, Segoe UI, sans-serif" font-size="26" font-weight="600" fill="#4a4238">${esc(clipW(title, 42))}</text>
    <text x="764" y="50" text-anchor="end" font-family="Consolas, monospace" font-size="18" fill="#8a7c68">${esc(extLabel)}</text>
    <line x1="36" y1="108" x2="764" y2="108" stroke="#d8cfbd"/>
    <text x="764" y="1004" text-anchor="end" font-family="Consolas, monospace" font-size="15" fill="#a2947e">${esc(meta)}</text>
    ${rows}
  </svg>`;
}
electron.ipcMain.handle("picnest-read-text", (_event, filePath) => {
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (!PICNEST_TEXT_EXTS.has(ext)) return { ok: false, error: "不是文本文件" };
    const st = fs.statSync(filePath);
    const truncated = st.size > PICNEST_TEXT_MAX_BYTES;
    const len = Math.min(st.size, PICNEST_TEXT_MAX_BYTES);
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(len);
    try { fs.readSync(fd, buf, 0, len, 0); } finally { fs.closeSync(fd); }
    const dec = picnestDecodeText(buf);
    return { ok: true, content: dec.content, encoding: dec.encoding, eol: dec.content.includes("\r\n") ? "\r\n" : "\n", size: st.size, mtimeMs: st.mtimeMs, truncated };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
electron.ipcMain.handle("picnest-save-text", (_event, filePath, content, expectedMtimeMs) => {
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (!PICNEST_TEXT_EXTS.has(ext)) return { ok: false, error: "不是文本文件" };
    if (!fs.existsSync(filePath)) return { ok: false, error: "文件不存在" };
    if (expectedMtimeMs) {
      const cur = fs.statSync(filePath).mtimeMs;
      if (Math.abs(cur - expectedMtimeMs) > 1500) return { ok: false, conflict: true, error: "文件已被外部修改" };
    }
    const tmp = filePath + ".picnest-tmp";
    fs.writeFileSync(tmp, Buffer.from(String(content == null ? "" : content), "utf8"));
    fs.renameSync(tmp, filePath);
    const st = fs.statSync(filePath);
    try { getDb().prepare("UPDATE images SET file_size = ?, modify_time = ? WHERE file_path = ?").run(st.size, Math.floor(st.mtimeMs / 1e3), filePath); } catch (e) {}
    /* 文本缩略图缓存失效：内容变了，纸面预览要重画（渲染层随后调 text-thumbnails 重建） */
    try {
      const thumb = picnestTextThumbPath(filePath);
      if (fs.existsSync(thumb)) fs.unlinkSync(thumb);
      getDb().prepare("UPDATE images SET thumbnail_path = '' WHERE file_path = ?").run(filePath);
    } catch (e) {}
    return { ok: true, size: st.size, mtimeMs: st.mtimeMs, encoding: "UTF-8" };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
electron.ipcMain.handle("picnest-text-thumbnails", async (_event, paths) => {
  const results = [], errors = [];
  let sharp;
  try { sharp = (await import("sharp")).default; } catch (e) { return { results: (paths || []).map((p) => ({ file_path: p, thumbnail_path: "" })), errors: ["sharp unavailable"] }; }
  for (const fp of paths || []) {
    try {
      const ext = path.extname(fp).toLowerCase();
      if (!PICNEST_TEXT_EXTS.has(ext)) { results.push({ file_path: fp, thumbnail_path: "" }); continue; }
      const out = picnestTextThumbPath(fp);
      if (!fs.existsSync(out)) {
        const st = fs.statSync(fp);
        const len = Math.min(st.size, 65536);
        const fd = fs.openSync(fp, "r");
        const buf = Buffer.alloc(len);
        try { fs.readSync(fd, buf, 0, len, 0); } finally { fs.closeSync(fd); }
        const dec = picnestDecodeText(buf);
        const lines = dec.content.split(/\r?\n/).slice(0, 40);
        const sizeText = st.size >= 1048576 ? (st.size / 1048576).toFixed(1) + " MB" : st.size >= 1024 ? (st.size / 1024).toFixed(1) + " KB" : st.size + " B";
        const svg = picnestTextThumbSvg(path.basename(fp), ext.slice(1).toUpperCase(), `${sizeText} · ${dec.encoding}`, lines);
        await sharp(Buffer.from(svg)).webp({ quality: 82 }).toFile(out);
      }
      try { getDb().prepare("UPDATE images SET thumbnail_path = ?, width = 800, height = 1040 WHERE file_path = ?").run(out, fp); } catch (e) {}
      results.push({ file_path: fp, thumbnail_path: out, width: 800, height: 1040, is_text: true });
    } catch (e) {
      errors.push(path.basename(fp));
      results.push({ file_path: fp, thumbnail_path: "" });
    }
  }
  return { results, errors };
});

/* 外部拖入：目录→返回待处理；图片/视频/文本→复制进目标目录（撞名加序号），watcher 自动入库 */
const PICNEST_DROP_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".tif", ".avif", ".svg", ".psd", ".heic", ".heif", ".mp4", ".webm", ".mov", ".mkv", ".avi", ".flv", ".f4v", ...PICNEST_TEXT_EXTS]);
const PICNEST_DROP_JUNK = new Set(["thumbs.db", "desktop.ini"]);
electron.ipcMain.handle("picnest-import-files", async (_event, paths, targetDir) => {
  const IMG_EXTS = PICNEST_DROP_EXTS;
  const dirs = [];
  const unsupportedNames = [];
  let copied = 0, failed = 0, skipped = 0, unsupported = 0;
  try {
    if (!fs.existsSync(targetDir)) return { ok: false, error: "目标目录不存在", dirs: [] };
    for (const p of paths || []) {
      try {
        if (!p || !fs.existsSync(p)) { failed++; continue; }
        const st = fs.statSync(p);
        if (st.isDirectory()) { dirs.push(p); continue; }
        const ext = path.extname(p).toLowerCase();
        if (!IMG_EXTS.has(ext) || PICNEST_DROP_JUNK.has(path.basename(p).toLowerCase())) {
          unsupported++;
          if (unsupportedNames.length < 12) unsupportedNames.push(path.basename(p));
          continue;
        }
        const sameName = path.join(targetDir, path.basename(p));
        if (fs.existsSync(sameName) && fs.statSync(sameName).size === st.size) { skipped++; continue; } // Eagle 式：同名同大小 = 重复，跳过
        let target = path.join(targetDir, path.basename(p));
        let n = 1;
        const stem = path.basename(p, ext);
        while (fs.existsSync(target)) { target = path.join(targetDir, `${stem} (${n})${ext}`); n++; }
        fs.copyFileSync(p, target);
        copied++;
      } catch (e) { failed++; }
    }
    return { ok: true, dirs, copied, failed, skipped, unsupported, unsupportedNames };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), dirs: [] };
  }
});

/* 外部拖入文件夹（PicNest P7）：复制为目标目录下的同名子文件夹（保留内部结构，仅收录图片/视频）
   目标同名文件夹 → 合并；同名同大小 → 跳过；同名不同内容 → 加序号。空目录不落盘。 */
electron.ipcMain.handle("picnest-import-dir-copy", async (_event, srcDir, targetDir, opts) => {
  const detail = {
    ok: false, name: "", dest: "", copied: 0, skipped: 0, failed: 0,
    unsupported: 0, unsupportedNames: [], dirsCreated: 0, created: false, replaced: 0, policy: "",
  };
  const o = opts || {};
  const policy = o.policy || ""; // skip | keep-both | replace（空 = 未做库内查重）
  const dupeMap = new Map();
  for (const d of Array.isArray(o.dupes) ? o.dupes : []) {
    if (d && d.src) dupeMap.set(String(d.src).toLowerCase(), d.old || "");
  }
  detail.policy = policy;
  try {
    if (!srcDir || !fs.existsSync(srcDir)) return { ...detail, error: "源文件夹不存在" };
    if (!fs.existsSync(targetDir)) return { ...detail, error: "目标目录不存在" };
    if (!fs.statSync(srcDir).isDirectory()) return { ...detail, error: "不是文件夹" };
    /* 防自包含递归：目标在源内（含相同）时拒绝 */
    const normPath = (p) => path.resolve(p).toLowerCase();
    const srcNorm = normPath(srcDir);
    const dstNorm = normPath(targetDir);
    if (dstNorm === srcNorm || dstNorm.startsWith(srcNorm + path.sep)) {
      return { ...detail, error: "不能把文件夹复制进自身或其子目录" };
    }
    const base = path.basename(srcDir).replace(/[\\/:*?"<>|]/g, "_") || "导入文件夹";
    let dest = path.join(targetDir, base);
    for (let n = 1; fs.existsSync(dest) && !fs.statSync(dest).isDirectory(); n++) {
      dest = path.join(targetDir, base + " (" + n + ")");
    }
    const destExisted = fs.existsSync(dest); // 同名目录 → 合并，不新开 (n)
    const madeDirs = new Set();
    const ensureDir = (abs) => {
      if (fs.existsSync(abs)) return;
      fs.mkdirSync(abs, { recursive: true });
      madeDirs.add(abs);
    };
    const unsupportedAt = (relName) => {
      detail.unsupported++;
      if (detail.unsupportedNames.length < 12) detail.unsupportedNames.push(relName);
    };
    const oldToTrash = [];
    const walk = (from, to, relPrefix) => {
      let entries = [];
      try { entries = fs.readdirSync(from, { withFileTypes: true }); }
      catch (e) { detail.failed++; return; }
      for (const ent of entries) {
        if (ent.name.startsWith(".")) continue; // 隐藏文件/目录
        const srcPath = path.join(from, ent.name);
        const relName = relPrefix ? relPrefix + "/" + ent.name : ent.name;
        if (ent.isDirectory()) { walk(srcPath, path.join(to, ent.name), relName); continue; }
        const lower = ent.name.toLowerCase();
        const ext = path.extname(lower);
        if (PICNEST_DROP_JUNK.has(lower)) continue;
        if (!PICNEST_DROP_EXTS.has(ext)) { unsupportedAt(relName); continue; }
        const srcKey = path.resolve(srcPath).toLowerCase();
        const dup = dupeMap.has(srcKey);
        if (policy === "skip" && dup) { detail.skipped++; continue; }
        try {
          const st = fs.statSync(srcPath);
          let finalDst = path.join(to, ent.name);
          const force = dup && (policy === "keep-both" || policy === "replace");
          if (fs.existsSync(finalDst)) {
            let sameSize = false;
            try { sameSize = fs.statSync(finalDst).size === st.size; } catch (e) { /* 不可读按冲突处理 */ }
            /* 同名同大小：按内容判断（合并同一文件夹时天然跳过；同名不同内容加序号） */
            if (sameSize) {
              let sameContent = false;
              try {
                const m1 = picnestMd5(srcPath);
                const m2 = m1 ? picnestMd5(finalDst) : null;
                sameContent = !!m1 && m1 === m2;
              } catch (e) { /* 读失败按不同内容处理 */ }
              if (sameContent && !force) { detail.skipped++; continue; }
            }
            const stem = path.basename(ent.name, path.extname(ent.name));
            for (let n = 1; fs.existsSync(finalDst); n++) {
              finalDst = path.join(to, stem + " (" + n + ")" + path.extname(ent.name));
            }
          }
          ensureDir(to);
          fs.copyFileSync(srcPath, finalDst);
          detail.copied++;
          if (policy === "replace" && dup) {
            const old = dupeMap.get(srcKey);
            if (old) {
              const oldNorm = path.resolve(old).toLowerCase();
              if (oldNorm !== path.resolve(finalDst).toLowerCase() && oldNorm !== path.resolve(srcPath).toLowerCase()) {
                oldToTrash.push(old);
              }
            }
          }
        } catch (e) { detail.failed++; }
      }
    };
    walk(srcDir, dest, "");
    if (oldToTrash.length) {
      const seen = new Set();
      for (const old of oldToTrash) {
        const key = path.resolve(old).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          await electron.shell.trashItem(old);
          getDb().prepare("DELETE FROM images WHERE file_path = ?").run(old);
          detail.replaced++;
        } catch (e) { detail.failed++; }
      }
    }
    detail.ok = true;
    detail.name = path.basename(dest);
    detail.dest = dest;
    detail.dirsCreated = madeDirs.size;
    detail.created = !destExisted && detail.copied > 0;
    if (!detail.copied && !detail.skipped && !detail.failed && !detail.unsupported) detail.empty = true;
    return detail;
  } catch (e) {
    return { ...detail, error: String(e?.message || e) };
  }
});

/* 文件夹放入前的库内查重：按文件大小筛候选 → MD5 确认；跳过自身与“目标同名位置”的噪声重复 */
electron.ipcMain.handle("picnest-dir-dup-check", (_event, srcDir, targetDir, folderId) => {
  const out = { ok: false, count: 0, scanned: 0, items: [] };
  try {
    if (!srcDir || !fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) return { ...out, error: "源文件夹不存在" };
    const norm = (p) => path.resolve(p).toLowerCase();
    const destRoot = path.join(targetDir, path.basename(srcDir).replace(/[\\/:*?"<>|]/g, "_"));
    const walk = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const ent of entries) {
        if (ent.name.startsWith(".")) continue;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) { walk(p); continue; }
        const ext = path.extname(ent.name).toLowerCase();
        if (!PICNEST_DROP_EXTS.has(ext) || PICNEST_DROP_JUNK.has(ent.name.toLowerCase())) continue;
        out.scanned++;
        let st;
        try { st = fs.statSync(p); } catch (e) { continue; }
        const cands = getDb().prepare(
          "SELECT file_path, file_name, width, height FROM images WHERE file_size = ? AND folder_id = ? AND deleted_at IS NULL LIMIT 8"
        ).all(st.size, folderId);
        if (!cands.length) continue;
        const md5 = picnestMd5(p);
        if (!md5) continue;
        const destPath = path.join(destRoot, path.relative(srcDir, p));
        /* 目标同名位置已有同内容文件 → 合并时天然跳过，不算待处理重复；
           否则报告库内其他位置的同内容文件 */
        let atDest = false;
        let hit = null;
        for (const c of cands) {
          const same = norm(c.file_path) === norm(p);
          const isDest = norm(c.file_path) === norm(destPath);
          if (same && !isDest) continue; // 自己（且不是目标同位）
          if (!fs.existsSync(c.file_path)) continue;
          if (picnestMd5(c.file_path) !== md5) continue;
          if (isDest) { atDest = true; break; }
          if (!hit) hit = c;
        }
        if (atDest || !hit) continue;
        out.count++;
        out.items.push({
          src: p, name: ent.name, size: st.size,
          existing: {
            file_path: hit.file_path, file_name: hit.file_name,
            width: hit.width, height: hit.height,
            folderName: path.basename(path.dirname(hit.file_path)),
          },
        });
      }
    };
    walk(srcDir);
    out.ok = true;
    return out;
  } catch (e) {
    return { ...out, error: String(e?.message || e) };
  }
});

/* 复制粘贴：图片文件复制到目标目录（永远生成副本，同名加序号；不查重） */
electron.ipcMain.handle("picnest-copy-images", async (_event, paths, targetDir) => {
  let copied = 0, failed = 0;
  try {
    if (!fs.existsSync(targetDir)) return { ok: false, error: "目标目录不存在" };
    for (const p of paths || []) {
      try {
        if (!p || !fs.existsSync(p)) { failed++; continue; }
        const st = fs.statSync(p);
        if (!st.isFile()) { failed++; continue; }
        const ext = path.extname(p).toLowerCase();
        if (!PICNEST_DROP_EXTS.has(ext)) { failed++; continue; }
        const stem = path.basename(p, ext);
        let target = path.join(targetDir, path.basename(p));
        for (let n = 1; fs.existsSync(target); n++) target = path.join(targetDir, stem + " (" + n + ")" + ext);
        fs.copyFileSync(p, target);
        copied++;
      } catch (e) { failed++; }
    }
    return { ok: failed === 0, copied, failed };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), copied, failed };
  }
});

/* 手动排序：把当前文件夹的可见顺序写进 images.sort_order（未排序=0 的排最后） */
electron.ipcMain.handle("picnest-images-reorder", (_event, folderId, dirRel, orderedPaths) => {
  try {
    const db = getDb();
    const upd = db.prepare("UPDATE images SET sort_order = ? WHERE file_path = ? AND folder_id = ?");
    const list = Array.isArray(orderedPaths) ? orderedPaths : [];
    const tx = db.transaction(() => {
      list.forEach((p, i) => upd.run(i + 1, p, folderId));
    });
    tx();
    return { ok: true, count: list.length };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

/* 浏览器拖图入库：下载 URL 到目标目录（Eagle 同款细节；同名不同内容自动加序号） */
electron.ipcMain.handle("picnest-import-urls", async (_event, urls, targetDir) => {
  let downloaded = 0, failed = 0;
  try {
    if (!fs.existsSync(targetDir)) return { ok: false, error: "目标目录不存在" };
    for (const u of (urls || []).slice(0, 20)) {
      try {
        if (!/^https?:\/\//i.test(u)) { failed++; continue; }
        const res = await fetch(u, { signal: AbortSignal.timeout(60000) });
        if (!res.ok) { failed++; continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        let name = decodeURIComponent((u.split("?")[0].split("#")[0].split("/").pop() || "")).trim();
        if (!name || name.length > 120 || !path.extname(name)) name = `drag-${Date.now()}-${downloaded + 1}.jpg`;
        name = name.replace(/[\/:*?"<>|]/g, "_");
        let target = path.join(targetDir, name);
        let n = 1;
        const stem = path.basename(name, path.extname(name));
        const ext = path.extname(name);
        while (fs.existsSync(target)) { target = path.join(targetDir, `${stem} (${n})${ext}`); n++; }
        fs.writeFileSync(target, buf);
        downloaded++;
      } catch (e) { failed++; }
    }
    return { ok: true, downloaded, failed };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

/* Eagle 式全库查重：先按大小筛候选，再 MD5 确认同内容 */
function picnestMd5(fp) {
  try {
    const buf = fs.readFileSync(fp);
    return crypto.createHash("md5").update(buf).digest("hex");
  } catch (e) { return null; }
}
electron.ipcMain.handle("picnest-import-check", async (_event, paths, folderId) => {
  const clean = [];
  const conflicts = [];
  const dirs = [];
  const missing = [];
  for (const p of paths || []) {
    try {
      if (!p || !fs.existsSync(p)) { missing.push(p); continue; }
      const st = fs.statSync(p);
      if (st.isDirectory()) { dirs.push(p); continue; } // 目录走子文件夹复制流程
      const size = st.size;
      const cands = getDb().prepare(
        "SELECT i.file_path, i.file_name, i.width, i.height, f.path AS folder_path, f.display_name FROM images i JOIN folders f ON f.id = i.folder_id WHERE i.file_size = ? AND i.folder_id = ? AND i.deleted_at IS NULL LIMIT 6"
      ).all(size, folderId);
      let existing = null;
      const md5New = picnestMd5(p);
      for (const c of cands) {
        if (!fs.existsSync(c.file_path)) continue;
        if (picnestMd5(c.file_path) === md5New) { existing = c; break; }
      }
      if (existing) {
        conflicts.push({
          path: p, name: path.basename(p), size,
          existing: {
            file_path: existing.file_path, file_name: existing.file_name,
            width: existing.width, height: existing.height,
            folderName: existing.display_name || existing.folder_path.split("\\").pop(),
          },
        });
      } else {
        clean.push(p);
      }
    } catch (e) { missing.push(p); /* 单个失败不阻塞 */ }
  }
  return { clean, conflicts, dirs, missing };
});

/* 裁切（Eagle 语义）：原地替换 + 原件自动备份进缓存（可找回） + 缩略图/色板失效重建 */
electron.ipcMain.handle("picnest-crop", async (_event, filePath, opts) => {
  try {
    const sharp = (await import("sharp")).default;
    const o = opts || {};
    const meta = await sharp(filePath).metadata();
    const left = Math.max(0, Math.min(Math.round(o.left || 0), meta.width - 1));
    const top = Math.max(0, Math.min(Math.round(o.top || 0), meta.height - 1));
    const width = Math.max(1, Math.min(Math.round(o.width || meta.width), meta.width - left));
    const height = Math.max(1, Math.min(Math.round(o.height || meta.height), meta.height - top));
    const buf = await sharp(filePath).extract({ left, top, width, height }).toBuffer();
    // 原件备份进缓存目录
    const ext = path.extname(filePath);
    const key = crypto.createHash("md5").update(filePath).digest("hex");
    const backup = path.join(cacheDir, "crop-backup-" + key + "-" + Date.now() + ext);
    fs.copyFileSync(filePath, backup);
    // 原子覆写
    const tmp = filePath + ".cropping";
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, filePath);
    // DB：新尺寸 + 色板失效
    getDb().prepare("UPDATE images SET width = ?, height = ?, palettes = NULL WHERE file_path = ?").run(width, height, filePath);
    // 缩略图缓存失效（md5 寻址的三种变体全清）
    for (const suffix of [ext, ".webp", ".jpg"]) {
      const t = path.join(cacheDir, key + suffix);
      if (fs.existsSync(t)) { try { fs.unlinkSync(t); } catch (e) {} }
    }
    return { ok: true, width, height, backup };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

/* 裁切另存为：新文件写进原目录（直链索引自动入库），原图不动；重名自动 -2/-3 递增 */
electron.ipcMain.handle("picnest-crop-as", async (_event, filePath, opts) => {
  try {
    const sharp = (await import("sharp")).default;
    const o = opts || {};
    const meta = await sharp(filePath).metadata();
    const left = Math.max(0, Math.min(Math.round(o.left || 0), meta.width - 1));
    const top = Math.max(0, Math.min(Math.round(o.top || 0), meta.height - 1));
    const width = Math.max(1, Math.min(Math.round(o.width || meta.width), meta.width - left));
    const height = Math.max(1, Math.min(Math.round(o.height || meta.height), meta.height - top));
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);
    let finalPath = path.join(dir, base + "-cropped" + ext);
    for (let i = 2; fs.existsSync(finalPath); i++) finalPath = path.join(dir, base + "-cropped-" + i + ext);
    const buf = await sharp(filePath).extract({ left, top, width, height }).toBuffer();
    const tmp = finalPath + ".cropping";
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, finalPath);
    return { ok: true, path: finalPath, width, height };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

/* 保存旋转/翻转：写回原图（先备份到缓存），并让缩略图/色板失效重算 */
electron.ipcMain.handle("picnest-apply-transform", async (_event, filePath, opts) => {
  try {
    const sharp = (await import("sharp")).default;
    const rot = ((Math.round(Number(opts?.rot) || 0) % 360) + 360) % 360;
    const flopX = !!opts?.flopX;
    if (!rot && !flopX) return { ok: true, changed: false };
    if (!fs.existsSync(filePath)) return { ok: false, error: "文件不存在" };
    const ext = path.extname(filePath).toLowerCase();
    let pipe = sharp(filePath);
    if (flopX) pipe = pipe.flop(); // CSS 是 scaleX(-1) 后再 rotate，这里同序
    if (rot) pipe = pipe.rotate(rot);
    const buf = await pipe.toBuffer();
    const key = crypto.createHash("md5").update(filePath).digest("hex");
    const backup = path.join(cacheDir, `transform-backup-${key}-${Date.now()}${ext}`);
    try { fs.copyFileSync(filePath, backup) } catch (e) {}
    const tmp = filePath + ".picnest-transform-tmp";
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, filePath);
    const m = await sharp(filePath).metadata();
    const st = fs.statSync(filePath);
    const width = m.width || 0;
    const height = m.height || 0;
    try {
      getDb().prepare(
        "UPDATE images SET width = ?, height = ?, file_size = ?, modify_time = ?, palettes = NULL, thumbnail_path = '' WHERE file_path = ?"
      ).run(width, height, st.size, Math.floor(st.mtimeMs / 1e3), filePath);
    } catch (e) {}
    for (const suffix of [ext, ".webp", ".jpg"]) {
      const t = path.join(cacheDir, key + suffix);
      if (fs.existsSync(t)) { try { fs.unlinkSync(t); } catch (e) {} }
    }
    return { ok: true, changed: true, width, height, size: st.size, backup };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* 兄弟排序关系（文件系统无顺序，存 config；key: 父目录 rel，根层用 __root__） */
function picnestDirOrderRead() {
  try { return JSON.parse(fs.readFileSync(configPath, "utf-8")).picnestDirOrder || {} } catch (e) { return {} }
}
/* 目录排序键按资料库隔离：`<folderId>|<rel>`（旧版只有 rel，会跨库串味） */
function picnestOrderKey(folderId, rel) { return `${folderId}|${rel || "__root__"}`; }
function picnestRootIdByPath(absPath) {
  try {
    const p = String(absPath || "").replace(/\//g, "\\").toLowerCase();
    const rows = getDb().prepare("SELECT id, path FROM folders").all();
    let best = null;
    for (const r of rows) {
      const rp = String(r.path || "").replace(/\//g, "\\").toLowerCase().replace(/\\+$/, "");
      if (!rp) continue;
      if (p === rp || p.startsWith(rp + "\\")) {
        if (!best || rp.length > best.rp.length) best = { id: r.id, rp };
      }
    }
    return best ? best.id : null;
  } catch (e) { return null; }
}
/* 旧版全局排序键一次性迁移：复制到每个资料库的隔离键（不动旧键，便于回滚） */
function picnestMigrateDirOrderKeys() {
  try {
    const c = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const map = c.picnestDirOrder || {};
    const roots = getDb().prepare("SELECT id FROM folders").all();
    let changed = false;
    for (const r of roots) {
      for (const [k, v] of Object.entries(map)) {
        if (k.includes("|")) continue;
        const nk = picnestOrderKey(r.id, k === "__root__" ? "" : k);
        if (!(nk in map)) { map[nk] = v; changed = true; }
      }
    }
    if (changed) { c.picnestDirOrder = map; fs.writeFileSync(configPath, JSON.stringify(c, null, 2)); }
  } catch (e) {}
}
electron.ipcMain.handle("picnest-dir-order-get", () => picnestDirOrderRead());
electron.ipcMain.handle("picnest-dir-order-set", (_event, folderId, parentKey, names) => {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch (e) {}
  c.picnestDirOrder = c.picnestDirOrder || {};
  c.picnestDirOrder[picnestOrderKey(folderId, parentKey === "__root__" ? "" : parentKey)] = names;
  fs.writeFileSync(configPath, JSON.stringify(c, null, 2));
  return true;
});

/* ==== 资料库文件夹管理：mkdir / 重命名 / 排序 / 导出 ==== */

const PICNEST_IMG_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif", ...PICNEST_TEXT_EXTS]);

/* 库内新建文件夹：重名自动 " (n)" 递增（真实 mkdir，索引走 watcher/sync） */
electron.ipcMain.handle("picnest-mkdir", (_event, parentPath, name) => {
  try {
    const clean = String(name || "").trim().replace(/[\\/:*?"<>|]/g, "");
    if (!clean) return { ok: false, error: "名称为空" };
    let finalPath = path.join(parentPath, clean);
    for (let i = 2; fs.existsSync(finalPath); i++) finalPath = path.join(parentPath, clean + " (" + i + ")");
    fs.mkdirSync(finalPath, { recursive: true });
    return { ok: true, path: finalPath, name: path.basename(finalPath) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

/* ==== 图巢内部回收站：文件夹软删除（移动进 AppData 回收区，记录原路径，可原位还原） ==== */
function picnestMoveAny(src, dst) {
  try { fs.renameSync(src, dst); return; } catch (e) {
    if (e && e.code === "EXDEV") {
      fs.cpSync(src, dst, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
      return;
    }
    throw e;
  }
}
function picnestTrashFolder(abs, rel, rootId) {
  picnestMigrate();
  const db = getDb();
  const prefix = abs.replace(/[\\/]+$/, "") + path.sep;
  const pattern = picnestLikeEscape(prefix) + "%";
  const stat = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(file_size),0) s FROM images WHERE file_path LIKE ? ESCAPE '\\'").get(pattern);
  const base = path.basename(abs);
  const trashRoot = path.join(dataDir, "picnest-trash", String(rootId));
  fs.mkdirSync(trashRoot, { recursive: true });
  const now = Date.now();
  const info = db.prepare(
    "INSERT INTO picnest_trash_folders (folder_id, rel, abs_path, trash_path, name, image_count, size, deleted_at) VALUES (?,?,?,?,?,?,?,?)"
  ).run(rootId, rel || "", abs, "", base, stat?.c || 0, stat?.s || 0, now);
  const id = info.lastInsertRowid;
  const trashPath = path.join(trashRoot, id + "-" + base);
  try {
    picnestMoveAny(abs, trashPath);
  } catch (e) {
    db.prepare("DELETE FROM picnest_trash_folders WHERE id = ?").run(id);
    throw e;
  }
  db.prepare("UPDATE picnest_trash_folders SET trash_path = ? WHERE id = ?").run(trashPath, id);
  const rows = db.prepare("SELECT file_path FROM images WHERE file_path LIKE ? ESCAPE '\\'").all(pattern);
  const upd = db.prepare("UPDATE images SET file_path = ?, file_name = ?, deleted_at = ?, trash_group = ? WHERE file_path = ?");
  for (const r of rows) {
    const np = trashPath + r.file_path.slice(abs.length);
    upd.run(np, path.basename(np), now, id, r.file_path);
  }
  return { ok: true, id, name: base, count: stat?.c || 0, size: stat?.s || 0, soft: true };
}
function picnestRestoreFolderRow(row) {
  if (!row) return { ok: false, error: "记录不存在" };
  if (!fs.existsSync(row.trash_path)) return { ok: false, error: "回收站中的文件夹已丢失" };
  let dest = row.abs_path;
  if (fs.existsSync(dest)) {
    const parent = path.dirname(dest), base = path.basename(dest);
    for (let n = 2; fs.existsSync(dest); n++) dest = path.join(parent, base + " (" + n + ")");
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  picnestMoveAny(row.trash_path, dest);
  const oldPrefix = row.trash_path.replace(/[\\/]+$/, "");
  const db = getDb();
  const rows = db.prepare("SELECT file_path FROM images WHERE trash_group = ?").all(row.id);
  const upd = db.prepare("UPDATE images SET file_path = ?, file_name = ?, deleted_at = NULL, trash_group = NULL WHERE file_path = ?");
  for (const r of rows) {
    const np = dest + r.file_path.slice(oldPrefix.length);
    upd.run(np, path.basename(np), r.file_path);
  }
  db.prepare("DELETE FROM picnest_trash_folders WHERE id = ?").run(row.id);
  const root = db.prepare("SELECT path FROM folders WHERE id = ?").get(row.folder_id);
  const sep = root && root.path.includes("\\") ? "\\" : "/";
  const rel = root && dest.toLowerCase().startsWith((root.path + sep).toLowerCase())
    ? dest.slice(root.path.length + 1).split(sep).join("/")
    : row.rel;
  return { ok: true, path: dest, rel, name: path.basename(dest), count: rows.length };
}
async function picnestPurgeFolderRow(row) {
  if (!row) return { ok: false, error: "记录不存在" };
  try {
    await electron.shell.trashItem(row.trash_path);
  } catch (e) {
    try { fs.rmSync(row.trash_path, { recursive: true, force: true }); } catch (e2) { /* 静默 */ }
  }
  const db = getDb();
  db.prepare("DELETE FROM images WHERE trash_group = ?").run(row.id);
  db.prepare("DELETE FROM picnest_trash_folders WHERE id = ?").run(row.id);
  return { ok: true, count: row.image_count || 0 };
}

/* 删除文件夹：软删进图巢回收站（文件夹形式），不物理丢 Windows 回收站；库根禁止 */
electron.ipcMain.handle("picnest-delete-dir", async (_event, dirPath, rel, rootId) => {
  try {
    if (!dirPath) return { ok: false, error: "路径为空" };
    const abs = path.resolve(dirPath);
    if (!fs.existsSync(abs)) return { ok: false, error: "目录不存在" };
    if (!fs.statSync(abs).isDirectory()) return { ok: false, error: "不是文件夹" };
    if (path.dirname(abs) === abs) return { ok: false, error: "不能删除盘符根目录" };
    const db = getDb();
    if (db.prepare("SELECT id FROM folders WHERE path = ?").get(abs)) {
      return { ok: false, error: "资料库根不能在文件夹区删除" };
    }
    let rid = rootId;
    if (!rid) {
      const sep0 = abs.includes("\\") ? "\\" : "/";
      const roots = db.prepare("SELECT id, path FROM folders").all();
      const hit = roots.filter((f) => abs.toLowerCase().startsWith((f.path + sep0).toLowerCase()))
        .sort((a, b) => b.path.length - a.path.length)[0];
      rid = hit?.id;
    }
    if (!rid) return { ok: false, error: "找不到所属资料库" };
    return picnestTrashFolder(abs, rel || "", rid);
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

/* 回收站文件夹：列表 / 还原 / 彻底删除 / 全部还原 / 清空 */
electron.ipcMain.handle("picnest-trash-folders", (_event, folderId) => {
  picnestMigrate();
  return getDb().prepare(
    "SELECT id, rel, abs_path, name, image_count, size, deleted_at FROM picnest_trash_folders WHERE folder_id = ? ORDER BY deleted_at DESC"
  ).all(folderId);
});
electron.ipcMain.handle("picnest-trash-restore-folder", (_event, id) => {
  picnestMigrate();
  const row = getDb().prepare("SELECT * FROM picnest_trash_folders WHERE id = ?").get(id);
  try { return picnestRestoreFolderRow(row); } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
electron.ipcMain.handle("picnest-trash-purge-folder", async (_event, id) => {
  picnestMigrate();
  const row = getDb().prepare("SELECT * FROM picnest_trash_folders WHERE id = ?").get(id);
  try { return await picnestPurgeFolderRow(row); } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
electron.ipcMain.handle("picnest-trash-restore-all", async (_event, folderId) => {
  picnestMigrate();
  const db = getDb();
  const folders = db.prepare("SELECT * FROM picnest_trash_folders WHERE folder_id = ?").all(folderId);
  let restoredFolders = 0, restoredImages = 0, failed = 0;
  for (const row of folders) {
    try {
      const r = picnestRestoreFolderRow(row);
      if (r.ok) { restoredFolders++; restoredImages += r.count || 0; } else failed++;
    } catch (e) { failed++; }
  }
  const imgs = db.prepare("SELECT file_path FROM images WHERE folder_id = ? AND deleted_at IS NOT NULL AND trash_group IS NULL").all(folderId);
  const upd = db.prepare("UPDATE images SET deleted_at = NULL, trash_group = NULL WHERE file_path = ?");
  for (const r of imgs) { upd.run(r.file_path); restoredImages++; }
  return { ok: failed === 0, restoredFolders, restoredImages, failed };
});
electron.ipcMain.handle("picnest-trash-purge-all", async (_event, folderId) => {
  picnestMigrate();
  const db = getDb();
  const folders = db.prepare("SELECT * FROM picnest_trash_folders WHERE folder_id = ?").all(folderId);
  let purgedFolders = 0, purgedImages = 0, failed = 0;
  for (const row of folders) {
    try {
      const r = await picnestPurgeFolderRow(row);
      if (r.ok) { purgedFolders++; purgedImages += r.count || 0; } else failed++;
    } catch (e) { failed++; }
  }
  const imgs = db.prepare("SELECT file_path FROM images WHERE folder_id = ? AND deleted_at IS NOT NULL AND trash_group IS NULL").all(folderId);
  if (imgs.length) {
    try {
      const trash = await import("trash");
      await trash.default(imgs.map((r) => r.file_path), { glob: false });
    } catch (e) {
      for (const r of imgs) { try { fs.unlinkSync(r.file_path); } catch (e2) { /* 静默 */ } }
    }
    purgedImages += imgs.length;
  }
  db.prepare("DELETE FROM images WHERE folder_id = ? AND deleted_at IS NOT NULL AND trash_group IS NULL").run(folderId);
  return { ok: failed === 0, purgedFolders, purgedImages, failed };
});

/* 资料库重命名：只改显示名，不动物理目录（资料库区的编辑入口） */
electron.ipcMain.handle("picnest-rename-library", (_event, id, name) => {
  try {
    const clean = String(name || "").trim();
    if (!clean) return { ok: false, error: "名称为空" };
    getDb().prepare("UPDATE folders SET display_name = ? WHERE id = ?").run(clean, id);
    return { ok: true, name: clean };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

/* 根文件移出：只解除图巢登记（清该根图片索引/回收站条目/排序键），磁盘文件夹与文件一律不动。
   回收站非空时拒绝——否则内部回收站里的文件会变成无人认领的孤盘。 */
electron.ipcMain.handle("picnest-remove-root", (_event, folderId) => {
  try {
    picnestMigrate();
    const db = getDb();
    const root = db.prepare("SELECT id, path, display_name FROM folders WHERE id = ?").get(folderId);
    if (!root) return { ok: false, error: "根文件不存在" };
    const trashImgs = db.prepare("SELECT COUNT(*) c FROM images WHERE folder_id = ? AND deleted_at IS NOT NULL").get(folderId).c;
    const trashDirs = db.prepare("SELECT COUNT(*) c FROM picnest_trash_folders WHERE folder_id = ?").get(folderId).c;
    if (trashImgs + trashDirs > 0) {
      return { ok: false, error: `回收站还有 ${trashImgs + trashDirs} 项，请先清空该根文件的回收站再移出` };
    }
    /* 正在监听该根时必须先停：worker 的 add 事件会 getOrCreateFolder 把根复活；清掉排队中的 add */
    try {
      const norm = (p) => String(p || "").replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
      if (typeof watchedFolder === "string" && watchedFolder && norm(watchedFolder) === norm(root.path)) {
        stopWatching();
        if (typeof _addQueue !== "undefined" && Array.isArray(_addQueue)) _addQueue.length = 0;
      }
    } catch (e) { /* watcher 内部符号缺失不阻塞移出 */ }
    const images = db.prepare("DELETE FROM images WHERE folder_id = ?").run(folderId).changes;
    db.prepare("DELETE FROM picnest_trash_folders WHERE folder_id = ?").run(folderId);
    db.prepare("DELETE FROM folders WHERE id = ?").run(folderId);
    /* 清该库的目录排序键（config，键 = folderId|rel） */
    try {
      const c = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (c.picnestDirOrder) {
        let hit = false;
        for (const k of Object.keys(c.picnestDirOrder)) {
          if (k.startsWith(folderId + "|")) { delete c.picnestDirOrder[k]; hit = true; }
        }
        if (hit) fs.writeFileSync(configPath, JSON.stringify(c, null, 2));
      }
    } catch (e) {}
    /* 回收站物理目录此时应为空壳，清掉避免留孤儿目录 */
    try {
      const td = path.join(dataDir, "picnest-trash", String(folderId));
      if (fs.existsSync(td)) fs.rmSync(td, { recursive: true, force: true });
    } catch (e) {}
    return { ok: true, images, name: root.display_name || path.basename(root.path) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

/* 目录重命名：迁移 picnestDirOrder 兄弟序里的老名字 + dirMemory 的 rel 键（rel 前缀整体搬家） */
electron.ipcMain.handle("picnest-rename-dir", (_event, oldPath, newName, oldRel, parentRel) => {
  try {
    const clean = String(newName || "").trim().replace(/[\\/:*?"<>|]/g, "");
    if (!clean) return { ok: false, error: "名称为空" };
    const newPath = path.join(path.dirname(oldPath), clean);
    if (newPath !== oldPath && fs.existsSync(newPath)) return { ok: false, error: "同名文件夹已存在" };
    fs.renameSync(oldPath, newPath);
    const oldName = path.basename(oldPath);
    const order = picnestDirOrderRead();
    const rid = picnestRootIdByPath(oldPath);
    const keyPrefix = rid != null ? rid + "|" : null;
    for (const key of Object.keys(order)) {
      if (keyPrefix ? !key.startsWith(keyPrefix) : key.includes("|")) continue; // 只迁移本库的排序键
      const arr = order[key];
      const idx = arr.indexOf(oldName);
      if (idx >= 0) arr[idx] = clean;
    }
    let c = {};
    try { c = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch (e) {}
    if (order && Object.keys(order).length) c.picnestDirOrder = order;
    const mem = c.picnestDirMemory || {};
    if (oldRel && typeof oldRel === "string") {
      const newRel = parentRel ? parentRel + "/" + clean : clean;
      for (const key of Object.keys(mem)) {
        if (key === oldRel) { mem[newRel] = mem[key]; delete mem[key]; }
        else if (key.startsWith(oldRel + "/")) { mem[newRel + key.slice(oldRel.length)] = mem[key]; delete mem[key]; }
      }
      c.picnestDirMemory = mem;
    }
    fs.writeFileSync(configPath, JSON.stringify(c, null, 2));
    return { ok: true, path: newPath, name: clean };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

/* 目录排序核心：读物理子目录 → 按 mode 排 → 写 picnestDirOrder[parentRel] */
function picnestSortDirLevel(parentRel, parentAbsPath, mode) {
  const entries = fs.readdirSync(parentAbsPath, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      let mt = 0;
      try { mt = fs.statSync(path.join(parentAbsPath, d.name)).mtimeMs; } catch (e) {}
      return { name: d.name, mt };
    });
  const cmp = {
    name_asc: (a, b) => a.name.localeCompare(b.name, "zh"),
    name_desc: (a, b) => b.name.localeCompare(a.name, "zh"),
    mtime_asc: (a, b) => a.mt - b.mt,
    mtime_desc: (a, b) => b.mt - a.mt,
  }[mode];
  if (!cmp) throw new Error("未知排序: " + mode);
  return entries.sort(cmp).map((e) => e.name);
}

/* 当前层级排序（Eagle：标题(当前层级) A→Z/Z→A；修改时间 新→旧/旧→新） */
electron.ipcMain.handle("picnest-dir-sort", (_event, parentRel, parentAbsPath, mode) => {
  try {
    const names = picnestSortDirLevel(parentRel, parentAbsPath, mode);
    let c = {};
    try { c = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch (e) {}
    c.picnestDirOrder = c.picnestDirOrder || {};
    const rid = picnestRootIdByPath(parentAbsPath);
    c.picnestDirOrder[rid != null ? picnestOrderKey(rid, parentRel) : (parentRel || "__root__")] = names;
    fs.writeFileSync(configPath, JSON.stringify(c, null, 2));
    return { ok: true, names };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

/* 全部层级排序：从 (rootRel, rootAbs) 起递归每层都按 mode 写 order */
electron.ipcMain.handle("picnest-dir-sort-recursive", (_event, rootAbsPath, rootRel, mode) => {
  try {
    let c = {};
    try { c = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch (e) {}
    c.picnestDirOrder = c.picnestDirOrder || {};
    const rid = picnestRootIdByPath(rootAbsPath);
    let levels = 0;
    const walk = (abs, rel) => {
      const names = picnestSortDirLevel(rel, abs, mode);
      c.picnestDirOrder[rid != null ? picnestOrderKey(rid, rel) : (rel || "__root__")] = names;
      levels++;
      for (const name of names) walk(path.join(abs, name), rel ? rel + "/" + name : name);
    };
    walk(rootAbsPath, rootRel || "");
    fs.writeFileSync(configPath, JSON.stringify(c, null, 2));
    return { ok: true, levels };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

/* 导出文件夹：系统对话框选目标目录 → 递归复制图片（保留子目录结构，重名自动去重） */
electron.ipcMain.handle("picnest-export-dir", async (_event, dirPath) => {
  try {
    const res = await electron.dialog.showOpenDialog(mainWindow, {
      title: "选择导出目标目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const destRoot = path.join(res.filePaths[0], path.basename(dirPath));
    let count = 0;
    const walk = (src, dest) => {
      fs.mkdirSync(dest, { recursive: true });
      for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
        if (ent.isDirectory()) {
          walk(path.join(src, ent.name), path.join(dest, ent.name));
        } else if (PICNEST_IMG_EXT.has(path.extname(ent.name).toLowerCase())) {
          let target = path.join(dest, ent.name);
          if (fs.existsSync(target)) {
            const e2 = path.extname(ent.name);
            const b2 = path.basename(ent.name, e2);
            for (let i = 2; fs.existsSync(target); i++) target = path.join(dest, b2 + " (" + i + ")" + e2);
          }
          fs.copyFileSync(path.join(src, ent.name), target);
          count++;
        }
      }
    };
    walk(dirPath, destRoot);
    return { ok: true, count, dest: destRoot };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

/* ---- M4 四视图：软删列 + 计数 + 随机 + 回收站 + 搜索 ---- */
electron.ipcMain.handle("picnest-view-counts", (_event, folderId) => {
  picnestMigrate();
  const db = getDb();
  const trashImages = db.prepare("SELECT COUNT(*) c FROM images WHERE folder_id = ? AND deleted_at IS NOT NULL AND trash_group IS NULL").get(folderId).c;
  const trashFolders = db.prepare("SELECT COUNT(*) c FROM picnest_trash_folders WHERE folder_id = ?").get(folderId).c;
  return {
    all: db.prepare("SELECT COUNT(*) c FROM images WHERE folder_id = ? AND deleted_at IS NULL").get(folderId).c,
    recent: db.prepare("SELECT COUNT(*) c FROM images WHERE folder_id = ? AND deleted_at IS NULL AND last_opened_at > 0").get(folderId).c,
    trash: trashImages + trashFolders,
    uncategorized: (() => {
      const root = db.prepare("SELECT path FROM folders WHERE id = ?").get(folderId);
      if (!root) return 0;
      const esc = picnestLikeEscape(root.path + path.sep);
      return db.prepare("SELECT COUNT(*) c FROM images WHERE folder_id = ? AND deleted_at IS NULL AND file_path LIKE ? ESCAPE '\\' AND file_path NOT LIKE ? ESCAPE '\\'").get(folderId, esc + "%", esc + "%" + picnestLikeEscape(path.sep) + "%").c;
    })(),
  };
});
electron.ipcMain.handle("picnest-random", (_event, folderId, limit) => {
  return getDb().prepare(
    `SELECT id, file_path, file_name, file_size, modify_time, width, height, thumbnail_path, is_favorite
     FROM images WHERE folder_id = ? AND deleted_at IS NULL ORDER BY RANDOM() LIMIT ?`
  ).all(folderId, limit);
});
electron.ipcMain.handle("picnest-trash-list", async (_event, folderId) => {
  picnestMigrate();
  const rows = getDb().prepare(
    `SELECT id, file_path, file_name, file_size, modify_time, width, height, thumbnail_path, is_favorite, deleted_at
     FROM images WHERE folder_id = ? AND deleted_at IS NOT NULL AND trash_group IS NULL ORDER BY deleted_at DESC`
  ).all(folderId);
  const valid = [];
  for (const img of rows) {
    if (img.thumbnail_path && !fs.existsSync(img.thumbnail_path)) img.thumbnail_path = "";
    if (!img.thumbnail_path) img.thumbnail_path = discoverThumbnailPath(img.file_path) || "";
    if (!fs.existsSync(img.file_path)) { deleteImageByPath(img.file_path); continue; } // 文件已真消失：行直接清
    valid.push(img);
  }
  return valid;
});
electron.ipcMain.handle("picnest-trash-restore", (_event, filePath) => {
  picnestMigrate();
  getDb().prepare("UPDATE images SET deleted_at = NULL, trash_group = NULL WHERE file_path = ? AND trash_group IS NULL").run(filePath);
  return true;
});
electron.ipcMain.handle("picnest-remove", (_event, filePath) => {
  picnestMigrate();
  getDb().prepare("UPDATE images SET deleted_at = ?, trash_group = NULL WHERE file_path = ?").run(Date.now(), filePath);
  return true;
});
electron.ipcMain.handle("picnest-trash-purge", async (_event, filePath) => {
  picnestMigrate();
  const row = getDb().prepare("SELECT trash_group FROM images WHERE file_path = ?").get(filePath);
  if (row && row.trash_group != null) return false; // 属于文件夹回收条目：走文件夹删除
  try {
    const trash = await import("trash");
    await trash.default([filePath], { glob: false });
  } catch (e) { try { fs.unlinkSync(filePath); } catch (e2) {} }
  deleteImageByPath(filePath);
  return true;
});
/* 色板提取（Eagle 式 dominantColors）：优先用缩略图（400px 足够），sharp 桶聚类取 top8 */
async function picnestExtractPalettes(fp) {
  const sharp = (await import("sharp")).default;
  let src = fp;
  try {
    const ext = path.extname(fp).toLowerCase();
    const hashName = crypto.createHash("md5").update(fp).digest("hex") + ext;
    const cand = [path.join(cacheDir, hashName.replace(ext, ".webp")), path.join(cacheDir, hashName.replace(ext, ".jpg")), path.join(cacheDir, hashName)];
    for (const c of cand) if (fs.existsSync(c)) { src = c; break; }
    const { data, info } = await sharp(src).resize(64, null, { withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels || 3;
    const buckets = new Map();
    let count = 0;
    for (let i = 0; i < data.length; i += channels) {
      const r = data[i], g = data[i + 1] ?? r, b = data[i + 2] ?? r;
      count++;
      const bk = Math.floor(r / 32) << 6 | Math.floor(g / 32) << 3 | Math.floor(b / 32);
      const bv = buckets.get(bk);
      if (bv) { bv.r += r; bv.g += g; bv.b += b; bv.n++; } else buckets.set(bk, { r, g, b, n: 1 });
    }
    const top = Array.from(buckets.values()).sort((a, b) => b.n - a.n).slice(0, 24);
    const merged = [];
    for (const bv of top) {
      const r = Math.round(bv.r / bv.n), g = Math.round(bv.g / bv.n), b = Math.round(bv.b / bv.n);
      let found = false;
      for (const m of merged) {
        const dr = r - m.r, dg = g - m.g, db2 = b - m.b;
        if (Math.sqrt(dr * dr + dg * dg + db2 * db2) < 48) {
          const total = m.count + bv.n;
          m.r = Math.round((m.r * m.count + r * bv.n) / total);
          m.g = Math.round((m.g * m.count + g * bv.n) / total);
          m.b = Math.round((m.b * m.count + b * bv.n) / total);
          m.count = total;
          found = true;
          break;
        }
      }
      if (!found) merged.push({ r, g, b, count: bv.n });
    }
    return merged.sort((a, b) => b.count - a.count).slice(0, 8)
      .map((c) => ({ r: c.r, g: c.g, b: c.b, percent: Math.round(c.count / count * 1000) / 10 }));
  } catch (e) {
    return null;
  }
}
electron.ipcMain.handle("picnest-build-palettes-step", async (_event, folderId, step) => {
  const rows = getDb().prepare("SELECT file_path FROM images WHERE folder_id = ? AND palettes IS NULL AND deleted_at IS NULL LIMIT ?").all(folderId, step || 40);
  let done = 0;
  for (const r of rows) {
    const pal = await picnestExtractPalettes(r.file_path);
    getDb().prepare("UPDATE images SET palettes = ? WHERE file_path = ?").run(pal ? JSON.stringify(pal) : "SKIP", r.file_path);
    done++;
  }
  const totalRow = getDb().prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN palettes IS NOT NULL THEN 1 ELSE 0 END) AS idx FROM images WHERE folder_id = ? AND deleted_at IS NULL").get(folderId);
  return { ok: true, processed: done, total: totalRow.total, indexed: totalRow.idx };
});
electron.ipcMain.handle("picnest-get-palettes", (_event, paths) => {
  if (!paths.length) return {};
  const placeholders = paths.map(() => "?").join(",");
  const rows = getDb().prepare(`SELECT file_path, palettes FROM images WHERE file_path IN (` + placeholders + `)`).all(...paths);
  const out = {};
  for (const r of rows) {
    if (r.palettes && r.palettes !== "SKIP") {
      try { out[r.file_path] = JSON.parse(r.palettes); } catch (e) {}
    }
  }
  return out;
});
electron.ipcMain.handle("picnest-search", (_event, folderId, query, limit) => {
  const q = String(query || "").trim();
  if (!q) return [];
  const pattern = "%" + picnestLikeEscape(q) + "%";
  return getDb().prepare(
    `SELECT id, file_path, file_name, file_size, modify_time, width, height, thumbnail_path, is_favorite
     FROM images WHERE folder_id = ? AND deleted_at IS NULL AND file_name LIKE ? ESCAPE '\\' ORDER BY file_name COLLATE NOCASE LIMIT ?`
  ).all(folderId, pattern, limit);
});

/* 移动目录（拖拽调整文件夹位置）：同盘 rename；禁止移进自身/自身子目录 */
electron.ipcMain.handle("picnest-move-dir", async (_event, dirPath, targetDir) => {
  try {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return { ok: false, error: "源目录不存在" };
    if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) return { ok: false, error: "目标目录不存在" };
    const norm = (p) => String(p).replace(/[\\/]+$/, "").toLowerCase();
    const src = norm(dirPath), dst = norm(targetDir);
    if (src === dst) return { ok: true, dir_path: dirPath, moved: false };
    if (dst.startsWith(src + "\\") || dst.startsWith(src + "/")) return { ok: false, error: "不能移动到自身子目录" };
    let target = path.join(targetDir, path.basename(dirPath));
    if (norm(target) === src) return { ok: true, dir_path: dirPath, moved: false }; // 已在目标父级，无需动
    let n = 1;
    while (fs.existsSync(target)) { target = path.join(targetDir, `${path.basename(dirPath)} (${n})`); n++; }
    fs.renameSync(dirPath, target);
    /* DB 同步：整棵子树的 file_path 前缀搬家（树从 DB 派生，只 rename 会显示错位） */
    let movedRows = 0;
    try {
      const fromPrefix = dirPath.replace(/[\\/]+$/, "");
      const toPrefix = target.replace(/[\\/]+$/, "");
      const rows = getDb().prepare(
        "SELECT file_path FROM images WHERE file_path LIKE ? ESCAPE '\\'"
      ).all(picnestLikeEscape(fromPrefix + path.sep) + "%");
      const upd = getDb().prepare("UPDATE images SET file_path = ?, file_name = ? WHERE file_path = ?");
      for (const r of rows) {
        const np = toPrefix + r.file_path.slice(fromPrefix.length);
        upd.run(np, path.basename(np), r.file_path);
        movedRows++;
      }
    } catch (e) { /* DB 更新失败不阻塞磁盘移动，watcher/sync 兜底 */ }
    return { ok: true, dir_path: target, moved: true, images: movedRows };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

/* 移动文件到指定目录（物理移动；同盘 rename 瞬时；撞名自动加序号） */
electron.ipcMain.handle("picnest-move-image", async (_event, filePath, targetDir) => {
  try {
    if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) return { ok: false, error: "目标目录不存在" };
    const name = path.basename(filePath);
    let target = path.join(targetDir, name);
    if (target.toLowerCase() === filePath.toLowerCase()) return { ok: true, file_path: filePath, moved: false };
    let n = 1;
    const stem = path.basename(name, path.extname(name));
    const ext = path.extname(name);
    while (fs.existsSync(target)) {
      target = path.join(targetDir, `${stem} (${n})${ext}`);
      n++;
    }
    fs.renameSync(filePath, target);
    getDb().prepare("UPDATE images SET file_path = ?, file_name = ?, sort_order = 0 WHERE file_path = ?").run(target, path.basename(target), filePath);
    return { ok: true, file_path: target, moved: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

/* 重命名：同目录内 fs.rename + 库内路径同步（缩略图缓存按路径 md5 寻址，旧缓存自然失效重生成） */
electron.ipcMain.handle("picnest-rename-image", async (_event, filePath, newName) => {
  const clean = String(newName || "").trim().replace(/[\\/:*?"<>|]/g, "_");
  if (!clean) return { ok: false, error: "名称为空" };
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const target = path.join(dir, clean.endsWith(ext) ? clean : clean + ext);
  if (target === filePath) return { ok: true, file_path: filePath };
  if (fs.existsSync(target)) return { ok: false, error: "同名文件已存在" };
  try {
    fs.renameSync(filePath, target);
    getDb().prepare("UPDATE images SET file_path = ?, file_name = ? WHERE file_path = ?").run(target, path.basename(target), filePath);
    return { ok: true, file_path: target };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

/* 文件夹记忆：每个子目录的浏览位置/排序/随机种子，存 config.json；key 传空 = 取全表 */
electron.ipcMain.handle("picnest-dir-memory-get", (_event, key) => key ? (picnestDirMemoryRead()[key] || null) : picnestDirMemoryRead());
electron.ipcMain.handle("picnest-dir-memory-set", (_event, key, patch) => {
  const map = picnestDirMemoryRead();
  map[key] = Object.assign(map[key] || {}, patch);
  picnestDirMemoryWrite(map);
  return true;
});

/* 迁移兜底：whenReady 后再跑一次（bundle 自己的 whenReady 先注册，db 必就绪） */
electron.app.whenReady().then(() => { try { picnestMigrate() } catch (e) {} });

/* 种子导入：dataDir/picnest-seed.json = {"path": "..."} → 窗口就绪后推给渲染层走正常导入链路（跑完自删） */
const picnestSeedTimer = setInterval(() => {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const seedFile = path.join(dataDir, "picnest-seed.json");
    if (!fs.existsSync(seedFile)) { clearInterval(picnestSeedTimer); return; }
    const seed = JSON.parse(fs.readFileSync(seedFile, "utf8"));
    if (!seed?.path) { fs.rmSync(seedFile); clearInterval(picnestSeedTimer); return; }
    mainWindow.webContents.send("picnest-seed", { path: seed.path });
    clearInterval(picnestSeedTimer);
  } catch (e) {
    console.error("[picnest] seed push failed:", e);
  }
}, 1000);
electron.ipcMain.handle("picnest-rm-seed", () => {
  try { fs.rmSync(path.join(dataDir, "picnest-seed.json")); } catch (e) {}
  return true;
});

/* P6: 手动拖窗——app-region: drag 在 Electron 33 物理命中测试不可靠（no-drag 子元素被拖拽位图无视），
   渲染层 mousedown + screenX/Y 增量后走这里移窗（频繁 send，勿改 handle/往返）。
   Win 非 100% DPI 下，移动触发的边框补偿会让窗口每次胀 ~2px：
   - 移动时永远断言「规范尺寸」picnestWinSize（绝不读现值回写 → 棘轮断根）
   - 规范尺寸只在 resize 防抖后、且与现值差 >4px 时才更新（≤4px 一律视为补偿抖动丢弃） */
let picnestDragBase = null;
let picnestWinSize = null;
let picnestResizeT = null;
function picnestSnapSize(force) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const b = mainWindow.getBounds();
    if (!picnestWinSize || force
        || Math.abs(b.width - picnestWinSize.width) > 4
        || Math.abs(b.height - picnestWinSize.height) > 4) {
      /* 吸附物理网格：DIP×scale 非整时（如 901×1.25=1126.25），每次换算都在舍入 → 永动 ±1 抖。
         取整到整数物理像素再换回 DIP（可能带小数），换算链路从此零舍入 */
      const f = electron.screen.getDisplayMatching(b).scaleFactor || 1;
      picnestWinSize = {
        width: Math.round(b.width * f) / f,
        height: Math.round(b.height * f) / f,
      };
    }
  } catch (e) {}
}
electron.ipcMain.on("picnest-window-drag-start", () => {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    picnestSnapSize(false); /* 自愈：若真实 resize 未被监听到，此处把规范尺寸追平（>4px 才采纳） */
    if (!picnestWinSize) picnestSnapSize(true);
    /* 关键：手势期关掉 resizable——Win 非 100% DPI 下位置一变系统就强制重算窗口尺寸（±2px
       非幂等），尺寸一变 Web 内容就整帧重排 = 拖动抖动。关掉后 Windows 停止尺寸管理，
       setBounds 尺寸分量精确落位。先关再取 base（setResizable 自身可能触发一次重算）。
       若渲染层崩溃漏发 drag-end，下次 drag-start 也会重新走到这里兜底 */
    try { mainWindow.setResizable(false); } catch (e) {}
    const b = mainWindow.getBounds();
    picnestDragBase = { x: b.x, y: b.y };
  } catch (e) {}
});
electron.ipcMain.on("picnest-window-move", (_event, dx, dy) => {
  try {
    if (!mainWindow || mainWindow.isDestroyed() || !picnestDragBase || !picnestWinSize) return;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const f = electron.screen.getDisplayMatching(mainWindow.getBounds()).scaleFactor || 1;
    mainWindow.setBounds({
      x: Math.round((picnestDragBase.x + dx) * f) / f, /* 位置同样吸附物理网格，消 ±1px 内容平移 */
      y: Math.round((picnestDragBase.y + dy) * f) / f,
      width: picnestWinSize.width,
      height: picnestWinSize.height,
    });
  } catch (e) {}
});
electron.ipcMain.on("picnest-window-drag-end", () => {
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setResizable(true); } catch (e) {}
});
/* 用户真实调整窗体（边缘拉伸/最大化还原）后刷新规范尺寸；拖拽自触发的 resize 也会进来，
   但 ≤4px 的被丢弃，不会污染 */
/* 注册挂 whenReady 之后：模块加载期 mainWindow 尚未赋值，直接 .on 会静默炸掉
   （被 catch 吞掉 → 规范尺寸永不更新 → 拖动永远回旧尺寸的元凶） */
electron.app.whenReady().then(() => {
  try {
    mainWindow.on("resize", () => {
      clearTimeout(picnestResizeT);
      picnestResizeT = setTimeout(() => picnestSnapSize(false), 400);
    });
  } catch (e) {}
});
/* 诊断探针：主进程视角的窗口 bounds（查 DPI 舍入漂移用） */
electron.ipcMain.handle("picnest-window-bounds", () => {
  try { return mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null; } catch (e) { return null; }
});
/* ---- 重复文件扫描（仅当前资料库；size 预筛 → MD5；图片/视频/文本） ---- */
function picnestMd5Stream(fp) {
  return new Promise((resolve) => {
    let h;
    try { h = crypto.createHash("md5"); } catch (e) { resolve(null); return; }
    let s;
    try { s = fs.createReadStream(fp); } catch (e) { resolve(null); return; }
    s.on("data", (d) => { try { h.update(d); } catch (e) {} });
    s.on("end", () => { try { resolve(h.digest("hex")); } catch (e) { resolve(null); } });
    s.on("error", () => resolve(null));
  });
}
async function picnestMapLimit(items, limit, fn) {
  let i = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const cur = items[i++]; await fn(cur); }
  }));
}
electron.ipcMain.handle("picnest-find-duplicates", async (event, folderId, rel) => {
  try {
    picnestMigrate();
    const t0 = Date.now();
    const root = getDb().prepare("SELECT path FROM folders WHERE id = ?").get(folderId);
    if (!root) return { ok: false, error: "资料库不存在" };
    const sep = root.path.includes("\\") ? "\\" : "/";
    const scopeRel = String(rel || "").replace(/^\/+|\/+$/g, "");
    let rows;
    if (scopeRel) {
      const pat = picnestLikeEscape(root.path + sep + scopeRel.split("/").join(sep) + sep) + "%";
      rows = getDb().prepare(
        `SELECT id, file_path, file_name, file_size, modify_time, width, height, thumbnail_path
         FROM images WHERE folder_id = ? AND deleted_at IS NULL AND file_path LIKE ? ESCAPE '\\'`
      ).all(folderId, pat);
    } else {
      rows = getDb().prepare(
        `SELECT id, file_path, file_name, file_size, modify_time, width, height, thumbnail_path
         FROM images WHERE folder_id = ? AND deleted_at IS NULL`
      ).all(folderId);
    }
    const files = [];
    for (const r of rows) {
      let st;
      try { st = fs.statSync(r.file_path); } catch (e) { continue; }
      if (!st.isFile() || st.size <= 0) continue;
      files.push({ ...r, size: st.size });
    }
    /* 只有同尺寸才可能同内容：先按 size 分桶，unique 尺寸不读盘 */
    const bySize = new Map();
    for (const f of files) {
      if (!bySize.has(f.size)) bySize.set(f.size, []);
      bySize.get(f.size).push(f);
    }
    const candidates = [];
    for (const arr of bySize.values()) if (arr.length > 1) candidates.push(...arr);
    const total = candidates.length;
    let done = 0, last = 0;
    await picnestMapLimit(candidates, 4, async (f) => {
      f.md5 = await picnestMd5Stream(f.file_path);
      done++;
      if (done - last >= 3 || done === total) {
        last = done;
        try { event.sender.send("picnest-dup-progress", { done, total }); } catch (e) {}
      }
    });
    const byHash = new Map();
    for (const f of candidates) {
      if (!f.md5) continue;
      const key = f.size + ":" + f.md5;
      if (!byHash.has(key)) byHash.set(key, []);
      byHash.get(key).push(f);
    }
    const relOf = (fp) => path.relative(root.path, path.dirname(fp)).replace(/[\\/]+/g, "/");
    const groups = [];
    for (const arr of byHash.values()) {
      if (arr.length < 2) continue;
      const filesOut = arr.map((f) => ({
        path: f.file_path,
        name: f.file_name,
        size: f.size,
        mtime: f.modify_time,
        width: f.width,
        height: f.height,
        thumb: f.thumbnail_path || "",
        rel: relOf(f.file_path),
      }));
      filesOut.sort((a, b) => (a.rel || "").localeCompare(b.rel || "", "zh") || String(a.name).localeCompare(String(b.name), "zh"));
      groups.push({ hash: arr[0].md5, size: arr[0].size, count: filesOut.length, wasted: arr[0].size * (filesOut.length - 1), files: filesOut });
    }
    groups.sort((a, b) => b.wasted - a.wasted || b.count - a.count);
    const stats = {
      scopes: files.length,
      candidates: total,
      groups: groups.length,
      files: groups.reduce((s, g) => s + g.count, 0),
      wasted: groups.reduce((s, g) => s + g.wasted, 0),
      ms: Date.now() - t0,
    };
    return { ok: true, rootId: folderId, rel: scopeRel, groups, stats };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});
/* ==== AI 查重（OpenAI 兼容视觉 API；缩略图 dHash 缩圈 → AI 逐对确认） ==== */
const PICNEST_AI_CFG_PATH = path.join(dataDir, "picnest-ai.json");
const PICNEST_AI_IMG_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif", ".tif", ".tiff", ".svg"]);
let picnestAiCancel = false;

function picnestAiMask(s) {
  return String(s == null ? "" : s).replace(/sk-[A-Za-z0-9_*-]{6,}/g, "sk-***");
}
function picnestAiErrText(txt) {
  const raw = String(txt || "");
  try {
    const j = JSON.parse(raw);
    const m = j?.error?.message || j?.message || j?.error;
    if (m) return String(m);
  } catch (e) {}
  // 错误体可能被截断导致 JSON.parse 失败，尽量把 message 抽出来
  const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (m) {
    try { return JSON.parse('"' + m[1] + '"'); } catch (e) { return m[1]; }
  }
  return raw;
}
function picnestAiHttpError(status, txt) {
  const body = picnestAiErrText(txt).replace(/\s+/g, " ").trim().slice(0, 300);
  return picnestAiMask(`API HTTP ${status}${body ? ": " + body : ""}`);
}
// 兼容两种写法：配置里既可能填 base（…/v1），也可能直接填完整 chat 地址
function picnestAiBaseOf(baseUrl) {
  return String(baseUrl || "").trim().replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
}
function picnestAiReadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(PICNEST_AI_CFG_PATH, "utf-8"));
    let apiKey = "";
    if (c.keyEnc) {
      try { apiKey = electron.safeStorage.decryptString(Buffer.from(c.keyEnc, "base64")); } catch (e) { apiKey = ""; }
    } else if (c.keyPlain) apiKey = c.keyPlain;
    return { baseUrl: c.baseUrl || "", model: c.model || "", apiKey };
  } catch (e) { return { baseUrl: "", model: "", apiKey: "" }; }
}
function picnestAiEncryptKey(key) {
  try {
    if (electron.safeStorage?.isEncryptionAvailable?.()) {
      return { keyEnc: electron.safeStorage.encryptString(key).toString("base64") };
    }
  } catch (e) {}
  return { keyPlain: key };
}
function picnestAiSaveConfig(baseUrl, model, apiKey) {
  const cleanBase = String(baseUrl || "").trim().replace(/\/+$/, "");
  const cleanModel = String(model || "").trim();
  if (!/^https?:\/\//i.test(cleanBase)) throw new Error("API 地址需以 http(s):// 开头");
  if (!cleanModel) throw new Error("请填写模型名");
  const old = picnestAiReadConfig();
  const key = String(apiKey || "").trim() || old.apiKey;
  const out = { baseUrl: cleanBase, model: cleanModel };
  if (key) Object.assign(out, picnestAiEncryptKey(key));
  fs.writeFileSync(PICNEST_AI_CFG_PATH, JSON.stringify(out, null, 2));
  return { hasKey: !!key, encrypted: !!out.keyEnc };
}

electron.ipcMain.handle("picnest-ai-config-get", () => {
  const c = picnestAiReadConfig();
  let encrypted = false;
  try { encrypted = !!JSON.parse(fs.readFileSync(PICNEST_AI_CFG_PATH, "utf-8")).keyEnc; } catch (e) {}
  return { ok: true, baseUrl: c.baseUrl, model: c.model, hasKey: !!c.apiKey, encrypted };
});
electron.ipcMain.handle("picnest-ai-config-set", (_event, opts) => {
  try {
    const r = picnestAiSaveConfig(opts?.baseUrl, opts?.model, opts?.apiKey);
    return { ok: true, ...r };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});

// GET {base}/models：用已保存或刚输入（尚未保存）的 Key 拉模型列表，供下拉选择
electron.ipcMain.handle("picnest-ai-models", async (_event, opts) => {
  const stored = picnestAiReadConfig();
  const base = picnestAiBaseOf(opts?.baseUrl || stored.baseUrl);
  const apiKey = String(opts?.apiKey || "").trim() || stored.apiKey;
  if (!/^https?:\/\//i.test(base)) return { ok: false, error: "请先填写 API 地址（http/https）" };
  if (!apiKey) return { ok: false, error: "请先填写 API Key，或先保存一次" };
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = setTimeout(() => { try { ctl?.abort(); } catch (e) {} }, 25000);
  try {
    const res = await fetch(base + "/models", {
      headers: { Authorization: "Bearer " + apiKey, Accept: "application/json" },
      signal: ctl?.signal,
    });
    if (!res.ok) {
      let txt = "";
      try { txt = (await res.text()).slice(0, 800); } catch (e) {}
      const hint = res.status === 401 || res.status === 403
        ? "（Key 与该 API 地址不匹配，或 Key 无效；模型列表需要和聊天用同一个 Key）"
        : res.status === 404 ? "（该地址没有 /models 接口，可手动填写模型名）" : "";
      return { ok: false, error: picnestAiMask(picnestAiHttpError(res.status, txt) + hint) };
    }
    const json = await res.json();
    const raw = Array.isArray(json) ? json
      : Array.isArray(json?.data) ? json.data
        : Array.isArray(json?.models) ? json.models : [];
    const ids = [...new Set(raw
      .map((x) => (typeof x === "string" ? x : x?.id || x?.name || x?.model))
      .map((x) => String(x || "").trim())
      .filter(Boolean))]
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 500);
    if (!ids.length) return { ok: false, error: "接口返回了空模型列表，可手动填写模型名" };
    return { ok: true, models: ids };
  } catch (e) {
    const msg = String(e?.message || e);
    return { ok: false, error: picnestAiMask(/abort/i.test(msg) ? "获取模型列表超时" : msg) };
  } finally { clearTimeout(timer); }
});

async function picnestAiCompare(cfg, dataA, dataB) {
  const base = picnestAiBaseOf(cfg.baseUrl);
  const endpoint = /\/chat\/completions$/i.test(base) ? base : base + "/chat/completions";
  const model = String(cfg.model || "");
  let isMimo = false;
  try { isMimo = /(^|\.)xiaomimimo\.com$/i.test(new URL(base).hostname); } catch (e) {}
  // MiMo / o 系列是推理模型：用 max_completion_tokens 留足思考+答案额度；
  // 旧式模型用 max_tokens 即可。MiMo 思考模式也不接受自定义 temperature。
  const reasoningModel = isMimo || /^(o[134]|gpt-5)/i.test(model);
  const body = {
    model,
    messages: [
      { role: "system", content: "You are an image duplicate checker. Reply with JSON only." },
      {
        role: "user",
        content: [
          { type: "text", text: "Are these two images the same artwork or the same photo? Allow different resolution, compression, watermark, text overlay, or minor cropping. Reply exactly with JSON: {\"same\":true,\"confidence\":0.0} or {\"same\":false,\"confidence\":0.0}." },
          { type: "image_url", image_url: { url: dataA } },
          { type: "image_url", image_url: { url: dataB } },
        ],
      },
    ],
  };
  if (!reasoningModel) body.temperature = 0;
  if (reasoningModel) body.max_completion_tokens = 2048;
  else body.max_tokens = 1024;
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = setTimeout(() => { try { ctl?.abort(); } catch (e) {} }, 90000);
  try {
    let res = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.apiKey },
        body: JSON.stringify(body),
        signal: ctl?.signal,
      });
      if (res.status === 429 || res.status >= 500) { if (attempt === 0) { await new Promise((r) => setTimeout(r, 1200)); continue; } }
      break;
    }
    if (!res.ok) {
      let txt = "";
      try { txt = (await res.text()).slice(0, 800); } catch (e) {}
      throw new Error(picnestAiHttpError(res.status, txt));
    }
    const json = await res.json();
    const choice = json.choices?.[0] || {};
    const content = choice.message?.content;
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.map((x) => x?.text || "").join("") : "";
    if (!text.trim()) {
      const reasoning = typeof choice.message?.reasoning_content === "string" ? choice.message.reasoning_content : "";
      const rt = json.usage?.completion_tokens_details?.reasoning_tokens;
      const bits = [`finish_reason=${choice.finish_reason || "?"}`];
      if (rt) bits.push(`思考 ${rt} tokens`);
      if (reasoning) bits.push(`仅有 reasoning_content ${reasoning.length} 字`);
      throw new Error(`AI 返回空 content（${bits.join("，")}）；请提高输出上限或换用非推理模型`);
    }
    let obj = null;
    const m = /\{[\s\S]*\}/.exec(text || "");
    if (m) { try { obj = JSON.parse(m[0]); } catch (e) {} }
    if (!obj) {
      const t = /\bsame\b[^a-z]{0,20}(true|false)/i.exec(text || "");
      if (!t) throw new Error("AI 返回无法解析: " + String(text || "").slice(0, 120));
      return t[1].toLowerCase() === "true";
    }
    return !!obj.same;
  } finally { clearTimeout(timer); }
}
electron.ipcMain.handle("picnest-ai-test", async () => {
  try {
    const cfg = picnestAiReadConfig();
    if (!cfg.baseUrl || !cfg.model || !cfg.apiKey) return { ok: false, error: "请先填写并保存 API 地址、模型和 Key" };
    const sharp = (await import("sharp")).default;
    const mk = async (rgb) => {
      const buf = await sharp({ create: { width: 64, height: 64, channels: 3, background: rgb } }).png().toBuffer();
      return "data:image/png;base64," + buf.toString("base64");
    };
    const same = await picnestAiCompare(cfg, await mk({ r: 220, g: 60, b: 60 }), await mk({ r: 60, g: 80, b: 220 }));
    return { ok: true, same };
  } catch (e) { return { ok: false, error: picnestAiMask(e?.message || e) }; }
});

function picnestAiPop32(x) {
  x = x >>> 0;
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
}
function picnestAiHam(a, b) {
  return picnestAiPop32((a[0] ^ b[0]) >>> 0) + picnestAiPop32((a[1] ^ b[1]) >>> 0);
}
async function picnestAiDHash(file) {
  const sharp = (await import("sharp")).default;
  const src = file.thumbnail_path && fs.existsSync(file.thumbnail_path) ? file.thumbnail_path : file.file_path;
  const buf = await sharp(src).rotate().resize(9, 8, { fit: "fill" }).greyscale().raw().toBuffer();
  let a = 0, b = 0, bit = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = buf[y * 9 + x], right = buf[y * 9 + x + 1];
      if (left > right) {
        if (bit < 32) a = (a | (1 << bit)) >>> 0;
        else b = (b | (1 << (bit - 32))) >>> 0;
      }
      bit++;
    }
  }
  return [a, b];
}
// 32×32 RGB 色块签名：每块量化到 3bit/通道（512 色），比较时统计有多少块颜色不同。
// 8×8 太粗（文字/小结构会被平均掉），32×32 能区分“同版式不同内容”，又比逐像素抗压缩。
async function picnestAiColorBlocks(file) {
  const sharp = (await import("sharp")).default;
  const src = file.thumbnail_path && fs.existsSync(file.thumbnail_path) ? file.thumbnail_path : file.file_path;
  return sharp(src).rotate().resize(32, 32, { fit: "fill" })
    .flatten({ background: "#ffffff" }).removeAlpha().raw().toBuffer();
}
function picnestAiColorDiff(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i += 3) {
    const ca = ((a[i] >> 5) << 6) | ((a[i + 1] >> 5) << 3) | (a[i + 2] >> 5);
    const cb = ((b[i] >> 5) << 6) | ((b[i + 1] >> 5) << 3) | (b[i + 2] >> 5);
    if (ca !== cb) diff++;
  }
  return diff;
}
// 64-bit pHash：32×32 灰度做 DCT，取左上 8×8 低频（去 DC）中位数二值化。
// 对缩放/JPEG 比重采样稳定，又能比 9×8 dHash 更好地分辨“同版式不同文字”。
const PICNEST_AI_COS = Array.from({ length: 32 }, (_, u) =>
  Array.from({ length: 32 }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / 64)));
function picnestAiPHash(rgb) {
  const g = new Float64Array(1024);
  for (let i = 0; i < 1024; i++) g[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
  const vals = [];
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      if (!u && !v) continue;
      let s = 0;
      for (let y = 0; y < 32; y++) {
        const row = y * 32;
        let rowSum = 0;
        for (let x = 0; x < 32; x++) rowSum += g[row + x] * PICNEST_AI_COS[u][x];
        s += rowSum * PICNEST_AI_COS[v][y];
      }
      vals.push(s);
    }
  }
  const sorted = [...vals].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  let a = 0, b = 0, bit = 0;
  for (const val of vals) {
    if (val > med) {
      if (bit < 32) a = (a | (1 << bit)) >>> 0;
      else b = (b | (1 << (bit - 32))) >>> 0;
    }
    bit++;
  }
  return [a, b];
}
async function picnestAiThumbData(file) {
  const sharp = (await import("sharp")).default;
  const src = file.thumbnail_path && fs.existsSync(file.thumbnail_path) ? file.thumbnail_path : file.file_path;
  const buf = await sharp(src).rotate().flatten({ background: "#ffffff" })
    .resize({ width: 384, height: 384, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 78 }).toBuffer();
  return "data:image/jpeg;base64," + buf.toString("base64");
}
electron.ipcMain.handle("picnest-ai-dup-cancel", () => { picnestAiCancel = true; return { ok: true }; });
electron.ipcMain.handle("picnest-ai-dup-scan", async (event, folderId, rel, maxPairs) => {
  const send = (p) => { try { if (!event.sender.isDestroyed()) event.sender.send("picnest-ai-dup-progress", p); } catch (e) {} };
  try {
    picnestAiCancel = false;
    picnestMigrate();
    const cfg = picnestAiReadConfig();
    if (!cfg.baseUrl || !cfg.model || !cfg.apiKey) return { ok: false, error: "请先配置并保存 AI API（地址/模型/Key）" };
    const t0 = Date.now();
    const root = getDb().prepare("SELECT id, path FROM folders WHERE id = ?").get(folderId);
    if (!root) return { ok: false, error: "资料库不存在" };
    const sep = root.path.includes("\\") ? "\\" : "/";
    const scopeRel = String(rel || "").replace(/^\/+|\/+$/g, "");
    let rows;
    if (scopeRel) {
      const pat = picnestLikeEscape(root.path + sep + scopeRel.split("/").join(sep) + sep) + "%";
      rows = getDb().prepare(
        `SELECT id, file_path, file_name, file_size, modify_time, width, height, thumbnail_path
         FROM images WHERE folder_id = ? AND deleted_at IS NULL AND file_path LIKE ? ESCAPE '\\'`
      ).all(folderId, pat);
    } else {
      rows = getDb().prepare(
        `SELECT id, file_path, file_name, file_size, modify_time, width, height, thumbnail_path
         FROM images WHERE folder_id = ? AND deleted_at IS NULL`
      ).all(folderId);
    }
    const images = [];
    for (const r of rows) {
      if (!PICNEST_AI_IMG_EXT.has(path.extname(r.file_path).toLowerCase())) continue;
      try {
        const st = fs.statSync(r.file_path);
        if (st.isFile() && st.size > 0) images.push({ ...r, size: st.size, hash: null, color: null, phash: null });
      } catch (e) {}
    }
    send({ phase: "hash", done: 0, total: images.length });
    let done = 0;
    await picnestMapLimit(images, 4, async (im) => {
      const [h, c] = await Promise.allSettled([picnestAiDHash(im), picnestAiColorBlocks(im)]);
      im.hash = h.status === "fulfilled" ? h.value : null;
      im.color = c.status === "fulfilled" ? c.value : null;
      im.phash = im.color ? picnestAiPHash(im.color) : null;
      done++;
      if (done % 4 === 0 || done === images.length) send({ phase: "hash", done, total: images.length });
    });
    const valid = images.filter((im) => im.hash);
    const threshold = 10;
    const colorLimit = 128;   // 32×32 中允许 128 块（12.5%）颜色量化不同
    const colorBypass = 4;    // dHash 距离 ≤4：结构几乎一致，可能是换色/裁剪，直接放行
    const phashLimit = 6;     // 64-bit pHash 汉明距离；同图缩放/压缩通常 0–4
    let dhashPairs = 0;
    let colorFiltered = 0;
    let pairs = [];
    for (let i = 0; i < valid.length; i++) {
      for (let j = i + 1; j < valid.length; j++) {
        const d = picnestAiHam(valid[i].hash, valid[j].hash);
        if (d <= threshold) {
          dhashPairs++;
          let cd = null;
          if (valid[i].color && valid[j].color) cd = picnestAiColorDiff(valid[i].color, valid[j].color);
          let ph = null;
          if (valid[i].phash && valid[j].phash) ph = picnestAiHam(valid[i].phash, valid[j].phash);
          if (d <= colorBypass || cd == null || ph == null || (cd <= colorLimit && ph <= phashLimit)) {
            pairs.push({ i, j, d, color: cd, phash: ph });
            if (pairs.length > 20000) {
              pairs.sort((x, y) => x.d - y.d || (x.color ?? 9999) - (y.color ?? 9999));
              pairs.length = 10000;
            }
          } else colorFiltered++;
        }
      }
    }
    pairs.sort((x, y) => x.d - y.d || (x.color ?? 9999) - (y.color ?? 9999));
    const cap = Math.max(1, Math.min(200, Number(maxPairs) || 40));
    const picked = pairs.slice(0, cap);
    send({ phase: "ai", done: 0, total: picked.length, candidates: pairs.length });
    const dataCache = new Map();
    const getData = async (idx) => {
      if (dataCache.has(idx)) return dataCache.get(idx);
      const d = await picnestAiThumbData(valid[idx]);
      dataCache.set(idx, d);
      return d;
    };
    const confirmed = [];
    let checked = 0;
    for (const p of picked) {
      if (picnestAiCancel) return { ok: false, error: "已取消" };
      let da = "", db = "";
      try { da = await getData(p.i); db = await getData(p.j); } catch (e) { checked++; continue; }
      const same = await picnestAiCompare(cfg, da, db);
      checked++;
      if (same) confirmed.push(p);
      if (checked % 2 === 0 || checked === picked.length) {
        send({ phase: "ai", done: checked, total: picked.length, candidates: pairs.length });
      }
    }
    const parent = valid.map((_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
    for (const p of confirmed) union(p.i, p.j);
    const byRoot = new Map();
    for (let i = 0; i < valid.length; i++) {
      const r = find(i);
      if (!byRoot.has(r)) byRoot.set(r, []);
      byRoot.get(r).push(i);
    }
    const relOf = (fp) => path.relative(root.path, path.dirname(fp)).replace(/[\\/]+/g, "/");
    const groups = [];
    for (const [r, idx] of byRoot.entries()) {
      if (idx.length < 2) continue;
      const filesOut = idx.map((i) => {
        const f = valid[i];
        return { path: f.file_path, name: f.file_name, size: f.size, mtime: f.modify_time, width: f.width, height: f.height, thumb: f.thumbnail_path || "", rel: relOf(f.file_path) };
      });
      filesOut.sort((a, b) => b.size - a.size || String(a.rel).localeCompare(String(b.rel), "zh") || String(a.name).localeCompare(String(b.name), "zh"));
      const sum = filesOut.reduce((s, f) => s + f.size, 0);
      const maxSize = filesOut[0]?.size || 0;
      groups.push({ hash: "ai-" + r, ai: true, size: maxSize, count: filesOut.length, wasted: Math.max(0, sum - maxSize), files: filesOut });
    }
    groups.sort((a, b) => b.wasted - a.wasted || b.count - a.count);
    const stats = {
      scopes: images.length,
      hashable: valid.length,
      dhashPairs,
      colorFiltered,
      candidates: pairs.length,
      checked,
      caps: cap,
      capped: pairs.length > picked.length,
      threshold,
      colorLimit,
      colorBypass,
      phashLimit,
      groups: groups.length,
      files: groups.reduce((s, g) => s + g.count, 0),
      wasted: groups.reduce((s, g) => s + g.wasted, 0),
      ms: Date.now() - t0,
      ai: true,
    };
    return { ok: true, rootId: folderId, rel: scopeRel, groups, stats };
  } catch (e) {
    return { ok: false, error: picnestAiMask(e?.message || e) };
  }
});
/* ==== M6 采集：本地保存服务（自研扩展用，127.0.0.1:41600） ====
   协议：GET /api/v1/ping | /api/v1/context | /api/v1/folders?rootId=
        POST /api/v1/save {kind:'image'|'page', src|dataUrl, title, url, annotation, star, rootId, rel}
   只写目标根目录内的文件；入库复用 insertImagesBatch + sync-db 事件。 */
const PICNEST_COLLECT_PORT = 41600;
let picnestCollectRootId = null;
let picnestCollectHttp = null;

function picnestCollectLog(...args) {
  try {
    const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
    const p = path.join(dataDir, "picnest-collect.log");
    try { if (fs.existsSync(p) && fs.statSync(p).size > 1024 * 1024) fs.renameSync(p, p + ".old"); } catch (e) {}
    fs.appendFileSync(p, line);
  } catch (e) {}
}
function picnestCollectRoots() {
  try { return getDb().prepare("SELECT id, path, display_name FROM folders ORDER BY id").all(); } catch (e) { return []; }
}
function picnestCollectRoot(rootId) {
  const roots = picnestCollectRoots();
  if (rootId != null) {
    const hit = roots.find((r) => String(r.id) === String(rootId));
    if (hit) return hit;
  }
  if (picnestCollectRootId != null) {
    const hit = roots.find((r) => r.id === picnestCollectRootId);
    if (hit) return hit;
  }
  return roots[0] || null;
}
function picnestCollectTree(rootPath, rel = "") {
  const abs = rel ? path.join(rootPath, ...rel.split("/")) : rootPath;
  let ents = [];
  try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return []; }
  return ents
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "Thumbs.db" && d.name !== "$RECYCLE.BIN")
    .sort((a, b) => a.name.localeCompare(b.name, "zh"))
    .map((d) => {
      const childRel = rel ? rel + "/" + d.name : d.name;
      return { id: childRel, name: d.name, parent: rel || null, children: picnestCollectTree(rootPath, childRel) };
    });
}
function picnestCollectTarget(rootId, rel) {
  const root = picnestCollectRoot(rootId);
  if (!root?.path) throw new Error("没有可用的根文件");
  const safeRel = String(rel || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const absRoot = path.resolve(root.path);
  const abs = safeRel ? path.resolve(absRoot, ...safeRel.split("/")) : absRoot;
  if (abs !== absRoot && !abs.startsWith(absRoot + path.sep)) throw new Error("目标不在根文件内");
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error("目标文件夹不存在");
  return { root, abs, rel: safeRel };
}
function picnestCollectSafeName(name) {
  return String(name || "采集")
    .replace(/[\\/:*?"<>|\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "采集";
}
function picnestCollectExt(contentType, src) {
  const ct = String(contentType || "").toLowerCase();
  const map = {
    "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/gif": ".gif",
    "image/webp": ".webp", "image/avif": ".avif", "image/bmp": ".bmp", "image/svg+xml": ".svg",
  };
  if (map[ct]) return map[ct];
  const m = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(String(src || ""));
  if (m) {
    const ext = "." + m[1].toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp", ".svg"].includes(ext)) return ext;
  }
  return ".jpg";
}
function picnestCollectDataUrl(u) {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(String(u || ""));
  if (!m) return null;
  const buf = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8");
  return { buf, contentType: m[1] || "application/octet-stream" };
}
async function picnestCollectFetchImage(src, referer) {
  const u = String(src || "");
  if (u.startsWith("data:")) {
    const d = picnestCollectDataUrl(u);
    if (!d) throw new Error("dataUrl 解析失败");
    return d;
  }
  if (!/^https?:\/\//i.test(u)) throw new Error("只支持 http(s) 或 data: 图片");
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = setTimeout(() => { try { ctl?.abort(); } catch (e) {} }, 30000);
  try {
    /* Pixiv（i.pximg.net）等站点按 Referer 防盗链；用页面 URL 作 Referer，并伪装常规浏览器 UA */
    const ref = String(referer || "").trim() || (() => {
      try { return new URL(u).origin + "/"; } catch (e) { return ""; }
    })();
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
      "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    };
    if (ref) headers.Referer = ref;
    const res = await fetch(u, {
      redirect: "follow",
      signal: ctl?.signal,
      headers,
    });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    if (ab.byteLength > 80 * 1024 * 1024) throw new Error("文件超过 80MB");
    return { buf: Buffer.from(ab), contentType: res.headers.get("content-type") || "" };
  } finally { clearTimeout(timer); }
}
/* 采集查重：同根内同尺寸候选 → MD5；返回已存在项（用于扩展面板的重复提醒） */
function picnestCollectDupes(root, buf) {
  try {
    const rows = getDb().prepare(
      "SELECT file_path, file_name, width, height FROM images WHERE folder_id = ? AND file_size = ? AND deleted_at IS NULL LIMIT 6"
    ).all(root.id, buf.length);
    if (!rows.length) return [];
    const md5 = crypto.createHash("md5").update(buf).digest("hex");
    const rootAbs = path.resolve(root.path);
    const out = [];
    for (const r of rows) {
      try {
        if (!fs.existsSync(r.file_path)) continue;
        if (picnestMd5(r.file_path) !== md5) continue;
        let folder = root.display_name || path.basename(rootAbs);
        try {
          const p = path.resolve(r.file_path);
          if (p.startsWith(rootAbs + path.sep)) {
            const rel = p.slice(rootAbs.length + 1);
            const i = rel.lastIndexOf(path.sep);
            if (i > 0) folder = rel.slice(0, i).split(path.sep).pop();
          }
        } catch (e) {}
        out.push({ file_path: r.file_path, file_name: r.file_name, width: r.width, height: r.height, folder });
      } catch (e) {}
    }
    return out;
  } catch (e) { return []; }
}
function picnestCollectInsert(root, absFile, meta = {}) {  const st = fs.statSync(absFile);
  insertImagesBatch(root.id, [{
    file_path: absFile,
    file_name: path.basename(absFile),
    file_size: st.size,
    modify_time: Math.floor(st.mtimeMs / 1000),
    sort_order: 0,
  }]);
  try {
    getDb().prepare(
      "UPDATE images SET annotation = CASE WHEN ?='' THEN annotation ELSE ? END, url = CASE WHEN ?='' THEN url ELSE ? END, is_favorite = MAX(is_favorite, ?) WHERE file_path = ?"
    ).run(String(meta.annotation || ""), String(meta.annotation || ""), String(meta.url || ""), String(meta.url || ""), meta.star ? 1 : 0, absFile);
  } catch (e) {}
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("sync-db", {
      type: "add",
      image: {
        file_path: absFile, file_name: path.basename(absFile), file_size: st.size,
        modify_time: Math.floor(st.mtimeMs / 1000), thumbnail_path: "", width: 0, height: 0,
        is_favorite: meta.star ? 1 : 0,
      },
    });
  }
  return absFile;
}
async function picnestCollectSaveOne(item) {
  const t = picnestCollectTarget(item.rootId, item.rel);
  const kind = String(item.kind || (item.dataUrl ? "page" : "image"));
  let buf, contentType, ext, base;
  if (kind === "page" || kind === "screenshot") {
    const d = picnestCollectDataUrl(item.dataUrl);
    if (!d) throw new Error("缺少截图数据");
    buf = d.buf;
    contentType = d.contentType;
    ext = picnestCollectExt(contentType, "");
    base = picnestCollectSafeName(item.title || "页面截图");
  } else {
    const d = await picnestCollectFetchImage(item.dataUrl || item.src, item.url || item.referer);
    buf = d.buf;
    contentType = d.contentType;
    ext = picnestCollectExt(contentType, item.src || item.dataUrl);
    base = picnestCollectSafeName(item.title || "图片");
  }
  if (!/^image\//i.test(contentType) && !/\.(jpe?g|png|gif|webp|avif|bmp|svg)$/i.test(ext)) throw new Error("不是图片内容");
  /* 覆盖模式：先照常写新图，成功后再把旧匹配项软删（进图巢回收站）；普通模式命中即拦截 */
  const matches = (item.overwrite || !item.force) ? picnestCollectDupes(t.root, buf) : [];
  if (matches.length && !item.overwrite && !item.force) {
    return { ok: false, duplicate: true, matches, rootId: t.root.id, rel: t.rel, error: "已存在相同图片，未保存" };
  }
  let dest = path.join(t.abs, base + ext);
  let n = 2;
  while (fs.existsSync(dest)) dest = path.join(t.abs, `${base} (${n++})${ext}`);
  fs.writeFileSync(dest, buf);
  picnestCollectInsert(t.root, dest, item);
  let overwritten = 0;
  if (matches.length && item.overwrite) {
    const now = Date.now();
    const stmt = getDb().prepare("UPDATE images SET deleted_at = ?, trash_group = NULL WHERE file_path = ? AND deleted_at IS NULL");
    for (const m of matches) {
      try {
        const r = stmt.run(now, m.file_path);
        if (r.changes) {
          overwritten++;
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("sync-db", { type: "unlink", path: m.file_path });
        }
      } catch (e) {}
    }
    picnestCollectLog("overwrite", `new=${dest}`, `old=${overwritten}`);
  }
  picnestCollectLog("saved", dest, `${buf.length}B`, `root=${t.root.id}`, `rel=${t.rel || "__root__"}`);
  return { ok: true, saved: dest, name: path.basename(dest), rootId: t.root.id, rel: t.rel, overwritten };
}
function picnestCollectCors(req, res) {
  const origin = String(req.headers.origin || "");
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}
function picnestCollectJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}
function picnestCollectReadJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body 过大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (e) { reject(new Error("JSON 解析失败")); }
    });
    req.on("error", reject);
  });
}
function picnestStartCollectServer() {
  if (picnestCollectHttp) return;
  const http = require("http");
  const server = http.createServer(async (req, res) => {
    picnestCollectCors(req, res);
    if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
    const origin = String(req.headers.origin || "");
    const originOk = !origin
      || /^(chrome-extension|extension):\/\//i.test(origin)
      || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin);
    if (!originOk) { picnestCollectJson(res, 403, { ok: false, error: "origin not allowed" }); return; }
    const url = new URL(req.url || "/", `http://127.0.0.1:${PICNEST_COLLECT_PORT}`);
    try {
      if (req.method === "GET" && url.pathname === "/api/v1/ping") {
        return picnestCollectJson(res, 200, { ok: true, app: "PicNest", api: 1, port: PICNEST_COLLECT_PORT });
      }
      if (req.method === "GET" && url.pathname === "/api/v1/context") {
        const roots = picnestCollectRoots();
        const cur = picnestCollectRoot(url.searchParams.get("rootId"));
        return picnestCollectJson(res, 200, {
          ok: true,
          roots: roots.map((r) => ({ id: r.id, name: r.display_name || path.basename(r.path), path: r.path })),
          rootId: cur?.id ?? null,
          rootName: cur ? (cur.display_name || path.basename(cur.path)) : "",
        });
      }
      if (req.method === "GET" && url.pathname === "/api/v1/folders") {
        const root = picnestCollectRoot(url.searchParams.get("rootId"));
        if (!root) return picnestCollectJson(res, 404, { ok: false, error: "没有根文件" });
        return picnestCollectJson(res, 200, {
          ok: true,
          root: { id: root.id, name: root.display_name || path.basename(root.path), path: root.path },
          folders: picnestCollectTree(root.path),
        });
      }
      if (req.method === "POST" && url.pathname === "/api/v1/folder/create") {
        const body = await picnestCollectReadJson(req);
        const parent = picnestCollectTarget(body.rootId, body.parentRel || "");
        let name = String(body.name || "")
          .replace(/[\\/:*?"<>|\r\n\t]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80);
        if (!name) return picnestCollectJson(res, 400, { ok: false, error: "文件夹名不能为空" });
        let dest = path.join(parent.abs, name);
        let n = 2;
        while (fs.existsSync(dest)) dest = path.join(parent.abs, `${name} (${n++})`);
        fs.mkdirSync(dest);
        const finalName = path.basename(dest);
        const rel = parent.rel ? parent.rel + "/" + finalName : finalName;
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("sync-db", { type: "dirs-changed", rootId: parent.root.id, rel });
          }
        } catch (e) {}
        picnestCollectLog("mkdir", dest, `root=${parent.root.id}`);
        return picnestCollectJson(res, 200, { ok: true, folder: { id: rel, name: finalName, parent: parent.rel || null } });
      }
      if (req.method === "POST" && url.pathname === "/api/v1/save") {
        const body = await picnestCollectReadJson(req);
        const items = Array.isArray(body.items) ? body.items : [body];
        const results = [];
        for (const it of items) results.push(await picnestCollectSaveOne(it));
        const dup = results.find((x) => x.duplicate);
        const payload = { ok: results.every((x) => x.ok), saved: results, count: results.length };
        if (dup) Object.assign(payload, {
          duplicate: true, matches: dup.matches, rootId: dup.rootId, rel: dup.rel, error: dup.error,
        });
        return picnestCollectJson(res, 200, payload);
      }
      return picnestCollectJson(res, 404, { ok: false, error: "not found" });
    } catch (e) {
      picnestCollectLog("error", req.method, url.pathname, String(e?.message || e));
      return picnestCollectJson(res, 400, { ok: false, error: String(e?.message || e) });
    }
  });
  server.on("error", (e) => {
    picnestCollectLog("listen error", String(e?.message || e));
    console.error("[collect] listen error:", e?.message || e);
  });
  server.listen(PICNEST_COLLECT_PORT, "127.0.0.1", () => {
    picnestCollectLog("listening", `127.0.0.1:${PICNEST_COLLECT_PORT}`, `pid=${process.pid}`);
    try {
      fs.writeFileSync(path.join(dataDir, "picnest-collect.json"), JSON.stringify({
        port: PICNEST_COLLECT_PORT, pid: process.pid, startedAt: new Date().toISOString(),
      }, null, 2));
    } catch (e) {}
  });
  picnestCollectHttp = server;
}
electron.ipcMain.handle("picnest-collect-set-root", (_event, id) => {
  picnestCollectRootId = id == null || id === "" ? null : Number(id);
  return { ok: true, rootId: picnestCollectRootId };
});
electron.ipcMain.handle("picnest-collect-info", () => ({
  ok: true,
  port: PICNEST_COLLECT_PORT,
  listening: !!picnestCollectHttp?.listening,
  rootId: picnestCollectRootId,
}));
if (electron.app.isReady()) {
  setTimeout(() => { try { picnestStartCollectServer(); } catch (e) { picnestCollectLog("start error", String(e?.message || e)); } }, 2000);
} else {
  electron.app.whenReady().then(() => {
    setTimeout(() => { try { picnestStartCollectServer(); } catch (e) { picnestCollectLog("start error", String(e?.message || e)); } }, 2000);
  });
}
/* ==== /M6 采集 ==== */

/* ==== /PicNest:P4 ==== */
