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
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      created_at INTEGER NOT NULL DEFAULT 0
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS image_tags (
      image_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (image_id, tag_id)
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_image_tags_tag ON image_tags(tag_id)");
    // 图片行被永久删除时顺手清关联；软删（deleted_at）保留标签，方便还原
    db.exec(`CREATE TRIGGER IF NOT EXISTS picnest_image_tags_cleanup
      AFTER DELETE ON images BEGIN DELETE FROM image_tags WHERE image_id = OLD.id; END`);
  } catch (e) {}
  try { picnestMigrateTextThumbs() } catch (e) {}
  try { picnestMigrateThumbCacheDir() } catch (e) {}
  try { picnestMigrateDirOrderKeys() } catch (e) {}
  try { picnestMigrateDirMemoryKeys() } catch (e) {}
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
    if (img.thumbnail_path && !fs.existsSync(img.thumbnail_path)) {
      /* 缓存被外部清理（浏览器缓存/手动删）→ DB 也清掉，避免每次查询都拿着死路径 */
      try { getDb().prepare("UPDATE images SET thumbnail_path = '' WHERE id = ?").run(img.id); } catch (e) {}
      img.thumbnail_path = "";
    }
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

/* 缩略图缓存目录迁移：旧 dataDir/cache 与 Chromium Cache 同名（Windows 大小写不敏感），
   浏览器清理缓存时缩略图一起消失。新目录 = picnest-thumbs；这里把旧文件中仍被 DB 引用的搬过来。 */
function picnestMigrateThumbCacheDir() {
  try {
    const oldDir = path.join(dataDir, "cache");
    if (path.resolve(oldDir) === path.resolve(cacheDir)) return; // 还没打 P10 补丁
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    const db = getDb();
    const rows = db.prepare("SELECT id, thumbnail_path FROM images WHERE thumbnail_path IS NOT NULL AND thumbnail_path NOT IN ('', 'SKIP')").all();
    const upd = db.prepare("UPDATE images SET thumbnail_path = ? WHERE id = ?");
    const oldNorm = oldDir.toLowerCase() + path.sep;
    for (const r of rows) {
      const tp = String(r.thumbnail_path || "");
      if (!tp.toLowerCase().startsWith(oldNorm)) continue;
      try {
        if (!fs.existsSync(tp)) { upd.run("", r.id); continue; }
        const dest = path.join(cacheDir, path.basename(tp));
        if (!fs.existsSync(dest)) fs.renameSync(tp, dest);
        else { try { fs.unlinkSync(tp); } catch (e) {} }
        upd.run(dest, r.id);
      } catch (e) {
        try { upd.run("", r.id); } catch (e2) {}
      }
    }
  } catch (e) { /* 迁移失败不阻塞启动 */ }
}

/* 缩略图批量修复：只补「没有缩略图 / 缓存文件已丢」的图片，复用 ensureQuickThumb（含 PSD/视频） */
let picnestThumbRepairCancel = false;
function picnestThumbRepairNeed(folderId) {
  const out = [];
  try {
    picnestMigrate();
    const rows = getDb().prepare(
      "SELECT id, file_path, thumbnail_path FROM images WHERE folder_id = ? AND deleted_at IS NULL"
    ).all(folderId);
    for (const r of rows) {
      const ext = path.extname(r.file_path).toLowerCase();
      if (PICNEST_TEXT_EXTS.has(ext)) continue; // 文本走纸面缩略图管线
      if (r.thumbnail_path && r.thumbnail_path !== "SKIP" && fs.existsSync(r.thumbnail_path)) continue;
      if (!fs.existsSync(r.file_path)) continue;
      out.push(r);
    }
  } catch (e) { /* 返回已收集部分 */ }
  return out;
}
electron.ipcMain.handle("picnest-thumbs-missing", (_event, folderId) => ({ ok: true, count: picnestThumbRepairNeed(folderId).length }));
/* 大格子显示图：1024px 有界缩略图（网格不再解码 10MB+ 原图；Chromium 解码缓存预算会偶发失败）。
   缓存名带 modify_time，旋转/裁剪/外部修改后自动失效；失败返回空串，前端退回 400 缩略图。 */
electron.ipcMain.handle("picnest-display-thumbs", async (_event, paths) => {
  const results = [];
  try {
    const sharp = (await import("sharp")).default;
    const list = [...new Set((paths || []).filter(Boolean))].slice(0, 80);
    await picnestMapLimit(list, 2, async (fp) => {
      try {
        const row = getDb().prepare("SELECT modify_time FROM images WHERE file_path = ?").get(fp);
        const mt = row?.modify_time || 0;
        const out = path.join(cacheDir, crypto.createHash("md5").update(fp + "|d1024|" + mt).digest("hex") + "-d1024.webp");
        if (!fs.existsSync(out)) {
          await sharp(fp, { failOn: "none" }).rotate().flatten({ background: "#ffffff" })
            .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
            .webp({ quality: 82 }).toFile(out);
        }
        results.push({ file_path: fp, thumbnail_path: out });
      } catch (e) { results.push({ file_path: fp, thumbnail_path: "" }); }
    });
  } catch (e) { /* sharp 不可用：前端用 400 缩略图 */ }
  return { ok: true, results };
});
electron.ipcMain.handle("picnest-repair-thumbs-cancel", () => { picnestThumbRepairCancel = true; return { ok: true }; });
electron.ipcMain.handle("picnest-repair-thumbs", async (event, folderId) => {
  const send = (p) => { try { if (!event.sender.isDestroyed()) event.sender.send("picnest-thumb-repair-progress", p); } catch (e) {} };
  picnestThumbRepairCancel = false;
  const t0 = Date.now();
  try {
    const sharp = (await import("sharp")).default;
    const need = picnestThumbRepairNeed(folderId);
    const total = need.length;
    let done = 0, ok = 0, fail = 0;
    const failedNames = [];
    send({ done: 0, total, generated: 0, failed: 0 });
    await picnestMapLimit(need, 2, async (r) => {
      if (picnestThumbRepairCancel) return;
      const fp = r.file_path;
      try {
        const ext = path.extname(fp).toLowerCase();
        const base = crypto.createHash("md5").update(fp).digest("hex");
        const thumb = path.join(cacheDir, base + (ext === ".gif" ? ".gif" : ".webp"));
        const out = await ensureQuickThumb(fp, thumb);
        if (out && out !== fp && fs.existsSync(out)) {
          try {
            const m = await sharp(fp).metadata();
            if (m.width && m.height) updateImageDimensions(fp, m.width, m.height);
          } catch (e) { /* 尺寸拿不到不影响缩略图 */ }
          ok++;
        } else {
          fail++;
          if (failedNames.length < 12) failedNames.push(path.basename(fp));
        }
      } catch (e) {
        fail++;
        if (failedNames.length < 12) failedNames.push(path.basename(fp));
      }
      done++;
      if (done % 5 === 0 || done === total) send({ done, total, generated: ok, failed: fail });
    });
    return {
      ok: true, total, done, generated: ok, failed: fail, failedNames,
      canceled: picnestThumbRepairCancel, ms: Date.now() - t0,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), total: 0, done: 0, generated: 0, failed: 0 };
  }
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

/* 文件夹放入前的库内查重：按文件大小筛候选 → 流式 MD5 确认；跳过自身与“目标同名位置”的噪声重复
   整包 MD5 走异步流：大文件夹不卡主进程；同路径只算一次（cache）；进度走 picnest-dir-dup-progress */
let picnestDirDupCancel = false;
electron.ipcMain.handle("picnest-dir-dup-cancel", () => { picnestDirDupCancel = true; return { ok: true }; });
electron.ipcMain.handle("picnest-dir-dup-check", async (event, srcDir, targetDir, folderId) => {
  const out = { ok: false, count: 0, scanned: 0, items: [] };
  const send = (p) => { try { if (!event.sender.isDestroyed()) event.sender.send("picnest-dir-dup-progress", p); } catch (e) {} };
  try {
    picnestDirDupCancel = false;
    if (!srcDir || !fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) return { ...out, error: "源文件夹不存在" };
    const norm = (p) => path.resolve(p).toLowerCase();
    const destRoot = path.join(targetDir, path.basename(srcDir).replace(/[\\/:*?"<>|]/g, "_"));
    const files = [];
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
        files.push({ path: p, name: ent.name });
      }
    };
    walk(srcDir);
    const total = files.length;
    send({ phase: "hash", done: 0, total });
    const candStmt = getDb().prepare(
      "SELECT file_path, file_name, width, height FROM images WHERE file_size = ? AND folder_id = ? AND deleted_at IS NULL LIMIT 8"
    );
    const cache = new Map();
    let done = 0;
    await picnestMapLimit(files, 4, async (ent) => {
      if (picnestDirDupCancel) return;
      try {
        let st;
        try { st = await fs.promises.stat(ent.path); } catch (e) { return; }
        if (!st.isFile()) return;
        const cands = candStmt.all(st.size, folderId);
        if (!cands.length) return;
        const md5 = await picnestMd5Of(ent.path, cache);
        if (!md5) return;
        const destPath = path.join(destRoot, path.relative(srcDir, ent.path));
        /* 目标同名位置已有同内容文件 → 合并时天然跳过，不算待处理重复；
           否则报告库内其他位置的同内容文件 */
        let atDest = false;
        let hit = null;
        for (const c of cands) {
          const same = norm(c.file_path) === norm(ent.path);
          const isDest = norm(c.file_path) === norm(destPath);
          if (same && !isDest) continue; // 自己（且不是目标同位）
          if (!fs.existsSync(c.file_path)) continue;
          if ((await picnestMd5Of(c.file_path, cache)) !== md5) continue;
          if (isDest) { atDest = true; break; }
          if (!hit) hit = c;
        }
        if (atDest || !hit) return;
        out.count++;
        out.items.push({
          src: ent.path, name: ent.name, size: st.size,
          existing: {
            file_path: hit.file_path, file_name: hit.file_name,
            width: hit.width, height: hit.height,
            folderName: path.basename(path.dirname(hit.file_path)),
          },
        });
      } catch (e) { /* 单个文件失败不阻塞 */ }
      finally {
        done++;
        if (done % 3 === 0 || done === total) send({ phase: "hash", done, total });
      }
    });
    if (picnestDirDupCancel) return { ...out, ok: false, canceled: true, error: "已取消" };
    out.items.sort((a, b) => String(a.src).localeCompare(String(b.src), "zh"));
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

/* 拖出到外部应用（CSP / PS / 资源管理器）：Electron 原生文件拖拽。
   统一拖拽：窗口内普通 HTML5 拖动继续走内部高亮/排序；主进程轮询光标，光标离开
   PicNest 且左键仍按下时升级为 startDrag。这样不需要 Alt/单独手柄。 */
const picnestDragSessions = new Map();
let _picnestGetAsyncKeyState = null;

function picnestLeftButtonDown() {
  try {
    if (!_picnestGetAsyncKeyState) {
      const koffi = require("koffi");
      const user32 = koffi.load("user32.dll");
      _picnestGetAsyncKeyState = user32.func("GetAsyncKeyState", "int16", ["int"]);
    }
    return (_picnestGetAsyncKeyState(1) & 0x8000) !== 0;
  } catch (e) {
    return true;
  }
}

function picnestDragIcon(list) {
  const iconPath = isDev
    ? path.join(process.cwd(), "_internal_data", "icon.png")
    : path.join(__dirname, "../../../../_internal_data", "icon.png");
  let icon = electron.nativeImage.createEmpty();
  if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(list[0])) {
    try { icon = electron.nativeImage.createFromPath(list[0]); } catch (e) {}
  }
  if (icon.isEmpty()) icon = electron.nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) icon = icon.resize({ width: 96 });
  return icon;
}

function picnestEndDragSession(id) {
  const st = picnestDragSessions.get(id);
  if (st?.timer) clearInterval(st.timer);
  picnestDragSessions.delete(id);
}

/* 普通拖拽开始：先让渲染层继续 HTML5 内部拖拽；光标离开窗口再升级为原生拖出。 */
electron.ipcMain.on("picnest-drag-begin", (event, paths) => {
  try {
    const sender = event.sender;
    const list = (Array.isArray(paths) ? paths : [paths])
      .filter((p) => typeof p === "string" && p && fs.existsSync(p));
    if (!list.length) return;
    picnestEndDragSession(sender.id);
    const win = electron.BrowserWindow.fromWebContents(sender);
    if (!win) return;
    const state = { list, timer: null, escalated: false };
    let outsideTicks = 0;
    state.timer = setInterval(() => {
      if (state.escalated) return;
      try {
        if (sender.isDestroyed()) { picnestEndDragSession(sender.id); return; }
        if (!picnestLeftButtonDown()) {
          picnestEndDragSession(sender.id);
          return;
        }
        const pt = electron.screen.getCursorScreenPoint();
        const b = win.getBounds();
        const outside = pt.x < b.x - 4 || pt.x > b.x + b.width + 4 ||
          pt.y < b.y - 4 || pt.y > b.y + b.height + 4;
        if (!outside) { outsideTicks = 0; return; }
        outsideTicks++;
        if (outsideTicks < 2) return;
        state.escalated = true;
        clearInterval(state.timer);
        state.timer = null;
        try { sender.send("picnest-drag-out-start"); } catch (e) {}
        try {
          sender.startDrag({ file: list[0], files: list, icon: picnestDragIcon(list) });
        } catch (e) {
          console.error("[picnest-drag-out]", e);
        }
        try {
          if (!sender.isDestroyed()) sender.send("picnest-drag-out-end");
        } catch (e) {}
        picnestDragSessions.delete(sender.id);
      } catch (e) {
        console.error("[picnest-drag-poll]", e);
        try {
          if (!sender.isDestroyed()) sender.send("picnest-drag-out-end");
        } catch (e2) {}
        picnestEndDragSession(sender.id);
      }
    }, 45);
    picnestDragSessions.set(sender.id, state);
  } catch (e) {
    console.error("[picnest-drag-begin]", e);
  }
});

electron.ipcMain.on("picnest-drag-end", (event) => {
  picnestEndDragSession(event.sender.id);
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
  const cache = new Map();
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
      const md5New = await picnestMd5Of(p, cache);
      for (const c of cands) {
        if (!fs.existsSync(c.file_path)) continue;
        if ((await picnestMd5Of(c.file_path, cache)) === md5New) { existing = c; break; }
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
electron.ipcMain.handle("picnest-rename-library", (_event, id, name, opts) => {
  try {
    picnestMigrate();
    const displayOnly = !!opts?.displayOnly;
    const rawName = String(name || "").trim();
    const clean = rawName.replace(/[\\/:*?"<>|]/g, "").replace(/[. ]+$/g, "");
    if (!clean) return { ok: false, error: "名称为空" };
    const db = getDb();
    const root = db.prepare("SELECT id, path, display_name FROM folders WHERE id = ?").get(id);
    if (!root) return { ok: false, error: "根文件不存在" };
    if (displayOnly) {
      // 仅显示名（Eagle 向导区分同名根等）；物理目录不动
      db.prepare("UPDATE folders SET display_name = ? WHERE id = ?").run(rawName, id);
      return { ok: true, path: root.path, name: rawName, display_name: rawName, displayOnly: true };
    }
    const oldPath = path.resolve(root.path);
    const newPath = path.join(path.dirname(oldPath), clean);
    const norm = (p) => String(p || "").replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
    const samePath = norm(oldPath) === norm(newPath);
    if (!samePath && fs.existsSync(newPath)) return { ok: false, error: "同名文件夹已存在" };

    /* watcher 先停，改名后重启到新路径；否则 worker 可能把旧路径/根重新登记 */
    let wasWatching = false, win = null, onAdd = null, onDelete = null;
    try {
      if (typeof watchedFolder === "string" && watchedFolder && norm(watchedFolder) === norm(oldPath)) {
        wasWatching = true;
        win = _mainWindow; onAdd = _onAddCb; onDelete = _onDeleteCb;
        stopWatching();
      }
    } catch (e) {}

    const oldPrefix = oldPath.replace(/[\\/]+$/, "");
    const newPrefix = newPath.replace(/[\\/]+$/, "");
    try {
      if (!samePath) fs.renameSync(oldPath, newPath);
      const tx = db.transaction(() => {
        db.prepare("UPDATE folders SET path = ?, display_name = ? WHERE id = ?").run(newPath, clean, id);
        const imgs = db.prepare("SELECT id, file_path FROM images WHERE folder_id = ?").all(id);
        const updImg = db.prepare("UPDATE images SET file_path = ? WHERE id = ?");
        for (const im of imgs) {
          if (norm(im.file_path).startsWith(norm(oldPrefix) + "\\")) {
            updImg.run(newPrefix + im.file_path.slice(oldPrefix.length), im.id);
          }
        }
        const trashes = db.prepare("SELECT id, abs_path FROM picnest_trash_folders WHERE folder_id = ?").all(id);
        const updTrash = db.prepare("UPDATE picnest_trash_folders SET abs_path = ? WHERE id = ?");
        for (const t of trashes) {
          if (norm(t.abs_path).startsWith(norm(oldPrefix) + "\\")) {
            updTrash.run(newPrefix + t.abs_path.slice(oldPrefix.length), t.id);
          }
        }
      });
      tx();
    } catch (e) {
      if (!samePath) { try { fs.renameSync(newPath, oldPath); } catch (e2) {} }
      return { ok: false, error: String(e?.message || e) };
    }
    /* 手动封面存的是绝对路径（dirMemory.cover），根改名后同步更新 */
    try {
      const c = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const mem = c.picnestDirMemory || {};
      let changed = false;
      for (const v of Object.values(mem)) {
        if (v && typeof v.cover === "string" && norm(v.cover).startsWith(norm(oldPrefix) + "\\")) {
          v.cover = newPrefix + v.cover.slice(oldPrefix.length);
          changed = true;
        }
      }
      if (changed) fs.writeFileSync(configPath, JSON.stringify(c, null, 2));
    } catch (e) {}
    // watcher 不在主进程重启：旧的 onAdd 闭包捕获的是旧路径。渲染层拿 wasWatching 后用新路径重新 startWatcher。
    return { ok: true, path: newPath, name: clean, display_name: clean, wasWatching };
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
    /* 移出前先把标签/颜色/排序写进 <root>/.picnest/meta.json，之后重新加回可恢复 */
    try { picnestMetaExport(folderId); } catch (e) {}
    const images = db.prepare("DELETE FROM images WHERE folder_id = ?").run(folderId).changes;
    db.prepare("DELETE FROM picnest_trash_folders WHERE folder_id = ?").run(folderId);
    db.prepare("DELETE FROM folders WHERE id = ?").run(folderId);
    /* 移出根后清孤儿标签：图片行已删，清掉不再被任何图片引用的标签 */
    let tagsRemoved = 0;
    try {
      db.prepare("DELETE FROM image_tags WHERE image_id NOT IN (SELECT id FROM images)").run();
      tagsRemoved = db.prepare("DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM image_tags)").run().changes;
    } catch (e) { /* 旧库无标签表时不阻塞移出 */ }
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
    return { ok: true, images, name: root.display_name || path.basename(root.path), tagsRemoved };
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
      const oldNorm = oldPath.replace(/[\\/]+$/, "").toLowerCase();
      for (const key of Object.keys(mem)) {
        if (key === oldRel) { mem[newRel] = mem[key]; delete mem[key]; }
        else if (key.startsWith(oldRel + "/")) { mem[newRel + key.slice(oldRel.length)] = mem[key]; delete mem[key]; }
      }
      // 文件夹封面存的是绝对路径，目录改名后同步
      for (const v of Object.values(mem)) {
        if (v && typeof v.cover === "string" && v.cover.toLowerCase().startsWith(oldNorm + "\\")) {
          v.cover = newPath + v.cover.slice(oldPath.length);
        }
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
    if (img.thumbnail_path && !fs.existsSync(img.thumbnail_path)) {
      /* 缓存被外部清理（浏览器缓存/手动删）→ DB 也清掉，避免每次查询都拿着死路径 */
      try { getDb().prepare("UPDATE images SET thumbnail_path = '' WHERE id = ?").run(img.id); } catch (e) {}
      img.thumbnail_path = "";
    }
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

/* ==== 标签系统（全局标签名 + 图片关联；按 folder_id 统计/加载当前根） ==== */
function picnestTagName(raw) {
  const name = String(raw || "").trim().replace(/\s+/g, " ");
  if (!name || !name.replace(/#/g, "").trim()) throw new Error("标签名不能为空");
  if (name.length > 60) throw new Error("标签名最多 60 字");
  return name;
}
function picnestTagImageIds(raw) {
  return [...new Set((Array.isArray(raw) ? raw : [])
    .map((x) => Number(x))
    .filter((n) => Number.isInteger(n) && n > 0))].slice(0, 10000);
}
function picnestTagEnsure(name) {
  const db = getDb();
  const hit = db.prepare("SELECT id, name FROM tags WHERE name = ? COLLATE NOCASE").get(name);
  if (hit) return hit;
  const info = db.prepare("INSERT INTO tags(name, created_at) VALUES (?, ?)").run(name, Date.now());
  return { id: Number(info.lastInsertRowid), name };
}
electron.ipcMain.handle("picnest-tags-list", (_event, folderId) => {
  try {
    picnestMigrate();
    const db = getDb();
    const tags = db.prepare(`SELECT t.id, t.name, COUNT(DISTINCT i.id) AS count
      FROM tags t
      LEFT JOIN image_tags it ON it.tag_id = t.id
      LEFT JOIN images i ON i.id = it.image_id AND i.folder_id = ? AND i.deleted_at IS NULL
      GROUP BY t.id ORDER BY t.name COLLATE NOCASE`).all(folderId);
    const rows = db.prepare(`SELECT it.image_id, it.tag_id FROM image_tags it
      JOIN images i ON i.id = it.image_id
      WHERE i.folder_id = ? AND i.deleted_at IS NULL`).all(folderId);
    const imageTags = {};
    for (const r of rows) {
      if (!imageTags[r.image_id]) imageTags[r.image_id] = [];
      imageTags[r.image_id].push(r.tag_id);
    }
    return { ok: true, tags, imageTags };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
electron.ipcMain.handle("picnest-tag-assign", (_event, opts) => {
  try {
    picnestMigrate();
    const ids = picnestTagImageIds(opts?.imageIds);
    if (!ids.length) return { ok: false, error: "没有目标图片" };
    const action = opts?.action === "remove" ? "remove" : "add";
    const db = getDb();
    let tag = null;
    if (action === "add") {
      tag = picnestTagEnsure(picnestTagName(opts?.name));
    } else {
      const byId = Number(opts?.tagId) || 0;
      tag = byId
        ? db.prepare("SELECT id, name FROM tags WHERE id = ?").get(byId)
        : db.prepare("SELECT id, name FROM tags WHERE name = ? COLLATE NOCASE").get(picnestTagName(opts?.name));
      if (!tag) return { ok: false, error: "标签不存在" };
    }
    let changed = 0;
    const tx = db.transaction(() => {
      if (action === "add") {
        const stmt = db.prepare(`INSERT OR IGNORE INTO image_tags(image_id, tag_id, created_at)
          SELECT id, ?, ? FROM images WHERE id = ? AND deleted_at IS NULL`);
        for (const id of ids) changed += stmt.run(tag.id, Date.now(), id).changes;
      } else {
        const stmt = db.prepare("DELETE FROM image_tags WHERE image_id = ? AND tag_id = ?");
        for (const id of ids) changed += stmt.run(id, tag.id).changes;
      }
    });
    tx();
    return { ok: true, tag: { id: tag.id, name: tag.name }, changed };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
electron.ipcMain.handle("picnest-tag-rename", (_event, opts) => {
  try {
    picnestMigrate();
    const id = Number(opts?.tagId) || 0;
    if (!id) return { ok: false, error: "标签不存在" };
    const name = picnestTagName(opts?.name);
    const db = getDb();
    const hit = db.prepare("SELECT id FROM tags WHERE name = ? COLLATE NOCASE AND id <> ?").get(name, id);
    if (hit) return { ok: false, error: "已有同名标签" };
    const info = db.prepare("UPDATE tags SET name = ? WHERE id = ?").run(name, id);
    if (!info.changes) return { ok: false, error: "标签不存在" };
    return { ok: true, tag: { id, name } };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
electron.ipcMain.handle("picnest-tag-delete", (_event, tagId) => {
  try {
    picnestMigrate();
    const id = Number(tagId) || 0;
    if (!id) return { ok: false, error: "标签不存在" };
    const db = getDb();
    let removed = 0;
    const tx = db.transaction(() => {
      removed = db.prepare("DELETE FROM image_tags WHERE tag_id = ?").run(id).changes;
      db.prepare("DELETE FROM tags WHERE id = ?").run(id);
    });
    tx();
    return { ok: true, removed };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});

electron.ipcMain.handle("picnest-search", (_event, folderId, query, limit) => {
  picnestMigrate();
  const q = String(query || "").trim();
  if (!q) return [];
  const pattern = "%" + picnestLikeEscape(q) + "%";
  return getDb().prepare(
    `SELECT id, file_path, file_name, file_size, modify_time, width, height, thumbnail_path, is_favorite
     FROM images WHERE folder_id = ? AND deleted_at IS NULL
       AND (file_name LIKE ? ESCAPE '\\' OR EXISTS (
         SELECT 1 FROM image_tags it JOIN tags t ON t.id = it.tag_id
         WHERE it.image_id = images.id AND t.name LIKE ? ESCAPE '\\'
       ))
     ORDER BY file_name COLLATE NOCASE LIMIT ?`
  ).all(folderId, pattern, pattern, limit);
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

/* 文件夹记忆：按根隔离（`<rootId>|<rel>`）；渲染层只拿当前根切片（rel 键，组件零改动） */
function picnestDirMemoryKey(rootId, rel) { return `${rootId}|${rel || ""}`; }
function picnestDirMemoryRootMap(rootId) {
  const map = picnestDirMemoryRead();
  const out = {};
  const prefix = String(rootId) + "|";
  for (const [k, v] of Object.entries(map)) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  }
  return out;
}
/* 旧全局 rel 键（单库时代）→ 复制到每个根的命名空间；已有 root 键不覆盖（幂等） */
function picnestMigrateDirMemoryKeys() {
  try {
    const map = picnestDirMemoryRead();
    const legacy = [];
    for (const [k, v] of Object.entries(map)) if (!/^\d+\|/.test(k)) legacy.push([k, v]);
    if (!legacy.length) return;
    const roots = getDb().prepare("SELECT id FROM folders").all();
    let changed = false;
    for (const r of roots) {
      for (const [rel, v] of legacy) {
        const k = picnestDirMemoryKey(r.id, rel);
        if (!(k in map)) { map[k] = v; changed = true; }
      }
    }
    if (changed) picnestDirMemoryWrite(map);
  } catch (e) {}
}
electron.ipcMain.handle("picnest-dir-memory-get", (_event, key) => key ? (picnestDirMemoryRead()[key] || null) : picnestDirMemoryRead());
electron.ipcMain.handle("picnest-dir-memory-root-get", (_event, rootId) => {
  try { picnestMigrate(); } catch (e) {}
  return picnestDirMemoryRootMap(rootId);
});
electron.ipcMain.handle("picnest-dir-memory-set", (_event, rootId, rel, patch) => {
  try {
    if (rootId == null) return false;
    const map = picnestDirMemoryRead();
    const key = picnestDirMemoryKey(rootId, rel);
    map[key] = Object.assign(map[key] || {}, patch);
    picnestDirMemoryWrite(map);
    return map[key];
  } catch (e) { return false; }
});
/* 目录改名：整棵子树的 dirMemory 键搬家 + 封面绝对路径同步（旧版只改了渲染层内存） */
function picnestDirMemoryRenameKeys(rootId, oldRel, newRel) {
  try {
    if (rootId == null || !oldRel) return { ok: false };
    const map = picnestDirMemoryRead();
    const prefix = String(rootId) + "|";
    const root = getDb().prepare("SELECT path FROM folders WHERE id = ?").get(rootId);
    const rootPath = root?.path || "";
    const oldAbs = rootPath ? path.join(rootPath, oldRel.split("/").join(path.sep)) : "";
    const newAbs = rootPath ? path.join(rootPath, String(newRel || "").split("/").join(path.sep)) : "";
    const oldNorm = oldAbs.toLowerCase();
    let changed = false;
    for (const key of Object.keys(map)) {
      if (!key.startsWith(prefix)) continue;
      const rel = key.slice(prefix.length);
      let nr = null;
      if (rel === oldRel) nr = newRel;
      else if (rel.startsWith(oldRel + "/")) nr = newRel + rel.slice(oldRel.length);
      if (nr == null || nr === rel) continue;
      map[prefix + nr] = map[key];
      delete map[key];
      changed = true;
    }
    if (oldAbs) {
      for (const v of Object.values(map)) {
        if (v && typeof v.cover === "string" && v.cover.toLowerCase().startsWith(oldNorm + path.sep)) {
          v.cover = newAbs + v.cover.slice(oldAbs.length);
          changed = true;
        }
      }
    }
    if (changed) picnestDirMemoryWrite(map);
    return { ok: true, changed };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
}
electron.ipcMain.handle("picnest-dir-memory-rename", (_event, rootId, oldRel, newRel) => picnestDirMemoryRenameKeys(rootId, oldRel, newRel));

/* 主题记忆：写 config.json（localStorage 按 origin 隔离，dev/prod 切换会看起来“丢主题”） */
electron.ipcMain.handle("picnest-theme-get", () => {
  try {
    const c = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return { ok: true, theme: String(c.picnestTheme || "") };
  } catch (e) { return { ok: false, theme: "" }; }
});
electron.ipcMain.handle("picnest-theme-set", (_event, theme) => {
  try {
    let c = {};
    try { c = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch (e) {}
    c.picnestTheme = String(theme || "");
    fs.writeFileSync(configPath, JSON.stringify(c, null, 2));
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});

/* ==== 根文件本地元数据：<root>/.picnest/meta.json（. 开头 → 扫描/监听/树全部忽略） ==== */
const PICNEST_META_DIR = ".picnest";
const PICNEST_META_FILE = "meta.json";
function picnestRootPath(rootId) {
  try { return getDb().prepare("SELECT path FROM folders WHERE id = ?").get(rootId)?.path || ""; } catch (e) { return ""; }
}
function picnestRelOfImage(rootPath, filePath) {
  try {
    return path.relative(rootPath, filePath).split(path.sep).join("/");
  } catch (e) { return ""; }
}
function picnestMetaPath(rootPath) { return path.join(rootPath, PICNEST_META_DIR, PICNEST_META_FILE); }
function picnestMetaRead(rootPath) {
  try { return JSON.parse(fs.readFileSync(picnestMetaPath(rootPath), "utf-8")); } catch (e) { return null; }
}
function picnestMetaEnsureDir(rootPath) {
  const dir = path.join(rootPath, PICNEST_META_DIR);
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  try {
    if (process.platform === "win32") {
      require("child_process").execFile("attrib", ["+h", dir], { windowsHide: true }, () => {});
    }
  } catch (e) {}
  return dir;
}
function picnestMetaWrite(rootPath, meta) {
  try {
    const dir = picnestMetaEnsureDir(rootPath);
    const file = path.join(dir, PICNEST_META_FILE);
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) { return false; }
}
function picnestMetaExport(rootId) {
  try {
    picnestMigrate();
    const db = getDb();
    const root = db.prepare("SELECT id, path FROM folders WHERE id = ?").get(rootId);
    if (!root) return { ok: false, error: "根文件不存在" };
    if (!root.path || !fs.existsSync(root.path) || !fs.statSync(root.path).isDirectory()) {
      return { ok: false, error: "根目录不存在" };
    }
    const meta = {
      version: 1, app: "PicNest", updatedAt: Date.now(),
      tags: [], images: {}, dirs: {}, orders: { dirs: {}, images: {} },
    };
    const tagRows = db.prepare(
      "SELECT DISTINCT t.name AS name FROM tags t JOIN image_tags it ON it.tag_id = t.id JOIN images i ON i.id = it.image_id WHERE i.folder_id = ? AND i.deleted_at IS NULL ORDER BY t.name COLLATE NOCASE"
    ).all(rootId);
    meta.tags = tagRows.map((r) => r.name);
    const rows = db.prepare(
      "SELECT file_path, rating, annotation, url, is_favorite, sort_order FROM images WHERE folder_id = ? AND deleted_at IS NULL"
    ).all(rootId);
    const images = {};
    for (const r of rows) {
      const rel = picnestRelOfImage(root.path, r.file_path);
      if (!rel) continue;
      const rec = {};
      if (r.rating) rec.rating = r.rating;
      if (r.annotation) rec.annotation = r.annotation;
      if (r.url) rec.url = r.url;
      if (r.is_favorite) rec.favorite = 1;
      images[rel] = rec;
    }
    const links = db.prepare(
      "SELECT i.file_path AS fp, t.name AS name FROM image_tags it JOIN tags t ON t.id = it.tag_id JOIN images i ON i.id = it.image_id WHERE i.folder_id = ? AND i.deleted_at IS NULL"
    ).all(rootId);
    for (const l of links) {
      const rel = picnestRelOfImage(root.path, l.fp);
      if (!rel) continue;
      if (!images[rel]) images[rel] = {};
      (images[rel].tags || (images[rel].tags = [])).push(l.name);
    }
    for (const [rel, rec] of Object.entries(images)) {
      if (!Object.keys(rec).length) delete images[rel];
      else if (rec.tags) rec.tags = [...new Set(rec.tags)].sort((a, b) => String(a).localeCompare(String(b), "zh"));
    }
    meta.images = images;
    /* 文件夹色/描述/展开/封面（封面存相对路径，换根也能找回） */
    const memMap = picnestDirMemoryRootMap(rootId);
    for (const [rel, mem] of Object.entries(memMap)) {
      const v = {};
      if (mem.color) v.color = mem.color;
      if (mem.desc) v.desc = mem.desc;
      if (typeof mem.expanded === "boolean") v.expanded = mem.expanded;
      if (mem.cover) {
        try {
          const rp = path.relative(root.path, mem.cover);
          if (rp && !rp.startsWith("..") && !path.isAbsolute(rp)) v.cover = rp.split(path.sep).join("/");
        } catch (e) {}
      }
      if (Object.keys(v).length) meta.dirs[rel] = v;
    }
    /* 手动排序：目录顺序在 config，图片顺序在 images.sort_order */
    const dirOrder = picnestDirOrderRead();
    const prefix = String(rootId) + "|";
    for (const [k, names] of Object.entries(dirOrder)) {
      if (!k.startsWith(prefix)) continue;
      const rel = k.slice(prefix.length);
      meta.orders.dirs[rel === "__root__" ? "" : rel] = names;
    }
    const orderRows = db.prepare(
      "SELECT file_path, file_name FROM images WHERE folder_id = ? AND deleted_at IS NULL AND sort_order > 0 ORDER BY sort_order ASC, id DESC"
    ).all(rootId);
    const groups = new Map();
    for (const r of orderRows) {
      const dirRel = picnestRelOfImage(root.path, path.dirname(r.file_path));
      if (!groups.has(dirRel)) groups.set(dirRel, []);
      groups.get(dirRel).push(r.file_name);
    }
    for (const [rel, names] of groups) if (names.length > 1) meta.orders.images[rel] = names;
    const okWrite = picnestMetaWrite(root.path, meta);
    return {
      ok: okWrite, path: picnestMetaPath(root.path),
      counts: {
        tags: meta.tags.length, images: Object.keys(meta.images).length,
        dirs: Object.keys(meta.dirs).length,
        dirOrder: Object.keys(meta.orders.dirs).length,
        imageOrder: Object.keys(meta.orders.images).length,
      },
    };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
}
function picnestMetaImport(rootId) {
  try {
    picnestMigrate();
    const db = getDb();
    const root = db.prepare("SELECT id, path FROM folders WHERE id = ?").get(rootId);
    if (!root) return { ok: false, error: "根文件不存在" };
    if (!root.path || !fs.existsSync(root.path) || !fs.statSync(root.path).isDirectory()) {
      return { ok: false, error: "根目录不存在" };
    }
    const meta = picnestMetaRead(root.path);
    if (!meta) return { ok: true, created: false };
    const c = { tags: 0, tagLinks: 0, images: 0, dirs: 0, dirOrder: 0, imageOrder: 0 };
    const now = Date.now();
    const tagCache = new Map();
    const findTag = db.prepare("SELECT id FROM tags WHERE name = ? COLLATE NOCASE");
    const insTag = db.prepare("INSERT OR IGNORE INTO tags (name, created_at) VALUES (?, ?)");
    const tagIdOf = (name) => {
      const n = String(name || "").trim();
      if (!n) return null;
      const k = n.toLowerCase();
      if (tagCache.has(k)) return tagCache.get(k);
      let row = findTag.get(n);
      if (!row) { insTag.run(n, now); row = findTag.get(n); if (row) c.tags++; }
      tagCache.set(k, row?.id || null);
      return row?.id || null;
    };
    for (const name of Array.isArray(meta.tags) ? meta.tags : []) tagIdOf(name);
    const idByRel = new Map();
    const fileRows = db.prepare("SELECT id, file_path FROM images WHERE folder_id = ? AND deleted_at IS NULL").all(rootId);
    for (const r of fileRows) idByRel.set(picnestRelOfImage(root.path, r.file_path), r.id);
    const linkTag = db.prepare("INSERT OR IGNORE INTO image_tags (image_id, tag_id, created_at) VALUES (?, ?, ?)");
    for (const [rel, rec] of Object.entries(meta.images || {})) {
      const id = idByRel.get(rel);
      if (!id || !rec || typeof rec !== "object") continue;
      const bits = [];
      const vals = [];
      if (rec.rating != null) { bits.push("rating = ?"); vals.push(Number(rec.rating) || 0); }
      if (typeof rec.annotation === "string") { bits.push("annotation = ?"); vals.push(rec.annotation); }
      if (typeof rec.url === "string") { bits.push("url = ?"); vals.push(rec.url); }
      if (rec.favorite != null) { bits.push("is_favorite = ?"); vals.push(rec.favorite ? 1 : 0); }
      if (bits.length) {
        try { db.prepare(`UPDATE images SET ${bits.join(", ")} WHERE id = ?`).run(...vals, id); c.images++; } catch (e) {}
      }
      for (const name of Array.isArray(rec.tags) ? rec.tags : []) {
        const tid = tagIdOf(name);
        if (!tid) continue;
        try { c.tagLinks += linkTag.run(id, tid, now).changes || 0; } catch (e) {}
      }
    }
    /* 文件夹颜色/描述/展开/封面 */
    if (meta.dirs && typeof meta.dirs === "object") {
      const mem = picnestDirMemoryRead();
      const prefix = String(rootId) + "|";
      for (const [rel, v] of Object.entries(meta.dirs)) {
        if (!v || typeof v !== "object") continue;
        const key = prefix + rel;
        const rec = Object.assign(mem[key] || {}, {});
        if (v.color) rec.color = v.color;
        if (typeof v.desc === "string") rec.desc = v.desc;
        if (typeof v.expanded === "boolean") rec.expanded = v.expanded;
        if (v.cover) {
          const abs = path.join(root.path, String(v.cover).split("/").join(path.sep));
          if (fs.existsSync(abs)) rec.cover = abs;
        }
        mem[key] = rec;
        c.dirs++;
      }
      picnestDirMemoryWrite(mem);
    }
    /* 目录排序 + 图片排序 */
    const dirOrder = picnestDirOrderRead();
    let changedOrder = false;
    for (const [rel, names] of Object.entries(meta.orders?.dirs || {})) {
      if (!Array.isArray(names) || !names.length) continue;
      dirOrder[picnestOrderKey(rootId, rel)] = names;
      changedOrder = true;
      c.dirOrder++;
    }
    if (changedOrder) {
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch (e) {}
      cfg.picnestDirOrder = dirOrder;
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    }
    const updSort = db.prepare("UPDATE images SET sort_order = ? WHERE id = ?");
    for (const [rel, names] of Object.entries(meta.orders?.images || {})) {
      if (!Array.isArray(names) || names.length < 2) continue;
      names.forEach((name, i) => {
        const id = idByRel.get(rel ? rel + "/" + name : name);
        if (!id) return;
        try { updSort.run(i + 1, id); c.imageOrder++; } catch (e) {}
      });
    }
    return { ok: true, created: true, counts: c };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
}
electron.ipcMain.handle("picnest-root-meta-save", (_event, rootId) => picnestMetaExport(rootId));
electron.ipcMain.handle("picnest-root-meta-load", (_event, rootId) => {
  const has = picnestMetaRead(picnestRootPath(rootId));
  if (!has) return picnestMetaExport(rootId);
  return picnestMetaImport(rootId);
});
/* 启动时只补缺失文件，不覆盖已有元数据 */
electron.ipcMain.handle("picnest-root-meta-ensure", (_event, rootId) => {
  const rootPath = picnestRootPath(rootId);
  if (!rootPath) return { ok: false };
  if (picnestMetaRead(rootPath)) return { ok: true, existed: true };
  return { ...picnestMetaExport(rootId), existed: false };
});
/* ==== 物理顺序同步（开关在渲染层，默认关闭）：手动排序写进文件名数字前缀 ==== */
let picnestPhysBusy = false;
function picnestPhysWatcherActive(rootPath) {
  try {
    const norm = (p) => String(p || "").replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
    return !!(typeof watchedFolder === "string" && watchedFolder && norm(watchedFolder) === norm(rootPath));
  } catch (e) { return false; }
}
function picnestPhysPad(i, total) { return String(i).padStart(Math.max(2, String(total).length), "0"); }
function picnestStripOrderPrefix(name) {
  const m = /^(?:\d{1,3}|0\d{3})_+(.+)$/.exec(String(name || ""));
  return m ? m[1] : String(name || "");
}
/* 改文件路径并同步 thumbnail 缓存名（缓存按新路径 md5 寻址）；失败只影响缓存 */
function picnestPhysThumbMove(db, oldPath, newPath) {
  try {
    const row = db.prepare("SELECT id, thumbnail_path FROM images WHERE file_path = ?").get(oldPath);
    if (!row) return;
    let thumb = row.thumbnail_path || "";
    if (thumb && thumb !== "SKIP" && fs.existsSync(thumb)) {
      const ext = path.extname(thumb);
      const dest = path.join(cacheDir, crypto.createHash("md5").update(newPath).digest("hex") + ext);
      try { if (dest !== thumb) fs.renameSync(thumb, dest); } catch (e) {}
      thumb = dest;
    } else if (thumb !== "SKIP") thumb = "";
    db.prepare("UPDATE images SET file_path = ?, file_name = ?, thumbnail_path = ? WHERE id = ?")
      .run(newPath, path.basename(newPath), thumb, row.id);
  } catch (e) { /* 单行失败不阻塞 */ }
}
function picnestDirOrderRenameKeys(rootId, oldRel, newRel) {
  try {
    const order = picnestDirOrderRead();
    const prefix = String(rootId) + "|";
    let changed = false;
    for (const key of Object.keys(order)) {
      if (!key.startsWith(prefix)) continue;
      const rel = key.slice(prefix.length);
      let nr = null;
      if (rel === oldRel) nr = newRel;
      else if (rel.startsWith(oldRel + "/")) nr = newRel + rel.slice(oldRel.length);
      if (!nr || nr === rel) continue;
      order[prefix + nr] = order[key];
      delete order[key];
      changed = true;
    }
    if (changed) {
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch (e) {}
      cfg.picnestDirOrder = order;
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    }
    return changed;
  } catch (e) { return false; }
}
/* 图片：按传入顺序给每个目录内的文件加 NN_ 前缀（两阶段改名，避免互换撞名） */
electron.ipcMain.handle("picnest-physical-order-images", async (_event, folderId, orderedPaths) => {
  if (picnestPhysBusy) return { ok: false, error: "已有同步任务在运行" };
  picnestPhysBusy = true;
  picnestMigrate();
  const db = getDb();
  const root = db.prepare("SELECT path FROM folders WHERE id = ?").get(folderId);
  if (!root) { picnestPhysBusy = false; return { ok: false, error: "根不存在" }; }
  const resume = picnestPhysWatcherActive(root.path);
  if (resume) { try { stopWatching(); } catch (e) {} }
  let renamed = 0, failed = 0;
  const errors = [], map = [];
  try {
    const groups = new Map();
    for (const fp of orderedPaths || []) {
      const dir = path.dirname(fp);
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir).push(fp);
    }
    for (const [dir, list] of groups) {
      const total = list.length;
      const plans = list.map((fp, i) => {
        const orig = path.basename(fp);
        const ext = path.extname(orig);
        const stem = orig.slice(0, orig.length - ext.length);
        return { fp, orig, ext, newName: picnestPhysPad(i + 1, total) + "_" + picnestStripOrderPrefix(stem) + ext, i: i + 1 };
      });
      const updOrder = db.prepare("UPDATE images SET sort_order = ? WHERE file_path = ?");
      for (const p of plans) { try { updOrder.run(p.i, p.fp); } catch (e) {} }
      const temps = [];
      for (const p of plans) {
        if (p.newName === p.orig) continue;
        const tmp = path.join(dir, `__pn_tmp_${p.i}__${p.orig}`);
        try {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
          fs.renameSync(p.fp, tmp);
          temps.push({ ...p, tmp });
        } catch (e) { failed++; errors.push(`${p.orig}: ${e.message}`); }
      }
      for (const p of temps) {
        let finalPath = path.join(dir, p.newName);
        for (let n = 2; fs.existsSync(finalPath); n++) {
          finalPath = path.join(dir, path.basename(p.newName, p.ext) + ` (${n})` + p.ext);
        }
        try {
          fs.renameSync(p.tmp, finalPath);
          picnestPhysThumbMove(db, p.fp, finalPath);
          renamed++;
          map.push({ old: p.fp, new: finalPath });
        } catch (e) {
          failed++;
          errors.push(`${p.orig}: ${e.message}`);
          try { fs.renameSync(p.tmp, p.fp); } catch (e2) {}
        }
      }
    }
    return { ok: failed === 0, renamed, failed, errors: errors.slice(0, 12), map };
  } finally {
    picnestPhysBusy = false;
    if (resume) { try { startWatching(root.path, mainWindow, _onAddCb, _onDeleteCb); } catch (e) {} }
  }
});
/* 文件夹：把同一父级下的子目录按顺序加 NN_ 前缀（两阶段），同步 DB 路径/缩略图/dirMemory/dirOrder */
electron.ipcMain.handle("picnest-physical-order-dirs", async (_event, folderId, parentRel, names) => {
  if (picnestPhysBusy) return { ok: false, error: "已有同步任务在运行" };
  picnestPhysBusy = true;
  picnestMigrate();
  const db = getDb();
  const root = db.prepare("SELECT path FROM folders WHERE id = ?").get(folderId);
  if (!root) { picnestPhysBusy = false; return { ok: false, error: "根不存在" }; }
  const parentAbs = parentRel ? path.join(root.path, String(parentRel).split("/").join(path.sep)) : root.path;
  const resume = picnestPhysWatcherActive(root.path);
  if (resume) { try { stopWatching(); } catch (e) {} }
  let renamed = 0;
  const errors = [], map = [];
  try {
    const total = names.length;
    const plans = names.map((name, i) => ({
      oldName: name,
      newName: picnestPhysPad(i + 1, total) + "_" + picnestStripOrderPrefix(name),
      i: i + 1,
    }));
    const temps = [];
    for (const p of plans) {
      if (p.newName === p.oldName) continue;
      const src = path.join(parentAbs, p.oldName);
      const tmp = path.join(parentAbs, `__pn_tmp_dir_${p.i}__${p.oldName}`);
      try {
        if (!fs.existsSync(src)) { errors.push(`${p.oldName}: 不存在`); continue; }
        if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
        fs.renameSync(src, tmp);
        temps.push({ ...p, tmp });
      } catch (e) { errors.push(`${p.oldName}: ${e.message}`); }
    }
    for (const p of temps) {
      let finalAbs = path.join(parentAbs, p.newName);
      for (let n = 2; fs.existsSync(finalAbs); n++) {
        const ext = path.extname(p.newName);
        finalAbs = path.join(parentAbs, path.basename(p.newName, ext) + ` (${n})` + ext);
      }
      const finalName = path.basename(finalAbs);
      try { fs.renameSync(p.tmp, finalAbs); }
      catch (e) {
        errors.push(`${p.oldName}: ${e.message}`);
        try { fs.renameSync(p.tmp, path.join(parentAbs, p.oldName)); } catch (e2) {}
        continue;
      }
      const oldAbs = path.join(parentAbs, p.oldName);
      const oldRel = parentRel ? parentRel + "/" + p.oldName : p.oldName;
      const newRel = parentRel ? parentRel + "/" + finalName : finalName;
      const prefix = oldAbs + path.sep;
      const rows = db.prepare("SELECT id, file_path FROM images WHERE folder_id = ? AND file_path LIKE ? ESCAPE '\\'")
        .all(folderId, picnestLikeEscape(prefix) + "%");
      for (const r of rows) {
        const newPath = finalAbs + r.file_path.slice(oldAbs.length);
        try { picnestPhysThumbMove(db, r.file_path, newPath); } catch (e) {}
      }
      try { picnestDirMemoryRenameKeys(folderId, oldRel, newRel); } catch (e) {}
      try { picnestDirOrderRenameKeys(folderId, oldRel, newRel); } catch (e) {}
      try {
        db.prepare("UPDATE picnest_trash_folders SET abs_path = ? || substr(abs_path, ?) WHERE folder_id = ? AND abs_path LIKE ? ESCAPE '\\'")
          .run(finalAbs, oldAbs.length + 1, folderId, picnestLikeEscape(prefix) + "%");
      } catch (e) {}
      renamed++;
      map.push({ oldName: p.oldName, newName: finalName, oldRel, newRel });
    }
    const order = picnestDirOrderRead();
    const key = picnestOrderKey(folderId, parentRel || "");
    order[key] = plans.map((p) => {
      const hit = map.find((m) => m.oldName === p.oldName);
      return hit ? hit.newName : p.oldName;
    });
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch (e) {}
    cfg.picnestDirOrder = order;
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    return { ok: errors.length === 0, renamed, map, errors: errors.slice(0, 12) };
  } finally {
    picnestPhysBusy = false;
    if (resume) { try { startWatching(root.path, mainWindow, _onAddCb, _onDeleteCb); } catch (e) {} }
  }
});

/* 一键清除全根目录里我们加的排序编号（01_ 前缀）：文件+文件夹，重名自动加 (2)；
   不改 sort_order/手动顺序，只把磁盘名还原。深度优先处理（先子后父），watcher 暂停。 */
let picnestStripBusy = false;
function picnestUniquePath(dir, name, isDir) {
  let target = path.join(dir, name);
  if (!fs.existsSync(target)) return target;
  if (isDir) {
    for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${name} (${n})`);
    return target;
  }
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${stem} (${n})${ext}`);
  return target;
}
function picnestOrderArrayRename(rootId, parentRel, oldName, newName) {
  try {
    const order = picnestDirOrderRead();
    const key = picnestOrderKey(rootId, parentRel || "");
    if (!Array.isArray(order[key])) return;
    const i = order[key].indexOf(oldName);
    if (i < 0) return;
    order[key][i] = newName;
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch (e) {}
    cfg.picnestDirOrder = order;
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  } catch (e) {}
}
electron.ipcMain.handle("picnest-strip-order-prefixes", async (event, folderId) => {
  if (picnestStripBusy) return { ok: false, error: "已有清除任务在运行" };
  picnestStripBusy = true;
  picnestMigrate();
  const send = (p) => { try { if (!event.sender.isDestroyed()) event.sender.send("picnest-strip-prefix-progress", p); } catch (e) {} };
  const db = getDb();
  const root = db.prepare("SELECT id, path FROM folders WHERE id = ?").get(folderId);
  if (!root) { picnestStripBusy = false; return { ok: false, error: "根文件不存在" }; }
  const resume = picnestPhysWatcherActive(root.path);
  if (resume) { try { stopWatching(); } catch (e) {} }
  let files = 0, dirs = 0, failed = 0;
  const errors = [];
  try {
    const entries = [];
    const walk = (dir, rel, depth) => {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const ent of ents) {
        if (ent.name.startsWith(".")) continue; // .picnest 等隐藏目录不动
        const abs = path.join(dir, ent.name);
        const childRel = rel ? rel + "/" + ent.name : ent.name;
        const stripped = picnestStripOrderPrefix(ent.name);
        if (stripped && stripped !== ent.name) {
          entries.push({ abs, name: ent.name, stripped, isDir: ent.isDirectory(), parentAbs: dir, rel: childRel, parentRel: rel, depth });
        }
        if (ent.isDirectory()) walk(abs, childRel, depth + 1);
      }
    };
    walk(root.path, "", 0);
    const total = entries.length;
    send({ done: 0, total, files: 0, dirs: 0, failed: 0 });
    entries.sort((a, b) => b.depth - a.depth); // 先子后父，父改名不会让子路径失效
    let done = 0;
    for (const e of entries) {
      const target = picnestUniquePath(e.parentAbs, e.stripped, e.isDir);
      const finalName = path.basename(target);
      try { fs.renameSync(e.abs, target); }
      catch (err) {
        failed++;
        if (errors.length < 12) errors.push(`${e.name}: ${err.message}`);
        done++;
        continue;
      }
      if (e.isDir) {
        const prefix = e.abs + path.sep;
        const rows = db.prepare("SELECT file_path FROM images WHERE folder_id = ? AND file_path LIKE ? ESCAPE '\\'")
          .all(folderId, picnestLikeEscape(prefix) + "%");
        for (const r of rows) {
          const np = target + r.file_path.slice(e.abs.length);
          try { picnestPhysThumbMove(db, r.file_path, np); } catch (err2) {}
        }
        const newRel = e.parentRel ? e.parentRel + "/" + finalName : finalName;
        try { picnestDirMemoryRenameKeys(folderId, e.rel, newRel); } catch (err2) {}
        try { picnestDirOrderRenameKeys(folderId, e.rel, newRel); } catch (err2) {}
        try { picnestOrderArrayRename(folderId, e.parentRel, e.name, finalName); } catch (err2) {}
        try {
          db.prepare("UPDATE picnest_trash_folders SET abs_path = ? || substr(abs_path, ?) WHERE folder_id = ? AND abs_path LIKE ? ESCAPE '\\'")
            .run(target, e.abs.length + 1, folderId, picnestLikeEscape(prefix) + "%");
        } catch (err2) {}
        dirs++;
      } else {
        try { picnestPhysThumbMove(db, e.abs, target); } catch (err2) {}
        files++;
      }
      done++;
      if (done % 10 === 0 || done === total) send({ done, total, files, dirs, failed });
    }
    return { ok: true, renamed: files + dirs, files, dirs, failed, errors: errors.slice(0, 12) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), files, dirs, failed, errors };
  } finally {
    picnestStripBusy = false;
    if (resume) { try { startWatching(root.path, mainWindow, _onAddCb, _onDeleteCb); } catch (e) {} }
  }
});

/* 任务栏/跳转列表显示名：Windows 的按钮组标签不一定跟窗口 title 走，
   需要给窗口显式设置 AppUserModelID 与 relaunchDisplayName（PicNest）。 */
electron.app.on("browser-window-created", (_event, win) => {
  try {
    const ico = path.join(path.dirname(process.execPath), "_internal_data", "icon.ico");
    win.setAppDetails({
      appId: "PicNest",
      appIconPath: fs.existsSync(ico) ? ico : "",
      appIconIndex: 0,
      relaunchCommand: process.execPath,
      relaunchDisplayName: "PicNest",
    });
  } catch (e) { /* 旧 Electron 或缺图标时忽略 */ }
});

/* ==== 插件系统（P1/P2：theme + renderer；main 仅登记，P3 再跑） ==== */
const PICNEST_PLUGIN_API = "1.0.0";
const PICNEST_PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const PICNEST_PLUGIN_TYPES = new Set(["theme", "renderer", "main"]);
function picnestPluginsDir() {
  const d = path.join(dataDir, "plugins");
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  return d;
}
function picnestPluginDir(id) { return path.join(picnestPluginsDir(), String(id || "")); }
function picnestPluginConfigRead() {
  try { return JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch (e) { return {}; }
}
function picnestPluginConfigWrite(c) { try { fs.writeFileSync(configPath, JSON.stringify(c, null, 2)); } catch (e) {} }
function picnestPluginEnabledList() {
  const c = picnestPluginConfigRead();
  return Array.isArray(c.picnestPluginsEnabled) ? c.picnestPluginsEnabled.map(String) : [];
}
function picnestPluginSetEnabledList(list) {
  const c = picnestPluginConfigRead();
  c.picnestPluginsEnabled = [...new Set((list || []).map(String))];
  picnestPluginConfigWrite(c);
}
function picnestPluginNormalizeManifest(raw, dirId) {
  if (!raw || typeof raw !== "object") throw new Error("plugin.json 无效");
  const id = String(raw.id || "").trim();
  if (!PICNEST_PLUGIN_ID_RE.test(id)) throw new Error("插件 id 不合法（小写字母/数字/点/横线，1-64 位）");
  if (dirId && id !== dirId) throw new Error("plugin.json 的 id 与目录名不一致");
  const type = String(raw.type || "");
  if (!PICNEST_PLUGIN_TYPES.has(type)) throw new Error("type 必须是 theme / renderer / main");
  const fallback = type === "theme" ? "theme.css" : type === "renderer" ? "index.html" : "index.cjs";
  const entry = String(raw.entry || fallback).trim();
  if (!entry || entry.includes("..") || path.isAbsolute(entry)) throw new Error("entry 路径不合法");
  const permissions = Array.isArray(raw.permissions) ? raw.permissions.map(String).filter(Boolean).slice(0, 30) : [];
  return {
    id, name: String(raw.name || id), version: String(raw.version || "0.0.0"), api: String(raw.api || PICNEST_PLUGIN_API),
    type, entry, author: String(raw.author || ""), license: String(raw.license || ""),
    description: String(raw.description || ""), permissions,
    ui: raw.ui && typeof raw.ui === "object" ? raw.ui : null,
  };
}
function picnestPluginReadManifest(dir, dirId) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf-8"));
  return picnestPluginNormalizeManifest(raw, dirId);
}
function picnestPluginEntryPath(man) {
  const p = path.resolve(picnestPluginDir(man.id), man.entry);
  const base = path.resolve(picnestPluginDir(man.id)) + path.sep;
  return p.startsWith(base) ? p : "";
}
electron.ipcMain.handle("picnest-plugins-list", () => {
  const root = picnestPluginsDir();
  const enabled = new Set(picnestPluginEnabledList());
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch (e) {}
  for (const ent of ents) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
    const dir = path.join(root, ent.name);
    try {
      const man = picnestPluginReadManifest(dir, ent.name);
      out.push({ ...man, enabled: enabled.has(man.id), error: "" });
    } catch (e) {
      out.push({ id: ent.name, name: ent.name, version: "", type: "", api: "", entry: "", permissions: [], enabled: enabled.has(ent.name), error: String(e?.message || e) });
    }
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name), "zh"));
  return { ok: true, apiVersion: PICNEST_PLUGIN_API, plugins: out };
});
electron.ipcMain.handle("picnest-plugin-set-enabled", (_e, id, on) => {
  try {
    const man = picnestPluginReadManifest(picnestPluginDir(id), id);
    const list = picnestPluginEnabledList();
    const next = on ? [...list, man.id] : list.filter((x) => x !== man.id);
    picnestPluginSetEnabledList(next);
    return { ok: true, enabled: !!on };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
electron.ipcMain.handle("picnest-plugin-uninstall", (_e, id) => {
  try {
    if (!PICNEST_PLUGIN_ID_RE.test(String(id || ""))) return { ok: false, error: "插件 id 不合法" };
    const dir = picnestPluginDir(id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    picnestPluginSetEnabledList(picnestPluginEnabledList().filter((x) => x !== id));
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
electron.ipcMain.handle("picnest-plugin-pick-folder", async () => {
  try {
    const res = await electron.dialog.showOpenDialog(mainWindow, {
      title: "选择插件文件夹（含 plugin.json）", properties: ["openDirectory"],
    });
    return { ok: !res.canceled, path: res.filePaths?.[0] || "" };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
electron.ipcMain.handle("picnest-plugin-install-folder", async (_e, srcDir) => {
  try {
    const src = path.resolve(String(srcDir || ""));
    if (!fs.existsSync(path.join(src, "plugin.json"))) return { ok: false, error: "所选文件夹缺少 plugin.json" };
    const man = picnestPluginReadManifest(src, null);
    const dest = picnestPluginDir(man.id);
    const tmp = dest + ".tmp-" + Date.now();
    fs.cpSync(src, tmp, { recursive: true, filter: (p) => !p.split(path.sep).includes(".git") });
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
    const wasEnabled = picnestPluginEnabledList().includes(man.id);
    return { ok: true, plugin: { ...man, enabled: wasEnabled, error: "" } };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
electron.ipcMain.handle("picnest-plugin-entry-html", (_e, id) => {
  try {
    const man = picnestPluginReadManifest(picnestPluginDir(id), id);
    if (man.type !== "renderer") return { ok: false, error: "不是 renderer 插件" };
    const fp = picnestPluginEntryPath(man);
    if (!fp || !fs.existsSync(fp)) return { ok: false, error: "缺少入口文件 " + man.entry };
    const st = fs.statSync(fp);
    if (st.size > 2 * 1024 * 1024) return { ok: false, error: "入口 HTML 超过 2MB" };
    return { ok: true, html: fs.readFileSync(fp, "utf-8"), plugin: man };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
electron.ipcMain.handle("picnest-plugin-theme-css", (_e, id) => {
  try {
    const man = picnestPluginReadManifest(picnestPluginDir(id), id);
    if (man.type !== "theme") return { ok: false, error: "不是 theme 插件" };
    const fp = picnestPluginEntryPath(man);
    if (!fp || !fs.existsSync(fp)) return { ok: false, error: "缺少入口文件 " + man.entry };
    const st = fs.statSync(fp);
    if (st.size > 512 * 1024) return { ok: false, error: "主题 CSS 超过 512KB" };
    return { ok: true, css: fs.readFileSync(fp, "utf-8") };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
function picnestPluginStoragePath(id) { return path.join(picnestPluginDir(id), "storage.json"); }
electron.ipcMain.handle("picnest-plugin-storage-get", (_e, id) => {
  try {
    const p = picnestPluginStoragePath(id);
    if (!fs.existsSync(p)) return { ok: true, value: {} };
    return { ok: true, value: JSON.parse(fs.readFileSync(p, "utf-8")) };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
electron.ipcMain.handle("picnest-plugin-storage-set", (_e, id, value) => {
  try {
    const p = picnestPluginStoragePath(id);
    const text = JSON.stringify(value && typeof value === "object" ? value : {});
    if (Buffer.byteLength(text) > 5 * 1024 * 1024) return { ok: false, error: "插件存储超过 5MB" };
    fs.writeFileSync(p + ".tmp", text);
    fs.renameSync(p + ".tmp", p);
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
electron.ipcMain.handle("picnest-plugin-query-images", (_e, opts) => {
  try {
    const folderId = Number(opts?.folderId);
    if (!folderId) return { ok: false, error: "缺少资料库 id" };
    const root = getDb().prepare("SELECT id, path FROM folders WHERE id = ?").get(folderId);
    if (!root) return { ok: false, error: "资料库不存在" };
    const rel = String(opts?.rel || "").replace(/^\/+|\/+$/g, "");
    const limit = Math.max(1, Math.min(500, Number(opts?.limit) || 100));
    const sep = root.path.includes("\\") ? "\\" : "/";
    let rows;
    if (rel) {
      const pat = picnestLikeEscape(root.path + sep + rel.split("/").join(sep) + sep) + "%";
      rows = getDb().prepare(
        `SELECT id, file_path, file_name, file_size, modify_time, width, height, rating, annotation, is_favorite
         FROM images WHERE folder_id = ? AND deleted_at IS NULL AND file_path LIKE ? ESCAPE '\\'
         ORDER BY rating DESC, id DESC LIMIT ?`
      ).all(folderId, pat, limit);
    } else {
      rows = getDb().prepare(
        `SELECT id, file_path, file_name, file_size, modify_time, width, height, rating, annotation, is_favorite
         FROM images WHERE folder_id = ? AND deleted_at IS NULL
         ORDER BY rating DESC, id DESC LIMIT ?`
      ).all(folderId, limit);
    }
    const images = rows.map((r) => ({
      id: r.id,
      file_name: r.file_name,
      file_size: r.file_size,
      modify_time: r.modify_time,
      width: r.width,
      height: r.height,
      rating: r.rating || 0,
      annotation: r.annotation || "",
      is_favorite: r.is_favorite || 0,
      rel: path.relative(root.path, path.dirname(r.file_path)).replace(/[\\/]+/g, "/"),
    }));
    return { ok: true, images, rootId: folderId, rel };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
electron.ipcMain.handle("picnest-plugin-fetch", async (_e, url, init) => {
  try {
    const u = String(url || "");
    if (!/^https?:\/\//i.test(u)) return { ok: false, error: "只允许 http(s) 地址" };
    const res = await fetch(u, { ...(init && typeof init === "object" ? init : {}), signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) return { ok: false, error: "响应超过 2MB" };
    return { ok: true, status: res.status, contentType: res.headers.get("content-type") || "", body: text };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
function picnestRegistryResolve(dl, base) {
  const s = String(dl || "");
  if (!s) return "";
  if (/^https?:\/\//i.test(s) || path.isAbsolute(s)) return s;
  if (/^https?:\/\//i.test(base)) { try { return new URL(s, base).href; } catch (e) { return s; } }
  return path.join(base, s);
}
electron.ipcMain.handle("picnest-plugin-registry-fetch", async (_e, url) => {
  try {
    const src = String(url || "").trim();
    if (!src) return { ok: false, error: "请填写 registry.json 地址或本地路径" };
    let data, base;
    if (/^https?:\/\//i.test(src)) {
      const res = await fetch(src, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return { ok: false, error: `拉取失败 HTTP ${res.status}` };
      data = JSON.parse(await res.text());
      base = src;
    } else {
      const p = path.resolve(src);
      if (!fs.existsSync(p)) return { ok: false, error: "registry.json 不存在" };
      data = JSON.parse(fs.readFileSync(p, "utf-8"));
      base = path.dirname(p);
    }
    const arr = Array.isArray(data) ? data : Array.isArray(data?.plugins) ? data.plugins : [];
    const plugins = [];
    for (const raw of arr) {
      if (!raw || typeof raw !== "object") continue;
      const id = String(raw.id || "");
      if (!PICNEST_PLUGIN_ID_RE.test(id)) continue;
      plugins.push({
        id,
        name: String(raw.name || id),
        version: String(raw.version || raw.latest || "0.0.0"),
        type: String(raw.type || ""),
        api: String(raw.api || ""),
        description: String(raw.description || ""),
        author: String(raw.author || ""),
        license: String(raw.license || ""),
        homepage: String(raw.homepage || ""),
        download: picnestRegistryResolve(raw.download, base),
        sha256: String(raw.sha256 || ""),
      });
    }
    return { ok: true, plugins };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
electron.ipcMain.handle("picnest-plugin-install-registry", async (_e, entry) => {
  try {
    const dl = String(entry?.download || "");
    if (!dl) return { ok: false, error: "仓库条目缺少 download" };
    let buf;
    if (/^https?:\/\//i.test(dl)) {
      const res = await fetch(dl, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) return { ok: false, error: `下载失败 HTTP ${res.status}` };
      const ab = await res.arrayBuffer();
      if (ab.byteLength > 50 * 1024 * 1024) return { ok: false, error: "插件包超过 50MB" };
      buf = Buffer.from(ab);
    } else {
      if (!fs.existsSync(dl)) return { ok: false, error: "插件包不存在" };
      const st = fs.statSync(dl);
      if (st.size > 50 * 1024 * 1024) return { ok: false, error: "插件包超过 50MB" };
      buf = fs.readFileSync(dl);
    }
    if (entry?.sha256) {
      const h = crypto.createHash("sha256").update(buf).digest("hex");
      if (h.toLowerCase() !== String(entry.sha256).toLowerCase()) return { ok: false, error: "sha256 校验失败" };
    }
    const AdmZip = require("adm-zip");
    const zip = new AdmZip(buf);
    const entries = zip.getEntries();
    let manifestEntry = null, basePrefix = "";
    for (const e of entries) {
      const name = e.entryName.replace(/\\/g, "/");
      if (name === "plugin.json") { manifestEntry = e; basePrefix = ""; break; }
      if (/^[^/]+\/plugin\.json$/.test(name)) { manifestEntry = e; basePrefix = name.slice(0, -"plugin.json".length); break; }
    }
    if (!manifestEntry) return { ok: false, error: "zip 根目录缺少 plugin.json" };
    const raw = JSON.parse(manifestEntry.getData().toString("utf-8"));
    const man = picnestPluginNormalizeManifest(raw, null);
    const tmp = path.join(picnestPluginsDir(), `.tmp-${man.id}-${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
    let total = 0;
    for (const e of entries) {
      const name = e.entryName.replace(/\\/g, "/");
      if (!name.startsWith(basePrefix)) continue;
      const rel = name.slice(basePrefix.length);
      if (!rel || rel.endsWith("/") || rel.includes("..")) continue;
      const dest = path.resolve(tmp, rel);
      if (!dest.startsWith(path.resolve(tmp) + path.sep)) continue;
      const data = e.getData();
      total += data.length;
      if (total > 200 * 1024 * 1024) { fs.rmSync(tmp, { recursive: true, force: true }); return { ok: false, error: "解压后超过 200MB" }; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
    }
    /* 解压后再校验一次清单（防 zip 内清单与目录不一致） */
    const man2 = picnestPluginReadManifest(tmp, null);
    const dest = picnestPluginDir(man2.id);
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
    return { ok: true, plugin: { ...man2, enabled: picnestPluginEnabledList().includes(man2.id), error: "" } };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});

/* 退出前兜底：把所有根的标签/颜色/排序刷到各自 .picnest/meta.json */
electron.app.on("before-quit", () => {
  try {
    for (const r of getDb().prepare("SELECT id FROM folders").all()) {
      try { picnestMetaExport(r.id); } catch (e) {}
    }
  } catch (e) {}
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
/* 同一路径只流式算一次 MD5（并发调用共享同一个 Promise） */
function picnestMd5Of(fp, cache) {
  const key = String(fp || "").toLowerCase();
  if (!key) return Promise.resolve(null);
  if (cache && cache.has(key)) return cache.get(key);
  const task = picnestMd5Stream(fp);
  if (cache) cache.set(key, task);
  return task;
}
let picnestDupCancel = false;
electron.ipcMain.handle("picnest-dup-cancel", () => { picnestDupCancel = true; return { ok: true }; });
electron.ipcMain.handle("picnest-find-duplicates", async (event, folderId, rel) => {
  picnestDupCancel = false;
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
      if (picnestDupCancel) return;
      f.md5 = await picnestMd5Stream(f.file_path);
      done++;
      if (done - last >= 3 || done === total) {
        last = done;
        try { event.sender.send("picnest-dup-progress", { done, total }); } catch (e) {}
      }
    });
    if (picnestDupCancel) return { ok: false, canceled: true, error: "已取消" };
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
  // MiMo 聊天接口支持关闭思考；查重只需要一个 JSON 判断，关掉可显著降低单次延迟。
  if (isMimo) body.thinking = { type: "disabled" };
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = setTimeout(() => { try { ctl?.abort(); } catch (e) {} }, 90000);
  try {
    let res = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.apiKey },
        body: JSON.stringify(body),
        signal: ctl?.signal,
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
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
    const getData = (idx) => {
      if (dataCache.has(idx)) return dataCache.get(idx);
      const task = picnestAiThumbData(valid[idx])
        .then((d) => { dataCache.set(idx, d); return d; })
        .catch((e) => { dataCache.delete(idx); throw e; });
      dataCache.set(idx, task);
      return task;
    };
    const confirmed = [];
    let checked = 0;
    let nextPair = 0;
    let fatalError = null;
    const aiConcurrency = 4;
    const worker = async () => {
      while (!picnestAiCancel && !fatalError) {
        const idx = nextPair++;
        if (idx >= picked.length) return;
        const p = picked[idx];
        let da = "", db = "";
        try {
          da = await getData(p.i); db = await getData(p.j);
        } catch (e) {
          checked++;
          if (checked % 2 === 0 || checked === picked.length) {
            send({ phase: "ai", done: checked, total: picked.length, candidates: pairs.length });
          }
          continue;
        }
        try {
          const same = await picnestAiCompare(cfg, da, db);
          if (same) confirmed.push(p);
        } catch (e) {
          fatalError = e;
          return;
        } finally {
          checked++;
          if (checked % 2 === 0 || checked === picked.length) {
            send({ phase: "ai", done: checked, total: picked.length, candidates: pairs.length });
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(aiConcurrency, picked.length) }, worker));
    if (fatalError) throw fatalError;
    if (picnestAiCancel) return { ok: false, error: "已取消" };
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
      aiConcurrency,
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
/* ==== Eagle 导入向导：根文件 ⌂ 选中 .library 时检测 → 复制 → 索引 → 元数据/标签 ==== */
const PICNEST_EAGLE_PRE_EXT = new Set(["jpg", "jpeg", "png", "webp", "avif", "tif", "tiff", "bmp", "gif", "psd"]);
let picnestEagleJob = null;
let picnestEagleCancel = false;

function picnestEagleProjectRoot() {
  const candidates = [
    path.resolve(electron.app.getAppPath(), "../../.."),
    path.resolve(process.cwd(), ".."),
    process.cwd(),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(path.join(p, "tools", "eagle-migrate", "migrate.mjs"))) return p; } catch (e) {}
  }
  return candidates[0];
}
function picnestEagleNormalize(rawPath) {
  try {
    let p = path.resolve(String(rawPath || ""));
    if (path.basename(p).toLowerCase() === "images" && fs.existsSync(path.join(p, "..", "metadata.json"))) p = path.dirname(p);
    if (fs.existsSync(path.join(p, "metadata.json")) && fs.existsSync(path.join(p, "images"))) return p;
  } catch (e) {}
  return "";
}
function picnestEagleExec(args, timeout = 180000) {
  return new Promise((resolve) => {
    const { execFile } = require("child_process");
    const root = picnestEagleProjectRoot();
    execFile(process.execPath, args, {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      maxBuffer: 64 * 1024 * 1024,
      timeout,
      windowsHide: true,
    }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") }));
  });
}
function picnestEagleSend(event, payload) {
  try { if (event?.sender && !event.sender.isDestroyed()) event.sender.send("picnest-eagle-progress", payload); } catch (e) {}
}
async function picnestEaglePreThumbs(event, manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const sharp = (await import("sharp")).default;
  const jobs = [];
  for (const it of manifest.items || []) {
    const itemDir = path.dirname(it.source);
    let thumbPath = "";
    try {
      const f = fs.readdirSync(itemDir).find((n) => /_thumbnail\.[^.]+$/i.test(n));
      if (f) thumbPath = path.join(itemDir, f);
    } catch (e) {}
    const ext = path.extname(it.source).slice(1).toLowerCase();
    const src = thumbPath || (PICNEST_EAGLE_PRE_EXT.has(ext) ? it.source : "");
    if (!src) continue;
    for (const t of it.targets || []) jobs.push({ src, target: t.path });
  }
  let next = 0, done = 0, ok = 0, fail = 0
  const total = jobs.length
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= total) return;
      if (picnestEagleCancel) return;
      const j = jobs[i];
      const dest = path.join(cacheDir, crypto.createHash("md5").update(j.target).digest("hex") + ".jpg");
      try {
        if (!fs.existsSync(dest)) {
          await sharp(j.src, { animated: false }).rotate().flatten({ background: "#ffffff" })
            .resize({ width: 400, withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(dest);
        }
        ok++;
      } catch (e) { fail++; }
      done++;
      if (done % 200 === 0 || done === total) picnestEagleSend(event, { phase: "thumbs", done, total, ok, fail });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  if (picnestEagleCancel) throw new Error("已取消");
  return { total, ok, fail };
}

electron.ipcMain.handle("picnest-eagle-inspect", async (_event, rawPath) => {
  const library = picnestEagleNormalize(rawPath);
  if (!library) return { ok: true, eagle: false };
  const script = path.join(picnestEagleProjectRoot(), "tools", "eagle-migrate", "migrate.mjs");
  if (!fs.existsSync(script)) return { ok: false, eagle: true, error: "缺少迁移脚本 tools/eagle-migrate/migrate.mjs" };
  const { err, stdout, stderr } = await picnestEagleExec([script, "--library", library, "--json"]);
  if (err) return { ok: false, eagle: true, error: String(stderr || err.message || err).slice(0, 600) };
  let summary = null;
  try { summary = JSON.parse(stdout.trim()); } catch (e) {}
  if (!summary) return { ok: false, eagle: true, error: "无法解析迁移预检结果" };
  let existingRootId = null, existingRootName = "";
  try {
    const row = getDb().prepare("SELECT id, display_name FROM folders WHERE path = ? COLLATE NOCASE").get(summary.targetRoot);
    if (row) { existingRootId = row.id; existingRootName = row.display_name || ""; }
  } catch (e) {}
  return { ok: true, eagle: true, library, ...summary, existingRootId, existingRootName };
});
electron.ipcMain.handle("picnest-eagle-copy", async (event, opts) => {
  if (picnestEagleJob) return { ok: false, error: "已有 Eagle 导入任务在运行" };
  const library = picnestEagleNormalize(opts?.library);
  const targetRoot = path.resolve(String(opts?.targetRoot || ""));
  if (!library) return { ok: false, error: "Eagle 库路径无效" };
  if (!targetRoot) return { ok: false, error: "目标目录无效" };
  const script = path.join(picnestEagleProjectRoot(), "tools", "eagle-migrate", "migrate.mjs");
  if (!fs.existsSync(script)) return { ok: false, error: "缺少迁移脚本 tools/eagle-migrate/migrate.mjs" };
  picnestEagleCancel = false;
  const { spawn } = require("child_process");
  const child = spawn(process.execPath, [script, "--apply", "--library", library, "--target", targetRoot], {
    cwd: picnestEagleProjectRoot(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    windowsHide: true,
  });
  picnestEagleJob = child;
  let stdout = "", stderr = "", lineBuf = "";
  child.stdout.on("data", (buf) => {
    stdout += buf.toString();
    lineBuf += buf.toString();
    let idx;
    while ((idx = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, idx).trim();
      lineBuf = lineBuf.slice(idx + 1);
      const m = /^copied (\d+)\/(\d+) · ([\d.]+) GB · (\d+)s/.exec(line);
      if (m) picnestEagleSend(event, { phase: "copy", done: Number(m[1]), total: Number(m[2]), gb: Number(m[3]), sec: Number(m[4]) });
    }
  });
  child.stderr.on("data", (buf) => { stderr += buf.toString(); });
  const code = await new Promise((resolve) => child.on("close", (c) => resolve(c)));
  picnestEagleJob = null;
  if (picnestEagleCancel) return { ok: false, error: "已取消", canceled: true };
  if (code !== 0) return { ok: false, error: String(stderr || stdout).slice(-800) || ("复制失败，退出码 " + code) };
  const manifestPath = targetRoot + ".manifest.json";
  if (!fs.existsSync(manifestPath)) return { ok: false, error: "复制完成但缺少 manifest" };
  let thumbs = null;
  try {
    thumbs = await picnestEaglePreThumbs(event, manifestPath);
  } catch (e) {
    if (picnestEagleCancel) return { ok: false, error: "已取消", canceled: true };
    // 缩略图失败不阻断导入，后续由应用后台补齐
    thumbs = { total: 0, ok: 0, fail: 0, error: String(e?.message || e) };
  }
  return { ok: true, manifestPath, targetRoot, thumbs };
});
electron.ipcMain.handle("picnest-eagle-finish", async (event, opts) => {
  try {
    picnestMigrate();
    const manifestPath = path.resolve(String(opts?.manifestPath || ""));
    if (!fs.existsSync(manifestPath)) return { ok: false, error: "manifest 不存在" };
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const db = getDb();
    const root = opts?.rootId
      ? db.prepare("SELECT id, path FROM folders WHERE id = ?").get(Number(opts.rootId))
      : db.prepare("SELECT id, path FROM folders WHERE path = ? COLLATE NOCASE").get(manifest.targetRoot);
    if (!root) return { ok: false, error: "目标根尚未加入 PicNest" };
    const findImg = db.prepare("SELECT id FROM images WHERE folder_id = ? AND file_path = ? COLLATE NOCASE");
    const updateMeta = db.prepare("UPDATE images SET url = ?, annotation = ?, rating = ? WHERE id = ?");
    const updateThumb = db.prepare("UPDATE images SET thumbnail_path = ? WHERE id = ?");
    const findTag = db.prepare("SELECT id FROM tags WHERE name = ? COLLATE NOCASE");
    const insertTag = db.prepare("INSERT INTO tags(name, created_at) VALUES (?, ?)");
    const linkTag = db.prepare("INSERT OR IGNORE INTO image_tags(image_id, tag_id, created_at) VALUES (?, ?, ?)");
    const tagIds = new Map();
    const ensureTag = (name) => {
      const k = String(name || "").trim();
      if (!k) return 0;
      const key = k.toLowerCase();
      if (tagIds.has(key)) return tagIds.get(key);
      let row = findTag.get(k);
      if (!row) row = { id: Number(insertTag.run(k, Date.now()).lastInsertRowid) };
      tagIds.set(key, row.id);
      return row.id;
    };
    const stats = { items: 0, targets: 0, found: 0, missing: 0, metaUpdated: 0, thumbUpdated: 0, tagsLinked: 0 };
    const tx = db.transaction(() => {
      for (const it of manifest.items || []) {
        stats.items++;
        const ids = [...new Set((it.tags || []).map((t) => String(t || "").trim()).filter(Boolean))].map(ensureTag).filter(Boolean);
        for (const t of it.targets || []) {
          stats.targets++;
          const row = findImg.get(root.id, t.path);
          if (!row) { stats.missing++; continue; }
          stats.found++;
          if (it.url || it.annotation || it.star) {
            updateMeta.run(it.url || "", it.annotation || "", Number(it.star) || 0, row.id);
            stats.metaUpdated++;
          }
          const thumb = path.join(cacheDir, crypto.createHash("md5").update(t.path).digest("hex") + ".jpg");
          if (fs.existsSync(thumb)) { updateThumb.run(thumb, row.id); stats.thumbUpdated++; }
          for (const tagId of ids) stats.tagsLinked += linkTag.run(row.id, tagId, Date.now()).changes || 0;
        }
        if (stats.items % 500 === 0) picnestEagleSend(event, { phase: "meta", done: stats.items, total: (manifest.items || []).length, found: stats.found, tags: tagIds.size });
      }
    });
    tx();
    picnestEagleSend(event, { phase: "meta", done: (manifest.items || []).length, total: (manifest.items || []).length, found: stats.found, tags: tagIds.size });
    return { ok: true, rootId: root.id, ...stats, tags: tagIds.size };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});
electron.ipcMain.handle("picnest-eagle-cancel", () => {
  picnestEagleCancel = true;
  try { picnestEagleJob?.kill(); } catch (e) {}
  return { ok: true };
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
async function picnestCollectDupes(root, buf) {
  try {
    const rows = getDb().prepare(
      "SELECT file_path, file_name, width, height FROM images WHERE folder_id = ? AND file_size = ? AND deleted_at IS NULL LIMIT 6"
    ).all(root.id, buf.length);
    if (!rows.length) return [];
    const md5 = crypto.createHash("md5").update(buf).digest("hex");
    const rootAbs = path.resolve(root.path);
    const out = [];
    const cache = new Map();
    for (const r of rows) {
      try {
        if (!fs.existsSync(r.file_path)) continue;
        if ((await picnestMd5Of(r.file_path, cache)) !== md5) continue;
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
  const matches = (item.overwrite || !item.force) ? await picnestCollectDupes(t.root, buf) : [];
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
