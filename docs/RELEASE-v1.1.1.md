# PicNest v1.1.1 (花瓣/Pixiv/Pinterest 无损采集 · 本地文件夹实时同步升级)

> 🎨 **专为画师、原画设计师与视觉创作者打造的轻量级开源本地素材管理中心**  
> 本次版本聚焦于 **花瓣网（huaban.com）采集全面修复**、**三大画师高频站点高清原图自动升级与多候选降级兜底**，以及 **本地资源管理器增删改名文件夹秒级实时同步**。

---

## ✨ v1.1.1 核心更新与修复

### 1. 花瓣网采集彻底修复（配套浏览器扩展 v0.3.3）
- **修复 EdgeOne `HTTP 567` 防盗链拦截**：拦截花瓣发现页卡片 `data-pin-id` 被误判成 Pinterest URL 的路径，并修复后端空 `Referer` 兜底为图片 CDN 域名导致的 `HTTP 567` 拦截；`huaban.com` / `huabanimg.com` 图床统一规范为合法花瓣页面 `Referer`。
- **DOM 穿透与误过滤修复**：适配花瓣发现页 `display: contents` 包装层与同级遮罩层结构，修复多图卡片漏判及首页根容器 `new-home-header-active` 触发的窄图误杀；非 2xx 下载错误显式透出具体 HTTP 状态码。

### 2. 花瓣 / Pinterest / Pixiv 高清无损原图自动升级与降级兜底
- **智能原图升级链（长按采集 & 右键采集双链路对齐）**：
  - **花瓣网**：保留原始 `auth_key` 签名并剥离 `_fw240webp` / `_fw658webp` / `_sq75webp` 等缩放后缀直取无损原图，失败时逐级降级至 `_fw1200webp` 与原始 `src`。
  - **Pinterest**：继续自动升级 `/236x/`、`/474x/`、`/564x/`、`/736x/` 至 `/originals/`，并在原图缺失时自动回退当前图源。
  - **Pixiv**：优先提取父级原图直链，列表缩略图自动推导 `img-original`（`.png` → `.jpg` → `.gif` → `_master1200.jpg` → 原 `src`）依次探测。
- **Rust 服务端多候选降级下载**：`collector` 支持携带 `fallbackSrcs`（最多 6 级去重候选），命中即保存并按真实命中 URL 与 `Content-Type` 匹配正确文件后缀。

### 3. 本地文件夹新增 / 拖入 / 删除 / 重命名实时同步优化
- **整棵被删目录自动软删**：修复外部删除或移出文件夹时仅尝试匹配目录路径本身导致子文件残留孤儿记录的问题，改为边界安全的目录前缀软删（绝不误伤同名开头兄弟目录）。
- **新增 / 移入 / 重命名目录递归增量入库**：外部拖入或新建多层文件夹时，监听线程直接递归扫入支持的媒体文件（过滤 `.picnest` / `.git` 等隐藏项，且绝不复活图巢回收站已软删条目），防抖窗口收紧至 `300ms`。
- **离线孤儿清理与目录树即时联动**：`sync_folder_snapshot` 补全磁盘已删文件 `gone` 清理；前端移除「非当前目录直接丢弃事件」的限制，外部在任意子目录增删文件夹均第一时间刷新侧边栏与计数；若当前正在浏览的文件夹被外部删除，将平滑退回最近的现存父目录或库根。

### 4. Windows 任务栏图标修复
- **规范多尺寸内嵌图标**：重制 `icons/icon.ico` 为符合 Win32 规范的 32-bit DIB（16/24/32/48/64px）+ PNG（256px）混合标准图标，并在 `build.rs` 增加变更监听确保资源编译器必然嵌入。
- **Win32 原生 `ICON_BIG` 与窗口类图标绑定**：绕开 Tauri/tao 默认仅设置 `ICON_SMALL` 并在创建无边框窗口时将 `ICON_BIG` 与 `WNDCLASSEXW.hIcon` 留空的限制，在主窗口创建、主线程初始化、窗口聚焦与托盘唤回时通过 `LoadImageW(#32512)` + `SetClassLongPtrW(GCLP_HICON / GCLP_HICONSM)` + `SendMessageW(WM_SETICON, ICON_BIG / ICON_SMALL)` 显式绑定原生大/小图标，彻底修复 Windows 11 任务栏白纸图标问题。

---

## 📦 下载与校验 (Assets)

| 文件名 | 说明 | 文件大小 | SHA-256 校验和 |
| :--- | :--- | :--- | :--- |
| **`PicNest-v1.1.1-windows-x64-portable.zip`** | 绿色便携包（内含 `PicNest.exe` 与画师指南） | **6.11 MB** | `15910D5875E6D8798D738CDBB0FE4FF28BF788002875CC0B0B7A782EFE42DAC0` |
| **`PicNest-extension-v0.3.3.zip`** | 浏览器采集扩展包（Edge / Chrome 解压加载 `extension/`） | **54.27 KB** | `7D5E0D922D7DCDC99300DD9CECFD52B82CECC0E3AFA512EF89F46FCD3B6744F5` |

> **使用方法**：
> - **桌面端**：解压 `PicNest-v1.1.1-windows-x64-portable.zip` 到任意目录双击 `PicNest.exe` 即可使用（v1.1.0 用户亦可在软件内点击「检查新版本」自动校验热更新）。
> - **浏览器扩展**：解压 `PicNest-extension-v0.3.3.zip`，在 `edge://extensions` / `chrome://extensions` 加载或更新 `extension/` 目录即可升至 `v0.3.3`。
