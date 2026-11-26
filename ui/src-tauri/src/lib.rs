mod commands;
mod collector;
mod db;
mod drag;
mod dup_finder;
mod fs_ops;
mod importer;
mod media_server;
mod operation_journal;
mod runtime_ops;
mod scanner;
mod security;
mod trash_ops;
mod updater;
mod visual_search;
mod watcher;
#[cfg(test)]
mod testutil;

use commands::*;
use runtime_ops::{dir_memory_get, eagle_inspect, thumbs_missing, video_preview};
use tauri::Manager;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use trash_ops::*;
use std::sync::{Arc, Mutex};

#[cfg(windows)]
fn apply_win32_window_icons(win: &tauri::WebviewWindow) {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetSystemMetrics(nIndex: i32) -> i32;
        fn LoadImageW(
            hInst: isize,
            name: *const u16,
            r#type: u32,
            cx: i32,
            cy: i32,
            fuLoad: u32,
        ) -> isize;
        fn SendMessageW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize;
        #[cfg(target_pointer_width = "64")]
        fn SetClassLongPtrW(hwnd: isize, nIndex: i32, dwNewLong: isize) -> isize;
        #[cfg(target_pointer_width = "32")]
        #[link_name = "SetClassLongW"]
        fn SetClassLongPtrW(hwnd: isize, nIndex: i32, dwNewLong: isize) -> isize;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetModuleHandleW(lpModuleName: *const u16) -> isize;
    }

    const IMAGE_ICON: u32 = 1;
    const LR_DEFAULTSIZE: u32 = 0x0040;
    const LR_SHARED: u32 = 0x8000;
    const SM_CXSMICON: i32 = 49;
    const SM_CYSMICON: i32 = 50;
    const WM_SETICON: u32 = 0x0080;
    const ICON_SMALL: usize = 0;
    const ICON_BIG: usize = 1;
    const GCLP_HICON: i32 = -14;
    const GCLP_HICONSM: i32 = -34;
    const IDI_APP_ICON: usize = 32512;

    let Ok(hwnd_val) = win.hwnd() else { return };
    let hwnd = hwnd_val.0 as isize;
    if hwnd == 0 {
        return;
    }

    unsafe {
        let hinst = GetModuleHandleW(std::ptr::null());
        if hinst == 0 {
            return;
        }
        let res_id = IDI_APP_ICON as *const u16;
        let big_icon = LoadImageW(hinst, res_id, IMAGE_ICON, 0, 0, LR_DEFAULTSIZE | LR_SHARED);
        let sm_w = GetSystemMetrics(SM_CXSMICON).max(16);
        let sm_h = GetSystemMetrics(SM_CYSMICON).max(16);
        let small_icon = LoadImageW(hinst, res_id, IMAGE_ICON, sm_w, sm_h, LR_SHARED);

        if big_icon != 0 {
            SetClassLongPtrW(hwnd, GCLP_HICON, big_icon);
            SendMessageW(hwnd, WM_SETICON, ICON_BIG, big_icon);
        }
        if small_icon != 0 {
            SetClassLongPtrW(hwnd, GCLP_HICONSM, small_icon);
            SendMessageW(hwnd, WM_SETICON, ICON_SMALL, small_icon);
        }
    }
}

#[cfg(not(windows))]
fn apply_win32_window_icons(_win: &tauri::WebviewWindow) {}

/// 托盘点击 / “打开窗口”菜单项共用：显示、恢复并聚焦主窗。
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        apply_win32_window_icons(&w);
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let data_dir = dirs::data_local_dir()
        .map(|p| p.join("PicNest"))
        .unwrap_or_else(|| std::path::PathBuf::from(".picnest_data"));

    media_server::diag_init(&data_dir);
    let db_path = data_dir.join("picnest.db");
    let t_db = std::time::Instant::now();
    let conn = db::init_db(&db_path).expect("Failed to initialize PicNest SQLite database");
    media_server::diag_push(&format!("db::init_db done in {}ms", t_db.elapsed().as_millis()));
    let thumbs_dir = data_dir.join("cache").join("thumbs");
    let (media_port, api_port, media_nonce) = media_server::start_media_server(db_path.clone(), thumbs_dir);
    media_server::diag_push(&format!("media_server port={} api_port={}", media_port, api_port));

    let cdp_data_base = data_dir.clone();
    let state = AppState {
        db: Arc::new(Mutex::new(conn)),
        db_path,
        data_dir,
        media_port,
        api_port,
        media_nonce,
    };

    tauri::Builder::default()
        // 单实例：重复双击 exe 不再叠后台，只把已有窗口唤回前台
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            window_minimize,
            window_maximize,
            window_close,
            window_toggle_always_on_top,
            set_always_on_top,
            app_version,
            video_preview,
            dir_memory_get,
            thumbs_missing,
            eagle_inspect,
            open_external,
            open_folder,
            get_paths,
            get_all_folders,
            add_folder_by_path,
            dir_tree,
            dir_stats,
            images_by_dir,
            dir_covers,
            count_all,
            recent,
            image_opened,
            delete_dir,
            mkdir,
            select_folders,
            view_counts,
            sync_folder_snapshot,
            sync_dir_snapshot,
            dir_memory_root_get,
            dir_memory_set,
            dir_memory_rename,
            window_is_always_on_top,
            generate_thumbnails_batch,
            generate_display_thumbs_batch,
            remove_root,
            fill_image_dims,
            view_preview,
            psd_preview,
            apply_transform,
            crop_image,
            crop_image_as,
            images_reorder,
            dir_order_get,
            dir_order_set,
            dir_sort,
            dir_sort_recursive,
            export_dir,
            move_image,
            move_dir,
            // 已弃用（2026-11-14）：下面三个命令不再注册。
            // 它们靠改文件名表达顺序，而 physical_order_* 每次改名都把 thumbnail_path 置 NULL，
            // 一次全量排序就能把整库缩略图路径清空——用户看到的是满屏灰卡、PSD 也显示不了。
            // 排序现在只存 sort_order + picnest_dir_order，磁盘文件名永不被程序碰。
            // physical_order_images,
            // physical_order_dirs,
            // strip_order_prefixes,
            // 手动触发版（安全）：预览 → 执行，改名时迁移缩略图缓存
            write_order_to_filenames,
            // 库 → 磁盘：把整个文件夹（含子文件夹）的图片顺序写成文件名前缀
            sync_folder_to_disk,
            rename_image,
            rename_dir,
            rename_library,
            get_media_port,
            get_api_port,
            get_image_meta,
            set_image_meta,
            compute_color_analysis,
            build_palettes_step,
            get_palettes,
            video_compat,
            set_image_rating,
            db_delete_image,
            picnest_reveal,
            picnest_search,
            picnest_random,
            tags_list,
            tag_assign,
            tag_rename,
            tag_delete,
            root_meta_load,
            root_meta_save,
            root_meta_ensure,
            read_text,
            save_text,
            generate_text_thumbnails,
            collect_get_token,
            collect_reset_token,
            collect_set_root,
            drag::drag_begin,
            drag::drag_end,
            drag::copy_files_to_clipboard,
            importer::stage_drop_begin,
            importer::stage_drop_mkdir,
            importer::stage_drop_chunk,
            importer::stage_drop_cleanup,
            importer::import_check,
            importer::import_files,
            importer::dir_dup_check,
            importer::dir_dup_cancel,
            importer::import_dir_copy,
            importer::import_urls,
            importer::copy_images,
            trash_remove_image,
            trash_list,
            trash_restore_image,
            trash_purge_image,
            trash_folders,
            trash_restore_folder,
            trash_purge_folder,
            trash_restore_all,
            trash_purge_all,
            visual_search_query,
            visual_search_save,
            find_duplicates,
            dup_cancel,
            ai_config_get,
            ai_config_set,
            ai_models,
            ai_test,
            ai_dup_scan,
            ai_dup_continue,
            ai_dup_cancel,
            cleanup_orphan_thumbs,
            crate::updater::check_update,
            crate::updater::download_update,
            crate::updater::cancel_download_update,
            crate::updater::quit_and_install,
            diag_event,
            diag_dump
        ])
        .setup(move |app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let mut win_cfg = app.config().app.windows.first().cloned()
                .ok_or_else(|| "missing main window config".to_string())?;
            // 2026-11-15 修复：裸 cargo build 不带 custom-protocol 时 tauri 内部 cfg(dev)
            // 恒为 true，release 也去加载 devUrl 5173（Vite 没起即 ERR_CONNECTION_REFUSED）。
            // Cargo.toml 已加 custom-protocol；开发热更改为 PICNEST_DEV=1 时显式把入口
            // 指成 External(devUrl)，普通双击走内嵌 assets（tauri.localhost）。
            if std::env::var("PICNEST_DEV").map(|v| v == "1").unwrap_or(false) {
                if let Some(dev) = app.config().build.dev_url.clone() {
                    win_cfg.url = tauri::utils::config::WebviewUrl::External(dev);
                }
            }
            let mut builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &win_cfg)?;
            /* WebView2 默认可能不走 GPU 光栅/零拷贝，合成与悬停重绘会挤在 UI 线程上，
               主线程一忙就“鼠标跑了高亮还挂着”。这里明确开 GPU 路径。
               （Electron 自带独立 GPU 进程，没这个困扰） */
            // 2026-11-14 晚 A/B：上面那批 GPU 开关（gpu-rasterization / ignore-gpu-blocklist /
            // zero-copy / CanvasOopRasterization+UseSkiaRenderer）已在下一轮拿掉，跑 WebView2 默认。
            let mut args = String::from(
                "--disable-background-timer-throttling \
                 --disable-renderer-backgrounding \
                 --disable-backgrounding-occluded-windows \
                 --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion ",
            );
            /*
            let mut args = String::from(
                "--enable-gpu-rasterization --ignore-gpu-blocklist --enable-zero-copy \
                 --enable-features=CanvasOopRasterization,UseSkiaRenderer \
                 --disable-background-timer-throttling \
                 --disable-renderer-backgrounding \
                 --disable-backgrounding-occluded-windows \
                 --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion ",
            );
            */
            // 已移除：--disable-gpu-vsync --disable-frame-rate-limit
            // 它们把输入投递节拍从 16ms 拉到 3–12ms，但同时让 renderer 无上限出帧，
            // 切目录时大量图层重建，宿主（Tauri 主线程）被合成提交占满 CPU，
            // 实测 Win32 消息泵阻塞 0.3–3s，真实点击延迟 1.3–3.3s。得不偿失。
            let mut data_dir: Option<std::path::PathBuf> = None;
            if let Ok(port) = std::env::var("PICNEST_CDP_PORT") {
                let p = port.trim();
                if !p.is_empty() {
                    args.push_str(&format!(
                        "--remote-debugging-port={} --remote-allow-origins=* ",
                        p
                    ));
                    let dir = cdp_data_base.join(format!("cdp_{}", p));
                    let _ = std::fs::create_dir_all(&dir);
                    data_dir = Some(dir);
                    media_server::diag_push(&format!("CDP enabled on port {}", p));
                }
            }
            builder = builder.additional_browser_args(&args);
            if let Some(d) = data_dir {
                builder = builder.data_directory(d);
            }
            media_server::diag_push(&format!("webview args: {}", args));
            let win = builder.build()?;
            apply_win32_window_icons(&win);
            let win_for_icon = win.clone();
            let _ = app.run_on_main_thread(move || apply_win32_window_icons(&win_for_icon));

            // —— 系统托盘 ——
            // 关窗只隐藏进托盘；托盘左键唤回窗口，右键菜单里“退出”才是真退。
            let show_item = MenuItem::with_id(app.handle(), "tray_show", "打开 PicNest 窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app.handle(), "tray_quit", "退出 PicNest", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app.handle(), &[&show_item, &quit_item])?;
            let _tray = TrayIconBuilder::with_id("picnest-main")
                .icon(tauri::include_image!("icons/tray-icon.png"))
                .tooltip("PicNest")
                .menu(&tray_menu)
                // Windows：左键不再弹菜单（弹给事件处理），右键才弹“退出”
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "tray_quit" => app.exit(0),
                    "tray_show" => show_main(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event {
                        show_main(tray.app_handle());
                    }
                })
                .build(app.handle())?;

            // Alt+F4 等任何关窗路径都在这里拦下：隐藏而不是关闭，托盘永远留一个入口。
            // （updater 的安装重启走 handle.exit(0)，不经过这里，不受影响）
            let win_for_close = win.clone();
            win.on_window_event(move |event| {
                match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = win_for_close.hide();
                    }
                    tauri::WindowEvent::Focused(true) => {
                        apply_win32_window_icons(&win_for_close);
                    }
                    _ => {}
                }
            });

            // 启文件监听：库里任何目录的新增/删除/改名 → 防抖合并 → 通知前端自动同步。
            // 开销：ReadDirectoryChangesW 是内核事件通知，不轮询、不读文件内容。
            let roots_for_watch: Vec<std::path::PathBuf> = {
                let state = win.state::<AppState>();
                let guard = state.db.lock().ok();
                guard
                    .as_ref()
                    .and_then(|conn| {
                        conn.prepare("SELECT path FROM folders")
                            .ok()
                            .and_then(|mut stmt| {
                                stmt.query_map([], |r| r.get::<_, String>(0))
                                    .ok()
                                    .map(|rows| rows.flatten().map(std::path::PathBuf::from).collect())
                            })
                    })
                    .unwrap_or_default()
            };
            watcher::start(win.app_handle().clone(), roots_for_watch);
            let c_data_dir = cdp_data_base.clone();
            let c_db_path = win.state::<AppState>().db_path.clone();
            collector::start_collector_server(c_data_dir, c_db_path, win.app_handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
