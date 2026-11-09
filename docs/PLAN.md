# PicNest 图巢 — 项目计划与规格

GPL-3.0 fork of PicRand 2.77.0 · 直链索引（不复制文件）+ Eagle 式文件夹树 · UI 设计语言参考 Wenku8_Flutter（奶玻璃/编辑排印/精致动效）

**开源合规**：动效规格（入场波 520ms/墨水渐入/过冲曲线/玻璃分段钮）移植自 [Wenku8_Flutter](https://github.com/mikufoxxx/Wenku8_Flutter)（GPL-2.0-or-later © MewX / mikufoxxx），本项目按 GPL-3.0 继续授权并保留此声明。

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
- [x] M1 层级数据：get-dir-tree IPC + DirTree 侧栏（根/文件夹计数一致）
- [x] M2 网格+顶栏+窗控（万级滚动/四种布局）
- [x] M3 灯箱+右键菜单+右侧详情面板+删除→回收站
- [x] M4 四视图+搜索
- [x] M5 筛选+文件夹记忆+设置+明暗主题（六套主题）
- [x] M6 采集：自研 MV3 扩展 + 127.0.0.1:41600 本地服务（Eagle 兼容层暂缓）
- [x] M7 Eagle 库迁移（2026-11-09 本库 11,365 条已迁移；脚本 `tools/eagle-migrate/` + 根文件 ⌂ 应用内导入向导）

## 踩坑记录

1. Steam PicRand 运行中时 fork 静默退出 = 单实例锁按 userData 判定 → P1c 在拿锁前 setPath
2. Vite 默认绑 ::1，Chromium 报 ERR_CONNECTION_REFUSED → server.host 127.0.0.1 + 主进程 P3c 写死 IPv4
3. loadFile(file://) 下 Vite base 必须 './'，否则 /assets 指向盘符根白屏
4. npm allow-scripts 拦 esbuild postinstall → 平台二进制经 optionalDependencies 已就位，构建不受影响
5. 截图验证用 PowerShell PrintWindow(PW_RENDERFULLCONTENT)，不抢前台；对 GPU 合成窗口偶有旧帧竞态
6. 关窗协议：主进程 confirm-close ↔ 渲染层 respondCloseConfirm(true)，新前端必须应答否则关不掉
7. python heredoc 写 JS 反斜杠字面量被转义链吃掉——修复用 chr(92)*2 构造 + esbuild 仲裁（node --check 不管 ESM）；更稳妥：整块 JS 一律 Write 工具直写
8. 运行时调试标配：PicNest 以 --remote-debugging-port=9222 启动，tools/cdp-eval.mjs 可在渲染层里查 Pinia 状态/模拟动作/端到端验证（支持 @文件 免转义；动画验证用 cdp-active-eval.mjs 且窗口勿最小化）（store 经 $pinia._s.get('library')）
9. PicRand 的 watcher 只在 add-folder 流程启动，应用重启后不恢复 → 必须在渲染层 init 里对所有根重新 startWatcher + 后台 sync-folder-snapshot（外部变动才可见）
10. 渲染层快速迭代期间，编译错误浮层会卡死整个页面（所有点击无效）——用户报「功能无效」时先查是否处于编译错误窗口期
11. **-webkit-app-region: drag 四种结构全灭**（2026-11-08）：①drag+backdrop-filter 同体 ②pointer-events:none 兄弟层 ③干净拖拽面+控件亲儿子 no-drag ④部分 setBounds——物理鼠标下 no-drag 全部失效（浏览器进程拖拽位图无视 no-drag，CDP 注入检测不出=假阳性）。→ 已弃用 app-region，改 winDrag.js 手动拖窗（mousedown + screenX/Y 增量 + IPC setBounds）。**左栏「图巢 PicNest」品牌块（SideBar `.brand`）也绑定同一套 `startWindowDrag`/`onBarDblclick`**（左右空白条整行可拖、双击最大化；h1/span 不在 `isInteractive` 内，不会被拦），并加 `user-select:none` 防拖选字。
12. **Win 非 100% DPI 拖窗三连坑**：a) 位置一变系统强制重算尺寸（±2px 非幂等）→ 尺寸一变 Web 内容整帧重排=抖动 → 手势期 setResizable(false) 冻结；b) 尺寸断言与补偿逐帧打架 → 主进程持「规范尺寸」+resize 防抖回读时 ≤4px 抖动丢弃（棘轮断根）；c) DIP×1.25 非整（901→1126.25）永动舍入 → 尺寸/位置吸附物理网格。验证看 clientWidth（40/40 恒定）而非 outerWidth（报告噪声）
13. **dev 数据目录 CWD 相对**（踩坑 #10 的完全体）：PowerShell Start-Process 不固定工作目录 → 进程在错误位置新建空 _internal_data →「库空了」。重启必须 `-WorkingDirectory '...\PicNest\app'`；已清两处垃圾目录
14. **「已完成」≠「接线」**：ensurePalettes 曾全工程零调用（颜色筛选恒空）；循环终止依赖 processed 字段在 DB 全量时恒 0 → 只回填一批（40/6673）。凡是「后台渐进构建」必须有：init 挂载点 + **loadImages 挂载点（切文件夹/根/视图后补建，否则内存索引只覆盖启动时的文件夹、颜色筛选恒 0）** + 不依赖单一返回键的终止条件 + 失败位标空防死循环。详情现算的色板也要回写 `lib.palettes`（否则「点自身色板必保原图」查不到自己）
15. **Eagle 真源挖掘法**：resources/ 下 i18n/CSS 是散的，主渲染层在 app.asar（头 16 字节 → jsonLen@12 → JSON 树 → data@8+headerSize），filter 指令模板在 app/js/directives/filter-item-*.html（含色板真值 12 色）；色板匹配有两套——主进程 isMatchColorRule（33% 门槛+±96 拒绝）与搜索窗 $scope.colorFilter（25% 门槛+白底特例），用户体感是后者。tools/asar_probe.py、asar_extract.py 可复用

16. **SQLite LIKE + ESCAPE 陷阱**：ESCAPE '' 生效时模式内裸反斜杠非法 → Windows 路径拼 LIKE 必须连分隔符一起 picnestLikeEscape（未分类视图曾因裸 sep 全体失配）
17. **Vue 模板作用域没有 window/innerWidth**（两次踩中）：模板表达式里引用会变 undefined → NaNpx。一律在 computed 里取 window 尺寸再绑定
18. **setup 内 TDZ 三连**：watch/computed 的 getter 注册即求值——引用晚声明的 const/let 直接 ReferenceError 白屏（ImageGrid 滑尺块曾三次踩中：lib、scrollTop、totalH）。新块一律放在全部依赖声明之后；大文件搬运禁用 find('}') 式锚点（会切进函数体内）

19. **窗口最小化 → rAF 冻结 → 所有动画验证失效**（2026-11-08 踩）：Chromium 对不可见/最小化窗口停 rAF（实测 600ms 仅 1 帧）且把 setTimeout 节流到 500-1000ms。
    现象：CDP 采样全是同一状态，误判"动效坏了/随机动又有"。**验证动画前必须先确认窗口非最小化**：
    `IsIconic` 查状态 → `ShowWindow(h, 9)` 还原 → 测 rAF 帧率（应 >50 帧/600ms）→ 再采样。
    工具：`tools/cdp-active-eval.mjs`（@文件表达式 + Page.setWebLifecycleState + Emulation.setFocusEmulationEnabled）。
    **生产构建无 `__vueParentComponent`**（dev 专属）——生产验证只能用 DOM 属性采样，不能读内部 ref。

20. **生产模式 dist 陈旧 = 改完看不到效果**：双击模式加载 `app/resources/app/dist`，每次改完必须 `cd ui && npm run build` 再 reload；
    改代码后只 reload 不 build，跑的还是旧 JS（本轮 random motion "复活" 假象的真因之一：源码已修但 dist 未重建）。
    验收流程固定为：改源码 → build → reload → 采样验证。

21. **查重必须按资料库（folder_id）**：`picnest-import-check` 曾只按 size 全表查 MD5，`folderId` 参数是装饰品 →
    往 B 库拖图会弹 A 库的重复卡。多资料库语义下各库互相独立，查询必须带 `AND i.folder_id = ?`。
    同批修复：`import-check` 把目录从 clean 分流到 `dirs`（文件夹走整包复制，不再误登记成新资料库）。
22. **外部拖入文件夹 = 复制为子文件夹**（不是登记新库）：保留内部结构、同名合并、同名同大小跳过、空目录不落盘；
    拖到资料库行/空白才进对应库根。落点语义（树行/缝隙/主展示区）见 HANDOFF 第三节。
23. **Vue Transition 在隐藏/最小化窗口会卡死**：transitionend 不触发 → 元素永久留在 DOM（opacity 0 仍可命中点击）。
    结果卡已改为 **CSS 入场动画 + `v-if` 立即卸载**；验证任何动效前先还原并前置窗口（最后台被遮挡也可能 `visibilityState=hidden`，#19）。
24. **文件系统目录移动必须同步 DB 路径前缀**：`picnest-move-dir` 曾只 `fs.renameSync` 不更新 `images.file_path`，
    而目录树是从 DB 派生的 → 旧位置仍显示 N 张、新位置 0 张（磁盘实际已搬完）。现在 rename 后按
    `LIKE 转义前缀` 批量 UPDATE 整棵子树的 file_path/file_name；重命名走全量 sync 兜底。凡是物理移动目录都要查这条。
25. **images 表没有 added_at 列**（只有 folders 有）：文件夹详情的「添加日期」取物理目录 `fs.statSync().birthtimeMs`；
    文件夹统计（`picnest-dir-stats`）用 rel 前缀 `LIKE ... OR ...` 一次查询取并集——父子文件夹同时选中不会重复计数。
26. **多选文件夹合并视图**：`selectedDirs.length > 1` → `selectionView`，`loadImages` 优先走 `imagesInDirs`
    （逐目录递归取图 → `file_path` 去重 → 全局排序）；`loadImages` 加 `_loadGen` 代际，快速切换/连续加选时丢弃过期结果。
    整组拖拽用 JSON 数组键 `x-picnest-dirs` / `x-picnest-files`（drop 端优先数组，单值键保兼容）；根行 `rel=""` 禁用 draggable，
    父子同时选中拖拽只搬父级（子项随父走，重复搬会源不存在）。
27. **IPC 新增参数必须三处同步**：main handler / `apply.mjs` preload bridge / `api.js`。`imagesByDir` 加 `recursive`
    时漏了 preload 转发，主进程永远收到 undefined → 「显示子文件夹内容」开关无效（表现为 321 张不变）。
    排查技巧：先看 `window.picrand.<方法>.length`（形参个数）是否包含新参数。
28. **子文件夹卡片条与布局**：`contentTop = HEADER_H + stripH + 10` 必须参与 grid/justified/masonry 三种布局的起始 Y；
    无图片时 `totalH` 也要给 header+strip 高度（否则 canvas 高度 0 裁掉卡片条）。`ImageGrid` 是 fragment 根
    （canvas + viewport），App 传入的 `.insp-open` class 无法继承；**详情让位已改为 `.browse` 上的 `--insp-reserve`（见 item 44），
    卡片条不要再手动 `right:312px`**（那会与 viewport padding 二次扣宽，只剩 2 列）。
29. **Pinia/Vue 响应式数组不能直接过 IPC**：把 store 里的 `clipboard.paths` 原样传给 `ipcRenderer.invoke`
    会抛 `An object could not be cloned`（structured clone 不支持 Proxy）。复制粘贴的图片分支需传 `[...clip.paths]`；
    规则：所有 IPC 参数先转普通值（展开/`slice`），删除/移动等路径字符串数组同样注意。
30. **文件夹放入的合并与查重**：同名目标文件夹 → 合并（不再 `名字 (n)`）；同名同大小必须按 MD5 判定——
    同内容跳过、不同内容加序号（只看大小会在合并自身时误编号）。`picnest-dir-dup-check` 按 size 筛候选再 MD5，
    且要排除**自身路径**与**目标同名位置**（`destRoot/相对路径`）：目标同位已有同内容 = 天然合并，不应弹重复提示。
    三策略 skip / keep-both / replace；replace 在复制成功后把旧文件 `shell.trashItem` + 删 DB 行。
    外部拖入文件夹与内部分支粘贴共用 store.mergeDirWithDupes。
31. **文件夹回收站（软删）**：文件夹删除不丢 Windows 回收站，而是整包移到 `AppData/PicNest/picnest-trash/<rootId>/<id>-<name>`，
    `picnest_trash_folders` 记原 abs_path/rel，图片行 file_path 改到回收区并标 `deleted_at + trash_group`。
    **sync/scan 的 diff 必须跳过 `deleted_at` 非空行**（P8a-P8d 已修）——回收区路径不在 root 扫描结果里，
    否则整行被当 removed 删除，还原时丢图（本轮实测踩中）。还原移回原路径（重名 `(2)`）并恢复行路径/标记；
    彻底删除才 `shell.trashItem`。回收站列表过滤 `trash_group IS NULL`；`counts.trash` = 独立软删图片 + 文件夹条目数。
    回收站图片多选批量还原/彻底删除只在右键菜单：还原逐张 `picnest-trash-restore` 不弹确认；彻底删除先 askConfirm
    （数量 + 前 5 文件名）再逐张 `picnest-trash-purge`；属于文件夹回收组的行 purge 返回 false，仍走文件夹卡片按钮。
    批量后选中集整批 filter 收缩（与 trashImages 一致）。
32. **图片手动排序**：`images.sort_order`（0 = 未排序）；manual 排序 SQL `(sort_order = 0) DESC, sort_order ASC, id DESC`，
    **新录入/移入的 0 值排最前**（id 新的在前）。拖动排序 IPC 写 1..n 并自动切 manual；移动图片时 `sort_order = 0`。
    **画布级拖动**：按光标最近图片中心算目标与 before/after（光标在目标左半=前、右半=后），画布任意缝隙都能命中；
    插入线用画布绝对坐标绘制（会随滚动），不依赖落点在单元格上。**全部视图也允许拖动排序**：非 manual 时强制 added，
    manual 时按 sort_order 显示并可拖。**canReorder 必须要求 sortMode==='manual'**：其他排序模式下拖动换位直接拒绝，
    不画插入线、不写 sort_order，只提示切换手动排序——否则会按临时画面顺序重建 sort_order，覆盖已有手动排序。
    多选组拖动载荷 `x-picnest-files`；外部拖入不拦截，继续冒泡给 shell 录入当前目录。
    点正文空白 = 清图选 + 选中当前文件夹（库根→资料库根）；侧栏空白不接收内部图片（防误落未分类）。
33. **树联动与增量更新**：`openDir(rel)` 调 `revealDir` 展开祖先（**库根被收起时也要展开**）。`DirTreeItem` 必须
    watch `dirMemory.expanded` 同步本地 `expanded` ref——只 watch `props.node` 时，补丁展开了 memory 但树行不展开。
    SideBar watch `currentDirRel` 后 `scrollIntoView` 选中行（等 160ms 让祖先行渲染完）。
    拖动排序/移动图片**不要整表 `loadImages`**：排序写库后直接重排 `this.images`（对象与选中保留，不重放入场波）；
    `moveImages` 过滤本地数组 + `refreshTree` 计数即可。内部操作设 `suppressSyncUntil`（默认 2-5s）屏蔽
    watcher 的 `add/unlink → 600ms 全量刷新`；`suppressWaveUntil` 抑制 sortMode/images.length 变化触发的入场波。
34. **子文件夹卡片条换行 + 全部视图开关**：`.sf-row` 用 `flex-wrap`，卡片固定 168×136；`sfColumns` 由
    `viewW - (inspector?312:4) - 28` 算出，`stripH = 30 + rows*(136+14) + 4` 参与 `contentTop`。全部视图卡片条也显示
    「显示子文件夹内容」开关：关 = `recursive=false` 且 `dirRel=""`，**directOnly 判断不能依赖 dirRel 真值**
    （空 rel 也要排除更深层，否则会返回全库）。图片拖到侧栏「回收站」入口 = `picnestRemove` 软删 + 本地过滤。
    主面板整圈 `drop-main` 虚线已移除（无实际作用，只剩卡片/树行/浮签反馈）。
    卡片交互：**单击只 `selectDir`（右侧详情看文件夹），双击才 `openDir`**；Shift/Alt 仍多选，带修饰键的双击不进入（防误入）。正文卡片传 `preview:false`：多选只更新选中/详情，不触发 selectionView、不切中央网格；树内多选仍走合并视图。
35. **浏览历史 / 面包屑**：store 里 `navHistory/navIndex`，位置 = `{rootId, view, rel}`；`openDir/switchView/switchRoot`
    末尾 `recordNav`（`opts.record===false` 时跳过，供 goBack/goForward 用）；新导航截断前进栈，上限 100。
    `goBack/goForward` 改 navIndex 后走 `applyNav`：跨库先 `switchRoot`（不记录）再 openDir/switchView。面包屑用
    `crumbs` 计算（全部 + 当前 rel 的每级前缀；特殊视图为 全部 + 视图名），非当前项用 `.crumb-link` 按钮点击
    `openDir(rel)` / `switchView(view)`。按钮在 drag-surface 内，`isInteractive` 已排除 button，不触发拖窗。
36. **框选 / 全选 / 批量软删**：框选挂在 `.canvas` 的 `@pointerdown.self`（只有空白背景起手，格子/卡片/头块不拦截），
    4px 阈值后才算拖拽；命中测试用 `items` 的画布绝对坐标（含虚拟滚动外的项），实时写 `setImageSelection(paths, {add, base})`。
    拖拽中贴视口上下缘 34px 时 rAF 持续自动滚动（按住不动也滚），每次滚动按 canvas rect 重算选区。
    **松手后 320ms 内的 click 必须抑制**（`mqSuppressClickUntil`），否则「点空白=选中当前文件夹」会立刻覆盖框选结果。
    Shift 加选以按下时的选中集为 base；Ctrl+A 走 `filteredImages`（选中筛选后可见全部），输入框/灯箱/右键菜单内不拦截。
    Esc 分层退出：输入框 → 灯箱（含裁剪）→ 确认卡（取消）→ 重复三选一（不自动选）→ 右键菜单 → 筛选栏 → 最后才 `clearSelections()`
    （合并视图退出时回原浏览文件夹）。TitleBar 的 Esc 关布局/筛选弹板时要 `preventDefault()`，App 顶层以 `defaultPrevented` 让行。
    批量软删入口只放右键菜单（Feb 定：删除不给独立按钮防误触）：多选时文案「丢到回收站（N 张）」，先弹确认卡
    （数量 + 前 5 个文件名）再走 `trashImages`；`trashImages` 的选中收缩改为整批 filter（逐项 prune 在 Ctrl+A 后是 O(n·m)）。
37. **文本类 / 视频（2026-11-09，Feb 定：文本收、代码不收）**：文本白名单
    `.txt .md .markdown .log .json .jsonc .csv .tsv .ini .cfg .conf .yaml .yml`；渲染层 `ui/src/lib/fileKinds.js`
    与主进程 `PICNEST_TEXT_EXTS` 必须同步。**index.js 里有三份同形扫描模板（oversize / scan / stats）**，
    `String.replace` 只替第一份——P9a 曾只打到 oversize，真正入库的 scan 没变（表现为文本怎么都扫不进来）；
    P9d/P9e 分别补 scan 与 stats。watcher 模板另在 P9b（单份）。扫描 worker 每次启动由模板重写，改模板后才重启才生效。
    文本缩略图：主进程读前 64KB → 前 26 行 → **800×1040** 纸面 SVG（sharp/librsvg 可渲染中文）→ `cache/md5(path)-v2.webp`；
    Feb 反馈 400px 版在大格子下糊 → 改 2 倍渲染并把正文字号压到 19px（相对 400 版的 9.5px），更密更小；
    DB 同步 `thumbnail_path + width/height=800/1040`（仅供排版）；旧版 400px 图启动时由 `picnestMigrateTextThumbs` 幂等清理。
    保存后主进程删缓存并清 DB 缩略图，渲染层立刻重画；
    网格文本缩略图 URL 追加 `?v=modify_time` 突破 file:// 图片缓存（实测带 query 可加载）。
    `picnest-read-text` 编码检测：UTF-8 BOM → UTF-16LE BOM → 严格 UTF-8 试解（只探前 64KB，避免截断末尾误判）→
    GB18030 兜底；返回 `{content, encoding, eol, size, mtimeMs, truncated}`。>2MB 截断只读（禁止保存，防截断写回毁文件）。
    `picnest-save-text` 原子写（`.picnest-tmp` + rename）**始终 UTF-8**（Node 无 GBK 编码器，GBK 原文保存即转码，
    工具栏提示「保存将转为 UTF-8」）；保留原换行 CRLF/LF；`expectedMtimeMs` 差 >1.5s 判 conflict，UI 提示再按 Ctrl+S 覆盖。
    编辑器：1.5s 防抖自动保存 + Ctrl+S；关闭/翻页/卸载前 `flushTextSave(true)` 强写；Esc 在输入框内只失焦。
    **文本编辑层 `.text-stage` z-index 必须低于标题栏（20）**：同为 20 时文本层后绘制，0.92 不透明的面板底会把左上角
    「← 退出」糊在下面（现象：Text 模式看不到/点不到退出按钮）；现设 10，Inspector（12/15）仍在编辑层之上。
    同时 `padding-top` 必须让过 **42px 标题栏 + 20px 玻璃拖尾**（现 76px），否则工具栏顶部 8px 会被拖尾压住，
    看起来像「编辑器被挡住一半」。
    视频：`<video>` 关闭原生 controls，自绘玻璃 dock（播放/进度拖拽/时间/静音/音量/循环/全屏/前后翻页），进入自动播放，
    空格播放暂停；`loadedmetadata` 取 videoWidth/Height 回填 store 并 fit；裁切/旋转/翻转/1:1 对视频隐藏；
    `url` 来自 `lib.images`（用不在当前列表的路径 openLightbox 会拿不到 src，探针踩过）。
38. **视觉分层（2026-11-09，Feb 要求"白窗体悬浮于左栏、详情悬浮于正文"）**：新增 token `--shadow-float`
    （近影 + 主影 + 大范围柔光）与 `--panel-edge`（顶缘 1px 高光）；**底座必须比白窗深一档**（`--bg:#eee7da`、
    `--panel-strong:0.95`），否则缝隙和投影都看不见，浮岛感立不住（Feb 反馈"不明显"后加强）。
    主面板 `margin: 上/右 8px、下 22px、左 20px` + `inset 0 1px 0 --panel-edge`，靠留白和投影压在左栏之上（2026-11-09 先加码到 22、再按 Feb 要求收紧上/右让窗控按钮贴角；滑尺 right/top/height 同步 6/70/calc(100vh-100px)）；
    详情浮岛 right/bottom 10（与主面板内缘对齐）、top 40（压进顶栏 2px、窗控按钮下缘 39 之下），
    层级 `玻璃 20 < 详情 24 < 栏内容/窗控 26`（`.titlebar` 去掉 z-index 上下文，`.glass`/`::after` z20、`.bar-content` z26）；
    底色为竖向玻璃渐变（top .97 → mid .93@46% → low .86@74% → bot .60）
    并加 `backdrop-filter: blur(22px)`——**0.85 半透明在文字密集页面会透底**，看起来像浮不起来；纯色实白又会失去玻璃感。
    渐变必须「上实下透」（Feb 指定仿顶栏玻璃，方向相反），底部 0.60 是阅读性下限，再透按钮文字会掉对比。圆角维持主面板 6 / 浮岛 14（既有定稿，勿顺手改）。
    **浮岛只属于浏览网格**：灯箱 `.stage`（图片/视频）与简报 `.brief img/video` 一律无投影、无圆角（Feb 2026-11-09：「图片进入简报和灯箱模式就不要有浮岛感」）。
    改定位时注意 `.insp-overlay` / `.browse` 两处 Inspector 与 resize-handle 的 bottom 要一起改（8→10）。
    **详情拖拽柄移位（Feb 指定）**：原先手柄在窗口右缘、方向反直觉；现在绝对定位骑在浮岛**左缘**
    （`right: calc(var(--insp-w) + 6px)`、top 40 / bottom 10、宽 8、z-index 25），`invert` 保留（向左拖=加宽）。
    `--insp-w` 必须同时设在 `.browse` / `.insp-overlay` 容器上，否则手柄算不出左缘位置。
    **高度/自由变换（Feb 指定，支点=详情右下角）**：`InspResize.vue` 渲染三个透明柄——左缘（宽）、顶边（高）、
    左上角（宽高同时变）；右下角由 `right:10 / bottom:10` 固定不动，所以高度增加表现为顶边上移。
    `lib.inspectorHeight` 0=自适应满高（默认），>0 固定高度并存 localStorage；固定时 `.insp-h-fixed .inspector`
    改为 `top:auto; height:var(--insp-h)`，顶边柄 `bottom:calc(10px + var(--insp-h) - 4px)`、角柄 `-8px`。
    判断尺寸上限要用拖拽起点时容器的 `rect.height - 50`（40 顶 + 10 底），拖到满高就回写 0 保持窗口自适应；
    双击顶边/角柄恢复满高。三个柄的 `pointer-events:auto` 必须显式写（`.insp-overlay` 整层是 none）。
39. **大图适配安全区（2026-11-09，Feb 报「顶部进入玻璃顶栏」）**：`fitToWindow` 的 `availH` 从 `rect.height - 110`
    改为上下各 70 → `rect.height - 140`。原因：flex 居中会把总留白对半分，旧值只给上下各 55px，而玻璃顶栏 42+拖尾 20=62、
    dock 46+底距 16=62，导致顶边钻拖尾 7px、底边压 dock 7px（帧实测 img top 68 < trailerBottom 75）。
    改后实测 img top 83 > 75、img bottom 1015 < dockTop 1023，各留 8px 呼吸。若日后改标题栏高度/拖尾/dock 尺寸，必须重算这 70。
40. **大图顶栏/底部工具条完全透明（2026-11-09，Feb 指定）**：`.titlebar` 加 `lb-clear` 类（`lib.lightbox.open` 时），
    `.glass` 背景置透明并去掉 `backdrop-filter`，`::after` 拖尾 `display:none`；底部 dock 加 `dock-clear` 类，
    关闭玻璃底/边框/阴影/模糊（裁剪条 crop-bar 仍是玻璃底）。浏览模式不受影响。
    注意大图「适应」仍按 70px 上留白算（顶栏变透明但控件仍占 42px 高），dock 也仍占 46+16，不要误以为可以去掉安全区。
41. **优化批次（2026-11-09）**：
    ①**详情让位**：`.insp-open` 类必须放在 `.browse` 容器上（ImageGrid 是 fragment 根，App 传 class 会被丢，之前规则一直没生效）；
    `.browse.insp-open { --insp-reserve: calc(var(--insp-w) + 16px) }`，ImageGrid `.grid-viewport` 的 `padding-right` 消费它；
    子文件夹卡片条 right 用 `inspectorWidth + 20`。实测内容右缘 1029 < 浮岛左缘 1041。
    ②**verify_counts.py 多库**：逐库报 active/原地软删/回收区/文件系统 + 顶层目录 diff；**旧脚本 `rel == '.'` 直接 continue，
    根目录直属文件从来没被统计**（素材库 42 张全在根层 → 误报 12），现在 root_files 单独计入。
    ③**文本缩略图外部修改失效**：在 `picnest-images-by-dir` 行富化时比 `stat(源).mtimeMs > stat(缩略图).mtimeMs + 1500`，
    命中就删缓存文件并清 DB thumbnail_path（容差避开保存后重画的竞态）；文本不再走 `discoverThumbnailPath`（避免复活 v1 残留）。
    ④**目录排序键隔离**：key 改为 `${folderId}|${rel || "__root__"}`；picnest-dir-tree / dir-order-set / dir-sort /
    dir-sort-recursive / rename 全部改用它；rename/sort 通过 `picnestRootIdByPath(absPath)` 反查库 id。
    启动时 `picnestMigrateDirOrderKeys` 把旧全局键复制到每个库的新键（旧键保留可回滚）。
    **preload 的 `picnestDirOrderSet(folderId, parentKey, names)` 多了首参**，store 4 处调用要同步传 `activeRootId`。
42. **重复文件查找（2026-11-09，Feb 指定）**：入口=文件夹右键「查找重复…」（子树）/ 资料库右键（全库）；
    资料库根在文件夹树里没有右键菜单，所以全库入口必须挂在资料库行。
    扫描：`folder_id` 精确限定（不跨库）→ 取 active 行 → `stat` 实际 size → **按 size 分桶，只有同尺寸才读盘** →
    流式 MD5（`createReadStream`，并发 4）→ `size:md5` 分组，≥2 成组。进度用 `event.sender.send("picnest-dup-progress")`
    （preload `onPicnestDupProgress`，store init 注册一次）；6.7k 文件实测 258ms（27 个候选）。
    **同内容文件必然同 size，所以快捷钮没有「保留最大」，用「保留第一/最新/最旧」**；默认一个都不勾，删前 confirm。
    删除只走 `trashImages`（图巢回收站软删）；删完在本地重算 groups（<2 丢弃）与 stats，不重新扫盘。
    面板 `DupFinder.vue`：z-index 940（confirm 950 在其上），Esc 在 App 里优先关闭；每个文件卡必须显示 `rel || '库根'`。
    **取消（2026-11-09 补）**：`picnest-dup-cancel` IPC + store `dupCancel()`；loading 期间恒显「停止」，关面板/切页签自动取消，
    取消后 UI 显示「已停止扫描」而不是「没有发现重复文件」。流式 MD5 不阻塞主进程事件循环。
43. **点库回根 / 根文件 / 菜单瘦身 / 简报 / 黑白 / 未分类（2026-11-09，Feb 指定）**：
    ①`switchRoot(id)` 原先同 id 直接 `return`，导致“点当前库没反应”；改为同 id 时 `openDir(null, opts)` 回库根（全部视图 + dir=null）。
    ②侧栏区块名改「根文件」（仅 SideBar 标题/添加钮/空态；`DirContextMenu` 等仍用“资料库”，避免“复制根文件文件夹”这类怪词）。
    ③图片右键移除「重命名」（详情面板点名称才是真重命名）；「从库中移除」改「移入未分类」——
    物理移动到**库根**（`moveImages(paths, '')` → `picnestMoveImage`，重名自动 `(n)`、`sort_order=0`）并保留索引；
    已在根层的路径跳过；移动后若 `!currentDirRel`（库根/未分类/最近等）要 `loadImages()`，否则会把仍在视图里的图错误过滤掉。
    ④简报模式（Eagle 语义：asar 里 `slideshowOn` + `setFullScreen(true)`）：`BriefMode.vue` 全屏黑底 overlay，
    单击下一张、右键菜单、←→、Esc；进入调 `document.documentElement.requestFullscreen()`（页面级，不是 Electron 窗口 fullscreen）；
    监听 `fullscreenchange` 兜底关闭。视频静音循环，文本占位。导航用 `lib.images` 顺序（不是网格的 sortedImages，可能与大图顺序有差）。
    **简报缩放/平移/右键**：`brief` 状态带 `scale/tx/ty`（切图/重开都重置）；滚轮以光标为锚点缩放（0.2–8×，
    `t' = p - (s'/s)(p - t)`），拖拽 4px 阈值后才算平移，未拖动 pointerup 才算单击切图；右键呼出图片菜单。
    **灯箱/简报 A/D = 上一张/下一张**（与 ←→ 同义；输入框/裁剪态不拦截，Ctrl+A/Ctrl+D 不误触）。
    **图片右键也有「查找重复…」**（扫该图所在文件夹；库根散图=全库），入口不再只藏在文件夹/资料库菜单。
    Brief z-index 必须 **890 < ContextMenu 900**，否则菜单被全屏层盖住；删除/移入未分类等会改变路径的操作要顺手 `closeBrief()`。
    **灯箱右键**：`.viewer` 上 `@contextmenu`，输入框/dock/裁剪层保留原生；菜单操作移动/删除时关掉灯箱。
    ⑤黑白预览（Eagle 语义：asar 里 `isGrayscaleMode` checkbox，全局显示开关）：`lib.grayscaleMode` 存 localStorage；
    网格 `.thumb.gray img`、大图 `.stage.gray`、详情预览/堆叠、简报统一 `filter: grayscale(1)`；右键菜单文案前加 ✓。
    ⑥**Vite dev 假象**：往 App.vue 新增组件后 Page.reload 也可能不挂载——Vite 的 App 模板缓存没失效（脚本 import 在、组件树里没有）。
    必须重启 Vite（占 5173 的 node）+ 重启应用；排查直接 fetch `/src/App.vue` 看编译出的 render。
44. **卡片条让位 / 内部拖拽分类（2026-11-09，Feb 反馈）**：
    ①详情打开后正文让位是通过 `.grid-viewport` 的 `padding-right` 实现的，**canvas 宽度已经变窄**；
    `.subfolders` 如果还按 `inspectorWidth + 20` 设 right，等于二次扣宽，卡片只剩 2 列、右侧一片空白。
    `sfColumns` 同理不能再次扣 `--insp-reserve`（viewW 是 contentRect，padding 已排除）。修复后详情宽 289 时 strip 845 / 4 列。
    ②**内部拖拽误判**：Chromium 给 draggable 元素自动附加 `text/uri-list`，旧判断 `Files || text/uri-list` 会把内部图片
    当成外部文件走“录入”分支（浮签「录入到」、drop 不移动）。统一 `ui/src/lib/dnd.js`：先检测
    `application/x-picnest-file/files/dir/dirs`，命中即 internal，external 必须 `!internal && (Files||uri-list)`。
    App / ImageGrid / DirTreeItem / SideBar 全部落点统一使用；合成验证：内部载荷 + uri-list 拖到树行 → 正确移动、无录入提示。
    ③空白处右键当前文件夹菜单尝试过，Feb 明确不要，已撤（保留图片/文件夹卡片/文件夹行/资料库行入口）。
45. **图片拖入落点 / 未分类入口 / 文件夹封面（2026-11-09，Feb 指定）**：
    ①图片内部拖拽在树行**只认中间落点**：`DirTreeItem.onDragOver` 检测 `x-picnest-file(s)` 后直接 `dropMark='into'` 并
    `stopPropagation`，不画上/下插入线；**根行（rel=''）不 preventDefault、不接图片**，避免手滑落进未分类。
    文件夹拖拽/外部文件拖入仍保留 30% 缝隙规则。侧栏「未分类」视图入口与「回收站」同款：
    `drop-uncat` 虚线高亮 + 浮签「移入未分类」，drop 调 `moveToUncategorized`（物理移到库根，保留索引）。
    ②**文件夹封面**：`dirMemory[rel].cover / coverThumb`（config.json）；右键图片（正文/灯箱/简报共用 ContextMenu）
    →「设为文件夹封面」→ `lib.setFolderCover` 反推图片所在文件夹 rel（库根散图 rel='' 不显示该项）；
    ImageGrid 子文件夹卡片封面优先用 coverThumb/cover，watch 依赖里要带 `dirMemory[f.rel].cover` 才能即时刷新。
    ③dev 稳定性：`vite.config.js` 开 `server.watch.usePolling:true, interval:350`，否则快速连续改文件会命中 Vite 旧模板缓存。
46. **旋转/翻转写回 / 封面开关（2026-11-09，Feb 指定）**：
    ①大图图片 dock 的「保存」按钮（`hasTransform = rot%360 || flopX` 时高亮）→ `picnest-apply-transform`。
    sharp 顺序必须 **flop 后 rotate**（CSS 是 `rotate(...) scaleX(-1)`，右到左先翻后转）；90° 倍数不产生黑边。
    写前 `fs.copyFileSync` 到 `cache/transform-backup-<md5>-<ts><ext>`，再 `.picnest-transform-tmp` + rename 原子覆写；
    DB 更新 width/height/file_size/modify_time，`palettes=NULL`、`thumbnail_path=''`；删除 cache 里 `md5+ext/.webp/.jpg` 三种缩略图。
    保存后 rot/flop 复位、fitNonce++，异步重生成缩略图；如果该图是某文件夹封面，要同步更新 `coverThumb`（否则卡片用到已删缩略图）。
    **同路径覆写必须带版本号刷新**：图片/视频 URL 用 `?v=modify_time`（网格、大图、详情统一），否则 Chromium 吃旧缓存。
    ②封面菜单是**文件夹级开关**：`folderHasCover = !!dirMemory[rel].cover`；已有手动封面时任意同夹图片的菜单都显示
    「✓ 设为文件夹封面」，再按走 `clearFolderCover` 恢复自动；要换新封面需先清除再对新图设置（Feb 明确接受两次）。
    判断必须用文件夹 cover 是否存在，而不是“这张图是不是 cover”，否则菜单不会变成开关态。
47. **移出根文件（2026-11-09，Feb 指定）**：资料库行右键新增「移出根文件…」，语义=只解除图巢登记：删 `images`（整根）、
    `picnest_trash_folders`、`folders` 行与 config 的 `folderId|*` 排序键；磁盘文件夹/文件永不动，可重新添加。
    回收站非空（软删图片或回收站文件夹条目）时主进程拒绝并给出件数；活动根被移出后切 roots[0]，空则空态。
    watcher 若正监听该根必须 `stopWatching()` 并清 `_addQueue`——worker 的 add 回调会 `getOrCreateFolder` 把根复活；
    渲染层随后对新活动根 `startWatcher`。IPC：`picnest-remove-root`（picnest-handlers.js） + `picnestRemoveRoot`（apply.mjs P4b）。
    根文件菜单另有「在文件管理器中打开」：`window.picrand.openWithDefault(path)`（`shell.openPath`）打开目录本身；
    不要用 `picnestReveal`（showItemInFolder 会在父目录里选中它，语义是“显示所在位置”）。
48. **主题系统（2026-11-09，Feb 指定）**：顶栏 ☀/☾/◐ 弹板六选一（跟随系统/暖砂/靛夜/灰白/炭黑/墨黑，后三套低饱和；
    暖砂=原暖米+金浅色、靛夜=原蓝紫夜+金深色，Feb 让 AI 起名），持久化 `picnest.theme`。
    `ui/src/lib/theme.js` 把 auto **解析成 mono-light/mono-dark（灰白/墨黑）**写入 `<html data-theme>` + `style.colorScheme`，并监听系统 `prefers-color-scheme` 变化；
    `style.css` 的暗色 token 块由 `@media (prefers-color-scheme: dark)` 改为 `:root[data-theme="dark"]`，另有 `mono-light`/`mono-charcoal`/`mono-dark` 三套中性灰 token；
    `index.html` 内联脚本首屏定色防闪白（识别五种显式主题，light/mono-light → colorScheme light，其余 dark）。
    **低饱和黑白**强调色/阴影/玻璃/详情浮岛全部去饱和，默认文件夹图标走 `--folder-default`（普通金/黑白灰）；
    概览滑尺是 canvas，换主题必须 watch `theme.resolved` 重绘（否则 dash 仍是旧 accent）。
    主题弹板与布局/筛选弹板互斥，Esc/外部点击关闭；按钮在 auto 时按解析结果显示 ☀/☾，黑白主题显示 ◐，非 auto 高亮。
    顶栏漏斗/布局/主题三个 `vo-wrap` 改 flex 对齐（盒子统一 29×28）；主题按钮用 `springAt` 做旋转+缩放手势，
    挂载/hover/mousedown/换主题/`iconShake` 集体晃动都会播放。
49. **详情文件夹 chip 反推（2026-11-09，Feb 报「子夹图片被标成根文件夹」）**：根目录开「显示子文件夹内容」或合并视图时，`currentDirRel` 是视图位置，
    不能当图片所在夹；`Inspector` 新增 `relOfImage(file_path)`（相对库根反推目录，再用 leaf 名），单选 chip 与多选 `multiFolders` 共用。
50. **M6 采集（2026-11-09，Feb 指定）**：自研开源 MV3 扩展 `extension/`（右键存图/页面截图，popup 选根与文件夹，目标全局）；
    主进程本地服务 `127.0.0.1:41600`：GET ping/context/folders、POST save；只写目标根内文件（`picnestCollectTarget` 防 `..` 逃逸）；
    写入后 `insertImagesBatch` + `sync-db add`（渲染层补缩略图/尺寸），`url/annotation/star` 写 DB；目标根跟随 activeRoot（store `syncCollectRoot`）。
    安全：127.0.0.1 + Origin 白名单（扩展/localhost）+ PNA 预检；token 待补。Eagle for Edge 调研（只读）：
    41595 根 + `/api/library`、`/api/folder`、`/api/tag`、`/api/item/addFromURL`；41593 旧表单（image/save-url/screen capture/import-images）；
    Eagle 启动时占这两个端口，兼容层暂缓且不默认开启；协议信息记录，代码原创、不抄不绑 Eagle 资源。
    **网页内按住采集（content.js）**：按住 380ms（120ms 起环形进度）→ Shadow DOM 双栏面板（左「未分类/库根」大片，
    右 = 当前根全部文件夹缩进列表，原生滚动）；拖到目标松开保存，松在面板空白则停留点击；提前移动 >6px 取消，
    不影响页面自身拖拽；Esc/点外部/页面滚动关闭；只处理主 frame 的 `<img>`，popup 可关闭手势（`holdCollect`）。
    面板固定白底（不随浏览器暗色，任何主题页面都清晰）；同一份扩展可在 Chrome `chrome://extensions` 开发者模式加载
    （Chrome 137+ 禁用 `--load-extension` 命令行），只使用标准 MV3 API（contextMenus/scripting/notifications/storage/tabs）。
    **采集查重**：写入前按同根 + 同 file_size 筛候选（≤6）→ MD5；命中不落盘，返回 `duplicate` + matches；
    按住面板显示「跳过 / 覆盖旧图 / 仍然保存」：覆盖=先写新图，成功后旧匹配项 `deleted_at` 软删（图巢回收站）+ unlink，
    物理文件保留；仍然保存=`force` 保留旧图再存一份。右键/页面截图只提示跳过。历史重复不自动清理。
    **未分类图标**：移植 PicNest FolderIcon（Wenku8 `archive_icon_fold_art`，GPL-2.0-or-later）几何 + `springAt`，
    面板打开/悬停时播放一次 640ms 弹簧手势。
    **面板新建文件夹**：右栏底部「＋ 新建文件夹…」inline 输入 → `POST /api/v1/folder/create`（库根；非法字符清理、
    同名 `(n)`）→ 新夹追加列表并高亮，点击即保存；主进程发 `sync-db dirs-changed`，store 分支 `refreshTree()`。子夹下新建暂不做。
    **防盗链/覆盖层**：服务端下载外部图片带页面 Referer + 常规 Edge/Chrome UA（Pixiv `i.pximg.net` 必需）；
    按住目标先用事件路径找 IMG，失败再 `elementsFromPoint` 按坐标找底层可见 `<img>`（Pinterest 覆盖层实测）。
51. **AI 查重（2026-11-09，Feb 指定）**：DupFinder 顶部「精确查重 / AI 查重」页签；AI 分支用 OpenAI 兼容视觉 API。
    **配置**：baseUrl/model/key；key 用 `electron.safeStorage` 加密写 `dataDir/picnest-ai.json`，渲染层只拿 hasKey；
    保存后用两张 64×64 色块请求一次 chat/completions 验证视觉连通（密钥不回传渲染层）。
    **候选**：范围同精确查重；缩略图 → sharp 9×8 灰度 dHash（64-bit，两段 32-bit popcount）→ 汉明距离 ≤10 生成候选对，
    按距离排序取 maxPairs（默认 40，可调 1–200）；只处理图片后缀，跳过文本/视频。
    **AI**：候选对缩略图 384px 白底 JPEG → `/chat/completions`（system 要求只回 JSON `{same,confidence}`）→ 解析；
    429/5xx 重试一次；并查集成组；只上传候选缩略图，必须勾选允许上传；进度事件 `picnest-ai-dup-progress`（hash/ai），支持取消。
    **结果**：AI 徽标；wasted = sum − max（保留最大有意义），快捷保留最大/最新/最旧；删除仍走图巢回收站，选中/批量软删共用精确分支。

52. **查重收尾（2026-11-09，Feb 指定）**：
    ① **精确查重可取消**：主进程 `picnestDupCancel` 每轮扫描重置；`picnest-dup-cancel` IPC；store `dupCancel()` 置 `canceling`；
    DupFinder 的 loading 区不分页签都给「停止」，关面板/切页签都调用取消；取消结果 `{ok:false,canceled:true,error:"已取消"}`，
    UI 空态显示「已停止扫描」。注意取消检查必须在 `picnestMapLimit` 的回调里（每文件读盘前），否则 4 路并发会继续读完。
    ② **文件夹整包查重异步化**：`picnest-dir-dup-check` 从「同步 walk + readFileSync」改为「同步收目录（仅元数据）→
    `fs.promises.stat` + `picnestMd5Stream` 流式 MD5（并发 4）」，进度事件 `picnest-dir-dup-progress`；
    同路径 MD5 进 per-scan Map 缓存（新图与库内候选都缓存，重复候选只算一次）；`picnest-dir-dup-cancel` 可中途停止；
    items 结束后按 src 排序（并发完成顺序不稳定）。store `taskProgress` 浮条（`TaskProgress.vue`，底部居中、z870）在
    `mergeDirWithDupes` 期间显示「正在检查文件夹重复 done/total + 停止」；查重弹窗前收起浮条。取消返回 `{canceled:true}`，
    `paste()`/`importDrop()` 遇到 canceled 立即 break，汇总卡标「已取消」且 tone=muted。
    ③ **拖入查重/采集查重同样流式**：`picnest-import-check` 与 `picnestCollectDupes` 改 `picnestMd5Of`（流式 + 缓存），
    不再 `readFileSync` 整文件。`import-dir-copy` 内部的同名同大小 MD5（walk 里）仍是同步——copy 本身同步，后续单独异步化。
    ④ **AI 查重费用/上传量预估**：AI 参数区新增可选「单价 ¥/1M tok」（localStorage `picnest.aiPricePerM`），
    估算 = maxPairs×2 张 384px 缩略图（≈45KB/张）+ 每对 ≈340 tokens（2×85 视觉 + 提示/输出），显示「最多 N 对 · ≈ X 张 / Y MB
    · ≈ Z 元」；不填单价只显示上传量。AI stats 的 `capped` 在结果头部提示「候选超出上限，只查最接近的 N 对」。
    实测：120 个 2.9MB 副本目录查重 900ms、进度 12→102、取消返回 canceled；30 副本走真实 mergeDirWithDupes：
    浮条 3/30 → 30/30、弹窗 count=30、复制 30 张；cancelTask 中途停止不复制；全库 10,764 行 317ms、38 个同尺寸候选
    （内容均不同 → 0 组，Eagle 入库时已按内容去重）；import-check 3 冲突 + 1 干净 + 1 缺失正确。

53. **根内元数据 / 目录记忆按根隔离 / 主题 / 缩略图 / 物理排序（2026-11-09，Feb 指定）**：
    ① **`.picnest/meta.json` 随根文件走**：点开头目录（扫描 P9f 跳过、watcher 自带 dot 过滤、`attrib +h` 资源管理器隐藏）。导出内容 = 标签名列表 + 每图 `{rating, annotation, url, favorite, tags}` + 每个文件夹 `{color, desc, expanded, cover(相对路径)}` + `orders.dirs`（父 rel → 目录名数组）+ `orders.images`（目录 rel → 文件名数组，仅 size>1 的组）。`picnest-root-meta-export/import/ensure/save/load`：移出根前强制导出（根目录不存在则跳过，防 drive-relative 垃圾路径建目录），重新加根后导入并 toast；启动时 `ensure` 只补缺失文件；`before-quit` 兜底导出全部根。store 在标签/评分/注释/文件夹记忆/排序/移动/改名后 `scheduleRootMetaSave()` 防抖 1.2s。
    ② **目录记忆按根隔离**：config `picnestDirMemory` 键从 `rel` 改为 `${rootId}|${rel}`；`picnestMigrateDirMemoryKeys` 把旧全局键复制到每个根；渲染层只取当前根切片（rel 键，组件零改），`refreshTree` 换切片；`patchDirMemory(activeRootId, rel, patch)`；目录改名 `picnest-dir-memory-rename` 整体搬键 + 封面绝对路径；根图标色 `dirMemory['']` 不再跨库串。
    ③ **主题跨 origin 记忆**：`picnest-theme-get/set` 写 config `picnestTheme`；`theme.js` 启动后从 config 对齐（`touched` 防覆盖用户手选），首次运行把 localStorage 旧值迁到 config。解决 dev（127.0.0.1）与生产（file://）localStorage 不互通造成的“重启丢主题”假象。
    ④ **缩略图缓存目录 P10 → `dataDir/picnest-thumbs`**：避开 Windows 上同名的 Chromium `Cache`（实测生产 340MB 只剩 `Cache_Data`，缩略图全被清）。`picnestMigrateThumbCacheDir` 搬旧文件/清死路径；`imagesByDir` 发现死路径写回 DB；新增 `picnest-thumbs-missing` / `picnest-repair-thumbs(-cancel)`：统计缺失 → 用户确认 → `ensureQuickThumb`（sharp/PSD/视频）并发 2 生成 → `picnest-thumb-repair-progress` + `taskProgress` 浮条可停止。资料库右键「修复缩略图…」。实测 4 缺失 → 4 补成 / 0 剩。
    ⑤ **物理排序开关（默认关）**：资料库/文件夹右键「✓ 排序同步文件名」。开启后 `reorderImages` / `insertOrderAt` / `appendOrder` / `dropOnDirs` 在写完顺序后调 `picnest-physical-order-images|dirs`：按目录分组加 `NN_` 前缀（去掉旧前缀），两阶段临时名防互换，暂停 watcher（rename 旧路径会触发 unlink 删 DB 行），同步 DB `file_path`、缩略图缓存名（md5 新路径）、dirMemory/dirOrder 键、回收站 `abs_path`，完成后重开 watcher。关闭时只写元数据不动文件。实测临时根 3 图/2 夹：`a,b,c` → `Alpha/01_a`、`Alpha/02_b`、`Beta/01_c` → `01_Beta/01_c`、`02_Alpha/01_a`、`02_Alpha/02_b`。
    ⑥ **`verify_counts.py` 跳过点目录/文件**，否则 `.picnest/meta.json`（.json 属文本白名单）会让对账多 1。

54. **左栏开合（2026-11-09，Feb 指定）**：窗控组最左（详情按钮左边）新增 left-sidebar 按钮；`lib.sidebarCollapsed` 存 localStorage，`toggleSidebar()` 切宽并 `collectiveShake()`；SideBar `width: collapsed ? 0 : sidebarWidth` + padding/opacity 过渡，`ResizeHandle` 在收起时 v-if 隐藏；`AnimIcon name="sidebar"`（`collapsed` prop 让分隔线 CSS translateX 左移、列内两条短线淡出），与其它顶栏动效图标共用 `iconShake` 总线/挂载/悬停弹簧手势。

55. **图标动效幅度加码 + 插件仓库设计（2026-11-09，Feb 指定）**：
    ① `grid` 四格上浮 1.3 → **2.8**（首轮 1.3 被 Feb 判"幅度不够"）；`sidebar` 面板抬升 0.8→1.4、分隔线横移 0.8→2.4、列内短线 0.5→1.2、收起态 CSS 位移 -3.6px→-5.4px（过渡 0.26s）。CDP 连拍两帧确认位移肉眼可见。Feb 口径再验证：动效幅度"宜大不宜小"，第一版宁大勿小。
    ② **插件仓库**：完整设计落 `docs/PLUGIN.md`——三种插件类型（theme 纯 CSS / renderer 沙箱 iframe / main utilityProcess）、plugin.json 清单（deny-by-default 权限）、宿主 RPC 网关（快照传递、无活引用）、GitHub 仓库即 marketplace（registry.json + zip + sha256，人工 PR 收录）、四阶段路线（P1 theme+管理页 → P2 renderer → P3 main → P4 在线仓库+签名）。红线：不给插件裸 db 句柄/Node，网络只走声明 origin 的代理，主题插件只许叠 token 不许整页覆盖。

56. **灯箱详情色板 / 裁剪交互修复（2026-11-09，Feb 报）**：
    ① **灯箱色板消失**：灯箱的详情浮岛是**另一个 Inspector 实例**（`.insp-overlay` 里新挂载），`watch(() => lib.selectedPath)` 没有 `immediate` → 挂载时拿不到当前选中项，meta/色板都空。给 meta 与色板 watch 加 `{ immediate: true }`；同时 `lib.palettes[p]` 的**空数组**要当成未命中（`ensurePalettes` 用空数组标记 SKIP/失败，旧逻辑 truthy 直接 return，永远显示 —）。
    ② **裁剪模式滚轮缩放**：删掉 `onWheel` 的 `cropMode` 早退；缩放时裁剪框由既有 watcher 按图片矩形宽度比例重映射（实测 scale 0.334→0.374，crop 240.7/564.7 → 288.2/613.0 同步放大）。
    ③ **裁剪模式非选区拖拽**：`onDown` 只在「落在选区内 / 手柄上 / cropAction 已激活」时让位给裁剪层，其余保留平移；`onMove` 只在 `cropAction` 激活时跳过。实测选区外拖 26/18 → `tx/ty` 26/18、裁剪框同步位移；选区内拖 → 只改 crop.x、图片 tx 不变。`.crop-layer` 光标 grab / 选区内 move / 手柄 resize。
    ④ 坑：改 Inspector 时删掉 `const palette = ref([])`/`paletteLoading` 会直接让整个 `<aside class="inspector">` 渲染失败（Vue 捕获 ReferenceError → DOM 里连 `.inspector` 都没有），排查时先看 console.error。

57. **窗口收缩后详情浮岛溢出（2026-11-09，Feb 报）**：详情固定高度存在 localStorage（`inspectorHeight`，如最大化时设到 1137px）；窗口从大框缩小时 CSS 仍用 `--insp-h: 1137px` + `bottom:10`，浮岛向上顶出视口、顶部被窗控盖住。修法：App.vue 用 `ResizeObserver` 监听 `.browse` 高度，渲染用 `inspEffH = min(inspectorHeight, browseH - 50)` 写进 `--insp-h`（偏好值保留，窗口放大自动恢复）；`.insp-overlay` 同值。`InspResize` 起拖的 `h0` 改用当前显示高度（`insp.height`）而不是偏好值，避免钳制后拖拽跳变。实测 1400×901 → 1000×651：偏好 1137 不变，`--insp-h` 821→570，浮岛 y=48/h=570/bottom=618 不越界；恢复窗口后回到 820。

58. **手动排序新图置顶 + 图片加载失败优化（2026-11-09，Feb 问）**：
    ① **新图置顶本来就是既有语义**：`insertImage`/`insertImagesBatch` 默认 `sort_order=0`，`picnest-move-image` 显式置 0；manual SQL `(sort_order=0) DESC, sort_order ASC, id DESC`。临时根实测：手动排序后外部复制 `c.png` → watcher/sync 入库 → 列表 `c,01_b,02_a`（顶部）；多条新图按 id DESC。唯一例外：全量 `scan-folder`（新增根时）会按遍历序号写 sort_order。
    ② **网格不再直链原图**：`picnest-display-thumbs` 生成 1024px `-d1024.webp`（sharp `failOn:'none'`、并发 2、缓存名含 modify_time），store `displayThumbs` 按 `{p,m}` 缓存；cells 取源顺序 = 显示图 → 400 thumb → 原图（gif 大格例外）。实测临时根 3 张有效大图 src 全部 `-d1024.webp`，`srcHasOriginal=0`。
    ③ **失败降级链**：`imgFix` 状态机 显示图/原图失败→400 thumb；thumb 失败→原图带 `&r=n` 重试一次；再失败→`.noimg.broken`（点击重试）。灯箱 `stageUrl` 与 Inspector 预览也做「原图→缩略图→占位」，灯箱两端都失败显示“图片加载失败”。损坏 PNG 探针：`bad.png` 入库后 1 个 broken 占位，不裂图。
    ④ **依据**（WebSearch）：Chromium decoded-image 工作集默认约 128MB，RGBA 2700×4000 单张 40MB+，并行解码触顶会 `EncodingError`；`decode()` 拒绝 ≠ 文件损坏；最佳实践 = 网格只加载有界缩略图、原图仅显式预览、onerror 降级。命令 `img.loading=lazy` + `decoding=async`。

59. **隐藏排序编号按钮（2026-11-09，Feb 指定；默认开）**：物理排序把文件/文件夹改成 `01_` 前缀后，界面默认不想看到编号。顶栏新增 `01` 按钮（`lib.hideOrderNumbers`，localStorage `picnest.hideOrderNumbers`，缺省/`'1'` 为开，只有 `'0'` 关）。`lib.dispName()` 只在显示层剥前缀，正则 `^(?:\d{1,3}|0\d{3})_+`（只认下划线；1~3 位或 0 开头 4 位），避免误伤 `2026-08-23`/`2026_08_23` 日期名；`lib.orderPrefix()` 取前缀。覆盖：网格 hover/文本卡、子文件夹卡片、树行与拖拽浮签、面包屑、详情图片名/文件夹 chip/移动下拉、查重结果、灯箱文本栏、删除确认名单。重命名走 `lib.renameTarget(oldName,newName)`：隐藏开启时把旧前缀接回，关闭时按输入原样，避免改名打乱物理排序。实测临时根：默认显示 `Alpha`/`y.png`，关按钮变 `01_Alpha`/`02_y.png`，再开恢复；`renameTarget('02_y.png','z')='02_z'`。

60. **「应用为手动排序」按钮（2026-11-09，Feb 指定）**：排序面板「排列方式」八格下方新增全宽按钮（`grid-column: 1/-1`，虚线边框）。ImageGrid 用 `watch(sortedImages)` 把**实际显示顺序**回写 `lib.gridOrder`（含筛选与前端排序 dims/rating/random），`lib.applyGridOrderToManual()` 按图片所在文件夹分组（用 `tree.rootPath` 剥相对路径），逐组 `picnest-images-reorder` 写 `sort_order`，点击先弹确认卡（标题「应用为手动排序并重命名原文件？」，列张数/物理开关状态/前缀替换风险，danger 按钮）；确认后调 `picnest-physical-order-images` 一次批量改名 `01_原名` 并写 sort_order，然后 `sortMode='manual'` + `loadImages`；取消完全不动；物理失败退回逐组 `images-reorder` 只写顺序并提示。manual 时禁用并显示「已是手动排序」，`view==='trash'` 禁用。实测临时根 name 序 `c,b,a`：取消保持原样；确认后变 `01_c,02_b,03_a` + manual。

61. **手动排序升为默认/首项（2026-11-09，Feb 指定）**：`SORTS` 数组把 `{key:'manual'}` 移到第一位（面板第一格，默认高亮），其余依次 标题/添加日期/修改日期/文件大小/尺寸/评分/随机模式；store `sortMode` 无 localStorage 时默认从 `'name'` 改为 `'manual'`（已存用户值不变）。实测面板第一格「手动排序」active，`sortMode=manual`；「应用为手动排序」按钮在 manual 下保持禁用属预期。

62. **一键清除根目录排序编号（2026-11-09，Feb 指定）**：根文件右键新增「清除排序编号…」（仅 isLib 行），确认卡（danger）说明会真实改磁盘名、物理开关仍开时下次拖拽会重新加编号。主进程 `picnest-strip-order-prefixes`：递归 walk 根目录（跳过点开头目录），收集匹配 `^(?:\d{1,3}|0\d{3})_+` 的文件/文件夹，按 depth 降序（先子后父）逐个 `fs.renameSync` 到去掉前缀的名字；重名用 `picnestUniquePath` 加 ` (2)`（文件夹不加扩展名处理，文件加在扩展名前）。文件夹改名同步：DB `file_path`（逐行 `picnestPhysThumbMove`，顺带缩略图缓存改名）、`picnestDirMemoryRenameKeys`、`picnestDirOrderRenameKeys`、父级 dirOrder 数组 `picnestOrderArrayRename`、回收站 `abs_path`；文件改名走 `picnestPhysThumbMove`。watcher 暂停/恢复；`sort_order` 不改。进度 `picnest-strip-prefix-progress` + `taskProgress` 浮条（不可取消）。实测临时根 3 文件 + 1 文件夹：`01_Alpha/01_x.png`、`02_y.png`、`01_a.png`（与 `a.png` 撞名）→ `Alpha/x.png`、`y.png`、`a (2).png`、`a.png`；`.picnest` 未动。

63. **插件库 P1/P2 实现（2026-11-09，Feb 指定）**：按 `docs/PLUGIN.md` 落地 theme + renderer 插件与仓库安装。
    ① **后端**（picnest-handlers.js）：`dataDir/plugins/<id>/plugin.json` 扫描/校验（id 正则、type theme/renderer/main、entry 无 `..`）、启停配置 `config.picnestPluginsEnabled`、文件夹安装（cpSync 临时目录后替换）、zip 安装（adm-zip；根/一层 plugin.json；50MB/200MB/路径穿越防护；sha256）、卸载、theme CSS 读取（512KB）、renderer 入口 HTML（2MB）、storage JSON（5MB）、`picnest-plugin-query-images`（folder_id 限定 ≤500、rating 排序）、`picnest-plugin-fetch`（http(s)、15s、2MB）、registry 拉取（http(s) 或本地文件，download 相对 registry 解析）。安装/卸载不跑代码。
    ② **渲染层**：侧栏底部「插件库」→ `PluginManager.vue`（已安装/插件仓库两页签、文件夹安装、registry zip 安装、启停、卸载、权限 chips）；`ui/src/lib/plugins.js` 负责主题 CSS 注入（`<style data-picnest-plugin>`）与事件总线。renderer 插件面板 = `srcdoc` 单文件 HTML + `sandbox="allow-scripts"`（**无 same-origin/Node/宿主 DOM**），postMessage 协议 `ready/init/event/query-images/storage-get/set/fetch/close`；宿主校验 pluginId + source window + permissions；query 的 folderId 由宿主填 activeRootId，插件不能跨库；fetch 只放行 `net:<origin>`；停用 renderer 会关闭其面板。
    ③ **事件**：store 在 selection-changed（selectImage/多选/清空）、view-changed（recordNav）、image-opened/closed（灯箱）emit，插件面板按 `events.read` 转发。新增 `openPlugins/closePlugins`。
    ④ **示例**：`examples/plugins/mono-mint`（theme CSS 437B）、`view-stats`（单文件 renderer，query 前 20 张评分 + 事件）、`registry.json` + `zips/`（sha256）+ README（清单/权限/消息协议/打包/调试）。
    ⑤ **实测**：文件夹安装两例→list 正确；theme 启用注入 style、停用移除；renderer 面板 srcdoc 5502B、sandbox=allow-scripts，page message 捕获 `ready` + `query-images#1/#2`；`query-images` 3 行；storage set/get；本地 registry 2 条；zip 安装 + sha256 成功；示例已卸载，插件目录为空。
    ⑥ **未做**：main 插件（P3 utilityProcess + 网关）、在线签名（P4）、`ui.contextMenu` 插槽、多文件资源（renderer 目前单文件）、默认在线 registry。

64. **帮助按钮 + 页头标题隐藏编号（2026-11-09，Feb 报）**：ImageGrid 的 `header.big` 对文件夹名补 `lib.dispName()`（此前只有面包屑/树/卡片走显示剥前缀，页头大标题仍显示 `03_ねぎまぷりん`）。顶栏新增 `?` 帮助按钮（`lib.helpOpen/openHelp/closeHelp`，App Esc 优先关帮助/插件库），`HelpDialog.vue` 分区说明：1 排序与文件名（重点：应用为手动排序会真实改名 `01_原名`；排序同步文件名开关；01 隐藏编号仅显示；根文件右键清除排序编号会去磁盘前缀且不改 sort_order；清除后若开关仍开会重新加；日期名不误伤）、2 浏览选择、3 录入拖拽复制、4 详情、5 大图裁剪旋转、6 筛选标签颜色、7 主题左栏、8 根元数据、9 查重缩略图插件、10 快捷键、底部风险提示。实测页头 hide 开=`ねぎまぷりん`、关=`03_ねぎまぷりん`；帮助含「清除排序编号」「01_」文案，Esc 可关。

65. **帮助补全简报/黑白/精确查重/AI 查重（2026-11-09，Feb 点名）**：`HelpDialog.vue` 扩到 14 节。新增 6 简报模式（入口右键、单击下一张/右键上一张、←→/A D、Esc、滚轮锚点缩放+拖拽平移、视频静音循环、路径变更自动退出）、7 黑白预览（全局显示开关，不改磁盘/色板，持久化）、11 精确查重（入口/大小分桶+MD5/结果快捷保留/不同后缀各留一张/停止/只进图巢回收站/与 AI 查重区别）、12 AI 查重怎么做（OpenAI 兼容地址/模型/Key、保存并测试色块、/models、maxPairs、¥/1M tok 估算、必须勾选上传缩略图且不上传原图、dHash→色块+pHash 预筛→AI 并查集、4 路并发/重试、结果与保留规则、停止/失败/人工复核注意）。实测 14 个 h3 标题与关键文案均存在。

66. **浏览器采集帮助 + 扩展视觉（2026-11-09，Feb 指定）**：HelpDialog 新增第 14 节「浏览器采集插件（重要）」——安装（Edge/Chrome 开发者模式加载 `extension/`）、弹窗选根文件/保存到、三种采集（右键图片、右键页面截图、按住 0.4s 进度环→面板拖到目标/新建文件夹）、重复三选一、重载后刷新页面、跨域 iframe/整页滚动/视频/标签未支持、真实写文件与 Referer/UA。快捷键顺延为 15。扩展视觉：content.js 按住进度环 `stroke-width 3.2 → 5.2`、底色透明度 .18→.22、金色提亮 #c08a3e；popup.css 底色 `#f4efe7 → #ffffff`、select 白底、文字/标签/提示改中性灰，暗色媒体保留。实测帮助 15 节且含关键文案；扩展需在浏览器扩展页重载并刷新已打开网页。

67. **AI 查重风险提示（2026-11-09，Feb 指定）**：`DupFinder.vue` AI 面板 `ai-hint` 下方新增 `.ai-risk` 小字（10.5px，琥珀 #b8862e）：「注意：图片可能因暴露度较高或不符合所选 AI 的使用准则而被服务商拒绝/弹回；请自行甄别素材并确认该服务条款。」实测 DOM 存在、颜色/字号正确。

68. **Logo 概念与 PSD 底稿（2026-11-09，Feb 问设计想法）**：`branding/` 下三版矢量概念——A 巢·照片卡（照片卡+U 形巢弧+金蛋，推荐主图标）、B 巢鸮（猫头鹰耳朵/双眼/喙+巢弧，吉祥物方向）、C N 字母标（圆角画框+N+金点，16px 最稳）；每版有浅底/深底 SVG（深底墨线换纸白）与 1024/512 PNG。`PicNest-logo-template.psd` 2048×2048，图层含暖纸背景、80% 安全区、22.5% 圆角、64 网格、中心十字、A/B/C 底稿（B/C 默认隐藏）；`preview-concepts.png`/`preview-sizes.png` 为对照图，README 写设计约束/导出规格/检查清单。**尚未接入 app/icon.png 与 .ico**，等 Feb 选定/改稿后再导出多尺寸。

69. **黑底 N 标终稿 + 软件图标接入（2026-11-09，Feb 给 PSD）**：Feb 在 `PicNest-logo-template.psd` 保留 C 层（黑底 N + 金点）后，仓库保存母版 `branding/final/PicNest-logo.psd`；用 ag-psd + canvas 读出可见层 canvas（1212×1212，透明外角），PIL LANCZOS 导出 2048/1024/512/256/128/64/48/32/16 PNG、多尺寸 ICO、浅/深底预览。已替换 `app/_internal_data/icon.png`（1024）与 `icon.ico`（旧件备份 `icon-old.*`），重启后通过 WM_GETICON 提取窗口图标验证为新 N 标。**exe 文件内嵌图标仍是旧图**，需 rcedit/Resource Hacker 改 PE 资源；窗口/任务栏已生效。Feb 追加「N 缩小 / 黑色面积加大」：从最终 2048 PNG 分解黑底 tile 与前景（纸白 N + 金点），前景等比缩至 **84%** 居中叠回，重导出 2048…16 PNG、ICO、预览并再次替换 `app/_internal_data/icon.*` + 重启；PSD 母版保持 100% 原始。再追加「N 更白」：按亮度/饱和度分离前景，非金色（N）像素做中性白重映射（34→34、245→255，保留黑边抗锯齿），金色与黑底不动；重导出并更新窗口图标。几何版 SVG 改名 `concepts/monogram-geometric-draft.svg` 仅作矢量化参考。

70. **最新 PSD 图标 + 软件名 PicRand→PicNest（2026-11-09，Feb 指定）**：按 Feb 最新 `PicNest-logo-template.psd` 可见层（C + 图层 2，纯白 N、更大的浅金蛋点、底部保留分隔缺口）合成，裁 1212 tile 导出 2048…16 PNG/ICO/预览，替换窗口图标。软件名全面改 PicNest：`package.json` name/productName/description/author（P11f）、`app.setName`+`setAppUserModelId`（P11a）、托盘 tooltip/菜单（P11b/P11c）、crashReporter（P11d）、wmic 进程名（P11e）；窗口 `setAppDetails({appId:"PicNest", relaunchDisplayName:"PicNest", appIconPath:…icon.ico})` 解决任务栏按钮组仍显示 Picrand 的问题。用 resedit 临时包改 `PicNest.exe` 的 VersionInfo（FileDescription PicNest / ProductName PicNest 图巢 / OriginalFilename PicNest.exe）和图标资源，原件备份 `app/PicNest.exe.picrand.bak`。验证：窗口标题 PicNest 图巢、exe VersionInfo 新、UIAutomation taskbar button = `PicNest - 1 个运行窗口`。后续再按同一 PSD 把 N 组缩到 76%（黑边加大）并重导 PNG/ICO/exe 图标，任务栏仍为 PicNest。

71. **纯黑底 + 分级 N 图标（2026-11-09，Feb 指定「底变成最黑的黑色」「对比其他 logo 有点糊」）**：底板改为纯黑 `#000000`（不再保留 PSD 合成出的近黑边），并按显示尺寸分级缩放 N——**16/20/24/32/40/48px 用 88%**（小图标放大 N，避免黑边过厚糊成一团）、**64px 及以上用 76%**（保留 Feb 要的宽黑边）。从 PSD 可见层重新裁 1212 原生 tile，逐尺寸 LANCZOS 导出 2048/1024/512/256/128/96/64/48/40/32/24/20/16 PNG 与 `preview-icon.png`；手工组装 `picnest.ico` 10 档 PNG 帧（16/20/24/32/40/48/64/96/128/256），每帧直接从 1212 母本缩放，不从 256 帧二次缩。接入：`app/_internal_data/icon.png`（1024）与 `icon.ico`，resedit 把同份 ICO 写入 `PicNest.exe` PE 资源（VersionInfo 保留 PicNest / PicNest 图巢 / PicNest.exe）；中间备份 `PicNest.exe.prev` 已删，仅保留原件 `PicNest.exe.picrand.bak`。Windows 任务栏缓存：结束 explorer → 删 `%LOCALAPPDATA%\IconCache.db` 与 `Microsoft\Windows\Explorer\iconcache*.db` → 重启 explorer 与 PicNest。实测 exe VersionInfo 正确、UIAutomation 任务栏按钮 `PicNest - 1 个运行窗口`、截图任务栏图标为纯黑圆角 tile + 白 N + 金点（无旧图）。`branding/README.md` 补分级比例与清缓存说明。

72. **两段式关闭：关窗隐藏到托盘 / 托盘退出彻底结束 + 托盘砍掉参考板（2026-11-09，Feb 指定「图1关闭后进入图2隐藏，从隐藏关闭才是彻底关闭」）**：
    ① **P12 托盘菜单移除参考板**：原 PicRand 托盘菜单有「新建参考板 / 隐藏所有参考板 / 显示所有参考板 / 关闭所有参考板」，PicNest 从未实现参考板窗口；现在托盘只剩「显示 PicNest 图巢 / 退出」。参考板相关函数与 IPC 还留在 bundle 里但无 UI 入口。
    ② **P13a 关窗 = 隐藏到托盘**：`mainWindow.on("close")` 不再发 `confirm-close` 等渲染层回包，而是 `event.preventDefault()` + `mainWindow.hide()`——点主窗口 X 后主窗口/任务栏运行按钮消失，进程和托盘图标保留（图2 的隐藏区）。**这里不能置 `allowClose = true`**，否则关窗会直接退出，破坏两段式语义。
    ③ **P13b 托盘「退出」才彻底结束**：托盘退出项先 `allowClose = true` 再 `app.quit()`；`window-all-closed` 的顺序改为**先 `tray.destroy()`**，再用 try/catch 兜底 `cleanupOnExit()` / `closeDatabase()`，最后无条件 `app.exit(0)`。原实现先清理，任一步抛错会跳过托盘销毁和退出，表现为“退出后图标/进程还挂着，需要再关一次”。
    ④ 实测：`window.picrand.windowClose()` 后主窗口 HWND `IsWindowVisible=False`、5 个 `PicNest.exe` 进程仍在、任务栏只剩固定的 `PicNest 已固定`；随后模拟托盘退出路径（`allowClose=true` + `app.quit()`）→ 5s 内所有进程退出。托盘菜单模板只剩「显示 PicNest 图巢 / 退出」两项。

73. **功能封版与开源交接（2026-11-09，Feb 指定「暂时所有功能完成，做个结尾，写交接文档给 Gemini 接手开源」）**：
    ① **收尾构建**：`ui` 生产构建（88 modules，dist 更新）→ `node tools/patches/apply.mjs` 重放 0 失败 → 重启生产应用 → CDP smoke：`title=PicNest 图巢`、`bridge=true`、网格 12 cells、`broken=0`、侧栏/根文件正常；两段式关闭再次确认（关窗隐藏、托盘退出全退）。
    ② **新增 `docs/HANDOFF-GEMINI.md`**：面向开源接手者的独立交接，含仓库现状（无 remote、根 README/LICENSE 缺失、`app/` 1.4GB 被 ignore、121 个跟踪文件）、GPL-3.0 义务与 PicRand 归属、**主进程/preload 对应源码缺口与两种补救方案**、隐私脱敏（docs 含真实路径/素材统计，建议新建公开仓库或重写历史）、第三方许可证/资产、已实现功能验收基线、已知限制、P0/P1/P2 开源 TODO、smoke 命令与交接结论。
    ③ **仓库状态**：`docs/HANDOFF.md` 顶部与 P0 段加入指向新文档的链接；最终检查点标签 `checkpoint-2026-11-09-final`。功能封版，后续新功能走插件或新分支。
    ④ 未做（留给 Gemini）：根 README/LICENSE/NOTICE、主进程源码入库、exe resedit 脚本固化、CI/Release、采集 token、扩展上架、插件 registry 签名。

74. **浏览页直接拖到 CSP / PS（统一拖拽，2026-11-09，Feb 指定「把图拖进 CSP 或 PS」→「和高亮拖动集成到一起，没必要分开」）**：
    ① **交互**：只有一种拖动。窗口内 = 原 HTML5 内部拖拽（落点高亮、排序/移动）；把图拖出 PicNest 窗口 = 主进程自动升级为 Electron 原生文件拖拽，拖进 Clip Studio Paint / Photoshop / 资源管理器松开即可。多选后拖其中一张会带上全部选中文件。Alt+拖动 / ↗ 手柄已移除。
    ② **主进程**：`picnest-drag-begin` 记录路径 + 所属 BrowserWindow，45ms 轮询 `screen.getCursorScreenPoint()` 与 `win.getBounds()`（外扩 4px），并用 koffi `GetAsyncKeyState(VK_LBUTTON)` 确认左键仍按下；连续 2 次在窗口外才升级，避免贴边误判。升级时发 `picnest-drag-out-start` → `sender.startDrag({ file, files, icon })` → 结束发 `picnest-drag-out-end`；`picnest-drag-end`（页面 dragend）清理轮询。拖拽预览优先首图（png/jpg/webp/gif/bmp）缩 96px，失败回退 `_internal_data/icon.png`。
    ③ **为什么这样做**：Windows 上 `startDrag` 与 HTML5 内部拖拽互斥（electron#7118），不能在 dragstart 就调用；保持 HTML5 在窗口内工作，只在光标离开窗口后升级，才能一个手势同时覆盖内部高亮排序和拖出。
    ④ **落回保护**：主进程在升级时发 out-start，渲染层 `markNativeDragOut()`；App 捕获阶段吞掉 `dragenter/dragover/drop` 的 Files，拖动途中又落回 PicNest 不会触发「重复添加」。out-end 后延迟 500ms 清标记，60s 兜底。
    ⑤ **实测**：build/apply 0 失败；普通拖动（不按任何键）从网格拖出窗口 → 外部 WinForms 文件拖放目标收到真实文件路径；主进程日志 `begin → escalate → startDrag returned`；落回 PicNest 不再弹重复添加。**实际拖入 CSP 画布仍需 Feb 手动确认**（未自动操作 CSP，避免动到正在编辑的画布）。

75. **Pinterest 采集失灵修复（2026-11-10，Feb 报「浏览器采集 Pinterest 失灵了」）**：
    ① **根因**：Pinterest 现在会把图片 `<img>` 设为 `pointer-events:none`（实测设置后 `document.elementsFromPoint` 直接不再包含该 img）。旧 `imgAtPoint` 只遍历 `elementsFromPoint`，于是按住采集拿不到图片、面板根本不弹；右键走浏览器原生 image context 同样可能不出现。采集服务日志只有 listening、没有 save/error，符合“请求根本没发出”。
    ② **修法**（`extension/content.js`）：新增 `imgVisibleAt()` 统一可见性判断（尺寸/自然尺寸/`checkVisibility`/display/visibility/opacity）；`imgAtPoint` 先走 `elementsFromPoint`，找不到时几何扫描 `document.images`，取包含该点、面积最大的可见图片。面板选择新增 `rowAtPoint`/`panelAtPoint` 坐标兜底：站点 `setPointerCapture` 把事件重定向到页面元素时，`composedPath` 里没有面板，仍能靠坐标高亮/点击行；`onDown` 也忽略面板区域，避免点面板时把面板关掉。
    ③ **验证**：把 `content.js` 注入真实 Pinterest 搜索页（stub `chrome.runtime`），先把 img 设 `pointer-events:none` 再 synthetic pointerdown → 面板正常打开（428×216）；随后把 pointermove/pointerup 派发到 `document.body`（模拟 capture 重定向）但坐标落在「文件夹A」行 → 行高亮 + `save-panel`，保存 URL 为 474x 的 `i.pinimg.com` 图片。未写真实文件（stub 只记录消息）。
    ④ **发布（v0.1.1）**：扩展版本 `0.1.1`；改动先落纯净版 `D:\zcode工作区\PicNest-Public`（commit `44f36ff`），再同步回开发版；沿用“重载扩展后必须刷新已打开网页”的纪律。
    ⑤ **追加根因：切回标签时 content script 根本不在（v0.1.2）**：Feb 补充「每次从标签进入 Pinterest 都失效，点开图片也没用，刷新就恢复」。这是另一条链路——Edge 睡眠标签/bfcache/扩展重载后遗留的旧页面不会自动重新注入 content script，切换标签或 Pinterest SPA 点开图片都不会触发注入，只有刷新才会。修法：`background.js` 在 `tabs.onActivated`、`tabs.onUpdated`（`status=complete` 或 `changeInfo.url`）主动 `chrome.scripting.executeScript({files:['content.js']})`，并在 `onStartup`/`onInstalled` 时补注入所有 Pinterest 标签；`content.js` 顶部 `__picnestHoldCollectLoaded` 守卫保证重复注入幂等。扩展版本 `0.1.2`；Public commit `b1a751b`。
