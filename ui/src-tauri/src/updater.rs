//! 自动更新（对齐旧版 argon 的 picnest-check-update / picnest-download-update）
//!
//! 流程：
//!   1. `check_update` 打 GitHub Releases API，比较 semver，挑出便携包 zip 与 SHA256
//!   2. `download_update` 流式下载到 `%TEMP%\picnest-update\`，边下边算 SHA256，定期发进度事件
//!   3. 校验通过后返回文件路径，前端提示用户手动解压替换（便携版没有安装器）
//!
//! 为什么不用 tauri-plugin-updater：
//!   它要求签名密钥对和安装包格式，而这个项目发布的是便携 exe，
//!   旧版 Electron 则是「下载 zip → 用户自己换」。保持同一条路径最省事。

use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use crate::visual_search::detect_proxy;

const REPO: &str = "Ranbow29/PicNest";
const FALLBACK_HTML: &str = "https://github.com/Ranbow29/PicNest/releases";

/// 下载取消标志（前端点「取消下载」时置 true）
static UPDATE_CANCEL: AtomicBool = AtomicBool::new(false);
/// 当前 curl 子进程 PID，取消时直接杀掉，避免等它自己超时
static UPDATE_PID: AtomicU32 = AtomicU32::new(0);

pub fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 语义化版本比较：a > b 返回 1，a < b 返回 -1，相等 0。
/// 支持 `1.2.3` 与 `1.2.3-beta`（正式版 > 同号预发布）。
fn compare_semver(a: &str, b: &str) -> i32 {
    let clean = |s: &str| {
        s.trim()
            .trim_start_matches(['v', 'V'])
            .trim()
            .to_string()
    };
    let a = clean(a);
    let b = clean(b);
    let (core_a, pre_a) = match a.split_once('-') {
        Some((c, p)) => (c.to_string(), Some(p.to_string())),
        None => (a.clone(), None),
    };
    let (core_b, pre_b) = match b.split_once('-') {
        Some((c, p)) => (c.to_string(), Some(p.to_string())),
        None => (b.clone(), None),
    };
    let parts = |s: &str| -> Vec<i64> {
        s.split('.')
            .map(|x| x.trim().parse::<i64>().unwrap_or(0))
            .collect()
    };
    let pa = parts(&core_a);
    let pb = parts(&core_b);
    let n = pa.len().max(pb.len());
    for i in 0..n {
        let x = pa.get(i).copied().unwrap_or(0);
        let y = pb.get(i).copied().unwrap_or(0);
        if x > y {
            return 1;
        }
        if x < y {
            return -1;
        }
    }
    match (pre_a, pre_b) {
        (None, Some(_)) => 1,
        (Some(_), None) => -1,
        (Some(x), Some(y)) if x != y => {
            if x > y {
                1
            } else {
                -1
            }
        }
        _ => 0,
    }
}

/// 从 release 资产或正文里提取 SHA-256（大写 64 位 hex）
fn extract_sha256(release: &Value, asset: Option<&Value>) -> Option<String> {
    if let Some(a) = asset {
        if let Some(d) = a.get("digest").and_then(|v| v.as_str()) {
            let low = d.to_lowercase();
            if low.starts_with("sha256:") {
                let hex = d[7..].trim();
                if hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
                    return Some(hex.to_uppercase());
                }
            }
        }
    }
    let body = release.get("body").and_then(|v| v.as_str()).unwrap_or("");
    for token in body.split(|c: char| !c.is_ascii_hexdigit()) {
        if token.len() == 64 && token.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(token.to_uppercase());
        }
    }
    None
}

/// 用 curl 拉一段 JSON（GitHub API 在国内基本必须走代理）。
/// 代理节点偶尔会握手失败（schannel 35），所以带一次重试。
fn curl_json(url: &str, timeout_secs: u64) -> Result<Value, String> {
    let tmp = std::env::temp_dir().join(format!(
        "picnest_update_probe_{}.json",
        std::process::id()
    ));
    let mut last_err = String::from("网络请求失败");

    for attempt in 0..2 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        let mut cmd = Command::new("curl.exe");
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
            .arg(timeout_secs.to_string())
            .arg("--connect-timeout")
            .arg("15")
            .arg("-H")
            .arg("Accept: application/vnd.github.v3+json")
            .arg("-A")
            .arg(format!("PicNest-Desktop-App/{}", current_version()));
        if let Some(p) = detect_proxy() {
            cmd.arg("--proxy").arg(p);
        }
        cmd.arg("-o").arg(&tmp).arg(url);

        let out = cmd
            .output()
            .map_err(|e| format!("启动网络请求失败: {}", e))?;
        if !out.status.success() {
            let e = String::from_utf8_lossy(&out.stderr).trim().to_string();
            last_err = if e.is_empty() {
                format!("网络请求失败 (curl 退出码 {:?})", out.status.code())
            } else {
                e
            };
            let _ = fs::remove_file(&tmp);
            continue;
        }
        let bytes = fs::read(&tmp).unwrap_or_default();
        let _ = fs::remove_file(&tmp);
        if bytes.is_empty() {
            last_err = "服务器返回空响应".to_string();
            continue;
        }
        return serde_json::from_slice(&bytes).map_err(|e| format!("解析响应失败: {}", e));
    }

    Err(last_err)
}

/// API 被限流时的兜底：跟 releases/latest 的重定向拿 tag（不消耗 API 配额）
fn latest_tag_via_redirect() -> Option<String> {
    let mut cmd = Command::new("curl.exe");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.args([
        "-sS",
        "-o",
        "NUL",
        "-L",
        "--max-time",
        "12",
        "--connect-timeout",
        "8",
        "-A",
    ])
    .arg(format!("PicNest-Desktop-App/{}", current_version()))
    .args(["-w", "%{url_effective}"]);
    if let Some(p) = detect_proxy() {
        cmd.arg("--proxy").arg(p);
    }
    cmd.arg(format!("https://github.com/{}/releases/latest", REPO));
    let out = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let idx = text.rfind("/tag/")?;
    let tag = text[idx + 5..].trim_end_matches('/').to_string();
    if tag.is_empty() {
        None
    } else {
        Some(tag)
    }
}

/// 检查更新（同步实现，Tauri 命令包一层 async）
pub fn do_check_update(api_url: Option<&str>) -> Value {
    let cur = current_version();
    let url = api_url
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("https://api.github.com/repos/{}/releases/latest", REPO));

    let release = match curl_json(&url, 12) {
        Ok(v) => v,
        Err(e) => {
            // 网络不通时给出可读提示，而不是裸错误码
            return json!({
                "ok": false,
                "currentVersion": cur,
                "htmlUrl": FALLBACK_HTML,
                "error": format!("检查更新失败：{}（GitHub 访问可能需要代理）", e)
            });
        }
    };

    // 没有 tag_name：要么还没发过正式版，要么 API 报错（限流 / 仓库改名）
    if release.get("tag_name").is_none() {
        let msg = release
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let low = msg.to_lowercase();
        if low.contains("rate limit") {
            // 限流时退一步：只看 releases/latest 跳转的 tag，至少能告诉用户「有新版本」
            if let Some(tag) = latest_tag_via_redirect() {
                let remote = tag.trim_start_matches(['v', 'V']).to_string();
                let has = compare_semver(&remote, &cur) > 0;
                return json!({
                    "ok": true,
                    "hasUpdate": has,
                    "currentVersion": cur,
                    "latestVersion": remote,
                    "tag": tag,
                    "htmlUrl": format!("https://github.com/{}/releases/tag/{}", REPO, tag),
                    "assetUrl": null,
                    "expectedSha256": null,
                    "message": "GitHub API 速率受限：只能查到版本号，自动下载不可用，请用「浏览器下载」"
                });
            }
            return json!({
                "ok": false,
                "currentVersion": cur,
                "htmlUrl": FALLBACK_HTML,
                "error": "GitHub API 速率限制（同一 IP 每小时 60 次），请稍后再试或开启代理"
            });
        }
        if low.contains("not found") {
            return json!({
                "ok": true,
                "hasUpdate": false,
                "currentVersion": cur,
                "latestVersion": cur,
                "htmlUrl": FALLBACK_HTML,
                "message": "暂未发布正式版本"
            });
        }
        if !msg.trim().is_empty() {
            return json!({
                "ok": false,
                "currentVersion": cur,
                "htmlUrl": FALLBACK_HTML,
                "error": format!("检查更新失败：{}", msg.trim())
            });
        }
    }

    let tag = release
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let remote_ver = tag.trim_start_matches(['v', 'V']).to_string();
    let latest = if remote_ver.is_empty() {
        cur.clone()
    } else {
        remote_ver
    };
    let has_update = compare_semver(&latest, &cur) > 0;

    // 优先便携包 zip，排除浏览器扩展包
    let assets = release
        .get("assets")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let pick = assets
        .iter()
        .find(|a| {
            let n = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
            n.to_lowercase().ends_with(".zip") && !n.to_lowercase().contains("extension")
        })
        .or_else(|| assets.first());

    let sha = extract_sha256(&release, pick);
    let asset_url = pick
        .and_then(|a| a.get("browser_download_url"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let asset_name = pick
        .and_then(|a| a.get("name"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let asset_size = pick
        .and_then(|a| a.get("size"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    json!({
        "ok": true,
        "hasUpdate": has_update,
        "currentVersion": cur,
        "latestVersion": latest,
        "tag": tag,
        "releaseName": release.get("name").and_then(|v| v.as_str()).unwrap_or(&tag),
        "releaseNotes": release.get("body").and_then(|v| v.as_str()).unwrap_or(""),
        "publishedAt": release.get("published_at").and_then(|v| v.as_str()).unwrap_or(""),
        "htmlUrl": release.get("html_url").and_then(|v| v.as_str()).unwrap_or(FALLBACK_HTML),
        "assetUrl": asset_url,
        "assetName": asset_name,
        "assetSize": asset_size,
        "expectedSha256": sha,
    })
}

/// 简单的 SHA-256（不引依赖，够用且可增量）
struct Sha256 {
    state: [u32; 8],
    buf: Vec<u8>,
    len: u64,
}

impl Sha256 {
    fn new() -> Self {
        Self {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            buf: Vec::with_capacity(64),
            len: 0,
        }
    }

    fn update(&mut self, data: &[u8]) {
        self.len = self.len.wrapping_add(data.len() as u64);
        self.buf.extend_from_slice(data);
        while self.buf.len() >= 64 {
            let block: Vec<u8> = self.buf.drain(..64).collect();
            self.compress(&block);
        }
    }

    fn compress(&mut self, block: &[u8]) {
        const K: [u32; 64] = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
            0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
            0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
            0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
            0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
            0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
            0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
            0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
            0xc67178f2,
        ];
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                block[i * 4],
                block[i * 4 + 1],
                block[i * 4 + 2],
                block[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let mut h = self.state;
        for i in 0..64 {
            let s1 = h[4].rotate_right(6) ^ h[4].rotate_right(11) ^ h[4].rotate_right(25);
            let ch = (h[4] & h[5]) ^ ((!h[4]) & h[6]);
            let t1 = h[7]
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = h[0].rotate_right(2) ^ h[0].rotate_right(13) ^ h[0].rotate_right(22);
            let maj = (h[0] & h[1]) ^ (h[0] & h[2]) ^ (h[1] & h[2]);
            let t2 = s0.wrapping_add(maj);
            h[7] = h[6];
            h[6] = h[5];
            h[5] = h[4];
            h[4] = h[3].wrapping_add(t1);
            h[3] = h[2];
            h[2] = h[1];
            h[1] = h[0];
            h[0] = t1.wrapping_add(t2);
        }
        for i in 0..8 {
            self.state[i] = self.state[i].wrapping_add(h[i]);
        }
    }

    fn finish(mut self) -> String {
        let bit_len = self.len.wrapping_mul(8);
        self.buf.push(0x80);
        while self.buf.len() % 64 != 56 {
            self.buf.push(0);
        }
        self.buf.extend_from_slice(&bit_len.to_be_bytes());
        let blocks: Vec<u8> = std::mem::take(&mut self.buf);
        for chunk in blocks.chunks(64) {
            self.compress(chunk);
        }
        self.state
            .iter()
            .map(|x| format!("{:08x}", x))
            .collect::<String>()
            .to_uppercase()
    }
}

/// 下载更新包（同步实现）。返回 { ok, filePath, sha256, verified }。
/// 边下边算 SHA256，每约 200ms 发一次 `picnest-update-progress` 事件。
pub fn do_download_update(
    app: &tauri::AppHandle,
    url: &str,
    file_name: Option<&str>,
    expected_sha: Option<&str>,
) -> Value {
    use tauri::Emitter;

    if url.trim().is_empty() {
        return json!({ "ok": false, "error": "下载地址为空" });
    }
    UPDATE_CANCEL.store(false, Ordering::SeqCst);

    let dir = std::env::temp_dir().join("picnest-update");
    if let Err(e) = fs::create_dir_all(&dir) {
        return json!({ "ok": false, "error": format!("创建下载目录失败: {}", e) });
    }
    let safe_name = file_name
        .unwrap_or("PicNest-update.zip")
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => c,
        })
        .collect::<String>();
    let target: PathBuf = dir.join(&safe_name);
    let part: PathBuf = dir.join(format!("{}.part", safe_name));
    let _ = fs::remove_file(&part);

    let mut cmd = Command::new("curl.exe");
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
        .arg("1800")
        .arg("--connect-timeout")
        .arg("20")
        .arg("-A")
        .arg(format!("PicNest-Desktop-App/{}", current_version()));
    if let Some(p) = detect_proxy() {
        cmd.arg("--proxy").arg(p);
    }
    cmd.arg("-o")
        .arg(&part)
        .arg(url)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "error": format!("启动下载失败: {}", e) }),
    };
    UPDATE_PID.store(child.id(), Ordering::SeqCst);

    // 轮询文件增长发进度（curl 本身不吐进度到 stderr 的时候也能用）
    let started = std::time::Instant::now();
    let mut last_len: u64 = 0;
    let mut last_tick = std::time::Instant::now();
    let mut cancelled = false;
    loop {
        if UPDATE_CANCEL.load(Ordering::SeqCst) {
            let _ = child.kill();
            cancelled = true;
            break;
        }
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(_) => break,
        }
        std::thread::sleep(std::time::Duration::from_millis(120));
        if last_tick.elapsed() >= std::time::Duration::from_millis(200) {
            let len = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
            let elapsed = last_tick.elapsed().as_secs_f64().max(0.001);
            let speed = ((len.saturating_sub(last_len)) as f64 / elapsed) as u64;
            let _ = app.emit(
                "picnest-update-progress",
                json!({ "received": len, "speed": speed }),
            );
            last_len = len;
            last_tick = std::time::Instant::now();
        }
        if started.elapsed().as_secs() > 1800 {
            let _ = child.kill();
            break;
        }
    }
    UPDATE_PID.store(0, Ordering::SeqCst);

    if cancelled {
        let _ = fs::remove_file(&part);
        return json!({ "ok": false, "cancelled": true, "error": "已取消下载" });
    }

    let total = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if total == 0 {
        let _ = fs::remove_file(&part);
        return json!({ "ok": false, "error": "下载失败：没有得到任何数据（网络或代理问题）" });
    }
    let _ = app.emit(
        "picnest-update-progress",
        json!({ "received": total, "speed": 0 }),
    );

    // 校验 SHA256
    let mut verified = None::<bool>;
    if let Some(expect) = expected_sha.filter(|s| s.len() == 64) {
        let mut hasher = Sha256::new();
        let mut ok_read = true;
        match fs::File::open(&part) {
            Ok(mut f) => {
                let mut buf = vec![0u8; 64 * 1024];
                loop {
                    match f.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => hasher.update(&buf[..n]),
                        Err(_) => {
                            ok_read = false;
                            break;
                        }
                    }
                }
            }
            Err(_) => ok_read = false,
        }
        if ok_read {
            let got = hasher.finish();
            let same = got.eq_ignore_ascii_case(expect);
            verified = Some(same);
            if !same {
                let _ = fs::remove_file(&part);
                return json!({
                    "ok": false,
                    "error": format!("校验失败：下载文件 SHA256 不匹配（期望 {}，实际 {}）", expect, got)
                });
            }
        }
    }

    if let Err(e) = fs::rename(&part, &target) {
        // 目标已存在时先删再换
        let _ = fs::remove_file(&target);
        if let Err(e2) = fs::rename(&part, &target) {
            let _ = fs::remove_file(&part);
            return json!({ "ok": false, "error": format!("保存文件失败: {} / {}", e, e2) });
        }
    }

    let _ = app.emit(
        "picnest-update-status",
        json!({ "stage": "done", "path": target.to_string_lossy() }),
    );

    json!({
        "ok": true,
        "filePath": target.to_string_lossy(),
        "size": total,
        "verified": verified,
    })
}

pub fn cancel_download() -> Value {
    UPDATE_CANCEL.store(true, Ordering::SeqCst);
    let pid = UPDATE_PID.load(Ordering::SeqCst);
    if pid != 0 {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        }
    }
    json!({ "ok": true })
}

/// 把下载好的 zip 所在目录打开（便携版没有安装器，用户自己解压替换）
pub fn reveal_download(file_path: &str) -> Value {
    let p = Path::new(file_path);
    if !p.exists() {
        return json!({ "ok": false, "error": "文件不存在" });
    }
    let dir = p.parent().unwrap_or(p);
    let _ = Command::new("explorer.exe").arg(dir).spawn();
    json!({ "ok": true })
}

// ---------------- Tauri Commands ----------------

#[tauri::command]
pub async fn check_update(api_url: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || do_check_update(api_url.as_deref()))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn download_update(
    app: tauri::AppHandle,
    url: Option<String>,
    file_name: Option<String>,
    expected_sha256: Option<String>,
    #[allow(non_snake_case)] expectedSha256: Option<String>,
) -> Result<Value, String> {
    let sha = expected_sha256.or(expectedSha256);
    let u = url.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        do_download_update(&app, &u, file_name.as_deref(), sha.as_deref())
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cancel_download_update() -> Value {
    cancel_download()
}

// ---------------- 热替换安装（对齐旧版 swap-and-restart.ps1） ----------------

/// 独立跳板脚本：等主进程退出 → 覆盖复制新版本 → 重新拉起 → 清理临时目录。
/// 所有路径都由 -File 参数传入，脚本体里不拼接任何数据，避免转义与编码问题。
const SWAP_SCRIPT: &str = r##"param(
    [int]$ParentPid,
    [string]$SourceDir,
    [string]$TargetDir,
    [string]$ExeName,
    [string]$LogFile,
    [int]$ShouldRestart = 1
)

function Write-UpdateLog([string]$msg) {
    $ts = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss.fff")
    Add-Content -LiteralPath $LogFile -Value "[$ts] $msg" -Encoding UTF8 -ErrorAction SilentlyContinue
}

Write-UpdateLog "Jump script started. ParentPid=$ParentPid SourceDir=$SourceDir TargetDir=$TargetDir ExeName=$ExeName"

# 1. 等主进程退出
$waited = 0
while ($ParentPid -gt 0 -and $waited -lt 15) {
    $proc = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
    if (-not $proc -or $proc.HasExited) { break }
    Start-Sleep -Milliseconds 250
    $waited += 0.25
}
Write-UpdateLog "Parent process exited after ${waited}s"

# 2. 确保目标目录下残余子进程释放句柄
$targetNorm = [System.IO.Path]::GetFullPath($TargetDir).TrimEnd("\\").ToLowerInvariant()
$subWaited = 0
while ($subWaited -lt 6) {
    $locked = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        try {
            $pPath = $_.MainModule.FileName
            $pPath -and $pPath.ToLowerInvariant().StartsWith($targetNorm + "\\")
        } catch { $false }
    })
    if ($locked.Count -eq 0) { break }
    if ($subWaited -ge 3) {
        foreach ($lp in $locked) {
            Write-UpdateLog "Force stopping lingering process pid=$($lp.Id)"
            Stop-Process -Id $lp.Id -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Milliseconds 300
    $subWaited += 0.3
}

Start-Sleep -Milliseconds 250

# 3. 带重试地覆盖复制（严格保护 _internal_data：库数据不能被更新包覆盖）
$items = Get-ChildItem -LiteralPath $SourceDir -Force
foreach ($item in $items) {
    if ($item.Name -eq "_internal_data") { continue }
    $ok = $false
    for ($retry = 1; $retry -le 6; $retry++) {
        try {
            Copy-Item -LiteralPath $item.FullName -Destination $TargetDir -Recurse -Force -ErrorAction Stop
            $ok = $true
            break
        } catch {
            Write-UpdateLog "Retry $retry copying $($item.Name): $($_.Exception.Message)"
            Start-Sleep -Milliseconds 400
        }
    }
    if (-not $ok) {
        Write-UpdateLog "Fallback copy for $($item.Name)"
        Copy-Item -LiteralPath $item.FullName -Destination $TargetDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
Write-UpdateLog "All files copied."

# 4. 重新拉起新版本
if ($ShouldRestart -eq 1) {
    $newExe = Join-Path $TargetDir $ExeName
    if (Test-Path -LiteralPath $newExe) {
        Write-UpdateLog "Launching $newExe"
        Start-Process -FilePath $newExe -WorkingDirectory $TargetDir
    } else {
        Write-UpdateLog "Executable not found: $newExe"
    }
}

# 5. 延迟清理解压目录（优先进回收站）
Start-Sleep -Seconds 2
try {
    Add-Type -AssemblyName Microsoft.VisualBasic
    if (Test-Path -LiteralPath $SourceDir) {
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($SourceDir, "OnlyErrorDialogs", "SendToRecycleBin")
    }
} catch {}
Write-UpdateLog "Update completed."
"##;

fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// 用 .NET ZipFile 解压（中文路径安全，比 curl/zip crate 快）
fn extract_zip(zip: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("创建解压目录失败: {}", e))?;
    let script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; \
                  Add-Type -AssemblyName System.IO.Compression.FileSystem; \
                  [System.IO.Compression.ZipFile]::ExtractToDirectory($env:PICNEST_ZIP_SRC, $env:PICNEST_ZIP_DEST)";
    let mut cmd = Command::new("powershell.exe");
    hide_window(&mut cmd);
    let out = cmd
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .env("PICNEST_ZIP_SRC", zip)
        .env("PICNEST_ZIP_DEST", dest)
        .output()
        .map_err(|e| format!("启动解压进程失败: {}", e))?;
    if !out.status.success() {
        let e = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if e.is_empty() {
            "解压更新包失败".to_string()
        } else {
            e
        });
    }
    Ok(())
}

/// 解压结果里挑出真正的程序根目录（兼容「压缩包里再包一层 PicNest/」）
fn pick_source_root(extracted: &Path) -> PathBuf {
    let named = extracted.join("PicNest");
    if named.is_dir() {
        return named;
    }
    if let Ok(rd) = fs::read_dir(extracted) {
        let items: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
        if items.len() == 1 && items[0].is_dir() {
            return items[0].clone();
        }
    }
    extracted.to_path_buf()
}

/// 结构完整性预检：至少要有 exe 或旧版的 resources/app，防止坏包覆盖后应用打不开
fn looks_like_app(dir: &Path) -> bool {
    if dir.join("resources").join("app").exists() {
        return true;
    }
    match fs::read_dir(dir) {
        Ok(rd) => rd.flatten().any(|e| {
            let p = e.path();
            p.is_file()
                && p.extension()
                    .map(|x| x.eq_ignore_ascii_case("exe"))
                    .unwrap_or(false)
        }),
        Err(_) => false,
    }
}

/// 一次热替换所需的全部路径（解压目录、真正的程序根、跳板脚本）。
#[derive(Debug)]
pub struct InstallPlan {
    pub extracted: PathBuf,
    pub source: PathBuf,
    pub target_dir: PathBuf,
    pub exe_name: String,
    pub script_path: PathBuf,
    pub log_path: PathBuf,
}

/// 清掉上几次安装失败/取消留在 %TEMP% 的解压目录与半截下载，避免越躺越多（白吃磁盘）。
/// 只碰自己命名的 `extracted-*` 与 `*.part`，且超过 24 小时才动。
fn cleanup_stale_update_temp(temp_dir: &Path) {
    let Ok(rd) = fs::read_dir(temp_dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if !(name.starts_with("extracted-") || name.ends_with(".part")) {
            continue;
        }
        let old = fs::metadata(&p)
            .and_then(|m| m.modified())
            .map(|t| now.duration_since(t).map(|d| d.as_secs() > 86_400).unwrap_or(false))
            .unwrap_or(false);
        if !old {
            continue;
        }
        if p.is_dir() {
            let _ = fs::remove_dir_all(&p);
        } else {
            let _ = fs::remove_file(&p);
        }
    }
}

/// 解压 + 结构预检 + 生成跳板脚本（不启动、不退出，便于单测）。
pub fn prepare_install(zip_path: &str) -> Result<InstallPlan, String> {
    let zip = PathBuf::from(zip_path);
    if zip_path.trim().is_empty() || !zip.is_file() {
        return Err("未找到下载的更新压缩包，请重新下载".to_string());
    }

    let temp_dir = std::env::temp_dir().join("picnest-update");
    fs::create_dir_all(&temp_dir).map_err(|e| format!("创建更新临时目录失败: {}", e))?;
    cleanup_stale_update_temp(&temp_dir);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let extracted = temp_dir.join(format!("extracted-{}", stamp));

    if let Err(e) = extract_zip(&zip, &extracted) {
        let _ = fs::remove_dir_all(&extracted);
        return Err(format!("解压失败：{}", e));
    }

    let source = pick_source_root(&extracted);
    if !looks_like_app(&source) {
        let _ = fs::remove_dir_all(&extracted);
        return Err("更新包结构校验未通过（缺少可执行文件），已中止替换".to_string());
    }

    // 目标 = 当前 exe 所在目录（便携版就地替换）
    let exe = std::env::current_exe().unwrap_or_default();
    let target_dir = exe
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let exe_name = exe
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "PicNest.exe".to_string());

    let script_path = temp_dir.join("swap-and-restart.ps1");
    let log_path = temp_dir.join("update-swap.log");

    // PowerShell 5.1 读无 BOM 的 UTF-8 会按 ANSI 解析；脚本本身是纯 ASCII，加 BOM 只为兼容日志里的中文
    let mut body = vec![0xEF, 0xBB, 0xBF];
    body.extend_from_slice(SWAP_SCRIPT.replace("\r\n", "\n").replace('\n', "\r\n").as_bytes());
    if let Err(e) = fs::write(&script_path, &body) {
        let _ = fs::remove_dir_all(&extracted);
        return Err(format!("写入跳板脚本失败: {}", e));
    }

    Ok(InstallPlan {
        extracted,
        source,
        target_dir,
        exe_name,
        script_path,
        log_path,
    })
}

/// 同步版热替换：准备 → 后台拉起跳板 → 退出自己。
/// 环境变量 `PICNEST_UPDATE_DRYRUN=1` 只准备不执行（给自动化测试用）。
pub fn do_quit_and_install(app: &tauri::AppHandle, zip_path: &str) -> Value {
    use tauri::Emitter;

    let _ = app.emit(
        "picnest-update-status",
        json!({ "stage": "extracting", "text": "正在异步解压更新包…" }),
    );

    let plan = match prepare_install(zip_path) {
        Ok(p) => p,
        Err(e) => return json!({ "ok": false, "error": e }),
    };

    let dry_run = std::env::var("PICNEST_UPDATE_DRYRUN").map(|v| v == "1").unwrap_or(false);
    if dry_run {
        return json!({
            "ok": true,
            "dryRun": true,
            "scriptPath": plan.script_path.to_string_lossy(),
            "sourceDir": plan.source.to_string_lossy(),
            "targetDir": plan.target_dir.to_string_lossy(),
            "exeName": plan.exe_name,
            "logPath": plan.log_path.to_string_lossy(),
        });
    }

    let _ = app.emit(
        "picnest-update-status",
        json!({ "stage": "restarting", "text": "正在启动热替换跳板并重启图巢…" }),
    );

    let mut cmd = Command::new("powershell.exe");
    {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            const DETACHED_PROCESS: u32 = 0x00000008;
            cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
        }
    }
    let spawned = cmd
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&plan.script_path)
        .args(["-ParentPid", &std::process::id().to_string()])
        .arg("-SourceDir")
        .arg(&plan.source)
        .arg("-TargetDir")
        .arg(&plan.target_dir)
        .arg("-ExeName")
        .arg(&plan.exe_name)
        .arg("-LogFile")
        .arg(&plan.log_path)
        .args(["-ShouldRestart", "1"])
        .spawn();

    if let Err(e) = spawned {
        let _ = fs::remove_dir_all(&plan.extracted);
        return json!({ "ok": false, "error": format!("启动热替换进程失败: {}", e) });
    }

    // 让前端把「正在重启」画完再退出
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        handle.exit(0);
    });

    json!({ "ok": true, "restarting": true })
}

#[tauri::command]
pub async fn quit_and_install(
    app: tauri::AppHandle,
    file_path: Option<String>,
    #[allow(non_snake_case)] zipPath: Option<String>,
) -> Result<Value, String> {
    let p = zipPath
        .or(file_path)
        .ok_or_else(|| "缺少更新包路径".to_string())?;
    tauri::async_runtime::spawn_blocking(move || do_quit_and_install(&app, &p))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha_hex(data: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(data);
        h.finish()
    }

    #[test]
    fn sha256_known_vectors() {
        assert_eq!(
            sha_hex(b""),
            "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855"
        );
        assert_eq!(
            sha_hex(b"abc"),
            "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD"
        );
        assert_eq!(
            sha_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248D6A61D20638B8E5C026930C3E6039A33CE45964FF2167F6ECEDD419DB06C1"
        );
    }

    #[test]
    fn sha256_incremental_matches_one_shot() {
        let data = vec![7u8; 200_000];
        let one = sha_hex(&data);
        let mut h = Sha256::new();
        for chunk in data.chunks(777) {
            h.update(chunk);
        }
        assert_eq!(one, h.finish());
    }

    #[test]
    fn semver_ordering() {
        assert_eq!(compare_semver("0.1.1", "0.1.0"), 1);
        assert_eq!(compare_semver("v0.1.0", "0.1.0"), 0);
        assert_eq!(compare_semver("0.1.0", "0.1.10"), -1);
        assert_eq!(compare_semver("1.0.0", "0.9.9"), 1);
        assert_eq!(compare_semver("0.2.0-beta", "0.2.0"), -1);
        assert_eq!(compare_semver("0.2.0", "0.2.0-beta"), 1);
        assert_eq!(compare_semver("1.2", "1.2.0"), 0);
    }

    #[test]
    fn sha_extraction_from_release_body() {
        let release = json!({
            "body": "hash:\n\n8A9968F598BF033D0F03204779D14FF25D607FF3D2CC5E03559D421286FAA939\n",
            "assets": [{
                "name": "PicNest-v0.1.0-windows-x64.zip",
                "size": 224182737u64,
                "browser_download_url": "https://example.com/x.zip"
            }]
        });
        let asset = release.get("assets").and_then(|v| v.as_array()).and_then(|a| a.first());
        assert_eq!(
            extract_sha256(&release, asset).as_deref(),
            Some("8A9968F598BF033D0F03204779D14FF25D607FF3D2CC5E03559D421286FAA939")
        );
    }

    #[test]
    fn pick_source_root_handles_nested_folder() {
        let base = std::env::temp_dir().join(format!("picnest_pick_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let inner = base.join("PicNest");
        fs::create_dir_all(&inner).unwrap();
        fs::write(inner.join("PicNest.exe"), b"x").unwrap();
        let picked = pick_source_root(&base);
        assert_eq!(picked, inner);
        assert!(looks_like_app(&picked));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn prepare_install_extracts_zip_and_writes_swap_script() {
        let base = std::env::temp_dir().join(format!("picnest_zip_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let src = base.join("PicNest");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("PicNest.exe"), b"fake-binary").unwrap();
        fs::write(src.join("readme.txt"), b"hi").unwrap();
        let zip = base.join("update.zip");

        let mut ps = Command::new("powershell.exe");
        hide_window(&mut ps);
        let out = ps
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Compress-Archive -Path (Join-Path $env:PICNEST_ZIP_SRC '*') -DestinationPath $env:PICNEST_ZIP_DEST -Force",
            ])
            .env("PICNEST_ZIP_SRC", &src)
            .env("PICNEST_ZIP_DEST", &zip)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "compress failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );

        let plan = prepare_install(zip.to_string_lossy().as_ref()).expect("prepare ok");
        assert!(plan.source.join("PicNest.exe").is_file());
        assert!(plan.script_path.is_file());
        let bytes = fs::read(&plan.script_path).unwrap();
        assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF], "script needs utf8 BOM");
        let text = String::from_utf8_lossy(&bytes[3..]).to_string();
        assert!(text.contains("_internal_data"));
        assert!(text.contains("$ParentPid"));

        let _ = fs::remove_dir_all(&plan.extracted);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn prepare_install_rejects_bad_zip() {
        let base = std::env::temp_dir().join(format!("picnest_zip_bad_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let zip = base.join("bad.zip");
        fs::write(&zip, b"not a zip at all").unwrap();
        let err = prepare_install(zip.to_string_lossy().as_ref()).unwrap_err();
        assert!(err.contains("解压失败"), "unexpected: {}", err);
        let _ = fs::remove_dir_all(&base);
    }

    /// 用本地 JSON 模拟 GitHub 响应，验证解析/版本比较/资产挑选（不走网络）
    #[test]
    fn check_update_parses_release_payload() {
        let base = std::env::temp_dir().join(format!("picnest_rel_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let json_path = base.join("release.json");
        let payload = json!({
            "tag_name": "9.9.9",
            "name": "PicNest v9.9.9",
            "html_url": "https://github.com/Ranbow29/PicNest/releases/tag/9.9.9",
            "published_at": "2026-01-01T00:00:00Z",
            "body": "sha256: 8a9968f598bf033d0f03204779d14ff25d607ff3d2cc5e03559d421286faa939",
            "assets": [
                { "name": "PicNest-extension.zip", "size": 1, "browser_download_url": "https://e/x-ext.zip" },
                { "name": "PicNest-v9.9.9-windows-x64.zip", "size": 1024, "browser_download_url": "https://e/x.zip" }
            ]
        });
        fs::write(&json_path, serde_json::to_vec(&payload).unwrap()).unwrap();
        let url = format!("file:///{}", json_path.to_string_lossy().replace('\\', "/"));

        let v = do_check_update(Some(&url));
        assert_eq!(v["ok"], json!(true), "payload: {}", v);
        assert_eq!(v["hasUpdate"], json!(true));
        assert_eq!(v["latestVersion"], json!("9.9.9"));
        assert_eq!(v["assetName"], json!("PicNest-v9.9.9-windows-x64.zip"));
        assert_eq!(
            v["expectedSha256"],
            json!("8A9968F598BF033D0F03204779D14FF25D607FF3D2CC5E03559D421286FAA939")
        );
        let _ = fs::remove_dir_all(&base);
    }

    /// 真实联网检查（默认跳过）：`cargo test -- --ignored live_check_update`
    #[test]
    #[ignore]
    fn live_check_update() {
        let v = do_check_update(None);
        println!(
            "{}",
            serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string())
        );
    }
}
