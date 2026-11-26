use jwalk::WalkDir;
use rusqlite::{params, Connection};
use std::collections::HashSet;
use std::path::Path;
use std::time::UNIX_EPOCH;

const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "ico", "avif", "tiff", "tif", "psd", "psb", "clip",
    "heic", "heif",
    "mp4", "webm", "mov", "mkv", "avi", "m4v", "flv", "f4v",
    "txt", "md", "markdown", "log", "json", "jsonc", "csv", "tsv", "ini", "cfg", "conf", "yaml", "yml",
];

pub fn is_supported_ext(ext: &str) -> bool {
    let low = ext.to_ascii_lowercase();
    IMAGE_EXTS.iter().any(|&e| e == low)
}

pub fn file_size_and_mtime(meta: Option<&std::fs::Metadata>) -> (i64, i64) {
    let size = meta.map(|m| m.len() as i64).unwrap_or(0);
    let mtime = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    (size, mtime)
}

pub fn collect_folder_files(root_path: &Path) -> Vec<(String, i64, i64)> {
    let allowed: HashSet<&str> = IMAGE_EXTS.iter().copied().collect();
    let mut files = Vec::new();

    for entry in WalkDir::new(root_path).skip_hidden(true).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            let path = entry.path();
            if let Some(ext) = path.extension().and_then(|s| s.to_str()).map(|s| s.to_lowercase()) {
                if allowed.contains(ext.as_str()) {
                    let meta = entry.metadata().ok();
                    let (size, mtime) = file_size_and_mtime(meta.as_ref());
                    files.push((path.to_string_lossy().to_string(), size, mtime));
                }
            }
        }
    }

    files
}

/// 仅扫描单层目录的直接子文件（不递归子文件夹），用于切换目录时毫秒级对齐磁盘新增/还原文件
pub fn collect_single_dir_files(dir_path: &Path) -> Result<Vec<(String, i64, i64)>, String> {
    let mut files = Vec::new();
    let rd = std::fs::read_dir(dir_path)
        .map_err(|e| format!("读取目录失败 {}: {e}", dir_path.display()))?;
    for ent in rd {
        let ent = ent.map_err(|e| format!("遍历目录失败 {}: {e}", dir_path.display()))?;
        let ft = ent
            .file_type()
            .map_err(|e| format!("读取目录项失败 {}: {e}", ent.path().display()))?;
        if !ft.is_file() {
            continue;
        }
        let path = ent.path();
        if let Some(fname) = path.file_name().and_then(|s| s.to_str())
            && fname.starts_with('.')
        {
            continue;
        }
        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
        if !is_supported_ext(ext) {
            continue;
        }
        let meta = ent
            .metadata()
            .map_err(|e| format!("读取文件元数据失败 {}: {e}", path.display()))?;
        let size = meta.len() as i64;
        let mtime = meta
            .modified()
            .map_err(|e| format!("读取文件修改时间失败 {}: {e}", path.display()))?
            .duration_since(UNIX_EPOCH)
            .map_err(|e| format!("文件修改时间无效 {}: {e}", path.display()))?
            .as_secs() as i64;
        files.push((path.to_string_lossy().to_string(), size, mtime));
    }
    Ok(files)
}

pub fn scan_and_sync_folder(conn: &mut Connection, folder_id: i64, root_path: &Path) -> Result<usize, String> {
    let files = collect_folder_files(root_path);
    let root_str = root_path.to_string_lossy().to_string();

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut count = 0;
    {
        let mut stmt = tx
            .prepare_cached(
                "INSERT INTO images (folder_id, file_path, size, mtime, dir_rel)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(file_path) DO UPDATE SET size = ?3, mtime = ?4, dir_rel = ?5
                 WHERE deleted_at IS NULL AND (size IS NOT ?3 OR mtime IS NOT ?4 OR dir_rel IS NULL)",
            )
            .map_err(|e| e.to_string())?;

        for (file_path, size, mtime) in &files {
            let dr = crate::db::dir_rel_of(&root_str, file_path);
            count += stmt.execute(params![folder_id, file_path, size, mtime, dr]).unwrap_or(0);
        }
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_dir_scan_errors_are_not_reported_as_an_empty_directory() {
        let dir = crate::testutil::TempDir::new("picnest_single_dir_scan");
        let not_a_dir = dir.join("image.png");
        std::fs::write(&not_a_dir, b"image").unwrap();
        let error = collect_single_dir_files(&not_a_dir).unwrap_err();
        assert!(error.contains("读取目录失败"));
    }

    #[test]
    fn single_dir_scan_returns_direct_supported_files_only() {
        let dir = crate::testutil::TempDir::new("picnest_single_dir_scan_files");
        std::fs::write(dir.join("image.PNG"), b"image").unwrap();
        std::fs::write(dir.join("notes.txt"), b"notes").unwrap();
        std::fs::write(dir.join("ignored.bin"), b"ignored").unwrap();
        std::fs::write(dir.join(".hidden.png"), b"hidden").unwrap();
        std::fs::create_dir(dir.join("nested")).unwrap();
        std::fs::write(dir.join("nested/nested.png"), b"nested").unwrap();
        let files = collect_single_dir_files(dir.path()).unwrap();
        assert_eq!(files.len(), 2);
        assert!(files.iter().all(|(_path, size, _)| *size > 0));
        assert!(files.iter().any(|(path, _, _)| path.ends_with("image.PNG")));
    }
}
