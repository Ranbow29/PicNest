# PicNest 图巢 — 交接文档（写给下一个窗口）

> **2026-11-09 第八版**（多选收尾：Ctrl+A / Esc 分层退出 / 空白框选 + 边缘自动滚动 / 右键批量软删）。
> 之前：第七版录入语义/回收站/复制粘贴/排序/浏览历史；第五版大图晃动/持久化；更早：拖窗战役 → 颜色对齐 Eagle 真源 → 资料库重构 → 动效系统 → 滑尺 → 生产验收。
> 本版按「开窗 → 现状 → 规则/约束 → 未做/技术债 → 文件地图 → 纪律」组织，新窗口从头读一遍即可接手。

## 〇、开窗三步走（照做即可）

```bash
# 1) 确认工作区干净 & 看上次进度
cd D:\zcode工作区\PicNest && git status --short && git log --oneline -n 8

# 2) 起 dev 环境（Vite + 带调试口的应用；-WorkingDirectory 必须给 app\，否则数据目录跑偏）
cd ui && npm run dev
powershell "$env:PICNEST_DEV='1'; Start-Process 'D:\zcode工作区\PicNest\app\PicNest.exe' -ArgumentList '--remote-debugging-port=9222' -WorkingDirectory 'D:\zcode工作区\PicNest\app'"

# 3) 探针自检（窗口别最小化——最小化会冻结 rAF，动画验证全失效）
node tools/cdp-eval.mjs "location.href"          # 期望 http://127.0.0.1:5173/
node tools/cdp-eval.mjs "@C:\path\any_probe.js"  # 表达式走文件，免 shell 转义
```

- **发布到双击模式**：`cd ui && npm run build`（改了源码不 build，双击跑的仍是旧 JS）。
- **同步数据**（dev ↔ 生产）：关应用 → 拷 `picrand.db` / `config.json` / `cache` 到 `C:\Users\feb\AppData\Roaming\PicNest`。
- dev 数据在 `app\_internal_data\`（CWD 相对，必须 `-WorkingDirectory app`）；生产在 `AppData\Roaming\PicNest`。

## 一、项目定位

PicNest 图巢：**GPL-3.0 fork 自 PicRand 2.77.0**，日常替代 Eagle。
**直链索引**：不复制文件，SQLite 只存 `file_path`；物理文件夹 = 真源，层级从路径派生。

- 仓库 `D:\zcode工作区\PicNest` · `app\`（运行时+dist）· `ui\`（Vite+Vue3）· `tools\`（补丁/探针）· `docs\`
- 文档：`PLAN.md`（规格 + 踩坑 35 条）· `MOTION.md`（动效规格/调参）· 本文
- 资料库：好图（约 6.7k）、素材（约 40）；数量实时以界面为准
- Eagle 参照本体 `D:\zcode工作区\eagle\Eagle`（app.asar 可拆，filter 真源在 `app/js/directives/filter-item-*.html`）

## 二、两种运行模式

| | 双击模式（生产） | dev 模式（开发） |
|---|---|---|
| 启动 | 双击 `app\PicNest.exe` | `PICNEST_DEV=1` + Vite 5173 |
| 界面 | `app\resources\app\dist`（改完必须 build） | 实时热更 |
| 数据 | `AppData\Roaming\PicNest` | `app\_internal_data\`（CWD 相对） |

## 三、能力现状（别重做）

### 资料库 / 文件夹
- 侧栏资料库区：多根切换 + localStorage 记忆；`⌂` 添加资料库；`＋` 在库根新建文件夹
- 文件夹右键菜单：新建子/同级、重命名（order+memory 键迁移）、排序（当前层/全部层、名称/修改时间）、移动到…、导出（递归保结构+重名去重）、图标颜色 8 预设、删除
- 空文件夹可见（dir-tree 合并真实目录）；颜色/展开态/描述存 `dirMemory`（config.json）
- **树根行只读**：根行无右键编辑菜单；库的编辑统一在「资料库」区
- **资料库行菜单**：新建子文件夹 / 重命名资料库（仅 `display_name`）/ 排序 / 导出 / 颜色 / 复制资料库文件夹 / 粘贴到此资料库
- **文件夹删除**：非根文件夹右键 → 确认卡（多选删除时 union 文件数/大小）→ 整包软删进图巢回收站；父子同选只删父级；当前浏览在被删子树内回父级

### 回收站（图巢内部，文件夹形态）
- 图片软删（`picnestRemove`）与文件夹条目（`picnest_trash_folders`）并存
- 文件夹删除 = 整包移到 `AppData\Roaming\PicNest\picnest-trash\<rootId>\<id>-<name>`（dev 在 `app\_internal_data\picnest-trash\...`），图片行 `file_path` 改到回收区并标 `deleted_at + trash_group`
- 回收站视图：顶部「已删除文件夹」卡片（还原 / 彻底删除），下方是单张软删图片；文件夹卡显示文件数/删除时间
- **回收站图片多选**：右键「还原到原文件夹（N 张）」批量还原（非破坏性、不弹确认）；「彻底删除（N 张，丢回收站）」先弹确认卡再逐张清理；文件夹条目仍走顶部卡片的单按钮
- **右键侧栏「回收站」** → 一键还原全部 / 清空回收站（有确认卡与结果卡）
- 还原回原路径；同名自动 `(2)`；`dirMemory`/排序保留；**彻底删除才进 Windows 回收站**
- `counts.trash` = 独立软删图片 + 文件夹条目数；回收站列表过滤 `trash_group IS NULL`
- **同步保护**：`scan-folder` / `sync-folder-snapshot` 的 diff 必须跳过 `deleted_at` 非空行（P8a-P8d），否则回收区路径不在 root 扫描结果里，会被当 removed 删掉、还原丢图

### 录入（位置即意图）
- 主展示区/窗口空白 → 当前浏览文件夹；非文件夹视图 → 库根（全部/未分类）
- 树行 → 该文件夹；树行上/下 30% 缝隙 → 该层父级，文件夹按缝隙序号插入排序（图片落进该层父级）
- 资料库栏 → 对应资料库库根；侧栏空白 → 当前库根
- **文件夹整包复制**：同名目标文件夹**合并，不再新开 `(n)`**；保留内部结构（仅图片/视频）；同名同大小按 MD5：同内容跳过、不同内容加序号；空目录不落盘；隐藏项/`Thumbs.db`/`desktop.ini` 忽略；自包含防护
- **放入前全库查重**（size 筛候选 → MD5，排除自身与目标同位）：重复弹三选一 —— 只保留旧位置（跳过新图）/ 覆盖到新文件夹（旧图移 Windows 回收站 + 删索引）/ 两个文件夹都保留
- 汇总结果卡：录入/文件夹/跳过/不支持/替换/失败 + 明细，6.5s 收起；跨库标 `→ 资料库名`
- 拖入反馈：资料库行/树行虚线、缝隙插入线、光标浮签「录入到「x」/插入到「x」第 n 位」；按住显示、松开/离开 450ms 内消失（window capture drop/dragend/dragleave + 心跳）

### 选择 / 拖动 / 排序
- 图片：单击单选；`Shift` 按 `filteredImages` 可见顺序范围选；`Alt/Ctrl` 加选、再点减选；`Shift+Alt` 范围并入
- **Ctrl+A** 选中筛选后可见的全部图片（输入框/灯箱/右键菜单打开时不拦截）
- **空白框选**：在正文空白处按住拖拽画金色选框，实时命中格子；`Shift` 以按下时的选中集为底加选；贴视口上下缘持续自动滚动；松手后的合成 click 被抑制（不会误触发「点空白选文件夹」）
- **Esc 分层退出**：输入框 → 灯箱（含裁剪）→ 确认卡（取消）→ 重复三选一（不自动选）→ 右键菜单 → 布局/筛选弹板 → 清空图片+文件夹选中（合并视图退回原浏览文件夹）
- 文件夹（树行）：单击打开；`Shift` 范围选；`Alt/Ctrl` 加减选（不打开）；多选时网格进入 **selectionView 合并内容视图**（union 去重、标题「已选定 N 个文件夹」）
- **正文文件夹卡片**：单击只选中（详情看文件夹），**双击才进入**；正文的 Shift/Alt 多选**只更新选中与详情、不切中央网格**；带修饰键双击不进入；选中样式与图片一致（2px 金 + 6px 光晕）
- **图片拖动排序**：**只在「手动排序」模式生效**（全部/文件夹都行），拖到正文任意位置按最近图算插入点；金色竖线距目标 12px；左半插前、右半插后；多选整组保持组内顺序；**非手动模式拖动直接拒绝**（不画线、不写库、提示切换），保护已有手动排序
- **手动顺序**：`images.sort_order`，`0` = 新录入/移入，**排最前**（id 新的在前）；manual SQL `(sort_order=0) DESC, sort_order ASC, id DESC`；移动图片 `sort_order=0`；全部视图非 manual 仍锁最新入库
- **拖进子文件夹**：图片拖到子文件夹卡片/树行 → 移入；外部文件拖到卡片 → 录入该文件夹；文件夹拖到卡片 → 移入；多选整组用 `x-picnest-files/dirs`
- **拖进回收站**：图片拖到侧栏「回收站」入口 → 软删；红色虚线高亮 + 浮签
- **批量软删**：右键已选中的图片（多选保留）→「丢到回收站（N 张）」→ 确认卡（数量 + 前 5 个文件名）→ 批量 `trashImages`；删除入口只在右键菜单（防误触），不进详情面板
- **点正文空白**：清图片选中，改为选中当前文件夹（库根→资料库根）；侧栏空白不再接收内部图片（防误落未分类）
- **树联动**：从正文卡片进入子文件夹时自动展开祖先（含收起的库根）并把选中行滚进树视口
- **增量更新**：排序/移动图片只写库 + 本地数组 + `refreshTree`，不整表 `loadImages`、不清选中、不重放入场波；内部移动用 `suppressSyncUntil` 屏蔽 watcher 全量刷新

### 复制 / 粘贴
- `Ctrl+C` / `Ctrl+V`（输入框内原生；文本选中时让浏览器复制）；同时写系统剪贴板
- 图片优先于文件夹；文件夹含**资料库根**（根行选中 Ctrl+C 或资料库行菜单「复制资料库文件夹」）
- 粘贴目标：Ctrl+V = 当前浏览文件夹（只选中一个文件夹时粘贴到它）；右键「粘贴到此文件夹」/资料库行「粘贴到此资料库」；支持跨库
- 文件夹粘贴同名合并；图片同名加序号；粘进自身/子目录拒绝；根复制粘贴前有耗时确认
- **父子同选穿透**：`topLevelDirs` 统一用于复制/删除/拖拽移动；根覆盖全部（复制只根、删除排除根）

### 详情面板三态
- 单选图片：预览/名称/注释/URL/色板/评分/文件夹/操作
- 多选图片：前 4 张扇形堆叠 + `已选 N 个文件`；批量注释/链接/评分；文件数/总大小/格式；文件夹 chips + 移动到…；复制全部文件/路径
- 单选文件夹：名称输入（root 只读）、描述（dirMemory.desc）、文件数/占用空间/添加日期（目录 birthtime）、导出
- 多选文件夹：`多个标题` + `已选 N 个文件夹` + union 统计；不显示导出
- 统计 IPC `picnest-dir-stats`（folderId + rels[]，LIKE 前缀 OR 并集）

### 浏览历史 / 面包屑
- 顶栏左上 ← / →：返回上一个打开的文件夹 / 前进回撤回前位置；跨资料库、全部/最近/回收站等视图都入栈
- 位置 = `{rootId, view, rel}`；新导航截断前进栈；上限 100；仅当前会话
- 面包屑「全部 › 祖先 › 当前」逐级可点（点全部回全部、点藤原回藤原）；当前项不可点

### 视图 / 子文件夹卡片
- **全部视图显示库根顶层文件夹**；文件夹视图显示直属子文件夹卡片（封面/名称/递归文件数）；卡片按可用宽度 **flex-wrap 铺满**（32 个全部可见）
- **「显示子文件夹内容」开关**：全部/文件夹都显示；开=递归，关=只直属（全部视图关 = 只显示库根散图）；localStorage 持久化
- 网格视口左内边距 26px（与右缘滑尺留白对齐）
- 全部 = 非手动时最新入库置顶；文件夹 = 排序面板（name/added/mtime/size/手动 × 升降序）
- 未分类 = 库根散图
- 持久化：布局/缩放/排序/资料库/侧栏宽/详情宽/树展开/上次浏览位置；详情初始收起

### 文本文件 / 视频
- **文本类入**（Feb 定：文本类收、代码类不收）：`.txt .md .markdown .log .json .jsonc .csv .tsv .ini .cfg .conf .yaml .yml`；
  scan-worker / watcher-worker / stats-worker / 拖入 / 文件夹复制 / 导出 全部同步收录；`.js/.ts/.py` 等代码文件仍被忽略
- **文字缩略图**：主进程把前 26 行渲染成 **800×1040** 纸面 SVG → webp（缓存 `md5(path)-v2.webp`，2 倍渲染保证大格子下不糊）；
  DB 写 `thumbnail_path + width/height=800/1040`；保存后自动失效重画；网格 URL 带 `?v=modify_time` 防浏览器旧缓存；
  未生成时格子显示后缀徽标占位卡；启动时幂等迁移会清掉旧版 400px 缩略图（`picnestMigrateTextThumbs`）
- **大图文本编辑器**：自动识别 UTF-8 / UTF-8 BOM / UTF-16LE / GB18030(GBK)，保留原换行风格（CRLF↔LF）；
  可编辑 + 1.5s 防抖自动保存 + `Ctrl+S`；关闭/翻页/离开前强制落盘；>2MB 只读预览；
  外部改动时保存返回冲突提示「再按 Ctrl+S 覆盖」；GBK 原文保存会转 UTF-8（工具栏明示）；字号/换行偏好进 localStorage
- **视频播放**：`<video>` 无原生 UI，自绘玻璃 dock —— 播放/暂停（空格）、进度拖拽、时间、静音、音量、循环、全屏；进入即自动播放；
  滚轮缩放/←→翻页照旧；裁切/旋转/翻转对视频隐藏；`loadedmetadata` 回填宽高
- 详情面板：文本显示「尺寸：文本」、隐藏色板；视频预览用海报缩略图（不再直链 mp4 裂图）

### 动效 / 滑尺 / 其它
- 入场波 520ms（1/24 墨水步进）；AnimIcon 六字形；集体晃动总线（切视图/换文件夹/切库/关大图/漏斗与布局弹板/详情开合）
- **随机自弹已彻底移除**（Feb 明确要求，勿复活）
- 滑尺 fixed 右缘：48 槽 cos² 波峰 + 单条金色 dash；点击/拖拽跳转
- **视觉分层**：底座 `--bg` 调到 `#eee7da`、主面板 `--panel-strong` 提到 0.95，主面板 `margin:12/12/12/10`
  + `--shadow-float`（近影+主影+大范围柔光）+ `inset 0 1px 0 --panel-edge` 顶缘高光，白窗体压在左栏之上；
  详情浮岛 right/bottom 10 与主面板内缘对齐，**底色为竖向玻璃渐变**（`--panel-insp-top/mid/low/bot`，
  0.97 → 0.93@46% → 0.86@74% → 0.60，顶端实白、越往下越透）+ `backdrop-filter: blur(22px)`，同用 `--shadow-float`
  （文字密集的正文上也不会透底）。圆角保持主面板 6 / 浮岛 14
- 手动拖窗、置顶按钮、颜色筛选对齐 Eagle 真源、裁剪三选一、丢回收站/从库移除
- **大图支持图片 / 视频 / 文本三种形态**；视频与文本的专属工具栏见上节

## 四、数据模型 / 关键约束

- `images.sort_order`：手动排序值；0 = 未排序（新录入/移入），manual 时排最前；移动图片重置 0
- `images.trash_group`：属于 `picnest_trash_folders.id` 的文件夹回收组；null = 独立图片
- `picnest_trash_folders`：`id, folder_id, rel, abs_path, trash_path, name, image_count, size, deleted_at`
- **sortMode 是全局的**（localStorage 一个值）；`sort_order` 数据按图片/文件夹各自存 —— 目前未实现「每文件夹独立排序模式」
- `picnestDirOrder` 以 rel 为键、跨资料库共享（历史结构）；多库根层同名顺序会互相影响
- `picnest-import-dir-copy`：同名合并 + opts `{policy, dupes}`；`picnest-dir-dup-check`：size→MD5，排除自身/目标同位
- 内部移动/排序设 `suppressSyncUntil` / `suppressWaveUntil`；`_loadGen` 防过期加载
- IPC 新增参数必须 **main handler / apply.mjs preload bridge / api.js** 三处同步
- Pinia 响应式数组不能直接 invoke：先 `[...arr]`（否则 `An object could not be cloned`）
- `ImageGrid` 是 fragment 根（canvas+viewport），App 的 `.insp-open` class 无法继承；需要手动处理右边距（卡片条 `right:312px` 等）
- `loadImages` 会清选中；本地增量操作不要调它
- **TEXT_EXTS 三处必须同步**：`ui/src/lib/fileKinds.js`、`tools/patches/picnest-handlers.js`（`PICNEST_TEXT_EXTS`）、`tools/patches/apply.mjs` 的 P9a/P9b/P9d/P9e 字面量
- 文本缩略图走 `picnest-text-thumbnails`，缓存名 `md5(file_path)-v2.webp`（2 倍渲染 800×1040），DB 同时写 `width=800/height=1040`（排版用）；
  Inspector 对文本显示「尺寸：文本」，不要暴露像素值；旧版 400px 缩略图由 `picnestMigrateTextThumbs` 在启动时幂等清理
- `picnest-read-text` 返回 `{content, encoding, eol, size, mtimeMs, truncated}`；`picnest-save-text(filePath, content, expectedMtimeMs)`
  原子写（`.picnest-tmp` + rename）且**始终写 UTF-8**（GBK 原文会转码，UI 已提示）；`expectedMtimeMs` 差值 >1.5s 判冲突；保存会失效旧缩略图
- 视频不写 width/height 的兜底：`loadedmetadata` 时回填 store（并 `layoutTick++`）；海报缩略图生成时主进程也会 updateImageDimensions

## 五、议题 / 下一步

已闭环：录入细分（位置即意图）、文件夹删除/图巢回收站、子文件夹卡片、图片拖动排序、浏览历史、复制粘贴、详情三态。

待做（优先级可再对）：
- [ ] 标签系统（筛选栏已预留标签位）
- [ ] 主题切换按钮（明暗 tokens 已齐备）
- [ ] 每文件夹独立排序模式记忆（当前全局 sortMode）
- [ ] 目录删除的图片确认细化（已软删，若要「删除并清空回收站」可补）
- [ ] 尺寸/评分排序 SQL 补全（目前前端排序）
- [ ] 滑尺 Monaco 细节（hover 预览）
- [ ] 既有同名副本（如 `风景 (1)`）的「合并到同名文件夹…」动作
- [ ] M6 采集：Eagle 兼容 localhost:41595 API（复用 Eagle for Edge）
- [ ] M7 Eagle 库迁移（先只读预演）
- [ ] `tools/verify_counts.py` 升级为多资料库

## 六、技术债

- `verify_counts.py` 单库时代脚本，多库账目混乱
- `picnestDirOrder` / `sortMode` 的全局性（见上）
- 文件夹整包 MD5 查重在主进程同步执行；超大文件夹首次放入会卡一下
- 同名副本 `风景 (1)` 不会自动合并；删除多余副本或做「合并到…」
- `.insp-open` 对 grid 的右边距不生效（fragment 根），图片可能滑到详情浮岛下面；卡片条已手动避让
- 大图无帧步进（Eagle Ctrl+←/→ 未做）；标签/框选外的批量编辑未做

## 七、关键文件地图

| 文件 | 职责 |
|---|---|
| `ui/src/stores/library.js` | 全部状态/动作：资料库、树、录入、选择、排序/增量、复制粘贴、回收站、浏览历史、详情统计 |
| `ui/src/lib/winDrag.js` · `iconMotion.js` · `wave.js` · `fileKinds.js` | 手动拖窗 · 图标弹簧+集体晃动 · 入场波 · 文本/视频后缀判定 |
| `ui/src/components/AnimIcon.vue` · `FolderIcon.vue` | 动效图标 · 文件夹图标 |
| `ui/src/components/TitleBar.vue` | 顶栏：面包屑/历史箭头/筛选/布局/缩放/搜索/窗控 |
| `ui/src/components/SideBar.vue` · `DirTreeItem.vue` | 资料库+视图入口/树行/拖拽落点/右键 |
| `ui/src/components/ImageGrid.vue` | 布局引擎+虚拟滚动+滑尺+子文件夹卡片+选中/拖动排序/拖回收站 |
| `ui/src/components/Inspector.vue` | 图片单选/多选、文件夹单选/多选四态 |
| `ui/src/components/DirContextMenu.vue` · `NamePromptDialog.vue` · `ConfirmDialog.vue` | 文件夹菜单/命名/通用确认 |
| `ui/src/components/ContextMenu.vue` · `DuplicateDialog.vue` · `ImportResultCard.vue` · `TrashMenu.vue` | 图片菜单/重复三选一/录入结果卡/回收站右键菜单 |
| `ui/src/components/FilterBar.vue` · `ColorPicker.vue` | 筛选 · HSV 取色 |
| `tools/patches/apply.mjs` · `picnest-handlers.js` | 补丁 P1-P6/P8/P9 + 文件夹/录入/回收站/统计/排序/文本 IPC |
| `tools/cdp-*.mjs` · `shot-prod.ps1` | CDP 探针/截屏 |
| `docs/MOTION.md` | 动效规格与调参速查 |

## 八、工作纪律（血泪换的）

1. 改 JS 一律 Write 脚本文件再执行（新 shell 会截断多行 `python -c` 且静默失败）
2. 改完 touch 目标文件；主进程/preload 改动重放 `node tools/patches/apply.mjs` + 重启应用
3. 生产验证前必须 `npm run build`（dist 陈旧 = 看不到效果）
4. 动画验证前确认窗口非最小化（最小化冻结 rAF/timer；遮挡也可能 `visibilityState=hidden`）
5. 生产构建无 `__vueParentComponent`（dev 专属），生产只能采样 DOM
6. **物理交互只有用户的鼠标是真相**（app-region 四连败；CDP 注入 drag 是假阳性）
7. SQLite LIKE + Windows 路径必须整体转义含分隔符；Vue 模板禁用 window/innerWidth；setup 新块放在依赖声明之后
8. 查重 SQL 必须带 `folder_id = ?`；import-check 分流 `dirs/clean/conflicts/missing`
9. 改 store 后行为没变先整页 reload（无 acceptHMRUpdate）
10. 物理移动/重命名目录后必须同步 DB（move-dir 已按前缀 UPDATE；rename 有全量 sync 兜底）
11. 隐藏/最小化窗口会卡 Vue Transition → 结果卡用 CSS 动画 + v-if 立即卸载
12. `sync/scan` 的 removed 必须跳过 `deleted_at` 非空行（P8a-P8d），否则回收站还原丢图
13. 手动排序保护：`canReorder` 要求 `sortMode==='manual'`；非手动拖动不写 sort_order
14. 增量优先：排序/移动不要整表 `loadImages`；内部操作设 suppress 时间戳
15. 新 IPC 参数三处同步（main/preload/api）；Pinia 数组过 IPC 先展开
16. 每完成一役 `git commit`；数量对账 `python tools/verify_counts.py`
17. **`window.picrand` 是 contextBridge 暴露的只读对象**：想替换方法做 spy 会静默失败（曾用假 restore 拦截，赋值没生效，探针真实还原了 2 张回收站图）——验证 IPC 副作用只能只读断言，或临时改源码再验
18. **主进程里有三份同形 worker 模板**（oversize / scan / stats），`String.replace` 只替第一份：加后缀/改扫描规则必须确认 **scan（真正入库）** 和 **stats（文件数）** 都打了补丁（P9d/P9e 就是这么补出来的）；改完重启应用才会重写 `*.cjs`

## 九、本轮验收状态 / 最近提交

- 当前 dev 实例运行中，浏览位置已还原到「粥」；回收站中 1 项为用户数据（验证批量还原时真实还原了 2 张，已回原文件夹）
- 本轮（多选收尾 + 回收站批量还原）CDP 逻辑验收已过：Ctrl+A 计数=可见数、Esc 分层、框选命中实时更新、Shift 并集、批量删除确认卡可取消且不动数据；回收站多选菜单文案「还原（N 张）/彻底删除（N 张）」、逐张调用、确认卡可取消
- **文本 / 视频批次验收**：临时文件夹入库 3 个文本 + 忽略 `.js`；SVG 纸面缩略图 3/3 生成、网格无占位卡；编辑器载入 UTF-8/6 行/101 字符、自动保存、Ctrl+S、关闭前 flush 全部回读通过；GB18030 探针正确解码、3MB 文件截断只读；mp4 720×960/16.57s 自动播放、自绘 dock 播放/暂停/拖进度到 8.28s 正常；测试目录已删、DB 行已清、浏览位置还原
- 最近提交（从旧到新）：`e4e21d0` 第七版交接 → `927e102` 多选收尾 → `6e4cc65` 回收站批量还原 → 本轮文本/视频（见 git log 顶部）
- 仍需 Feb **物理鼠标**验收：文本编辑器手感（自动保存/字号/换行）、文字缩略图观感、视频自绘控制条（拖动进度/音量/全屏）、以及此前遗留的框选/批量删除/拖动排序/历史箭头
- dist 已构建；文档三件套已同步（HANDOFF/PLAN/MOTION）
