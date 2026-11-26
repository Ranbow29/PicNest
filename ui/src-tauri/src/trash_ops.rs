use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;
use sha2::{Digest, Sha256};

use crate::commands::{
    now_ms, rebase_path_prefix, resolve_existing_thumb, with_read_conn,
    AppState, ImageItem,
};

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq, Eq)]
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
    let entries = std::fs::read_dir(src)
        .map_err(|e| format!("读取源目录失败 {}: {}", src.display(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        if ft.is_symlink() {
            return Err(format!("跨卷目录复制不支持符号链接: {}", from.display()));
        }
        if ft.is_dir() {
            std::fs::create_dir(&to)
                .map_err(|e| format!("创建目标目录失败 {}: {}", to.display(), e))?;
            copy_dir_recursive(&from, &to)?;
        } else if ft.is_file() {
            let mut input = File::open(&from)
                .map_err(|e| format!("读取源文件失败 {}: {}", from.display(), e))?;
            let mut output = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&to)
                .map_err(|e| format!("创建目标文件失败 {}: {}", to.display(), e))?;
            io::copy(&mut input, &mut output)
                .map_err(|e| format!("复制文件失败 {} -> {}: {}", from.display(), to.display(), e))?;
            output.flush()
                .map_err(|e| format!("刷新目标文件失败 {}: {}", to.display(), e))?;
            output.sync_all()
                .map_err(|e| format!("落盘目标文件失败 {}: {}", to.display(), e))?;
        } else {
            return Err(format!("跨卷目录复制不支持的文件类型: {}", from.display()));
        }
    }
    Ok(())
}

fn hash_tree_contents(
    root: &Path,
    dir: &Path,
    hasher: &mut Sha256,
    staging_marker: Option<&Path>,
) -> Result<(), String> {
    let mut children = std::fs::read_dir(dir)
        .map_err(|e| format!("读取校验目录失败 {}: {}", dir.display(), e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("遍历校验目录失败 {}: {}", dir.display(), e))?;
    children.sort_by_key(|entry| entry.file_name());
    for child in children {
        let path = child.path();
        if staging_marker == Some(path.as_path()) {
            continue;
        }
        let rel = path.strip_prefix(root).map_err(|e| e.to_string())?;
        hasher.update((rel.as_os_str().as_encoded_bytes().len() as u64).to_le_bytes());
        hasher.update(rel.as_os_str().as_encoded_bytes());
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|e| format!("读取校验元数据失败 {}: {}", path.display(), e))?;
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            return Err(format!("跨卷目录复制不支持符号链接: {}", path.display()));
        }
        if file_type.is_dir() {
            hasher.update(b"dir");
            hash_tree_contents(root, &path, hasher, staging_marker)?;
        } else if file_type.is_file() {
            hasher.update(b"file");
            hasher.update(metadata.len().to_le_bytes());
            let mut file = File::open(&path)
                .map_err(|e| format!("读取校验文件失败 {}: {}", path.display(), e))?;
            io::copy(&mut file, hasher)
                .map_err(|e| format!("读取校验文件失败 {}: {}", path.display(), e))?;
        } else {
            return Err(format!("跨卷目录复制不支持的文件类型: {}", path.display()));
        }
    }
    Ok(())
}

pub(crate) fn staging_marker_path(staging: &Path, operation_id: i64) -> PathBuf {
    staging.join(format!(".picnest-operation-{operation_id}"))
}

pub(crate) fn tree_content_identity_for_staging(
    staging: &Path,
    operation_id: i64,
) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hasher.update(b"picnest-tree-content-v1");
    let marker = staging_marker_path(staging, operation_id);
    hash_tree_contents(staging, staging, &mut hasher, Some(&marker))?;
    Ok(format!("{:x}", hasher.finalize()))
}

fn tree_content_identity(root: &Path) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hasher.update(b"picnest-tree-content-v1");
    hash_tree_contents(root, root, &mut hasher, None)?;
    Ok(format!("{:x}", hasher.finalize()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DirMoveMode {
    Renamed,
    CopiedAndRecycled,
}

pub(crate) fn move_dir_cross_device_safe_mode(
    src: &Path,
    dest: &Path,
    operation_id: i64,
    record_staging: impl FnOnce(&Path, &str) -> Result<(), String>,
) -> Result<DirMoveMode, String> {
    if dest.exists() {
        return Err(format!("目标已存在，拒绝覆盖: {}", dest.display()));
    }
    let parent = dest.parent().ok_or("移动目录缺少目标父目录")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {}", e))?;
    match crate::fs_ops::rename_no_replace(src, dest) {
        Ok(()) => Ok(DirMoveMode::Renamed),
        Err(rename_err) if crate::fs_ops::is_cross_device_error(&rename_err) => {
            let expected = tree_content_identity(src)?;
            let nonce = crate::security::random_hex(8)?;
            let name = src.file_name().and_then(|n| n.to_str()).unwrap_or("folder");
            let staging = parent.join(format!(
                ".picnest-part-dir-{}-{}-{}", std::process::id(), nonce, name
            ));
            record_staging(&staging, &expected)?;
            std::fs::create_dir(&staging)
                .map_err(|e| format!("创建跨卷暂存目录失败 {}: {}", staging.display(), e))?;
            let mut staging_created = true;
            let result = (|| {
                copy_dir_recursive(src, &staging)?;
                if tree_content_identity(&staging)? != expected {
                    return Err("跨卷复制内容校验失败".to_string());
                }
                if tree_content_identity(src)? != expected {
                    return Err("跨卷复制期间源目录已变化，拒绝回收源目录".to_string());
                }
                let marker = staging_marker_path(&staging, operation_id);
                let mut marker_file = OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&marker)
                    .map_err(|e| format!("创建跨卷暂存恢复标记失败 {}: {e}", marker.display()))?;
                marker_file.write_all(operation_id.to_string().as_bytes())
                    .map_err(|e| format!("写入跨卷暂存恢复标记失败 {}: {e}", marker.display()))?;
                marker_file.sync_all()
                    .map_err(|e| format!("落盘跨卷暂存恢复标记失败 {}: {e}", marker.display()))?;
                drop(marker_file);
                std::fs::remove_file(&marker)
                    .map_err(|e| format!("清理跨卷暂存恢复标记失败 {}: {e}", marker.display()))?;
                crate::fs_ops::rename_no_replace(&staging, dest)
                    .map_err(|e| format!("发布跨卷目录失败 {}: {e}", dest.display()))?;
                staging_created = false;
                trash::delete(src)
                    .map_err(|e| format!("已复制目录但原目录移入回收站失败: {}", e))?;
                Ok(DirMoveMode::CopiedAndRecycled)
            })();
            match result {
                Ok(mode) => Ok(mode),
                Err(error) => {
                    if staging_created && staging.exists() {
                        if let Err(cleanup) = trash::delete(&staging) {
                            return Err(format!("{error}; 跨卷暂存目录移入回收站失败: {cleanup}"));
                        }
                    }
                    Err(error)
                }
            }
        }
        Err(rename_err) => Err(format!("移动目录失败: {rename_err}")),
    }
}

#[cfg(test)]
pub(crate) fn move_dir_cross_device_safe(src: &Path, dest: &Path) -> Result<(), String> {
    move_dir_cross_device_safe_mode(src, dest, 0, |_, _| Ok(())).map(|_| ())
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
    Ok(rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?)
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
    for name in crate::commands::thumbnail_filenames(&h) {
        let _ = std::fs::remove_file(thumbs_dir.join(name));
    }
}

fn db_delete_image_rows_by_path(conn: &rusqlite::Connection, file_path: &str) -> Result<bool, String> {    let changed = conn
        .execute("DELETE FROM image_tags WHERE image_id IN (SELECT id FROM images WHERE file_path = ?1)", [file_path])
        .map_err(|e| e.to_string())?;
    let _ = changed;
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
    Ok(rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?)
}

pub(crate) fn prepare_trash_folder_record(
    conn: &rusqlite::Connection,
    data_dir: &Path,
    dir_path: &str,
    rel: &str,
    root_id: i64,
    now: i64,
    identity: crate::operation_journal::PathMoveIdentity,
) -> Result<(i64, String, PathBuf, i64, i64, Vec<(i64, String, bool)>, crate::operation_journal::PathMove), String> {
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
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

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

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO picnest_trash_folders (folder_id, rel, abs_path, trash_path, name, image_count, size, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![root_id, rel_clean, dir_clean, trash_root.join(format!("pending-{now}")).to_string_lossy().to_string(), base_name, active_count, total_size, now],
    )
    .map_err(|e| e.to_string())?;
    let trash_id = tx.last_insert_rowid();
    let trash_path = trash_root.join(format!("{}-{}", trash_id, base_name));
    tx.execute("UPDATE picnest_trash_folders SET trash_path = ?1 WHERE id = ?2", rusqlite::params![trash_path.to_string_lossy().to_string(), trash_id])
        .map_err(|e| e.to_string())?;
    let operation = crate::operation_journal::begin_path_move(&tx, src, &trash_path, identity)?;
    crate::operation_journal::tag_path_move(
        &tx,
        operation.id,
        "folder_trash_pending",
        "prepared",
        serde_json::json!({ "trashId": trash_id }),
    )?;
    tx.commit().map_err(|e| e.to_string())?;

    Ok((trash_id, dir_clean, trash_path, active_count, total_size, matched, operation))
}

pub(crate) fn finalize_trash_folder_db(
    conn: &mut rusqlite::Connection,
    trash_id: i64,
    dir_clean: &str,
    trash_path_str: &str,
    now: i64,
    matched: &[(i64, String, bool)],
    operation_id: i64,
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let changed = tx.execute(
        "UPDATE picnest_trash_folders SET trash_path = ?1 WHERE id = ?2",
        rusqlite::params![trash_path_str, trash_id],
    ).map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("回收站目录记录已变化".to_string());
    }

    for (img_id, old_fp, was_deleted) in matched {
        if let Some(new_fp) = rebase_path_prefix(old_fp, dir_clean, trash_path_str) {
            if *was_deleted {
                // 原本单独软删过的图片随目录搬家，用负 trash_group 标记以免还原目录时误恢复成正常图
                let changed = tx.execute(
                    "UPDATE images SET file_path = ?1, trash_group = ?2 WHERE id = ?3",
                    rusqlite::params![new_fp, -trash_id, img_id],
                ).map_err(|e| e.to_string())?;
                if changed != 1 { return Err(format!("更新回收站图片失败: {img_id}")); }
            } else {
                let changed = tx.execute(
                    "UPDATE images SET file_path = ?1, deleted_at = ?2, trash_group = ?3 WHERE id = ?4",
                    rusqlite::params![new_fp, now, trash_id, img_id],
                ).map_err(|e| e.to_string())?;
                if changed != 1 { return Err(format!("更新回收站图片失败: {img_id}")); }
            }
        }
    }
    crate::operation_journal::finish_in_tx(&tx, operation_id)?;
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
    operation_id: i64,
) -> Result<i64, String> {
    let rows: Vec<(i64, String, Option<i64>)> = {
        let mut stmt = conn
            .prepare("SELECT id, file_path, trash_group FROM images WHERE folder_id = ?1 AND (trash_group = ?2 OR trash_group = ?3)")
            .map_err(|e| e.to_string())?;
        stmt.query_map(rusqlite::params![row.folder_id, row.id, -row.id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
    };

    // 还原时目录可能因重名被改成 `name (2)`，file_path 变了
    // dir_rel 就必须跟着重算，否则还原出来的图在列表里查不到（徽章/树却在数）。
    let root_path: String = conn
        .query_row("SELECT path FROM folders WHERE id = ?1", [row.folder_id], |r| {
            r.get::<_, String>(0)
        })
        .map_err(|e| e.to_string())?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut restored_count: i64 = 0;
    for (img_id, old_fp, tg) in rows {
        let new_fp = rebase_path_prefix(&old_fp, &row.trash_path, dest_str).unwrap_or(old_fp);
        let dr = crate::db::dir_rel_of(&root_path, &new_fp);
        let changed = if tg == Some(-row.id) {
            tx.execute(
                "UPDATE images SET file_path = ?1, dir_rel = ?2, trash_group = NULL WHERE id = ?3",
                rusqlite::params![new_fp, dr, img_id],
            ).map_err(|e| e.to_string())?
        } else {
            tx.execute(
                "UPDATE images SET file_path = ?1, dir_rel = ?2, deleted_at = NULL, trash_group = NULL WHERE id = ?3",
                rusqlite::params![new_fp, dr, img_id],
            ).map_err(|e| e.to_string())?
        };
        if changed != 1 { return Err(format!("更新还原图片失败: {img_id}")); }
        if tg != Some(-row.id) {
            restored_count += 1;
        }
    }
    let changed = tx.execute("DELETE FROM picnest_trash_folders WHERE id = ?1", [row.id])
        .map_err(|e| e.to_string())?;
    if changed != 1 { return Err("回收站目录记录已变化".to_string()); }
    crate::operation_journal::finish_in_tx(&tx, operation_id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(restored_count)
}

pub(crate) fn finalize_purge_folder_db(
    conn: &mut rusqlite::Connection,
    row: &TrashFolderRow,
    thumbs_dir: &Path,
    operation_id: Option<i64>,
) -> Result<i64, String> {
    // 先把这批图对应的缩略图删了，再删行（删行之后就查不到 file_path 了）
    {
        let paths: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT file_path FROM images WHERE folder_id = ?1 AND (trash_group = ?2 OR trash_group = ?3)")
                .map_err(|e| e.to_string())?;
            stmt.query_map(rusqlite::params![row.folder_id, row.id, -row.id], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        for fp in &paths {
            remove_thumbs_for(thumbs_dir, fp);
        }
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM image_tags WHERE image_id IN (SELECT id FROM images WHERE folder_id = ?1 AND (trash_group = ?2 OR trash_group = ?3))",
        rusqlite::params![row.folder_id, row.id, -row.id],
    ).map_err(|e| e.to_string())?;
    let deleted = tx
        .execute(
            "DELETE FROM images WHERE folder_id = ?1 AND (trash_group = ?2 OR trash_group = ?3)",
            rusqlite::params![row.folder_id, row.id, -row.id],
        )
        .map_err(|e| e.to_string())? as i64;
    tx.execute("DELETE FROM picnest_trash_folders WHERE id = ?1", [row.id])
        .map_err(|e| e.to_string())?;
    if let Some(operation_id) = operation_id {
        crate::operation_journal::finish_in_tx(&tx, operation_id)?;
    }
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

fn record_cross_volume_staging(
    db: &Arc<Mutex<rusqlite::Connection>>,
    operation: &crate::operation_journal::PathMove,
    staging: &Path,
    sha256: &str,
) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    crate::operation_journal::extend_path_move_payload(
        &conn,
        operation.id,
        serde_json::json!({
            "crossVolume": true,
            "stagingPath": staging.to_string_lossy(),
            "stagingSha256": sha256
        }),
    )
}

fn abort_path_move(
    db: &Arc<Mutex<rusqlite::Connection>>,
    operation: &crate::operation_journal::PathMove,
) -> Result<(), String> {
    crate::operation_journal::rollback_path_files(operation)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    crate::operation_journal::finish_in_tx(&tx, operation.id)?;
    tx.commit().map_err(|e| e.to_string())
}

fn abort_folder_trash(
    db: &Arc<Mutex<rusqlite::Connection>>,
    trash_id: i64,
    operation: &crate::operation_journal::PathMove,
) -> Result<(), String> {
    crate::operation_journal::rollback_path_files(operation)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let changed = tx.execute("DELETE FROM picnest_trash_folders WHERE id = ?1", [trash_id])
        .map_err(|e| e.to_string())?;
    if changed != 1 { return Err("回收站目录记录已变化".to_string()); }
    crate::operation_journal::finish_in_tx(&tx, operation.id)?;
    tx.commit().map_err(|e| e.to_string())
}

fn mark_path_manual(
    conn: &rusqlite::Connection,
    operation: &crate::operation_journal::PathMove,
    error: &str,
) {
    let _ = crate::operation_journal::mark_manual(conn, operation.id, error);
}

fn restore_folder_by_id_blocking(
    db: &std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>,
    id: i64,
) -> serde_json::Value {
    let _filesystem_guard = crate::operation_journal::filesystem_operation_guard();
    let row = {
        let conn = match db.lock() {
            Ok(c) => c,
            Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }),
        };
        match get_trash_folder_row(&conn, id) {
            Ok(row) => row,
            Err(e) => return serde_json::json!({ "ok": false, "error": e }),
        }
    };
    let src_trash = Path::new(&row.trash_path);
    if row.trash_path.is_empty() || !src_trash.is_dir() {
        return serde_json::json!({ "ok": false, "error": "回收站目录缺失，拒绝创建空目录" });
    }
    let identity = match crate::operation_journal::capture_path_identity(src_trash) {
        Ok(identity) => identity,
        Err(e) => return serde_json::json!({ "ok": false, "error": e }),
    };
    let payload = serde_json::json!({ "trashId": id });
    let (row, operation, final_rel, final_name, payload) = {
        let conn = match db.lock() {
            Ok(c) => c,
            Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }),
        };
        let current_row = match get_trash_folder_row(&conn, id) {
            Ok(row) => row,
            Err(e) => return serde_json::json!({ "ok": false, "error": e }),
        };
        if current_row != row {
            return serde_json::json!({ "ok": false, "error": "回收站目录记录已变化" });
        }
        let (target_path, final_rel, final_name) = compute_nonconflicting_restore_target(&current_row);
        let operation = match crate::operation_journal::begin_path_move(&conn, src_trash, &target_path, identity) {
            Ok(op) => op,
            Err(e) => return serde_json::json!({ "ok": false, "error": e }),
        };
        if let Err(e) = crate::operation_journal::tag_path_move(&conn, operation.id, "folder_restore_pending", "prepared", payload.clone()) {
            let _ = conn.execute("DELETE FROM picnest_operations WHERE id = ?1", [operation.id]);
            return serde_json::json!({ "ok": false, "error": e });
        }
        (current_row, operation, final_rel, final_name, payload)
    };

    let mode = match move_dir_cross_device_safe_mode(&operation.source, &operation.target, operation.id, |staging, sha256| {
        record_cross_volume_staging(&db, &operation, staging, sha256)
    }) {
        Ok(mode) => mode,
        Err(e) => {
            if let Err(rollback) = abort_path_move(&db, &operation) {
                if let Ok(conn) = db.lock() {
                    mark_path_manual(&conn, &operation, &format!("{e}; {rollback}"));
                }
            }
            return serde_json::json!({ "ok": false, "error": e });
        }
    };

    let dest_str = operation.target.to_string_lossy().to_string();
    let mut conn = match db.lock() {
        Ok(c) => c,
        Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }),
    };
    if let Err(e) = crate::operation_journal::tag_path_move(
        &conn,
        operation.id,
        if mode == DirMoveMode::Renamed { "folder_restore_rename" } else { "folder_restore_copy" },
        "file_applied",
        payload,
    ) {
        if mode == DirMoveMode::Renamed {
            drop(conn);
            if let Err(rollback) = abort_path_move(&db, &operation) {
                if let Ok(conn) = db.lock() {
                    mark_path_manual(&conn, &operation, &format!("{e}; {rollback}"));
                }
            }
        } else {
            mark_path_manual(&conn, &operation, &format!("{e}; 跨卷源目录已进入回收站，禁止自动逆向恢复"));
        }
        return serde_json::json!({ "ok": false, "error": e });
    }
    match finalize_restore_folder_db(&mut conn, &row, &dest_str, operation.id) {
        Ok(count) => serde_json::json!({
            "ok": true,
            "path": dest_str,
            "rel": final_rel,
            "name": final_name,
            "count": count.max(row.image_count),
        }),
        Err(e) => {
            if mode == DirMoveMode::Renamed {
                drop(conn);
                if let Err(rollback) = abort_path_move(&db, &operation) {
                    if let Ok(conn) = db.lock() {
                        mark_path_manual(&conn, &operation, &format!("{e}; {rollback}"));
                    }
                }
            } else {
                mark_path_manual(&conn, &operation, &format!("{e}; 跨卷源目录已进入回收站，禁止自动逆向恢复"));
            }
            serde_json::json!({ "ok": false, "error": e })
        }
    }
}

fn purge_folder_by_id_blocking(
    db: &std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>,
    id: i64,
    thumbs_dir: &Path,
) -> serde_json::Value {
    let _filesystem_guard = crate::operation_journal::filesystem_operation_guard();
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
    let path = Path::new(&row.trash_path);
    let identity = if !row.trash_path.is_empty() && path.exists() {
        match crate::operation_journal::capture_path_identity(path) {
            Ok(identity) if identity.directory => Some(identity),
            Ok(_) => return serde_json::json!({ "ok": false, "error": "回收站路径不是目录" }),
            Err(e) => return serde_json::json!({ "ok": false, "error": e }),
        }
    } else {
        None
    };
    let operation_id = {
        let conn = match db.lock() {
            Ok(c) => c,
            Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }),
        };
        let current = match get_trash_folder_row(&conn, id) {
            Ok(r) => r,
            Err(e) => return serde_json::json!({ "ok": false, "error": e }),
        };
        if current.trash_path != row.trash_path {
            return serde_json::json!({ "ok": false, "error": "回收站目录记录已变化" });
        }
        if !row.trash_path.is_empty() && path.exists() {
            let Some(identity) = identity.clone() else {
                return serde_json::json!({ "ok": false, "error": "回收站目录身份缺失" });
            };
            match crate::operation_journal::create(
                &conn,
                "folder_purge",
                "prepared",
                &row.trash_path,
                "",
                serde_json::json!({
                    "version": 2, "identity": crate::operation_journal::METADATA_IDENTITY, "directory": true,
                    "size": identity.size, "sha256": identity.sha256, "trashId": id
                }),
            ) {
                Ok(operation_id) => Some(operation_id),
                Err(e) => return serde_json::json!({ "ok": false, "error": e }),
            }
        } else {
            None
        }
    };

    // 严禁物理强删：暂存目录必须移交 Windows 系统回收站
    if let Some(operation_id) = operation_id {
        let path = Path::new(&row.trash_path);
        if let Some(expected) = identity {
            match crate::operation_journal::capture_path_identity(path) {
                Ok(current) if current.directory == expected.directory
                    && current.size == expected.size && current.sha256 == expected.sha256 => {}
                Ok(_) | Err(_) => {
                    let message = "回收站目录在清除前已变化，拒绝自动恢复";
                    if let Ok(conn) = db.lock() {
                        let _ = crate::operation_journal::mark_manual(&conn, operation_id, message);
                    }
                    return serde_json::json!({ "ok": false, "error": message });
                }
            }
        }
        if let Err(e) = trash::delete(path) {
            let conn = match db.lock() {
                Ok(c) => c,
                Err(lock_error) => return serde_json::json!({ "ok": false, "error": format!("{e}; {lock_error}") }),
            };
            if let Err(cleanup) = conn.unchecked_transaction().map_err(|e| e.to_string())
                .and_then(|tx| crate::operation_journal::finish_in_tx(&tx, operation_id).and_then(|_| tx.commit().map_err(|e| e.to_string()))) {
                let _ = crate::operation_journal::mark_manual(&conn, operation_id, &format!("{e}; {cleanup}"));
            }
            return serde_json::json!({ "ok": false, "error": format!("移入系统回收站失败: {}", e) });
        }
    }

    let mut conn = match db.lock() {
        Ok(c) => c,
        Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }),
    };
    match finalize_purge_folder_db(&mut conn, &row, thumbs_dir, operation_id) {
        Ok(count) => serde_json::json!({ "ok": true, "count": count.max(row.image_count) }),
        Err(e) => {
            if let Some(operation_id) = operation_id {
                let _ = crate::operation_journal::mark_manual(&conn, operation_id, &e);
            }
            serde_json::json!({ "ok": false, "error": e })
        }
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

fn trash_purge_image_sync(
    db: &Arc<Mutex<rusqlite::Connection>>,
    thumbs_dir: &Path,
    file_path: &str,
) -> Result<bool, String> {
    let _filesystem_guard = crate::operation_journal::filesystem_operation_guard();
    let mut conn = db.lock().map_err(|e| e.to_string())?;
    let operation_id = crate::operation_journal::create(
        &conn,
        "image_purge",
        "prepared",
        file_path,
        file_path,
        serde_json::json!({ "version": 1 }),
    )?;
    let path = Path::new(file_path);
    if path.exists() {
        if let Err(e) = trash::delete(path) {
            let cleanup = conn.unchecked_transaction().map_err(|e| e.to_string())
                .and_then(|tx| crate::operation_journal::finish_in_tx(&tx, operation_id)
                    .and_then(|_| tx.commit().map_err(|e| e.to_string())));
            if let Err(cleanup) = cleanup {
                let _ = crate::operation_journal::mark_manual(&conn, operation_id, &format!("{e}; {cleanup}"));
            }
            return Err(format!("移入系统回收站失败: {e}"));
        }
    }
    let result: Result<bool, String> = (|| {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let changed = db_delete_image_rows_by_path(&tx, file_path)?;
        crate::operation_journal::finish_in_tx(&tx, operation_id)?;
        tx.execute(
            "DELETE FROM picnest_operations WHERE kind = 'image_purge' AND id != ?1 AND LOWER(source_path) = LOWER(?2)",
            rusqlite::params![operation_id, file_path],
        ).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(changed)
    })();
    match result {
        Ok(changed) => {
            remove_thumbs_for(thumbs_dir, file_path);
            Ok(changed)
        }
        Err(error) => {
            let _ = crate::operation_journal::mark_manual(&conn, operation_id, &error);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn trash_purge_image(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let db = state.db.clone();
    let thumbs_dir = state.data_dir.join("cache").join("thumbs");
    tauri::async_runtime::spawn_blocking(move || {
        trash_purge_image_sync(&db, &thumbs_dir, &file_path)
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
        let _filesystem_guard = crate::operation_journal::filesystem_operation_guard();
        let identity = match crate::operation_journal::capture_path_identity(Path::new(&dir_path)) {
            Ok(identity) => identity,
            Err(e) => return Ok(serde_json::json!({ "ok": false, "error": e })),
        };
        let (trash_id, dir_clean, trash_path, active_count, total_size, matched, operation) = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            match prepare_trash_folder_record(&conn, &data_dir, &dir_path, &rel_str, root_id, now, identity) {
                Ok(v) => v,
                Err(e) => return Ok(serde_json::json!({ "ok": false, "error": e })),
            }
        };

        let mode = match move_dir_cross_device_safe_mode(Path::new(&dir_clean), &trash_path, operation.id, |staging, sha256| {
            record_cross_volume_staging(&db, &operation, staging, sha256)
        }) {
            Ok(mode) => mode,
            Err(e) => {
                if let Err(rollback) = abort_folder_trash(&db, trash_id, &operation) {
                    if let Ok(conn) = db.lock() {
                        mark_path_manual(&conn, &operation, &format!("{e}; {rollback}"));
                    }
                }
                return Ok(serde_json::json!({ "ok": false, "error": e }));
            }
        };

        let trash_path_str = trash_path.to_string_lossy().to_string();
        let mut conn = db.lock().map_err(|e| e.to_string())?;
        if let Err(e) = crate::operation_journal::tag_path_move(
            &conn,
            operation.id,
            if mode == DirMoveMode::Renamed { "folder_trash_rename" } else { "folder_trash_copy" },
            "file_applied",
            serde_json::json!({ "trashId": trash_id }),
        ) {
            if mode == DirMoveMode::Renamed {
                drop(conn);
                if let Err(rollback) = abort_folder_trash(&db, trash_id, &operation) {
                    if let Ok(conn) = db.lock() {
                        mark_path_manual(&conn, &operation, &format!("{e}; {rollback}"));
                    }
                }
            } else {
                mark_path_manual(&conn, &operation, &format!("{e}; 跨卷源目录已进入回收站，禁止自动逆向恢复"));
            }
            return Ok(serde_json::json!({ "ok": false, "error": e }));
        }
        if let Err(e) = finalize_trash_folder_db(&mut conn, trash_id, &dir_clean, &trash_path_str, now, &matched, operation.id) {
            if mode == DirMoveMode::Renamed {
                drop(conn);
                if let Err(rollback) = abort_folder_trash(&db, trash_id, &operation) {
                    if let Ok(conn) = db.lock() {
                        mark_path_manual(&conn, &operation, &format!("{e}; {rollback}"));
                    }
                }
            } else {
                mark_path_manual(&conn, &operation, &format!("{e}; 跨卷源目录已进入回收站，禁止自动逆向恢复"));
            }
            return Ok(serde_json::json!({ "ok": false, "error": e }));
        }

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
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
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

fn purge_single_trash_images(
    db: &Arc<Mutex<rusqlite::Connection>>,
    thumbs_dir: &Path,
    single_paths: Vec<String>,
) -> Result<(i64, i64), String> {
    if single_paths.is_empty() {
        return Ok((0, 0));
    }
    let _filesystem_guard = crate::operation_journal::filesystem_operation_guard();
    let journaled: Vec<(String, i64)> = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let mut journaled = Vec::with_capacity(single_paths.len());
        for file_path in single_paths {
            let id = crate::operation_journal::create(
                &tx,
                "image_purge",
                "prepared",
                &file_path,
                &file_path,
                serde_json::json!({ "version": 1 }),
            )?;
            journaled.push((file_path, id));
        }
        tx.commit().map_err(|e| e.to_string())?;
        journaled
    };

    let disk_paths: Vec<PathBuf> = journaled.iter().map(|(path, _)| PathBuf::from(path)).collect();
    let batch_ok = send_paths_to_recycle_bin(&disk_paths).is_ok();
    let mut disk_ok = Vec::with_capacity(journaled.len());
    let mut failed = 0i64;
    for (file_path, _) in &journaled {
        let path = Path::new(file_path);
        let ok = if batch_ok {
            true
        } else if path.exists() {
            trash::delete(path).is_ok()
        } else {
            true
        };
        disk_ok.push(ok);
        if !ok {
            failed += 1;
        }
    }

    let mut purged = 0i64;
    let mut to_remove_thumbs = Vec::new();
    let commit_result: Result<(), String> = (|| {
        let mut conn = db.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for ((file_path, id), ok) in journaled.iter().zip(disk_ok.iter()) {
            if *ok {
                if db_delete_image_rows_by_path(&tx, file_path)? {
                    purged += 1;
                }
                crate::operation_journal::finish_in_tx(&tx, *id)?;
                tx.execute(
                    "DELETE FROM picnest_operations WHERE kind = 'image_purge' AND id != ?1 AND LOWER(source_path) = LOWER(?2)",
                    rusqlite::params![*id, file_path],
                ).map_err(|e| e.to_string())?;
                to_remove_thumbs.push(file_path.clone());
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(error) = commit_result {
        let conn = db.lock().map_err(|e| e.to_string())?;
        for (_, id) in &journaled {
            let _ = crate::operation_journal::mark_manual(&conn, *id, &error);
        }
        return Err(error);
    }
    let conn = db.lock().map_err(|e| e.to_string())?;
    for ((file_path, id), ok) in journaled.iter().zip(disk_ok.iter()) {
        if !ok {
            let _ = crate::operation_journal::mark_manual(
                &conn,
                *id,
                &format!("移入系统回收站失败，保留记录待确认: {file_path}"),
            );
        }
    }
    drop(conn);
    for file_path in to_remove_thumbs {
        remove_thumbs_for(thumbs_dir, &file_path);
    }
    Ok((purged, failed))
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
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
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
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };

        let mut purged_images = 0i64;
        let (purged, purge_failed) = purge_single_trash_images(&db, &thumbs_dir, single_paths)?;
        purged_images += purged;
        failed += purge_failed;

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

    fn make_pending_folder_trash(
        tag: &str,
    ) -> (crate::testutil::TempDir, PathBuf, PathBuf, i64, crate::operation_journal::PathMove, rusqlite::Connection) {
        let (base, root_dir, conn) = make_temp_env(tag);
        let data_dir = base.join("data");
        conn.execute("INSERT INTO folders (id, path) VALUES (1, ?1)", [root_dir.to_string_lossy().to_string()]).unwrap();
        let source = root_dir.join("alpha");
        std::fs::create_dir(&source).unwrap();
        let image = source.join("one.png");
        std::fs::write(&image, b"1234").unwrap();
        conn.execute("INSERT INTO images (folder_id, file_path, size, mtime) VALUES (1, ?1, 4, 1000)", [image.to_string_lossy().to_string()]).unwrap();
        let identity = crate::operation_journal::capture_path_identity(&source).unwrap();
        let (trash_id, _, trash_path, _, _, _, operation) = prepare_trash_folder_record(
            &conn, &data_dir, &source.to_string_lossy(), "alpha", 1, 1700000000123, identity,
        ).unwrap();
        (base, source, trash_path, trash_id, operation, conn)
    }

    fn make_trashed_folder(
        tag: &str,
    ) -> (crate::testutil::TempDir, PathBuf, PathBuf, i64, rusqlite::Connection) {
        let (base, source, trash_path, trash_id, operation, mut conn) = make_pending_folder_trash(tag);
        let dir_clean = source.to_string_lossy().to_string();
        let matched: Vec<(i64, String, bool)> = conn.query_row(
            "SELECT id, file_path, 0 FROM images WHERE folder_id = 1", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).map(|row| vec![row]).unwrap();
        std::fs::rename(&source, &trash_path).unwrap();
        crate::operation_journal::tag_path_move(
            &conn, operation.id, "folder_trash_rename", "file_applied", serde_json::json!({ "trashId": trash_id }),
        ).unwrap();
        finalize_trash_folder_db(
            &mut conn, trash_id, &dir_clean, &trash_path.to_string_lossy(), 1700000000123, &matched, operation.id,
        ).unwrap();
        (base, trash_path, source, trash_id, conn)
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
    fn bulk_image_purge_journals_survive_database_failure_and_close_on_retry() {
        let (base, root_dir, conn) = make_temp_env("bulk_purge_fault");
        let thumbs_dir = base.join("data").join("cache").join("thumbs");
        std::fs::create_dir_all(&thumbs_dir).unwrap();
        conn.execute("INSERT INTO folders (id, path) VALUES (1, ?1)", [root_dir.to_string_lossy().to_string()]).unwrap();
        let mut paths = Vec::new();
        for name in ["one.png", "two.png"] {
            let image = root_dir.join(name);
            let image_str = image.to_string_lossy().to_string();
            conn.execute(
                "INSERT INTO images (folder_id, file_path, size, mtime, deleted_at) VALUES (1, ?1, 1, 1, 2)",
                [&image_str],
            ).unwrap();
            let thumb = thumbs_dir.join(format!("{:x}-q80.jpg", crate::commands::fnv1a_hash(image_str.as_bytes())));
            std::fs::write(&thumb, b"cache").unwrap();
            paths.push(image_str);
        }
        conn.execute_batch("CREATE TRIGGER reject_bulk_purge BEFORE DELETE ON images BEGIN SELECT RAISE(ABORT, 'injected bulk purge failure'); END;").unwrap();
        let db = Arc::new(Mutex::new(conn));
        let error = purge_single_trash_images(&db, &thumbs_dir, paths.clone()).unwrap_err();
        assert!(error.contains("injected bulk purge failure"), "{error}");
        {
            let conn = db.lock().unwrap();
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM images", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_operations WHERE kind = 'image_purge' AND state = 'needs_review'", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
        }
        assert_eq!(std::fs::read_dir(&thumbs_dir).unwrap().count(), 2);
        db.lock().unwrap().execute_batch("DROP TRIGGER reject_bulk_purge").unwrap();
        assert_eq!(purge_single_trash_images(&db, &thumbs_dir, paths).unwrap(), (2, 0));
        let conn = db.lock().unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM images", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(std::fs::read_dir(&thumbs_dir).unwrap().count(), 0);
    }

    #[test]
    fn image_purge_database_failure_preserves_cache_and_requires_review() {
        let (base, root_dir, conn) = make_temp_env("purge_fault");
        let thumbs_dir = base.join("data").join("cache").join("thumbs");
        std::fs::create_dir_all(&thumbs_dir).unwrap();
        conn.execute("INSERT INTO folders (id, path) VALUES (1, ?1)", [root_dir.to_string_lossy().to_string()]).unwrap();
        let image = root_dir.join("missing.png");
        let image_str = image.to_string_lossy().to_string();
        conn.execute(
            "INSERT INTO images (folder_id, file_path, size, mtime, deleted_at) VALUES (1, ?1, 1, 1, 2)",
            [&image_str],
        ).unwrap();
        let thumb = thumbs_dir.join(format!("{:x}-q80.jpg", crate::commands::fnv1a_hash(image_str.as_bytes())));
        std::fs::write(&thumb, b"cache").unwrap();
        conn.execute_batch("CREATE TRIGGER reject_purge BEFORE DELETE ON images BEGIN SELECT RAISE(ABORT, 'injected purge failure'); END;").unwrap();
        let db = Arc::new(Mutex::new(conn));
        let error = trash_purge_image_sync(&db, &thumbs_dir, &image_str).unwrap_err();
        assert!(error.contains("injected purge failure"), "{error}");
        assert!(thumb.exists());
        {
            let conn = db.lock().unwrap();
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM images", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
            let state: String = conn.query_row("SELECT state FROM picnest_operations WHERE kind = 'image_purge'", [], |r| r.get(0)).unwrap();
            assert_eq!(state, "needs_review");
        }
        db.lock().unwrap().execute_batch("DROP TRIGGER reject_purge").unwrap();
        assert!(trash_purge_image_sync(&db, &thumbs_dir, &image_str).unwrap());
        assert!(!thumb.exists());
        let conn = db.lock().unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM images", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn directory_move_does_not_copy_after_non_cross_device_rename_error() {
        let dir = crate::testutil::TempDir::new("picnest_dir_move_error");
        let source = dir.join("missing");
        let target = dir.join("output").join("target");
        let error = move_dir_cross_device_safe_mode(&source, &target, 0, |_, _| Ok(())).unwrap_err();
        assert!(error.contains("移动目录失败"), "{error}");
        assert!(!target.exists());
    }

    #[test]
    fn directory_copy_never_overwrites_an_existing_file() {
        let dir = crate::testutil::TempDir::new("picnest_dir_copy_collision");
        let source = dir.join("source");
        let target = dir.join("target");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&target).unwrap();
        std::fs::write(source.join("image.png"), b"new").unwrap();
        std::fs::write(target.join("image.png"), b"user").unwrap();
        assert!(copy_dir_recursive(&source, &target).is_err());
        assert_eq!(std::fs::read(target.join("image.png")).unwrap(), b"user");
        assert_eq!(std::fs::read(source.join("image.png")).unwrap(), b"new");
    }

    #[test]
    fn directory_copy_identity_detects_content_changes() {
        let dir = crate::testutil::TempDir::new("picnest_dir_copy_identity");
        let source = dir.join("source");
        std::fs::create_dir(&source).unwrap();
        let file = source.join("image.png");
        std::fs::write(&file, b"aaaa").unwrap();
        let before = tree_content_identity(&source).unwrap();
        std::fs::write(&file, b"bbbb").unwrap();
        assert_ne!(before, tree_content_identity(&source).unwrap());
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
        let identity = crate::operation_journal::capture_path_identity(&sub_a).unwrap();
        let (trash_id, dir_clean, trash_path, active_count, total_size, matched, operation) =
            prepare_trash_folder_record(&conn, &data_dir, &sub_a_str, "alpha", 1, 1700000000123, identity)
                .unwrap();
        assert_eq!(active_count, 1);
        assert_eq!(total_size, 4);
        assert_eq!(matched.len(), 1); // must NOT capture alphabet/two.png

        move_dir_cross_device_safe(Path::new(&dir_clean), &trash_path).unwrap();
        let trash_path_str = trash_path.to_string_lossy().to_string();
        finalize_trash_folder_db(&mut conn, trash_id, &dir_clean, &trash_path_str, 1700000000123, &matched, operation.id)
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
        let identity = crate::operation_journal::capture_path_identity(&trash_path).unwrap();
        let operation = crate::operation_journal::begin_path_move(&conn, &trash_path, &dest_target, identity).unwrap();
        move_dir_cross_device_safe(&trash_path, &dest_target).unwrap();
        let dest_str = dest_target.to_string_lossy().to_string();
        let restored = finalize_restore_folder_db(&mut conn, &tf_rows[0], &dest_str, operation.id).unwrap();
        assert_eq!(restored, 1);
        assert!(dest_target.join("one.png").exists());
        assert!(trash_folders_inner(&conn, 1).unwrap().is_empty());

        let new_fp: String = conn
            .query_row("SELECT file_path FROM images WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert!(new_fp.contains("alpha (2)"));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn folder_trash_sql_failure_after_move_restores_source_and_row() {
        let (base, root_dir, mut conn) = make_temp_env("dir_fault");
        let data_dir = base.join("data");
        conn.execute("INSERT INTO folders (id, path) VALUES (1, ?1)", [root_dir.to_string_lossy().to_string()]).unwrap();
        let source = root_dir.join("alpha");
        std::fs::create_dir_all(&source).unwrap();
        let image = source.join("one.png");
        std::fs::write(&image, b"1234").unwrap();
        conn.execute("INSERT INTO images (folder_id, file_path, size, mtime) VALUES (1, ?1, 4, 1000)", [image.to_string_lossy().to_string()]).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_folder BEFORE UPDATE OF file_path ON images BEGIN SELECT RAISE(ABORT, 'injected folder failure'); END;").unwrap();
        let identity = crate::operation_journal::capture_path_identity(&source).unwrap();
        let (trash_id, dir_clean, trash_path, _, _, matched, operation) = prepare_trash_folder_record(
            &conn, &data_dir, &source.to_string_lossy(), "alpha", 1, 1700000000123, identity,
        ).unwrap();
        assert_eq!(move_dir_cross_device_safe_mode(&source, &trash_path, operation.id, |_, _| Ok(())).unwrap(), DirMoveMode::Renamed);
        crate::operation_journal::tag_path_move(&conn, operation.id, "folder_trash_rename", "file_applied", serde_json::json!({ "trashId": trash_id })).unwrap();
        let error = finalize_trash_folder_db(&mut conn, trash_id, &dir_clean, &trash_path.to_string_lossy(), 1700000000123, &matched, operation.id).unwrap_err();
        assert!(error.contains("injected folder failure"), "{error}");
        let db = Arc::new(Mutex::new(conn));
        abort_folder_trash(&db, trash_id, &operation).unwrap();
        assert_eq!(std::fs::read(&image).unwrap(), b"1234");
        assert!(!trash_path.exists());
        let conn = db.lock().unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_trash_folders", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn folder_trash_restart_recovery_requires_review_when_structure_changed() {
        let (base, root_dir, conn) = make_temp_env("dir_restart");
        let data_dir = base.join("data");
        let db_path = data_dir.join("picnest.db");
        conn.execute("INSERT INTO folders (id, path) VALUES (1, ?1)", [root_dir.to_string_lossy().to_string()]).unwrap();
        let source = root_dir.join("alpha");
        std::fs::create_dir_all(&source).unwrap();
        let image = source.join("one.png");
        std::fs::write(&image, b"1234").unwrap();
        conn.execute("INSERT INTO images (folder_id, file_path, size, mtime) VALUES (1, ?1, 4, 1000)", [image.to_string_lossy().to_string()]).unwrap();
        let identity = crate::operation_journal::capture_path_identity(&source).unwrap();
        let (trash_id, _, trash_path, _, _, _, operation) = prepare_trash_folder_record(
            &conn, &data_dir, &source.to_string_lossy(), "alpha", 1, 1700000000123, identity,
        ).unwrap();
        std::fs::rename(&source, &trash_path).unwrap();
        crate::operation_journal::tag_path_move(&conn, operation.id, "folder_trash_rename", "file_applied", serde_json::json!({ "trashId": trash_id })).unwrap();
        std::fs::write(trash_path.join("new-user-file.png"), b"new").unwrap();
        drop(conn);
        let conn = init_db(&db_path).unwrap();
        assert_eq!(std::fs::read(&trash_path.join("one.png")).unwrap(), b"1234");
        assert!(!source.exists());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_trash_folders", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        let state: String = conn.query_row("SELECT state FROM picnest_operations", [], |r| r.get(0)).unwrap();
        assert_eq!(state, "needs_review");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn folder_purge_restart_recovery_rejects_a_recreated_directory() {
        let (base, trash_path, _, trash_id, conn) = make_trashed_folder("purge_recreated");
        let identity = crate::operation_journal::capture_path_identity(&trash_path).unwrap();
        crate::operation_journal::create(
            &conn,
            "folder_purge",
            "prepared",
            &trash_path.to_string_lossy(),
            "",
            serde_json::json!({
                "version": 2, "identity": crate::operation_journal::METADATA_IDENTITY,
                "directory": true, "size": identity.size, "sha256": identity.sha256,
                "trashId": trash_id
            }),
        ).unwrap();
        std::fs::rename(&trash_path, base.join("recycled-original")).unwrap();
        std::fs::create_dir(&trash_path).unwrap();
        std::fs::write(trash_path.join("unrelated-user-file.png"), b"user-data").unwrap();
        drop(conn);
        let conn = init_db(&base.join("data").join("picnest.db")).unwrap();
        assert_eq!(std::fs::read(trash_path.join("unrelated-user-file.png")).unwrap(), b"user-data");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_trash_folders", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        let state: String = conn.query_row("SELECT state FROM picnest_operations", [], |r| r.get(0)).unwrap();
        assert_eq!(state, "needs_review");
    }

    #[test]
    fn folder_trash_pending_restart_recovery_cancels_unmoved_record() {
        let (base, source, trash_path, _, _, conn) = make_pending_folder_trash("trash_pending");
        drop(conn);
        let conn = init_db(&base.join("data").join("picnest.db")).unwrap();
        assert_eq!(std::fs::read(source.join("one.png")).unwrap(), b"1234");
        assert!(!trash_path.exists());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_trash_folders", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn folder_trash_pending_restart_recovery_reverses_rename_before_tag() {
        let (base, source, trash_path, _, _, conn) = make_pending_folder_trash("trash_pending_moved");
        std::fs::rename(&source, &trash_path).unwrap();
        drop(conn);
        let conn = init_db(&base.join("data").join("picnest.db")).unwrap();
        assert_eq!(std::fs::read(source.join("one.png")).unwrap(), b"1234");
        assert!(!trash_path.exists());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_trash_folders", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn folder_trash_rename_restart_recovery_reverses_applied_move() {
        let (base, source, trash_path, trash_id, operation, conn) = make_pending_folder_trash("trash_rename");
        std::fs::rename(&source, &trash_path).unwrap();
        crate::operation_journal::tag_path_move(
            &conn, operation.id, "folder_trash_rename", "file_applied", serde_json::json!({ "trashId": trash_id }),
        ).unwrap();
        drop(conn);
        let conn = init_db(&base.join("data").join("picnest.db")).unwrap();
        assert_eq!(std::fs::read(source.join("one.png")).unwrap(), b"1234");
        assert!(!trash_path.exists());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_trash_folders", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn folder_restore_pending_restart_recovery_keeps_unmoved_trash() {
        let (base, trash_path, target, trash_id, conn) = make_trashed_folder("restore_pending");
        let identity = crate::operation_journal::capture_path_identity(&trash_path).unwrap();
        let operation = crate::operation_journal::begin_path_move(&conn, &trash_path, &target, identity).unwrap();
        crate::operation_journal::tag_path_move(
            &conn, operation.id, "folder_restore_pending", "prepared", serde_json::json!({ "trashId": trash_id }),
        ).unwrap();
        drop(conn);
        let conn = init_db(&base.join("data").join("picnest.db")).unwrap();
        assert_eq!(std::fs::read(trash_path.join("one.png")).unwrap(), b"1234");
        assert!(!target.exists());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_trash_folders", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn folder_restore_pending_restart_recovery_reverses_rename_before_tag() {
        let (base, trash_path, target, trash_id, conn) = make_trashed_folder("restore_pending_moved");
        let identity = crate::operation_journal::capture_path_identity(&trash_path).unwrap();
        let operation = crate::operation_journal::begin_path_move(&conn, &trash_path, &target, identity).unwrap();
        crate::operation_journal::tag_path_move(
            &conn, operation.id, "folder_restore_pending", "prepared", serde_json::json!({ "trashId": trash_id }),
        ).unwrap();
        std::fs::rename(&trash_path, &target).unwrap();
        drop(conn);
        let conn = init_db(&base.join("data").join("picnest.db")).unwrap();
        assert_eq!(std::fs::read(trash_path.join("one.png")).unwrap(), b"1234");
        assert!(!target.exists());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_trash_folders", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn folder_restore_rename_restart_recovery_reverses_applied_move() {
        let (base, trash_path, target, trash_id, conn) = make_trashed_folder("restore_rename");
        let identity = crate::operation_journal::capture_path_identity(&trash_path).unwrap();
        let operation = crate::operation_journal::begin_path_move(&conn, &trash_path, &target, identity).unwrap();
        crate::operation_journal::tag_path_move(
            &conn, operation.id, "folder_restore_pending", "prepared", serde_json::json!({ "trashId": trash_id }),
        ).unwrap();
        std::fs::rename(&trash_path, &target).unwrap();
        crate::operation_journal::tag_path_move(
            &conn, operation.id, "folder_restore_rename", "file_applied", serde_json::json!({ "trashId": trash_id }),
        ).unwrap();
        drop(conn);
        let conn = init_db(&base.join("data").join("picnest.db")).unwrap();
        assert_eq!(std::fs::read(trash_path.join("one.png")).unwrap(), b"1234");
        assert!(!target.exists());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_trash_folders", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn folder_restore_pending_cross_volume_marker_requires_review_after_source_disappears() {
        let (base, trash_path, target, trash_id, conn) = make_trashed_folder("restore_cross_volume_pending");
        let identity = crate::operation_journal::capture_path_identity(&trash_path).unwrap();
        let operation = crate::operation_journal::begin_path_move(&conn, &trash_path, &target, identity).unwrap();
        crate::operation_journal::tag_path_move(
            &conn, operation.id, "folder_restore_pending", "prepared", serde_json::json!({ "trashId": trash_id }),
        ).unwrap();
        crate::operation_journal::extend_path_move_payload(
            &conn,
            operation.id,
            serde_json::json!({
                "crossVolume": true,
                "stagingPath": base.join(".picnest-part-dir-missing").to_string_lossy(),
                "stagingSha256": "unused"
            }),
        ).unwrap();
        std::fs::rename(&trash_path, &target).unwrap();
        drop(conn);
        let conn = init_db(&base.join("data").join("picnest.db")).unwrap();
        assert_eq!(std::fs::read(target.join("one.png")).unwrap(), b"1234");
        assert!(!trash_path.exists());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_trash_folders", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        let state: String = conn.query_row("SELECT state FROM picnest_operations", [], |r| r.get(0)).unwrap();
        assert_eq!(state, "needs_review");
    }

    #[test]
    fn folder_restore_copy_restart_recovery_requires_review() {
        let (base, trash_path, target, trash_id, conn) = make_trashed_folder("restore_copy");
        let identity = crate::operation_journal::capture_path_identity(&trash_path).unwrap();
        let operation = crate::operation_journal::begin_path_move(&conn, &trash_path, &target, identity).unwrap();
        crate::operation_journal::tag_path_move(
            &conn, operation.id, "folder_restore_copy", "file_applied", serde_json::json!({ "trashId": trash_id }),
        ).unwrap();
        drop(conn);
        let conn = init_db(&base.join("data").join("picnest.db")).unwrap();
        assert!(trash_path.exists());
        assert!(!target.exists());
        let state: String = conn.query_row("SELECT state FROM picnest_operations WHERE id = ?1", [operation.id], |r| r.get(0)).unwrap();
        assert_eq!(state, "needs_review");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_trash_folders", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn remove_thumbs_for_cleans_every_shared_variant() {
        let dir = crate::testutil::TempDir::new("picnest_thumb_variants");
        let thumbs = dir.join("thumbs");
        std::fs::create_dir(&thumbs).unwrap();
        let file_path = dir.join("image.png").to_string_lossy().to_string();
        let hash = format!("{:x}", crate::commands::fnv1a_hash(file_path.as_bytes()));
        for name in crate::commands::thumbnail_filenames(&hash) {
            std::fs::write(thumbs.join(&name), b"thumb").unwrap();
        }
        let unrelated = thumbs.join("unrelated.webp");
        std::fs::write(&unrelated, b"keep").unwrap();
        remove_thumbs_for(&thumbs, &file_path);
        assert_eq!(std::fs::read_dir(&thumbs).unwrap().count(), 1);
        assert_eq!(std::fs::read(unrelated).unwrap(), b"keep");
    }

    #[test]
    fn restore_missing_trash_path_never_creates_empty_directory() {
        let (_base, root_dir, conn) = make_temp_env("dir_missing");
        let target = root_dir.join("alpha");
        conn.execute(
            "INSERT INTO picnest_trash_folders (folder_id, rel, abs_path, trash_path, name, deleted_at) VALUES (1, 'alpha', ?1, '', 'alpha', 1)",
            [target.to_string_lossy().to_string()],
        ).unwrap();
        let db = std::sync::Arc::new(std::sync::Mutex::new(conn));
        let result = restore_folder_by_id_blocking(&db, 1);
        assert_eq!(result["ok"], false);
        assert!(!target.exists());
        assert_eq!(db.lock().unwrap().query_row("SELECT COUNT(*) FROM picnest_trash_folders", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn cross_volume_folder_recovery_preserves_files_and_requires_review() {
        let (base, root_dir, conn) = make_temp_env("dir_copy_review");
        let data_dir = base.join("data");
        let db_path = data_dir.join("picnest.db");
        conn.execute("INSERT INTO folders (id, path) VALUES (1, ?1)", [root_dir.to_string_lossy().to_string()]).unwrap();
        let source = root_dir.join("alpha");
        std::fs::create_dir_all(&source).unwrap();
        let image = source.join("one.png");
        std::fs::write(&image, b"1234").unwrap();
        conn.execute("INSERT INTO images (folder_id, file_path, size, mtime) VALUES (1, ?1, 4, 1000)", [image.to_string_lossy().to_string()]).unwrap();
        let identity = crate::operation_journal::capture_path_identity(&source).unwrap();
        let (trash_id, _, trash_path, _, _, _, operation) = prepare_trash_folder_record(
            &conn, &data_dir, &source.to_string_lossy(), "alpha", 1, 1700000000123, identity,
        ).unwrap();
        std::fs::rename(&source, &trash_path).unwrap();
        crate::operation_journal::tag_path_move(&conn, operation.id, "folder_trash_copy", "file_applied", serde_json::json!({ "trashId": trash_id })).unwrap();
        drop(conn);
        let conn = init_db(&db_path).unwrap();
        assert_eq!(std::fs::read(&trash_path.join("one.png")).unwrap(), b"1234");
        assert!(!source.exists());
        let state: String = conn.query_row("SELECT state FROM picnest_operations WHERE id = ?1", [operation.id], |r| r.get(0)).unwrap();
        assert_eq!(state, "needs_review");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_trash_folders", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }
}
