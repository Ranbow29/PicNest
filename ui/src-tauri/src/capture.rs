use crate::AppState;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Debug, Serialize)]
pub struct WinRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone)]
pub struct CapturedMonitor {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub scale_factor: f64,
    pub bgra: Vec<u8>,
}

struct CaptureSession {
    id: u64,
    monitors: Vec<CapturedMonitor>,
    windows: Vec<WinRect>,
    cursor_x: i32,
    cursor_y: i32,
}

#[derive(Clone)]
struct PinItem {
    id: u64,
    width: u32,
    height: u32,
    png: Vec<u8>,
    bgra: Vec<u8>,
    scale_factor: f64,
    cur_sf: f64,
    opacity: f64,
    screen_x: i32,
    screen_y: i32,
    cur_w: i32,
    cur_h: i32,
    click_through: bool,
    drag_anchor: Option<(i32, i32, i32, i32)>,
    drag_tracks_lbutton: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum HotkeyTarget {
    Capture,
    PinThrough,
}

#[derive(Clone)]
struct HotkeyState {
    canonical: String,
    mods: u32,
    vk: u32,
    registered: bool,
}

struct HotkeyRebindReq {
    target: HotkeyTarget,
    mods: u32,
    vk: u32,
    canonical: String,
    reply: std::sync::mpsc::SyncSender<Result<String, String>>,
}

static SESSION_SEQ: AtomicU64 = AtomicU64::new(1);
static PIN_SEQ: AtomicU64 = AtomicU64::new(1);
static CURRENT_CAPTURE: OnceLock<Mutex<Option<CaptureSession>>> = OnceLock::new();
static CAPTURE_TARGET_DIR: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static PIN_STORE: OnceLock<Mutex<HashMap<u64, PinItem>>> = OnceLock::new();
static HOTKEY_STATE: OnceLock<Mutex<HotkeyState>> = OnceLock::new();
static THROUGH_HOTKEY_STATE: OnceLock<Mutex<HotkeyState>> = OnceLock::new();
static HOTKEY_REBIND_REQ: OnceLock<Mutex<Option<HotkeyRebindReq>>> = OnceLock::new();
static HOTKEY_THREAD_ID: AtomicU32 = AtomicU32::new(0);
static TRAY_CAPTURE_ITEM: OnceLock<tauri::menu::MenuItem<tauri::Wry>> = OnceLock::new();
static TRAY_THROUGH_ITEM: OnceLock<tauri::menu::MenuItem<tauri::Wry>> = OnceLock::new();
static HOTKEY_ACTIVE: AtomicBool = AtomicBool::new(false);
static CAPTURE_LAUNCHING: AtomicBool = AtomicBool::new(false);
static DRAG_LOOP_RUNNING: AtomicBool = AtomicBool::new(false);

pub fn compute_zoomed_rect(
    cur_x: i32,
    cur_y: i32,
    cur_w: i32,
    cur_h: i32,
    new_w: i32,
    new_h: i32,
    anchor_rx: f64,
    anchor_ry: f64,
) -> (i32, i32, i32, i32) {
    let arx = anchor_rx.clamp(0.0, 1.0);
    let ary = anchor_ry.clamp(0.0, 1.0);
    let nw = new_w.clamp(48, 8192);
    let nh = new_h.clamp(48, 8192);
    let nx = (cur_x as f64 + arx * (cur_w as f64 - nw as f64)).round() as i32;
    let ny = (cur_y as f64 + ary * (cur_h as f64 - nh as f64)).round() as i32;
    (nx, ny, nw, nh)
}

pub fn compute_relative_zoom_size(
    orig_w: u32,
    orig_h: u32,
    orig_sf: f64,
    cur_w: i32,
    cur_sf: f64,
    factor: f64,
) -> (i32, i32, u32) {
    let base_w = (orig_w.max(1) as f64) * (cur_sf.max(1.0) / orig_sf.max(1.0));
    let aspect = (orig_h.max(1) as f64) / (orig_w.max(1) as f64);
    let min_w = (base_w * 0.15).max(48.0);
    let max_w = (base_w * 4.0).min(8192.0).max(min_w);
    let f = if factor.is_finite() && factor > 0.0 { factor } else { 1.0 };
    let target_w = ((cur_w.max(48) as f64) * f).clamp(min_w, max_w);
    let nw = target_w.round() as i32;
    let nh = (target_w * aspect).round().clamp(48.0, 8192.0) as i32;
    let percent = ((nw as f64 / base_w.max(1.0)) * 100.0)
        .round()
        .clamp(1.0, 999.0) as u32;
    (nw, nh, percent)
}

fn capture_lock() -> &'static Mutex<Option<CaptureSession>> {
    CURRENT_CAPTURE.get_or_init(|| Mutex::new(None))
}

fn target_dir_lock() -> &'static Mutex<Option<String>> {
    CAPTURE_TARGET_DIR.get_or_init(|| Mutex::new(None))
}

fn pin_lock() -> &'static Mutex<HashMap<u64, PinItem>> {
    PIN_STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn hotkey_rebind_lock() -> &'static Mutex<Option<HotkeyRebindReq>> {
    HOTKEY_REBIND_REQ.get_or_init(|| Mutex::new(None))
}

pub fn get_pin_png(id: u64) -> Option<Vec<u8>> {
    let guard = pin_lock().lock().ok()?;
    guard.get(&id).map(|item| item.png.clone())
}

fn remove_pin(id: u64) {
    if let Ok(mut guard) = pin_lock().lock() {
        guard.remove(&id);
    }
}

fn parse_pin_id(label: &str) -> Option<u64> {
    label.strip_prefix("pin-").and_then(|s| s.parse::<u64>().ok())
}

pub fn parse_hotkey_spec(spec: &str) -> Result<(u32, u32, String), String> {
    const MOD_ALT_FLAG: u32 = 0x0001;
    const MOD_CTRL_FLAG: u32 = 0x0002;
    const MOD_SHIFT_FLAG: u32 = 0x0004;

    let mut mods: u32 = 0;
    let mut key_pair: Option<(u32, String)> = None;

    for raw_tok in spec.split('+') {
        let tok = raw_tok.trim();
        if tok.is_empty() {
            continue;
        }
        let upper = tok.to_ascii_uppercase();
        match upper.as_str() {
            "CTRL" | "CONTROL" => mods |= MOD_CTRL_FLAG,
            "ALT" => mods |= MOD_ALT_FLAG,
            "SHIFT" => mods |= MOD_SHIFT_FLAG,
            _ => {
                if key_pair.is_some() {
                    return Err("快捷键只能包含一个主键（如 Alt+Q、Ctrl+Alt+A、F1）".to_string());
                }
                let parsed = if upper.len() == 1 {
                    let ch = upper.as_bytes()[0];
                    if ch.is_ascii_uppercase() || ch.is_ascii_digit() {
                        Some((ch as u32, upper.clone()))
                    } else {
                        None
                    }
                } else if let Some(num_str) = upper.strip_prefix('F')
                    && let Ok(n) = num_str.parse::<u32>()
                    && (1..=12).contains(&n)
                {
                    Some((0x6F + n, format!("F{}", n)))
                } else {
                    match upper.as_str() {
                        "PRINTSCREEN" | "PRTSC" | "SNAPSHOT" => Some((0x2C, "PrintScreen".to_string())),
                        "SPACE" => Some((0x20, "Space".to_string())),
                        "INSERT" | "INS" => Some((0x2D, "Insert".to_string())),
                        "DELETE" | "DEL" => Some((0x2E, "Delete".to_string())),
                        "HOME" => Some((0x24, "Home".to_string())),
                        "END" => Some((0x23, "End".to_string())),
                        "PAGEUP" | "PGUP" => Some((0x21, "PageUp".to_string())),
                        "PAGEDOWN" | "PGDN" => Some((0x22, "PageDown".to_string())),
                        _ => None,
                    }
                };
                match parsed {
                    Some(v) => key_pair = Some(v),
                    None => return Err(format!("不支持的按键: {}", tok)),
                }
            }
        }
    }

    let Some((vk, key_name)) = key_pair else {
        return Err("请指定一个有效按键（如 Alt+Q、Ctrl+Alt+A、F1）".to_string());
    };

    let is_fn_or_prtsc = (0x70..=0x7B).contains(&vk) || vk == 0x2C;
    if mods == 0 && !is_fn_or_prtsc {
        return Err("普通按键必须搭配 Ctrl / Alt / Shift 修饰键".to_string());
    }
    if mods == MOD_ALT_FLAG && vk == 0x73 {
        return Err("Alt+F4 为系统关闭窗口快捷键，不能占用".to_string());
    }
    if mods == MOD_CTRL_FLAG && matches!(vk, 0x43 | 0x56 | 0x58 | 0x5A | 0x41 | 0x53) {
        return Err("Ctrl+C/V/X/Z/A/S 为通用编辑快捷键，请换一个组合".to_string());
    }

    let mut parts: Vec<String> = Vec::with_capacity(4);
    if (mods & MOD_CTRL_FLAG) != 0 {
        parts.push("Ctrl".to_string());
    }
    if (mods & MOD_ALT_FLAG) != 0 {
        parts.push("Alt".to_string());
    }
    if (mods & MOD_SHIFT_FLAG) != 0 {
        parts.push("Shift".to_string());
    }
    parts.push(key_name);
    Ok((mods, vk, parts.join("+")))
}

fn hotkey_config_path() -> PathBuf {
    crate::app_data_dir().join("capture_hotkey.txt")
}

fn through_hotkey_config_path() -> PathBuf {
    crate::app_data_dir().join("pin_through_hotkey.txt")
}

fn load_saved_hotkey() -> (u32, u32, String) {
    if let Ok(raw) = std::fs::read_to_string(hotkey_config_path())
        && let Ok(parsed) = parse_hotkey_spec(&raw)
    {
        return parsed;
    }
    (0x0001, 0x51, "Alt+Q".to_string())
}

fn load_saved_through_hotkey() -> (u32, u32, String) {
    if let Ok(raw) = std::fs::read_to_string(through_hotkey_config_path())
        && let Ok(parsed) = parse_hotkey_spec(&raw)
    {
        return parsed;
    }
    (0x0005, 0x50, "Alt+Shift+P".to_string())
}

fn save_hotkey_text(canonical: &str) {
    let path = hotkey_config_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, canonical);
}

fn save_through_hotkey_text(canonical: &str) {
    let path = through_hotkey_config_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, canonical);
}

fn hotkey_state_lock() -> &'static Mutex<HotkeyState> {
    HOTKEY_STATE.get_or_init(|| {
        let (mods, vk, canonical) = load_saved_hotkey();
        Mutex::new(HotkeyState {
            canonical,
            mods,
            vk,
            registered: false,
        })
    })
}

fn through_hotkey_state_lock() -> &'static Mutex<HotkeyState> {
    THROUGH_HOTKEY_STATE.get_or_init(|| {
        let (mods, vk, canonical) = load_saved_through_hotkey();
        Mutex::new(HotkeyState {
            canonical,
            mods,
            vk,
            registered: false,
        })
    })
}

pub fn register_tray_capture_item(item: tauri::menu::MenuItem<tauri::Wry>) {
    let _ = TRAY_CAPTURE_ITEM.set(item);
}

pub fn register_tray_through_item(item: tauri::menu::MenuItem<tauri::Wry>) {
    let _ = TRAY_THROUGH_ITEM.set(item);
}

pub fn current_hotkey_label() -> String {
    hotkey_state_lock()
        .lock()
        .map(|g| g.canonical.clone())
        .unwrap_or_else(|_| "Alt+Q".to_string())
}

pub fn current_through_hotkey_label() -> String {
    through_hotkey_state_lock()
        .lock()
        .map(|g| g.canonical.clone())
        .unwrap_or_else(|_| "Alt+Shift+P".to_string())
}

/// 构造 top-down 32bpp BI_RGB BMP 内存字节流（零压缩耗时，供本地 media_server 直出）
pub fn build_bmp_from_bgra(width: i32, height: i32, bgra: &[u8]) -> Option<Vec<u8>> {
    if width <= 0 || height <= 0 {
        return None;
    }
    let expected = (width as usize).checked_mul(height as usize)?.checked_mul(4)?;
    if bgra.len() < expected {
        return None;
    }
    let img_bytes = expected as u32;
    let file_size = 54u32.checked_add(img_bytes)?;
    let mut out = Vec::with_capacity(file_size as usize);

    // BITMAPFILEHEADER (14 bytes)
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&file_size.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&54u32.to_le_bytes());

    // BITMAPINFOHEADER (40 bytes), biHeight < 0 -> top-down
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&(-height).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&32u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&img_bytes.to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());

    out.extend_from_slice(&bgra[..expected]);
    Some(out)
}

/// 从整屏 top-down BGRA 提取裁剪区域
pub fn crop_bgra(
    mon_bgra: &[u8],
    mon_w: u32,
    mon_h: u32,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
) -> Result<(u32, u32, Vec<u8>), String> {
    if mon_w == 0 || mon_h == 0 {
        return Err("显示器尺寸无效".to_string());
    }
    let sx = x.min(mon_w.saturating_sub(1));
    let sy = y.min(mon_h.saturating_sub(1));
    let cw = w.min(mon_w - sx);
    let ch = h.min(mon_h - sy);
    if cw == 0 || ch == 0 {
        return Err("选区宽高不能为 0".to_string());
    }
    let stride = (mon_w as usize) * 4;
    let row_bytes = (cw as usize) * 4;
    if mon_bgra.len() < (mon_h as usize) * stride {
        return Err("屏幕位图数据不完整".to_string());
    }
    let mut out = Vec::with_capacity((ch as usize) * row_bytes);
    for row in 0..ch {
        let offset = ((sy + row) as usize) * stride + (sx as usize) * 4;
        out.extend_from_slice(&mon_bgra[offset..offset + row_bytes]);
    }
    Ok((cw, ch, out))
}

/// top-down BGRA -> RGBA（将 GDI Alpha=0 坑位统一重置为不透明 255）
pub fn bgra_to_opaque_rgba(bgra: &[u8]) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(bgra.len());
    for px in bgra.chunks_exact(4) {
        rgba.push(px[2]);
        rgba.push(px[1]);
        rgba.push(px[0]);
        rgba.push(255);
    }
    rgba
}

/// top-down BGRA -> bottom-up 32bpp DIB（写入 Windows CF_DIB 剪贴板）
pub fn bgra_to_bottom_up_dib(w: u32, h: u32, bgra: &[u8]) -> Vec<u8> {
    let row_bytes = (w as usize) * 4;
    let img_bytes = (row_bytes * (h as usize)) as u32;
    let mut dib = Vec::with_capacity(40 + img_bytes as usize);

    dib.extend_from_slice(&40u32.to_le_bytes());
    dib.extend_from_slice(&(w as i32).to_le_bytes());
    dib.extend_from_slice(&(h as i32).to_le_bytes());
    dib.extend_from_slice(&1u16.to_le_bytes());
    dib.extend_from_slice(&32u16.to_le_bytes());
    dib.extend_from_slice(&0u32.to_le_bytes());
    dib.extend_from_slice(&img_bytes.to_le_bytes());
    dib.extend_from_slice(&0i32.to_le_bytes());
    dib.extend_from_slice(&0i32.to_le_bytes());
    dib.extend_from_slice(&0u32.to_le_bytes());
    dib.extend_from_slice(&0u32.to_le_bytes());

    for row in (0..h as usize).rev() {
        let start = row * row_bytes;
        for px in bgra[start..start + row_bytes].chunks_exact(4) {
            dib.push(px[0]);
            dib.push(px[1]);
            dib.push(px[2]);
            dib.push(255);
        }
    }
    dib
}

fn encode_png_bytes(w: u32, h: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut buf);
    use image::ImageEncoder;
    encoder
        .write_image(rgba, w, h, image::ExtendedColorType::Rgba8)
        .map_err(|e| format!("PNG 编码失败: {}", e))?;
    Ok(buf)
}

/// 解码前端合成的无损 PNG Base64，并返回 (w, h, png_bytes, top-down opaque BGRA)
pub fn decode_annotated_png(b64: &str) -> Result<(u32, u32, Vec<u8>, Vec<u8>), String> {
    use base64::Engine;
    let clean = b64
        .trim()
        .strip_prefix("data:image/png;base64,")
        .unwrap_or_else(|| b64.trim());
    let png_bytes = base64::engine::general_purpose::STANDARD
        .decode(clean)
        .map_err(|e| format!("标注图像 Base64 解码失败: {}", e))?;
    let dyn_img = image::load_from_memory(&png_bytes)
        .map_err(|e| format!("标注图像 PNG 解析失败: {}", e))?;
    let rgba = dyn_img.into_rgba8();
    let (w, h) = rgba.dimensions();
    if w == 0 || h == 0 {
        return Err("标注图像尺寸无效".to_string());
    }
    let raw = rgba.into_raw();
    let mut bgra = Vec::with_capacity(raw.len());
    for px in raw.chunks_exact(4) {
        bgra.push(px[2]);
        bgra.push(px[1]);
        bgra.push(px[0]);
        bgra.push(255);
    }
    Ok((w, h, png_bytes, bgra))
}

pub fn get_monitor_bmp(session_id: u64, mon_idx: usize) -> Option<Vec<u8>> {
    let guard = capture_lock().lock().ok()?;
    let sess = guard.as_ref()?;
    if sess.id != session_id {
        return None;
    }
    let mon = sess.monitors.get(mon_idx)?;
    build_bmp_from_bgra(mon.width, mon.height, &mon.bgra)
}

#[cfg(windows)]
mod win32 {
    use super::*;
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct Rect {
        pub left: i32,
        pub top: i32,
        pub right: i32,
        pub bottom: i32,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct Point {
        pub x: i32,
        pub y: i32,
    }

    #[repr(C)]
    struct MonitorInfoExW {
        cb_size: u32,
        rc_monitor: Rect,
        rc_work: Rect,
        dw_flags: u32,
        sz_device: [u16; 32],
    }

    #[repr(C)]
    #[derive(Default)]
    struct BitmapInfoHeader {
        bi_size: u32,
        bi_width: i32,
        bi_height: i32,
        bi_planes: u16,
        bi_bit_count: u16,
        bi_compression: u32,
        bi_size_image: u32,
        bi_x_pels_per_meter: i32,
        bi_y_pels_per_meter: i32,
        bi_clr_used: u32,
        bi_clr_important: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct BitmapInfo {
        bmi_header: BitmapInfoHeader,
        bmi_colors: [u32; 3],
    }

    #[repr(C)]
    #[derive(Default)]
    struct WinMsg {
        hwnd: isize,
        message: u32,
        w_param: usize,
        l_param: isize,
        time: u32,
        pt: Point,
        l_private: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    pub struct SystemTime {
        pub year: u16,
        pub month: u16,
        pub day_of_week: u16,
        pub day: u16,
        pub hour: u16,
        pub minute: u16,
        pub second: u16,
        pub milliseconds: u16,
    }

    const SRCCOPY: u32 = 0x00CC0020;
    const CAPTUREBLT: u32 = 0x40000000;
    const GWL_EXSTYLE: i32 = -20;
    const WS_EX_TOOLWINDOW: isize = 0x00000080;
    const WS_EX_NOACTIVATE: isize = 0x08000000;
    const WS_EX_LAYERED: isize = 0x00080000;
    const LWA_ALPHA: u32 = 0x00000002;
    const DWMWA_EXTENDED_FRAME_BOUNDS: u32 = 9;
    const DWMWA_CLOAKED: u32 = 14;
    const GMEM_MOVEABLE: u32 = 0x0002;
    const CF_DIB: u32 = 8;
    const CF_UNICODETEXT: u32 = 13;
    const MOD_ALT_BIT: u32 = 0x0001;
    const MOD_SHIFT_BIT: u32 = 0x0004;
    const MOD_NOREPEAT: u32 = 0x4000;
    const VK_LBUTTON: i32 = 0x01;
    const VK_P: u32 = 0x50;
    const WM_HOTKEY: u32 = 0x0312;
    const WM_USER_REBIND_HOTKEY: u32 = 0x0451;
    const HOTKEY_ID: i32 = 0x504E;
    const HOTKEY_ID_THROUGH: i32 = 0x504F;
    const HWND_TOPMOST: isize = -1;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const MONITOR_DEFAULTTONEAREST: u32 = 2;
    const SM_XVIRTUALSCREEN: i32 = 76;
    const SM_YVIRTUALSCREEN: i32 = 77;
    const SM_CXVIRTUALSCREEN: i32 = 78;
    const SM_CYVIRTUALSCREEN: i32 = 79;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn EnumDisplayMonitors(
            hdc: isize,
            lprc_clip: *const Rect,
            lpfn_enum: unsafe extern "system" fn(isize, isize, *mut Rect, isize) -> i32,
            dw_data: isize,
        ) -> i32;
        fn GetMonitorInfoW(hmonitor: isize, lpmi: *mut MonitorInfoExW) -> i32;
        fn MonitorFromWindow(hwnd: isize, dw_flags: u32) -> isize;
        fn GetDC(hwnd: isize) -> isize;
        fn ReleaseDC(hwnd: isize, hdc: isize) -> i32;
        fn GetCursorPos(lp_point: *mut Point) -> i32;
        fn EnumWindows(
            lp_enum_func: unsafe extern "system" fn(isize, isize) -> i32,
            l_param: isize,
        ) -> i32;
        fn IsWindowVisible(hwnd: isize) -> i32;
        fn IsIconic(hwnd: isize) -> i32;
        fn GetWindowRect(hwnd: isize, lp_rect: *mut Rect) -> i32;
        fn GetWindowThreadProcessId(hwnd: isize, lpdw_process_id: *mut u32) -> u32;
        fn GetWindowLongPtrW(hwnd: isize, n_index: i32) -> isize;
        fn SetWindowLongPtrW(hwnd: isize, n_index: i32, dw_new_long: isize) -> isize;
        fn SetLayeredWindowAttributes(hwnd: isize, cr_key: u32, b_alpha: u8, dw_flags: u32) -> i32;
        fn GetWindowTextLengthW(hwnd: isize) -> i32;
        fn GetSystemMetrics(n_index: i32) -> i32;
        fn SetWindowPos(
            hwnd: isize,
            hwnd_insert_after: isize,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            u_flags: u32,
        ) -> i32;
        fn OpenClipboard(hwnd_new_owner: *mut c_void) -> i32;
        fn CloseClipboard() -> i32;
        fn EmptyClipboard() -> i32;
        fn SetClipboardData(u_format: u32, h_mem: *mut c_void) -> *mut c_void;
        fn RegisterClipboardFormatW(lpsz_format: *const u16) -> u32;
        fn RegisterHotKey(hwnd: isize, id: i32, fs_modifiers: u32, vk: u32) -> i32;
        fn UnregisterHotKey(hwnd: isize, id: i32) -> i32;
        fn GetMessageW(lp_msg: *mut WinMsg, hwnd: isize, w_msg_min: u32, w_msg_max: u32) -> i32;
        fn PeekMessageW(
            lp_msg: *mut WinMsg,
            hwnd: isize,
            w_msg_min: u32,
            w_msg_max: u32,
            w_remove_msg: u32,
        ) -> i32;
        fn PostThreadMessageW(id_thread: u32, msg: u32, w_param: usize, l_param: isize) -> i32;
        fn GetAsyncKeyState(v_key: i32) -> i16;
    }

    #[link(name = "gdi32")]
    unsafe extern "system" {
        fn CreateCompatibleDC(hdc: isize) -> isize;
        fn DeleteDC(hdc: isize) -> i32;
        fn CreateCompatibleBitmap(hdc: isize, cx: i32, cy: i32) -> isize;
        fn SelectObject(hdc: isize, h: isize) -> isize;
        fn DeleteObject(ho: isize) -> i32;
        fn BitBlt(
            hdc: isize,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            hdc_src: isize,
            x1: i32,
            y1: i32,
            rop: u32,
        ) -> i32;
        fn GetDIBits(
            hdc: isize,
            hbm: isize,
            start: u32,
            c_lines: u32,
            lpv_bits: *mut c_void,
            lpbmi: *mut BitmapInfo,
            usage: u32,
        ) -> i32;
    }

    #[link(name = "dwmapi")]
    unsafe extern "system" {
        fn DwmGetWindowAttribute(
            hwnd: isize,
            dw_attribute: u32,
            pv_attribute: *mut c_void,
            cb_attribute: u32,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcessId() -> u32;
        fn GetCurrentThreadId() -> u32;
        fn GetLocalTime(lp_system_time: *mut SystemTime);
        fn GlobalAlloc(u_flags: u32, dw_bytes: usize) -> *mut c_void;
        fn GlobalLock(h_mem: *mut c_void) -> *mut c_void;
        fn GlobalUnlock(h_mem: *mut c_void) -> i32;
        fn GlobalFree(h_mem: *mut c_void) -> *mut c_void;
        fn LoadLibraryW(lp_lib_file_name: *const u16) -> isize;
        fn GetProcAddress(h_module: isize, lp_proc_name: *const u8) -> *const c_void;
    }

    pub fn local_timestamp_name() -> String {
        let mut st = SystemTime::default();
        unsafe { GetLocalTime(&mut st) };
        format!(
            "PicNest_{:04}{:02}{:02}_{:02}{:02}{:02}",
            st.year, st.month, st.day, st.hour, st.minute, st.second
        )
    }

    struct MonRaw {
        hmon: isize,
        rect: Rect,
    }

    unsafe extern "system" fn enum_mon_cb(
        hmon: isize,
        _hdc: isize,
        lprc: *mut Rect,
        lparam: isize,
    ) -> i32 {
        let list = unsafe { &mut *(lparam as *mut Vec<MonRaw>) };
        let mut info = MonitorInfoExW {
            cb_size: std::mem::size_of::<MonitorInfoExW>() as u32,
            rc_monitor: Rect::default(),
            rc_work: Rect::default(),
            dw_flags: 0,
            sz_device: [0; 32],
        };
        let ok = unsafe { GetMonitorInfoW(hmon, &mut info) } != 0;
        let rect = if ok {
            info.rc_monitor
        } else if !lprc.is_null() {
            unsafe { *lprc }
        } else {
            return 1;
        };
        list.push(MonRaw { hmon, rect });
        1
    }

    fn monitor_scale_factor(hmon: isize) -> f64 {
        type GetDpiFn = unsafe extern "system" fn(isize, i32, *mut u32, *mut u32) -> i32;
        static GET_DPI_FN: OnceLock<Option<GetDpiFn>> = OnceLock::new();
        let func = *GET_DPI_FN.get_or_init(|| unsafe {
            let wide: Vec<u16> = "shcore.dll\0".encode_utf16().collect();
            let hmod = LoadLibraryW(wide.as_ptr());
            if hmod == 0 {
                return None;
            }
            let ptr = GetProcAddress(hmod, b"GetDpiForMonitor\0".as_ptr());
            if ptr.is_null() {
                None
            } else {
                Some(std::mem::transmute::<*const c_void, GetDpiFn>(ptr))
            }
        });
        if let Some(f) = func {
            let mut dx = 96u32;
            let mut dy = 96u32;
            let hr = unsafe { f(hmon, 0, &mut dx, &mut dy) };
            if hr == 0 && dx >= 96 {
                return (dx as f64) / 96.0;
            }
        }
        1.0
    }

    pub fn capture_all_monitors() -> Result<(Vec<CapturedMonitor>, i32, i32), String> {
        let mut raws: Vec<MonRaw> = Vec::new();
        unsafe {
            EnumDisplayMonitors(0, std::ptr::null(), enum_mon_cb, (&mut raws) as *mut _ as isize);
        }
        if raws.is_empty() {
            return Err("未检测到可用显示器".to_string());
        }

        let mut pt = Point::default();
        unsafe { GetCursorPos(&mut pt) };

        let hdc_screen = unsafe { GetDC(0) };
        if hdc_screen == 0 {
            return Err("GetDC(0) 失败".to_string());
        }

        let mut out = Vec::with_capacity(raws.len());
        for m in raws {
            let w = m.rect.right - m.rect.left;
            let h = m.rect.bottom - m.rect.top;
            if w <= 0 || h <= 0 {
                continue;
            }
            let hdc_mem = unsafe { CreateCompatibleDC(hdc_screen) };
            if hdc_mem == 0 {
                continue;
            }
            let hbm = unsafe { CreateCompatibleBitmap(hdc_screen, w, h) };
            if hbm == 0 {
                unsafe { DeleteDC(hdc_mem) };
                continue;
            }
            let old = unsafe { SelectObject(hdc_mem, hbm) };
            let blt_ok = unsafe {
                BitBlt(
                    hdc_mem,
                    0,
                    0,
                    w,
                    h,
                    hdc_screen,
                    m.rect.left,
                    m.rect.top,
                    SRCCOPY | CAPTUREBLT,
                )
            } != 0;
            unsafe { SelectObject(hdc_mem, old) };

            let mut bgra = vec![0u8; (w as usize) * (h as usize) * 4];
            if blt_ok {
                let mut bmi = BitmapInfo::default();
                bmi.bmi_header.bi_size = std::mem::size_of::<BitmapInfoHeader>() as u32;
                bmi.bmi_header.bi_width = w;
                bmi.bmi_header.bi_height = -h; // top-down
                bmi.bmi_header.bi_planes = 1;
                bmi.bmi_header.bi_bit_count = 32;
                bmi.bmi_header.bi_compression = 0; // BI_RGB
                unsafe {
                    GetDIBits(
                        hdc_mem,
                        hbm,
                        0,
                        h as u32,
                        bgra.as_mut_ptr() as *mut c_void,
                        &mut bmi,
                        0,
                    );
                }
            }

            unsafe {
                DeleteObject(hbm);
                DeleteDC(hdc_mem);
            }

            out.push(CapturedMonitor {
                x: m.rect.left,
                y: m.rect.top,
                width: w,
                height: h,
                scale_factor: monitor_scale_factor(m.hmon),
                bgra,
            });
        }

        unsafe { ReleaseDC(0, hdc_screen) };
        if out.is_empty() {
            return Err("屏幕图像抓取失败".to_string());
        }
        Ok((out, pt.x, pt.y))
    }

    struct WinEnumCtx {
        self_pid: u32,
        rects: Vec<WinRect>,
    }

    unsafe extern "system" fn enum_win_cb(hwnd: isize, lparam: isize) -> i32 {
        let ctx = unsafe { &mut *(lparam as *mut WinEnumCtx) };
        unsafe {
            if IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 {
                return 1;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == ctx.self_pid {
                return 1;
            }
            let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            if (ex_style & WS_EX_TOOLWINDOW) != 0 && GetWindowTextLengthW(hwnd) == 0 {
                return 1;
            }
            let mut cloaked: u32 = 0;
            let hr_cloak = DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                (&mut cloaked) as *mut _ as *mut c_void,
                std::mem::size_of::<u32>() as u32,
            );
            if hr_cloak == 0 && cloaked != 0 {
                return 1;
            }
            let mut r = Rect::default();
            let hr_bounds = DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                (&mut r) as *mut _ as *mut c_void,
                std::mem::size_of::<Rect>() as u32,
            );
            if hr_bounds != 0 && GetWindowRect(hwnd, &mut r) == 0 {
                return 1;
            }
            let w = r.right - r.left;
            let h = r.bottom - r.top;
            if w >= 24 && h >= 24 {
                ctx.rects.push(WinRect {
                    x: r.left,
                    y: r.top,
                    width: w,
                    height: h,
                });
            }
        }
        1
    }

    pub fn snapshot_visible_windows() -> Vec<WinRect> {
        let mut ctx = WinEnumCtx {
            self_pid: unsafe { GetCurrentProcessId() },
            rects: Vec::new(),
        };
        unsafe {
            EnumWindows(enum_win_cb, (&mut ctx) as *mut _ as isize);
        }
        ctx.rects
    }

    pub fn cursor_pos_and_lbutton() -> (i32, i32, bool) {
        let mut pt = Point::default();
        unsafe {
            GetCursorPos(&mut pt);
            let down = (GetAsyncKeyState(VK_LBUTTON) as u16 & 0x8000) != 0;
            (pt.x, pt.y, down)
        }
    }

    pub fn clamp_rect_to_virtual_screen(x: i32, y: i32, w: i32, h: i32) -> (i32, i32) {
        unsafe {
            let vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
            let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN).max(640);
            let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN).max(480);
            let keep = 44;
            let nx = x.max(vx - w + keep).min(vx + vw - keep);
            let ny = y.max(vy - h + keep).min(vy + vh - keep);
            (nx, ny)
        }
    }

    pub fn get_window_rect_and_scale(win: &tauri::WebviewWindow) -> Option<(i32, i32, i32, i32, f64)> {
        let hwnd = win.hwnd().ok()?.0 as isize;
        if hwnd == 0 {
            return None;
        }
        unsafe {
            let mut r = Rect::default();
            if GetWindowRect(hwnd, &mut r) == 0 {
                return None;
            }
            let w = r.right - r.left;
            let h = r.bottom - r.top;
            if w <= 0 || h <= 0 {
                return None;
            }
            let hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            let sf = if hmon != 0 { monitor_scale_factor(hmon) } else { 1.0 };
            Some((r.left, r.top, w, h, sf))
        }
    }

    pub fn move_pin_pos(win: &tauri::WebviewWindow, x: i32, y: i32) {
        if let Ok(hwnd_val) = win.hwnd() {
            let hwnd = hwnd_val.0 as isize;
            if hwnd != 0 {
                unsafe {
                    SetWindowPos(
                        hwnd,
                        HWND_TOPMOST,
                        x,
                        y,
                        0,
                        0,
                        SWP_NOSIZE | SWP_NOACTIVATE,
                    );
                }
            }
        }
    }

    pub fn set_pin_rect(win: &tauri::WebviewWindow, x: i32, y: i32, w: i32, h: i32) {
        if let Ok(hwnd_val) = win.hwnd() {
            let hwnd = hwnd_val.0 as isize;
            if hwnd != 0 {
                unsafe {
                    SetWindowPos(
                        hwnd,
                        HWND_TOPMOST,
                        x,
                        y,
                        w.max(40),
                        h.max(40),
                        SWP_NOACTIVATE,
                    );
                }
            }
        }
    }

    pub fn position_pin_window(win: &tauri::WebviewWindow, x: i32, y: i32, w: i32, h: i32) {
        set_pin_rect(win, x, y, w, h);
    }

    pub fn resize_pin_centered(win: &tauri::WebviewWindow, new_w: i32, new_h: i32) {
        let Ok(hwnd_val) = win.hwnd() else { return };
        let hwnd = hwnd_val.0 as isize;
        if hwnd == 0 {
            return;
        }
        unsafe {
            let mut r = Rect::default();
            if GetWindowRect(hwnd, &mut r) == 0 {
                return;
            }
            let nw = new_w.max(40);
            let nh = new_h.max(40);
            let cx = (r.left + r.right) / 2;
            let cy = (r.top + r.bottom) / 2;
            let (nx, ny) = clamp_rect_to_virtual_screen(cx - nw / 2, cy - nh / 2, nw, nh);
            SetWindowPos(hwnd, HWND_TOPMOST, nx, ny, nw, nh, SWP_NOACTIVATE);
        }
    }

    pub fn set_window_opacity(win: &tauri::WebviewWindow, alpha: f64) {
        let Ok(hwnd_val) = win.hwnd() else { return };
        let hwnd = hwnd_val.0 as isize;
        if hwnd == 0 {
            return;
        }
        let byte = (alpha.clamp(0.15, 1.0) * 255.0).round() as u8;
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            if (ex & WS_EX_LAYERED) == 0 {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_LAYERED);
            }
            SetLayeredWindowAttributes(hwnd, 0, byte, LWA_ALPHA);
        }
    }

    pub fn set_window_no_activate(win: &tauri::WebviewWindow, no_activate: bool) {
        let Ok(hwnd_val) = win.hwnd() else { return };
        let hwnd = hwnd_val.0 as isize;
        if hwnd == 0 {
            return;
        }
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let next = if no_activate {
                ex | WS_EX_NOACTIVATE
            } else {
                ex & !WS_EX_NOACTIVATE
            };
            if next != ex {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
            }
        }
    }

    pub fn position_overlay_window(win: &tauri::WebviewWindow, mon: &CapturedMonitor) {
        if let Ok(hwnd_val) = win.hwnd() {
            let hwnd = hwnd_val.0 as isize;
            if hwnd != 0 {
                unsafe {
                    SetWindowPos(
                        hwnd,
                        HWND_TOPMOST,
                        mon.x,
                        mon.y,
                        mon.width,
                        mon.height,
                        SWP_NOACTIVATE,
                    );
                }
            }
        }
    }

    fn alloc_global(bytes: &[u8]) -> Result<*mut c_void, String> {
        unsafe {
            let hmem = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
            if hmem.is_null() {
                return Err("GlobalAlloc 失败".to_string());
            }
            let ptr = GlobalLock(hmem) as *mut u8;
            if ptr.is_null() {
                GlobalFree(hmem);
                return Err("GlobalLock 失败".to_string());
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
            GlobalUnlock(hmem);
            Ok(hmem)
        }
    }

    fn open_clipboard_retry() -> Result<(), String> {
        for i in 0..4 {
            if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
                return Ok(());
            }
            if i < 3 {
                std::thread::sleep(std::time::Duration::from_millis(15));
            }
        }
        Err("剪贴板正被其他程序占用".to_string())
    }

    pub fn write_image_to_clipboard(dib: &[u8], png: &[u8]) -> Result<(), String> {
        let h_dib = alloc_global(dib)?;
        let h_png = match alloc_global(png) {
            Ok(h) => h,
            Err(e) => {
                unsafe { GlobalFree(h_dib) };
                return Err(e);
            }
        };

        if let Err(e) = open_clipboard_retry() {
            unsafe {
                GlobalFree(h_dib);
                GlobalFree(h_png);
            }
            return Err(e);
        }

        unsafe {
            EmptyClipboard();
            if SetClipboardData(CF_DIB, h_dib).is_null() {
                GlobalFree(h_dib);
            }
            let png_name: Vec<u16> = "PNG\0".encode_utf16().collect();
            let png_fmt = RegisterClipboardFormatW(png_name.as_ptr());
            if png_fmt != 0 {
                if SetClipboardData(png_fmt, h_png).is_null() {
                    GlobalFree(h_png);
                }
            } else {
                GlobalFree(h_png);
            }
            CloseClipboard();
        }
        Ok(())
    }

    pub fn write_text_to_clipboard(text: &str) -> Result<(), String> {
        let mut wide: Vec<u16> = text.encode_utf16().collect();
        wide.push(0);
        let bytes = unsafe {
            std::slice::from_raw_parts(wide.as_ptr() as *const u8, wide.len() * 2)
        };
        let h_mem = alloc_global(bytes)?;
        if let Err(e) = open_clipboard_retry() {
            unsafe { GlobalFree(h_mem) };
            return Err(e);
        }
        unsafe {
            EmptyClipboard();
            if SetClipboardData(CF_UNICODETEXT, h_mem).is_null() {
                GlobalFree(h_mem);
            }
            CloseClipboard();
        }
        Ok(())
    }

    pub fn start_hotkey_thread(app: AppHandle) {
        std::thread::spawn(move || unsafe {
            // 强制提前创建线程消息队列，确保后续 PostThreadMessageW 不会因队列未就绪丢失
            let mut msg = WinMsg::default();
            PeekMessageW(&mut msg, 0, 0, 0, 0);
            HOTKEY_THREAD_ID.store(GetCurrentThreadId(), Ordering::SeqCst);

            let (mut cur_mods, mut cur_vk, mut cur_canonical) = load_saved_hotkey();
            let reg_ok = RegisterHotKey(0, HOTKEY_ID, cur_mods | MOD_NOREPEAT, cur_vk) != 0;
            if let Ok(mut g) = hotkey_state_lock().lock() {
                g.mods = cur_mods;
                g.vk = cur_vk;
                g.canonical = cur_canonical.clone();
                g.registered = reg_ok;
            }
            if reg_ok {
                crate::media_server::diag_push(&format!("capture hotkey {} registered", cur_canonical));
            } else {
                crate::media_server::diag_push(&format!(
                    "capture hotkey {} RegisterHotKey failed (may conflict with another app)",
                    cur_canonical
                ));
            }

            let (mut cur_through_mods, mut cur_through_vk, mut cur_through_canonical) =
                load_saved_through_hotkey();
            let through_ok = RegisterHotKey(
                0,
                HOTKEY_ID_THROUGH,
                cur_through_mods | MOD_NOREPEAT,
                cur_through_vk,
            ) != 0;
            if let Ok(mut g) = through_hotkey_state_lock().lock() {
                g.mods = cur_through_mods;
                g.vk = cur_through_vk;
                g.canonical = cur_through_canonical.clone();
                g.registered = through_ok;
            }
            if through_ok {
                crate::media_server::diag_push(&format!(
                    "pin click-through hotkey {} registered",
                    cur_through_canonical
                ));
            } else {
                crate::media_server::diag_push(&format!(
                    "pin click-through hotkey {} RegisterHotKey failed",
                    cur_through_canonical
                ));
            }

            while GetMessageW(&mut msg, 0, 0, 0) > 0 {
                if msg.message == WM_HOTKEY && msg.w_param == (HOTKEY_ID as usize) {
                    super::trigger_capture(&app);
                } else if msg.message == WM_HOTKEY && msg.w_param == (HOTKEY_ID_THROUGH as usize) {
                    let app_c = app.clone();
                    std::thread::spawn(move || {
                        super::toggle_all_pins_through(&app_c, false);
                    });
                } else if msg.message == WM_USER_REBIND_HOTKEY {
                    let req_opt = hotkey_rebind_lock().lock().ok().and_then(|mut g| g.take());
                    if let Some(req) = req_opt {
                        match req.target {
                            HotkeyTarget::Capture => {
                                if req.mods == cur_through_mods && req.vk == cur_through_vk {
                                    let _ = req.reply.send(Err(format!(
                                        "快捷键 {} 已分配给“贴图穿透开关”，请换一个组合键",
                                        req.canonical
                                    )));
                                    continue;
                                }
                                UnregisterHotKey(0, HOTKEY_ID);
                                if RegisterHotKey(0, HOTKEY_ID, req.mods | MOD_NOREPEAT, req.vk) != 0 {
                                    cur_mods = req.mods;
                                    cur_vk = req.vk;
                                    cur_canonical = req.canonical.clone();
                                    if let Ok(mut g) = hotkey_state_lock().lock() {
                                        g.mods = cur_mods;
                                        g.vk = cur_vk;
                                        g.canonical = cur_canonical.clone();
                                        g.registered = true;
                                    }
                                    save_hotkey_text(&cur_canonical);
                                    if let Some(item) = TRAY_CAPTURE_ITEM.get() {
                                        let item_c = item.clone();
                                        let label = format!("屏幕截图 ({})", cur_canonical);
                                        let _ = app.run_on_main_thread(move || {
                                            let _ = item_c.set_text(&label);
                                        });
                                    }
                                    crate::media_server::diag_push(&format!("capture hotkey rebound to {}", cur_canonical));
                                    let _ = req.reply.send(Ok(cur_canonical.clone()));
                                } else {
                                    let restored = RegisterHotKey(0, HOTKEY_ID, cur_mods | MOD_NOREPEAT, cur_vk) != 0;
                                    if let Ok(mut g) = hotkey_state_lock().lock() {
                                        g.mods = cur_mods;
                                        g.vk = cur_vk;
                                        g.canonical = cur_canonical.clone();
                                        g.registered = restored;
                                    }
                                    let _ = req.reply.send(Err(format!(
                                        "快捷键 {} 已被其他程序占用，已保留 {}",
                                        req.canonical, cur_canonical
                                    )));
                                }
                            }
                            HotkeyTarget::PinThrough => {
                                if req.mods == cur_mods && req.vk == cur_vk {
                                    let _ = req.reply.send(Err(format!(
                                        "快捷键 {} 已分配给“屏幕截图”，请换一个组合键",
                                        req.canonical
                                    )));
                                    continue;
                                }
                                UnregisterHotKey(0, HOTKEY_ID_THROUGH);
                                if RegisterHotKey(0, HOTKEY_ID_THROUGH, req.mods | MOD_NOREPEAT, req.vk) != 0 {
                                    cur_through_mods = req.mods;
                                    cur_through_vk = req.vk;
                                    cur_through_canonical = req.canonical.clone();
                                    if let Ok(mut g) = through_hotkey_state_lock().lock() {
                                        g.mods = cur_through_mods;
                                        g.vk = cur_through_vk;
                                        g.canonical = cur_through_canonical.clone();
                                        g.registered = true;
                                    }
                                    save_through_hotkey_text(&cur_through_canonical);
                                    if let Some(item) = TRAY_THROUGH_ITEM.get() {
                                        let item_c = item.clone();
                                        let label = format!("解除贴图穿透 ({})", cur_through_canonical);
                                        let _ = app.run_on_main_thread(move || {
                                            let _ = item_c.set_text(&label);
                                        });
                                    }
                                    let _ = app.emit(
                                        "picnest:through-hotkey-changed",
                                        json!({ "hotkey": cur_through_canonical }),
                                    );
                                    crate::media_server::diag_push(&format!("pin through hotkey rebound to {}", cur_through_canonical));
                                    let _ = req.reply.send(Ok(cur_through_canonical.clone()));
                                } else {
                                    let restored = RegisterHotKey(
                                        0,
                                        HOTKEY_ID_THROUGH,
                                        cur_through_mods | MOD_NOREPEAT,
                                        cur_through_vk,
                                    ) != 0;
                                    if let Ok(mut g) = through_hotkey_state_lock().lock() {
                                        g.mods = cur_through_mods;
                                        g.vk = cur_through_vk;
                                        g.canonical = cur_through_canonical.clone();
                                        g.registered = restored;
                                    }
                                    let _ = req.reply.send(Err(format!(
                                        "快捷键 {} 已被其他程序占用，已保留 {}",
                                        req.canonical, cur_through_canonical
                                    )));
                                }
                            }
                        }
                    }
                }
            }
            UnregisterHotKey(0, HOTKEY_ID);
            UnregisterHotKey(0, HOTKEY_ID_THROUGH);
        });
    }

    pub fn request_rebind_hotkey(
        target: HotkeyTarget,
        mods: u32,
        vk: u32,
        canonical: String,
    ) -> Result<String, String> {
        let tid = HOTKEY_THREAD_ID.load(Ordering::SeqCst);
        if tid == 0 {
            return Err("热键服务尚未就绪".to_string());
        }
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        {
            let mut guard = hotkey_rebind_lock().lock().map_err(|_| "热键锁异常".to_string())?;
            *guard = Some(HotkeyRebindReq {
                target,
                mods,
                vk,
                canonical,
                reply: tx,
            });
        }
        let posted = unsafe { PostThreadMessageW(tid, WM_USER_REBIND_HOTKEY, 0, 0) };
        if posted == 0 {
            return Err("无法投递热键切换请求".to_string());
        }
        rx.recv_timeout(std::time::Duration::from_secs(2))
            .map_err(|_| "热键切换超时".to_string())?
    }
}

#[cfg(not(windows))]
mod win32 {
    use super::*;
    pub fn local_timestamp_name() -> String { "PicNest_capture".to_string() }
    pub fn capture_all_monitors() -> Result<(Vec<CapturedMonitor>, i32, i32), String> {
        Err("当前平台暂不支持原生截屏".to_string())
    }
    pub fn snapshot_visible_windows() -> Vec<WinRect> { Vec::new() }
    pub fn position_overlay_window(_win: &tauri::WebviewWindow, _mon: &CapturedMonitor) {}
    pub fn cursor_pos_and_lbutton() -> (i32, i32, bool) { (0, 0, false) }
    pub fn clamp_rect_to_virtual_screen(x: i32, y: i32, _w: i32, _h: i32) -> (i32, i32) { (x, y) }
    pub fn get_window_rect_and_scale(_win: &tauri::WebviewWindow) -> Option<(i32, i32, i32, i32, f64)> { None }
    pub fn move_pin_pos(_win: &tauri::WebviewWindow, _x: i32, _y: i32) {}
    pub fn set_pin_rect(_win: &tauri::WebviewWindow, _x: i32, _y: i32, _w: i32, _h: i32) {}
    pub fn position_pin_window(_win: &tauri::WebviewWindow, _x: i32, _y: i32, _w: i32, _h: i32) {}
    pub fn resize_pin_centered(_win: &tauri::WebviewWindow, _w: i32, _h: i32) {}
    pub fn set_window_opacity(_win: &tauri::WebviewWindow, _alpha: f64) {}
    pub fn set_window_no_activate(_win: &tauri::WebviewWindow, _no_activate: bool) {}
    pub fn write_image_to_clipboard(_dib: &[u8], _png: &[u8]) -> Result<(), String> {
        Err("当前平台暂不支持剪贴板写入".to_string())
    }
    pub fn write_text_to_clipboard(_text: &str) -> Result<(), String> {
        Err("当前平台暂不支持剪贴板写入".to_string())
    }
    pub fn start_hotkey_thread(_app: AppHandle) {}
    pub fn request_rebind_hotkey(
        _target: HotkeyTarget,
        _mods: u32,
        _vk: u32,
        _canonical: String,
    ) -> Result<String, String> {
        Err("当前平台暂不支持全局热键".to_string())
    }
}

pub fn start_hotkey_listener(app: AppHandle) {
    if HOTKEY_ACTIVE.swap(true, Ordering::SeqCst) {
        return;
    }
    win32::start_hotkey_thread(app);
}

fn close_capture_windows(app: &AppHandle) {
    for (label, win) in app.webview_windows() {
        if label.starts_with("capture-") {
            let _ = win.close();
        }
    }
}

fn clear_capture_session(app: &AppHandle) {
    close_capture_windows(app);
    if let Ok(mut guard) = capture_lock().lock() {
        *guard = None;
    }
}

pub fn trigger_capture(app: &AppHandle) -> Value {
    // 若已有截图浮层打开，直接聚焦光标所在或首个浮层，防止叠窗
    let existing: Vec<String> = app
        .webview_windows()
        .keys()
        .filter(|k| k.starts_with("capture-"))
        .cloned()
        .collect();
    if !existing.is_empty() {
        if let Some(first) = existing.first().and_then(|l| app.get_webview_window(l)) {
            let _ = first.show();
            let _ = first.set_focus();
        }
        return json!({ "ok": true, "alreadyOpen": true });
    }

    if CAPTURE_LAUNCHING.swap(true, Ordering::SeqCst) {
        return json!({ "ok": true, "launching": true });
    }

    let app_c = app.clone();
    // 关键：在 Windows Tauri v2 下，绝不能在 UI 主线程（托盘菜单 / 同步命令 / run_on_main_thread）里
    // 同步调用 WebviewWindowBuilder::build()，否则会与 WebView2 初始化消息泵互相阻塞造成永久死锁。
    std::thread::spawn(move || {
        struct LaunchGuard;
        impl Drop for LaunchGuard {
            fn drop(&mut self) {
                CAPTURE_LAUNCHING.store(false, Ordering::SeqCst);
            }
        }
        let _guard = LaunchGuard;

        let t0 = std::time::Instant::now();
        let (monitors, cursor_x, cursor_y) = match win32::capture_all_monitors() {
            Ok(v) => v,
            Err(e) => {
                crate::media_server::diag_push(&format!("capture_all_monitors failed: {}", e));
                let _ = app_c.emit("picnest:capture-error", json!({ "error": e }));
                return;
            }
        };
        let windows = win32::snapshot_visible_windows();
        let session_id = SESSION_SEQ.fetch_add(1, Ordering::Relaxed);
        let mon_snapshots: Vec<(usize, i32, i32, f64, CapturedMonitor)> = monitors
            .iter()
            .enumerate()
            .map(|(i, m)| (i, m.width, m.height, m.scale_factor, m.clone()))
            .collect();

        crate::media_server::diag_push(&format!(
            "capture session={} monitors={} windows={} grabbed_in={}ms",
            session_id,
            mon_snapshots.len(),
            windows.len(),
            t0.elapsed().as_millis()
        ));

        {
            let mut guard = capture_lock().lock().unwrap_or_else(|e| e.into_inner());
            *guard = Some(CaptureSession {
                id: session_id,
                monitors,
                windows,
                cursor_x,
                cursor_y,
            });
        }

        let is_dev = std::env::var("PICNEST_DEV").map(|v| v == "1").unwrap_or(false);
        let shared_args = crate::shared_webview_args();
        let shared_data_dir = crate::shared_webview_data_dir();
        let mut built_any = false;
        let mut last_err = String::new();

        for (i, width, height, scale_factor, mon) in mon_snapshots {
            let label = format!("capture-{}", i);
            let make_url = || {
                if is_dev {
                    tauri::WebviewUrl::External(
                        "http://127.0.0.1:5173/"
                            .parse()
                            .expect("valid dev capture url"),
                    )
                } else {
                    tauri::WebviewUrl::App("index.html".into())
                }
            };

            let logical_w = (width as f64) / scale_factor.max(1.0);
            let logical_h = (height as f64) / scale_factor.max(1.0);

            let build_with = |data_dir: Option<std::path::PathBuf>| {
                let mut b = tauri::WebviewWindowBuilder::new(&app_c, &label, make_url())
                    .title("PicNest Capture")
                    .inner_size(logical_w.max(100.0), logical_h.max(100.0))
                    .decorations(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .resizable(false)
                    .shadow(false)
                    .visible(false);
                if !shared_args.is_empty() {
                    b = b.additional_browser_args(&shared_args);
                }
                if let Some(d) = data_dir {
                    b = b.data_directory(d);
                }
                b.build()
            };

            // 1. 优先复用与主窗完全一致的 browser_args + data_directory（避免 WebView2 0x8007139F）
            let built = match build_with(shared_data_dir.clone()) {
                Ok(w) => Ok(w),
                Err(first_err) => {
                    crate::media_server::diag_push(&format!(
                        "capture window {} primary build failed ({}), retrying isolated data_dir",
                        label, first_err
                    ));
                    // 2. 兜底：使用独立 capture_webview 数据目录重建
                    let fallback_dir = crate::app_data_dir().join("capture_webview");
                    let _ = std::fs::create_dir_all(&fallback_dir);
                    build_with(Some(fallback_dir))
                }
            };

            match built {
                Ok(win) => {
                    built_any = true;
                    let win_c = win.clone();
                    let mon_c = mon.clone();
                    let _ = app_c.run_on_main_thread(move || {
                        win32::position_overlay_window(&win_c, &mon_c);
                    });
                    crate::media_server::diag_push(&format!("capture window {} built", label));
                }
                Err(e) => {
                    last_err = e.to_string();
                    crate::media_server::diag_push(&format!("capture window {} build failed: {}", label, last_err));
                }
            }
        }

        if !built_any {
            if let Ok(mut guard) = capture_lock().lock() {
                *guard = None;
            }
            let msg = if last_err.is_empty() {
                "创建截图浮层窗口失败".to_string()
            } else {
                last_err
            };
            let _ = app_c.emit("picnest:capture-error", json!({ "error": msg }));
        }
    });

    json!({ "ok": true })
}

#[tauri::command]
pub async fn capture_start(app: AppHandle) -> Value {
    trigger_capture(&app)
}

#[tauri::command]
pub async fn capture_ready(app: AppHandle, window: tauri::WebviewWindow) -> Value {
    let label = window.label().to_string();
    let mon_idx: Option<usize> = label.strip_prefix("capture-").and_then(|s| s.parse().ok());
    let mut should_focus = false;
    let mon_snap = if let (Some(idx), Ok(guard)) = (mon_idx, capture_lock().lock())
        && let Some(sess) = guard.as_ref()
        && let Some(mon) = sess.monitors.get(idx)
    {
        should_focus = sess.cursor_x >= mon.x
            && sess.cursor_x < mon.x + mon.width
            && sess.cursor_y >= mon.y
            && sess.cursor_y < mon.y + mon.height;
        Some(mon.clone())
    } else {
        None
    };
    let win_c = window.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(ref m) = mon_snap {
            win32::position_overlay_window(&win_c, m);
        }
        let _ = win_c.show();
        if should_focus {
            let _ = win_c.set_focus();
        }
        if let Some(ref m) = mon_snap {
            win32::position_overlay_window(&win_c, m);
        }
    });
    crate::media_server::diag_push(&format!("capture_ready {} focus={}", label, should_focus));
    json!({ "ok": true })
}

#[tauri::command]
pub fn capture_get_session(app: AppHandle, window: tauri::WebviewWindow) -> Value {
    let label = window.label().to_string();
    let mon_idx = label
        .strip_prefix("capture-")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0);
    let state = app.state::<AppState>();
    let guard = capture_lock().lock().unwrap_or_else(|e| e.into_inner());
    let Some(sess) = guard.as_ref() else {
        return json!({ "ok": false, "error": "截图会话已结束" });
    };
    let session_id = sess.id;
    let Some(mon) = sess.monitors.get(mon_idx) else {
        return json!({ "ok": false, "error": "显示器索引无效" });
    };

    let rel_windows: Vec<WinRect> = sess
        .windows
        .iter()
        .filter_map(|w| {
            let rx1 = w.x.max(mon.x);
            let ry1 = w.y.max(mon.y);
            let rx2 = (w.x + w.width).min(mon.x + mon.width);
            let ry2 = (w.y + w.height).min(mon.y + mon.height);
            if rx2 - rx1 >= 12 && ry2 - ry1 >= 12 {
                Some(WinRect {
                    x: rx1 - mon.x,
                    y: ry1 - mon.y,
                    width: rx2 - rx1,
                    height: ry2 - ry1,
                })
            } else {
                None
            }
        })
        .collect();

    let bmp_url = format!(
        "http://127.0.0.1:{}/capture/{}/{}/{}.bmp",
        state.media_port, state.media_nonce, session_id, mon_idx
    );
    let target_dir = target_dir_lock()
        .lock()
        .ok()
        .and_then(|g| g.clone());

    json!({
        "ok": true,
        "sessionId": session_id,
        "monIdx": mon_idx,
        "x": mon.x,
        "y": mon.y,
        "width": mon.width,
        "height": mon.height,
        "scaleFactor": mon.scale_factor,
        "bmpUrl": bmp_url,
        "windows": rel_windows,
        "targetDir": target_dir,
    })
}

#[tauri::command]
pub async fn capture_cancel(app: AppHandle) -> Value {
    let app_c = app.clone();
    std::thread::spawn(move || {
        clear_capture_session(&app_c);
    });
    json!({ "ok": true })
}

#[tauri::command]
pub fn capture_set_target_dir(dir: Option<String>) -> Value {
    let clean = dir
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if let Ok(mut guard) = target_dir_lock().lock() {
        *guard = clean;
    }
    json!({ "ok": true })
}

#[tauri::command]
pub fn capture_copy_text(text: String) -> Value {
    match win32::write_text_to_clipboard(&text) {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

fn resolve_save_dir(state: &State<'_, AppState>) -> PathBuf {
    if let Ok(guard) = target_dir_lock().lock()
        && let Some(ref d) = *guard
    {
        let p = PathBuf::from(d);
        if p.is_dir() {
            return p;
        }
    }
    if let Ok(conn) = state.db.lock()
        && let Ok(mut stmt) = conn.prepare("SELECT path FROM folders ORDER BY id ASC LIMIT 1")
        && let Ok(first) = stmt.query_row([], |r| r.get::<_, String>(0))
    {
        let p = PathBuf::from(first);
        if p.is_dir() {
            return p;
        }
    }
    dirs::picture_dir().unwrap_or_else(std::env::temp_dir)
}

fn unique_png_path(dir: &Path, stem: &str) -> PathBuf {
    let first = dir.join(format!("{}.png", stem));
    if !first.exists() {
        return first;
    }
    for n in 1..1000 {
        let cand = dir.join(format!("{}_{}.png", stem, n));
        if !cand.exists() {
            return cand;
        }
    }
    dir.join(format!("{}_{}.png", stem, SESSION_SEQ.fetch_add(1, Ordering::Relaxed)))
}

pub fn close_all_pins(app: &AppHandle) -> usize {
    let mut closed = 0usize;
    for (label, win) in app.webview_windows() {
        if label.starts_with("pin-") {
            let _ = win.close();
            closed += 1;
        }
    }
    if let Ok(mut guard) = pin_lock().lock() {
        guard.clear();
    }
    closed
}

fn spawn_pin_window(
    app: &AppHandle,
    pin_id: u64,
    width: u32,
    height: u32,
    screen_x: i32,
    screen_y: i32,
    scale_factor: f64,
) -> Result<(), String> {
    let label = format!("pin-{}", pin_id);
    let is_dev = std::env::var("PICNEST_DEV").map(|v| v == "1").unwrap_or(false);
    let make_url = || {
        if is_dev {
            tauri::WebviewUrl::External(
                "http://127.0.0.1:5173/"
                    .parse()
                    .expect("valid dev pin url"),
            )
        } else {
            tauri::WebviewUrl::App("index.html".into())
        }
    };

    let sf = scale_factor.max(1.0);
    let logical_x = (screen_x as f64) / sf;
    let logical_y = (screen_y as f64) / sf;
    let logical_w = (width as f64) / sf;
    let logical_h = (height as f64) / sf;
    let shared_args = crate::shared_webview_args();
    let shared_data_dir = crate::shared_webview_data_dir();

    let build_with = |data_dir: Option<std::path::PathBuf>| {
        let mut b = tauri::WebviewWindowBuilder::new(app, &label, make_url())
            .title("PicNest Pin")
            .position(logical_x, logical_y)
            .inner_size(logical_w.max(40.0), logical_h.max(40.0))
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(true)
            .visible(false);
        if !shared_args.is_empty() {
            b = b.additional_browser_args(&shared_args);
        }
        if let Some(d) = data_dir {
            b = b.data_directory(d);
        }
        b.build()
    };

    let win = match build_with(shared_data_dir) {
        Ok(w) => w,
        Err(first_err) => {
            crate::media_server::diag_push(&format!(
                "pin window {} primary build failed ({}), retrying isolated data_dir",
                label, first_err
            ));
            let fallback_dir = crate::app_data_dir().join("capture_webview");
            let _ = std::fs::create_dir_all(&fallback_dir);
            build_with(Some(fallback_dir)).map_err(|e| format!("创建贴图窗口失败: {}", e))?
        }
    };

    let win_c = win.clone();
    let w_phys = width as i32;
    let h_phys = height as i32;
    let _ = app.run_on_main_thread(move || {
        win32::position_pin_window(&win_c, screen_x, screen_y, w_phys, h_phys);
    });
    win.on_window_event(move |ev| {
        if matches!(ev, tauri::WindowEvent::Destroyed) {
            remove_pin(pin_id);
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn capture_commit(
    app: AppHandle,
    session_id: u64,
    mon_idx: usize,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    action: String,
    annotated_png_b64: Option<String>,
) -> Value {
    let has_annotated = annotated_png_b64
        .as_deref()
        .is_some_and(|s| !s.trim().is_empty());

    let mon_origin: (i32, i32, f64) = {
        let guard = capture_lock().lock().unwrap_or_else(|e| e.into_inner());
        guard
            .as_ref()
            .and_then(|s| s.monitors.get(mon_idx))
            .map(|m| (m.x, m.y, m.scale_factor))
            .unwrap_or((0, 0, 1.0))
    };

    // 若未带前端合成标注图，则直接从冻结屏幕会话零拷贝裁剪选区；否则后续在后台线程解码标注 PNG
    let cropped = if !has_annotated {
        let guard = capture_lock().lock().unwrap_or_else(|e| e.into_inner());
        let Some(sess) = guard.as_ref() else {
            return json!({ "ok": false, "error": "截图会话已结束" });
        };
        if sess.id != session_id {
            return json!({ "ok": false, "error": "截图会话已过期" });
        }
        let Some(mon) = sess.monitors.get(mon_idx) else {
            return json!({ "ok": false, "error": "显示器索引无效" });
        };
        match crop_bgra(
            &mon.bgra,
            mon.width.max(0) as u32,
            mon.height.max(0) as u32,
            x,
            y,
            width,
            height,
        ) {
            Ok(v) => Some(v),
            Err(e) => {
                let app_close = app.clone();
                std::thread::spawn(move || clear_capture_session(&app_close));
                return json!({ "ok": false, "error": e });
            }
        }
    } else {
        None
    };

    let app_close = app.clone();
    std::thread::spawn(move || {
        clear_capture_session(&app_close);
    });

    let target_dir = if action == "save_to_picnest" {
        let state = app.state::<AppState>();
        Some(resolve_save_dir(&state))
    } else {
        None
    };

    let app_emit = app.clone();
    let res = tauri::async_runtime::spawn_blocking(move || -> Value {
        let (cw, ch, png, bgra) = if let Some(b64) = annotated_png_b64.filter(|s| !s.trim().is_empty()) {
            match decode_annotated_png(&b64) {
                Ok(v) => v,
                Err(e) => return json!({ "ok": false, "error": e }),
            }
        } else {
            let Some((cw, ch, bgra)) = cropped else {
                return json!({ "ok": false, "error": "未找到截图数据" });
            };
            let rgba = bgra_to_opaque_rgba(&bgra);
            let png = match encode_png_bytes(cw, ch, &rgba) {
                Ok(b) => b,
                Err(e) => return json!({ "ok": false, "error": e }),
            };
            (cw, ch, png, bgra)
        };

        match action.as_str() {
            "copy" => {
                let dib = bgra_to_bottom_up_dib(cw, ch, &bgra);
                if let Err(e) = win32::write_image_to_clipboard(&dib, &png) {
                    return json!({ "ok": false, "error": e });
                }
                let _ = app_emit.emit(
                    "picnest:capture-done",
                    json!({ "action": "copy", "width": cw, "height": ch }),
                );
                json!({ "ok": true, "action": "copy", "width": cw, "height": ch })
            }
            "pin" => {
                let pin_id = PIN_SEQ.fetch_add(1, Ordering::Relaxed);
                let screen_x = mon_origin.0 + (x as i32);
                let screen_y = mon_origin.1 + (y as i32);
                let sf = mon_origin.2.max(1.0);
                let item = PinItem {
                    id: pin_id,
                    width: cw,
                    height: ch,
                    png,
                    bgra,
                    scale_factor: sf,
                    cur_sf: sf,
                    opacity: 1.0,
                    screen_x,
                    screen_y,
                    cur_w: cw as i32,
                    cur_h: ch as i32,
                    click_through: false,
                    drag_anchor: None,
                    drag_tracks_lbutton: false,
                };
                if let Ok(mut guard) = pin_lock().lock() {
                    guard.insert(pin_id, item);
                }
                if let Err(e) = spawn_pin_window(&app_emit, pin_id, cw, ch, screen_x, screen_y, sf) {
                    remove_pin(pin_id);
                    return json!({ "ok": false, "error": e });
                }
                let _ = app_emit.emit(
                    "picnest:capture-done",
                    json!({ "action": "pin", "pinId": pin_id, "width": cw, "height": ch }),
                );
                json!({ "ok": true, "action": "pin", "pinId": pin_id, "width": cw, "height": ch })
            }
            "save_to_picnest" => {
                let dir = target_dir.unwrap_or_else(std::env::temp_dir);
                if let Err(e) = std::fs::create_dir_all(&dir) {
                    return json!({ "ok": false, "error": format!("创建目录失败: {}", e) });
                }
                let stem = win32::local_timestamp_name();
                let out_path = unique_png_path(&dir, &stem);
                if let Err(e) = std::fs::write(&out_path, &png) {
                    return json!({ "ok": false, "error": format!("保存失败: {}", e) });
                }
                let path_str = out_path.to_string_lossy().to_string();
                let dir_str = dir.to_string_lossy().to_string();
                let _ = app_emit.emit(
                    "picnest:capture-saved",
                    json!({ "path": path_str, "dir": dir_str, "width": cw, "height": ch }),
                );
                json!({ "ok": true, "action": "save_to_picnest", "path": path_str, "dir": dir_str, "width": cw, "height": ch })
            }
            "save_as" => {
                let stem = format!("{}.png", win32::local_timestamp_name());
                let mut dlg = rfd::FileDialog::new()
                    .set_file_name(&stem)
                    .add_filter("PNG 图片", &["png"]);
                if let Some(pic) = dirs::picture_dir() {
                    dlg = dlg.set_directory(pic);
                }
                let Some(dest) = dlg.save_file() else {
                    return json!({ "ok": false, "canceled": true });
                };
                if let Err(e) = std::fs::write(&dest, &png) {
                    return json!({ "ok": false, "error": format!("写入文件失败: {}", e) });
                }
                let path_str = dest.to_string_lossy().to_string();
                let _ = app_emit.emit(
                    "picnest:capture-done",
                    json!({ "action": "save_as", "path": path_str, "width": cw, "height": ch }),
                );
                json!({ "ok": true, "action": "save_as", "path": path_str, "width": cw, "height": ch })
            }
            _ => json!({ "ok": false, "error": "未知截图动作" }),
        }
    })
    .await;

    match res {
        Ok(v) => v,
        Err(e) => json!({ "ok": false, "error": format!("截图后台处理失败: {}", e) }),
    }
}

#[tauri::command]
pub fn pin_get_info(app: AppHandle, window: tauri::WebviewWindow) -> Value {
    let Some(pin_id) = parse_pin_id(window.label()) else {
        return json!({ "ok": false, "error": "无效贴图窗口" });
    };
    let state = app.state::<AppState>();
    let guard = pin_lock().lock().unwrap_or_else(|e| e.into_inner());
    let Some(item) = guard.get(&pin_id) else {
        return json!({ "ok": false, "error": "贴图数据不存在" });
    };
    let png_url = format!(
        "http://127.0.0.1:{}/pin/{}/{}.png",
        state.media_port, state.media_nonce, pin_id
    );
    json!({
        "ok": true,
        "id": item.id,
        "width": item.width,
        "height": item.height,
        "scaleFactor": item.scale_factor,
        "pngUrl": png_url,
        "opacity": item.opacity,
        "clickThrough": item.click_through,
        "throughHotkey": current_through_hotkey_label(),
    })
}

#[tauri::command]
pub async fn pin_ready(app: AppHandle, window: tauri::WebviewWindow) -> Value {
    let rect_opt = parse_pin_id(window.label()).and_then(|pin_id| {
        pin_lock()
            .lock()
            .ok()
            .and_then(|g| g.get(&pin_id).map(|i| (i.screen_x, i.screen_y, i.cur_w, i.cur_h)))
    });
    let win_c = window.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some((sx, sy, cw, ch)) = rect_opt {
            win32::set_pin_rect(&win_c, sx, sy, cw, ch);
        }
        let _ = win_c.set_always_on_top(true);
        let _ = win_c.show();
        let _ = win_c.set_focus();
    });
    json!({ "ok": true })
}

fn ensure_pin_drag_loop(app: &AppHandle) {
    if DRAG_LOOP_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app_c = app.clone();
    std::thread::spawn(move || {
        struct DragLoopGuard;
        impl Drop for DragLoopGuard {
            fn drop(&mut self) {
                DRAG_LOOP_RUNNING.store(false, Ordering::SeqCst);
            }
        }
        let _guard = DragLoopGuard;

        loop {
            std::thread::sleep(std::time::Duration::from_millis(8));
            let (cx, cy, lbtn_down) = win32::cursor_pos_and_lbutton();
            let mut active_count = 0usize;
            let mut moves: Vec<(u64, i32, i32)> = Vec::new();
            let mut ended_ids: Vec<u64> = Vec::new();

            {
                let Ok(mut guard) = pin_lock().lock() else { break };
                for item in guard.values_mut() {
                    let Some((scx, scy, swx, swy)) = item.drag_anchor else {
                        continue;
                    };
                    active_count += 1;
                    if !item.drag_tracks_lbutton && lbtn_down {
                        item.drag_tracks_lbutton = true;
                    }
                    if should_auto_end_lbutton_drag(item.drag_tracks_lbutton, lbtn_down) {
                        item.drag_anchor = None;
                        item.drag_tracks_lbutton = false;
                        ended_ids.push(item.id);
                        continue;
                    }
                    let (nx, ny) = win32::clamp_rect_to_virtual_screen(
                        swx + (cx - scx),
                        swy + (cy - scy),
                        item.cur_w,
                        item.cur_h,
                    );
                    if nx != item.screen_x || ny != item.screen_y {
                        item.screen_x = nx;
                        item.screen_y = ny;
                        moves.push((item.id, nx, ny));
                    }
                }
            }

            if active_count == 0 {
                break;
            }

            if !moves.is_empty() {
                let mut main_moves: Vec<(tauri::WebviewWindow, i32, i32)> = Vec::with_capacity(moves.len());
                for (id, nx, ny) in moves {
                    if let Some(win) = app_c.get_webview_window(&format!("pin-{}", id)) {
                        main_moves.push((win, nx, ny));
                    }
                }
                if !main_moves.is_empty() {
                    let _ = app_c.run_on_main_thread(move || {
                        for (win, nx, ny) in main_moves {
                            // 只更新坐标不动尺寸，让 Windows WM_DPICHANGED 自动适配混合 DPI
                            win32::move_pin_pos(&win, nx, ny);
                        }
                    });
                }
            }

            for id in &ended_ids {
                if let Some(win) = app_c.get_webview_window(&format!("pin-{}", id)) {
                    if let Some((rx, ry, rw, rh, sf)) = win32::get_window_rect_and_scale(&win)
                        && let Ok(mut guard) = pin_lock().lock()
                        && let Some(item) = guard.get_mut(id)
                        && item.drag_anchor.is_none()
                    {
                        item.screen_x = rx;
                        item.screen_y = ry;
                        item.cur_w = rw;
                        item.cur_h = rh;
                        item.cur_sf = sf;
                    }
                    let _ = win.emit(
                        "picnest:pin-drag-state",
                        json!({ "dragging": false }),
                    );
                }
            }

            if active_count == ended_ids.len() {
                break;
            }
        }
    });
}

#[tauri::command]
pub fn pin_drag_begin(app: AppHandle, window: tauri::WebviewWindow) -> Value {
    let Some(pin_id) = parse_pin_id(window.label()) else {
        return json!({ "ok": false, "error": "无效贴图窗口" });
    };
    let (cx, cy, lbtn_down) = win32::cursor_pos_and_lbutton();
    let real = win32::get_window_rect_and_scale(&window);
    let mut started = false;
    if let Ok(mut guard) = pin_lock().lock()
        && let Some(item) = guard.get_mut(&pin_id)
    {
        if let Some((rx, ry, rw, rh, sf)) = real {
            item.screen_x = rx;
            item.screen_y = ry;
            item.cur_w = rw;
            item.cur_h = rh;
            item.cur_sf = sf;
        }
        item.drag_anchor = Some((cx, cy, item.screen_x, item.screen_y));
        item.drag_tracks_lbutton = lbtn_down;
        started = true;
    }
    if started {
        ensure_pin_drag_loop(&app);
        let _ = window.emit(
            "picnest:pin-drag-state",
            json!({ "dragging": true, "tracksLbutton": lbtn_down }),
        );
    }
    json!({ "ok": true, "dragging": started, "tracksLbutton": lbtn_down })
}

#[tauri::command]
pub fn pin_drag_move(app: AppHandle, window: tauri::WebviewWindow) -> Value {
    let Some(pin_id) = parse_pin_id(window.label()) else {
        return json!({ "ok": false });
    };
    let (cx, cy, _) = win32::cursor_pos_and_lbutton();
    let real = win32::get_window_rect_and_scale(&window);
    let pos_opt = {
        let Ok(mut guard) = pin_lock().lock() else {
            return json!({ "ok": false });
        };
        let Some(item) = guard.get_mut(&pin_id) else {
            return json!({ "ok": false });
        };
        if let Some((_, _, rw, rh, sf)) = real {
            item.cur_w = rw;
            item.cur_h = rh;
            item.cur_sf = sf;
        }
        let Some((scx, scy, swx, swy)) = item.drag_anchor else {
            return json!({ "ok": false });
        };
        let raw_x = swx + (cx - scx);
        let raw_y = swy + (cy - scy);
        let (nx, ny) = win32::clamp_rect_to_virtual_screen(raw_x, raw_y, item.cur_w, item.cur_h);
        item.screen_x = nx;
        item.screen_y = ny;
        Some((nx, ny))
    };
    if let Some((nx, ny)) = pos_opt {
        let win_c = window.clone();
        let _ = app.run_on_main_thread(move || {
            // 只更新坐标不动尺寸，让 Windows WM_DPICHANGED 自动适配主屏与数位屏间的混合 DPI
            win32::move_pin_pos(&win_c, nx, ny);
        });
    }
    json!({ "ok": true })
}

#[tauri::command]
pub fn pin_drag_end(window: tauri::WebviewWindow) -> Value {
    let real = win32::get_window_rect_and_scale(&window);
    if let Some(pin_id) = parse_pin_id(window.label())
        && let Ok(mut guard) = pin_lock().lock()
        && let Some(item) = guard.get_mut(&pin_id)
    {
        item.drag_anchor = None;
        item.drag_tracks_lbutton = false;
        if let Some((rx, ry, rw, rh, sf)) = real {
            item.screen_x = rx;
            item.screen_y = ry;
            item.cur_w = rw;
            item.cur_h = rh;
            item.cur_sf = sf;
        }
    }
    let _ = window.emit(
        "picnest:pin-drag-state",
        json!({ "dragging": false }),
    );
    json!({ "ok": true, "dragging": false })
}

fn apply_pin_zoom_rect(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    width: u32,
    height: u32,
    anchor_rx: f64,
    anchor_ry: f64,
) -> bool {
    let Some(pin_id) = parse_pin_id(window.label()) else {
        return false;
    };
    let real = win32::get_window_rect_and_scale(window);
    let updated = {
        let Ok(mut guard) = pin_lock().lock() else {
            return false;
        };
        let Some(item) = guard.get_mut(&pin_id) else {
            return false;
        };
        let (rx, ry, rw, rh, live_sf) = real.unwrap_or((item.screen_x, item.screen_y, item.cur_w, item.cur_h, item.cur_sf));
        let (raw_x, raw_y, nw, nh) = compute_zoomed_rect(
            rx,
            ry,
            rw,
            rh,
            width as i32,
            height as i32,
            anchor_rx,
            anchor_ry,
        );
        let (nx, ny) = win32::clamp_rect_to_virtual_screen(raw_x, raw_y, nw, nh);
        let dx = nx - rx;
        let dy = ny - ry;
        item.screen_x = nx;
        item.screen_y = ny;
        item.cur_w = nw;
        item.cur_h = nh;
        item.cur_sf = live_sf;
        if let Some((scx, scy, swx, swy)) = item.drag_anchor {
            item.drag_anchor = Some((scx, scy, swx + dx, swy + dy));
        }
        (nx, ny, nw, nh)
    };
    let win_c = window.clone();
    let _ = app.run_on_main_thread(move || {
        win32::set_pin_rect(&win_c, updated.0, updated.1, updated.2, updated.3);
    });
    true
}

#[tauri::command]
pub async fn pin_zoom_by(
    app: AppHandle,
    window: tauri::WebviewWindow,
    factor: f64,
    anchor_rx: Option<f64>,
    anchor_ry: Option<f64>,
) -> Value {
    let Some(pin_id) = parse_pin_id(window.label()) else {
        return json!({ "ok": false });
    };
    let arx = anchor_rx.unwrap_or(0.5);
    let ary = anchor_ry.unwrap_or(0.5);
    let real = win32::get_window_rect_and_scale(&window);
    let out = {
        let Ok(mut guard) = pin_lock().lock() else {
            return json!({ "ok": false });
        };
        let Some(item) = guard.get_mut(&pin_id) else {
            return json!({ "ok": false });
        };
        let (rx, ry, rw, rh, live_sf) = real.unwrap_or((item.screen_x, item.screen_y, item.cur_w, item.cur_h, item.cur_sf));
        let (tw, th, pct) = compute_relative_zoom_size(item.width, item.height, item.scale_factor, rw, live_sf, factor);
        let (raw_x, raw_y, nw, nh) = compute_zoomed_rect(rx, ry, rw, rh, tw, th, arx, ary);
        let (nx, ny) = win32::clamp_rect_to_virtual_screen(raw_x, raw_y, nw, nh);
        let dx = nx - rx;
        let dy = ny - ry;
        item.screen_x = nx;
        item.screen_y = ny;
        item.cur_w = nw;
        item.cur_h = nh;
        item.cur_sf = live_sf;
        if let Some((scx, scy, swx, swy)) = item.drag_anchor {
            item.drag_anchor = Some((scx, scy, swx + dx, swy + dy));
        }
        (nx, ny, nw, nh, pct)
    };
    let win_c = window.clone();
    let _ = app.run_on_main_thread(move || {
        win32::set_pin_rect(&win_c, out.0, out.1, out.2, out.3);
    });
    json!({ "ok": true, "percent": out.4, "width": out.2, "height": out.3 })
}

#[tauri::command]
pub async fn pin_reset_size(app: AppHandle, window: tauri::WebviewWindow) -> Value {
    let Some(pin_id) = parse_pin_id(window.label()) else {
        return json!({ "ok": false });
    };
    let real = win32::get_window_rect_and_scale(&window);
    let out = {
        let Ok(mut guard) = pin_lock().lock() else {
            return json!({ "ok": false });
        };
        let Some(item) = guard.get_mut(&pin_id) else {
            return json!({ "ok": false });
        };
        let (rx, ry, rw, rh, live_sf) = real.unwrap_or((item.screen_x, item.screen_y, item.cur_w, item.cur_h, item.cur_sf));
        let ratio = live_sf.max(1.0) / item.scale_factor.max(1.0);
        let tw = ((item.width as f64) * ratio).round().clamp(48.0, 8192.0) as i32;
        let th = ((item.height as f64) * ratio).round().clamp(48.0, 8192.0) as i32;
        let (raw_x, raw_y, nw, nh) = compute_zoomed_rect(rx, ry, rw, rh, tw, th, 0.5, 0.5);
        let (nx, ny) = win32::clamp_rect_to_virtual_screen(raw_x, raw_y, nw, nh);
        item.screen_x = nx;
        item.screen_y = ny;
        item.cur_w = nw;
        item.cur_h = nh;
        item.cur_sf = live_sf;
        (nx, ny, nw, nh)
    };
    let win_c = window.clone();
    let _ = app.run_on_main_thread(move || {
        win32::set_pin_rect(&win_c, out.0, out.1, out.2, out.3);
    });
    json!({ "ok": true, "percent": 100, "width": out.2, "height": out.3 })
}

#[tauri::command]
pub async fn pin_zoom_at(
    app: AppHandle,
    window: tauri::WebviewWindow,
    width: u32,
    height: u32,
    anchor_rx: Option<f64>,
    anchor_ry: Option<f64>,
) -> Value {
    let ok = apply_pin_zoom_rect(
        &app,
        &window,
        width,
        height,
        anchor_rx.unwrap_or(0.5),
        anchor_ry.unwrap_or(0.5),
    );
    json!({ "ok": ok })
}

#[tauri::command]
pub async fn pin_set_bounds(app: AppHandle, window: tauri::WebviewWindow, width: u32, height: u32) -> Value {
    if !apply_pin_zoom_rect(&app, &window, width, height, 0.5, 0.5) {
        let w = width.clamp(40, 8192) as i32;
        let h = height.clamp(40, 8192) as i32;
        let win_c = window.clone();
        let _ = app.run_on_main_thread(move || {
            win32::resize_pin_centered(&win_c, w, h);
        });
    }
    json!({ "ok": true })
}

fn apply_pin_interaction_style(
    win: &tauri::WebviewWindow,
    ignore_cursor: bool,
    no_activate: bool,
    opacity: f64,
) {
    let _ = win.set_ignore_cursor_events(ignore_cursor);
    win32::set_window_no_activate(win, no_activate);
    if opacity < 0.999 {
        win32::set_window_opacity(win, opacity);
    }
}

pub fn should_auto_end_lbutton_drag(tracks_lbutton: bool, lbtn_down: bool) -> bool {
    tracks_lbutton && !lbtn_down
}

#[tauri::command]
pub async fn pin_set_opacity(app: AppHandle, window: tauri::WebviewWindow, alpha: f64) -> Value {
    let clamped = alpha.clamp(0.15, 1.0);
    if let Some(pin_id) = parse_pin_id(window.label())
        && let Ok(mut guard) = pin_lock().lock()
        && let Some(item) = guard.get_mut(&pin_id)
    {
        item.opacity = clamped;
    }
    let win_c = window.clone();
    let _ = app.run_on_main_thread(move || {
        win32::set_window_opacity(&win_c, clamped);
    });
    json!({ "ok": true, "alpha": clamped })
}

#[tauri::command]
pub async fn pin_action(app: AppHandle, window: tauri::WebviewWindow, action: String) -> Value {
    let Some(pin_id) = parse_pin_id(window.label()) else {
        return json!({ "ok": false, "error": "无效贴图窗口" });
    };

    if action == "close" {
        remove_pin(pin_id);
        let win_c = window.clone();
        std::thread::spawn(move || {
            let _ = win_c.close();
        });
        return json!({ "ok": true, "action": "close" });
    }

    let snapshot = {
        let guard = pin_lock().lock().unwrap_or_else(|e| e.into_inner());
        guard.get(&pin_id).map(|i| (i.width, i.height, i.png.clone(), i.bgra.clone()))
    };
    let Some((cw, ch, png, bgra)) = snapshot else {
        return json!({ "ok": false, "error": "贴图数据已释放" });
    };

    let target_dir = if action == "save_to_picnest" {
        let state = app.state::<AppState>();
        Some(resolve_save_dir(&state))
    } else {
        None
    };

    let app_emit = app.clone();
    let res = tauri::async_runtime::spawn_blocking(move || -> Value {
        match action.as_str() {
            "copy" => {
                let dib = bgra_to_bottom_up_dib(cw, ch, &bgra);
                if let Err(e) = win32::write_image_to_clipboard(&dib, &png) {
                    return json!({ "ok": false, "error": e });
                }
                json!({ "ok": true, "action": "copy" })
            }
            "save_to_picnest" => {
                let dir = target_dir.unwrap_or_else(std::env::temp_dir);
                if let Err(e) = std::fs::create_dir_all(&dir) {
                    return json!({ "ok": false, "error": format!("创建目录失败: {}", e) });
                }
                let stem = win32::local_timestamp_name();
                let out_path = unique_png_path(&dir, &stem);
                if let Err(e) = std::fs::write(&out_path, &png) {
                    return json!({ "ok": false, "error": format!("保存失败: {}", e) });
                }
                let path_str = out_path.to_string_lossy().to_string();
                let dir_str = dir.to_string_lossy().to_string();
                let _ = app_emit.emit(
                    "picnest:capture-saved",
                    json!({ "path": path_str, "dir": dir_str, "width": cw, "height": ch }),
                );
                json!({ "ok": true, "action": "save_to_picnest", "path": path_str })
            }
            "save_as" => {
                let stem = format!("{}.png", win32::local_timestamp_name());
                let mut dlg = rfd::FileDialog::new()
                    .set_file_name(&stem)
                    .add_filter("PNG 图片", &["png"]);
                if let Some(pic) = dirs::picture_dir() {
                    dlg = dlg.set_directory(pic);
                }
                let Some(dest) = dlg.save_file() else {
                    return json!({ "ok": false, "canceled": true });
                };
                if let Err(e) = std::fs::write(&dest, &png) {
                    return json!({ "ok": false, "error": format!("写入文件失败: {}", e) });
                }
                let path_str = dest.to_string_lossy().to_string();
                let _ = app_emit.emit(
                    "picnest:capture-done",
                    json!({ "action": "save_as", "path": path_str, "width": cw, "height": ch }),
                );
                json!({ "ok": true, "action": "save_as", "path": path_str })
            }
            _ => json!({ "ok": false, "error": "未知贴图动作" }),
        }
    })
    .await;

    match res {
        Ok(v) => v,
        Err(e) => json!({ "ok": false, "error": format!("贴图操作失败: {}", e) }),
    }
}

pub fn toggle_all_pins_through(app: &AppHandle, force_off: bool) -> (bool, usize) {
    let (target, opacities) = {
        let Ok(mut guard) = pin_lock().lock() else {
            return (false, 0);
        };
        if guard.is_empty() {
            return (false, 0);
        }
        let any_through = guard.values().any(|i| i.click_through);
        let next = if force_off { false } else { !any_through };
        let mut ops = HashMap::with_capacity(guard.len());
        for item in guard.values_mut() {
            item.click_through = next;
            item.drag_anchor = None;
            item.drag_tracks_lbutton = false;
            ops.insert(item.id, item.opacity);
        }
        (next, ops)
    };

    let wins: Vec<(tauri::WebviewWindow, f64)> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with("pin-"))
        .map(|(label, win)| {
            let op = parse_pin_id(&label)
                .and_then(|id| opacities.get(&id).copied())
                .unwrap_or(1.0);
            (win, op)
        })
        .collect();
    let count = wins.len();
    if count > 0 {
        let wins_main = wins.clone();
        let _ = app.run_on_main_thread(move || {
            for (win, op) in wins_main {
                apply_pin_interaction_style(&win, target, target, op);
            }
        });
        for (win, _) in &wins {
            let _ = win.emit("picnest:pin-through", json!({ "enabled": target }));
        }
        let _ = app.emit(
            "picnest:capture-done",
            json!({ "action": "pin_through", "enabled": target, "count": count }),
        );
    }
    (target, count)
}

#[tauri::command]
pub async fn pin_set_click_through(
    app: AppHandle,
    window: tauri::WebviewWindow,
    enabled: bool,
    alpha: Option<f64>,
) -> Value {
    let Some(pin_id) = parse_pin_id(window.label()) else {
        return json!({ "ok": false, "error": "无效贴图窗口" });
    };
    let effective_opacity = {
        let mut guard = pin_lock().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(item) = guard.get_mut(&pin_id) {
            item.click_through = enabled;
            item.drag_anchor = None;
            item.drag_tracks_lbutton = false;
            if let Some(a) = alpha {
                item.opacity = a.clamp(0.15, 1.0);
            }
            item.opacity
        } else {
            alpha.map(|a| a.clamp(0.15, 1.0)).unwrap_or(1.0)
        }
    };
    let win_c = window.clone();
    let _ = app.run_on_main_thread(move || {
        apply_pin_interaction_style(&win_c, enabled, enabled, effective_opacity);
    });
    let _ = window.emit(
        "picnest:pin-through",
        json!({ "enabled": enabled, "fromSelf": true }),
    );
    let _ = app.emit(
        "picnest:capture-done",
        json!({ "action": "pin_through", "enabled": enabled, "count": 1 }),
    );
    json!({ "ok": true, "enabled": enabled, "opacity": effective_opacity })
}

#[tauri::command]
pub async fn pin_release_all_through(app: AppHandle) -> Value {
    let (_, count) = toggle_all_pins_through(&app, true);
    json!({ "ok": true, "enabled": false, "count": count })
}

#[tauri::command]
pub async fn pin_close_all(app: AppHandle) -> Value {
    let app_c = app.clone();
    std::thread::spawn(move || {
        close_all_pins(&app_c);
    });
    json!({ "ok": true })
}

#[tauri::command]
pub fn capture_get_hotkey() -> Value {
    let guard = hotkey_state_lock().lock().unwrap_or_else(|e| e.into_inner());
    json!({
        "ok": true,
        "hotkey": guard.canonical,
        "registered": guard.registered,
    })
}

#[tauri::command]
pub async fn capture_set_hotkey(hotkey: String) -> Value {
    let (mods, vk, canonical) = match parse_hotkey_spec(&hotkey) {
        Ok(v) => v,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    let res = tauri::async_runtime::spawn_blocking(move || {
        win32::request_rebind_hotkey(HotkeyTarget::Capture, mods, vk, canonical)
    })
    .await;
    match res {
        Ok(Ok(bound)) => json!({ "ok": true, "hotkey": bound }),
        Ok(Err(e)) => json!({ "ok": false, "error": e }),
        Err(e) => json!({ "ok": false, "error": format!("热键更新失败: {}", e) }),
    }
}

#[tauri::command]
pub fn pin_get_through_hotkey() -> Value {
    let guard = through_hotkey_state_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    json!({
        "ok": true,
        "hotkey": guard.canonical,
        "registered": guard.registered,
    })
}

#[tauri::command]
pub async fn pin_set_through_hotkey(hotkey: String) -> Value {
    let (mods, vk, canonical) = match parse_hotkey_spec(&hotkey) {
        Ok(v) => v,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    let res = tauri::async_runtime::spawn_blocking(move || {
        win32::request_rebind_hotkey(HotkeyTarget::PinThrough, mods, vk, canonical)
    })
    .await;
    match res {
        Ok(Ok(bound)) => json!({ "ok": true, "hotkey": bound }),
        Ok(Err(e)) => json!({ "ok": false, "error": e }),
        Err(e) => json!({ "ok": false, "error": format!("热键更新失败: {}", e) }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_bmp_from_bgra_header_and_pixels() {
        // 2x2 top-down BGRA
        let bgra = vec![
            1, 2, 3, 0, 4, 5, 6, 0, // row 0
            7, 8, 9, 0, 10, 11, 12, 0, // row 1
        ];
        let bmp = build_bmp_from_bgra(2, 2, &bgra).expect("valid bmp");
        assert_eq!(bmp.len(), 54 + 16);
        assert_eq!(&bmp[0..2], b"BM");
        assert_eq!(u32::from_le_bytes(bmp[2..6].try_into().unwrap()), 70);
        assert_eq!(u32::from_le_bytes(bmp[10..14].try_into().unwrap()), 54);
        assert_eq!(i32::from_le_bytes(bmp[18..22].try_into().unwrap()), 2);
        assert_eq!(i32::from_le_bytes(bmp[22..26].try_into().unwrap()), -2);
        assert_eq!(u16::from_le_bytes(bmp[28..30].try_into().unwrap()), 32);
        assert_eq!(&bmp[54..], &bgra[..]);
    }

    #[test]
    fn test_crop_bgra_and_bottom_up_dib_flip() {
        // 3x2 image, pixel value = [x, y, 100, 0]
        let mut src = Vec::new();
        for y in 0..2u8 {
            for x in 0..3u8 {
                src.extend_from_slice(&[x, y, 100, 0]);
            }
        }
        let (cw, ch, cropped) = crop_bgra(&src, 3, 2, 1, 0, 2, 2).expect("crop ok");
        assert_eq!((cw, ch), (2, 2));
        // top-down cropped: row 0 -> (1,0),(2,0); row 1 -> (1,1),(2,1)
        assert_eq!(
            cropped,
            vec![1, 0, 100, 0, 2, 0, 100, 0, 1, 1, 100, 0, 2, 1, 100, 0]
        );

        let dib = bgra_to_bottom_up_dib(cw, ch, &cropped);
        assert_eq!(dib.len(), 40 + 16);
        assert_eq!(i32::from_le_bytes(dib[8..12].try_into().unwrap()), 2);
        // bottom-up: row 1 first, alpha forced to 255
        assert_eq!(
            &dib[40..],
            &[1, 1, 100, 255, 2, 1, 100, 255, 1, 0, 100, 255, 2, 0, 100, 255]
        );
    }

    #[test]
    fn test_decode_annotated_png_to_dib() {
        use base64::Engine;
        // 2x1 RGBA: (10,20,30,255), (40,50,60,255)
        let rgba = vec![10u8, 20, 30, 255, 40, 50, 60, 255];
        let png = encode_png_bytes(2, 1, &rgba).expect("png encode");
        let b64 = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&png)
        );
        let (w, h, out_png, bgra) = decode_annotated_png(&b64).expect("decode annotated png");
        assert_eq!((w, h), (2, 1));
        assert_eq!(out_png, png);
        assert_eq!(bgra, vec![30, 20, 10, 255, 60, 50, 40, 255]);
        let dib = bgra_to_bottom_up_dib(w, h, &bgra);
        assert_eq!(&dib[40..], &[30, 20, 10, 255, 60, 50, 40, 255]);
    }

    #[test]
    fn test_parse_hotkey_spec_valid_and_invalid() {
        let (m1, k1, c1) = parse_hotkey_spec("alt + q").expect("alt+q");
        assert_eq!((m1, k1, c1.as_str()), (0x0001, 0x51, "Alt+Q"));

        let (m2, k2, c2) = parse_hotkey_spec("shift+ctrl+alt+a").expect("ctrl+alt+shift+a");
        assert_eq!((m2, k2, c2.as_str()), (0x0007, 0x41, "Ctrl+Alt+Shift+A"));

        let (m3, k3, c3) = parse_hotkey_spec("f1").expect("bare f1");
        assert_eq!((m3, k3, c3.as_str()), (0, 0x70, "F1"));

        let (m4, k4, c4) = parse_hotkey_spec("Ctrl+PrintScreen").expect("ctrl+prtsc");
        assert_eq!((m4, k4, c4.as_str()), (0x0002, 0x2C, "Ctrl+PrintScreen"));

        assert!(parse_hotkey_spec("A").is_err());
        assert!(parse_hotkey_spec("Alt+F4").is_err());
        assert!(parse_hotkey_spec("Ctrl+C").is_err());
        assert!(parse_hotkey_spec("").is_err());
    }

    #[test]
    fn test_pin_store_insert_get_remove() {
        let id = PIN_SEQ.fetch_add(1, Ordering::Relaxed);
        let item = PinItem {
            id,
            width: 10,
            height: 20,
            png: vec![1, 2, 3, 4],
            bgra: vec![0; 800],
            scale_factor: 1.5,
            cur_sf: 1.5,
            opacity: 1.0,
            screen_x: 100,
            screen_y: 200,
            cur_w: 10,
            cur_h: 20,
            click_through: false,
            drag_anchor: None,
            drag_tracks_lbutton: false,
        };
        pin_lock().lock().unwrap().insert(id, item);
        assert_eq!(get_pin_png(id), Some(vec![1, 2, 3, 4]));
        assert_eq!(parse_pin_id(&format!("pin-{}", id)), Some(id));
        assert_eq!(parse_pin_id("capture-0"), None);
        remove_pin(id);
        assert_eq!(get_pin_png(id), None);
    }

    #[test]
    fn test_pin_click_through_state_toggle() {
        let id = PIN_SEQ.fetch_add(1, Ordering::Relaxed);
        pin_lock().lock().unwrap().insert(
            id,
            PinItem {
                id,
                width: 30,
                height: 40,
                png: vec![9],
                bgra: vec![0; 4800],
                scale_factor: 1.0,
                cur_sf: 1.0,
                opacity: 1.0,
                screen_x: 0,
                screen_y: 0,
                cur_w: 30,
                cur_h: 40,
                click_through: false,
                drag_anchor: None,
                drag_tracks_lbutton: false,
            },
        );
        {
            let mut guard = pin_lock().lock().unwrap();
            let item = guard.get_mut(&id).unwrap();
            assert!(!item.click_through);
            item.click_through = true;
            assert!(item.click_through);
            item.click_through = false;
            assert!(!item.click_through);
        }
        remove_pin(id);
    }

    #[test]
    fn test_pin_zoom_anchor_and_exit_corner() {
        // 中心缩放：100x100 @ (200, 200) 放大到 200x200 应向四周等扩 -> (150, 150)
        assert_eq!(
            compute_zoomed_rect(200, 200, 100, 100, 200, 200, 0.5, 0.5),
            (150, 150, 200, 200)
        );
        // 锚在左上角 (0, 0) 放大时，左上角固定不动
        assert_eq!(
            compute_zoomed_rect(200, 200, 100, 100, 200, 200, 0.0, 0.0),
            (200, 200, 200, 200)
        );
        // 锚在右下角 (1, 1) 放大时，右下角固定在 (300, 300)
        assert_eq!(
            compute_zoomed_rect(200, 200, 100, 100, 200, 200, 1.0, 1.0),
            (100, 100, 200, 200)
        );
    }

    #[test]
    fn test_relative_zoom_across_mixed_dpi() {
        // 在 1.5x 主屏截取 300x150 贴图，拖到 1.0x 数位屏后 Windows 自动缩为 200x100
        // 在数位屏点放大 1.1x 应变为 ~220x110（110%），而不是跳回 300x150 体系！
        let (nw, nh, pct) = compute_relative_zoom_size(300, 150, 1.5, 200, 1.0, 1.1);
        assert_eq!((nw, nh, pct), (220, 110, 110));

        // 点缩小 1/1.1 应从 200x100 缩成 ~182x91（91%）
        let (sw, sh, spct) = compute_relative_zoom_size(300, 150, 1.5, 200, 1.0, 1.0 / 1.1);
        assert_eq!((sw, sh, spct), (182, 91, 91));
    }

    #[test]
    fn test_pin_drag_auto_end_lbutton_rule() {
        // Windows Ink 纯笔模式未追踪到 VK_LBUTTON 时，不会误自动断拖
        assert!(!should_auto_end_lbutton_drag(false, false));
        // 鼠标或映射了左键的数位笔，当检测到松手 (lbtn_down=false) 时立刻自动停拖
        assert!(should_auto_end_lbutton_drag(true, false));
        assert!(!should_auto_end_lbutton_drag(true, true));
    }

    #[test]
    fn test_default_through_hotkey_parses() {
        let (mods, vk, canonical) = parse_hotkey_spec("Alt+Shift+P").expect("default through hotkey");
        assert_eq!((mods, vk, canonical.as_str()), (0x0005, 0x50, "Alt+Shift+P"));
    }
}
