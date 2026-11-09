# PicNest 图巢 — 开源接手交接（给 Gemini）

> 写给接下来负责**开源发布、许可证、仓库与发布流程**的接手者。
>
> 先读顺序：**本文 → `docs/HANDOFF.md`（工程细节/纪律）→ `docs/PLAN.md`（功能与决策历史）→ `docs/PLUGIN.md`（插件协议）→ `extension/README.md`（浏览器扩展）**。
>
> 结论先行：**功能开发已告一段落，当前仓库可以运行，但不能直接原样公开**。最大的两个问题不是功能，而是：
> 1. **`app/` 被 .gitignore 排除**，主进程/preload 的唯一源码副本不在 git 里；直接发行二进制会缺少 GPL-3.0 要求的对应源码，公开仓库也无法从零构建。
> 2. **根目录没有 README / LICENSE**，且 `docs/` 里含真实素材库路径、数量和个人使用痕迹；不能原样作为公开仓库的文档。
>
> 建议 Gemini 的第一优先级是 **GPL 合规 + 可复现构建 + 隐私清理**，不是继续加功能。

---

## 1. 项目一句话

**PicNest 图巢**：Windows 桌面图片素材库，**直链索引本地文件夹（不复制原图）**，用来日常替代 Eagle。暖纸/金色 UI，支持手动排序与物理前缀、标签/评分/注释、缩略图、灯箱/裁剪/旋转、精确与 AI 查重、Eagle 库迁移、浏览器采集扩展、沙箱插件。

- 来源：**GPL-3.0 fork 自 PicRand 2.77.0**。
- 技术栈：Electron 33.4.11 + Vue 3.5 + Pinia + Vite 6；主进程为预构建的 PicRand `out/main`，通过 `tools/patches/apply.mjs` 打补丁。
- 目标平台：**Windows 10/11 x64**；macOS/Linux 未测试。
- 当前形态：便携目录 `app/PicNest.exe`，不是安装包，没有自动更新。

## 2. 当前仓库状态

| 项目 | 状态 |
|---|---|
| 分支 | `master`，**没有 remote** |
| 提交 | 功能收尾提交见 `git log -1`；最终检查点标签 `checkpoint-2026-11-09-final` |
| 跟踪文件 | 约 120 个，约 3.3 MiB |
| `app/` | **被 .gitignore 排除**，约 1.4 GB（Electron 运行时 + node_modules + 主进程/preload + dist + exe） |
| 根 README | **不存在** |
| 根 LICENSE | **不存在**（`app/LICENSE` 是 PicRand 的 GPL-3.0 原文 + Electron/Chromium 许可证） |
| 版本号 | `app/resources/app/package.json` = `2.77.0`（继承自 PicRand）；`ui/package.json` = `0.1.0` |
| 现有标签 | `checkpoint-2026-11-09`、`checkpoint-2026-11-09-r2`、最终检查点 |

> `app/` 不进 git 是开发期为了避开 1.4 GB 运行时；**公开发布时必须单独解决源码与构建问题**（见 §4）。

## 3. 构建 / 运行 / 数据位置

### 3.1 dev 运行

```bash
cd <repo>\ui
npm run dev
# 另开窗口：
powershell "$env:PICNEST_DEV='1'; Start-Process '<repo>\app\PicNest.exe' -ArgumentList '--remote-debugging-port=9222' -WorkingDirectory '<repo>\app'"
```

- dev 数据目录：`app\_internal_data\`（CWD 相对；`-WorkingDirectory` 必须给 `app\`，否则数据目录跑偏）。
- 生产数据目录：`C:\Users\<用户>\AppData\Roaming\PicNest`。
- dev 页面：`http://127.0.0.1:5173/`；生产：`file:///.../app/resources/app/dist/index.html`。

### 3.2 生产构建

```bash
cd ui
npm ci
npm run build          # 直接产出到 app/resources/app/dist
cd ..
node tools/patches/apply.mjs
```

- `ui/vite.config.js` 的 `build.outDir` 已指向 `../app/resources/app/dist`，`base: './'` 不能改（`file://` 加载）。
- **不 build 就双击 exe 会跑旧 dist**。
- 主进程补丁：`node tools/patches/apply.mjs`（幂等；P4 整块重注入 handlers，P4b 重注入 preload 桥）。新增 IPC 必须同步三处：`tools/patches/picnest-handlers.js`、`apply.mjs` 的 P4b 列表、`ui/src/api.js`。
- 当前 `apply.mjs` 重放应显示 **0 失败**。若出现 FAIL，先修补丁标记，不要继续发布。

### 3.3 运行目录里哪些不能丢

| 路径 | 作用 |
|---|---|
| `app/resources/app/out/main/index.js` | 已打补丁的主进程（**唯一主进程源码形态**） |
| `app/resources/app/out/preload/index.js` | 已打补丁的 preload（contextBridge） |
| `app/resources/app/dist/` | Vite 构建产物（可由 `ui/` 重建） |
| `app/_internal_data/icon.png` / `icon.ico` | 窗口/任务栏图标 |
| `app/PicNest.exe` | 已用 resedit 写入图标与 VersionInfo 的 Electron 主程序 |
| `app/PicNest.exe.picrand.bak` | 原始 PicRand exe 备份（**不要公开分发**） |
| `app/LICENSE`、`app/LICENSE.electron.txt`、`app/LICENSES.chromium.html` | 上游/运行时许可证 |

> **exe 资源补丁脚本目前不在仓库里**（开发时用的是临时 `/tmp/resedit-tool/patch.cjs`）。Gemini 需要把它固化成 `tools/patches/exe-resources.mjs` 之类的可复现脚本，并把图标/版本信息写入流程写进 README。没有它，重新拿到原始 PicRand app 后无法复现当前 exe 的品牌信息。

## 4. 开源合规：先解决这四件事

### 4.1 许可证与归属（P0）

- PicNest 是 PicRand 2.77.0 的衍生作品，**必须继续以 GPL-3.0（或更高版本）分发**，保留原版权声明，不能附加额外限制。
- 当前 `app/LICENSE` 顶部是：

  ```
  PicRand
  Copyright (C) 2026 PicRand
  ... GNU General Public License v3 ...
  ```

- 需要新增：
  - 根 `LICENSE`：GPL-3.0 完整正文。
  - 根 `NOTICE`（或 `COPYING.NOTICE`）：说明 PicNest 基于 PicRand 2.77.0、列出主要修改、保留 PicRand 版权；注明 PicNest 自己的版权归属（由 Feb 确认署名）。
  - README 的 License 段落链接到上述文件。
- **确认上游 PicRand 的源码获取方式**。如果上游有公开仓库，在 NOTICE 里给出；如果没有，至少随发布物提供本衍生版对应源码（见 4.2）。GPL 义务是“提供对应源码”，不是“链到别人的二进制”。

### 4.2 对应源码（P0，最关键）

`app/` 被 gitignore，所以当前公开仓库**没有主进程/preload 源码**，也无法从零构建。建议二选一：

**方案 A（推荐）：在仓库里放一份可修改的主进程源码镜像**
- 新增 `source/picrand-2.77.0/`（或 `vendor/picrand/`），包含：
  - `out/main/index.js`
  - `out/preload/index.js`
  - `package.json`
  - `LICENSE`
  - 如能找到上游的 TypeScript/源工程，优先放上游源工程而不是打包产物。
- 让 `apply.mjs` 支持从该镜像复制到 `app/` 再打补丁，形成“镜像 + 补丁 → 可运行 app”的可复现链路。
- 发布二进制时，在 README/关于页给出对应源码的 tag/压缩包地址。

**方案 B：发布物附带源码压缩包**
- 每次 Release 同时上传 `PicNest-<version>-source.zip`，包含上述文件 + `ui/` + `tools/patches/` + 构建说明。
- 仓库里仍建议放镜像，否则 CI 无法构建。

> 不要只发布 `app/` 整个 1.4 GB 目录当“源码”；里面包含 node_modules、Chromium 运行时和个人数据目录，既超限也不符合“对应源码”的清晰性。把 node_modules 的许可证清单单独生成即可。

### 4.3 隐私清理（P0）

- `docs/HANDOFF.md` / `docs/PLAN.md` 含**真实素材库路径、图片数量、个人标签/文件夹名、迁移统计**。**不要原样公开**。
- 公开前执行并人工复核：

  ```bash
  git grep -nE '[A-Z]:\\|OneDrive|C:\\Users|/Users/' -- docs 2>/dev/null
  ```

- 建议**新建一个干净的公开仓库**（而不是直接把当前仓库 push 上去），只保留：
  - `ui/`、`tools/patches/`、`extension/`、`examples/`、`branding/`（确认版权后）、`docs/PLUGIN.md`、脱敏后的 README/构建文档。
- 如果坚持复用当前 git 历史，需要重写历史清除个人路径；仅删除最新提交里的文本不够。
- 确认 `app/_internal_data/`、`picnest.db`、`picnest-thumbs/`、`picnest-ai.json`、日志、截图都没有被跟踪。当前 `.gitignore` 已排除 `app/`、`_internal_data/`、`tools/shot-*.png`、`tools/*.log`，但公开前仍要 `git ls-files` 全量核对。

### 4.4 第三方许可证与资产（P0/P1）

- Electron/Chromium：`app/LICENSE.electron.txt`、`app/LICENSES.chromium.html`，发布时保留。
- npm 依赖：用 `license-checker` 或类似工具生成 `THIRD-PARTY-NOTICES`；重点核对 `sharp`、`better-sqlite3`、`@xenova/transformers`、`onnxruntime-node`、`@ffmpeg-installer/ffmpeg`、`steamworks.js`（已禁用但仍在依赖里）、`koffi`、`trash`。
- **Wenku8 文件夹图标**：`docs/HANDOFF.md` 记录为 GPL-2.0-or-later 移植，需在 NOTICE 保留出处与许可证。
- Logo/PSD：`branding/final/PicNest-logo.psd` 与导出图由 Feb 提供；公开前确认署名/授权方式。
- 浏览器扩展：代码原创，但 manifest 申请了 `<all_urls>` 与 `tabs/scripting` 等权限；上架商店需要隐私说明与权限理由。

## 5. 功能验收基线（已实现）

发布前用这份清单确认没有回退：

- 根文件管理：添加/移出/重命名/导出/复制粘贴；直链索引，不复制原图；`.picnest/meta.json` 随根保存标签/评分/注释/颜色/封面/手动顺序。
- 浏览：文件夹树、全部/最近/未分类/回收站、子文件夹内容、面包屑、历史前进后退、框选/多选、拖拽移动/排序。
- 排序：手动（默认）、标题/添加/修改/大小/尺寸/评分/随机；物理前缀开关；`01` 隐藏编号；应用为手动排序（真实改名 + 确认）；一键清除根目录编号。
- 详情：预览、名称、注释、URL、评分、标签、文件夹 chip、色板、多选批量操作；灯箱详情独立 Inspector。
- 大图：滚轮缩放/拖拽、裁剪、旋转/翻转保存、视频自绘控制、简报模式、黑白预览。
- 拖出：直接拖动图片——窗口内是内部排序/移动（落点高亮），拖出 PicNest 窗口自动升级为原生文件拖拽，可拖进 CSP / PS / 资源管理器。
- 搜索/筛选：关键词、评分、标签、颜色、尺寸/方向等；主题六选一 + 系统跟随 + config 记忆；左栏开合。
- 缩略图：400px 网格 + 1024px 显示图；失败降级链；批量修复；文本/PSD/视频缩略图。
- 查重：精确（大小分桶 + 流式 MD5 + 可取消）、AI（OpenAI 兼容视觉、dHash 预筛、费用预估、风险提示、只上传缩略图）。
- 采集：MV3 扩展（右键图片/页面截图/按住拖拽），本机 `127.0.0.1:41600`，重复三选一，新建文件夹。
- 插件：theme CSS 注入；renderer 单文件 HTML + sandbox iframe + postMessage 白名单；registry zip + sha256；安装/启停/卸载。
- 关闭行为：**点主窗口 X = 隐藏到托盘；托盘「退出」才彻底结束进程**（P13a/P13b）。托盘菜单只有「显示 PicNest 图巢 / 退出」，参考板四项已移除。

## 6. 已知限制（公开时要写进 README/ROADMAP）

- **仅 Windows x64**；macOS/Linux 未测试。
- **便携目录**，无安装包、无自动更新、无代码签名（SmartScreen 会提示）。
- 主进程是 PicRand 预构建产物 + 补丁，不是常规 Electron 源码工程；上游同步成本高。
- Eagle 迁移向导在打包版依赖项目根 `tools/eagle-migrate/`，打包时必须一起分发或内置（P0 发布前）。
- 采集服务**还没有 token 鉴权**，只靠 127.0.0.1 + Origin 白名单；公开宣传前建议补 token。
- 插件 `type=main` 只登记不运行（P3）；registry 在线签名未做（P4）；没有默认在线 registry。
- AI 查重候选超过上限只查最接近的 N 对，无后台定时扫描；AI 需要用户自备 OpenAI 兼容 Key。
- 物理排序无撤销、无预览；开启后每次手动拖拽可能批量改名，建议只在小文件夹用。
- 大文件夹拖入的 `import-dir-copy` 仍有同步 MD5/copy 段，可能卡主进程。
- 拖到外部应用是**统一拖拽**：窗口内保持 HTML5 内部排序/高亮，光标离开 PicNest 窗口后主进程才升级为原生 `startDrag`（Windows 上两者互斥，electron#7118）。升级判定基于窗口 bounds；如果目标窗口覆盖在 PicNest 内部且光标坐标未出界，不会升级，把目标窗口挪到 PicNest 外侧即可。CSP/PS 的实际接收需按用户环境验证。
- 参考板功能已从托盘菜单移除；bundle 里仍有旧函数，但无入口。

## 7. 开源发布 TODO（建议顺序）

### P0 — 不做完不要公开发布

- [ ] 确认 PicRand 上游来源与许可证原文；确定 PicNest 版权署名。
- [ ] 根 `LICENSE`（GPL-3.0 全文）+ `NOTICE`（PicRand 归属、修改说明、Wenku8 图标、第三方声明）。
- [ ] 主进程/preload 对应源码进入仓库或随 Release 提供（§4.2）；让 clean checkout 能构建。
- [ ] 固化 exe 图标/VersionInfo 补丁脚本（resedit），写进构建文档。
- [ ] 脱敏 `docs/`，新建干净公开仓库或重写历史；`git ls-files` 确认无个人数据。
- [ ] 根 `README.md`：中文为主 + 英文摘要、功能截图（用演示库，不用个人素材）、安装/运行/构建/数据位置/卸载/许可证。
- [ ] 第三方许可证清单（Electron/Chromium/npm/Wenku8/字体/图标）。

### P1 — 发布流程与仓库治理

- [ ] 版本方案（建议从 `0.1.0` 起，不要继续用上游 `2.77.0` 当产品版本；或在关于页写清“基于 PicRand 2.77.0”）。
- [ ] `CHANGELOG.md`、`CONTRIBUTING.md`、`SECURITY.md`、Issue/PR 模板、行为准则。
- [ ] `main` 分支 + remote + CI：至少跑 `node tools/patches/apply.mjs`（0 失败）、`npm ci && npm run build`、许可证检查。
- [ ] 便携 zip + SHA256 + Release notes；可选代码签名。
- [ ] 采集服务 token；扩展隐私说明；AI 上传说明；插件 registry 托管与签名计划。
- [ ] 上游同步策略（PicRand 新版本如何合并补丁）。

### P2 — 生态与文档

- [ ] 扩展上架 Edge Add-ons / Chrome Web Store（需权限理由、隐私政策、截图）。
- [ ] 插件 registry 静态托管 + 示例插件发布。
- [ ] 用户文档站/FAQ（直链索引的删除语义、物理排序风险、AI 费用）。
- [ ] 英文 README/界面文案（当前 UI 中文为主）。

## 8. 交接验收（Gemini 接手后先跑一遍）

```bash
cd <repo>

# 1) 补丁幂等：应 0 失败
node tools/patches/apply.mjs

# 2) UI 构建：应成功，产物进 app/resources/app/dist
cd ui && npm ci && npm run build && cd ..

# 3) 启动生产模式（带调试口方便自检）
powershell "Start-Process '<repo>\app\PicNest.exe' -ArgumentList '--remote-debugging-port=9222' -WorkingDirectory '<repo>\app'"

# 4) 页面/桥接/网格
node tools/cdp-eval.mjs "({href:location.href,title:document.title,bridge:!!window.picrand,cells:document.querySelectorAll('.cell').length})"

# 5) 采集服务（应用运行时）
curl http://127.0.0.1:41600/api/v1/ping
```

人工验收：

1. 关窗 → 窗口消失、进程/托盘仍在；托盘「退出」→ 进程全部结束。
2. 打开一个**临时测试根**（不要用真实素材库），确认网格/详情/灯箱/排序/标签正常。
3. 插件库安装 `examples/plugins/mono-mint`，启用/停用；renderer 示例面板能打开。
4. `git status` 干净；`git ls-files` 中没有 `app/`、数据库、缩略图、AI key、个人截图。

## 9. 交接结论

- 功能：**暂时封版**。后续新增功能应走插件或新分支，不在这个收尾点上继续堆。
- 工程：可运行、可复现打补丁、UI 可构建；**但公开仓库还缺主进程源码与许可证文件**。
- 品牌与素材版权归 Feb；Gemini 在公开前需要 Feb 确认署名、Logo 授权和最终许可证方案。
- 建议 Gemini 的推进顺序：**§4.1 许可证 → §4.2 对应源码 → §4.3 隐私清理 → README/构建文档 → CI/Release → 采集 token/扩展上架**。

---

*本文由当前开发窗口在功能收尾时写给下一个接手者；工程细节以 `docs/HANDOFF.md` 为准，功能决策历史以 `docs/PLAN.md` 为准。*
