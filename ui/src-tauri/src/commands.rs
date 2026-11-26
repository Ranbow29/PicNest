use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::State;

/// 图库取数的代际水位：前端每发起一次请求写入递增序号，
/// 后端在耗时点比对——比水位小的请求说明用户已经切走了，立刻放弃，不再空跑。
static LATEST_IMG_REQ: AtomicU64 = AtomicU64::new(0);

pub struct AppState {
    pub db: Arc<Mutex<rusqlite::Connection>>,
    pub db_path: PathBuf,
    pub data_dir: PathBuf,
    pub media_port: u16,
    pub api_port: u16,
    pub media_nonce: String,
}

/// 命令级计时器：进入/退出各打一条诊断日志（只在 PICNEST_DIAG=1 时有成本）。
/// 目的：搞清楚「切一次目录之后 IPC 通道被谁占了 0.5–1.7 秒」。
pub struct CmdTimer {
    name: &'static str,
    t0: std::time::Instant,
}

impl CmdTimer {
    pub fn new(name: &'static str) -> Self {
        // 把执行线程也打出来：用来实证「sync 命令是不是真的跑在宿主主线程上」
        crate::media_server::diag_log!(
            "cmd> {} [{}]",
            name,
            std::thread::current().name().unwrap_or("?")
        );
        Self { name, t0: std::time::Instant::now() }
    }
}

impl Drop for CmdTimer {
    fn drop(&mut self) {
        crate::media_server::diag_log!(
            "cmd< {} {}ms",
            self.name,
            self.t0.elapsed().as_millis()
        );
    }
}

pub(crate) fn open_read_conn(db_path: &Path) -> Result<rusqlite::Connection, String> {
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    let _ = conn.execute_batch("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;");
    Ok(conn)
}

/// 只读连接池：每次请求新建连接（open + PRAGMA）在快路径上是固定开销，
/// 实测 15 张图的目录也要 20ms 量级。池化后省掉这一段。
static READ_POOL: std::sync::OnceLock<std::sync::Mutex<Vec<rusqlite::Connection>>> =
    std::sync::OnceLock::new();

pub(crate) fn with_read_conn<T>(
    db_path: &Path,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, String>,
) -> Result<T, String> {
    let pool = READ_POOL.get_or_init(|| std::sync::Mutex::new(Vec::new()));
    // 只在取/还连接时持锁，查询期间不占锁，否则并发请求会全部串行排队
    let reused = {
        let mut guard = pool.lock().map_err(|e| e.to_string())?;
        guard.pop()
    };
    let conn = match reused {
        Some(c) => c,
        None => {
            let c = open_read_conn(db_path)?;
            // dir_rel 已是小写，开区分大小写的 LIKE 后前缀匹配才能走索引
            let _ = c.execute_batch("PRAGMA case_sensitive_like = ON;");
            c
        }
    };
    let out = f(&conn);
    if let Ok(mut guard) = pool.lock() {
        if guard.len() < 4 {
            guard.push(conn);
        }
    }
    out
}

#[tauri::command]
pub fn get_media_port(state: State<AppState>) -> serde_json::Value {
    let _t = CmdTimer::new("get_media_port");
    serde_json::json!({ "port": state.media_port, "nonce": state.media_nonce })
}

/// 图库取数接口的独立端口（与缩略图共用 HTTP 服务，但分端口避免连接池互扰）
#[tauri::command]
pub fn get_api_port(state: State<AppState>) -> u16 {
    let _t = CmdTimer::new("get_api_port");
    state.api_port
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FolderItem {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub display_name: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ImageItem {
    pub id: i64,
    pub folder_id: i64,
    pub file_path: String,
    pub file_name: String,
    pub file_size: i64,
    pub modify_time: i64,
    pub width: i64,
    pub height: i64,
    pub thumbnail_path: Option<String>,
    pub rating: i64,
    pub is_favorite: bool,
    pub last_opened_at: i64,
    pub annotation: String,
    pub url: String,
    pub deleted_at: Option<i64>,
}

#[allow(dead_code)]
pub(crate) fn load_thumb_filename_set(thumbs_dir: &Path) -> std::collections::HashSet<std::ffi::OsString> {
    let mut set = std::collections::HashSet::new();
    if let Ok(entries) = std::fs::read_dir(thumbs_dir) {
        for e in entries.flatten() {
            set.insert(e.file_name());
        }
    }
    set
}

pub(crate) fn resolve_existing_thumb(
    tp: Option<String>,
    _file_path: &str,
    _thumbs_dir: &Path,
) -> Option<String> {
    if let Some(ref s) = tp {
        if s == "SKIP" || !s.is_empty() {
            return tp;
        }
    }
    None
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TreeNode {
    pub name: String,
    pub rel: String,
    pub count: usize,
    pub total: usize,
    pub children: Vec<TreeNode>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DirTreeResponse {
    #[serde(rename = "rootPath")]
    pub root_path: String,
    pub tree: TreeNode,
    #[serde(rename = "orphanFiles")]
    pub orphan_files: usize,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DirStatsResult {
    pub ok: bool,
    pub count: i64,
    pub size: i64,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PathsInfo {
    pub app_data: String,
    pub cache_dir: String,
}

// ----------------- 窗口管理命令 -----------------

#[tauri::command]
pub fn window_minimize(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_maximize(window: tauri::Window) -> Result<(), String> {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn window_close(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_toggle_always_on_top(window: tauri::Window) -> Result<bool, String> {
    let cur = window.is_always_on_top().unwrap_or(false);
    let next = !cur;
    window.set_always_on_top(next).map_err(|e| e.to_string())?;
    Ok(next)
}

#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() || trimmed.chars().any(|c| c.is_control()) {
        return Err("无效的外部链接：含非法控制字符或为空".to_string());
    }
    let lower = trimmed.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Err("仅支持 http:// 或 https:// 协议链接".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", trimmed])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ----------------- 资料库 & 文件系统 -----------------

#[tauri::command]
pub fn get_paths(state: State<AppState>) -> PathsInfo {
    let app_data = state.data_dir.to_string_lossy().to_string();
    let cache_dir = state.data_dir.join("cache").to_string_lossy().to_string();
    PathsInfo {
        app_data,
        cache_dir,
    }
}

#[tauri::command]
pub async fn get_all_folders(state: State<'_, AppState>) -> Result<Vec<FolderItem>, String> {
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_read_conn(&db_path, |conn| {
            let mut stmt = conn
                .prepare("SELECT id, path, COALESCE(display_name, '') FROM folders ORDER BY id ASC")
                .map_err(|e| e.to_string())?;

            let rows = stmt
                .query_map([], |row| {
                    let id: i64 = row.get(0)?;
                    let path: String = row.get(1)?;
                    let display_name: String = row.get(2)?;
                    let disk_name = Path::new(&path)
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| path.clone());
                    let name = if !display_name.trim().is_empty() {
                        display_name.clone()
                    } else {
                        disk_name.clone()
                    };
                    Ok(FolderItem {
                        id,
                        path,
                        name,
                        display_name,
                    })
                })
                .map_err(|e| e.to_string())?;

            Ok(rows.flatten().collect())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn add_folder_by_path(path: String, state: State<'_, AppState>) -> Result<FolderItem, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _filesystem_guard = crate::operation_journal::filesystem_operation_guard();
        let id: i64 = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO folders (path) VALUES (?1) ON CONFLICT(path) DO NOTHING",
                [&path],
            )
            .map_err(|e| e.to_string())?;

            conn.query_row("SELECT id FROM folders WHERE path = ?1", [&path], |r| r.get(0))
                .map_err(|e| e.to_string())?
        };

        // 先无锁高并发扫盘，再短锁落库，绝不在 WalkDir 期间阻塞其他查询
        let root = PathBuf::from(&path);
        let files = crate::scanner::collect_folder_files(&root);
        if !files.is_empty() {
            let mut conn = db.lock().map_err(|e| e.to_string())?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            {
                let mut stmt = tx
                    .prepare_cached(
                        // dir_rel 必须写：列表按它取数，漏了会导致登库后「点进目录一片空」。
                        "INSERT INTO images (folder_id, file_path, size, mtime, dir_rel)
                         VALUES (?1, ?2, ?3, ?4, ?5)
                         ON CONFLICT(file_path) DO UPDATE SET size = ?3, mtime = ?4, dir_rel = ?5
                         WHERE deleted_at IS NULL AND (size IS NOT ?3 OR mtime IS NOT ?4)",
                    )
                    .map_err(|e| e.to_string())?;
                for (fp, sz, mt) in &files {
                    let dr = crate::db::dir_rel_of(&path, fp);
                    stmt.execute(rusqlite::params![id, fp, sz, mt, dr])
                        .map_err(|e| e.to_string())?;
                }
            }
            tx.commit().map_err(|e| e.to_string())?;
        }

        // 运行时新添加的资料库立即纳入文件系统监听，无需重启应用
        crate::watcher::watch_path(Path::new(&path));

        let name = Path::new(&path)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());

        Ok(FolderItem {
            id,
            path,
            name,
            display_name: String::new(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dir_tree(folder_id: i64, state: State<'_, AppState>) -> Result<DirTreeResponse, String> {
    crate::media_server::diag_log!("dir_tree start folder_id={}", folder_id);
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (root_path, file_rows, order_map) = with_read_conn(&db_path, |conn| {
            let root_path: String = conn
                .query_row("SELECT path FROM folders WHERE id = ?1", [folder_id], |r| r.get(0))
                .map_err(|_| "资料库不存在".to_string())?;

            let mut stmt = conn
                .prepare("SELECT file_path FROM images WHERE folder_id = ?1 AND deleted_at IS NULL")
                .map_err(|e| e.to_string())?;

            let file_rows: Vec<String> = stmt
                .query_map([folder_id], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .flatten()
                .collect();

            let mut order_map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
            let prefix = format!("{}|", folder_id);
            if let Ok(mut ostmt) = conn.prepare("SELECT key, names FROM picnest_dir_order WHERE key LIKE ?1") {
                if let Ok(rows) = ostmt.query_map([format!("{}%", prefix)], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                }) {
                    for row in rows.flatten() {
                        if let Ok(vec) = serde_json::from_str::<Vec<String>>(&row.1) {
                            order_map.insert(row.0, vec);
                        }
                    }
                }
            }
            Ok((root_path, file_rows, order_map))
        })?; // 查完立刻释放 DB 连接回池，绝不带着连接扫盘！

        let root_norm = root_path.replace('\\', "/");
        let root_name = Path::new(&root_path)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| root_path.clone());

        struct RawNode {
            name: String,
            rel: String,
            direct: usize,
            children: std::collections::BTreeMap<String, RawNode>,
        }

        let mut root_dir = RawNode {
            name: root_name,
            rel: String::new(),
            direct: 0,
            children: std::collections::BTreeMap::new(),
        };

        let mut total_files: usize = 0;
        let mut categorized_files: usize = 0;

        for row in file_rows {
            total_files += 1;
            let abs = row.replace('\\', "/");
            if !abs.starts_with(&(root_norm.clone() + "/")) {
                continue;
            }
            let rel = &abs[(root_norm.len() + 1)..];
            if let Some(idx) = rel.rfind('/') {
                let dir_rel = &rel[..idx];
                let parts: Vec<&str> = dir_rel.split('/').collect();
                let mut curr = &mut root_dir;
                let mut current_rel = String::new();
                for part in parts {
                    if !current_rel.is_empty() {
                        current_rel.push('/');
                    }
                    current_rel.push_str(part);
                    let rel_clone = current_rel.clone();
                    curr = curr.children.entry(part.to_string()).or_insert_with(|| RawNode {
                        name: part.to_string(),
                        rel: rel_clone,
                        direct: 0,
                        children: std::collections::BTreeMap::new(),
                    });
                }
                curr.direct += 1;
                categorized_files += 1;
            }
        }

        fn walk_fs(dir_path: &Path, rel_prefix: &str, node: &mut RawNode) {
            if let Ok(entries) = std::fs::read_dir(dir_path) {
                for entry in entries.flatten() {
                    if let Ok(ft) = entry.file_type() {
                        if ft.is_dir() {
                            let name = entry.file_name().to_string_lossy().to_string();
                            if !name.starts_with('.') {
                                let child_rel = if rel_prefix.is_empty() {
                                    name.clone()
                                } else {
                                    format!("{}/{}", rel_prefix, name)
                                };
                                let child_path = entry.path();
                                let child_node = node.children.entry(name.clone()).or_insert_with(|| RawNode {
                                    name,
                                    rel: child_rel.clone(),
                                    direct: 0,
                                    children: std::collections::BTreeMap::new(),
                                });
                                walk_fs(&child_path, &child_rel, child_node);
                            }
                        }
                    }
                }
            }
        }

        walk_fs(Path::new(&root_path), "", &mut root_dir);

        fn convert(raw: RawNode, folder_id: i64, order_map: &std::collections::HashMap<String, Vec<String>>) -> TreeNode {
            let mut total = raw.direct;
            let mut children = Vec::new();
            for (_, child) in raw.children {
                let c = convert(child, folder_id, order_map);
                total += c.total;
                children.push(c);
            }
            let key = format!("{}|{}", folder_id, raw.rel);
            if let Some(order) = order_map.get(&key) {
                children.sort_by(|a, b| {
                    let ra = order.iter().position(|x| x == &a.name).unwrap_or(usize::MAX);
                    let rb = order.iter().position(|x| x == &b.name).unwrap_or(usize::MAX);
                    ra.cmp(&rb).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                });
            }
            TreeNode {
                name: raw.name,
                rel: raw.rel,
                count: raw.direct,
                total,
                children,
            }
        }

        let tree = convert(root_dir, folder_id, &order_map);
        let orphan_files = total_files.saturating_sub(categorized_files);

        Ok(DirTreeResponse {
            root_path,
            tree,
            orphan_files,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// LIKE 模式转义：路径里的 `_` / `%` 必须转义，否则目录名 `01_好图`
/// 的 `_` 会当通配符，统计/封面串到兄弟目录去。
/// 逐字符处理，避免“先转 `%` 再转 `\`”这种二次转义。
fn escape_like_pattern(s: &str) -> String {
    escape_like(s)
}

pub(crate) fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '%' => out.push_str("\\%"),
            '_' => out.push_str("\\_"),
            _ => out.push(c),
        }
    }
    out
}

#[tauri::command]
pub async fn dir_stats(folder_id: i64, rels: Vec<String>, state: State<'_, AppState>) -> Result<DirStatsResult, String> {
    let _timer = CmdTimer::new("dir_stats");
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_read_conn(&db_path, |conn| {
            let _: String = conn
                .query_row("SELECT path FROM folders WHERE id = ?1", [folder_id], |r| r.get(0))
                .map_err(|_| "资料库不存在".to_string())?;

            let list = if rels.is_empty() { vec![String::new()] } else { rels };

            let mut total_count = 0;
            let mut total_size = 0;

            let mut sub_stmt = conn
                .prepare(
                    "SELECT COUNT(*), COALESCE(SUM(size), 0)
                     FROM images
                     WHERE folder_id = ?1 AND deleted_at IS NULL
                       AND (dir_rel = ?2 OR (dir_rel >= ?3 AND dir_rel < ?4))",
                )
                .map_err(|e| e.to_string())?;

            for rel in &list {
                let rel_low = rel
                    .trim_matches(|c| c == '/' || c == '\\')
                    .replace('\\', "/")
                    .to_lowercase();
                let (c, s): (i64, i64) = if rel_low.is_empty() {
                    conn.query_row(
                        "SELECT COUNT(*), COALESCE(SUM(size), 0) FROM images WHERE folder_id = ?1 AND deleted_at IS NULL",
                        [folder_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .unwrap_or((0, 0))
                } else {
                    let sub_low = format!("{}/", rel_low);
                    let sub_high = format!("{}0", rel_low);
                    sub_stmt
                        .query_row(
                            rusqlite::params![folder_id, rel_low, sub_low, sub_high],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )
                        .unwrap_or((0, 0))
                };

                total_count += c;
                total_size += s;
            }

            Ok(DirStatsResult {
                ok: true,
                count: total_count,
                size: total_size,
                created_at: 0,
            })
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn images_by_dir(
    folder_id: i64,
    dir_rel: String,
    offset: i64,
    limit: i64,
    sort_mode: Option<String>,
    sort_asc: Option<bool>,
    recursive: Option<bool>,
    req_seq: Option<u64>,
    state: State<'_, AppState>,
) -> Result<Vec<ImageItem>, String> {
    let t0 = std::time::Instant::now();
    let my_seq = req_seq.unwrap_or(0);
    if my_seq > 0 {
        LATEST_IMG_REQ.fetch_max(my_seq, Ordering::Relaxed);
    }
    crate::media_server::diag_log!(
        "images_by_dir start folder={} rel={:?} limit={} sort={:?} seq={}",
        folder_id, dir_rel, limit, sort_mode, my_seq
    );
    let db_path = state.db_path.clone();
    let thumbs_dir = state.data_dir.join("cache").join("thumbs");
    let dir_rel_log = dir_rel.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        // 排队期间用户可能已经切走：连库都不必开
        if my_seq > 0 && my_seq < LATEST_IMG_REQ.load(Ordering::Relaxed) {
            return Ok(Vec::new());
        }
        let list = query_images_http(
            &db_path,
            &thumbs_dir,
            folder_id,
            &dir_rel,
            offset,
            limit,
            sort_mode.as_deref(),
            sort_asc,
            recursive,
        )?;
        // 查完再确认一次：扫描/序列化已经花了时间，若此刻已被后发的请求顶掉，
        // 就不必再把整页数据搬过 IPC。
        if my_seq > 0 && my_seq < LATEST_IMG_REQ.load(Ordering::Relaxed) {
            return Ok(Vec::new());
        }
        Ok(list)
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Ok(ref v) = res {
        if v.is_empty() && my_seq > 0 && my_seq < LATEST_IMG_REQ.load(Ordering::Relaxed) {
            crate::media_server::diag_log!(
                "images_by_dir stale-skip rel={:?} seq={}",
                dir_rel_log, my_seq
            );
        } else {
            crate::media_server::diag_log!(
                "images_by_dir done rel={:?} count={} in {}ms",
                dir_rel_log,
                v.len(),
                t0.elapsed().as_millis()
            );
        }
    } else if let Err(ref e) = res {
        crate::media_server::diag_log!("images_by_dir err: {}", e);
    }
    res
}

/// 批量取多个子目录的封面候选：一次 IPC、一条连接、每目录一条预编译查询。
/// 替代前端原本「每目录一个 images_by_dir」的并发风暴。
#[tauri::command]
pub async fn dir_covers(
    folder_id: i64,
    rels: Vec<String>,
    per_dir: Option<i64>,
    state: State<'_, AppState>,
) -> Result<std::collections::HashMap<String, Vec<ImageItem>>, String> {
    let _timer = CmdTimer::new("dir_covers");
    let db_path = state.db_path.clone();
    let thumbs_dir = state.data_dir.join("cache").join("thumbs");
    let take = per_dir.unwrap_or(6).clamp(1, 24);
    let t0 = std::time::Instant::now();
    let rels_log = (folder_id, rels.len());
    tauri::async_runtime::spawn_blocking(move || {
        with_read_conn(&db_path, |conn| {
            let _: String = conn
                .query_row("SELECT path FROM folders WHERE id = ?1", [folder_id], |r| r.get(0))
                .map_err(|_| "资料库不存在".to_string())?;

            const COLS2: &str = "id, folder_id, file_path, size, mtime, width, height, thumbnail_path, last_opened_at, annotation, url, deleted_at, COALESCE(rating, 0), COALESCE(is_favorite, 0), sort_order";
            let sql_sub = format!(
                "SELECT * FROM (
                     SELECT {cols} FROM images WHERE folder_id = ?1 AND deleted_at IS NULL AND dir_rel = ?2
                     UNION ALL
                     SELECT {cols} FROM images WHERE folder_id = ?1 AND deleted_at IS NULL AND dir_rel >= ?3 AND dir_rel < ?4
                 ) ORDER BY (sort_order = 0) DESC, sort_order ASC, id DESC
                 LIMIT ?5",
                cols = COLS2
            );
            let mut stmt_sub = conn.prepare(&sql_sub).map_err(|e| e.to_string())?;
            let mut stmt_root = conn
                .prepare(
                    "SELECT id, folder_id, file_path, size, mtime, width, height, thumbnail_path, last_opened_at, annotation, url, deleted_at, COALESCE(rating, 0), COALESCE(is_favorite, 0)
                     FROM images
                     WHERE folder_id = ?1 AND deleted_at IS NULL
                     ORDER BY (sort_order = 0) DESC, sort_order ASC, id DESC
                     LIMIT ?2",
                )
                .map_err(|e| e.to_string())?;

            let map_row = |r: &rusqlite::Row<'_>| -> rusqlite::Result<ImageItem> {
                let file_path: String = r.get(2)?;
                let file_name = Path::new(&file_path)
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| file_path.clone());
                let raw_tp: Option<String> = r.get(7)?;
                let thumbnail_path = resolve_existing_thumb(raw_tp, &file_path, &thumbs_dir);
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
            };

            let mut out: std::collections::HashMap<String, Vec<ImageItem>> =
                std::collections::HashMap::with_capacity(rels.len());
            for rel in rels {
                let rel_low = rel
                    .trim_matches(|c| c == '/' || c == '\\')
                    .replace('\\', "/")
                    .to_lowercase();
                let list: Vec<ImageItem> = if rel_low.is_empty() {
                    stmt_root
                        .query_map(rusqlite::params![folder_id, take], map_row)
                        .map_err(|e| e.to_string())?
                        .flatten()
                        .collect()
                } else {
                    let sub_low = format!("{}/", rel_low);
                    let sub_high = format!("{}0", rel_low);
                    stmt_sub
                        .query_map(rusqlite::params![folder_id, rel_low, sub_low, sub_high, take], map_row)
                        .map_err(|e| e.to_string())?
                        .flatten()
                        .collect()
                };
                out.insert(rel, list);
            }
            crate::media_server::diag_log!(
                "dir_covers folder={} rels={} in {}ms",
                rels_log.0,
                rels_log.1,
                t0.elapsed().as_millis()
            );
            Ok(out)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 供本地 HTTP 接口使用的取数实现（与 images_by_dir 同口径、同排序）。
///
/// 为什么要两条路：实测切目录瞬间 Tauri IPC 会被宿主侧阻塞（后端查询 12ms，
/// 但 invoke 往返要 0.9–1.9s），而同一时刻本地 HTTP 通道最快 4ms、最慢 47ms。
/// 所以导航取数改走 HTTP，IPC 留给写操作。两处 SQL 必须保持同步。
const MAX_QUERY_LIMIT: i64 = 500_000;

fn normalize_limit(limit: i64) -> i64 {
    limit.clamp(1, MAX_QUERY_LIMIT)
}

pub(crate) fn normalize_query_window(offset: i64, limit: i64) -> (i64, i64) {
    (offset.max(0), normalize_limit(limit))
}

pub(crate) fn query_images_http(
    db_path: &Path,
    thumbs_dir: &Path,
    folder_id: i64,
    dir_rel: &str,
    offset: i64,
    limit: i64,
    sort_mode: Option<&str>,
    sort_asc: Option<bool>,
    recursive: Option<bool>,
) -> Result<Vec<ImageItem>, String> {
    let (offset, limit) = normalize_query_window(offset, limit);
    with_read_conn(db_path, |conn| {
    let root_path: String = conn
        .query_row("SELECT path FROM folders WHERE id = ?1", [folder_id], |r| r.get(0))
        .map_err(|_| "资料库不存在".to_string())?;

    let sep = if root_path.contains('\\') { '\\' } else { '/' };
    let root_norm = if root_path.ends_with(sep) {
        root_path.clone()
    } else {
        format!("{}{}", root_path, sep)
    };

    let loose_only = dir_rel == "__loose__";
    // 库根散图 = 非递归 + dir_rel 为空。若这里沿用 recursive 默认 true，
    // loose 会被折成「根目录递归」，把整个库都当成散图返回（未分类显示 1 万张的 bug）。
    let is_recursive = !loose_only && recursive.unwrap_or(true);

    // dir_rel 口径：小写、正斜杠、无首尾斜杠
    let rel_low = if loose_only {
        String::new()
    } else {
        dir_rel.trim_matches(|c| c == '/' || c == '\\').replace('\\', "/").to_lowercase()
    };

    // 用 dir_rel + 复合索引定位，取代原来的 file_path LIKE 全表扫。
    // 递归时子目录用区间 [rel/, rel0)：任何以 "rel/" 开头的串都落在里面，且天然避免 `_`/`%` 通配符误伤！
    let subtree_low = format!("{}/", rel_low);
    let subtree_high = format!("{}0", rel_low);
    let base_pattern = if rel_low.is_empty() {
        root_norm.clone()
    } else {
        format!("{}{}{}", root_norm, rel_low.replace('/', &sep.to_string()), sep)
    };

    let asc_str = if sort_asc.unwrap_or(false) { "ASC" } else { "DESC" };
    let order_by = match sort_mode {
        Some("name") => format!("file_path COLLATE NOCASE {}", asc_str),
        Some("mtime") => format!("mtime {}", asc_str),
        Some("size") => format!("size {}", asc_str),
        Some("rating") => format!("COALESCE(rating, 0) {}, id DESC", asc_str),
        Some("added") => format!("id {}", asc_str),
        _ => "(sort_order = 0) DESC, sort_order ASC, id DESC".to_string(),
    };

    // 两个分支各自走索引，再合并排序：
    // 单条 OR 会被计划器降级成「先按 folder 扫再逐行过滤」。
    const COLS: &str = "id, folder_id, file_path, size, mtime, width, height, thumbnail_path, last_opened_at, annotation, url, deleted_at, COALESCE(rating, 0), COALESCE(is_favorite, 0)";
    let sql = if rel_low.is_empty() {
        if is_recursive {
            format!(
                "SELECT {} FROM images WHERE folder_id = ?1 AND deleted_at IS NULL AND ?5 = '' AND ?6 IS NOT NULL AND ?7 IS NOT NULL ORDER BY {} LIMIT ?3 OFFSET ?4",
                COLS, order_by
            )
        } else {
            /* 库根非递归 = 散图。NULL 也要算：采集器曾经不写 dir_rel，
               那些行才是真散图，只认 `= ''` 会让它们从列表里蒸发
               （表现为「未分类徽章 1、列表 0」）。 */
            format!(
                "SELECT {} FROM images WHERE folder_id = ?1 AND deleted_at IS NULL AND (dir_rel = '' OR dir_rel IS NULL) AND ?5 = '' AND ?6 IS NOT NULL AND ?7 IS NOT NULL ORDER BY {} LIMIT ?3 OFFSET ?4",
                COLS, order_by
            )
        }
    } else if is_recursive {
        // 外层 ORDER BY 要用到 sort_order，所以子查询里多取一列（追加在末尾，不影响前面的列序）
        let cols2 = format!("{}, sort_order", COLS);
        format!(
            "SELECT * FROM (
                 SELECT {} FROM images WHERE folder_id = ?1 AND deleted_at IS NULL AND dir_rel = ?5 AND ?2 IS NOT NULL
                 UNION ALL
                 SELECT {} FROM images WHERE folder_id = ?1 AND deleted_at IS NULL AND dir_rel >= ?6 AND dir_rel < ?7 AND ?2 IS NOT NULL
             ) ORDER BY {} LIMIT ?3 OFFSET ?4",
            cols2, cols2, order_by
        )
    } else {
        format!(
            "SELECT {} FROM images WHERE folder_id = ?1 AND deleted_at IS NULL AND dir_rel = ?5 AND ?6 IS NOT NULL AND ?7 IS NOT NULL ORDER BY {} LIMIT ?3 OFFSET ?4",
            COLS, order_by
        )
    };

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            rusqlite::params![folder_id, base_pattern, limit, offset, rel_low, subtree_low, subtree_high],
            |r| {
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
        })
        .map_err(|e| e.to_string())?;

    Ok(rows.flatten().collect())
    })
}

/// 调试用：返回图库取数 SQL 的执行计划
pub(crate) fn explain_images_plan(db_path: &Path, _thumbs: &Path) -> Result<Vec<String>, String> {
    with_read_conn(db_path, |conn| {
        let sql = "SELECT id, file_path, size, mtime FROM images
             WHERE folder_id = ?1 AND deleted_at IS NULL
               AND (dir_rel = ?5 OR dir_rel LIKE ?6)
             ORDER BY (sort_order = 0) DESC, sort_order ASC, id DESC LIMIT ?3 OFFSET ?4";
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {}", sql)).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![4i64, "", 10i64, 0i64, "02_好图", "02_好图/%"], |r| {
                r.get::<_, String>(3)
            })
            .map_err(|e| e.to_string())?;
        Ok(rows.flatten().collect())
    })
}

#[tauri::command]
pub async fn count_all(folder_id: i64, state: State<'_, AppState>) -> Result<i64, String> {
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_read_conn(&db_path, |conn| {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM images WHERE folder_id = ?1 AND deleted_at IS NULL",
                    [folder_id],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            Ok(count)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn recent(folder_id: i64, limit: i64, state: State<'_, AppState>) -> Result<Vec<ImageItem>, String> {
    let limit = normalize_limit(limit);
    let db_path = state.db_path.clone();
    let thumbs_dir = state.data_dir.join("cache").join("thumbs");
    tauri::async_runtime::spawn_blocking(move || {
        with_read_conn(&db_path, |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, folder_id, file_path, size, mtime, width, height, thumbnail_path, last_opened_at, annotation, url, deleted_at, COALESCE(rating, 0), COALESCE(is_favorite, 0)
                     FROM images
                     WHERE folder_id = ?1 AND deleted_at IS NULL AND last_opened_at > 0
                     ORDER BY last_opened_at DESC
                     LIMIT ?2",
                )
                .map_err(|e| e.to_string())?;

            let rows = stmt
                .query_map(rusqlite::params![folder_id, limit], |r| {
                    let file_path: String = r.get(2)?;
                    let file_name = Path::new(&file_path)
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| file_path.clone());
                    let raw_tp: Option<String> = r.get(7)?;
                    let thumbnail_path = resolve_existing_thumb(raw_tp, &file_path, &thumbs_dir);

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
                })
                .map_err(|e| e.to_string())?;

            Ok(rows.flatten().collect())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn image_opened(file_path: String, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        conn.execute(
            "UPDATE images SET last_opened_at = ?1 WHERE file_path = ?2",
            rusqlite::params![now, file_path],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// delete_dir 已迁移至 trash_ops 模块（对齐图巢内部回收站 + 清空进系统回收站）

#[tauri::command]
pub async fn mkdir(parent_path: String, name: String) -> Result<String, String> {
    // 从主线程卸下来：sync 命令跑在 [main]（已由 CmdTimer 的线程名实证），
    // 任何磁盘/DB 重活都会直接堵住窗口消息泵 → 输入延迟。
    tauri::async_runtime::spawn_blocking(move || {
        let target = Path::new(&parent_path).join(&name);
        std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        Ok(target.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ----------------- 新增：原生系统选择器 & 统计 & 记忆 & 缩略图 -----------------

#[tauri::command]
pub async fn select_folders() -> Result<Option<Vec<String>>, String> {
    let folder = rfd::AsyncFileDialog::new()
        .set_title("选择图巢资料库根文件夹")
        .pick_folder()
        .await;
    Ok(folder.map(|f| vec![f.path().to_string_lossy().to_string()]))
}

#[derive(Serialize)]
pub struct ViewCounts {
    pub all: i64,
    pub recent: i64,
    pub trash: i64,
    pub uncategorized: i64,
}

#[tauri::command]
pub async fn view_counts(folder_id: i64, state: State<'_, AppState>) -> Result<ViewCounts, String> {
    let _timer = CmdTimer::new("view_counts");
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_read_conn(&db_path)?;
        let all: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM images WHERE folder_id = ?1 AND deleted_at IS NULL",
                [folder_id],
                |r| r.get(0),
            )
            .unwrap_or(0);

        let recent: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM images WHERE folder_id = ?1 AND deleted_at IS NULL AND last_opened_at > 0",
                [folder_id],
                |r| r.get(0),
            )
            .unwrap_or(0);

        let trash_images: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM images WHERE folder_id = ?1 AND deleted_at IS NOT NULL AND trash_group IS NULL",
                [folder_id],
                |r| r.get(0),
            )
            .unwrap_or(0);

        let trash_folders: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM picnest_trash_folders WHERE folder_id = ?1",
                [folder_id],
                |r| r.get(0),
            )
            .unwrap_or(0);

        let root_path: Option<String> = conn
            .query_row(
                "SELECT path FROM folders WHERE id = ?1",
                [folder_id],
                |r| r.get(0),
            )
            .ok();

        let uncategorized = if let Some(root) = root_path {
            let sep = std::path::MAIN_SEPARATOR;
            let prefix = format!("{}{}", root, sep);
            let prefix_escaped = prefix.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
            conn.query_row(
                "SELECT COUNT(*) FROM images WHERE folder_id = ?1 AND deleted_at IS NULL AND file_path LIKE ?2 ESCAPE '\\' AND file_path NOT LIKE ?3 ESCAPE '\\'",
                rusqlite::params![
                    folder_id,
                    format!("{}%", prefix_escaped),
                    format!("{}%{}%", prefix_escaped, if sep == '\\' { "\\\\" } else { "/" })
                ],
                |r| r.get(0),
            )
            .unwrap_or(0)
        } else {
            0
        };

        Ok(ViewCounts {
            all,
            recent,
            trash: trash_images + trash_folders,
            uncategorized,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn find_folder_id_for_path(conn: &rusqlite::Connection, target: &Path) -> Option<i64> {
    find_folder_id_for_path_result(conn, target).ok().flatten()
}

fn find_folder_id_for_path_result(conn: &rusqlite::Connection, target: &Path) -> Result<Option<i64>, String> {
    let norm = target
        .to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase();
    if norm.is_empty() {
        return Ok(None);
    }
    let mut stmt = conn.prepare("SELECT id, path FROM folders").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut best: Option<(usize, i64)> = None;
    for row in rows {
        let (id, rp) = row.map_err(|e| e.to_string())?;
        let root = rp.replace('/', "\\").trim_end_matches('\\').to_lowercase();
        if root.is_empty() {
            continue;
        }
        let matched = norm == root
            || (norm.len() > root.len()
                && norm.starts_with(&root)
                && norm.as_bytes()[root.len()] == b'\\');
        if matched && best.map(|(len, _)| root.len() > len).unwrap_or(true) {
            best = Some((root.len(), id));
        }
    }
    Ok(best.map(|(_, id)| id))
}

fn apply_file_snapshot_diff(
    db: &Arc<Mutex<rusqlite::Connection>>,
    folder_id: i64,
    diff: &[(String, i64, i64)],
    gone: &[String],
) -> Result<bool, String> {
    if diff.is_empty() && gone.is_empty() {
        return Ok(false);
    }
    let mut wconn = db.lock().map_err(|e| e.to_string())?;
    let root_path: String = wconn
        .query_row("SELECT path FROM folders WHERE id = ?1", [folder_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let tx = wconn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare_cached(
                "INSERT INTO images (folder_id, file_path, size, mtime, dir_rel)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(file_path) DO UPDATE SET size = ?3, mtime = ?4, dir_rel = ?5
                 WHERE deleted_at IS NULL AND (size IS NOT ?3 OR mtime IS NOT ?4 OR dir_rel IS NOT ?5)",
            )
            .map_err(|e| e.to_string())?;
        for (fp, sz, mt) in diff {
            let dr = crate::db::dir_rel_of(&root_path, fp);
            stmt.execute(rusqlite::params![folder_id, fp, sz, mt, dr])
                .map_err(|e| e.to_string())?;
        }
    }
    if !gone.is_empty() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let mut stmt = tx
            .prepare_cached(
                "UPDATE images SET deleted_at = ?1
                 WHERE folder_id = ?2 AND LOWER(file_path) = ?3 AND deleted_at IS NULL",
            )
            .map_err(|e| e.to_string())?;
        for low in gone {
            stmt.execute(rusqlite::params![now, folder_id, low])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn sync_folder_snapshot(path: String, state: State<'_, AppState>) -> Result<bool, String> {
    let db_path = state.db_path.clone();
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _filesystem_guard = crate::operation_journal::filesystem_operation_guard();
        let root = PathBuf::from(&path);
        if !root.exists() || !root.is_dir() {
            return Ok(false);
        }
        let rconn = open_read_conn(&db_path)?;
        let id: i64 = rconn
            .query_row("SELECT id FROM folders WHERE path = ?1", [&path], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let mut existing: std::collections::HashMap<String, (i64, i64, bool)> =
            std::collections::HashMap::new();
        let mut stmt = rconn
            .prepare(
                "SELECT file_path, size, mtime, deleted_at IS NOT NULL FROM images WHERE folder_id = ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1).unwrap_or(0),
                    r.get::<_, i64>(2).unwrap_or(0),
                    r.get::<_, bool>(3).unwrap_or(false),
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (fp, sz, mt, del) = row.map_err(|e| e.to_string())?;
            existing.insert(fp.to_lowercase(), (sz, mt, del));
        }
        drop(stmt);
        drop(rconn);

        let files = crate::scanner::collect_folder_files(&root);
        let mut diff: Vec<(String, i64, i64)> = Vec::new();
        for (fp, sz, mt) in files {
            match existing.get(&fp.to_lowercase()) {
                None => diff.push((fp, sz, mt)),
                Some(&(old_sz, old_mt, del)) if !del && (old_sz != sz || old_mt != mt) => {
                    diff.push((fp, sz, mt))
                }
                _ => {}
            }
        }

        apply_file_snapshot_diff(&db, id, &diff, &[])
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 仅同步单层目录中的直接子文件，供切换目录时即时捕捉外部新增或回收站还原的文件
#[tauri::command]
pub async fn sync_dir_snapshot(
    folder_id: i64,
    dir_path: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let _timer = CmdTimer::new("sync_dir_snapshot");
    let db_path = state.db_path.clone();
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _filesystem_guard = crate::operation_journal::filesystem_operation_guard();
        let dir = PathBuf::from(&dir_path);
        if !dir.exists() || !dir.is_dir() {
            return Ok(false);
        }
        let files = crate::scanner::collect_single_dir_files(&dir)?;
        let rconn = open_read_conn(&db_path)?;
        let t0 = std::time::Instant::now();
        let resolved_id = find_folder_id_for_path_result(&rconn, &dir)?.unwrap_or(folder_id);

        // 一次把这层的行拉回来，内存里做 diff。
        // 原实现是「每个文件一条 LOWER(file_path)=LOWER(?)」——该列无索引，每条全表扫，
        // 实测 43 个文件的目录要 477ms。之后改成前缀区间扫（LOWER(file_path) >= / <），
        // 不再是逐文件扫，但 LOWER() 套在列上依旧吃不到索引，每次还是扫满 10803 行（实测 20–32ms）。
        // 现在优先用 dir_rel 直接命中索引；算不出 rel（根路径异常）才退回前缀区间。
        let dir_str = dir.to_string_lossy().to_string();
        let sep = if dir_str.contains('\\') { '\\' } else { '/' };
        let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_lowercase();
        let root_path: String = rconn
            .query_row(
                "SELECT path FROM folders WHERE id = ?1",
                [resolved_id],
                |r| r.get::<_, String>(0),
            )
            .map_err(|e| e.to_string())?;
        let root_n = norm(&root_path);
        let dir_n = norm(&dir_str);
        let rel_opt: Option<String> = if dir_n == root_n {
            Some(String::new())
        } else if let Some(rel) = dir_n.strip_prefix(&format!("{root_n}/")) {
            Some(rel.to_string())
        } else {
            return Err(format!("目录不在图库根目录内: {}", dir.display()));
        };

        let mut existing: std::collections::HashMap<String, (i64, i64, bool)> =
            std::collections::HashMap::new();
        let mut got_rows = false;
        if let Some(rel) = rel_opt.as_deref() {
            let mut stmt = rconn
                .prepare(
                    "SELECT file_path, size, mtime, deleted_at IS NOT NULL FROM images
                     WHERE folder_id = ?1 AND dir_rel = ?2",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt.query_map(rusqlite::params![resolved_id, rel], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1).unwrap_or(0),
                    r.get::<_, i64>(2).unwrap_or(0),
                    r.get::<_, bool>(3).unwrap_or(false),
                ))
            }).map_err(|e| e.to_string())?;
            for row in rows {
                let (fp, sz, mt, del) = row.map_err(|e| e.to_string())?;
                existing.insert(fp.to_lowercase(), (sz, mt, del));
            }
            got_rows = true;
        }
        if !got_rows {
            let base = format!("{}{}", dir_str.trim_end_matches(&['\\', '/'][..]), sep).to_lowercase();
            let base_end = format!("{}{}", base, char::MAX);
            let mut stmt = rconn
                .prepare(
                    "SELECT file_path, size, mtime, deleted_at IS NOT NULL FROM images
                     WHERE folder_id = ?1 AND LOWER(file_path) >= ?2 AND LOWER(file_path) < ?3",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt.query_map(rusqlite::params![resolved_id, &base, &base_end], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1).unwrap_or(0),
                    r.get::<_, i64>(2).unwrap_or(0),
                    r.get::<_, bool>(3).unwrap_or(false),
                ))
            }).map_err(|e| e.to_string())?;
            for row in rows {
                let (fp, sz, mt, del) = row.map_err(|e| e.to_string())?;
                let low = fp.to_lowercase();
                if low.starts_with(&base) && !low[base.len()..].contains(sep) {
                    existing.insert(low, (sz, mt, del));
                }
            }
        }
        drop(rconn);

        let mut diff: Vec<(String, i64, i64)> = Vec::new();
        let disk_set: std::collections::HashSet<String> =
            files.iter().map(|(fp, _, _)| fp.to_lowercase()).collect();
        for (fp, sz, mt) in &files {
            match existing.get(&fp.to_lowercase()) {
                None => diff.push((fp.clone(), *sz, *mt)),
                Some((old_sz, old_mt, del)) if !del && (*old_sz != *sz || *old_mt != *mt) => {
                    diff.push((fp.clone(), *sz, *mt))
                }
                _ => {}
            }
        }
        // 磁盘上没了、库里还活着的行 → 软删（进回收站视图，可恢复）。
        // 历史上这里从来没检查过「库有磁盘无」，所以「在资源管理器删图」永远同步不过来。
        let gone: Vec<String> = existing
            .iter()
            .filter(|(low, (_sz, _mt, del))| !*del && !disk_set.contains(*low))
            .map(|(low, _)| low.clone())
            .collect();
        crate::media_server::diag_push(&format!(
            "sync_dir_snapshot files={} diff={} gone={} in {}ms",
            existing.len(),
            diff.len(),
            gone.len(),
            t0.elapsed().as_millis()
        ));
        apply_file_snapshot_diff(&db, resolved_id, &diff, &gone)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dir_memory_root_get(
    root_id: i64,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_read_conn(&db_path)?;
        let mut stmt = conn
            .prepare("SELECT rel, patch FROM picnest_dir_memory WHERE root_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([root_id], |row| {
                let rel: String = row.get(0)?;
                let patch_str: String = row.get(1)?;
                Ok((rel, patch_str))
            })
            .map_err(|e| e.to_string())?;

        let mut map = serde_json::Map::new();
        for r in rows.flatten() {
            let parsed = serde_json::from_str::<serde_json::Value>(&r.1)
                .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
            map.insert(r.0, parsed);
        }
        Ok(serde_json::Value::Object(map))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dir_memory_set(
    root_id: i64,
    rel: String,
    patch: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let _timer = CmdTimer::new("dir_memory_set");
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let patch_str = patch.to_string();
        conn.execute(
            "INSERT INTO picnest_dir_memory (root_id, rel, patch) VALUES (?1, ?2, ?3)
             ON CONFLICT(root_id, rel) DO UPDATE SET patch = ?3",
            rusqlite::params![root_id, rel, patch_str],
        )
        .map_err(|e| e.to_string())?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Migrate `picnest_dir_memory` keys (`old_rel` / `old_rel/*` -> `new_rel` / `new_rel/*`)
/// and rebase `cover` / `coverPath` / `coverThumb` inside each moved folder's JSON patch.
/// Safe to call even if `rename_dir` already moved `rel` rows (idempotent).
pub fn dir_memory_rename_sync(
    conn: &rusqlite::Connection,
    root_id: i64,
    old_rel: &str,
    new_rel: &str,
) -> Result<bool, String> {
    let old_clean = old_rel.trim_matches('/');
    let new_clean = new_rel.trim_matches('/');
    if old_clean.is_empty() || new_clean.is_empty() || old_clean == new_clean {
        return Ok(true);
    }

    let root_path: Option<String> = conn
        .query_row("SELECT path FROM folders WHERE id = ?1", [root_id], |r| r.get(0))
        .ok();
    let old_abs_str = root_path
        .as_deref()
        .map(|rp| {
            Path::new(rp)
                .join(old_clean.replace('/', "\\"))
                .to_string_lossy()
                .to_string()
        })
        .unwrap_or_default();
    let new_abs_str = root_path
        .as_deref()
        .map(|rp| {
            Path::new(rp)
                .join(new_clean.replace('/', "\\"))
                .to_string_lossy()
                .to_string()
        })
        .unwrap_or_default();

    let rows: Vec<(String, String)> = {
        let mut stmt = conn
            .prepare("SELECT rel, patch FROM picnest_dir_memory WHERE root_id = ?1")
            .map_err(|e| e.to_string())?;
        stmt.query_map([root_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
            .flatten()
            .collect()
    };

    let old_prefix = format!("{}/", old_clean);
    let new_prefix = format!("{}/", new_clean);
    for (mrel, mpatch) in rows {
        let mapped_rel = if mrel == old_clean {
            Some(new_clean.to_string())
        } else if let Some(rest) = mrel.strip_prefix(&old_prefix) {
            Some(format!("{}/{}", new_clean, rest))
        } else {
            None
        };
        let in_new_subtree = mrel == new_clean || mrel.starts_with(&new_prefix);
        if mapped_rel.is_none() && !in_new_subtree {
            continue;
        }
        let target_rel = mapped_rel.unwrap_or_else(|| mrel.clone());
        let mut new_patch = mpatch.clone();
        if !old_abs_str.is_empty() && !new_abs_str.is_empty() {
            if let Ok(mut map) =
                serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&mpatch)
            {
                let mut changed = false;
                for field in ["cover", "coverPath", "coverThumb"] {
                    if let Some(serde_json::Value::String(cur)) = map.get(field).cloned() {
                        if let Some(rebased) = rebase_path_prefix(&cur, &old_abs_str, &new_abs_str) {
                            map.insert(field.to_string(), serde_json::Value::String(rebased));
                            changed = true;
                        }
                    }
                }
                if changed {
                    if let Ok(s) = serde_json::to_string(&map) {
                        new_patch = s;
                    }
                }
            }
        }
        if target_rel != mrel {
            let _ = conn.execute(
                "DELETE FROM picnest_dir_memory WHERE root_id = ?1 AND rel = ?2",
                rusqlite::params![root_id, mrel],
            );
            conn.execute(
                "INSERT INTO picnest_dir_memory (root_id, rel, patch) VALUES (?1, ?2, ?3)
                 ON CONFLICT(root_id, rel) DO UPDATE SET patch = ?3",
                rusqlite::params![root_id, target_rel, new_patch],
            )
            .map_err(|e| e.to_string())?;
        } else if new_patch != mpatch {
            conn.execute(
                "UPDATE picnest_dir_memory SET patch = ?1 WHERE root_id = ?2 AND rel = ?3",
                rusqlite::params![new_patch, root_id, target_rel],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(true)
}

#[tauri::command]
pub async fn dir_memory_rename(
    root_id: i64,
    old_rel: String,
    new_rel: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        dir_memory_rename_sync(&conn, root_id, &old_rel, &new_rel)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn window_is_always_on_top(window: tauri::Window) -> bool {
    window.is_always_on_top().unwrap_or(false)
}

#[derive(Serialize)]
pub struct ThumbItem {
    pub file_path: String,
    pub thumbnail_path: String,
}

#[derive(Serialize)]
pub struct BatchThumbResponse {
    pub results: Vec<ThumbItem>,
}

#[derive(Serialize)]
pub struct DisplayThumbItem {
    pub file_path: String,
    pub display_path: String,
}

#[derive(Serialize)]
pub struct BatchDisplayThumbResponse {
    pub results: Vec<DisplayThumbItem>,
}

pub(crate) fn fnv1a_hash(data: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for &b in data {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn find_media_tool_exe(tool_name: &str, fallback: &str) -> String {
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let winget = std::path::PathBuf::from(local)
            .join("Microsoft")
            .join("WinGet")
            .join("Links")
            .join(tool_name);
        if winget.exists() {
            return winget.to_string_lossy().to_string();
        }
    }
    fallback.to_string()
}

fn find_ffmpeg_exe() -> String {
    find_media_tool_exe("ffmpeg.exe", "ffmpeg")
}

fn find_ffprobe_exe() -> String {
    find_media_tool_exe("ffprobe.exe", "ffprobe")
}

/// 带硬超时的子进程执行：到点直接 kill。
///
/// 为什么必须有：ffmpeg/ffprobe 遇到损坏文件、网络流、异常容器时会无限期挂在解码里，
/// `.output()` 等它一等就是永远——既留下孤儿进程持续烧 CPU/GPU（本机发热、风扇狂转），
/// 又把 spawn_blocking 线程和文件句柄一起占死。超时或启动失败返回 None。
pub(crate) fn output_with_timeout(
    cmd: &mut std::process::Command,
    timeout: std::time::Duration,
) -> Option<std::process::Output> {
    use std::io::Read;
    use std::process::Stdio;

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().ok()?;
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    // 异步排空两根管道：不读的话子进程写满 64KB 就会阻塞，反而造成“假卡死”
    let t_out = std::thread::spawn(move || {
        let mut v = Vec::new();
        if let Some(p) = out_pipe.as_mut() {
            let _ = p.read_to_end(&mut v);
        }
        v
    });
    let t_err = std::thread::spawn(move || {
        let mut v = Vec::new();
        if let Some(p) = err_pipe.as_mut() {
            let _ = p.read_to_end(&mut v);
        }
        v
    });

    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    // 只杀直接子进程不够：`cmd /c start`、批处理这类会留孙进程继承管道句柄，
                    // 反过来把读取线程拖住。Windows 上用 taskkill /T 连整棵树一起收。
                    #[cfg(windows)]
                    {
                        use std::os::windows::process::CommandExt;
                        const CREATE_NO_WINDOW: u32 = 0x08000000;
                        let _ = std::process::Command::new("taskkill")
                            .args(["/PID", &child.id().to_string(), "/T", "/F"])
                            .creation_flags(CREATE_NO_WINDOW)
                            .output();
                    }
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(_) => break None,
        }
    };

    // 超时/异常：不再 join 读取线程（孙进程可能还握着管道），立即返回，不留阻塞
    let status = status?;
    let stdout = t_out.join().unwrap_or_default();
    let stderr = t_err.join().unwrap_or_default();
    Some(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

pub(crate) fn extract_video_dims(video_path: &Path) -> Option<(u32, u32)> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let ffprobe = find_ffprobe_exe();
    let v_str = video_path.to_string_lossy().to_string();
    let mut cmd = std::process::Command::new(&ffprobe);
    cmd.creation_flags(CREATE_NO_WINDOW).args([
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=s=x:p=0",
        &v_str,
    ]);
    let out = output_with_timeout(&mut cmd, std::time::Duration::from_secs(15))?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().next()?.trim();
    let (ws, hs) = line.split_once('x')?;
    let w: u32 = ws.trim().parse().ok()?;
    let h: u32 = hs.trim().parse().ok()?;
    if w > 0 && h > 0 { Some((w, h)) } else { None }
}

pub(crate) fn is_video_ext(ext: &str) -> bool {
    matches!(
        ext,
        "mp4" | "webm" | "mov" | "mkv" | "avi" | "m4v" | "flv" | "f4v"
    )
}

pub(crate) fn extract_video_poster(video_path: &Path, thumb_path: &Path) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let ffmpeg = find_ffmpeg_exe();
    let tmp_jpg = thumb_path.with_extension("tmp.jpg");
    let v_str = video_path.to_string_lossy().to_string();
    let t_str = tmp_jpg.to_string_lossy().to_string();

    // 优先尝试 0.5s（跳过淡入黑帧），失败后逐级回退至 0.1s 及 0s 第一帧
    for seek_time in ["0.5", "0.1", "0.0"] {
        let mut cmd = std::process::Command::new(&ffmpeg);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.arg("-y");
        if seek_time != "0.0" {
            cmd.args(["-ss", seek_time]);
        }
        cmd.args([
            "-i",
            &v_str,
            "-vframes",
            "1",
            "-vf",
            "scale='min(400,iw)':-2",
            "-q:v",
            "2",
            "-an",
            &t_str,
        ]);
        if let Some(out) = output_with_timeout(&mut cmd, std::time::Duration::from_secs(25)) {
            if out.status.success() && tmp_jpg.exists() {
                if let Ok(meta) = std::fs::metadata(&tmp_jpg) {
                    if meta.len() > 100 {
                        let _ = std::fs::rename(&tmp_jpg, thumb_path);
                        if thumb_path.exists() {
                            return true;
                        }
                    }
                }
            }
        }
        let _ = std::fs::remove_file(&tmp_jpg);
    }
    false
}

#[tauri::command]
pub async fn generate_thumbnails_batch(
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<BatchThumbResponse, String> {
    let _timer = CmdTimer::new("generate_thumbnails_batch");
    let thumbs_dir = state.data_dir.join("cache").join("thumbs");
    let db = state.db.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let _ = std::fs::create_dir_all(&thumbs_dir);

        use rayon::prelude::*;
        // 线程池复用：原来每次调用都新建一个（每次两线程），高频调用时线程反复创建销毁会拖慢整机
        static THUMB_POOL: std::sync::OnceLock<Option<rayon::ThreadPool>> = std::sync::OnceLock::new();
        let pool = THUMB_POOL.get_or_init(|| {
            rayon::ThreadPoolBuilder::new().num_threads(2).build().ok()
        });
        let worker = || {
            paths
                .par_iter()
                .filter_map(|file_path| {
                    let p = Path::new(file_path);
                    if !p.exists() {
                        return None;
                    }
                    let hash = format!("{:x}", fnv1a_hash(file_path.as_bytes()));
                    // 有透明的图写无损 WebP（保透明），其余写 q80 JPEG——
                    // JPEG 没 alpha，透明区里藏的 RGB 会被暴露成彩色毛刺。
                    if existing_thumb(&thumbs_dir, &hash).is_none() {
                        let ext = p
                            .extension()
                            .and_then(|e| e.to_str())
                            .unwrap_or("")
                            .to_ascii_lowercase();
                        if ext == "psd" || ext == "psb" {
                            let psd_cached = thumbs_dir.join(format!("psd-{}.webp", hash));
                            if psd_cached.exists() {
                                if let Ok(img) = image::open(&psd_cached) {
                                    let thumb = img.resize(400, 400, image::imageops::FilterType::Triangle);
                                    let _ = save_thumb_smart(&thumb, &thumbs_dir, &hash);
                                }
                            }
                            if existing_thumb(&thumbs_dir, &hash).is_none() {
                                if let Some(img) = extract_psd_image(p) {
                                    let thumb = img.resize(400, 400, image::imageops::FilterType::Triangle);
                                    let _ = save_thumb_smart(&thumb, &thumbs_dir, &hash);
                                }
                            }
                        } else if is_video_ext(&ext) {
                            let poster = thumbs_dir.join(format!("{}-q80.jpg", hash));
                            let _ = extract_video_poster(p, &poster);
                        } else if let Ok(img) = image::open(p) {
                            let thumb = img.resize(400, 400, image::imageops::FilterType::Triangle);
                            let _ = save_thumb_smart(&thumb, &thumbs_dir, &hash);
                        }
                    }
                    let thumb_path = existing_thumb(&thumbs_dir, &hash)?;
                    let thumb_str = thumb_path.to_string_lossy().to_string();
                    Some(ThumbItem {
                        file_path: file_path.clone(),
                        thumbnail_path: thumb_str,
                    })
                })
                .collect::<Vec<ThumbItem>>()
        };
        let items: Vec<ThumbItem> = match pool {
            Some(p) => p.install(worker),
            None => worker(),
        };

        if !items.is_empty() {
            if let Ok(mut conn) = db.lock() {
                if let Ok(tx) = conn.transaction() {
                    for item in &items {
                        let _ = tx.execute(
                            "UPDATE images SET thumbnail_path = ?1 WHERE file_path = ?2",
                            rusqlite::params![item.thumbnail_path, item.file_path],
                        );
                    }
                    let _ = tx.commit();
                }
            }
        }

        Ok(BatchThumbResponse { results: items })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ----------------- PSD 头部尺寸与内嵌预览提取 -----------------

/// 有损 JPEG 缩略图（原子写入）：image crate 的 WebP 编码只能无损，
/// 400px 也要 ~200KB，一屏 20 张就是 4MB，解码也按无损图像做。
fn save_thumb_jpeg(img: &image::DynamicImage, path: &Path) -> bool {
    let tmp = path.with_extension("tmp");
    let rgb = img.to_rgb8();
    let Ok(f) = std::fs::File::create(&tmp) else {
        return false;
    };
    let mut w = std::io::BufWriter::new(f);
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut w, 80);
    let ok = enc
        .encode(rgb.as_raw(), rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
        .is_ok();
    drop(enc);
    /* 必须显式 flush 再 rename：BufWriter 没 flush 就改名，
       改名后文件是半截的，浏览器可能读到截断的 JPEG（早期缩略图异常的一个隐患）。 */
    use std::io::Write;
    let _ = w.flush();
    drop(w);
    if ok {
        let _ = std::fs::rename(&tmp, path);
        true
    } else {
        let _ = std::fs::remove_file(&tmp);
        false
    }
}

/// 图片里是否真的用到了透明（有 alpha 通道且存在 < 250 的像素）。
/// PNG 在“全透明”的像素里照样存 RGB；一旦丢掉 alpha 转 JPEG，
/// 那些本该隐藏的颜色就会变成彩色毛刺。
fn has_visible_alpha(img: &image::DynamicImage) -> bool {
    if !img.color().has_alpha() {
        return false;
    }
    let rgba = img.to_rgba8();
    rgba.pixels().any(|p| p[3] < 250)
}

/// 无损 WebP（保留透明通道）。体积比 JPEG 大几倍，但只有“真透明”的图才会走这里。
fn write_webp_lossless(img: &image::DynamicImage, path: &Path) -> bool {
    let tmp = path.with_extension("tmp");
    let rgba = img.to_rgba8();
    let Ok(f) = std::fs::File::create(&tmp) else {
        return false;
    };
    let mut w = std::io::BufWriter::new(f);
    let ok = image::codecs::webp::WebPEncoder::new_lossless(&mut w)
        .encode(
            rgba.as_raw(),
            rgba.width(),
            rgba.height(),
            image::ExtendedColorType::Rgba8,
        )
        .is_ok();
    use std::io::Write;
    let _ = w.flush();
    drop(w);
    if ok {
        let _ = std::fs::rename(&tmp, path);
        true
    } else {
        let _ = std::fs::remove_file(&tmp);
        false
    }
}

/// 缩略图落盘：有透明 → `{stem}-lossless.webp`（保透明）；无透明 → `{stem}-q80.jpg`。
/// 返回实际写出的路径。
fn save_thumb_smart(img: &image::DynamicImage, thumbs_dir: &Path, stem: &str) -> Option<PathBuf> {
    if has_visible_alpha(img) {
        let p = thumbs_dir.join(format!("{}-lossless.webp", stem));
        if write_webp_lossless(img, &p) {
            return Some(p);
        }
        // WebP 写入失败：退回 JPEG（至少别让格子空着）
        let j = thumbs_dir.join(format!("{}-q80.jpg", stem));
        return if save_thumb_jpeg(img, &j) { Some(j) } else { None };
    }
    let j = thumbs_dir.join(format!("{}-q80.jpg", stem));
    if save_thumb_jpeg(img, &j) {
        Some(j)
    } else {
        None
    }
}

/// 该图现有的缩略图路径（有损 jpg 或 保透明 webp，优先挑已存在的）
fn existing_thumb(thumbs_dir: &Path, stem: &str) -> Option<PathBuf> {
    let webp = thumbs_dir.join(format!("{}-lossless.webp", stem));
    if webp.exists() {
        return Some(webp);
    }
    let jpg = thumbs_dir.join(format!("{}-q80.jpg", stem));
    if jpg.exists() {
        return Some(jpg);
    }
    None
}

/// 网格大格高清显示图（1024px）：按需并发生成，有损 JPEG q80 存储
#[tauri::command]
pub async fn generate_display_thumbs_batch(
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<BatchDisplayThumbResponse, String> {
    let _timer = CmdTimer::new("generate_display_thumbs_batch");
    let thumbs_dir = state.data_dir.join("cache").join("thumbs");

    tauri::async_runtime::spawn_blocking(move || {
        let _ = std::fs::create_dir_all(&thumbs_dir);

        use rayon::prelude::*;
        static DISPLAY_POOL: std::sync::OnceLock<Option<rayon::ThreadPool>> = std::sync::OnceLock::new();
        let pool = DISPLAY_POOL.get_or_init(|| {
            rayon::ThreadPoolBuilder::new().num_threads(2).build().ok()
        });

        let worker = || {
            paths
                .par_iter()
                .filter_map(|file_path| {
                    let p = Path::new(file_path);
                    if !p.exists() {
                        return None;
                    }
                    let hash = format!("{:x}", fnv1a_hash(file_path.as_bytes()));
                    let stem = format!("{}-1024", hash);
                    if existing_thumb(&thumbs_dir, &stem).is_none() {
                        let ext = p
                            .extension()
                            .and_then(|e| e.to_str())
                            .unwrap_or("")
                            .to_ascii_lowercase();
                        if ext == "psd" || ext == "psb" {
                            let psd_cached = thumbs_dir.join(format!("psd-{}.webp", hash));
                            if psd_cached.exists() {
                                if let Ok(img) = image::open(&psd_cached) {
                                    let thumb = img.resize(1024, 1024, image::imageops::FilterType::Triangle);
                                    let _ = save_thumb_smart(&thumb, &thumbs_dir, &stem);
                                }
                            }
                            if existing_thumb(&thumbs_dir, &stem).is_none() {
                                if let Some(img) = extract_psd_image(p) {
                                    let thumb = img.resize(1024, 1024, image::imageops::FilterType::Triangle);
                                    let _ = save_thumb_smart(&thumb, &thumbs_dir, &stem);
                                }
                            }
                        } else if is_video_ext(&ext) {
                            if let Some(t400) = existing_thumb(&thumbs_dir, &hash) {
                                return Some(DisplayThumbItem {
                                    file_path: file_path.clone(),
                                    display_path: t400.to_string_lossy().to_string(),
                                });
                            }
                        } else if let Ok(img) = image::open(p) {
                            let thumb = img.resize(1024, 1024, image::imageops::FilterType::Triangle);
                            let _ = save_thumb_smart(&thumb, &thumbs_dir, &stem);
                        }
                    }
                    let display_path = existing_thumb(&thumbs_dir, &stem)?;
                    let display_str = display_path.to_string_lossy().to_string();
                    Some(DisplayThumbItem {
                        file_path: file_path.clone(),
                        display_path: display_str,
                    })
                })
                .collect::<Vec<DisplayThumbItem>>()
        };

        let items: Vec<DisplayThumbItem> = match pool {
            Some(p) => p.install(worker),
            None => worker(),
        };

        Ok(BatchDisplayThumbResponse { results: items })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn read_be_u16(buf: &[u8]) -> u16 {    u16::from_be_bytes([buf[0], buf[1]])
}

fn read_be_u32(buf: &[u8]) -> u32 {
    u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]])
}

fn extract_psd_dims(path: &Path) -> Option<(u32, u32)> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).ok()?;
    let mut hdr = [0u8; 26];
    f.read_exact(&mut hdr).ok()?;
    if &hdr[0..4] != b"8BPS" {
        return None;
    }
    let h = read_be_u32(&hdr[14..18]);
    let w = read_be_u32(&hdr[18..22]);
    if w > 0 && h > 0 {
        Some((w, h))
    } else {
        None
    }
}

fn unpack_packbits(src: &[u8], expected_len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(expected_len);
    let mut i = 0;
    while i < src.len() && out.len() < expected_len {
        let n = src[i] as i8;
        i += 1;
        if n >= 0 {
            let count = (n as usize) + 1;
            let avail = (src.len() - i).min(count);
            out.extend_from_slice(&src[i..i + avail]);
            i += avail;
        } else if n != -128 {
            let count = (1 - (n as i32)) as usize;
            if i >= src.len() {
                break;
            }
            let val = src[i];
            i += 1;
            let take = count.min(expected_len - out.len());
            out.resize(out.len() + take, val);
        }
    }
    if out.len() != expected_len {
        out.resize(expected_len, 0);
    }
    out
}

fn decode_psd_merged_section(
    version: u16,
    channels: usize,
    width: usize,
    height: usize,
    depth: usize,
    color_mode: u16,
    color_data: &[u8],
    merged: &[u8],
) -> Option<image::DynamicImage> {
    if merged.len() < 2 {
        return None;
    }
    let compression = read_be_u16(&merged[0..2]);
    let pos = 2usize;
    let row_bytes = if depth == 1 {
        (width + 7) / 8
    } else {
        width * (depth / 8)
    };
    let plane_bytes = row_bytes * height;
    let use_channels = channels.min(5);
    let mut planes: Vec<Vec<u8>> = Vec::with_capacity(use_channels);

    if compression == 0 {
        for c in 0..use_channels {
            let start = pos + c * plane_bytes;
            let end = start + plane_bytes;
            if end > merged.len() {
                return None;
            }
            planes.push(merged[start..end].to_vec());
        }
    } else if compression == 1 {
        let total_scanlines = channels * height;
        let len_entry_size = if version == 2 { 4 } else { 2 };
        let table_bytes = total_scanlines * len_entry_size;
        if pos + table_bytes > merged.len() {
            return None;
        }
        let mut line_lens = Vec::with_capacity(total_scanlines);
        for s in 0..total_scanlines {
            let off = pos + s * len_entry_size;
            let l = if version == 2 {
                read_be_u32(&merged[off..off + 4]) as usize
            } else {
                read_be_u16(&merged[off..off + 2]) as usize
            };
            line_lens.push(l);
        }
        let mut data_pos = pos + table_bytes;
        for c in 0..channels {
            let mut ch_buf = if c < use_channels {
                Vec::with_capacity(plane_bytes)
            } else {
                Vec::new()
            };
            for r in 0..height {
                let l = line_lens[c * height + r];
                if data_pos > merged.len() {
                    return None;
                }
                let avail_end = (data_pos + l).min(merged.len());
                if c < use_channels {
                    let dec = unpack_packbits(&merged[data_pos..avail_end], row_bytes);
                    ch_buf.extend_from_slice(&dec);
                }
                data_pos += l;
            }
            if c < use_channels {
                planes.push(ch_buf);
            }
        }
    } else if compression == 2 || compression == 3 {
        use std::io::Read;
        let expected_total = use_channels * plane_bytes;
        let mut decoder = flate2::read::ZlibDecoder::new(&merged[pos..]);
        let mut decompressed = Vec::with_capacity(expected_total.min(32 * 1024 * 1024));
        if decoder.by_ref().take(expected_total as u64).read_to_end(&mut decompressed).is_err() {
            return None;
        }
        if decompressed.len() < expected_total {
            decompressed.resize(expected_total, 0);
        }
        for c in 0..use_channels {
            let start = c * plane_bytes;
            let mut plane = decompressed[start..start + plane_bytes].to_vec();
            if compression == 3 {
                if depth == 8 {
                    for r in 0..height {
                        let row = &mut plane[r * row_bytes..(r + 1) * row_bytes];
                        for x in 1..row.len() {
                            row[x] = row[x].wrapping_add(row[x - 1]);
                        }
                    }
                } else if depth == 16 {
                    for r in 0..height {
                        let row = &mut plane[r * row_bytes..(r + 1) * row_bytes];
                        let mut prev = 0u16;
                        for x in (0..row.len()).step_by(2) {
                            let cur = u16::from_be_bytes([row[x], row[x + 1]]).wrapping_add(prev);
                            prev = cur;
                            let bytes = cur.to_be_bytes();
                            row[x] = bytes[0];
                            row[x + 1] = bytes[1];
                        }
                    }
                }
            }
            planes.push(plane);
        }
    } else {
        return None;
    }

    let sample = |ch: usize, idx: usize| -> u8 {
        if depth == 16 {
            planes[ch][idx * 2]
        } else if depth == 32 {
            let off = idx * 4;
            let v = f32::from_be_bytes([
                planes[ch][off],
                planes[ch][off + 1],
                planes[ch][off + 2],
                planes[ch][off + 3],
            ]);
            let clamped = v.clamp(0.0, 1.0);
            (clamped.powf(1.0 / 2.2) * 255.0).round() as u8
        } else {
            planes[ch][idx]
        }
    };

    let px_count = width * height;
    let mut rgba = vec![255u8; px_count * 4];
    match color_mode {
        0 if depth == 1 && !planes.is_empty() => {
            for y in 0..height {
                for x in 0..width {
                    let byte = planes[0][y * row_bytes + (x / 8)];
                    let bit = (byte >> (7 - (x % 8))) & 1;
                    let v = if bit != 0 { 0u8 } else { 255u8 };
                    let dst = (y * width + x) * 4;
                    rgba[dst] = v;
                    rgba[dst + 1] = v;
                    rgba[dst + 2] = v;
                    rgba[dst + 3] = 255;
                }
            }
        }
        1 if !planes.is_empty() => {
            let has_a = planes.len() >= 2;
            for i in 0..px_count {
                let g = sample(0, i);
                rgba[i * 4] = g;
                rgba[i * 4 + 1] = g;
                rgba[i * 4 + 2] = g;
                rgba[i * 4 + 3] = if has_a { sample(1, i) } else { 255 };
            }
        }
        2 if !planes.is_empty() && color_data.len() >= 768 => {
            for i in 0..px_count {
                let idx = planes[0][i] as usize;
                rgba[i * 4] = color_data[idx];
                rgba[i * 4 + 1] = color_data[256 + idx];
                rgba[i * 4 + 2] = color_data[512 + idx];
                rgba[i * 4 + 3] = 255;
            }
        }
        3 if planes.len() >= 3 => {
            let has_a = planes.len() >= 4;
            for i in 0..px_count {
                rgba[i * 4] = sample(0, i);
                rgba[i * 4 + 1] = sample(1, i);
                rgba[i * 4 + 2] = sample(2, i);
                rgba[i * 4 + 3] = if has_a { sample(3, i) } else { 255 };
            }
        }
        4 if planes.len() >= 4 => {
            let has_a = planes.len() >= 5;
            for i in 0..px_count {
                let c = sample(0, i) as u32;
                let m = sample(1, i) as u32;
                let y = sample(2, i) as u32;
                let k = sample(3, i) as u32;
                rgba[i * 4] = ((c * k) / 255) as u8;
                rgba[i * 4 + 1] = ((m * k) / 255) as u8;
                rgba[i * 4 + 2] = ((y * k) / 255) as u8;
                rgba[i * 4 + 3] = if has_a { sample(4, i) } else { 255 };
            }
        }
        _ => return None,
    }

    image::RgbaImage::from_raw(width as u32, height as u32, rgba).map(image::DynamicImage::ImageRgba8)
}

fn extract_psd_merged_image_streaming(path: &Path) -> Option<image::DynamicImage> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let mut hdr = [0u8; 26];
    f.read_exact(&mut hdr).ok()?;
    if &hdr[0..4] != b"8BPS" {
        return None;
    }
    let version = read_be_u16(&hdr[4..6]);
    if version != 1 && version != 2 {
        return None;
    }
    let channels = read_be_u16(&hdr[12..14]) as usize;
    let height = read_be_u32(&hdr[14..18]) as usize;
    let width = read_be_u32(&hdr[18..22]) as usize;
    let depth = read_be_u16(&hdr[22..24]) as usize;
    let color_mode = read_be_u16(&hdr[24..26]);

    if width == 0 || height == 0 || channels == 0 || !matches!(depth, 1 | 8 | 16 | 32) {
        return None;
    }
    if (width as u64) * (height as u64) > 500_000_000 {
        return None;
    }

    let mut len4 = [0u8; 4];
    f.read_exact(&mut len4).ok()?;
    let color_len = read_be_u32(&len4) as usize;
    let color_data = if color_mode == 2 && color_len >= 768 && color_len <= 4096 {
        let mut buf = vec![0u8; color_len];
        f.read_exact(&mut buf).ok()?;
        buf
    } else {
        f.seek(SeekFrom::Current(color_len as i64)).ok()?;
        Vec::new()
    };

    f.read_exact(&mut len4).ok()?;
    let res_len = read_be_u32(&len4) as i64;
    f.seek(SeekFrom::Current(res_len)).ok()?;

    if version == 2 {
        let mut len8 = [0u8; 8];
        f.read_exact(&mut len8).ok()?;
        let lm_len = u64::from_be_bytes(len8) as i64;
        f.seek(SeekFrom::Current(lm_len)).ok()?;
    } else {
        f.read_exact(&mut len4).ok()?;
        let lm_len = read_be_u32(&len4) as i64;
        f.seek(SeekFrom::Current(lm_len)).ok()?;
    }

    let mut merged = Vec::new();
    f.read_to_end(&mut merged).ok()?;
    decode_psd_merged_section(version, channels, width, height, depth, color_mode, &color_data, &merged)
}

fn extract_psd_image(path: &Path) -> Option<image::DynamicImage> {
    // 1. 优先流式跳过图层区，直接解码末尾 Merged Image Data（大 PSD 内存省 90%）
    if let Some(img) = extract_psd_merged_image_streaming(path) {
        return Some(img);
    }

    // 2. Fallback: 若文件不太大 (< 150MB)，尝试用 psd crate 合成图层
    let file_len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if file_len > 0 && file_len < 150 * 1024 * 1024 {
        if let Ok(bytes) = std::fs::read(path) {
            if let Ok(doc) = psd::Psd::from_bytes(&bytes) {
                let w = doc.width();
                let h = doc.height();
                if w > 0 && h > 0 {
                    let rgba = doc.rgba();
                    if let Some(buf) = image::RgbaImage::from_raw(w, h, rgba) {
                        return Some(image::DynamicImage::ImageRgba8(buf));
                    }
                }
            }
        }
    }

    // 3. Fallback: 读取 8BIM 内嵌缩略图资源 (1036 / 1033)
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let mut hdr = [0u8; 26];
    f.read_exact(&mut hdr).ok()?;
    if &hdr[0..4] != b"8BPS" {
        return None;
    }

    let mut len_buf = [0u8; 4];
    f.read_exact(&mut len_buf).ok()?;
    let color_len = read_be_u32(&len_buf) as i64;
    f.seek(SeekFrom::Current(color_len)).ok()?;

    f.read_exact(&mut len_buf).ok()?;
    let res_len = read_be_u32(&len_buf) as usize;
    if res_len == 0 || res_len > 64 * 1024 * 1024 {
        return None;
    }
    let mut res_buf = vec![0u8; res_len];
    f.read_exact(&mut res_buf).ok()?;

    let mut pos = 0usize;
    while pos + 12 <= res_buf.len() {
        let sig = &res_buf[pos..pos + 4];
        if !matches!(sig, b"8BIM" | b"8B64" | b"PHUT" | b"MeSa" | b"DCSR") {
            break;
        }
        pos += 4;
        let res_id = read_be_u16(&res_buf[pos..pos + 2]);
        pos += 2;
        let name_len = res_buf[pos] as usize;
        let padded_name = (1 + name_len + 1) & !1;
        if pos + padded_name + 4 > res_buf.len() {
            break;
        }
        pos += padded_name;
        let data_len = read_be_u32(&res_buf[pos..pos + 4]) as usize;
        pos += 4;
        if pos + data_len > res_buf.len() {
            break;
        }
        let data = &res_buf[pos..pos + data_len];
        if (res_id == 1036 || res_id == 1033) && data.len() > 28 {
            let fmt = read_be_u32(&data[0..4]);
            if fmt == 1 {
                if let Ok(img) = image::load_from_memory(&data[28..]) {
                    return Some(img);
                }
            } else if fmt == 0 {
                let tw = read_be_u32(&data[4..8]);
                let th = read_be_u32(&data[8..12]);
                let raw = &data[28..];
                if tw > 0 && th > 0 && raw.len() >= (tw as usize) * (th as usize) * 3 {
                    if let Some(rgb) = image::RgbImage::from_raw(
                        tw,
                        th,
                        raw[..(tw as usize) * (th as usize) * 3].to_vec(),
                    ) {
                        return Some(image::DynamicImage::ImageRgb8(rgb));
                    }
                }
            }
        }
        let padded_data = (data_len + 1) & !1;
        pos += padded_data;
    }
    None
}

// ----------------- 移出根文件 -----------------

#[tauri::command]
pub async fn remove_root(
    folder_id: i64,
    state: State<'_, crate::AppState>,
) -> Result<serde_json::Value, String> {
    let db = state.db.clone();
    let thumbs_dir = state.data_dir.join("cache").join("thumbs");
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = db.lock().map_err(|e| e.to_string())?;
        let trash_imgs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM images WHERE folder_id = ?1 AND deleted_at IS NOT NULL AND trash_group IS NULL",
                [folder_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let trash_dirs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM picnest_trash_folders WHERE folder_id = ?1",
                [folder_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if trash_imgs > 0 || trash_dirs > 0 {
            return Ok(serde_json::json!({
                "ok": false,
                "error": format!("该根文件回收站内还有 {} 项，请先清空或还原", trash_imgs + trash_dirs)
            }));
        }

        /* 移出根之前先把标签/颜色/排序写进 <root>/.picnest/meta.json。
           对齐旧版行为（picnest-handlers.js 里 remove-root 的第一件事就是 picnestMetaExport）。
           不写的话，下面两行 DELETE 会直接抹掉这些设置，重新加回这个库时全丢。 */
        let paths: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT file_path FROM images WHERE folder_id = ?1")
                .map_err(|e| e.to_string())?;
            stmt.query_map([folder_id], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        meta_export_inner(&conn, folder_id)?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM images WHERE folder_id = ?1", [folder_id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM picnest_trash_folders WHERE folder_id = ?1", [folder_id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM picnest_dir_memory WHERE root_id = ?1", [folder_id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM folders WHERE id = ?1", [folder_id])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        for fp in &paths {
            crate::trash_ops::remove_thumbs_for(&thumbs_dir, fp);
        }
        Ok(serde_json::json!({ "ok": true }))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ----------------- 后台宽高探测 -----------------

#[tauri::command]
pub async fn fill_image_dims(
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let _timer = CmdTimer::new("fill_image_dims");
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        use rayon::prelude::*;
        let results: Vec<(String, u32, u32)> = paths
            .into_par_iter()
            .filter_map(|p_str| {
                let p = Path::new(&p_str);
                if !p.exists() {
                    return None;
                }
                let ext = p
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let dims = if ext == "psd" || ext == "psb" {
                    extract_psd_dims(p)
                } else if is_video_ext(&ext) {
                    extract_video_dims(p)
                } else {
                    image::image_dimensions(p).ok()
                };
                dims.filter(|&(w, h)| w > 0 && h > 0).map(|(w, h)| (p_str, w, h))
            })
            .collect();

        if !results.is_empty() {
            if let Ok(mut conn) = db.lock() {
                if let Ok(tx) = conn.transaction() {
                    for (p_str, w, h) in &results {
                        let _ = tx.execute(
                            "UPDATE images SET width = ?1, height = ?2 WHERE file_path = ?3",
                            rusqlite::params![*w as i64, *h as i64, p_str],
                        );
                    }
                    let _ = tx.commit();
                }
            }
        }

        let mut out = serde_json::Map::new();
        for (p_str, w, h) in results {
            out.insert(p_str, serde_json::json!({ "width": w, "height": h }));
        }
        Ok(serde_json::Value::Object(out))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ----------------- 大图预览 & PSD 预览 -----------------

fn psd_preview_inner(file_path: &str, data_dir: &Path) -> serde_json::Value {
    let p = Path::new(file_path);
    if !p.exists() {
        return serde_json::json!({ "ok": false, "error": "PSD 文件不存在" });
    }
    let thumbs_dir = data_dir.join("cache").join("thumbs");
    let _ = std::fs::create_dir_all(&thumbs_dir);
    let hash = format!("{:x}", fnv1a_hash(file_path.as_bytes()));
    let preview_path = thumbs_dir.join(format!("psd-{}.webp", hash));
    if !preview_path.exists() {
        if let Some(img) = extract_psd_image(p) {
            let out_img = if img.width() > 3000 || img.height() > 3000 {
                img.thumbnail(2560, 2560)
            } else {
                img
            };
            if let Err(e) = out_img.save(&preview_path) {
                return serde_json::json!({ "ok": false, "error": e.to_string() });
            }
        } else {
            return serde_json::json!({ "ok": false, "error": "PSD 解析失败" });
        }
    }
    serde_json::json!({ "ok": true, "path": preview_path.to_string_lossy().to_string() })
}

#[tauri::command]
pub async fn view_preview(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&file_path);
        if !p.exists() {
            return Ok(serde_json::json!({ "ok": false, "error": "文件不存在" }));
        }
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext == "psd" || ext == "psb" {
            return Ok(psd_preview_inner(&file_path, &data_dir));
        }

        if let Ok((w, h)) = image::image_dimensions(p) {
            if w <= 2400 && h <= 2400 {
                return Ok(serde_json::json!({ "ok": true, "path": file_path }));
            }
        }

        let thumbs_dir = data_dir.join("cache").join("thumbs");
        let _ = std::fs::create_dir_all(&thumbs_dir);
        let hash = format!("{:x}", fnv1a_hash(file_path.as_bytes()));
        let view_path = thumbs_dir.join(format!("{}-2048-q80.jpg", hash));
        let old_view_webp = thumbs_dir.join(format!("view-{}.webp", hash));

        if !view_path.exists() {
            if old_view_webp.exists() {
                return Ok(serde_json::json!({ "ok": true, "path": old_view_webp.to_string_lossy().to_string() }));
            }
            if let Ok(img) = image::open(p) {
                let resized = img.resize(2048, 2048, image::imageops::FilterType::Triangle);
                if !save_thumb_jpeg(&resized, &view_path) {
                    return Ok(serde_json::json!({ "ok": true, "path": file_path }));
                }
            } else {
                return Ok(serde_json::json!({ "ok": true, "path": file_path }));
            }
        }
        Ok(serde_json::json!({ "ok": true, "path": view_path.to_string_lossy().to_string() }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn psd_preview(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || Ok(psd_preview_inner(&file_path, &data_dir)))
        .await
        .map_err(|e| e.to_string())?
}

// ----------------- 旋转 / 翻转 / 裁切写回源文件 -----------------

fn is_editable_raster_ext(ext: &str) -> bool {
    !matches!(ext, "psd" | "psb" | "gif" | "svg" | "")
}

fn prepare_for_ext(img: image::DynamicImage, ext: &str) -> image::DynamicImage {
    if (ext == "jpg" || ext == "jpeg") && img.color().has_alpha() {
        image::DynamicImage::ImageRgb8(img.to_rgb8())
    } else {
        img
    }
}

fn save_dynamic_image_atomic(
    img: &image::DynamicImage,
    target_path: &Path,
    tmp_path: &Path,
) -> Result<(), String> {
    if let Err(e) = img.save(tmp_path) {
        let _ = std::fs::remove_file(tmp_path);
        return Err(format!("保存失败: {}", e));
    }
    if let Err(e) = std::fs::rename(tmp_path, target_path) {
        let _ = std::fs::remove_file(tmp_path);
        return Err(format!("替换目标文件失败: {}", e));
    }
    Ok(())
}

/// Shared backup -> atomic overwrite -> thumb cache invalidation -> DB metadata update
/// used by both `apply_transform` and `crop_image`.
fn overwrite_image_atomic_and_reindex(
    file_path: &str,
    img: image::DynamicImage,
    data_dir: &Path,
    conn: Option<&rusqlite::Connection>,
) -> serde_json::Value {
    let p = Path::new(file_path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let img = prepare_for_ext(img, &ext);

    let backup_dir = data_dir.join("cache").join("transform-backups");
    let _ = std::fs::create_dir_all(&backup_dir);
    let hash = format!("{:x}", fnv1a_hash(file_path.as_bytes()));
    let fname = p.file_name().and_then(|s| s.to_str()).unwrap_or("img");
    let backup_path = backup_dir.join(format!("{}-{}", hash, fname));
    let backup_ok = std::fs::copy(p, &backup_path).is_ok();

    let parent = p.parent().unwrap_or_else(|| Path::new("."));
    let tmp_path = parent.join(format!(".picnest-tmp-{}.{}", hash, ext));
    if let Err(err) = save_dynamic_image_atomic(&img, p, &tmp_path) {
        return serde_json::json!({ "ok": false, "error": err });
    }

    let thumbs_dir = data_dir.join("cache").join("thumbs");
    crate::trash_ops::remove_thumbs_for(&thumbs_dir, file_path);

    let w = img.width() as i64;
    let h = img.height() as i64;
    let meta = std::fs::metadata(p).ok();
    let size = meta.as_ref().map(|m| m.len() as i64).unwrap_or(0);
    let modified_dur = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok());
    let mtime_secs = modified_dur.map(|d| d.as_secs() as i64).unwrap_or(0);
    let mtime_ms = modified_dur.map(|d| d.as_millis() as i64).unwrap_or(0);

    if let Some(c) = conn {
        let _ = c.execute(
            "UPDATE images SET width = ?1, height = ?2, size = ?3, mtime = ?4, thumbnail_path = NULL WHERE LOWER(file_path) = LOWER(?5)",
            rusqlite::params![w, h, size, mtime_secs, file_path],
        );
    }

    serde_json::json!({
        "ok": true,
        "changed": true,
        "width": w,
        "height": h,
        "size": size,
        "modify_time": mtime_ms,
        "backupPath": if backup_ok { Some(backup_path.to_string_lossy().to_string()) } else { None::<String> }
    })
}

fn clamp_crop_box(opts: &serde_json::Value, orig_w: u32, orig_h: u32) -> (u32, u32, u32, u32) {
    let raw_left = opts.get("left").and_then(|v| v.as_f64()).unwrap_or(0.0).round() as i64;
    let raw_top = opts.get("top").and_then(|v| v.as_f64()).unwrap_or(0.0).round() as i64;
    let raw_w = opts
        .get("width")
        .and_then(|v| v.as_f64())
        .unwrap_or(orig_w as f64)
        .round() as i64;
    let raw_h = opts
        .get("height")
        .and_then(|v| v.as_f64())
        .unwrap_or(orig_h as f64)
        .round() as i64;

    let max_left = orig_w.saturating_sub(1) as i64;
    let max_top = orig_h.saturating_sub(1) as i64;
    let left = raw_left.clamp(0, max_left) as u32;
    let top = raw_top.clamp(0, max_top) as u32;
    let max_w = (orig_w - left) as i64;
    let max_h = (orig_h - top) as i64;
    let width = raw_w.clamp(1, max_w.max(1)) as u32;
    let height = raw_h.clamp(1, max_h.max(1)) as u32;
    (left, top, width, height)
}

#[tauri::command]
pub async fn apply_transform(
    file_path: String,
    opts: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // 解码 + 旋转 + 重编码 + 写盘，几百毫秒到几秒：绝不能跑在主线程（会堵窗口消息泵）
    let db = state.db.clone();
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&file_path);
        if !p.exists() {
            return Ok(serde_json::json!({ "ok": false, "error": "文件不存在" }));
        }
        let rot_raw = opts.get("rot").and_then(|v| v.as_i64()).unwrap_or(0);
        let rot = ((rot_raw % 360) + 360) % 360;
        let flop_x = opts.get("flopX").and_then(|v| v.as_bool()).unwrap_or(false);
        if rot == 0 && !flop_x {
            return Ok(serde_json::json!({ "ok": true, "changed": false }));
        }

        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !is_editable_raster_ext(&ext) {
            return Ok(serde_json::json!({ "ok": false, "error": "当前格式不支持直接写回旋转翻转" }));
        }

        let mut img = match image::open(p) {
            Ok(im) => im,
            Err(e) => {
                return Ok(serde_json::json!({ "ok": false, "error": format!("解码失败: {}", e) }))
            }
        };
        if flop_x {
            img = img.fliph();
        }
        img = match rot {
            90 => img.rotate90(),
            180 => img.rotate180(),
            270 => img.rotate270(),
            _ => img,
        };

        let conn = db.lock().ok();
        Ok(overwrite_image_atomic_and_reindex(
            &file_path,
            img,
            &data_dir,
            conn.as_deref(),
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn crop_image_sync(
    file_path: &str,
    opts: &serde_json::Value,
    data_dir: &Path,
    conn: Option<&rusqlite::Connection>,
) -> serde_json::Value {
    let p = Path::new(file_path);
    if !p.exists() {
        return serde_json::json!({ "ok": false, "error": "文件不存在" });
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !is_editable_raster_ext(&ext) {
        return serde_json::json!({ "ok": false, "error": "当前格式不支持直接裁切写回" });
    }
    let img = match image::open(p) {
        Ok(im) => im,
        Err(e) => return serde_json::json!({ "ok": false, "error": format!("解码失败: {}", e) }),
    };
    let (orig_w, orig_h) = (img.width(), img.height());
    if orig_w == 0 || orig_h == 0 {
        return serde_json::json!({ "ok": false, "error": "图片尺寸无效" });
    }
    let (left, top, width, height) = clamp_crop_box(opts, orig_w, orig_h);
    let cropped = img.crop_imm(left, top, width, height);
    overwrite_image_atomic_and_reindex(file_path, cropped, data_dir, conn)
}

#[tauri::command]
pub async fn crop_image(
    file_path: String,
    opts: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let data_dir = state.data_dir.clone();
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().ok();
        Ok(crop_image_sync(&file_path, &opts, &data_dir, conn.as_deref()))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn crop_image_as_sync(
    file_path: &str,
    opts: &serde_json::Value,
    conn: &rusqlite::Connection,
) -> serde_json::Value {
    let p = Path::new(file_path);
    if !p.exists() {
        return serde_json::json!({ "ok": false, "error": "文件不存在" });
    }
    let ext_raw = p.extension().and_then(|e| e.to_str()).unwrap_or("");
    let ext = ext_raw.to_ascii_lowercase();
    if !is_editable_raster_ext(&ext) {
        return serde_json::json!({ "ok": false, "error": "当前格式不支持裁切另存" });
    }
    let img = match image::open(p) {
        Ok(im) => im,
        Err(e) => return serde_json::json!({ "ok": false, "error": format!("解码失败: {}", e) }),
    };
    let (orig_w, orig_h) = (img.width(), img.height());
    if orig_w == 0 || orig_h == 0 {
        return serde_json::json!({ "ok": false, "error": "图片尺寸无效" });
    }
    let (left, top, width, height) = clamp_crop_box(opts, orig_w, orig_h);
    let cropped = prepare_for_ext(img.crop_imm(left, top, width, height), &ext);

    let dir = p.parent().unwrap_or_else(|| Path::new("."));
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let mut final_path = dir.join(format!("{}-cropped.{}", stem, ext_raw));
    let mut i = 2usize;
    while final_path.exists() {
        final_path = dir.join(format!("{}-cropped-{}.{}", stem, i, ext_raw));
        i += 1;
    }

    let format = match image::ImageFormat::from_path(&final_path) {
        Ok(format) => format,
        Err(error) => return serde_json::json!({ "ok": false, "error": error.to_string() }),
    };
    let mut bytes = Vec::new();
    if let Err(error) = cropped.write_to(&mut std::io::Cursor::new(&mut bytes), format) {
        return serde_json::json!({ "ok": false, "error": format!("保存失败: {error}") });
    }
    let staged = match crate::fs_ops::stage_write_new(&final_path, &bytes) {
        Ok(staged) => staged,
        Err(error) => return serde_json::json!({ "ok": false, "error": error }),
    };
    if let Err(error) = crate::operation_journal::commit_new_files(
        conn,
        vec![(staged, serde_json::json!({}))],
        |tx, files| {
            crate::importer::index_disk_paths_in_tx(tx, &[files[0].final_path.clone()], true)?;
            Ok(())
        },
    ) {
        return serde_json::json!({ "ok": false, "error": error });
    }

    let final_str = final_path.to_string_lossy().to_string();
    let meta = std::fs::metadata(&final_path).ok();
    let size = meta.as_ref().map(|m| m.len() as i64).unwrap_or(0);
    let mtime_ms = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    serde_json::json!({
        "ok": true,
        "path": final_str,
        "width": cropped.width() as i64,
        "height": cropped.height() as i64,
        "size": size,
        "modify_time": mtime_ms
    })
}

#[tauri::command]
pub async fn crop_image_as(
    file_path: String,
    opts: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        Ok(crop_image_as_sync(&file_path, &opts, &conn))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ----------------- 拖拽排序与移动 -----------------

#[tauri::command]
pub async fn images_reorder(
    folder_id: i64,
    _dir_rel: Option<String>,
    ordered_paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = db.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for (idx, p) in ordered_paths.iter().enumerate() {
            let order_val = (idx + 1) as i64;
            let _ = tx.execute(
                "UPDATE images SET sort_order = ?1 WHERE folder_id = ?2 AND file_path = ?3",
                rusqlite::params![order_val, folder_id, p],
            );
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(serde_json::json!({ "ok": true }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dir_order_get(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_read_conn(&db_path)?;
        let mut stmt = conn
            .prepare("SELECT key, names FROM picnest_dir_order")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        let mut map = serde_json::Map::new();
        for row in rows.flatten() {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&row.1) {
                map.insert(row.0, val);
            }
        }
        Ok(serde_json::Value::Object(map))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dir_order_set(
    folder_id: i64,
    parent_key: String,
    names: Vec<String>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let pk = if parent_key == "__root__" { "" } else { parent_key.as_str() };
        let key = format!("{}|{}", folder_id, pk);
        if names.is_empty() {
            let _ = conn.execute("DELETE FROM picnest_dir_order WHERE key = ?1", [&key]);
        } else {
            let names_json = serde_json::to_string(&names).map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO picnest_dir_order (key, names) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET names = ?2",
                rusqlite::params![key, names_json],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn natural_cmp_ci(a: &str, b: &str) -> std::cmp::Ordering {
    let ab = a.as_bytes();
    let bb = b.as_bytes();
    if ab.is_ascii() && bb.is_ascii() {
        let (mut i, mut j) = (0usize, 0usize);
        while i < ab.len() && j < bb.len() {
            if ab[i].is_ascii_digit() && bb[j].is_ascii_digit() {
                let is = i;
                while i < ab.len() && ab[i].is_ascii_digit() {
                    i += 1;
                }
                let js = j;
                while j < bb.len() && bb[j].is_ascii_digit() {
                    j += 1;
                }
                let na = std::str::from_utf8(&ab[is..i]).unwrap_or("").trim_start_matches('0');
                let nb = std::str::from_utf8(&bb[js..j]).unwrap_or("").trim_start_matches('0');
                let ord = na
                    .len()
                    .cmp(&nb.len())
                    .then_with(|| na.cmp(nb))
                    .then_with(|| (i - is).cmp(&(j - js)));
                if ord != std::cmp::Ordering::Equal {
                    return ord;
                }
            } else {
                let ca = ab[i].to_ascii_lowercase();
                let cb = bb[j].to_ascii_lowercase();
                if ca != cb {
                    return ca.cmp(&cb);
                }
                i += 1;
                j += 1;
            }
        }
        return ab.len().cmp(&bb.len()).then_with(|| a.cmp(b));
    }
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b))
}

fn sort_dir_level_names(parent_abs: &Path, mode: &str) -> Result<Vec<String>, String> {
    if !matches!(mode, "name_asc" | "name_desc" | "mtime_asc" | "mtime_desc") {
        return Err(format!("未知排序: {}", mode));
    }
    let rd = std::fs::read_dir(parent_abs).map_err(|e| e.to_string())?;
    let mut entries: Vec<(String, u128)> = Vec::new();
    for ent in rd.flatten() {
        if !ent.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = ent.file_name().to_string_lossy().to_string();
        let mt = ent
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        entries.push((name, mt));
    }
    entries.sort_by(|a, b| match mode {
        "name_asc" => natural_cmp_ci(&a.0, &b.0),
        "name_desc" => natural_cmp_ci(&b.0, &a.0),
        "mtime_asc" => a.1.cmp(&b.1).then_with(|| natural_cmp_ci(&a.0, &b.0)),
        "mtime_desc" => b.1.cmp(&a.1).then_with(|| natural_cmp_ci(&a.0, &b.0)),
        _ => std::cmp::Ordering::Equal,
    });
    Ok(entries.into_iter().map(|e| e.0).collect())
}

fn write_dir_order_entry(
    conn: &rusqlite::Connection,
    folder_id: i64,
    parent_rel: &str,
    names: &[String],
) -> Result<(), String> {
    let pk = if parent_rel == "__root__" { "" } else { parent_rel.trim_matches('/') };
    let key = format!("{}|{}", folder_id, pk);
    let names_json = serde_json::to_string(names).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO picnest_dir_order (key, names) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET names = ?2",
        rusqlite::params![key, names_json],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn dir_sort_sync(
    conn: &rusqlite::Connection,
    parent_rel: &str,
    parent_abs_path: &str,
    mode: &str,
) -> serde_json::Value {
    let abs = Path::new(parent_abs_path);
    let Some(folder_id) = find_folder_id_for_path(conn, abs) else {
        return serde_json::json!({ "ok": false, "error": "未找到对应的根资料库" });
    };
    let names = match sort_dir_level_names(abs, mode) {
        Ok(v) => v,
        Err(e) => return serde_json::json!({ "ok": false, "error": e }),
    };
    if let Err(e) = write_dir_order_entry(conn, folder_id, parent_rel, &names) {
        return serde_json::json!({ "ok": false, "error": e });
    }
    serde_json::json!({ "ok": true, "names": names })
}

#[tauri::command]
pub async fn dir_sort(
    parent_rel: String,
    parent_abs_path: String,
    mode: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        Ok(dir_sort_sync(&conn, &parent_rel, &parent_abs_path, &mode))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn dir_sort_recursive_sync(
    conn: &rusqlite::Connection,
    root_abs_path: &str,
    root_rel: &str,
    mode: &str,
) -> serde_json::Value {
    let start_abs = Path::new(root_abs_path);
    let Some(folder_id) = find_folder_id_for_path(conn, start_abs) else {
        return serde_json::json!({ "ok": false, "error": "未找到对应的根资料库" });
    };
    let mut stack: Vec<(PathBuf, String)> = vec![(start_abs.to_path_buf(), root_rel.trim_matches('/').to_string())];
    let mut levels = 0usize;
    while let Some((abs, rel)) = stack.pop() {
        let names = match sort_dir_level_names(&abs, mode) {
            Ok(v) => v,
            Err(e) => return serde_json::json!({ "ok": false, "error": e }),
        };
        if let Err(e) = write_dir_order_entry(conn, folder_id, &rel, &names) {
            return serde_json::json!({ "ok": false, "error": e });
        }
        levels += 1;
        for name in names.into_iter().rev() {
            let child_abs = abs.join(&name);
            let child_rel = if rel.is_empty() { name } else { format!("{}/{}", rel, name) };
            stack.push((child_abs, child_rel));
        }
    }
    serde_json::json!({ "ok": true, "levels": levels })
}

#[tauri::command]
pub async fn dir_sort_recursive(
    root_abs_path: String,
    root_rel: String,
    mode: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        Ok(dir_sort_recursive_sync(&conn, &root_abs_path, &root_rel, &mode))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn export_dir_to_dest(src_dir: &Path, picked_parent: &Path, strip_prefix: bool) -> serde_json::Value {
    if !src_dir.exists() || !src_dir.is_dir() {
        return serde_json::json!({ "ok": false, "error": "源文件夹不存在" });
    }
    let dir_name_raw = src_dir
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("PicNest-Export");
    // 导出副本可选去掉排序编号（原库不动）；只剥 2–3 位数字前缀，不改日期类名字
    let dir_name_owned = if strip_prefix {
        strip_our_order_prefix(dir_name_raw)
    } else {
        dir_name_raw.to_string()
    };
    let dir_name = dir_name_owned.as_str();
    let dest_root = picked_parent.join(dir_name);
    let src_norm = src_dir.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase();
    let dst_norm = dest_root.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase();
    if dst_norm == src_norm || dst_norm.starts_with(&format!("{}\\", src_norm)) {
        return serde_json::json!({ "ok": false, "error": "不能导出到源目录内部" });
    }

    let mut stack: Vec<(PathBuf, PathBuf)> = vec![(src_dir.to_path_buf(), dest_root.clone())];
    let mut count = 0usize;
    while let Some((src, dst)) = stack.pop() {
        if let Err(e) = std::fs::create_dir_all(&dst) {
            return serde_json::json!({ "ok": false, "error": e.to_string(), "count": count });
        }
        let Ok(rd) = std::fs::read_dir(&src) else {
            continue;
        };
        for ent in rd.flatten() {
            let Ok(ft) = ent.file_type() else {
                continue;
            };
            let name = ent.file_name().to_string_lossy().to_string();
            if ft.is_dir() {
                let sub = if strip_prefix {
                    strip_our_order_prefix(&name)
                } else {
                    name.clone()
                };
                stack.push((ent.path(), dst.join(&sub)));
            } else if ft.is_file() {
                let ext = Path::new(&name)
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.to_ascii_lowercase())
                    .unwrap_or_default();
                if crate::importer::is_supported_drop_ext(&ext) {
                    let out_name = if strip_prefix {
                        let p = Path::new(&name);
                        let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or(&name);
                        let clean = strip_our_order_prefix(stem);
                        if ext.is_empty() {
                            clean
                        } else {
                            format!("{}.{}", clean, ext)
                        }
                    } else {
                        name.clone()
                    };
                    let target = crate::importer::unique_dest_path(&dst, &out_name);
                    if std::fs::copy(ent.path(), &target).is_ok() {
                        count += 1;
                    }
                }
            }
        }
    }
    serde_json::json!({
        "ok": true,
        "count": count,
        "dest": dest_root.to_string_lossy().to_string()
    })
}

#[tauri::command]
pub async fn export_dir(
    dir_path: String,
    strip_prefix: Option<bool>,
) -> Result<serde_json::Value, String> {
    let picked = rfd::AsyncFileDialog::new()
        .set_title("选择导出目标目录")
        .pick_folder()
        .await;
    let Some(folder) = picked else {
        return Ok(serde_json::json!({ "ok": false, "canceled": true }));
    };
    let dest_parent = folder.path().to_path_buf();
    let strip = strip_prefix.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        export_dir_to_dest(Path::new(&dir_path), &dest_parent, strip)
    })
    .await
    .map_err(|e| e.to_string())
}

/// 从 file_path 反查所属库根。用于「改 file_path 时同步重算 dir_rel」。
/// dir_rel 是列表/同步的唯一口径，只要 file_path 变了就必须重算，
/// 否则图会从目标目录的列表里消失，并且可能被源目录的快照判定成“磁盘已删除”。
fn root_path_for_result(conn: &rusqlite::Connection, file_path: &str) -> Result<Option<String>, String> {
    match conn.query_row(
        "SELECT f.path FROM images i JOIN folders f ON f.id = i.folder_id WHERE i.file_path = ?1 COLLATE NOCASE LIMIT 1",
        [file_path],
        |r| r.get::<_, String>(0),
    ) {
        Ok(path) => Ok(Some(path)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn move_image(
    file_path: String,
    target_dir: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db = state.db.clone();
    let thumbs_dir = state.data_dir.join("cache").join("thumbs");
    tauri::async_runtime::spawn_blocking(move || {
        let src = Path::new(&file_path);
        let dst_dir = Path::new(&target_dir);
        if !dst_dir.exists() || !dst_dir.is_dir() {
            return Ok(serde_json::json!({ "ok": false, "error": "目标目录不存在" }));
        }
        if !src.exists() {
            return Ok(serde_json::json!({ "ok": false, "error": "源文件不存在" }));
        }
        let name = src.file_name().and_then(|s| s.to_str()).unwrap_or("file");
        let mut target = dst_dir.join(name);
        if target.to_string_lossy().eq_ignore_ascii_case(&file_path) {
            return Ok(serde_json::json!({ "ok": true, "file_path": file_path, "moved": false }));
        }
        let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
        let ext = src.extension().and_then(|s| s.to_str()).unwrap_or("");
        let mut n = 1;
        while target.exists() {
            let candidate = if ext.is_empty() {
                format!("{} ({})", stem, n)
            } else {
                format!("{} ({}).{}", stem, n, ext)
            };
            target = dst_dir.join(candidate);
            n += 1;
        }
        let target_str = target.to_string_lossy().to_string();
        match rename_image_compensated(&db, &thumbs_dir, src, &target, true) {
            Ok(_) => Ok(serde_json::json!({ "ok": true, "file_path": target_str, "moved": true })),
            Err(e) => Ok(serde_json::json!({ "ok": false, "error": e })),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn move_dir_sync(
    db: &std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>,
    thumbs_dir: &Path,
    dir_path: &str,
    target_dir: &str,
) -> Result<serde_json::Value, String> {
        let _filesystem_guard = crate::operation_journal::filesystem_operation_guard();
        let src = Path::new(dir_path);
        let dst_dir = Path::new(target_dir);
        if !src.exists() || !src.is_dir() {
            return Ok(serde_json::json!({ "ok": false, "error": "源目录不存在" }));
        }
        if !dst_dir.exists() || !dst_dir.is_dir() {
            return Ok(serde_json::json!({ "ok": false, "error": "目标目录不存在" }));
        }
        let norm = |s: &str| s.trim_end_matches(&['\\', '/'][..]).to_lowercase();
        let src_norm = norm(&dir_path);
        let dst_norm = norm(&target_dir);
        if src_norm == dst_norm {
            return Ok(serde_json::json!({ "ok": true, "dir_path": dir_path, "moved": false }));
        }
        if dst_norm.starts_with(&(src_norm.clone() + "\\")) || dst_norm.starts_with(&(src_norm.clone() + "/")) {
            return Ok(serde_json::json!({ "ok": false, "error": "不能移动到自身子目录" }));
        }
        let base = src.file_name().and_then(|s| s.to_str()).unwrap_or("dir");
        let mut target = dst_dir.join(base);
        if norm(&target.to_string_lossy()) == src_norm {
            return Ok(serde_json::json!({ "ok": true, "dir_path": dir_path, "moved": false }));
        }
        let mut n = 1;
        while target.exists() {
            target = dst_dir.join(format!("{} ({})", base, n));
            n += 1;
        }
        let from_prefix = dir_path.trim_end_matches(&['\\', '/'][..]).to_string();
        let to_prefix = target.to_string_lossy().trim_end_matches(&['\\', '/'][..]).to_string();
        let identity = match crate::operation_journal::capture_path_identity(src) {
            Ok(identity) => identity,
            Err(e) => return Ok(serde_json::json!({ "ok": false, "error": e })),
        };
        let conn = match db.lock() {
            Ok(c) => c,
            Err(e) => return Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
        };
        let operation = match crate::operation_journal::begin_path_move(&conn, src, &target, identity) {
            Ok(op) => op,
            Err(e) => return Ok(serde_json::json!({ "ok": false, "error": e })),
        };
        let mut thumbs = Vec::new();
        let result = (|| {
            let sep = if from_prefix.contains('\\') { '\\' } else { '/' };
            let raw_prefix = format!("{}{}", from_prefix, sep);
            let like_prefix = format!("{}%", escape_like(&raw_prefix));
            let paths: Vec<String> = {
                let mut stmt = conn.prepare("SELECT file_path FROM images WHERE file_path LIKE ?1 ESCAPE '\\'")
                    .map_err(|e| e.to_string())?;
                stmt.query_map([like_prefix], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
            };
            crate::fs_ops::rename_no_replace(src, &target).map_err(|e| e.to_string())?;
            crate::operation_journal::mark_path_applied(&conn, &operation)?;
            let mut moved_thumbs = Vec::new();
            for old_p in &paths {
                let Some(np) = rebase_path_prefix(old_p, &from_prefix, &to_prefix) else { continue };
                let mut migration = ThumbMigration::prepare(&thumbs_dir, old_p, &np)?;
                let new_thumb = migration.apply()?;
                thumbs.push(migration);
                moved_thumbs.push((old_p.clone(), new_thumb));
            }
            let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            let mut moved_rows = 0i64;
            for (old_p, new_thumb) in &moved_thumbs {
                let Some(np) = rebase_path_prefix(old_p, &from_prefix, &to_prefix) else { continue };
                let dr = root_path_for_result(&tx, old_p)?
                    .map(|root| crate::db::dir_rel_of(&root, &np))
                    .unwrap_or_default();
                let changed = tx.execute(
                    "UPDATE images SET file_path = ?1, dir_rel = ?2, thumbnail_path = COALESCE(?3, thumbnail_path) WHERE file_path = ?4",
                    rusqlite::params![np, dr, new_thumb, old_p],
                ).map_err(|e| e.to_string())?;
                if changed != 1 { return Err(format!("目录图片记录已变化: {old_p}")); }
                moved_rows += 1;
            }
            crate::operation_journal::finish_in_tx(&tx, operation.id)?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(moved_rows)
        })();
        match result {
            Ok(moved_rows) => Ok(serde_json::json!({
                "ok": true, "dir_path": to_prefix, "moved": true, "images": moved_rows
            })),
            Err(error) => {
                let mut rollback_errors = Vec::new();
                for migration in thumbs.iter().rev() {
                    if let Err(e) = migration.rollback() {
                        rollback_errors.push(format!("缩略图回滚失败: {e}"));
                    }
                }
                drop(conn);
                let mut files_rolled_back = false;
                if let Err(e) = crate::operation_journal::rollback_path_files(&operation) {
                    rollback_errors.push(e);
                } else {
                    files_rolled_back = true;
                }
                let conn = match db.lock() {
                    Ok(conn) => conn,
                    Err(e) => {
                        rollback_errors.push(format!("回滚后重新锁定数据库失败: {e}"));
                        return Ok(serde_json::json!({ "ok": false, "error": format!("{error}; 回滚: {}", rollback_errors.join("; ")) }));
                    }
                };
                let mut journal_cleanup_failed = !files_rolled_back;
                if files_rolled_back {
                    if let Err(e) = conn.unchecked_transaction().map_err(|e| e.to_string())
                        .and_then(|tx| crate::operation_journal::finish_in_tx(&tx, operation.id).and_then(|_| tx.commit().map_err(|e| e.to_string()))) {
                        rollback_errors.push(e);
                        journal_cleanup_failed = true;
                    }
                }
                if journal_cleanup_failed {
                    let _ = crate::operation_journal::mark_manual(&conn, operation.id, &rollback_errors.join("; "));
                }
                Ok(serde_json::json!({ "ok": false, "error": format!("{error}; 回滚: {}", rollback_errors.join("; ")) }))
            }
        }
}

#[tauri::command]
pub async fn move_dir(
    dir_path: String,
    target_dir: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db = state.db.clone();
    let thumbs_dir = state.data_dir.join("cache").join("thumbs");
    tauri::async_runtime::spawn_blocking(move || {
        move_dir_sync(&db, &thumbs_dir, &dir_path, &target_dir)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ----------------- 排序同步文件名与重命名 -----------------

fn strip_order_prefix(name: &str) -> String {
    if let Some(pos) = name.find('_') {
        let num = &name[..pos];
        if (1..=4).contains(&num.len()) && num.chars().all(|c| c.is_ascii_digit()) {
            let rest = &name[pos + 1..];
            // 避免把 2026_08_23 这类日期名当成排序前缀
            if num.len() == 4
                && rest.len() >= 5
                && rest.as_bytes()[0].is_ascii_digit()
                && rest.as_bytes()[1].is_ascii_digit()
                && rest.as_bytes()[2] == b'_'
                && rest.as_bytes()[3].is_ascii_digit()
                && rest.as_bytes()[4].is_ascii_digit()
            {
                return name.to_string();
            }
            if !rest.is_empty() {
                return rest.to_string();
            }
        }
    }
    name.to_string()
}

fn pad_order_num(idx: usize, total: usize) -> String {
    let width = total.to_string().len().max(2);
    format!("{:0width$}", idx, width = width)
}

/// 剥掉“我们加的”排序前缀：只认 2–3 位数字 + 下划线。
/// 比旧的 `strip_order_prefix`（1–4 位）保守——4 位是 `0524_`、`2023_` 这类日期/年份，不能碰。
fn strip_our_order_prefix(name: &str) -> String {
    if let Some(pos) = name.find('_') {
        let num = &name[..pos];
        if (2..=3).contains(&num.len()) && num.chars().all(|c| c.is_ascii_digit()) {
            let rest = &name[pos + 1..];
            if !rest.is_empty() {
                return rest.to_string();
            }
        }
    }
    name.to_string()
}

/// 同步到文件夹（库 → 磁盘）：把库里这个文件夹（含所有子文件夹）的图片顺序写成文件名前缀。
/// 与旧 `physical_order_images` 的区别：手动触发、可预览、**按库里的顺序**（不靠前端传什么就信什么）、
/// 改名时迁移缩略图缓存。
#[tauri::command]
pub async fn sync_folder_to_disk(
    folder_id: i64,
    dir_rel: String,
    dry_run: bool,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let _timer = CmdTimer::new("sync_folder_to_disk");
    let db = state.db.clone();
    let thumbs_dir = state.data_dir.join("cache").join("thumbs");
    tauri::async_runtime::spawn_blocking(move || {
        let root_path: String = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            conn.query_row("SELECT path FROM folders WHERE id = ?1", [folder_id], |r| r.get(0))
                .map_err(|_| "资料库不存在".to_string())?
        };
        let target = if dir_rel.is_empty() {
            PathBuf::from(&root_path)
        } else {
            Path::new(&root_path).join(dir_rel.replace('/', "\\"))
        };
        if !target.exists() {
            return Err("文件夹不存在".to_string());
        }

        // 1) 递归收集目录（相对 root 的 rel，小写，与 DB 的 dir_rel 对齐）
        let mut dirs: Vec<String> = Vec::new();
        let base_rel = dir_rel.trim_matches('/').to_lowercase();
        fn walk(dir: &Path, root: &Path, out: &mut Vec<String>, depth: usize) {
            if depth > 24 {
                return;
            }
            let rel = match dir.strip_prefix(root) {
                Ok(r) => r.to_string_lossy().replace('\\', "/").to_lowercase(),
                Err(_) => return,
            };
            out.push(rel);
            if let Ok(ents) = std::fs::read_dir(dir) {
                for ent in ents.flatten() {
                    let name = ent.file_name().to_string_lossy().to_string();
                    if name.starts_with('.') {
                        continue;
                    }
                    if ent.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        walk(&ent.path(), root, out, depth + 1);
                    }
                }
            }
        }
        walk(&target, Path::new(&root_path), &mut dirs, 0);

        struct Item {
            old: String,
            new: String,
        }
        let mut plan: Vec<Item> = Vec::new();

        // 2) 逐目录按库里的顺序生成新名
        for rel in &dirs {
            let list: Vec<String> = {
                let conn = db.lock().map_err(|e| e.to_string())?;
                let mut stmt = conn
                    .prepare(
                        "SELECT file_path FROM images WHERE folder_id = ?1 AND dir_rel = ?2 \
                         AND deleted_at IS NULL AND thumbnail_path != 'SKIP' \
                         ORDER BY (COALESCE(sort_order, 0) = 0) DESC, COALESCE(sort_order, 0) ASC, id DESC",
                    )
                    .map_err(|e| e.to_string())?;
                stmt.query_map(rusqlite::params![folder_id, rel], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?
            };
            // 只处理磁盘上真实存在的（避免把已删的算进去）
            let existing: Vec<String> = list.into_iter().filter(|p| Path::new(p).exists()).collect();
            let total = existing.len();
            if total == 0 {
                continue;
            }
            let width = total.to_string().len().max(2);
            for (i, fp) in existing.iter().enumerate() {
                let p = Path::new(fp);
                let orig = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
                let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
                let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or(orig);
                let clean = strip_our_order_prefix(stem);
                let prefix = format!("{:0width$}", i + 1, width = width);
                let new_name = if ext.is_empty() {
                    format!("{}_{}", prefix, clean)
                } else {
                    format!("{}_{}.{}", prefix, clean, ext)
                };
                if new_name == orig {
                    continue;
                }
                plan.push(Item {
                    old: fp.clone(),
                    new: p.parent().unwrap_or_else(|| Path::new(".")).join(&new_name).to_string_lossy().to_string(),
                });
            }
        }

        let _ = base_rel;
        let changed = plan.len();
        if dry_run {
            let preview: Vec<serde_json::Value> = plan.iter().take(200).map(|x| {
                serde_json::json!({
                    "old": Path::new(&x.old).file_name().and_then(|s| s.to_str()).unwrap_or(""),
                    "new": Path::new(&x.new).file_name().and_then(|s| s.to_str()).unwrap_or("")
                })
            }).collect();
            return Ok(serde_json::json!({
                "ok": true, "dryRun": true, "dirs": dirs.len(), "changed": changed, "preview": preview
            }));
        }

        let plan: Vec<(PathBuf, PathBuf)> = plan.into_iter()
            .map(|item| (PathBuf::from(item.old), PathBuf::from(item.new)))
            .collect();
        match run_batch_rename(&db, &thumbs_dir, &root_path, plan) {
            Ok(map) => Ok(serde_json::json!({
                "ok": true, "dryRun": false, "dirs": dirs.len(),
                "changed": changed, "renamed": map.len(), "failed": 0, "errors": []
            })),
            Err(error) => Ok(serde_json::json!({
                "ok": false, "dryRun": false, "dirs": dirs.len(),
                "changed": changed, "renamed": 0, "failed": changed, "errors": [error]
            })),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 把当前顺序写进文件名（手动、可预览、带缓存迁移）。
/// 与已废弃的 `physical_order_images` 的区别：
/// 1. 不再默默跟着拖拽自动跑，必须显式调用；
/// 2. `dry_run=true` 只返回改动清单，不碰磁盘；
/// 3. 改名后**迁移缩略图缓存**（old_hash → new_hash），不再置 NULL；
/// 4. 两阶段改名但用 `.picnest-tmp-*` 前缀，且失败单项回滚。
#[tauri::command]
pub async fn write_order_to_filenames(
    folder_id: i64,
    dir_rel: String,
    ordered_paths: Vec<String>,
    dry_run: bool,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let _timer = CmdTimer::new("write_order_to_filenames");
    let db = state.db.clone();
    let thumbs_dir = state.data_dir.join("cache").join("thumbs");
    tauri::async_runtime::spawn_blocking(move || {
        let root_path: String = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            conn.query_row("SELECT path FROM folders WHERE id = ?1", [folder_id], |r| r.get(0))
                .map_err(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => "资料库不存在".to_string(),
                    other => other.to_string(),
                })?
        };

        // 按父目录分组（每个目录独立编号 01..N）
        let mut by_parent: std::collections::BTreeMap<String, Vec<String>> = Default::default();
        for p in &ordered_paths {
            let parent = Path::new(p)
                .parent()
                .map(|x| x.to_string_lossy().to_string())
                .unwrap_or_default();
            by_parent.entry(parent).or_default().push(p.clone());
        }

        struct Item {
            old: String,
            new: String,
            changed: bool,
        }
        let mut plan: Vec<Item> = Vec::new();
        for (_parent, list) in &by_parent {
            let total = list.len();
            let width = total.to_string().len().max(2);
            for (i, fp) in list.iter().enumerate() {
                let p = Path::new(fp);
                let orig = p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
                let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
                let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or(&orig).to_string();
                let clean = strip_our_order_prefix(&stem);
                let prefix = format!("{:0width$}", i + 1, width = width);
                let new_name = if ext.is_empty() {
                    format!("{}_{}", prefix, clean)
                } else {
                    format!("{}_{}.{}", prefix, clean, ext)
                };
                let changed = new_name != orig;
                let new_path = p
                    .parent()
                    .unwrap_or_else(|| Path::new("."))
                    .join(&new_name)
                    .to_string_lossy()
                    .to_string();
                plan.push(Item { old: fp.clone(), new: new_path, changed });
            }
        }

        let total = plan.len();
        let changed_count = plan.iter().filter(|x| x.changed).count();
        let _ = dir_rel;

        if dry_run {
            let preview: Vec<serde_json::Value> = plan
                .iter()
                .filter(|x| x.changed)
                .take(300)
                .map(|x| {
                    serde_json::json!({
                        "old": Path::new(&x.old).file_name().and_then(|s| s.to_str()).unwrap_or(""),
                        "new": Path::new(&x.new).file_name().and_then(|s| s.to_str()).unwrap_or("")
                    })
                })
                .collect();
            return Ok(serde_json::json!({
                "ok": true, "dryRun": true,
                "total": plan.len(), "changed": changed_count, "preview": preview
            }));
        }

        let plan: Vec<(PathBuf, PathBuf)> = plan.into_iter()
            .filter(|item| item.changed)
            .map(|item| (PathBuf::from(item.old), PathBuf::from(item.new)))
            .collect();
        match run_batch_rename(&db, &thumbs_dir, &root_path, plan) {
            Ok(map) => Ok(serde_json::json!({
                "ok": true, "dryRun": false,
                "total": total, "changed": changed_count,
                "renamed": map.len(), "failed": 0, "errors": [], "map": map
            })),
            Err(error) => Ok(serde_json::json!({
                "ok": false, "dryRun": false,
                "total": total, "changed": changed_count,
                "renamed": 0, "failed": changed_count, "errors": [error], "map": []
            })),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 清理缩略图缓存里的孤儿文件（图已不存在，缩略图还在）。
///
/// 为什么需要它：永久删除、改名失败、崩溃残留、手动删文件都会留下孤儿。
/// 孤儿攒到几万个后，任何全目录遍历（Defender 实时扫描、OneDrive 同步）
/// 都会变成磁盘风暴 —— 2026-11-15 那次就是 4.2 万个文件把盘打到 100%。
///
/// 设计上故意限流（默认一次最多 400 个）且在启动后延迟调用，
/// 避免自己成为新的 IO 峰值。
#[tauri::command]
pub async fn cleanup_orphan_thumbs(
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db_path = state.db_path.clone();
    let thumbs_dir = state.data_dir.join("cache").join("thumbs");
    tauri::async_runtime::spawn_blocking(move || {
        let mut live = std::collections::HashSet::with_capacity(12000);
        with_read_conn(&db_path, |conn| {
            let mut stmt = conn
                .prepare("SELECT file_path FROM images")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            for fp in rows.flatten() {
                live.insert(format!("{:x}", fnv1a_hash(fp.as_bytes())));
            }
            Ok(())
        })?;
        let max = limit.unwrap_or(400).clamp(1, 5000);
        let (mut checked, mut deleted) = (0usize, 0usize);
        let mut freed: u64 = 0;
        if let Ok(rd) = std::fs::read_dir(&thumbs_dir) {
            for entry in rd.flatten() {
                checked += 1;
                let name = entry.file_name().to_string_lossy().to_string();
                // psd- / view- 有独立用途，不归本命令管
                if name.starts_with("psd-") || name.starts_with("view-") {
                    continue;
                }
                // 长后缀优先，否则 "-1024-q80.jpg" 会被 "-q80.jpg" 错切
                let h = name
                    .strip_suffix("-1024-q80.jpg")
                    .or_else(|| name.strip_suffix("-2048-q80.jpg"))
                    .or_else(|| name.strip_suffix("-q80.jpg"))
                    .or_else(|| name.strip_suffix("-1024-lossless.webp"))
                    .or_else(|| name.strip_suffix("-lossless.webp"))
                    .or_else(|| name.strip_suffix(".webp"));
                let Some(h) = h else { continue };
                if live.contains(h) {
                    continue;
                }
                if let Ok(md) = entry.metadata() {
                    if std::fs::remove_file(entry.path()).is_ok() {
                        deleted += 1;
                        freed += md.len();
                    }
                }
                if deleted >= max {
                    break;
                }
            }
        }
        Ok(serde_json::json!({
            "ok": true,
            "checked": checked,
            "deleted": deleted,
            "freedMB": freed / 1048576,
            "hasMore": deleted >= max
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) const THUMB_VARIANTS: [(&str, &str); 8] = [
    ("", "-q80.jpg"),
    ("", "-lossless.webp"),
    ("", "-1024-q80.jpg"),
    ("", "-1024-lossless.webp"),
    ("", "-2048-q80.jpg"),
    ("", ".webp"),
    ("psd-", ".webp"),
    ("view-", ".webp"),
];

pub(crate) fn thumbnail_filenames(hash: &str) -> Vec<String> {
    THUMB_VARIANTS.iter()
        .map(|(prefix, suffix)| format!("{prefix}{hash}{suffix}"))
        .collect()
}

pub(crate) struct ThumbMigration {
    moves: Vec<(PathBuf, PathBuf)>,
    applied: Vec<(PathBuf, PathBuf)>,
}

impl ThumbMigration {
    fn prepare(thumbs_dir: &Path, old_path: &str, new_path: &str) -> Result<Self, String> {
        let oh = format!("{:x}", fnv1a_hash(old_path.as_bytes()));
        let nh = format!("{:x}", fnv1a_hash(new_path.as_bytes()));
        if oh == nh {
            return Ok(Self { moves: Vec::new(), applied: Vec::new() });
        }
        let moves = thumbnail_filenames(&oh).into_iter().zip(thumbnail_filenames(&nh))
            .map(|(a, b)| (thumbs_dir.join(a), thumbs_dir.join(b)))
            .filter(|(a, b)| a.is_file() && !b.exists())
            .collect();
        Ok(Self { moves, applied: Vec::new() })
    }

    pub(crate) fn apply(&mut self) -> Result<Option<String>, String> {
        let mut applied: Vec<(PathBuf, PathBuf)> = Vec::new();
        for (old, new) in &self.moves {
            if let Err(e) = crate::fs_ops::rename_no_replace(old, new) {
                let rollback: String = applied.iter().rev()
                    .filter_map(|(a, b)| crate::fs_ops::rename_no_replace(b, a).err().map(|e| e.to_string()))
                    .collect::<Vec<_>>().join("; ");
                return Err(format!("迁移缩略图失败: {e}; 回滚: {rollback}"));
            }
            applied.push((old.clone(), new.clone()));
        }
        self.applied = applied;
        let nh = self.applied.iter().find(|(_, b)| b.ends_with("-lossless.webp")).map(|(_, b)| b.clone())
            .or_else(|| self.applied.iter().find(|(_, b)| b.ends_with("-q80.jpg")).map(|(_, b)| b.clone()));
        Ok(nh.map(|p| p.to_string_lossy().to_string()))
    }

    pub(crate) fn rollback(&self) -> Result<(), String> {
        let mut errors = Vec::new();
        for (old, new) in self.applied.iter().rev() {
            if old.exists() || !new.exists() {
                continue;
            }
            if let Err(e) = crate::fs_ops::rename_no_replace(new, old) {
                errors.push(e.to_string());
            }
        }
        if errors.is_empty() { Ok(()) } else { Err(errors.join("; ")) }
    }
}

fn reserve_batch_target(
    desired: &Path,
    old_keys: &std::collections::HashSet<String>,
    reserved: &mut std::collections::HashSet<String>,
) -> PathBuf {
    let parent = desired.parent().unwrap_or_else(|| Path::new("."));
    let name = desired.file_name().and_then(|n| n.to_str()).unwrap_or("image");
    let stem = desired.file_stem().and_then(|n| n.to_str()).unwrap_or(name);
    let ext = desired.extension().and_then(|n| n.to_str());
    let mut candidate = desired.to_path_buf();
    let mut suffix = 1u32;
    loop {
        let key = candidate.to_string_lossy().to_lowercase();
        let occupied_by_plan = old_keys.contains(&key);
        if reserved.contains(&key) || (candidate.exists() && !occupied_by_plan) {
            suffix += 1;
            let suffix = format!(" ({suffix})");
            let file_name = match ext {
                Some(ext) if !ext.is_empty() => format!("{stem}{suffix}.{ext}"),
                _ => format!("{stem}{suffix}"),
            };
            candidate = parent.join(file_name);
            continue;
        }
        reserved.insert(key);
        return candidate;
    }
}

fn run_batch_rename(
    db: &std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>,
    thumbs_dir: &Path,
    root_path: &str,
    desired: Vec<(PathBuf, PathBuf)>,
) -> Result<Vec<serde_json::Value>, String> {
    if desired.is_empty() {
        return Ok(Vec::new());
    }
    let _filesystem_guard = crate::operation_journal::filesystem_operation_guard();
    let old_keys = desired.iter().map(|(old, _)| old.to_string_lossy().to_lowercase()).collect();
    let mut reserved = std::collections::HashSet::new();
    let plan: Vec<(PathBuf, PathBuf)> = desired.into_iter()
        .map(|(old, target)| (old, reserve_batch_target(&target, &old_keys, &mut reserved)))
        .collect();
    let items = crate::operation_journal::prepare_batch_rename(&plan)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    let batch = crate::operation_journal::begin_batch_rename(&conn, items)?;
    let mut migrations: Vec<ThumbMigration> = Vec::new();
    let result: Result<Vec<serde_json::Value>, String> = (|| {
        for item in &batch.items {
            crate::fs_ops::rename_no_replace(&item.old, &item.temp).map_err(|e| e.to_string())?;
        }
        for item in &batch.items {
            crate::fs_ops::rename_no_replace(&item.temp, &item.final_path).map_err(|e| e.to_string())?;
        }
        crate::operation_journal::set_state(&conn, batch.id, "file_applied", None)?;
        let mut output = Vec::with_capacity(batch.items.len());
        for item in &batch.items {
            let old = item.old.to_string_lossy().to_string();
            let new = item.final_path.to_string_lossy().to_string();
            let mut migration = ThumbMigration::prepare(thumbs_dir, &old, &new)?;
            let new_thumb = migration.apply()?;
            migrations.push(migration);
            output.push(serde_json::json!({ "old": old, "new": new, "thumb": new_thumb }));
        }
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for (item, mapped) in batch.items.iter().zip(&output) {
            let new = item.final_path.to_string_lossy().to_string();
            let dr = crate::db::dir_rel_of(root_path, &new);
            let thumb = mapped.get("thumb").and_then(serde_json::Value::as_str);
            let changed = tx.execute(
                "UPDATE images SET file_path = ?1, dir_rel = ?2, thumbnail_path = COALESCE(?3, thumbnail_path) WHERE file_path = ?4",
                rusqlite::params![new, dr, thumb, item.old.to_string_lossy().to_string()],
            ).map_err(|e| e.to_string())?;
            if changed != 1 {
                return Err(format!("图片记录不存在或路径已变化: {}", item.old.display()));
            }
        }
        crate::operation_journal::finish_in_tx(&tx, batch.id)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(output)
    })();
    if result.is_err() {
        let mut rollback_errors = Vec::new();
        for migration in migrations.iter().rev() {
            if let Err(e) = migration.rollback() {
                rollback_errors.push(e);
            }
        }
        drop(conn);
        let mut files_rolled_back = false;
        if let Err(e) = crate::operation_journal::rollback_batch_files(&batch) {
            rollback_errors.push(e);
        } else {
            files_rolled_back = true;
        }
        let conn = db.lock().map_err(|e| format!("回滚后重新锁定数据库失败: {e}"))?;
        let mut journal_cleanup_failed = !files_rolled_back;
        if files_rolled_back {
            if let Err(e) = conn.unchecked_transaction().map_err(|e| e.to_string())
                .and_then(|tx| crate::operation_journal::finish_in_tx(&tx, batch.id).and_then(|_| tx.commit().map_err(|e| e.to_string()))) {
                rollback_errors.push(e);
                journal_cleanup_failed = true;
            }
        }
        if journal_cleanup_failed {
            let _ = crate::operation_journal::mark_manual(&conn, batch.id, &rollback_errors.join("; "));
        }
        if !rollback_errors.is_empty() {
            return Err(format!("{}; 回滚失败: {}", result.unwrap_err(), rollback_errors.join("; ")));
        }
    }
    result
}

pub(crate) fn db_move_image_path(
    conn: &rusqlite::Connection,
    old_path: &str,
    new_path: &str,
    new_thumb: Option<&str>,
) -> Result<(), String> {
    // 有可用的新缩略图就写进去；确实没有才置空（真需重生时前端会自己补）
    // dir_rel 同样要重算：rename_dir 也复用本函数，目录改名后相对路径变了。
    // （rename_image 是同目录改名，重算出来与原来一致，无副作用）
    let dr = root_path_for_result(conn, old_path)?
        .map(|root| crate::db::dir_rel_of(&root, new_path))
        .unwrap_or_default();
    let changed = match new_thumb {
        Some(t) => conn.execute(
            "UPDATE images SET file_path = ?1, dir_rel = ?2, thumbnail_path = ?3 WHERE file_path = ?4",
            rusqlite::params![new_path, dr, t, old_path],
        ).map_err(|e| e.to_string())?,
        None => conn.execute(
            "UPDATE images SET file_path = ?1, dir_rel = ?2, thumbnail_path = NULL WHERE file_path = ?3",
            rusqlite::params![new_path, dr, old_path],
        ).map_err(|e| e.to_string())?,
    };
    if changed != 1 {
        return Err("图片记录不存在或路径已变化".to_string());
    }
    Ok(())
}

fn rename_image_compensated(
    db: &std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>,
    thumbs_dir: &Path,
    source: &Path,
    target: &Path,
    reset_order: bool,
) -> Result<Option<String>, String> {
    let _filesystem_guard = crate::operation_journal::filesystem_operation_guard();
    let old_path = source.to_string_lossy().to_string();
    let new_path = target.to_string_lossy().to_string();
    let identity = crate::operation_journal::capture_path_identity(source)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    let operation = crate::operation_journal::begin_path_move(&conn, source, target, identity)?;
    let mut thumb = None;
    let result: Result<Option<String>, String> = (|| {
        crate::fs_ops::rename_no_replace(source, target).map_err(|e| e.to_string())?;
        crate::operation_journal::mark_path_applied(&conn, &operation)?;
        let mut migration = ThumbMigration::prepare(thumbs_dir, &old_path, &new_path)?;
        let new_thumb = migration.apply()?;
        thumb = Some(migration);
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        db_move_image_path(&tx, &old_path, &new_path, new_thumb.as_deref())?;
        if reset_order {
            tx.execute("UPDATE images SET sort_order = 0 WHERE file_path = ?1", [&new_path])
                .map_err(|e| e.to_string())?;
        }
        crate::operation_journal::finish_in_tx(&tx, operation.id)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(new_thumb)
    })();
    match result {
        Ok(thumb) => Ok(thumb),
        Err(error) => {
            let mut rollback_errors = Vec::new();
            if let Some(migration) = thumb.as_ref() {
                if let Err(e) = migration.rollback() {
                    rollback_errors.push(format!("缩略图回滚失败: {e}"));
                }
            }
            drop(conn);
            let mut files_rolled_back = false;
            if let Err(e) = crate::operation_journal::rollback_path_files(&operation) {
                rollback_errors.push(e);
            } else {
                files_rolled_back = true;
            }
            let conn = db.lock().map_err(|e| format!("回滚后重新锁定数据库失败: {e}"))?;
            let mut journal_cleanup_failed = !files_rolled_back;
            if files_rolled_back {
                if let Err(e) = conn.unchecked_transaction().map_err(|e| e.to_string())
                    .and_then(|tx| crate::operation_journal::finish_in_tx(&tx, operation.id).and_then(|_| tx.commit().map_err(|e| e.to_string()))) {
                    rollback_errors.push(e);
                    journal_cleanup_failed = true;
                }
            }
            if journal_cleanup_failed {
                let _ = crate::operation_journal::mark_manual(&conn, operation.id, &rollback_errors.join("; "));
            }
            Err(format!("{error}; 回滚: {}", rollback_errors.join("; ")))
        }
    }
}

#[tauri::command]
pub async fn rename_image(
    file_path: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // 磁盘改名 + 缓存迁移，不能放主线程（会堵窗口消息泵）
    let db = state.db.clone();
    let thumbs_dir = state.data_dir.join("cache").join("thumbs");
    tauri::async_runtime::spawn_blocking(move || {
    let clean: String = new_name
        .trim()
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    if clean.is_empty() {
        return Ok(serde_json::json!({ "ok": false, "error": "名称为空" }));
    }
    let src = Path::new(&file_path);
    let dir = src.parent().unwrap_or_else(|| Path::new("."));
    let ext = src.extension().and_then(|s| s.to_str()).unwrap_or("");
    let final_name = if !ext.is_empty() && !clean.to_lowercase().ends_with(&format!(".{}", ext.to_lowercase())) {
        format!("{}.{}", clean, ext)
    } else {
        clean
    };
    let target = dir.join(&final_name);
    let target_str = target.to_string_lossy().to_string();
    if target_str == file_path {
        return Ok(serde_json::json!({ "ok": true, "file_path": file_path }));
    }
    if target.exists() && !crate::fs_ops::paths_alias(src, &target) {
        return Ok(serde_json::json!({ "ok": false, "error": "同名文件已存在" }));
    }
    match rename_image_compensated(&db, &thumbs_dir, src, &target, false) {
        Ok(_) => Ok(serde_json::json!({ "ok": true, "file_path": target_str })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": e })),
    }
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn rebase_path_prefix(full: &str, old_root: &str, new_root: &str) -> Option<String> {
    let old_clean = old_root.trim_end_matches(&['\\', '/'][..]);
    let new_clean = new_root.trim_end_matches(&['\\', '/'][..]);
    if old_clean.is_empty() {
        return None;
    }
    let old_comps: Vec<String> = Path::new(old_clean)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
        .collect();
    let full_comps: Vec<std::path::Component<'_>> = Path::new(full).components().collect();
    if full_comps.len() < old_comps.len() {
        return None;
    }
    for (oc, fc) in old_comps.iter().zip(full_comps.iter()) {
        if oc != &fc.as_os_str().to_string_lossy().to_lowercase() {
            return None;
        }
    }
    let mut out = PathBuf::from(new_clean);
    for rem in &full_comps[old_comps.len()..] {
        out.push(rem.as_os_str());
    }
    Some(out.to_string_lossy().to_string())
}

fn rename_dir_sync(
    db: &std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>,
    thumbs_dir: &Path,
    old_path: &str,
    new_name: &str,
    old_rel: Option<&str>,
    parent_rel: Option<&str>,
) -> Result<serde_json::Value, String> {
        let _filesystem_guard = crate::operation_journal::filesystem_operation_guard();
        let clean: String = new_name
            .trim()
            .chars()
            .filter(|&c| !"\\/:*?\"<>|".contains(c))
            .collect();
        if clean.is_empty() {
            return Ok(serde_json::json!({ "ok": false, "error": "名称为空" }));
        }
        let old_clean = old_path.trim_end_matches(&['\\', '/'][..]).to_string();
        let src = Path::new(&old_clean);
        let parent = src.parent().unwrap_or_else(|| Path::new("."));
        let target = parent.join(&clean);
        let target_str = target.to_string_lossy().to_string();
        if !old_clean.eq_ignore_ascii_case(&target_str) && target.exists() {
            return Ok(serde_json::json!({ "ok": false, "error": "同名文件夹已存在" }));
        }
        let physically_changed = old_clean != target_str;
        let old_name = src.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let identity = if physically_changed {
            match crate::operation_journal::capture_path_identity(src) {
                Ok(identity) => Some(identity),
                Err(e) => return Ok(serde_json::json!({ "ok": false, "error": e })),
            }
        } else {
            None
        };
        let conn = match db.lock() {
            Ok(c) => c,
            Err(e) => return Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
        };
        let operation = if physically_changed {
            match crate::operation_journal::begin_path_move(&conn, src, &target, identity.unwrap()) {
                Ok(op) => Some(op),
                Err(e) => return Ok(serde_json::json!({ "ok": false, "error": e })),
            }
        } else {
            None
        };
        let mut thumbs = Vec::new();
        let result = (|| {
            let sep = if old_clean.contains('\\') { '\\' } else { '/' };
            let raw_prefix = format!("{}{}", old_clean, sep);
            let like_prefix = format!("{}%", escape_like(&raw_prefix));
            let rows: Vec<String> = {
                let mut stmt = conn.prepare("SELECT file_path FROM images WHERE file_path LIKE ?1 ESCAPE '\\'")
                    .map_err(|e| e.to_string())?;
                stmt.query_map([like_prefix], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
            };
            let folder_id_opt = find_folder_id_for_path_result(&conn, Path::new(&old_clean))?
                .or(find_folder_id_for_path_result(&conn, Path::new(&target_str))?);
            if physically_changed {
                crate::fs_ops::rename_no_replace(src, &target).map_err(|e| e.to_string())?;
                crate::operation_journal::mark_path_applied(&conn, operation.as_ref().unwrap())?;
            }
            let mut image_updates = Vec::new();
            for old_fp in rows {
                let Some(np) = rebase_path_prefix(&old_fp, &old_clean, &target_str) else { continue };
                let mut migration = ThumbMigration::prepare(&thumbs_dir, &old_fp, &np)?;
                let nt = migration.apply()?;
                thumbs.push(migration);
                image_updates.push((old_fp, np, nt));
            }
            let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            for (old_fp, np, nt) in &image_updates {
                let dr = root_path_for_result(&tx, old_fp)?
                    .map(|root| crate::db::dir_rel_of(&root, np))
                    .unwrap_or_default();
                let changed = tx.execute(
                    "UPDATE images SET file_path = ?1, dir_rel = ?2, thumbnail_path = COALESCE(?3, thumbnail_path) WHERE file_path = ?4",
                    rusqlite::params![np, dr, nt, old_fp],
                ).map_err(|e| e.to_string())?;
                if changed != 1 { return Err(format!("目录图片记录已变化: {old_fp}")); }
            }
            if let (Some(orel), Some(fid)) = (old_rel.as_ref(), folder_id_opt) {
                let prel = parent_rel.as_deref().unwrap_or_default();
                let new_rel = if prel.is_empty() { clean.clone() } else { format!("{}/{}", prel, clean) };
                let orel_prefix = format!("{}/", orel);
                let mems: Vec<(String, String)> = {
                    let mut stmt = tx.prepare("SELECT rel, patch FROM picnest_dir_memory WHERE root_id = ?1")
                        .map_err(|e| e.to_string())?;
                    stmt.query_map([fid], |r| Ok((r.get(0)?, r.get(1)?)))
                        .map_err(|e| e.to_string())?
                        .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
                };
                for (mrel, _) in mems {
                    let target_rel = if mrel == *orel {
                        Some(new_rel.clone())
                    } else if let Some(rest) = mrel.strip_prefix(&orel_prefix) {
                        Some(format!("{}/{}", new_rel, rest))
                    } else {
                        None
                    };
                    if let Some(nrel) = target_rel {
                        let changed = tx.execute(
                            "UPDATE picnest_dir_memory SET rel = ?1 WHERE root_id = ?2 AND rel = ?3",
                            rusqlite::params![nrel, fid, mrel],
                        ).map_err(|e| e.to_string())?;
                        if changed != 1 { return Err("目录记忆记录已变化".to_string()); }
                    }
                }
                let exact_order_key = format!("{}|{}", fid, prel);
                let key_like = format!("{}|%", escape_like(&fid.to_string()));
                let items: Vec<(String, String)> = {
                    let mut stmt = tx.prepare("SELECT key, names FROM picnest_dir_order WHERE key LIKE ?1 ESCAPE '\\'")
                        .map_err(|e| e.to_string())?;
                    stmt.query_map([key_like], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                        .map_err(|e| e.to_string())?
                        .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
                };
                for (k, v) in items {
                    if k != exact_order_key && !(prel.is_empty() && k == format!("{}|__root__", fid)) {
                        continue;
                    }
                    let mut arr: Vec<String> = serde_json::from_str(&v).map_err(|e| e.to_string())?;
                    if let Some(pos) = arr.iter().position(|x| x == &old_name) {
                        arr[pos] = clean.clone();
                        let nj = serde_json::to_string(&arr).map_err(|e| e.to_string())?;
                        tx.execute("UPDATE picnest_dir_order SET names = ?1 WHERE key = ?2", rusqlite::params![nj, k])
                            .map_err(|e| e.to_string())?;
                    }
                }
            }
            if let Some(op) = operation.as_ref() {
                crate::operation_journal::finish_in_tx(&tx, op.id)?;
            }
            tx.commit().map_err(|e| e.to_string())?;
            Ok(())
        })();
        match result {
            Ok(()) => Ok(serde_json::json!({ "ok": true, "path": target_str, "name": clean })),
            Err(error) => {
                let mut rollback_errors = Vec::new();
                for migration in thumbs.iter().rev() {
                    if let Err(e) = migration.rollback() {
                        rollback_errors.push(format!("缩略图回滚失败: {e}"));
                    }
                }
                let Some(op) = operation.as_ref() else {
                    return Ok(serde_json::json!({ "ok": false, "error": format!("{error}; 回滚: {}", rollback_errors.join("; ")) }));
                };
                drop(conn);
                let mut files_rolled_back = false;
                if let Err(e) = crate::operation_journal::rollback_path_files(op) {
                    rollback_errors.push(e);
                } else {
                    files_rolled_back = true;
                }
                let conn = match db.lock() {
                    Ok(conn) => conn,
                    Err(e) => {
                        rollback_errors.push(format!("回滚后重新锁定数据库失败: {e}"));
                        return Ok(serde_json::json!({ "ok": false, "error": format!("{error}; 回滚: {}", rollback_errors.join("; ")) }));
                    }
                };
                let mut journal_cleanup_failed = !files_rolled_back;
                if files_rolled_back {
                    if let Err(e) = conn.unchecked_transaction().map_err(|e| e.to_string())
                        .and_then(|tx| crate::operation_journal::finish_in_tx(&tx, op.id).and_then(|_| tx.commit().map_err(|e| e.to_string()))) {
                        rollback_errors.push(e);
                        journal_cleanup_failed = true;
                    }
                }
                if journal_cleanup_failed {
                    let _ = crate::operation_journal::mark_manual(&conn, op.id, &rollback_errors.join("; "));
                }
                Ok(serde_json::json!({ "ok": false, "error": format!("{error}; 回滚: {}", rollback_errors.join("; ")) }))
            }
        }
}

#[tauri::command]
pub async fn rename_dir(
    old_path: String,
    new_name: String,
    old_rel: Option<String>,
    parent_rel: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db = state.db.clone();
    let thumbs_dir = state.data_dir.join("cache").join("thumbs");
    tauri::async_runtime::spawn_blocking(move || {
        rename_dir_sync(
            &db, &thumbs_dir, &old_path, &new_name,
            old_rel.as_deref(), parent_rel.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

fn rename_library_sync(
    db: &std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>,
    thumbs_dir: &Path,
    id: i64,
    clean: &str,
    rename_disk: bool,
) -> Result<serde_json::Value, String> {
    if clean.is_empty() || clean == "." || clean == ".." {
        return Ok(serde_json::json!({ "ok": false, "error": "名称无效或为空" }));
    }
    let _filesystem_guard = crate::operation_journal::filesystem_operation_guard();
    let identity = if rename_disk {
        let old_path: String = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            conn.query_row("SELECT path FROM folders WHERE id = ?1", [id], |r| r.get(0))
                .map_err(|_| "根文件不存在".to_string())?
        };
        let old_clean = old_path.trim_end_matches(&['\\', '/'][..]);
        let src = Path::new(old_clean);
        if src.exists() {
            Some(crate::operation_journal::capture_path_identity(src)?)
        } else {
            None
        }
    } else {
        None
    };
    let conn = db.lock().map_err(|e| e.to_string())?;
    let old_path: String = conn
        .query_row("SELECT path FROM folders WHERE id = ?1", [id], |r| r.get(0))
        .map_err(|_| "根文件不存在".to_string())?;
    if !rename_disk {
        let changed = conn.execute(
            "UPDATE folders SET display_name = ?1 WHERE id = ?2",
            rusqlite::params![clean, id],
        ).map_err(|e| e.to_string())?;
        if changed != 1 {
            return Err("根文件记录已变化".to_string());
        }
        return Ok(serde_json::json!({
            "ok": true, "path": old_path, "name": clean,
            "display_name": clean, "displayOnly": true
        }));
    }

    let old_clean = old_path.trim_end_matches(&['\\', '/'][..]).to_string();
    let src = Path::new(&old_clean);
    let parent = src.parent().unwrap_or_else(|| Path::new("."));
    let target = parent.join(clean);
    let target_str = target.to_string_lossy().to_string();
    if old_clean == target_str {
        let changed = conn.execute(
            "UPDATE folders SET display_name = ?1 WHERE id = ?2",
            rusqlite::params![clean, id],
        ).map_err(|e| e.to_string())?;
        if changed != 1 {
            return Err("根文件记录已变化".to_string());
        }
        return Ok(serde_json::json!({
            "ok": true, "path": target_str, "name": clean,
            "display_name": clean, "unchanged": true
        }));
    }
    if !old_clean.eq_ignore_ascii_case(&target_str) && target.exists() {
        return Ok(serde_json::json!({ "ok": false, "error": "同名目录已存在" }));
    }

    let physical_change = if src.exists() {
        true
    } else if target.exists() {
        false
    } else {
        return Ok(serde_json::json!({ "ok": false, "error": "原根目录在磁盘上不存在" }));
    };
    let operation = if physical_change {
        Some(crate::operation_journal::begin_path_move(
            &conn,
            src,
            &target,
            identity.ok_or("根目录移动缺少预计算指纹")?,
        ).map_err(|e| e.to_string())?)
    } else {
        None
    };
    let mut migrations = Vec::new();
    let result: Result<(), String> = (|| {
        if physical_change {
            crate::fs_ops::rename_no_replace(src, &target).map_err(|e| e.to_string())?;
            crate::operation_journal::mark_path_applied(&conn, operation.as_ref().unwrap())?;
        }
        let rows: Vec<(i64, String)> = {
            let mut stmt = conn.prepare("SELECT id, file_path FROM images WHERE folder_id = ?1")
                .map_err(|e| e.to_string())?;
            stmt.query_map([id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };
        let mut updates = Vec::with_capacity(rows.len());
        for (image_id, old_fp) in rows {
            let Some(new_fp) = rebase_path_prefix(&old_fp, &old_clean, &target_str) else { continue };
            let mut migration = ThumbMigration::prepare(thumbs_dir, &old_fp, &new_fp)?;
            let new_thumb = migration.apply()?;
            migrations.push(migration);
            updates.push((image_id, old_fp, new_fp, new_thumb));
        }
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let changed = tx.execute(
            "UPDATE folders SET path = ?1, display_name = ?2 WHERE id = ?3",
            rusqlite::params![&target_str, clean, id],
        ).map_err(|e| e.to_string())?;
        if changed != 1 {
            return Err("根文件记录已变化".to_string());
        }
        for (image_id, old_fp, new_fp, new_thumb) in &updates {
            let changed = tx.execute(
                "UPDATE images SET file_path = ?1, dir_rel = ?2, thumbnail_path = COALESCE(?3, thumbnail_path) WHERE id = ?4 AND file_path = ?5",
                rusqlite::params![new_fp, crate::db::dir_rel_of(&target_str, new_fp), new_thumb, image_id, old_fp],
            ).map_err(|e| e.to_string())?;
            if changed != 1 {
                return Err(format!("图片记录已变化: {old_fp}"));
            }
        }
        let mems: Vec<(String, String)> = {
            let mut stmt = tx.prepare("SELECT rel, patch FROM picnest_dir_memory WHERE root_id = ?1")
                .map_err(|e| e.to_string())?;
            stmt.query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };
        for (rel, patch) in mems {
            let mut map: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&patch)
                .map_err(|e| format!("目录记忆 JSON 无效 {rel}: {e}"))?;
            if let Some(serde_json::Value::String(cover)) = map.get("coverPath").cloned() {
                if let Some(new_cover) = rebase_path_prefix(&cover, &old_clean, &target_str) {
                    map.insert("coverPath".to_string(), serde_json::Value::String(new_cover));
                    let patch = serde_json::to_string(&map).map_err(|e| e.to_string())?;
                    let changed = tx.execute(
                        "UPDATE picnest_dir_memory SET patch = ?1 WHERE root_id = ?2 AND rel = ?3",
                        rusqlite::params![patch, id, rel],
                    ).map_err(|e| e.to_string())?;
                    if changed != 1 {
                        return Err("目录记忆记录已变化".to_string());
                    }
                }
            }
        }
        if let Some(op) = operation.as_ref() {
            crate::operation_journal::finish_in_tx(&tx, op.id)?;
        }
        tx.commit().map_err(|e| e.to_string())
    })();
    if let Err(error) = result {
        let mut rollback_errors = Vec::new();
        for migration in migrations.iter().rev() {
            if let Err(e) = migration.rollback() {
                rollback_errors.push(format!("缩略图回滚失败: {e}"));
            }
        }
        let Some(op) = operation.as_ref() else {
            return Ok(serde_json::json!({ "ok": false, "error": error }));
        };
        drop(conn);
        let mut files_rolled_back = false;
        if let Err(e) = crate::operation_journal::rollback_path_files(op) {
            rollback_errors.push(e);
        } else {
            files_rolled_back = true;
        }
        let conn = db.lock().map_err(|e| format!("回滚后重新锁定数据库失败: {e}"))?;
        let mut journal_cleanup_failed = !files_rolled_back;
        if files_rolled_back {
            if let Err(e) = conn.unchecked_transaction().map_err(|e| e.to_string())
                .and_then(|tx| crate::operation_journal::finish_in_tx(&tx, op.id).and_then(|_| tx.commit().map_err(|e| e.to_string()))) {
                rollback_errors.push(e);
                journal_cleanup_failed = true;
            }
        }
        if journal_cleanup_failed {
            let _ = crate::operation_journal::mark_manual(&conn, op.id, &rollback_errors.join("; "));
        }
        return Ok(serde_json::json!({
            "ok": false,
            "error": if rollback_errors.is_empty() { error } else { format!("{error}; 回滚: {}", rollback_errors.join("; ")) }
        }));
    }
    Ok(serde_json::json!({
        "ok": true, "path": target_str, "name": clean, "display_name": clean
    }))
}

#[tauri::command]
pub async fn rename_library(
    id: i64,
    name: String,
    opts: Option<serde_json::Value>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db = state.db.clone();
    let thumbs_dir = state.data_dir.join("cache").join("thumbs");
    tauri::async_runtime::spawn_blocking(move || {
        let clean: String = name
            .trim()
            .chars()
            .filter(|&c| !"\\/:*?\"<>|".contains(c))
            .collect();
        let display_only = opts
            .as_ref()
            .and_then(|o| o.get("displayOnly"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let rename_disk = !display_only && opts
            .as_ref()
            .and_then(|o| o.get("renameDisk"))
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        rename_library_sync(&db, &thumbs_dir, id, &clean, rename_disk)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ----------------- 右侧详情：图片注释/URL 与色板分析 -----------------

#[tauri::command]
pub async fn get_image_meta(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let _timer = CmdTimer::new("get_image_meta");
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_read_conn(&db_path)?;
        let res = conn.query_row(
            "SELECT annotation, url FROM images WHERE file_path = ?1",
            [&file_path],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?)),
        );
        match res {
            Ok((ann, url)) => Ok(serde_json::json!({
                "annotation": ann.unwrap_or_default(),
                "url": url.unwrap_or_default()
            })),
            Err(_) => Ok(serde_json::json!({ "annotation": "", "url": "" })),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn set_image_meta(
    file_path: String,
    patch: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        if let Some(ann) = patch.get("annotation").and_then(|v| v.as_str()) {
            let _ = conn.execute(
                "UPDATE images SET annotation = ?1 WHERE file_path = ?2",
                rusqlite::params![ann, file_path],
            );
        }
        if let Some(url) = patch.get("url").and_then(|v| v.as_str()) {
            let _ = conn.execute(
                "UPDATE images SET url = ?1 WHERE file_path = ?2",
                rusqlite::params![url, file_path],
            );
        }
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn extract_palette_vec(img: &image::DynamicImage) -> Vec<serde_json::Value> {
    let small = img.resize_exact(48, 48, image::imageops::FilterType::Nearest).to_rgba8();
    let mut buckets: std::collections::HashMap<(u8, u8, u8), (u64, u64, u64, u64)> =
        std::collections::HashMap::new();
    let mut total_px = 0u64;
    for px in small.pixels() {
        if px[3] < 32 {
            continue;
        }
        let qr = px[0] / 32;
        let qg = px[1] / 32;
        let qb = px[2] / 32;
        let entry = buckets.entry((qr, qg, qb)).or_insert((0, 0, 0, 0));
        entry.0 += px[0] as u64;
        entry.1 += px[1] as u64;
        entry.2 += px[2] as u64;
        entry.3 += 1;
        total_px += 1;
    }
    if total_px == 0 {
        return Vec::new();
    }
    let mut raw: Vec<(u64, u64, u64, u64)> = buckets.into_values().collect();
    raw.sort_by(|a, b| b.3.cmp(&a.3));

    // 与旧版 picnest1 一致的贪心聚类：欧氏 RGB 距离 < 48 的相邻桶合并为统一主色簇
    let mut clusters: Vec<(u64, u64, u64, u64)> = Vec::new();
    for (sr, sg, sb, cnt) in raw {
        let r = (sr as f64) / (cnt as f64);
        let g = (sg as f64) / (cnt as f64);
        let b = (sb as f64) / (cnt as f64);
        let mut merged = false;
        for cl in clusters.iter_mut() {
            let cr = (cl.0 as f64) / (cl.3 as f64);
            let cg = (cl.1 as f64) / (cl.3 as f64);
            let cb = (cl.2 as f64) / (cl.3 as f64);
            let dist = ((r - cr).powi(2) + (g - cg).powi(2) + (b - cb).powi(2)).sqrt();
            if dist < 48.0 {
                cl.0 += sr;
                cl.1 += sg;
                cl.2 += sb;
                cl.3 += cnt;
                merged = true;
                break;
            }
        }
        if !merged {
            clusters.push((sr, sg, sb, cnt));
        }
    }

    clusters.sort_by(|a, b| b.3.cmp(&a.3));
    clusters.truncate(8);
    clusters
        .into_iter()
        .map(|(sr, sg, sb, cnt)| {
            let r = ((sr as f64) / (cnt as f64)).round() as u8;
            let g = ((sg as f64) / (cnt as f64)).round() as u8;
            let b = ((sb as f64) / (cnt as f64)).round() as u8;
            serde_json::json!({
                "r": r,
                "g": g,
                "b": b,
                "percent": ((cnt as f64) * 100.0) / (total_px as f64)
            })
        })
        .collect()
}

#[tauri::command]
pub async fn compute_color_analysis(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let data_dir = state.data_dir.clone();
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&file_path);
        let thumbs_dir = data_dir.join("cache").join("thumbs");
        let hash = format!("{:x}", fnv1a_hash(file_path.as_bytes()));
        let thumb_path = thumbs_dir.join(format!("{}.webp", hash));

        let img = if thumb_path.exists() {
            image::open(&thumb_path).ok()
        } else {
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            if ext == "psd" || ext == "psb" {
                extract_psd_image(p)
            } else {
                image::open(p).ok()
            }
        };

        let Some(im) = img else {
            return Ok(serde_json::json!({ "dominantColors": [] }));
        };

        let dominant = extract_palette_vec(&im);
        if !dominant.is_empty() {
            if let Ok(json_str) = serde_json::to_string(&dominant) {
                if let Ok(conn) = db.lock() {
                    let _ = conn.execute(
                        "UPDATE images SET palettes = ?1 WHERE file_path = ?2",
                        rusqlite::params![json_str, file_path],
                    );
                }
            }
        }

        Ok(serde_json::json!({ "dominantColors": dominant }))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn compute_palette_json_for_path(
    fp: &str,
    tp: Option<&str>,
    thumbs_dir: &Path,
) -> Option<String> {
    let hash = format!("{:x}", fnv1a_hash(fp.as_bytes()));
    let cached_thumb = thumbs_dir.join(format!("{}.webp", hash));
    let psd_cached = thumbs_dir.join(format!("psd-{}.webp", hash));
    let thumb_candidate = tp
        .filter(|s| !s.is_empty() && *s != "SKIP")
        .map(PathBuf::from)
        .filter(|p| p.exists())
        .or_else(|| cached_thumb.exists().then_some(cached_thumb))
        .or_else(|| psd_cached.exists().then_some(psd_cached));

    let p = Path::new(fp);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    let img = if let Some(tc) = thumb_candidate {
        image::open(&tc).ok()
    } else if matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp" | "bmp") {
        let size = std::fs::metadata(p).map(|m| m.len()).unwrap_or(u64::MAX);
        if size < 1_500_000 {
            image::open(p).ok()
        } else {
            return None;
        }
    } else {
        return None;
    };

    if let Some(im) = img {
        let vec = extract_palette_vec(&im);
        Some(serde_json::to_string(&vec).unwrap_or_else(|_| "[]".to_string()))
    } else {
        Some("[]".to_string())
    }
}

#[tauri::command]
pub async fn build_palettes_step(
    folder_id: i64,
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let _timer = CmdTimer::new("build_palettes_step");
    let db_path = state.db_path.clone();
    let data_dir = state.data_dir.clone();
    let db = state.db.clone();
    let lim = limit.unwrap_or(100).clamp(1, 300);

    tauri::async_runtime::spawn_blocking(move || {
        let rconn = open_read_conn(&db_path)?;
        let mut stmt = rconn
            .prepare(
                "SELECT file_path, thumbnail_path FROM images
                 WHERE folder_id = ?1 AND deleted_at IS NULL AND palettes IS NULL
                 ORDER BY id DESC
                 LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;
        let todo: Vec<(String, Option<String>)> = stmt
            .query_map(rusqlite::params![folder_id, lim], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })
            .map_err(|e| e.to_string())?
            .flatten()
            .collect();
        drop(stmt);
        drop(rconn);

        if todo.is_empty() {
            return Ok(serde_json::json!({ "ok": true, "processed": 0 }));
        }

        let thumbs_dir = data_dir.join("cache").join("thumbs");
        use rayon::prelude::*;
        let pool = rayon::ThreadPoolBuilder::new().num_threads(2).build();
        let work = || {
            todo.par_iter()
                .filter_map(|(fp, tp)| {
                    compute_palette_json_for_path(fp, tp.as_deref(), &thumbs_dir)
                        .map(|pal_json| (fp.clone(), pal_json))
                })
                .collect::<Vec<(String, String)>>()
        };
        let computed = match pool {
            Ok(p) => p.install(work),
            Err(_) => work(),
        };

        let count = computed.len();
        if let Ok(mut wconn) = db.lock() {
            if let Ok(tx) = wconn.transaction() {
                for (fp, pal) in &computed {
                    let _ = tx.execute(
                        "UPDATE images SET palettes = ?1 WHERE file_path = ?2",
                        rusqlite::params![pal, fp],
                    );
                }
                let _ = tx.commit();
            }
        }

        Ok(serde_json::json!({ "ok": true, "processed": count }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_palettes(
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let _timer = CmdTimer::new("get_palettes");
    if paths.is_empty() {
        return Ok(serde_json::json!({}));
    }
    let db_path = state.db_path.clone();
    let thumbs_dir = state.data_dir.join("cache").join("thumbs");
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_read_conn(&db_path)?;
        let mut out = serde_json::Map::new();
        let mut missing_rows: Vec<(String, Option<String>)> = Vec::new();
        for chunk in paths.chunks(200) {
            let placeholders: Vec<String> = (1..=chunk.len()).map(|i| format!("?{}", i)).collect();
            let sql = format!(
                "SELECT file_path, palettes, thumbnail_path FROM images WHERE file_path IN ({})",
                placeholders.join(",")
            );
            if let Ok(mut stmt) = conn.prepare(&sql) {
                let params = rusqlite::params_from_iter(chunk.iter());
                if let Ok(rows) = stmt.query_map(params, |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, Option<String>>(2)?,
                    ))
                }) {
                    for (fp, pal_opt, tp_opt) in rows.flatten() {
                        let mut loaded = false;
                        if let Some(ref pal_str) = pal_opt {
                            if let Ok(val) = serde_json::from_str::<serde_json::Value>(pal_str) {
                                if let Some(arr) = val.as_array() {
                                    loaded = true; // 包含 "[]" 也视为已处理，避免重复解码卡顿
                                    if !arr.is_empty() {
                                        out.insert(fp.clone(), val);
                                    }
                                }
                            }
                        }
                        if !loaded {
                            missing_rows.push((fp, tp_opt));
                        }
                    }
                }
            }
        }
        drop(conn);

        if !missing_rows.is_empty() {
            // 仅对已有磁盘缩略图缓存的条目标并行现算，最多 40 条，杜绝读原图卡顿
            let cached_only: Vec<(String, PathBuf)> = missing_rows
                .into_iter()
                .filter_map(|(fp, tp_opt)| {
                    let hash = format!("{:x}", fnv1a_hash(fp.as_bytes()));
                    let cached_thumb = thumbs_dir.join(format!("{}.webp", hash));
                    let psd_cached = thumbs_dir.join(format!("psd-{}.webp", hash));
                    let tc = tp_opt
                        .filter(|s| !s.is_empty() && s != "SKIP")
                        .map(PathBuf::from)
                        .filter(|p| p.exists())
                        .or_else(|| cached_thumb.exists().then_some(cached_thumb))
                        .or_else(|| psd_cached.exists().then_some(psd_cached))?;
                    Some((fp, tc))
                })
                .take(40)
                .collect();

            if !cached_only.is_empty() {
                use rayon::prelude::*;
                let pool = rayon::ThreadPoolBuilder::new().num_threads(2).build();
                let work = || {
                    cached_only
                        .par_iter()
                        .filter_map(|(fp, tc)| {
                            let pal_json = if let Ok(im) = image::open(tc) {
                                let vec = extract_palette_vec(&im);
                                serde_json::to_string(&vec).unwrap_or_else(|_| "[]".to_string())
                            } else {
                                "[]".to_string()
                            };
                            Some((fp.clone(), pal_json))
                        })
                        .collect::<Vec<(String, String)>>()
                };
                let to_save = match pool {
                    Ok(p) => p.install(work),
                    Err(_) => work(),
                };
                for (fp, pal_json) in &to_save {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(pal_json) {
                        if val.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                            out.insert(fp.clone(), val);
                        }
                    }
                }
                if !to_save.is_empty() {
                    if let Ok(mut wconn) = db.lock() {
                        if let Ok(tx) = wconn.transaction() {
                            for (fp, pal_json) in &to_save {
                                let _ = tx.execute(
                                    "UPDATE images SET palettes = ?1 WHERE file_path = ?2",
                                    rusqlite::params![pal_json, fp],
                                );
                            }
                            let _ = tx.commit();
                        }
                    }
                }
            }
        }

        Ok(serde_json::Value::Object(out))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ----------------- 视频兼容转码兜底 (MP4 / HEVC / MOV -> H.264) -----------------

#[tauri::command]
pub async fn video_compat(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&file_path);
        if !p.exists() {
            return Ok(serde_json::json!({ "ok": false, "error": "视频文件不存在" }));
        }
        let vid_dir = data_dir.join("cache").join("videos");
        let _ = std::fs::create_dir_all(&vid_dir);
        let hash = format!("{:x}", fnv1a_hash(file_path.as_bytes()));
        let out_path = vid_dir.join(format!("compat-{}.mp4", hash));
        if out_path.exists() && std::fs::metadata(&out_path).map(|m| m.len() > 0).unwrap_or(false) {
            return Ok(serde_json::json!({
                "ok": true,
                "path": out_path.to_string_lossy().to_string()
            }));
        }

        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let ffmpeg = find_ffmpeg_exe();
        let tmp_path = vid_dir.join(format!("compat-{}.tmp.mp4", hash));
        let mut cmd = std::process::Command::new(&ffmpeg);
        cmd.creation_flags(CREATE_NO_WINDOW)
            // -nostats + loglevel error：别把进度刷到 stderr（刷得越多、超时监控越容易被淹）
            .args(["-y", "-loglevel", "error", "-nostats"])
            .args([
                "-i",
                &file_path,
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "22",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-movflags",
                "+faststart",
            ])
            .arg(&tmp_path);
        // 转码最长给 10 分钟：超时直接 kill，宁可这张图没海报，也不留一个吃 GPU 的孤儿 ffmpeg
        let status = output_with_timeout(&mut cmd, std::time::Duration::from_secs(600));

        match status {
            Some(out) if out.status.success() && tmp_path.exists() => {
                let _ = std::fs::rename(&tmp_path, &out_path);
                Ok(serde_json::json!({
                    "ok": true,
                    "path": out_path.to_string_lossy().to_string()
                }))
            }
            Some(out) => {
                let _ = std::fs::remove_file(&tmp_path);
                let err = String::from_utf8_lossy(&out.stderr);
                Ok(serde_json::json!({
                    "ok": false,
                    "error": format!("ffmpeg 转码失败: {}", err.chars().take(200).collect::<String>())
                }))
            }
            None => {
                let _ = std::fs::remove_file(&tmp_path);
                Ok(serde_json::json!({
                    "ok": false,
                    "error": "ffmpeg 超时（10 分钟）已被中止，避免留下长时间吃 GPU 的进程"
                }))
            }
        }    })
    .await
    .map_err(|e| e.to_string())?
}

// ----------------- 评分、移除、搜索、随机、资源管理器定位 -----------------

#[tauri::command]
pub async fn set_image_rating(
    file_path: String,
    rating: i64,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let r = rating.clamp(0, 5);
        let _ = conn.execute(
            "UPDATE images SET rating = ?1 WHERE file_path = ?2",
            rusqlite::params![r, file_path],
        );
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn db_delete_image(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let db = state.db.clone();
    let thumbs_dir = state.data_dir.join("cache").join("thumbs");
    tauri::async_runtime::spawn_blocking(move || {
        // 删记录同时清缩略图，不让孤儿积起来
        crate::trash_ops::remove_thumbs_for(&thumbs_dir, &file_path);
        let conn = db.lock().map_err(|e| e.to_string())?;
        let _ = conn.execute("DELETE FROM images WHERE file_path = ?1", [file_path]);
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn picnest_reveal(file_path: String) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _ = std::process::Command::new("explorer")
            .creation_flags(CREATE_NO_WINDOW)
            .arg(format!("/select,{}", file_path))
            .spawn();
    }
    Ok(true)
}

#[tauri::command]
pub async fn picnest_search(
    folder_id: i64,
    query: String,
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<ImageItem>, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let db_path = state.db_path.clone();
    let thumbs_dir = state.data_dir.join("cache").join("thumbs");
    let lim = normalize_limit(limit.unwrap_or(300));
    tauri::async_runtime::spawn_blocking(move || {
        with_read_conn(&db_path, |conn| {
            let escaped = escape_like(&q);
            let pattern = format!("%{}%", escaped);
            let mut stmt = conn
                .prepare(
                    "SELECT id, folder_id, file_path, size, mtime, width, height, thumbnail_path, last_opened_at, annotation, url, deleted_at, COALESCE(rating, 0), COALESCE(is_favorite, 0)
                     FROM images
                     WHERE folder_id = ?1 AND deleted_at IS NULL
                       AND (file_path LIKE ?2 ESCAPE '\\' OR EXISTS (
                         SELECT 1 FROM image_tags it JOIN tags t ON t.id = it.tag_id
                         WHERE it.image_id = images.id AND t.name LIKE ?2 ESCAPE '\\'
                       ))
                     ORDER BY file_path COLLATE NOCASE LIMIT ?3",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params![folder_id, pattern, lim], |r| {
                    let file_path: String = r.get(2)?;
                    let file_name = Path::new(&file_path)
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| file_path.clone());
                    let raw_tp: Option<String> = r.get(7)?;
                    let thumbnail_path = resolve_existing_thumb(raw_tp, &file_path, &thumbs_dir);
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
                })
                .map_err(|e| e.to_string())?;
            Ok(rows.flatten().collect())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn picnest_random(
    folder_id: i64,
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<ImageItem>, String> {
    let db_path = state.db_path.clone();
    let thumbs_dir = state.data_dir.join("cache").join("thumbs");
    let lim = normalize_limit(limit.unwrap_or(300));
    tauri::async_runtime::spawn_blocking(move || {
        with_read_conn(&db_path, |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, folder_id, file_path, size, mtime, width, height, thumbnail_path, last_opened_at, annotation, url, deleted_at, COALESCE(rating, 0), COALESCE(is_favorite, 0)
                     FROM images
                     WHERE folder_id = ?1 AND deleted_at IS NULL
                     ORDER BY RANDOM() LIMIT ?2",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params![folder_id, lim], |r| {
                    let file_path: String = r.get(2)?;
                    let file_name = Path::new(&file_path)
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| file_path.clone());
                    let raw_tp: Option<String> = r.get(7)?;
                    let thumbnail_path = resolve_existing_thumb(raw_tp, &file_path, &thumbs_dir);
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
                })
                .map_err(|e| e.to_string())?;
            Ok(rows.flatten().collect())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ----------------- 标签系统 (tags / image_tags) -----------------

#[tauri::command]
pub async fn tags_list(
    folder_id: i64,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_read_conn(&db_path)?;
        let mut tstmt = conn
            .prepare(
                "SELECT t.id, t.name, COUNT(DISTINCT i.id) AS count
                 FROM tags t
                 LEFT JOIN image_tags it ON it.tag_id = t.id
                 LEFT JOIN images i ON i.id = it.image_id AND i.folder_id = ?1 AND i.deleted_at IS NULL
                 GROUP BY t.id ORDER BY t.name COLLATE NOCASE",
            )
            .map_err(|e| e.to_string())?;
        let tags: Vec<serde_json::Value> = tstmt
            .query_map([folder_id], |r| {
                Ok(serde_json::json!({
                    "id": r.get::<_, i64>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "count": r.get::<_, i64>(2)?,
                }))
            })
            .map_err(|e| e.to_string())?
            .flatten()
            .collect();

        let mut istmt = conn
            .prepare(
                "SELECT it.image_id, it.tag_id FROM image_tags it
                 JOIN images i ON i.id = it.image_id
                 WHERE i.folder_id = ?1 AND i.deleted_at IS NULL",
            )
            .map_err(|e| e.to_string())?;
        let mut image_tags: std::collections::HashMap<String, Vec<i64>> = std::collections::HashMap::new();
        if let Ok(rows) = istmt.query_map([folder_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))) {
            for (img_id, tag_id) in rows.flatten() {
                image_tags.entry(img_id.to_string()).or_default().push(tag_id);
            }
        }
        Ok(serde_json::json!({
            "ok": true,
            "tags": tags,
            "imageTags": image_tags
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub async fn tag_assign(
    image_ids: Vec<i64>,
    name: Option<String>,
    tag_id: Option<i64>,
    action: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    if image_ids.is_empty() {
        return Ok(serde_json::json!({ "ok": false, "error": "没有目标图片" }));
    }
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = db.lock().map_err(|e| e.to_string())?;
        let clean_name = name.as_deref().unwrap_or("").trim().to_string();
        let tag: Option<(i64, String)> = if action != "remove" {
            if clean_name.is_empty() {
                return Ok(serde_json::json!({ "ok": false, "error": "标签名为空" }));
            }
            if let Ok(hit) = conn.query_row(
                "SELECT id, name FROM tags WHERE name = ?1 COLLATE NOCASE",
                [&clean_name],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
            ) {
                Some(hit)
            } else {
                conn.execute(
                    "INSERT INTO tags (name, created_at) VALUES (?1, ?2)",
                    rusqlite::params![clean_name, now_ms()],
                )
                .map_err(|e| e.to_string())?;
                let id = conn.last_insert_rowid();
                Some((id, clean_name))
            }
        } else if let Some(tid) = tag_id.filter(|&x| x > 0) {
            conn.query_row("SELECT id, name FROM tags WHERE id = ?1", [tid], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .ok()
        } else if !clean_name.is_empty() {
            conn.query_row(
                "SELECT id, name FROM tags WHERE name = ?1 COLLATE NOCASE",
                [&clean_name],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
            )
            .ok()
        } else {
            None
        };

        let Some((tid, tname)) = tag else {
            return Ok(serde_json::json!({ "ok": false, "error": "标签不存在" }));
        };

        let ts = now_ms();
        let mut changed = 0usize;
        if let Ok(tx) = conn.transaction() {
            for iid in image_ids {
                if action == "remove" {
                    changed += tx
                        .execute(
                            "DELETE FROM image_tags WHERE image_id = ?1 AND tag_id = ?2",
                            rusqlite::params![iid, tid],
                        )
                        .unwrap_or(0);
                } else {
                    changed += tx
                        .execute(
                            "INSERT OR IGNORE INTO image_tags (image_id, tag_id, created_at)
                             SELECT id, ?2, ?3 FROM images WHERE id = ?1 AND deleted_at IS NULL",
                            rusqlite::params![iid, tid, ts],
                        )
                        .unwrap_or(0);
                }
            }
            let _ = tx.commit();
        }

        Ok(serde_json::json!({
            "ok": true,
            "tag": { "id": tid, "name": tname },
            "changed": changed
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn tag_rename(
    tag_id: i64,
    name: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let clean = name.trim().to_string();
    if tag_id <= 0 || clean.is_empty() {
        return Ok(serde_json::json!({ "ok": false, "error": "参数无效" }));
    }
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let dup: bool = conn
            .query_row(
                "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE AND id <> ?2",
                rusqlite::params![clean, tag_id],
                |r| r.get::<_, i64>(0),
            )
            .is_ok();
        if dup {
            return Ok(serde_json::json!({ "ok": false, "error": "已有同名标签" }));
        }
        let ch = conn
            .execute("UPDATE tags SET name = ?1 WHERE id = ?2", rusqlite::params![clean, tag_id])
            .unwrap_or(0);
        if ch == 0 {
            return Ok(serde_json::json!({ "ok": false, "error": "标签不存在" }));
        }
        Ok(serde_json::json!({ "ok": true, "tag": { "id": tag_id, "name": clean } }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn tag_delete(tag_id: i64, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    if tag_id <= 0 {
        return Ok(serde_json::json!({ "ok": false, "error": "标签不存在" }));
    }
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = db.lock().map_err(|e| e.to_string())?;
        let mut removed = 0usize;
        if let Ok(tx) = conn.transaction() {
            removed = tx
                .execute("DELETE FROM image_tags WHERE tag_id = ?1", [tag_id])
                .unwrap_or(0);
            let _ = tx.execute("DELETE FROM tags WHERE id = ?1", [tag_id]);
            let _ = tx.commit();
        }
        Ok(serde_json::json!({ "ok": true, "removed": removed }))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ----------------- 根文件便携元数据 (<root>/.picnest/meta.json) -----------------

fn rel_of_image(root_path: &str, file_path: &str) -> String {
    let r = Path::new(root_path);
    let p = Path::new(file_path);
    if let Ok(rel) = p.strip_prefix(r) {
        return rel.to_string_lossy().replace('\\', "/");
    }
    let r_norm = root_path.trim_end_matches(['\\', '/']).replace('\\', "/");
    let p_norm = file_path.replace('\\', "/");
    if p_norm.to_lowercase().starts_with(&(r_norm.to_lowercase() + "/")) {
        return p_norm[r_norm.len() + 1..].to_string();
    }
    String::new()
}

fn meta_export_inner(conn: &rusqlite::Connection, root_id: i64) -> Result<serde_json::Value, String> {
    let root_path: String = conn
        .query_row("SELECT path FROM folders WHERE id = ?1", [root_id], |r| r.get(0))
        .map_err(|_| "根文件不存在".to_string())?;
    let rp = Path::new(&root_path);
    if !rp.is_dir() {
        return Err("根目录不存在".to_string());
    }

    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT t.name FROM tags t
             JOIN image_tags it ON it.tag_id = t.id
             JOIN images i ON i.id = it.image_id
             WHERE i.folder_id = ?1 AND i.deleted_at IS NULL
             ORDER BY t.name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([root_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut tag_names = Vec::new();
    for row in rows {
        tag_names.push(row.map_err(|e| e.to_string())?);
    }
    drop(stmt);

    let mut images_map: std::collections::BTreeMap<String, serde_json::Map<String, serde_json::Value>> =
        std::collections::BTreeMap::new();
    let mut stmt = conn
        .prepare(
            "SELECT file_path, COALESCE(rating, 0), COALESCE(annotation, ''), COALESCE(url, ''), COALESCE(is_favorite, 0)
             FROM images WHERE folder_id = ?1 AND deleted_at IS NULL",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([root_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (fp, rating, ann, url, fav) = row.map_err(|e| e.to_string())?;
        let rel = rel_of_image(&root_path, &fp);
        if rel.is_empty() {
            continue;
        }
        let mut rec = serde_json::Map::new();
        if rating > 0 {
            rec.insert("rating".to_string(), serde_json::json!(rating));
        }
        if !ann.is_empty() {
            rec.insert("annotation".to_string(), serde_json::json!(ann));
        }
        if !url.is_empty() {
            rec.insert("url".to_string(), serde_json::json!(url));
        }
        if fav != 0 {
            rec.insert("favorite".to_string(), serde_json::json!(1));
        }
        if !rec.is_empty() {
            images_map.insert(rel, rec);
        }
    }
    drop(stmt);

    let mut stmt = conn
        .prepare(
            "SELECT i.file_path, t.name FROM image_tags it
             JOIN tags t ON t.id = it.tag_id
             JOIN images i ON i.id = it.image_id
             WHERE i.folder_id = ?1 AND i.deleted_at IS NULL",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([root_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (fp, tname) = row.map_err(|e| e.to_string())?;
        let rel = rel_of_image(&root_path, &fp);
        if rel.is_empty() {
            continue;
        }
        let rec = images_map.entry(rel).or_default();
        let arr = rec
            .entry("tags".to_string())
            .or_insert_with(|| serde_json::Value::Array(Vec::new()));
        if let Some(vec) = arr.as_array_mut() {
            if !vec.iter().any(|x| x.as_str() == Some(&tname)) {
                vec.push(serde_json::Value::String(tname));
            }
        }
    }
    drop(stmt);

    let mut dirs_map = serde_json::Map::new();
    let mut stmt = conn
        .prepare("SELECT rel, patch FROM picnest_dir_memory WHERE root_id = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([root_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (rel, patch_str) = row.map_err(|e| e.to_string())?;
        let serde_json::Value::Object(mut obj) =
            serde_json::from_str::<serde_json::Value>(&patch_str).map_err(|e| e.to_string())?
        else {
            return Err(format!("目录元数据不是对象: {rel}"));
        };
        if let Some(cov) = obj.get("cover").and_then(|v| v.as_str()).map(|s| s.to_string()) {
            let cov_rel = rel_of_image(&root_path, &cov);
            if !cov_rel.is_empty() {
                obj.insert("cover".to_string(), serde_json::Value::String(cov_rel));
            } else {
                obj.remove("cover");
            }
        }
        obj.remove("coverThumb");
        if !obj.is_empty() {
            dirs_map.insert(rel, serde_json::Value::Object(obj));
        }
    }
    drop(stmt);

    let mut dirs_order = serde_json::Map::new();
    let prefix = format!("{}|", root_id);
    let mut stmt = conn
        .prepare("SELECT key, names FROM picnest_dir_order WHERE key LIKE ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([format!("{}%", prefix)], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (k, names_str) = row.map_err(|e| e.to_string())?;
        if let Some(rel) = k.strip_prefix(&prefix) {
            let val = serde_json::from_str::<serde_json::Value>(&names_str).map_err(|e| e.to_string())?;
            let key_out = if rel == "__root__" { "" } else { rel };
            dirs_order.insert(key_out.to_string(), val);
        }
    }
    drop(stmt);

    let mut images_order = serde_json::Map::new();
    let mut img_groups: std::collections::BTreeMap<String, Vec<String>> = std::collections::BTreeMap::new();
    let mut stmt = conn
        .prepare(
            "SELECT file_path FROM images WHERE folder_id = ?1 AND deleted_at IS NULL AND sort_order > 0 ORDER BY sort_order ASC, id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([root_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let fp = row.map_err(|e| e.to_string())?;
        let parent = Path::new(&fp).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        let drel = rel_of_image(&root_path, &parent);
        if let Some(fname) = Path::new(&fp).file_name().map(|s| s.to_string_lossy().to_string()) {
            img_groups.entry(drel).or_default().push(fname);
        }
    }
    drop(stmt);
    for (rel, names) in img_groups {
        if names.len() > 1 {
            images_order.insert(rel, serde_json::json!(names));
        }
    }

    let images_json: serde_json::Map<String, serde_json::Value> = images_map
        .into_iter()
        .map(|(k, v)| (k, serde_json::Value::Object(v)))
        .collect();
    let meta = serde_json::json!({
        "version": 1,
        "app": "PicNest",
        "updatedAt": now_ms(),
        "tags": tag_names,
        "images": images_json,
        "dirs": dirs_map,
        "orders": {
            "dirs": dirs_order,
            "images": images_order
        }
    });

    let meta_dir = rp.join(".picnest");
    std::fs::create_dir_all(&meta_dir).map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _ = std::process::Command::new("attrib")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["+h", &meta_dir.to_string_lossy()])
            .output();
    }
    let meta_file = meta_dir.join("meta.json");
    let pretty = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
    let staged = crate::fs_ops::stage_write_new(&meta_file, pretty.as_bytes())?;
    if let Err(error) = std::fs::rename(&staged.temp_path, &meta_file) {
        let rollback = crate::fs_ops::rollback_staged(&staged);
        return Err(format!(
            "提交元数据失败 {}: {error}; 回滚: {}",
            meta_file.display(),
            rollback.err().unwrap_or_default()
        ));
    }
    crate::fs_ops::verify_staged_file(&staged)?;
    Ok(serde_json::json!({
        "ok": true,
        "path": meta_file.to_string_lossy().to_string()
    }))
}

fn meta_import_inner(conn: &mut rusqlite::Connection, root_id: i64) -> serde_json::Value {
    let root_path: String = match conn.query_row("SELECT path FROM folders WHERE id = ?1", [root_id], |r| r.get(0)) {
        Ok(p) => p,
        Err(_) => return serde_json::json!({ "ok": false, "error": "根文件不存在" }),
    };
    let meta_file = Path::new(&root_path).join(".picnest").join("meta.json");
    if !meta_file.exists() {
        return serde_json::json!({ "ok": true, "created": false });
    }
    let text = match std::fs::read_to_string(&meta_file) {
        Ok(s) => s,
        Err(_) => return serde_json::json!({ "ok": true, "created": false }),
    };
    let meta: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return serde_json::json!({ "ok": true, "created": false }),
    };

    let now = now_ms();
    let mut c_tags = 0i64;
    let mut c_tag_links = 0i64;
    let mut c_images = 0i64;
    let mut c_dirs = 0i64;
    let mut c_dir_order = 0i64;
    let mut c_image_order = 0i64;

    if let Ok(tx) = conn.transaction() {
        let mut tag_cache: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        let ensure_tag = |tx: &rusqlite::Transaction, name: &str, cache: &mut std::collections::HashMap<String, i64>, added: &mut i64| -> Option<i64> {
            let clean = name.trim();
            if clean.is_empty() {
                return None;
            }
            let key = clean.to_lowercase();
            if let Some(&id) = cache.get(&key) {
                return Some(id);
            }
            if let Ok(id) = tx.query_row("SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE", [clean], |r| r.get::<_, i64>(0)) {
                cache.insert(key, id);
                return Some(id);
            }
            if tx.execute("INSERT OR IGNORE INTO tags (name, created_at) VALUES (?1, ?2)", rusqlite::params![clean, now]).is_ok() {
                if let Ok(id) = tx.query_row("SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE", [clean], |r| r.get::<_, i64>(0)) {
                    *added += 1;
                    cache.insert(key, id);
                    return Some(id);
                }
            }
            None
        };

        if let Some(arr) = meta.get("tags").and_then(|v| v.as_array()) {
            for t in arr {
                if let Some(s) = t.as_str() {
                    let _ = ensure_tag(&tx, s, &mut tag_cache, &mut c_tags);
                }
            }
        }

        let mut id_by_rel: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        if let Ok(mut stmt) = tx.prepare("SELECT id, file_path FROM images WHERE folder_id = ?1 AND deleted_at IS NULL") {
            if let Ok(rows) = stmt.query_map([root_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))) {
                for (id, fp) in rows.flatten() {
                    let rel = rel_of_image(&root_path, &fp);
                    if !rel.is_empty() {
                        id_by_rel.insert(rel.to_lowercase(), id);
                    }
                }
            }
        }

        if let Some(imgs) = meta.get("images").and_then(|v| v.as_object()) {
            for (rel, rec) in imgs {
                let Some(&img_id) = id_by_rel.get(&rel.to_lowercase()) else {
                    continue;
                };
                if let Some(rating) = rec.get("rating").and_then(|v| v.as_i64()) {
                    let _ = tx.execute("UPDATE images SET rating = ?1 WHERE id = ?2 AND COALESCE(rating, 0) = 0", rusqlite::params![rating, img_id]);
                }
                if let Some(ann) = rec.get("annotation").and_then(|v| v.as_str()) {
                    if !ann.is_empty() {
                        let _ = tx.execute("UPDATE images SET annotation = ?1 WHERE id = ?2 AND COALESCE(annotation, '') = ''", rusqlite::params![ann, img_id]);
                    }
                }
                if let Some(url) = rec.get("url").and_then(|v| v.as_str()) {
                    if !url.is_empty() {
                        let _ = tx.execute("UPDATE images SET url = ?1 WHERE id = ?2 AND COALESCE(url, '') = ''", rusqlite::params![url, img_id]);
                    }
                }
                if let Some(fav) = rec.get("favorite").and_then(|v| v.as_i64()) {
                    if fav != 0 {
                        let _ = tx.execute("UPDATE images SET is_favorite = 1 WHERE id = ?1", [img_id]);
                    }
                }
                c_images += 1;
                if let Some(tarr) = rec.get("tags").and_then(|v| v.as_array()) {
                    for t in tarr {
                        if let Some(tname) = t.as_str() {
                            if let Some(tid) = ensure_tag(&tx, tname, &mut tag_cache, &mut c_tags) {
                                c_tag_links += tx
                                    .execute(
                                        "INSERT OR IGNORE INTO image_tags (image_id, tag_id, created_at) VALUES (?1, ?2, ?3)",
                                        rusqlite::params![img_id, tid, now],
                                    )
                                    .unwrap_or(0) as i64;
                            }
                        }
                    }
                }
            }
        }

        if let Some(dirs) = meta.get("dirs").and_then(|v| v.as_object()) {
            for (rel, v) in dirs {
                let Some(obj) = v.as_object() else { continue };
                let resolved_rel = crate::db::resolve_disk_rel(&root_path, rel).unwrap_or_else(|| rel.clone());
                let existing: Option<String> = tx
                    .query_row(
                        "SELECT patch FROM picnest_dir_memory WHERE root_id = ?1 AND rel = ?2",
                        rusqlite::params![root_id, &resolved_rel],
                        |r| r.get(0),
                    )
                    .ok();
                let mut merged = existing
                    .and_then(|s| serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&s).ok())
                    .unwrap_or_default();
                for (k, val) in obj {
                    if k == "cover" {
                        if let Some(cov_rel) = val.as_str() {
                            let abs = Path::new(&root_path).join(cov_rel.replace('/', "\\"));
                            if abs.exists() {
                                merged.entry("cover".to_string()).or_insert_with(|| {
                                    serde_json::Value::String(abs.to_string_lossy().to_string())
                                });
                            }
                        }
                    } else {
                        merged.entry(k.clone()).or_insert_with(|| val.clone());
                    }
                }
                if let Ok(js) = serde_json::to_string(&merged) {
                    let _ = tx.execute(
                        "INSERT INTO picnest_dir_memory (root_id, rel, patch) VALUES (?1, ?2, ?3)
                         ON CONFLICT(root_id, rel) DO UPDATE SET patch = excluded.patch",
                        rusqlite::params![root_id, &resolved_rel, js],
                    );
                    c_dirs += 1;
                }
            }
        }

        if let Some(orders) = meta.get("orders").and_then(|v| v.as_object()) {
            if let Some(d_ord) = orders.get("dirs").and_then(|v| v.as_object()) {
                for (rel, names) in d_ord {
                    if let Ok(ns) = serde_json::to_string(names) {
                        let key = if rel.is_empty() {
                            format!("{}|__root__", root_id)
                        } else {
                            format!("{}|{}", root_id, rel)
                        };
                        let _ = tx.execute(
                            "INSERT OR IGNORE INTO picnest_dir_order (key, names) VALUES (?1, ?2)",
                            rusqlite::params![key, ns],
                        );
                        c_dir_order += 1;
                    }
                }
            }
            if let Some(i_ord) = orders.get("images").and_then(|v| v.as_object()) {
                for (rel, names) in i_ord {
                    let Some(arr) = names.as_array() else { continue };
                    for (idx, nm) in arr.iter().enumerate() {
                        let Some(name_str) = nm.as_str() else { continue };
                        let full_rel = if rel.is_empty() {
                            name_str.to_string()
                        } else {
                            format!("{}/{}", rel, name_str)
                        };
                        if let Some(&img_id) = id_by_rel.get(&full_rel.to_lowercase()) {
                            let _ = tx.execute(
                                "UPDATE images SET sort_order = ?1 WHERE id = ?2 AND COALESCE(sort_order, 0) = 0",
                                rusqlite::params![(idx + 1) as i64, img_id],
                            );
                            c_image_order += 1;
                        }
                    }
                }
            }
        }

        let _ = tx.execute(
            "INSERT OR REPLACE INTO picnest_kv (key, value) VALUES (?1, '1')",
            [format!("meta_imported:{}", root_id)],
        );
        let _ = tx.commit();
    }

    serde_json::json!({
        "ok": true,
        "created": true,
        "imported": true,
        "counts": {
            "tags": c_tags,
            "tagLinks": c_tag_links,
            "images": c_images,
            "dirs": c_dirs,
            "dirOrder": c_dir_order,
            "imageOrder": c_image_order
        }
    })
}

#[tauri::command]
pub async fn root_meta_save(root_id: i64, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let _timer = CmdTimer::new("root_meta_save");
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        meta_export_inner(&conn, root_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn root_meta_load(root_id: i64, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = db.lock().map_err(|e| e.to_string())?;
        let res = meta_import_inner(&mut conn, root_id);
        if res.get("created").and_then(|v| v.as_bool()) == Some(false) {
            return meta_export_inner(&conn, root_id);
        }
        Ok(res)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn root_meta_ensure(root_id: i64, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = db.lock().map_err(|e| e.to_string())?;
        let root_path: String = match conn.query_row("SELECT path FROM folders WHERE id = ?1", [root_id], |r| r.get(0)) {
            Ok(p) => p,
            Err(_) => return Ok(serde_json::json!({ "ok": false })),
        };
        let meta_file = Path::new(&root_path).join(".picnest").join("meta.json");
        if meta_file.exists() {
            let already: bool = conn
                .query_row(
                    "SELECT value FROM picnest_kv WHERE key = ?1",
                    [format!("meta_imported_v2:{}", root_id)],
                    |r| r.get::<_, String>(0),
                )
                .is_ok();
            if !already {
                let res = meta_import_inner(&mut conn, root_id);
                let _ = conn.execute(
                    "INSERT OR REPLACE INTO picnest_kv (key, value) VALUES (?1, '1')",
                    [format!("meta_imported_v2:{}", root_id)],
                );
                return Ok(res);
            }
            return Ok(serde_json::json!({ "ok": true, "existed": true, "imported": false }));
        }
        meta_export_inner(&conn, root_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn diag_event(msg: String) {
    let _t = CmdTimer::new("diag_event");
    crate::media_server::diag_push(&format!("[JS] {}", msg));
}

#[tauri::command]
pub fn diag_dump() -> Vec<String> {
    crate::media_server::diag_snapshot()
}

#[cfg(windows)]
fn decode_cp_win32(bytes: &[u8], codepage: u32, strict: bool) -> Option<String> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MultiByteToWideChar(
            code_page: u32,
            dw_flags: u32,
            lp_multi_byte_str: *const u8,
            cb_multi_byte: i32,
            lp_wide_char_str: *mut u16,
            cch_wide_char: i32,
        ) -> i32;
    }
    if bytes.is_empty() {
        return Some(String::new());
    }
    let flags: u32 = if strict { 0x00000008 } else { 0 }; // MB_ERR_INVALID_CHARS
    let cb = i32::try_from(bytes.len()).ok()?;
    let needed = unsafe { MultiByteToWideChar(codepage, flags, bytes.as_ptr(), cb, std::ptr::null_mut(), 0) };
    if needed <= 0 {
        return None;
    }
    let mut wide = vec![0u16; needed as usize];
    let written = unsafe { MultiByteToWideChar(codepage, flags, bytes.as_ptr(), cb, wide.as_mut_ptr(), needed) };
    if written <= 0 {
        return None;
    }
    wide.truncate(written as usize);
    Some(String::from_utf16_lossy(&wide))
}

fn decode_text_bytes(raw: &[u8]) -> (String, &'static str) {
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return (String::from_utf8_lossy(&raw[3..]).into_owned(), "utf-8-bom");
    }
    if raw.starts_with(&[0xFF, 0xFE]) {
        let mut units = Vec::with_capacity((raw.len() - 2) / 2);
        for ch in raw[2..].chunks_exact(2) {
            units.push(u16::from_le_bytes([ch[0], ch[1]]));
        }
        return (String::from_utf16_lossy(&units), "utf-16le");
    }
    if raw.starts_with(&[0xFE, 0xFF]) {
        let mut units = Vec::with_capacity((raw.len() - 2) / 2);
        for ch in raw[2..].chunks_exact(2) {
            units.push(u16::from_be_bytes([ch[0], ch[1]]));
        }
        return (String::from_utf16_lossy(&units), "utf-16be");
    }
    if let Ok(s) = std::str::from_utf8(raw) {
        return (s.to_string(), "utf-8");
    }
    #[cfg(windows)]
    {
        if let Some(s) = decode_cp_win32(raw, 54936, true) {
            return (s, "gb18030");
        }
        if let Some(s) = decode_cp_win32(raw, 54936, false) {
            return (s, "gb18030");
        }
    }
    (String::from_utf8_lossy(raw).into_owned(), "utf-8")
}

fn read_text_inner(file_path: &str) -> serde_json::Value {
    const MAX_PREVIEW_BYTES: usize = 512 * 1024;
    let p = Path::new(file_path);
    let meta = match std::fs::metadata(p) {
        Ok(m) => m,
        Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }),
    };
    let size = meta.len();
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);

    let mut f = match std::fs::File::open(p) {
        Ok(f) => f,
        Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }),
    };
    use std::io::Read;
    let truncated = size as usize > MAX_PREVIEW_BYTES;
    let to_read = (size as usize).min(MAX_PREVIEW_BYTES);
    let mut buf = vec![0u8; to_read];
    let n = f.read(&mut buf).unwrap_or(0);
    buf.truncate(n);

    let (mut content, encoding) = decode_text_bytes(&buf);
    let eol = if content.contains("\r\n") { "crlf" } else { "lf" };
    if eol == "crlf" {
        content = content.replace("\r\n", "\n");
    }
    serde_json::json!({
        "ok": true,
        "content": content,
        "encoding": encoding,
        "eol": eol,
        "size": size,
        "mtimeMs": mtime_ms,
        "truncated": truncated
    })
}

fn save_text_inner(
    file_path: &str,
    content: &str,
    expected_mtime_ms: Option<f64>,
    conn: Option<&rusqlite::Connection>,
) -> serde_json::Value {
    let p = Path::new(file_path);
    let mut encoding = "utf-8";
    let mut use_crlf = content.contains("\r\n");

    if let Ok(meta) = std::fs::metadata(p) {
        let cur_mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        if let Some(exp) = expected_mtime_ms {
            if exp > 0.0 && (cur_mtime_ms - exp).abs() > 1500.0 {
                return serde_json::json!({
                    "ok": false,
                    "conflict": true,
                    "error": "文件已被外部程序修改"
                });
            }
        }
        if let Ok(existing) = std::fs::read(p) {
            if existing.starts_with(&[0xEF, 0xBB, 0xBF]) {
                encoding = "utf-8-bom";
            } else if existing.starts_with(&[0xFF, 0xFE]) {
                encoding = "utf-16le";
            }
            if existing.windows(2).any(|w| w == b"\r\n") {
                use_crlf = true;
            }
        }
    }

    let normalized = content.replace("\r\n", "\n");
    let final_str = if use_crlf {
        normalized.replace('\n', "\r\n")
    } else {
        normalized
    };

    let bytes: Vec<u8> = match encoding {
        "utf-8-bom" => {
            let mut b = vec![0xEF, 0xBB, 0xBF];
            b.extend_from_slice(final_str.as_bytes());
            b
        }
        "utf-16le" => {
            let mut b = vec![0xFF, 0xFE];
            for u in final_str.encode_utf16() {
                b.extend_from_slice(&u.to_le_bytes());
            }
            b
        }
        _ => final_str.into_bytes(),
    };

    if let Err(e) = std::fs::write(p, &bytes) {
        return serde_json::json!({ "ok": false, "error": e.to_string() });
    }

    let (new_size, new_mtime_ms, new_mtime_s) = match std::fs::metadata(p) {
        Ok(m) => {
            let secs = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64())
                .unwrap_or(0.0);
            (m.len(), secs * 1000.0, secs.round() as i64)
        }
        Err(_) => (bytes.len() as u64, 0.0, 0),
    };

    if let Some(c) = conn {
        let _ = c.execute(
            "UPDATE images SET size = ?1, mtime = ?2 WHERE file_path = ?3 COLLATE NOCASE",
            rusqlite::params![new_size as i64, new_mtime_s, file_path],
        );
    }

    serde_json::json!({
        "ok": true,
        "size": new_size,
        "mtimeMs": new_mtime_ms,
        "encoding": encoding
    })
}

#[tauri::command]
pub async fn read_text(file_path: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || read_text_inner(&file_path))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_text(
    file_path: String,
    content: String,
    expected_mtime_ms: Option<f64>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().ok();
        save_text_inner(&file_path, &content, expected_mtime_ms, conn.as_deref())
    })
    .await
    .map_err(|e| e.to_string())
}

/// Sync text file metadata in SQLite while preserving PicNest-Rust's clean `.docph` grid cards (`thumbnail_path = ""`).
#[tauri::command]
pub async fn generate_text_thumbnails(
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().ok();
        let mut results = Vec::with_capacity(paths.len());
        let mut errors = Vec::new();
        for fp in paths {
            let p = Path::new(&fp);
            match std::fs::metadata(p) {
                Ok(m) => {
                    let size = m.len() as i64;
                    let mtime_s = m
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);
                    if let Some(c) = conn.as_deref() {
                        let _ = c.execute(
                            "UPDATE images SET size = ?1, mtime = ?2, thumbnail_path = NULL WHERE file_path = ?3 COLLATE NOCASE",
                            rusqlite::params![size, mtime_s, fp],
                        );
                    }
                    results.push(serde_json::json!({
                        "file_path": fp,
                        "thumbnail_path": "",
                        "is_text": true
                    }));
                }
                Err(_) => {
                    errors.push(fp.clone());
                    results.push(serde_json::json!({
                        "file_path": fp,
                        "thumbnail_path": ""
                    }));
                }
            }
        }
        Ok(serde_json::json!({
            "ok": true,
            "results": results,
            "errors": errors
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn collect_get_token() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "ok": true,
        "token": crate::collector::get_token()?
    }))
}

#[tauri::command]
pub fn collect_reset_token() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "ok": true,
        "token": crate::collector::reset_token()?
    }))
}

#[tauri::command]
pub fn collect_set_root(root_id: Option<i64>) -> Result<serde_json::Value, String> {
    crate::collector::set_active_collect_root(root_id);
    Ok(serde_json::json!({
        "ok": true,
        "rootId": root_id
    }))
}


#[tauri::command]
pub async fn visual_search_query(
    opts: crate::visual_search::VisualSearchOpts,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::visual_search::execute_visual_search(&opts, &data_dir)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn visual_search_save(
    item: serde_json::Value,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::visual_search::save_visual_search_item(&item, &db_path, Some(&app))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn find_duplicates(
    folder_id: Option<i64>,
    #[allow(non_snake_case)]
    folderId: Option<i64>,
    rel: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let fid = folder_id.or(folderId).ok_or("缺少 folder_id 参数")?;
    let db_path = state.db_path.clone();
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::dup_finder::execute_find_duplicates(&db_path, &data_dir, fid, rel.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dup_cancel() -> Result<serde_json::Value, String> {
    crate::dup_finder::DUP_CANCEL_FLAG.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub async fn ai_config_get(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(crate::dup_finder::get_ai_config(&data_dir))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ai_config_set(
    opts: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::dup_finder::set_ai_config(&data_dir, &opts)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ai_models(
    opts: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::dup_finder::fetch_ai_models(&data_dir, &opts)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ai_test(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::dup_finder::execute_ai_test(&data_dir)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ai_dup_scan(
    root_id: Option<i64>,
    #[allow(non_snake_case)]
    rootId: Option<i64>,
    rel: Option<String>,
    max_pairs: Option<usize>,
    #[allow(non_snake_case)]
    maxPairs: Option<usize>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let rid = root_id.or(rootId).ok_or("缺少 root_id 参数")?;
    let mp = max_pairs.or(maxPairs);
    let db_path = state.db_path.clone();
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // 前端靠这个事件更新进度条（旧版是 picnest-ai-dup-progress）
        let emit = move |phase: &str, done: usize, total: usize, candidates: usize| {
            use tauri::Emitter;
            let _ = app.emit(
                "picnest-ai-dup-progress",
                serde_json::json!({
                    "phase": phase,
                    "done": done,
                    "total": total,
                    "candidates": candidates
                }),
            );
        };
        crate::dup_finder::execute_ai_dup_scan(&db_path, &data_dir, rid, rel.as_deref(), mp, Some(&emit))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ai_dup_continue(
    root_id: Option<i64>,
    #[allow(non_snake_case)]
    rootId: Option<i64>,
    rel: Option<String>,
    max_pairs: Option<usize>,
    #[allow(non_snake_case)]
    maxPairs: Option<usize>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let rid = root_id.or(rootId).ok_or("缺少 root_id 参数")?;
    let mp = max_pairs.or(maxPairs);
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let emit = move |phase: &str, done: usize, total: usize, candidates: usize| {
            use tauri::Emitter;
            let _ = app.emit(
                "picnest-ai-dup-progress",
                serde_json::json!({
                    "phase": phase,
                    "done": done,
                    "total": total,
                    "candidates": candidates
                }),
            );
        };
        crate::dup_finder::execute_ai_dup_continue(&data_dir, rid, rel.as_deref(), mp, Some(&emit))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ai_dup_cancel() -> Result<serde_json::Value, String> {
    crate::dup_finder::AI_DUP_CANCEL_FLAG.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(serde_json::json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meta_export_query_failure_is_not_masked_by_an_existing_file() {
        let tmp = crate::testutil::TempDir::new("picnest_meta_export_fault");
        let root = tmp.join("lib");
        let meta_dir = root.join(".picnest");
        std::fs::create_dir_all(&meta_dir).unwrap();
        let meta_file = meta_dir.join("meta.json");
        std::fs::write(&meta_file, b"previous metadata").unwrap();
        let conn = crate::db::init_db(&tmp.join("test.db")).unwrap();
        conn.execute("INSERT INTO folders (path) VALUES (?1)", [root.to_string_lossy().to_string()]).unwrap();
        conn.execute_batch("ALTER TABLE images RENAME TO images_hidden").unwrap();
        let error = meta_export_inner(&conn, conn.last_insert_rowid()).unwrap_err();
        assert!(error.contains("images"), "{error}");
        assert_eq!(std::fs::read(&meta_file).unwrap(), b"previous metadata");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM folders", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn meta_export_replaces_previous_metadata_without_leaving_staging_files() {
        let tmp = crate::testutil::TempDir::new("picnest_meta_export_success");
        let root = tmp.join("lib");
        let meta_dir = root.join(".picnest");
        std::fs::create_dir_all(&meta_dir).unwrap();
        let meta_file = meta_dir.join("meta.json");
        std::fs::write(&meta_file, b"previous metadata").unwrap();
        let conn = crate::db::init_db(&tmp.join("test.db")).unwrap();
        conn.execute("INSERT INTO folders (path) VALUES (?1)", [root.to_string_lossy().to_string()]).unwrap();
        let result = meta_export_inner(&conn, conn.last_insert_rowid()).unwrap();
        assert!(result["ok"].as_bool() == Some(true));
        let updated = std::fs::read_to_string(&meta_file).unwrap();
        assert!(updated.contains("\"app\": \"PicNest\""));
        assert!(!std::fs::read_dir(&meta_dir).unwrap().any(|entry| {
            entry.unwrap().file_name().to_string_lossy().starts_with(".picnest-part-")
        }));
    }

    #[test]
    fn query_window_clamps_invalid_limits_without_truncating_large_folders() {
        assert_eq!(normalize_query_window(-10, -1), (0, 1));
        assert_eq!(normalize_query_window(20, 0), (20, 1));
        assert_eq!(normalize_query_window(0, 500_001), (0, 500_000));
        assert_eq!(normalize_query_window(0, 250_000), (0, 250_000));
    }

    #[test]
    fn snapshot_diff_never_resurrects_soft_deleted_images() {
        let tmp = crate::testutil::TempDir::new("picnest_snapshot_trash");
        let root = tmp.join("library");
        std::fs::create_dir_all(&root).unwrap();
        let image = root.join("trashed.png");
        std::fs::write(&image, b"replacement").unwrap();
        let conn = crate::db::init_db(&tmp.join("test.db")).unwrap();
        conn.execute("INSERT INTO folders (path) VALUES (?1)", [root.to_string_lossy().to_string()]).unwrap();
        let folder_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO images (folder_id, file_path, size, mtime, deleted_at, trash_group) VALUES (?1, ?2, 3, 1, 99, 7)",
            rusqlite::params![folder_id, image.to_string_lossy().to_string()],
        ).unwrap();
        let db = std::sync::Arc::new(std::sync::Mutex::new(conn));
        apply_file_snapshot_diff(
            &db,
            folder_id,
            &[(image.to_string_lossy().to_string(), 11, 2)],
            &[],
        ).unwrap();
        let conn = db.lock().unwrap();
        let row: (i64, i64, Option<i64>, Option<i64>) = conn.query_row(
            "SELECT size, mtime, deleted_at, trash_group FROM images", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        ).unwrap();
        assert_eq!(row, (3, 1, Some(99), Some(7)));
    }

    #[test]
    fn snapshot_diff_rolls_back_inserts_when_gone_update_fails() {
        let tmp = crate::testutil::TempDir::new("picnest_snapshot_atomic");
        let root = tmp.join("library");
        std::fs::create_dir_all(&root).unwrap();
        let gone = root.join("gone.png");
        let added = root.join("added.png");
        let conn = crate::db::init_db(&tmp.join("test.db")).unwrap();
        conn.execute("INSERT INTO folders (path) VALUES (?1)", [root.to_string_lossy().to_string()]).unwrap();
        let folder_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO images (folder_id, file_path, size, mtime) VALUES (?1, ?2, 1, 1)",
            rusqlite::params![folder_id, gone.to_string_lossy().to_string()],
        ).unwrap();
        conn.execute_batch("CREATE TRIGGER reject_snapshot BEFORE UPDATE OF deleted_at ON images BEGIN SELECT RAISE(ABORT, 'injected snapshot failure'); END;").unwrap();
        let db = std::sync::Arc::new(std::sync::Mutex::new(conn));
        let error = apply_file_snapshot_diff(
            &db,
            folder_id,
            &[(added.to_string_lossy().to_string(), 2, 2)],
            &[gone.to_string_lossy().to_lowercase()],
        ).unwrap_err();
        assert!(error.contains("injected snapshot failure"), "{error}");
        let conn = db.lock().unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM images", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        let deleted: Option<i64> = conn.query_row("SELECT deleted_at FROM images", [], |r| r.get(0)).unwrap();
        assert_eq!(deleted, None);
    }

    #[test]
    fn rename_image_sql_failure_reverses_file_cache_and_path() {
        let tmp = crate::testutil::TempDir::new("picnest_rename_fault");
        let root = tmp.join("lib");
        let thumbs = tmp.join("thumbs");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&thumbs).unwrap();
        let source = root.join("old.png");
        let target = root.join("new.png");
        std::fs::write(&source, b"original").unwrap();
        let conn = crate::db::init_db(&tmp.join("test.db")).unwrap();
        conn.execute("INSERT INTO folders (path) VALUES (?1)", [root.to_string_lossy().to_string()]).unwrap();
        let old_thumb = thumbs.join(format!("{:x}-q80.jpg", fnv1a_hash(source.to_string_lossy().as_bytes())));
        let new_thumb = thumbs.join(format!("{:x}-q80.jpg", fnv1a_hash(target.to_string_lossy().as_bytes())));
        std::fs::write(&old_thumb, b"thumb").unwrap();
        conn.execute(
            "INSERT INTO images (folder_id, file_path, thumbnail_path, size, mtime) VALUES (?1, ?2, ?3, 8, 1)",
            rusqlite::params![conn.last_insert_rowid(), source.to_string_lossy().to_string(), old_thumb.to_string_lossy().to_string()],
        ).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_rename BEFORE UPDATE OF file_path ON images BEGIN SELECT RAISE(ABORT, 'injected rename failure'); END;").unwrap();
        let db = std::sync::Arc::new(std::sync::Mutex::new(conn));
        let error = rename_image_compensated(&db, &thumbs, &source, &target, false).unwrap_err();
        assert!(error.contains("injected rename failure"), "{error}");
        assert_eq!(std::fs::read(&source).unwrap(), b"original");
        assert!(!target.exists());
        assert!(old_thumb.exists());
        assert!(!new_thumb.exists());
        let db = db.lock().unwrap();
        let path: String = db.query_row("SELECT file_path FROM images", [], |r| r.get(0)).unwrap();
        assert_eq!(path, source.to_string_lossy());
        assert_eq!(db.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn batch_rename_sql_failure_restores_files_cache_and_database() {
        let tmp = crate::testutil::TempDir::new("picnest_batch_fault");
        let root = tmp.join("lib");
        let thumbs = tmp.join("thumbs");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&thumbs).unwrap();
        let source = root.join("image.png");
        let target = root.join("01_image.png");
        std::fs::write(&source, b"original").unwrap();
        let conn = crate::db::init_db(&tmp.join("test.db")).unwrap();
        conn.execute("INSERT INTO folders (path) VALUES (?1)", [root.to_string_lossy().to_string()]).unwrap();
        let folder_id = conn.last_insert_rowid();
        let old_thumb = thumbs.join(format!("{:x}-q80.jpg", fnv1a_hash(source.to_string_lossy().as_bytes())));
        let new_thumb = thumbs.join(format!("{:x}-q80.jpg", fnv1a_hash(target.to_string_lossy().as_bytes())));
        std::fs::write(&old_thumb, b"thumb").unwrap();
        conn.execute(
            "INSERT INTO images (folder_id, file_path, thumbnail_path, size, mtime) VALUES (?1, ?2, ?3, 8, 1)",
            rusqlite::params![folder_id, source.to_string_lossy().to_string(), old_thumb.to_string_lossy().to_string()],
        ).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_batch BEFORE UPDATE OF file_path ON images BEGIN SELECT RAISE(ABORT, 'injected batch failure'); END;").unwrap();
        let db = std::sync::Arc::new(std::sync::Mutex::new(conn));
        let error = run_batch_rename(&db, &thumbs, &root.to_string_lossy(), vec![(source.clone(), target.clone())]).unwrap_err();
        assert!(error.contains("injected batch failure"), "{error}");
        assert_eq!(std::fs::read(&source).unwrap(), b"original");
        assert!(!target.exists());
        assert!(old_thumb.exists());
        assert!(!new_thumb.exists());
        let db = db.lock().unwrap();
        let path: String = db.query_row("SELECT file_path FROM images", [], |r| r.get(0)).unwrap();
        assert_eq!(path, source.to_string_lossy());
        assert_eq!(db.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn move_dir_sql_failure_reverses_directory_cache_and_database() {
        let tmp = crate::testutil::TempDir::new("picnest_move_dir_fault");
        let root = tmp.join("lib");
        let source = root.join("alpha");
        let destination = tmp.join("destination");
        let target = destination.join("alpha");
        let thumbs = tmp.join("thumbs");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::create_dir_all(&thumbs).unwrap();
        let image = source.join("one.png");
        std::fs::write(&image, b"original").unwrap();
        let conn = crate::db::init_db(&tmp.join("test.db")).unwrap();
        conn.execute("INSERT INTO folders (path) VALUES (?1)", [root.to_string_lossy().to_string()]).unwrap();
        let folder_id = conn.last_insert_rowid();
        let old_thumb = thumbs.join(format!("{:x}-q80.jpg", fnv1a_hash(image.to_string_lossy().as_bytes())));
        let new_thumb = thumbs.join(format!("{:x}-q80.jpg", fnv1a_hash(target.join("one.png").to_string_lossy().as_bytes())));
        std::fs::write(&old_thumb, b"thumb").unwrap();
        conn.execute(
            "INSERT INTO images (folder_id, file_path, thumbnail_path, size, mtime) VALUES (?1, ?2, ?3, 8, 1)",
            rusqlite::params![folder_id, image.to_string_lossy().to_string(), old_thumb.to_string_lossy().to_string()],
        ).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_move_dir BEFORE UPDATE OF file_path ON images BEGIN SELECT RAISE(ABORT, 'injected move dir failure'); END;").unwrap();
        let db = std::sync::Arc::new(std::sync::Mutex::new(conn));
        let result = move_dir_sync(&db, &thumbs, &source.to_string_lossy(), &destination.to_string_lossy()).unwrap();
        assert_eq!(result["ok"], false, "{result}");
        assert!(result["error"].as_str().unwrap().contains("injected move dir failure"));
        assert_eq!(std::fs::read(&image).unwrap(), b"original");
        assert!(!target.exists());
        assert!(old_thumb.exists());
        assert!(!new_thumb.exists());
        let conn = db.lock().unwrap();
        let path: String = conn.query_row("SELECT file_path FROM images", [], |r| r.get(0)).unwrap();
        assert_eq!(path, image.to_string_lossy());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn rename_dir_sql_failure_reverses_directory_cache_and_database() {
        let tmp = crate::testutil::TempDir::new("picnest_rename_dir_fault");
        let root = tmp.join("lib");
        let source = root.join("alpha");
        let target = root.join("beta");
        let thumbs = tmp.join("thumbs");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&thumbs).unwrap();
        let image = source.join("one.png");
        std::fs::write(&image, b"original").unwrap();
        let conn = crate::db::init_db(&tmp.join("test.db")).unwrap();
        conn.execute("INSERT INTO folders (path) VALUES (?1)", [root.to_string_lossy().to_string()]).unwrap();
        let folder_id = conn.last_insert_rowid();
        let old_thumb = thumbs.join(format!("{:x}-q80.jpg", fnv1a_hash(image.to_string_lossy().as_bytes())));
        let new_thumb = thumbs.join(format!("{:x}-q80.jpg", fnv1a_hash(target.join("one.png").to_string_lossy().as_bytes())));
        std::fs::write(&old_thumb, b"thumb").unwrap();
        conn.execute(
            "INSERT INTO images (folder_id, file_path, thumbnail_path, size, mtime) VALUES (?1, ?2, ?3, 8, 1)",
            rusqlite::params![folder_id, image.to_string_lossy().to_string(), old_thumb.to_string_lossy().to_string()],
        ).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_rename_dir BEFORE UPDATE OF file_path ON images BEGIN SELECT RAISE(ABORT, 'injected rename dir failure'); END;").unwrap();
        let db = std::sync::Arc::new(std::sync::Mutex::new(conn));
        let result = rename_dir_sync(&db, &thumbs, &source.to_string_lossy(), "beta", None, None).unwrap();
        assert_eq!(result["ok"], false, "{result}");
        assert!(result["error"].as_str().unwrap().contains("injected rename dir failure"));
        assert_eq!(std::fs::read(&image).unwrap(), b"original");
        assert!(!target.exists());
        assert!(old_thumb.exists());
        assert!(!new_thumb.exists());
        let conn = db.lock().unwrap();
        let path: String = conn.query_row("SELECT file_path FROM images", [], |r| r.get(0)).unwrap();
        assert_eq!(path, image.to_string_lossy());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn rename_library_sql_failure_reverses_root_file_cache_and_database() {
        let tmp = crate::testutil::TempDir::new("picnest_library_rename_fault");
        let root = tmp.join("old-library");
        let target = tmp.join("new-library");
        let thumbs = tmp.join("thumbs");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&thumbs).unwrap();
        let source = root.join("image.png");
        std::fs::write(&source, b"original").unwrap();
        let conn = crate::db::init_db(&tmp.join("test.db")).unwrap();
        conn.execute("INSERT INTO folders (path) VALUES (?1)", [root.to_string_lossy().to_string()]).unwrap();
        let folder_id = conn.last_insert_rowid();
        let old_thumb = thumbs.join(format!("{:x}-q80.jpg", fnv1a_hash(source.to_string_lossy().as_bytes())));
        let new_thumb = thumbs.join(format!("{:x}-q80.jpg", fnv1a_hash(target.join("image.png").to_string_lossy().as_bytes())));
        std::fs::write(&old_thumb, b"thumb").unwrap();
        conn.execute(
            "INSERT INTO images (folder_id, file_path, thumbnail_path, size, mtime) VALUES (?1, ?2, ?3, 8, 1)",
            rusqlite::params![folder_id, source.to_string_lossy().to_string(), old_thumb.to_string_lossy().to_string()],
        ).unwrap();
        conn.execute(
            "UPDATE picnest_dir_memory SET patch = ?1 WHERE root_id = ?2 AND rel = ''",
            rusqlite::params![serde_json::json!({"coverPath": source.to_string_lossy()}).to_string(), folder_id],
        ).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_library BEFORE UPDATE OF file_path ON images BEGIN SELECT RAISE(ABORT, 'injected library failure'); END;").unwrap();
        let db = std::sync::Arc::new(std::sync::Mutex::new(conn));
        let result = rename_library_sync(&db, &thumbs, folder_id, "new-library", true).unwrap();
        assert_eq!(result["ok"], false, "{result}");
        assert!(result["error"].as_str().unwrap().contains("injected library failure"));
        assert_eq!(std::fs::read(&source).unwrap(), b"original");
        assert!(!target.exists());
        assert!(old_thumb.exists());
        assert!(!new_thumb.exists());
        let conn = db.lock().unwrap();
        let path: String = conn.query_row("SELECT path FROM folders WHERE id = ?1", [folder_id], |r| r.get(0)).unwrap();
        assert_eq!(path, root.to_string_lossy());
        let image_path: String = conn.query_row("SELECT file_path FROM images", [], |r| r.get(0)).unwrap();
        assert_eq!(image_path, source.to_string_lossy());
        let cover: String = conn.query_row("SELECT patch FROM picnest_dir_memory WHERE root_id = ?1", [folder_id], |r| r.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&cover).unwrap()["coverPath"].as_str(), Some(source.to_string_lossy().as_ref()));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn rename_library_restart_recovery_reverses_verified_directory_move() {
        let tmp = crate::testutil::TempDir::new("picnest_library_restart");
        let root = tmp.join("old-library");
        let target = tmp.join("new-library");
        let thumbs = tmp.join("thumbs");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&thumbs).unwrap();
        std::fs::write(root.join("image.png"), b"original").unwrap();
        let db_path = tmp.join("test.db");
        {
            let conn = crate::db::init_db(&db_path).unwrap();
            conn.execute("INSERT INTO folders (path) VALUES (?1)", [root.to_string_lossy().to_string()]).unwrap();
            let identity = crate::operation_journal::capture_path_identity(&root).unwrap();
            let op = crate::operation_journal::begin_path_move(&conn, &root, &target, identity).unwrap();
            std::fs::rename(&root, &target).unwrap();
            crate::operation_journal::mark_path_applied(&conn, &op).unwrap();
            assert!(target.exists());
        }
        let conn = crate::db::init_db(&db_path).unwrap();
        assert_eq!(std::fs::read(root.join("image.png")).unwrap(), b"original");
        assert!(!target.exists());
        let path: String = conn.query_row("SELECT path FROM folders", [], |r| r.get(0)).unwrap();
        assert_eq!(path, root.to_string_lossy());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn rename_image_commit_is_atomic_and_immediately_indexes() {
        let tmp = crate::testutil::TempDir::new("picnest_rename_ok");
        let root = tmp.join("lib");
        let thumbs = tmp.join("thumbs");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&thumbs).unwrap();
        let source = root.join("old.png");
        let target = root.join("01_new.png");
        std::fs::write(&source, b"original").unwrap();
        let conn = crate::db::init_db(&tmp.join("test.db")).unwrap();
        conn.execute("INSERT INTO folders (path) VALUES (?1)", [root.to_string_lossy().to_string()]).unwrap();
        conn.execute(
            "INSERT INTO images (folder_id, file_path, size, mtime) VALUES (?1, ?2, 8, 1)",
            rusqlite::params![conn.last_insert_rowid(), source.to_string_lossy().to_string()],
        ).unwrap();
        let db = std::sync::Arc::new(std::sync::Mutex::new(conn));
        rename_image_compensated(&db, &thumbs, &source, &target, false).unwrap();
        assert!(!source.exists());
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
        let db = db.lock().unwrap();
        let path: String = db.query_row("SELECT file_path FROM images", [], |r| r.get(0)).unwrap();
        assert_eq!(path, target.to_string_lossy());
        assert_eq!(db.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    /// 透明图必须走无损 WebP（否则 JPEG 会暴露 alpha=0 里藏的 RGB，变成彩色毛刺）
    #[test]
    fn save_thumb_smart_keeps_transparency() {
        let dir = crate::testutil::TempDir::new("picnest_webp_test");
        let rgba = image::RgbaImage::from_pixel(16, 16, image::Rgba([12, 34, 56, 0]));
        let img = image::DynamicImage::ImageRgba8(rgba);
        let out = save_thumb_smart(&img, dir.path(), "abc").expect("应该写出缩略图");
        assert!(
            out.to_string_lossy().ends_with("-lossless.webp"),
            "透明图没走 webp: {}",
            out.display()
        );
        assert!(std::fs::metadata(&out).map(|m| m.len() > 0).unwrap_or(false));
    }

    /// 不含透明的不该多花体积走无损
    #[test]
    fn save_thumb_smart_uses_jpeg_when_opaque() {
        let dir = crate::testutil::TempDir::new("picnest_webp_test2");
        let rgb = image::RgbImage::from_pixel(16, 16, image::Rgb([200, 100, 50]));
        let img = image::DynamicImage::ImageRgb8(rgb);
        let out = save_thumb_smart(&img, dir.path(), "opq").expect("应该写出缩略图");
        assert!(out.to_string_lossy().ends_with("-q80.jpg"), "{}", out.display());
    }

    /// 硬件友好度的底线：卡住的子进程必须被准点杀掉，不能留在后台吃 CPU
    #[test]
    fn output_with_timeout_kills_hanging_child() {
        let mut cmd = std::process::Command::new("powershell");
        cmd.args(["-Command", "Start-Sleep -Seconds 10"]);
        let t0 = std::time::Instant::now();
        let out = output_with_timeout(&mut cmd, std::time::Duration::from_millis(400));
        assert!(out.is_none(), "应超时返回 None");
        assert!(
            t0.elapsed().as_secs() < 5,
            "必须及时中止，实际耗时 {:?}",
            t0.elapsed()
        );
    }

    #[test]
    fn output_with_timeout_returns_fast_child_output() {
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/c", "echo", "picnest"]);
        let out = output_with_timeout(&mut cmd, std::time::Duration::from_secs(15)).expect("应正常返回");
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("picnest"));
    }

    #[test]
    fn text_read_and_save_handles_utf8_bom_and_gb18030() {
        let tmp = std::env::temp_dir().join(format!("picnest_txt_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let p_utf8 = tmp.join("note.txt");
        std::fs::write(&p_utf8, "\u{FEFF}第一行\r\n第二行").unwrap();
        let r = read_text_inner(&p_utf8.to_string_lossy());
        assert_eq!(r["ok"], true);
        assert_eq!(r["encoding"], "utf-8-bom");
        assert_eq!(r["eol"], "crlf");
        assert_eq!(r["content"], "第一行\n第二行");

        let mtime = r["mtimeMs"].as_f64();
        let sr = save_text_inner(&p_utf8.to_string_lossy(), "已更新\n文本", mtime, None);
        assert_eq!(sr["ok"], true);
        let raw_after = std::fs::read(&p_utf8).unwrap();
        assert!(raw_after.starts_with(&[0xEF, 0xBB, 0xBF]));
        assert_eq!(read_text_inner(&p_utf8.to_string_lossy())["content"], "已更新\n文本");

        // GBK/GB18030 raw bytes: "中文" = [0xD6, 0xD0, 0xCE, 0xC4]
        let (decoded_gbk, enc_gbk) = decode_text_bytes(&[0xD6, 0xD0, 0xCE, 0xC4]);
        #[cfg(windows)]
        {
            assert_eq!(decoded_gbk, "中文");
            assert_eq!(enc_gbk, "gb18030");
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn bench_10k_queries_do_not_deadlock() {
        // TempDir 的 Drop 守卫负责清理：断言 panic 也不会在 %TEMP% 里留垃圾
        let tmp = crate::testutil::TempDir::new("picnest_test");
        let db_path = tmp.join("test.db");
        let conn = crate::db::init_db(&db_path).unwrap();
        conn.execute("INSERT INTO folders (path) VALUES (?1)", ["D:\\DummyRoot"]).unwrap();
        let fid = conn.last_insert_rowid();
        {
            let mut c = conn;
            let tx = c.transaction().unwrap();
            {
                let mut stmt = tx
                    .prepare("INSERT INTO images (folder_id, file_path, size, mtime) VALUES (?1, ?2, 1024, 1700000000)")
                    .unwrap();
                for i in 0..10800 {
                    let sub = i % 18;
                    let p = format!("D:\\DummyRoot\\{:02}_folder\\img_{:05}.png", sub, i);
                    stmt.execute(rusqlite::params![fid, p]).unwrap();
                }
            }
            tx.commit().unwrap();
        }
        let t0 = std::time::Instant::now();
        let rconn = open_read_conn(&db_path).unwrap();
        let mut stmt = rconn
            .prepare("SELECT id, file_path FROM images WHERE folder_id = ?1 AND deleted_at IS NULL AND file_path LIKE ?2 || '%' ORDER BY CASE WHEN sort_order > 0 THEN 0 ELSE 1 END, sort_order ASC, id DESC LIMIT 100000 OFFSET 0")
            .unwrap();
        let count = stmt
            .query_map(rusqlite::params![fid, "D:\\DummyRoot\\"], |r| r.get::<_, i64>(0))
            .unwrap()
            .count();
        assert_eq!(count, 10800);
        println!("10800 images_by_dir SQL took {}ms", t0.elapsed().as_millis());
    }

    #[test]
    fn crop_as_sql_failure_removes_the_new_file_and_journal() {
        let tmp = crate::testutil::TempDir::new("picnest_crop_as_fault");
        let root = tmp.join("lib");
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("source.png");
        let image = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            8,
            8,
            image::Rgba([10, 20, 30, 255]),
        ));
        image.save(&source).unwrap();
        let conn = crate::db::init_db(&tmp.join("test.db")).unwrap();
        conn.execute("INSERT INTO folders (path) VALUES (?1)", [root.to_string_lossy().to_string()]).unwrap();
        conn.execute(
            "INSERT INTO images (folder_id, file_path, size, mtime) VALUES (?1, ?2, 1, 1)",
            rusqlite::params![conn.last_insert_rowid(), source.to_string_lossy().to_string()],
        ).unwrap();
        conn.execute_batch("CREATE TRIGGER reject_crop_as BEFORE INSERT ON images BEGIN SELECT RAISE(ABORT, 'injected crop failure'); END;").unwrap();
        let result = crop_image_as_sync(
            source.to_str().unwrap(),
            &serde_json::json!({ "left": 0, "top": 0, "width": 4, "height": 4 }),
            &conn,
        );
        assert_eq!(result["ok"], false);
        assert!(result["error"].as_str().unwrap().contains("injected crop failure"));
        assert!(source.exists());
        assert!(!root.join("source-cropped.png").exists());
        assert!(!std::fs::read_dir(&root).unwrap().any(|entry| {
            entry.unwrap().file_name().to_string_lossy().starts_with(".picnest-part-")
        }));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn group_a_crop_memory_rename_sort_and_export_work() {
        let tmp = crate::testutil::TempDir::new("picnest_group_a");
        let root = tmp.join("lib");
        let sub_a = root.join("02_Beta");
        let sub_a_nested = sub_a.join("Child");
        let sub_b = root.join("10_Alpha");
        let data_dir = tmp.join("data");
        std::fs::create_dir_all(&sub_a_nested).unwrap();
        std::fs::create_dir_all(&sub_b).unwrap();
        std::fs::create_dir_all(&data_dir).unwrap();

        // Create a valid 20x12 PNG via image crate
        let img_path = sub_a.join("art.png");
        let dyn_img = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            20,
            12,
            image::Rgba([200, 100, 50, 255]),
        ));
        dyn_img.save(&img_path).unwrap();

        let db_path = tmp.join("test.db");
        let conn = crate::db::init_db(&db_path).unwrap();
        conn.execute(
            "INSERT INTO folders (path) VALUES (?1)",
            [root.to_string_lossy().to_string()],
        )
        .unwrap();
        let fid = conn.last_insert_rowid();
        let img_str = img_path.to_string_lossy().to_string();
        conn.execute(
            "INSERT INTO images (folder_id, file_path, width, height, size, mtime) VALUES (?1, ?2, 20, 12, 100, 100)",
            rusqlite::params![fid, img_str],
        )
        .unwrap();

        // 1a. crop_image_as_sync saves new file + indexes it without altering original
        let crop_opts = serde_json::json!({ "left": 2, "top": 1, "width": 10, "height": 6 });
        let res_as = crop_image_as_sync(&img_str, &crop_opts, &conn);
        assert!(res_as["ok"].as_bool() == Some(true));
        assert_eq!(res_as["width"], 10);
        assert_eq!(res_as["height"], 6);
        let cropped_path = PathBuf::from(res_as["path"].as_str().unwrap());
        assert!(cropped_path.exists());
        assert_eq!(image::image_dimensions(&cropped_path).unwrap(), (10, 6));
        assert_eq!(image::image_dimensions(&img_path).unwrap(), (20, 12));
        let as_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM images WHERE LOWER(file_path) = LOWER(?1)",
                [cropped_path.to_string_lossy().to_string()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(as_count, 1);

        // 1b. crop_image_sync overwrites original + backs up original into transform-backups
        let res_over = crop_image_sync(&img_str, &crop_opts, &data_dir, Some(&conn));
        assert_eq!(res_over["ok"], true);
        assert_eq!(res_over["width"], 10);
        assert_eq!(res_over["height"], 6);
        assert_eq!(image::image_dimensions(&img_path).unwrap(), (10, 6));
        let backup_path = PathBuf::from(res_over["backupPath"].as_str().unwrap());
        assert!(backup_path.exists());
        assert_eq!(image::image_dimensions(&backup_path).unwrap(), (20, 12));

        // 2. dir_memory_rename_sync migrates subtree keys + rebases cover absolute paths
        let patch_parent = serde_json::json!({ "color": "#ff8800", "cover": img_str });
        let patch_child = serde_json::json!({ "color": "#0088ff", "cover": sub_a_nested.join("inner.png").to_string_lossy().to_string() });
        conn.execute(
            "INSERT INTO picnest_dir_memory (root_id, rel, patch) VALUES (?1, '02_Beta', ?2), (?1, '02_Beta/Child', ?3)",
            rusqlite::params![fid, patch_parent.to_string(), patch_child.to_string()],
        )
        .unwrap();
        assert_eq!(dir_memory_rename_sync(&conn, fid, "02_Beta", "02_Renamed").unwrap(), true);
        let migrated_parent: String = conn
            .query_row(
                "SELECT patch FROM picnest_dir_memory WHERE root_id = ?1 AND rel = '02_Renamed'",
                [fid],
                |r| r.get(0),
            )
            .unwrap();
        let mp_json: serde_json::Value = serde_json::from_str(&migrated_parent).unwrap();
        assert_eq!(mp_json["color"], "#ff8800");
        assert!(mp_json["cover"].as_str().unwrap().contains("02_Renamed"));
        let migrated_child: String = conn
            .query_row(
                "SELECT patch FROM picnest_dir_memory WHERE root_id = ?1 AND rel = '02_Renamed/Child'",
                [fid],
                |r| r.get(0),
            )
            .unwrap();
        let mc_json: serde_json::Value = serde_json::from_str(&migrated_child).unwrap();
        assert!(mc_json["cover"].as_str().unwrap().contains("02_Renamed"));

        // 3. dir_sort_sync + dir_sort_recursive_sync write sorted names to picnest_dir_order
        let sort_res = dir_sort_sync(&conn, "", &root.to_string_lossy(), "name_desc");
        assert_eq!(sort_res["ok"], true);
        let names = sort_res["names"].as_array().unwrap();
        assert_eq!(names[0], "10_Alpha");
        assert_eq!(names[1], "02_Beta");
        let rec_res = dir_sort_recursive_sync(&conn, &root.to_string_lossy(), "", "name_asc");
        assert_eq!(rec_res["ok"], true);
        assert!(rec_res["levels"].as_u64().unwrap() >= 3);

        // 4. export_dir_to_dest copies supported files preserving tree & avoiding dupes
        let export_target = tmp.join("exported");
        std::fs::create_dir_all(&export_target).unwrap();
        let exp_res = export_dir_to_dest(&sub_a, &export_target, false);
        assert_eq!(exp_res["ok"], true);
        assert_eq!(exp_res["count"], 2);
        assert!(export_target.join("02_Beta").join("art.png").exists());

        drop(conn);
    }
}
