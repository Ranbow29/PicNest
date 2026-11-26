use crate::fs_ops::{rollback_staged, StagedFile};
use rusqlite::{params, Connection, Transaction};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

pub(crate) const METADATA_IDENTITY: &str = "metadata-sample-v1";
const SAMPLE_BYTES: u64 = 4 * 1024;

pub(crate) fn filesystem_operation_guard() -> std::sync::MutexGuard<'static, ()> {
    static GUARD: OnceLock<Mutex<()>> = OnceLock::new();
    GUARD.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[derive(Debug, Clone)]
pub(crate) struct PathMoveIdentity {
    pub directory: bool,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub(crate) struct PathMove {
    pub id: i64,
    pub source: PathBuf,
    pub target: PathBuf,
    pub directory: bool,
    pub size: Option<u64>,
    pub sha256: Option<String>,
}

pub(crate) fn capture_path_identity(path: &Path) -> Result<PathMoveIdentity, String> {
    let metadata = std::fs::metadata(path)
        .map_err(|e| format!("读取移动路径失败 {}: {e}", path.display()))?;
    let directory = metadata.is_dir();
    if !directory && !metadata.is_file() {
        return Err(format!("移动路径不是普通文件或目录: {}", path.display()));
    }
    let (size, sha256) = if directory {
        tree_identity(path)?
    } else {
        file_identity(path)?
    };
    Ok(PathMoveIdentity { directory, size, sha256 })
}

pub(crate) fn begin_path_move(
    conn: &Connection,
    source: &Path,
    target: &Path,
    identity: PathMoveIdentity,
) -> Result<PathMove, String> {
    validate_move_paths(source, target, identity.directory)?;
    let id = create(
        conn,
        "path_move",
        "prepared",
        &source.to_string_lossy(),
        &target.to_string_lossy(),
        json!({
            "version": 3, "identity": METADATA_IDENTITY, "directory": identity.directory,
            "size": identity.size, "sha256": identity.sha256
        }),
    )?;
    Ok(PathMove {
        id, source: source.to_path_buf(), target: target.to_path_buf(), directory: identity.directory,
        size: Some(identity.size), sha256: Some(identity.sha256),
    })
}

fn validate_move_paths(source: &Path, target: &Path, directory: bool) -> Result<(), String> {
    let metadata = std::fs::metadata(source)
        .map_err(|e| format!("检查移动源路径失败 {}: {e}", source.display()))?;
    if metadata.is_dir() != directory {
        return Err(format!("移动源路径类型已变化: {}", source.display()));
    }
    match std::fs::metadata(target) {
        Ok(_) => {
            if !crate::fs_ops::paths_alias(source, target) {
                return Err(format!("移动目标已存在，拒绝覆盖: {}", target.display()));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("检查移动目标失败 {}: {error}", target.display())),
    }
    Ok(())
}

pub(crate) fn mark_path_applied(conn: &Connection, op: &PathMove) -> Result<(), String> {
    set_state(conn, op.id, "file_applied", None)
}

pub(crate) fn rollback_path_files(op: &PathMove) -> Result<(), String> {
    let source_exists = op.source.exists();
    let target_exists = op.target.exists();
    if source_exists && target_exists && crate::fs_ops::paths_alias(&op.source, &op.target) {
        verify_move_identity(op, &op.target)?;
        return crate::fs_ops::rename_no_replace(&op.target, &op.source)
            .map_err(|e| format!("逆向改名失败，操作需人工确认: {} -> {}: {e}", op.target.display(), op.source.display()));
    }
    if source_exists && !target_exists {
        verify_move_identity(op, &op.source)?;
        return Ok(());
    }
    if source_exists || !target_exists {
        return Err(format!("移动状态不明确，拒绝自动回滚: {} / {}", op.source.display(), op.target.display()));
    }
    verify_move_identity(op, &op.target)?;
    crate::fs_ops::rename_no_replace(&op.target, &op.source)
        .map_err(|e| format!("逆向改名失败，操作需人工确认: {} -> {}: {e}", op.target.display(), op.source.display()))
}

fn verify_move_identity(op: &PathMove, path: &Path) -> Result<(), String> {
    let (Some(expected_size), Some(expected_hash)) = (op.size, op.sha256.as_deref()) else {
        return Err("移动日志缺少内容身份，拒绝自动回滚".to_string());
    };
    let identity = capture_path_identity(path)?;
    if identity.directory != op.directory || identity.size != expected_size || identity.sha256 != expected_hash {
        return Err(format!("移动路径内容已变化，拒绝自动回滚: {}", path.display()));
    }
    Ok(())
}

fn path_move_from_operation(op: &Operation) -> Result<PathMove, String> {
    Ok(PathMove {
        id: op.id,
        source: PathBuf::from(&op.source_path),
        target: PathBuf::from(&op.target_path),
        directory: op.payload.get("directory").and_then(Value::as_bool)
            .unwrap_or_else(|| Path::new(&op.source_path).is_dir() || Path::new(&op.target_path).is_dir()),
        size: op.payload.get("size").and_then(Value::as_u64),
        sha256: op.payload.get("sha256").and_then(Value::as_str).map(ToString::to_string),
    })
}

fn require_metadata_identity(payload: &Value, version: u64) -> Result<(), String> {
    if payload.get("version").and_then(Value::as_u64) != Some(version)
        || payload.get("identity").and_then(Value::as_str) != Some(METADATA_IDENTITY)
    {
        return Err("操作日志不是受支持的元数据指纹版本，拒绝自动恢复".to_string());
    }
    Ok(())
}

fn recover_cross_volume_staging(op: &Operation) -> Result<(), String> {
    let staging = op.payload.get("stagingPath").and_then(Value::as_str).map(PathBuf::from);
    let source = Path::new(&op.source_path);
    let target = Path::new(&op.target_path);
    let source_exists = source.exists();
    let target_exists = target.exists();
    if let Some(staging) = staging {
        let is_operation_staging = staging.file_name().and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(".picnest-part-dir-"));
        if !is_operation_staging || staging.parent() != target.parent() {
            return Err("跨卷日志的暂存路径不合法，拒绝自动恢复".to_string());
        }
        if staging.exists() {
            if !source_exists || target_exists {
                return Err("跨卷暂存目录存在但源目标状态不明确，拒绝自动恢复".to_string());
            }
            let marker = crate::trash_ops::staging_marker_path(&staging, op.id);
            let marker_metadata = std::fs::symlink_metadata(&marker)
                .map_err(|e| format!("跨卷暂存目录缺少恢复标记，拒绝自动恢复: {e}"))?;
            let expected_marker = op.id.to_string();
            if !marker_metadata.is_file() || marker_metadata.len() != expected_marker.len() as u64
                || std::fs::read_to_string(&marker).map_err(|e| e.to_string())? != expected_marker
            {
                return Err("跨卷暂存目录恢复标记不匹配，拒绝自动恢复".to_string());
            }
            let expected_hash = op.payload.get("stagingSha256").and_then(Value::as_str)
                .ok_or("跨卷日志缺少暂存目录哈希，拒绝自动恢复")?;
            if crate::trash_ops::tree_content_identity_for_staging(&staging, op.id)? != expected_hash {
                return Err("跨卷暂存目录内容已变化，拒绝自动恢复".to_string());
            }
            trash::delete(&staging)
                .map_err(|e| format!("跨卷暂存目录移入回收站失败: {e}"))?;
        }
    }
    if op.payload.get("crossVolume").and_then(Value::as_bool) == Some(true)
        && !(source_exists && !target_exists)
    {
        return Err("跨卷目录复制可能已回收源目录，拒绝自动恢复".to_string());
    }
    Ok(())
}

fn recover_path_move(conn: &mut Connection, op: &Operation) -> Result<(), String> {
    require_metadata_identity(&op.payload, 3)?;
    recover_cross_volume_staging(op)?;
    let move_op = path_move_from_operation(op)?;
    rollback_path_files(&move_op)?;
    conn.execute("DELETE FROM picnest_operations WHERE id = ?1", [op.id])
        .map_err(|e| format!("清理移动操作日志失败: {e}"))?;
    Ok(())
}

#[derive(Debug, Clone)]
pub(crate) struct BatchRenameItem {
    pub old: PathBuf,
    pub temp: PathBuf,
    pub final_path: PathBuf,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub(crate) struct BatchRename {
    pub id: i64,
    pub items: Vec<BatchRenameItem>,
}

fn mtime_ns(path: &Path, metadata: &std::fs::Metadata) -> Result<u128, String> {
    metadata.modified()
        .map_err(|e| format!("读取修改时间失败 {}: {e}", path.display()))?
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .map_err(|_| format!("修改时间早于 UNIX epoch: {}", path.display()))
}

fn hash_length_prefixed(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update((bytes.len() as u64).to_le_bytes());
    hasher.update(bytes);
}

fn hash_file_sample<R: Read + Seek>(reader: &mut R, size: u64, hasher: &mut Sha256) -> Result<(), String> {
    hasher.update(size.to_le_bytes());
    let head_len = size.min(SAMPLE_BYTES) as usize;
    let mut head = vec![0u8; head_len];
    reader.read_exact(&mut head).map_err(|e| e.to_string())?;
    hasher.update((head_len as u64).to_le_bytes());
    hasher.update(&head);
    let tail_len = size.saturating_sub(SAMPLE_BYTES).min(SAMPLE_BYTES) as usize;
    if tail_len > 0 {
        reader.seek(SeekFrom::Start(size - tail_len as u64)).map_err(|e| e.to_string())?;
        let mut tail = vec![0u8; tail_len];
        reader.read_exact(&mut tail).map_err(|e| e.to_string())?;
        hasher.update((tail_len as u64).to_le_bytes());
        hasher.update(&tail);
    } else {
        hasher.update(0u64.to_le_bytes());
    }
    Ok(())
}

fn file_identity(path: &Path) -> Result<(u64, String), String> {
    let mut file = File::open(path).map_err(|e| format!("读取移动文件失败 {}: {e}", path.display()))?;
    let metadata = file.metadata().map_err(|e| format!("读取文件元数据失败 {}: {e}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("移动路径不是普通文件: {}", path.display()));
    }
    let size = metadata.len();
    let mut hasher = Sha256::new();
    hasher.update(b"picnest-file-metadata-sample-v1");
    hasher.update(mtime_ns(path, &metadata)?.to_le_bytes());
    hash_file_sample(&mut file, size, &mut hasher)?;
    Ok((size, format!("{:x}", hasher.finalize())))
}

fn tree_identity(root: &Path) -> Result<(u64, String), String> {
    let mut hasher = Sha256::new();
    hasher.update(b"picnest-tree-metadata-v1");
    let mut total = 0u64;
    hash_tree_metadata(root, root, &mut hasher, &mut total)?;
    Ok((total, format!("{:x}", hasher.finalize())))
}

fn hash_tree_metadata(
    root: &Path,
    dir: &Path,
    hasher: &mut Sha256,
    total: &mut u64,
) -> Result<(), String> {
    let mut children = std::fs::read_dir(dir)
        .map_err(|e| format!("读取目录身份失败 {}: {e}", dir.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("遍历目录身份失败 {}: {e}", dir.display()))?;
    children.sort_by_key(|entry| entry.file_name());
    for child in children {
        let path = child.path();
        let rel = path.strip_prefix(root).map_err(|e| e.to_string())?;
        hash_length_prefixed(hasher, rel.as_os_str().as_encoded_bytes());
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|e| format!("读取目录项元数据失败 {}: {e}", path.display()))?;
        let file_type = metadata.file_type();
        hasher.update(metadata.len().to_le_bytes());
        hasher.update(mtime_ns(&path, &metadata)?.to_le_bytes());
        if file_type.is_dir() {
            hasher.update(b"dir");
            hash_tree_metadata(root, &path, hasher, total)?;
        } else if file_type.is_file() {
            hasher.update(b"file");
            *total = total.checked_add(metadata.len()).ok_or("目录内容总大小溢出")?;
        } else if file_type.is_symlink() {
            hasher.update(b"link");
            let target = std::fs::read_link(&path)
                .map_err(|e| format!("读取符号链接身份失败 {}: {e}", path.display()))?;
            hash_length_prefixed(hasher, target.as_os_str().as_encoded_bytes());
        } else {
            return Err(format!("目录包含不支持的身份类型: {}", path.display()));
        }
    }
    Ok(())
}

pub(crate) fn prepare_batch_rename(paths: &[(PathBuf, PathBuf)]) -> Result<Vec<BatchRenameItem>, String> {
    let nonce = crate::security::random_hex(8)?;
    let mut items = Vec::with_capacity(paths.len());
    for (index, (old, final_path)) in paths.iter().enumerate() {
        let identity = capture_path_identity(old)?;
        if identity.directory {
            return Err(format!("批量改名只支持文件: {}", old.display()));
        }
        let name = old.file_name().and_then(|n| n.to_str()).unwrap_or("image");
        let temp = old.parent().ok_or("批量改名缺少父目录")?.join(format!(
            ".picnest-part-batch-{}-{}-{}-{}", std::process::id(), nonce, index, name
        ));
        items.push(BatchRenameItem { old: old.clone(), temp, final_path: final_path.clone(), size: identity.size, sha256: identity.sha256 });
    }
    Ok(items)
}

pub(crate) fn begin_batch_rename(conn: &Connection, items: Vec<BatchRenameItem>) -> Result<BatchRename, String> {
    if items.is_empty() {
        return Err("批量改名计划为空".to_string());
    }
    let old_keys: HashSet<String> = items.iter().map(|item| item.old.to_string_lossy().to_lowercase()).collect();
    let old_canonical: HashSet<PathBuf> = items.iter().filter_map(|item| std::fs::canonicalize(&item.old).ok()).collect();
    for item in &items {
        let metadata = std::fs::metadata(&item.old)
            .map_err(|e| format!("检查批量改名源文件失败 {}: {e}", item.old.display()))?;
        if !metadata.is_file() {
            return Err(format!("批量改名源路径不是文件: {}", item.old.display()));
        }
        if item.temp.exists() {
            return Err(format!("批量改名临时路径已存在: {}", item.temp.display()));
        }
        if item.final_path.exists() {
            let same_as_plan = old_keys.contains(&item.final_path.to_string_lossy().to_lowercase())
                || std::fs::canonicalize(&item.final_path).ok().is_some_and(|path| old_canonical.contains(&path));
            if !same_as_plan {
                return Err(format!("批量改名目标已存在，拒绝覆盖: {}", item.final_path.display()));
            }
        }
    }
    let payload = json!({ "version": 2, "identity": METADATA_IDENTITY, "items": items.iter().map(|item| json!({
        "old": item.old.to_string_lossy(), "temp": item.temp.to_string_lossy(),
        "final": item.final_path.to_string_lossy(), "size": item.size, "sha256": item.sha256
    })).collect::<Vec<_>>() });
    let source = items.first().ok_or("批量改名计划为空")?.old.to_string_lossy().to_string();
    let target = items.first().unwrap().final_path.to_string_lossy().to_string();
    let id = create(conn, "batch_rename", "prepared", &source, &target, payload)?;
    Ok(BatchRename { id, items })
}

pub(crate) fn rollback_batch_files(batch: &BatchRename) -> Result<(), String> {
    let mut active_paths = Vec::with_capacity(batch.items.len());
    for item in &batch.items {
        let mut candidates = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for path in [&item.final_path, &item.temp, &item.old] {
            if !path.exists() {
                continue;
            }
            if let Ok(canonical) = std::fs::canonicalize(path) {
                if !seen.insert(canonical) {
                    continue;
                }
            }
            candidates.push(path.clone());
        }
        let mut matches = Vec::new();
        for candidate in candidates {
            let identity = capture_path_identity(&candidate)?;
            if !identity.directory && identity.size == item.size && identity.sha256 == item.sha256 {
                matches.push(candidate);
            }
        }
        if matches.len() != 1 {
            return Err(format!("批量改名文件缺失、已变化或状态不明确: {}", item.old.display()));
        }
        active_paths.push(matches.pop().unwrap());
    }

    let mut moved_to_temp = vec![false; batch.items.len()];
    for (index, (item, active)) in batch.items.iter().zip(&active_paths).enumerate() {
        if active == &item.old {
            continue;
        }
        if active != &item.temp {
            crate::fs_ops::rename_no_replace(active, &item.temp)
                .map_err(|e| format!("批量改名逆向恢复失败 {} -> {}: {e}", active.display(), item.temp.display()))?;
        }
        moved_to_temp[index] = true;
    }
    for (item, moved) in batch.items.iter().zip(&moved_to_temp) {
        if *moved {
            crate::fs_ops::rename_no_replace(&item.temp, &item.old)
                .map_err(|e| format!("批量改名逆向恢复失败 {} -> {}: {e}", item.temp.display(), item.old.display()))?;
        }
    }
    Ok(())
}

fn recover_batch_rename(conn: &mut Connection, op: &Operation) -> Result<(), String> {
    require_metadata_identity(&op.payload, 2)?;
    let values = op.payload.get("items").and_then(Value::as_array)
        .ok_or("批量改名日志缺少 items")?;
    let mut items = Vec::with_capacity(values.len());
    for value in values {
        let text = |key: &str| value.get(key).and_then(Value::as_str)
            .ok_or_else(|| format!("批量改名日志缺少 {key}"));
        items.push(BatchRenameItem {
            old: PathBuf::from(text("old")?),
            temp: PathBuf::from(text("temp")?),
            final_path: PathBuf::from(text("final")?),
            size: value.get("size").and_then(Value::as_u64).ok_or("批量改名日志缺少 size")?,
            sha256: text("sha256")?.to_string(),
        });
    }
    rollback_batch_files(&BatchRename { id: op.id, items })?;
    conn.execute("DELETE FROM picnest_operations WHERE id = ?1", [op.id])
        .map_err(|e| format!("清理批量改名日志失败: {e}"))?;
    Ok(())
}

#[derive(Debug, Clone)]
pub(crate) struct Operation {
    pub id: i64,
    pub kind: String,
    pub source_path: String,
    pub target_path: String,
    pub payload: Value,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

pub(crate) fn create(
    conn: &Connection,
    kind: &str,
    state: &str,
    source_path: &str,
    target_path: &str,
    payload: Value,
) -> Result<i64, String> {
    let payload = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    let now = now_ms();
    conn.execute(
        "INSERT INTO picnest_operations (kind, state, source_path, target_path, payload, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![kind, state, source_path, target_path, payload, now],
    )
    .map_err(|e| format!("写入操作日志失败: {e}"))?;
    Ok(conn.last_insert_rowid())
}

pub(crate) fn set_state(
    conn: &Connection,
    id: i64,
    state: &str,
    last_error: Option<&str>,
) -> Result<(), String> {
    let changed = conn.execute(
        "UPDATE picnest_operations SET state = ?1, last_error = ?2, updated_at = ?3 WHERE id = ?4",
        params![state, last_error, now_ms(), id],
    )
    .map_err(|e| format!("更新操作日志失败: {e}"))?;
    if changed != 1 {
        return Err("操作日志不存在或已变化".to_string());
    }
    Ok(())
}

pub(crate) fn tag_path_move(
    conn: &Connection,
    id: i64,
    kind: &str,
    state: &str,
    payload: Value,
) -> Result<(), String> {
    let previous: String = conn.query_row(
        "SELECT payload FROM picnest_operations WHERE id = ?1", [id], |r| r.get(0),
    ).map_err(|e| format!("读取移动日志失败: {e}"))?;
    let mut merged: Value = serde_json::from_str(&previous).map_err(|e| format!("解析移动日志失败: {e}"))?;
    let object = merged.as_object_mut().ok_or("移动日志 payload 不是对象")?;
    object.extend(payload.as_object().cloned().unwrap_or_default());
    let payload = serde_json::to_string(&merged).map_err(|e| e.to_string())?;
    let changed = conn.execute(
        "UPDATE picnest_operations SET kind = ?1, state = ?2, payload = ?3, updated_at = ?4 WHERE id = ?5",
        params![kind, state, payload, now_ms(), id],
    ).map_err(|e| format!("更新移动日志失败: {e}"))?;
    if changed != 1 {
        return Err("移动日志不存在或已变化".to_string());
    }
    Ok(())
}

pub(crate) fn extend_path_move_payload(
    conn: &Connection,
    id: i64,
    payload: Value,
) -> Result<(), String> {
    let previous: String = conn.query_row(
        "SELECT payload FROM picnest_operations WHERE id = ?1", [id], |r| r.get(0),
    ).map_err(|e| format!("读取移动日志失败: {e}"))?;
    let mut merged: Value = serde_json::from_str(&previous).map_err(|e| format!("解析移动日志失败: {e}"))?;
    let object = merged.as_object_mut().ok_or("移动日志 payload 不是对象")?;
    object.extend(payload.as_object().cloned().unwrap_or_default());
    let payload = serde_json::to_string(&merged).map_err(|e| e.to_string())?;
    let changed = conn.execute(
        "UPDATE picnest_operations SET payload = ?1, updated_at = ?2 WHERE id = ?3",
        params![payload, now_ms(), id],
    ).map_err(|e| format!("更新移动日志失败: {e}"))?;
    if changed != 1 {
        return Err("移动日志不存在或已变化".to_string());
    }
    Ok(())
}

pub(crate) fn mark_manual(conn: &Connection, id: i64, error: &str) -> Result<(), String> {
    set_state(conn, id, "needs_review", Some(error))
}

pub(crate) fn begin_file_replacements(
    conn: &Connection,
    old_paths: &[&str],
    staged: &StagedFile,
) -> Result<Vec<i64>, String> {
    let target = staged.final_path.to_string_lossy().to_string();
    let mut ids = Vec::with_capacity(old_paths.len());
    for old in old_paths {
        let payload = json!({
            "version": 1,
            "oldPath": old,
            "staged": staged.payload()
        });
        ids.push(create(conn, "replace_file", "prepared", old, &target, payload)?);
    }
    Ok(ids)
}

pub(crate) fn finish_in_tx(tx: &Transaction<'_>, id: i64) -> Result<(), String> {
    let changed = tx.execute("DELETE FROM picnest_operations WHERE id = ?1", [id])
        .map_err(|e| format!("完成操作日志失败: {e}"))?;
    if changed != 1 {
        return Err("操作日志不存在或已变化".to_string());
    }
    Ok(())
}

pub(crate) fn commit_new_files<T>(
    conn: &Connection,
    items: Vec<(StagedFile, Value)>,
    apply: impl FnOnce(&Transaction<'_>, &[StagedFile]) -> Result<T, String>,
) -> Result<T, String> {
    if items.is_empty() {
        return Err("没有可提交的新文件".to_string());
    }
    let finish_ids: Vec<i64> = items.iter().flat_map(|(_, extra)| {
        let mut ids: Vec<i64> = extra.get("finishOperationId").and_then(Value::as_i64).into_iter().collect();
        if let Some(values) = extra.get("finishOperationIds").and_then(Value::as_array) {
            ids.extend(values.iter().filter_map(Value::as_i64));
        }
        ids
    }).collect();
    let mut ids = Vec::with_capacity(items.len());
    let journal_result: Result<(), String> = (|| {
        let tx = conn.unchecked_transaction().map_err(|e| format!("开启操作日志事务失败: {e}"))?;
        for (staged, extra) in &items {
            let mut payload = staged.payload();
            if let Some(object) = payload.as_object_mut() {
                object.extend(extra.as_object().cloned().unwrap_or_default());
            }
            let source = staged.temp_path.to_string_lossy().to_string();
            let target = staged.final_path.to_string_lossy().to_string();
            let id = create(&tx, "new_file", "prepared", &source, &target, payload)?;
            ids.push(id);
        }
        tx.commit().map_err(|e| format!("提交操作日志失败: {e}"))?;
        Ok(())
    })();
    if let Err(error) = journal_result {
        let rollback_errors: Vec<String> = items
            .iter()
            .filter_map(|(staged, _)| rollback_staged(staged).err())
            .collect();
        return Err(format!("{error}; 回滚: {}", rollback_errors.join("; ")));
    }

    let rollback_after_failure = |cause: &str| -> Vec<String> {
        let mut errors = Vec::new();
        for item in &items {
            if let Err(error) = rollback_staged(&item.0) {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            match conn.unchecked_transaction().map_err(|e| e.to_string())
                .and_then(|tx| {
                    for id in &ids {
                        finish_in_tx(&tx, *id)?;
                    }
                    tx.commit().map_err(|e| e.to_string())
                }) {
                Ok(()) => {}
                Err(error) => errors.push(error),
            }
        }
        let preserve_journals = !errors.is_empty();
        for id in &ids {
            if preserve_journals
                && let Err(error) = mark_manual(conn, *id, &errors.join("; "))
            {
                errors.push(error);
            }
        }
        for id in &finish_ids {
            if let Err(error) = mark_manual(conn, *id, cause) {
                errors.push(error);
            }
        }
        errors
    };

    for (committed, (staged, _)) in items.iter().enumerate() {
        if let Err(e) = crate::fs_ops::commit_staged(staged) {
            let rollback_errors = rollback_after_failure(&format!("提交新文件失败: {e}"));
            return Err(format!("提交新文件失败（已提交 {committed} 项）: {e}; 回滚: {}", rollback_errors.join("; ")));
        }
    }

    let result: Result<T, String> = (|| {
        let tx = conn.unchecked_transaction().map_err(|e| format!("开启入库事务失败: {e}"))?;
        let output = apply(&tx, &items.iter().map(|(s, _)| s.clone()).collect::<Vec<_>>())?;
        for id in &ids {
            finish_in_tx(&tx, *id)?;
        }
        for id in &finish_ids {
            finish_in_tx(&tx, *id)?;
        }
        tx.commit().map_err(|e| format!("提交入库事务失败: {e}"))?;
        Ok(output)
    })();
    match result {
        Ok(output) => Ok(output),
        Err(error) => {
            let rollback_errors = rollback_after_failure(&error);
            Err(format!("{error}; 回滚: {}", rollback_errors.join("; ")))
        }
    }
}

fn staged_from_payload(payload: &Value) -> Result<StagedFile, String> {
    let text = |key: &str| -> Result<String, String> {
        payload
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string)
            .ok_or_else(|| format!("操作日志缺少 {key}"))
    };
    Ok(StagedFile {
        temp_path: PathBuf::from(text("tempPath")?),
        final_path: PathBuf::from(text("finalPath")?),
        size: payload.get("size").and_then(Value::as_u64).ok_or("操作日志缺少 size")?,
        sha256: text("sha256")?,
    })
}

fn recover_new_file(conn: &mut Connection, op: &Operation) -> Result<(), String> {
    let staged = staged_from_payload(&op.payload)?;
    rollback_staged(&staged)?;
    conn.execute("DELETE FROM picnest_operations WHERE id = ?1", [op.id])
        .map_err(|e| format!("清理新文件操作日志失败: {e}"))?;
    Ok(())
}

fn finish_recovered_journal(conn: &mut Connection, id: i64) -> Result<(), String> {
    let changed = conn.execute("DELETE FROM picnest_operations WHERE id = ?1", [id])
        .map_err(|e| format!("清理恢复日志失败: {e}"))?;
    if changed != 1 {
        return Err("恢复日志不存在或已变化".to_string());
    }
    Ok(())
}

fn recover_replace_file(_conn: &mut Connection, op: &Operation) -> Result<(), String> {
    Err(format!("覆盖操作可能已把原文件移入回收站，拒绝自动恢复: {}", op.source_path))
}

fn recover_folder_trash(conn: &mut Connection, op: &Operation) -> Result<(), String> {
    require_metadata_identity(&op.payload, 3)?;
    recover_cross_volume_staging(op)?;
    let movement = path_move_from_operation(op)?;
    if !movement.directory {
        return Err("文件夹回收站日志缺少目录身份，拒绝自动恢复".to_string());
    }
    if op.kind == "folder_trash_copy" {
        return Err("跨卷文件夹回收站可能已删除源目录，拒绝自动恢复".to_string());
    }
    rollback_path_files(&movement)?;
    let trash_id = op.payload.get("trashId").and_then(Value::as_i64)
        .ok_or("文件夹回收站日志缺少 trashId")?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let changed = tx.execute("DELETE FROM picnest_trash_folders WHERE id = ?1", [trash_id])
        .map_err(|e| format!("清理回收站目录记录失败: {e}"))?;
    if changed != 1 {
        return Err("回收站目录记录不存在或已变化".to_string());
    }
    finish_in_tx(&tx, op.id)?;
    tx.commit().map_err(|e| e.to_string())
}

fn recover_folder_restore(conn: &mut Connection, op: &Operation) -> Result<(), String> {
    require_metadata_identity(&op.payload, 3)?;
    recover_cross_volume_staging(op)?;
    let movement = path_move_from_operation(op)?;
    if !movement.directory {
        return Err("文件夹还原日志缺少目录身份，拒绝自动恢复".to_string());
    }
    if op.kind == "folder_restore_copy" {
        return Err("跨卷文件夹还原可能已删除回收站源目录，拒绝自动恢复".to_string());
    }
    rollback_path_files(&movement)?;
    finish_recovered_journal(conn, op.id)
}

fn recover_folder_purge(conn: &mut Connection, op: &Operation) -> Result<(), String> {
    require_metadata_identity(&op.payload, 2)?;
    let movement = path_move_from_operation(op)?;
    if !movement.directory {
        return Err("回收站目录清除日志缺少目录身份，拒绝自动恢复".to_string());
    }
    let source = Path::new(&op.source_path);
    if !source.exists() {
        return Err("回收站目录已不存在，无法确认清除是否完成".to_string());
    }
    verify_move_identity(&movement, source)?;
    finish_recovered_journal(conn, op.id)
}

fn recover_image_purge(_conn: &mut Connection, op: &Operation) -> Result<(), String> {
    Err(format!("单图清除可能已移入回收站，拒绝自动恢复: {}", op.source_path))
}

pub(crate) fn recover_all(conn: &mut Connection) -> Vec<String> {
    let operations: Vec<Operation> = match conn.prepare(
        "SELECT id, kind, source_path, target_path, payload FROM picnest_operations WHERE state != 'needs_review' ORDER BY id",
    ) {
        Ok(mut stmt) => match stmt.query_map([], |r| {
            Ok(Operation {
                id: r.get(0)?,
                kind: r.get(1)?,
                source_path: r.get(2)?,
                target_path: r.get(3)?,
                payload: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or(Value::Null),
            })
        }) {
            Ok(rows) => match rows.collect::<Result<Vec<_>, _>>() {
                Ok(operations) => operations,
                Err(e) => return vec![format!("读取操作日志失败: {e}")],
            },
            Err(e) => return vec![format!("读取操作日志失败: {e}")],
        },
        Err(e) => return vec![format!("读取操作日志失败: {e}")],
    };

    let mut errors = Vec::new();
    for op in operations {
        let result = match op.kind.as_str() {
            "new_file" => recover_new_file(conn, &op),
            "replace_file" => recover_replace_file(conn, &op),
            "image_purge" => recover_image_purge(conn, &op),
            "path_move" => recover_path_move(conn, &op),
            "batch_rename" => recover_batch_rename(conn, &op),
            "folder_trash_pending" | "folder_trash_rename" | "folder_trash_copy" => recover_folder_trash(conn, &op),
            "folder_restore_pending" | "folder_restore_rename" | "folder_restore_copy" => recover_folder_restore(conn, &op),
            "folder_purge" => recover_folder_purge(conn, &op),
            _ => Err(format!("不支持自动恢复的操作类型: {}", op.kind)),
        };
        if let Err(e) = result {
            let _ = mark_manual(conn, op.id, &e);
            errors.push(format!("操作 {} 需人工确认: {}", op.id, e));
        }
    }
    errors
}

#[cfg(test)]
mod tests {
    use super::*;

    fn begin_test_move(conn: &Connection, source: &Path, target: &Path) -> Result<PathMove, String> {
        let identity = capture_path_identity(source)?;
        begin_path_move(conn, source, target, identity)
    }

    fn begin_test_batch(conn: &Connection, paths: &[(PathBuf, PathBuf)]) -> Result<BatchRename, String> {
        let items = prepare_batch_rename(paths)?;
        begin_batch_rename(conn, items)
    }

    #[test]
    fn sql_failure_rolls_back_new_file_and_journal() {
        let dir = crate::testutil::TempDir::new("picnest_journal_sql_fail");
        let conn = crate::db::init_db(&dir.join("test.db")).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER reject_image BEFORE INSERT ON images BEGIN SELECT RAISE(ABORT, 'injected'); END;",
        ).unwrap();
        let target = dir.join("new.png");
        let staged = crate::fs_ops::stage_write_new(&target, b"new").unwrap();
        let result = commit_new_files(&conn, vec![(staged, serde_json::json!({}))], |tx, files| {
            tx.execute("INSERT INTO images (file_path) VALUES (?1)", [files[0].final_path.to_string_lossy().to_string()]).map_err(|e| e.to_string())?;
            Ok(())
        });
        assert!(result.unwrap_err().contains("injected"));
        assert!(!target.exists());
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn journal_creation_failure_cleans_only_the_new_staging_file() {
        let dir = crate::testutil::TempDir::new("picnest_journal_create_fail");
        let conn = crate::db::init_db(&dir.join("test.db")).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER reject_journal BEFORE INSERT ON picnest_operations BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END;",
        ).unwrap();
        let target = dir.join("new.png");
        let staged = crate::fs_ops::stage_write_new(&target, b"new").unwrap();
        let result = commit_new_files(&conn, vec![(staged, serde_json::json!({}))], |_, _| {
            Ok::<(), String>(())
        });
        assert!(result.unwrap_err().contains("injected journal failure"));
        assert!(!target.exists());
        assert!(!std::fs::read_dir(dir.path()).unwrap().any(|entry| {
            entry.unwrap().file_name().to_string_lossy().starts_with(".picnest-part-")
        }));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn restart_recovery_removes_only_verified_uncommitted_file() {
        let dir = crate::testutil::TempDir::new("picnest_journal_restart");
        let db_path = dir.join("test.db");
        let target = dir.join("new.png");
        let staged = {
            let conn = crate::db::init_db(&db_path).unwrap();
            let staged = crate::fs_ops::stage_write_new(&target, b"new").unwrap();
            let id = create(&conn, "new_file", "prepared", staged.temp_path.to_str().unwrap(), target.to_str().unwrap(), staged.payload()).unwrap();
            crate::fs_ops::commit_staged(&staged).unwrap();
            assert!(conn.query_row("SELECT 1 FROM picnest_operations WHERE id = ?1", [id], |_| Ok(())).is_ok());
            staged
        };
        assert!(target.exists());
        let conn = crate::db::init_db(&db_path).unwrap();
        assert!(!target.exists());
        assert!(!staged.temp_path.exists());
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn file_identity_reads_at_most_head_and_tail_samples() {
        struct CountingReader {
            inner: std::io::Cursor<Vec<u8>>,
            read: usize,
        }
        impl Read for CountingReader {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                let count = self.inner.read(buf)?;
                self.read += count;
                Ok(count)
            }
        }
        impl Seek for CountingReader {
            fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
                self.inner.seek(position)
            }
        }

        let size = 2 * 1024 * 1024;
        let mut reader = CountingReader { inner: std::io::Cursor::new(vec![0x5a; size]), read: 0 };
        let mut hasher = Sha256::new();
        hash_file_sample(&mut reader, size as u64, &mut hasher).unwrap();
        assert_eq!(reader.read, 8 * 1024);
    }

    #[test]
    fn directory_identity_uses_metadata_without_file_content() {
        let dir = crate::testutil::TempDir::new("picnest_tree_metadata_identity");
        let source = dir.join("source");
        std::fs::create_dir(&source).unwrap();
        let file = source.join("image.bin");
        std::fs::write(&file, b"aaaa").unwrap();
        let before = capture_path_identity(&source).unwrap();
        let modified = std::fs::metadata(&file).unwrap().modified().unwrap();
        std::fs::write(&file, b"bbbb").unwrap();
        std::fs::OpenOptions::new().write(true).open(&file).unwrap().set_times(
            std::fs::FileTimes::new().set_modified(modified),
        ).unwrap();
        let after = capture_path_identity(&source).unwrap();
        assert_eq!(before.size, after.size);
        assert_eq!(before.sha256, after.sha256);
    }

    #[test]
    fn restart_recovery_reverses_a_verified_directory_move() {
        let dir = crate::testutil::TempDir::new("picnest_directory_restart");
        let db_path = dir.join("test.db");
        let source = dir.join("source");
        let target = dir.join("target");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(source.join("nested")).unwrap();
        std::fs::write(source.join("nested/image.png"), b"original").unwrap();
        {
            let conn = crate::db::init_db(&db_path).unwrap();
            let operation = begin_test_move(&conn, &source, &target).unwrap();
            crate::fs_ops::rename_no_replace(&source, &target).unwrap();
            mark_path_applied(&conn, &operation).unwrap();
        }
        let conn = crate::db::init_db(&db_path).unwrap();
        assert_eq!(std::fs::read(source.join("nested/image.png")).unwrap(), b"original");
        assert!(!target.exists());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn restart_recovery_requires_review_when_directory_structure_changed() {
        let dir = crate::testutil::TempDir::new("picnest_directory_restart_changed");
        let db_path = dir.join("test.db");
        let source = dir.join("source");
        let target = dir.join("target");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("image.png"), b"original").unwrap();
        {
            let conn = crate::db::init_db(&db_path).unwrap();
            let operation = begin_test_move(&conn, &source, &target).unwrap();
            crate::fs_ops::rename_no_replace(&source, &target).unwrap();
            mark_path_applied(&conn, &operation).unwrap();
            std::fs::write(target.join("new-user-file.png"), b"new").unwrap();
        }
        let conn = crate::db::init_db(&db_path).unwrap();
        assert!(!source.exists());
        assert_eq!(std::fs::read(target.join("new-user-file.png")).unwrap(), b"new");
        let state: String = conn.query_row("SELECT state FROM picnest_operations", [], |r| r.get(0)).unwrap();
        assert_eq!(state, "needs_review");
    }

    #[test]
    fn cross_volume_staging_recovery_rejects_an_unmarked_preexisting_directory() {
        let dir = crate::testutil::TempDir::new("picnest_cross_volume_unmarked_staging");
        let conn = crate::db::init_db(&dir.join("test.db")).unwrap();
        let source = dir.join("source");
        let target = dir.join("target");
        let staging = dir.join(".picnest-part-dir-1-abcdef-source");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&staging).unwrap();
        std::fs::write(source.join("one.png"), b"1234").unwrap();
        std::fs::write(staging.join("one.png"), b"1234").unwrap();
        let operation = begin_test_move(&conn, &source, &target).unwrap();
        let staging_hash = crate::trash_ops::tree_content_identity_for_staging(&staging, operation.id).unwrap();
        tag_path_move(&conn, operation.id, "folder_restore_pending", "prepared", json!({})).unwrap();
        extend_path_move_payload(&conn, operation.id, json!({
            "crossVolume": true,
            "stagingPath": staging.to_string_lossy(),
            "stagingSha256": staging_hash
        })).unwrap();
        drop(conn);
        let conn = crate::db::init_db(&dir.join("test.db")).unwrap();
        assert_eq!(std::fs::read(staging.join("one.png")).unwrap(), b"1234");
        assert_eq!(std::fs::read(source.join("one.png")).unwrap(), b"1234");
        let state: String = conn.query_row("SELECT state FROM picnest_operations", [], |r| r.get(0)).unwrap();
        assert_eq!(state, "needs_review");
    }

    #[test]
    fn cross_volume_staging_recovery_rejects_changed_content_even_with_a_valid_marker() {
        let dir = crate::testutil::TempDir::new("picnest_cross_volume_changed_staging");
        let conn = crate::db::init_db(&dir.join("test.db")).unwrap();
        let source = dir.join("source");
        let target = dir.join("target");
        let staging = dir.join(".picnest-part-dir-1-abcdef-source");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&staging).unwrap();
        std::fs::write(source.join("one.png"), b"1234").unwrap();
        std::fs::write(staging.join("one.png"), b"changed").unwrap();
        let operation = begin_test_move(&conn, &source, &target).unwrap();
        std::fs::write(crate::trash_ops::staging_marker_path(&staging, operation.id), operation.id.to_string()).unwrap();
        tag_path_move(&conn, operation.id, "folder_restore_pending", "prepared", json!({})).unwrap();
        extend_path_move_payload(&conn, operation.id, json!({
            "crossVolume": true,
            "stagingPath": staging.to_string_lossy(),
            "stagingSha256": "mismatched"
        })).unwrap();
        drop(conn);
        let conn = crate::db::init_db(&dir.join("test.db")).unwrap();
        assert_eq!(std::fs::read(staging.join("one.png")).unwrap(), b"changed");
        let state: String = conn.query_row("SELECT state FROM picnest_operations", [], |r| r.get(0)).unwrap();
        assert_eq!(state, "needs_review");
    }

    #[test]
    fn directory_rollback_rejects_content_changed_after_move() {
        let dir = crate::testutil::TempDir::new("picnest_directory_rollback_identity");
        let source = dir.join("source");
        let target = dir.join("target");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("image.png"), b"original").unwrap();
        let conn = crate::db::init_db(&dir.join("test.db")).unwrap();
        let operation = begin_test_move(&conn, &source, &target).unwrap();
        assert!(operation.directory);
        crate::fs_ops::rename_no_replace(&source, &target).unwrap();
        std::fs::write(target.join("image.png"), b"user changes").unwrap();
        assert!(rollback_path_files(&operation).is_err());
        assert_eq!(std::fs::read(target.join("image.png")).unwrap(), b"user changes");
        assert!(!source.exists());
    }

    #[test]
    fn directory_rollback_rejects_recreated_source_with_changed_content() {
        let dir = crate::testutil::TempDir::new("picnest_directory_source_identity");
        let source = dir.join("source");
        let target = dir.join("target");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("image.png"), b"original").unwrap();
        let conn = crate::db::init_db(&dir.join("test.db")).unwrap();
        let operation = begin_test_move(&conn, &source, &target).unwrap();
        std::fs::write(source.join("image.png"), b"recreated").unwrap();
        assert!(rollback_path_files(&operation).is_err());
        assert_eq!(std::fs::read(source.join("image.png")).unwrap(), b"recreated");
        assert!(!target.exists());
    }

    #[test]
    fn restart_recovery_reverses_an_applied_path_move() {
        let dir = crate::testutil::TempDir::new("picnest_path_restart");
        let db_path = dir.join("test.db");
        let source = dir.join("source.png");
        let target = dir.join("target.png");
        std::fs::write(&source, b"original").unwrap();
        {
            let conn = crate::db::init_db(&db_path).unwrap();
            let operation = begin_test_move(&conn, &source, &target).unwrap();
            std::fs::rename(&source, &target).unwrap();
            mark_path_applied(&conn, &operation).unwrap();
        }
        assert!(target.exists());
        let conn = crate::db::init_db(&db_path).unwrap();
        assert_eq!(std::fs::read(&source).unwrap(), b"original");
        assert!(!target.exists());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn restart_recovery_preserves_source_recreated_after_applied_move() {
        let dir = crate::testutil::TempDir::new("picnest_move_recreated");
        let db_path = dir.join("test.db");
        let source = dir.join("source.png");
        let target = dir.join("target.png");
        std::fs::write(&source, b"original").unwrap();
        {
            let conn = crate::db::init_db(&db_path).unwrap();
            let operation = begin_test_move(&conn, &source, &target).unwrap();
            crate::fs_ops::rename_no_replace(&source, &target).unwrap();
            mark_path_applied(&conn, &operation).unwrap();
        }
        std::fs::remove_file(&target).unwrap();
        std::fs::write(&source, b"recreated").unwrap();
        let conn = crate::db::init_db(&db_path).unwrap();
        assert_eq!(std::fs::read(&source).unwrap(), b"recreated");
        assert!(!target.exists());
        let state: String = conn.query_row("SELECT state FROM picnest_operations", [], |r| r.get(0)).unwrap();
        assert_eq!(state, "needs_review");
    }

    #[test]
    fn replacement_journal_survives_new_file_database_failure() {
        let dir = crate::testutil::TempDir::new("picnest_replace_failure");
        let conn = crate::db::init_db(&dir.join("test.db")).unwrap();
        conn.execute_batch("CREATE TRIGGER reject_replacement BEFORE INSERT ON images BEGIN SELECT RAISE(ABORT, 'injected replacement failure'); END;").unwrap();
        let target = dir.join("new.png");
        let staged = crate::fs_ops::stage_write_new(&target, b"new").unwrap();
        let ids = begin_file_replacements(&conn, &[dir.join("old.png").to_str().unwrap()], &staged).unwrap();
        let result = commit_new_files(&conn, vec![(staged, serde_json::json!({ "finishOperationIds": ids }))], |tx, files| {
            tx.execute("INSERT INTO images (file_path) VALUES (?1)", [files[0].final_path.to_string_lossy().to_string()])
                .map_err(|e| e.to_string())?;
            Ok(())
        });
        assert!(result.unwrap_err().contains("injected replacement failure"));
        assert!(!target.exists());
        let state: String = conn.query_row("SELECT state FROM picnest_operations WHERE kind = 'replace_file'", [], |r| r.get(0)).unwrap();
        assert_eq!(state, "needs_review");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_operations WHERE kind = 'new_file'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn restart_recovery_reverses_batch_intermediate_and_final_names() {
        let dir = crate::testutil::TempDir::new("picnest_batch_restart");
        let db_path = dir.join("test.db");
        let first_old = dir.join("b.png");
        let first_new = dir.join("01_a.png");
        let second_old = dir.join("a.png");
        let second_new = dir.join("02_b.png");
        std::fs::write(&first_old, b"first").unwrap();
        std::fs::write(&second_old, b"second").unwrap();
        {
            let conn = crate::db::init_db(&db_path).unwrap();
            let batch = begin_test_batch(&conn, &[(first_old.clone(), first_new.clone()), (second_old.clone(), second_new.clone())]).unwrap();
            std::fs::rename(&first_old, &batch.items[0].temp).unwrap();
            std::fs::rename(&second_old, &batch.items[1].temp).unwrap();
            std::fs::rename(&batch.items[0].temp, &first_new).unwrap();
        }
        assert!(first_new.exists());
        assert!(!first_old.exists());
        let conn = crate::db::init_db(&db_path).unwrap();
        assert_eq!(std::fs::read(&first_old).unwrap(), b"first");
        assert_eq!(std::fs::read(&second_old).unwrap(), b"second");
        assert!(!first_new.exists());
        assert!(!second_new.exists());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[cfg(windows)]
    #[test]
    fn restart_recovery_reverses_a_verified_case_only_move() {
        let dir = crate::testutil::TempDir::new("picnest_case_restart");
        let db_path = dir.join("test.db");
        let source = dir.join("Ä.png");
        let target = dir.join("ä.png");
        std::fs::write(&source, b"original").unwrap();
        {
            let conn = crate::db::init_db(&db_path).unwrap();
            let operation = begin_test_move(&conn, &source, &target).unwrap();
            crate::fs_ops::rename_no_replace(&source, &target).unwrap();
            mark_path_applied(&conn, &operation).unwrap();
        }
        let conn = crate::db::init_db(&db_path).unwrap();
        assert_eq!(std::fs::read(&source).unwrap(), b"original");
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .filter(|name| name.ends_with(".png"))
            .collect();
        assert_eq!(names, vec!["Ä.png".to_string()]);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[cfg(windows)]
    #[test]
    fn batch_rollback_restores_a_case_only_name() {
        let dir = crate::testutil::TempDir::new("picnest_batch_case_rollback");
        let source = dir.join("Ä.png");
        let target = dir.join("ä.png");
        std::fs::write(&source, b"original").unwrap();
        let conn = crate::db::init_db(&dir.join("test.db")).unwrap();
        let batch = begin_test_batch(&conn, &[(source.clone(), target.clone())]).unwrap();
        crate::fs_ops::rename_no_replace(&batch.items[0].old, &batch.items[0].temp).unwrap();
        crate::fs_ops::rename_no_replace(&batch.items[0].temp, &batch.items[0].final_path).unwrap();
        rollback_batch_files(&batch).unwrap();
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .filter(|name| name.ends_with(".png"))
            .collect();
        assert_eq!(names, vec!["Ä.png".to_string()]);
    }

    #[test]
    fn restart_recovery_reverses_a_batch_name_swap() {
        let dir = crate::testutil::TempDir::new("picnest_batch_swap_restart");
        let db_path = dir.join("test.db");
        let first_old = dir.join("a.png");
        let second_old = dir.join("b.png");
        std::fs::write(&first_old, b"first").unwrap();
        std::fs::write(&second_old, b"second").unwrap();
        {
            let conn = crate::db::init_db(&db_path).unwrap();
            let batch = begin_test_batch(&conn, &[(first_old.clone(), second_old.clone()), (second_old.clone(), first_old.clone())]).unwrap();
            for item in &batch.items {
                crate::fs_ops::rename_no_replace(&item.old, &item.temp).unwrap();
            }
            for item in &batch.items {
                crate::fs_ops::rename_no_replace(&item.temp, &item.final_path).unwrap();
            }
            crate::operation_journal::set_state(&conn, batch.id, "file_applied", None).unwrap();
        }
        let conn = crate::db::init_db(&db_path).unwrap();
        assert_eq!(std::fs::read(&first_old).unwrap(), b"first");
        assert_eq!(std::fs::read(&second_old).unwrap(), b"second");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn batch_recovery_rejects_simultaneous_temp_and_final_files() {
        let dir = crate::testutil::TempDir::new("picnest_batch_temp_final");
        let db_path = dir.join("test.db");
        let source = dir.join("source.png");
        let target = dir.join("target.png");
        std::fs::write(&source, b"original").unwrap();
        {
            let conn = crate::db::init_db(&db_path).unwrap();
            let batch = begin_test_batch(&conn, &[(source.clone(), target.clone())]).unwrap();
            std::fs::rename(&source, &batch.items[0].temp).unwrap();
            std::fs::copy(&batch.items[0].temp, &target).unwrap();
        }
        let conn = crate::db::init_db(&db_path).unwrap();
        let op: Operation = conn.query_row(
            "SELECT id, kind, source_path, target_path, payload FROM picnest_operations",
            [], |r| Ok(Operation {
                id: r.get(0)?, kind: r.get(1)?,
                source_path: r.get(2)?, target_path: r.get(3)?,
                payload: serde_json::from_str(&r.get::<_, String>(4)?).unwrap(),
            }),
        ).unwrap();
        let state: String = conn.query_row("SELECT state FROM picnest_operations", [], |r| r.get(0)).unwrap();
        assert_eq!(state, "needs_review");
        assert!(target.exists());
        assert!(dir.join(op.payload["items"][0]["temp"].as_str().unwrap()).exists());
        assert!(!source.exists());
    }

    #[test]
    fn restart_recovery_rejects_a_replaced_move_target() {
        let dir = crate::testutil::TempDir::new("picnest_move_replaced");
        let db_path = dir.join("test.db");
        let source = dir.join("source.png");
        let target = dir.join("target.png");
        std::fs::write(&source, b"original").unwrap();
        {
            let conn = crate::db::init_db(&db_path).unwrap();
            let op = begin_test_move(&conn, &source, &target).unwrap();
            std::fs::rename(&source, &target).unwrap();
            mark_path_applied(&conn, &op).unwrap();
            std::fs::write(&target, b"replacement").unwrap();
        }
        let conn = crate::db::init_db(&db_path).unwrap();
        assert!(!source.exists());
        assert_eq!(std::fs::read(&target).unwrap(), b"replacement");
        let state: String = conn.query_row("SELECT state FROM picnest_operations", [], |r| r.get(0)).unwrap();
        assert_eq!(state, "needs_review");
    }

    #[test]
    fn ambiguous_recovery_preserves_files_and_requires_review() {
        let dir = crate::testutil::TempDir::new("picnest_batch_ambiguous");
        let db_path = dir.join("test.db");
        let source = dir.join("source.png");
        let target = dir.join("target.png");
        std::fs::write(&source, b"original").unwrap();
        let operation_id;
        {
            let conn = crate::db::init_db(&db_path).unwrap();
            let operation = begin_test_move(&conn, &source, &target).unwrap();
            operation_id = operation.id;
            std::fs::rename(&source, &target).unwrap();
            std::fs::write(&source, b"different-user-file").unwrap();
        }
        let _conn = crate::db::init_db(&db_path).unwrap();
        assert_eq!(std::fs::read(&source).unwrap(), b"different-user-file");
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        let state: String = conn.query_row("SELECT state FROM picnest_operations WHERE id = ?1", [operation_id], |r| r.get(0)).unwrap();
        assert_eq!(state, "needs_review");
    }
}
