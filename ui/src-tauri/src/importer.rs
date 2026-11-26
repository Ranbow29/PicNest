use crate::commands::{with_read_conn, AppState};
use crate::scanner::{file_size_and_mtime, is_supported_ext};
use rusqlite::{params, Connection};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

static STAGE_SEQ: AtomicU64 = AtomicU64::new(1);
static DIR_DUP_CANCEL: AtomicBool = AtomicBool::new(false);

pub(crate) fn is_supported_drop_ext(ext: &str) -> bool {
    is_supported_ext(ext)
}

/// 将已在目标目录磁盘上存在、但数据库未录入（或处于软删回收站）的文件补录/恢复到 images 表。
/// 返回本次新补录或恢复的条目数量；已在库且处于激活态（deleted_at IS NULL）的文件不计入。
/// 在循环外预读 `folders` 列表并开启单个事务批量写入，大幅降低大批量导入时的 DB 事务开销。
pub(crate) fn index_disk_paths(conn: &Connection, paths: &[PathBuf], restore_soft_deleted: bool) -> Result<usize, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let count = index_disk_paths_in_tx(&tx, paths, restore_soft_deleted)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(count)
}

pub(crate) fn index_disk_paths_in_tx(tx: &rusqlite::Transaction<'_>, paths: &[PathBuf], restore_soft_deleted: bool) -> Result<usize, String> {
    if paths.is_empty() {
        return Ok(0);
    }

    let folders: Vec<(i64, String, String)> = {
        let mut stmt = tx.prepare("SELECT id, path FROM folders").map_err(|e| e.to_string())?;
        stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
            .into_iter()
            .filter_map(|(id, rp)| {
                let norm = rp.replace('/', "\\").trim_end_matches('\\').to_lowercase();
                if norm.is_empty() { None } else { Some((id, rp, norm)) }
            })
            .collect()
    };
    if folders.is_empty() {
        return Ok(0);
    }

    let match_folder = |target: &Path| -> Option<(i64, &str)> {
        let norm = target
            .to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase();
        if norm.is_empty() {
            return None;
        }
        let mut best: Option<(usize, i64, &str)> = None;
        for (id, raw_root, root_norm) in &folders {
            let matched = norm == *root_norm
                || (norm.len() > root_norm.len()
                    && norm.starts_with(root_norm)
                    && norm.as_bytes()[root_norm.len()] == b'\\');
            if matched && best.map(|(len, _, _)| root_norm.len() > len).unwrap_or(true) {
                best = Some((root_norm.len(), *id, raw_root.as_str()));
            }
        }
        best.map(|(_, id, rp)| (id, rp))
    };

    let mut registered = 0usize;
    for path in paths {
        let Ok(meta) = std::fs::metadata(path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let Some((folder_id, root_path)) = match_folder(path) else {
            continue;
        };
        let fp = path.to_string_lossy().to_string();
        let fp_norm = fp.replace('/', "\\");
        let (size, mtime) = file_size_and_mtime(Some(&meta));
        let dir_rel = crate::db::dir_rel_of(root_path, &fp_norm);
        let existing: Option<(i64, bool)> = match tx.query_row(
            "SELECT id, deleted_at IS NOT NULL FROM images WHERE LOWER(REPLACE(file_path, '/', '\\')) = LOWER(?1) LIMIT 1",
            [&fp_norm],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, bool>(1)?)),
        ) {
            Ok(row) => Some(row),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(e) => return Err(e.to_string()),
        };
        match existing {
            Some((_, false)) => {}
            Some((id, true)) => {
                if restore_soft_deleted {
                    tx.execute(
                        "UPDATE images SET folder_id = ?1, file_path = ?2, dir_rel = ?3, size = ?4, mtime = ?5, deleted_at = NULL, trash_group = NULL WHERE id = ?6",
                        params![folder_id, fp, dir_rel, size, mtime, id],
                    ).map_err(|e| e.to_string())?;
                    registered += 1;
                }
            }
            None => {
                tx.execute(
                    "INSERT INTO images (folder_id, file_path, size, mtime, dir_rel)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(file_path) DO UPDATE SET
                       folder_id = ?1, size = ?3, mtime = ?4, dir_rel = ?5, deleted_at = NULL, trash_group = NULL",
                    params![folder_id, fp, size, mtime, dir_rel],
                ).map_err(|e| e.to_string())?;
                registered += 1;
            }
        }
    }
    Ok(registered)
}

fn commit_staged_imports(
    db: &Arc<Mutex<Connection>>,
    staged: Vec<crate::fs_ops::StagedFile>,
    replacements: &[String],
    thumbs_dir: &Path,
) -> Result<usize, String> {
    if staged.is_empty() {
        return Ok(0);
    }
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut seen_replacements = std::collections::HashSet::new();
    let replacements: Vec<&str> = replacements.iter()
        .map(|old| old.as_str())
        .filter(|old| seen_replacements.insert(old.to_lowercase()))
        .collect();
    let first = staged.first().ok_or("替换操作缺少新文件")?;
    let replacement_ids = crate::operation_journal::begin_file_replacements(&conn, &replacements, first)?;
    for old in &replacements {
        let path = Path::new(old);
        if path.exists() {
            if let Err(e) = trash::delete(path) {
                let mut cleanup_errors = Vec::new();
                for file in &staged {
                    if let Err(error) = crate::fs_ops::rollback_staged(file) {
                        cleanup_errors.push(error);
                    }
                }
                for id in &replacement_ids {
                    let _ = crate::operation_journal::mark_manual(
                        &conn,
                        *id,
                        &format!("{e}; 新文件回滚: {}", cleanup_errors.join("; ")),
                    );
                }
                return Err(format!("覆盖文件移入回收站失败: {e}; 回滚: {}", cleanup_errors.join("; ")));
            }
        }
    }
    let mut items: Vec<(crate::fs_ops::StagedFile, serde_json::Value)> = staged
        .into_iter()
        .map(|file| (file, json!({})))
        .collect();
    items[0].1 = json!({ "finishOperationIds": replacement_ids });
    let result = crate::operation_journal::commit_new_files(&conn, items, |tx, files| {
        let paths: Vec<PathBuf> = files.iter().map(|f| f.final_path.clone()).collect();
        let registered = index_disk_paths_in_tx(tx, &paths, true)?;
        for old in &replacements {
            tx.execute("DELETE FROM images WHERE LOWER(file_path) = LOWER(?1)", [old])
                .map_err(|e| e.to_string())?;
        }
        Ok(registered)
    });
    if result.is_ok() {
        for old in &replacements {
            crate::trash_ops::remove_thumbs_for(thumbs_dir, old);
        }
    }
    result
}

fn is_junk_filename(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), "thumbs.db" | "desktop.ini" | ".ds_store")
}

fn sanitize_filename(name: &str, fallback: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        fallback.to_string()
    } else {
        cleaned
    }
}

fn safe_rel_join(base: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut out = base.to_path_buf();
    for seg in rel.replace('\\', "/").split('/') {
        let s = seg.trim();
        if s.is_empty() || s == "." {
            continue;
        }
        if s == ".." {
               return Err("非法相对路径".to_string());
        }
        let clean = sanitize_filename(s, "item");
        let p = Path::new(&clean);
        match p.components().next() {
            Some(Component::Normal(_)) => out.push(clean),
            _ => return Err("非法路径段".to_string()),
        }
    }
    Ok(out)
}

pub(crate) fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let cleaned: String = input.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    base64::engine::general_purpose::STANDARD
        .decode(cleaned.as_bytes())
        .map_err(|_| "无效的 base64 数据".to_string())
}

// RFC 1321 流式 MD5：无外部依赖，大 PSD/MP4 只占 64KB 缓冲
pub(crate) fn md5_digest_reader<R: Read>(mut reader: R) -> std::io::Result<String> {
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5,  9, 14, 20, 5,  9, 14, 20, 5,  9, 14, 20, 5,  9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    const K: [u32; 64] = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
        0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
        0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
        0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
        0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
        0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
        0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
        0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
    ];

    let mut state: [u32; 4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
    let mut total_bits: u64 = 0;
    let mut tail = Vec::with_capacity(128);
    let mut chunk = vec![0u8; 64 * 1024];

    let process_block = |block: &[u8; 64], st: &mut [u32; 4]| {
        let mut m = [0u32; 16];
        for i in 0..16 {
            let j = i * 4;
            m[i] = u32::from_le_bytes([block[j], block[j + 1], block[j + 2], block[j + 3]]);
        }
        let (mut a, mut b, mut c, mut d) = (st[0], st[1], st[2], st[3]);
        for i in 0..64 {
            let (f, g) = match i {
                0..=15 => ((b & c) | ((!b) & d), i),
                16..=31 => ((d & b) | ((!d) & c), (5 * i + 1) % 16),
                32..=47 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | (!d)), (7 * i) % 16),
            };
            let temp = d;
            d = c;
            c = b;
            let sum = a.wrapping_add(f).wrapping_add(K[i]).wrapping_add(m[g]);
            b = b.wrapping_add(sum.rotate_left(S[i]));
            a = temp;
        }
        st[0] = st[0].wrapping_add(a);
        st[1] = st[1].wrapping_add(b);
        st[2] = st[2].wrapping_add(c);
        st[3] = st[3].wrapping_add(d);
    };

    loop {
        let n = reader.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        total_bits = total_bits.wrapping_add((n as u64) * 8);
        tail.extend_from_slice(&chunk[..n]);
        let full = (tail.len() / 64) * 64;
        if full > 0 {
            for blk in tail[..full].chunks_exact(64) {
                let b: &[u8; 64] = blk.try_into().unwrap();
                process_block(b, &mut state);
            }
            tail.drain(..full);
        }
    }

    tail.push(0x80);
    while (tail.len() % 64) != 56 {
        tail.push(0);
    }
    tail.extend_from_slice(&total_bits.to_le_bytes());
    for blk in tail.chunks_exact(64) {
        let b: &[u8; 64] = blk.try_into().unwrap();
        process_block(b, &mut state);
    }

    Ok(format!(
        "{:08x}{:08x}{:08x}{:08x}",
        state[0].swap_bytes(),
        state[1].swap_bytes(),
        state[2].swap_bytes(),
        state[3].swap_bytes()
    ))
}

fn md5_of_file(path: &Path, cache: &mut HashMap<String, String>) -> Option<String> {
    let key = path.to_string_lossy().to_lowercase();
    if let Some(hit) = cache.get(&key) {
        return Some(hit.clone());
    }
    let f = std::fs::File::open(path).ok()?;
    let hex = md5_digest_reader(f).ok()?;
    cache.insert(key, hex.clone());
    Some(hex)
}

pub(crate) fn unique_dest_path(dir: &Path, filename: &str) -> PathBuf {
    let mut candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }
    let p = Path::new(filename);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
    let mut n = 1usize;
    loop {
        let next_name = if ext.is_empty() {
            format!("{} ({})", stem, n)
        } else {
            format!("{} ({}).{}", stem, n, ext)
        };
        candidate = dir.join(next_name);
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

#[tauri::command]
pub fn stage_drop_begin(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let seq = STAGE_SEQ.fetch_add(1, Ordering::Relaxed);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let batch_id = format!("b_{}_{}", ts, seq);
    let batch_dir = state.data_dir.join("cache").join("drop_stage").join(&batch_id);
    std::fs::create_dir_all(&batch_dir).map_err(|e| e.to_string())?;
    Ok(json!({
        "ok": true,
        "batchId": batch_id,
        "rootDir": batch_dir.to_string_lossy().to_string()
    }))
}

#[tauri::command]
pub fn stage_drop_mkdir(
    batch_id: String,
    rel_path: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let clean_id = sanitize_filename(&batch_id, "b");
    let batch_dir = state.data_dir.join("cache").join("drop_stage").join(clean_id);
    let target = safe_rel_join(&batch_dir, &rel_path)?;
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true, "path": target.to_string_lossy().to_string() }))
}

#[tauri::command]
pub async fn stage_drop_chunk(
    batch_id: String,
    rel_path: String,
    append: bool,
    b64: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        let clean_id = sanitize_filename(&batch_id, "b");
        let batch_dir = data_dir.join("cache").join("drop_stage").join(clean_id);
        let target = safe_rel_join(&batch_dir, &rel_path)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let bytes = decode_base64(&b64)?;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(append)
            .truncate(!append)
            .open(&target)
            .map_err(|e| e.to_string())?;
        f.write_all(&bytes).map_err(|e| e.to_string())?;
        Ok(json!({
            "ok": true,
            "path": target.to_string_lossy().to_string(),
            "written": bytes.len()
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn stage_drop_cleanup(
    batch_id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let clean_id = sanitize_filename(&batch_id, "");
        if clean_id.is_empty() {
            return Ok(json!({ "ok": false }));
        }
        let batch_dir = data_dir.join("cache").join("drop_stage").join(clean_id);
        if batch_dir.exists() {
            let _ = trash::delete(&batch_dir);
        }
        Ok(json!({ "ok": true }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn import_check(
    paths: Vec<String>,
    folder_id: i64,
    target_dir: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_read_conn(&db_path, |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT i.file_path, COALESCE(i.width, 0), COALESCE(i.height, 0), f.path, COALESCE(f.display_name, '')
                     FROM images i
                     JOIN folders f ON f.id = i.folder_id
                     WHERE i.size = ?1 AND i.folder_id = ?2 AND i.deleted_at IS NULL
                     LIMIT 6",
                )
                .map_err(|e| e.to_string())?;

            let mut clean = Vec::new();
            let mut conflicts = Vec::new();
            let mut dirs = Vec::new();
            let mut missing = Vec::new();
            let mut md5_cache = HashMap::new();

            for raw in paths {
                let p = Path::new(&raw);
                if raw.is_empty() || !p.exists() {
                    missing.push(raw);
                    continue;
                }
                if p.is_dir() {
                    dirs.push(raw);
                    continue;
                }
                let Ok(meta) = std::fs::metadata(p) else {
                    missing.push(raw);
                    continue;
                };
                let size = meta.len() as i64;
                let base = p
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| raw.clone());

                // 1. 如果目标目录磁盘上已存在同名文件（且不是自身拖入），直接触发冲突对比弹窗
                let mut matched_target = None;
                if let Some(td) = target_dir.as_deref() {
                    let dst_path = Path::new(td).join(&base);
                    let same_low = dst_path.to_string_lossy().to_lowercase();
                    let raw_low = raw.to_lowercase();
                    if same_low != raw_low && dst_path.exists() && dst_path.is_file() {
                        let (ex_w, ex_h) = image::image_dimensions(&dst_path).unwrap_or((0, 0));
                        let folder_name = Path::new(td)
                            .file_name()
                            .map(|s| s.to_string_lossy().to_string())
                            .unwrap_or_else(|| "当前文件夹".to_string());
                        matched_target = Some((dst_path.to_string_lossy().to_string(), ex_w as i64, ex_h as i64, td.to_string(), folder_name));
                    }
                }

                let mut matched = matched_target;
                if matched.is_none() {
                    let cands: Vec<(String, i64, i64, String, String)> = stmt
                        .query_map(params![size, folder_id], |r| {
                            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                        })
                        .map(|rows| rows.flatten().collect())
                        .unwrap_or_default();

                    if !cands.is_empty() {
                        if let Some(md5_new) = md5_of_file(p, &mut md5_cache) {
                            for cand in cands {
                                let cp = Path::new(&cand.0);
                                if !cp.exists() {
                                    continue;
                                }
                                if md5_of_file(cp, &mut md5_cache).as_deref() == Some(&md5_new) {
                                    matched = Some(cand);
                                    break;
                                }
                            }
                        }
                    }
                }

                if let Some((fp, w, h, root_path, disp)) = matched {
                    let name = p
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| raw.clone());
                    let existing_name = Path::new(&fp)
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let parent_name = Path::new(&fp)
                        .parent()
                        .and_then(|d| d.file_name())
                        .map(|s| s.to_string_lossy().to_string())
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| {
                            if !disp.trim().is_empty() {
                                disp
                            } else {
                                Path::new(&root_path)
                                    .file_name()
                                    .map(|s| s.to_string_lossy().to_string())
                                    .unwrap_or(root_path)
                            }
                        });
                    conflicts.push(json!({
                        "path": raw,
                        "name": name,
                        "size": size,
                        "existing": {
                            "file_path": fp,
                            "file_name": existing_name,
                            "width": w,
                            "height": h,
                            "folderName": parent_name
                        }
                    }));
                } else {
                    clean.push(raw);
                }
            }

            Ok(json!({
                "clean": clean,
                "conflicts": conflicts,
                "dirs": dirs,
                "missing": missing
            }))
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn import_files_sync(
    db: &Arc<Mutex<Connection>>,
    paths: Vec<String>,
    target_dir: String,
    replace_old: Option<Vec<String>>,
    thumbs_dir: &Path,
) -> serde_json::Value {
    let _filesystem_guard = crate::operation_journal::filesystem_operation_guard();
    let dst_dir = Path::new(&target_dir);
    if !dst_dir.exists() || !dst_dir.is_dir() {
        return json!({ "ok": false, "error": "目标目录不存在", "dirs": [] });
    }

    let replace_list: Vec<String> = replace_old
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let replace_set: HashSet<String> = replace_list.iter().map(|s| s.to_lowercase()).collect();
    let mut dest_paths: Vec<String> = Vec::new();
    let mut dest_set: HashSet<String> = HashSet::new();
    let mut staged_files: Vec<crate::fs_ops::StagedFile> = Vec::new();
    let mut replacements: Vec<String> = Vec::new();
    let mut skip_check_paths: Vec<PathBuf> = Vec::new();

    let mut dirs = Vec::new();
    let mut unsupported_names = Vec::new();
    let mut copied = 0usize;
    let mut registered = 0usize;
    let mut failed = 0usize;
    let mut skipped = 0usize;
    let mut unsupported = 0usize;
    let mut replaced = 0usize;

    for raw in paths {
        let p = Path::new(&raw);
        if raw.is_empty() || !p.exists() {
            failed += 1;
            continue;
        }
        if p.is_dir() {
            dirs.push(raw);
            continue;
        }
        let Ok(_st) = std::fs::metadata(p) else {
            failed += 1;
            continue;
        };
        let base = p
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
        if !is_supported_drop_ext(ext) || is_junk_filename(&base) {
            unsupported += 1;
            if unsupported_names.len() < 12 {
                unsupported_names.push(base);
            }
            continue;
        }
        let same_name = dst_dir.join(&base);
        let same_low = same_name.to_string_lossy().to_lowercase();
        let is_self_drop = raw.to_lowercase() == same_low;
        if same_name.exists() && !is_self_drop && replace_set.contains(&same_low) {
            replacements.push(same_name.to_string_lossy().to_string());
        } else if is_self_drop {
            dest_set.insert(same_low);
            dest_paths.push(same_name.to_string_lossy().to_string());
            skip_check_paths.push(same_name);
            continue;
        }
        let dest = if same_name.exists() && !is_self_drop && !replace_set.contains(&same_low) {
            unique_dest_path(dst_dir, &base)
        } else {
            same_name
        };
        match crate::fs_ops::stage_copy_new(p, &dest) {
            Ok(staged) => {
                copied += 1;
                let d_str = dest.to_string_lossy().to_string();
                dest_set.insert(d_str.to_lowercase());
                dest_paths.push(d_str);
                staged_files.push(staged);
            }
            Err(_) => failed += 1,
        }
    }

    for old_p in replace_list {
        let low = old_p.to_lowercase();
        if !dest_set.contains(&low) && !replacements.iter().any(|p| p.to_lowercase() == low) {
            replacements.push(old_p);
        }
    }
    if !staged_files.is_empty() {
        match commit_staged_imports(db, staged_files, &replacements, thumbs_dir) {
            Ok(count) => registered += count,
            Err(e) => return json!({
                "ok": false, "error": e, "dirs": dirs, "copied": 0, "registered": 0,
                "failed": failed + 1, "skipped": skipped, "replaced": 0,
                "destPaths": [], "unsupported": unsupported, "unsupportedNames": unsupported_names
            }),
        }
        replaced = replacements.len();
    }

    if !skip_check_paths.is_empty() {
        match db.lock() {
            Ok(conn) => {
                registered = match index_disk_paths(&conn, &skip_check_paths, true) {
                    Ok(count) => count,
                    Err(e) => return json!({ "ok": false, "error": e }),
                };
                skipped += skip_check_paths.len().saturating_sub(registered);
            }
            Err(e) => return json!({ "ok": false, "error": e.to_string() }),
        }
    }

    json!({
        "ok": true,
        "dirs": dirs,
        "copied": copied,
        "registered": registered,
        "failed": failed,
        "skipped": skipped,
        "replaced": replaced,
        "destPaths": dest_paths,
        "unsupported": unsupported,
        "unsupportedNames": unsupported_names
    })
}

#[tauri::command]
pub async fn import_files(
    paths: Vec<String>,
    target_dir: String,
    replace_old: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db = state.db.clone();
    let thumbs_dir = state.data_dir.join("cache").join("thumbs");
    tauri::async_runtime::spawn_blocking(move || {
        import_files_sync(&db, paths, target_dir, replace_old, &thumbs_dir)
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn dir_dup_cancel() -> serde_json::Value {
    DIR_DUP_CANCEL.store(true, Ordering::SeqCst);
    json!({ "ok": true })
}

#[tauri::command]
pub async fn dir_dup_check(
    app: AppHandle,
    src_dir: String,
    target_dir: String,
    folder_id: i64,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        DIR_DUP_CANCEL.store(false, Ordering::SeqCst);
        let src_p = Path::new(&src_dir);
        if src_dir.is_empty() || !src_p.is_dir() {
            return json!({ "ok": false, "count": 0, "scanned": 0, "items": [], "error": "源文件夹不存在" });
        }

        let base_name = sanitize_filename(
            src_p
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("导入文件夹"),
            "导入文件夹",
        );
        let dest_root = Path::new(&target_dir).join(base_name);

        let mut files: Vec<(PathBuf, String, u64)> = Vec::new();
        for ent in jwalk::WalkDir::new(src_p).skip_hidden(true).into_iter().flatten() {
            if !ent.file_type().is_file() {
                continue;
            }
            let fp = ent.path();
            let fname = fp.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
            let ext = fp.extension().and_then(|s| s.to_str()).unwrap_or("");
            if !is_supported_drop_ext(ext) || is_junk_filename(&fname) {
                continue;
            }
            let sz = ent.metadata().map(|m| m.len()).unwrap_or(0);
            files.push((fp, fname, sz));
        }

        let scanned = files.len();
        let total = scanned;
        let _ = app.emit("picnest-dir-dup-progress", json!({ "phase": "hash", "done": 0, "total": total }));

        let Ok(conn) = crate::commands::open_read_conn(&db_path) else {
            return json!({ "ok": false, "count": 0, "scanned": scanned, "items": [], "error": "数据库打开失败" });
        };
        let Ok(mut stmt) = conn.prepare(
            "SELECT file_path, COALESCE(width, 0), COALESCE(height, 0)
             FROM images
             WHERE size = ?1 AND folder_id = ?2 AND deleted_at IS NULL
             LIMIT 8",
        ) else {
            return json!({ "ok": false, "count": 0, "scanned": scanned, "items": [], "error": "查询失败" });
        };

        let mut md5_cache = HashMap::new();
        let mut items = Vec::new();

        for (idx, (fp, fname, sz)) in files.iter().enumerate() {
            if DIR_DUP_CANCEL.load(Ordering::SeqCst) {
                return json!({ "ok": false, "canceled": true, "count": items.len(), "scanned": scanned, "items": items, "error": "已取消" });
            }
            let cands: Vec<(String, i64, i64)> = stmt
                .query_map(params![*sz as i64, folder_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .map(|rows| rows.flatten().collect())
                .unwrap_or_default();

            if !cands.is_empty() {
                if let Some(md5_new) = md5_of_file(fp, &mut md5_cache) {
                    let rel = fp.strip_prefix(src_p).unwrap_or(fp.as_path());
                    let dest_path_str = dest_root.join(rel).to_string_lossy().to_lowercase();
                    let src_low = fp.to_string_lossy().to_lowercase();

                    let mut at_dest = false;
                    let mut hit: Option<(String, i64, i64)> = None;
                    for c in cands {
                        let c_low = c.0.to_lowercase();
                        if c_low == src_low && c_low != dest_path_str {
                            continue;
                        }
                        if !Path::new(&c.0).exists() {
                            continue;
                        }
                        if md5_of_file(Path::new(&c.0), &mut md5_cache).as_deref() != Some(&md5_new) {
                            continue;
                        }
                        if c_low == dest_path_str {
                            at_dest = true;
                            break;
                        }
                        if hit.is_none() {
                            hit = Some(c);
                        }
                    }

                    if !at_dest {
                        if let Some((hfp, hw, hh)) = hit {
                            let hname = Path::new(&hfp)
                                .file_name()
                                .map(|s| s.to_string_lossy().to_string())
                                .unwrap_or_default();
                            let folder_name = Path::new(&hfp)
                                .parent()
                                .and_then(|d| d.file_name())
                                .map(|s| s.to_string_lossy().to_string())
                                .unwrap_or_default();
                            items.push(json!({
                                "src": fp.to_string_lossy().to_string(),
                                "name": fname,
                                "size": *sz,
                                "existing": {
                                    "file_path": hfp,
                                    "file_name": hname,
                                    "width": hw,
                                    "height": hh,
                                    "folderName": folder_name
                                }
                            }));
                        }
                    }
                }
            }

            let done = idx + 1;
            if done % 3 == 0 || done == total {
                let _ = app.emit("picnest-dir-dup-progress", json!({ "phase": "hash", "done": done, "total": total }));
            }
        }

        json!({
            "ok": true,
            "count": items.len(),
            "scanned": scanned,
            "items": items
        })
    })
    .await
    .map_err(|e| e.to_string())
}

fn import_dir_copy_sync(
    db: &Arc<Mutex<Connection>>,
    src_dir: String,
    target_dir: String,
    opts: Option<serde_json::Value>,
    thumbs_dir: &Path,
) -> serde_json::Value {
    let _filesystem_guard = crate::operation_journal::filesystem_operation_guard();
    let policy = opts
        .as_ref()
        .and_then(|o| o.get("policy"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let mut dupe_map: HashMap<String, String> = HashMap::new();
    if let Some(arr) = opts.as_ref().and_then(|o| o.get("dupes")).and_then(|v| v.as_array()) {
        for d in arr {
            if let Some(src) = d.get("src").and_then(|v| v.as_str()) {
                let old = d.get("old").and_then(|v| v.as_str()).unwrap_or("").to_string();
                dupe_map.insert(src.to_lowercase(), old);
            }
        }
    }

    let src_p = Path::new(&src_dir);
    let dst_p = Path::new(&target_dir);
    if !src_p.is_dir() {
        return json!({ "ok": false, "error": "源文件夹不存在", "policy": policy });
    }
    if !dst_p.is_dir() {
        return json!({ "ok": false, "error": "目标目录不存在", "policy": policy });
    }

    let src_abs = std::fs::canonicalize(src_p).unwrap_or_else(|_| src_p.to_path_buf());
    let dst_abs = std::fs::canonicalize(dst_p).unwrap_or_else(|_| dst_p.to_path_buf());
    if dst_abs == src_abs || dst_abs.starts_with(&src_abs) {
        return json!({ "ok": false, "error": "不能把文件夹复制进自身或其子目录", "policy": policy });
    }

    let base = sanitize_filename(
        src_p.file_name().and_then(|s| s.to_str()).unwrap_or("导入文件夹"),
        "导入文件夹",
    );
    let mut dest = dst_p.join(&base);
    let mut n = 1usize;
    while dest.exists() && !dest.is_dir() {
        dest = dst_p.join(format!("{} ({})", base, n));
        n += 1;
    }
    let dest_name = dest
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| base.clone());
    let dest_existed = dest.exists();

    let mut made_dirs: HashSet<PathBuf> = HashSet::new();
    let mut staged_files: Vec<crate::fs_ops::StagedFile> = Vec::new();
    let mut skip_check_paths: Vec<PathBuf> = Vec::new();
    let mut copied = 0usize;
    let mut registered = 0usize;
    let mut skipped = 0usize;
    let mut failed = 0usize;
    let mut unsupported = 0usize;
    let mut replaced = 0usize;
    let mut unsupported_names: Vec<String> = Vec::new();
    let mut old_to_trash: Vec<String> = Vec::new();

    for ent in jwalk::WalkDir::new(src_p).skip_hidden(true).into_iter().flatten() {
        if !ent.file_type().is_file() {
            continue;
        }
        let fp = ent.path();
        let fname = fp.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
        if fname.starts_with('.') || is_junk_filename(&fname) {
            continue;
        }
        let rel = fp.strip_prefix(src_p).unwrap_or(fp.as_path());
        let ext = fp.extension().and_then(|s| s.to_str()).unwrap_or("");
        if !is_supported_drop_ext(ext) {
            unsupported += 1;
            if unsupported_names.len() < 12 {
                unsupported_names.push(rel.to_string_lossy().replace('\\', "/"));
            }
            continue;
        }

        let src_key = fp.to_string_lossy().to_lowercase();
        let old_dup = dupe_map.get(&src_key).cloned();
        if policy == "skip" && old_dup.is_some() {
            skipped += 1;
            continue;
        }

        let dest_parent = match rel.parent() {
            Some(rp) if !rp.as_os_str().is_empty() => dest.join(rp),
            _ => dest.clone(),
        };
        if !dest_parent.exists() {
            if std::fs::create_dir_all(&dest_parent).is_err() {
                failed += 1;
                continue;
            }
            made_dirs.insert(dest_parent.clone());
        }

        let Ok(src_meta) = std::fs::metadata(&fp) else {
            failed += 1;
            continue;
        };
        let same_place = dest_parent.join(&fname);
        if let Ok(dst_meta) = std::fs::metadata(&same_place) {
            if dst_meta.len() == src_meta.len() {
                skip_check_paths.push(same_place);
                continue;
            }
        }

        let out_file = unique_dest_path(&dest_parent, &fname);
        match crate::fs_ops::stage_copy_new(&fp, &out_file) {
            Ok(staged) => {
                copied += 1;
                staged_files.push(staged);
                if policy == "replace" {
                    if let Some(old_p) = old_dup {
                        if !old_p.is_empty() && !old_p.eq_ignore_ascii_case(&out_file.to_string_lossy()) {
                            old_to_trash.push(old_p);
                        }
                    }
                }
            }
            Err(_) => failed += 1,
        }
    }

    if !staged_files.is_empty() {
        match commit_staged_imports(db, staged_files, &old_to_trash, thumbs_dir) {
            Ok(count) => registered += count,
            Err(e) => return json!({
                "ok": false, "error": e, "name": dest_name, "dest": dest.to_string_lossy().to_string(),
                "copied": 0, "registered": 0, "skipped": skipped, "failed": failed + 1,
                "unsupported": unsupported, "unsupportedNames": unsupported_names,
                "dirsCreated": made_dirs.len(), "created": !dest_existed && dest.exists(),
                "replaced": 0, "policy": policy
            }),
        }
        replaced = old_to_trash.len();
    }

    if !skip_check_paths.is_empty() {
        match db.lock() {
            Ok(conn) => {
                registered = match index_disk_paths(&conn, &skip_check_paths, true) {
                    Ok(count) => count,
                    Err(e) => return json!({ "ok": false, "error": e }),
                };
                skipped += skip_check_paths.len().saturating_sub(registered);
            }
            Err(e) => return json!({ "ok": false, "error": e.to_string() }),
        }
    }

    let created = !dest_existed && dest.exists();
    json!({
        "ok": true,
        "name": dest_name,
        "dest": dest.to_string_lossy().to_string(),
        "copied": copied,
        "registered": registered,
        "skipped": skipped,
        "failed": failed,
        "unsupported": unsupported,
        "unsupportedNames": unsupported_names,
        "dirsCreated": made_dirs.len(),
        "created": created,
        "replaced": replaced,
        "policy": policy
    })
}

#[tauri::command]
pub async fn import_dir_copy(
    src_dir: String,
    target_dir: String,
    opts: Option<serde_json::Value>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db = state.db.clone();
    let thumbs_dir = state.data_dir.join("cache").join("thumbs");
    tauri::async_runtime::spawn_blocking(move || {
        import_dir_copy_sync(&db, src_dir, target_dir, opts, &thumbs_dir)
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn import_urls(
    urls: Vec<String>,
    target_dir: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        import_urls_sync(&db, &urls, &target_dir, |url| {
            crate::collector::download_media_curl_limited(url, "", 500 * 1024 * 1024, false)
        })
    })
    .await
    .map_err(|e| e.to_string())
}

fn import_urls_sync(
    db: &Arc<Mutex<Connection>>,
    urls: &[String],
    target_dir: &str,
    download: impl Fn(&str) -> Result<(Vec<u8>, String), String>,
) -> serde_json::Value {
    let dst_dir = Path::new(target_dir);
    if !dst_dir.is_dir() {
        return json!({ "ok": false, "error": "目标目录不存在", "downloaded": 0, "failed": 0 });
    }

    let mut downloaded = 0usize;
    let mut failed = 0usize;
    let mut errors = Vec::new();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    for (idx, u) in urls.iter().take(20).enumerate() {
        let trimmed = u.trim();
        let low = trimmed.to_ascii_lowercase();
        if !(low.starts_with("http://") || low.starts_with("https://")) {
            failed += 1;
            errors.push(format!("第 {} 个 URL 不是 HTTP(S) 地址", idx + 1));
            continue;
        }

        let raw_tail = trimmed
            .split('?')
            .next()
            .unwrap_or("")
            .split('#')
            .next()
            .unwrap_or("")
            .rsplit('/')
            .next()
            .unwrap_or("");
        let mut name = sanitize_filename(raw_tail, "");
        let has_ext = Path::new(&name).extension().is_some();
        if name.is_empty() || name.len() > 120 || !has_ext {
            name = format!("drag-{}-{}.jpg", ts, idx + 1);
        }
        let (bytes, _) = match download(trimmed) {
            Ok(data) => data,
            Err(error) => {
                failed += 1;
                errors.push(error);
                continue;
            }
        };
        let _filesystem_guard = crate::operation_journal::filesystem_operation_guard();
        let target = unique_dest_path(dst_dir, &name);
        let staged = match crate::fs_ops::stage_write_new(&target, &bytes) {
            Ok(file) => file,
            Err(error) => {
                failed += 1;
                errors.push(error);
                continue;
            }
        };
        let conn = match db.lock() {
            Ok(c) => c,
            Err(error) => {
                let cleanup = crate::fs_ops::rollback_staged(&staged)
                    .err()
                    .unwrap_or_default();
                failed += 1;
                errors.push(format!("{error}; 回滚: {cleanup}"));
                continue;
            }
        };
        match crate::operation_journal::commit_new_files(
            &conn,
            vec![(staged, json!({}))],
            |tx, files| index_disk_paths_in_tx(tx, &[files[0].final_path.clone()], true),
        ) {
            Ok(_) => downloaded += 1,
            Err(error) => {
                failed += 1;
                errors.push(error);
            }
        }
    }

    json!({
        "ok": failed == 0,
        "downloaded": downloaded,
        "failed": failed,
        "errors": errors
    })
}

/// Copy supported image/video/text files into `target_dir` as fresh copies (`name (n).ext` on collision)
/// and immediately index the created files into SQLite so grid views reflect them right away.
pub fn copy_images_sync(
    conn: Option<&Connection>,
    paths: &[String],
    target_dir: &str,
) -> serde_json::Value {
    let target_p = Path::new(target_dir);
    if !target_p.exists() || !target_p.is_dir() {
        return json!({ "ok": false, "error": "目标目录不存在", "copied": 0, "failed": 0 });
    }
    let mut copied = 0usize;
    let mut failed = 0usize;
    let mut staged_files: Vec<crate::fs_ops::StagedFile> = Vec::new();
    for raw in paths {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            failed += 1;
            continue;
        }
        let src = Path::new(trimmed);
        if !src.is_file() {
            failed += 1;
            continue;
        }
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if !is_supported_drop_ext(&ext) {
            failed += 1;
            continue;
        }
        let fname = src
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("image");
        let dest = unique_dest_path(target_p, fname);
        match crate::fs_ops::stage_copy_new(src, &dest) {
            Ok(staged) => {
                copied += 1;
                staged_files.push(staged);
            }
            Err(_) => {
                failed += 1;
            }
        }
    }
    let mut commit_error = None;
    if let Some(c) = conn {
        if !staged_files.is_empty() {
            match crate::operation_journal::commit_new_files(
                c,
                staged_files.iter().cloned().map(|file| (file, json!({}))).collect(),
                |tx, files| index_disk_paths_in_tx(tx, &files.iter().map(|f| f.final_path.clone()).collect::<Vec<_>>(), true),
            ) {
                Ok(_) => {}
                Err(e) => {
                    commit_error = Some(e);
                    copied = 0;
                }
            }
        }
    } else {
        let commit_result: Result<(), String> = (|| {
            for staged in &staged_files {
                crate::fs_ops::commit_staged(staged)?;
            }
            Ok(())
        })();
        if let Err(error) = commit_result {
            let mut rollback_errors = Vec::new();
            for staged in &staged_files {
                if let Err(rollback) = crate::fs_ops::rollback_staged(staged) {
                    rollback_errors.push(rollback);
                }
            }
            commit_error = Some(if rollback_errors.is_empty() {
                error
            } else {
                format!("{error}; 回滚失败: {}", rollback_errors.join("; "))
            });
            copied = 0;
        }
    }
    let out_paths: Vec<String> = if commit_error.is_none() {
        staged_files.iter().map(|p| p.final_path.to_string_lossy().to_string()).collect()
    } else {
        Vec::new()
    };
    json!({
        "ok": failed == 0 && commit_error.is_none(),
        "copied": copied,
        "failed": failed,
        "paths": out_paths,
        "error": commit_error
    })
}

#[tauri::command]
pub async fn copy_images(
    paths: Vec<String>,
    target_dir: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        Ok(copy_images_sync(Some(&conn), &paths, &target_dir))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn md5_matches_rfc1321_vectors() {
        assert_eq!(
            md5_digest_reader(std::io::Cursor::new(b"")).unwrap(),
            "d41d8cd98f00b204e9800998ecf8427e"
        );
        assert_eq!(
            md5_digest_reader(std::io::Cursor::new(b"abc")).unwrap(),
            "900150983cd24fb0d6963f7d28e17f72"
        );
        assert_eq!(
            md5_digest_reader(std::io::Cursor::new(b"message digest")).unwrap(),
            "f96b697d7cb7938d525a2f31aaf161d0"
        );
    }

    #[test]
    fn base64_decoder_roundtrips_binary_bytes() {
        let decoded = decode_base64("5Lit5paH").unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), "中文");
    }

    fn setup_test_env(name: &str) -> (crate::testutil::TempDir, Arc<Mutex<Connection>>, i64) {
        let base = crate::testutil::TempDir::new(&format!("picnest_imp_test_{}", name));
        let root = base.join("library");
        std::fs::create_dir_all(root.join("01_doc")).unwrap();
        let db_path = base.join("test.db");
        let conn = crate::db::init_db(&db_path).unwrap();
        conn.execute(
            "INSERT INTO folders (path, display_name) VALUES (?1, ?2)",
            params![root.to_string_lossy().to_string(), "library"],
        )
        .unwrap();
        let fid = conn.last_insert_rowid();
        (base, Arc::new(Mutex::new(conn)), fid)
    }

    #[test]
    fn import_files_registers_unindexed_ghost_and_restores_trashed_file() {
        let (base, db, fid) = setup_test_env("ghost");
        let target_dir = base.join("library").join("01_doc");
        let ghost = target_dir.join("ghost_pic.png");
        std::fs::write(&ghost, b"fake-png-bytes").unwrap();
        let ghost_str = ghost.to_string_lossy().to_string();

        // 1. 磁盘已有未入库文件直接拖入当前目录：必须补录进 images，不能计为 skipped
        let r1 = import_files_sync(&db, vec![ghost_str.clone()], target_dir.to_string_lossy().to_string(), None, &target_dir.join("thumbs"));
        assert_eq!(r1["registered"].as_u64(), Some(1));
        assert_eq!(r1["skipped"].as_u64(), Some(0));
        {
            let conn = db.lock().unwrap();
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM images WHERE folder_id = ?1 AND LOWER(file_path) = LOWER(?2) AND deleted_at IS NULL",
                    params![fid, &ghost_str],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 1);
        }

        // 2. 已经在库且激活的文件再次拖入：此时才计为 skipped
        let r2 = import_files_sync(&db, vec![ghost_str.clone()], target_dir.to_string_lossy().to_string(), None, &target_dir.join("thumbs"));
        assert_eq!(r2["registered"].as_u64(), Some(0));
        assert_eq!(r2["skipped"].as_u64(), Some(1));

        // 3. 若此前曾软删在回收站（deleted_at IS NOT NULL），用户显式再次拖入则恢复显示
        {
            let conn = db.lock().unwrap();
            conn.execute(
                "UPDATE images SET deleted_at = 1700000000 WHERE LOWER(file_path) = LOWER(?1)",
                params![&ghost_str],
            )
            .unwrap();
        }
        let r3 = import_files_sync(&db, vec![ghost_str.clone()], target_dir.to_string_lossy().to_string(), None, &target_dir.join("thumbs"));
        assert_eq!(r3["registered"].as_u64(), Some(1));
        assert_eq!(r3["skipped"].as_u64(), Some(0));
        {
            let conn = db.lock().unwrap();
            let active: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM images WHERE LOWER(file_path) = LOWER(?1) AND deleted_at IS NULL",
                    params![&ghost_str],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(active, 1);
        }

        let _ = trash::delete(&base);
    }

    #[test]
    fn import_dir_copy_registers_existing_unindexed_same_place_file() {
        let (base, db, _fid) = setup_test_env("dir_ghost");
        let src_folder = base.join("ext_src").join("pack");
        let dst_parent = base.join("library");
        let dst_folder = dst_parent.join("pack");
        std::fs::create_dir_all(&src_folder).unwrap();
        std::fs::create_dir_all(&dst_folder).unwrap();
        std::fs::write(src_folder.join("a.png"), b"same-content-123").unwrap();
        let existing_unindexed = dst_folder.join("a.png");
        std::fs::write(&existing_unindexed, b"same-content-123").unwrap();

        let res = import_dir_copy_sync(
            &db,
            src_folder.to_string_lossy().to_string(),
            dst_parent.to_string_lossy().to_string(),
            None,
            &base.join("thumbs"),
        );
        assert_eq!(res["registered"].as_u64(), Some(1));
        assert_eq!(res["skipped"].as_u64(), Some(0));
        {
            let conn = db.lock().unwrap();
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM images WHERE LOWER(file_path) = LOWER(?1) AND deleted_at IS NULL",
                    params![existing_unindexed.to_string_lossy().to_string()],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 1);
        }

        let _ = trash::delete(&base);
    }

    #[test]
    fn copy_images_creates_unique_copies_and_indexes_immediately() {
        let (base, db, _fid) = setup_test_env("copy_imgs");
        let src_dir = base.join("src");
        let target_dir = base.join("library").join("sub");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::create_dir_all(&target_dir).unwrap();
        let src_a = src_dir.join("sample.png");
        let existing_a = target_dir.join("sample.png");
        std::fs::write(&src_a, b"src-bytes").unwrap();
        std::fs::write(&existing_a, b"existing-bytes").unwrap();

        let conn = db.lock().unwrap();
        let res = copy_images_sync(
            Some(&conn),
            &[src_a.to_string_lossy().to_string()],
            &target_dir.to_string_lossy(),
        );
        assert_eq!(res["ok"], true);
        assert_eq!(res["copied"], 1);
        assert_eq!(res["failed"], 0);
        let copy_path = target_dir.join("sample (1).png");
        assert!(copy_path.exists());
        assert_eq!(std::fs::read(&copy_path).unwrap(), b"src-bytes");
        assert_eq!(std::fs::read(&existing_a).unwrap(), b"existing-bytes");

        let indexed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM images WHERE LOWER(file_path) = LOWER(?1) AND deleted_at IS NULL",
                params![copy_path.to_string_lossy().to_string()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(indexed, 1);
        drop(conn);

        let _ = trash::delete(&base);
    }

    #[test]
    fn staged_import_sql_failure_leaves_no_final_file_or_journal() {
        let (base, db, _fid) = setup_test_env("import_fault");
        let source_dir = base.join("external");
        let target_dir = base.join("library").join("01_doc");
        std::fs::create_dir_all(&source_dir).unwrap();
        let source = source_dir.join("source.png");
        std::fs::write(&source, b"payload").unwrap();
        {
            let conn = db.lock().unwrap();
            conn.execute_batch("CREATE TRIGGER reject_import BEFORE INSERT ON images BEGIN SELECT RAISE(ABORT, 'injected import failure'); END;").unwrap();
        }
        let result = import_files_sync(
            &db,
            vec![source.to_string_lossy().to_string()],
            target_dir.to_string_lossy().to_string(),
            None,
            &base.join("thumbs"),
        );
        assert_eq!(result["ok"], false);
        assert!(result["error"].as_str().unwrap_or_default().contains("injected import failure"), "{result}");
        assert!(!target_dir.join("source.png").exists());
        assert!(!std::fs::read_dir(&target_dir).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with(".picnest-part-")));
        let conn = db.lock().unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM images", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn url_import_downloads_then_indexes_in_the_same_commit() {
        let (base, db, _fid) = setup_test_env("url_ok");
        let target_dir = base.join("library").join("01_doc");
        let url = "https://images.example.invalid/photo.jpg?size=large";
        let result = import_urls_sync(&db, &[url.to_string()], &target_dir.to_string_lossy(), |requested| {
            assert_eq!(requested, url);
            Ok((b"payload".to_vec(), "image/jpeg".to_string()))
        });
        assert_eq!(result["ok"], true);
        assert_eq!(result["downloaded"], 1);
        assert_eq!(result["failed"], 0);
        let final_path = target_dir.join("photo.jpg");
        assert_eq!(std::fs::read(&final_path).unwrap(), b"payload");
        let conn = db.lock().unwrap();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM images WHERE file_path = ?1 AND deleted_at IS NULL",
            [final_path.to_string_lossy().to_string()],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(count, 1);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn url_import_sql_failure_removes_final_file_and_reports_failure() {
        let (base, db, _fid) = setup_test_env("url_fault");
        let target_dir = base.join("library").join("01_doc");
        {
            let conn = db.lock().unwrap();
            conn.execute_batch("CREATE TRIGGER reject_url BEFORE INSERT ON images BEGIN SELECT RAISE(ABORT, 'injected url failure'); END;").unwrap();
        }
        let result = import_urls_sync(
            &db,
            &["https://images.example.invalid/photo.jpg".to_string()],
            &target_dir.to_string_lossy(),
            |_| Ok((b"payload".to_vec(), "image/jpeg".to_string())),
        );
        assert_eq!(result["ok"], false);
        assert_eq!(result["downloaded"], 0);
        assert_eq!(result["failed"], 1);
        assert!(result["errors"][0].as_str().unwrap_or_default().contains("injected url failure"), "{result}");
        assert!(!target_dir.join("photo.jpg").exists());
        assert!(!std::fs::read_dir(&target_dir).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with(".picnest-part-")));
        assert_eq!(db.lock().unwrap().query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }
}
