//! 文件系统监听：库里任何目录的新增/删除/改名，防抖合并后通知前端自动同步。
//!
//! 为什么需要：图片列表来自数据库，不是实时读磁盘。以前只在「切进目录 1.2 秒后」扫一次，
//! 所以你停在一个目录里往其中丢图，界面不会自己更新，必须切走再切回。
//!
//! 开销：Windows 下走 ReadDirectoryChangesW（内核事件通知，缓冲 64KB），
//! 不轮询、不读文件内容，监听整棵树几乎零负担。

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::Emitter;
use tauri::Manager;

/// 静默这么久之后收口（连续事件会一直延长，但有 2 秒硬上限）
const QUIET_MS: u64 = 600;
const HARD_CAP_MS: u64 = 2000;

fn collect_dirs(
    ev: notify::Event,
    dirs: &mut HashSet<PathBuf>,
    removed: &mut Vec<PathBuf>,
) {
    match ev.kind {
        EventKind::Remove(_) => {
            // 删除：除了通知前端刷新，还要把库里对应记录软删（否则会留下孤儿行，
            // 表现为张数比磁盘多、里面有灰卡）。
            for p in &ev.paths {
                removed.push(p.clone());
                if let Some(parent) = p.parent() {
                    dirs.insert(parent.to_path_buf());
                }
            }
        }
        // 增 / 改名：只刷新目录，入库交给前端调 syncDirSnapshot
        EventKind::Create(_) | EventKind::Modify(notify::event::ModifyKind::Name(_)) => {
            for p in ev.paths {
                if let Some(parent) = p.parent() {
                    dirs.insert(parent.to_path_buf());
                }
            }
        }
        _ => {}
    }
}

/// 把被删掉的文件在库里标记为删除（软删，可在回收站视图恢复）。
/// 只动 file_path 完全对得上的行；目录被删的情况由外层的目录刷新处理。
fn mark_removed(app: &tauri::AppHandle, paths: &[PathBuf]) {
    if paths.is_empty() {
        return;
    }
    let Some(state) = app.try_state::<crate::commands::AppState>() else {
        return;
    };
    let Ok(conn) = state.db.lock() else {
        return;
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    for p in paths {
        let s = p.to_string_lossy().to_string();
        let _ = conn.execute(
            "UPDATE images SET deleted_at = ?1 \
             WHERE file_path = ?2 COLLATE NOCASE AND deleted_at IS NULL",
            rusqlite::params![now, s],
        );
    }
}

pub fn start(app: tauri::AppHandle, roots: Vec<PathBuf>) {
    if roots.is_empty() {
        return;
    }
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
        if watched == 0 {
            return;
        }

        loop {
            // 先阻塞等第一个事件（没有事件时不占 CPU）
            let first = match rx.recv() {
                Ok(v) => v,
                Err(_) => return,
            };
            let mut dirs: HashSet<PathBuf> = HashSet::new();
            let mut removed: Vec<PathBuf> = Vec::new();
            if let Ok(ev) = first {
                collect_dirs(ev, &mut dirs, &mut removed);
            }
            let hard_deadline = Instant::now() + Duration::from_millis(HARD_CAP_MS);
            loop {
                if Instant::now() >= hard_deadline {
                    break;
                }
                match rx.recv_timeout(Duration::from_millis(QUIET_MS)) {
                    Ok(Ok(ev)) => collect_dirs(ev, &mut dirs, &mut removed),
                    Ok(Err(_)) => {}
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            // 先把被删的文件在库里软删，再通知前端刷新
            mark_removed(&app, &removed);
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
