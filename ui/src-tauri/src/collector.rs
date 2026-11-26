use rusqlite::params;
use serde_json::json;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

const COLLECT_PORT: u16 = 41600;

static ACTIVE_COLLECT_ROOT: AtomicI64 = AtomicI64::new(-1);
static COLLECTOR_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
static COLLECTOR_DB_PATH: OnceLock<PathBuf> = OnceLock::new();
static COLLECTOR_APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();
static COLLECTOR_TOKEN: OnceLock<std::sync::RwLock<String>> = OnceLock::new();

pub fn set_active_collect_root(root_id: Option<i64>) {
    ACTIVE_COLLECT_ROOT.store(root_id.unwrap_or(-1), Ordering::SeqCst);
}

pub fn get_active_collect_root() -> Option<i64> {
    let id = ACTIVE_COLLECT_ROOT.load(Ordering::SeqCst);
    if id < 0 {
        None
    } else {
        Some(id)
    }
}

pub fn get_token() -> Result<String, String> {
    let slot = COLLECTOR_TOKEN.get_or_init(|| std::sync::RwLock::new(String::new()));
    let mut guard = slot.write().map_err(|_| "采集密钥锁不可用".to_string())?;
    if guard.len() == 32 && guard.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(guard.clone());
    }
    let data_dir = COLLECTOR_DATA_DIR
        .get()
        .ok_or_else(|| "采集服务数据目录未初始化".to_string())?;
    let loaded = fs::read_to_string(data_dir.join("collect_token.txt"))
        .ok()
        .map(|content| content.trim().to_string())
        .filter(|token| token.len() == 32 && token.chars().all(|c| c.is_ascii_hexdigit()));
    let token = match loaded {
        Some(token) => token,
        None => generate_token(data_dir)?,
    };
    *guard = token.clone();
    Ok(token)
}

fn generate_token(data_dir: &Path) -> Result<String, String> {
    let token = crate::security::random_hex(16)?;
    fs::create_dir_all(data_dir).map_err(|e| format!("创建数据目录失败: {}", e))?;
    fs::write(data_dir.join("collect_token.txt"), &token)
        .map_err(|e| format!("保存采集密钥失败: {}", e))?;
    Ok(token)
}

pub fn reset_token() -> Result<String, String> {
    let data_dir = COLLECTOR_DATA_DIR
        .get()
        .ok_or_else(|| "采集服务数据目录未初始化".to_string())?;
    let slot = COLLECTOR_TOKEN.get_or_init(|| std::sync::RwLock::new(String::new()));
    let mut guard = slot.write().map_err(|_| "采集密钥锁不可用".to_string())?;
    let token = crate::security::random_hex(16)?;
    fs::create_dir_all(data_dir).map_err(|e| format!("创建数据目录失败: {}", e))?;
    fs::write(data_dir.join("collect_token.txt"), &token)
        .map_err(|e| format!("保存采集密钥失败: {}", e))?;
    *guard = token.clone();
    Ok(token)
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

fn sanitize_filename(name: &str, fallback: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| if "\\/:*?\"<>|\r\n\t".contains(c) { ' ' } else { c })
        .collect();
    let squashed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if squashed.is_empty() || squashed == "." || squashed == ".." {
        fallback.to_string()
    } else {
        squashed.chars().take(120).collect()
    }
}

fn guess_ext(content_type: &str, url_or_src: &str) -> &'static str {
    let ct = content_type.to_ascii_lowercase();
    if ct.starts_with("image/jpeg") || ct.starts_with("image/jpg") {
        return ".jpg";
    }
    if ct.starts_with("image/png") {
        return ".png";
    }
    if ct.starts_with("image/webp") {
        return ".webp";
    }
    if ct.starts_with("image/gif") {
        return ".gif";
    }
    if ct.starts_with("image/avif") {
        return ".avif";
    }
    if ct.starts_with("image/bmp") {
        return ".bmp";
    }
    if ct.starts_with("image/svg+xml") {
        return ".svg";
    }
    if ct.starts_with("image/vnd.adobe.photoshop")
        || ct.starts_with("image/x-photoshop")
        || ct.starts_with("application/x-photoshop")
    {
        return ".psd";
    }
    if ct.starts_with("video/mp4") {
        return ".mp4";
    }
    if ct.starts_with("video/webm") {
        return ".webm";
    }
    if ct.starts_with("video/quicktime") {
        return ".mov";
    }
    if ct.starts_with("video/x-matroska") {
        return ".mkv";
    }
    if ct.starts_with("video/x-msvideo") {
        return ".avi";
    }
    if ct.starts_with("video/x-flv") {
        return ".flv";
    }

    // 从 URL 提取后缀探测
    if let Some(pos) = url_or_src.find('?') {
        let clean_url = &url_or_src[..pos];
        if let Some(dot) = clean_url.rfind('.') {
            let ext = clean_url[dot..].to_ascii_lowercase();
            match ext.as_str() {
                ".jpg" | ".jpeg" => return ".jpg",
                ".png" => return ".png",
                ".webp" => return ".webp",
                ".gif" => return ".gif",
                ".avif" => return ".avif",
                ".bmp" => return ".bmp",
                ".svg" => return ".svg",
                ".psd" => return ".psd",
                ".mp4" => return ".mp4",
                ".webm" => return ".webm",
                ".mov" => return ".mov",
                ".mkv" => return ".mkv",
                ".avi" => return ".avi",
                _ => {}
            }
        }
    } else if let Some(dot) = url_or_src.rfind('.') {
        let ext = url_or_src[dot..].to_ascii_lowercase();
        match ext.as_str() {
            ".jpg" | ".jpeg" => return ".jpg",
            ".png" => return ".png",
            ".webp" => return ".webp",
            ".gif" => return ".gif",
            ".avif" => return ".avif",
            ".bmp" => return ".bmp",
            ".svg" => return ".svg",
            ".psd" => return ".psd",
            ".mp4" => return ".mp4",
            ".webm" => return ".webm",
            ".mov" => return ".mov",
            ".mkv" => return ".mkv",
            ".avi" => return ".avi",
            _ => {}
        }
    }

    ".jpg"
}

fn parse_data_url(u: &str) -> Result<(Vec<u8>, String), String> {
    if !u.starts_with("data:") {
        return Err("不是 dataUrl".to_string());
    }
    let rest = &u[5..];
    let (meta, data_part) = rest
        .split_once(',')
        .ok_or_else(|| "非法 dataUrl 格式".to_string())?;
    let is_base64 = meta.contains(";base64");
    let content_type = meta
        .split(';')
        .next()
        .unwrap_or("application/octet-stream")
        .trim()
        .to_string();

    let bytes = if is_base64 {
        crate::importer::decode_base64(data_part)?
    } else {
        data_part.as_bytes().to_vec()
    };
    Ok((bytes, content_type))
}

fn is_domain_or_sub(host: &str, domain: &str) -> bool {
    host == domain || host.ends_with(&format!(".{}", domain))
}

pub(crate) fn resolve_download_referer(target: &url::Url, referer: &str) -> String {
    let clean_referer: String = referer
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    let target_host = target.host_str().unwrap_or("").to_ascii_lowercase();
    let ref_host = url::Url::parse(&clean_referer)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()));

    if is_domain_or_sub(&target_host, "pinimg.com") {
        return "https://www.pinterest.com/".to_string();
    }
    if is_domain_or_sub(&target_host, "pximg.net") {
        if let Some(rh) = ref_host.as_deref() {
            if is_domain_or_sub(rh, "pixiv.net") {
                return clean_referer;
            }
        }
        return "https://www.pixiv.net/".to_string();
    }
    if is_domain_or_sub(&target_host, "huaban.com") || is_domain_or_sub(&target_host, "huabanimg.com") {
        // gd-hbimg-edge.huaban.com 等图床子域绝不可作为 Referer，否则触发 EdgeOne HTTP 567
        if matches!(ref_host.as_deref(), Some("huaban.com" | "www.huaban.com")) {
            return clean_referer;
        }
        return "https://huaban.com/".to_string();
    }

    clean_referer
}

fn download_media_with_fallbacks(
    primary: &str,
    fallbacks: &[String],
    referer: &str,
) -> Result<(Vec<u8>, String, String), String> {
    download_media_with_fallbacks_limited_with_proxy(
        primary,
        fallbacks,
        referer,
        500 * 1024 * 1024,
        false,
        crate::security::detect_curl_proxy(),
    )
}

pub(crate) fn download_media_with_fallbacks_limited_with_proxy(
    primary: &str,
    fallbacks: &[String],
    referer: &str,
    max_bytes: usize,
    allow_loopback_test: bool,
    proxy: Option<String>,
) -> Result<(Vec<u8>, String, String), String> {
    let mut candidates: Vec<String> = Vec::new();
    for cand in std::iter::once(primary).chain(fallbacks.iter().map(String::as_str)) {
        let trimmed = cand.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !candidates.iter().any(|existing| existing == trimmed) {
            candidates.push(trimmed.to_string());
        }
        if candidates.len() >= 6 {
            break;
        }
    }
    if candidates.is_empty() {
        return Err("缺少有效下载地址".to_string());
    }
    let mut last_err = None;
    for url in candidates {
        match download_media_curl_limited_with_proxy(
            &url,
            referer,
            max_bytes,
            allow_loopback_test,
            proxy.clone(),
        ) {
            Ok((bytes, content_type)) => return Ok((bytes, content_type, url)),
            Err(err) => {
                last_err = Some(err);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| "下载采集资源失败".to_string()))
}

pub(crate) fn download_media_curl_limited(
    src: &str,
    referer: &str,
    max_bytes: usize,
    allow_loopback_test: bool,
) -> Result<(Vec<u8>, String), String> {
    let proxy = if allow_loopback_test {
        None
    } else {
        crate::security::detect_curl_proxy()
    };
    download_media_curl_limited_with_proxy(src, referer, max_bytes, allow_loopback_test, proxy)
}

fn download_media_curl_limited_with_proxy(
    src: &str,
    referer: &str,
    max_bytes: usize,
    allow_loopback_test: bool,
    proxy: Option<String>,
) -> Result<(Vec<u8>, String), String> {
    let proxy_enabled = proxy.is_some();
    let mut current = crate::security::validate_download_url(src, allow_loopback_test, proxy_enabled)?;
    let temp_root = std::env::temp_dir().join(format!("picnest_collect_{}", crate::security::random_hex(12)?));
    fs::create_dir(&temp_root).map_err(|e| format!("创建下载临时目录失败: {}", e))?;
    let _guard = defer_cleanup(&temp_root);
    let hdr_path = temp_root.join("headers.tmp");
    let body_path = temp_root.join("body.tmp");

    let ref_header = resolve_download_referer(&current, referer);

    let mut content_type = String::new();
    for _ in 0..6 {
        let addr = crate::security::resolve_download_address(&current, allow_loopback_test, proxy_enabled)?;
        let mut cmd = std::process::Command::new("curl.exe");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd.arg("-s")
            .arg("-S")
            .arg("--max-time")
            .arg("15")
            .arg("--max-filesize")
            .arg(max_bytes.to_string())
            .arg("-A")
            .arg("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0")
            .arg("-D")
            .arg(&hdr_path)
            .arg("-o")
            .arg(&body_path);
        for arg in crate::security::curl_args_for_url(&current, addr)? {
            cmd.arg(arg);
        }
        if let Some(proxy) = &proxy {
            cmd.arg("-x").arg(proxy);
        } else if allow_loopback_test {
            cmd.arg("--noproxy").arg("*");
        }
        if !ref_header.is_empty() {
            cmd.arg("-e").arg(&ref_header);
        }
        cmd.arg(current.as_str());

        let output = cmd.output().map_err(|e| format!("启动 curl 失败: {}", e))?;
        if !output.status.success() {
            let err_msg = String::from_utf8_lossy(&output.stderr);
            if output.status.code() == Some(63)
                || err_msg.contains("Maximum file size exceeded")
                || err_msg.contains("Exceeded the size limit")
            {
                return Err("文件超过采集大小上限".to_string());
            }
            return Err(format!("curl 下载失败 (code={:?}): {}", output.status.code(), err_msg));
        }

        let headers = fs::read_to_string(&hdr_path).map_err(|e| format!("读取响应头失败: {}", e))?;
        let mut status = None;
        let mut location = None;
        content_type.clear();
        for line in headers.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("HTTP/") {
                status = trimmed.split_whitespace().nth(1).and_then(|v| v.parse::<u16>().ok());
                location = None;
                content_type.clear();
            } else if let Some((k, v)) = trimmed.split_once(':') {
                if k.trim().eq_ignore_ascii_case("location") {
                    location = Some(v.trim().to_string());
                } else if k.trim().eq_ignore_ascii_case("content-type") {
                    content_type = v.trim().to_string();
                }
            }
        }
        let status = status.ok_or_else(|| "远程服务器未返回有效 HTTP 状态".to_string())?;
        if (300..400).contains(&status) {
            let location = location.ok_or_else(|| "重定向响应缺少 Location".to_string())?;
            current = current
                .join(&location)
                .map_err(|_| "重定向链接非法".to_string())?;
            crate::security::validate_download_url(current.as_str(), allow_loopback_test, proxy_enabled)?;
            continue;
        }
        if !(200..300).contains(&status) {
            return Err(format!("远程服务器返回 HTTP {}", status));
        }

        let file = File::open(&body_path).map_err(|e| format!("读取临时文件失败: {}", e))?;
        let mut bytes = Vec::new();
        file.take(max_bytes as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("读取下载文件失败: {}", e))?;
        if bytes.len() > max_bytes {
            return Err("文件超过采集大小上限".to_string());
        }
        if bytes.is_empty() {
            return Err("采集数据为空 (0 字节)".to_string());
        }
        let head = &bytes[..std::cmp::min(bytes.len(), 64)];
        let head_str = String::from_utf8_lossy(head).to_ascii_lowercase();
        if head_str.starts_with("<!doctype")
            || head_str.starts_with("<html")
            || head_str.starts_with("<?xml")
        {
            return Err("远程服务器返回了网页而非媒体流".to_string());
        }
        return Ok((bytes, content_type));
    }
    Err("下载重定向次数过多".to_string())
}

struct CleanGuard<'a> {
    dir: &'a Path,
}

impl<'a> Drop for CleanGuard<'a> {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.dir);
    }
}

fn defer_cleanup<'a>(dir: &'a Path) -> CleanGuard<'a> {
    CleanGuard { dir }
}

#[derive(Clone, serde::Serialize)]
pub struct RootItem {
    pub id: i64,
    pub name: String,
    pub path: String,
}

fn query_roots_result(conn: &rusqlite::Connection) -> Result<Vec<RootItem>, String> {
    let mut stmt = conn.prepare("SELECT id, path, COALESCE(display_name, '') FROM folders ORDER BY id ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| {
        let id: i64 = r.get(0)?;
        let path: String = r.get(1)?;
        let mut name: String = r.get(2)?;
        if name.trim().is_empty() {
            name = Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| format!("资料库 {}", id));
        }
        Ok(RootItem { id, name, path })
    }).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn canonicalize_within_root(root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|_| "资料库根目录物理路径不存在".to_string())?;
    let mut existing = candidate.to_path_buf();
    while !existing.exists() {
        let Some(parent) = existing.parent() else {
            return Err("目标存储路径越界（不在根文件范围内）".to_string());
        };
        existing = parent.to_path_buf();
    }
    let canonical = fs::canonicalize(&existing).map_err(|e| format!("解析目标路径失败: {}", e))?;
    if !canonical.starts_with(&root) {
        return Err("目标存储路径越界（不在根文件范围内）".to_string());
    }
    Ok(candidate.to_path_buf())
}

fn build_folder_tree(root_abs: &Path, rel: &str) -> Vec<serde_json::Value> {
    let current_dir = if rel.is_empty() {
        root_abs.to_path_buf()
    } else {
        root_abs.join(rel.replace('/', "\\"))
    };
    let entries = match fs::read_dir(&current_dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut dirs: Vec<String> = Vec::new();
    for entry in entries.filter_map(|e| e.ok()) {
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !ft.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.')
            || name.eq_ignore_ascii_case("thumbs.db")
            || name.eq_ignore_ascii_case("$recycle.bin")
            || name.eq_ignore_ascii_case(".picnest")
            || name.eq_ignore_ascii_case("desktop.ini")
        {
            continue;
        }
        dirs.push(name);
    }
    dirs.sort_by(|a, b| a.to_ascii_lowercase().cmp(&b.to_ascii_lowercase()));

    dirs.into_iter()
        .map(|dname| {
            let child_rel = if rel.is_empty() {
                dname.clone()
            } else {
                format!("{}/{}", rel, dname)
            };
            let children = build_folder_tree(root_abs, &child_rel);
            let parent_val = if rel.is_empty() {
                serde_json::Value::Null
            } else {
                json!(rel)
            };
            json!({
                "id": child_rel,
                "name": dname,
                "parent": parent_val,
                "children": children
            })
        })
        .collect()
}

fn check_duplicates(
    conn: &rusqlite::Connection,
    folder_id: i64,
    root_path: &Path,
    buf: &[u8],
) -> Vec<serde_json::Value> {
    let size = buf.len() as i64;
    let mut stmt = match conn.prepare(
        "SELECT file_path, width, height FROM images WHERE folder_id = ?1 AND size = ?2 AND deleted_at IS NULL LIMIT 8",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let rows: Vec<(String, i64, i64)> = match stmt.query_map(params![folder_id, size], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
    }) {
        Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
        Err(_) => return Vec::new(),
    };

    if rows.is_empty() {
        return Vec::new();
    }

    let target_md5 = match crate::importer::md5_digest_reader(std::io::Cursor::new(buf)) {
        Ok(m) => m,
        Err(_) => return Vec::new(),
    };

    let mut matches = Vec::new();
    let root_canon = fs::canonicalize(root_path).unwrap_or_else(|_| root_path.to_path_buf());

    for (file_path, width, height) in rows {
        let p = Path::new(&file_path);
        if !p.exists() {
            continue;
        }
        let Ok(f) = File::open(p) else { continue };
        let Ok(file_md5) = crate::importer::md5_digest_reader(f) else { continue };
        if file_md5.eq_ignore_ascii_case(&target_md5) {
            let mut folder_name = root_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "根目录".to_string());
            let p_canon = fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
            if let Ok(rel) = p_canon.strip_prefix(&root_canon) {
                if let Some(parent) = rel.parent() {
                    let parent_str = parent.to_string_lossy().replace('\\', "/");
                    if !parent_str.is_empty() {
                        folder_name = parent_str;
                    }
                }
            }
            let file_name = p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            matches.push(json!({
                "file_path": file_path,
                "file_name": file_name,
                "width": width,
                "height": height,
                "folder": folder_name
            }));
        }
    }

    matches
}

pub(crate) fn save_one_item(
    conn: &rusqlite::Connection,
    item: &serde_json::Value,
    app_handle: Option<&tauri::AppHandle>,
) -> Result<serde_json::Value, String> {
    save_one_item_direct(conn, item, app_handle)
}

pub(crate) fn save_one_item_direct(
    conn: &rusqlite::Connection,
    item: &serde_json::Value,
    app_handle: Option<&tauri::AppHandle>,
) -> Result<serde_json::Value, String> {
    let roots = query_roots_result(conn)?;
    if roots.is_empty() {
        return Err("图库中没有可用的资料库根目录".to_string());
    }

    let req_root_id = item.get("rootId").and_then(|v| v.as_i64());
    let active_root_id = get_active_collect_root();

    let root = roots
        .iter()
        .find(|r| Some(r.id) == req_root_id)
        .or_else(|| roots.iter().find(|r| Some(r.id) == active_root_id))
        .unwrap_or(&roots[0]);

    let raw_rel = item
        .get("rel")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .replace('\\', "/");
    let safe_rel = raw_rel.trim_matches('/').to_string();

    let root_path = PathBuf::from(&root.path);
    if !root_path.exists() {
        return Err("资料库根目录物理路径不存在".to_string());
    }

    let mut dest_dir = root_path.clone();
    if !safe_rel.is_empty() {
        for seg in safe_rel.split('/') {
            let s = seg.trim();
            if s.is_empty() || s == "." {
                continue;
            }
            if s == ".." {
                return Err("非法相对路径：禁止使用 ..".to_string());
            }
            dest_dir.push(sanitize_filename(s, "dir"));
        }
    }

    // 防逃逸安全检查
    canonicalize_within_root(&root_path, &dest_dir)?;

    fs::create_dir_all(&dest_dir).map_err(|e| format!("创建采集目录失败: {}", e))?;

    let kind = item
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("image");
    let src = item.get("src").and_then(|v| v.as_str()).unwrap_or("");
    let fallback_srcs: Vec<String> = item
        .get("fallbackSrcs")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::trim))
                .filter(|s| !s.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default();
    let data_url = item.get("dataUrl").and_then(|v| v.as_str()).unwrap_or("");
    let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("");
    let url = item.get("url").and_then(|v| v.as_str()).unwrap_or("");
    let referer = item.get("referer").and_then(|v| v.as_str()).unwrap_or("");
    let annotation = item
        .get("annotation")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let star = item.get("star").and_then(|v| v.as_bool()).unwrap_or(false);
    let overwrite = item
        .get("overwrite")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let force = item
        .get("force")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let (buf, content_type, matched_src): (Vec<u8>, String, String);

    if kind == "page" || kind == "screenshot" || (!data_url.is_empty() && src.is_empty()) {
        let (d_buf, d_ct) = parse_data_url(data_url)?;
        buf = d_buf;
        content_type = d_ct;
        matched_src = String::new();
    } else if !src.is_empty() {
        match download_media_with_fallbacks(
            src,
            &fallback_srcs,
            if referer.is_empty() { url } else { referer },
        ) {
            Ok((d_buf, d_ct, used_url)) => {
                buf = d_buf;
                content_type = d_ct;
                matched_src = used_url;
            }
            Err(e) => {
                if !data_url.is_empty() {
                    let (d_buf, d_ct) = parse_data_url(data_url)?;
                    buf = d_buf;
                    content_type = d_ct;
                    matched_src = String::new();
                } else {
                    return Err(format!("下载采集资源失败: {}", e));
                }
            }
        }
    } else if !data_url.is_empty() {
        let (d_buf, d_ct) = parse_data_url(data_url)?;
        buf = d_buf;
        content_type = d_ct;
        matched_src = String::new();
    } else {
        return Err("缺少待采集的数据源 (src 或 dataUrl)".to_string());
    }

    if buf.is_empty() {
        return Err("采集内容为空 (0 字节)".to_string());
    }

    // 查重比对
    let matches = if !force || overwrite {
        check_duplicates(conn, root.id, &root_path, &buf)
    } else {
        Vec::new()
    };

    if !matches.is_empty() && !overwrite && !force {
        return Ok(json!({
            "ok": false,
            "duplicate": true,
            "matches": matches,
            "rootId": root.id,
            "rel": safe_rel,
            "error": "已存在相同图片，未保存"
        }));
    }

    let ext_hint = if !matched_src.is_empty() {
        matched_src.as_str()
    } else if !src.is_empty() {
        src
    } else {
        data_url
    };
    let ext = guess_ext(&content_type, ext_hint);
    let fallback_name = if kind == "video" {
        "采集视频"
    } else if kind == "page" || kind == "screenshot" {
        "页面截图"
    } else {
        "采集图片"
    };
    let base_name = sanitize_filename(title, fallback_name);

    let mut dest_file = dest_dir.join(format!("{}{}", base_name, ext));
    let mut seq = 2;
    while dest_file.exists() {
        dest_file = dest_dir.join(format!("{} ({}){}", base_name, seq, ext));
        seq += 1;
    }

    let mut overwrite_paths: Vec<String> = Vec::new();
    if overwrite {
        let mut seen = std::collections::HashSet::new();
        for m in &matches {
            if let Some(old_fp) = m.get("file_path").and_then(|v| v.as_str()) {
                if seen.insert(old_fp.to_lowercase()) {
                    overwrite_paths.push(old_fp.to_string());
                }
            }
        }
    }
    if overwrite_paths.len() > 1 {
        return Err("覆盖操作存在多个重复文件，拒绝自动回收，请先人工确认".to_string());
    }
    let staged = crate::fs_ops::stage_write_new(&dest_file, &buf)?;
    let replacement_ids = if overwrite_paths.is_empty() {
        Vec::new()
    } else {
        match crate::operation_journal::begin_file_replacements(
            conn,
            &overwrite_paths.iter().map(String::as_str).collect::<Vec<_>>(),
            &staged,
        ) {
            Ok(ids) => ids,
            Err(error) => {
                let _ = crate::fs_ops::rollback_staged(&staged);
                return Err(error);
            }
        }
    };
    for old in &overwrite_paths {
        if Path::new(old).exists() {
            if let Err(e) = trash::delete(Path::new(old)) {
                let mut cleanup_errors = Vec::new();
                if let Err(error) = crate::fs_ops::rollback_staged(&staged) {
                    cleanup_errors.push(error);
                }
                for id in &replacement_ids {
                    let _ = crate::operation_journal::mark_manual(
                        conn,
                        *id,
                        &format!("{e}; 新文件回滚: {}", cleanup_errors.join("; ")),
                    );
                }
                return Err(format!("覆盖文件移入回收站失败: {e}; 回滚: {}", cleanup_errors.join("; ")));
            }
        }
    }
    let inspect_path = staged.temp_path.clone();

    let abs_file_str = dest_file.to_string_lossy().to_string();
    let file_name_str = dest_file
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| base_name.clone());

    let (mut width, mut height) = match image::image_dimensions(&inspect_path) {
        Ok((w, h)) => (w as i64, h as i64),
        Err(_) => (0i64, 0i64),
    };
    let ext_lower = ext.to_ascii_lowercase();
    let is_video = crate::commands::is_video_ext(&ext_lower);
    if (width == 0 || height == 0) && is_video {
        if let Some((vw, vh)) = crate::commands::extract_video_dims(&inspect_path) {
            width = vw as i64;
            height = vh as i64;
        }
    }

    let mut thumb_path_str = String::new();
    if let Some(data_dir) = COLLECTOR_DATA_DIR.get() {
        let thumbs_dir = data_dir.join("cache").join("thumbs");
        let _ = fs::create_dir_all(&thumbs_dir);
        let hash = format!("{:x}", crate::commands::fnv1a_hash(abs_file_str.as_bytes()));
        let thumb_path = thumbs_dir.join(format!("{}-q80.jpg", hash));
        if is_video {
            if crate::commands::extract_video_poster(&inspect_path, &thumb_path) {
                thumb_path_str = thumb_path.to_string_lossy().to_string();
            }
        }
    }

    let now_ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let file_size = buf.len() as i64;

    /* dir_rel 必须写：这个列是列表/计数/同步的统一口径。
       之前 INSERT 根本没带这一列，新采集的图落成 NULL ——
       计数 SQL 把 NULL 算进「未分类」，而列表 SQL 只认 `dir_rel = ''`，
       于是出现「徽章 1、列表 0」。
       口径：相对库根、正斜杠、小写（与其余 10798 行一致）。 */
    let dir_rel_value = dest_dir
        .strip_prefix(&root_path)
        .map(|p| p.to_string_lossy().replace('\\', "/").to_lowercase())
        .unwrap_or_default();
    let dir_rel_value = dir_rel_value.trim_matches('/').to_string();

    let mut overwritten = 0;
    crate::operation_journal::commit_new_files(
        conn,
        vec![(staged, json!({ "rootId": root.id, "finishOperationIds": replacement_ids }))],
        |tx, _files| {
            let changed = tx.execute(
                "INSERT INTO images (folder_id, file_path, size, mtime, width, height, annotation, url, is_favorite, thumbnail_path, dir_rel)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    root.id, abs_file_str, file_size, now_ts, width, height,
                    annotation, url, if star { 1 } else { 0 }, thumb_path_str, dir_rel_value
                ],
            ).map_err(|e| e.to_string())?;
            if changed != 1 {
                return Err("采集图片入库失败".to_string());
            }
            for old_fp in &overwrite_paths {
                let changed = tx.execute(
                    "DELETE FROM images WHERE file_path = ?1 AND deleted_at IS NULL",
                    [old_fp],
                ).map_err(|e| e.to_string())?;
                overwritten += changed;
            }
            Ok(())
        },
    )?;
    for old_fp in &overwrite_paths {
        if let Some(data_dir) = COLLECTOR_DATA_DIR.get() {
            crate::trash_ops::remove_thumbs_for(&data_dir.join("cache").join("thumbs"), old_fp);
        }
        if let Some(h) = app_handle {
            let _ = h.emit("sync-db", json!({ "type": "unlink", "path": old_fp }));
        }
    }

    if let Some(h) = app_handle {
        let _ = h.emit(
            "sync-db",
            json!({
                "type": "add",
                "image": {
                    "file_path": abs_file_str,
                    "file_name": file_name_str,
                    "file_size": file_size,
                    "modify_time": now_ts,
                    "thumbnail_path": thumb_path_str,
                    "width": width,
                    "height": height,
                    "is_favorite": if star { 1 } else { 0 }
                }
            }),
        );
        let _ = h.emit(
            "collect-saved",
            json!({
                "rootId": root.id,
                "rel": safe_rel,
                "filePath": abs_file_str
            }),
        );
    }

    Ok(json!({
        "ok": true,
        "saved": abs_file_str,
        "name": file_name_str,
        "rootId": root.id,
        "rel": safe_rel,
        "overwritten": overwritten
    }))
}

fn send_response(
    stream: &mut TcpStream,
    status_code: u16,
    status_text: &str,
    origin: Option<&str>,
    body: &[u8],
) {
    let allow_origin = origin
        .map(|value| format!("Access-Control-Allow-Origin: {}\r\n", value))
        .unwrap_or_default();
    let resp = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\n{}Vary: Origin\r\nAccess-Control-Allow-Methods: GET,POST,OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, X-PicNest-Token\r\nAccess-Control-Allow-Private-Network: true\r\nConnection: close\r\n\r\n",
        status_code,
        status_text,
        body.len(),
        allow_origin
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn send_json(stream: &mut TcpStream, status_code: u16, origin: Option<&str>, val: &serde_json::Value) {
    let body_str = serde_json::to_string(val).unwrap_or_else(|_| "{}".to_string());
    let status_text = match status_code {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "OK",
    };
    send_response(stream, status_code, status_text, origin, body_str.as_bytes());
}

fn handle_client(mut stream: TcpStream, expected_port: u16) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(15)));

    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });

    let mut request_line = String::new();
    if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
        return;
    }
    let parts: Vec<&str> = request_line.trim().split_whitespace().collect();
    if parts.len() < 2 {
        return;
    }
    let method = parts[0].to_uppercase();
    let uri = parts[1];

    let mut headers: HashMap<String, String> = HashMap::new();
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
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    let origin = headers.get("origin").cloned();
    let origin_str = origin.as_deref();

    if !headers.get("host").is_some_and(|host| {
        crate::security::validate_download_host_header(host, expected_port)
    }) {
        send_json(&mut stream, 403, origin_str, &json!({ "ok": false, "error": "host not allowed" }));
        return;
    }
    if let Some(o) = &origin
        && !crate::security::is_allowed_collector_origin(o)
    {
        send_json(&mut stream, 403, origin_str, &json!({ "ok": false, "error": "origin not allowed" }));
        return;
    }

    // CORS 预检
    if method == "OPTIONS" {
        send_response(&mut stream, 204, "No Content", origin_str, b"");
        return;
    }

    let (path, query) = uri.split_once('?').unwrap_or((uri, ""));

    // 1. GET /api/v1/ping (免 Token 校验)
    if method == "GET" && path == "/api/v1/ping" {
        send_json(
            &mut stream,
            200,
            origin_str,
            &json!({
                "ok": true,
                "app": "PicNest",
                "api": 1,
                "port": COLLECT_PORT,
                "auth": true
            }),
        );
        return;
    }

    // Token 校验
    let req_token = headers.get("x-picnest-token").cloned().unwrap_or_default();
    let valid_token = match get_token() {
        Ok(token) => token,
        Err(e) => {
            send_json(&mut stream, 500, origin_str, &json!({ "ok": false, "error": e }));
            return;
        }
    };
    if req_token.is_empty() || !crate::security::constant_time_eq(req_token.trim(), &valid_token) {
        send_json(
            &mut stream,
            401,
            origin_str,
            &json!({
                "ok": false,
                "error": "未授权：无效或缺失的采集密钥 (X-PicNest-Token)"
            }),
        );
        return;
    }

    let db_path = match COLLECTOR_DB_PATH.get() {
        Some(p) => p,
        None => {
            send_json(
                &mut stream,
                500,
                origin_str,
                &json!({ "ok": false, "error": "数据库未就绪" }),
            );
            return;
        }
    };

    let conn = match crate::db::open_conn_with_pragmas(db_path) {
        Ok(c) => c,
        Err(e) => {
            send_json(
                &mut stream,
                500,
                origin_str,
                &json!({ "ok": false, "error": e.to_string() }),
            );
            return;
        }
    };

    // 2. GET /api/v1/context
    if method == "GET" && path == "/api/v1/context" {
        let roots = match query_roots_result(&conn) {
            Ok(roots) => roots,
            Err(e) => {
                send_json(&mut stream, 500, origin_str, &json!({ "ok": false, "error": e }));
                return;
            }
        };
        let req_root_id = query_param(query, "rootId").and_then(|v| v.parse::<i64>().ok());
        let active_id = get_active_collect_root();

        let cur = roots
            .iter()
            .find(|r| Some(r.id) == req_root_id)
            .or_else(|| roots.iter().find(|r| Some(r.id) == active_id))
            .or_else(|| roots.first());

        send_json(
            &mut stream,
            200,
            origin_str,
            &json!({
                "ok": true,
                "roots": roots,
                "rootId": cur.map(|r| r.id),
                "rootName": cur.map(|r| r.name.clone()).unwrap_or_default()
            }),
        );
        return;
    }

    // 3. GET /api/v1/folders
    if method == "GET" && path == "/api/v1/folders" {
        let roots = match query_roots_result(&conn) {
            Ok(roots) => roots,
            Err(e) => {
                send_json(&mut stream, 500, origin_str, &json!({ "ok": false, "error": e }));
                return;
            }
        };
        let req_root_id = query_param(query, "rootId").and_then(|v| v.parse::<i64>().ok());
        let active_id = get_active_collect_root();

        let cur = roots
            .iter()
            .find(|r| Some(r.id) == req_root_id)
            .or_else(|| roots.iter().find(|r| Some(r.id) == active_id))
            .or_else(|| roots.first());

        let Some(root) = cur else {
            send_json(
                &mut stream,
                404,
                origin_str,
                &json!({ "ok": false, "error": "没有可用的图库根目录" }),
            );
            return;
        };

        let folders = build_folder_tree(Path::new(&root.path), "");
        send_json(
            &mut stream,
            200,
            origin_str,
            &json!({
                "ok": true,
                "root": root,
                "folders": folders
            }),
        );
        return;
    }


    // 针对 POST 请求，读取 Body
    let body_len: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if body_len > 100 * 1024 * 1024 {
        send_json(
            &mut stream,
            400,
            origin_str,
            &json!({ "ok": false, "error": "请求体过大 (>100MB)" }),
        );
        return;
    }
    let mut body_bytes = vec![0u8; body_len];
    if body_len > 0 {
        if let Err(e) = reader.read_exact(&mut body_bytes) {
            send_json(
                &mut stream,
                400,
                origin_str,
                &json!({ "ok": false, "error": format!("读取请求体失败: {}", e) }),
            );
            return;
        }
    }

    let json_body: serde_json::Value = if body_len > 0 {
        match serde_json::from_slice(&body_bytes) {
            Ok(v) => v,
            Err(e) => {
                send_json(
                    &mut stream,
                    400,
                    origin_str,
                    &json!({ "ok": false, "error": format!("JSON 解析失败: {}", e) }),
                );
                return;
            }
        }
    } else {
        json!({})
    };

    // 4. POST /api/v1/folder/create
    if method == "POST" && path == "/api/v1/folder/create" {
        let roots = match query_roots_result(&conn) {
            Ok(roots) => roots,
            Err(e) => {
                send_json(&mut stream, 500, origin_str, &json!({ "ok": false, "error": e }));
                return;
            }
        };
        let req_root_id = json_body.get("rootId").and_then(|v| v.as_i64());
        let active_id = get_active_collect_root();

        let cur = roots
            .iter()
            .find(|r| Some(r.id) == req_root_id)
            .or_else(|| roots.iter().find(|r| Some(r.id) == active_id))
            .or_else(|| roots.first());

        let Some(root) = cur else {
            send_json(
                &mut stream,
                404,
                origin_str,
                &json!({ "ok": false, "error": "没有可用的图库根目录" }),
            );
            return;
        };

        let parent_rel = json_body
            .get("parentRel")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .replace('\\', "/");
        let parent_safe = parent_rel.trim_matches('/').to_string();

        let raw_name = json_body.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let safe_name = sanitize_filename(raw_name, "新建文件夹");

        let mut dest_dir = PathBuf::from(&root.path);
        if !parent_safe.is_empty() {
            for seg in parent_safe.split('/') {
                let s = seg.trim();
                if s.is_empty() || s == "." {
                    continue;
                }
                if s == ".." {
                    send_json(
                        &mut stream,
                        400,
                        origin_str,
                        &json!({ "ok": false, "error": "非法父目录路径" }),
                    );
                    return;
                }
                dest_dir.push(sanitize_filename(s, "dir"));
            }
        }

        let mut final_dir = dest_dir.join(&safe_name);
        let mut n = 2;
        while final_dir.exists() {
            final_dir = dest_dir.join(format!("{} ({})", safe_name, n));
            n += 1;
        }
        if canonicalize_within_root(Path::new(&root.path), &dest_dir).is_err()
            || canonicalize_within_root(Path::new(&root.path), &final_dir).is_err()
        {
            send_json(&mut stream, 400, origin_str, &json!({ "ok": false, "error": "目标路径越界" }));
            return;
        }

        if let Err(e) = fs::create_dir_all(&final_dir) {
            send_json(
                &mut stream,
                500,
                origin_str,
                &json!({ "ok": false, "error": format!("创建文件夹失败: {}", e) }),
            );
            return;
        }

        let final_name = final_dir
            .file_name()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or(safe_name);
        let rel = if parent_safe.is_empty() {
            final_name.clone()
        } else {
            format!("{}/{}", parent_safe, final_name)
        };

        if let Some(h) = COLLECTOR_APP_HANDLE.get() {
            let _ = h.emit(
                "sync-db",
                json!({
                    "type": "dirs-changed",
                    "rootId": root.id,
                    "rel": rel
                }),
            );
        }

        send_json(
            &mut stream,
            200,
            origin_str,
            &json!({
                "ok": true,
                "folder": {
                    "id": rel,
                    "name": final_name,
                    "parent": if parent_safe.is_empty() { serde_json::Value::Null } else { json!(parent_safe) }
                }
            }),
        );
        return;
    }

    // 5. POST /api/v1/save
    if method == "POST" && path == "/api/v1/save" {
        let items: Vec<serde_json::Value> = if let Some(arr) = json_body.get("items").and_then(|v| v.as_array()) {
            arr.clone()
        } else {
            vec![json_body]
        };

        let app_handle = COLLECTOR_APP_HANDLE.get();
        let mut results = Vec::new();

        for it in &items {
            match save_one_item(&conn, it, app_handle) {
                Ok(r) => results.push(r),
                Err(err_msg) => results.push(json!({
                    "ok": false,
                    "error": err_msg
                })),
            }
        }

        let all_ok = results.iter().all(|r| r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));
        let dup = results.iter().find(|r| r.get("duplicate").and_then(|v| v.as_bool()).unwrap_or(false));

        let mut payload = json!({
            "ok": all_ok,
            "saved": results,
            "count": results.len()
        });

        if let Some(d) = dup {
            if let Some(obj) = payload.as_object_mut() {
                obj.insert("duplicate".to_string(), json!(true));
                if let Some(m) = d.get("matches") {
                    obj.insert("matches".to_string(), m.clone());
                }
                if let Some(r_id) = d.get("rootId") {
                    obj.insert("rootId".to_string(), r_id.clone());
                }
                if let Some(rel) = d.get("rel") {
                    obj.insert("rel".to_string(), rel.clone());
                }
                if let Some(err) = d.get("error") {
                    obj.insert("error".to_string(), err.clone());
                }
            }
        }

        send_json(&mut stream, 200, origin_str, &payload);
        return;
    }

    send_json(
        &mut stream,
        404,
        origin_str,
        &json!({ "ok": false, "error": "not found" }),
    );
}

pub fn start_collector_server(data_dir: PathBuf, db_path: PathBuf, app_handle: tauri::AppHandle) {
    let _ = COLLECTOR_DATA_DIR.set(data_dir);
    let _ = COLLECTOR_DB_PATH.set(db_path);
    let _ = COLLECTOR_APP_HANDLE.set(app_handle);

    std::thread::spawn(move || {
        let addr = format!("127.0.0.1:{}", COLLECT_PORT);
        let listener = match TcpListener::bind(&addr) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[collector] 监听 127.0.0.1:{} 失败: {}", COLLECT_PORT, e);
                return;
            }
        };

        for stream in listener.incoming() {
            match stream {
                Ok(s) => {
                    std::thread::spawn(move || {
                        handle_client(s, COLLECT_PORT);
                    });
                }
                Err(_) => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_collector_pipeline_and_endpoints() {
        let tmp = crate::testutil::TempDir::new("picnest_collector_test");

        let data_dir = tmp.join("data");
        let root_dir = tmp.join("photos");
        fs::create_dir_all(&data_dir).unwrap();
        fs::create_dir_all(&root_dir).unwrap();

        let _ = COLLECTOR_DATA_DIR.set(data_dir.clone());
        let _ = COLLECTOR_DB_PATH.set(data_dir.join("test.db"));
        let token = get_token().unwrap();
        assert_eq!(token.len(), 32);

        let db_path = data_dir.join("test.db");
        let conn = crate::db::init_db(&db_path).unwrap();
        conn.execute(
            "INSERT INTO folders (path, display_name) VALUES (?1, '测试根库')",
            [root_dir.to_string_lossy().to_string()],
        )
        .unwrap();
        let fid = conn.last_insert_rowid();

        // 1. 测试 Token 生成与重置
        let new_token = reset_token().unwrap();
        assert_eq!(new_token.len(), 32);
        assert_ne!(token, new_token);
        assert_eq!(get_token().unwrap(), new_token);

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            for _ in 0..5 {
                let stream = accept_with_timeout(&listener, Duration::from_secs(5)).unwrap();
                handle_client(stream, port);
            }
        });
        let valid_host = format!("127.0.0.1:{}", port);
        let token_header = format!("X-PicNest-Token: {}\r\n", new_token);
        let send = |target: &str, host: &str, headers: &str| -> String {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
            write!(
                stream,
                "GET {} HTTP/1.1\r\nHost: {}\r\n{}Connection: close\r\n\r\n",
                target, host, headers
            )
            .unwrap();
            stream.flush().unwrap();
            read_response(&mut stream)
        };

        let missing_token = send("/api/v1/context", &valid_host, "");
        assert_eq!(missing_token.split_whitespace().nth(1), Some("401"));
        assert!(!missing_token.contains("Access-Control-Allow-Origin:"));
        let query_token = send(
            &format!("/api/v1/context?token={}", new_token),
            &valid_host,
            "",
        );
        assert_eq!(query_token.split_whitespace().nth(1), Some("401"));
        let invalid_origin = send(
            "/api/v1/context",
            &valid_host,
            &format!("Origin: https://evil.example\r\n{}", token_header),
        );
        assert_eq!(invalid_origin.split_whitespace().nth(1), Some("403"));
        let invalid_host = send(
            "/api/v1/context",
            &format!("127.0.0.1:{}", port + 1),
            &token_header,
        );
        assert_eq!(invalid_host.split_whitespace().nth(1), Some("403"));
        let authorized = send("/api/v1/context", &valid_host, &token_header);
        assert_eq!(authorized.split_whitespace().nth(1), Some("200"));
        server.join().unwrap();

        // 2. 测试 save_one_item (base64 写入)
        // 1x1 透明 PNG base64
        let base64_png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        let item1 = json!({
            "rootId": fid,
            "rel": "",
            "title": "测试图片",
            "dataUrl": base64_png,
            "url": "https://example.com/art/1",
            "annotation": "采集测试备注",
            "star": true
        });

        let r1 = save_one_item(&conn, &item1, None).unwrap();
        assert_eq!(r1["ok"], true);
        assert_eq!(r1["name"], "测试图片.png");
        let saved_path = PathBuf::from(r1["saved"].as_str().unwrap());
        assert!(saved_path.exists());
        assert_eq!(fs::read(&saved_path).unwrap().len(), 68);

        // 3. 验证查重拦截：再次保存相同图片，应该返回 duplicate: true
        let item2 = json!({
            "rootId": fid,
            "rel": "",
            "title": "测试图片重复",
            "dataUrl": base64_png
        });
        let r2 = save_one_item(&conn, &item2, None).unwrap();
        assert_eq!(r2["ok"], false);
        assert_eq!(r2["duplicate"], true);

        // 4. 验证 overwrite: true 覆盖模式
        let item3 = json!({
            "rootId": fid,
            "rel": "",
            "title": "覆盖写入",
            "dataUrl": base64_png,
            "overwrite": true
        });
        let r3 = save_one_item(&conn, &item3, None).unwrap();
        assert_eq!(r3["ok"], true);
        assert_eq!(r3["overwritten"], 1);

        // 5. 验证目录树构建与清理
        let sub1 = root_dir.join("插画");
        let sub2 = sub1.join("风景");
        let junk = root_dir.join(".hidden");
        fs::create_dir_all(&sub2).unwrap();
        fs::create_dir_all(&junk).unwrap();

        let tree = build_folder_tree(&root_dir, "");
        assert_eq!(tree.len(), 1); // 忽略了 .hidden
        assert_eq!(tree[0]["name"], "插画");
        assert_eq!(tree[0]["children"].as_array().unwrap().len(), 1);
        assert_eq!(tree[0]["children"][0]["name"], "风景");

        let _ = trash::delete(&tmp);
    }

    #[cfg(windows)]
    #[test]
    fn collector_paths_reject_junction_escape() {
        let tmp = crate::testutil::TempDir::new("picnest_collector_junction");
        let root = tmp.join("library");
        let outside = tmp.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
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
        assert!(canonicalize_within_root(&root, &root.join("new").join("folder")).is_ok());
        assert!(canonicalize_within_root(&root, &outside).is_err());
        assert!(canonicalize_within_root(&root, &junction.join("new")).is_err());
    }

    fn accept_with_timeout(
        listener: &TcpListener,
        timeout: Duration,
    ) -> Result<TcpStream, std::io::Error> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            match listener.accept() {
                Ok((stream, _)) => return Ok(stream),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if std::time::Instant::now() >= deadline {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            "mock server 未在超时时间内收到连接",
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => return Err(error),
            }
        }
    }

    #[test]
    fn accept_timeout_returns_instead_of_blocking() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let error = accept_with_timeout(&listener, Duration::from_millis(20)).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
    }

    fn read_response(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut response = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            match stream.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => response.extend_from_slice(&buffer[..count]),
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::ConnectionReset
                            | std::io::ErrorKind::ConnectionAborted
                            | std::io::ErrorKind::TimedOut
                            | std::io::ErrorKind::WouldBlock
                    ) => break,
                Err(error) => panic!("读取测试响应失败: {}", error),
            }
        }
        String::from_utf8_lossy(&response).into_owned()
    }

    fn mock_server(response: &'static [u8]) -> (u16, std::thread::JoinHandle<Result<String, String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let mut stream = accept_with_timeout(&listener, Duration::from_secs(5))
                .map_err(|error| error.to_string())?;
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .map_err(|error| error.to_string())?;
            stream
                .set_write_timeout(Some(Duration::from_secs(5)))
                .map_err(|error| error.to_string())?;
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            let mut line = String::new();
            loop {
                line.clear();
                if reader.read_line(&mut line).map_err(|error| error.to_string())? == 0 {
                    break;
                }
                request.push_str(&line);
                if line == "\r\n" {
                    break;
                }
            }
            stream.write_all(response).map_err(|error| error.to_string())?;
            stream.flush().map_err(|error| error.to_string())?;
            Ok(request)
        });
        (port, server)
    }

    #[test]
    fn download_tests_allow_loopback_only_for_mock_server() {
        let response = b"HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\nConnection: close\r\n\r\n\xff\xd8\xff\xd9" as &[u8];
        let (port, server) = mock_server(response);
        let (bytes, content_type) = download_media_curl_limited(
            &format!("http://127.0.0.1:{}/image.jpg", port),
            "https://example.com/\r\nX-Injected: yes",
            1024,
            true,
        )
        .unwrap();
        assert_eq!(bytes, b"\xff\xd8\xff\xd9");
        assert_eq!(content_type, "image/jpeg");
        let request = server.join().unwrap().unwrap();
        assert!(!request.contains("\r\nX-Injected: yes"));
        assert!(download_media_curl_limited(
            &format!("http://127.0.0.1:{}/image.jpg", port),
            "",
            1024,
            false,
        )
        .is_err());
    }

    #[test]
    fn download_rejects_redirect_to_private_address_and_oversize_body() {
        let redirect = b"HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/latest/meta-data\r\nContent-Length: 0\r\nConnection: close\r\n\r\n" as &[u8];
        let (port, server) = mock_server(redirect);
        let error = download_media_curl_limited(
            &format!("http://127.0.0.1:{}/image", port),
            "",
            1024,
            true,
        )
        .unwrap_err();
        assert!(error.contains("禁止采集内网、回环或链路本地地址"), "{error}");
        server.join().unwrap().unwrap();

        let oversized = b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 1024\r\nConnection: close\r\n\r\n" as &[u8];
        let (port, server) = mock_server(oversized);
        let error = download_media_curl_limited(
            &format!("http://127.0.0.1:{}/image.png", port),
            "",
            16,
            true,
        )
        .unwrap_err();
        assert_eq!(error, "文件超过采集大小上限");
        server.join().unwrap().unwrap();
    }

    #[test]
    fn download_uses_explicit_proxy_without_resolving_target() {
        let response = b"HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\nConnection: close\r\n\r\n\xff\xd8\xff\xd9" as &[u8];
        let (proxy_port, server) = mock_server(response);
        let target = "http://images.example.invalid/image.jpg";
        let (bytes, content_type) = download_media_curl_limited_with_proxy(
            target,
            "",
            1024,
            true,
            Some(format!("http://127.0.0.1:{}", proxy_port)),
        )
        .unwrap();
        assert_eq!(bytes, b"\xff\xd8\xff\xd9");
        assert_eq!(content_type, "image/jpeg");
        let request = server.join().unwrap().unwrap();
        assert!(request.starts_with(&format!("GET {} HTTP/1.1\r\n", target)));
        assert!(request.contains("Host: images.example.invalid\r\n"));
    }

    #[test]
    fn proxy_download_rejects_private_redirect_target() {
        let redirect = b"HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/latest/meta-data\r\nContent-Length: 0\r\nConnection: close\r\n\r\n" as &[u8];
        let (proxy_port, server) = mock_server(redirect);
        let error = download_media_curl_limited_with_proxy(
            "http://images.example.invalid/image",
            "",
            1024,
            false,
            Some(format!("http://127.0.0.1:{}", proxy_port)),
        )
        .unwrap_err();
        assert!(error.contains("禁止采集内网、回环或链路本地地址"), "{error}");
        server.join().unwrap().unwrap();
    }

    #[test]
    fn collector_sql_failure_removes_staged_final_file_and_journal() {
        let dir = crate::testutil::TempDir::new("picnest_collector_fault");
        let root = dir.join("library");
        std::fs::create_dir_all(&root).unwrap();
        let conn = crate::db::init_db(&dir.join("test.db")).unwrap();
        conn.execute("INSERT INTO folders (path) VALUES (?1)", [root.to_string_lossy().to_string()]).unwrap();
        let root_id = conn.last_insert_rowid();
        conn.execute_batch("CREATE TRIGGER reject_collector BEFORE INSERT ON images BEGIN SELECT RAISE(ABORT, 'injected collector failure'); END;").unwrap();
        let item = json!({
            "rootId": root_id,
            "kind": "screenshot",
            "title": "fault",
            "dataUrl": "data:text/plain;base64,cGF5bG9hZA=="
        });
        let error = save_one_item_direct(&conn, &item, None).unwrap_err();
        assert!(error.contains("injected collector failure"), "{error}");
        assert!(!root.join("fault.txt").exists());
        assert!(!std::fs::read_dir(&root).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with(".picnest-part-")));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM picnest_operations", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn resolve_download_referer_normalizes_huaban_pixiv_pinterest_and_generic() {
        let hb_img = url::Url::parse("https://gd-hbimg-edge.huaban.com/abc_fw240webp?auth_key=1").unwrap();
        assert_eq!(resolve_download_referer(&hb_img, ""), "https://huaban.com/");
        assert_eq!(
            resolve_download_referer(&hb_img, "https://www.pinterest.com/pin/7058355788/"),
            "https://huaban.com/"
        );
        assert_eq!(
            resolve_download_referer(&hb_img, "https://gd-hbimg-edge.huaban.com/"),
            "https://huaban.com/"
        );
        assert_eq!(
            resolve_download_referer(&hb_img, "https://huaban.com/pins/7274155613"),
            "https://huaban.com/pins/7274155613"
        );
        assert_eq!(
            resolve_download_referer(&hb_img, "https://www.huaban.com/discovery"),
            "https://www.huaban.com/discovery"
        );

        let px_img = url::Url::parse("https://i.pximg.net/img-original/img/2026/01/01/00/00/00/123_p0.png").unwrap();
        assert_eq!(resolve_download_referer(&px_img, ""), "https://www.pixiv.net/");
        assert_eq!(
            resolve_download_referer(&px_img, "https://www.pixiv.net/artworks/123"),
            "https://www.pixiv.net/artworks/123"
        );

        let pin_img = url::Url::parse("https://i.pinimg.com/originals/ab/cd/ef.jpg").unwrap();
        assert_eq!(
            resolve_download_referer(&pin_img, "https://example.com/"),
            "https://www.pinterest.com/"
        );

        let generic = url::Url::parse("https://cdn.example.com/a.jpg").unwrap();
        assert_eq!(resolve_download_referer(&generic, ""), "");
        assert_eq!(
            resolve_download_referer(&generic, "https://example.com/post/1"),
            "https://example.com/post/1"
        );
    }

    #[test]
    fn download_reports_http_status_falls_back_and_omits_empty_referer() {
        let err_567 = b"HTTP/1.1 567 Unknown Status\r\nContent-Length: 0\r\nConnection: close\r\n\r\n" as &[u8];
        let (port_567, server_567) = mock_server(err_567);
        let err = download_media_curl_limited(
            &format!("http://127.0.0.1:{}/img.webp", port_567),
            "",
            1024,
            true,
        )
        .unwrap_err();
        assert!(err.contains("HTTP 567"), "{err}");
        let req_567 = server_567.join().unwrap().unwrap();
        let has_referer = req_567
            .lines()
            .any(|line| line.to_ascii_lowercase().starts_with("referer:"));
        assert!(!has_referer, "空 referer 不应伪造请求头: {req_567}");

        let err_404 = b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n" as &[u8];
        let ok_200 = b"HTTP/1.1 200 OK\r\nContent-Type: image/webp\r\nContent-Length: 4\r\nConnection: close\r\n\r\nRIFF" as &[u8];
        let (p1, s1) = mock_server(err_404);
        let (p2, s2) = mock_server(ok_200);
        let u1 = format!("http://127.0.0.1:{}/orig.png", p1);
        let u2 = format!("http://127.0.0.1:{}/fallback.webp", p2);
        let (bytes, ct, used) = download_media_with_fallbacks_limited_with_proxy(
            &u1,
            &[u2.clone()],
            "",
            1024,
            true,
            None,
        )
        .unwrap();
        assert_eq!(bytes, b"RIFF");
        assert_eq!(ct, "image/webp");
        assert_eq!(used, u2);
        s1.join().unwrap().unwrap();
        s2.join().unwrap().unwrap();
    }
}

