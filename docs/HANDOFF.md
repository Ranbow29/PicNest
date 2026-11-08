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
- 空文件夹可见（dir-tree 合并真实目录）；颜色/展开态/描述/封面存 `dirMemory`（config.json，封面键 `cover`/`coverThumb`）
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
- **内部拖拽优先判定**：Chromium 会给拖拽元素自动附带 `text/uri-list`，导致图片拖到树行被当外部文件、只弹「录入到」且不移动。
  统一用 `ui/src/lib/dnd.js` 的 `isExternalDT`：先看 `application/x-picnest-file/files/dir/dirs`，有内部标记就绝不按外部导入；
  所有落点（App shell / ImageGrid 卡片 / DirTreeItem 树行 / SideBar 库行与空白）都走这个判断
- **图片拖入左栏的落点**（Feb 要求）：只认文件夹行、整行 = 放进该文件夹；图片拖拽不提供上/下缝隙插入（避免手滑落进父级/未分类）；
  **库根行不接图片**；要回未分类请拖到侧栏「未分类」入口——和回收站同款虚线高亮 + 浮签「移入未分类」。
  文件夹拖拽/外部文件拖入仍保留上/下 30% 缝隙规则

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
- 单选图片：预览/名称/注释/色板/评分/文件夹/操作（**URL 输入栏已按 Feb 要求删除**；DB 里旧 url 字段保留不动）
- 多选图片：前 4 张扇形堆叠 + `已选 N 个文件`；批量注释/评分；文件数/总大小/格式；文件夹 chips + 移动到…；复制全部文件/路径
- 单选文件夹：名称输入（root 只读）、描述（dirMemory.desc）、文件数/占用空间/添加日期（目录 birthtime）、导出
- 多选文件夹：`多个标题` + `已选 N 个文件夹` + union 统计；不显示导出
- 统计 IPC `picnest-dir-stats`（folderId + rels[]，LIKE 前缀 OR 并集）

### 浏览历史 / 面包屑
- 顶栏左上 ← / →：返回上一个打开的文件夹 / 前进回撤回前位置；跨资料库、全部/最近/回收站等视图都入栈
- 位置 = `{rootId, view, rel}`；新导航截断前进栈；上限 100；仅当前会话
- 面包屑「全部 › 祖先 › 当前」逐级可点（点全部回全部、点藤原回藤原）；当前项不可点

### 视图 / 子文件夹卡片
- **全部视图显示库根顶层文件夹**；文件夹视图显示直属子文件夹卡片（封面/名称/递归文件数）；卡片按可用宽度 **flex-wrap 铺满**（32 个全部可见）
- **文件夹封面**：图片右键（正文/灯箱/简报）→「设为文件夹封面」，写入 `dirMemory[rel].cover / coverThumb`；
  父级子文件夹卡片优先用它，缺省才取目录内第一张有缩略图的图。库根散图没有子文件夹卡片，菜单里不显示该项。
  菜单项是**文件夹级开关**：该文件夹已有手动封面时显示「✓ 设为文件夹封面」，再按 = 清除并恢复自动封面；
  要换新封面需先取消再对新图设置（Feb 指定，接受两次操作）
  详情打开时卡片条也只按内容区铺满：**不要再给 `.subfolders` 叠加 `right=详情宽`，`sfColumns` 也不要二次扣 `--insp-reserve`**（grid-viewport 的 padding 已经让过位，二次扣会让卡片只剩 2 列、右侧大片空白）
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

### 查重 / 数据一致性
- **查找重复**：入口 = 文件夹右键「查找重复…」（查该子树） / 资料库右键（查全库） / **图片右键「查找重复…」**（查该图所在文件夹；库根散图=全库）；严格按 `folder_id` 查，**不跨资料库**
- 扫描：全部图片+视频+文本 → 按 `file_size` 分桶（只有同尺寸才读盘）→ 流式 MD5（并发 4）→ 同 hash 且 ≥2 成组；
  进度经 `picnest-dup-progress` 推给渲染层；6.7k 库实测 258ms（27 个同尺寸候选，9 组/19 文件/13.1MB）
- 结果面板：组按可省空间排序；每个文件显示缩略图/文件名/**所在文件夹**（库根显示「库根」）/大小/修改时间；
  每组快捷「保留第一张 / 保留最新 / 保留最旧」只勾掉其余（同内容尺寸相同，"最大"无意义），也可手动勾选；默认不勾任何文件
- 删除：只走图巢回收站（软删可还原）；确认卡列前 5 个文件名；删后组内不足 2 个自动消失，统计实时更新
- 优化批次：①详情打开时正文网格真正让位（`--insp-reserve` 设 `.browse`，ImageGrid 用 padding-right；不再依赖无效的 `.insp-open`）
  ②`verify_counts.py` 多库对账（每库 active / 原地软删 / 回收区 / 文件系统 + 顶层目录 diff；修了根目录直属文件漏数）
  ③文本缩略图外部修改懒失效（`imagesByDir` 里源 mtime > 缩略图 mtime+1.5s 即删缓存/清 DB）
  ④目录排序键按库隔离 `${folderId}|${rel}`，旧全局键启动时复制到每个库（保留旧键可回滚）

### 简报 / 黑白 / 未分类
- **点击根文件（资料库）**：回到该库的根目录（全部视图 + `currentDirRel=null`）；再点当前库也会回根（`switchRoot` 同 id 不再直接 return）
- **根文件**：侧栏区块名从「资料库」改为「根文件」（仅侧栏标题/添加钮/空态；右键菜单与其它文案仍用“资料库”）
- **图片右键菜单**：移除「重命名」（真实重命名在详情面板点名称）；新增「进入简报模式」「黑白预览」；
  「从库中移除」改为「**移入未分类**」——物理移动到库根（重名自动 `(n)`）并保留索引，不再删 DB 行造成幽灵文件
- **简报模式**：全屏黑底演示（Eagle 语义，`requestFullscreen`），单击下一张 / **←/A 上一张、→/D 下一张** / Esc 退出；
  图片走原图，视频静音循环，文本显示占位提示；顶部计数、底部操作提示、右上关闭。
  **滚轮缩放（以光标为锚点，0.2–8×）+ 拖拽平移（4px 阈值；没拖动才算单击切图）**；
  **右键呼出图片菜单**（`z-index:890` 低于菜单 900，菜单在简报之上可用）；灯箱里右键同样呼出这套菜单
- **灯箱右键**：图片/视频/文本舞台右键 → 同一套图片菜单；dock/裁剪层/输入框保留原生行为；菜单操作删除/移动时会自动关掉灯箱或简报。
  灯箱 ←/→ 与 **A/D** 都能翻页（输入框/裁剪态不拦截；Ctrl+A/Ctrl+D 不误触）
- **黑白预览**：全局显示开关（Eagle `isGrayscaleMode` 语义），不是改图；网格/大图/详情/简报统一 `filter:grayscale(1)`，
  状态存 localStorage，右键菜单带 ✓；文本缩略图也会一起变灰
- **移入未分类**：多选可用（菜单显示 N 张）；已在库根的跳过并提示；移动后 `sort_order=0`，当前在库根/未分类视图时自动重载

### 动效 / 滑尺 / 其它
- 入场波 520ms（1/24 墨水步进）；AnimIcon 六字形；集体晃动总线（切视图/换文件夹/切库/关大图/漏斗与布局弹板/详情开合）
- **随机自弹已彻底移除**（Feb 明确要求，勿复活）
- 滑尺 fixed 右缘：48 槽 cos² 波峰 + 单条金色 dash；点击/拖拽跳转
- **视觉分层**：底座 `--bg` 调到 `#eee7da`、主面板 `--panel-strong` 提到 0.95，主面板 `margin:12/12/12/10`
  + `--shadow-float`（近影+主影+大范围柔光）+ `inset 0 1px 0 --panel-edge` 顶缘高光，白窗体压在左栏之上；
  详情浮岛 right/bottom 10 与主面板内缘对齐，**底色为竖向玻璃渐变**（`--panel-insp-top/mid/low/bot`，
  0.97 → 0.93@46% → 0.86@74% → 0.60，顶端实白、越往下越透）+ `backdrop-filter: blur(22px)`，同用 `--shadow-float`
  （文字密集的正文上也不会透底）。圆角保持主面板 6 / 浮岛 14
- **详情宽度拖拽柄在浮岛左缘**（不再贴窗口右缘）：绝对定位 `right: calc(var(--insp-w) + 6px)`、top 64 / bottom 10、宽 8px、z-index 13，
  4px 骑在浮岛左缘上；`--insp-w` 同时设在 `.browse` / `.insp-overlay` 容器上供手柄计算；`invert` 保留 = 向左拖加宽
- **详情高度/自由变换**：`InspResize.vue` 三个柄——左缘（宽）、顶边（高）、左上角（宽高同时，支点固定右下角）；
  `lib.inspectorHeight`（0=自适应满高，localStorage 持久化），固定高度时 `top:auto; bottom:10; height:var(--insp-h)`，
  顶边/角柄用 `bottom:calc(10px + var(--insp-h) ± n)` 跟随；双击顶边/角柄恢复满高；高度上下限 220 / 容器高-74
- 手动拖窗、置顶按钮、颜色筛选对齐 Eagle 真源、裁剪三选一、丢回收站/从库移除
- **大图支持图片 / 视频 / 文本三种形态**；视频与文本的专属工具栏见上节
- **旋转/翻转写回原图**：图片 dock 的「保存」按钮（有未保存变换时高亮）走 `picnest-apply-transform`：
  sharp 先 flop 再 rotate（与 CSS `rotate(...) scaleX(-1)` 同序），原件备份到 `cache/transform-backup-*` 后原子覆写；
  DB 更新 width/height/file_size/modify_time，清 `palettes`/`thumbnail_path`；保存后 rot/flop 复位、重新适配并重生成缩略图。
  图片/视频/网格/详情 URL 统一带 `?v=modify_time`，同路径覆写也能强制刷新
- **大图模式顶栏完全透明**（Feb 指定）：`.titlebar.lb-clear` 关闭 `.glass` 背景/模糊与 `::after` 拖尾，只留悬浮控件；
  图放大/平移时会直接从控件后面穿过（控件无底板，靠自身背景/字号辨识）。浏览模式仍保留全宽玻璃+拖尾
- **大图底部工具条同样全透明**（Feb 指定）：`.dock.dock-clear` 关闭玻璃底/边框/阴影/模糊，只留按钮；
  图片与视频两种 dock 都带这个类，裁剪条（crop-bar）仍是玻璃底
- **大图「适应」/ 自动适配的安全区**：上下各留 70px（42 标题栏 + 20 玻璃拖尾 + 8 呼吸；dock 46 + 16 底距 + 8 呼吸）。
  旧版只留总 110px，居中后上下各 55px → 顶边钻进拖尾、底边压到 dock（Feb 报「顶部被玻璃遮盖」）。
  改这个值时同步看 `.titlebar` 高度/拖尾与 dock 实际高度，三者任一变化都要重算

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
- **dirOrder 键 = `${folderId}|${rel || "__root__"}`**（多库隔离）；旧全局键在启动迁移时复制到每个库，读取只认新键
- **查重 IPC**：`picnest-find-duplicates(folderId, rel)` → `{groups, stats}`；进度事件 `picnest-dup-progress`；只查当前 `folder_id`，不跨库
- **详情让位**：`.browse.insp-open` 提供 `--insp-reserve`（= 详情宽 + 16），ImageGrid `.grid-viewport` padding-right 使用；不要再给 ImageGrid 传 class（fragment 根会丢）

## 五、议题 / 下一步

已闭环：录入细分（位置即意图）、文件夹删除/图巢回收站、子文件夹卡片、图片拖动排序、浏览历史、复制粘贴、详情三态、
**重复文件查找（右键子树/全库）**、详情让位/多库对账/文本缩略图失效/排序键隔离、
**简报模式 / 黑白预览 / 移入未分类 / 点库回根**。

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

## 六、技术债

- `picnestDirOrder` 的「排序」仍按当前层写回名字列表；跨库已隔离，但每个库的文件夹顺序模式（名称/时间）本身没有记忆
- 文件夹整包 MD5 查重在主进程同步执行；超大文件夹首次放入会卡一下
- 同名副本 `风景 (1)` 不会自动合并；删除多余副本或做「合并到…」
- 大图无帧步进（Eagle Ctrl+←/→ 未做）；标签/框选外的批量编辑未做
- 查重扫描没有取消按钮（关窗后主进程会继续扫完，结果丢弃）；同尺寸候选极多的大库第一次扫可能慢

## 七、关键文件地图

| 文件 | 职责 |
|---|---|
| `ui/src/stores/library.js` | 全部状态/动作：资料库、树、录入、选择、排序/增量、复制粘贴、回收站、浏览历史、详情统计 |
| `ui/src/lib/winDrag.js` · `iconMotion.js` · `wave.js` · `fileKinds.js` | 手动拖窗 · 图标弹簧+集体晃动 · 入场波 · 文本/视频后缀判定 |
| `ui/src/components/AnimIcon.vue` · `FolderIcon.vue` | 动效图标 · 文件夹图标 |
| `ui/src/components/TitleBar.vue` | 顶栏：面包屑/历史箭头/筛选/布局/缩放/搜索/窗控 |
| `ui/src/components/SideBar.vue` · `DirTreeItem.vue` | 资料库+视图入口/树行/拖拽落点/右键 |
| `ui/src/components/ImageGrid.vue` | 布局引擎+虚拟滚动+滑尺+子文件夹卡片+选中/拖动排序/拖回收站 |
| `ui/src/components/Inspector.vue` · `InspResize.vue` | 图片/文件夹详情四态 · 详情三向尺寸拖拽（左/顶/左上角，支点右下） |
| `ui/src/components/DirContextMenu.vue` · `NamePromptDialog.vue` · `ConfirmDialog.vue` · `DupFinder.vue` | 文件夹菜单（含查找重复）/命名/通用确认/重复结果面板 |
| `ui/src/components/ContextMenu.vue` · `DuplicateDialog.vue` · `ImportResultCard.vue` · `TrashMenu.vue` | 图片菜单/录入重复三选一/录入结果卡/回收站右键菜单 |
| `ui/src/components/FilterBar.vue` · `ColorPicker.vue` | 筛选 · HSV 取色 |
| `tools/patches/apply.mjs` · `picnest-handlers.js` | 补丁 P1-P6/P8/P9 + 文件夹/录入/回收站/统计/排序/文本/查重 IPC |
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
19. **Vite dev 会出现“新组件不挂载”的假象**：往 App.vue 新增 `<Xxx />` 后，即使 Page.reload，编译出的 render 里可能根本没有它（其它组件靠 HMR 更新了，App 模板仍是旧缓存；症状：脚本里 import 在、组件树里没有、DOM 也没有）。
    处理：重启 Vite dev server（占 5173 的 node 进程）+ 重启应用；排查时直接 fetch `http://127.0.0.1:5173/src/App.vue` 搜组件名，比盯着 DOM 快。
    dev 已开 `server.watch.usePolling: true, interval: 350`（vite.config.js），仍失效就重启 Vite
20. **简报模式的“全屏”是 `document.documentElement.requestFullscreen()`**（页面级），不是 Electron 窗口 fullscreen；Esc 会先退 fullscreen 再触发 fullscreenchange，组件里监听并关掉简报，App 里也兜底处理 Esc
21. **内部拖拽会被 Chromium 自动附带 `text/uri-list`**：判断外部拖入必须先看自定义 `x-picnest-*` 标记（`lib/dnd.js`）；
    否则图片拖到树行会走进“录入”分支、表现为拖不进文件夹。所有 dragover/drop 落点统一用它

## 九、本轮验收状态 / 最近提交

- 当前 dev 实例运行中，浏览位置在「红油奇亚籽/新_2025-2026」；详情面板尺寸为用户当前手动值（localStorage 持久化）
- **优化批次 CDP 验收**：详情打开时网格让位（内容右缘 1029 < 浮岛左缘 1041，不再压图）；
  `verify_counts.py` 两库均一致（好图 6718/6718、素材 42/42，修了根目录直属文件漏数）；
  文本缩略图被外部改后 mtime 判定失效并清空重画；dirOrder 旧键已迁移成 164 个 `${folderId}|rel` 隔离键，树顺序不变
- **查重批次验收**：临时目录 9 个文件 → 视频 2、图片 3（含 sub/ 子目录）、文本 2 正确成组，同尺寸不同内容未误报；
  快捷「保留第一/最新」勾选正确、确认卡 3 张、软删后组内不足 2 个自动消失；全库 6724 文件扫描 258ms
  （27 个同尺寸候选）→ 9 组 / 19 文件 / 可省 13.1MB；测试文件已从磁盘/回收站/索引全部清理
- **简报/黑白/未分类批次验收**：侧栏标题「根文件」；点当前库从子文件夹回到库根（`dir=null`）；
  图片右键菜单确认无「重命名」，新增「进入简报模式 / ✓ 黑白预览」，原「从库中移除」变「移入未分类」；
  黑白开关后网格缩略图 `filter:grayscale(1)`；简报全屏黑底、1/370 计数、灰度图、←→ 切换、Esc 关闭；
  灯箱右键菜单可开；简报滚轮 1→1.12、拖拽 50/30 平移、未拖动单击切图；简报里右键菜单 z900 > 简报 z890（可操作）；Esc 关闭；
  灯箱/简报 A/D 翻页实测通过；图片右键「查找重复…」打开扫描，scope 正确落在图片所在文件夹（`红油奇亚籽/新_2025-2026`，0 组）；
  **卡片条让位**：详情宽 289 时 strip 宽 845、卡片 4 列（修复前 2 列）；
  **拖拽分类**：合成 dragstart（内部标记 + 手动加 text/uri-list）拖到树行，图片正确移动到目标文件夹、无“录入”提示；
  **拖入落点**：目标行顶部 10% 也强制 into（无插入线）；根行不接图片；「未分类」入口高亮 `drop-uncat` 并落库根（note「已移入未分类 1 张」）；
  **文件夹封面**：右键菜单出现「设为文件夹封面」，卡片封面从 4f5de… 换成 ad7b2…，测试后已恢复自动封面；
  **封面开关**：干净状态下首按「设为文件夹封面」→ cover=true；同夹另一图右键显示「✓ 设为文件夹封面」→ 再按 cover=false；
  **旋转/翻转保存**：临时图 735×490 → 按钮保存后磁盘实际变 490×735、DB 尺寸同步、缩略图重生成、保存按钮复位、toast「已保存到原图（原件已备份）」；
  空白处右键已按 Feb 要求撤掉；测试目录/行已清，浏览位置还原
  移入未分类实测：`_picnest_move_test/sub/moveme.jpg` → 库根 `好图/moveme.jpg`，DB 行路径同步、旧路径不再索引、当前文件夹视图变空；
  测试文件/目录已清理，浏览位置还原「红油奇亚籽/新_2025-2026」，灰度开关已关
- 最近提交：`927e102` 多选收尾 → `6e4cc65` 回收站批量还原 → `f358e2f` 文本/视频 → `d1ebf3e` 缩略图 2x →
  `9309a67`/`64c70c6` 文本编辑层 → `e1d6d28`/`fb75cce`/`af4f999`/`f90daf8` 视觉分层（顶栏浮岛已回调）→
  `a93544c` 详情自由缩放 → `f168293` 大图安全区 → `4d036d6` 去 URL → `1a28e7f`/`b328019` 大图透明栏 →
  `9cc6703` 查重+优化 → 简报/黑白/未分类 → 灯箱/简报 A/D+图片查重 → 卡片条/拖拽分类 → 本轮拖拽落点/文件夹封面（见 git log 顶部）
- 仍需 Feb **物理鼠标**验收：旋转/翻转后点「保存」写回、封面开关（✓ 再按恢复自动）、图片拖入只落文件夹/根行不接、「未分类」拖入、简报模式全屏/缩放/平移/右键、灯箱右键与 A/D、查重面板、详情三向缩放、大图透明顶栏/底栏、框选/拖动排序
- dist 已构建；文档三件套已同步（HANDOFF/PLAN/MOTION）
