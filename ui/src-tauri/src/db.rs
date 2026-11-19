use rusqlite::{Connection, Result};
use std::path::Path;

pub fn open_conn_with_pragmas(db_path: &Path) -> Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.execute_batch("
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
    ")?;
    Ok(conn)
}

pub fn init_db(db_path: &Path) -> Result<Connection> {
    if let Some(parent) = db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(db_path)?;

    // WAL 模式 + 8MB 内存缓存限制，保障极致读写速度与内存低开销
    conn.execute_batch("
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        PRAGMA cache_size = -8000;
        PRAGMA temp_store = MEMORY;
    ")?;

    // 初始化 PicNest 基础核心表
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL UNIQUE,
            created_at INTEGER DEFAULT (strftime('%s', 'now'))
        );

        CREATE TABLE IF NOT EXISTS images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            folder_id INTEGER NOT NULL,
            file_path TEXT NOT NULL UNIQUE,
            thumbnail_path TEXT,
            width INTEGER DEFAULT 0,
            height INTEGER DEFAULT 0,
            size INTEGER DEFAULT 0,
            mtime INTEGER DEFAULT 0,
            last_opened_at INTEGER DEFAULT 0,
            rating INTEGER DEFAULT 0,
            is_favorite INTEGER DEFAULT 0,
            annotation TEXT DEFAULT '',
            url TEXT DEFAULT '',
            deleted_at INTEGER DEFAULT NULL,
            palettes TEXT DEFAULT NULL,
            trash_group INTEGER DEFAULT NULL,
            FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_images_deleted ON images(deleted_at);
        CREATE INDEX IF NOT EXISTS idx_images_folder_deleted ON images(folder_id, deleted_at, trash_group);
        CREATE INDEX IF NOT EXISTS idx_images_last_opened ON images(last_opened_at);
        CREATE INDEX IF NOT EXISTS idx_images_folder_size ON images(folder_id, size) WHERE deleted_at IS NULL;

        CREATE TABLE IF NOT EXISTS picnest_trash_folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            folder_id INTEGER NOT NULL,
            rel TEXT NOT NULL,
            abs_path TEXT NOT NULL,
            trash_path TEXT NOT NULL,
            name TEXT NOT NULL,
            image_count INTEGER DEFAULT 0,
            size INTEGER DEFAULT 0,
            deleted_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_trash_folders_folder ON picnest_trash_folders(folder_id, deleted_at);

        CREATE TABLE IF NOT EXISTS picnest_dir_memory (
            root_id INTEGER NOT NULL,
            rel TEXT NOT NULL,
            patch TEXT NOT NULL,
            PRIMARY KEY(root_id, rel)
        );

        CREATE TABLE IF NOT EXISTS tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL COLLATE NOCASE UNIQUE,
            created_at INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS image_tags (
            image_id INTEGER NOT NULL,
            tag_id INTEGER NOT NULL,
            created_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (image_id, tag_id),
            FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
            FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS picnest_dir_order (
            key TEXT PRIMARY KEY,
            names TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS picnest_kv (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_image_tags_tag ON image_tags(tag_id);
    ")?;

    let _ = conn.execute("ALTER TABLE images ADD COLUMN sort_order INTEGER DEFAULT 0", []);
    // 目录指纹：相对根的小写目录（正斜杠）。用来把「全库 LIKE 扫描」换成索引定位。
    // 允许 NULL：NULL 表示尚未回填，查询会把它当兵底一并纳入，不会漏图。
    let _ = conn.execute("ALTER TABLE images ADD COLUMN dir_rel TEXT", []);
    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_images_dirrel ON images(folder_id, dir_rel, sort_order, id)",
        [],
    );
    // 把过滤条件（deleted_at）一并放进索引前缀，查询计划才会选它而不是 folder_deleted
    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_images_nav ON images(folder_id, deleted_at, dir_rel, sort_order, id)",
        [],
    );
    // sync_dir_snapshot 按 (folder_id, dir_rel) 取本层行做 diff。
    // idx_images_dirrel 已经是 (folder_id, dir_rel, sort_order, id)，前缀直接命中；
    // 之前多建了一个同名近似的索引（idx_images_dir_rel），这里删掉避免重复写放大。
    let _ = conn.execute("DROP INDEX IF EXISTS idx_images_dir_rel", []);
    let _ = conn.execute("DROP INDEX IF EXISTS idx_images_file_path", []);
    let _ = conn.execute("DROP INDEX IF EXISTS idx_images_folder", []);
    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_images_folder_size ON images(folder_id, size) WHERE deleted_at IS NULL",
        [],
    );
    let _ = conn.execute(
        "CREATE TABLE IF NOT EXISTS picnest_img_hash (
            file_path TEXT PRIMARY KEY,
            size INTEGER NOT NULL,
            mtime INTEGER NOT NULL,
            dhash INTEGER NOT NULL,
            dhash_flip INTEGER NOT NULL,
            color BLOB NOT NULL,
            phash0 INTEGER NOT NULL,
            phash1 INTEGER NOT NULL,
            phash_flip0 INTEGER NOT NULL,
            phash_flip1 INTEGER NOT NULL
        )",
        [],
    );
    // 历史脏数据：早期版本把根层顺序写成 "<folder>|__root__"，而 dir_tree 读的是 "<folder>|"，
    // 那批行永远读不到。能搬到正确 key 的搬，搬不了（已有新值）的删。
    if let Ok(mut stmt) = conn.prepare("SELECT key, names FROM picnest_dir_order WHERE key LIKE '%|__root__'") {
        let stale: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default();
        drop(stmt);
        for (old_key, names) in stale {
            let new_key = old_key.replace("|__root__", "|");
            let exists: bool = conn
                .query_row("SELECT 1 FROM picnest_dir_order WHERE key = ?1", [&new_key], |_| Ok(true))
                .unwrap_or(false);
            if !exists {
                let _ = conn.execute("UPDATE picnest_dir_order SET key = ?1 WHERE key = ?2", [&new_key, &old_key]);
            } else {
                let _ = conn.execute("DELETE FROM picnest_dir_order WHERE key = ?1", [&old_key]);
                let _ = names;
            }
        }
    }
    // 缩略图格式迁移（无损 webp ~167KB → 有损 jpeg q80 ~28KB）已在 2026-11-14 离线完成：
    // 离线脚本把每张 webp 重编码成 {hash}-q80.jpg 并回写了 DB 路径。
    // 这里不再做「把 webp 路径置空」那种破坏性操作：那条路径一旦把 DB 清空，
    // 网格会退回加载原图（一张 1.2MB、解码 26ms），实测就是「不跟手」的最大来源。
    // 旧 webp 文件暂时留在缓存里作为回退，确认稳定后再清。
    let _ = conn.execute(
        "INSERT OR REPLACE INTO picnest_kv (key, value) VALUES ('thumbs_jpeg_v1', '1')",
        [],
    );
    let _ = conn.execute("ALTER TABLE images ADD COLUMN rating INTEGER DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE images ADD COLUMN is_favorite INTEGER DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE folders ADD COLUMN display_name TEXT DEFAULT ''", []);
    let palettes_cleaned: bool = conn
        .query_row(
            "SELECT 1 FROM picnest_kv WHERE key = 'palettes_v2_cleaned'",
            [],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if !palettes_cleaned {
        let _ = conn.execute(
            "UPDATE images SET palettes = NULL WHERE palettes IS NOT NULL AND palettes != '[]' AND CAST(json_extract(palettes, '$[0].percent') AS REAL) <= 1.0",
            [],
        );
        let _ = conn.execute(
            "UPDATE images SET palettes = NULL WHERE palettes = '[]' AND thumbnail_path IS NOT NULL AND thumbnail_path != 'SKIP'",
            [],
        );
        let _ = conn.execute(
            "INSERT OR REPLACE INTO picnest_kv (key, value) VALUES ('palettes_v2_cleaned', '1')",
            [],
        );
    }

    // 一次性兼容导入旧版 Electron (AppData\Roaming\PicNest\config.json 与 picrand.db) 的文件夹颜色、标签与手动排序
    migrate_legacy_electron_config(&conn);
    migrate_legacy_electron_data(&conn);
    heal_renamed_folders(&conn);
    backfill_dir_rel(&conn);

    Ok(conn)
}

fn migrate_legacy_electron_config(conn: &Connection) {
    let done: bool = conn
        .query_row(
            "SELECT value FROM picnest_kv WHERE key = 'legacy_config_migrated'",
            [],
            |r| r.get::<_, String>(0),
        )
        .is_ok();
    if done {
        return;
    }

    if let Some(roaming) = dirs::config_dir() {
        let cfg_path = roaming.join("PicNest").join("config.json");
        if cfg_path.exists() {
            if let Ok(text) = std::fs::read_to_string(&cfg_path) {
                if let Ok(cfg) = serde_json::from_str::<serde_json::Value>(&text) {
                    if let Some(mem_obj) = cfg.get("picnestDirMemory").and_then(|v| v.as_object()) {
                        for (k, v) in mem_obj {
                            if let Some((root_id_str, rel)) = k.split_once('|') {
                                if let Ok(root_id) = root_id_str.parse::<i64>() {
                                    if let Ok(patch_str) = serde_json::to_string(v) {
                                        let _ = conn.execute(
                                            "INSERT OR IGNORE INTO picnest_dir_memory (root_id, rel, patch) VALUES (?1, ?2, ?3)",
                                            rusqlite::params![root_id, rel, patch_str],
                                        );
                                    }
                                }
                            }
                        }
                    }
                    if let Some(order_obj) = cfg.get("picnestDirOrder").and_then(|v| v.as_object()) {
                        for (k, v) in order_obj {
                            if let Ok(names_str) = serde_json::to_string(v) {
                                let _ = conn.execute(
                                    "INSERT OR IGNORE INTO picnest_dir_order (key, names) VALUES (?1, ?2)",
                                    rusqlite::params![k, names_str],
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    let _ = conn.execute(
        "INSERT OR REPLACE INTO picnest_kv (key, value) VALUES ('legacy_config_migrated', '1')",
        [],
    );
}

fn strip_prefix_seg(name: &str) -> &str {
    if let Some(pos) = name.find('_') {
        let num = &name[..pos];
        if (1..=4).contains(&num.len()) && num.chars().all(|c| c.is_ascii_digit()) {
            let rest = &name[pos + 1..];
            if !(num.len() == 4
                && rest.len() >= 5
                && rest.as_bytes()[0].is_ascii_digit()
                && rest.as_bytes()[1].is_ascii_digit()
                && rest.as_bytes()[2] == b'_')
            {
                return rest;
            }
        }
    }
    name
}

pub(crate) fn resolve_disk_rel(root_path: &str, rel: &str) -> Option<String> {    let base = Path::new(root_path);
    if rel.is_empty() {
        return Some(String::new());
    }
    if base.join(rel.replace('/', "\\")).exists() {
        return Some(rel.to_string());
    }
    let mut cur_abs = base.to_path_buf();
    let mut resolved = Vec::new();
    for seg in rel.split('/').filter(|s| !s.is_empty()) {
        let exact = cur_abs.join(seg);
        if exact.is_dir() {
            cur_abs = exact;
            resolved.push(seg.to_string());
            continue;
        }
        let target_clean = strip_prefix_seg(seg).to_lowercase();
        let mut matched: Option<String> = None;
        if let Ok(entries) = std::fs::read_dir(&cur_abs) {
            for ent in entries.flatten() {
                if !ent.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                if let Ok(name) = ent.file_name().into_string() {
                    if strip_prefix_seg(&name).to_lowercase() == target_clean {
                        matched = Some(name);
                        break;
                    }
                }
            }
        }
        let hit = matched?;
        cur_abs = cur_abs.join(&hit);
        resolved.push(hit);
    }
    Some(resolved.join("/"))
}

fn migrate_legacy_electron_data(conn: &Connection) {
    let done: bool = conn
        .query_row(
            "SELECT value FROM picnest_kv WHERE key = 'legacy_electron_v2_migrated'",
            [],
            |r| r.get::<_, String>(0),
        )
        .is_ok();
    if done {
        return;
    }

    let Some(roaming) = dirs::config_dir() else {
        return;
    };
    let picnest_dir = roaming.join("PicNest");
    let old_db_path = picnest_dir.join("picrand.db");

    // 1. 当前根库 path -> (id, path)
    let mut new_roots: std::collections::HashMap<String, (i64, String)> = std::collections::HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT id, path FROM folders") {
        if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))) {
            for (id, p) in rows.flatten() {
                let norm = p.trim_end_matches(&['\\', '/'][..]).to_lowercase();
                new_roots.insert(norm, (id, p));
            }
        }
    }

    // 2. 从旧 Electron picrand.db 导入 tags、image_tags 与旧文件夹 ID 映射
    let mut old_id_to_new: std::collections::HashMap<String, (i64, String)> = std::collections::HashMap::new();
    if old_db_path.exists() {
        if let Ok(old_conn) = Connection::open_with_flags(
            &old_db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) {
            if let Ok(mut stmt) = old_conn.prepare("SELECT id, path FROM folders") {
                if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))) {
                    for (oid, opath) in rows.flatten() {
                        let norm = opath.trim_end_matches(&['\\', '/'][..]).to_lowercase();
                        if let Some(nr) = new_roots.get(&norm) {
                            old_id_to_new.insert(oid.to_string(), nr.clone());
                        }
                    }
                }
            }

            if let Ok(mut stmt) = old_conn.prepare("SELECT name, COALESCE(created_at, 0) FROM tags") {
                if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))) {
                    for (name, created_at) in rows.flatten() {
                        let clean = name.trim();
                        if !clean.is_empty() {
                            let _ = conn.execute(
                                "INSERT OR IGNORE INTO tags (name, created_at) VALUES (?1, ?2)",
                                rusqlite::params![clean, created_at],
                            );
                        }
                    }
                }
            }

            if let Ok(mut stmt) = old_conn.prepare(
                "SELECT i.file_path, t.name, COALESCE(it.created_at, 0)
                 FROM image_tags it
                 JOIN images i ON i.id = it.image_id
                 JOIN tags t ON t.id = it.tag_id",
            ) {
                if let Ok(rows) = stmt.query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                }) {
                    for (fp, tname, ts) in rows.flatten() {
                        if let Ok(img_id) = conn.query_row(
                            "SELECT id FROM images WHERE file_path = ?1 COLLATE NOCASE",
                            [&fp],
                            |r| r.get::<_, i64>(0),
                        ) {
                            if let Ok(tid) = conn.query_row(
                                "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE",
                                [tname.trim()],
                                |r| r.get::<_, i64>(0),
                            ) {
                                let _ = conn.execute(
                                    "INSERT OR IGNORE INTO image_tags (image_id, tag_id, created_at) VALUES (?1, ?2, ?3)",
                                    rusqlite::params![img_id, tid, ts],
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. 按旧->新根路径映射导入 config.json 里的 picnestDirMemory（带 NN_ 前缀偏移回溯）
    let cfg_path = picnest_dir.join("config.json");
    if cfg_path.exists() && !old_id_to_new.is_empty() {
        if let Ok(text) = std::fs::read_to_string(&cfg_path) {
            if let Ok(cfg) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(mem_obj) = cfg.get("picnestDirMemory").and_then(|v| v.as_object()) {
                    for (k, v) in mem_obj {
                        let Some((old_id_str, raw_rel)) = k.split_once('|') else { continue };
                        let Some((new_root_id, root_path)) = old_id_to_new.get(old_id_str) else { continue };
                        let Some(v_obj) = v.as_object() else { continue };
                        let target_rel = resolve_disk_rel(root_path, raw_rel).unwrap_or_else(|| raw_rel.to_string());

                        let existing: Option<String> = conn
                            .query_row(
                                "SELECT patch FROM picnest_dir_memory WHERE root_id = ?1 AND rel = ?2",
                                rusqlite::params![new_root_id, &target_rel],
                                |r| r.get(0),
                            )
                            .ok();
                        let mut merged = existing
                            .and_then(|s| serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&s).ok())
                            .unwrap_or_default();
                        for (pk, pv) in v_obj {
                            if pk == "coverThumb" {
                                continue;
                            }
                            merged.entry(pk.clone()).or_insert_with(|| pv.clone());
                        }
                        if let Ok(patch_str) = serde_json::to_string(&merged) {
                            let _ = conn.execute(
                                "INSERT INTO picnest_dir_memory (root_id, rel, patch) VALUES (?1, ?2, ?3)
                                 ON CONFLICT(root_id, rel) DO UPDATE SET patch = excluded.patch",
                                rusqlite::params![new_root_id, &target_rel, patch_str],
                            );
                        }
                    }
                }
            }
        }
    }

    let _ = conn.execute(
        "INSERT OR REPLACE INTO picnest_kv (key, value) VALUES ('legacy_electron_v2_migrated', '1')",
        [],
    );
}

fn extract_child_dir_under(parent: &Path, file_path: &str) -> Option<String> {
    let p_comps: Vec<String> = parent
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
        .collect();
    let f_comps: Vec<String> = Path::new(file_path)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();
    if f_comps.len() <= p_comps.len() {
        return None;
    }
    for (pc, fc) in p_comps.iter().zip(f_comps.iter()) {
        if pc != &fc.to_lowercase() {
            return None;
        }
    }
    let cand = &f_comps[p_comps.len()];
    if cand.is_empty() || !parent.join(cand).is_dir() {
        return None;
    }
    Some(cand.clone())
}

pub(crate) fn heal_renamed_folders(conn: &Connection) {
    let folders: Vec<(i64, String)> = match conn.prepare("SELECT id, path FROM folders") {
        Ok(mut stmt) => stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default(),
        Err(_) => return,
    };

    for (id, old_path) in folders {
        if Path::new(&old_path).exists() {
            continue;
        }
        let Some(parent) = Path::new(&old_path).parent() else {
            continue;
        };
        if !parent.exists() {
            continue;
        }

        let samples: Vec<String> = match conn.prepare("SELECT file_path FROM images WHERE folder_id = ?1 LIMIT 100") {
            Ok(mut stmt) => stmt
                .query_map([id], |r| r.get::<_, String>(0))
                .map(|rows| rows.flatten().collect())
                .unwrap_or_default(),
            Err(_) => continue,
        };
        if samples.is_empty() {
            continue;
        }

        let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for fp in &samples {
            if let Some(cand) = extract_child_dir_under(parent, fp) {
                *counts.entry(cand).or_insert(0) += 1;
            }
        }
        let Some((best_name, best_count)) = counts.into_iter().max_by_key(|(_, c)| *c) else {
            continue;
        };
        if best_count == 0 {
            continue;
        }

        let new_path = parent.join(&best_name).to_string_lossy().to_string();
        let _ = conn.execute(
            "UPDATE folders
             SET path = ?1,
                 display_name = CASE WHEN COALESCE(TRIM(display_name), '') = '' THEN ?2 ELSE display_name END
             WHERE id = ?3",
            rusqlite::params![&new_path, &best_name, id],
        );

        let old_prefix_bs = format!("{}\\", old_path.trim_end_matches(&['\\', '/'][..]));
        let old_prefix_fs = format!("{}/", old_path.trim_end_matches(&['\\', '/'][..]));
        let new_root_clean = new_path.trim_end_matches(&['\\', '/'][..]);

        if let Ok(mut stmt) = conn.prepare("SELECT rel, patch FROM picnest_dir_memory WHERE root_id = ?1") {
            let entries: Vec<(String, String)> = stmt
                .query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map(|rows| rows.flatten().collect())
                .unwrap_or_default();
            for (rel, patch_str) in entries {
                if let Ok(mut map) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&patch_str) {
                    if let Some(serde_json::Value::String(cp)) = map.get("coverPath").cloned() {
                        let cp_low = cp.to_lowercase();
                        let updated = if cp_low.starts_with(&old_prefix_bs.to_lowercase()) {
                            Some(format!("{}\\{}", new_root_clean, &cp[old_prefix_bs.len()..]))
                        } else if cp_low.starts_with(&old_prefix_fs.to_lowercase()) {
                            Some(format!("{}\\{}", new_root_clean, &cp[old_prefix_fs.len()..]))
                        } else {
                            None
                        };
                        if let Some(new_cp) = updated {
                            map.insert("coverPath".to_string(), serde_json::Value::String(new_cp));
                            if let Ok(s) = serde_json::to_string(&map) {
                                let _ = conn.execute(
                                    "UPDATE picnest_dir_memory SET patch = ?1 WHERE root_id = ?2 AND rel = ?3",
                                    rusqlite::params![s, id, rel],
                                );
                            }
                        }
                    }
                }
            }
        }
    }
}

/// 目录指纹：file_path 相对根目录的父目录（小写、正斜杠）。
pub(crate) fn dir_rel_of(root_path: &str, file_path: &str) -> String {
    let root = root_path
        .trim_end_matches(&['\\', '/'][..])
        .replace('/', "\\")
        .to_lowercase();
    let fp = file_path.replace('/', "\\").to_lowercase();
    if !fp.starts_with(&root) {
        return String::new();
    }
    let rest = fp[root.len()..].trim_start_matches('\\');
    match rest.rfind('\\') {
        Some(i) => rest[..i].replace('\\', "/"),
        None => String::new(),
    }
}

/// 回填 dir_rel（只处理 NULL 行，所以既是一次性迁移也是增量补齐）。
pub(crate) fn backfill_dir_rel(conn: &Connection) {
    let folders: Vec<(i64, String)> = match conn.prepare("SELECT id, path FROM folders") {
        Ok(mut s) => s
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default(),
        Err(_) => return,
    };
    for (fid, root) in folders {
        let rows: Vec<(i64, String)> = match conn
            .prepare("SELECT id, file_path FROM images WHERE folder_id = ?1 AND dir_rel IS NULL")
        {
            Ok(mut s) => s
                .query_map([fid], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
                .map(|r| r.flatten().collect())
                .unwrap_or_default(),
            Err(_) => continue,
        };
        if rows.is_empty() {
            continue;
        }
        if let Ok(tx) = conn.unchecked_transaction() {
            if let Ok(mut stmt) = tx.prepare("UPDATE images SET dir_rel = ?1 WHERE id = ?2") {
                for (id, fp) in rows {
                    let _ = stmt.execute(rusqlite::params![dir_rel_of(&root, &fp), id]);
                }
            }
            let _ = tx.commit();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heals_desynced_root_folder_path_from_images() {
        let base = std::env::temp_dir().join(format!("picnest_heal_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let new_dir = base.join("图").join("01_文档");
        std::fs::create_dir_all(&new_dir).unwrap();

        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE folders (id INTEGER PRIMARY KEY, path TEXT UNIQUE, display_name TEXT DEFAULT '', created_at INTEGER);
             CREATE TABLE images (id INTEGER PRIMARY KEY, folder_id INTEGER, file_path TEXT, dir_rel TEXT);
             CREATE TABLE picnest_dir_memory (root_id INTEGER, rel TEXT, patch TEXT, PRIMARY KEY (root_id, rel));",
        ).unwrap();

        let old_root = base.join("图源").to_string_lossy().to_string();
        let actual_root = base.join("图").to_string_lossy().to_string();
        let actual_file = new_dir.join("test.txt").to_string_lossy().to_string();
        conn.execute("INSERT INTO folders (id, path, display_name, created_at) VALUES (4, ?1, '', 1)", [&old_root]).unwrap();
        conn.execute("INSERT INTO images (id, folder_id, file_path, dir_rel) VALUES (1, 4, ?1, '01_文档')", [&actual_file]).unwrap();

        heal_renamed_folders(&conn);

        let (healed_path, healed_name): (String, String) = conn
            .query_row("SELECT path, display_name FROM folders WHERE id = 4", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(healed_path, actual_root);
        assert_eq!(healed_name, "图");

        let _ = std::fs::remove_dir_all(&base);
    }
}
