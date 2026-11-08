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
8. 运行时调试标配：PicNest 以 --remote-debugging-port=9222 启动，tools/cdp-eval.mjs 可在渲染层里查 Pinia 状态/模拟动作/端到端验证（支持 @文件 免转义；动画验证用 cdp-active-eval.mjs 且窗口勿最小化）（store 经 $pinia._s.get('library')）
9. PicRand 的 watcher 只在 add-folder 流程启动，应用重启后不恢复 → 必须在渲染层 init 里对所有根重新 startWatcher + 后台 sync-folder-snapshot（外部变动才可见）
10. 渲染层快速迭代期间，编译错误浮层会卡死整个页面（所有点击无效）——用户报「功能无效」时先查是否处于编译错误窗口期
11. **-webkit-app-region: drag 四种结构全灭**（2026-11-08）：①drag+backdrop-filter 同体 ②pointer-events:none 兄弟层 ③干净拖拽面+控件亲儿子 no-drag ④部分 setBounds——物理鼠标下 no-drag 全部失效（浏览器进程拖拽位图无视 no-drag，CDP 注入检测不出=假阳性）。→ 已弃用 app-region，改 winDrag.js 手动拖窗（mousedown + screenX/Y 增量 + IPC setBounds）
12. **Win 非 100% DPI 拖窗三连坑**：a) 位置一变系统强制重算尺寸（±2px 非幂等）→ 尺寸一变 Web 内容整帧重排=抖动 → 手势期 setResizable(false) 冻结；b) 尺寸断言与补偿逐帧打架 → 主进程持「规范尺寸」+resize 防抖回读时 ≤4px 抖动丢弃（棘轮断根）；c) DIP×1.25 非整（901→1126.25）永动舍入 → 尺寸/位置吸附物理网格。验证看 clientWidth（40/40 恒定）而非 outerWidth（报告噪声）
13. **dev 数据目录 CWD 相对**（踩坑 #10 的完全体）：PowerShell Start-Process 不固定工作目录 → 进程在错误位置新建空 _internal_data →「库空了」。重启必须 `-WorkingDirectory '...\PicNest\app'`；已清两处垃圾目录
14. **「已完成」≠「接线」**：ensurePalettes 曾全工程零调用（颜色筛选恒空）；循环终止依赖 processed 字段在 DB 全量时恒 0 → 只回填一批（40/6673）。凡是「后台渐进构建」必须有：init 挂载点 + 不依赖单一返回键的终止条件 + 失败位标空防死循环
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
    （canvas + viewport），App 传入的 `.insp-open` class 无法继承 → 卡片条在详情打开时手动 `right:312px` 避让。
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
    视频：`<video>` 关闭原生 controls，自绘玻璃 dock（播放/进度拖拽/时间/静音/音量/循环/全屏/前后翻页），进入自动播放，
    空格播放暂停；`loadedmetadata` 取 videoWidth/Height 回填 store 并 fit；裁切/旋转/翻转/1:1 对视频隐藏；
    `url` 来自 `lib.images`（用不在当前列表的路径 openLightbox 会拿不到 src，探针踩过）。