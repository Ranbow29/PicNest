//! 文件系统监听：库里任何目录的新增/删除/改名，防抖合并后通知前端自动同步。
//!
//! 为什么需要：图片列表来自数据库，不是实时读磁盘。以前只在「切进目录 1.2 秒后」扫一次，
//! 所以你停在一个目录里往其中丢图，界面不会自己更新，必须切走再切回。
//!
//! 开销：Windows 下走 ReadDirectoryChangesW（内核事件通知，缓冲 64KB），
//! 不轮询、不读文件内容，监听整棵树几乎零负担。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::Emitter;
use tauri::Manager;

/// 全局 Watcher 句柄，支持运行时动态添加新资料库到监听列表
static WATCHER: OnceLock<Mutex<RecommendedWatcher>> = OnceLock::new();

/// 运行时动态将新资料库根目录加入监听（无需重启）
pub fn watch_path(p: &Path) {
    if !p.exists() {
        return;
    }
    if let Some(lock) = WATCHER.get() {
        if let Ok(mut w) = lock.lock() {
            let _ = w.watch(p, RecursiveMode::Recursive);
        }
    }
}

/// 静默这么久之后收口（连续事件会一直延长，但有硬上限）
const QUIET_MS: u64 = 300;
const HARD_CAP_MS: u64 = 1800;

fn is_hidden_path(p: &Path) -> bool {
    p.components().any(|c| match c {
        std::path::Component::Normal(s) => {
            let name = s.to_string_lossy();
            name.starts_with('.') || name.eq_ignore_ascii_case("thumbs.db") || name.eq_ignore_ascii_case("desktop.ini")
        }
        _ => false,
    })
}

fn collect_events(
    ev: notify::Event,
    dirs: &mut HashSet<PathBuf>,
    removed: &mut HashSet<PathBuf>,
    created: &mut HashSet<PathBuf>,
) {
    match ev.kind {
        EventKind::Remove(_) => {
            // 删除：除了通知前端刷新，还要把库里对应记录（含整棵被删目录）软删
            for p in ev.paths {
                if is_hidden_path(&p) {
                    continue;
                }
                if let Some(parent) = p.parent() {
                    dirs.insert(parent.to_path_buf());
                }
                removed.insert(p);
            }
        }
        EventKind::Create(_) => {
            for p in ev.paths {
                if is_hidden_path(&p) {
                    continue;
                }
                if let Some(parent) = p.parent() {
                    dirs.insert(parent.to_path_buf());
                }
                if p.is_dir() {
                    dirs.insert(p.clone());
                }
                created.insert(p);
            }
        }
        EventKind::Modify(notify::event::ModifyKind::Name(_)) => {
            // Windows 重命名/移出/移入都会走 Name 事件：旧路径磁盘不存在走 removed，新路径存在走 created
            for p in ev.paths {
                if is_hidden_path(&p) {
                    continue;
                }
                if let Some(parent) = p.parent() {
                    dirs.insert(parent.to_path_buf());
                }
                if p.is_dir() {
                    dirs.insert(p.clone());
                }
                removed.insert(p.clone());
                created.insert(p);
            }
        }
        _ => {}
    }
}

/// 把被删掉的文件或目录在库里标记为删除（软删，可在回收站视图恢复）。
fn mark_removed(app: &tauri::AppHandle, paths: &[PathBuf]) {
    if paths.is_empty() {
        return;
    }
    let _filesystem_guard = crate::operation_journal::filesystem_operation_guard();
    let Some(state) = app.try_state::<crate::commands::AppState>() else {
        return;
    };
    let result = state.db.lock().map_err(|e| e.to_string()).and_then(|conn| mark_removed_inner(&conn, paths));
    if let Err(e) = result {
        crate::media_server::diag_push(&format!("watcher mark removed failed: {}", e));
    }
}

pub(crate) fn mark_removed_inner(conn: &rusqlite::Connection, paths: &[PathBuf]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    for p in paths {
        match std::fs::symlink_metadata(p) {
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("检查监听路径失败 {}: {error}", p.display())),
        }
        let s = p.to_string_lossy().to_string();
        let mut updated = tx.execute(
            "UPDATE images SET deleted_at = ?1 \
             WHERE file_path = ?2 AND deleted_at IS NULL",
            rusqlite::params![now, s],
        ).map_err(|e| e.to_string())?;
        if updated == 0 {
            updated = tx.execute(
                "UPDATE images SET deleted_at = ?1 \
                 WHERE file_path = ?2 COLLATE NOCASE AND deleted_at IS NULL",
                rusqlite::params![now, s],
            ).map_err(|e| e.to_string())?;
        }
        if updated == 0 {
            let trimmed = s.trim_end_matches(&['\\', '/'][..]);
            if !trimmed.is_empty() {
                let prefix_win = format!("{}\\", trimmed);
                let prefix_unix = format!("{}/", trimmed);
                tx.execute(
                    "UPDATE images SET deleted_at = ?1 \
                     WHERE deleted_at IS NULL \
                       AND (substr(file_path, 1, length(?2)) = ?2 COLLATE NOCASE \
                         OR substr(file_path, 1, length(?3)) = ?3 COLLATE NOCASE)",
                    rusqlite::params![now, prefix_win, prefix_unix],
                ).map_err(|e| e.to_string())?;
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

fn path_belongs_to_root(path_str: &str, root_str: &str) -> bool {
    let norm = |v: &str| v.replace('\\', "/").trim_end_matches('/').to_ascii_lowercase();
    let pn = norm(path_str);
    let rn = norm(root_str);
    !rn.is_empty() && (pn == rn || pn.starts_with(&format!("{rn}/")))
}

/// 将新建、复制或移入的目录/文件直接增量入库（递归新目录树，且不复活软删记录）。
fn sync_created_paths(app: &tauri::AppHandle, paths: &[PathBuf]) {
    if paths.is_empty() {
        return;
    }
    let _filesystem_guard = crate::operation_journal::filesystem_operation_guard();
    let Some(state) = app.try_state::<crate::commands::AppState>() else {
        return;
    };
    let result = state
        .db
        .lock()
        .map_err(|e| e.to_string())
        .and_then(|conn| sync_created_paths_inner(&conn, paths));
    if let Err(e) = result {
        crate::media_server::diag_push(&format!("watcher sync created failed: {}", e));
    }
}

pub(crate) fn sync_created_paths_inner(conn: &rusqlite::Connection, paths: &[PathBuf]) -> Result<usize, String> {
    if paths.is_empty() {
        return Ok(0);
    }
    let mut existing_dirs: Vec<PathBuf> = Vec::new();
    let mut existing_files: Vec<PathBuf> = Vec::new();
    for p in paths {
        if is_hidden_path(p) {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(p) else {
            continue;
        };
        if meta.file_type().is_dir() {
            existing_dirs.push(p.clone());
        } else if meta.file_type().is_file() {
            existing_files.push(p.clone());
        }
    }
    if existing_dirs.is_empty() && existing_files.is_empty() {
        return Ok(0);
    }

    // 去掉被祖先目录覆盖的子目录与单文件，防止重复扫盘
    existing_dirs.sort_by_key(|p| p.as_os_str().len());
    let mut top_dirs: Vec<PathBuf> = Vec::new();
    for d in existing_dirs {
        let d_str = d.to_string_lossy().to_string();
        if !top_dirs.iter().any(|parent| path_belongs_to_root(&d_str, &parent.to_string_lossy())) {
            top_dirs.push(d);
        }
    }

    let roots: Vec<(i64, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, path FROM folders ORDER BY LENGTH(path) DESC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        rows.flatten().collect()
    };
    if roots.is_empty() {
        return Ok(0);
    }

    let find_root = |p: &str| -> Option<(i64, &str)> {
        roots
            .iter()
            .find(|(_, rp)| path_belongs_to_root(p, rp))
            .map(|(id, rp)| (*id, rp.as_str()))
    };

    let mut to_upsert: Vec<(i64, String, i64, i64, String)> = Vec::new();
    let mut seen_files: HashSet<String> = HashSet::new();

    for d in &top_dirs {
        let d_str = d.to_string_lossy().to_string();
        let Some((folder_id, root_path)) = find_root(&d_str) else {
            continue;
        };
        for (fp, size, mtime) in crate::scanner::collect_folder_files(d) {
            let key = fp.to_ascii_lowercase();
            if seen_files.insert(key) {
                let dr = crate::db::dir_rel_of(root_path, &fp);
                to_upsert.push((folder_id, fp, size, mtime, dr));
            }
        }
    }

    for f in &existing_files {
        let fp = f.to_string_lossy().to_string();
        if top_dirs.iter().any(|parent| path_belongs_to_root(&fp, &parent.to_string_lossy())) {
            continue;
        }
        let ext = f.extension().and_then(|s| s.to_str()).unwrap_or("");
        if !crate::scanner::is_supported_ext(ext) {
            continue;
        }
        let Some((folder_id, root_path)) = find_root(&fp) else {
            continue;
        };
        let Ok(meta) = std::fs::metadata(f) else {
            continue;
        };
        let (size, mtime) = crate::scanner::file_size_and_mtime(Some(&meta));
        let key = fp.to_ascii_lowercase();
        if seen_files.insert(key) {
            let dr = crate::db::dir_rel_of(root_path, &fp);
            to_upsert.push((folder_id, fp, size, mtime, dr));
        }
    }

    if to_upsert.is_empty() {
        return Ok(0);
    }

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut touched = 0usize;
    {
        let mut stmt = tx
            .prepare_cached(
                "INSERT INTO images (folder_id, file_path, size, mtime, dir_rel) \
                 VALUES (?1, ?2, ?3, ?4, ?5) \
                 ON CONFLICT(file_path) DO UPDATE SET size = ?3, mtime = ?4, dir_rel = ?5 \
                 WHERE deleted_at IS NULL AND (size IS NOT ?3 OR mtime IS NOT ?4 OR dir_rel IS NOT ?5)",
            )
            .map_err(|e| e.to_string())?;
        for (folder_id, fp, size, mtime, dr) in &to_upsert {
            touched += stmt
                .execute(rusqlite::params![folder_id, fp, size, mtime, dr])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(touched)
}

pub fn start(app: tauri::AppHandle, roots: Vec<PathBuf>) {
    std::thread::spawn(move || {
        let (tx, rx) = channel::<notify::Result<notify::Event>>();
        let mut watcher = match RecommendedWatcher::new(tx, notify::Config::default()) {
            Ok(w) => w,
            Err(e) => {
                crate::media_server::diag_push(&format!("watcher init failed: {}", e));
                return;
            }
        };
        let mut watched = 0;
        for r in &roots {
            if r.exists() && watcher.watch(r, RecursiveMode::Recursive).is_ok() {
                watched += 1;
            }
        }
        crate::media_server::diag_push(&format!(
            "watcher watching {} / {} roots",
            watched,
            roots.len()
        ));
        let _ = WATCHER.set(Mutex::new(watcher));

        loop {
            // 先阻塞等第一个事件（没有事件时不占 CPU）
            let first = match rx.recv() {
                Ok(v) => v,
                Err(_) => return,
            };
            let mut dirs: HashSet<PathBuf> = HashSet::new();
            let mut removed: HashSet<PathBuf> = HashSet::new();
            let mut created: HashSet<PathBuf> = HashSet::new();
            if let Ok(ev) = first {
                collect_events(ev, &mut dirs, &mut removed, &mut created);
            }
            let hard_deadline = Instant::now() + Duration::from_millis(HARD_CAP_MS);
            loop {
                if Instant::now() >= hard_deadline {
                    break;
                }
                match rx.recv_timeout(Duration::from_millis(QUIET_MS)) {
                    Ok(Ok(ev)) => collect_events(ev, &mut dirs, &mut removed, &mut created),
                    Ok(Err(_)) => {}
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            let removed_list: Vec<PathBuf> = removed.into_iter().collect();
            let created_list: Vec<PathBuf> = created.into_iter().collect();
            // 先软删消失的文件/整棵目录，再递归入库新建/移入的目录与文件，最后通知前端刷新
            mark_removed(&app, &removed_list);
            sync_created_paths(&app, &created_list);
            if dirs.is_empty() {
                continue;
            }
            let list: Vec<String> = dirs
                .into_iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            let _ = app.emit("fs-dir-changed", serde_json::json!({ "dirs": list }));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mark_removed_does_not_soft_delete_a_recreated_file() {
        let dir = crate::testutil::TempDir::new("picnest_watcher_recreated");
        let conn = crate::db::init_db(&dir.join("test.db")).unwrap();
        conn.execute("INSERT INTO folders (path) VALUES (?1)", [dir.path().to_string_lossy().to_string()]).unwrap();
        let path = dir.join("image.png");
        conn.execute(
            "INSERT INTO images (folder_id, file_path, size, mtime) VALUES (?1, ?2, 5, 1)",
            rusqlite::params![conn.last_insert_rowid(), path.to_string_lossy().to_string()],
        ).unwrap();
        std::fs::write(&path, b"recreated").unwrap();
        mark_removed_inner(&conn, std::slice::from_ref(&path)).unwrap();
        let deleted: Option<i64> = conn.query_row("SELECT deleted_at FROM images", [], |r| r.get(0)).unwrap();
        assert_eq!(deleted, None);
        assert_eq!(std::fs::read(&path).unwrap(), b"recreated");
    }

    #[test]
    fn mark_removed_propagates_sql_and_commit_failures() {
        let dir = crate::testutil::TempDir::new("picnest_watcher_fault");
        let conn = crate::db::init_db(&dir.join("test.db")).unwrap();
        conn.execute("INSERT INTO folders (path) VALUES (?1)", [dir.path().to_string_lossy().to_string()]).unwrap();
        let folder_id = conn.last_insert_rowid();
        let path = dir.join("image.png");
        std::fs::write(&path, b"image").unwrap();
        conn.execute(
            "INSERT INTO images (folder_id, file_path, size, mtime) VALUES (?1, ?2, 5, 1)",
            rusqlite::params![folder_id, path.to_string_lossy().to_string()],
        ).unwrap();
        conn.execute_batch("CREATE TRIGGER reject_remove BEFORE UPDATE OF deleted_at ON images BEGIN SELECT RAISE(ABORT, 'injected watcher failure'); END;").unwrap();
        std::fs::remove_file(&path).unwrap();
        let error = mark_removed_inner(&conn, std::slice::from_ref(&path)).unwrap_err();
        assert!(error.contains("injected watcher failure"), "{error}");
        let deleted: Option<i64> = conn.query_row("SELECT deleted_at FROM images", [], |r| r.get(0)).unwrap();
        assert_eq!(deleted, None);
        conn.execute_batch("DROP TRIGGER reject_remove").unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA defer_foreign_keys = ON; CREATE TRIGGER defer_failure AFTER UPDATE OF deleted_at ON images BEGIN INSERT INTO images (folder_id, file_path, size, mtime) VALUES (999999, 'orphan.png', 1, 1); END;").unwrap();
        let error = mark_removed_inner(&conn, std::slice::from_ref(&path)).unwrap_err();
        assert!(error.contains("FOREIGN KEY"), "{error}");
        let deleted: Option<i64> = conn.query_row("SELECT deleted_at FROM images", [], |r| r.get(0)).unwrap();
        assert_eq!(deleted, None);
    }

    #[test]
    fn mark_removed_soft_deletes_entire_deleted_directory_without_touching_sibling() {
        let dir = crate::testutil::TempDir::new("picnest_watcher_rm_dir");
        let root = dir.join("library");
        let dir_a = root.join("A");
        let dir_a_sub = dir_a.join("sub");
        let dir_a2 = root.join("A2");
        let dir_a_copy = root.join("A_copy");
        std::fs::create_dir_all(&dir_a_sub).unwrap();
        std::fs::create_dir_all(&dir_a2).unwrap();
        std::fs::create_dir_all(&dir_a_copy).unwrap();

        let f1 = dir_a.join("1.png");
        let f2 = dir_a_sub.join("2.png");
        let f3 = dir_a2.join("3.png");
        let f4 = dir_a_copy.join("4.png");
        std::fs::write(&f1, b"1").unwrap();
        std::fs::write(&f2, b"2").unwrap();
        std::fs::write(&f3, b"3").unwrap();
        std::fs::write(&f4, b"4").unwrap();

        let conn = crate::db::init_db(&dir.join("test.db")).unwrap();
        conn.execute(
            "INSERT INTO folders (path) VALUES (?1)",
            [root.to_string_lossy().to_string()],
        )
        .unwrap();
        let fid = conn.last_insert_rowid();
        for fp in [&f1, &f2, &f3, &f4] {
            let fp_str = fp.to_string_lossy().to_string();
            let dr = crate::db::dir_rel_of(&root.to_string_lossy(), &fp_str);
            conn.execute(
                "INSERT INTO images (folder_id, file_path, size, mtime, dir_rel) VALUES (?1, ?2, 1, 1, ?3)",
                rusqlite::params![fid, fp_str, dr],
            )
            .unwrap();
        }

        std::fs::remove_dir_all(&dir_a).unwrap();
        mark_removed_inner(&conn, std::slice::from_ref(&dir_a)).unwrap();

        let is_deleted = |p: &Path| -> Option<i64> {
            conn.query_row(
                "SELECT deleted_at FROM images WHERE file_path = ?1",
                [p.to_string_lossy().to_string()],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert!(is_deleted(&f1).is_some(), "被删目录内直属文件应软删");
        assert!(is_deleted(&f2).is_some(), "被删目录内子目录文件应软删");
        assert!(is_deleted(&f3).is_none(), "兄弟目录 A2 不得被误伤");
        assert!(is_deleted(&f4).is_none(), "兄弟目录 A_copy 不得被误伤");
    }

    #[test]
    fn sync_created_paths_recursively_indexes_added_directory_and_skips_hidden() {
        let dir = crate::testutil::TempDir::new("picnest_watcher_add_dir");
        let root = dir.join("library");
        let new_dir = root.join("new_dir");
        let nested = new_dir.join("sub");
        let hidden = new_dir.join(".hidden");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::create_dir_all(&hidden).unwrap();

        let art = nested.join("art.png");
        let secret = hidden.join("x.png");
        let trashed = new_dir.join("trashed.png");
        std::fs::write(&art, b"artdata").unwrap();
        std::fs::write(&secret, b"secret").unwrap();
        std::fs::write(&trashed, b"trashed").unwrap();

        let conn = crate::db::init_db(&dir.join("test.db")).unwrap();
        conn.execute(
            "INSERT INTO folders (path) VALUES (?1)",
            [root.to_string_lossy().to_string()],
        )
        .unwrap();
        let fid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO images (folder_id, file_path, size, mtime, deleted_at, dir_rel) VALUES (?1, ?2, 1, 1, 888, 'new_dir')",
            rusqlite::params![fid, trashed.to_string_lossy().to_string()],
        )
        .unwrap();

        sync_created_paths_inner(&conn, std::slice::from_ref(&new_dir)).unwrap();

        let (dr, del): (String, Option<i64>) = conn
            .query_row(
                "SELECT dir_rel, deleted_at FROM images WHERE file_path = ?1",
                [art.to_string_lossy().to_string()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(dr, "new_dir/sub");
        assert_eq!(del, None);

        let hidden_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM images WHERE file_path = ?1",
                [secret.to_string_lossy().to_string()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hidden_count, 0, "隐藏目录内文件不应入库");

        let trashed_del: Option<i64> = conn
            .query_row(
                "SELECT deleted_at FROM images WHERE file_path = ?1",
                [trashed.to_string_lossy().to_string()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(trashed_del, Some(888), "已软删记录不得被意外复活");
    }
}
