use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

static DIAG_START: OnceLock<Instant> = OnceLock::new();
static DIAG_BUF: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();
static DIAG_LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
/// 诊断日志开关：默认关闭。生产环境没有理由把每次请求、每次导航都写一遍磁盘——
/// 一个 700 张的目录光缩略图就是 1400 行日志。带 PICNEST_DIAG=1 或带 CDP 端口启动时自动打开。
static DIAG_ON: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// 日志走异步队列落盘：热路径（每次图库查询）不再同步 open/append 文件
static DIAG_TX: OnceLock<std::sync::mpsc::Sender<String>> = OnceLock::new();
/// 图库取数 HTTP 接口需要的库路径与缩略图目录
static API_DB_PATH: OnceLock<PathBuf> = OnceLock::new();
static API_THUMBS_DIR: OnceLock<PathBuf> = OnceLock::new();
static ALLOWED_ROOTS_CACHE: OnceLock<std::sync::RwLock<(Option<Instant>, Vec<PathBuf>)>> = OnceLock::new();
static MEDIA_NONCE: OnceLock<String> = OnceLock::new();

fn media_nonce() -> &'static str {
    MEDIA_NONCE.get().map(String::as_str).unwrap_or("")
}

fn load_folder_roots_from_db() -> Vec<PathBuf> {
    let Some(db_path) = API_DB_PATH.get() else {
        return Vec::new();
    };
    let Ok(conn) = crate::commands::open_read_conn(db_path) else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare("SELECT path FROM folders") else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) else {
        return Vec::new();
    };
    rows.flatten()
        .map(PathBuf::from)
        .filter_map(|p| p.canonicalize().ok())
        .collect()
}

fn resolve_allowed_media_path(raw_path: &Path) -> Option<PathBuf> {
    let cache = ALLOWED_ROOTS_CACHE.get_or_init(|| std::sync::RwLock::new((None, Vec::new())));
    let cached = cache
        .read()
        .ok()
        .and_then(|guard| guard.0.filter(|ts| ts.elapsed().as_secs() < 5).map(|_| guard.1.clone()));
    let roots = match cached {
        Some(roots) => roots,
        None => {
            let fresh = load_folder_roots_from_db();
            if let Ok(mut guard) = cache.write() {
                *guard = (Some(Instant::now()), fresh.clone());
            }
            fresh
        }
    };
    resolve_allowed_media_path_with_roots(raw_path, API_THUMBS_DIR.get().map(PathBuf::as_path), &roots)
}

fn resolve_allowed_media_path_with_roots(
    raw_path: &Path,
    thumbs_dir: Option<&Path>,
    roots: &[PathBuf],
) -> Option<PathBuf> {
    if raw_path.as_os_str().is_empty()
        || raw_path.components().any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return None;
    }
    let target = raw_path.canonicalize().ok()?;
    if let Some(thumbs) = thumbs_dir
        && let Ok(root) = thumbs.canonicalize()
        && target.starts_with(root)
    {
        return Some(target);
    }
    roots.iter().find(|root| target.starts_with(root)).cloned().map(|_| target)
}

fn is_allowed_origin(origin: &str) -> bool {
    if origin == "tauri://localhost" {
        return true;
    }
    if crate::security::is_loopback_origin(origin) {
        return true;
    }
    url::Url::parse(origin).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.host_str() == Some("tauri.localhost")
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none()
    })
}

fn query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key {
                return Some(url_decode(v));
            }
        }
    }
    None
}

/// GET /api/images?folder=4&rel=...&offset=0&limit=100000&sort=manual&asc=1&rec=1
/// 返回与 images_by_dir 命令同形的 JSON 数组。
fn serve_images_api(query: &str) -> Option<String> {
    let t0 = std::time::Instant::now();
    let db = API_DB_PATH.get()?;
    if query_param(query, "plan").as_deref() == Some("1") {
        // 调试：直接把执行计划抖出来，确认索引有没有被用上
        let thumbs = String::new();
        let _ = thumbs;
        if let Some(th) = API_THUMBS_DIR.get() {
            if let Ok(plan) = crate::commands::explain_images_plan(db, th) {
                return Some(serde_json::to_string(&plan).unwrap_or_default());
            }
        }
        return Some("[]".to_string());
    }
    let thumbs = API_THUMBS_DIR.get()?;
    let folder_id: i64 = query_param(query, "folder")?.parse().ok()?;
    let rel = query_param(query, "rel").unwrap_or_default();
    let offset: i64 = query_param(query, "offset").and_then(|v| v.parse().ok()).unwrap_or(0);
    let limit: i64 = query_param(query, "limit").and_then(|v| v.parse().ok()).unwrap_or(100000);
    let (offset, limit) = crate::commands::normalize_query_window(offset, limit);
    let sort = query_param(query, "sort");
    let asc = query_param(query, "asc").map(|v| v == "1" || v == "true");
    let rec = query_param(query, "rec").map(|v| v == "1" || v == "true");

    let out = match crate::commands::query_images_http(
        db,
        thumbs,
        folder_id,
        &rel,
        offset,
        limit,
        sort.as_deref(),
        asc,
        rec,
    ) {
        Ok(list) => {
            let n = list.len();
            let s = serde_json::to_string(&list).ok();
            diag_log!(
                "api/images rel={:?} rows={} in {}ms",
                rel,
                n,
                t0.elapsed().as_millis()
            );
            s
        }
        Err(e) => Some(serde_json::json!({ "error": e }).to_string()),
    };
    out
}

pub fn diag_init(data_dir: &Path) {
    // 默认关闭；PICNEST_DIAG=1 才开。注意：不要让它跟着 CDP 端口自动开——
    // 诊断日志走的是和真实命令同一条 IPC 通道，一次导航 5 条日志就足够把
    // 交互命令排到后面（实测每次切目录首次 invoke 要等 0.6~4 秒）。
    let on = std::env::var("PICNEST_DIAG")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    DIAG_ON.store(on, std::sync::atomic::Ordering::Relaxed);
    let _ = DIAG_START.set(Instant::now());
    let _ = DIAG_BUF.set(Mutex::new(VecDeque::with_capacity(400)));
    let _ = std::fs::create_dir_all(data_dir);
    let log_path = data_dir.join("diag.log");
    if on {
        // 每次启动重新开一篇：混着上一次的日志会让时间轴对不上。
        let _ = std::fs::write(&log_path, b"");
    }
    let _ = DIAG_LOG_PATH.set(log_path.clone());
    if !on {
        return;
    }

    // 用一条常驻线程独占日志文件：写入排队，主线程只 send 不再等磁盘
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let _ = DIAG_TX.set(tx);
    std::thread::spawn(move || {
        let mut file = OpenOptions::new().create(true).append(true).open(&log_path).ok();
        let mut batch: Vec<String> = Vec::with_capacity(64);
        loop {
            match rx.recv() {
                Ok(line) => batch.push(line),
                Err(_) => break,
            }
            // 把已排队的都收进来（最多 256 行一批），然后一次刷盘
            while batch.len() < 256 {
                match rx.try_recv() {
                    Ok(more) => batch.push(more),
                    Err(_) => break,
                }
            }
            if let Some(ref mut f) = file {
                for line in batch.drain(..) {
                    let _ = writeln!(f, "{}", line);
                }
                let _ = f.flush();
            } else {
                batch.clear();
            }
        }
        if let Some(ref mut f) = file {
            let _ = f.flush();
        }
    });

    diag_push("=== PicNest session start ===");
}

#[inline]
pub fn is_diag_on() -> bool {
    DIAG_ON.load(std::sync::atomic::Ordering::Relaxed)
}

macro_rules! diag_log {
    ($($arg:tt)*) => {
        if $crate::media_server::is_diag_on() {
            $crate::media_server::diag_push(&format!($($arg)*));
        }
    };
}
pub(crate) use diag_log;

pub fn diag_push(msg: &str) {
    if !is_diag_on() {
        return;
    }
    let ms = DIAG_START.get().map(|t| t.elapsed().as_millis()).unwrap_or(0);
    let line = format!("[+{:06}ms] {}", ms, msg);
    if let Some(m) = DIAG_BUF.get() {
        if let Ok(mut buf) = m.lock() {
            if buf.len() >= 400 {
                buf.pop_front();
            }
            buf.push_back(line.clone());
        }
    }
    if let Some(p) = DIAG_LOG_PATH.get() {
        // 正常路径：交给后台线程落盘，不阻塞调用者
        if let Some(tx) = DIAG_TX.get() {
            let _ = tx.send(line.clone());
        } else if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(p) {
            let _ = writeln!(f, "{}", line);
        }
    }
}

pub fn diag_snapshot() -> Vec<String> {
    if let Some(m) = DIAG_BUF.get() {
        if let Ok(buf) = m.lock() {
            return buf.iter().cloned().collect();
        }
    }
    Vec::new()
}

fn url_decode(input: &str) -> String {
    let mut out = Vec::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(b) = u8::from_str_radix(hex, 16) {
                    out.push(b);
                    i += 3;
                    continue;
                }
            }
        } else if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn mime_for_ext(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "flv" | "f4v" => "video/x-flv",
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

/// 允许“挂着等下一个请求”的连接数上限。
/// keep-alive 的代价是连接会占着一个 worker 线程读下一行；Chromium 会同时开多条
/// （图片、预连接各算一条），一旦把 24 个 worker 都挂满，新连接只能在 accept 队列里
/// 等 5 秒超时回收——实测连一次普通缩略图都要 3.9s。
/// 留出余量：最多 8 条挂着，剩下的 worker 永远能接新连接。
const PARK_CAP: usize = 8;
static PARKED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn handle_client(mut stream: TcpStream, expected_port: u16) {
    // 写超时：对端不读时不能无限期卡住 worker。
    let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(15)));
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });
    // keep-alive：一条连接上连续处理请求，省掉每个缩略图一次三次握手。
    // 空闲连接用读超时回收，并且有 PARK_CAP 上限，不会把 worker 池吃干。
    let mut first = true;
    loop {
        let mut parked = false;
        if first {
            // 首条请求：Chromium 会预连接（连上不发请求），给 5 秒等它开口
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
            first = false;
        } else {
            use std::sync::atomic::Ordering::Relaxed;
            if PARKED.fetch_add(1, Relaxed) >= PARK_CAP {
                PARKED.fetch_sub(1, Relaxed);
                return; // 挂位已满：直接关，让出 worker
            }
            parked = true;
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
        }
        let mut request_line = String::new();
        let read = reader.read_line(&mut request_line);
        if parked {
            PARKED.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
        }
        match read {
            Ok(0) => return,  // 对端关闭
            Ok(_) => {}
            Err(_) => return, // 读超时 = 空闲连接，回收
        }
        if request_line.trim().is_empty() {
            continue;
        }
        if !serve_request(&mut stream, &mut reader, &request_line, expected_port) {
            return;
        }
    }
}

/// 处理一条请求，返回 true 表示这条连接还能继续用
fn serve_request(
    stream: &mut TcpStream,
    reader: &mut BufReader<TcpStream>,
    request_line: &str,
    expected_port: u16,
) -> bool {
    let mut range_header: Option<String> = None;
    let mut origin_header: Option<String> = None;
    let mut host_header: Option<String> = None;
    let mut keep_alive = true;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            let key = k.trim();
            if key.eq_ignore_ascii_case("range") {
                range_header = Some(v.trim().to_string());
            } else if key.eq_ignore_ascii_case("origin") {
                origin_header = Some(v.trim().to_string());
            } else if key.eq_ignore_ascii_case("host") {
                host_header = Some(v.trim().to_string());
            } else if key.eq_ignore_ascii_case("connection")
                && v.trim().eq_ignore_ascii_case("close")
            {
                keep_alive = false;
            }
        }
    }
    let conn_hdr = if keep_alive {
        "Connection: keep-alive\r\nKeep-Alive: timeout=5\r\n"
    } else {
        "Connection: close\r\n"
    };

    if !host_header.as_deref().is_some_and(|host| {
        crate::security::validate_download_host_header(host, expected_port)
    }) {
        let hdr = format!("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n{}\r\n", conn_hdr);
        let _ = stream.write_all(hdr.as_bytes());
        return keep_alive;
    }

    // 收紧 CORS：若浏览器携带非本机/非 Tauri Origin，直接拒绝；仅允许本机/Tauri/无 Origin 的资源加载
    if let Some(orig) = &origin_header
        && !is_allowed_origin(orig)
    {
        let hdr = format!(
            "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n{}\r\n",
            conn_hdr
        );
        let _ = stream.write_all(hdr.as_bytes());
        return keep_alive;
    }
    let cors_origin = origin_header
        .as_deref()
        .filter(|o| !o.is_empty())
        .unwrap_or("http://tauri.localhost");

    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 {
        let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return false;
    }
    let method = parts[0];
    let target = parts[1];

    if method == "OPTIONS" {
        let hdr = format!(
            "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: {}\r\nVary: Origin\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range\r\n{}\r\n",
            cors_origin, conn_hdr
        );
        let _ = stream.write_all(hdr.as_bytes());
        return keep_alive;
    }

    if method != "GET" && method != "HEAD" {
        let _ = stream.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return false;
    }

    let (path_part, query) = target.split_once('?').unwrap_or((target, ""));
    let nonce = media_nonce();
    if path_part == "/api/images" || path_part == "/diag" {
        let supplied = query_param(query, "nonce").unwrap_or_default();
        if nonce.is_empty() || !crate::security::constant_time_eq(&supplied, nonce) {
            let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            return false;
        }
    }
    if path_part == "/api/images" {
        let body = serve_images_api(query).unwrap_or_else(|| "[]".to_string());
        let hdr = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: {}\r\nVary: Origin\r\nCache-Control: no-store\r\n{}\r\n",
            body.len(),
            cors_origin,
            conn_hdr
        );
        if stream.write_all(hdr.as_bytes()).is_err() {
            return false;
        }
        return stream.write_all(body.as_bytes()).is_ok() && keep_alive;
    }
    if path_part == "/diag" {
        let body = serde_json::json!({
            "uptime_ms": DIAG_START.get().map(|t| t.elapsed().as_millis() as u64).unwrap_or(0),
            "logs": diag_snapshot(),
        })
        .to_string();
        let hdr = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: {}\r\nVary: Origin\r\n{}\r\n",
            body.len(),
            cors_origin,
            conn_hdr
        );
        if stream.write_all(hdr.as_bytes()).is_err() {
            return false;
        }
        return stream.write_all(body.as_bytes()).is_ok() && keep_alive;
    }
    if let Some(rest) = path_part.strip_prefix("/capture/") {
        let segs: Vec<&str> = rest.split('/').collect();
        if segs.len() != 3 || nonce.is_empty() || !crate::security::constant_time_eq(segs[0], nonce) {
            let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            return false;
        }
        let session_id = segs[1].parse::<u64>().ok();
        let mon_idx = segs[2].strip_suffix(".bmp").and_then(|s| s.parse::<usize>().ok());
        let bmp = match (session_id, mon_idx) {
            (Some(sid), Some(midx)) => crate::capture::get_monitor_bmp(sid, midx),
            _ => None,
        };
        let Some(bytes) = bmp else {
            let hdr = format!(
                "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: {}\r\nVary: Origin\r\n{}\r\n",
                cors_origin, conn_hdr
            );
            let _ = stream.write_all(hdr.as_bytes());
            return keep_alive;
        };
        let hdr = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: image/bmp\r\nContent-Length: {}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: {}\r\nVary: Origin\r\n{}\r\n",
            bytes.len(),
            cors_origin,
            conn_hdr
        );
        if stream.write_all(hdr.as_bytes()).is_err() {
            return false;
        }
        if method == "HEAD" {
            return keep_alive;
        }
        return stream.write_all(&bytes).is_ok() && keep_alive;
    }
    if let Some(rest) = path_part.strip_prefix("/pin/") {
        let segs: Vec<&str> = rest.split('/').collect();
        if segs.len() != 2 || nonce.is_empty() || !crate::security::constant_time_eq(segs[0], nonce) {
            let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            return false;
        }
        let pin_id = segs[1].strip_suffix(".png").and_then(|s| s.parse::<u64>().ok());
        let png = pin_id.and_then(crate::capture::get_pin_png);
        let Some(bytes) = png else {
            let hdr = format!(
                "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: {}\r\nVary: Origin\r\n{}\r\n",
                cors_origin, conn_hdr
            );
            let _ = stream.write_all(hdr.as_bytes());
            return keep_alive;
        };
        let hdr = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: {}\r\nVary: Origin\r\n{}\r\n",
            bytes.len(),
            cors_origin,
            conn_hdr
        );
        if stream.write_all(hdr.as_bytes()).is_err() {
            return false;
        }
        if method == "HEAD" {
            return keep_alive;
        }
        return stream.write_all(&bytes).is_ok() && keep_alive;
    }
    let file_path_str = path_part
        .strip_prefix("/m/")
        .and_then(|rest| rest.split_once('/'))
        .and_then(|(supplied, encoded)| {
            if !crate::security::constant_time_eq(supplied, nonce) {
                return None;
            }
            (!encoded.is_empty()).then(|| url_decode(encoded))
        });

    let Some(fp) = file_path_str else {
        let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return false;
    };

    let Some(path) = resolve_allowed_media_path(Path::new(&fp)) else {
        diag_log!("m 403 {}", fp);
        let hdr = format!(
            "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: {}\r\nVary: Origin\r\n{}\r\n",
            cors_origin, conn_hdr
        );
        let _ = stream.write_all(hdr.as_bytes());
        return keep_alive;
    };

    let t_media = std::time::Instant::now();
    diag_log!(
        "m req {}",
        path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
    );
    let Ok(mut file) = File::open(&path) else {
        diag_log!(
            "m 404 {}",
            path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
        );
        let hdr = format!(
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: {}\r\nVary: Origin\r\n{}\r\n",
            cors_origin, conn_hdr
        );
        let _ = stream.write_all(hdr.as_bytes());
        return keep_alive;
    };
    let Ok(meta) = file.metadata() else {
        let _ = stream.write_all(b"HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n");
        return false;
    };
    let total_len = meta.len();
    let mime = mime_for_ext(&path);

    if total_len == 0 {
        let hdr = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: 0\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: {}\r\nVary: Origin\r\n{}\r\n",
            mime, cors_origin, conn_hdr
        );
        let _ = stream.write_all(hdr.as_bytes());
        return keep_alive;
    }

    let (status, start, end) = if let Some(rh) = range_header {
        if let Some(spec) = rh.strip_prefix("bytes=") {
            let first = spec.split(',').next().unwrap_or("").trim();
            if let Some((s_str, e_str)) = first.split_once('-') {
                let s = s_str.trim().parse::<u64>().unwrap_or(0);
                let e = if e_str.trim().is_empty() {
                    total_len - 1
                } else {
                    e_str.trim().parse::<u64>().unwrap_or(total_len - 1).min(total_len - 1)
                };
                if s <= e && s < total_len {
                    (206, s, e)
                } else {
                    let hdr = format!(
                        "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{}\r\n{}\r\n",
                        total_len, conn_hdr
                    );
                    let _ = stream.write_all(hdr.as_bytes());
                    return keep_alive;
                }
            } else {
                (200, 0, total_len - 1)
            }
        } else {
            (200, 0, total_len - 1)
        }
    } else {
        (200, 0, total_len - 1)
    };

    let content_len = end - start + 1;
    let hdr = if status == 206 {
        format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Type: {}\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: {}\r\nVary: Origin\r\n{}\r\n",
            mime, content_len, start, end, total_len, cors_origin, conn_hdr
        )
    } else {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nCache-Control: public, max-age=3600\r\nAccess-Control-Allow-Origin: {}\r\nVary: Origin\r\n{}\r\n",
            mime, content_len, cors_origin, conn_hdr
        )
    };

    if stream.write_all(hdr.as_bytes()).is_err() {
        return false;
    }
    if method == "HEAD" {
        return keep_alive;
    }
    if file.seek(SeekFrom::Start(start)).is_err() {
        return false;
    }

    let mut remaining = content_len;
    let mut buf = [0u8; 65536];
    while remaining > 0 {
        let to_read = remaining.min(buf.len() as u64) as usize;
        match file.read(&mut buf[..to_read]) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if stream.write_all(&buf[..n]).is_err() {
                    return false;
                }
                remaining -= n as u64;
            }
        }
    }
    diag_log!(
        "m done {} bytes={} in {}ms",
        content_len - remaining,
        content_len,
        t_media.elapsed().as_millis()
    );
    keep_alive && remaining == 0
}

pub fn start_media_server(
    db_path: std::path::PathBuf,
    thumbs_dir: std::path::PathBuf,
) -> (u16, u16, String) {
    let _ = API_DB_PATH.set(db_path);
    let _ = API_THUMBS_DIR.set(thumbs_dir);
    let nonce = crate::security::random_hex(24).expect("Failed to generate media nonce");
    let _ = MEDIA_NONCE.set(nonce.clone());
    // 两条监听：图库取数走独立端口，避开浏览器的同源 6 连限制——
    // 否则切目录时缩略图请求会把连接占满，取数要排队（实测 15 张的目录要 170ms）。
    let media_port = spawn_listener();
    let api_port = spawn_listener();
    (media_port, api_port, nonce)
}

fn spawn_listener() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to bind local media server");
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);

    // 固定线程池：原来一个连接起一个线程，一次进目录几十张缩略图就是几十个线程同时起，
    // 线程风暴会把整机响应拖死（表现为窗口“未响应”）。
    let (tx, rx) = std::sync::mpsc::channel::<TcpStream>();
    let rx = std::sync::Arc::new(std::sync::Mutex::new(rx));
    for _ in 0..24 {
        let rx = rx.clone();
        std::thread::spawn(move || loop {
            let stream = {
                match rx.lock() {
                    Ok(g) => g.recv(),
                    Err(_) => break,
                }
            };
            match stream {
                Ok(s) => handle_client(s, port),
                Err(_) => break,
            }
        });
    }

    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let _ = stream.set_nodelay(true);
            if tx.send(stream).is_err() {
                break;
            }
        }
    });
    port
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Read, Write};

    fn request(port: u16, target: &str, headers: &[(&str, &str)]) -> (u16, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
        let mut req = format!("GET {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n", target, port);
        for (key, value) in headers {
            req.push_str(&format!("{}: {}\r\n", key, value));
        }
        req.push_str("\r\n");
        stream.write_all(req.as_bytes()).unwrap();
        let mut response = Vec::new();
        let _ = stream.read_to_end(&mut response);
        let response = String::from_utf8_lossy(&response);
        let status = response.split_whitespace().nth(1).and_then(|v| v.parse().ok()).unwrap_or(0);
        (status, response.into_owned())
    }

    #[test]
    fn containment_uses_canonical_paths_and_only_explicit_roots() {
        let tmp = crate::testutil::TempDir::new("picnest_media_containment");
        let root = tmp.join("library");
        let thumbs = tmp.join("data").join("cache").join("thumbs");
        let outside = tmp.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&thumbs).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let image = root.join("image.png");
        let secret = tmp.join("data").join("collect_token.txt");
        let thumb = thumbs.join("thumb.jpg");
        let external = outside.join("outside.png");
        fs::write(&image, b"image").unwrap();
        fs::write(&secret, b"secret").unwrap();
        fs::write(&thumb, b"thumb").unwrap();
        fs::write(&external, b"outside").unwrap();
        let roots = vec![root.canonicalize().unwrap()];
        assert!(resolve_allowed_media_path_with_roots(&image, Some(&thumbs), &roots).is_some());
        assert!(resolve_allowed_media_path_with_roots(&thumb, Some(&thumbs), &roots).is_some());
        assert!(resolve_allowed_media_path_with_roots(&secret, Some(&thumbs), &roots).is_none());
        assert!(resolve_allowed_media_path_with_roots(&external, Some(&thumbs), &roots).is_none());
        assert!(resolve_allowed_media_path_with_roots(&root.join("..").join("outside.png"), Some(&thumbs), &roots).is_none());
        #[cfg(windows)]
        {
            let junction = root.join("escape");
            let status = std::process::Command::new("cmd")
                .args(["/D", "/C", "mklink", "/J"])
                .arg(&junction)
                .arg(&outside)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap();
            assert!(status.success());
            assert!(resolve_allowed_media_path_with_roots(&junction.join("outside.png"), Some(&thumbs), &roots).is_none());
        }
    }

    #[test]
    fn media_endpoints_require_nonce_host_and_origin() {
        let tmp = crate::testutil::TempDir::new("picnest_media_http");
        let data = tmp.join("data");
        let root = tmp.join("library");
        let thumbs = data.join("cache").join("thumbs");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&thumbs).unwrap();
        fs::write(root.join("image.png"), b"image").unwrap();
        fs::write(data.join("collect_token.txt"), b"secret").unwrap();
        let db_path = data.join("test.db");
        let conn = crate::db::init_db(&db_path).unwrap();
        conn.execute("INSERT INTO folders (path) VALUES (?1)", [root.to_string_lossy().to_string()]).unwrap();
        drop(conn);
        let (media_port, api_port, nonce) = start_media_server(db_path, thumbs);
        let encoded: String = url::form_urlencoded::byte_serialize(root.join("image.png").to_string_lossy().as_bytes()).collect();
        let target = format!("/m/{}/{}", nonce, encoded);
        assert_eq!(request(media_port, &target, &[]).0, 200);
        assert_eq!(request(media_port, &format!("/m/wrong/{}", encoded), &[]).0, 403);
        let secret_encoded: String = url::form_urlencoded::byte_serialize(data.join("collect_token.txt").to_string_lossy().as_bytes()).collect();
        assert_eq!(request(media_port, &format!("/m/{}/{}", nonce, secret_encoded), &[]).0, 403);
        assert_eq!(request(media_port, &target, &[("Origin", "https://evil.example")]).0, 403);
        assert_eq!(request(api_port, "/api/images?folder=1&limit=10", &[]).0, 403);
        assert_eq!(request(api_port, &format!("/api/images?folder=1&limit=10&nonce={}", nonce), &[]).0, 200);
        let mut stream = TcpStream::connect(("127.0.0.1", media_port)).unwrap();
        write!(stream, "GET {} HTTP/1.1\r\nHost: evil.example:{}\r\nConnection: close\r\n\r\n", target, media_port).unwrap();
        let mut response = Vec::new();
        let _ = stream.read_to_end(&mut response);
        assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 403"));
    }
}
