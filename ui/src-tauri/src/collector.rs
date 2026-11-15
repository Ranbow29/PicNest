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

pub fn get_token() -> String {
    let Some(data_dir) = COLLECTOR_DATA_DIR.get() else {
        return "picnest-token-fallback".to_string();
    };
    let token_file = data_dir.join("collect_token.txt");
    if let Ok(content) = fs::read_to_string(&token_file) {
        let trimmed = content.trim();
        if trimmed.len() >= 16 && trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
            return trimmed.to_string();
        }
    }
    reset_token()
}

pub fn reset_token() -> String {
    let Some(data_dir) = COLLECTOR_DATA_DIR.get() else {
        return "picnest-token-fallback".to_string();
    };
    let _ = fs::create_dir_all(data_dir);
    let token_file = data_dir.join("collect_token.txt");

    // 生成高质量 32 位 hex 密钥
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let pid = std::process::id();
    let p1 = (now ^ 0x5bf03635) as u64;
    let p2 = ((now >> 64) ^ (pid as u128) ^ 0xa5a5a5a5) as u64;
    let token = format!("{:016x}{:016x}", p1, p2);

    let _ = fs::write(&token_file, &token);
    token
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

fn download_media_curl(src: &str, referer: &str) -> Result<(Vec<u8>, String), String> {
    if !src.starts_with("http://") && !src.starts_with("https://") {
        return Err("仅支持 http 或 https 链接".to_string());
    }

    let temp_dir = std::env::temp_dir();
    let tick = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let hdr_path = temp_dir.join(format!("picnest_hdr_{}.tmp", tick));
    let body_path = temp_dir.join(format!("picnest_body_{}.tmp", tick));

    let is_pin = src.to_ascii_lowercase().contains("pinimg.com");
    let ref_header = if is_pin {
        "https://www.pinterest.com/".to_string()
    } else if !referer.trim().is_empty() {
        referer.trim().to_string()
    } else if let Some(idx) = src.find("://") {
        let after = &src[idx + 3..];
        if let Some(slash) = after.find('/') {
            format!("{}/", &src[..idx + 3 + slash])
        } else {
            format!("{}/", src)
        }
    } else {
        "".to_string()
    };

    let mut cmd = std::process::Command::new("curl.exe");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.arg("-s")
        .arg("-S")
        .arg("-L")
        .arg("--max-time")
        .arg("15")
        .arg("-A")
        .arg("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0")
        .arg("-D")
        .arg(&hdr_path)
        .arg("-o")
        .arg(&body_path);

    if !ref_header.is_empty() {
        cmd.arg("-e").arg(&ref_header);
    }
    cmd.arg(src);

    let output = cmd.output().map_err(|e| format!("启动 curl 失败: {}", e))?;

    let _guard = defer_cleanup(&hdr_path, &body_path);

    if !output.status.success() {
        let err_msg = String::from_utf8_lossy(&output.stderr);
        return Err(format!("curl 下载失败 (code={:?}): {}", output.status.code(), err_msg));
    }

    // 检查 HTTP 状态码和 Content-Type
    let mut status_ok = false;
    let mut content_type = String::new();
    if let Ok(hdr_str) = fs::read_to_string(&hdr_path) {
        for line in hdr_str.lines() {
            let t = line.trim();
            if t.starts_with("HTTP/") {
                if let Some(code_part) = t.split_whitespace().nth(1) {
                    if let Ok(code) = code_part.parse::<u16>() {
                        status_ok = (200..=299).contains(&code);
                    }
                }
            } else if let Some((k, v)) = t.split_once(':') {
                if k.trim().eq_ignore_ascii_case("content-type") {
                    content_type = v.trim().to_string();
                }
            }
        }
    }

    if !status_ok {
        return Err("远程服务器返回非 200 响应".to_string());
    }

    let bytes = fs::read(&body_path).map_err(|e| format!("读取临时文件失败: {}", e))?;
    if bytes.is_empty() {
        return Err("采集数据为空 (0 字节)".to_string());
    }
    if bytes.len() > 500 * 1024 * 1024 {
        return Err("文件过大 (>500MB)".to_string());
    }

    // 防御性校验：远程网页拦截（如 B 站防盗链/登录跳转 HTML）
    let head = &bytes[..std::cmp::min(bytes.len(), 64)];
    let head_str = String::from_utf8_lossy(head).to_ascii_lowercase();
    if head_str.starts_with("<!doctype")
        || head_str.starts_with("<html")
        || head_str.starts_with("<?xml")
    {
        return Err("远程服务器返回了网页而非媒体流".to_string());
    }

    Ok((bytes, content_type))
}

struct CleanGuard<'a> {
    p1: &'a Path,
    p2: &'a Path,
}

impl<'a> Drop for CleanGuard<'a> {
    fn drop(&mut self) {
        let _ = fs::remove_file(self.p1);
        let _ = fs::remove_file(self.p2);
    }
}

fn defer_cleanup<'a>(p1: &'a Path, p2: &'a Path) -> CleanGuard<'a> {
    CleanGuard { p1, p2 }
}

#[derive(Clone, serde::Serialize)]
pub struct RootItem {
    pub id: i64,
    pub name: String,
    pub path: String,
}

fn query_roots(conn: &rusqlite::Connection) -> Vec<RootItem> {
    let mut stmt = match conn.prepare("SELECT id, path, COALESCE(display_name, '') FROM folders ORDER BY id ASC") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
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
    });
    match rows {
        Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    }
}

fn safe_canonicalize(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
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
    let root_canon = safe_canonicalize(root_path);

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
            let p_canon = safe_canonicalize(p);
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
    let roots = query_roots(conn);
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
    let root_canon = safe_canonicalize(&root_path);
    let dest_canon = safe_canonicalize(&dest_dir);
    if !dest_canon.starts_with(&root_canon) {
        return Err("目标存储路径越界（不在根文件范围内）".to_string());
    }

    let _ = fs::create_dir_all(&dest_dir);

    let kind = item
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("image");
    let src = item.get("src").and_then(|v| v.as_str()).unwrap_or("");
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

    let mut buf: Vec<u8> = Vec::new();
    let mut content_type = String::new();

    if kind == "page" || kind == "screenshot" || (!data_url.is_empty() && src.is_empty()) {
        let (d_buf, d_ct) = parse_data_url(data_url)?;
        buf = d_buf;
        content_type = d_ct;
    } else if !src.is_empty() {
        match download_media_curl(src, if referer.is_empty() { url } else { referer }) {
            Ok((d_buf, d_ct)) => {
                buf = d_buf;
                content_type = d_ct;
            }
            Err(e) => {
                if !data_url.is_empty() {
                    let (d_buf, d_ct) = parse_data_url(data_url)?;
                    buf = d_buf;
                    content_type = d_ct;
                } else {
                    return Err(format!("下载采集资源失败: {}", e));
                }
            }
        }
    } else if !data_url.is_empty() {
        let (d_buf, d_ct) = parse_data_url(data_url)?;
        buf = d_buf;
        content_type = d_ct;
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

    let ext = guess_ext(&content_type, if src.is_empty() { data_url } else { src });
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

    fs::write(&dest_file, &buf).map_err(|e| format!("写入磁盘失败: {}", e))?;

    let abs_file_str = dest_file.to_string_lossy().to_string();
    let file_name_str = dest_file
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| base_name.clone());

    let (mut width, mut height) = match image::image_dimensions(&dest_file) {
        Ok((w, h)) => (w as i64, h as i64),
        Err(_) => (0i64, 0i64),
    };
    let ext_lower = ext.to_ascii_lowercase();
    let is_video = crate::commands::is_video_ext(&ext_lower);
    if (width == 0 || height == 0) && is_video {
        if let Some((vw, vh)) = crate::commands::extract_video_dims(&dest_file) {
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
            if crate::commands::extract_video_poster(&dest_file, &thumb_path) {
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

    let _ = conn.execute(
        "INSERT INTO images (folder_id, file_path, size, mtime, width, height, annotation, url, is_favorite, thumbnail_path, dir_rel)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(file_path) DO UPDATE SET
            folder_id = ?1, size = ?3, mtime = ?4, width = ?5, height = ?6,
            annotation = ?7, url = ?8, is_favorite = MAX(is_favorite, ?9),
            thumbnail_path = COALESCE(NULLIF(?10, ''), thumbnail_path),
            dir_rel = ?11,
            deleted_at = NULL, trash_group = NULL",
        params![
            root.id,
            abs_file_str,
            file_size,
            now_ts,
            width,
            height,
            annotation,
            url,
            if star { 1 } else { 0 },
            thumb_path_str,
            dir_rel_value
        ],
    );

    // 覆盖模式下软删旧图片
    let mut overwritten = 0;
    if overwrite && !matches.is_empty() {
        for m in &matches {
            if let Some(old_fp) = m.get("file_path").and_then(|v| v.as_str()) {
                if let Ok(c) = conn.execute(
                    "UPDATE images SET deleted_at = ?1, trash_group = NULL WHERE file_path = ?2 AND deleted_at IS NULL",
                    params![now_ts, old_fp],
                ) {
                    if c > 0 {
                        overwritten += c;
                        if let Some(h) = app_handle {
                            let _ = h.emit(
                                "sync-db",
                                json!({
                                    "type": "unlink",
                                    "path": old_fp
                                }),
                            );
                        }
                    }
                }
            }
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
    let resp = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: {}\r\nVary: Origin\r\nAccess-Control-Allow-Methods: GET,POST,OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, X-PicNest-Token\r\nAccess-Control-Allow-Private-Network: true\r\nConnection: close\r\n\r\n",
        status_code,
        status_text,
        body.len(),
        origin.unwrap_or("*")
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

fn handle_client(mut stream: TcpStream) {
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

    // CORS 预检
    if method == "OPTIONS" {
        send_response(&mut stream, 204, "No Content", origin_str, b"");
        return;
    }

    // Origin 白名单过滤
    if let Some(ref o) = origin {
        let is_ok = o.is_empty()
            || o.starts_with("chrome-extension://")
            || o.starts_with("extension://")
            || o.starts_with("http://127.0.0.1")
            || o.starts_with("http://localhost");
        if !is_ok {
            send_json(
                &mut stream,
                403,
                origin_str,
                &json!({ "ok": false, "error": "origin not allowed" }),
            );
            return;
        }
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
    let req_token = headers
        .get("x-picnest-token")
        .cloned()
        .or_else(|| query_param(query, "token"))
        .unwrap_or_default();

    let valid_token = get_token();
    if req_token.trim().is_empty() || req_token != valid_token {
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

    let conn = match rusqlite::Connection::open(db_path) {
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
        let roots = query_roots(&conn);
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
        let roots = query_roots(&conn);
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
        let roots = query_roots(&conn);
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
                        handle_client(s);
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
        let tmp = std::env::temp_dir().join(format!("picnest_collector_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let data_dir = tmp.join("data");
        let root_dir = tmp.join("photos");
        fs::create_dir_all(&data_dir).unwrap();
        fs::create_dir_all(&root_dir).unwrap();

        let _ = COLLECTOR_DATA_DIR.set(data_dir.clone());
        let token = get_token();
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
        let new_token = reset_token();
        assert_eq!(new_token.len(), 32);
        assert_ne!(token, new_token);
        assert_eq!(get_token(), new_token);

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
}

