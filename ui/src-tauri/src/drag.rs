use serde_json::json;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, WebviewWindow};

struct DragSession {
    id: u64,
    active: Arc<AtomicBool>,
    escalated: Arc<AtomicBool>,
    web_ended: Arc<AtomicBool>,
}

static SESSION_SEQ: AtomicU64 = AtomicU64::new(1);
static CURRENT_SESSION: OnceLock<Mutex<Option<DragSession>>> = OnceLock::new();

fn session_lock() -> &'static Mutex<Option<DragSession>> {
    CURRENT_SESSION.get_or_init(|| Mutex::new(None))
}

#[tauri::command]
pub fn drag_begin(
    app: AppHandle,
    window: WebviewWindow,
    file_paths: Vec<String>,
) -> serde_json::Value {
    let valid_files: Vec<String> = file_paths
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && Path::new(s).exists())
        .collect();

    if valid_files.is_empty() {
        crate::media_server::diag_push("drag_begin rejected: empty valid_files");
        return json!({ "ok": false, "error": "没有可拖拽的有效文件" });
    }

    let id = SESSION_SEQ.fetch_add(1, Ordering::Relaxed);
    let active = Arc::new(AtomicBool::new(true));
    let escalated = Arc::new(AtomicBool::new(false));
    let web_ended = Arc::new(AtomicBool::new(false));
    crate::media_server::diag_push(&format!("drag_begin id={} count={} first={}", id, valid_files.len(), valid_files[0]));

    {
        let mut guard = session_lock().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(prev) = guard.take() {
            prev.active.store(false, Ordering::SeqCst);
        }
        *guard = Some(DragSession {
            id,
            active: active.clone(),
            escalated: escalated.clone(),
            web_ended: web_ended.clone(),
        });
    }

    #[cfg(windows)]
    {
        let app_c = app.clone();
        let win_c = window.clone();
        let active_c = active.clone();
        let escalated_c = escalated.clone();
        let web_ended_c = web_ended.clone();
        std::thread::spawn(move || {
            monitor_and_escalate(id, app_c, win_c, valid_files, active_c, escalated_c, web_ended_c);
        });
    }
    #[cfg(not(windows))]
    {
        let _ = (app, window);
    }

    json!({ "ok": true, "id": id })
}

#[tauri::command]
pub fn drag_end() -> serde_json::Value {
    let mut guard = session_lock().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(sess) = guard.as_ref() {
        sess.web_ended.store(true, Ordering::SeqCst);
        if sess.escalated.load(Ordering::SeqCst) {
            crate::media_server::diag_push(&format!("drag_end escalated id={}", sess.id));
            return json!({ "ok": true, "escalated": true });
        }
        crate::media_server::diag_push(&format!("drag_end normal id={}", sess.id));
        sess.active.store(false, Ordering::SeqCst);
    }
    *guard = None;
    json!({ "ok": true })
}

#[cfg(windows)]
mod win32_drag {
    use super::*;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicI32, AtomicU32, Ordering as AtomOrd};

    const VK_LBUTTON: i32 = 0x01;
    const VK_ESCAPE: u16 = 0x1B;
    const INPUT_KEYBOARD: u32 = 1;
    const KEYEVENTF_KEYUP: u32 = 0x0002;
    const WH_MOUSE_LL: i32 = 14;
    const WM_MOUSEWHEEL: usize = 0x020A;
    const PM_REMOVE: u32 = 0x0001;
    const QS_ALLINPUT: u32 = 0x04FF;

    static DRAG_WHEEL_DELTA: AtomicI32 = AtomicI32::new(0);

    #[repr(C)]
    struct MsllHookStruct {
        pt: Point,
        mouse_data: u32,
        flags: u32,
        time: u32,
        dw_extra_info: usize,
    }

    #[repr(C)]
    #[derive(Default)]
    struct WinMsg {
        hwnd: usize,
        message: u32,
        w_param: usize,
        l_param: isize,
        time: u32,
        pt: Point,
    }

    unsafe extern "system" fn drag_wheel_hook_proc(
        n_code: i32,
        w_param: usize,
        l_param: isize,
    ) -> isize {
        if n_code >= 0 && w_param == WM_MOUSEWHEEL && l_param != 0 {
            let info = unsafe { &*(l_param as *const MsllHookStruct) };
            let wheel_delta = ((info.mouse_data >> 16) as u16) as i16;
            if wheel_delta != 0 {
                DRAG_WHEEL_DELTA.fetch_add(wheel_delta as i32, AtomOrd::Relaxed);
            }
        }
        unsafe { CallNextHookEx(std::ptr::null_mut(), n_code, w_param, l_param) }
    }

    struct WheelHookGuard(*mut c_void);

    impl WheelHookGuard {
        fn install() -> Self {
            DRAG_WHEEL_DELTA.store(0, AtomOrd::Relaxed);
            let h = unsafe {
                SetWindowsHookExW(WH_MOUSE_LL, drag_wheel_hook_proc, std::ptr::null_mut(), 0)
            };
            Self(h)
        }
    }

    impl Drop for WheelHookGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    UnhookWindowsHookEx(self.0);
                }
                self.0 = std::ptr::null_mut();
            }
            DRAG_WHEEL_DELTA.store(0, AtomOrd::Relaxed);
        }
    }

    const S_OK: i32 = 0;
    const S_FALSE: i32 = 1;
    const E_NOINTERFACE: i32 = 0x80004002_u32 as i32;
    const E_POINTER: i32 = 0x80004003_u32 as i32;
    const E_NOTIMPL: i32 = 0x80004001_u32 as i32;
    const E_OUTOFMEMORY: i32 = 0x8007000E_u32 as i32;
    const DV_E_FORMATETC: i32 = 0x80040064_u32 as i32;
    const DV_E_TYMED: i32 = 0x80040069_u32 as i32;
    const OLE_E_ADVISENOTSUPPORTED: i32 = 0x80040003_u32 as i32;
    const DATA_S_SAMEFORMATETC: i32 = 0x00040130;

    const DRAGDROP_S_DROP: i32 = 0x00040100;
    const DRAGDROP_S_CANCEL: i32 = 0x00040101;
    const DRAGDROP_S_USEDEFAULTCURSORS: i32 = 0x00040102;

    const MK_LBUTTON: u32 = 0x0001;
    const DROPEFFECT_COPY: u32 = 1;
    const DROPEFFECT_LINK: u32 = 4;

    const CF_HDROP: u16 = 15;
    const DVASPECT_CONTENT: u32 = 1;
    const TYMED_HGLOBAL: u32 = 1;
    const DATADIR_GET: u32 = 1;
    const GMEM_MOVEABLE: u32 = 0x0002;
    const GMEM_ZEROINIT: u32 = 0x0040;

    #[repr(C)]
    #[derive(Copy, Clone, Default)]
    struct Point {
        x: i32,
        y: i32,
    }

    // Win64 INPUT 结构体精确内存布局（40 字节，匹配 winuser.h）
    #[repr(C)]
    #[derive(Copy, Clone)]
    struct KeybdInput {
        w_vk: u16,
        w_scan: u16,
        dw_flags: u32,
        time: u32,
        dw_extra_info: usize,
    }

    #[repr(C)]
    #[derive(Copy, Clone)]
    union InputPayload {
        ki: KeybdInput,
        _mouse_pad: [usize; 4], // sizeof(MOUSEINPUT) on x64 = 32 bytes
    }

    #[repr(C)]
    struct WinInput {
        input_type: u32,
        payload: InputPayload,
    }

    #[repr(C)]
    #[derive(Copy, Clone, PartialEq, Eq)]
    struct Guid {
        data1: u32,
        data2: u16,
        data3: u16,
        data4: [u8; 8],
    }

    const IID_IUNKNOWN: Guid = Guid {
        data1: 0x00000000,
        data2: 0x0000,
        data3: 0x0000,
        data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
    };
    const IID_IDATA_OBJECT: Guid = Guid {
        data1: 0x0000010E,
        data2: 0x0000,
        data3: 0x0000,
        data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
    };
    const IID_IDROP_SOURCE: Guid = Guid {
        data1: 0x00000121,
        data2: 0x0000,
        data3: 0x0000,
        data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
    };
    const IID_IENUM_FORMATETC: Guid = Guid {
        data1: 0x00000103,
        data2: 0x0000,
        data3: 0x0000,
        data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
    };

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct FormatEtc {
        cf_format: u16,
        ptd: *mut c_void,
        dw_aspect: u32,
        lindex: i32,
        tymed: u32,
    }

    #[repr(C)]
    struct StgMedium {
        tymed: u32,
        h_global: *mut c_void,
        p_unk_for_release: *mut c_void,
    }

    #[repr(C)]
    struct DropFiles {
        p_files: u32,
        pt_x: i32,
        pt_y: i32,
        f_nc: i32,
        f_wide: i32,
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetAsyncKeyState(v_key: i32) -> i16;
        fn GetKeyState(v_key: i32) -> i16;
        fn GetCursorPos(lp_point: *mut Point) -> i32;
        fn ReleaseCapture() -> i32;
        fn SendInput(c_inputs: u32, p_inputs: *const WinInput, cb_size: i32) -> u32;
        fn RegisterClipboardFormatW(lpsz_format: *const u16) -> u32;
        fn OpenClipboard(h_wnd_new_owner: *mut c_void) -> i32;
        fn EmptyClipboard() -> i32;
        fn SetClipboardData(u_format: u32, h_mem: *mut c_void) -> *mut c_void;
        fn CloseClipboard() -> i32;
        fn SetWindowsHookExW(
            id_hook: i32,
            lpfn: unsafe extern "system" fn(i32, usize, isize) -> isize,
            hmod: *mut c_void,
            dw_thread_id: u32,
        ) -> *mut c_void;
        fn UnhookWindowsHookEx(hhk: *mut c_void) -> i32;
        fn CallNextHookEx(
            hhk: *mut c_void,
            n_code: i32,
            w_param: usize,
            l_param: isize,
        ) -> isize;
        fn PeekMessageW(
            lp_msg: *mut WinMsg,
            h_wnd: *mut c_void,
            w_msg_filter_min: u32,
            w_msg_filter_max: u32,
            w_remove_msg: u32,
        ) -> i32;
        fn MsgWaitForMultipleObjects(
            n_count: u32,
            p_handles: *const *mut c_void,
            f_wait_all: i32,
            dw_milliseconds: u32,
            dw_wake_mask: u32,
        ) -> u32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GlobalAlloc(u_flags: u32, dw_bytes: usize) -> *mut c_void;
        fn GlobalLock(h_mem: *mut c_void) -> *mut c_void;
        fn GlobalUnlock(h_mem: *mut c_void) -> i32;
        fn GlobalFree(h_mem: *mut c_void) -> *mut c_void;
    }

    #[link(name = "ole32")]
    unsafe extern "system" {
        fn OleInitialize(pv_reserved: *mut c_void) -> i32;
        fn OleUninitialize();
        fn DoDragDrop(
            p_data_obj: *mut c_void,
            p_drop_source: *mut c_void,
            dw_ok_effects: u32,
            pdw_effect: *mut u32,
        ) -> i32;
    }

    fn send_escape_key() {
        let down = WinInput {
            input_type: INPUT_KEYBOARD,
            payload: InputPayload {
                ki: KeybdInput {
                    w_vk: VK_ESCAPE,
                    w_scan: 0,
                    dw_flags: 0,
                    time: 0,
                    dw_extra_info: 0,
                },
            },
        };
        let up = WinInput {
            input_type: INPUT_KEYBOARD,
            payload: InputPayload {
                ki: KeybdInput {
                    w_vk: VK_ESCAPE,
                    w_scan: 0,
                    dw_flags: KEYEVENTF_KEYUP,
                    time: 0,
                    dw_extra_info: 0,
                },
            },
        };
        let inputs = [down, up];
        unsafe {
            SendInput(2, inputs.as_ptr(), std::mem::size_of::<WinInput>() as i32);
        }
    }

    fn reg_clip_format(name: &str) -> u16 {
        let mut w: Vec<u16> = name.encode_utf16().collect();
        w.push(0);
        unsafe { RegisterClipboardFormatW(w.as_ptr()) as u16 }
    }

    fn cf_preferred_drop_effect() -> u16 {
        static CF: OnceLock<u16> = OnceLock::new();
        *CF.get_or_init(|| reg_clip_format("Preferred DropEffect"))
    }

    fn cf_filename_w() -> u16 {
        static CF: OnceLock<u16> = OnceLock::new();
        *CF.get_or_init(|| reg_clip_format("FileNameW"))
    }

    pub fn build_hdrop_bytes(paths: &[String]) -> Vec<u8> {
        let mut wide: Vec<u16> = Vec::new();
        for p in paths {
            wide.extend(p.encode_utf16());
            wide.push(0);
        }
        wide.push(0);

        let hdr_size = std::mem::size_of::<DropFiles>();
        let mut buf = vec![0u8; hdr_size + wide.len() * 2];
        let hdr = DropFiles {
            p_files: hdr_size as u32,
            pt_x: 0,
            pt_y: 0,
            f_nc: 0,
            f_wide: 1,
        };
        unsafe {
            std::ptr::copy_nonoverlapping(
                (&hdr as *const DropFiles) as *const u8,
                buf.as_mut_ptr(),
                hdr_size,
            );
            std::ptr::copy_nonoverlapping(
                wide.as_ptr() as *const u8,
                buf.as_mut_ptr().add(hdr_size),
                wide.len() * 2,
            );
        }
        buf
    }

    fn build_filename_w_bytes(first_path: &str) -> Vec<u8> {
        let mut wide: Vec<u16> = first_path.encode_utf16().collect();
        wide.push(0);
        let mut buf = vec![0u8; wide.len() * 2];
        unsafe {
            std::ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, buf.as_mut_ptr(), buf.len());
        }
        buf
    }

    fn alloc_hglobal(bytes: &[u8]) -> *mut c_void {
        unsafe {
            let h = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes.len());
            if h.is_null() {
                return std::ptr::null_mut();
            }
            let ptr = GlobalLock(h);
            if ptr.is_null() {
                GlobalFree(h);
                return std::ptr::null_mut();
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
            GlobalUnlock(h);
            h
        }
    }

    // ---- IEnumFORMATETC ----
    #[repr(C)]
    struct EnumFormatEtcVtbl {
        query_interface: unsafe extern "system" fn(*mut c_void, *const Guid, *mut *mut c_void) -> i32,
        add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
        release: unsafe extern "system" fn(*mut c_void) -> u32,
        next: unsafe extern "system" fn(*mut c_void, u32, *mut FormatEtc, *mut u32) -> i32,
        skip: unsafe extern "system" fn(*mut c_void, u32) -> i32,
        reset: unsafe extern "system" fn(*mut c_void) -> i32,
        clone: unsafe extern "system" fn(*mut c_void, *mut *mut c_void) -> i32,
    }

    #[repr(C)]
    struct ComEnumFormatEtc {
        vtbl: *const EnumFormatEtcVtbl,
        ref_count: AtomicU32,
        formats: Vec<FormatEtc>,
        pos: Mutex<usize>,
    }

    static ENUM_FORMATETC_VTBL: EnumFormatEtcVtbl = EnumFormatEtcVtbl {
        query_interface: enum_qi,
        add_ref: enum_add_ref,
        release: enum_release,
        next: enum_next,
        skip: enum_skip,
        reset: enum_reset,
        clone: enum_clone,
    };

    fn std_fmt(cf: u16) -> FormatEtc {
        FormatEtc {
            cf_format: cf,
            ptd: std::ptr::null_mut(),
            dw_aspect: DVASPECT_CONTENT,
            lindex: -1,
            tymed: TYMED_HGLOBAL,
        }
    }

    impl ComEnumFormatEtc {
        fn new(pos: usize) -> *mut c_void {
            let formats = vec![
                std_fmt(CF_HDROP),
                std_fmt(cf_preferred_drop_effect()),
                std_fmt(cf_filename_w()),
            ];
            let boxed = Box::new(ComEnumFormatEtc {
                vtbl: &ENUM_FORMATETC_VTBL,
                ref_count: AtomicU32::new(1),
                formats,
                pos: Mutex::new(pos),
            });
            Box::into_raw(boxed) as *mut c_void
        }
    }

    unsafe extern "system" fn enum_qi(
        this: *mut c_void,
        riid: *const Guid,
        ppv: *mut *mut c_void,
    ) -> i32 {
        unsafe {
            if ppv.is_null() {
                return E_POINTER;
            }
            if !riid.is_null() && (*riid == IID_IUNKNOWN || *riid == IID_IENUM_FORMATETC) {
                *ppv = this;
                enum_add_ref(this);
                return S_OK;
            }
            *ppv = std::ptr::null_mut();
            E_NOINTERFACE
        }
    }

    unsafe extern "system" fn enum_add_ref(this: *mut c_void) -> u32 {
        unsafe {
            let obj = &*(this as *const ComEnumFormatEtc);
            obj.ref_count.fetch_add(1, AtomOrd::Relaxed) + 1
        }
    }

    unsafe extern "system" fn enum_release(this: *mut c_void) -> u32 {
        unsafe {
            let obj = &*(this as *const ComEnumFormatEtc);
            let prev = obj.ref_count.fetch_sub(1, AtomOrd::Release);
            if prev == 1 {
                std::sync::atomic::fence(AtomOrd::Acquire);
                drop(Box::from_raw(this as *mut ComEnumFormatEtc));
            }
            prev - 1
        }
    }

    unsafe extern "system" fn enum_next(
        this: *mut c_void,
        celt: u32,
        rgelt: *mut FormatEtc,
        pcelt_fetched: *mut u32,
    ) -> i32 {
        unsafe {
            if rgelt.is_null() {
                return E_POINTER;
            }
            let obj = &*(this as *const ComEnumFormatEtc);
            let mut pos = obj.pos.lock().unwrap_or_else(|e| e.into_inner());
            let mut fetched = 0u32;
            while fetched < celt && *pos < obj.formats.len() {
                *rgelt.add(fetched as usize) = obj.formats[*pos];
                *pos += 1;
                fetched += 1;
            }
            if !pcelt_fetched.is_null() {
                *pcelt_fetched = fetched;
            }
            if fetched == celt {
                S_OK
            } else {
                S_FALSE
            }
        }
    }

    unsafe extern "system" fn enum_skip(this: *mut c_void, celt: u32) -> i32 {
        unsafe {
            let obj = &*(this as *const ComEnumFormatEtc);
            let mut pos = obj.pos.lock().unwrap_or_else(|e| e.into_inner());
            let next = (*pos).saturating_add(celt as usize);
            if next > obj.formats.len() {
                *pos = obj.formats.len();
                S_FALSE
            } else {
                *pos = next;
                S_OK
            }
        }
    }

    unsafe extern "system" fn enum_reset(this: *mut c_void) -> i32 {
        unsafe {
            let obj = &*(this as *const ComEnumFormatEtc);
            let mut pos = obj.pos.lock().unwrap_or_else(|e| e.into_inner());
            *pos = 0;
            S_OK
        }
    }

    unsafe extern "system" fn enum_clone(this: *mut c_void, ppenum: *mut *mut c_void) -> i32 {
        unsafe {
            if ppenum.is_null() {
                return E_POINTER;
            }
            let obj = &*(this as *const ComEnumFormatEtc);
            let pos = *obj.pos.lock().unwrap_or_else(|e| e.into_inner());
            *ppenum = ComEnumFormatEtc::new(pos);
            S_OK
        }
    }

    // ---- IDataObject ----
    #[repr(C)]
    struct DataObjectVtbl {
        query_interface: unsafe extern "system" fn(*mut c_void, *const Guid, *mut *mut c_void) -> i32,
        add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
        release: unsafe extern "system" fn(*mut c_void) -> u32,
        get_data: unsafe extern "system" fn(*mut c_void, *const FormatEtc, *mut StgMedium) -> i32,
        get_data_here: unsafe extern "system" fn(*mut c_void, *const FormatEtc, *mut StgMedium) -> i32,
        query_get_data: unsafe extern "system" fn(*mut c_void, *const FormatEtc) -> i32,
        get_canonical_format_etc: unsafe extern "system" fn(*mut c_void, *const FormatEtc, *mut FormatEtc) -> i32,
        set_data: unsafe extern "system" fn(*mut c_void, *const FormatEtc, *const StgMedium, i32) -> i32,
        enum_format_etc: unsafe extern "system" fn(*mut c_void, u32, *mut *mut c_void) -> i32,
        d_advise: unsafe extern "system" fn(*mut c_void, *const FormatEtc, u32, *mut c_void, *mut u32) -> i32,
        d_unadvise: unsafe extern "system" fn(*mut c_void, u32) -> i32,
        enum_d_advise: unsafe extern "system" fn(*mut c_void, *mut *mut c_void) -> i32,
    }

    #[repr(C)]
    struct ComDataObject {
        vtbl: *const DataObjectVtbl,
        ref_count: AtomicU32,
        hdrop_bytes: Vec<u8>,
        pref_effect_bytes: [u8; 4],
        filename_w_bytes: Vec<u8>,
    }

    static DATA_OBJECT_VTBL: DataObjectVtbl = DataObjectVtbl {
        query_interface: data_qi,
        add_ref: data_add_ref,
        release: data_release,
        get_data: data_get_data,
        get_data_here: data_get_data_here,
        query_get_data: data_query_get_data,
        get_canonical_format_etc: data_get_canonical,
        set_data: data_set_data,
        enum_format_etc: data_enum_format_etc,
        d_advise: data_d_advise,
        d_unadvise: data_d_unadvise,
        enum_d_advise: data_enum_d_advise,
    };

    impl ComDataObject {
        fn new(paths: &[String]) -> *mut c_void {
            let first = paths.first().map(|s| s.as_str()).unwrap_or("");
            let boxed = Box::new(ComDataObject {
                vtbl: &DATA_OBJECT_VTBL,
                ref_count: AtomicU32::new(1),
                hdrop_bytes: build_hdrop_bytes(paths),
                pref_effect_bytes: DROPEFFECT_COPY.to_le_bytes(),
                filename_w_bytes: build_filename_w_bytes(first),
            });
            Box::into_raw(boxed) as *mut c_void
        }
    }

    unsafe extern "system" fn data_qi(
        this: *mut c_void,
        riid: *const Guid,
        ppv: *mut *mut c_void,
    ) -> i32 {
        unsafe {
            if ppv.is_null() {
                return E_POINTER;
            }
            if !riid.is_null() && (*riid == IID_IUNKNOWN || *riid == IID_IDATA_OBJECT) {
                *ppv = this;
                data_add_ref(this);
                return S_OK;
            }
            *ppv = std::ptr::null_mut();
            E_NOINTERFACE
        }
    }

    unsafe extern "system" fn data_add_ref(this: *mut c_void) -> u32 {
        unsafe {
            let obj = &*(this as *const ComDataObject);
            obj.ref_count.fetch_add(1, AtomOrd::Relaxed) + 1
        }
    }

    unsafe extern "system" fn data_release(this: *mut c_void) -> u32 {
        unsafe {
            let obj = &*(this as *const ComDataObject);
            let prev = obj.ref_count.fetch_sub(1, AtomOrd::Release);
            if prev == 1 {
                std::sync::atomic::fence(AtomOrd::Acquire);
                drop(Box::from_raw(this as *mut ComDataObject));
            }
            prev - 1
        }
    }

    #[derive(Copy, Clone, PartialEq, Eq)]
    enum SupportedFmt {
        HDrop,
        PreferredEffect,
        FileNameW,
    }

    unsafe fn match_format(fmt: *const FormatEtc) -> Result<SupportedFmt, i32> {
        unsafe {
            if fmt.is_null() {
                return Err(E_POINTER);
            }
            let f = &*fmt;
            if (f.dw_aspect & DVASPECT_CONTENT) == 0 {
                return Err(DV_E_FORMATETC);
            }
            if f.lindex != -1 && f.lindex != 0 {
                return Err(DV_E_FORMATETC);
            }
            if (f.tymed & TYMED_HGLOBAL) == 0 {
                return Err(DV_E_TYMED);
            }
            if f.cf_format == CF_HDROP {
                Ok(SupportedFmt::HDrop)
            } else if f.cf_format != 0 && f.cf_format == cf_preferred_drop_effect() {
                Ok(SupportedFmt::PreferredEffect)
            } else if f.cf_format != 0 && f.cf_format == cf_filename_w() {
                Ok(SupportedFmt::FileNameW)
            } else {
                Err(DV_E_FORMATETC)
            }
        }
    }

    unsafe extern "system" fn data_query_get_data(
        _this: *mut c_void,
        p_format_etc: *const FormatEtc,
    ) -> i32 {
        unsafe {
            match match_format(p_format_etc) {
                Ok(_) => S_OK,
                Err(hr) => hr,
            }
        }
    }

    unsafe extern "system" fn data_get_data(
        this: *mut c_void,
        p_format_etc_in: *const FormatEtc,
        p_medium: *mut StgMedium,
    ) -> i32 {
        unsafe {
            if p_medium.is_null() {
                return E_POINTER;
            }
            let kind = match match_format(p_format_etc_in) {
                Ok(k) => k,
                Err(hr) => return hr,
            };
            let obj = &*(this as *const ComDataObject);
            let slice: &[u8] = match kind {
                SupportedFmt::HDrop => &obj.hdrop_bytes,
                SupportedFmt::PreferredEffect => &obj.pref_effect_bytes,
                SupportedFmt::FileNameW => &obj.filename_w_bytes,
            };
            let h = alloc_hglobal(slice);
            if h.is_null() {
                return E_OUTOFMEMORY;
            }
            (*p_medium).tymed = TYMED_HGLOBAL;
            (*p_medium).h_global = h;
            (*p_medium).p_unk_for_release = std::ptr::null_mut();
            S_OK
        }
    }

    unsafe extern "system" fn data_get_data_here(
        _this: *mut c_void,
        _p_format_etc: *const FormatEtc,
        _p_medium: *mut StgMedium,
    ) -> i32 {
        E_NOTIMPL
    }

    unsafe extern "system" fn data_get_canonical(
        _this: *mut c_void,
        p_in: *const FormatEtc,
        p_out: *mut FormatEtc,
    ) -> i32 {
        unsafe {
            if p_out.is_null() || p_in.is_null() {
                return E_POINTER;
            }
            *p_out = *p_in;
            (*p_out).ptd = std::ptr::null_mut();
            DATA_S_SAMEFORMATETC
        }
    }

    unsafe extern "system" fn data_set_data(
        _this: *mut c_void,
        _p_fmt: *const FormatEtc,
        _p_med: *const StgMedium,
        _f_release: i32,
    ) -> i32 {
        E_NOTIMPL
    }

    unsafe extern "system" fn data_enum_format_etc(
        _this: *mut c_void,
        dw_direction: u32,
        pp_enum: *mut *mut c_void,
    ) -> i32 {
        unsafe {
            if pp_enum.is_null() {
                return E_POINTER;
            }
            if dw_direction == DATADIR_GET {
                *pp_enum = ComEnumFormatEtc::new(0);
                S_OK
            } else {
                *pp_enum = std::ptr::null_mut();
                E_NOTIMPL
            }
        }
    }

    unsafe extern "system" fn data_d_advise(
        _this: *mut c_void,
        _p_fmt: *const FormatEtc,
        _advf: u32,
        _p_adv_sink: *mut c_void,
        _pdw_conn: *mut u32,
    ) -> i32 {
        OLE_E_ADVISENOTSUPPORTED
    }

    unsafe extern "system" fn data_d_unadvise(_this: *mut c_void, _dw_conn: u32) -> i32 {
        OLE_E_ADVISENOTSUPPORTED
    }

    unsafe extern "system" fn data_enum_d_advise(
        _this: *mut c_void,
        _pp_enum: *mut *mut c_void,
    ) -> i32 {
        OLE_E_ADVISENOTSUPPORTED
    }

    // ---- IDropSource ----
    #[repr(C)]
    struct DropSourceVtbl {
        query_interface: unsafe extern "system" fn(*mut c_void, *const Guid, *mut *mut c_void) -> i32,
        add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
        release: unsafe extern "system" fn(*mut c_void) -> u32,
        query_continue_drag: unsafe extern "system" fn(*mut c_void, i32, u32) -> i32,
        give_feedback: unsafe extern "system" fn(*mut c_void, u32) -> i32,
    }

    #[repr(C)]
    struct ComDropSource {
        vtbl: *const DropSourceVtbl,
        ref_count: AtomicU32,
    }

    static DROP_SOURCE_VTBL: DropSourceVtbl = DropSourceVtbl {
        query_interface: src_qi,
        add_ref: src_add_ref,
        release: src_release,
        query_continue_drag: src_query_continue,
        give_feedback: src_give_feedback,
    };

    impl ComDropSource {
        fn new() -> *mut c_void {
            let boxed = Box::new(ComDropSource {
                vtbl: &DROP_SOURCE_VTBL,
                ref_count: AtomicU32::new(1),
            });
            Box::into_raw(boxed) as *mut c_void
        }
    }

    unsafe extern "system" fn src_qi(
        this: *mut c_void,
        riid: *const Guid,
        ppv: *mut *mut c_void,
    ) -> i32 {
        unsafe {
            if ppv.is_null() {
                return E_POINTER;
            }
            if !riid.is_null() && (*riid == IID_IUNKNOWN || *riid == IID_IDROP_SOURCE) {
                *ppv = this;
                src_add_ref(this);
                return S_OK;
            }
            *ppv = std::ptr::null_mut();
            E_NOINTERFACE
        }
    }

    unsafe extern "system" fn src_add_ref(this: *mut c_void) -> u32 {
        unsafe {
            let obj = &*(this as *const ComDropSource);
            obj.ref_count.fetch_add(1, AtomOrd::Relaxed) + 1
        }
    }

    unsafe extern "system" fn src_release(this: *mut c_void) -> u32 {
        unsafe {
            let obj = &*(this as *const ComDropSource);
            let prev = obj.ref_count.fetch_sub(1, AtomOrd::Release);
            if prev == 1 {
                std::sync::atomic::fence(AtomOrd::Acquire);
                drop(Box::from_raw(this as *mut ComDropSource));
            }
            prev - 1
        }
    }

    unsafe extern "system" fn src_query_continue(
        _this: *mut c_void,
        f_escape_pressed: i32,
        grf_key_state: u32,
    ) -> i32 {
        if f_escape_pressed != 0 {
            return DRAGDROP_S_CANCEL;
        }
        if (grf_key_state & MK_LBUTTON) == 0 {
            return DRAGDROP_S_DROP;
        }
        S_OK
    }

    unsafe extern "system" fn src_give_feedback(_this: *mut c_void, _dw_effect: u32) -> i32 {
        DRAGDROP_S_USEDEFAULTCURSORS
    }

    pub fn do_ole_file_drag(paths: &[String]) -> (i32, u32) {
        const RPC_E_CHANGED_MODE: i32 = 0x80010106_u32 as i32;
        unsafe {
            let hr_init = OleInitialize(std::ptr::null_mut());
            let async_lb = GetAsyncKeyState(VK_LBUTTON);
            let sync_lb = GetKeyState(VK_LBUTTON);
            crate::media_server::diag_push(&format!(
                "drag_ole_begin hr_init=0x{:08x} async_lb=0x{:04x} sync_lb=0x{:04x}",
                hr_init as u32, async_lb as u16, sync_lb as u16
            ));

            if hr_init == RPC_E_CHANGED_MODE {
                let paths_owned = paths.to_vec();
                let res = std::thread::spawn(move || {
                    let hr2 = OleInitialize(std::ptr::null_mut());
                    crate::media_server::diag_push(&format!("drag_ole_sta_fallback hr2=0x{:08x}", hr2 as u32));
                    let data_obj = ComDataObject::new(&paths_owned);
                    let drop_src = ComDropSource::new();
                    let mut effect: u32 = 0;
                    let hr = DoDragDrop(
                        data_obj,
                        drop_src,
                        DROPEFFECT_COPY | DROPEFFECT_LINK,
                        &mut effect,
                    );
                    src_release(drop_src);
                    data_release(data_obj);
                    if hr2 >= 0 {
                        OleUninitialize();
                    }
                    (hr, effect)
                })
                .join()
                .unwrap_or((0x80004005_u32 as i32, 0));
                return res;
            }

            let data_obj = ComDataObject::new(paths);
            let drop_src = ComDropSource::new();
            let mut effect: u32 = 0;
            let hr = DoDragDrop(
                data_obj,
                drop_src,
                DROPEFFECT_COPY | DROPEFFECT_LINK,
                &mut effect,
            );
            src_release(drop_src);
            data_release(data_obj);
            if hr_init >= 0 {
                OleUninitialize();
            }
            (hr, effect)
        }
    }

    pub fn monitor_and_escalate(
        id: u64,
        app: AppHandle,
        window: WebviewWindow,
        files: Vec<String>,
        active: Arc<AtomicBool>,
        escalated: Arc<AtomicBool>,
        web_ended: Arc<AtomicBool>,
    ) {
        let mut out_ticks: u32 = 0;
        let mut up_ticks: u32 = 0;
        // 拖拽期间挂轻量低级鼠标钩子穿透 Windows OLE 模态循环，让滚轮实时滚动预览页；
        // RAII 守卫保证任何退出/升级路径都立即卸载，绝不残留。
        let wheel_guard = WheelHookGuard::install();

        loop {
            unsafe {
                MsgWaitForMultipleObjects(0, std::ptr::null(), 0, 16, QS_ALLINPUT);
                let mut msg = WinMsg::default();
                while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {}
            }
            if !active.load(Ordering::SeqCst) {
                break;
            }

            let lbutton_down = unsafe { GetAsyncKeyState(VK_LBUTTON) < 0 };
            if !lbutton_down {
                up_ticks += 1;
                if up_ticks >= 3 {
                    active.store(false, Ordering::SeqCst);
                    break;
                }
                continue;
            }
            up_ticks = 0;

            let mut pt = Point::default();
            unsafe {
                GetCursorPos(&mut pt);
            }

            let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
                continue;
            };
            let wx = pos.x;
            let wy = pos.y;
            let ww = size.width as i32;
            let wh = size.height as i32;

            let outside = pt.x < wx || pt.x >= wx + ww || pt.y < wy || pt.y >= wy + wh;
            let wheel_delta = DRAG_WHEEL_DELTA.swap(0, AtomOrd::Relaxed);
            if wheel_delta != 0 && !outside {
                let _ = app.emit("picnest-drag-wheel", json!({ "delta": wheel_delta }));
            }
            if outside {
                out_ticks += 1;
            } else {
                out_ticks = 0;
            }

            if out_ticks >= 2 {
                // 即将升级为外部原生 OLE 拖拽，立即卸载滚轮钩子不干扰外部窗口
                drop(wheel_guard);
                escalated.store(true, Ordering::SeqCst);
                active.store(false, Ordering::SeqCst);
                crate::media_server::diag_push(&format!("drag_escalate id={} send VK_ESCAPE", id));

                // 先发 Escape 让 WebView2（独立 msedgewebview2 进程）取消内部 HTML5 拖拽并退出其模态循环，
                // 并等待 JS dragend -> drag_end() 回调确认后再切换为原生 OLE DoDragDrop，避免两者撞车返回 E_FAIL(0x80004005)。
                send_escape_key();

                let t_esc = std::time::Instant::now();
                let mut resent = false;
                while t_esc.elapsed().as_millis() < 400 {
                    if web_ended.load(Ordering::SeqCst) {
                        break;
                    }
                    if unsafe { GetAsyncKeyState(VK_LBUTTON) >= 0 } {
                        break;
                    }
                    if !resent && t_esc.elapsed().as_millis() >= 140 {
                        resent = true;
                        send_escape_key();
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                let ended = web_ended.load(Ordering::SeqCst);
                crate::media_server::diag_push(&format!(
                    "drag_escalate id={} wait_web_end ended={} elapsed={}ms",
                    id,
                    ended,
                    t_esc.elapsed().as_millis()
                ));
                if ended {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }

                let app_for_emit = app.clone();
                let files_c = files.clone();
                let _ = app.run_on_main_thread(move || {
                    const E_FAIL_HR: i32 = 0x80004005_u32 as i32;
                    let still_down = unsafe { GetAsyncKeyState(VK_LBUTTON) < 0 };
                    if !still_down {
                        crate::media_server::diag_push(&format!("drag_escalate id={} mouse released before DoDragDrop", id));
                        let _ = app_for_emit.emit("picnest-drag-out-end", json!({ "id": id }));
                        let mut guard = session_lock().lock().unwrap_or_else(|e| e.into_inner());
                        if guard.as_ref().map(|s| s.id) == Some(id) {
                            *guard = None;
                        }
                        return;
                    }

                    let _ = app_for_emit.emit("picnest-drag-out-start", json!({ "id": id, "count": files_c.len() }));
                    let mut hr: i32 = 0;
                    let mut eff: u32 = 0;
                    for attempt in 1..=5 {
                        if unsafe { GetAsyncKeyState(VK_LBUTTON) >= 0 } {
                            break;
                        }
                        if attempt == 4 {
                            // 若主 UI 线程连续返回 E_FAIL，尝试独立干净 STA 线程发起 DoDragDrop
                            let files_sta = files_c.clone();
                            (hr, eff) = std::thread::spawn(move || do_ole_file_drag(&files_sta))
                                .join()
                                .unwrap_or((E_FAIL_HR, 0));
                        } else {
                            (hr, eff) = do_ole_file_drag(&files_c);
                        }
                        crate::media_server::diag_push(&format!(
                            "drag_out attempt={} id={} hr=0x{:08x} effect={}",
                            attempt, id, hr as u32, eff
                        ));
                        if hr != E_FAIL_HR {
                            break;
                        }
                        unsafe { ReleaseCapture(); }
                        std::thread::sleep(std::time::Duration::from_millis(30));
                    }
                    crate::media_server::diag_push(&format!("drag_out done id={} hr=0x{:08x} effect={}", id, hr as u32, eff));
                    let _ = app_for_emit.emit("picnest-drag-out-end", json!({ "id": id, "effect": eff }));

                    let mut guard = session_lock().lock().unwrap_or_else(|e| e.into_inner());
                    if guard.as_ref().map(|s| s.id) == Some(id) {
                        *guard = None;
                    }
                });
                break;
            }
        }
    }

    /// Write existing local paths into the Windows clipboard as CF_HDROP so Explorer / CSP can Ctrl+V paste.
    pub fn set_clipboard_hdrop(paths: &[String]) -> Result<usize, String> {
        let valid: Vec<String> = paths
            .iter()
            .map(|p| p.trim().replace('/', "\\"))
            .filter(|p| !p.is_empty() && Path::new(p).exists())
            .collect();
        if valid.is_empty() {
            return Err("没有可复制的有效文件".to_string());
        }
        let hdrop_bytes = build_hdrop_bytes(&valid);
        let eff_bytes = 1u32.to_le_bytes().to_vec(); // DROPEFFECT_COPY

        let mut opened = false;
        for _ in 0..5 {
            if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        if !opened {
            return Err("无法打开系统剪贴板".to_string());
        }

        let res = unsafe {
            if EmptyClipboard() == 0 {
                CloseClipboard();
                return Err("清空剪贴板失败".to_string());
            }
            let h_drop = alloc_hglobal(&hdrop_bytes);
            if h_drop.is_null() {
                CloseClipboard();
                return Err("分配剪贴板内存失败".to_string());
            }
            if SetClipboardData(CF_HDROP as u32, h_drop).is_null() {
                GlobalFree(h_drop);
                CloseClipboard();
                return Err("写入 CF_HDROP 到剪贴板失败".to_string());
            }
            // Also hint Copy drop effect (owned by OS once SetClipboardData succeeds)
            let h_eff = alloc_hglobal(&eff_bytes);
            if !h_eff.is_null() {
                if SetClipboardData(cf_preferred_drop_effect() as u32, h_eff).is_null() {
                    GlobalFree(h_eff);
                }
            }
            CloseClipboard();
            Ok(valid.len())
        };
        res
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn win64_input_struct_is_40_bytes() {
            assert_eq!(std::mem::size_of::<WinInput>(), 40);
        }

        #[test]
        fn builds_valid_cf_hdrop_and_csp_formats() {
            let paths = vec![
                "D:\\OneDrive\\图\\a.png".to_string(),
                "D:\\OneDrive\\图\\b.psd".to_string(),
            ];
            let obj = ComDataObject::new(&paths);
            let mut fmt = std_fmt(CF_HDROP);
            let mut med = StgMedium {
                tymed: 0,
                h_global: std::ptr::null_mut(),
                p_unk_for_release: std::ptr::null_mut(),
            };
            unsafe {
                assert_eq!(data_query_get_data(obj, &fmt), S_OK);
                assert_eq!(data_get_data(obj, &fmt, &mut med), S_OK);
                assert_eq!(med.tymed, TYMED_HGLOBAL);
                assert!(!med.h_global.is_null());

                let ptr = GlobalLock(med.h_global) as *const DropFiles;
                assert_eq!((*ptr).p_files, 20);
                assert_eq!((*ptr).f_wide, 1);
                GlobalUnlock(med.h_global);
                GlobalFree(med.h_global);

                // Preferred DropEffect (DROPEFFECT_COPY = 1)
                let fmt_eff = std_fmt(cf_preferred_drop_effect());
                assert_eq!(data_query_get_data(obj, &fmt_eff), S_OK);
                assert_eq!(data_get_data(obj, &fmt_eff, &mut med), S_OK);
                let eff_ptr = GlobalLock(med.h_global) as *const u32;
                assert_eq!(*eff_ptr, DROPEFFECT_COPY);
                GlobalUnlock(med.h_global);
                GlobalFree(med.h_global);

                // FileNameW
                let fmt_fn = std_fmt(cf_filename_w());
                assert_eq!(data_query_get_data(obj, &fmt_fn), S_OK);
                assert_eq!(data_get_data(obj, &fmt_fn, &mut med), S_OK);
                GlobalFree(med.h_global);

                fmt.cf_format = 1;
                assert_eq!(data_query_get_data(obj, &fmt), DV_E_FORMATETC);
                assert_eq!(data_release(obj), 0);
            }
        }
    }
}

#[cfg(windows)]
use win32_drag::monitor_and_escalate;

#[tauri::command]
pub fn copy_files_to_clipboard(paths: Vec<String>) -> serde_json::Value {
    #[cfg(windows)]
    {
        match win32_drag::set_clipboard_hdrop(&paths) {
            Ok(count) => json!({ "ok": true, "count": count }),
            Err(e) => json!({ "ok": false, "error": e }),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = paths;
        json!({ "ok": false, "error": "仅支持 Windows 剪贴板文件写入" })
    }
}
