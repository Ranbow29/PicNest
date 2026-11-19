use std::path::{Path, PathBuf};
use tauri::State;

use crate::commands::{
    now_ms, rebase_path_prefix, resolve_existing_thumb, with_read_conn,
    AppState, ImageItem,
};

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct TrashFolderRow {
    pub id: i64,
    pub folder_id: i64,
    pub rel: String,
    pub abs_path: String,
    pub trash_path: String,
    pub name: String,
    pub image_count: i64,
    pub size: i64,
    pub deleted_at: i64,
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("创建目标目录失败 {}: {}", dst.display(), e))?;
    let entries = std::fs::read_dir(src)
        .map_err(|e| format!("读取源目录失败 {}: {}", src.display(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        if ft.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)
                .map_err(|e| format!("复制文件失败 {} -> {}: {}", from.display(), to.display(), e))?;
        }
    }
    Ok(())
}

/// 同卷走 O(1) rename；跨卷或占锁回退为递归复制 + 原目录送入系统回收站（严禁物理强删）。
pub(crate) fn move_dir_cross_device_safe(src: &Path, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {}", e))?;
    }
    match std::fs::rename(src, dest) {
        Ok(()) => Ok(()),
        Err(rename_err) => {
            copy_dir_recursive(src, dest).map_err(|copy_err| {
                format!("移动目录失败（rename: {}; copy: {}）", rename_err, copy_err)
            })?;
            // Recycle Bin Only: 绝不物理强删源目录
            trash::delete(src)
                .map_err(|e| format!("已复制目录但原目录移入回收站失败: {}", e))?;
            Ok(())
        }
    }
}

fn trash_base_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("picnest-trash")
}

fn send_paths_to_recycle_bin(paths: &[PathBuf]) -> Result<(), String> {
    let existing: Vec<PathBuf> = paths.iter().filter(|p| p.exists()).cloned().collect();
    if existing.is_empty() {
        return Ok(());
    }
    if existing.len() == 1 {
        return trash::delete(&existing[0]).map_err(|e| format!("移入系统回收站失败: {}", e));
    }
    trash::delete_all(&existing).map_err(|e| format!("批量移入系统回收站失败: {}", e))
}

fn row_to_image_item(
    r: &rusqlite::Row<'_>,
    thumbs_dir: &Path,
) -> rusqlite::Result<ImageItem> {
    let file_path: String = r.get(2)?;
    let file_name = Path::new(&file_path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| file_path.clone());
    let raw_tp: Option<String> = r.get(7)?;
    let thumbnail_path = resolve_existing_thumb(raw_tp, &file_path, thumbs_dir);
    Ok(ImageItem {
        id: r.get(0)?,
        folder_id: r.get(1)?,
        file_path,
        file_name,
        file_size: r.get(3)?,
        modify_time: r.get(4)?,
        width: r.get(5)?,
        height: r.get(6)?,
        thumbnail_path,
        rating: r.get(12)?,
        is_favorite: r.get::<_, i64>(13).unwrap_or(0) != 0,
        last_opened_at: r.get(8)?,
        annotation: r.get(9)?,
        url: r.get(10)?,
        deleted_at: r.get(11)?,
    })
}

pub(crate) fn trash_remove_image_inner(
    conn: &rusqlite::Connection,
    file_path: &str,
    now: i64,
) -> Result<bool, String> {
    let changed = conn
        .execute(
            "UPDATE images SET deleted_at = ?1, trash_group = NULL WHERE file_path = ?2 AND deleted_at IS NULL",
            rusqlite::params![now, file_path],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed > 0)
}

pub(crate) fn trash_list_inner(
    conn: &rusqlite::Connection,
    folder_id: i64,
    thumbs_dir: &Path,
) -> Result<Vec<ImageItem>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, folder_id, file_path, size, mtime, width, height, thumbnail_path, last_opened_at, annotation, url, deleted_at, COALESCE(rating, 0), COALESCE(is_favorite, 0)
             FROM images
             WHERE folder_id = ?1 AND deleted_at IS NOT NULL AND trash_group IS NULL
             ORDER BY deleted_at DESC, id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([folder_id], |r| row_to_image_item(r, thumbs_dir))
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

pub(crate) fn trash_restore_image_inner(
    conn: &rusqlite::Connection,
    file_path: &str,
) -> Result<bool, String> {
    let changed = conn
        .execute(
            "UPDATE images SET deleted_at = NULL, trash_group = NULL WHERE file_path = ?1 AND deleted_at IS NOT NULL",
            [file_path],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed > 0)
}

/// 删一张图对应的所有缩略图变体。/// 永久删除必须带上它，否则每删一张图就在 cache/thumbs 里留一个孤儿文件；
/// 孤儿积到几万个后，任何全目录遍历（Defender 实时扫描、同步、诊断）
/// 都会变成磁盘风暴 —— 这就是 2026-11-15 那次磁盘 100% 的根因。
pub(crate) fn remove_thumbs_for(thumbs_dir: &Path, file_path: &str) {
    let h = format!("{:x}", crate::commands::fnv1a_hash(file_path.as_bytes()));
    for name in [
        format!("{}-q80.jpg", h),
        format!("{}.webp", h),
        format!("psd-{}.webp", h),
        format!("view-{}.webp", h),
    ] {
        let _ = std::fs::remove_file(thumbs_dir.join(name));
    }
}

fn db_delete_image_rows_by_path(conn: &rusqlite::Connection, file_path: &str) -> Result<bool, String> {    let _ = conn.execute(
        "DELETE FROM image_tags WHERE image_id IN (SELECT id FROM images WHERE file_path = ?1)",
        [file_path],
    );
    let changed = conn
        .execute("DELETE FROM images WHERE file_path = ?1", [file_path])
        .map_err(|e| e.to_string())?;
    Ok(changed > 0)
}

pub(crate) fn trash_folders_inner(
    conn: &rusqlite::Connection,
    folder_id: i64,
) -> Result<Vec<TrashFolderRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, folder_id, rel, abs_path, trash_path, name, COALESCE(image_count, 0), COALESCE(size, 0), deleted_at
             FROM picnest_trash_folders
             WHERE folder_id = ?1
             ORDER BY deleted_at DESC, id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([folder_id], |r| {
            Ok(TrashFolderRow {
                id: r.get(0)?,
                folder_id: r.get(1)?,
                rel: r.get(2)?,
                abs_path: r.get(3)?,
                trash_path: r.get(4)?,
                name: r.get(5)?,
                image_count: r.get(6)?,
                size: r.get(7)?,
                deleted_at: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

pub(crate) fn prepare_trash_folder_record(
    conn: &rusqlite::Connection,
    data_dir: &Path,
    dir_path: &str,
    rel: &str,
    root_id: i64,
    now: i64,
) -> Result<(i64, String, PathBuf, i64, i64, Vec<(i64, String, bool)>), String> {
    let dir_clean = dir_path.trim_end_matches(&['\\', '/'][..]).to_string();
    let src = Path::new(&dir_clean);
    if !src.exists() || !src.is_dir() {
        return Err("文件夹不存在".to_string());
    }
    let rel_clean = rel.trim_matches('/').to_string();
    let base_name = src
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "folder".to_string());

    let mut stmt = conn
        .prepare("SELECT id, file_path, COALESCE(size, 0), deleted_at IS NOT NULL FROM images WHERE folder_id = ?1")
        .map_err(|e| e.to_string())?;
    let candidates: Vec<(i64, String, i64, bool)> = stmt
        .query_map([root_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();

    let mut active_count: i64 = 0;
    let mut total_size: i64 = 0;
    let mut matched: Vec<(i64, String, bool)> = Vec::new();
    for (img_id, fp, sz, was_deleted) in candidates {
        if rebase_path_prefix(&fp, &dir_clean, &dir_clean).is_some() {
            if !was_deleted {
                active_count += 1;
                total_size += sz;
            }
            matched.push((img_id, fp, was_deleted));
        }
    }

    let trash_root = trash_base_dir(data_dir).join(root_id.to_string());
    std::fs::create_dir_all(&trash_root).map_err(|e| format!("创建图巢回收站目录失败: {}", e))?;

    conn.execute(
        "INSERT INTO picnest_trash_folders (folder_id, rel, abs_path, trash_path, name, image_count, size, deleted_at)
         VALUES (?1, ?2, ?3, '', ?4, ?5, ?6, ?7)",
        rusqlite::params![root_id, rel_clean, dir_clean, base_name, active_count, total_size, now],
    )
    .map_err(|e| e.to_string())?;
    let trash_id = conn.last_insert_rowid();
    let trash_path = trash_root.join(format!("{}-{}", trash_id, base_name));

    Ok((trash_id, dir_clean, trash_path, active_count, total_size, matched))
}

pub(crate) fn finalize_trash_folder_db(
    conn: &mut rusqlite::Connection,
    trash_id: i64,
    dir_clean: &str,
    trash_path_str: &str,
    now: i64,
    matched: &[(i64, String, bool)],
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE picnest_trash_folders SET trash_path = ?1 WHERE id = ?2",
        rusqlite::params![trash_path_str, trash_id],
    )
    .map_err(|e| e.to_string())?;

    for (img_id, old_fp, was_deleted) in matched {
        if let Some(new_fp) = rebase_path_prefix(old_fp, dir_clean, trash_path_str) {
            if *was_deleted {
                // 原本单独软删过的图片随目录搬家，用负 trash_group 标记以免还原目录时误恢复成正常图
                let _ = tx.execute(
                    "UPDATE images SET file_path = ?1, trash_group = ?2 WHERE id = ?3",
                    rusqlite::params![new_fp, -trash_id, img_id],
                );
            } else {
                let _ = tx.execute(
                    "UPDATE images SET file_path = ?1, deleted_at = ?2, trash_group = ?3 WHERE id = ?4",
                    rusqlite::params![new_fp, now, trash_id, img_id],
                );
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

pub(crate) fn compute_nonconflicting_restore_target(row: &TrashFolderRow) -> (PathBuf, String, String) {
    let desired = PathBuf::from(&row.abs_path);
    let parent = desired.parent().unwrap_or_else(|| Path::new("."));
    let orig_name = desired
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| row.name.clone());

    let mut target = desired.clone();
    let mut final_name = orig_name.clone();
    let mut n = 2i32;
    while target.exists() {
        final_name = format!("{} ({})", orig_name, n);
        target = parent.join(&final_name);
        n += 1;
    }

    let final_rel = if row.rel.contains('/') {
        let prefix = &row.rel[..row.rel.rfind('/').unwrap_or(0)];
        format!("{}/{}", prefix, final_name)
    } else {
        final_name.clone()
    };

    (target, final_rel, final_name)
}

pub(crate) fn finalize_restore_folder_db(
    conn: &mut rusqlite::Connection,
    row: &TrashFolderRow,
    dest_str: &str,
) -> Result<i64, String> {
    let rows: Vec<(i64, String, Option<i64>)> = {
        let mut stmt = conn
            .prepare("SELECT id, file_path, trash_group FROM images WHERE folder_id = ?1 AND (trash_group = ?2 OR trash_group = ?3)")
            .map_err(|e| e.to_string())?;
        stmt.query_map(rusqlite::params![row.folder_id, row.id, -row.id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(|e| e.to_string())?
        .flatten()
        .collect()
    };

    // 还原时目录可能因重名被改成 `name (2)`，file_path 变了
    // dir_rel 就必须跟着重算，否则还原出来的图在列表里查不到（徽章/树却在数）。
    let root_path: Option<String> = conn
        .query_row("SELECT path FROM folders WHERE id = ?1", [row.folder_id], |r| {
            r.get::<_, String>(0)
        })
        .ok();

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut restored_count: i64 = 0;
    for (img_id, old_fp, tg) in rows {
        let new_fp = rebase_path_prefix(&old_fp, &row.trash_path, dest_str).unwrap_or(old_fp);
        let dr = root_path
            .as_ref()
            .map(|r| crate::db::dir_rel_of(r, &new_fp))
            .unwrap_or_default();
        if tg == Some(-row.id) {
            let _ = tx.execute(
                "UPDATE images SET file_path = ?1, dir_rel = ?2, trash_group = NULL WHERE id = ?3",
                rusqlite::params![new_fp, dr, img_id],
            );
        } else {
            let _ = tx.execute(
                "UPDATE images SET file_path = ?1, dir_rel = ?2, deleted_at = NULL, trash_group = NULL WHERE id = ?3",
                rusqlite::params![new_fp, dr, img_id],
            );
            restored_count += 1;
        }
    }
    tx.execute("DELETE FROM picnest_trash_folders WHERE id = ?1", [row.id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(restored_count)
}

pub(crate) fn finalize_purge_folder_db(
    conn: &mut rusqlite::Connection,
    row: &TrashFolderRow,
    thumbs_dir: &Path,
) -> Result<i64, String> {
    // 先把这批图对应的缩略图删了，再删行（删行之后就查不到 file_path 了）
    {
        let paths: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT file_path FROM images WHERE folder_id = ?1 AND (trash_group = ?2 OR trash_group = ?3)")
                .map_err(|e| e.to_string())?;
            stmt.query_map(rusqlite::params![row.folder_id, row.id, -row.id], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .flatten()
                .collect()
        };
        for fp in &paths {
            remove_thumbs_for(thumbs_dir, fp);
        }
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let _ = tx.execute(
        "DELETE FROM image_tags WHERE image_id IN (SELECT id FROM images WHERE folder_id = ?1 AND (trash_group = ?2 OR trash_group = ?3))",
        rusqlite::params![row.folder_id, row.id, -row.id],
    );
    let deleted = tx
        .execute(
            "DELETE FROM images WHERE folder_id = ?1 AND (trash_group = ?2 OR trash_group = ?3)",
            rusqlite::params![row.folder_id, row.id, -row.id],
        )
        .map_err(|e| e.to_string())? as i64;
    tx.execute("DELETE FROM picnest_trash_folders WHERE id = ?1", [row.id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(deleted)
}

fn get_trash_folder_row(conn: &rusqlite::Connection, id: i64) -> Result<TrashFolderRow, String> {
    conn.query_row(
        "SELECT id, folder_id, rel, abs_path, trash_path, name, COALESCE(image_count, 0), COALESCE(size, 0), deleted_at
         FROM picnest_trash_folders WHERE id = ?1",
        [id],
        |r| {
            Ok(TrashFolderRow {
                id: r.get(0)?,
                folder_id: r.get(1)?,
                rel: r.get(2)?,
                abs_path: r.get(3)?,
                trash_path: r.get(4)?,
                name: r.get(5)?,
                image_count: r.get(6)?,
                size: r.get(7)?,
                deleted_at: r.get(8)?,
            })
        },
    )
    .map_err(|_| "回收站目录记录不存在".to_string())
}

fn restore_folder_by_id_blocking(
    db: &std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>,
    id: i64,
) -> serde_json::Value {
    let row = {
        let conn = match db.lock() {
            Ok(c) => c,
            Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }),
        };
        match get_trash_folder_row(&conn, id) {
            Ok(r) => r,
            Err(e) => return serde_json::json!({ "ok": false, "error": e }),
        }
    };

    let (target_path, final_rel, final_name) = compute_nonconflicting_restore_target(&row);
    let src_trash = Path::new(&row.trash_path);
    if !row.trash_path.is_empty() && src_trash.exists() {
        if let Err(e) = move_dir_cross_device_safe(src_trash, &target_path) {
            return serde_json::json!({ "ok": false, "error": e });
        }
    } else if let Err(e) = std::fs::create_dir_all(&target_path) {
        return serde_json::json!({ "ok": false, "error": e.to_string() });
    }

    let dest_str = target_path.to_string_lossy().to_string();
    let mut conn = match db.lock() {
        Ok(c) => c,
        Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }),
    };
    match finalize_restore_folder_db(&mut conn, &row, &dest_str) {
        Ok(count) => serde_json::json!({
            "ok": true,
            "path": dest_str,
            "rel": final_rel,
            "name": final_name,
            "count": count.max(row.image_count),
        }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    }
}

fn purge_folder_by_id_blocking(
    db: &std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>,
    id: i64,
    thumbs_dir: &Path,
) -> serde_json::Value {
    let row = {
        let conn = match db.lock() {
            Ok(c) => c,
            Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }),
        };
        match get_trash_folder_row(&conn, id) {
            Ok(r) => r,
            Err(e) => return serde_json::json!({ "ok": false, "error": e }),
        }
    };

    // 严禁物理强删：暂存目录必须移交 Windows 系统回收站
    if !row.trash_path.is_empty() {
        let p = Path::new(&row.trash_path);
        if p.exists() {
            if let Err(e) = trash::delete(p) {
                return serde_json::json!({ "ok": false, "error": format!("移入系统回收站失败: {}", e) });
            }
        }
    }

    let mut conn = match db.lock() {
        Ok(c) => c,
        Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }),
    };
    match finalize_purge_folder_db(&mut conn, &row, thumbs_dir) {
        Ok(count) => serde_json::json!({ "ok": true, "count": count.max(row.image_count) }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    }
}

// ---------------- Tauri Commands ----------------

#[tauri::command]
pub async fn trash_remove_image(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let db = state.db.clone();
    let now = now_ms();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        trash_remove_image_inner(&conn, &file_path, now)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn trash_list(
    folder_id: i64,
    state: State<'_, AppState>,
) -> Result<Vec<ImageItem>, String> {
    let db_path = state.db_path.clone();
    let thumbs_dir = state.data_dir.join("cache").join("thumbs");
    tauri::async_runtime::spawn_blocking(move || {
        with_read_conn(&db_path, |conn| trash_list_inner(conn, folder_id, &thumbs_dir))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn trash_restore_image(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        trash_restore_image_inner(&conn, &file_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn trash_purge_image(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let db = state.db.clone();
    let thumbs_dir = state.data_dir.join("cache").join("thumbs");
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&file_path);
        if p.exists() {
            if let Err(_) = trash::delete(p) {
                return Ok(false);
            }
        }
        // 原图删掉之后，缩略图也一并清 —— 不留孤儿
        remove_thumbs_for(&thumbs_dir, &file_path);
        let conn = db.lock().map_err(|e| e.to_string())?;
        db_delete_image_rows_by_path(&conn, &file_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_dir(
    dir_path: String,
    rel: Option<String>,
    root_id: i64,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db = state.db.clone();
    let data_dir = state.data_dir.clone();
    let rel_str = rel.unwrap_or_default();
    let now = now_ms();
    tauri::async_runtime::spawn_blocking(move || {
        let (trash_id, dir_clean, trash_path, active_count, total_size, matched) = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            match prepare_trash_folder_record(&conn, &data_dir, &dir_path, &rel_str, root_id, now) {
                Ok(v) => v,
                Err(e) => return Ok(serde_json::json!({ "ok": false, "error": e })),
            }
        };

        if let Err(e) = move_dir_cross_device_safe(Path::new(&dir_clean), &trash_path) {
            if let Ok(conn) = db.lock() {
                let _ = conn.execute("DELETE FROM picnest_trash_folders WHERE id = ?1", [trash_id]);
            }
            return Ok(serde_json::json!({ "ok": false, "error": e }));
        }

        let trash_path_str = trash_path.to_string_lossy().to_string();
        let mut conn = db.lock().map_err(|e| e.to_string())?;
        finalize_trash_folder_db(&mut conn, trash_id, &dir_clean, &trash_path_str, now, &matched)?;

        let name = Path::new(&dir_clean)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        Ok(serde_json::json!({
            "ok": true,
            "id": trash_id,
            "name": name,
            "count": active_count,
            "size": total_size,
            "soft": true,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn trash_folders(
    folder_id: i64,
    state: State<'_, AppState>,
) -> Result<Vec<TrashFolderRow>, String> {
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_read_conn(&db_path, |conn| trash_folders_inner(conn, folder_id))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn trash_restore_folder(
    id: i64,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || restore_folder_by_id_blocking(&db, id))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn trash_purge_folder(
    id: i64,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db = state.db.clone();
    let thumbs_dir = state.data_dir.join("cache").join("thumbs");
    tauri::async_runtime::spawn_blocking(move || purge_folder_by_id_blocking(&db, id, &thumbs_dir))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn trash_restore_all(
    folder_id: i64,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let folder_ids: Vec<i64> = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn
                .prepare("SELECT id FROM picnest_trash_folders WHERE folder_id = ?1 ORDER BY id ASC")
                .map_err(|e| e.to_string())?;
            stmt.query_map([folder_id], |r| r.get::<_, i64>(0))
                .map_err(|e| e.to_string())?
                .flatten()
                .collect()
        };

        let mut restored_folders = 0i64;
        let mut failed = 0i64;
        for fid in folder_ids {
            let r = restore_folder_by_id_blocking(&db, fid);
            if r.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                restored_folders += 1;
            } else {
                failed += 1;
            }
        }

        let conn = db.lock().map_err(|e| e.to_string())?;
        let restored_images = conn
            .execute(
                "UPDATE images SET deleted_at = NULL, trash_group = NULL WHERE folder_id = ?1 AND deleted_at IS NOT NULL AND trash_group IS NULL",
                [folder_id],
            )
            .map_err(|e| e.to_string())? as i64;

        Ok(serde_json::json!({
            "ok": true,
            "restoredFolders": restored_folders,
            "restoredImages": restored_images,
            "failed": failed,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn trash_purge_all(
    folder_id: i64,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db = state.db.clone();
    let thumbs_dir = state.data_dir.join("cache").join("thumbs");
    tauri::async_runtime::spawn_blocking(move || {
        let folder_ids: Vec<i64> = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn
                .prepare("SELECT id FROM picnest_trash_folders WHERE folder_id = ?1 ORDER BY id ASC")
                .map_err(|e| e.to_string())?;
            stmt.query_map([folder_id], |r| r.get::<_, i64>(0))
                .map_err(|e| e.to_string())?
                .flatten()
                .collect()
        };

        let mut purged_folders = 0i64;
        let mut failed = 0i64;
        for fid in folder_ids {
            let r = purge_folder_by_id_blocking(&db, fid, &thumbs_dir);
            if r.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                purged_folders += 1;
            } else {
                failed += 1;
            }
        }

        let single_paths: Vec<String> = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn
                .prepare(
                    "SELECT file_path FROM images WHERE folder_id = ?1 AND deleted_at IS NOT NULL AND trash_group IS NULL",
                )
                .map_err(|e| e.to_string())?;
            stmt.query_map([folder_id], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .flatten()
                .collect()
        };

        let mut purged_images = 0i64;
        if !single_paths.is_empty() {
            let disk_paths: Vec<PathBuf> = single_paths.iter().map(PathBuf::from).collect();
            let batch_ok = send_paths_to_recycle_bin(&disk_paths).is_ok();
            let mut ok_list = Vec::with_capacity(single_paths.len());
            for fp in single_paths {
                let p = Path::new(&fp);
                let ok_disk = if batch_ok {
                    true
                } else if p.exists() {
                    trash::delete(p).is_ok()
                } else {
                    true
                };
                if ok_disk {
                    ok_list.push(fp);
                } else {
                    failed += 1;
                }
            }
            let mut to_remove_thumbs = Vec::with_capacity(ok_list.len());
            {
                let mut conn = db.lock().map_err(|e| e.to_string())?;
                let tx = conn.transaction().map_err(|e| e.to_string())?;
                for fp in ok_list {
                    if db_delete_image_rows_by_path(&tx, &fp).unwrap_or(false) {
                        purged_images += 1;
                    }
                    to_remove_thumbs.push(fp);
                }
                tx.commit().map_err(|e| e.to_string())?;
            } // 释放 state.db.lock() 后再删磁盘缩略图
            for fp in to_remove_thumbs {
                remove_thumbs_for(&thumbs_dir, &fp);
            }
        }

        Ok(serde_json::json!({
            "ok": true,
            "purgedFolders": purged_folders,
            "purgedImages": purged_images,
            "failed": failed,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;

    fn make_temp_env(tag: &str) -> (crate::testutil::TempDir, PathBuf, rusqlite::Connection) {
        let base = crate::testutil::TempDir::new(&format!("picnest_trash_test_{}", tag));
        let data_dir = base.join("data");
        let root_dir = base.join("library");
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::create_dir_all(&root_dir).unwrap();
        let conn = init_db(&data_dir.join("picnest.db")).unwrap();
        (base, root_dir, conn)
    }

    #[test]
    fn single_image_soft_delete_and_restore_preserves_disk_file() {
        let (base, root_dir, conn) = make_temp_env("img");
        let data_dir = base.join("data");
        let thumbs_dir = data_dir.join("cache").join("thumbs");
        conn.execute(
            "INSERT INTO folders (id, path) VALUES (1, ?1)",
            [root_dir.to_string_lossy().to_string()],
        )
        .unwrap();
        let img_path = root_dir.join("sample.png");
        std::fs::write(&img_path, b"PNG").unwrap();
        let img_str = img_path.to_string_lossy().to_string();
        conn.execute(
            "INSERT INTO images (folder_id, file_path, size, mtime) VALUES (1, ?1, 3, 1000)",
            [&img_str],
        )
        .unwrap();

        assert!(trash_remove_image_inner(&conn, &img_str, 1700000000000).unwrap());
        assert!(img_path.exists(), "single-image soft delete must keep file on disk");

        let trashed = trash_list_inner(&conn, 1, &thumbs_dir).unwrap();
        assert_eq!(trashed.len(), 1);
        assert_eq!(trashed[0].file_path, img_str);
        assert_eq!(trashed[0].deleted_at, Some(1700000000000));

        assert!(trash_restore_image_inner(&conn, &img_str).unwrap());
        assert!(trash_list_inner(&conn, 1, &thumbs_dir).unwrap().is_empty());
        let deleted_at: Option<i64> = conn
            .query_row("SELECT deleted_at FROM images WHERE file_path = ?1", [&img_str], |r| r.get(0))
            .unwrap();
        assert_eq!(deleted_at, None);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn folder_soft_delete_and_restore_with_conflict_suffix() {
        let (base, root_dir, mut conn) = make_temp_env("dir");
        let data_dir = base.join("data");
        let thumbs_dir = data_dir.join("cache").join("thumbs");
        conn.execute(
            "INSERT INTO folders (id, path) VALUES (1, ?1)",
            [root_dir.to_string_lossy().to_string()],
        )
        .unwrap();

        let sub_a = root_dir.join("alpha");
        let sub_ab = root_dir.join("alphabet");
        std::fs::create_dir_all(&sub_a).unwrap();
        std::fs::create_dir_all(&sub_ab).unwrap();
        let f_in_a = sub_a.join("one.png");
        let f_in_ab = sub_ab.join("two.png");
        std::fs::write(&f_in_a, b"1234").unwrap();
        std::fs::write(&f_in_ab, b"5678").unwrap();
        let p_in_a = f_in_a.to_string_lossy().to_string();
        let p_in_ab = f_in_ab.to_string_lossy().to_string();

        conn.execute(
            "INSERT INTO images (folder_id, file_path, size, mtime) VALUES (1, ?1, 4, 1000)",
            [&p_in_a],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO images (folder_id, file_path, size, mtime) VALUES (1, ?1, 4, 1000)",
            [&p_in_ab],
        )
        .unwrap();

        let sub_a_str = sub_a.to_string_lossy().to_string();
        let (trash_id, dir_clean, trash_path, active_count, total_size, matched) =
            prepare_trash_folder_record(&conn, &data_dir, &sub_a_str, "alpha", 1, 1700000000123)
                .unwrap();
        assert_eq!(active_count, 1);
        assert_eq!(total_size, 4);
        assert_eq!(matched.len(), 1); // must NOT capture alphabet/two.png

        move_dir_cross_device_safe(Path::new(&dir_clean), &trash_path).unwrap();
        let trash_path_str = trash_path.to_string_lossy().to_string();
        finalize_trash_folder_db(&mut conn, trash_id, &dir_clean, &trash_path_str, 1700000000123, &matched)
            .unwrap();

        assert!(!sub_a.exists());
        assert!(trash_path.join("one.png").exists());
        assert!(f_in_ab.exists());
        assert!(trash_list_inner(&conn, 1, &thumbs_dir).unwrap().is_empty());

        let tf_rows = trash_folders_inner(&conn, 1).unwrap();
        assert_eq!(tf_rows.len(), 1);
        assert_eq!(tf_rows[0].image_count, 1);

        // Recreate alpha on disk to force non-conflicting suffix "alpha (2)"
        std::fs::create_dir_all(&sub_a).unwrap();
        let (dest_target, dest_rel, dest_name) = compute_nonconflicting_restore_target(&tf_rows[0]);
        assert_eq!(dest_name, "alpha (2)");
        assert_eq!(dest_rel, "alpha (2)");
        move_dir_cross_device_safe(&trash_path, &dest_target).unwrap();
        let dest_str = dest_target.to_string_lossy().to_string();
        let restored = finalize_restore_folder_db(&mut conn, &tf_rows[0], &dest_str).unwrap();
        assert_eq!(restored, 1);
        assert!(dest_target.join("one.png").exists());
        assert!(trash_folders_inner(&conn, 1).unwrap().is_empty());

        let new_fp: String = conn
            .query_row("SELECT file_path FROM images WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert!(new_fp.contains("alpha (2)"));

        let _ = std::fs::remove_dir_all(&base);
    }
}
