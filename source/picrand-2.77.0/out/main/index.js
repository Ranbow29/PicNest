"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
const electron = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const module$1 = require("module");
const worker_threads = require("worker_threads");
const STEAM_APP_ID = 5013580;
const STEAM_STORE_URL = "https://store.steampowered.com/app/5013580/Picrand/";
const initialStatus = {
  checked: false,
  genuine: false,
  available: false,
  owned: false,
  familyShared: false,
  freeWeekend: false
};
let _status = { ...initialStatus };
let _initPromise = null;
function getSteamStatus() {
  return _status;
}
function initSteamStatus() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const steamworks = require("steamworks.js");
      const client = steamworks.init(STEAM_APP_ID);
      const me = client.localplayer.getSteamId();
      const owned = !!client.apps.isSubscribedApp(STEAM_APP_ID);
      let familyShared = false;
      try {
        const owner = client.apps.appOwner();
        familyShared = !!owner && owner.steamId64 !== me.steamId64;
      } catch {
      }
      let freeWeekend = false;
      try {
        freeWeekend = !!client.apps.isSubscribedFromFreeWeekend();
      } catch {
      }
      const forceUnowned = process.env.PICRAND_STEAM_FORCE_UNOWNED === "1";
      const genuine = !forceUnowned && owned && !familyShared && !freeWeekend;
      let persona;
      try {
        persona = client.localplayer.getName();
      } catch {
      }
      _status = {
        checked: true,
        genuine,
        available: true,
        owned,
        familyShared,
        freeWeekend,
        steamId: me?.steamId64?.toString(),
        persona
      };
      console.log(`[steam] owned=${owned} genuine=${genuine} familyShared=${familyShared} freeWeekend=${freeWeekend}`);
    } catch (e) {
      const msg = e?.message || String(e);
      _status = { ...initialStatus, checked: true, error: msg };
      console.warn("[steam] authorization check failed:", msg);
    }
    return _status;
  })();
  return _initPromise;
}
async function openSteamStore() {
  try {
    await electron.shell.openExternal(STEAM_STORE_URL);
    return true;
  } catch (e) {
    console.warn("[steam] open store page failed:", e);
    return false;
  }
}
const require$1 = module$1.createRequire(require("url").pathToFileURL(__filename).href);
const Database = require$1("better-sqlite3");
let db = null;
function initDatabase(dataDir2) {
  const dbPath = path.join(dataDir2, "picrand.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      display_name TEXT DEFAULT '',
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER,
      file_path TEXT UNIQUE NOT NULL,
      file_name TEXT NOT NULL,
      file_size INTEGER,
      modify_time INTEGER,
      width INTEGER,
      height INTEGER,
      thumbnail_path TEXT,
      is_favorite INTEGER DEFAULT 0,
      FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_images_folder ON images(folder_id);
    CREATE INDEX IF NOT EXISTS idx_images_modify ON images(modify_time);
    CREATE INDEX IF NOT EXISTS idx_images_name ON images(file_name);
  `);
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_images_folder_mtime ON images(folder_id, modify_time DESC)`);
  } catch {
  }
  try {
    db.exec(`ALTER TABLE folders ADD COLUMN display_name TEXT DEFAULT ''`);
  } catch {
  }
  try {
    db.exec(`ALTER TABLE images ADD COLUMN sort_order REAL DEFAULT 0`);
  } catch {
  }
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_images_sort ON images(folder_id, sort_order)`);
  } catch {
  }
  try {
    db.exec(`ALTER TABLE images ADD COLUMN features BLOB DEFAULT NULL`);
  } catch {
  }
  try {
    db.exec(`ALTER TABLE folders ADD COLUMN color TEXT DEFAULT ''`);
  } catch {
  }
  try {
    db.exec(`ALTER TABLE folders ADD COLUMN cover_path TEXT DEFAULT ''`);
  } catch {
  }
  try {
    db.exec(`ALTER TABLE folders ADD COLUMN is_favorite INTEGER DEFAULT 0`);
  } catch {
  }
  try {
    db.exec(`ALTER TABLE folders ADD COLUMN sort_order REAL DEFAULT 0`);
  } catch {
  }
  try {
    db.exec(`ALTER TABLE folders ADD COLUMN random_seed TEXT DEFAULT NULL`);
  } catch {
  }
  try {
    db.exec(`ALTER TABLE images ADD COLUMN rating INTEGER DEFAULT 0`);
  } catch {
  }
  try {
    db.exec(`ALTER TABLE images ADD COLUMN description TEXT DEFAULT ''`);
  } catch {
  }
  try {
    db.exec(`ALTER TABLE images ADD COLUMN clip_feat BLOB DEFAULT NULL`);
  } catch {
  }
  try {
    db.exec(`ALTER TABLE images ADD COLUMN color_info TEXT DEFAULT NULL`);
  } catch {
  }
  try {
    db.exec(`ALTER TABLE images ADD COLUMN favorited_at INTEGER DEFAULT 0`);
  } catch {
  }
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_images_favorite ON images(is_favorite, favorited_at DESC)`);
  } catch {
  }
  try {
    db.exec(`ALTER TABLE folders ADD COLUMN image_count INTEGER DEFAULT 0`);
  } catch {
  }
  try {
    db.exec(`ALTER TABLE folders ADD COLUMN total_size INTEGER DEFAULT 0`);
  } catch {
  }
  try {
    db.exec(`ALTER TABLE folders ADD COLUMN description TEXT DEFAULT ''`);
  } catch {
  }
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_folders_stats ON folders(image_count)`);
  } catch {
  }
  try {
    const sentinel = path.join(dataDir2, ".folders-stats-cached");
    if (!fs.existsSync(sentinel)) {
      db.exec(`
        UPDATE folders SET
          image_count = (SELECT COUNT(*) FROM images WHERE images.folder_id = folders.id),
          total_size  = COALESCE((SELECT SUM(file_size) FROM images WHERE images.folder_id = folders.id), 0)
      `);
      fs.writeFileSync(sentinel, "1", "utf8");
    }
  } catch {
  }
  try {
    const sentinel = path.join(dataDir2, ".color-info-v2-migrated");
    if (!fs.existsSync(sentinel)) {
      db.exec(`UPDATE images SET color_info = NULL`);
      fs.writeFileSync(sentinel, "1", "utf8");
    }
  } catch {
  }
  try {
    _ensureFolderStatsTriggers(db);
  } catch (e) {
    console.error("[db] folder stats triggers:", e);
  }
  return db;
}
function getDb() {
  if (!db) throw new Error("Database not initialized");
  return db;
}
function insertImage(folderId, filePath, fileName, fileSize, modifyTime, width, height, thumbnailPath) {
  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO images (folder_id, file_path, file_name, file_size, modify_time, width, height, thumbnail_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(folderId, filePath, fileName, fileSize, modifyTime, width, height, thumbnailPath);
}
function deleteImageByPath(filePath) {
  getDb().prepare("DELETE FROM images WHERE file_path = ?").run(filePath);
}
function getOrCreateFolder(folderPath) {
  const insert = getDb().prepare("INSERT OR IGNORE INTO folders (path) VALUES (?)");
  const select = getDb().prepare("SELECT id FROM folders WHERE path = ?");
  insert.run(folderPath);
  return select.get(folderPath).id;
}
function getImagesByFolder(folderId) {
  return getDb().prepare("SELECT * FROM images WHERE folder_id = ?").all(folderId);
}
function _ensureFolderStatsTriggers(db2) {
  db2.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_images_ai_stats
    AFTER INSERT ON images
    BEGIN
      UPDATE folders SET
        image_count = MAX(0, image_count + 1),
        total_size  = MAX(0, total_size  + NEW.file_size)
      WHERE id = NEW.folder_id;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_images_ad_stats
    AFTER DELETE ON images
    BEGIN
      UPDATE folders SET
        image_count = MAX(0, image_count - 1),
        total_size  = MAX(0, total_size  - OLD.file_size)
      WHERE id = OLD.folder_id;
    END;
    -- UPDATE 触发器：file_size 或 folder_id 变动时同步搬运缓存值
    CREATE TRIGGER IF NOT EXISTS trg_images_au_stats
    AFTER UPDATE OF file_size, folder_id ON images
    BEGIN
      UPDATE folders SET
        image_count = MAX(0, image_count - 1),
        total_size  = MAX(0, total_size  - OLD.file_size)
      WHERE id = OLD.folder_id;
      UPDATE folders SET
        image_count = image_count + 1,
        total_size  = total_size  + NEW.file_size
      WHERE id = NEW.folder_id;
    END;
  `);
}
function insertImagesBatch(folderId, images) {
  const db2 = getDb();
  const stmt = db2.prepare(`
    INSERT OR IGNORE INTO images (folder_id, file_path, file_name, file_size, modify_time, width, height, thumbnail_path, sort_order)
    VALUES (?, ?, ?, ?, ?, 0, 0, '', ?)
  `);
  const tx = db2.transaction(() => {
    for (const img of images) {
      stmt.run(folderId, img.file_path, img.file_name, img.file_size, img.modify_time, img.sort_order ?? 0);
    }
  });
  tx();
}
function getImagesPage(folderId, offset, limit, sortMode) {
  const orderClause = buildMultiOrderClause(sortMode || "random");
  return getDb().prepare(
    `SELECT * FROM images WHERE folder_id = ?${fmtFilterClause()} ${orderClause} LIMIT ? OFFSET ?`
  ).all(folderId, limit, offset);
}
function getImagesCount(folderId) {
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM images WHERE folder_id = ?${fmtFilterClause()}`
  ).get(folderId);
  return row?.cnt || 0;
}
const multiFolderShuffles = /* @__PURE__ */ new Map();
const SUPPORTED_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".tif", ".avif", ".svg", ".psd", ".heic", ".heif", ".mp4", ".webm", ".mov", ".mkv", ".avi", ".flv", ".f4v"];
let _formatFilter = null;
function setFormatFilter(exts) {
  if (!Array.isArray(exts)) {
    _formatFilter = null;
    multiFolderShuffles.clear();
    return;
  }
  const valid = exts.map((e) => String(e).toLowerCase()).filter((e) => SUPPORTED_EXTS.includes(e));
  _formatFilter = valid.length >= SUPPORTED_EXTS.length ? null : new Set(valid);
  multiFolderShuffles.clear();
}
function isFormatAllowed(filePath) {
  if (!_formatFilter) return true;
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return false;
  return _formatFilter.has(filePath.slice(dot).toLowerCase());
}
function fmtFilterClause() {
  if (!_formatFilter) return "";
  if (_formatFilter.size === 0) return " AND 0=1";
  const likes = Array.from(_formatFilter).map((e) => `lower(file_path) LIKE '%${e}'`).join(" OR ");
  return ` AND (${likes})`;
}
function buildMultiOrderClause(sortMode) {
  switch (sortMode) {
    case "name-asc":
      return "ORDER BY file_name ASC, file_path ASC";
    case "name-desc":
      return "ORDER BY file_name DESC, file_path ASC";
    case "time-asc":
      return "ORDER BY modify_time ASC, file_path ASC";
    case "time-desc":
      return "ORDER BY modify_time DESC, file_path ASC";
    case "dim-asc":
      return "ORDER BY (CASE WHEN width=0 OR height=0 THEN 99999999 ELSE width*height END) ASC, file_name ASC";
    case "dim-desc":
      return "ORDER BY (CASE WHEN width=0 OR height=0 THEN -1 ELSE width*height END) DESC, file_name ASC";
    case "size-asc":
      return "ORDER BY file_size ASC, file_name ASC";
    case "size-desc":
      return "ORDER BY file_size DESC, file_name ASC";
    default:
    case "random":
      return "ORDER BY sort_order";
  }
}
function getImagesPageMulti(folderIds, offset, limit, sortMode) {
  if (!sortMode || sortMode === "random") {
    const key = folderIds.sort((a, b) => a - b).join(",");
    if (offset === 0) {
      const placeholders2 = folderIds.map(() => "?").join(",");
      const ids = getDb().prepare(
        `SELECT id FROM images WHERE folder_id IN (${placeholders2})${fmtFilterClause()}`
      ).all(...folderIds);
      const arr = ids.map((r) => r.id);
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      multiFolderShuffles.set(key, arr);
    }
    const pool = multiFolderShuffles.get(key);
    if (!pool) return [];
    const slice = pool.slice(offset, offset + limit);
    if (!slice.length) return [];
    return getImagesByIds(slice);
  }
  if (sortMode.startsWith("hue") || sortMode.startsWith("sat") || sortMode.startsWith("val")) {
    const ids = [...new Set(folderIds)].sort((a, b) => a - b);
    const key = `color:${ids.join(",")}:${sortMode}`;
    let pool = multiFolderShuffles.get(key);
    if (!pool) {
      const placeholders2 = ids.map(() => "?").join(",");
      const rows = getDb().prepare(
        `SELECT id, color_info FROM images WHERE folder_id IN (${placeholders2})${fmtFilterClause()}`
      ).all(...ids);
      const dir = sortMode.endsWith("-desc") ? -1 : 1;
      const base = sortMode.replace("-asc", "").replace("-desc", "");
      const entries = rows.map((r) => ({ id: r.id, hsv: _parseHsv(r.color_info) }));
      entries.sort((a, b) => {
        if (!a.hsv && !b.hsv) return 0;
        if (!a.hsv) return 1;
        if (!b.hsv) return -1;
        if (base === "hue") {
          const da = (a.hsv.h % 360 + 360) % 360;
          const db2 = (b.hsv.h % 360 + 360) % 360;
          return (da - db2) * dir;
        }
        if (base === "sat") return (a.hsv.s - b.hsv.s) * dir;
        return (a.hsv.v - b.hsv.v) * dir;
      });
      pool = entries.map((e) => e.id);
      multiFolderShuffles.set(key, pool);
    }
    const slice = pool.slice(offset, offset + limit);
    if (!slice.length) return [];
    return getImagesByIds(slice);
  }
  const placeholders = folderIds.map(() => "?").join(",");
  const orderClause = buildMultiOrderClause(sortMode);
  return getDb().prepare(
    `SELECT * FROM images WHERE folder_id IN (${placeholders})${fmtFilterClause()} ${orderClause} LIMIT ? OFFSET ?`
  ).all(...folderIds, limit, offset);
}
function getImagesCountMulti(folderIds) {
  const placeholders = folderIds.map(() => "?").join(",");
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM images WHERE folder_id IN (${placeholders})${fmtFilterClause()}`
  ).get(...folderIds);
  return row?.cnt || 0;
}
function searchImages(folderId, query, offset, limit) {
  return getDb().prepare(
    `SELECT * FROM images WHERE folder_id = ? AND file_name LIKE ?${fmtFilterClause()} ORDER BY sort_order LIMIT ? OFFSET ?`
  ).all(folderId, `%${query}%`, limit, offset);
}
function searchImagesCount(folderId, query) {
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM images WHERE folder_id = ? AND file_name LIKE ?${fmtFilterClause()}`
  ).get(folderId, `%${query}%`);
  return row?.cnt || 0;
}
function searchByDescription(folderId, query, offset, limit) {
  return getDb().prepare(
    `SELECT * FROM images WHERE folder_id = ? AND description LIKE ?${fmtFilterClause()} ORDER BY sort_order LIMIT ? OFFSET ?`
  ).all(folderId, `%${query}%`, limit, offset);
}
function searchByDescriptionCount(folderId, query) {
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM images WHERE folder_id = ? AND description LIKE ?${fmtFilterClause()}`
  ).get(folderId, `%${query}%`);
  return row?.cnt || 0;
}
function searchByRating(folderId, ratings, offset, limit) {
  if (!ratings.length) {
    return getDb().prepare(
      `SELECT * FROM images WHERE folder_id = ? AND rating = 0${fmtFilterClause()} ORDER BY sort_order LIMIT ? OFFSET ?`
    ).all(folderId, limit, offset);
  }
  const ph = ratings.map(() => "?").join(",");
  return getDb().prepare(
    `SELECT * FROM images WHERE folder_id = ? AND rating IN (${ph})${fmtFilterClause()} ORDER BY rating DESC, sort_order LIMIT ? OFFSET ?`
  ).all(folderId, ...ratings, limit, offset);
}
function searchByRatingCount(folderId, ratings) {
  if (!ratings.length) {
    const row2 = getDb().prepare(
      `SELECT COUNT(*) as cnt FROM images WHERE folder_id = ? AND rating = 0${fmtFilterClause()}`
    ).get(folderId);
    return row2?.cnt || 0;
  }
  const ph = ratings.map(() => "?").join(",");
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM images WHERE folder_id = ? AND rating IN (${ph})${fmtFilterClause()}`
  ).get(folderId, ...ratings);
  return row?.cnt || 0;
}
function searchByAspectRatio(folderId, ratioW, ratioH, tolerance, offset, limit) {
  const target = ratioW / ratioH;
  const lo = target * (1 - tolerance);
  const hi = target * (1 + tolerance);
  return getDb().prepare(
    `SELECT * FROM images WHERE folder_id = ? AND width > 0 AND height > 0 AND (CAST(width AS REAL) / CAST(height AS REAL)) BETWEEN ? AND ?${fmtFilterClause()} ORDER BY sort_order LIMIT ? OFFSET ?`
  ).all(folderId, lo, hi, limit, offset);
}
function searchByAspectRatioCount(folderId, ratioW, ratioH, tolerance) {
  const target = ratioW / ratioH;
  const lo = target * (1 - tolerance);
  const hi = target * (1 + tolerance);
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM images WHERE folder_id = ? AND width > 0 AND height > 0 AND (CAST(width AS REAL) / CAST(height AS REAL)) BETWEEN ? AND ?${fmtFilterClause()}`
  ).get(folderId, lo, hi);
  return row?.cnt || 0;
}
function searchMultiRows(folderIds, condClause, condParams, sortMode, offset, limit) {
  const ids = [...new Set(folderIds)].sort((a, b) => a - b);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const base = `folder_id IN (${placeholders})${fmtFilterClause()} AND ${condClause}`;
  if (!sortMode || sortMode === "random") {
    const key = `${ids.join(",")}|${condClause}|${JSON.stringify(condParams)}`;
    let pool = multiFolderShuffles.get(key);
    if (!pool) {
      const idRows = getDb().prepare(
        `SELECT id FROM images WHERE ${base}`
      ).all(...ids, ...condParams);
      pool = idRows.map((r) => r.id);
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      multiFolderShuffles.set(key, pool);
    }
    return getColorRowsByIdsOrdered(pool.slice(offset, offset + limit));
  }
  const orderClause = buildMultiOrderClause(sortMode);
  return getDb().prepare(
    `SELECT ${COLOR_SELECT_COLS} FROM images WHERE ${base} ${orderClause} LIMIT ? OFFSET ?`
  ).all(...ids, ...condParams, limit, offset);
}
function searchMultiCount(folderIds, condClause, condParams) {
  const ids = [...new Set(folderIds)].sort((a, b) => a - b);
  if (!ids.length) return 0;
  const placeholders = ids.map(() => "?").join(",");
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM images WHERE folder_id IN (${placeholders})${fmtFilterClause()} AND ${condClause}`
  ).get(...ids, ...condParams);
  return row?.cnt || 0;
}
function searchImagesMulti(folderIds, query, offset, limit, sortMode) {
  return searchMultiRows(folderIds, "file_name LIKE ?", [`%${query}%`], sortMode, offset, limit);
}
function searchImagesCountMulti(folderIds, query) {
  return searchMultiCount(folderIds, "file_name LIKE ?", [`%${query}%`]);
}
function searchByDescriptionMulti(folderIds, query, offset, limit, sortMode) {
  return searchMultiRows(folderIds, "description LIKE ?", [`%${query}%`], sortMode, offset, limit);
}
function searchByDescriptionCountMulti(folderIds, query) {
  return searchMultiCount(folderIds, "description LIKE ?", [`%${query}%`]);
}
function searchByRatingMulti(folderIds, ratings, offset, limit, sortMode) {
  if (!ratings.length) return searchMultiRows(folderIds, "rating = 0", [], sortMode, offset, limit);
  const ph = ratings.map(() => "?").join(",");
  return searchMultiRows(folderIds, `rating IN (${ph})`, ratings, sortMode, offset, limit);
}
function searchByRatingCountMulti(folderIds, ratings) {
  if (!ratings.length) return searchMultiCount(folderIds, "rating = 0", []);
  const ph = ratings.map(() => "?").join(",");
  return searchMultiCount(folderIds, `rating IN (${ph})`, ratings);
}
function searchByAspectRatioMulti(folderIds, ratioW, ratioH, tolerance, offset, limit, sortMode) {
  const target = ratioW / ratioH;
  const lo = target * (1 - tolerance);
  const hi = target * (1 + tolerance);
  return searchMultiRows(
    folderIds,
    "width > 0 AND height > 0 AND (CAST(width AS REAL) / CAST(height AS REAL)) BETWEEN ? AND ?",
    [lo, hi],
    sortMode,
    offset,
    limit
  );
}
function searchByAspectRatioCountMulti(folderIds, ratioW, ratioH, tolerance) {
  const target = ratioW / ratioH;
  const lo = target * (1 - tolerance);
  const hi = target * (1 + tolerance);
  return searchMultiCount(
    folderIds,
    "width > 0 AND height > 0 AND (CAST(width AS REAL) / CAST(height AS REAL)) BETWEEN ? AND ?",
    [lo, hi]
  );
}
function getImagesByIds(ids) {
  if (!ids.length) return [];
  const db2 = getDb();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db2.prepare(
    `SELECT id, folder_id, file_path, file_name, file_size, modify_time, width, height, thumbnail_path, is_favorite, sort_order FROM images WHERE id IN (${placeholders})`
  ).all(...ids);
  const map = /* @__PURE__ */ new Map();
  for (const r of rows) map.set(r.id, r);
  return ids.map((id) => map.get(id)).filter(Boolean);
}
function getAllImageIds(folderId) {
  return getDb().prepare(`SELECT id, file_path FROM images WHERE folder_id = ?${fmtFilterClause()}`).all(folderId);
}
function getRandomSample(folderId, excludePath, count) {
  const db2 = getDb();
  const ids = db2.prepare(
    `SELECT id FROM images WHERE folder_id = ? AND file_path != ?${fmtFilterClause()}`
  ).all(folderId, excludePath);
  return pickAndFetch(ids, count, db2);
}
function getRandomSampleMulti(folderIds, excludePath, count) {
  const db2 = getDb();
  const fPlaceholders = folderIds.map(() => "?").join(",");
  const ids = db2.prepare(
    `SELECT id FROM images WHERE folder_id IN (${fPlaceholders}) AND file_path != ?${fmtFilterClause()}`
  ).all(...folderIds, excludePath);
  return pickAndFetch(ids, count, db2);
}
function pickAndFetch(ids, count, db2) {
  if (ids.length === 0) return [];
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const picked = ids.slice(0, Math.min(count, ids.length)).map((r) => r.id);
  const placeholders = picked.map(() => "?").join(",");
  return db2.prepare(
    `SELECT * FROM images WHERE id IN (${placeholders})`
  ).all(...picked);
}
const _randomBackup = /* @__PURE__ */ new Map();
const _folderSortMode = /* @__PURE__ */ new Map();
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = h << 13 | h >>> 19;
  }
  return function() {
    h = Math.imul(h ^ h >>> 16, 2246822507);
    h = Math.imul(h ^ h >>> 13, 3266489909);
    return (h ^ h >>> 16) >>> 0;
  };
}
function mulberry32(seed) {
  return function() {
    seed |= 0;
    seed = seed + 1831565813 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function _parseHsv(colorInfo) {
  if (!colorInfo) return null;
  try {
    const o = JSON.parse(colorInfo);
    if (o.h != null && o.s != null && o.v != null) return { h: o.h, s: o.s, v: o.v };
    return null;
  } catch {
    return null;
  }
}
function getFolderStoredSortMode(folderId) {
  return _folderSortMode.get(folderId);
}
function generateRandomSeed() {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * 36)];
  return s;
}
function getFolderRandomSeed(folderId) {
  const row = getDb().prepare("SELECT random_seed FROM folders WHERE id = ?").get(folderId);
  return row?.random_seed || "";
}
function setFolderRandomSeed(folderId, seed) {
  getDb().prepare("UPDATE folders SET random_seed = ? WHERE id = ?").run(seed, folderId);
}
function recomputeSortOrder(folderId, sortMode, forceShuffle = false, hueOrigin = 0) {
  const db2 = getDb();
  const needsColorInfo = sortMode.startsWith("hue") || sortMode.startsWith("sat") || sortMode.startsWith("val");
  const rows = db2.prepare(
    needsColorInfo ? "SELECT id, file_name, file_size, modify_time, width, height, color_info FROM images WHERE folder_id = ? ORDER BY id" : "SELECT id, file_name, file_size, modify_time, width, height FROM images WHERE folder_id = ? ORDER BY id"
  ).all(folderId);
  if (rows.length === 0) {
    _folderSortMode.set(folderId, sortMode);
    return;
  }
  function shuffleArr(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  _folderSortMode.get(folderId);
  new Map(rows.map((r) => [r.id, r]));
  let sorted;
  if (sortMode === "random") {
    let seed = db2.prepare("SELECT random_seed FROM folders WHERE id = ?").get(folderId)?.random_seed;
    if (forceShuffle || !seed) {
      seed = generateRandomSeed();
      db2.prepare("UPDATE folders SET random_seed = ? WHERE id = ?").run(seed, folderId);
    }
    const rng = mulberry32(xmur3(seed)());
    sorted = shuffleArr([...rows], rng);
  } else {
    switch (sortMode) {
      case "name-asc":
        sorted = [...rows].sort((a, b) => a.file_name.localeCompare(b.file_name));
        break;
      case "name-desc":
        sorted = [...rows].sort((a, b) => b.file_name.localeCompare(a.file_name));
        break;
      case "time-asc":
        sorted = [...rows].sort((a, b) => a.modify_time - b.modify_time);
        break;
      case "time-desc":
        sorted = [...rows].sort((a, b) => b.modify_time - a.modify_time);
        break;
      case "dim-asc":
        sorted = [...rows].sort((a, b) => {
          const aa = (a.width || 0) * (a.height || 0), ba = (b.width || 0) * (b.height || 0);
          if (aa === 0 && ba === 0) return 0;
          if (aa === 0) return 1;
          if (ba === 0) return -1;
          return aa - ba;
        });
        break;
      case "dim-desc":
        sorted = [...rows].sort((a, b) => {
          const aa = (a.width || 0) * (a.height || 0), ba = (b.width || 0) * (b.height || 0);
          if (aa === 0 && ba === 0) return 0;
          if (aa === 0) return 1;
          if (ba === 0) return -1;
          return ba - aa;
        });
        break;
      case "size-asc":
        sorted = [...rows].sort((a, b) => a.file_size - b.file_size);
        break;
      case "size-desc":
        sorted = [...rows].sort((a, b) => b.file_size - a.file_size);
        break;
      case "hue-asc":
        sorted = [...rows].sort((a, b) => {
          const ca = _parseHsv(a.color_info), cb = _parseHsv(b.color_info);
          const ha = ca?.h ?? 361, hb = cb?.h ?? 361;
          if (ha === 361 && hb === 361) return 0;
          if (ha === 361) return 1;
          if (hb === 361) return -1;
          const da = ((ha - hueOrigin + 360) % 360 + 360) % 360;
          const db3 = ((hb - hueOrigin + 360) % 360 + 360) % 360;
          return da - db3;
        });
        break;
      case "hue-desc":
        sorted = [...rows].sort((a, b) => {
          const ca = _parseHsv(a.color_info), cb = _parseHsv(b.color_info);
          const ha = ca?.h ?? -1, hb = cb?.h ?? -1;
          if (ha === -1 && hb === -1) return 0;
          if (ha === -1) return 1;
          if (hb === -1) return -1;
          const da = ((ha - hueOrigin + 360) % 360 + 360) % 360;
          const db3 = ((hb - hueOrigin + 360) % 360 + 360) % 360;
          return db3 - da;
        });
        break;
      case "sat-asc":
        sorted = [...rows].sort((a, b) => {
          const ca = _parseHsv(a.color_info), cb = _parseHsv(b.color_info);
          const sa = ca?.s ?? -1, sb = cb?.s ?? -1;
          if (sa === -1 && sb === -1) return 0;
          if (sa === -1) return 1;
          if (sb === -1) return -1;
          return sa - sb;
        });
        break;
      case "sat-desc":
        sorted = [...rows].sort((a, b) => {
          const ca = _parseHsv(a.color_info), cb = _parseHsv(b.color_info);
          const sa = ca?.s ?? -1, sb = cb?.s ?? -1;
          if (sa === -1 && sb === -1) return 0;
          if (sa === -1) return 1;
          if (sb === -1) return -1;
          return sb - sa;
        });
        break;
      case "val-asc":
        sorted = [...rows].sort((a, b) => {
          const ca = _parseHsv(a.color_info), cb = _parseHsv(b.color_info);
          const va = ca?.v ?? -1, vb = cb?.v ?? -1;
          if (va === -1 && vb === -1) return 0;
          if (va === -1) return 1;
          if (vb === -1) return -1;
          return va - vb;
        });
        break;
      case "val-desc":
        sorted = [...rows].sort((a, b) => {
          const ca = _parseHsv(a.color_info), cb = _parseHsv(b.color_info);
          const va = ca?.v ?? -1, vb = cb?.v ?? -1;
          if (va === -1 && vb === -1) return 0;
          if (va === -1) return 1;
          if (vb === -1) return -1;
          return vb - va;
        });
        break;
      default:
        sorted = [...rows];
    }
  }
  const update = db2.prepare("UPDATE images SET sort_order = ? WHERE id = ?");
  const tx = db2.transaction(() => {
    sorted.forEach((img, i) => update.run(i, img.id));
  });
  tx();
  _folderSortMode.set(folderId, sortMode);
}
function updateFavorite(filePath, isFavorite) {
  const ts = isFavorite ? Math.floor(Date.now() / 1e3) : 0;
  getDb().prepare("UPDATE images SET is_favorite = ?, favorited_at = ? WHERE file_path = ?").run(isFavorite, ts, filePath);
}
function updateImageDimensions(filePath, width, height) {
  getDb().prepare("UPDATE images SET width = ?, height = ? WHERE file_path = ?").run(width, height, filePath);
}
function updateThumbnailPath(filePath, thumbnailPath) {
  getDb().prepare("UPDATE images SET thumbnail_path = ? WHERE file_path = ?").run(thumbnailPath, filePath);
}
function updateFeaturesBatch(items) {
  if (!items.length) return;
  const stmt = getDb().prepare("UPDATE images SET features = ? WHERE file_path = ?");
  getDb().transaction(() => {
    for (const r of items) stmt.run(Buffer.from(r.features.buffer, r.features.byteOffset, r.features.byteLength), r.filePath);
  })();
}
function getThumbnailPaths(paths) {
  const out = /* @__PURE__ */ new Map();
  if (!paths.length) return out;
  const placeholders = paths.map(() => "?").join(",");
  const rows = getDb().prepare(
    `SELECT file_path, thumbnail_path FROM images WHERE file_path IN (${placeholders}) AND thumbnail_path IS NOT NULL AND thumbnail_path != ''`
  ).all(...paths);
  for (const r of rows) out.set(r.file_path, r.thumbnail_path);
  return out;
}
function getFeaturesByFolder(folderId) {
  return getDb().prepare("SELECT file_path, features FROM images WHERE folder_id = ?").all(folderId);
}
function getAllFeatures() {
  return getDb().prepare("SELECT file_path, features FROM images").all();
}
function updateClipFeature(filePath, vec) {
  getDb().prepare("UPDATE images SET clip_feat = ? WHERE file_path = ?").run(Buffer.from(vec.buffer), filePath);
}
function getClipFeaturesByFolder(folderId) {
  return getDb().prepare("SELECT file_path, clip_feat FROM images WHERE folder_id = ?").all(folderId);
}
function getAllClipFeatures() {
  return getDb().prepare("SELECT file_path, clip_feat FROM images").all();
}
function getRootClipFeatures(folderIds) {
  if (!folderIds.length) return [];
  const placeholders = folderIds.map(() => "?").join(",");
  return getDb().prepare(`SELECT file_path, clip_feat FROM images WHERE folder_id IN (${placeholders})`).all(...folderIds);
}
function getClipFeaturesByPaths(paths) {
  if (!paths.length) return [];
  const placeholders = paths.map(() => "?").join(",");
  return getDb().prepare(`SELECT file_path, clip_feat FROM images WHERE file_path IN (${placeholders})`).all(...paths);
}
function countClipFeaturesByFolder(folderId) {
  const row = getDb().prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN clip_feat IS NOT NULL THEN 1 ELSE 0 END) AS idx FROM images WHERE folder_id = ?").get(folderId);
  return { total: row?.total || 0, indexed: row?.idx || 0 };
}
function countClipFeaturesByFolders(folderIds) {
  if (!folderIds.length) return { total: 0, indexed: 0 };
  const placeholders = folderIds.map(() => "?").join(",");
  const row = getDb().prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN clip_feat IS NOT NULL THEN 1 ELSE 0 END) AS idx FROM images WHERE folder_id IN (${placeholders})`).get(...folderIds);
  return { total: row?.total || 0, indexed: row?.idx || 0 };
}
function updateColorInfo(filePath, info) {
  getDb().prepare("UPDATE images SET color_info = ? WHERE file_path = ?").run(JSON.stringify(info), filePath);
}
function getColorInfoByFolder(folderId) {
  return getDb().prepare("SELECT file_path, color_info FROM images WHERE folder_id = ?").all(folderId);
}
function getColorInfoByPaths(paths) {
  if (!paths.length) return [];
  const placeholders = paths.map(() => "?").join(",");
  return getDb().prepare(`SELECT file_path, color_info FROM images WHERE file_path IN (${placeholders})`).all(...paths);
}
function countColorInfoByFolder(folderId) {
  const row = getDb().prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN color_info IS NOT NULL THEN 1 ELSE 0 END) AS idx FROM images WHERE folder_id = ?").get(folderId);
  return { total: row?.total || 0, indexed: row?.idx || 0 };
}
function countColorInfoByFolders(folderIds) {
  if (!folderIds.length) return { total: 0, indexed: 0 };
  const placeholders = folderIds.map(() => "?").join(",");
  const row = getDb().prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN color_info IS NOT NULL THEN 1 ELSE 0 END) AS idx FROM images WHERE folder_id IN (${placeholders})`).get(...folderIds);
  return { total: row?.total || 0, indexed: row?.idx || 0 };
}
function colorDistance(info, target, useHue = true, useSat = true, useValue = true) {
  const hsv = _parseHsv(info);
  if (!hsv) return null;
  let acc = 0;
  let dims = 0;
  if (useHue) {
    const hueDiff = Math.min(Math.abs(hsv.h - target.h), 360 - Math.abs(hsv.h - target.h)) / 180;
    acc += hueDiff * hueDiff;
    dims += 1;
  }
  if (useSat) {
    const satDiff = Math.abs(hsv.s - target.s);
    acc += satDiff * satDiff;
    dims += 1;
  }
  if (useValue) {
    const valDiff = Math.abs(hsv.v - target.v);
    acc += valDiff * valDiff;
    dims += 1;
  }
  if (dims === 0) return 0;
  return Math.sqrt(acc / dims);
}
const COLOR_SELECT_COLS = "id, file_path, file_name, file_size, modify_time, width, height, thumbnail_path, is_favorite, rating, description, color_info";
function getColorRowsByIdsOrdered(ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = getDb().prepare(
    `SELECT ${COLOR_SELECT_COLS} FROM images WHERE id IN (${placeholders})`
  ).all(...ids);
  const map = /* @__PURE__ */ new Map();
  for (const row of rows) map.set(row.id, row);
  const ordered = [];
  for (const id of ids) {
    const row = map.get(id);
    if (row) ordered.push(row);
  }
  return ordered;
}
function searchByColor(folderIds, target, tolerance, offset, limit, sortMode, useHue = true, useSat = true, useValue = true) {
  const ids = [...new Set(folderIds)].sort((a, b) => a - b);
  if (!ids.length) return { rows: [], total: 0 };
  let rows = [];
  if (!sortMode || sortMode === "random") {
    if (ids.length === 1) {
      rows = getDb().prepare(
        `SELECT ${COLOR_SELECT_COLS} FROM images WHERE folder_id = ?${fmtFilterClause()} ORDER BY sort_order, file_path`
      ).all(ids[0]);
    } else {
      const key = ids.join(",");
      let pool = multiFolderShuffles.get(key);
      if (!pool) {
        const placeholders = ids.map(() => "?").join(",");
        const idRows = getDb().prepare(
          `SELECT id FROM images WHERE folder_id IN (${placeholders})${fmtFilterClause()}`
        ).all(...ids);
        pool = idRows.map((r) => r.id);
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        multiFolderShuffles.set(key, pool);
      }
      rows = getColorRowsByIdsOrdered(pool);
    }
  } else {
    const placeholders = ids.map(() => "?").join(",");
    const orderClause = buildMultiOrderClause(sortMode);
    rows = getDb().prepare(
      `SELECT ${COLOR_SELECT_COLS} FROM images WHERE folder_id IN (${placeholders})${fmtFilterClause()} ${orderClause}`
    ).all(...ids);
  }
  const matches = rows.filter((r) => {
    const d = colorDistance(r.color_info, target, useHue, useSat, useValue);
    return d != null && d <= tolerance;
  });
  return { rows: matches.slice(offset, offset + limit), total: matches.length };
}
function updateRating(filePath, rating) {
  getDb().prepare("UPDATE images SET rating = ? WHERE file_path = ?").run(rating, filePath);
}
function updateDescription(filePath, desc) {
  getDb().prepare("UPDATE images SET description = ? WHERE file_path = ?").run(desc, filePath);
}
function clearRatingsInFolder(folderId) {
  const info = getDb().prepare("UPDATE images SET rating = 0 WHERE folder_id = ? AND rating > 0").run(folderId);
  return info.changes || 0;
}
function clearDescriptionsInFolder(folderId) {
  const info = getDb().prepare(`UPDATE images SET description = '' WHERE folder_id = ? AND description IS NOT NULL AND LENGTH(description) > 0`).run(folderId);
  return info.changes || 0;
}
function getFavoriteImages() {
  return getDb().prepare(`SELECT * FROM images WHERE is_favorite = 1${fmtFilterClause()} ORDER BY favorited_at DESC`).all();
}
function getFavoritesCount() {
  const row = getDb().prepare("SELECT COUNT(*) as c FROM images WHERE is_favorite = 1").get();
  return row?.c || 0;
}
function getFolderCachedStats(folderId) {
  const row = getDb().prepare("SELECT image_count, total_size FROM folders WHERE id = ?").get(folderId);
  return { image_count: row?.image_count || 0, total_size: row?.total_size || 0 };
}
function getAllFolders() {
  return getDb().prepare("SELECT * FROM folders ORDER BY sort_order ASC, added_at DESC").all();
}
function reorderFolders(orderedIds) {
  const stmt = getDb().prepare("UPDATE folders SET sort_order = ? WHERE id = ?");
  const update = getDb().transaction((ids) => {
    for (let i = 0; i < ids.length; i++) {
      stmt.run(i, ids[i]);
    }
  });
  update(orderedIds);
}
function addFolder(folderPath, displayName) {
  const name = displayName || folderPath.split("\\").pop() || folderPath;
  const stmt = getDb().prepare("INSERT OR IGNORE INTO folders (path, display_name) VALUES (?, ?)");
  stmt.run(folderPath, name);
  const row = getDb().prepare("SELECT id FROM folders WHERE path = ?").get(folderPath);
  return row?.id || 0;
}
function updateFolderName(folderId, displayName) {
  getDb().prepare("UPDATE folders SET display_name = ? WHERE id = ?").run(displayName, folderId);
}
function updateFolderPath(folderId, newPath) {
  getDb().prepare("UPDATE folders SET path = ? WHERE id = ?").run(newPath, folderId);
}
function deleteFolderById(folderId) {
  getDb().prepare("DELETE FROM folders WHERE id = ?").run(folderId);
}
function updateFolderColor(folderId, color) {
  getDb().prepare("UPDATE folders SET color = ? WHERE id = ?").run(color, folderId);
}
function updateFolderCover(folderId, coverPath) {
  getDb().prepare("UPDATE folders SET cover_path = ? WHERE id = ?").run(coverPath, folderId);
}
function updateFolderFavorite(folderId, val) {
  getDb().prepare("UPDATE folders SET is_favorite = ? WHERE id = ?").run(val, folderId);
}
function updateFolderDescription(folderId, desc) {
  getDb().prepare("UPDATE folders SET description = ? WHERE id = ?").run(desc, folderId);
}
function getFolderStoredCover(folderId) {
  const row = getDb().prepare("SELECT cover_path FROM folders WHERE id = ?").get(folderId);
  return row?.cover_path || "";
}
function getFolderRandomThumbs(folderId, count) {
  const db2 = getDb();
  const ids = db2.prepare("SELECT id FROM images WHERE folder_id = ?").all(folderId);
  if (ids.length === 0) return [];
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const picked = ids.slice(0, Math.min(count, ids.length)).map((r) => r.id);
  if (!picked.length) return [];
  const placeholders = picked.map(() => "?").join(",");
  return db2.prepare(
    `SELECT file_path, thumbnail_path FROM images WHERE id IN (${placeholders})`
  ).all(...picked);
}
function getFolderDisplayNameByPath(folderPath) {
  const col = getDb().prepare("SELECT display_name FROM folders WHERE path = ?").get(folderPath);
  return col?.display_name || "";
}
function getFolderStats(folderId) {
  const db2 = getDb();
  const cached = db2.prepare("SELECT image_count, total_size FROM folders WHERE id = ?").get(folderId);
  const cnt = cached?.image_count || 0;
  const countCapped = false;
  const totalSize = cached?.total_size || 0;
  const favCnt = db2.prepare("SELECT COUNT(*) as c FROM images WHERE folder_id = ? AND is_favorite = 1").get(folderId)?.c || 0;
  const latest = db2.prepare("SELECT file_path, thumbnail_path FROM images WHERE folder_id = ? ORDER BY modify_time DESC LIMIT 1").get(folderId);
  const recent = db2.prepare("SELECT file_path, thumbnail_path FROM images WHERE folder_id = ? AND file_path != ? ORDER BY modify_time DESC LIMIT 3").all(folderId, latest?.file_path || "");
  return {
    count: cnt,
    countCapped,
    totalSize,
    favCount: favCnt,
    latestPath: latest?.file_path || null,
    latestThumb: latest?.thumbnail_path || null,
    recentPaths: recent
  };
}
function closeDatabase() {
  _randomBackup.clear();
  multiFolderShuffles.clear();
  if (db) {
    db.close();
    db = null;
  }
}
let activeChild = null;
let watchedFolder = null;
let _curGen = 0;
let _stopping = false;
let _addQueue = [];
let _addRunning = false;
const ADD_TIMEOUT_MS = 3e4;
let _restartCount = 0;
let _restartTimer = null;
const MAX_RESTART = 3;
const RESTART_BASE_MS = 2e3;
function _probeLog(msg) {
  try {
    const { app } = require("electron");
    const dataDir2 = app.isPackaged ? app.getPath("userData") : path.join(process.cwd(), "_internal_data");
    fs.appendFileSync(path.join(dataDir2, "perf-probe.log"), `[watcher] ${(/* @__PURE__ */ new Date()).toISOString()} ${msg}
`);
  } catch {
  }
}
function _ensureWatcherWorkerPath() {
  const workerPath = path.join(__dirname, "watcher-worker.cjs");
  try {
    const fs2 = require("fs");
    fs2.writeFileSync(workerPath, [
      "const { parentPort } = require('worker_threads');",
      "const fs = require('fs');",
      "const path = require('path');",
      "const IMAGE_EXTS = new Set(['.jpg','.jpeg','.png','.gif','.bmp','.webp','.tiff','.tif','.avif','.svg','.psd','.heic','.heif','.mp4','.webm','.mov','.mkv','.avi','.flv','.f4v']);",
      "function extOf(p){ const i=p.lastIndexOf('.'); return i<0?'':p.slice(i).toLowerCase(); }",
      "function isImg(p){ return IMAGE_EXTS.has(extOf(p)); }",
      "// 等价旧 chokidar ignored:/(^|[\\\\/])\\\\./ —— 相对路径任一段以点开头则忽略",
      "function inDotEntry(rel){ return String(rel).split(/[\\\\/]+/).some(function(s){ return s.length > 0 && s.charAt(0) === '.'; }); }",
      "let watcher = null;",
      "let curGen = 0;",
      "parentPort.on('message', (msg) => {",
      "  if (msg && msg.cmd === 'start' && msg.dir) {",
      "    if (watcher) { try { watcher.close(); } catch(e){} watcher = null; }",
      "    curGen = msg.gen;",
      "    try {",
      "      watcher = fs.watch(msg.dir, { recursive: true }, (event, filename) => {",
      "        if (!filename) return;",
      "        if (inDotEntry(filename)) return;",
      "        const full = path.join(msg.dir, filename);",
      "        if (event === 'change') {",
      "          if (isImg(full)) parentPort.postMessage({ evt: 'change', path: full, gen: curGen });",
      "          return;",
      "        }",
      "        // 'rename' 在 fs.watch 语义里 = 创建/删除/改名，用 stat 区分；目录本身忽略（递归监听自动覆盖其内容）",
      "        fs.stat(full, (err, st) => {",
      "          if (err) { parentPort.postMessage({ evt: 'unlink', path: full, gen: curGen }); return; }",
      "          if (st.isFile() && isImg(full)) parentPort.postMessage({ evt: 'add', path: full, gen: curGen });",
      "        });",
      "      });",
      "      watcher.on('error', (e) => parentPort.postMessage({ evt: 'error', msg: String(e && e.message || e), gen: curGen }));",
      "      // 递归监听立即生效，无需像 chokidar 那样先全盘爬目录树",
      "      parentPort.postMessage({ evt: 'ready', ms: 0, gen: curGen });",
      "    } catch(e) {",
      "      parentPort.postMessage({ evt: 'fatal', msg: String(e && e.message || e), gen: curGen });",
      "    }",
      "  } else if (msg && msg.cmd === 'stop') {",
      "    if (watcher) { try { watcher.close(); } catch(e){} watcher = null; }",
      "    parentPort.postMessage({ evt: 'stopped' });",
      "  }",
      "});",
      ""
    ].join("\n"));
  } catch (e) {
    _probeLog(`worker script write error: ${e?.message || e}`);
  }
  return workerPath;
}
let _onAddCb = null;
let _onDeleteCb = null;
let _mainWindow = null;
async function _drainAddQueue() {
  if (_addRunning) return;
  _addRunning = true;
  try {
    while (_addQueue.length > 0) {
      const fp = _addQueue.shift();
      let timedOut = false;
      try {
        if (_onAddCb) {
          await Promise.race([
            _onAddCb(fp),
            new Promise((r) => setTimeout(() => {
              timedOut = true;
              r();
            }, ADD_TIMEOUT_MS))
          ]);
        }
        if (timedOut) _probeLog(`drain timeout: ${fp.slice(-60)}`);
      } catch (err) {
        console.error("watcher add error:", err);
      }
    }
  } finally {
    _addRunning = false;
  }
}
function _restartWatcher() {
  if (!watchedFolder || !_mainWindow || !_onAddCb || !_onDeleteCb) return;
  if (_stopping) return;
  _restartCount++;
  if (_restartCount > MAX_RESTART) {
    _probeLog(`crash restart limit reached (${MAX_RESTART}), giving up for ${watchedFolder.slice(-50)}`);
    activeChild = null;
    watchedFolder = null;
    return;
  }
  const delay = RESTART_BASE_MS * Math.min(_restartCount, MAX_RESTART);
  _probeLog(`crash detected, restart #${_restartCount} in ${delay}ms for ${watchedFolder.slice(-50)}`);
  activeChild = null;
  _restartTimer = setTimeout(() => {
    if (!_stopping && watchedFolder) startWatching(watchedFolder, _mainWindow, _onAddCb, _onDeleteCb);
  }, delay);
}
function startWatching(folderPath, mainWindow2, onAdd, onDelete) {
  stopWatching();
  watchedFolder = folderPath;
  _curGen++;
  _stopping = false;
  _onAddCb = onAdd;
  _onDeleteCb = onDelete;
  _mainWindow = mainWindow2;
  _addQueue = [];
  _addRunning = false;
  _restartCount = 0;
  _probeLog(`start: ${folderPath.slice(-60)} gen=${_curGen}`);
  const workerPath = _ensureWatcherWorkerPath();
  try {
    activeChild = new worker_threads.Worker(workerPath);
    _probeLog(`worker started gen=${_curGen}`);
  } catch (e) {
    _probeLog(`worker create failed: ${e?.message || e}`);
    activeChild = null;
    return;
  }
  activeChild.on("message", (msg) => {
    if (!msg || !msg.evt) return;
    if (msg.gen !== void 0 && msg.gen !== _curGen) return;
    switch (msg.evt) {
      case "ready":
        _probeLog(`ready: ${msg.ms}ms`);
        break;
      case "add":
        _addQueue.push(msg.path);
        _drainAddQueue();
        break;
      case "unlink":
        if (_onDeleteCb) _onDeleteCb(msg.path);
        break;
      case "change":
        if (_mainWindow && !_mainWindow.isDestroyed()) _mainWindow.webContents.send("sync-db", { type: "change", path: msg.path });
        break;
      case "error":
        console.error("watcher error:", msg.msg);
        break;
      case "fatal":
        _probeLog(`fatal: ${msg.msg}`);
        console.error("[watcher-worker fatal]", msg.msg);
        break;
    }
  });
  activeChild.on("error", (err) => {
    _probeLog(`worker error: ${err.message}`);
  });
  const selfWorker = activeChild;
  selfWorker._gen = _curGen;
  selfWorker.on("exit", (code) => {
    _probeLog(`worker exit code=${code} gen=${_curGen} workerGen=${selfWorker?._gen}`);
    const workerGen = selfWorker?._gen;
    const isCurrent = workerGen === _curGen;
    if (isCurrent && !_stopping && watchedFolder && _mainWindow && _onAddCb && _onDeleteCb) {
      _restartWatcher();
    } else {
      if (activeChild === selfWorker) activeChild = null;
    }
  });
  activeChild.postMessage({ cmd: "start", dir: folderPath, gen: _curGen });
}
function stopWatching() {
  _stopping = true;
  if (_restartTimer) {
    clearTimeout(_restartTimer);
    _restartTimer = null;
  }
  if (activeChild) {
    const worker = activeChild;
    try {
      worker.postMessage({ cmd: "stop" });
    } catch {
    }
    try {
      worker.terminate();
    } catch {
    }
    _probeLog(`stopWatching: worker terminated gen=${_curGen}`);
    activeChild = null;
  }
  watchedFolder = null;
  _addQueue = [];
}
function getWatchedFolder() {
  return watchedFolder;
}
function isWatching() {
  return !!activeChild;
}
process.on("uncaughtException", (err) => {
  try {
    const { app: _a } = require("electron");
    const _dir = _a?.isPackaged ? _a.getPath("userData") : path.join(process.cwd(), "_internal_data");
    fs.appendFileSync(
      path.join(_dir, "crash-guard.log"),
      `[${(/* @__PURE__ */ new Date()).toISOString()}] uncaughtException: ${err?.stack || String(err)}
`
    );
  } catch {
  }
  console.error("[crash-guard] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  try {
    const { app: _a } = require("electron");
    const _dir = _a?.isPackaged ? _a.getPath("userData") : path.join(process.cwd(), "_internal_data");
    fs.appendFileSync(
      path.join(_dir, "crash-guard.log"),
      `[${(/* @__PURE__ */ new Date()).toISOString()}] unhandledRejection: ${String(reason && reason.stack || reason)}
`
    );
  } catch {
  }
  console.error("[crash-guard] unhandledRejection:", reason);
});
try {
  if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = "12";
} catch {
}
function _gc() {
  try {
    if (typeof global.gc === "function") global.gc();
  } catch {
  }
}
function _scheduleGC() {
  setTimeout(_gc, 0);
}
electron.app.setName("PicRand");
electron.app.commandLine.appendSwitch("force_high_performance_gpu");
electron.app.commandLine.appendSwitch("js-flags", "--expose-gc");
let mainWindow = null;
let allowClose = false;
let _gcInterval = null;
let _hbInterval = null;
let tray = null;
let _scanGen = 0;
let _activeScanWorker = null;
const pendingDimReads = /* @__PURE__ */ new Map();
const _scanVpFfmpegs = /* @__PURE__ */ new Set();
function _killScanVpFfmpegs() {
  for (const p of _scanVpFfmpegs) {
    try {
      p._picrandKilled ? p._picrandKilled() : p.kill();
    } catch {
    }
  }
  _scanVpFfmpegs.clear();
}
const _refBoardPids = /* @__PURE__ */ new Set();
function _logChildProbes(tag) {
  try {
    let procLine = "";
    try {
      const { execSync } = require("child_process");
      const out = execSync(`wmic process where "name='PicRand.exe'" get ProcessId,CommandLine /format:list`, { windowsHide: true, timeout: 3e3 }).toString();
      const types = /* @__PURE__ */ new Map();
      const lines = out.split("\n");
      let curCli = "";
      for (const ln of lines) {
        const t = ln.trim();
        if (t.startsWith("CommandLine=")) curCli = t.slice("CommandLine=".length);
        else if (t.startsWith("ProcessId=")) {
          const m = curCli.match(/--type=(\S+)/);
          const ty = m ? m[1] : "main";
          types.set(ty, (types.get(ty) || 0) + 1);
          curCli = "";
        }
      }
      const parts = [];
      for (const [ty, n] of types) parts.push(`${ty}=${n}`);
      procLine = ` procs=[${parts.join(",")}] total=${[...types.values()].reduce((a, b) => a + b, 0)}`;
    } catch {
    }
    fs.appendFileSync(
      path.join(dataDir, "perf-probe.log"),
      `[childprobe] ${(/* @__PURE__ */ new Date()).toISOString()} tag=${tag} watcher=${isWatching() ? 1 : 0} scanVpFfmpeg=${_scanVpFfmpegs.size} refBoard=${_refBoardPids.size}${procLine}
`
    );
  } catch {
  }
}
let currentLocale = "zh";
const isDev = !electron.app.isPackaged;
const exeDir = isDev ? process.cwd() : path.dirname(electron.app.getPath("exe"));
const dataDir = isDev ? path.join(process.cwd(), "_internal_data") : path.join(electron.app.getPath("userData"));
const cacheDir = path.join(dataDir, "cache");
const localDataDir = path.join(exeDir, "_internal_data");
let newFoldersDir = path.join(localDataDir, "_new_folders");
const configPath = path.join(dataDir, "config.json");
function resolveStoredPath(storedPath) {
  if (fs.existsSync(storedPath)) return storedPath;
  const resolved = path.join(exeDir, storedPath);
  if (fs.existsSync(resolved)) return resolved;
  const resolved2 = path.join(dataDir, storedPath);
  if (fs.existsSync(resolved2)) return resolved2;
  return storedPath;
}
const pinboardsPath = path.join(dataDir, "pinboards.json");
const logPath = path.join(dataDir, "thumbnail-errors.log");
function logError(msg) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const line = `[${timestamp}] ${msg}
`;
  try {
    const fs2 = require("fs");
    fs2.appendFileSync(logPath, line, "utf8");
  } catch {
  }
}
const _trayLogPath = path.join(dataDir, "refboard-tray.log");
function _logTray(msg) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const line = `[${timestamp}] ${msg}
`;
  try {
    const fs2 = require("fs");
    fs2.appendFileSync(_trayLogPath, line, "utf8");
    console.log("[refboard-tray]", msg);
  } catch {
  }
}
let _psdPoolInit = false;
let _psdPoolIdleTimer = null;
const _PSD_IDLE_MS = 5e3;
const _PSD_WORKERS = 3;
const _psdWorkers = [];
const _psdPending = [];
function _resetPsdIdleTimer() {
  if (_psdPoolIdleTimer) clearTimeout(_psdPoolIdleTimer);
  _psdPoolIdleTimer = setTimeout(() => {
    console.log("[psd-pool] idle, terminating workers to free memory");
    for (const w of _psdWorkers) {
      try {
        w.terminate();
      } catch {
      }
    }
    _psdWorkers.length = 0;
    _psdPoolInit = false;
  }, _PSD_IDLE_MS);
}
function _terminatePsdPoolNow() {
  if (_psdPoolIdleTimer) {
    clearTimeout(_psdPoolIdleTimer);
    _psdPoolIdleTimer = null;
  }
  for (const w of _psdWorkers) {
    try {
      w.terminate();
    } catch {
    }
  }
  _psdWorkers.length = 0;
  const pending = _psdPending.splice(0);
  for (const j of pending) {
    try {
      j.reject(new Error("psd pool terminated"));
    } catch {
    }
  }
  _psdPoolInit = false;
}
async function _clearSharpCache() {
  try {
    const sharp = (await import("sharp")).default;
    sharp.cache({ memory: 10, files: 0, items: 5 });
  } catch {
  }
}
function _dispatchJob(w, job) {
  const cleanup = () => {
    w._busy = false;
    w.off("message", handler);
    w.off("error", onErr);
    w.off("exit", onExit);
  };
  const onErr = (err) => {
    logError(`[psd-worker] error on ${path.basename(job.psdPath)}: ${err.message}`);
    cleanup();
    job.reject(new Error(`psd worker error: ${err.message}`));
    const idx = _psdWorkers.indexOf(w);
    if (idx >= 0) _psdWorkers.splice(idx, 1);
    if (_psdPending.length > 0) {
      _ensurePsdPool().then(() => {
        const nextW = _psdWorkers.find((x) => !x._busy);
        if (nextW) _dispatchJob(nextW, _psdPending.shift());
      });
    } else {
      _resetPsdIdleTimer();
    }
  };
  const onExit = (code) => {
    logError(`[psd-worker] exited with code ${code} while processing ${path.basename(job.psdPath)}`);
    cleanup();
    job.reject(new Error(`psd worker exited with code ${code}`));
    const idx = _psdWorkers.indexOf(w);
    if (idx >= 0) _psdWorkers.splice(idx, 1);
    if (_psdPending.length > 0) {
      _ensurePsdPool().then(() => {
        const nextW = _psdWorkers.find((x) => !x._busy);
        if (nextW) _dispatchJob(nextW, _psdPending.shift());
      });
    } else {
      _resetPsdIdleTimer();
    }
  };
  const handler = (msg) => {
    if (msg.psdPath !== job.psdPath) return;
    cleanup();
    if (msg.ok) job.resolve({ width: msg.width, height: msg.height, pixels: msg.pixels });
    else job.reject(new Error(msg.error || "psd decode failed"));
    if (_psdPending.length > 0) {
      _dispatchJob(w, _psdPending.shift());
    } else {
      _resetPsdIdleTimer();
    }
  };
  w._busy = true;
  if (_psdPoolIdleTimer) clearTimeout(_psdPoolIdleTimer);
  w.on("message", handler);
  w.on("error", onErr);
  w.on("exit", onExit);
  w.postMessage({ psdPath: job.psdPath });
}
async function _ensurePsdPool() {
  if (_psdPoolInit) return;
  _psdPoolInit = true;
  const path2 = await import("path");
  const fs2 = await import("fs");
  const { Worker } = await import("worker_threads");
  const workerPath = path2.join(__dirname, "psd-worker.cjs");
  if (!fs2.existsSync(workerPath)) {
    fs2.writeFileSync(workerPath, `const { parentPort } = require('worker_threads');
const { readFileSync } = require('fs');
require('ag-psd/initialize-canvas');
const { readPsd } = require('ag-psd');
parentPort.on('message', ({ psdPath }) => {
  try {
    const buf = readFileSync(psdPath);
    const psd = readPsd(buf, { skipLayerImageData: true, skipThumbnail: true, useImageData: true });
    const { data, width, height } = psd.imageData;
    parentPort.postMessage({ ok: true, psdPath, width, height, pixels: Buffer.from(data.buffer, data.byteOffset, data.byteLength) }, [data.buffer]);
  } catch(e) {
    parentPort.postMessage({ ok: false, psdPath, error: e.message || String(e) });
  }
});
parentPort.postMessage({ ready: true });
`);
  }
  for (let i = 0; i < _PSD_WORKERS; i++) {
    const w = new Worker(workerPath);
    w._busy = false;
    _psdWorkers.push(w);
    await new Promise((resolve) => {
      const onMsg = (msg) => {
        if (msg.ready) {
          w.off("message", onMsg);
          resolve();
        }
      };
      w.on("message", onMsg);
      w.on("error", (err) => {
        logError(`[psd-worker] ${err.message}`);
        resolve();
      });
    });
  }
}
async function ensurePsdPng(psdPath) {
  const pngPath = path.join(cacheDir, "psd-" + crypto.createHash("md5").update(psdPath).digest("hex") + ".png");
  if (fs.existsSync(pngPath)) {
    try {
      const sharp = (await import("sharp")).default;
      await sharp(pngPath).metadata();
      return pngPath;
    } catch {
      try {
        const fsp = await import("fs");
        fsp.unlinkSync(pngPath);
      } catch {
      }
    }
  }
  console.log("[psd] converting:", path.basename(psdPath));
  try {
    await _ensurePsdPool();
    console.log("[psd] pool ready, dispatching decode job");
    const job = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("psd decode timeout"));
      }, 12e4);
      const safeResolve = (v) => {
        clearTimeout(timeout);
        resolve(v);
      };
      const safeReject = (e) => {
        clearTimeout(timeout);
        reject(e);
      };
      const free = _psdWorkers.find((w) => !w._busy);
      if (free) _dispatchJob(free, { psdPath, resolve: safeResolve, reject: safeReject });
      else _psdPending.push({ psdPath, resolve: safeResolve, reject: safeReject });
    });
    const sharp = (await import("sharp")).default;
    let { width, height, pixels } = job;
    console.log("[psd] decoded:", width, "x", height, "buf:", pixels?.length);
    const expectedSize = width * height * 4;
    if (!pixels || pixels.length < expectedSize) {
      console.error("[psd] buffer size mismatch:", pixels?.length, "expected:", expectedSize);
      if (pixels && pixels.length > 0 && pixels.length >= width * height * 3) {
        const rgba = Buffer.alloc(expectedSize);
        for (let i = 0; i < width * height; i++) {
          rgba[i * 4] = pixels[i * 3];
          rgba[i * 4 + 1] = pixels[i * 3 + 1];
          rgba[i * 4 + 2] = pixels[i * 3 + 2];
          rgba[i * 4 + 3] = 255;
        }
        pixels = rgba;
      } else {
        return psdPath;
      }
    }
    await sharp(pixels, {
      raw: { width, height, channels: 4 }
    }).png().toFile(pngPath);
    updateImageDimensions(psdPath, width, height);
    _scheduleGC();
    console.log("[psd] done:", path.basename(psdPath));
    return pngPath;
  } catch (e) {
    console.error("[psd] FAILED:", path.basename(psdPath), e?.message || e);
    logError(`[psd-convert] ${path.basename(psdPath)} - ${e?.message || e}`);
    return psdPath;
  }
}
const VIDEO_EXTS = /* @__PURE__ */ new Set([".mp4", ".webm", ".mov", ".mkv", ".avi", ".flv", ".f4v"]);
function isVideoExt(ext) {
  return VIDEO_EXTS.has(ext.toLowerCase());
}
function getPosterPath(filePath) {
  return path.join(cacheDir, crypto.createHash("md5").update(filePath).digest("hex") + ".webp");
}
async function extractVideoFrame(filePath, seekSec, onSpawn) {
  const os2 = await import("os");
  const tmpPng = path.join(os2.tmpdir(), "picrand-frame-" + crypto.createHash("md5").update(filePath).digest("hex") + "-" + Math.floor(Math.random() * 1e6) + ".png");
  try {
    const ffmpegPath = (await import("@ffmpeg-installer/ffmpeg")).path;
    const { spawn } = await import("child_process");
    const args = ["-y"];
    if (seekSec !== void 0) args.push("-ss", String(seekSec));
    args.push("-i", filePath, "-vframes", "1", "-vf", "scale=400:-1", "-an", tmpPng);
    const killed = { v: false };
    await new Promise((resolve, reject) => {
      const p = spawn(ffmpegPath, args, { stdio: "ignore", windowsHide: true });
      if (onSpawn) onSpawn(p);
      p.on("exit", (code) => {
        if (killed.v) resolve();
        else code === 0 ? resolve() : reject(new Error("ffmpeg exit " + code));
      });
      p.on("error", reject);
      p._picrandKilled = () => {
        killed.v = true;
        try {
          p.kill();
        } catch {
        }
      };
    });
    if (!fs.existsSync(tmpPng)) return null;
    return tmpPng;
  } catch (e) {
    logError(`[video-frame] ${path.basename(filePath)} - ${e?.message || e}`);
    try {
      if (fs.existsSync(tmpPng)) fs.unlinkSync(tmpPng);
    } catch {
    }
    return null;
  }
}
async function getOrGeneratePoster(filePath, onSpawn) {
  const posterPath = getPosterPath(filePath);
  if (fs.existsSync(posterPath)) return posterPath;
  let tmpPng = await extractVideoFrame(filePath, void 0, onSpawn);
  if (!tmpPng) tmpPng = await extractVideoFrame(filePath, 0, onSpawn);
  if (!tmpPng) {
    logError(`[video-poster] ${path.basename(filePath)} - frame extraction failed`);
    return "";
  }
  const pngPath = getPosterPngPath(filePath);
  if (!fs.existsSync(pngPath)) {
    try {
      const fse = await import("fs-extra");
      await fse.copy(tmpPng, pngPath);
    } catch {
    }
  }
  try {
    const sharp = (await import("sharp")).default;
    await sharp(tmpPng).resize({ width: 400, withoutEnlargement: true }).webp({ quality: 75 }).toFile(posterPath);
    return posterPath;
  } catch (e) {
    logError(`[video-poster] ${path.basename(filePath)} - encode failed: ${e?.message || e}`);
    try {
      if (fs.existsSync(posterPath)) fs.unlinkSync(posterPath);
    } catch {
    }
    return "";
  } finally {
    try {
      if (fs.existsSync(tmpPng)) fs.unlinkSync(tmpPng);
    } catch {
    }
    _scheduleGC();
  }
}
function getPosterPngPath(filePath) {
  return path.join(cacheDir, crypto.createHash("md5").update(filePath).digest("hex") + ".png");
}
async function readVideoDimensions(filePath) {
  try {
    const ffmpegPath = (await import("@ffmpeg-installer/ffmpeg")).path;
    const { spawn } = await import("child_process");
    const buf = [];
    await new Promise((resolve) => {
      const p = spawn(ffmpegPath, ["-i", filePath], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      p.stderr.on("data", (d) => buf.push(d.toString()));
      p.stdout.on("data", () => {
      });
      const done = () => resolve();
      p.on("exit", done);
      p.on("error", done);
    });
    const text = buf.join("");
    const m = text.match(/Video:[^\n]*?(\d{2,5})x(\d{2,5})/);
    if (m) return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
    return null;
  } catch {
    return null;
  }
}
async function resolveForSharp(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".psd") return await ensurePsdPng(filePath);
  if (isVideoExt(ext)) return await getOrGeneratePoster(filePath);
  return filePath;
}
async function readPsdDimensions(psdPath) {
  try {
    await import("ag-psd");
    try {
      require("ag-psd/initialize-canvas");
    } catch {
    }
    const { readPsd } = await import("ag-psd");
    const fsp = await import("fs");
    const buf = await fsp.promises.readFile(psdPath);
    await new Promise((r) => setImmediate(r));
    const psd = readPsd(buf, {
      skipLayerImageData: true,
      skipCompositeImageData: true,
      skipThumbnail: true
    });
    return { width: psd.width, height: psd.height };
  } catch {
    return null;
  }
}
async function readImageDimensions(filePath, sharpRef) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".psd") return await readPsdDimensions(filePath);
  if (isVideoExt(ext)) return await readVideoDimensions(filePath);
  try {
    await _metaAcquire();
    try {
      const sharp = sharpRef || (await import("sharp")).default;
      const m = await sharp(filePath).metadata();
      if (m.width && m.height) return { width: m.width, height: m.height };
    } finally {
      _metaRelease();
    }
  } catch {
  }
  return null;
}
async function _fillRowsDims(rows) {
  const need = rows.filter((r) => !r.width || !r.height);
  if (!need.length) return;
  let cursor = 0;
  const runOne = async () => {
    while (true) {
      const i = cursor++;
      if (i >= need.length) break;
      const r = need[i];
      try {
        const d = await readImageDimensions(r.file_path);
        if (d && d.width > 0 && d.height > 0) {
          r.width = d.width;
          r.height = d.height;
          updateImageDimensions(r.file_path, d.width, d.height);
        }
      } catch {
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, need.length) }, () => runOne()));
}
function ensureDataDirs() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(localDataDir)) fs.mkdirSync(localDataDir, { recursive: true });
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  const oldNewFolders = path.join(dataDir, "_new_folders");
  if (fs.existsSync(oldNewFolders)) {
    try {
      if (!fs.existsSync(newFoldersDir)) fs.mkdirSync(newFoldersDir, { recursive: true });
      const fsp = require("fs");
      const copyDirRecursive = (src, dst) => {
        const entries = fsp.readdirSync(src, { withFileTypes: true });
        for (const e of entries) {
          const sP = path.join(src, e.name);
          const dP = path.join(dst, e.name);
          if (e.isDirectory()) {
            if (!fs.existsSync(dP)) fsp.mkdirSync(dP, { recursive: true });
            copyDirRecursive(sP, dP);
          } else if (!fs.existsSync(dP)) {
            try {
              fsp.copyFileSync(sP, dP);
            } catch {
            }
          }
        }
      };
      copyDirRecursive(oldNewFolders, newFoldersDir);
      try {
        fsp.rmSync(oldNewFolders, { recursive: true, force: true });
      } catch {
      }
    } catch {
    }
  }
  if (!fs.existsSync(newFoldersDir)) fs.mkdirSync(newFoldersDir, { recursive: true });
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({ columns: 4, picRadius: 8, picGap: 12, picShadow: "heavy", themeColor: "#faf5ef", sortMode: "random", defaultSortMode: "random", bgImagePath: "", bgBlurAmount: 12, locale: "en" }, null, 2));
    currentLocale = "en";
  } else {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (cfg.locale) currentLocale = cfg.locale;
      if (cfg.newFoldersPath && fs.existsSync(cfg.newFoldersPath)) {
        newFoldersDir = cfg.newFoldersPath;
      }
      try {
        setFormatFilter(null);
      } catch {
      }
    } catch {
    }
  }
  if (!fs.existsSync(pinboardsPath)) fs.writeFileSync(pinboardsPath, JSON.stringify({ currentId: null, boards: [] }, null, 2));
}
function readPinboards() {
  try {
    if (!fs.existsSync(pinboardsPath)) return { currentId: null, boards: [] };
    const data = JSON.parse(fs.readFileSync(pinboardsPath, "utf-8"));
    if (!Array.isArray(data?.boards)) return { currentId: null, boards: [] };
    return { currentId: data.currentId || null, boards: data.boards };
  } catch {
    return { currentId: null, boards: [] };
  }
}
function writePinboards(data) {
  const tmp = pinboardsPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, pinboardsPath);
  return data;
}
function createPinboardId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}
function getPinboardOrThrow(data, id) {
  const board = data.boards.find((b) => b.id === id);
  if (!board) throw new Error("图钉板不存在");
  return board;
}
async function copyFileUnique(sourcePath, targetDir) {
  const fs2 = await import("fs-extra");
  const path2 = await import("path");
  const ext = path2.extname(sourcePath);
  const base = path2.basename(sourcePath, ext);
  let dest = path2.join(targetDir, path2.basename(sourcePath));
  let i = 1;
  while (await fs2.pathExists(dest)) {
    dest = path2.join(targetDir, `${base}(${i})${ext}`);
    i++;
  }
  await fs2.copy(sourcePath, dest);
  return dest;
}
function discoverThumbnailPath(filePath) {
  const row = getDb().prepare("SELECT thumbnail_path FROM images WHERE file_path = ?").get(filePath);
  if (row?.thumbnail_path && fs.existsSync(row.thumbnail_path)) return row.thumbnail_path;
  const ext = path.extname(filePath).toLowerCase();
  const md5Name = crypto.createHash("md5").update(filePath).digest("hex") + ext;
  const md5Gif = path.join(cacheDir, md5Name);
  const md5Webp = path.join(cacheDir, md5Name.replace(ext, ".webp"));
  const md5Jpg = path.join(cacheDir, md5Name.replace(ext, ".jpg"));
  if (ext === ".gif" && fs.existsSync(md5Gif)) {
    updateThumbnailPath(filePath, md5Gif);
    return md5Gif;
  }
  if (fs.existsSync(md5Webp)) {
    updateThumbnailPath(filePath, md5Webp);
    return md5Webp;
  }
  if (fs.existsSync(md5Jpg)) {
    updateThumbnailPath(filePath, md5Jpg);
    return md5Jpg;
  }
  const b64Name = Buffer.from(filePath).toString("base64url") + ext;
  const b64Gif = path.join(cacheDir, b64Name);
  const b64Webp = path.join(cacheDir, b64Name.replace(ext, ".webp"));
  const b64Jpg = path.join(cacheDir, b64Name.replace(ext, ".jpg"));
  if (ext === ".gif" && fs.existsSync(b64Gif)) {
    updateThumbnailPath(filePath, b64Gif);
    return b64Gif;
  }
  if (fs.existsSync(b64Webp)) {
    updateThumbnailPath(filePath, b64Webp);
    return b64Webp;
  }
  if (fs.existsSync(b64Jpg)) {
    updateThumbnailPath(filePath, b64Jpg);
    return b64Jpg;
  }
  if (row?.thumbnail_path) updateThumbnailPath(filePath, "");
  return "";
}
function registerPicRandProtocol() {
  let _protoCount = 0;
  let _protoVideoCount = 0;
  let _protoLastFlush = 0;
  electron.protocol.handle("picrand", async (request) => {
    _protoCount++;
    const _origExt0 = path.extname(decodeURIComponent(new URL(request.url).searchParams.get("orig") || "")).toLowerCase();
    if (isVideoExt(_origExt0)) _protoVideoCount++;
    if (_protoCount - _protoLastFlush >= 50 || _protoLastFlush === 0 && _protoCount >= 1) {
      _protoLastFlush = _protoCount;
      try {
        fs.appendFileSync(path.join(dataDir, "perf-probe.log"), `[proto] ${(/* @__PURE__ */ new Date()).toISOString()} total=${_protoCount} video=${_protoVideoCount}
`);
      } catch {
      }
    }
    const url = new URL(request.url);
    const origPath = decodeURIComponent(url.searchParams.get("orig") || "");
    const thumbPath = decodeURIComponent(url.searchParams.get("thumb") || "");
    const legacyPath = decodeURIComponent(url.searchParams.get("path") || "");
    let servePath = "";
    if (thumbPath && fs.existsSync(thumbPath)) {
      servePath = thumbPath;
    } else if (origPath && fs.existsSync(origPath)) {
      const _origExt = path.extname(origPath).toLowerCase();
      if (isVideoExt(_origExt)) {
        let poster = getPosterPath(origPath);
        if (!fs.existsSync(poster)) {
          await _videoAcquire();
          try {
            const p = await getOrGeneratePoster(origPath);
            if (p) poster = p;
          } catch {
          } finally {
            _videoRelease();
          }
        }
        if (poster && fs.existsSync(poster)) {
          servePath = poster;
          try {
            updateThumbnailPath(origPath, poster);
          } catch {
          }
        } else {
          return new Response(null, { status: 404, statusText: "Not Found" });
        }
      } else if (thumbPath) {
        try {
          servePath = await ensureQuickThumb(origPath, thumbPath);
        } catch {
          servePath = origPath;
        }
      } else {
        const ext = path.extname(origPath).toLowerCase();
        const b64Name = Buffer.from(origPath).toString("base64url") + ext;
        const expectedWebp = path.join(cacheDir, b64Name.replace(ext, ".webp"));
        const expectedJpg = path.join(cacheDir, b64Name.replace(ext, ".jpg"));
        if (fs.existsSync(expectedWebp)) {
          servePath = expectedWebp;
          updateThumbnailPath(origPath, expectedWebp);
        } else if (fs.existsSync(expectedJpg)) {
          servePath = expectedJpg;
          updateThumbnailPath(origPath, expectedJpg);
        } else {
          if (ext === ".gif") {
            servePath = origPath;
          } else {
            try {
              servePath = await ensureQuickThumb(origPath, expectedJpg);
            } catch {
              servePath = origPath;
            }
          }
        }
      }
    } else if (legacyPath && fs.existsSync(legacyPath)) {
      const lgExt = path.extname(legacyPath).toLowerCase();
      if (isVideoExt(lgExt)) {
        let png = getPosterPngPath(legacyPath);
        if (!fs.existsSync(png)) {
          await _videoAcquire();
          let p = "";
          try {
            p = await getOrGeneratePoster(legacyPath);
          } catch {
          } finally {
            _videoRelease();
          }
          png = p ? getPosterPngPath(legacyPath) : "";
        }
        servePath = png && fs.existsSync(png) ? png : getPosterPath(legacyPath);
      } else {
        servePath = legacyPath;
      }
    }
    if (!servePath) {
      return new Response(null, { status: 404, statusText: "Not Found" });
    }
    const svcExt = path.extname(servePath).toLowerCase();
    if (svcExt === ".tiff" || svcExt === ".tif") {
      const sharp = (await import("sharp")).default;
      const jpgName = crypto.createHash("md5").update(servePath).digest("hex") + ".jpg";
      const jpgPath = path.join(cacheDir, "display-" + jpgName);
      if (!fs.existsSync(jpgPath)) {
        await _cpuAcquire();
        try {
          await sharp(servePath).jpeg({ quality: 92 }).toFile(jpgPath);
        } catch {
        } finally {
          _cpuRelease();
        }
      }
      if (fs.existsSync(jpgPath)) servePath = jpgPath;
    }
    if (svcExt === ".heic" || svcExt === ".heif") {
      const sharp = (await import("sharp")).default;
      const jpgName = crypto.createHash("md5").update(servePath).digest("hex") + ".jpg";
      const jpgPath = path.join(cacheDir, "display-" + jpgName);
      if (!fs.existsSync(jpgPath)) {
        await _cpuAcquire();
        try {
          await sharp(servePath).jpeg({ quality: 92 }).toFile(jpgPath);
        } catch {
        } finally {
          _cpuRelease();
        }
      }
      if (fs.existsSync(jpgPath)) servePath = jpgPath;
    }
    if (svcExt === ".psd") {
      const PSD_MAX_PIXELS_SERVE = 64 * 1024 * 1024;
      let skipPsd = false;
      try {
        const dim = await readPsdDimensions(servePath);
        if (dim && dim.width > 0 && dim.height > 0 && dim.width * dim.height > PSD_MAX_PIXELS_SERVE) {
          logError(`[psd-serve] skip oversize ${path.basename(servePath)} ${dim.width}x${dim.height}`);
          skipPsd = true;
        }
      } catch {
        skipPsd = true;
      }
      if (!skipPsd) {
        const pngPath = await ensurePsdPng(servePath);
        if (fs.existsSync(pngPath)) servePath = pngPath;
      }
    }
    try {
      const ext = path.extname(servePath).toLowerCase();
      const mime = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : ext === ".bmp" ? "image/bmp" : ext === ".tiff" || ext === ".tif" ? "image/tiff" : ext === ".avif" ? "image/avif" : ext === ".svg" ? "image/svg+xml" : "application/octet-stream";
      const fileSize = fs.statSync(servePath).size;
      const { Readable } = await import("stream");
      const nodeStream = fs.createReadStream(servePath, { highWaterMark: 256 * 1024 });
      const webStream = Readable.toWeb(nodeStream);
      return new Response(webStream, { status: 200, headers: { "Content-Type": mime, "Content-Length": String(fileSize), "Cache-Control": "max-age=15" } });
    } catch (e) {
      console.warn("[picrand] 404:", servePath.slice(0, 100), e?.message || "");
      return new Response(null, { status: 404, statusText: "Not Found" });
    }
  });
}
const _cpuConcurrency = 6;
let _cpuRunning = 0;
const _cpuQueue = [];
function _cpuAcquire() {
  if (_cpuRunning < _cpuConcurrency) {
    _cpuRunning++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = _cpuQueue.indexOf(fn);
      if (idx >= 0) {
        _cpuQueue.splice(idx, 1);
        reject(new Error("cpu gate timeout"));
      }
    }, 3e4);
    const fn = () => {
      clearTimeout(timer);
      _cpuRunning++;
      resolve();
    };
    _cpuQueue.push(fn);
  });
}
function _cpuRelease() {
  _cpuRunning--;
  if (_cpuQueue.length > 0) {
    _cpuQueue.shift()();
  }
}
const _metaConcurrency = 8;
let _metaRunning = 0;
const _metaQueue = [];
function _metaAcquire() {
  if (_metaRunning < _metaConcurrency) {
    _metaRunning++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = _metaQueue.indexOf(fn);
      if (idx >= 0) {
        _metaQueue.splice(idx, 1);
        reject(new Error("meta gate timeout"));
      }
    }, 15e3);
    const fn = () => {
      clearTimeout(timer);
      _metaRunning++;
      resolve();
    };
    _metaQueue.push(fn);
  });
}
function _metaRelease() {
  _metaRunning--;
  if (_metaQueue.length > 0) {
    _metaQueue.shift()();
  }
}
let _videoRunning = 0;
const _videoQueue = [];
async function _videoAcquire() {
  if (_videoRunning < 1) {
    _videoRunning++;
    return;
  }
  return new Promise((resolve) => _videoQueue.push(() => {
    _videoRunning++;
    resolve();
  }));
}
function _videoRelease() {
  _videoRunning--;
  if (_videoQueue.length > 0) {
    _videoQueue.shift()();
  }
}
async function _thumbAcquire() {
  return _cpuAcquire();
}
function _thumbRelease() {
  _cpuRelease();
}
async function _ensureQuickThumbImpl(origPath, thumbPath) {
  const destDir = path.dirname(thumbPath);
  if (!fs.existsSync(destDir)) {
    const fsp = await import("fs");
    fsp.mkdirSync(destDir, { recursive: true });
  }
  const ext = path.extname(thumbPath).toLowerCase();
  const origExt = path.extname(origPath).toLowerCase();
  if (ext === ".gif") {
    const fse = await import("fs-extra");
    await fse.copy(origPath, thumbPath);
  } else if (origExt === ".psd") {
    const PSD_MAX_PIXELS = 64 * 1024 * 1024;
    try {
      const dim = await readPsdDimensions(origPath);
      if (dim && dim.width > 0 && dim.height > 0 && dim.width * dim.height > PSD_MAX_PIXELS) {
        logError(`[psd-thumb] skip oversize ${path.basename(origPath)} ${dim.width}x${dim.height}`);
        return origPath;
      }
      const pngPath = await ensurePsdPng(origPath);
      const sharp = (await import("sharp")).default;
      await sharp(pngPath).resize({ width: 400, withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(thumbPath);
    } catch {
      return origPath;
    }
  } else if (isVideoExt(origExt)) {
    try {
      const poster = await getOrGeneratePoster(origPath);
      if (!poster) return origPath;
      const sharp = (await import("sharp")).default;
      await sharp(poster).resize({ width: 400, withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(thumbPath);
    } catch {
      return origPath;
    }
  } else {
    try {
      const sharp = (await import("sharp")).default;
      await sharp(origPath).toColourspace("srgb").resize({ width: 400, withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(thumbPath);
    } catch {
      const { nativeImage: nativeImage2 } = await import("electron");
      const img = nativeImage2.createFromPath(origPath);
      if (img.isEmpty()) return origPath;
      const resized = img.resize({ width: 400 });
      const buf = resized.toJPEG(75);
      const fsp = await import("fs");
      fsp.writeFileSync(thumbPath, buf);
    }
  }
  try {
    updateThumbnailPath(origPath, thumbPath);
  } catch {
  }
  return thumbPath;
}
async function ensureQuickThumb(origPath, thumbPath) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let acquired = false;
    try {
      await _thumbAcquire();
      acquired = true;
      return await _ensureQuickThumbImpl(origPath, thumbPath);
    } catch (e) {
      if (e?.message === "cpu gate timeout" && attempt < 2) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      return origPath;
    } finally {
      if (acquired) _thumbRelease();
    }
  }
  return origPath;
}
function showWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }
}
let _refWinMod = null;
const REFBOARD_CLASS = "PicRandRefBoard4";
async function _getRefWinMod() {
  if (_refWinMod) return _refWinMod;
  const koffiMod = await import("koffi");
  const k = koffiMod.default || koffiMod;
  const user32 = k.load("user32.dll");
  const findWindowEx = user32.func("FindWindowExW", "void *", ["void *", "void *", "str16", "str16"]);
  const showWinAsync = user32.func("ShowWindowAsync", "int32", ["void *", "int32"]);
  _refWinMod = { k, findWindowEx, showWinAsync };
  return _refWinMod;
}
async function _refBoardWindows(action) {
  _logTray(">>> _refBoardWindows called: action=" + action + " trackedPids=" + _refBoardPids.size);
  if (action === "close") {
    for (const pid of _refBoardPids) {
      try {
        process.kill(pid, 0);
      } catch {
        _refBoardPids.delete(pid);
      }
    }
    const pids = [..._refBoardPids];
    if (pids.length === 0) {
      _logTray("no tracked PIDs to close");
      return;
    }
    for (const pid of pids) {
      try {
        process.kill(pid);
      } catch {
      }
      _refBoardPids.delete(pid);
    }
    _logTray("closed " + pids.length + " refboard(s)");
    return;
  }
  const nCmd = action === "hide" ? 6 : 9;
  _logTray(action + " all RefBoard windows by class, nCmd=" + nCmd);
  try {
    const mod = await _getRefWinMod();
    const { k, findWindowEx, showWinAsync } = mod;
    let hwnd = null;
    let count = 0;
    while (true) {
      hwnd = findWindowEx(null, hwnd, REFBOARD_CLASS, null);
      if (!hwnd) break;
      showWinAsync(hwnd, nCmd);
      count++;
    }
    _logTray("FindWindowEx loop done, found " + count + " RefBoard windows, nCmd=" + nCmd);
  } catch (e) {
    _logTray("koffi " + action + " FAILED: " + (e?.message || e));
  }
}
function createTray() {
  if (tray) return;
  const iconPath = isDev ? path.join(process.cwd(), "_internal_data", "icon.png") : path.join(__dirname, "../../../../_internal_data", "icon.png");
  try {
    const icon = electron.nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    tray = new electron.Tray(icon);
  } catch {
    tray = new electron.Tray(electron.nativeImage.createEmpty());
  }
  tray.setToolTip("PicRand");
  const ctx = electron.Menu.buildFromTemplate([
    { label: "显示 PicRand", click: () => showWindow() },
    { type: "separator" },
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
    { type: "separator" },
    { label: "退出", click: () => {
      allowClose = true;
      electron.app.quit();
    } }
  ]);
  tray.setContextMenu(ctx);
  tray.on("double-click", () => showWindow());
}
function createWindow() {
  if (mainWindow) return;
  const preloadPath = isDev ? path.join(__dirname, "../preload/index.js") : path.join(__dirname, "../preload/index.js");
  let bgColor = "#1a1a2e";
  try {
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (cfg.themeColor && cfg.themeColor !== "glass") bgColor = cfg.themeColor;
    }
  } catch {
  }
  mainWindow = new electron.BrowserWindow({
    width: 1400,
    height: 900,
    frame: false,
    show: false,
    backgroundColor: bgColor,
    title: "PicRand",
    icon: isDev ? path.join(process.cwd(), "_internal_data", "icon.png") : path.join(__dirname, "../../../../_internal_data", "icon.png"),
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, webSecurity: false }
  });
  mainWindow.once("ready-to-show", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });
  mainWindow.on("close", async (event) => {
    if (allowClose) return;
    event.preventDefault();
    mainWindow?.webContents.send("confirm-close");
  });
  if (isDev) mainWindow.loadURL("http://localhost:5173");
  else mainWindow.loadFile(path.join(__dirname, "../../dist/index.html"));
  Promise.resolve().then(() => require("./clip-search-BIoZDeWT.js")).then(({ setClipSender }) => {
    setClipSender((channel, payload) => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
      } catch {
      }
    });
  });
}
electron.ipcMain.handle("get-paths", () => ({ dataDir, cacheDir, configPath, newFoldersDir }));
electron.ipcMain.handle("steam-status", async () => {
  await initSteamStatus();
  return getSteamStatus();
});
electron.ipcMain.handle("open-steam-store", () => openSteamStore());
electron.ipcMain.handle("set-new-folders-dir", async () => {
  const result = await electron.dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
  if (result.canceled || !result.filePaths[0]) return null;
  const newPath = result.filePaths[0];
  if (fs.existsSync(newFoldersDir) && newFoldersDir !== newPath) {
    try {
      const fse = await import("fs-extra");
      const items = fs.readdirSync(newFoldersDir);
      for (const item of items) {
        const src = path.join(newFoldersDir, item);
        const dst = path.join(newPath, item);
        try {
          const s = fs.statSync(src);
          if (s.isDirectory()) {
            await fse.copy(src, dst);
          }
        } catch {
        }
      }
    } catch {
    }
  }
  newFoldersDir = newPath;
  if (!fs.existsSync(newFoldersDir)) fs.mkdirSync(newFoldersDir, { recursive: true });
  const cfg = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf-8")) : {};
  cfg.newFoldersPath = newPath;
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  return newPath;
});
electron.ipcMain.handle("read-config", () => {
  try {
    if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
  }
  return { columns: 4, picRadius: 8, picGap: 12, picShadow: "light", themeColor: "#1a1a2e", sortMode: "random", defaultSortMode: "random" };
});
electron.ipcMain.handle("perf-probe", (_event, payload) => {
  try {
    const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${JSON.stringify(payload)}
`;
    fs.appendFileSync(path.join(dataDir, "perf-probe.log"), line);
  } catch {
  }
  return true;
});
electron.ipcMain.handle("save-config", (_event, config) => {
  const merged = (() => {
    try {
      if (!fs.existsSync(configPath)) return { ...config };
      const cur = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      return { ...cur, ...config };
    } catch {
      return { ...config };
    }
  })();
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
  if (config.locale) currentLocale = config.locale;
  return true;
});
electron.ipcMain.handle("set-format-filter", (_event, exts) => {
  const list = Array.isArray(exts) ? exts.filter((e) => typeof e === "string") : null;
  setFormatFilter(list);
  try {
    const cur = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf-8")) : {};
    cur.formatFilter = list;
    fs.writeFileSync(configPath, JSON.stringify(cur, null, 2));
  } catch {
  }
  return true;
});
electron.ipcMain.handle("clear-image-cache", async () => {
  _terminatePsdPoolNow();
  await _clearSharpCache();
  _scheduleGC();
  return true;
});
function extractFeatures(rgba, w, h) {
  const feat = new Float32Array(160);
  const hBins = 32, sBins = 16, vBins = 16, totalHsv = hBins + sBins + vBins;
  let i = 0;
  for (let y = 0; y < h; y += 4) {
    for (let x = 0; x < w; x += 4) {
      const idx = (y * w + x) * 3;
      const r = rgba[idx] / 255, g = rgba[idx + 1] / 255, b = rgba[idx + 2] / 255;
      const cmax = Math.max(r, g, b), cmin = Math.min(r, g, b), delta = cmax - cmin;
      let hh = 0, s = 0;
      if (delta > 1e-3) {
        if (cmax === r) hh = (g - b) / delta % 6;
        else if (cmax === g) hh = (b - r) / delta + 2;
        else hh = (r - g) / delta + 4;
        hh = (hh < 0 ? hh + 6 : hh) / 6;
        s = delta / cmax;
      }
      feat[Math.floor(hh * hBins)]++;
      feat[hBins + Math.floor(s * sBins)]++;
      feat[hBins + sBins + Math.floor(cmax * vBins)]++;
      i++;
    }
  }
  const neighbors = [[-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1]];
  for (let y = 1; y < h - 1; y += 3) {
    for (let x = 1; x < w - 1; x += 3) {
      const ci = (y * w + x) * 3, cv = rgba[ci] + rgba[ci + 1] + rgba[ci + 2];
      let pat = 0;
      for (let n = 0; n < 8; n++) {
        const nx = x + neighbors[n][0], ny = y + neighbors[n][1];
        const ni = (ny * w + nx) * 3, nv = rgba[ni] + rgba[ni + 1] + rgba[ni + 2];
        if (nv > cv) pat |= 1 << n;
      }
      feat[totalHsv + pat % 64]++;
    }
  }
  const edgeOff = totalHsv + 64;
  for (let y = 1; y < h - 1; y += 3) {
    for (let x = 1; x < w - 1; x += 3) {
      const gx = rgba[(y * w + x + 1) * 3 + 1] - rgba[(y * w + x - 1) * 3 + 1];
      const gy = rgba[((y + 1) * w + x) * 3 + 1] - rgba[((y - 1) * w + x) * 3 + 1];
      const angle = (Math.atan2(gy, gx) + Math.PI) / (Math.PI * 2);
      feat[edgeOff + Math.floor(angle * 32)]++;
    }
  }
  for (let j = 0; j < 160; j++) {
    const sum = feat[j];
    feat[j] = sum > 0 ? sum / (i || 1) : 0;
  }
  return feat;
}
function analysisSource(filePath, thumbnailPath) {
  if (!thumbnailPath) return filePath;
  if (path.extname(filePath).toLowerCase() === ".gif") return filePath;
  const p = resolveStoredPath(thumbnailPath);
  return fs.existsSync(p) ? p : filePath;
}
async function readAnalysisPixels(sharp, filePath, thumbnailPath) {
  const src = analysisSource(filePath, thumbnailPath);
  try {
    const { data, info } = await sharp(src).resize(128, 128, { fit: "inside" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch (err) {
    if (src === filePath) throw err;
    const resolved = await resolveForSharp(filePath);
    const { data, info } = await sharp(resolved).resize(128, 128, { fit: "inside" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  }
}
async function prefetchFeatures(sharp, paths, thumbs) {
  const BATCH = 20;
  let done = 0;
  console.log("[prefetch] features starting %d images", paths.length);
  for (let i = 0; i < paths.length; i += BATCH) {
    await new Promise((resolve) => setImmediate(resolve));
    const pending = [];
    for (const p of paths.slice(i, i + BATCH)) {
      try {
        const { data, width, height } = await readAnalysisPixels(sharp, p, thumbs?.get(p));
        pending.push({ filePath: p, features: extractFeatures(data, width, height) });
        done++;
      } catch {
      }
    }
    if (pending.length) updateFeaturesBatch(pending);
    if (i % 500 === 0 && i > 0) console.log("[prefetch] features %d/%d", done, paths.length);
  }
  console.log("[prefetch] features done, %d cached", done);
}
electron.ipcMain.handle("compute-feature", async (_event, filePath) => {
  try {
    const sharp = (await import("sharp")).default;
    const { data, width, height } = await readAnalysisPixels(sharp, filePath, getThumbnailPaths([filePath]).get(filePath));
    return Array.from(extractFeatures(data, width, height));
  } catch {
    return null;
  }
});
electron.ipcMain.handle("compute-features-batch", async (_event, paths) => {
  try {
    const results = [];
    const placeholders = paths.map(() => "?").join(",");
    const cachedRows = getDb().prepare(
      `SELECT file_path, features FROM images WHERE file_path IN (${placeholders}) AND features IS NOT NULL`
    ).all(...paths);
    const cached = /* @__PURE__ */ new Map();
    for (const row of cachedRows) {
      const arr = new Float32Array(row.features.buffer, row.features.byteOffset, row.features.byteLength / 4);
      cached.set(row.file_path, Array.from(arr));
    }
    for (const p of paths) {
      if (cached.has(p)) results.push({ file_path: p, features: cached.get(p) });
    }
    const missing = paths.filter((p) => !cached.has(p));
    if (missing.length > 0) {
      const sharp = (await import("sharp")).default;
      const thumbs = getThumbnailPaths(missing);
      const lim = 24;
      const pending = [];
      for (let i = 0; i < missing.length; i += lim) {
        const batch = missing.slice(i, i + lim);
        const feats = await Promise.all(batch.map(async (p) => {
          try {
            const { data, width, height } = await readAnalysisPixels(sharp, p, thumbs.get(p));
            const feat = extractFeatures(data, width, height);
            pending.push({ filePath: p, features: feat });
            return { file_path: p, features: Array.from(feat) };
          } catch {
            return { file_path: p, features: null };
          }
        }));
        results.push(...feats);
      }
      if (pending.length) updateFeaturesBatch(pending);
    }
    return results;
  } catch {
    return [];
  }
});
electron.ipcMain.handle("get-clip-features-by-paths", async (_event, paths) => {
  try {
    if (!paths.length) return [];
    const rows = getClipFeaturesByPaths(paths);
    return rows.map((r) => ({
      file_path: r.file_path,
      features: r.clip_feat ? Array.from(new Float32Array(r.clip_feat.buffer, r.clip_feat.byteOffset, r.clip_feat.byteLength / 4)) : null
    }));
  } catch {
    return [];
  }
});
electron.ipcMain.handle("prefetch-features", async (_event, folderId) => {
  const paths = getFeaturesByFolder(folderId).filter((r) => !r.features).map((r) => r.file_path);
  if (!paths.length) return;
  try {
    const sharp = (await import("sharp")).default;
    await prefetchFeatures(sharp, paths, getThumbnailPaths(paths));
  } catch {
  }
});
electron.ipcMain.handle("get-all-features", () => {
  return getAllFeatures().map((r) => ({
    file_path: r.file_path,
    features: r.features ? Array.from(new Float32Array(r.features.buffer, r.features.byteOffset, r.features.byteLength / 4)) : null
  }));
});
electron.ipcMain.handle("compute-clip-feature", async (_event, filePath) => {
  try {
    const { computeImageVec } = await Promise.resolve().then(() => require("./clip-search-BIoZDeWT.js"));
    const resolved = await resolveForSharp(filePath);
    const vec = await computeImageVec(resolved);
    return Array.from(vec);
  } catch {
    return null;
  }
});
electron.ipcMain.handle("compute-clip-batch", async (_event, paths) => {
  try {
    const { computeImageVec } = await Promise.resolve().then(() => require("./clip-search-BIoZDeWT.js"));
    const placeholder = paths.map(() => "?").join(",");
    const cachedRows = getDb().prepare(
      `SELECT file_path, clip_feat FROM images WHERE file_path IN (${placeholder}) AND clip_feat IS NOT NULL`
    ).all(...paths);
    const cached = new Set(cachedRows.map((r) => r.file_path));
    const missing = paths.filter((p) => !cached.has(p));
    if (missing.length > 0) {
      const lim = 4;
      for (let i = 0; i < missing.length; i += lim) {
        const batch = missing.slice(i, i + lim);
        await Promise.all(batch.map(async (p) => {
          try {
            const resolved = await resolveForSharp(p);
            const vec = await computeImageVec(resolved);
            updateClipFeature(p, vec);
          } catch {
          }
        }));
      }
    }
    return { ok: true, missing: missing.length, cached: cached.size };
  } catch (err) {
    console.error("[clip-batch] error:", err);
    return { ok: false, error: String(err) };
  }
});
electron.ipcMain.handle("build-clip-index", async (_event, folderId, force) => {
  let firstError = "";
  try {
    if (force) {
      try {
        getDb().prepare(`UPDATE images SET clip_feat = NULL WHERE folder_id = ?`).run(folderId);
      } catch {
      }
    }
    const rows = getClipFeaturesByFolder(folderId);
    const missing = rows.filter((r) => !r.clip_feat).map((r) => r.file_path);
    const total = missing.length;
    const sendP = (d, t) => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("clip-index-progress", { done: d, total: t });
      } catch {
      }
    };
    if (total === 0) {
      sendP(0, 0);
      return { ok: true, total: 0, done: 0 };
    }
    sendP(0, total);
    await new Promise((r) => setImmediate(r));
    const { computeImageVec } = await Promise.resolve().then(() => require("./clip-search-BIoZDeWT.js"));
    let done = 0;
    const CONCUR = Math.max(4, Math.min(8, (await import("os")).cpus().length * 2));
    for (let i = 0; i < missing.length; i += CONCUR) {
      const batch = missing.slice(i, i + CONCUR);
      const results = await Promise.all(batch.map(async (p) => {
        try {
          const resolved = await resolveForSharp(p);
          const vec = await computeImageVec(resolved);
          return { filePath: p, vec };
        } catch (e) {
          return { filePath: p, vec: null, error: String(e?.message || e) };
        }
      }));
      let batchErr = false;
      for (const r of results) {
        done++;
        if (r.vec) {
          updateClipFeature(r.filePath, r.vec);
        } else {
          if (!firstError) {
            firstError = r.error || "unknown";
            batchErr = true;
          }
        }
      }
      sendP(done, total);
      if (!batchErr) await new Promise((r) => setImmediate(r));
    }
    sendP(total, total);
    const allOk = done === total && !firstError;
    return allOk ? { ok: true, total, done } : { ok: false, total, done, error: firstError };
  } catch (err) {
    const msg = String(err?.message || err);
    console.error("[build-clip-index]", msg);
    return { ok: false, total: 0, done: 0, error: msg };
  }
});
electron.ipcMain.handle("search-by-text", async (_event, query, scope, topN) => {
  try {
    const { searchByText } = await Promise.resolve().then(() => require("./clip-search-BIoZDeWT.js"));
    let rows = [];
    if (scope?.folderIds && scope.folderIds.length > 0) rows = getRootClipFeatures(scope.folderIds);
    else if (scope?.folderId) rows = getClipFeaturesByFolder(scope.folderId);
    else rows = getAllClipFeatures();
    rows = rows.filter((r) => isFormatAllowed(r.file_path));
    const results = await searchByText(query, rows, topN ?? 500);
    return results;
  } catch (err) {
    console.error("[search-by-text] error:", err);
    return { error: String(err?.message || err) };
  }
});
electron.ipcMain.handle("clip-index-status", async (_event, folderId) => {
  try {
    return countClipFeaturesByFolder(folderId);
  } catch {
    return { total: 0, indexed: 0 };
  }
});
electron.ipcMain.handle("build-clip-index-multi", async (_event, folderIds, force) => {
  let firstError = "";
  try {
    const ids = Array.isArray(folderIds) ? folderIds.filter((x) => x > 0) : [];
    if (!ids.length) return { ok: false, total: 0, done: 0, error: "no folders" };
    if (force) {
      try {
        const placeholders = ids.map(() => "?").join(",");
        getDb().prepare(`UPDATE images SET clip_feat = NULL WHERE folder_id IN (${placeholders})`).run(...ids);
      } catch {
      }
    }
    const rows = getRootClipFeatures(ids);
    const missing = rows.filter((r) => !r.clip_feat).map((r) => r.file_path);
    const total = missing.length;
    const sendP = (d, t) => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("clip-index-progress", { done: d, total: t });
      } catch {
      }
    };
    if (total === 0) {
      sendP(0, 0);
      return { ok: true, total: 0, done: 0 };
    }
    sendP(0, total);
    await new Promise((r) => setImmediate(r));
    const { computeImageVec } = await Promise.resolve().then(() => require("./clip-search-BIoZDeWT.js"));
    let done = 0;
    const CONCUR = Math.max(4, Math.min(8, (await import("os")).cpus().length * 2));
    for (let i = 0; i < missing.length; i += CONCUR) {
      const batch = missing.slice(i, i + CONCUR);
      const results = await Promise.all(batch.map(async (p) => {
        try {
          const resolved = await resolveForSharp(p);
          return { filePath: p, vec: await computeImageVec(resolved) };
        } catch (e) {
          return { filePath: p, vec: null, error: String(e?.message || e) };
        }
      }));
      let batchErr = false;
      for (const r of results) {
        done++;
        if (r.vec) updateClipFeature(r.filePath, r.vec);
        else if (!firstError) {
          firstError = r.error || "unknown";
          batchErr = true;
        }
      }
      sendP(done, total);
      if (!batchErr) await new Promise((r) => setImmediate(r));
    }
    sendP(total, total);
    const allOk = done === total && !firstError;
    return allOk ? { ok: true, total, done } : { ok: false, total, done, error: firstError };
  } catch (err) {
    const msg = String(err?.message || err);
    console.error("[build-clip-index-multi]", msg);
    return { ok: false, total: 0, done: 0, error: msg };
  }
});
electron.ipcMain.handle("clip-index-status-multi", async (_event, folderIds) => {
  try {
    return countClipFeaturesByFolders(Array.isArray(folderIds) ? folderIds : []);
  } catch {
    return { total: 0, indexed: 0 };
  }
});
async function _computeColorInfo(filePath) {
  try {
    const sharp = (await import("sharp")).default;
    const resolved = await resolveForSharp(filePath);
    const { data, info } = await sharp(resolved).removeAlpha().resize(128, 128, { fit: "inside" }).toColorspace("srgb").raw({ depth: "uchar" }).toBuffer({ resolveWithObject: true });
    const { width, height } = info;
    const count = width * height;
    if (!count) return null;
    let hueSum = 0, satSum = 0, valSum = 0;
    for (let i = 0; i < data.length; i += 3) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const val = max / 255;
      const sat = max === 0 ? 0 : (max - min) / max;
      let hue = 0;
      if (max !== min) {
        if (max === r) hue = ((g - b) / (max - min) + 6) % 6;
        else if (max === g) hue = (b - r) / (max - min) + 2;
        else hue = (r - g) / (max - min) + 4;
        hue *= 60;
      }
      hueSum += hue;
      satSum += sat;
      valSum += val;
    }
    return {
      h: Math.round(hueSum / count * 10) / 10,
      s: Math.round(satSum / count * 100) / 100,
      v: Math.round(valSum / count * 100) / 100
    };
  } catch {
    return null;
  }
}
electron.ipcMain.handle("build-color-index", async (_event, folderId, force) => {
  let firstError = "";
  try {
    const rows = getColorInfoByFolder(folderId);
    const missing = (force ? rows : rows.filter((r) => !r.color_info)).map((r) => r.file_path);
    if (force) {
      try {
        getDb().prepare(`UPDATE images SET color_info = NULL WHERE folder_id = ?`).run(folderId);
      } catch {
      }
    }
    const total = missing.length;
    const sendP = (d, t) => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("color-index-progress", { done: d, total: t });
      } catch {
      }
    };
    if (total === 0) {
      sendP(0, 0);
      return { ok: true, total: 0, done: 0 };
    }
    sendP(0, total);
    let done = 0;
    for (const fp of missing) {
      const info = await _computeColorInfo(fp);
      done++;
      if (info) {
        updateColorInfo(fp, info);
      } else {
        if (!firstError) firstError = `failed: ${fp.slice(-40)}`;
      }
      if (done % 10 === 0) sendP(done, total);
    }
    sendP(total, total);
    const allOk = done === total && !firstError;
    return allOk ? { ok: true, total, done } : { ok: false, total, done, error: firstError };
  } catch (err) {
    console.error("[build-color-index]", err);
    return { ok: false, total: 0, done: 0, error: String(err?.message || err) };
  }
});
electron.ipcMain.handle("build-color-index-multi", async (_event, folderIds) => {
  let firstError = "";
  try {
    const ids = Array.isArray(folderIds) ? folderIds.filter((x) => x > 0) : [];
    if (!ids.length) return { ok: false, total: 0, done: 0, error: "no folders" };
    const allRows = [];
    for (const id of ids) allRows.push(...getColorInfoByFolder(id));
    const missing = allRows.filter((r) => !r.color_info).map((r) => r.file_path);
    const total = missing.length;
    const sendP = (d, t) => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("color-index-progress", { done: d, total: t });
      } catch {
      }
    };
    if (total === 0) {
      sendP(0, 0);
      return { ok: true, total: 0, done: 0 };
    }
    sendP(0, total);
    let done = 0;
    for (const fp of missing) {
      const info = await _computeColorInfo(fp);
      done++;
      if (info) {
        updateColorInfo(fp, info);
      } else {
        if (!firstError) firstError = `failed: ${fp.slice(-40)}`;
      }
      if (done % 10 === 0) sendP(done, total);
    }
    sendP(total, total);
    const allOk = done === total && !firstError;
    return allOk ? { ok: true, total, done } : { ok: false, total, done, error: firstError };
  } catch (err) {
    return { ok: false, total: 0, done: 0, error: String(err?.message || err) };
  }
});
electron.ipcMain.handle("color-index-status", async (_event, folderId) => {
  try {
    return countColorInfoByFolder(folderId);
  } catch {
    return { total: 0, indexed: 0 };
  }
});
electron.ipcMain.handle("color-index-status-multi", async (_event, folderIds) => {
  try {
    return countColorInfoByFolders(Array.isArray(folderIds) ? folderIds : []);
  } catch {
    return { total: 0, indexed: 0 };
  }
});
electron.ipcMain.handle("get-color-info-by-paths", async (_event, paths) => {
  try {
    return getColorInfoByPaths(Array.isArray(paths) ? paths : []);
  } catch {
    return [];
  }
});
const OVERSIZE_LIMIT = 5e4;
const OVERSIZE_TIMEOUT_MS = 8e3;
let _ovWorkerPath = "";
async function _ensureOversizeWorkerPath() {
  if (_ovWorkerPath) try {
    if (require("fs").existsSync(_ovWorkerPath)) return _ovWorkerPath;
  } catch {
  }
  const pth = await import("path");
  const os2 = await import("os");
  const content = `const { parentPort, workerData } = require('worker_threads')
const fs = require('fs')
const path = require('path')
const exts = new Set(['.jpg','.jpeg','.png','.gif','.bmp','.webp','.tiff','.tif','.avif','.svg','.psd','.heic','.heif','.mp4','.webm','.mov','.mkv','.avi','.flv','.f4v'])
let count = 0
const stack = [workerData.dir]
while (stack.length) {
  const cur = stack.pop()
  let entries
  try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
  for (const entry of entries) {
    if (entry.isDirectory()) { stack.push(path.join(cur, entry.name)); continue }
    if (entry.isFile() && exts.has(path.extname(entry.name).toLowerCase())) { count++; if (count >= workerData.limit) { parentPort.postMessage(true); return } }
  }
}
parentPort.postMessage(false)
`;
  const candidates = [
    pth.join(__dirname, "oversize-worker.cjs"),
    pth.join(os2.tmpdir(), "picrand-oversize-worker.cjs")
  ];
  for (const c of candidates) {
    try {
      const _fsw = require("fs");
      _fsw.writeFileSync(c, content);
      _ovWorkerPath = c;
      return c;
    } catch {
    }
  }
  return _ovWorkerPath;
}
async function checkFolderOversize(dir) {
  const { Worker } = await import("worker_threads");
  let workerPath = await _ensureOversizeWorkerPath();
  if (!workerPath || !require("fs").existsSync(workerPath)) {
    try {
      workerPath = await _ensureOversizeWorkerPath();
    } catch {
    }
  }
  if (!workerPath || !require("fs").existsSync(workerPath)) {
    return false;
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (v, tag) => {
      if (done) return;
      done = true;
      try {
        worker.terminate();
      } catch {
      }
      clearTimeout(timer);
      resolve(v);
    };
    const worker = new Worker(workerPath, { workerData: { dir, limit: OVERSIZE_LIMIT } });
    const timer = setTimeout(() => finish(true), OVERSIZE_TIMEOUT_MS);
    worker.once("message", (limited) => finish(!!limited));
    worker.once("error", (e) => {
      finish(true);
    });
  });
}
let _oversizeResolver = null;
async function confirmOversizeDialog() {
  return new Promise((resolve) => {
    _oversizeResolver = resolve;
    try {
      mainWindow?.webContents.send("confirm-oversize");
    } catch {
      resolve(false);
    }
  });
}
electron.ipcMain.on("confirm-oversize-response", (_event, confirmed) => {
  if (_oversizeResolver) {
    _oversizeResolver(confirmed);
    _oversizeResolver = null;
  }
});
let _scanWorkerPath = "";
async function _ensureScanWorkerPath() {
  if (_scanWorkerPath && require("fs").existsSync(_scanWorkerPath)) return _scanWorkerPath;
  const pth = await import("path");
  const os2 = await import("os");
  const content = `const fs = require('fs')
const path = require('path')
const { parentPort, workerData } = require('worker_threads')
const exts = new Set(['.jpg','.jpeg','.png','.gif','.bmp','.webp','.tiff','.tif','.avif','.svg','.psd','.heic','.heif','.mp4','.webm','.mov','.mkv','.avi','.flv','.f4v'])
const result = []
function walk(dir) {
  let items
  try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of items) {
    if (entry.isDirectory()) { walk(path.join(dir, entry.name)); continue }
    if (entry.isFile() && exts.has(path.extname(entry.name).toLowerCase())) {
      let s
      try { s = fs.statSync(path.join(dir, entry.name)) } catch { continue }
      result.push({ path: path.join(dir, entry.name), size: s.size, mtimeMs: s.mtimeMs })
    }
  }
}
walk(workerData.dir)
parentPort.postMessage(result)
`;
  const candidates = [pth.join(__dirname, "scan-worker.cjs"), pth.join(os2.tmpdir(), "picrand-scan-worker.cjs")];
  for (const c of candidates) {
    try {
      const _fsw = require("fs");
      _fsw.writeFileSync(c, content);
      _scanWorkerPath = c;
      return c;
    } catch {
    }
  }
  return _scanWorkerPath;
}
async function _scanFolderWorker(dir, opts) {
  try {
    const { Worker } = await import("worker_threads");
    const wp = await _ensureScanWorkerPath();
    if (!wp || !require("fs").existsSync(wp)) return null;
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        try {
          worker.terminate();
        } catch {
        }
        ;
        clearTimeout(timer);
        resolve(v);
      };
      const worker = new Worker(wp, { workerData: { dir } });
      if (opts?.onWorker) opts.onWorker(worker);
      const timer = setTimeout(() => finish(null), 12e4);
      worker.once("message", (r) => finish(r));
      worker.once("error", () => finish(null));
      worker.once("exit", () => finish(null));
    });
  } catch {
    return null;
  }
}
electron.ipcMain.handle("scan-folder", async (_event, folderPath, sortMode, forceShuffle, hueOrigin) => {
  _scanGen++;
  const myGen = _scanGen;
  _killScanVpFfmpegs();
  _logChildProbes(`scan-enter folder=${folderPath.slice(-40)}`);
  if (_activeScanWorker) {
    try {
      _activeScanWorker.terminate();
    } catch {
    }
    _activeScanWorker = null;
  }
  const _stale = () => _scanGen !== myGen;
  let _sharp;
  try {
    const _tTotal = Date.now();
    const scanResult = await _scanFolderWorker(folderPath, { onWorker: (w) => {
      _activeScanWorker = w;
    } }) || [];
    _activeScanWorker = null;
    if (_stale()) {
      console.log("[scan] aborted after walk:", folderPath.slice(0, 80));
      return { error: true, message: "Scan superseded" };
    }
    const entries = scanResult;
    console.log("[scan] found %d images in %s", entries.length, folderPath);
    const folderId = getOrCreateFolder(folderPath);
    const allImages = entries.map((e, i) => ({
      file_path: e.path,
      file_name: path.basename(e.path),
      file_size: e.size || 0,
      modify_time: e.mtimeMs ? Math.floor(e.mtimeMs / 1e3) : 0,
      sort_order: i
    }));
    console.log("[scan] found %d images in %s, folderId=%d", allImages.length, folderPath, folderId);
    if (_stale()) {
      console.log("[scan] aborted before db ops:", folderPath.slice(0, 80));
      return { error: true, message: "Scan superseded" };
    }
    const _tSaveAll = Date.now();
    const scannedPaths = new Set(allImages.map((img) => img.file_path));
    const dbRows = getDb().prepare("SELECT file_path FROM images WHERE folder_id = ?").all(folderId);
    const dbPathSet = new Set(dbRows.map((r) => r.file_path));
    const added = [];
    const movedFromOther = [];
    for (const img of allImages) {
      if (!dbPathSet.has(img.file_path)) {
        added.push(img);
        const existRow = getDb().prepare("SELECT folder_id FROM images WHERE file_path = ?").get(img.file_path);
        if (existRow && existRow.folder_id !== folderId) movedFromOther.push(img.file_path);
      }
    }
    const removed = [];
    for (const dp of dbPathSet) {
      if (!scannedPaths.has(dp)) removed.push(dp);
    }
    if (_stale()) {
      console.log("[scan] aborted during diff:", folderPath.slice(0, 80));
      return { error: true, message: "Scan superseded" };
    }
    if (movedFromOther.length > 0) {
      const moveStmt = getDb().prepare("UPDATE images SET folder_id = ? WHERE file_path = ?");
      getDb().transaction(() => {
        for (const fp of movedFromOther) {
          try {
            moveStmt.run(folderId, fp);
          } catch {
          }
        }
      })();
    }
    if (added.length > 0) {
      try {
        insertImagesBatch(folderId, added);
        console.log("[scan] insertImagesBatch done, added=%d", added.length);
      } catch (e) {
        console.error("[scan] insertImagesBatch failed:", e);
      }
    }
    if (removed.length > 0) {
      const delStmt = getDb().prepare("DELETE FROM images WHERE file_path = ?");
      const COOP_YIELD = 200;
      let _delIdx = 0;
      while (_delIdx < removed.length) {
        const end = Math.min(_delIdx + COOP_YIELD, removed.length);
        for (let i = _delIdx; i < end; i++) {
          try {
            delStmt.run(removed[i]);
          } catch {
          }
        }
        _delIdx = end;
        if (_stale()) {
          console.log("[scan] aborted during removed cleanup:", folderPath.slice(0, 80));
          return { error: true, message: "Scan superseded" };
        }
        await new Promise((r) => setImmediate(r));
      }
    }
    const _tSaveAllMs = Date.now() - _tSaveAll;
    const _tSyncRestoreMs = 0;
    if (_stale()) {
      console.log("[scan] aborted before dim read:", folderPath.slice(0, 80));
      return { error: true, message: "Scan superseded" };
    }
    const DIM_FIRST_BATCH = 300;
    try {
      const firstBatch = allImages.slice(0, DIM_FIRST_BATCH);
      const addedPathSet = new Set(added.map((a) => a.file_path));
      _sharp = (await import("sharp")).default;
      let _dimCheck = 0;
      let cursor = 0;
      const _runOne = async (img) => {
        if (_stale()) return;
        try {
          const d = await readImageDimensions(img.file_path, _sharp);
          if (d) updateImageDimensions(img.file_path, d.width, d.height);
        } catch {
        }
      };
      const CONCURRENCY = 3;
      const workers = [];
      for (let w = 0; w < CONCURRENCY; w++) {
        workers.push((async () => {
          while (true) {
            const myIdx = cursor++;
            if (myIdx >= firstBatch.length) break;
            if (++_dimCheck % 20 === 0 && _stale()) {
              console.log("[scan] aborted during dim read:", folderPath.slice(0, 80));
              return;
            }
            if (!addedPathSet.has(firstBatch[myIdx].file_path)) continue;
            await _runOne(firstBatch[myIdx]);
          }
        })());
      }
      await Promise.all(workers);
      if (_stale()) {
        console.log("[scan] aborted during dim read:", folderPath.slice(0, 80));
        return { error: true, message: "Scan superseded" };
      }
      const remaining = allImages.slice(DIM_FIRST_BATCH);
      if (remaining.length > 0) {
        const bgGen = myGen;
        const bgPromise = (async () => {
          let _bgCheck = 0;
          for (const img of remaining) {
            if (++_bgCheck % 10 === 0 && _scanGen !== bgGen) return;
            if (!addedPathSet.has(img.file_path)) continue;
            try {
              const d = await readImageDimensions(img.file_path);
              if (d) updateImageDimensions(img.file_path, d.width, d.height);
            } catch {
            }
          }
        })();
        pendingDimReads.set(folderId, bgPromise);
        bgPromise.then(() => pendingDimReads.delete(folderId));
      }
    } catch {
    }
    const finalSortMode = sortMode || "random";
    const _isDimSort = finalSortMode === "dim-asc" || finalSortMode === "dim-desc";
    if (_stale()) {
      console.log("[scan] aborted before recompute sort:", folderPath.slice(0, 80));
      return { error: true, message: "Scan superseded" };
    }
    if (!_isDimSort) {
      const prevSort = getFolderStoredSortMode(folderId);
      const needsFullRecompute = forceShuffle || prevSort !== finalSortMode || prevSort === "random" && finalSortMode === "random" && added.length > 0;
      if (needsFullRecompute) {
        recomputeSortOrder(folderId, finalSortMode, forceShuffle ?? true, hueOrigin ?? 0);
      } else if (added.length > 0) {
        const maxSo = getDb().prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM images WHERE folder_id = ?").get(folderId)?.m ?? -1;
        const upd = getDb().prepare("UPDATE images SET sort_order = ? WHERE file_path = ?");
        for (let ai = 0; ai < added.length; ai++) {
          upd.run(maxSo + 1 + ai, added[ai].file_path);
        }
        const storage = require("./database");
        if (storage._folderSortMode) storage._folderSortMode.set(folderId, finalSortMode);
        console.log("[scan] assign sort_order to %d new images (skip full recompute)", added.length);
      }
    }
    invalidateStatsCache(folderId);
    const firstPage = getImagesPage(folderId, 0, 100, finalSortMode);
    let _fpCheck = 0;
    for (const img of firstPage) {
      if (!img.thumbnail_path) img.thumbnail_path = discoverThumbnailPath(img.file_path);
    }
    const _needDim = firstPage.filter((img) => !img.width || !img.height);
    let _fpCursor = 0;
    const _fpRun = async (ent) => {
      if (_stale()) return;
      try {
        const d = await readImageDimensions(ent.file_path, _sharp);
        if (d) {
          ent.width = d.width;
          ent.height = d.height;
        }
      } catch {
      }
    };
    const _fpWorkers = [];
    for (let w = 0; w < 8 && w < _needDim.length; w++) {
      _fpWorkers.push((async () => {
        while (true) {
          if (_stale()) {
            console.log("[scan] aborted during first-page dim:", folderPath.slice(0, 80));
            return;
          }
          const myIdx = _fpCursor++;
          if (myIdx >= _needDim.length) break;
          if (++_fpCheck % 20 === 0 && _stale()) {
            console.log("[scan] aborted during first-page dim:", folderPath.slice(0, 80));
            return;
          }
          await _fpRun(_needDim[myIdx]);
        }
      })());
    }
    await Promise.all(_fpWorkers);
    if (_stale()) {
      console.log("[scan] aborted during first-page dim:", folderPath.slice(0, 80));
      return { error: true, message: "Scan superseded" };
    }
    if (_stale()) {
      console.log("[scan] aborted before video poster bg:", folderPath.slice(0, 80));
      return { error: true, message: "Scan superseded" };
    }
    const _vidAll = allImages.filter((img) => isVideoExt(path.extname(img.file_path).toLowerCase()) && !img.thumbnail_path);
    if (_vidAll.length) {
      const _vpGen = myGen;
      (async () => {
        let _vpCursor = 0;
        const _vpRun = async (ent) => {
          if (_scanGen !== _vpGen) return;
          await _cpuAcquire();
          try {
            if (_scanGen !== _vpGen) return;
            const poster = await getOrGeneratePoster(ent.file_path, (p) => {
              if (_scanGen === _vpGen) {
                _scanVpFfmpegs.add(p);
                p.on("exit", () => _scanVpFfmpegs.delete(p));
              } else {
                try {
                  p.kill();
                } catch {
                }
              }
            });
            if (poster && fs.existsSync(poster)) {
              ent.thumbnail_path = poster;
              try {
                updateThumbnailPath(ent.file_path, poster);
              } catch {
              }
              if (_scanGen === _vpGen && mainWindow && !mainWindow.isDestroyed()) {
                try {
                  mainWindow.webContents.send("sync-db", { type: "thumb-update", file_path: ent.file_path, thumbnail_path: poster });
                } catch {
                }
              }
            }
          } catch {
          } finally {
            _cpuRelease();
          }
        };
        while (_scanGen === _vpGen) {
          const myIdx = _vpCursor++;
          if (myIdx >= _vidAll.length) break;
          await _vpRun(_vidAll[myIdx]);
        }
      })();
    }
    if (!getFolderStoredCover(folderId) && allImages.length > 0) {
      updateFolderCover(folderId, allImages[0].file_path);
    }
    const _tTotalMs = Date.now() - _tTotal;
    try {
      const fs2 = require("fs");
      const path2 = require("path");
      const os2 = require("os");
      fs2.appendFileSync(path2.join(dataDir, "scan-timing.log"), "[" + (/* @__PURE__ */ new Date()).toISOString() + "] folder=" + folderPath + " save=" + _tSaveAllMs + "ms restore_sync=" + _tSyncRestoreMs + "ms total=" + _tTotalMs + "ms" + os2.EOL);
    } catch {
    }
    console.log("[scan] returning firstPage=%d total=%d (bg prefetch queued for %d)", firstPage.length, allImages.length, Math.max(0, allImages.length - 100));
    _logChildProbes(`scan-return folder=${folderPath.slice(-40)}`);
    return { images: firstPage, total: allImages.length, folderId };
  } catch (err) {
    if (_stale()) {
      console.log("[scan] aborted (superseded):", folderPath.slice(0, 80));
      return { error: true, message: "Scan superseded" };
    }
    console.error("scan-folder:", err);
    return { error: true, message: err?.message || "路径无法访问或权限不足" };
  }
});
electron.ipcMain.handle("sync-folder-snapshot", async (_event, folderPath) => {
  try {
    _scanGen++;
    const myGen = _scanGen;
    const _stale = () => _scanGen !== myGen;
    if (_activeScanWorker) {
      try {
        _activeScanWorker.terminate();
      } catch {
      }
      _activeScanWorker = null;
    }
    const walkResult = await _scanFolderWorker(folderPath, { onWorker: (w) => {
      _activeScanWorker = w;
    } });
    _activeScanWorker = null;
    if (_stale() || !walkResult) return { ok: false };
    const currentPaths = new Set(walkResult.map((e) => e.path));
    const folderId = getOrCreateFolder(folderPath);
    const dbRows = getDb().prepare("SELECT file_path FROM images WHERE folder_id = ?").all(folderId);
    const dbPathSet = new Set(dbRows.map((r) => r.file_path));
    const added = [];
    for (const cp of currentPaths) {
      if (!dbPathSet.has(cp)) {
        added.push(cp);
      }
    }
    const removed = [];
    for (const dp of dbPathSet) {
      if (!currentPaths.has(dp)) {
        removed.push(dp);
      }
    }
    if (_stale()) return { ok: false };
    if (added.length > 0) {
      const addedWithInfo = [];
      for (const ap of added) {
        try {
          const s = fs.statSync(ap);
          addedWithInfo.push({
            file_path: ap,
            file_name: path.basename(ap),
            file_size: s.size,
            modify_time: Math.floor(s.mtimeMs / 1e3),
            sort_order: 0
          });
        } catch {
        }
      }
      if (addedWithInfo.length > 0 && !_stale()) {
        insertImagesBatch(folderId, addedWithInfo);
        for (const ai of addedWithInfo) {
          if (isFormatAllowed(ai.file_path) && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("sync-db", { type: "add", image: { file_path: ai.file_path, file_name: ai.file_name, file_size: ai.file_size, modify_time: ai.modify_time, thumbnail_path: "", width: 0, height: 0, is_favorite: 0 } });
          }
        }
      }
    }
    if (removed.length > 0 && !_stale()) {
      const delStmt = getDb().prepare("DELETE FROM images WHERE file_path = ?");
      for (const rp of removed) {
        try {
          delStmt.run(rp);
        } catch {
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("sync-db", { type: "unlink", path: rp });
        }
      }
    }
    return { ok: true, added: added.length, removed: removed.length };
  } catch (e) {
    console.error("[sync-folder-snapshot] error:", e?.message || e);
    return { ok: false };
  }
});
electron.ipcMain.handle("get-images-page", async (_event, folderId, offset, limit, sortMode) => {
  console.log("[db] get-images-page folderId=%d offset=%d limit=%d", folderId, offset, limit);
  const page = getImagesPage(folderId, offset, limit, sortMode);
  console.log("[db] get-images-page returned %d rows", page?.length || 0);
  const valid = [];
  for (const img of page) {
    if (img.thumbnail_path && !fs.existsSync(img.thumbnail_path)) {
      img.thumbnail_path = "";
    }
    if (!img.thumbnail_path) {
      img.thumbnail_path = discoverThumbnailPath(img.file_path);
    }
    if (!fs.existsSync(img.file_path)) {
      deleteImageByPath(img.file_path);
      continue;
    }
    valid.push(img);
  }
  try {
    const needDim = valid.filter((img) => !img.width || !img.height);
    let cursor = 0;
    const runOne = async () => {
      while (true) {
        const i = cursor++;
        if (i >= needDim.length) break;
        const img = needDim[i];
        try {
          const d = await readImageDimensions(img.file_path);
          if (d) {
            img.width = d.width;
            img.height = d.height;
            updateImageDimensions(img.file_path, d.width, d.height);
          }
        } catch {
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, needDim.length) }, () => runOne()));
  } catch {
  }
  return valid;
});
electron.ipcMain.handle("get-images-count", (_event, folderId) => {
  return getImagesCount(folderId);
});
electron.ipcMain.handle("search-images", async (_event, folderId, query, offset, limit) => {
  if (!query.trim()) return [];
  const rows = searchImages(folderId, query.trim(), offset, limit);
  const fse = await import("fs-extra");
  const valid = [];
  for (const img of rows) {
    const exists = await fse.pathExists(img.file_path).catch(() => false);
    if (!exists) continue;
    if (!img.thumbnail_path) {
      img.thumbnail_path = discoverThumbnailPath(img.file_path);
    }
    valid.push(img);
  }
  try {
    const needDim = valid.filter((img) => !img.width || !img.height);
    let cursor = 0;
    const runOne = async () => {
      while (true) {
        const i = cursor++;
        if (i >= needDim.length) break;
        const img = needDim[i];
        try {
          const d = await readImageDimensions(img.file_path);
          if (d) {
            img.width = d.width;
            img.height = d.height;
            updateImageDimensions(img.file_path, d.width, d.height);
          }
        } catch {
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, needDim.length) }, () => runOne()));
  } catch {
  }
  return valid;
});
electron.ipcMain.handle("search-images-count", (_event, folderId, query) => {
  return searchImagesCount(folderId, query.trim());
});
electron.ipcMain.handle("search-by-description", async (_event, folderId, query, offset, limit) => {
  if (!query.trim()) return [];
  const rows = searchByDescription(folderId, query.trim(), offset, limit);
  const fse = await import("fs-extra");
  const valid = [];
  for (const img of rows) {
    const exists = await fse.pathExists(img.file_path).catch(() => false);
    if (!exists) continue;
    if (!img.thumbnail_path) {
      img.thumbnail_path = discoverThumbnailPath(img.file_path);
    }
    valid.push(img);
  }
  try {
    for (const img of valid) {
      if (!img.width || !img.height) {
        try {
          const d = await readImageDimensions(img.file_path);
          if (d) {
            img.width = d.width;
            img.height = d.height;
            updateImageDimensions(img.file_path, d.width, d.height);
          }
        } catch {
        }
      }
    }
  } catch {
  }
  return valid;
});
electron.ipcMain.handle("search-by-description-count", (_event, folderId, query) => {
  return searchByDescriptionCount(folderId, query.trim());
});
electron.ipcMain.handle("search-by-rating", async (_event, folderId, ratings, offset, limit) => {
  const rows = searchByRating(folderId, ratings, offset, limit);
  const fse = await import("fs-extra");
  const valid = [];
  for (const img of rows) {
    const exists = await fse.pathExists(img.file_path).catch(() => false);
    if (!exists) continue;
    if (!img.thumbnail_path) {
      img.thumbnail_path = discoverThumbnailPath(img.file_path);
    }
    valid.push(img);
  }
  try {
    await _fillRowsDims(valid);
  } catch {
  }
  return valid;
});
electron.ipcMain.handle("search-by-rating-count", (_event, folderId, ratings) => {
  return searchByRatingCount(folderId, ratings);
});
electron.ipcMain.handle("search-by-aspect-ratio", async (_event, folderId, ratioW, ratioH, tolerance, offset, limit) => {
  const rows = searchByAspectRatio(folderId, ratioW, ratioH, tolerance, offset, limit);
  const fse = await import("fs-extra");
  const valid = [];
  for (const img of rows) {
    const exists = await fse.pathExists(img.file_path).catch(() => false);
    if (!exists) continue;
    if (!img.thumbnail_path) {
      img.thumbnail_path = discoverThumbnailPath(img.file_path);
    }
    valid.push(img);
  }
  return valid;
});
electron.ipcMain.handle("search-by-aspect-ratio-count", (_event, folderId, ratioW, ratioH, tolerance) => {
  return searchByAspectRatioCount(folderId, ratioW, ratioH, tolerance);
});
async function _prepareMultiSearchRows(rows, fillDims = true) {
  const fse = await import("fs-extra");
  const valid = [];
  for (const img of rows) {
    const exists = await fse.pathExists(img.file_path).catch(() => false);
    if (!exists) continue;
    if (!img.thumbnail_path) img.thumbnail_path = discoverThumbnailPath(img.file_path);
    valid.push(img);
  }
  if (fillDims) {
    try {
      await _fillRowsDims(valid);
    } catch {
    }
  }
  return valid;
}
electron.ipcMain.handle("search-images-multi", async (_event, folderIds, query, offset, limit, sortMode) => {
  if (!query.trim()) return [];
  return _prepareMultiSearchRows(searchImagesMulti(folderIds, query.trim(), offset, limit, sortMode), true);
});
electron.ipcMain.handle("search-images-count-multi", (_event, folderIds, query) => {
  return searchImagesCountMulti(folderIds, query.trim());
});
electron.ipcMain.handle("search-by-description-multi", async (_event, folderIds, query, offset, limit, sortMode) => {
  if (!query.trim()) return [];
  return _prepareMultiSearchRows(searchByDescriptionMulti(folderIds, query.trim(), offset, limit, sortMode), true);
});
electron.ipcMain.handle("search-by-description-count-multi", (_event, folderIds, query) => {
  return searchByDescriptionCountMulti(folderIds, query.trim());
});
electron.ipcMain.handle("search-by-rating-multi", async (_event, folderIds, ratings, offset, limit, sortMode) => {
  return _prepareMultiSearchRows(searchByRatingMulti(folderIds, ratings, offset, limit, sortMode), true);
});
electron.ipcMain.handle("search-by-rating-count-multi", (_event, folderIds, ratings) => {
  return searchByRatingCountMulti(folderIds, ratings);
});
electron.ipcMain.handle("search-by-aspect-ratio-multi", async (_event, folderIds, ratioW, ratioH, tolerance, offset, limit, sortMode) => {
  return _prepareMultiSearchRows(searchByAspectRatioMulti(folderIds, ratioW, ratioH, tolerance, offset, limit, sortMode), false);
});
electron.ipcMain.handle("search-by-aspect-ratio-count-multi", (_event, folderIds, ratioW, ratioH, tolerance) => {
  return searchByAspectRatioCountMulti(folderIds, ratioW, ratioH, tolerance);
});
electron.ipcMain.handle("search-by-color", async (_event, folderIds, target, tolerance, offset, limit, sortMode, useHue = true, useSat = true, useValue = true) => {
  const ids = Array.isArray(folderIds) ? folderIds.filter((x) => x > 0) : [];
  const t = target && typeof target === "object" ? { h: Number(target.h) || 0, s: Number(target.s) || 0, v: Number(target.v) || 0 } : { h: 0, s: 0, v: 0 };
  const tol = Math.max(0, Math.min(1, Number(tolerance) || 0));
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.max(1, Math.min(1e3, Number(limit) || 100));
  const { rows, total } = searchByColor(ids, t, tol, off, lim, sortMode, useHue, useSat, useValue);
  for (const img of rows) {
    img.is_favorite = img.is_favorite || 0;
    if (!img.thumbnail_path) img.thumbnail_path = discoverThumbnailPath(img.file_path);
  }
  return { rows, total };
});
electron.ipcMain.handle("get-images-page-multi", async (_event, folderIds, offset, limit, sortMode) => {
  const page = getImagesPageMulti(folderIds, offset, limit, sortMode);
  const result = page.map((r) => {
    const img = { ...r, is_favorite: r.is_favorite || 0 };
    if (!img.thumbnail_path) {
      img.thumbnail_path = discoverThumbnailPath(img.file_path);
    } else if (!fs.existsSync(img.thumbnail_path)) {
      img.thumbnail_path = "";
      img.thumbnail_path = discoverThumbnailPath(img.file_path);
    }
    if (!fs.existsSync(img.file_path)) {
      deleteImageByPath(img.file_path);
      return null;
    }
    return img;
  }).filter(Boolean);
  try {
    for (const img of result) {
      if (!img.width || !img.height) {
        try {
          const d = await readImageDimensions(img.file_path);
          if (d) {
            img.width = d.width;
            img.height = d.height;
            updateImageDimensions(img.file_path, d.width, d.height);
          }
        } catch {
        }
      }
    }
  } catch {
  }
  return result;
});
electron.ipcMain.handle("get-images-count-multi", (_event, folderIds) => {
  return getImagesCountMulti(folderIds);
});
electron.ipcMain.handle("get-all-image-ids", (_event, folderId) => {
  return getAllImageIds(folderId);
});
electron.ipcMain.handle("get-images-by-ids", (_event, ids) => {
  return getImagesByIds(ids);
});
electron.ipcMain.handle("get-random-sample", async (_event, folderId, excludePath, count) => {
  const rows = Array.isArray(folderId) ? getRandomSampleMulti(folderId, excludePath, count) : getRandomSample(folderId, excludePath, count);
  const needDim = rows.filter((r) => !r.width || !r.height);
  if (needDim.length > 0) {
    try {
      const sharp = (await import("sharp")).default;
      const lim = 16;
      for (let i = 0; i < needDim.length; i += lim) {
        await Promise.all(needDim.slice(i, i + lim).map(async (r) => {
          try {
            const m = await sharp(r.file_path).metadata();
            r.width = m.width || 0;
            r.height = m.height || 0;
            updateImageDimensions(r.file_path, r.width, r.height);
          } catch {
          }
        }));
      }
    } catch {
    }
  }
  return rows;
});
electron.ipcMain.handle("set-titlebar-theme", (_event, isLight) => {
  if (!mainWindow) return;
  try {
    mainWindow.setTitleBarOverlay({
      color: isLight ? "#faf5ef" : "#1a1a2e",
      symbolColor: isLight ? "#555555" : "#aaaaaa",
      height: 48
    });
    console.log("[titlebar] theme set to", isLight ? "light" : "dark");
  } catch (e) {
    console.error("[titlebar] setTitleBarOverlay failed:", e);
  }
});
electron.ipcMain.handle("generate-thumbnail", async (_event, sourcePath) => {
  const sharp = (await import("sharp")).default;
  const fse = await import("fs-extra");
  const { nativeImage: nativeImage2 } = await import("electron");
  const ext = path.extname(sourcePath).toLowerCase();
  const hashName = crypto.createHash("md5").update(sourcePath).digest("hex") + ext;
  const outputPath = path.join(cacheDir, hashName);
  async function fallback(dest) {
    try {
      const img = nativeImage2.createFromPath(sourcePath);
      if (img.isEmpty()) return null;
      const size = img.getSize();
      const resized = img.resize({ width: 400 });
      const buf = resized.toJPEG(75);
      await fse.writeFile(dest, buf);
      return { w: size.width, h: size.height };
    } catch {
      return null;
    }
  }
  if (ext === ".gif") {
    if (await fse.pathExists(outputPath)) {
      let origW = 0, origH = 0;
      try {
        const m = await sharp(sourcePath).metadata();
        origW = m.width || 0;
        origH = m.height || 0;
      } catch {
      }
      return { thumbnail_path: outputPath, width: origW, height: origH };
    }
    try {
      let origW = 0, origH = 0;
      try {
        const m = await sharp(sourcePath).metadata();
        origW = m.width || 0;
        origH = m.height || 0;
      } catch {
      }
      await sharp(sourcePath, { animated: true }).resize({ width: 400, withoutEnlargement: true }).gif({ colours: 48, dither: 1 }).toFile(outputPath);
      return { thumbnail_path: outputPath, width: origW, height: origH };
    } catch (e) {
      console.error("[thumbnail:single] sharp gif failed, trying fallback:", path.basename(sourcePath), e?.message || e);
      logError(`[single-gif] ${path.basename(sourcePath)} - sharp failed: ${e?.message || e}`);
      const fb = await fallback(outputPath);
      if (fb) return { thumbnail_path: outputPath, width: fb.w, height: fb.h };
      logError(`[single-gif] ${path.basename(sourcePath)} - fallback also failed`);
      throw e;
    }
  }
  if (ext === ".psd") {
    const pngPath = await ensurePsdPng(sourcePath);
    const webpPath2 = outputPath.replace(ext, ".webp");
    if (await fse.pathExists(webpPath2)) {
      try {
        const m = await sharp(pngPath).metadata();
        return { thumbnail_path: webpPath2, width: m.width || 0, height: m.height || 0 };
      } catch {
        return { thumbnail_path: webpPath2 };
      }
    }
    try {
      let origW = 0, origH = 0;
      try {
        const m = await sharp(pngPath).metadata();
        origW = m.width || 0;
        origH = m.height || 0;
      } catch {
      }
      await sharp(pngPath).resize({ width: 400, withoutEnlargement: true }).webp({ quality: 75 }).toFile(webpPath2);
      return { thumbnail_path: webpPath2, width: origW, height: origH };
    } catch (e) {
      logError(`[single-psd] ${path.basename(sourcePath)} - convert failed: ${e?.message || e}`);
      const fb = await fallback(webpPath2);
      if (fb) return { thumbnail_path: webpPath2, width: fb.w, height: fb.h };
      throw e;
    }
  }
  if (isVideoExt(ext)) {
    const webpPath2 = outputPath.replace(ext, ".webp");
    if (await fse.pathExists(webpPath2)) {
      try {
        const m = await sharp(webpPath2).metadata();
        return { thumbnail_path: webpPath2, width: m.width || 0, height: m.height || 0 };
      } catch {
        return { thumbnail_path: webpPath2 };
      }
    }
    const poster = await getOrGeneratePoster(sourcePath);
    if (!poster) return { thumbnail_path: "" };
    try {
      const m = await sharp(poster).metadata();
      return { thumbnail_path: webpPath2, width: m.width || 0, height: m.height || 0 };
    } catch {
      return { thumbnail_path: webpPath2 };
    }
  }
  const webpPath = outputPath.replace(ext, ".webp");
  if (await fse.pathExists(webpPath)) {
    try {
      const m = await sharp(sourcePath).metadata();
      return { thumbnail_path: webpPath, width: m.width || 0, height: m.height || 0 };
    } catch {
      return { thumbnail_path: webpPath };
    }
  }
  try {
    let origW = 0, origH = 0;
    try {
      const m = await sharp(sourcePath).metadata();
      origW = m.width || 0;
      origH = m.height || 0;
    } catch {
    }
    await sharp(sourcePath).toColourspace("srgb").resize({ width: 400, withoutEnlargement: true }).webp({ quality: 75 }).toFile(webpPath);
    return { thumbnail_path: webpPath, width: origW, height: origH };
  } catch (e) {
    console.error("[thumbnail:single] sharp failed, trying fallback:", path.basename(sourcePath), e?.message || e);
    logError(`[single-webp] ${path.basename(sourcePath)} - sharp failed: ${e?.message || e}`);
    const jpgPath = webpPath.replace(/\.webp$/, ".jpg");
    const fb = await fallback(jpgPath);
    if (fb) return { thumbnail_path: jpgPath, width: fb.w, height: fb.h };
    logError(`[single-webp] ${path.basename(sourcePath)} - fallback also failed`);
    throw e;
  }
});
let _thumbWorkerPath = null;
async function _ensureThumbWorkerPath() {
  if (_thumbWorkerPath && fs.existsSync(_thumbWorkerPath)) return _thumbWorkerPath;
  const wp = path.join(__dirname, "thumb-worker-v2.cjs");
  if (!fs.existsSync(wp)) {
    fs.writeFileSync(wp, `const fs = require('fs');
const sharp = require('sharp');
const taskFile = process.argv[2];
const tasks = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
(async () => {
  const out = [];
  for (const t of tasks) {
    try {
      if (fs.existsSync(t.output)) { out.push({ ok: true, file_path: t.file_path, thumbnail_path: t.output, skipped: true }); continue; }
      const m = await sharp(t.input).metadata();
      let p = sharp(t.input).toColourspace('srgb');
      if (!t.noResize) p = p.resize({ width: 400, withoutEnlargement: true });
      const fmt = t.format === 'jpg' ? 'jpeg' : 'webp';
      await p[fmt]({ quality: t.quality || 75 }).toFile(t.output);
      out.push({ ok: true, file_path: t.file_path, thumbnail_path: t.output, width: m.width || 0, height: m.height || 0 });
    } catch (e) {
      out.push({ ok: false, file_path: t.file_path, error: (e && e.message) || String(e) });
    }
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
})().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
`);
  }
  _thumbWorkerPath = wp;
  return wp;
}
async function _generateThumbsInChild(tasks) {
  try {
    const workerPath = await _ensureThumbWorkerPath();
    const { spawn } = await import("child_process");
    const os2 = await import("os");
    const taskFile = path.join(os2.tmpdir(), "picrand-thumbs-" + crypto.randomUUID() + ".json");
    fs.writeFileSync(taskFile, JSON.stringify(tasks));
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [workerPath, taskFile], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      let out = "", err = "";
      child.stdout.on("data", (d) => {
        out += d;
      });
      child.stderr.on("data", (d) => {
        err += d;
      });
      child.on("error", (e) => reject(e));
      child.on("exit", (code) => {
        code === 0 ? resolve(out) : reject(new Error("thumb-worker exit " + code + (err ? " | " + err.slice(0, 500) : "")));
      });
    });
    try {
      fs.unlinkSync(taskFile);
    } catch {
    }
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    console.error("[thumb-worker] batch failed:", e?.message || e);
    return null;
  }
}
electron.ipcMain.handle("generate-thumbnails-batch", async (_event, filePaths) => {
  const sharp = (await import("sharp")).default;
  const fse = await import("fs-extra");
  const { nativeImage: nativeImage2 } = await import("electron");
  const results = [];
  const errors = [];
  async function fallbackThumb(fp, dest) {
    try {
      const img = nativeImage2.createFromPath(fp);
      if (img.isEmpty()) return null;
      const size = img.getSize();
      const resized = img.resize({ width: 400 });
      const buf = resized.toJPEG(75);
      await fse.writeFile(dest, buf);
      return { w: size.width, h: size.height };
    } catch {
      return null;
    }
  }
  const childTasks = [];
  for (const fp of filePaths) {
    await _thumbAcquire();
    try {
      const ext = path.extname(fp).toLowerCase();
      const hashName = crypto.createHash("md5").update(fp).digest("hex") + ext;
      const tp = path.join(cacheDir, hashName);
      let origW = 0, origH = 0;
      if (ext === ".gif") {
        if (!await fse.pathExists(tp)) {
          try {
            await sharp(fp, { animated: true }).resize({ width: 400, withoutEnlargement: true }).gif({ colours: 48, dither: 1 }).toFile(tp);
            results.push({ file_path: fp, thumbnail_path: tp, width: origW, height: origH });
          } catch (e) {
            logError(`[batch-gif] ${path.basename(fp)} - sharp failed: ${e?.message || e}`);
            const fb = await fallbackThumb(fp, tp);
            if (fb) {
              origW = fb.w;
              origH = fb.h;
              results.push({ file_path: fp, thumbnail_path: tp, width: origW, height: origH });
            } else {
              logError(`[batch-gif] ${path.basename(fp)} - fallback also failed`);
              console.error("[thumbnail] gif+fallback failed:", path.basename(fp), e?.message || e);
              errors.push(path.basename(fp));
              results.push({ file_path: fp, thumbnail_path: "" });
            }
          }
        } else {
          results.push({ file_path: fp, thumbnail_path: tp, width: origW, height: origH });
        }
        continue;
      }
      if (ext === ".psd") {
        const wp2 = tp.replace(ext, ".webp");
        if (await fse.pathExists(wp2)) {
          results.push({ file_path: fp, thumbnail_path: wp2, width: origW, height: origH });
          continue;
        }
        try {
          const pngPath = await ensurePsdPng(fp);
          const m = await sharp(pngPath).metadata();
          origW = m.width || 0;
          origH = m.height || 0;
          await sharp(pngPath).resize({ width: 400, withoutEnlargement: true }).webp({ quality: 75 }).toFile(wp2);
          results.push({ file_path: fp, thumbnail_path: wp2, width: origW, height: origH });
          updateImageDimensions(fp, origW, origH);
        } catch (e) {
          logError(`[batch-psd] ${path.basename(fp)} - convert failed: ${e?.message || e}`);
          const fb = await fallbackThumb(fp, wp2);
          if (fb) {
            origW = fb.w;
            origH = fb.h;
            results.push({ file_path: fp, thumbnail_path: wp2, width: origW, height: origH });
          } else {
            errors.push(path.basename(fp));
            results.push({ file_path: fp, thumbnail_path: "" });
          }
        }
        continue;
      }
      if (isVideoExt(ext)) {
        const wp2 = tp.replace(ext, ".webp");
        if (await fse.pathExists(wp2)) {
          try {
            const m = await sharp(wp2).metadata();
            origW = m.width || 0;
            origH = m.height || 0;
          } catch {
          }
          results.push({ file_path: fp, thumbnail_path: wp2, width: origW, height: origH });
          continue;
        }
        const poster = await getOrGeneratePoster(fp);
        if (!poster) {
          errors.push(path.basename(fp));
          results.push({ file_path: fp, thumbnail_path: "" });
          continue;
        }
        try {
          const m = await sharp(poster).metadata();
          origW = m.width || 0;
          origH = m.height || 0;
          updateImageDimensions(fp, origW, origH);
        } catch {
        }
        results.push({ file_path: fp, thumbnail_path: wp2, width: origW, height: origH });
        continue;
      }
      const wp = tp.replace(ext, ".webp");
      if (!await fse.pathExists(wp)) {
        childTasks.push({ file_path: fp, input: fp, output: wp });
      } else {
        results.push({ file_path: fp, thumbnail_path: wp, width: origW, height: origH });
      }
    } finally {
      _thumbRelease();
    }
  }
  if (childTasks.length > 0) {
    const childRes = await _generateThumbsInChild(childTasks);
    if (childRes) {
      for (const cr of childRes) {
        if (cr.ok && cr.thumbnail_path) {
          results.push({ file_path: cr.file_path, thumbnail_path: cr.thumbnail_path, width: cr.width || 0, height: cr.height || 0 });
        } else {
          const fp = cr.file_path;
          const ext = path.extname(fp).toLowerCase();
          const wp = path.join(cacheDir, crypto.createHash("md5").update(fp).digest("hex") + ext).replace(ext, ".webp");
          try {
            const m = await sharp(fp).metadata();
            await sharp(fp).toColourspace("srgb").resize({ width: 400, withoutEnlargement: true }).webp({ quality: 75 }).toFile(wp);
            results.push({ file_path: fp, thumbnail_path: wp, width: m.width || 0, height: m.height || 0 });
          } catch (e) {
            logError(`[batch-webp] ${path.basename(fp)} - sharp failed: ${e?.message || e}`);
            const jpgPath = wp.replace(/\.webp$/, ".jpg");
            const fb = await fallbackThumb(fp, jpgPath);
            if (fb) {
              results.push({ file_path: fp, thumbnail_path: jpgPath, width: fb.w, height: fb.h });
            } else {
              logError(`[batch-webp] ${path.basename(fp)} - fallback also failed`);
              errors.push(path.basename(fp));
              results.push({ file_path: fp, thumbnail_path: "" });
            }
          }
        }
      }
    } else {
      for (const t of childTasks) {
        const fp = t.file_path;
        try {
          const m = await sharp(fp).metadata();
          await sharp(fp).toColourspace("srgb").resize({ width: 400, withoutEnlargement: true }).webp({ quality: 75 }).toFile(t.output);
          results.push({ file_path: fp, thumbnail_path: t.output, width: m.width || 0, height: m.height || 0 });
        } catch (e) {
          const jpgPath = t.output.replace(/\.webp$/, ".jpg");
          const fb = await fallbackThumb(fp, jpgPath);
          if (fb) {
            results.push({ file_path: fp, thumbnail_path: jpgPath, width: fb.w, height: fb.h });
          } else {
            errors.push(path.basename(fp));
            results.push({ file_path: fp, thumbnail_path: "" });
          }
        }
      }
    }
  }
  return { results, errors };
});
electron.ipcMain.handle("db-init-folder", (_event, folderPath) => getOrCreateFolder(folderPath));
electron.ipcMain.handle("db-insert-image", (_event, image) => {
  insertImage(image.folderId, image.filePath, image.fileName, image.fileSize, image.modifyTime, image.width, image.height, image.thumbnailPath);
});
electron.ipcMain.handle("db-delete-image", (_event, filePath) => {
  deleteImageByPath(filePath);
});
electron.ipcMain.handle("db-get-images-by-folder", (_event, folderId) => getImagesByFolder(folderId));
electron.ipcMain.handle("update-image-dimensions", (_event, filePath, width, height) => {
  updateImageDimensions(filePath, width, height);
});
electron.ipcMain.handle("update-image-thumbnail", (_event, filePath, thumbnailPath) => {
  updateThumbnailPath(filePath, thumbnailPath);
});
electron.ipcMain.handle("get-dimensions-batch", (_event, paths) => {
  if (!paths.length) return [];
  const placeholders = paths.map(() => "?").join(",");
  const rows = getDb().prepare(
    `SELECT file_path, width, height FROM images WHERE file_path IN (${placeholders})`
  ).all(...paths);
  return rows;
});
electron.ipcMain.handle("fill-image-dims", async (_event, paths) => {
  if (!Array.isArray(paths) || paths.length === 0) return {};
  const placeholders = paths.map(() => "?").join(",");
  const rows = getDb().prepare(
    `SELECT file_path, width, height FROM images WHERE file_path IN (${placeholders})`
  ).all(...paths);
  const need = rows.filter((r) => !r.width || !r.height).map((r) => r.file_path);
  const out = {};
  let cursor = 0;
  const runOne = async () => {
    while (true) {
      const i = cursor++;
      if (i >= need.length) break;
      const p = need[i];
      try {
        const d = await readImageDimensions(p);
        if (d && d.width > 0 && d.height > 0) {
          out[p] = { width: d.width, height: d.height };
          updateImageDimensions(p, d.width, d.height);
        }
      } catch {
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, need.length) }, () => runOne()));
  return out;
});
electron.ipcMain.handle("write-temp-png", (_event, data) => {
  try {
    const os2 = require("os");
    const tmpDir = path.join(os2.tmpdir(), "picrand-frames");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, "frame-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".png");
    fs.writeFileSync(tmpPath, Buffer.from(data));
    return tmpPath;
  } catch (e) {
    console.error("[write-temp-png] failed:", e);
    return null;
  }
});
electron.ipcMain.handle("read-file-buffer", (_event, filePath) => {
  try {
    const buf = fs.readFileSync(filePath);
    return new Uint8Array(buf);
  } catch (e) {
    console.error("[read-file-buffer] failed:", e);
    return null;
  }
});
electron.ipcMain.handle("get-image-info", async (_event, filePath) => {
  const stat = fs.statSync(filePath);
  let width = 0, height = 0, dpi = 72;
  try {
    const sharp = (await import("sharp")).default;
    const resolved = await resolveForSharp(filePath);
    const meta = await sharp(resolved).metadata();
    width = meta.width || 0;
    height = meta.height || 0;
    if (meta.density && meta.density > 0) dpi = meta.density;
  } catch {
    try {
      const { nativeImage: nativeImage2 } = await import("electron");
      const img = nativeImage2.createFromPath(filePath);
      if (!img.isEmpty()) {
        const size = img.getSize();
        width = size.width;
        height = size.height;
      }
    } catch {
    }
  }
  return {
    file_path: filePath,
    file_name: path.basename(filePath),
    file_size: stat.size,
    modify_time: Math.floor(stat.mtimeMs / 1e3),
    width,
    height,
    dpi,
    thumbnail_path: filePath,
    is_favorite: 0
  };
});
electron.ipcMain.handle("get-image-metadata", async (_event, filePath) => {
  try {
    const sharp = (await import("sharp")).default;
    const resolved = await resolveForSharp(filePath);
    const meta = await sharp(resolved).metadata();
    const stat = fs.statSync(filePath);
    const w = meta.width || 0, h = meta.height || 0;
    return {
      width: w,
      height: h,
      space: meta.space || "srgb",
      channels: meta.channels || 3,
      hasAlpha: meta.hasAlpha ?? false,
      format: meta.format || "",
      fileSize: stat.size,
      isPotWidth: (w & w - 1) === 0 && w > 0,
      isPotHeight: (h & h - 1) === 0 && h > 0
    };
  } catch {
    return null;
  }
});
electron.ipcMain.handle("sample-pixel", async (_event, filePath, x, y) => {
  try {
    const sharp = (await import("sharp")).default;
    const resolved = await resolveForSharp(filePath);
    const { data } = await sharp(resolved).extract({ left: Math.max(0, Math.round(x)), top: Math.max(0, Math.round(y)), width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
    const r = data[0], g = data[1] ?? r, b = data[2] ?? r, a = data[3] ?? 255;
    const hex = "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase();
    const fr = r / 255, fg = g / 255, fb = b / 255;
    const cmax = Math.max(fr, fg, fb), cmin = Math.min(fr, fg, fb), delta = cmax - cmin;
    let h = 0, s = 0;
    if (delta > 1e-3) {
      if (cmax === fr) h = (fg - fb) / delta % 6;
      else if (cmax === fg) h = (fb - fr) / delta + 2;
      else h = (fr - fg) / delta + 4;
      h = (h < 0 ? h + 6 : h) * 60;
      s = delta / cmax;
    }
    return { r, g, b, a, hex, floatR: fr, floatG: fg, floatB: fb, h: Math.round(h), s: +s.toFixed(4), v: +cmax.toFixed(4) };
  } catch {
    return null;
  }
});
electron.ipcMain.handle("sample-rect", async (_event, filePath, x, y, w, h) => {
  try {
    const rw = Math.max(1, Math.round(w)), rh = Math.max(1, Math.round(h));
    const rx = Math.max(0, Math.round(x)), ry = Math.max(0, Math.round(y));
    const sharp = (await import("sharp")).default;
    const resolved = await resolveForSharp(filePath);
    const { data, info } = await sharp(resolved).extract({ left: rx, top: ry, width: rw, height: rh }).raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels || 3;
    let sumR = 0, sumG = 0, sumB = 0, count = 0;
    for (let i = 0; i < data.length; i += channels) {
      sumR += data[i];
      sumG += data[i + 1] ?? data[i];
      sumB += data[i + 2] ?? data[i];
      count++;
    }
    if (count === 0) return null;
    const r = Math.round(sumR / count), g = Math.round(sumG / count), b = Math.round(sumB / count);
    const hex = "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase();
    const fr = r / 255, fg = g / 255, fb = b / 255;
    const cmax = Math.max(fr, fg, fb), cmin = Math.min(fr, fg, fb), delta = cmax - cmin;
    let hh = 0, s = 0;
    if (delta > 1e-3) {
      if (cmax === fr) hh = (fg - fb) / delta % 6;
      else if (cmax === fg) hh = (fb - fr) / delta + 2;
      else hh = (fr - fg) / delta + 4;
      hh = (hh < 0 ? hh + 6 : hh) * 60;
      s = delta / cmax;
    }
    return { r, g, b, hex, h: Math.round(hh), s: +s.toFixed(4), v: +cmax.toFixed(4) };
  } catch {
    return null;
  }
});
electron.ipcMain.handle("compute-histogram", async (_event, filePath, sampleStep = 4) => {
  try {
    const sharp = (await import("sharp")).default;
    const resolved = await resolveForSharp(filePath);
    const { data, info } = await sharp(resolved).raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels || 3;
    const lumas = new Array(256).fill(0), reds = new Array(256).fill(0);
    const greens = new Array(256).fill(0), blues = new Array(256).fill(0);
    let step = sampleStep;
    const totalPixels = info.width * info.height;
    if (totalPixels > 16e6) step = Math.max(step, 8);
    let count = 0;
    for (let i = 0; i < data.length; i += step * channels) {
      const r = data[i], g = data[i + 1] ?? r, b_ = data[i + 2] ?? r;
      const luma = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b_);
      lumas[luma]++;
      reds[r]++;
      greens[g]++;
      blues[b_]++;
      count++;
    }
    return { luma: lumas, red: reds, green: greens, blue: blues, totalPixels: count };
  } catch {
    return null;
  }
});
electron.ipcMain.handle("compute-color-analysis", async (_event, filePath) => {
  try {
    const sharp = (await import("sharp")).default;
    const resolved = await resolveForSharp(filePath);
    const { data, info } = await sharp(resolved).raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels || 3;
    const totalPixels = info.width * info.height;
    let step = 4;
    if (totalPixels > 16e6) step = Math.max(step, 8);
    let sumR = 0, sumG = 0, sumB = 0, count = 0;
    const hueHist = new Array(360).fill(0);
    const satHist = new Array(100).fill(0);
    const valHist = new Array(100).fill(0);
    const buckets = /* @__PURE__ */ new Map();
    for (let i = 0; i < data.length; i += step * channels) {
      const r = data[i], g = data[i + 1] ?? r, b = data[i + 2] ?? r;
      sumR += r;
      sumG += g;
      sumB += b;
      count++;
      const fr = r / 255, fg = g / 255, fb = b / 255;
      const cmax = Math.max(fr, fg, fb), cmin = Math.min(fr, fg, fb), delta = cmax - cmin;
      let h = 0, s = 0;
      if (delta > 1e-4) {
        if (cmax === fr) h = (fg - fb) / delta % 6;
        else if (cmax === fg) h = (fb - fr) / delta + 2;
        else h = (fr - fg) / delta + 4;
        h = (h < 0 ? h + 6 : h) * 60;
        s = delta / cmax;
      }
      hueHist[Math.min(359, Math.floor(h))]++;
      satHist[Math.min(99, Math.floor(s * 100))]++;
      valHist[Math.min(99, Math.floor(cmax * 100))]++;
      const bk = Math.floor(r / 32) << 6 | Math.floor(g / 32) << 3 | Math.floor(b / 32);
      const bv = buckets.get(bk);
      if (bv) {
        bv.r += r;
        bv.g += g;
        bv.b += b;
        bv.n++;
      } else buckets.set(bk, { r, g, b, n: 1 });
    }
    const avgR = Math.round(sumR / count), avgG = Math.round(sumG / count), avgB = Math.round(sumB / count);
    const avgHex = "#" + [avgR, avgG, avgB].map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase();
    let sinSum = 0, cosSum = 0;
    const rad = Math.PI / 180;
    for (let i = 0; i < 360; i++) {
      sinSum += Math.sin(i * rad) * hueHist[i];
      cosSum += Math.cos(i * rad) * hueHist[i];
    }
    let hueAvg = 0;
    if (Math.abs(sinSum) > 1e-9 || Math.abs(cosSum) > 1e-9) {
      hueAvg = Math.atan2(sinSum, cosSum) / rad;
      if (hueAvg < 0) hueAvg += 360;
    }
    let satSum = 0, satWt = 0;
    for (let i = 0; i < 100; i++) {
      satSum += i * satHist[i];
      satWt += satHist[i];
    }
    const satAvg = satWt > 0 ? satSum / satWt / 100 : 0;
    let valSum = 0, valWt = 0;
    for (let i = 0; i < 100; i++) {
      valSum += i * valHist[i];
      valWt += valHist[i];
    }
    const valAvg = valWt > 0 ? valSum / valWt / 100 : 0;
    const topBuckets = Array.from(buckets.entries()).sort((a, b) => b[1].n - a[1].n).slice(0, 20).map(([bk, bv]) => {
      const r = Math.round(bv.r / bv.n), g = Math.round(bv.g / bv.n), b = Math.round(bv.b / bv.n);
      return { r, g, b, hex: "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase(), count: bv.n };
    });
    const merged = [];
    for (const c of topBuckets) {
      let found = false;
      for (const m of merged) {
        const dr = c.r - m.r, dg = c.g - m.g, db2 = c.b - m.b;
        if (Math.sqrt(dr * dr + dg * dg + db2 * db2) < 48) {
          const total = m.count + c.count;
          m.r = Math.round((m.r * m.count + c.r * c.count) / total);
          m.g = Math.round((m.g * m.count + c.g * c.count) / total);
          m.b = Math.round((m.b * m.count + c.b * c.count) / total);
          m.hex = "#" + [m.r, m.g, m.b].map((c2) => c2.toString(16).padStart(2, "0")).join("").toUpperCase();
          m.count = total;
          found = true;
          break;
        }
      }
      if (!found) merged.push({ ...c });
    }
    const dominantColors = merged.sort((a, b) => b.count - a.count).slice(0, 8).map((c) => ({ r: c.r, g: c.g, b: c.b, hex: c.hex, percent: Math.round(c.count / count * 1e3) / 10 }));
    return { avgR, avgG, avgB, avgHex, hueHist, satHist, valHist, hueAvg, satAvg, valAvg, dominantColors, totalPixels: count };
  } catch {
    return null;
  }
});
electron.ipcMain.handle("get-all-folders", () => {
  const folders = getAllFolders();
  return folders.map((f) => ({ ...f, path: resolveStoredPath(f.path) }));
});
electron.ipcMain.handle("reorder-folders", (_event, orderedIds) => {
  reorderFolders(orderedIds);
  return true;
});
function _toastChecking() {
  try {
    mainWindow?.webContents.send("show-toast", { msg: currentLocale === "en" ? "Adding…" : currentLocale === "ja" ? "追加中…" : "正在添加…", ms: 6e4 });
  } catch {
  }
}
function _toastClear() {
  try {
    mainWindow?.webContents.send("show-toast", { msg: "", ms: 100 });
  } catch {
  }
}
electron.ipcMain.handle("add-folder", async () => {
  const result = await electron.dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  if (result.canceled || !result.filePaths[0]) return null;
  const p = result.filePaths[0];
  const name = p.split("\\").pop() || p;
  _toastChecking();
  const _ovResult2 = await checkFolderOversize(p);
  if (_ovResult2) {
    if (!await confirmOversizeDialog()) {
      _toastClear();
      return null;
    }
    _toastClear();
  } else {
    _toastClear();
  }
  const id = addFolder(p, name);
  invalidateStatsCache();
  return { id, path: p, display_name: name };
});
electron.ipcMain.handle("resolve-drop-paths", (_event, paths) => {
  if (!Array.isArray(paths)) return [];
  const dirs = /* @__PURE__ */ new Set();
  for (const p of paths) {
    if (!p || typeof p !== "string") continue;
    try {
      if (!fs.existsSync(p)) continue;
      if (fs.statSync(p).isDirectory()) dirs.add(p);
    } catch {
    }
  }
  return Array.from(dirs);
});
electron.ipcMain.on("drop-folders", async (_event, paths) => {
  const payload = paths;
  const rawPaths = Array.isArray(payload) ? payload : payload?.paths || [];
  const diag = Array.isArray(payload) ? "" : payload?.diag || "";
  const dirs = [];
  const imgFiles = [];
  const IMG_EXTS = /* @__PURE__ */ new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".tif", ".avif", ".svg", ".psd", ".heic", ".heif", ".mp4", ".webm", ".mov", ".mkv", ".avi", ".flv", ".f4v"]);
  let nonDirCount = 0;
  let notExistCount = 0;
  for (const p of rawPaths) {
    if (!p || typeof p !== "string") continue;
    try {
      if (!fs.existsSync(p)) {
        notExistCount++;
        continue;
      }
      if (fs.statSync(p).isDirectory()) {
        dirs.push(p);
      } else if (IMG_EXTS.has(path.extname(p).toLowerCase())) {
        imgFiles.push(p);
      } else {
        nonDirCount++;
      }
    } catch {
    }
  }
  mainWindow?.webContents.send("drop-result", { folders: dirs, imgFiles, diag, nonDirCount, notExistCount });
});
electron.ipcMain.handle("add-folder-by-path", async (_event, folderPath) => {
  if (!fs.existsSync(folderPath)) return null;
  if (!fs.statSync(folderPath).isDirectory()) return null;
  const name = folderPath.split("\\").pop() || folderPath;
  _toastChecking();
  const _ovResult3 = await checkFolderOversize(folderPath);
  if (_ovResult3) {
    if (!await confirmOversizeDialog()) {
      _toastClear();
      return null;
    }
    _toastClear();
  } else {
    _toastClear();
  }
  const id = addFolder(folderPath, name);
  invalidateStatsCache();
  return { id, path: folderPath, display_name: name };
});
electron.ipcMain.handle("get-folder-name-by-path", (_event, folderPath) => {
  return getFolderDisplayNameByPath(folderPath);
});
electron.ipcMain.handle("get-folder-random-thumbs", async (_event, folderId, count) => {
  const dbResult = getFolderRandomThumbs(folderId, count);
  if (dbResult.length > 0) return dbResult;
  try {
    const row = getDb().prepare("SELECT path FROM folders WHERE id = ?").get(folderId);
    const resolved = row?.path ? resolveStoredPath(row.path) : "";
    if (resolved && fs.existsSync(resolved)) {
      const wresult = await _walkFolderWorker(resolved);
      if (wresult && wresult.recentPaths && wresult.recentPaths.length > 0) {
        const paths = wresult.recentPaths.slice(0, count);
        return paths.map((p) => ({ file_path: p, thumbnail_path: discoverThumbnailPath(p) || null }));
      }
      if (wresult && wresult.latestPath) {
        return [{ file_path: wresult.latestPath, thumbnail_path: discoverThumbnailPath(wresult.latestPath) || null }];
      }
    }
  } catch {
  }
  return [];
});
electron.ipcMain.handle("create-new-folder", async (_event, name) => {
  const safeName = name.trim();
  if (!safeName) return null;
  const fs2 = await import("fs-extra");
  const folderPath = path.join(newFoldersDir, safeName);
  let finalPath = folderPath, finalName = safeName;
  let i = 1;
  while (await fs2.pathExists(finalPath)) {
    finalName = `${safeName}(${i})`;
    finalPath = path.join(newFoldersDir, finalName);
    i++;
  }
  await fs2.ensureDir(finalPath);
  const id = addFolder(finalPath, finalName);
  return { id, path: finalPath, display_name: finalName };
});
electron.ipcMain.handle("update-folder-name", (_event, id, name) => {
  updateFolderName(id, name);
  return true;
});
electron.ipcMain.handle("update-folder-description", (_event, id, desc) => {
  updateFolderDescription(id, desc);
  return true;
});
electron.ipcMain.handle("update-folder-path", async (_event, id) => {
  const result = await electron.dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  if (result.canceled || !result.filePaths[0]) return null;
  const p = result.filePaths[0];
  updateFolderPath(id, p);
  return { path: p, display_name: p.split("\\").pop() || p };
});
electron.ipcMain.handle("delete-folder", (_event, id, folderPath) => {
  if (folderPath && getWatchedFolder() === folderPath) stopWatching();
  deleteFolderById(id);
  invalidateStatsCache(id);
  return true;
});
electron.ipcMain.handle("favorite-image", async (_event, sourcePath) => {
  updateFavorite(sourcePath, 1);
  return sourcePath;
});
electron.ipcMain.handle("update-folder-color", (_event, folderId, color) => {
  updateFolderColor(folderId, color);
  return true;
});
electron.ipcMain.handle("update-folder-cover", (_event, folderId, coverPath) => {
  updateFolderCover(folderId, coverPath);
  invalidateStatsCache(folderId);
  return true;
});
electron.ipcMain.handle("toggle-folder-favorite", (_event, folderId, val) => {
  updateFolderFavorite(folderId, val);
  return true;
});
let _statsWorkerPath = "";
async function _ensureStatsWorkerPath() {
  if (_statsWorkerPath && require("fs").existsSync(_statsWorkerPath)) return _statsWorkerPath;
  const pth = await import("path");
  const os2 = await import("os");
  const content = `const fs = require('fs')
const path = require('path')
const { parentPort, workerData } = require('worker_threads')
const exts = new Set(['.jpg','.jpeg','.png','.gif','.bmp','.webp','.tiff','.tif','.avif','.svg','.psd','.heic','.heif','.mp4','.webm','.mov','.mkv','.avi','.flv','.f4v'])
const deadline = Date.now() + 8000
let aborted = false
const allFiles = []
let realCount = 0, totalSize = 0
// BFS: queue instead of recursion - shallow multi-dir scan first
const queue = [workerData.dir]
while (queue.length > 0) {
  if (Date.now() > deadline) { aborted = true; break }
  const dir = queue.shift()
  let items
  try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
  for (const entry of items) {
    if (Date.now() > deadline) { aborted = true; break }
    if (entry.isDirectory()) { queue.push(path.join(dir, entry.name)); continue }
    if (entry.isFile() && exts.has(path.extname(entry.name).toLowerCase())) {
      let st
      try { st = fs.statSync(path.join(dir, entry.name)) } catch { continue }
      realCount++; totalSize += st.size
      if (realCount <= 5000) { allFiles.push({ path: path.join(dir, entry.name), time: st.mtimeMs, size: st.size }) }
      if (realCount >= 5000) { aborted = true; break }
    }
  }
}
// 超时或达到上限时，用已扫到的图片作为结果
allFiles.sort((a, b) => b.time - a.time)
const latest = allFiles.length > 0 ? allFiles[0] : null
const recent = allFiles.filter(f => !latest || f.path !== latest.path).slice(0, 3)
// 即使 aborted 且 allFiles 为空，也发回已有数据
if (aborted && allFiles.length === 0) {
  // 没扫到任何图，尝试用一个非空 fallback
  parentPort.postMessage({ aborted, realCount: realCount || 0, totalSize, latestPath: null, recentPaths: [], countCapped: true })
} else {
  parentPort.postMessage({ aborted, realCount, totalSize, latestPath: latest ? latest.path : null, recentPaths: recent.map(f => f.path), countCapped: aborted })
}
`;
  const candidates = [pth.join(__dirname, "stats-worker.cjs"), pth.join(os2.tmpdir(), "picrand-stats-worker.cjs")];
  for (const c of candidates) {
    try {
      const _fsw = require("fs");
      _fsw.writeFileSync(c, content);
      _statsWorkerPath = c;
      return c;
    } catch {
    }
  }
  return _statsWorkerPath;
}
async function _walkFolderWorker(dir) {
  try {
    const { Worker } = await import("worker_threads");
    const wp = await _ensureStatsWorkerPath();
    if (!wp || !require("fs").existsSync(wp)) return null;
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        try {
          worker.terminate();
        } catch {
        }
        ;
        clearTimeout(timer);
        resolve(v);
      };
      const worker = new Worker(wp, { workerData: { dir } });
      const timer = setTimeout(() => finish(null), 9e3);
      worker.once("message", (r) => finish(r));
      worker.once("error", () => finish(null));
    });
  } catch {
    return null;
  }
}
const _statsCache = /* @__PURE__ */ new Map();
function invalidateStatsCache(folderId) {
  if (folderId != null) _statsCache.delete(folderId);
  else _statsCache.clear();
}
async function _buildFolderStatsImpl(folderId) {
  const stats = getFolderStats(folderId);
  const stored = getFolderStoredCover(folderId);
  const resolvedStored = stored ? resolveStoredPath(stored) : "";
  if (resolvedStored && fs.existsSync(resolvedStored)) {
    stats.latestPath = resolvedStored;
    stats.latestThumb = discoverThumbnailPath(resolvedStored) || "";
  }
  if (stats.count === 0 || stats.recentPaths.length === 0 || !stats.latestPath) {
    const row = getDb().prepare("SELECT path FROM folders WHERE id = ?").get(folderId);
    const resolvedPath = row?.path ? resolveStoredPath(row.path) : "";
    if (resolvedPath && fs.existsSync(resolvedPath)) {
      try {
        const wresult = await _walkFolderWorker(resolvedPath);
        if (wresult) {
          if (wresult.realCount > 0) {
            stats.count = wresult.realCount;
            stats.totalSize = wresult.totalSize(stats).countCapped = !!wresult.countCapped;
          }
          const coverCandidate = wresult.latestPath || (wresult.recentPaths && wresult.recentPaths.length > 0 ? wresult.recentPaths[0] : null);
          if (coverCandidate && (!stats.latestPath || !fs.existsSync(stats.latestPath))) {
            stats.latestPath = coverCandidate;
            stats.latestThumb = discoverThumbnailPath(coverCandidate) || "";
            updateFolderCover(folderId, coverCandidate);
          }
          if (wresult.recentPaths && wresult.recentPaths.length > 0) {
            stats.recentPaths = wresult.recentPaths.map((p) => ({
              file_path: p,
              thumbnail_path: discoverThumbnailPath(p) || null
            }));
          }
        }
      } catch (e) {
        console.error("[get-folder-stats] walk failed:", e);
      }
    }
  }
  for (const rp of stats.recentPaths) {
    if (!rp.thumbnail_path) rp.thumbnail_path = discoverThumbnailPath(rp.file_path) || null;
  }
  return stats;
}
electron.ipcMain.handle("get-folder-stats", async (_event, folderId) => {
  return buildFolderStats(folderId);
});
async function buildFolderStats(folderId) {
  const cached = _statsCache.get(folderId);
  if (cached) return cached;
  const result = await _buildFolderStatsImpl(folderId);
  if (result && result.count > 0) _statsCache.set(folderId, result);
  return result;
}
electron.ipcMain.handle("get-all-folder-stats", async () => {
  const folders = getAllFolders();
  const result = {};
  await Promise.all(folders.map(async (f) => {
    try {
      result[f.id] = await buildFolderStats(f.id);
    } catch {
    }
  }));
  return result;
});
electron.ipcMain.handle("get-dashboard-stats", async () => {
  const folders = getAllFolders();
  const result = {};
  for (const f of folders) {
    const s = getFolderCachedStats(f.id);
    result[f.id] = { count: s.image_count, totalSize: s.total_size };
  }
  return { folderStats: result, favoritesCount: getFavoritesCount() };
});
electron.ipcMain.handle("get-all-folder-grid-data", async () => {
  const folders = getAllFolders();
  const result = {};
  for (const f of folders) {
    try {
      const fid = f.id;
      const stats = getFolderStats(fid);
      if (stats.count === 0 || !stats.latestPath) {
        try {
          const row = getDb().prepare("SELECT path FROM folders WHERE id = ?").get(fid);
          const resolvedPath = row?.path ? resolveStoredPath(row.path) : "";
          if (resolvedPath && fs.existsSync(resolvedPath)) {
            const wres = await _walkFolderWorker(resolvedPath);
            if (wres && wres.latestPath) {
              stats.latestPath = wres.latestPath;
              stats.recentPaths = (wres.recentPaths || []).slice(0, 3).map((p) => ({ file_path: p, thumbnail_path: null }));
              if (wres.realCount > 0) {
                stats.count = wres.realCount;
                stats.totalSize = wres.totalSize;
              }
              updateFolderCover(fid, wres.latestPath);
              _statsCache.set(fid, stats);
            }
          }
        } catch {
        }
      }
      const storedCover = getFolderStoredCover(fid);
      const resolvedStoredCover = storedCover ? resolveStoredPath(storedCover) : "";
      if (resolvedStoredCover && fs.existsSync(resolvedStoredCover)) {
        stats.latestPath = resolvedStoredCover;
        stats.latestThumb = discoverThumbnailPath(resolvedStoredCover) || "";
      }
      const toUrl = (p, thumb) => {
        const orig = encodeURIComponent(p);
        const t = thumb ? `&thumb=${encodeURIComponent(thumb)}` : "";
        return `picrand://get-image?orig=${orig}${t}`;
      };
      const coverUrl = stats.latestPath ? toUrl(stats.latestPath, stats.latestThumb || discoverThumbnailPath(stats.latestPath) || null) : "";
      const thumbUrls = [];
      for (const rp of (stats.recentPaths || []).slice(0, 3)) {
        const tp = rp.thumbnail_path || discoverThumbnailPath(rp.file_path) || null;
        thumbUrls.push(toUrl(rp.file_path, tp));
      }
      result[fid] = {
        count: stats.count,
        countCapped: !!stats.countCapped,
        totalSize: stats.totalSize,
        coverUrl,
        thumbUrls
      };
    } catch {
    }
  }
  return result;
});
electron.ipcMain.handle("preload-folder-stats", async () => {
  const folders = getAllFolders();
  await Promise.all(folders.map(async (f) => {
    try {
      await buildFolderStats(f.id);
    } catch {
    }
  }));
  return true;
});
electron.ipcMain.handle("select-cover-image", async (_event, folderPath) => {
  const result = await electron.dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [{ name: "图片", extensions: ["jpg", "jpeg", "png", "bmp", "webp", "gif", "tiff", "tif", "avif", "svg", "mp4", "webm", "mov", "mkv", "avi", "flv", "f4v"] }],
    defaultPath: fs.existsSync(folderPath) ? folderPath : void 0
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});
electron.ipcMain.handle("unfavorite-image", async (_event, sourcePath) => {
  updateFavorite(sourcePath, 0);
  return true;
});
electron.ipcMain.handle("set-image-rating", async (_event, filePath, rating) => {
  updateRating(filePath, rating);
  return true;
});
electron.ipcMain.handle("set-image-description", async (_event, filePath, desc) => {
  updateDescription(filePath, desc);
  return true;
});
electron.ipcMain.handle("clear-ratings-in-folder", async (_event, folderPath) => {
  const folderId = getOrCreateFolder(folderPath);
  return { cleared: clearRatingsInFolder(folderId) };
});
electron.ipcMain.handle("clear-descriptions-in-folder", async (_event, folderPath) => {
  const folderId = getOrCreateFolder(folderPath);
  return { cleared: clearDescriptionsInFolder(folderId) };
});
electron.ipcMain.handle("load-favorites", async () => {
  const favs = getFavoriteImages().map((img) => ({ ...img, is_favorite: 1 }));
  try {
    for (const img of favs) {
      if (!img.width || !img.height) {
        try {
          const d = await readImageDimensions(img.file_path);
          if (d) {
            img.width = d.width;
            img.height = d.height;
            updateImageDimensions(img.file_path, d.width, d.height);
          }
        } catch {
        }
      }
    }
  } catch {
  }
  return favs;
});
electron.ipcMain.handle("get-favorites-count", async () => {
  return getFavoritesCount();
});
electron.ipcMain.handle("save-as", async (_event, sourcePath) => {
  const result = await electron.dialog.showSaveDialog(mainWindow, { defaultPath: path.basename(sourcePath) });
  if (!result.canceled && result.filePath) {
    const fs2 = await import("fs-extra");
    await fs2.copy(sourcePath, result.filePath);
  }
  return !result.canceled;
});
electron.ipcMain.handle("save-as-batch", async (_event, sourcePaths, destFolder) => {
  const fse = await import("fs-extra");
  let copied = 0;
  for (const sp of sourcePaths) {
    try {
      const dest = path.join(destFolder, path.basename(sp));
      await fse.copy(sp, dest);
      copied++;
    } catch (e) {
      console.error("[save-as-batch] copy failed:", sp, e);
    }
  }
  return { success: true, count: copied, total: sourcePaths.length };
});
electron.ipcMain.handle("delete-image", async (_event, filePath) => {
  let fileRemoved = false;
  try {
    const trash = await import("trash");
    await trash.default([filePath], { glob: false });
    fileRemoved = true;
  } catch {
    try {
      fs.unlinkSync(filePath);
      fileRemoved = true;
    } catch {
    }
  }
  deleteImageByPath(filePath);
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("sync-db", { type: "unlink", path: filePath });
  } catch {
  }
  return { success: true, fileRemoved };
});
electron.ipcMain.handle("open-in-folder", (_event, filePath) => {
  electron.shell.showItemInFolder(filePath);
});
electron.ipcMain.handle("open-with-default", (_event, filePath) => {
  return electron.shell.openPath(filePath);
});
async function _clipboardSearch(filePath, url) {
  try {
    let clipPath = filePath;
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".psd") clipPath = await ensurePsdPng(filePath);
    else if (isVideoExt(ext)) {
      const png = getPosterPngPath(filePath);
      if (fs.existsSync(png)) clipPath = png;
      else {
        const p = await getOrGeneratePoster(filePath);
        clipPath = p && fs.existsSync(getPosterPngPath(filePath)) ? getPosterPngPath(filePath) : p;
      }
      if (!clipPath) return false;
    }
    if (!(/* @__PURE__ */ new Set([".jpg", ".jpeg", ".png", ".bmp"])).has(ext)) {
      const sharp = (await import("sharp")).default;
      const jpgPath = path.join(cacheDir, "search-" + crypto.createHash("md5").update(filePath).digest("hex") + ".jpg");
      if (!fs.existsSync(jpgPath)) await sharp(clipPath).resize({ width: 1920, withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(jpgPath);
      clipPath = jpgPath;
    }
    const { nativeImage: nativeImage2, clipboard } = await import("electron");
    const img = nativeImage2.createFromPath(clipPath);
    if (!img.isEmpty()) clipboard.writeImage(img);
    electron.shell.openExternal(url);
    return true;
  } catch {
    return false;
  }
}
electron.ipcMain.handle("yandex-search", (_e, fp) => _clipboardSearch(fp, "https://yandex.com/images/"));
electron.ipcMain.handle("saucenao-search", (_e, fp) => _clipboardSearch(fp, "https://saucenao.com/"));
electron.ipcMain.handle("tineye-search", (_e, fp) => _clipboardSearch(fp, "https://tineye.com/"));
electron.ipcMain.handle("tracemoe-search", (_e, fp) => _clipboardSearch(fp, "https://trace.moe/"));
electron.ipcMain.handle("googlelens-search", (_e, fp) => _clipboardSearch(fp, "https://lens.google.com/"));
electron.ipcMain.handle("import-images-to-folder", async (_event, imgPaths, destFolder) => {
  const fse = await import("fs-extra");
  const sharp = (await import("sharp")).default;
  let copied = 0;
  let firstDest = "";
  for (const src of imgPaths) {
    try {
      const ext = path.extname(src);
      const baseName = path.basename(src, ext);
      const name = path.basename(src);
      let dest = path.join(destFolder, name);
      let i = 1;
      while (await fse.pathExists(dest)) {
        dest = path.join(destFolder, `${baseName}(${i})${ext}`);
        i++;
      }
      await fse.copy(src, dest);
      copied++;
      if (!firstDest) firstDest = dest;
      try {
        const folderId = getOrCreateFolder(destFolder);
        const stat = fs.statSync(dest);
        let imgWidth = 0, imgHeight = 0;
        try {
          const d = await readImageDimensions(dest, sharp);
          if (d) {
            imgWidth = d.width;
            imgHeight = d.height;
          }
          if (!imgWidth || !imgHeight) {
            const { nativeImage: ni } = await import("electron");
            const img = ni.createFromPath(dest);
            if (!img.isEmpty()) {
              const s = img.getSize();
              imgWidth = s.width;
              imgHeight = s.height;
            }
          }
        } catch {
        }
        let thumbPath = "";
        try {
          const hashName = crypto.createHash("md5").update(dest).digest("hex") + ext;
          const outPath = path.join(cacheDir, hashName);
          const destExt = ext.toLowerCase();
          if (destExt === ".gif") {
            if (!fs.existsSync(outPath)) {
              await sharp(dest, { animated: true }).resize({ width: 400, withoutEnlargement: true }).gif({ colours: 48, dither: 1 }).toFile(outPath);
            }
            thumbPath = outPath;
          } else {
            const webpPath = outPath.replace(ext, ".webp");
            if (!fs.existsSync(webpPath)) {
              await sharp(dest).resize({ width: 400, withoutEnlargement: true }).webp({ quality: 75 }).toFile(webpPath);
            }
            thumbPath = webpPath;
          }
        } catch {
        }
        insertImage(folderId, dest, path.basename(dest), stat.size, Math.floor(stat.mtimeMs / 1e3), imgWidth, imgHeight, thumbPath);
        if (isFormatAllowed(dest) && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("sync-db", { type: "add", image: { file_path: dest, file_name: path.basename(dest), file_size: stat.size, modify_time: Math.floor(stat.mtimeMs / 1e3), thumbnail_path: thumbPath, width: imgWidth, height: imgHeight, is_favorite: 0 } });
        }
      } catch (e) {
        console.error("[import-images] db insert failed:", path.basename(dest), e?.message || e);
      }
    } catch (e) {
      console.error("[import-images] copy failed:", path.basename(src), e?.message || e);
    }
  }
  return { ok: true, copied, firstFile: firstDest || null };
});
electron.ipcMain.handle("copy-image-to-clipboard", async (_event, filePath) => {
  try {
    let cp = filePath;
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".psd") cp = await ensurePsdPng(filePath);
    else if (isVideoExt(ext)) {
      let png = getPosterPngPath(filePath);
      if (!fs.existsSync(png)) {
        const p = await getOrGeneratePoster(filePath);
        png = p && fs.existsSync(getPosterPngPath(filePath)) ? getPosterPngPath(filePath) : p;
      }
      cp = png;
    }
    const { nativeImage: nativeImage2, clipboard } = await import("electron");
    const img = nativeImage2.createFromPath(cp);
    if (!img.isEmpty()) {
      clipboard.writeImage(img);
      return true;
    }
    return false;
  } catch {
    return false;
  }
});
electron.ipcMain.handle("copy-files-to-clipboard", async (_event, filePaths) => {
  try {
    const valid = filePaths.filter((p) => fs.existsSync(p));
    if (!valid.length) return false;
    const { execFileSync } = await import("child_process");
    const lines = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$c=New-Object System.Collections.Specialized.StringCollection"
    ];
    for (const p of valid) lines.push(`$c.Add([System.IO.Path]::GetFullPath('${p.replace(/'/g, "''")}'))`);
    lines.push("[System.Windows.Forms.Clipboard]::SetFileDropList($c)");
    execFileSync("powershell", ["-STA", "-NoProfile", "-NonInteractive", "-Command", lines.join(";")], { timeout: 1e4, windowsHide: true });
    return true;
  } catch (e) {
    console.error("copy-files-to-clipboard:", e);
    return false;
  }
});
electron.ipcMain.handle("read-clipboard-files", async () => {
  try {
    const { execFileSync } = await import("child_process");
    const script = `Add-Type -AssemblyName System.Windows.Forms
	$paths = try { [System.Windows.Forms.Clipboard]::GetFileDropList() } catch { $null }
	if ($paths -and $paths.Count -gt 0) { [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes(($paths -join "|"))) } else { '' }`;
    const out = execFileSync("powershell", ["-STA", "-NoProfile", "-NonInteractive", "-Command", script], { timeout: 5e3, windowsHide: true, encoding: "utf-8" });
    const b64 = (out || "").trim();
    if (!b64) return [];
    const text = Buffer.from(b64, "base64").toString("utf-8");
    return text.split("|");
  } catch {
    return [];
  }
});
electron.ipcMain.handle("select-folder", async () => {
  const result = await electron.dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  return result.canceled ? null : result.filePaths[0];
});
electron.ipcMain.handle("select-folders", async () => {
  const result = await electron.dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "multiSelections"] });
  return result.canceled ? [] : result.filePaths;
});
electron.ipcMain.handle("select-image", async () => {
  const result = await electron.dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [{ name: "图片", extensions: ["jpg", "jpeg", "png", "bmp", "webp", "tiff", "tif", "avif", "svg"] }]
  });
  return result.canceled ? null : result.filePaths[0];
});
electron.ipcMain.handle("analyze-bg-brightness", async (_event, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const sharpMod = await import("sharp");
    const sharp = sharpMod.default || sharpMod;
    const resolved = await resolveForSharp(filePath);
    const stats = await sharp(resolved).stats();
    const [r, g, b] = stats.channels.map((c) => c.mean);
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luma >= 128 ? "bright" : "dark";
  } catch {
    return null;
  }
});
electron.ipcMain.handle("pinboards-read", () => readPinboards());
electron.ipcMain.handle("pinboards-create", (_event, name) => {
  const trimmed = (name || "").trim();
  if (!trimmed) return { error: true, message: "名称不能为空" };
  const data = readPinboards();
  if (data.boards.some((b) => b.name === trimmed)) return { error: true, message: "名称已存在" };
  const board = { id: createPinboardId(), name: trimmed, createdAt: (/* @__PURE__ */ new Date()).toISOString(), images: [], hotkey: "" };
  data.boards.push(board);
  data.currentId = board.id;
  return writePinboards(data);
});
electron.ipcMain.handle("pinboards-set-current", (_event, id) => {
  const data = readPinboards();
  if (id && data.boards.some((b) => b.id === id)) data.currentId = id;
  return writePinboards(data);
});
electron.ipcMain.handle("pinboards-rename", (_event, id, name) => {
  const trimmed = (name || "").trim();
  if (!trimmed) return { error: true, message: "名称不能为空" };
  const data = readPinboards();
  const board = data.boards.find((b) => b.id === id);
  if (!board) return { error: true, message: "图钉板不存在" };
  if (data.boards.some((b) => b.id !== id && b.name === trimmed)) return { error: true, message: "名称已存在" };
  board.name = trimmed;
  return writePinboards(data);
});
electron.ipcMain.handle("pinboards-set-hotkey", (_event, id, hotkey) => {
  const data = readPinboards();
  const board = data.boards.find((b) => b.id === id);
  if (!board) return { error: true, message: "图钉板不存在" };
  const key = (hotkey || "").trim();
  let displaced = null;
  if (key) {
    for (const b of data.boards) {
      if (b.id !== id && b.hotkey === key) {
        displaced = { name: b.name };
        b.hotkey = "";
      }
    }
  }
  board.hotkey = key;
  return { state: writePinboards(data), displaced };
});
electron.ipcMain.handle("pinboards-delete", (_event, id) => {
  const data = readPinboards();
  data.boards = data.boards.filter((b) => b.id !== id);
  if (data.currentId === id) data.currentId = data.boards[0]?.id || null;
  return writePinboards(data);
});
electron.ipcMain.handle("pinboards-clear", (_event, id) => {
  const data = readPinboards();
  const board = getPinboardOrThrow(data, id);
  board.images = [];
  return writePinboards(data);
});
electron.ipcMain.handle("pinboards-add-image", (_event, id, imagePath) => {
  const data = readPinboards();
  const board = getPinboardOrThrow(data, id);
  if (!board.images.some((i) => i.path === imagePath)) {
    board.images.push({ path: imagePath, addedAt: (/* @__PURE__ */ new Date()).toISOString() });
  }
  return writePinboards(data);
});
electron.ipcMain.handle("pinboards-reorder", (_event, orderedIds) => {
  const data = readPinboards();
  const idSet = new Map(data.boards.map((b) => [b.id, b]));
  const next = [];
  for (const id of orderedIds || []) {
    const b = idSet.get(id);
    if (b) {
      next.push(b);
      idSet.delete(b.id);
    }
  }
  for (const b of idSet.values()) next.push(b);
  data.boards = next;
  return writePinboards(data);
});
electron.ipcMain.handle("pinboards-remove-image", (_event, id, imagePath) => {
  const data = readPinboards();
  const board = getPinboardOrThrow(data, id);
  board.images = board.images.filter((i) => i.path !== imagePath);
  return writePinboards(data);
});
electron.ipcMain.handle("pinboards-export", async (_event, id) => {
  const data = readPinboards();
  const board = getPinboardOrThrow(data, id);
  const result = await electron.dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
  if (result.canceled || !result.filePaths[0]) return { canceled: true, count: 0, folderPath: "" };
  const folderPath = result.filePaths[0];
  let count = 0;
  for (const item of board.images) {
    try {
      await copyFileUnique(item.path, folderPath);
      count++;
    } catch (err) {
      logError(`[pinboard-export] ${item.path} - ${err}`);
    }
  }
  return { canceled: false, count, folderPath };
});
electron.ipcMain.handle("pinboards-export-to-folder", async (_event, id, folderPath) => {
  const data = readPinboards();
  const board = getPinboardOrThrow(data, id);
  let count = 0;
  for (const item of board.images) {
    try {
      await copyFileUnique(item.path, folderPath);
      count++;
    } catch (err) {
      logError(`[pinboard-export] ${item.path} - ${err}`);
    }
  }
  return { count, folderPath };
});
electron.ipcMain.handle("pinboards-has-nonempty", () => {
  const state = readPinboards();
  return state.boards.some((b) => b.images && b.images.length > 0);
});
electron.ipcMain.handle("pinboards-clear-all", () => {
  try {
    writePinboards({ currentId: null, boards: [] });
    return true;
  } catch {
    return false;
  }
});
electron.ipcMain.handle("start-watcher", async (_event, folderPath) => {
  if (!mainWindow) return;
  startWatching(
    folderPath,
    mainWindow,
    async (filePath) => {
      const fsMod = await import("fs");
      const stat = fsMod.statSync(filePath);
      const folderId = getOrCreateFolder(folderPath);
      let thumbPath = "", imgWidth = 0, imgHeight = 0;
      try {
        const sharp = (await import("sharp")).default;
        const ext = path.extname(filePath).toLowerCase();
        const hashName = crypto.createHash("md5").update(filePath).digest("hex") + ext;
        const outputPath = path.join(cacheDir, hashName);
        const fse = await import("fs-extra");
        try {
          const d = await readImageDimensions(filePath, sharp);
          if (d) {
            imgWidth = d.width;
            imgHeight = d.height;
          }
          if (!imgWidth || !imgHeight) {
            const { nativeImage: nativeImage2 } = await import("electron");
            const ni = nativeImage2.createFromPath(filePath);
            if (!ni.isEmpty()) {
              const s = ni.getSize();
              imgWidth = s.width;
              imgHeight = s.height;
            }
          }
        } catch {
        }
        if (await fse.pathExists(outputPath)) {
          thumbPath = outputPath;
        } else if (ext === ".gif") {
          try {
            await sharp(filePath, { animated: true }).resize({ width: 400, withoutEnlargement: true }).gif({ colours: 48, dither: 1 }).toFile(outputPath);
            thumbPath = outputPath;
          } catch (e) {
            console.error("[watcher] sharp gif failed, trying fallback:", path.basename(filePath), e?.message || e);
            logError(`[watcher-gif] ${path.basename(filePath)} - sharp failed: ${e?.message || e}`);
            const { nativeImage: nativeImage2 } = await import("electron");
            const img = nativeImage2.createFromPath(filePath);
            if (!img.isEmpty()) {
              if (!imgWidth) {
                const size = img.getSize();
                imgWidth = size.width;
                imgHeight = size.height;
              }
              const buf = img.resize({ width: 400 }).toJPEG(75);
              await fse.writeFile(outputPath, buf);
              thumbPath = outputPath;
            } else {
              logError(`[watcher-gif] ${path.basename(filePath)} - fallback also failed (isEmpty)`);
            }
          }
        } else if (ext === ".psd") {
          const webpPath = outputPath.replace(ext, ".webp");
          if (await fse.pathExists(webpPath)) {
            thumbPath = webpPath;
          } else {
            try {
              const pngPath = await ensurePsdPng(filePath);
              await sharp(pngPath).resize({ width: 400, withoutEnlargement: true }).webp({ quality: 75 }).toFile(webpPath);
              thumbPath = webpPath;
            } catch (e) {
              logError(`[watcher-psd] ${path.basename(filePath)} - convert failed: ${e?.message || e}`);
            }
          }
        } else if (isVideoExt(ext)) {
          const webpPath = outputPath.replace(ext, ".webp");
          if (await fse.pathExists(webpPath)) {
            thumbPath = webpPath;
          } else {
            try {
              const poster = await getOrGeneratePoster(filePath);
              if (poster) thumbPath = poster;
            } catch (e) {
              logError(`[watcher-video] ${path.basename(filePath)} - ${e?.message || e}`);
            }
          }
          if (!imgWidth || !imgHeight) {
            try {
              const d = await readVideoDimensions(filePath);
              if (d) {
                imgWidth = d.width;
                imgHeight = d.height;
              }
            } catch {
            }
          }
        } else {
          const webpPath = outputPath.replace(ext, ".webp");
          if (await fse.pathExists(webpPath)) {
            thumbPath = webpPath;
          } else {
            try {
              await sharp(filePath).resize({ width: 400, withoutEnlargement: true }).webp({ quality: 75 }).toFile(webpPath);
              thumbPath = webpPath;
            } catch (e) {
              console.error("[watcher] sharp failed, trying fallback:", path.basename(filePath), e?.message || e);
              logError(`[watcher-webp] ${path.basename(filePath)} - sharp failed: ${e?.message || e}`);
              const { nativeImage: nativeImage2 } = await import("electron");
              const img = nativeImage2.createFromPath(filePath);
              if (!img.isEmpty()) {
                if (!imgWidth) {
                  const size = img.getSize();
                  imgWidth = size.width;
                  imgHeight = size.height;
                }
                const jpgPath = webpPath.replace(/\.webp$/, ".jpg");
                const buf = img.resize({ width: 400 }).toJPEG(75);
                await fse.writeFile(jpgPath, buf);
                thumbPath = jpgPath;
              } else {
                logError(`[watcher-webp] ${path.basename(filePath)} - fallback also failed (isEmpty)`);
              }
            }
          }
        }
      } catch {
      }
      insertImage(folderId, filePath, path.basename(filePath), stat.size, Math.floor(stat.mtimeMs / 1e3), imgWidth, imgHeight, thumbPath);
      if (isFormatAllowed(filePath) && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("sync-db", { type: "add", image: { file_path: filePath, file_name: path.basename(filePath), file_size: stat.size, modify_time: Math.floor(stat.mtimeMs / 1e3), thumbnail_path: thumbPath, width: imgWidth, height: imgHeight, is_favorite: 0 } });
    },
    (filePath) => {
      deleteImageByPath(filePath);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("sync-db", { type: "unlink", path: filePath });
    }
  );
});
electron.ipcMain.handle("stop-watcher", () => {
  stopWatching();
});
electron.ipcMain.handle("recompute-sort-order", async (_event, folderId, sortMode, forceShuffle, hueOrigin) => {
  if ((sortMode === "dim-asc" || sortMode === "dim-desc") && pendingDimReads.has(folderId)) {
    await pendingDimReads.get(folderId);
  }
  recomputeSortOrder(folderId, sortMode, forceShuffle, hueOrigin ?? 0);
});
electron.ipcMain.handle("get-random-seed", (_event, folderId) => {
  return getFolderRandomSeed(folderId);
});
electron.ipcMain.handle("set-random-seed", (_event, folderId, seed) => {
  setFolderRandomSeed(folderId, seed);
});
electron.ipcMain.on("confirm-close-response", (_event, confirmed) => {
  if (confirmed) {
    allowClose = true;
    mainWindow?.close();
  }
});
electron.ipcMain.on("window-minimize", () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});
electron.ipcMain.on("window-maximize", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});
electron.ipcMain.on("window-close", () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});
electron.ipcMain.handle("window-is-maximized", () => mainWindow && !mainWindow.isDestroyed() ? mainWindow.isMaximized() : false);
electron.ipcMain.handle("window-is-always-on-top", () => mainWindow && !mainWindow.isDestroyed() ? mainWindow.isAlwaysOnTop() : false);
electron.ipcMain.on("window-toggle-always-on-top", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const next = !mainWindow.isAlwaysOnTop();
  if (next) {
    mainWindow.setAlwaysOnTop(true, "screen-saver");
  } else {
    mainWindow.setAlwaysOnTop(false);
  }
});
async function splitGifFrames(gifPath, id) {
  try {
    ;
    const tmpRoot = path.join(os.tmpdir(), "picrand-frames", id);
    if (fs.existsSync(tmpRoot)) {
      try {
        const rm = (await import("fs-extra")).remove;
        await rm(tmpRoot);
      } catch {
      }
    }
    fs.mkdirSync(tmpRoot, { recursive: true });
    const buf = fs.readFileSync(gifPath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const { parseGIF, decompressFrames } = require("gifuct-js");
    const parsed = parseGIF(ab);
    const all = decompressFrames(parsed, true);
    if (!all || all.length === 0) return null;
    const W = parsed.lsd.width, H = parsed.lsd.height;
    const sharpMod = (await import("sharp")).default;
    const delays = [];
    let comp = new Uint8Array(W * H * 4);
    let snap = null;
    const clearRect = (b, w, d) => {
      for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) {
        const di = ((d.top + y) * w + (d.left + x)) * 4;
        b[di] = b[di + 1] = b[di + 2] = b[di + 3] = 0;
      }
    };
    const putPatch = (b, w, patch, d) => {
      for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) {
        const si = (y * d.width + x) * 4, di = ((d.top + y) * w + (d.left + x)) * 4;
        const a = patch[si + 3];
        if (a > 0) {
          b[di] = patch[si];
          b[di + 1] = patch[si + 1];
          b[di + 2] = patch[si + 2];
          b[di + 3] = a;
        }
      }
    };
    const framePaths = [];
    for (let k = 0; k < all.length; k++) {
      const f = all[k];
      if (k > 0) {
        const pv = all[k - 1];
        if (pv.disposalType === 2) clearRect(comp, W, pv.dims);
        else if (pv.disposalType === 3 && snap) comp.set(snap);
      }
      if (f.disposalType === 3) snap = new Uint8Array(comp);
      putPatch(comp, W, f.patch, f.dims);
      const pngPath = path.join(tmpRoot, k + ".png");
      await sharpMod(Buffer.from(comp.buffer, comp.byteOffset, comp.byteLength), { raw: { width: W, height: H, channels: 4 } }).png().toFile(pngPath);
      framePaths.push(pngPath);
      delays.push(Math.max(20, f.delay || 100));
    }
    const enc = new TextEncoder();
    const pathBufs = framePaths.map((p) => enc.encode(p));
    let bodyLen = 4 + 4 + delays.length * 4;
    for (const b of pathBufs) bodyLen += 4 + b.length;
    const out = Buffer.alloc(bodyLen);
    let o = 0;
    out.write("GIF1", o, 4, "latin1");
    o += 4;
    out.writeInt32LE(framePaths.length, o);
    o += 4;
    for (const d of delays) {
      out.writeInt32LE(d, o);
      o += 4;
    }
    for (const b of pathBufs) {
      out.writeInt32LE(b.length, o);
      o += 4;
      bopy(Buffer.from(b.buffer, b.byteOffset, b.byteLength), out, o);
      o += b.length;
    }
    const manifestPath = path.join(tmpRoot, "manifest.bin");
    fs.writeFileSync(manifestPath, out);
    return { manifestPath };
  } catch (e) {
    console.error("[RefBoard] splitGifFrames failed:", e);
    return null;
  }
}
function bopy(src, dst, offset) {
  for (let i = 0; i < src.length; i++) dst[offset + i] = src[i];
}
let _refCascadeIdx = 0;
function computeCascadePos() {
  try {
    const wa = electron.screen.getPrimaryDisplay().workArea;
    const step = 32, tileW = 300, tileH = 220;
    const centerX = wa.x + Math.round((wa.width - tileW) / 2);
    const centerY = wa.y + Math.round((wa.height - tileH) / 2);
    const x = centerX + _refCascadeIdx * step;
    const y = centerY + _refCascadeIdx * step;
    if (x + tileW > wa.x + wa.width || y + tileH > wa.y + wa.height) {
      _refCascadeIdx = 1;
      return [centerX, centerY];
    }
    _refCascadeIdx++;
    return [x, y];
  } catch {
    return [-1, -1];
  }
}
async function createRefWin(_id, filePath, posX = -1, posY = -1) {
  const posArgs = posX >= 0 && posY >= 0 ? ["--x", String(posX), "--y", String(posY)] : [];
  try {
    const fse = await import("fs-extra");
    if (!await fse.pathExists(filePath)) {
      _logTray("createRefWin: FILE NOT FOUND: " + filePath);
      throw new Error("File not found: " + filePath);
    }
    _logTray("createRefWin: file exists, ext=" + path.extname(filePath).toLowerCase());
    if (path.extname(filePath).toLowerCase() === ".gif") {
      const res = await splitGifFrames(filePath, _id);
      if (res) {
        const appPath2 = electron.app.getAppPath();
        const candidates2 = [
          path.join(appPath2, "refboard", "RefBoardHost.exe"),
          path.join(appPath2, "resources", "refboard", "RefBoardHost.exe"),
          path.join(exeDir, "refboard", "RefBoardHost.exe"),
          path.join(exeDir, "resources", "refboard", "RefBoardHost.exe"),
          path.join(exeDir, "resources", "app", "refboard", "RefBoardHost.exe")
        ];
        const hostPath2 = candidates2.find((p) => fs.existsSync(p));
        if (!hostPath2) throw new Error("Reference board host is not bundled yet");
        const { spawn: spawn2 } = await import("child_process");
        const child2 = spawn2(hostPath2, ["--manifest", res.manifestPath, "--locale", currentLocale, ...posArgs], {
          detached: true,
          stdio: "ignore",
          windowsHide: true
        });
        if (child2.pid) {
          _refBoardPids.add(child2.pid);
          child2.on("exit", () => {
            _refBoardPids.delete(child2.pid);
            _logTray("pid " + child2.pid + " exited (manifest)");
          });
          _logTray("tracked pid " + child2.pid + " (GIF manifest) total=" + _refBoardPids.size);
        }
        child2.unref();
        return;
      }
    }
    let refPath = filePath;
    if (isVideoExt(path.extname(refPath).toLowerCase())) {
      let png = getPosterPngPath(refPath);
      if (!fs.existsSync(png)) {
        const p = await getOrGeneratePoster(refPath);
        png = p ? getPosterPngPath(refPath) : "";
      }
      refPath = png && fs.existsSync(png) ? png : getPosterPath(refPath);
    } else if (path.extname(refPath).toLowerCase() === ".psd") {
      refPath = await resolveForSharp(refPath);
    }
    const WIC_UNSUPPORTED = /* @__PURE__ */ new Set([".webp", ".avif", ".svg", ".heic", ".heif"]);
    const srcExt = path.extname(refPath).toLowerCase();
    if (WIC_UNSUPPORTED.has(srcExt)) {
      try {
        const cacheName = "refboard-" + crypto.createHash("md5").update(refPath).digest("hex") + ".png";
        const pngPath = path.join(cacheDir, cacheName);
        if (!fs.existsSync(pngPath)) {
          const sharpMod = (await import("sharp")).default;
          if (srcExt === ".svg") {
            await sharpMod(refPath, { density: 144 }).resize({ width: 2e3, withoutEnlargement: true }).png().toFile(pngPath);
          } else {
            await sharpMod(refPath).png().toFile(pngPath);
          }
        }
        refPath = pngPath;
      } catch (e) {
        console.error("[RefBoard] WIC-unsupported format conversion failed:", e);
      }
    }
    const refExt = path.extname(refPath).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(refExt)) {
      try {
        const refStat = fs.statSync(refPath);
        let needScale = refStat.size > 2 * 1024 * 1024;
        if (!needScale) {
          try {
            const refMeta = await (await import("sharp")).default(refPath).metadata();
            needScale = (refMeta.width || 0) > 2e3 || (refMeta.height || 0) > 2e3 || (refMeta.width || 0) * (refMeta.height || 0) > 4e6;
          } catch {
          }
        }
        if (needScale) {
          const tmpDir = path.join(dataDir, "tmp_refboard");
          if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
          const tmpPath = path.join(tmpDir, _id + ".jpg");
          const sharpMod = (await import("sharp")).default;
          await sharpMod(refPath).resize({ width: 1500, withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(tmpPath);
          refPath = tmpPath;
        }
      } catch (e) {
        console.error("[RefBoard] Pre-scale failed:", e);
      }
    }
    const appPath = electron.app.getAppPath();
    const candidates = [
      path.join(appPath, "refboard", "RefBoardHost.exe"),
      path.join(appPath, "resources", "refboard", "RefBoardHost.exe"),
      path.join(exeDir, "refboard", "RefBoardHost.exe"),
      path.join(exeDir, "resources", "refboard", "RefBoardHost.exe"),
      path.join(exeDir, "resources", "app", "refboard", "RefBoardHost.exe")
    ];
    const hostPath = candidates.find((p) => fs.existsSync(p));
    if (!hostPath) {
      _logTray("createRefWin: RefBoardHost.exe NOT FOUND in any candidate. appPath=" + appPath + " exeDir=" + exeDir);
      throw new Error("Reference board host is not bundled yet");
    }
    _logTray("createRefWin: hostPath=" + hostPath);
    const { spawn } = await import("child_process");
    const child = spawn(hostPath, ["--image", refPath, "--locale", currentLocale, ...posArgs], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    _logTray("createRefWin: spawned pid=" + child.pid + " args: --image " + refPath);
    child.on("error", (e) => {
      _logTray("createRefWin: spawn ERROR: " + (e?.message || String(e)));
    });
    if (child.pid) {
      _refBoardPids.add(child.pid);
      child.on("exit", (code) => {
        _refBoardPids.delete(child.pid);
        _logTray("pid " + child.pid + " exited code=" + code);
      });
      _logTray("tracked pid " + child.pid + " (image) total=" + _refBoardPids.size);
    }
    child.unref();
  } catch (error) {
    console.error("[RefBoard] Failed to create reference host:", error);
    throw error;
  }
}
electron.ipcMain.handle("open-ref-board", async (_event, filePath) => {
  try {
    _logTray(">>> open-ref-board filePath=" + filePath);
    const [cx, cy] = computeCascadePos();
    await createRefWin(crypto.randomUUID(), filePath, cx, cy);
    _logTray("<<< open-ref-board OK");
    return { ok: true };
  } catch (error) {
    _logTray("!!! open-ref-board FAILED: " + (error?.message || String(error)));
    console.error("[IPC] open-ref-board failed:", error);
    return { ok: false, error: error.message || String(error) };
  }
});
electron.ipcMain.handle("reset-ref-cascade", () => {
  _refCascadeIdx = 0;
});
const SHELL_MENU_KEY = "PicRandRefBoard";
const SHELL_MENU_EXTS = ["jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif", "ico", "heic", "heif", "avif", "svg"];
const SHELL_MENU_ROOT_FULL = `HKEY_CURRENT_USER\\Software\\Classes\\SystemFileAssociations`;
const SHELL_MENU_ROOT_SHORT = `HKCU\\Software\\Classes\\SystemFileAssociations`;
function resolveRefBoardHostPath() {
  const appPath = electron.app.getAppPath();
  const candidates = [
    path.join(appPath, "refboard", "RefBoardHost.exe"),
    path.join(appPath, "resources", "refboard", "RefBoardHost.exe"),
    path.join(exeDir, "refboard", "RefBoardHost.exe"),
    path.join(exeDir, "resources", "refboard", "RefBoardHost.exe"),
    path.join(exeDir, "resources", "app", "refboard", "RefBoardHost.exe")
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}
function runReg(args) {
  return new Promise((resolve) => {
    import("child_process").then(({ spawn }) => {
      const p = spawn("reg", args, { windowsHide: true });
      let stderr = "";
      p.stderr.on("data", (d) => {
        stderr += d.toString("utf8");
      });
      p.on("error", () => resolve({ code: 1, stderr: "failed to spawn reg.exe" }));
      p.on("close", (code) => resolve({ code: code ?? 1, stderr }));
    }).catch(() => resolve({ code: 1, stderr: "child_process unavailable" }));
  });
}
function buildRegContent(lines) {
  return "\uFEFF" + [
    "Windows Registry Editor Version 5.00",
    "",
    ...lines,
    ""
  ].join("\r\n");
}
async function regImport(lines) {
  const os2 = await import("os");
  const tmpPath = path.join(os2.tmpdir(), `picrand-shell-${Date.now()}-${Math.floor(Math.random() * 1e6)}.reg`);
  try {
    fs.writeFileSync(tmpPath, buildRegContent(lines), "utf16le");
    const r = await runReg(["import", tmpPath]);
    if (r.code !== 0) return { ok: false, error: r.stderr || `reg import exit ${r.code}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
    }
  }
}
electron.ipcMain.handle("install-shell-menu", async () => {
  try {
    const hostPath = resolveRefBoardHostPath();
    if (!hostPath) return { ok: false, error: "RefBoardHost.exe not found" };
    const label = "新建参考板";
    const regEsc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const iconVal = regEsc(hostPath);
    const cmdVal = regEsc(`"${hostPath}" --image "%1"`);
    const lines = [];
    for (const ext of SHELL_MENU_EXTS) {
      const base = `${SHELL_MENU_ROOT_FULL}\\.${ext}\\shell\\${SHELL_MENU_KEY}`;
      lines.push(`[${base}]`, `@="${regEsc(label)}"`, `"Icon"="${iconVal}"`, `[${base}\\command]`, `@="${cmdVal}"`, "");
    }
    return await regImport(lines);
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});
electron.ipcMain.handle("uninstall-shell-menu", async () => {
  try {
    let anyFail = null;
    for (const ext of SHELL_MENU_EXTS) {
      const basePath = `${SHELL_MENU_ROOT_SHORT}\\.${ext}\\shell\\${SHELL_MENU_KEY}`;
      const r = await runReg(["delete", basePath, "/f"]);
      if (r.code !== 0 && !/找不到|cannot find/i.test(r.stderr)) anyFail = r.stderr;
    }
    return anyFail ? { ok: false, error: anyFail } : { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});
electron.ipcMain.handle("shell-menu-status", async () => {
  try {
    const basePath = `${SHELL_MENU_ROOT_SHORT}\\.jpg\\shell\\${SHELL_MENU_KEY}`;
    const { code } = await runReg(["query", basePath]);
    return { installed: code === 0 };
  } catch {
    return { installed: false };
  }
});
const gotLock = electron.app.requestSingleInstanceLock();
if (!gotLock) {
  try {
    require("fs").appendFileSync(require("path").join(require("os").tmpdir(), "picrand-oversize-debug.log"), `[${(/* @__PURE__ */ new Date()).toISOString()}] second instance detected, exiting (old process is still running)
`);
  } catch {
  }
  electron.app.exit(0);
}
electron.app.on("second-instance", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showWindow();
  } else {
    createWindow();
  }
});
try {
  const { crashReporter } = require("electron");
  crashReporter.start({ productName: "PicRand", companyName: "PicRand", submitURL: "", uploadToServer: false });
} catch {
}
electron.app.whenReady().then(async () => {
  ensureDataDirs();
  initDatabase(dataDir);
  registerPicRandProtocol();
  createWindow();
  createTray();
  void initSteamStatus();
  try {
    (await import("sharp")).default.cache({ memory: 10, files: 0, items: 5 });
  } catch {
  }
  console.log("[boot] sharp cache set: memory=10MB files=0 items=5");
  try {
    fs.appendFileSync(path.join(dataDir, "perf-probe.log"), `[boot] ${(/* @__PURE__ */ new Date()).toISOString()} exe=${electron.app.getPath("exe")}
`);
  } catch {
  }
  {
    let _hbLast = Date.now();
    _hbInterval = setInterval(() => {
      const now = Date.now();
      const gap = now - _hbLast;
      _hbLast = now;
      if (gap > 800) {
        try {
          fs.appendFileSync(path.join(dataDir, "perf-probe.log"), `[heartbeat] gap=${gap}ms
`);
        } catch {
        }
      }
    }, 500);
  }
  _gcInterval = setInterval(() => {
    try {
      global.gc?.();
    } catch {
    }
  }, 3e4);
  try {
    setInterval(() => {
      try {
        const mu = process.memoryUsage();
        const rss = Math.round(mu.rss / 1024 / 1024);
        const heap = Math.round(mu.heapUsed / 1024 / 1024);
        const heapTotal = Math.round(mu.heapTotal / 1024 / 1024);
        const ext = Math.round(mu.external / 1024 / 1024);
        const ab = Math.round(mu.arrayBuffers / 1024 / 1024);
        const native = rss - heapTotal - ext;
        const metrics = electron.app.getAppMetrics();
        const parts = [
          `main=${rss}MB`,
          `heap=${heap}MB`,
          `heapTotal=${heapTotal}MB`,
          `ext=${ext}MB`,
          `ab=${ab}MB`,
          `native=${native}MB`,
          `cpuRun=${_cpuRunning}`,
          `vidRun=${_videoRunning}`
        ];
        for (const m of metrics) {
          const mb = Math.round((m.memory?.workingSetSize || 0) / 1024);
          if (m.type !== "Browser") parts.push(`${m.type || m.name || "proc"}=${mb}MB`);
        }
        fs.appendFileSync(path.join(dataDir, "memory-probe.log"), `[${(/* @__PURE__ */ new Date()).toISOString()}] ${parts.join(" ")}
`);
      } catch {
      }
    }, 3e3);
  } catch {
  }
  electron.globalShortcut.register("F12", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
      } else {
        mainWindow.webContents.openDevTools();
      }
    }
  });
  electron.globalShortcut.register("CommandOrControl+Shift+I", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
      } else {
        mainWindow.webContents.openDevTools();
      }
    }
  });
  mainWindow?.on("maximize", () => mainWindow?.webContents.send("window-state-changed", true));
  mainWindow?.on("unmaximize", () => mainWindow?.webContents.send("window-state-changed", false));
  mainWindow?.on("minimize", () => mainWindow?.webContents.send("window-state-changed", "minimized"));
  mainWindow?.on("restore", () => {
    mainWindow?.webContents.send("window-state-changed", "restored");
  });
  mainWindow?.on("show", () => {
  });
});
function cleanupOnExit() {
  try {
    const rmSync = require("fs").rmSync;
    if (fs.existsSync(cacheDir)) {
      try {
        const keepSet = /* @__PURE__ */ new Set();
        const folders = getAllFolders();
        for (const f of folders) {
          const cover = getFolderStoredCover(f.id);
          if (cover) {
            const tp = discoverThumbnailPath(resolveStoredPath(cover) || cover);
            if (tp) keepSet.add(tp);
          }
          const rows = getDb().prepare("SELECT thumbnail_path FROM images WHERE folder_id = ? AND thumbnail_path IS NOT NULL AND thumbnail_path != ? ORDER BY modify_time DESC LIMIT 10").all(f.id, "");
          for (const r of rows) {
            if (r.thumbnail_path && fs.existsSync(r.thumbnail_path)) keepSet.add(r.thumbnail_path);
          }
        }
        const cacheFiles = require("fs").readdirSync(cacheDir);
        for (const cf of cacheFiles) {
          if (cf.startsWith("psd-")) {
            keepSet.add(path.join(cacheDir, cf));
          }
        }
        for (const cf of cacheFiles) {
          const fullP = path.join(cacheDir, cf);
          if (!keepSet.has(fullP)) {
            try {
              require("fs").unlinkSync(fullP);
            } catch {
            }
          }
        }
      } catch (e) {
        try {
          rmSync(cacheDir, { recursive: true, force: true });
        } catch {
        }
      }
    }
    const framesDir = require("path").join(require("os").tmpdir(), "picrand-frames");
    if (fs.existsSync(framesDir)) {
      try {
        rmSync(framesDir, { recursive: true, force: true });
      } catch {
      }
    }
    try {
      const tmp = require("os").tmpdir();
      for (const f of require("fs").readdirSync(tmp)) {
        if (f.startsWith("picrand-") && (f.endsWith(".cjs") || f.endsWith(".log"))) {
          try {
            require("fs").unlinkSync(require("path").join(tmp, f));
          } catch {
          }
        }
      }
    } catch {
    }
    const refTmp = require("path").join(dataDir, "tmp_refboard");
    if (fs.existsSync(refTmp)) {
      try {
        rmSync(refTmp, { recursive: true, force: true });
      } catch {
      }
    }
    const logF = require("path").join(dataDir, "thumbnail-errors.log");
    if (fs.existsSync(logF)) {
      try {
        require("fs").unlinkSync(logF);
      } catch {
      }
    }
    if (_refBoardPids.size > 0) {
      for (const pid of _refBoardPids) {
        try {
          process.kill(pid);
        } catch {
        }
      }
      _refBoardPids.clear();
    }
  } catch {
  }
}
electron.app.on("before-quit", () => {
  if (_hbInterval) {
    clearInterval(_hbInterval);
    _hbInterval = null;
  }
  if (_gcInterval) {
    clearInterval(_gcInterval);
    _gcInterval = null;
  }
  _terminatePsdPoolNow();
  try {
    electron.globalShortcut.unregisterAll();
  } catch {
  }
  mainWindow = null;
  if (tray) {
    try {
      tray.destroy();
    } catch {
    }
    tray = null;
  }
  try {
    stopWatching();
  } catch {
  }
  try {
    const cfg = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf-8")) : {};
    if (cfg.pinboardEnabled !== false && cfg.pinboardMemoryEnabled === false) {
      writePinboards({ currentId: null, boards: [] });
    }
  } catch {
  }
});
electron.app.on("window-all-closed", () => {
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
});
