//! 测试专用小工具（只在 `cargo test` 时编译）。
//!
//! 为什么需要它：测试会在 `%TEMP%` 里建临时目录，以前靠测试末尾手动
//! `remove_dir_all`——只要中间有一条断言失败（panic），清理就被跳过，
//! 临时目录就永久留在那里。开发几天下来攒了上百个、近百 MB，属于典型的
//! "没人认领的垃圾"。这里用 Drop 守卫保证：无论正常结束还是 panic，都会清掉。

use std::ops::Deref;
use std::path::{Path, PathBuf};

pub struct TempDir(PathBuf);

impl TempDir {
    /// 建一个 `%TEMP%/<tag>_<pid>[_<seq>]` 目录；已存在就先清空。
    pub fn new(tag: &str) -> Self {
        static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let name = if n == 0 {
            format!("{}_{}", tag, std::process::id())
        } else {
            format!("{}_{}_{}", tag, std::process::id(), n)
        };
        let p = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).expect("创建测试临时目录失败");
        Self(p)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Deref for TempDir {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<Path> for TempDir {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
