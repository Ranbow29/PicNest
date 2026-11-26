use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static PART_SEQ: AtomicU64 = AtomicU64::new(1);

pub(crate) fn paths_alias(source: &Path, target: &Path) -> bool {
    matches!((std::fs::canonicalize(source), std::fs::canonicalize(target)), (Ok(a), Ok(b)) if a == b)
}

pub(crate) fn is_cross_device_error(error: &std::io::Error) -> bool {
    #[cfg(windows)]
    {
        error.raw_os_error() == Some(17)
    }
    #[cfg(not(windows))]
    {
        error.raw_os_error() == Some(18)
    }
}

pub(crate) fn rename_no_replace(source: &Path, target: &Path) -> io::Result<()> {
    if paths_alias(source, target) {
        return std::fs::rename(source, target);
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        unsafe extern "system" {
            fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
        }
        let wide = |path: &Path| {
            path.as_os_str().encode_wide().chain(std::iter::once(0)).collect::<Vec<_>>()
        };
        let source = wide(source);
        let target = wide(target);
        if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0) } != 0 {
            return Ok(());
        }
        Err(io::Error::last_os_error())
    }
    #[cfg(not(windows))]
    {
        std::fs::rename(source, target)
    }
}

#[derive(Debug, Clone)]
pub(crate) struct StagedFile {
    pub temp_path: PathBuf,
    pub final_path: PathBuf,
    pub size: u64,
    pub sha256: String,
}

impl StagedFile {
    pub fn payload(&self) -> Value {
        json!({
            "tempPath": self.temp_path.to_string_lossy(),
            "finalPath": self.final_path.to_string_lossy(),
            "size": self.size,
            "sha256": self.sha256,
        })
    }
}

fn part_path(target: &Path) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .ok_or_else(|| "写入目标缺少父目录".to_string())?;
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "写入目标缺少文件名".to_string())?;
    let seq = PART_SEQ.fetch_add(1, Ordering::Relaxed);
    Ok(parent.join(format!(
        ".picnest-part-{}-{}-{}",
        std::process::id(),
        seq,
        name
    )))
}

pub(crate) fn cleanup_part(path: &Path) {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return;
    };
    if name.starts_with(".picnest-part-") {
        let _ = std::fs::remove_file(path);
    }
}

pub(crate) fn stage_write_new(target: &Path, bytes: &[u8]) -> Result<StagedFile, String> {
    let temp_path = part_path(target)?;
    let mut created = false;
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .map_err(|e| format!("创建临时文件失败 {}: {}", temp_path.display(), e))?;
        created = true;
        file.write_all(bytes)
            .map_err(|e| format!("写入临时文件失败 {}: {}", temp_path.display(), e))?;
        file.flush()
            .map_err(|e| format!("刷新临时文件失败 {}: {}", temp_path.display(), e))?;
        file.sync_all()
            .map_err(|e| format!("落盘临时文件失败 {}: {}", temp_path.display(), e))?;
        drop(file);
        Ok(StagedFile {
            temp_path: temp_path.clone(),
            final_path: target.to_path_buf(),
            size: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
        })
    })();
    if result.is_err() && created {
        cleanup_part(&temp_path);
    }
    result
}

pub(crate) fn stage_copy_new(source: &Path, target: &Path) -> Result<StagedFile, String> {
    let expected = std::fs::metadata(source)
        .map_err(|e| format!("读取源文件失败 {}: {}", source.display(), e))?;
    if !expected.is_file() {
        return Err(format!("源路径不是文件: {}", source.display()));
    }
    let temp_path = part_path(target)?;
    let mut created = false;
    let result = (|| {
        let mut input = File::open(source)
            .map_err(|e| format!("打开源文件失败 {}: {}", source.display(), e))?;
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .map_err(|e| format!("创建临时文件失败 {}: {}", temp_path.display(), e))?;
        created = true;
        let mut buffer = vec![0u8; 64 * 1024];
        let mut hasher = Sha256::new();
        let mut copied = 0u64;
        loop {
            let read = input
                .read(&mut buffer)
                .map_err(|e| format!("复制临时文件失败 {}: {}", temp_path.display(), e))?;
            if read == 0 {
                break;
            }
            output
                .write_all(&buffer[..read])
                .map_err(|e| format!("复制临时文件失败 {}: {}", temp_path.display(), e))?;
            hasher.update(&buffer[..read]);
            copied += read as u64;
        }
        output
            .flush()
            .map_err(|e| format!("刷新临时文件失败 {}: {}", temp_path.display(), e))?;
        output
            .sync_all()
            .map_err(|e| format!("落盘临时文件失败 {}: {}", temp_path.display(), e))?;
        drop(output);
        if copied != expected.len()
            || std::fs::metadata(&temp_path).map(|m| m.len()).unwrap_or(0) != expected.len()
        {
            return Err(format!("复制校验失败: {}", source.display()));
        }
        Ok(StagedFile {
            temp_path: temp_path.clone(),
            final_path: target.to_path_buf(),
            size: copied,
            sha256: format!("{:x}", hasher.finalize()),
        })
    })();
    if result.is_err() && created {
        cleanup_part(&temp_path);
    }
    result
}

fn verify_file_payload(path: &Path, size: u64, sha256: &str) -> Result<(), String> {
    let metadata = std::fs::metadata(path)
        .map_err(|e| format!("校验文件失败 {}: {e}", path.display()))?;
    if metadata.len() != size {
        return Err(format!("文件长度不符: {}", path.display()));
    }
    let mut file = File::open(path)
        .map_err(|e| format!("读取文件失败 {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    io::copy(&mut file, &mut hasher)
        .map_err(|e| format!("读取文件失败 {}: {e}", path.display()))?;
    if format!("{:x}", hasher.finalize()) != sha256 {
        return Err(format!("文件哈希不符: {}", path.display()));
    }
    Ok(())
}

pub(crate) fn verify_staged_file(staged: &StagedFile) -> Result<(), String> {
    verify_file_payload(&staged.final_path, staged.size, &staged.sha256)
}

pub(crate) fn commit_staged(staged: &StagedFile) -> Result<(), String> {
    if staged.final_path.exists() {
        return Err(format!("目标已存在，拒绝覆盖: {}", staged.final_path.display()));
    }
    rename_no_replace(&staged.temp_path, &staged.final_path)
        .map_err(|e| format!("提交临时文件失败 {}: {}", staged.final_path.display(), e))
}

pub(crate) fn rollback_staged(staged: &StagedFile) -> Result<(), String> {
    if staged.final_path.exists() {
        if staged.temp_path.exists() {
            return Err(format!(
                "临时文件与最终文件同时存在，需人工确认: {}",
                staged.final_path.display()
            ));
        }
        verify_staged_file(staged)?;
        crate::fs_ops::rename_no_replace(&staged.final_path, &staged.temp_path)
            .map_err(|e| format!("回滚新文件失败 {}: {}", staged.final_path.display(), e))?;
    } else if staged.temp_path.exists() {
        verify_file_payload(&staged.temp_path, staged.size, &staged.sha256)?;
    }
    cleanup_part(&staged.temp_path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rename_never_replaces_an_existing_target() {
        let dir = crate::testutil::TempDir::new("picnest_no_replace");
        let source = dir.join("source.png");
        let target = dir.join("target.png");
        std::fs::write(&source, b"source").unwrap();
        std::fs::write(&target, b"user-target").unwrap();
        assert!(rename_no_replace(&source, &target).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), b"source");
        assert_eq!(std::fs::read(&target).unwrap(), b"user-target");
    }

    #[test]
    fn staging_collision_never_cleans_a_preexisting_file() {
        let dir = crate::testutil::TempDir::new("picnest_staging_collision");
        let target = dir.join("collision.png");
        let source = dir.join("source.bin");
        std::fs::write(&source, b"source").unwrap();
        let start = PART_SEQ.load(Ordering::Relaxed);
        let mut sentinels = Vec::new();
        for offset in 0..256 {
            let path = dir.join(format!(
                ".picnest-part-{}-{}-collision.png",
                std::process::id(),
                start + offset
            ));
            std::fs::write(&path, b"preexisting").unwrap();
            sentinels.push(path);
        }
        assert!(stage_write_new(&target, b"new").is_err());
        assert!(stage_copy_new(&source, &target).is_err());
        for path in sentinels {
            assert_eq!(std::fs::read(path).unwrap(), b"preexisting");
        }
        assert!(!target.exists());
    }

    #[cfg(windows)]
    #[test]
    fn rename_supports_non_ascii_case_only_changes() {
        let dir = crate::testutil::TempDir::new("picnest_case_rename");
        let source = dir.join("Ä.png");
        let target = dir.join("ä.png");
        std::fs::write(&source, b"image").unwrap();
        rename_no_replace(&source, &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"image");
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["ä.png".to_string()]);
    }

    #[test]
    fn atomic_writes_never_replace_existing_files() {
        let dir = crate::testutil::TempDir::new("picnest_atomic_write");
        let target = dir.join("image.png");
        let staged = stage_write_new(&target, b"first").unwrap();
        commit_staged(&staged).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"first");
        let staged = stage_write_new(&target, b"second").unwrap();
        assert!(commit_staged(&staged).is_err());
        cleanup_part(&staged.temp_path);
        assert_eq!(std::fs::read(&target).unwrap(), b"first");
        assert!(!std::fs::read_dir(dir.path())
            .unwrap()
            .any(|e| e.unwrap().file_name().to_string_lossy().starts_with(".picnest-part-")));
    }

    #[test]
    fn atomic_copy_verifies_bytes_and_cleans_part_on_failure() {
        let dir = crate::testutil::TempDir::new("picnest_atomic_copy");
        let source = dir.join("source.bin");
        let target = dir.join("target.bin");
        std::fs::write(&source, b"payload").unwrap();
        let staged = stage_copy_new(&source, &target).unwrap();
        assert_eq!(staged.size, 7);
        commit_staged(&staged).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"payload");
        let staged = stage_copy_new(&source, &target).unwrap();
        assert!(commit_staged(&staged).is_err());
        cleanup_part(&staged.temp_path);
        assert_eq!(std::fs::read(&target).unwrap(), b"payload");
        cleanup_part(&dir.join("user.png"));
        assert!(source.exists());
    }

    #[test]
    fn rollback_never_deletes_a_replaced_staging_file() {
        let dir = crate::testutil::TempDir::new("picnest_staging_rollback_identity");
        let target = dir.join("image.png");
        let staged = stage_write_new(&target, b"original").unwrap();
        std::fs::write(&staged.temp_path, b"replaced").unwrap();
        assert!(rollback_staged(&staged).is_err());
        assert_eq!(std::fs::read(&staged.temp_path).unwrap(), b"replaced");
        assert!(!target.exists());
    }

    #[test]
    fn rollback_rejects_a_replaced_final_file() {
        let dir = crate::testutil::TempDir::new("picnest_atomic_rollback");
        let target = dir.join("image.png");
        let staged = stage_write_new(&target, b"original").unwrap();
        commit_staged(&staged).unwrap();
        std::fs::write(&target, b"replaced").unwrap();
        assert!(rollback_staged(&staged).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"replaced");
    }
}
