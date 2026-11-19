use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Instant;

/// 并发调用时临时文件名必须唯一：单靠毫秒时间戳会重名。
static AI_TMP_SEQ: AtomicUsize = AtomicUsize::new(0);

pub static DUP_CANCEL_FLAG: AtomicBool = AtomicBool::new(false);
pub static AI_DUP_CANCEL_FLAG: AtomicBool = AtomicBool::new(false);

/// 扫描阶段的单图指纹（从函数内提到模块级，以便会话缓存复用）
#[derive(Clone)]
pub struct ScannedImg {
    pub info: FileInfo,
    pub dhash: Option<u64>,
    /// 水平翻转后的 dHash（旧版 hashFlip），用于认出镜像图
    pub dhash_flip: Option<u64>,
    pub aspect: f32,
    /// 32×32 白底 RGB（旧版的色块预筛：每像素 RGB 量化到 3bit 后逐点比）
    pub color: Option<Vec<u8>>,
    /// 64-bit pHash（32×32 灰度 DCT 左上 8×8 去 DC 中位数二值化）
    pub phash: Option<Vec<u64>>,
    pub phash_flip: Option<Vec<u64>>,
}

/// 一次 AI 查重的扫描会话：扫描结果和已确认对都留着，
/// 这样“查完 40 对再接着查”不用重新扫全库、重算哈希。
pub struct AiScanSession {
    pub created_at: Instant,
    pub images: Vec<ScannedImg>,
    pub candidates: Vec<(usize, usize, u32)>,
    pub verified: Vec<(usize, usize)>,
    /// 已经交给 AI 判过的对数（candidates 下标）
    pub checked: usize,
    pub total_candidates: usize,
    pub dhash_pairs: usize,
    pub color_filtered: usize,
    pub scopes: usize,
    pub ai_calls: usize,
    pub ai_fail: usize,
    pub ai_error: Option<String>,
}

static AI_SESSIONS: std::sync::OnceLock<std::sync::Mutex<HashMap<String, AiScanSession>>> =
    std::sync::OnceLock::new();

fn sessions() -> &'static std::sync::Mutex<HashMap<String, AiScanSession>> {
    AI_SESSIONS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn insert_ai_session(key: String, sess: AiScanSession) {
    if let Ok(mut m) = sessions().lock() {
        m.insert(key.clone(), sess);
        while m.len() > 2 {
            let oldest = m
                .iter()
                .filter(|(k, _)| *k != &key)
                .min_by_key(|(_, v)| v.created_at)
                .map(|(k, _)| k.clone());
            if let Some(old_k) = oldest {
                m.remove(&old_k);
            } else {
                break;
            }
        }
    }
}

pub fn session_key(root_id: i64, rel: Option<&str>) -> String {
    format!("{}::{}", root_id, rel.unwrap_or(""))
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileInfo {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mtime: i64,
    pub width: u32,
    pub height: u32,
    pub thumb: String,
    pub rel: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DupGroup {
    pub hash: String,
    pub size: u64,
    pub count: usize,
    pub wasted: u64,
    pub files: Vec<FileInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub api_key: String,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            base_url: "https://api.openai.com/v1".to_string(),
            model: "gpt-4o-mini".to_string(),
            api_key: String::new(),
        }
    }
}

pub fn load_ai_config(data_dir: &Path) -> AiConfig {
    let p = data_dir.join("ai_config.json");
    if let Ok(bytes) = fs::read(&p) {
        if let Ok(cfg) = serde_json::from_slice::<AiConfig>(&bytes) {
            return cfg;
        }
    }
    // 兼容旧版配置文件路径 picnest-ai.json
    let p_old = data_dir.join("picnest-ai.json");
    if let Ok(bytes) = fs::read(&p_old) {
        if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            let bu = val.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("https://api.openai.com/v1");
            let m = val.get("model").and_then(|v| v.as_str()).unwrap_or("gpt-4o-mini");
            let k = val.get("keyPlain").or_else(|| val.get("apiKey")).and_then(|v| v.as_str()).unwrap_or("");
            return AiConfig {
                base_url: bu.to_string(),
                model: m.to_string(),
                api_key: k.to_string(),
            };
        }
    }
    AiConfig::default()
}

pub fn save_ai_config(data_dir: &Path, cfg: &AiConfig) -> Result<(), String> {
    let p = data_dir.join("ai_config.json");
    let json_bytes = serde_json::to_vec_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&p, json_bytes).map_err(|e| e.to_string())
}

/* ================= 1. 精确查重 (按大小分桶 -> 分块 Hash -> 逐字节严格校验) ================= */

fn quick_file_hash(p: &Path) -> Option<u64> {
    let mut file = fs::File::open(p).ok()?;
    let meta = file.metadata().ok()?;
    let len = meta.len();
    if len == 0 {
        return Some(0);
    }

    let mut hasher: u64 = 0xcbf29ce484222325;
    let prime: u64 = 0x100000001b3;

    let mut buf = [0u8; 8192];
    let n = file.read(&mut buf).unwrap_or(0);
    for &b in &buf[..n] {
        hasher ^= b as u64;
        hasher = hasher.wrapping_mul(prime);
    }

    if len > 16384 {
        use std::io::Seek;
        let _ = file.seek(std::io::SeekFrom::End(-8192));
        let n2 = file.read(&mut buf).unwrap_or(0);
        for &b in &buf[..n2] {
            hasher ^= b as u64;
            hasher = hasher.wrapping_mul(prime);
        }
    }

    hasher ^= len;
    hasher = hasher.wrapping_mul(prime);
    Some(hasher)
}

fn files_are_identical(p1: &Path, p2: &Path) -> bool {
    let Ok(mut f1) = fs::File::open(p1) else { return false };
    let Ok(mut f2) = fs::File::open(p2) else { return false };
    let mut b1 = [0u8; 16384];
    let mut b2 = [0u8; 16384];
    loop {
        let n1 = f1.read(&mut b1).unwrap_or(0);
        let n2 = f2.read(&mut b2).unwrap_or(0);
        if n1 != n2 {
            return false;
        }
        if n1 == 0 {
            return true;
        }
        if b1[..n1] != b2[..n2] {
            return false;
        }
    }
}

pub fn execute_find_duplicates(
    db_path: &Path,
    data_dir: &Path,
    folder_id: i64,
    rel: Option<&str>,
) -> Result<serde_json::Value, String> {
    DUP_CANCEL_FLAG.store(false, Ordering::SeqCst);
    let t0 = Instant::now();

    let conn = crate::db::open_conn_with_pragmas(db_path).map_err(|e| e.to_string())?;

    // 获取资料库根路径
    let root_path: String = conn
        .query_row("SELECT path FROM folders WHERE id = ?1", [folder_id], |r| r.get(0))
        .map_err(|_| "资料库不存在".to_string())?;

    let root_p = Path::new(&root_path);
    let scope_rel = rel.unwrap_or("").trim().trim_matches(|c| c == '/' || c == '\\').replace('/', "\\");
    let prefix_filter = if !scope_rel.is_empty() {
        let base = if root_path.ends_with('\\') {
            format!("{}{}", root_path, scope_rel)
        } else {
            format!("{}\\{}", root_path, scope_rel)
        };
        Some(base.to_lowercase())
    } else {
        None
    };

    let mut stmt = conn
        .prepare(
            "SELECT id, file_path, size, mtime, width, height, thumbnail_path \
             FROM images \
             WHERE folder_id = ?1 AND deleted_at IS NULL",
        )
        .map_err(|e| e.to_string())?;

    let mut rows = stmt.query([folder_id]).map_err(|e| e.to_string())?;

    let mut size_buckets: HashMap<u64, Vec<FileInfo>> = HashMap::new();
    let mut total_scanned = 0usize;

    while let Some(r) = rows.next().map_err(|e| e.to_string())? {
        if DUP_CANCEL_FLAG.load(Ordering::Relaxed) {
            return Ok(json!({ "ok": true, "canceled": true, "groups": [], "stats": null }));
        }

        let id: i64 = r.get(0).map_err(|e| e.to_string())?;
        let fp: String = r.get(1).map_err(|e| e.to_string())?;
        let size: u64 = r.get(2).map_err(|e| e.to_string())?;
        let mtime: i64 = r.get(3).map_err(|e| e.to_string())?;
        let width: u32 = r.get(4).unwrap_or(0);
        let height: u32 = r.get(5).unwrap_or(0);
        let thumb_path: Option<String> = r.get(6).ok();

        if let Some(ref pf) = prefix_filter {
            if !fp.to_lowercase().starts_with(pf) {
                continue;
            }
        }

        let p = Path::new(&fp);
        // 过滤不存在的文件或空文件
        let Ok(meta) = fs::metadata(p) else { continue };
        if !meta.is_file() || meta.len() == 0 {
            continue;
        }
        let actual_size = meta.len();
        total_scanned += 1;

        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let rel_of = if let Ok(rel_path) = p.parent().unwrap_or(p).strip_prefix(root_p) {
            rel_path.to_string_lossy().replace('\\', "/")
        } else {
            String::new()
        };

        let thumb = thumb_path
            .filter(|s| !s.is_empty() && s != "SKIP")
            .unwrap_or_else(|| {
                let md5_hash = format!("{:x}", crate::commands::fnv1a_hash(fp.as_bytes()));
                let p_cand = data_dir.join("cache").join("thumbs").join(format!("{}-q80.jpg", md5_hash));
                if p_cand.exists() {
                    p_cand.to_string_lossy().to_string()
                } else {
                    fp.clone()
                }
            });

        size_buckets.entry(actual_size).or_default().push(FileInfo {
            id,
            path: fp,
            name,
            size: actual_size,
            mtime,
            width,
            height,
            thumb,
            rel: rel_of,
        });
    }

    // 第二阶段：只保留相同大小且数量 >= 2 的文件分桶进行 Hash 比对
    let mut candidates_count = 0usize;
    let mut dup_groups: Vec<DupGroup> = Vec::new();
    let mut total_wasted_bytes: u64 = 0;
    let mut total_dup_files: usize = 0;

    for (size, files) in size_buckets {
        if files.len() < 2 {
            continue;
        }
        candidates_count += files.len();
        if DUP_CANCEL_FLAG.load(Ordering::Relaxed) {
            return Ok(json!({ "ok": true, "canceled": true, "groups": [], "stats": null }));
        }

        // 按快速采样哈希分组
        let mut hash_map: HashMap<u64, Vec<FileInfo>> = HashMap::new();
        for f in files {
            let p = Path::new(&f.path);
            if let Some(h) = quick_file_hash(p) {
                hash_map.entry(h).or_default().push(f);
            }
        }

        // 针对同一哈希的列表进行确证
        for (h_val, mut cand_files) in hash_map {
            if cand_files.len() < 2 {
                continue;
            }

            let mut validated_groups: Vec<Vec<FileInfo>> = Vec::new();
            while let Some(lead) = cand_files.pop() {
                let lead_path = PathBuf::from(&lead.path);
                let mut matched = vec![lead];
                let mut i = 0;
                while i < cand_files.len() {
                    let other_path = PathBuf::from(&cand_files[i].path);
                    if files_are_identical(&lead_path, &other_path) {
                        matched.push(cand_files.remove(i));
                    } else {
                        i += 1;
                    }
                }
                if matched.len() >= 2 {
                    validated_groups.push(matched);
                }
            }

            for mut g in validated_groups {
                g.sort_by(|a, b| a.mtime.cmp(&b.mtime));
                let count = g.len();
                let wasted = (count - 1) as u64 * size;
                total_wasted_bytes += wasted;
                total_dup_files += count;
                dup_groups.push(DupGroup {
                    hash: format!("{:016x}", h_val),
                    size,
                    count,
                    wasted,
                    files: g,
                    ai: None,
                });
            }
        }
    }

    // 按浪费空间降序排列（对齐旧版源码）
    dup_groups.sort_by(|a, b| b.wasted.cmp(&a.wasted).then_with(|| b.count.cmp(&a.count)));

    let group_count = dup_groups.len();
    let stats = json!({
        "scopes": total_scanned,
        "candidates": candidates_count,
        "groups": group_count,
        "files": total_dup_files,
        "wasted": total_wasted_bytes,
        "ms": t0.elapsed().as_millis(),
    });

    Ok(json!({
        "ok": true,
        "rootId": folder_id,
        "rel": scope_rel,
        "groups": dup_groups,
        "stats": stats,
    }))
}

/* ================= 2. AI 配置与连接测试 (picnestAiTest) ================= */

pub fn get_ai_config(data_dir: &Path) -> serde_json::Value {
    let cfg = load_ai_config(data_dir);
    json!({
        "ok": true,
        "baseUrl": cfg.base_url,
        "model": cfg.model,
        "hasKey": !cfg.api_key.trim().is_empty(),
        "encrypted": false
    })
}

pub fn set_ai_config(data_dir: &Path, val: &serde_json::Value) -> Result<serde_json::Value, String> {
    let mut cfg = load_ai_config(data_dir);
    if let Some(bu) = val.get("baseUrl").and_then(|v| v.as_str()) {
        if !bu.trim().is_empty() {
            cfg.base_url = bu.trim().trim_end_matches('/').to_string();
        }
    }
    if let Some(m) = val.get("model").and_then(|v| v.as_str()) {
        if !m.trim().is_empty() {
            cfg.model = m.trim().to_string();
        }
    }
    if let Some(k) = val.get("apiKey").and_then(|v| v.as_str()) {
        if !k.trim().is_empty() {
            cfg.api_key = k.trim().to_string();
        }
    }
    save_ai_config(data_dir, &cfg)?;
    Ok(json!({ "ok": true, "hasKey": !cfg.api_key.trim().is_empty(), "encrypted": false }))
}

pub fn fetch_ai_models(data_dir: &Path, opts: &serde_json::Value) -> Result<serde_json::Value, String> {
    let cfg = load_ai_config(data_dir);
    let base_url = opts
        .get("baseUrl")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&cfg.base_url)
        .trim()
        .trim_end_matches('/')
        .trim_end_matches("/chat/completions");

    let api_key = opts
        .get("apiKey")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&cfg.api_key)
        .trim();

    if api_key.is_empty() {
        return Err("请先填写 API Key，或先保存一次".to_string());
    }

    let url = format!("{}/models", base_url);

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
        .arg("20")
        .arg("-H")
        .arg(format!("Authorization: Bearer {}", api_key))
        .arg("-H")
        .arg("Accept: application/json")
        .arg(&url);

    let output = cmd.output().map_err(|e| format!("请求模型列表启动失败: {}", e))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("网络请求失败: {}", err));
    }

    let resp_str = String::from_utf8_lossy(&output.stdout);
    let resp_json: serde_json::Value = serde_json::from_str(&resp_str)
        .map_err(|e| format!("解析模型返回 JSON 失败: {}", e))?;

    let mut models = Vec::new();
    let raw_list = if let Some(arr) = resp_json.as_array() {
        arr
    } else if let Some(arr) = resp_json.get("data").and_then(|v| v.as_array()) {
        arr
    } else if let Some(arr) = resp_json.get("models").and_then(|v| v.as_array()) {
        arr
    } else {
        &vec![]
    };

    for it in raw_list {
        if let Some(id) = it.as_str().or_else(|| it.get("id").and_then(|v| v.as_str())) {
            let s = id.trim();
            if !s.is_empty() && !models.contains(&s.to_string()) {
                models.push(s.to_string());
            }
        }
    }

    models.sort_by(|a, b| {
        let is_fav_a = a.contains("gpt-4o") || a.contains("vision") || a.contains("flash") || a.contains("mimo");
        let is_fav_b = b.contains("gpt-4o") || b.contains("vision") || b.contains("flash") || b.contains("mimo");
        match (is_fav_a, is_fav_b) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.cmp(b),
        }
    });

    if models.is_empty() {
        return Err("接口返回了空模型列表，可手动填写模型名".to_string());
    }

    Ok(json!({
        "ok": true,
        "models": models
    }))
}

// 核心多模态比对函数（对齐旧版源码，针对 MiMo 思考模式进行专门适配）
/// 清掉一次 AI 比对用的两个临时文件（请求体里是 base64 图，不能留在 %TEMP% 里）
fn cleanup_ai_temps(req: &Path, resp: &Path) {
    let _ = fs::remove_file(req);
    let _ = fs::remove_file(resp);
}

/// 兜底清扫：异常退出/旧版本可能留下 `picnest_ai_req_*` / `picnest_ai_resp_*`，超过时限就删。
/// 返回删掉的文件数。
pub(crate) fn sweep_stale_ai_temps(temp_dir: &Path, max_age_secs: u64) -> usize {
    let Ok(rd) = fs::read_dir(temp_dir) else {
        return 0;
    };
    let now = std::time::SystemTime::now();
    let mut removed = 0usize;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !(name.starts_with("picnest_ai_req_") || name.starts_with("picnest_ai_resp_")) {
            continue;
        }
        let p = e.path();
        let old = fs::metadata(&p)
            .and_then(|m| m.modified())
            .map(|t| {
                now.duration_since(t)
                    .map(|d| d.as_secs() >= max_age_secs)
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        if old && fs::remove_file(&p).is_ok() {
            removed += 1;
        }
    }
    removed
}

pub fn call_ai_compare(
    cfg: &AiConfig,
    data_url_a: &str,
    data_url_b: &str,
) -> Result<bool, String> {
    let base = cfg.base_url.trim().trim_end_matches('/').trim_end_matches("/chat/completions");
    let endpoint = format!("{}/chat/completions", base);
    let is_mimo = base.to_lowercase().contains("xiaomimimo.com");
    let model = cfg.model.trim();

    let mut body_obj = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": "You are an image duplicate checker. Reply with JSON only." },
            {
                "role": "user",
                "content": [
                    { "type": "text", "text": "Are these two images the same artwork or the same photo? Allow different resolution, compression, watermark, text overlay, or minor cropping. Reply exactly with JSON: {\"same\":true,\"confidence\":0.0} or {\"same\":false,\"confidence\":0.0}." },
                    { "type": "image_url", "image_url": { "url": data_url_a } },
                    { "type": "image_url", "image_url": { "url": data_url_b } }
                ]
            }
        ]
    });

    if is_mimo || model.starts_with("o1") || model.starts_with("o3") || model.starts_with("o4") {
        body_obj["max_completion_tokens"] = json!(2048);
    } else {
        body_obj["temperature"] = json!(0);
        body_obj["max_tokens"] = json!(1024);
    }

    // 小米 MiMo 接口：关闭思考模式以提高查重速度
    if is_mimo {
        body_obj["thinking"] = json!({ "type": "disabled" });
    }

    let req_body_str = serde_json::to_string(&body_obj).map_err(|e| e.to_string())?;

    let temp_dir = std::env::temp_dir();
    let tick = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let seq = AI_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let req_tmp = temp_dir.join(format!("picnest_ai_req_{}_{}.json", tick, seq));
    let resp_tmp = temp_dir.join(format!("picnest_ai_resp_{}_{}.json", tick, seq));

    fs::write(&req_tmp, req_body_str.as_bytes())
        .map_err(|e| format!("写入请求临时文件失败: {}", e))?;

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
        .arg("POST")
        .arg("--max-time")
        // 旧版是 90s：MiMo 这类推理模型偶尔会想很久，45s 会误判为失败。
        .arg("90")
        .arg("--connect-timeout")
        .arg("15")
        .arg("-H")
        .arg("Content-Type: application/json")
        .arg("-H")
        .arg(format!("Authorization: Bearer {}", cfg.api_key.trim()))
        .arg("--data-binary")
        .arg(format!("@{}", req_tmp.to_string_lossy()))
        .arg("-o")
        .arg(&resp_tmp)
        .arg(&endpoint);

    /* 旧版对 429 / 5xx 重试 3 次（退避 1s、2s）。AI 查重要跑几十对，
       中间夹一两个限流就整轮失败的代价太高。 */
    let mut last_err = String::new();
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(1000 * attempt as u64));
        }
        match cmd.output() {
            Ok(out) if out.status.success() => {
                let bytes = fs::read(&resp_tmp).unwrap_or_default();
                if !bytes.is_empty() {
                    let val: serde_json::Value = match serde_json::from_slice(&bytes) {
                        Ok(v) => v,
                        Err(e) => {
                            last_err = format!("解析 API 响应失败: {}", e);
                            continue;
                        }
                    };
                    if let Some(err_obj) = val.get("error") {
                        let msg = err_obj
                            .get("message")
                            .and_then(|v| v.as_str())
                            .unwrap_or("API 调用报错");
                        // 只对可重试的错误再试
                        let retryable = msg.to_lowercase().contains("rate")
                            || msg.to_lowercase().contains("overload")
                            || msg.to_lowercase().contains("timeout")
                            || msg.to_lowercase().contains("try again");
                        last_err = msg.to_string();
                        if retryable && attempt < 2 {
                            continue;
                        }
                        // 不可重试的错误（Key 错/模型错）：两个临时文件都要收走，
                        // 以前这里只删了响应，请求文件（含两张 384px base64）会一直留着
                        cleanup_ai_temps(&req_tmp, &resp_tmp);
                        return Err(last_err);
                    }
                    cleanup_ai_temps(&req_tmp, &resp_tmp);
                    return finish_ai_compare(val);
                }
                last_err = "API 返回空响应".to_string();
            }
            Ok(out) => {
                let e = String::from_utf8_lossy(&out.stderr).trim().to_string();
                last_err = if e.is_empty() {
                    format!("curl 退出码 {}", out.status.code().unwrap_or(-1))
                } else {
                    e
                };
            }
            Err(e) => last_err = format!("启动 curl 请求失败: {}", e),
        }
    }
    cleanup_ai_temps(&req_tmp, &resp_tmp);
    return Err(last_err);
}

/// 从已解析的响应里取出 {"same":bool}（对齐旧版 picnestAiCompare 的返回解析）
fn finish_ai_compare(resp_val: serde_json::Value) -> Result<bool, String> {
    let choice = resp_val.get("choices").and_then(|v| v.get(0));
    let content = choice
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");

    if let Some(start) = content.find('{') {
        if let Some(end) = content.rfind('}') {
            let json_slice = &content[start..=end];
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(json_slice) {
                if let Some(same_bool) = parsed.get("same").and_then(|v| v.as_bool()) {
                    return Ok(same_bool);
                }
            }
        }
    }

    let lower = content.to_lowercase();
    if lower.contains("\"same\": true") || lower.contains("\"same\":true") {
        return Ok(true);
    }
    if lower.contains("\"same\": false") || lower.contains("\"same\":false") {
        return Ok(false);
    }

    Ok(false)
}

// 测试 AI 连接性（对齐旧版源码 picnest-ai-test）
pub fn execute_ai_test(data_dir: &Path) -> Result<serde_json::Value, String> {
    let cfg = load_ai_config(data_dir);
    if cfg.base_url.trim().is_empty() || cfg.model.trim().is_empty() || cfg.api_key.trim().is_empty() {
        return Err("请先填写并保存 API 地址、模型和 Key".to_string());
    }

    // 构造两张 64x64 纯色小图做连通性测试 (红 vs 蓝)。
    // 旧常量是损坏的 PNG（PIL 打不开），API 会直接返回 Invalid request parameters。
    // 纯色 PNG base64 数据：
    let red_data_url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAUElEQVR42u3PQREAAAQAMATRP5QwUni42xospzs+q3hOQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBA4N4CCJ0BmOb2hBcAAAAASUVORK5CYII=";
    let blue_data_url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAUklEQVR42u3PMQ0AMAgAMJgQlOBfBWKmgoOkddCsnrjsxXECAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC+z6usAG2Baz66wAAAABJRU5ErkJggg==";

    let same = call_ai_compare(&cfg, red_data_url, blue_data_url)?;
    Ok(json!({ "ok": true, "same": same }))
}

/* ================= 3. AI 相似查重 (本地感知哈希初筛 + OpenAI/MiMo 视觉确认) ================= */

/// 转灰度：对齐 sharp/libvips 的 `greyscale()`（Rec.601 权重）。
/// Rust 的 `to_luma8()` 用的是 Rec.709，同一张图会得到不同亮度，
/// 梯度符号一变，dHash 就完全跑偏。
fn gray_601(img: &image::DynamicImage, w: u32, h: u32) -> Vec<u8> {
    let rgb = img.resize_exact(w, h, image::imageops::FilterType::Lanczos3).to_rgb8();
    rgb.pixels()
        .map(|p| {
            let v = 0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64;
            v.round().clamp(0.0, 255.0) as u8
        })
        .collect()
}

fn compute_dhash(img: &image::DynamicImage) -> u64 {
    let gray = gray_601(img, 9, 8);
    let mut hash: u64 = 0;
    for y in 0..8u32 {
        for x in 0..8u32 {
            let left = gray[(y * 9 + x) as usize];
            let right = gray[(y * 9 + x + 1) as usize];
            if left > right {
                hash |= 1 << (y * 8 + x);
            }
        }
    }
    hash
}

fn hamming_distance(h1: u64, h2: u64) -> u32 {
    (h1 ^ h2).count_ones()
}

/// 用并查集把已确认对聚合成组（扫描/继续查共用）
fn build_groups(images: &[ScannedImg], verified: &[(usize, usize)]) -> (Vec<DupGroup>, u64, usize) {
    let n = images.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(p: &mut [usize], x: usize) -> usize {
        if p[x] != x {
            p[x] = find(p, p[x]);
        }
        p[x]
    }
    fn union(p: &mut [usize], a: usize, b: usize) {
        let ra = find(p, a);
        let rb = find(p, b);
        if ra != rb {
            p[ra] = rb;
        }
    }
    for (i, j) in verified {
        union(&mut parent, *i, *j);
    }

    let mut group_map: HashMap<usize, Vec<FileInfo>> = HashMap::new();
    for i in 0..n {
        let root = find(&mut parent, i);
        group_map.entry(root).or_default().push(images[i].info.clone());
    }

    let mut groups: Vec<DupGroup> = Vec::new();
    let mut total_wasted = 0u64;
    let mut total_files = 0usize;
    for (k, mut files) in group_map {
        if files.len() < 2 {
            continue;
        }
        // AI 查重按图片大小降序排列（方便“保留最大”）
        files.sort_by(|a, b| b.size.cmp(&a.size));
        let count = files.len();
        let min_size = files.iter().map(|f| f.size).min().unwrap_or(0);
        let wasted = (count - 1) as u64 * min_size;
        total_wasted += wasted;
        total_files += count;
        groups.push(DupGroup {
            hash: format!("ai-sim-{}", k),
            size: min_size,
            count,
            wasted,
            files,
            ai: Some(true),
        });
    }
    groups.sort_by(|a, b| b.wasted.cmp(&a.wasted));
    (groups, total_wasted, total_files)
}

/// 在已有扫描会话的基础上继续查下一批候选（不重扫全库、不重算哈希）。
pub fn execute_ai_dup_continue(
    data_dir: &Path,
    root_id: i64,
    rel: Option<&str>,
    max_pairs: Option<usize>,
    progress: Option<&dyn Fn(&str, usize, usize, usize)>,
) -> Result<serde_json::Value, String> {
    let key = session_key(root_id, rel);
    sweep_stale_ai_temps(&std::env::temp_dir(), 3600);
    let mut sess = {
        let mut m = sessions()
            .lock()
            .map_err(|_| "扫描会话锁失败".to_string())?;
        m.remove(&key)
    }
    .ok_or_else(|| "没有可继续的扫描结果，请先跑一次 AI 查重".to_string())?;

    let cfg = load_ai_config(data_dir);
    let has_key = !cfg.api_key.trim().is_empty();
    let max_p = max_pairs.unwrap_or(40).clamp(1, 200);
    let start = sess.checked;
    let end = (start + max_p).min(sess.candidates.len());
    if start >= sess.candidates.len() {
        return Err("候选已全部查完".to_string());
    }

    let batch: Vec<(usize, usize, u32)> = sess.candidates[start..end].to_vec();
    if let Some(cb) = progress {
        cb("ai", start, sess.candidates.len(), sess.total_candidates);
    }

    if has_key && !batch.is_empty() {
        let images_ref = &sess.images;
        let cfg_ref = &cfg;
        let results: Vec<(usize, usize, u32, Option<bool>, Option<String>)> =
            std::thread::scope(|s| {
                let mut handles = Vec::new();
                for chunk in batch.chunks(4) {
                    handles.push(s.spawn(move || {
                        chunk
                            .iter()
                            .map(|&(i, j, dist)| {
                                if AI_DUP_CANCEL_FLAG.load(Ordering::Relaxed) {
                                    return (i, j, dist, None, None);
                                }
                                let p_a = Path::new(&images_ref[i].info.thumb);
                                let p_b = Path::new(&images_ref[j].info.thumb);
                                match (file_to_data_url(p_a), file_to_data_url(p_b)) {
                                    (Some(da), Some(db)) => match call_ai_compare(cfg_ref, &da, &db) {
                                        Ok(v) => (i, j, dist, Some(v), None),
                                        Err(e) => (i, j, dist, None, Some(e)),
                                    },
                                    _ => (i, j, dist, None, Some("读取缩略图失败".to_string())),
                                }
                            })
                            .collect::<Vec<_>>()
                    }));
                }
                handles
                    .into_iter()
                    .flat_map(|h| h.join().unwrap_or_default())
                    .collect()
            });

        for (i, j, dist, verdict, err) in results {
            match verdict {
                Some(true) => {
                    sess.ai_calls += 1;
                    sess.verified.push((i, j));
                }
                Some(false) => {
                    sess.ai_calls += 1;
                }
                None => {
                    if let Some(e) = err {
                        sess.ai_calls += 1;
                        sess.ai_fail += 1;
                        if sess.ai_error.is_none() {
                            sess.ai_error = Some(e);
                        }
                        if dist <= 4 {
                            sess.verified.push((i, j));
                        }
                    }
                }
            }
        }
    }

    sess.checked = end;
    let (groups, wasted, files) = build_groups(&sess.images, &sess.verified);
    let remaining = sess.candidates.len().saturating_sub(sess.checked);
    let group_count = groups.len();
    let out = json!({
        "ok": true,
        "rootId": root_id,
        "rel": rel,
        "groups": groups,
        "stats": {
            "scopes": sess.scopes,
            "candidates": sess.total_candidates,
            "dhashPairs": sess.dhash_pairs,
            "colorFiltered": sess.color_filtered,
            "aiCalls": sess.ai_calls,
            "aiFail": sess.ai_fail,
            "aiError": sess.ai_error,
            "withAi": has_key,
            "groups": group_count,
            "files": files,
            "wasted": wasted,
            "checked": sess.checked,
            "remaining": remaining,
            "ms": 0,
        }
    });
    sess.created_at = Instant::now();
    insert_ai_session(key, sess);
    Ok(out)
}

/// 水平翻转后的 dHash（旧版 hashFlip）。
/// 用于认出镜像翻转过的同一张图：直接拿 A 的翻转 hash 去比 B。
fn compute_dhash_flip(img: &image::DynamicImage) -> u64 {
    let gray = gray_601(img, 9, 8);
    let mut hash: u64 = 0;
    for y in 0..8u32 {
        for x in 0..8u32 {
            // 水平镜像：镜像后第 x 格对应原图第 (8-x) 列对 (7-x) 列
            let left = gray[(y * 9 + (8 - x)) as usize];
            let right = gray[(y * 9 + (7 - x)) as usize];
            if left > right {
                hash |= 1 << (y * 8 + x);
            }
        }
    }
    hash
}

/// 32×32 白底 RGB（旧版 `flatten({background:"#fff"}).resize(32)` 的等价）
fn flatten_white_32(img: &image::DynamicImage) -> Vec<u8> {
    let small = img.resize_exact(32, 32, image::imageops::FilterType::Lanczos3);
    let rgba = small.to_rgba8();
    let mut out = Vec::with_capacity(32 * 32 * 3);
    for p in rgba.pixels() {
        let a = p[3] as u32;
        let blend = |c: u8| -> u8 { ((c as u32 * a + 255 * (255 - a)) / 255) as u8 };
        out.push(blend(p[0]));
        out.push(blend(p[1]));
        out.push(blend(p[2]));
    }
    out
}

/// 色块差异：每像素 RGB 量化到 3bit（每通道取高 3 位）后逐点比，返回不同像素数。
/// 旧版口径 colorLimit = 128（1024 像素里允许 128 个不同）。
fn color_diff(a: &[u8], b: &[u8]) -> usize {
    let mut diff = 0usize;
    let n = a.len().min(b.len());
    let mut i = 0;
    while i + 2 < n {
        let ca = ((a[i] >> 5) << 6) | ((a[i + 1] >> 5) << 3) | (a[i + 2] >> 5);
        let cb = ((b[i] >> 5) << 6) | ((b[i + 1] >> 5) << 3) | (b[i + 2] >> 5);
        if ca != cb {
            diff += 1;
        }
        i += 3;
    }
    diff
}

/// 64-bit pHash：32×32 灰度做 DCT，取左上 8×8 低频（去 DC）中位数二值化。
/// 同时返回水平翻转版本（2D-DCT 翻转后奇数阶 u 反号，用于镜像感知）。
/// 采用预计算 8×32 余弦表 + 可分离 2D-DCT（先对 32 行做 8 点 1D-DCT 存入 32×8 栈数组，再对 8 列做 8 点 1D-DCT），
/// 与原三重循环数学完全等价，消除每张图 64,512 次 f64::cos() 调用。
fn dct_cos_table() -> &'static [[f64; 32]; 8] {
    static COS_TABLE: std::sync::OnceLock<[[f64; 32]; 8]> = std::sync::OnceLock::new();
    COS_TABLE.get_or_init(|| {
        use std::f64::consts::PI;
        let mut tbl = [[0.0f64; 32]; 8];
        for u in 0..8 {
            for x in 0..32 {
                tbl[u][x] = (((2 * x + 1) as f64) * (u as f64) * PI / 64.0).cos();
            }
        }
        tbl
    })
}

fn compute_phash(rgb: &[u8]) -> (Vec<u64>, Vec<u64>) {
    let mut g = [0f64; 1024];
    for i in 0..1024 {
        let r = rgb[i * 3] as f64;
        let gg = rgb[i * 3 + 1] as f64;
        let b = rgb[i * 3 + 2] as f64;
        g[i] = 0.299 * r + 0.587 * gg + 0.114 * b;
    }
    let cos_tbl = dct_cos_table();
    // 第一步：对 32 行做 8 点 1D-DCT，存入 32×8 栈数组 row_dct[y][u]
    let mut row_dct = [[0.0f64; 8]; 32];
    for y in 0..32 {
        let row = &g[y * 32..y * 32 + 32];
        for u in 0..8 {
            let cu = &cos_tbl[u];
            let mut s = 0.0f64;
            for x in 0..32 {
                s += row[x] * cu[x];
            }
            row_dct[y][u] = s;
        }
    }
    // 第二步：对 8 列做 8 点 1D-DCT
    let mut vals: Vec<f64> = Vec::with_capacity(63);
    let mut flip_vals: Vec<f64> = Vec::with_capacity(63);
    for v in 0..8 {
        let cv = &cos_tbl[v];
        for u in 0..8 {
            if u == 0 && v == 0 {
                continue;
            }
            let mut s = 0.0f64;
            for y in 0..32 {
                s += row_dct[y][u] * cv[y];
            }
            vals.push(s);
            flip_vals.push(if u % 2 == 1 { -s } else { s });
        }
    }
    let to_bits = |arr: &[f64]| -> Vec<u64> {
        let mut sorted = arr.to_vec();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let med = sorted[sorted.len() / 2];
        let mut out = vec![0u64; 2];
        for (bit, val) in arr.iter().enumerate() {
            if *val > med {
                if bit < 64 {
                    out[bit / 64] |= 1u64 << (bit % 64);
                }
            }
        }
        out
    };
    (to_bits(&vals), to_bits(&flip_vals))
}

fn phash_dist(a: &[u64], b: &[u64]) -> u32 {
    let mut d = 0u32;
    for i in 0..a.len().min(b.len()) {
        d += (a[i] ^ b[i]).count_ones();
    }
    d
}

// 将缩略图转为 data-url
fn file_to_data_url(p: &Path) -> Option<String> {
    let bytes = fs::read(p).ok()?;
    if bytes.is_empty() {
        return None;
    }
    // 对齐旧版 picnestAiThumbData：384×384 inside + 白底 + JPEG q95。
    // 直接端原缩略图大小不一，模型对不同尺寸的容忍度更差；
    // 统一到 384 也能把上传体积降下来（AI 阶段每对图都要传两张）。
    let mut out = Vec::new();
    if let Ok(img) = image::load_from_memory(&bytes) {
        let small = img.resize(384, 384, image::imageops::FilterType::Triangle);
        let rgb = if small.color().has_alpha() {
            let rgba = small.to_rgba8();
            let (w, h) = rgba.dimensions();
            let mut buf = image::RgbImage::new(w, h);
            for (x, y, px) in rgba.enumerate_pixels() {
                let a = px[3] as u32;
                let blend = |c: u8| -> u8 { ((c as u32 * a + 255 * (255 - a)) / 255) as u8 };
                buf.put_pixel(x, y, image::Rgb([blend(px[0]), blend(px[1]), blend(px[2])]));
            }
            buf
        } else {
            small.to_rgb8()
        };
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 95);
        if enc
            .encode(rgb.as_raw(), rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
            .is_err()
        {
            out.clear();
        }
    }
    if out.is_empty() {
        // 解码失败就退回原文件（保留 MIME 嗅探的旧行为）
        let mime = match p
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .as_deref()
        {
            Some("png") => "image/png",
            Some("webp") => "image/webp",
            Some("gif") => "image/gif",
            Some("bmp") => "image/bmp",
            _ => "image/jpeg",
        };
        return Some(format!(
            "data:{};base64,{}",
            mime,
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes)
        ));
    }
    Some(format!(
        "data:image/jpeg;base64,{}",
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &out)
    ))
}

pub fn execute_ai_dup_scan(
    db_path: &Path,
    data_dir: &Path,
    root_id: i64,
    rel: Option<&str>,
    max_pairs: Option<usize>,
    progress: Option<&(dyn Fn(&str, usize, usize, usize) + Sync)>,
) -> Result<serde_json::Value, String> {
    // 开扫前先扔掉以前异常退出留下的请求/响应临时文件（里面有 base64 图，不能长期躺在 %TEMP%）
    sweep_stale_ai_temps(&std::env::temp_dir(), 3600);
    let notify = |phase: &str, done: usize, total: usize, cands: usize| {
        if let Some(cb) = progress {
            cb(phase, done, total, cands);
        }
    };
    AI_DUP_CANCEL_FLAG.store(false, Ordering::SeqCst);
    let t0 = Instant::now();

    let cfg = load_ai_config(data_dir);
    let max_p = max_pairs.unwrap_or(40).clamp(1, 200);
    let conn = crate::db::open_conn_with_pragmas(db_path).map_err(|e| e.to_string())?;
    // 哈希阶段的进度分母：先查总数，否则前端显示 “192/0”
    let est_total: usize = conn
        .query_row(
            "SELECT COUNT(*) FROM images WHERE folder_id = ?1 AND deleted_at IS NULL",
            [root_id],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0) as usize;

    let root_path: String = conn
        .query_row("SELECT path FROM folders WHERE id = ?1", [root_id], |r| r.get(0))
        .map_err(|_| "资料库不存在".to_string())?;

    let root_p = Path::new(&root_path);
    let scope_rel = rel.unwrap_or("").trim().trim_matches(|c| c == '/' || c == '\\').replace('/', "\\");
    let prefix_filter = if !scope_rel.is_empty() {
        let base = if root_path.ends_with('\\') {
            format!("{}{}", root_path, scope_rel)
        } else {
            format!("{}\\{}", root_path, scope_rel)
        };
        Some(base.to_lowercase())
    } else {
        None
    };

    let _ = conn.execute(
        "CREATE TABLE IF NOT EXISTS picnest_img_hash (
            file_path TEXT PRIMARY KEY,
            size INTEGER NOT NULL,
            mtime INTEGER NOT NULL,
            dhash INTEGER NOT NULL,
            dhash_flip INTEGER NOT NULL,
            color BLOB NOT NULL,
            phash0 INTEGER NOT NULL,
            phash1 INTEGER NOT NULL,
            phash_flip0 INTEGER NOT NULL,
            phash_flip1 INTEGER NOT NULL
        )",
        [],
    );

    let mut stmt = conn
        .prepare(
            "SELECT i.id, i.file_path, i.size, i.mtime, i.width, i.height, i.thumbnail_path, \
                    h.dhash, h.dhash_flip, h.color, h.phash0, h.phash1, h.phash_flip0, h.phash_flip1 \
             FROM images i \
             LEFT JOIN picnest_img_hash h \
               ON h.file_path = i.file_path AND h.size = i.size AND h.mtime = i.mtime \
             WHERE i.folder_id = ?1 AND i.deleted_at IS NULL",
        )
        .map_err(|e| e.to_string())?;

    let mut rows = stmt.query([root_id]).map_err(|e| e.to_string())?;

    struct RawScanItem {
        idx: usize,
        info: FileInfo,
        aspect: f32,
        cached: Option<(u64, u64, Vec<u8>, Vec<u64>, Vec<u64>)>,
    }

    let mut raw_items: Vec<RawScanItem> = Vec::with_capacity(est_total);
    let mut total_scanned = 0usize;

    while let Some(r) = rows.next().map_err(|e| e.to_string())? {
        if AI_DUP_CANCEL_FLAG.load(Ordering::Relaxed) {
            return Ok(json!({ "ok": true, "canceled": true, "groups": [], "stats": null }));
        }

        let id: i64 = r.get(0).map_err(|e| e.to_string())?;
        let fp: String = r.get(1).map_err(|e| e.to_string())?;
        let size: u64 = r.get(2).map_err(|e| e.to_string())?;
        let mtime: i64 = r.get(3).map_err(|e| e.to_string())?;
        let width: u32 = r.get(4).unwrap_or(0);
        let height: u32 = r.get(5).unwrap_or(0);
        let thumb_path: Option<String> = r.get(6).ok();

        if let Some(ref pf) = prefix_filter {
            if !fp.to_lowercase().starts_with(pf) {
                continue;
            }
        }

        let p = Path::new(&fp);
        let idx = total_scanned;
        total_scanned += 1;

        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let rel_of = if let Ok(rel_path) = p.parent().unwrap_or(p).strip_prefix(root_p) {
            rel_path.to_string_lossy().replace('\\', "/")
        } else {
            String::new()
        };

        let thumb = thumb_path
            .filter(|s| !s.is_empty() && s != "SKIP")
            .unwrap_or_else(|| {
                let md5_hash = format!("{:x}", crate::commands::fnv1a_hash(fp.as_bytes()));
                let p_cand = data_dir.join("cache").join("thumbs").join(format!("{}-q80.jpg", md5_hash));
                if p_cand.exists() {
                    p_cand.to_string_lossy().to_string()
                } else {
                    fp.clone()
                }
            });

        let aspect = if height > 0 { width as f32 / height as f32 } else { 1.0 };

        let cached = match (
            r.get::<_, Option<i64>>(7).ok().flatten(),
            r.get::<_, Option<i64>>(8).ok().flatten(),
            r.get::<_, Option<Vec<u8>>>(9).ok().flatten(),
            r.get::<_, Option<i64>>(10).ok().flatten(),
            r.get::<_, Option<i64>>(11).ok().flatten(),
            r.get::<_, Option<i64>>(12).ok().flatten(),
            r.get::<_, Option<i64>>(13).ok().flatten(),
        ) {
            (Some(dh), Some(dhf), Some(col), Some(p0), Some(p1), Some(pf0), Some(pf1))
                if col.len() == 32 * 32 * 3 =>
            {
                Some((
                    dh as u64,
                    dhf as u64,
                    col,
                    vec![p0 as u64, p1 as u64],
                    vec![pf0 as u64, pf1 as u64],
                ))
            }
            _ => None,
        };

        raw_items.push(RawScanItem {
            idx,
            info: FileInfo {
                id,
                path: fp,
                name,
                size,
                mtime,
                width,
                height,
                thumb,
                rel: rel_of,
            },
            aspect,
            cached,
        });
    }
    drop(rows);
    drop(stmt);

    let mut images: Vec<Option<ScannedImg>> = vec![None; raw_items.len()];
    let mut uncached: Vec<RawScanItem> = Vec::new();
    let done_counter = AtomicUsize::new(0);

    for item in raw_items {
        if let Some((dh, dhf, col, ph, phf)) = item.cached {
            let cur = done_counter.fetch_add(1, Ordering::Relaxed) + 1;
            if cur % 64 == 0 {
                notify("hash", cur, total_scanned.max(est_total), 0);
            }
            images[item.idx] = Some(ScannedImg {
                info: item.info,
                dhash: Some(dh),
                dhash_flip: Some(dhf),
                aspect: item.aspect,
                color: Some(col),
                phash: Some(ph),
                phash_flip: Some(phf),
            });
        } else {
            uncached.push(item);
        }
    }

    if !uncached.is_empty() {
        use rayon::prelude::*;
        let computed: Vec<(usize, ScannedImg, Option<(String, i64, i64, i64, i64, Vec<u8>, i64, i64, i64, i64)>)> =
            uncached
                .into_par_iter()
                .map(|item| {
                    if AI_DUP_CANCEL_FLAG.load(Ordering::Relaxed) {
                        let empty = ScannedImg {
                            info: item.info,
                            dhash: None,
                            dhash_flip: None,
                            aspect: item.aspect,
                            color: None,
                            phash: None,
                            phash_flip: None,
                        };
                        return (item.idx, empty, None);
                    }
                    let thumb_file = Path::new(&item.info.thumb);
                    let orig_file = Path::new(&item.info.path);
                    let img_target = if thumb_file.exists() { thumb_file } else { orig_file };

                    let mut dhash = None;
                    let mut dhash_flip = None;
                    let mut color32: Option<Vec<u8>> = None;
                    let mut phash: Option<Vec<u64>> = None;
                    let mut phash_flip: Option<Vec<u64>> = None;
                    let mut cache_row = None;

                    if let Ok(bytes) = fs::read(img_target) {
                        if let Ok(d_img) = image::load_from_memory(&bytes) {
                            let dh = compute_dhash(&d_img);
                            let dhf = compute_dhash_flip(&d_img);
                            let c = flatten_white_32(&d_img);
                            let (ph, phf) = compute_phash(&c);
                            cache_row = Some((
                                item.info.path.clone(),
                                item.info.size as i64,
                                item.info.mtime,
                                dh as i64,
                                dhf as i64,
                                c.clone(),
                                ph.first().copied().unwrap_or(0) as i64,
                                ph.get(1).copied().unwrap_or(0) as i64,
                                phf.first().copied().unwrap_or(0) as i64,
                                phf.get(1).copied().unwrap_or(0) as i64,
                            ));
                            dhash = Some(dh);
                            dhash_flip = Some(dhf);
                            color32 = Some(c);
                            phash = Some(ph);
                            phash_flip = Some(phf);
                        }
                    }

                    let cur = done_counter.fetch_add(1, Ordering::Relaxed) + 1;
                    if cur % 64 == 0 {
                        notify("hash", cur, total_scanned.max(est_total), 0);
                    }

                    let scanned = ScannedImg {
                        info: item.info,
                        dhash,
                        dhash_flip,
                        aspect: item.aspect,
                        color: color32,
                        phash,
                        phash_flip,
                    };
                    (item.idx, scanned, cache_row)
                })
                .collect();

        if AI_DUP_CANCEL_FLAG.load(Ordering::Relaxed) {
            return Ok(json!({ "ok": true, "canceled": true, "groups": [], "stats": null }));
        }

        let mut to_cache = Vec::with_capacity(computed.len());
        for (idx, sc, crow) in computed {
            images[idx] = Some(sc);
            if let Some(r) = crow {
                to_cache.push(r);
            }
        }

        if !to_cache.is_empty() {
            if let Ok(tx) = conn.unchecked_transaction() {
                if let Ok(mut ins) = tx.prepare(
                    "INSERT OR REPLACE INTO picnest_img_hash \
                     (file_path, size, mtime, dhash, dhash_flip, color, phash0, phash1, phash_flip0, phash_flip1) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                ) {
                    for r in to_cache {
                        let _ = ins.execute(rusqlite::params![r.0, r.1, r.2, r.3, r.4, r.5, r.6, r.7, r.8, r.9]);
                    }
                }
                let _ = tx.commit();
            }
        }
    }

    let images: Vec<ScannedImg> = images.into_iter().flatten().collect();

    notify("hash", total_scanned, total_scanned, 0);

    // 寻找候选对：严格对齐旧版 picnest-handlers.js 的 AI 查重循环
    //   threshold = 10（不是 8）
    //   d = min(直接汉明距离, 镜像汉明距离)
    //   不看宽高比（旧版没有这个条件；加了会砍掉“同版式不同裁切”的候选，
    //   而那正是最需要 AI 判断的）
    // 筛出候选对时直接把已计算的 color_diff 存入元组第 4 项，避免 sort_by 时重复跑 1024 像素循环
    let mut candidate_pairs_with_cd: Vec<(usize, usize, u32, usize)> = Vec::new();
    let mut dhash_pairs = 0usize;
    let mut color_filtered = 0usize;
    let mut cd_fail_sum: u64 = 0;
    let mut cd_fail_min: usize = usize::MAX;
    let mut ph_fail_sum: u64 = 0;
    let mut ph_fail_min: u32 = u32::MAX;
    let mut cd_fail_n: u64 = 0;
    const DHASH_THRESHOLD: u32 = 10;
    const COLOR_BYPASS: u32 = 4;
    const COLOR_LIMIT: usize = 128;
    const PHASH_LIMIT: u32 = 6;
    let n = images.len();
    for i in 0..n {
        let Some(h1) = images[i].dhash else { continue };
        for j in (i + 1)..n {
            let Some(h2) = images[j].dhash else { continue };
            let d_direct = hamming_distance(h1, h2);
            let d_flip = images[i]
                .dhash_flip
                .map(|f| hamming_distance(f, h2))
                .unwrap_or(u32::MAX);
            let d = d_direct.min(d_flip);
            if d > DHASH_THRESHOLD {
                continue;
            }
            dhash_pairs += 1;
            let cd = match (&images[i].color, &images[j].color) {
                (Some(a), Some(b)) => Some(color_diff(a, b)),
                _ => None,
            };
            let ph = match (&images[i].phash, &images[j].phash, &images[i].phash_flip) {
                (Some(a), Some(b), Some(f)) => {
                    Some(phash_dist(a, b).min(phash_dist(f, b)))
                }
                _ => None,
            };
            // 旧版：d≤4 放行；色块/pHash 缺一就放行；两者都过门槛才放行
            let pass = d <= COLOR_BYPASS
                || cd.is_none()
                || ph.is_none()
                || (cd.unwrap_or(usize::MAX) <= COLOR_LIMIT && ph.unwrap_or(u32::MAX) <= PHASH_LIMIT);
            if pass {
                candidate_pairs_with_cd.push((i, j, d, cd.unwrap_or(9999)));
            } else {
                color_filtered += 1;
                if let Some(v) = cd {
                    cd_fail_sum += v as u64;
                    if v < cd_fail_min {
                        cd_fail_min = v;
                    }
                }
                if let Some(v) = ph {
                    ph_fail_sum += v as u64;
                    if v < ph_fail_min {
                        ph_fail_min = v;
                    }
                }
                cd_fail_n += 1;
            }
        }
    }

    // 排序：dHash 距离，其次色块差异（直接复用已计算的 cd，消除排序比较中的重复像素循环）
    candidate_pairs_with_cd.sort_by(|a, b| a.2.cmp(&b.2).then_with(|| a.3.cmp(&b.3)));
    let mut candidate_pairs: Vec<(usize, usize, u32)> = candidate_pairs_with_cd
        .into_iter()
        .map(|(i, j, d, _)| (i, j, d))
        .collect();
    let total_candidates = candidate_pairs.len();
    let all_candidates = candidate_pairs.clone();
    if candidate_pairs.len() > max_p {
        candidate_pairs.truncate(max_p);
    }
    let candidate_pairs_len = candidate_pairs.len();

    if candidate_pairs.is_empty() {
        return Ok(json!({
            "ok": true,
            "rootId": root_id,
            "rel": scope_rel,
            "groups": [],
            "stats": {
                "scopes": total_scanned,
                "candidates": 0,
                "dhashPairs": dhash_pairs,
                "colorFiltered": color_filtered,
                "aiCalls": 0,
                "aiFail": 0,
                "withAi": !cfg.api_key.trim().is_empty(),
                "groups": 0,
                "files": 0,
                "wasted": 0,
                "checked": 0,
                "ms": t0.elapsed().as_millis(),
            }
        }));
    }

    // 确认对集合
    let mut verified_pairs: Vec<(usize, usize)> = Vec::new();
    let has_key = !cfg.api_key.trim().is_empty();
    let mut ai_calls = 0usize;
    let mut ai_fail = 0usize;
    let mut ai_error: Option<String> = None;

    if has_key && !candidate_pairs.is_empty() {
        // 4 路并发（对齐旧版）。每个候选对只做一件事：把两张缩略图交给 AI 判定。
        let pairs_snapshot: Vec<(usize, usize, u32)> = candidate_pairs.clone();
        let results: Vec<(usize, usize, u32, Option<bool>, Option<String>)> = std::thread::scope(|s| {
            let mut handles = Vec::new();
            for chunk in pairs_snapshot.chunks(4) {
                let images_ref = &images;
                let cfg_ref = &cfg;
                handles.push(s.spawn(move || {
                    chunk
                        .iter()
                        .map(|&(i, j, dist)| {
                            if AI_DUP_CANCEL_FLAG.load(Ordering::Relaxed) {
                                return (i, j, dist, None, None);
                            }
                            let p_a = Path::new(&images_ref[i].info.thumb);
                            let p_b = Path::new(&images_ref[j].info.thumb);
                            match (file_to_data_url(p_a), file_to_data_url(p_b)) {
                                (Some(da), Some(db)) => match call_ai_compare(cfg_ref, &da, &db) {
                                    Ok(v) => (i, j, dist, Some(v), None),
                                    Err(e) => (i, j, dist, None, Some(e)),
                                },
                                _ => (i, j, dist, None, Some("读取缩略图失败".to_string())),
                            }
                        })
                        .collect::<Vec<_>>()
                }));
            }
            handles
                .into_iter()
                .flat_map(|h| h.join().unwrap_or_default())
                .collect()
        });

        notify("ai", 0, candidate_pairs.len(), total_candidates);

    for (i, j, dist, verdict, err) in results {
            match verdict {
                Some(true) => {
                    ai_calls += 1;
                    verified_pairs.push((i, j));
                    notify("ai", ai_calls + ai_fail, candidate_pairs_len, total_candidates);
                }
                Some(false) => {
                    ai_calls += 1;
                    notify("ai", ai_calls + ai_fail, candidate_pairs_len, total_candidates);
                }
                None => {
                    if let Some(e) = err {
                        ai_calls += 1;
                        ai_fail += 1;
                        if ai_error.is_none() {
                            ai_error = Some(e);
                        }
                        // AI 不可用时退回本地判断：dHash 很接近就当成相似
                        if dist <= COLOR_BYPASS {
                            verified_pairs.push((i, j));
                        }
                    }
                }
            }
        }
    } else {
        for (i, j, dist) in &candidate_pairs {
            if *dist <= COLOR_BYPASS {
                verified_pairs.push((*i, *j));
            }
        }
    }

    if verified_pairs.is_empty() {
        // 即使这批没确认任何对，也要存会话，以便“继续查”
        insert_ai_session(
            session_key(root_id, rel),
            AiScanSession {
                created_at: Instant::now(),
                images: images.clone(),
                candidates: all_candidates.clone(),
                verified: Vec::new(),
                checked: candidate_pairs_len,
                total_candidates,
                dhash_pairs,
                color_filtered,
                scopes: total_scanned,
                ai_calls,
                ai_fail,
                ai_error: ai_error.clone(),
            },
        );
        return Ok(json!({
            "ok": true,
            "rootId": root_id,
            "rel": scope_rel,
            "groups": [],
            "stats": {
                "scopes": total_scanned,
                "candidates": total_candidates,
                "dhashPairs": dhash_pairs,
                "colorFiltered": color_filtered,
                "aiCalls": ai_calls,
                "aiFail": ai_fail,
                "withAi": has_key,
                "groups": 0,
                "files": 0,
                "wasted": 0,
                "checked": verified_pairs.len(),
                "ms": t0.elapsed().as_millis(),
            }
        }));
    }

    // 并查集聚合（抽成函数，以便“继续查”复用）
    let (ai_groups, total_wasted, total_files) = build_groups(&images, &verified_pairs);

    // 保存扫描会话：下次同一目录“继续查”不用重扫全库
    insert_ai_session(
        session_key(root_id, rel),
        AiScanSession {
            created_at: Instant::now(),
            images: images.clone(),
            candidates: all_candidates.clone(),
            verified: verified_pairs.clone(),
            checked: candidate_pairs_len,
            total_candidates,
            dhash_pairs,
            color_filtered,
            scopes: total_scanned,
            ai_calls,
            ai_fail,
            ai_error: ai_error.clone(),
        },
    );

    let group_count = ai_groups.len();
    Ok(json!({
        "ok": true,
        "rootId": root_id,
        "rel": scope_rel,
        "groups": ai_groups,
        "stats": {
            "scopes": total_scanned,
            "candidates": total_candidates,
            "dhashPairs": dhash_pairs,
            "colorFiltered": color_filtered,
            "aiCalls": ai_calls,
            "aiFail": ai_fail,
            "aiError": ai_error,
            // 诊断：被色块/pHash 筛掉的那批，它们的实际数值分布
            "cdFailAvg": if cd_fail_n > 0 { (cd_fail_sum / cd_fail_n) as u32 } else { 0 },
            "cdFailMin": if cd_fail_min == usize::MAX { 0 } else { cd_fail_min as u32 },
            "phFailAvg": if cd_fail_n > 0 { (ph_fail_sum / cd_fail_n) as u32 } else { 0 },
            "phFailMin": if ph_fail_min == u32::MAX { 0 } else { ph_fail_min },
            "withAi": has_key,
            "groups": group_count,
            "files": total_files,
            "wasted": total_wasted,
            "checked": candidate_pairs_len,
            "remaining": total_candidates.saturating_sub(candidate_pairs_len),
            "ms": t0.elapsed().as_millis(),
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 临时请求/响应文件必须能被扫掉，且不误伤别的临时文件
    #[test]
    fn sweep_stale_ai_temps_only_touches_its_own_files() {
        let dir = std::env::temp_dir().join(format!("picnest_ai_sweep_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let own = dir.join("picnest_ai_req_1_1.json");
        let own2 = dir.join("picnest_ai_resp_1_1.json");
        let other = dir.join("someone_else.json");
        for p in [&own, &own2, &other] {
            fs::write(p, b"{}").unwrap();
        }
        // max_age = 0：全部视为过期
        let removed = sweep_stale_ai_temps(&dir, 0);
        assert_eq!(removed, 2, "只该删自己的两个文件");
        assert!(!own.exists() && !own2.exists());
        assert!(other.exists(), "别把别人的临时文件删了");
        let _ = fs::remove_dir_all(&dir);
    }
}
