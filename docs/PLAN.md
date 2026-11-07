# PicNest 图巢 — 项目计划与规格

GPL-3.0 fork of PicRand 2.77.0 · 直链索引（不复制文件）+ Eagle 式文件夹树 · UI 设计语言参考 Wenku8_Flutter（奶玻璃/编辑排印/精致动效）

## 目录

```
PicNest/
  app/              fork 运行时（PicNest.exe；数据: dev=app/_internal_data 便携, 正式=AppData/Roaming/PicNest）
  ui/               Vite+Vue3+Pinia 渲染层 → build 进 app/resources/app/dist
  tools/patches/    主进程补丁（apply.mjs 幂等，原始副本 index.js.bak）
  tools/eagle-migrate/  Eagle 库解包脚本（M7）
  docs/
```

## 启动方式

- 开发: `cd ui && npm run dev`，另开 `app/PicNest.exe`（或设 `PICNEST_DEV=1`）→ 加载 127.0.0.1:5173 热更
- 正式: 双击 `app/PicNest.exe` → 加载 dist
- 补丁重放: `node tools/patches/apply.mjs`（Steam 更新/换版本后重跑）

## 已应用补丁（P 编号，均带 PicNest 标记）

| # | 内容 |
|---|---|
| P1a | isDev 支持 `PICNEST_DEV=1` 环境变量 |
| P1b | 正式模式数据目录 → AppData/Roaming/PicNest（不碰 Steam 版数据） |
| P1c | userData 在单实例锁**之前**指向 PicNest（避免与运行中的 PicRand 抢锁静默退出） |
| P2 | 摘除 Steam 状态上报（无 DRM 门禁） |
| P3a | 窗口标题 PicNest 图巢 |
| P3b | 启动背景色跟随系统明暗 |
| P3c | dev 加载 127.0.0.1:5173（IPv4，绕 ::1/代理怪癖） |
| P6 | 手动拖窗：picnest-window-drag-start/move/end IPC（规范尺寸 + 物理网格吸附 + 手势期 resizable 冻结） |

## 三栏布局规格（对照 Eagle 截图，Feb 2026-11-07 定）

**布局基调（2026-11-07 补充，参考 ZCode 自身 UI）**：三浮岛结构——左侧栏圆角浮岛、顶栏磨砂玻璃浮条（网格从底下滚过）、右侧详情为悬浮圆角内嵌窗（同 ZCode 计划面板质感）。改动量小：现有 shell 已是浮岛骨架，M2/M3 落地时按此调即可。

### 顶栏（网格上方）——奶玻璃浮条，网格从底下滚过
返回/前进 ←→ · 视图标题（如「随机模式」）· 缩放滑条 −●＋ · 刷新 · 筛选开关 · 视图选项 · 搜索框
窗控（无边框自绘）：置顶图钉 · 最小化 · 最大化 · 关闭
**视图选项弹出板**（对照 Eagle）：布局方式（瀑布流/自适应/网格/列表）· 缩略图大小 · 排列方式（可按文件夹覆盖全局）· 开关组：显示名称/简介/扩展名/扩展名标签/注释数/子文件夹内容/侧栏/检查器 · 刷新

### 左侧栏
- 四入口：全部 / 最近使用 / 随机模式 / 回收站（各带计数）
- 文件夹树（物理目录派生）：懒展开、递归计数、颜色标记、文件夹记忆
- 底部：筛选面板（类型/评分/尺寸/分辨率；颜色 v0.2）
- **实色面板（不磨砂）**：侧栏/详情面板下方无内容滚过，磨砂无意义；玻璃只给顶栏（Feb 定）

### 中央网格
四种布局（对照 Eagle：瀑布流/自适应/网格/列表，M2 先做网格+自适应，其余随后）· 虚拟滚动 · 缩略图懒加载（sharp 400px）· 单元格**默认悬停才显文件名/分辨率**（视图选项可关，Feb 定）· 选中高亮 · 双击灯箱

### 右侧详情面板（Inspector）——**分区可折叠**（Feb 定）
- 顶部：格式徽标(PNG) + 大预览图
- 色板行（9 色，接 PicRand compute-color-analysis）
- 文件名（可改名）· 注释框 · URL 字段（带复制）
- 标签区（v0.1 只读，编辑 v0.2）· 所属文件夹
- 基本信息：评分★、尺寸、文件大小、格式、添加/创建/修改日期
- 导出按钮（复制/另存到…）

### 数据模型
物理文件夹 = 真源，层级从 images.file_path 派生；注释/URL/评分/标签/使用时间存本库 SQLite（images 追加 last_opened_at；注释/URL v0.1 即有列位）。删除 = trash → Windows 回收站。

## 里程碑

- [x] M0 fork+补丁+脚手架（双模式启动 ✓ HMR ✓）
- [ ] M1 层级数据：get-dir-tree IPC + DirTree 侧栏（验收：Desktop\好图 6,671 计数一致）
- [ ] M2 网格+顶栏+窗控（万级不掉帧）
- [ ] M3 灯箱+右键菜单+右侧详情面板+删除→回收站
- [ ] M4 四视图+搜索
- [ ] M5 筛选+文件夹记忆+设置+明暗主题
- [ ] M6 采集：localhost:41595 Eagle 兼容端点（复用 Eagle for Edge 扩展）
- [ ] M7 Eagle 库迁移（先只读预演 11,363 条）

## 踩坑记录

1. Steam PicRand 运行中时 fork 静默退出 = 单实例锁按 userData 判定 → P1c 在拿锁前 setPath
2. Vite 默认绑 ::1，Chromium 报 ERR_CONNECTION_REFUSED → server.host 127.0.0.1 + 主进程 P3c 写死 IPv4
3. loadFile(file://) 下 Vite base 必须 './'，否则 /assets 指向盘符根白屏
4. npm allow-scripts 拦 esbuild postinstall → 平台二进制经 optionalDependencies 已就位，构建不受影响
5. 截图验证用 PowerShell PrintWindow(PW_RENDERFULLCONTENT)，不抢前台；对 GPU 合成窗口偶有旧帧竞态
6. 关窗协议：主进程 confirm-close ↔ 渲染层 respondCloseConfirm(true)，新前端必须应答否则关不掉
7. python heredoc 写 JS 反斜杠字面量被转义链吃掉——修复用 chr(92)*2 构造 + esbuild 仲裁（node --check 不管 ESM）；更稳妥：整块 JS 一律 Write 工具直写
8. 运行时调试标配：PicNest 以 --remote-debugging-port=9222 启动，tools/cdp-eval.mjs 可在渲染层里查 Pinia 状态/模拟动作/端到端验证（store 经 $pinia._s.get('library')）
9. PicRand 的 watcher 只在 add-folder 流程启动，应用重启后不恢复 → 必须在渲染层 init 里对所有根重新 startWatcher + 后台 sync-folder-snapshot（外部变动才可见）
10. 渲染层快速迭代期间，编译错误浮层会卡死整个页面（所有点击无效）——用户报「功能无效」时先查是否处于编译错误窗口期
11. **-webkit-app-region: drag 四种结构全灭**（2026-11-08）：①drag+backdrop-filter 同体 ②pointer-events:none 兄弟层 ③干净拖拽面+控件亲儿子 no-drag ④部分 setBounds——物理鼠标下 no-drag 全部失效（浏览器进程拖拽位图无视 no-drag，CDP 注入检测不出=假阳性）。→ 已弃用 app-region，改 winDrag.js 手动拖窗（mousedown + screenX/Y 增量 + IPC setBounds）
12. **Win 非 100% DPI 拖窗三连坑**：a) 位置一变系统强制重算尺寸（±2px 非幂等）→ 尺寸一变 Web 内容整帧重排=抖动 → 手势期 setResizable(false) 冻结；b) 尺寸断言与补偿逐帧打架 → 主进程持「规范尺寸」+resize 防抖回读时 ≤4px 抖动丢弃（棘轮断根）；c) DIP×1.25 非整（901→1126.25）永动舍入 → 尺寸/位置吸附物理网格。验证看 clientWidth（40/40 恒定）而非 outerWidth（报告噪声）
13. **dev 数据目录 CWD 相对**（踩坑 #10 的完全体）：PowerShell Start-Process 不固定工作目录 → 进程在错误位置新建空 _internal_data →「库空了」。重启必须 `-WorkingDirectory '...\PicNest\app'`；已清两处垃圾目录
14. **「已完成」≠「接线」**：ensurePalettes 曾全工程零调用（颜色筛选恒空）；循环终止依赖 processed 字段在 DB 全量时恒 0 → 只回填一批（40/6673）。凡是「后台渐进构建」必须有：init 挂载点 + 不依赖单一返回键的终止条件 + 失败位标空防死循环
15. **Eagle 真源挖掘法**：resources/ 下 i18n/CSS 是散的，主渲染层在 app.asar（头 16 字节 → jsonLen@12 → JSON 树 → data@8+headerSize），filter 指令模板在 app/js/directives/filter-item-*.html（含色板真值 12 色）；色板匹配有两套——主进程 isMatchColorRule（33% 门槛+±96 拒绝）与搜索窗 $scope.colorFilter（25% 门槛+白底特例），用户体感是后者。tools/asar_probe.py、asar_extract.py 可复用
