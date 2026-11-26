# PicNest v1.1.0 (全链路安全与一致性加固 · 动态视觉主题升级)

> 🎨 **专为画师、原画设计师与视觉创作者打造的轻量级开源本地素材管理中心**  
> 本次版本聚焦于 **本地服务与文件边界安全加固**、**文件系统与 SQLite 原子一致性恢复**、**Windows 原生资源管理器集成修复** 与 **全新动态视觉主题引擎**。

---

## ✨ v1.1.0 核心更新与优化

### 1. 本地服务与采集合规边界加固（阶段 1）
- **媒体服务严格隔离**：引入进程级随机 Nonce 与路径规范化校验（`canonicalize` + 严格根目录 Containment），仅允许访问已登记图库根目录与缩略图缓存，拒绝访问应用数据根、数据库、密钥与系统临时目录；强制校验 `Host`/`Origin`。
- **密码学随机采集密钥**：浏览器扩展配对密钥升级为 CSPRNG 随机数，废除 URL query token，仅接受 `X-PicNest-Token` Header 与精确 Origin 匹配。
- **SSRF 防护与代理兼容**：远程采集新增私网/链路本地/回环地址拦截、逐跳重定向验证与 500 MB 流式下载硬上限；同时智能兼容本地系统代理与 Clash Fake-IP / TUN 环境。
- **生产 CSP 与协议收敛**：关闭全局 `asset` 协议放行，启用生产端脚本哈希校验及严格 CSP。

### 2. 文件系统与 SQLite 原子一致性及崩溃恢复（阶段 2）
- **防丢文件状态机（Operation Journal）**：引入持久化单表操作日志与 `.picnest-part-*` 临时暂存校验，确保采集、导入、裁剪另存、移动、改名、目录重命名与回收站批量清除在中断或 SQL 失败时可精确回滚或安全续做。
- **全量遵循回收站安全底线**：任何既有用户文件替换与跨卷操作均强制通过 Windows 原生回收站（`trash::delete`），移除缺失 `trash_path` 时误建空目录的高危分支。
- **版本化幂等数据库迁移**：基于 `PRAGMA user_version` 建立幂等迁移链，平滑兼容存量旧版本图库数据库，缩略图清理与迁移统一覆盖全部 8 种派生变体。

### 3. Windows 原生文件管理器定位与 Tauri 运行时对齐（阶段 3 & 补充修复）
- **文件定位不再跳回「文档」**：图片右键「在文件管理器打开」改用 Windows Shell 原生 `ILCreateFromPathW` + `SHOpenFolderAndSelectItems`（辅以剔除 `\\?\` 与规范引号的 `explorer /select` 安全兜底），彻底解决路径含空格/逗号时跳入系统「文档」的问题。
- **目录右键直达文件管理器**：新增受图库 Containment 约束的 `open_folder` 命令，打通根文件夹与普通子文件夹的「在文件管理器中打开」入口。
- **运行时能力显式收敛**：统一补齐 `video_preview`、`set_always_on_top`、`dir_memory_get`、`thumbs_missing`、`app_version`（结构化版本返回）；为 Eagle `.library` 导入与未实现插件接口接入明确阻断提示与 Fail-Closed 拦截；强化自更新器流式 SHA-256 校验与扩展 E2E 门禁。

### 4. 全新动态视觉主题与转场引擎
- **5 款动态主题登场**：在经典主题基础上新增 **`酸性印刷 (acid-print)`**、**`终末工业 · 白纸/暗夜 (endfield-light/dark)`** 与 **`黑曜棱镜 · 暗夜/冷晶 (obsidian-dark/light)`**。
- **View Transitions 主题转场**：新增 `motionDirector.js`、`AcidBanner.vue`、`ObsidianHorizon.vue`、`PixelMascots.vue`，按主题匹配丝网刮墨斜切、激光扫描揭示或光学棱镜折射转场动画。

---

## 📦 下载与校验 (Assets)

| 文件名 | 说明 | 文件大小 | SHA-256 校验和 |
| :--- | :--- | :--- | :--- |
| **`PicNest-v1.1.0-windows-x64-portable.zip`** | 绿色便携包（内含 `PicNest.exe` 与画师指南） | **6.06 MB** | `13A5A6865CEB1ED90E0C369B36468A23724A205F3477F00A279EDE3BDC40FBD8` |

> **使用方法**：解压 `PicNest-v1.1.0-windows-x64-portable.zip` 到任意目录，双击 `PicNest.exe` 即可直接使用，无需任何外部依赖；已安装 v1.0.1 的用户亦可直接通过软件内「检查新版本」一键校验热替换升级。
