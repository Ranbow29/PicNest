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
  _picnestMigrated = true;
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
  function toNode(n) {
    const children = Object.values(n.children).map(toNode);
    const order = (picnestDirOrderRead()[n.rel || "__root__"]) || [];
    const rank = (name) => { const i = order.indexOf(name); return i < 0 ? 1e9 + name.length : i; };
    children.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, "zh"));
    let total = n.direct;
    for (const c of children) total += c.total;
    return { name: n.name, rel: n.rel, count: n.direct, total, children };
  }
  return { rootPath: root.path, tree: toNode(rootDir), orphanFiles: rows.length - Object.values(dirAt).reduce((s, d) => s + d.direct, 0) };
});

/* 某子目录下的图片分页（dirRel 用 "/" 分隔，"" = 根层直属文件） */
electron.ipcMain.handle("picnest-images-by-dir", (_event, folderId, dirRel, offset, limit, sortMode) => {
  picnestMigrate();
  const root = getDb().prepare("SELECT path FROM folders WHERE id = ?").get(folderId);
  if (!root) return [];
  const sep = root.path.includes("\\") ? "\\" : "/";
  const platRel = dirRel ? dirRel.split("/").join(sep) + sep : "";
  const pattern = picnestLikeEscape(root.path + sep + platRel) + "%";
  const order = sortMode === "name" ? "file_name COLLATE NOCASE ASC" : sortMode === "mtime" ? "modify_time DESC" : "id ASC";
  const rows = getDb().prepare(
    `SELECT id, file_path, file_name, file_size, modify_time, width, height, thumbnail_path, is_favorite
     FROM images WHERE folder_id = ? AND deleted_at IS NULL AND file_path LIKE ? ESCAPE '\\' ORDER BY ${order} LIMIT ? OFFSET ?`
  ).all(folderId, pattern, limit, offset);
  const valid = [];
  for (const img of rows) {
    if (img.thumbnail_path && !fs.existsSync(img.thumbnail_path)) img.thumbnail_path = "";
    if (!img.thumbnail_path) img.thumbnail_path = discoverThumbnailPath(img.file_path) || "";
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

/* 外部拖入：目录→返回待登记；图片/视频→复制进目标目录（撞名加序号），watcher 自动入库 */
electron.ipcMain.handle("picnest-import-files", async (_event, paths, targetDir) => {
  const IMG_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".tif", ".avif", ".svg", ".psd", ".heic", ".heif", ".mp4", ".webm", ".mov", ".mkv", ".avi", ".flv", ".f4v"]);
  const dirs = [];
  let copied = 0, failed = 0, skipped = 0;
  try {
    if (!fs.existsSync(targetDir)) return { ok: false, error: "目标目录不存在", dirs: [] };
    for (const p of paths || []) {
      try {
        if (!p || !fs.existsSync(p)) { failed++; continue; }
        const st = fs.statSync(p);
        if (st.isDirectory()) { dirs.push(p); continue; }
        const ext = path.extname(p).toLowerCase();
        if (!IMG_EXTS.has(ext)) { failed++; continue; }
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
    return { ok: true, dirs, copied, failed, skipped };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), dirs: [] };
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
  for (const p of paths || []) {
    try {
      if (!p || !fs.existsSync(p)) continue;
      const st = fs.statSync(p);
      if (st.isDirectory()) { clean.push(p); continue; } // 目录走登记流程
      const size = st.size;
      const cands = getDb().prepare(
        "SELECT i.file_path, i.file_name, i.width, i.height, f.path AS folder_path, f.display_name FROM images i JOIN folders f ON f.id = i.folder_id WHERE i.file_size = ? AND i.deleted_at IS NULL LIMIT 6"
      ).all(size);
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
    } catch (e) { /* 单个失败不阻塞 */ }
  }
  return { clean, conflicts };
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

/* 兄弟排序关系（文件系统无顺序，存 config；key: 父目录 rel，根层用 __root__） */
function picnestDirOrderRead() {
  try { return JSON.parse(fs.readFileSync(configPath, "utf-8")).picnestDirOrder || {} } catch (e) { return {} }
}
electron.ipcMain.handle("picnest-dir-order-get", () => picnestDirOrderRead());
electron.ipcMain.handle("picnest-dir-order-set", (_event, parentKey, names) => {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch (e) {}
  c.picnestDirOrder = c.picnestDirOrder || {};
  c.picnestDirOrder[parentKey] = names;
  fs.writeFileSync(configPath, JSON.stringify(c, null, 2));
  return true;
});

/* ---- M4 四视图：软删列 + 计数 + 随机 + 回收站 + 搜索 ---- */
electron.ipcMain.handle("picnest-view-counts", (_event, folderId) => {
  const db = getDb();
  return {
    all: db.prepare("SELECT COUNT(*) c FROM images WHERE folder_id = ? AND deleted_at IS NULL").get(folderId).c,
    recent: db.prepare("SELECT COUNT(*) c FROM images WHERE folder_id = ? AND deleted_at IS NULL AND last_opened_at > 0").get(folderId).c,
    trash: db.prepare("SELECT COUNT(*) c FROM images WHERE folder_id = ? AND deleted_at IS NOT NULL").get(folderId).c,
  };
});
electron.ipcMain.handle("picnest-random", (_event, folderId, limit) => {
  return getDb().prepare(
    `SELECT id, file_path, file_name, file_size, modify_time, width, height, thumbnail_path, is_favorite
     FROM images WHERE folder_id = ? AND deleted_at IS NULL ORDER BY RANDOM() LIMIT ?`
  ).all(folderId, limit);
});
electron.ipcMain.handle("picnest-trash-list", async (_event, folderId) => {
  const rows = getDb().prepare(
    `SELECT id, file_path, file_name, file_size, modify_time, width, height, thumbnail_path, is_favorite, deleted_at
     FROM images WHERE folder_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC`
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
  getDb().prepare("UPDATE images SET deleted_at = NULL WHERE file_path = ?").run(filePath);
  return true;
});
electron.ipcMain.handle("picnest-remove", (_event, filePath) => {
  getDb().prepare("UPDATE images SET deleted_at = ? WHERE file_path = ?").run(Date.now(), filePath);
  return true;
});
electron.ipcMain.handle("picnest-trash-purge", async (_event, filePath) => {
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
    return { ok: true, dir_path: target, moved: true };
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
    getDb().prepare("UPDATE images SET file_path = ?, file_name = ? WHERE file_path = ?").run(target, path.basename(target), filePath);
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

/* 文件夹记忆：每个子目录的浏览位置/排序/随机种子，存 config.json */
electron.ipcMain.handle("picnest-dir-memory-get", (_event, key) => picnestDirMemoryRead()[key] || null);
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
/* ==== /PicNest:P4 ==== */
