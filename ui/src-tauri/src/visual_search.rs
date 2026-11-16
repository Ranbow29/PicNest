use serde_json::json;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// 代理地址归一化：`127.0.0.1:7897` → `http://127.0.0.1:7897`，
/// 注册表那种 `http=..;https=..` 取 https 那一支。
fn normalize_proxy(raw: &str) -> Option<String> {
    let v = raw.trim();
    if v.is_empty() {
        return None;
    }
    let v = if let Some(rest) = v.strip_prefix("http=") {
        rest.split(';').next().unwrap_or(rest).trim().to_string()
    } else if v.contains('=') {
        v.split(';')
            .filter_map(|seg| seg.split_once('='))
            .find(|(k, _)| {
                let k = k.trim();
                k.eq_ignore_ascii_case("https") || k.eq_ignore_ascii_case("http")
            })
            .map(|(_, val)| val.trim().to_string())?
    } else {
        v.to_string()
    };
    if v.is_empty() {
        return None;
    }
    if v.contains("://") {
        Some(v)
    } else {
        Some(format!("http://{}", v))
    }
}

#[cfg(windows)]
fn registry_proxy() -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let out = std::process::Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "ProxyServer",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    let line = s.lines().find(|l| l.contains("ProxyServer"))?;
    let v = line.split("REG_SZ").nth(1)?.trim();
    normalize_proxy(v)
}

/// 按原版顺序探测代理：环境变量 → 注册表 → 常见本地端口。
pub(crate) fn detect_proxy() -> Option<String> {
    for k in [
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        if let Ok(v) = std::env::var(k) {
            if let Some(p) = normalize_proxy(&v) {
                return Some(p);
            }
        }
    }
    #[cfg(windows)]
    {
        if let Some(p) = registry_proxy() {
            return Some(p);
        }
        for port in [7897u16, 7890, 10809, 10808, 1080, 2080] {
            let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
            if std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(150))
                .is_ok()
            {
                return Some(format!("http://127.0.0.1:{}", port));
            }
        }
    }
    None
}

static VS_REQ_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualSearchOpts {
    #[serde(alias = "file_path", alias = "filePath")]
    pub file_path: Option<String>,
    #[serde(alias = "data_url", alias = "dataUrl")]
    pub data_url: Option<String>,
    pub bbox: Option<Vec<f64>>,
    pub bookmark: Option<String>,
    #[serde(alias = "page_size", alias = "pageSize")]
    pub page_size: Option<usize>,
}

fn prepare_search_jpeg(opts: &VisualSearchOpts, data_dir: &Path) -> Result<Vec<u8>, String> {
    let bbox = opts.bbox.as_deref().unwrap_or(&[]);
    let bx = bbox.get(0).copied().unwrap_or(0.0).clamp(0.0, 1.0);
    let by = bbox.get(1).copied().unwrap_or(0.0).clamp(0.0, 1.0);
    let bw = bbox.get(2).copied().unwrap_or(1.0).clamp(0.01, 1.0 - bx);
    let bh = bbox.get(3).copied().unwrap_or(1.0).clamp(0.01, 1.0 - by);
    let is_sub_crop = bx > 0.02 || by > 0.02 || bw < 0.98 || bh < 0.98;

    // 1. 本地 JPEG 且无子裁切：直接透传原始文件 Buffer，保留 100% 高频线稿与笔触特征
    if let Some(ref fp) = opts.file_path {
        let clean_path = fp.trim().trim_start_matches("picnest-file://");
        let p = Path::new(clean_path);
        if p.exists() {
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if (ext == "jpg" || ext == "jpeg") && !is_sub_crop {
                if let Ok(buf) = fs::read(p) {
                    // 体积上限：2MB 原图走代理上传要十几秒（实测 14s），
                    // 而 Pinterest 侧 1600px 已足够。超过 800KB 就降下来重编码。
                    if !buf.is_empty() && buf.len() < 800 * 1024 {
                        return Ok(buf);
                    }
                }
            }
        }
    }

    // 2. 加载图像并处理裁剪/透明通道
    let mut dyn_img: Option<image::DynamicImage> = None;

    if let Some(ref fp) = opts.file_path {
        let clean_path = fp.trim().trim_start_matches("picnest-file://");
        let p = Path::new(clean_path);
        if p.exists() {
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();

            let md5_hash = format!("{:x}", crate::commands::fnv1a_hash(p.to_string_lossy().as_bytes()));
            let thumb_candidates = [
                data_dir.join("cache").join("thumbs").join(format!("{}-q80.jpg", md5_hash)),
                data_dir.join("cache").join("thumbs").join(format!("{}.jpg", md5_hash)),
                data_dir.join("cache").join(format!("psd-{}.png", md5_hash)),
            ];

            // PSD / PSB 或 视频 优先读取已提取的预览图
            if ext == "psd" || ext == "psb" || matches!(ext.as_str(), "mp4" | "webm" | "mov" | "mkv" | "avi" | "flv") {
                for cand in &thumb_candidates {
                    if cand.exists() {
                        if let Ok(bytes) = fs::read(cand) {
                            if let Ok(img) = image::load_from_memory(&bytes) {
                                dyn_img = Some(img);
                                break;
                            }
                        }
                    }
                }
            }

            // 尝试读取原图
            if dyn_img.is_none() {
                if let Ok(bytes) = fs::read(p) {
                    dyn_img = image::load_from_memory(&bytes).ok();
                }
            }

            // 原图如果因为特殊编码加载失败，尝试从缩略图兜底
            if dyn_img.is_none() {
                for cand in &thumb_candidates {
                    if cand.exists() {
                        if let Ok(bytes) = fs::read(cand) {
                            if let Ok(img) = image::load_from_memory(&bytes) {
                                dyn_img = Some(img);
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    if dyn_img.is_none() {
        if let Some(ref du) = opts.data_url {
            let du = du.trim();
            if let Ok((raw_bytes, _)) = parse_data_url_helper(du) {
                dyn_img = image::load_from_memory(&raw_bytes).ok();
            } else if du.starts_with("http://") || du.starts_with("https://") {
                /* 衍生图搜（拿 Pinterest 结果再搜）传的是远程 URL，
                   旧代码只认 data: 前缀，所以直接报「无法读取或解码」。
                   pinimg 需要代理，走和视觉检索同一条代理探测。 */
                if let Ok(bytes) = download_remote_image(du) {
                    dyn_img = image::load_from_memory(&bytes).ok();
                }
            }
        }
    }

    let Some(mut img) = dyn_img else {
        return Err("无法读取或解码待检索图片".to_string());
    };

    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return Err("图片宽高无效".to_string());
    }

    // 局部 ROI 区域裁切
    if is_sub_crop && w > 10 && h > 10 {
        let cx = ((bx * w as f64).round() as u32).min(w - 1);
        let cy = ((by * h as f64).round() as u32).min(h - 1);
        let cw = ((bw * w as f64).round() as u32).clamp(16, w - cx);
        let ch = ((bh * h as f64).round() as u32).clamp(16, h - cy);
        img = img.crop_imm(cx, cy, cw, ch);
    }

    // 尺寸保护。原来限 3840：一张 2672×3802 的图要先对 1000 万像素做逐像素白底合成，
    // 再用单线程编码 q95，就是秒级（老版 sharp/libvips 是多线程 SIMD）。
    // Pinterest 侧实测 1024/1600/2048/3840 返回结果数一致，1600 最快，定在这个档。
    let max_dim = 1600u32;
    let (cur_w, cur_h) = (img.width(), img.height());
    if cur_w > max_dim || cur_h > max_dim {
        img = img.resize(max_dim, max_dim, image::imageops::FilterType::Triangle);
    }

    // 只有真带 alpha 的图才需要白底合成；JPEG 没有 alpha，直接 to_rgb8 就行。
    // （不能对任何图都用 to_rgb8：它只是丢 alpha，透明区会变黑，Pinterest 认不出黑底图）
    let rgb_img = if img.color().has_alpha() {
        let rgba = img.to_rgba8();
        let (w, h) = rgba.dimensions();
        let mut out = image::RgbImage::new(w, h);
        for (x, y, p) in rgba.enumerate_pixels() {
            let a = p[3] as u32;
            let blend = |c: u8| -> u8 { ((c as u32 * a + 255 * (255 - a)) / 255) as u8 };
            out.put_pixel(x, y, image::Rgb([blend(p[0]), blend(p[1]), blend(p[2])]));
        }
        out
    } else {
        img.to_rgb8()
    };

    let mut out_buf = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out_buf, 88);
    encoder
        .encode(
            rgb_img.as_raw(),
            rgb_img.width(),
            rgb_img.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| format!("JPEG 编码失败: {}", e))?;

    Ok(out_buf)
}

/// 把 Pinterest 尺寸前缀（`1200x` / `736x` / `90x` 等）换成 `originals`，拿到原图。
/// 等价于老版 `lrg.replace(/[0-9]+x/g, "originals")`，只改 host 之后路径里的那一段。
fn to_originals_url(url: &str) -> String {
    let Some(scheme_end) = url.find("://") else {
        return url.to_string();
    };
    let after = &url[scheme_end + 3..];
    let Some(slash) = after.find('/') else {
        return url.to_string();
    };
    let (host, path) = after.split_at(slash);
    let mut segs: Vec<&str> = path.split('/').collect();
    // segs[0] 是空串（path 以 / 开头），尺寸段在 segs[1]
    if segs.len() > 2 {
        let candidate = segs[1];
        if let Some(num) = candidate.strip_suffix('x') {
            if !num.is_empty() && num.chars().all(|c| c.is_ascii_digit()) {
                segs[1] = "originals";
                return format!("{}://{}/{}", &url[..scheme_end], host, segs[1..].join("/"));
            }
        }
    }
    url.to_string()
}

/// 复用的 HTTP 客户端：每次搜索新建 Client 都要重做一次 TLS 握手（经代理 3–5 秒），
/// 全局只建一次，后续搜索直接复用连接池与 HTTP/2 会话。
static VS_CLIENT: std::sync::OnceLock<reqwest::blocking::Client> = std::sync::OnceLock::new();

fn vs_client() -> Result<&'static reqwest::blocking::Client, String> {
    if let Some(c) = VS_CLIENT.get() {
        return Ok(c);
    }
    let mut builder = reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(120))
        .pool_idle_timeout(std::time::Duration::from_secs(180))
        // HTTP 代理的 CONNECT 隧道下 h2 协商会失败（request or response body error），
        // 强制 HTTP/1.1 才稳。
        .http1_only()
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        );
    if let Some(p) = detect_proxy() {
        if let Ok(pr) = reqwest::Proxy::all(&p) {
            builder = builder.proxy(pr);
        }
    }
    let client = builder
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;
    let _ = VS_CLIENT.set(client);
    VS_CLIENT
        .get()
        .ok_or_else(|| "创建 HTTP 客户端失败".to_string())
}

/// 下载远程图片（衍生图搜：Pinterest 结果图是 https://i.pinimg.com/...）。
/// pinimg 走代理，复用与视觉检索相同的代理探测。
fn download_remote_image(url: &str) -> Result<Vec<u8>, String> {
    let proxy = detect_proxy();
    let tick = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let tmp = std::env::temp_dir().join(format!("picnest_vs_dl_{}.bin", tick));
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
        .arg("45")
        .arg("--retry")
        .arg("1")
        .arg("--retry-all-errors");
    if let Some(p) = proxy {
        cmd.arg("--proxy").arg(p);
    }
    cmd.arg("-A")
        .arg("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        .arg("-o")
        .arg(&tmp)
        .arg(url);
    let out = cmd.output().map_err(|e| format!("启动下载失败: {}", e))?;
    let bytes = fs::read(&tmp).unwrap_or_default();
    let _ = fs::remove_file(&tmp);
    if !out.status.success() || bytes.is_empty() {
        return Err(format!(
            "下载远程图失败: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(bytes)
}

fn parse_data_url_helper(u: &str) -> Result<(Vec<u8>, String), String> {
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

pub fn execute_visual_search(
    opts: &VisualSearchOpts,
    data_dir: &Path,
) -> Result<serde_json::Value, String> {
    let raw_jpeg = prepare_search_jpeg(opts, data_dir)?;

    // 诊断用：PICNEST_VS_DUMP=<路径> 时把实际要上传的 JPEG 落盘，用于和外部工具比对
    if let Ok(dump) = std::env::var("PICNEST_VS_DUMP") {
        if !dump.trim().is_empty() {
            let _ = fs::write(dump.trim(), &raw_jpeg);
        }
    }
    if raw_jpeg.is_empty() {
        return Err("准备待检索图像数据为空".to_string());
    }

    let req_id = VS_REQ_COUNTER.fetch_add(1, Ordering::SeqCst);
    let tick = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let _ = (req_id, tick);

    // multipart 由 reqwest 自己生成（boundary 也由它管）
    let page_size = opts.page_size.unwrap_or(200);
    let jpeg_len = raw_jpeg.len();

    let mut api_url = "https://api.pinterest.com/v3/visual_search/extension/image/".to_string();
    if let Some(ref bm) = opts.bookmark {
        if !bm.trim().is_empty() {
            let enc = bm
                .chars()
                .map(|c| match c {
                    'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
                    _ => format!("%{:02X}", c as u8),
                })
                .collect::<String>();
            api_url.push_str(&format!("?bookmark={}", enc));
        }
    }

    /* 传输层：curl.exe + 三次重试。
       - 为什么不用 reqwest：它在 HTTP 代理的 CONNECT 隧道下会报
         `request or response body error` / `error sending request`（h2 与 h1 都不行），
         实测完全拿不到响应。
       - 为什么不用 Chromium net.fetch：Rust 侧没有这个 API（那是 Electron 的）。
       - curl 的问题是偶发 schannel 握手被对方断开（curl 56 / 35），不是每次；
         实测同一张图有时 2.5s 成功、有时失败，所以用重试来拉平。
       临时文件一次写好，重试时只换 URL/代理。 */
    let temp_dir = std::env::temp_dir();
    let body_tmp = temp_dir.join(format!("picnest_vs_req_{}.tmp", tick));
    let resp_tmp = temp_dir.join(format!("picnest_vs_resp_{}.tmp", tick));

    {
        let boundary = format!("----WebKitFormBoundary{:016x}{:08x}", tick, req_id);
        let crlf = "\r\n";
        let mut body = Vec::with_capacity(raw_jpeg.len() + 2048);
        body.extend_from_slice(
            format!(
                "--{b}{crlf}Content-Disposition: form-data; name=\"image\"; filename=\"blob\"{crlf}Content-Type: image/jpeg{crlf}{crlf}",
                b = boundary, crlf = crlf
            )
            .as_bytes(),
        );
        body.extend_from_slice(&raw_jpeg);
        for (k, v) in [
            ("x", "0"),
            ("y", "0"),
            ("w", "1"),
            ("h", "1"),
            ("page_size", "200"),
        ] {
            let val = if k == "page_size" { page_size.to_string() } else { v.to_string() };
            body.extend_from_slice(
                format!(
                    "{crlf}--{b}{crlf}Content-Disposition: form-data; name=\"{k}\"{crlf}{crlf}{val}",
                    b = boundary, crlf = crlf, k = k, val = val
                )
                .as_bytes(),
            );
        }
        body.extend_from_slice(format!("{crlf}--{}--{crlf}", boundary).as_bytes());
        fs::write(&body_tmp, &body).map_err(|e| format!("写入请求体失败: {}", e))?;
    }

    let boundary = format!("----WebKitFormBoundary{:016x}{:08x}", tick, req_id);
    let proxy = detect_proxy();
    let mut resp_bytes: Vec<u8> = Vec::new();
    let mut last_err = String::new();

    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
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
            .arg("-X")
            .arg("PUT")
            .arg("--connect-timeout")
            .arg("15")
            .arg("--max-time")
            .arg("90")
            .arg("-A")
            .arg("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
            .arg("-e")
            .arg("https://www.pinterest.com/")
            .arg("-H")
            .arg("Accept: application/json, text/plain, */*")
            .arg("-H")
            .arg(format!("Content-Type: multipart/form-data; boundary={}", boundary));
        if let Some(ref p) = proxy {
            cmd.arg("--proxy").arg(p);
        }
        cmd.arg("--data-binary")
            .arg(format!("@{}", body_tmp.to_string_lossy()))
            .arg("-o")
            .arg(&resp_tmp)
            .arg(&api_url);

        match cmd.output() {
            Ok(out) if out.status.success() => {
                resp_bytes = fs::read(&resp_tmp).unwrap_or_default();
                if !resp_bytes.is_empty() {
                    break;
                }
                last_err = "响应为空".to_string();
            }
            Ok(out) => {
                let e = String::from_utf8_lossy(&out.stderr).trim().to_string();
                last_err = if e.is_empty() { format!("curl 退出码 {}", out.status.code().unwrap_or(-1)) } else { e };
            }
            Err(e) => last_err = format!("启动 curl 失败: {}", e),
        }
    }

    let _ = fs::remove_file(&body_tmp);
    let _ = fs::remove_file(&resp_tmp);

    if resp_bytes.is_empty() {
        return Err(format!("视觉检索网络请求失败（已重试 3 次）: {}", last_err));
    }

    let resp_json: serde_json::Value = serde_json::from_slice(&resp_bytes)
        .map_err(|e| format!("解析 Pinterest 响应 JSON 失败: {}", e))?;

    // 提取结果与游标
    let mut items: Vec<serde_json::Value> = Vec::new();
    let mut next_bookmark: Option<String> = None;

    if let Some(bm) = resp_json.get("bookmark").and_then(|v| v.as_str()) {
        if !bm.is_empty() && bm != "-end-" {
            next_bookmark = Some(bm.to_string());
        }
    }

    let raw_items = resp_json
        .get("data")
        .and_then(|d| d.as_array())
        .or_else(|| resp_json.get("items").and_then(|d| d.as_array()));

    if let Some(arr) = raw_items {
        for it in arr {
            let id = it
                .get("id")
                .and_then(|v| v.as_str().map(|s| s.to_string()).or_else(|| v.as_i64().map(|n| n.to_string())))
                .unwrap_or_default();
            if id.is_empty() {
                continue;
            }

            let imgs = it.get("images");
            let flat = |k: &str| it.get(k).and_then(|v| v.as_str());
            // 完全对齐老版映射：
            //   med = image_medium_url || image_square_url
            //   lrg = image_large_url || med
            //   orig = lrg 里的 "1200x"/"236x" 段换成 "originals"
            // 之前取 image_square_url（90×90）导致瀑布流模糊，且没给 largeUrl。
            let med = flat("image_medium_url")
                .or_else(|| flat("image_square_url"))
                .or_else(|| flat("image_236x_url"))
                .or_else(|| {
                    imgs.and_then(|m| m.get("236x").or_else(|| m.get("474x")).or_else(|| m.get("orig")))
                        .and_then(|o| o.get("url"))
                        .and_then(|u| u.as_str())
                })
                .unwrap_or("");
            let lrg = flat("image_large_url")
                .or_else(|| {
                    imgs.and_then(|m| {
                        m.get("orig")
                            .or_else(|| m.get("originals"))
                            .or_else(|| m.get("736x"))
                            .or_else(|| m.get("474x"))
                    })
                    .and_then(|o| o.get("url"))
                    .and_then(|u| u.as_str())
                })
                .unwrap_or(med);
            let orig = if lrg.is_empty() {
                med.to_string()
            } else {
                to_originals_url(lrg)
            };

            if med.is_empty() && lrg.is_empty() {
                continue;
            }

            let (w, h) = it
                .get("image_medium_size_pixels")
                .map(|p| {
                    (
                        p.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                        p.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                    )
                })
                .filter(|(w, h)| *w > 0 && *h > 0)
                .unwrap_or((474, 600));

            let title = it
                .get("title")
                .and_then(|v| v.as_str())
                .or_else(|| it.get("grid_title").and_then(|v| v.as_str()))
                .or_else(|| it.get("description").and_then(|v| v.as_str()))
                .unwrap_or("Pinterest 灵感素材");

            let board_name = it
                .get("board")
                .and_then(|b| b.get("name").and_then(|v| v.as_str()))
                .unwrap_or("");

            let source_url = format!("https://www.pinterest.com/pin/{}/", id);
            let aspect_ratio = if h > 0 { (w as f64) / (h as f64) } else { 0.75 };

            items.push(json!({
                "id": id,
                "engine": "pinterest",
                "title": title,
                "thumbUrl": med,
                "largeUrl": lrg,
                "origUrl": orig,
                "width": w,
                "height": h,
                "aspectRatio": aspect_ratio,
                "sourceUrl": source_url,
                "boardName": board_name,
                "saved": false
            }));
        }
    }

    Ok(json!({
        "ok": true,
        "results": items,
        "bookmark": next_bookmark,
        // 诊断字段（不影响前端使用）
        "dbgProxy": detect_proxy(),
        "dbgJpegBytes": jpeg_len,
        "dbgRespBytes": resp_bytes.len()
    }))
}

pub fn save_visual_search_item(
    item: &serde_json::Value,
    db_path: &Path,
    app_handle: Option<&tauri::AppHandle>,
) -> Result<serde_json::Value, String> {
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    let src = item
        .get("origUrl")
        .and_then(|v| v.as_str())
        .or_else(|| item.get("src").and_then(|v| v.as_str()))
        .or_else(|| item.get("thumbUrl").and_then(|v| v.as_str()))
        .unwrap_or("");

    if src.is_empty() {
        return Err("缺少待保存的图片链接".to_string());
    }

    let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("以图搜图灵感");
    let source_url = item.get("sourceUrl").and_then(|v| v.as_str()).unwrap_or("");

    let save_payload = json!({
        "src": src,
        "title": title,
        "url": source_url,
        "annotation": format!("Pinterest 以图找图 · {}", title),
        "force": true
    });

    crate::collector::save_one_item_direct(&conn, &save_payload, app_handle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_prepare_search_jpeg_from_data_url() {
        let data_url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        let (raw_bytes, _ct) = parse_data_url_helper(data_url).expect("parse_data_url failed");
        let _img = image::load_from_memory(&raw_bytes).expect("image load failed");

        let opts = VisualSearchOpts {
            file_path: None,
            data_url: Some(data_url.to_string()),
            bbox: Some(vec![0.0, 0.0, 1.0, 1.0]),
            bookmark: None,
            page_size: Some(10),
        };
        let tmp = std::env::temp_dir();
        let bytes = prepare_search_jpeg(&opts, &tmp).unwrap();
        assert!(!bytes.is_empty());
        assert_eq!(bytes[0], 0xFF);
        assert_eq!(bytes[1], 0xD8);
    }
}

