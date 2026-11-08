# PicNest 图巢 — 交接文档（写给下一个窗口）

> **2026-11-09 第九版·收官交接**（多选/回收站/文本视频/视觉分层/详情自由缩放/查重/简报/拖拽落点/文件夹封面/旋转翻转写回）。
> 之前：第七版录入语义、第八版多选收尾。本版按「开窗 → 现状 → 数据约束 → 未做 → 文件地图 → 纪律 → 验收」组织。
> 最新提交 `4f30cab`；工作区干净；dist 已构建；dev 数据已清理（无测试目录、无手动封面残留）。

## 〇、开窗三步走

```bash
# 1) 状态
cd D:\zcode工作区\PicNest && git status --short && git log --oneline -n 8

# 2) dev 环境（Vite 必须在 ui\；应用 -WorkingDirectory 必须给 app\，否则数据目录跑偏）
cd ui && npm run dev
powershell "$env:PICNEST_DEV='1'; Start-Process 'D:\zcode工作区\PicNest\app\PicNest.exe' -ArgumentList '--remote-debugging-port=9222' -WorkingDirectory 'D:\zcode工作区\PicNest\app'"

# 3) 自检（窗口别最小化：最小化冻结 rAF/timer）
node tools/cdp-eval.mjs "location.href"          # 期望 http://127.0.0.1:5173/
node tools/cdp-eval.mjs "@C:\path\probe.js"      # 表达式走文件，免 shell 转义
```

- **发布到双击模式**：`cd ui && npm run build`（不 build 双击跑旧 JS）。
- dev 数据：`app\_internal_data\`（CWD 相对）；生产：`C:\Users\feb\AppData\Roaming\PicNest`。
- Vite 已开 `server.watch.usePolling: true, interval: 350`；若改文件仍不生效，重启占 5173 的 node 进程 + 重启应用。

## 一、项目定位

PicNest 图巢：**GPL-3.0 fork 自 PicRand 2.77.0**，日常替代 Eagle。**直链索引**：不复制文件，SQLite 只存 `file_path`；
物理文件夹是真源，层级从路径派生。仓库 `D:\zcode工作区\PicNest`（`app\` 运行时+dist、`ui\` Vite+Vue3、`tools\` 补丁/探针、`docs\`）。

- 文档：`PLAN.md`（规格+踩坑 46 条）、`MOTION.md`（动效）、本文。
- Eagle 参照本体 `D:\zcode工作区\eagle\Eagle`（app.asar 可拆；菜单文案/slideshow/grayscale 语义都从 asar 核实过）。

## 二、能力现状（别重做）

### 根文件 / 文件夹
- 侧栏区块名 **「根文件」**；资料库行的右键菜单用同一套词（重命名根文件…/复制根文件/粘贴到此根文件/移出根文件…），提示卡与 toast 也已统一。点击当前库也会回库根（全部视图 + `dir=null`）。
- 树根行只读（无右键编辑菜单）；库的编辑在「根文件」区（资料库行菜单：**在文件管理器中打开**/新建/重命名显示名/排序/导出/颜色/复制/粘贴/查找重复/**移出根文件**）。「打开」用 `openWithDefault`（`shell.openPath`）直接进目录本身；图片右键的「在文件管理器打开」是 `showItemInFolder`（选中文件），两者语义不同。
- **移出根文件**（2026-11-09）：只解除图巢登记——删该根 `images` 行/`picnest_trash_folders`/`folders` 行、config 里 `folderId|*` 排序键；**磁盘文件夹与文件一律不动**，可重新添加。回收站非空时主进程拒绝（先清空/还原）；被移出根若正在被 watcher 监听则 `stopWatching()` + 清 `_addQueue`（否则 add 事件会 `getOrCreateFolder` 把根复活）；活动根被移出 → 切到 roots[0] 或空态，并重启新根的 watcher；浏览历史过滤掉该根位置。
- 文件夹右键：新建子/同级、重命名、排序（当前层/全部层，名称/修改时间）、移动到…、导出、查找重复、图标颜色 8 色、删除。
- 空文件夹可见（dir-tree 合并真实目录）；颜色/展开/描述/封面存 `dirMemory`（config.json；封面键 `cover`/`coverThumb`）。

### 回收站
- 图片软删 `picnestRemove`；文件夹删除整包软删到 `AppData\Roaming\PicNest\picnest-trash\<rootId>\<id>-<name>`（dev 在 `_internal_data\picnest-trash`），行标 `deleted_at + trash_group`。
- 回收站视图：顶部已删除文件夹卡片（还原/彻底删除），下方单张软删图片。
- 图片多选右键：还原（N 张）批量、彻底删除（N 张，确认后逐张进 Windows 回收站）。文件夹条目走卡片按钮。
- 右键侧栏「回收站」：一键还原全部 / 清空；`counts.trash` = 独立软删图片 + 文件夹条目。
- **sync/scan 的 removed 必须跳过 `deleted_at` 非空行（P8a-P8d）**，否则回收站还原丢图。

### 录入 / 拖拽（最新 Feb 口径）
- 主展示区/窗口空白 → 当前浏览文件夹；非文件夹视图 → 库根；资料库行/侧栏空白 → 当前库根。
- **图片拖入左栏只认文件夹行**：整行 = 放进该文件夹，不提供上/下缝隙插入（避免手滑落父级）；**库根行不接图片**。
- **「未分类」视图入口**（与回收站同款）：拖图经过金色虚线高亮 + 浮签「移入未分类」，松开物理移到库根、保留索引。
- 文件夹拖拽 / 外部文件拖入仍保留上/下 30% 缝隙规则（文件夹排序 / 录入父级）。
- **内部拖拽优先判定**：Chromium 自动附带 `text/uri-list`；所有落点用 `ui/src/lib/dnd.js` 的 `isExternalDT`：先认 `x-picnest-file/files/dir/dirs`，命中即内部。
- 外部文件夹整包复制：同名目标合并；同名同大小按 MD5（同内容跳过/不同加序号）；空目录不落盘；隐藏项/Thumbs.db 忽略。
- 汇总结果卡：录入/文件夹/跳过/不支持/替换/失败 + 明细，6.5s 收起；拖入浮签按住显示、松开/离开 450ms 消失。

### 选择 / 排序 / 拖动
- 图片：单击单选；`Shift` 按 `filteredImages` 顺序范围选；`Alt/Ctrl` 加减选；`Shift+Alt` 范围并入。
- `Ctrl+A` 选全部可见（输入框/灯箱/右键菜单内不拦截）；空白框选（4px 阈值、Shift 加选、贴边 34px rAF 自动滚动、松手 320ms 内抑制 click）。
- `Esc` 分层退出：输入框 → 灯箱（含裁剪）→ 确认卡 → 重复三选一 → 右键菜单 → 布局/筛选弹板 → `clearSelections()`（合并视图回原浏览文件夹）。
- 文件夹树行：单击打开；Shift 范围；Alt/Ctrl 加减（不打开）；多选进 selectionView 合并内容视图。
- 正文文件夹卡片：单击只选中（详情看文件夹）、双击进入；Shift/Alt 只更新选中与详情、不切中央网格；选中样式与图片一致。
- **拖动排序只在手动排序模式生效**：拖到正文任意位置按最近图中心算插入点，金色竖线距目标 12px，左半插前/右半插后；非手动模式拒绝并提示。
- `sort_order=0` = 新录入/移入，manual 时排最前；移动图片重置 0。
- 拖图到子文件夹卡片/树行 = 移入；外部文件到卡片 = 录入；文件夹到卡片 = 移入；多选整组用 `x-picnest-files/dirs`。
- 拖图到侧栏「回收站」= 软删；拖到「未分类」= 移库根。
- 点正文空白 = 清图选并选中当前文件夹；树联动（revealDir + scrollIntoView）；增量更新不整表 `loadImages`。

### 图片右键菜单（正文 / 灯箱 / 简报共用）
当前顺序：`在文件管理器打开 / 进入简报模式 / ✓ 黑白预览 / 复制 / 粘贴到当前文件夹(条件) / 复制文件路径 / ✓ 设为文件夹封面(条件) / 查找重复… / 移入未分类 / 丢到回收站`。

- **没有「打开（灯箱）」**（双击即可进）、**没有「重命名」**（详情面板点名称才是真重命名）。
- **黑白预览**：全局显示开关（Eagle `isGrayscaleMode` 语义），网格/大图/详情/简报统一 `filter:grayscale(1)`，localStorage 持久化。
- **移入未分类**：物理移动到库根（重名 `(n)`、`sort_order=0`）并保留索引，替代旧「从库中移除」，避免幽灵文件；多选可用。
- **查找重复**：扫该图所在文件夹（库根散图=全库），不跨资料库。另有文件夹右键（子树）/资料库行右键（全库）入口。
- **设为文件夹封面**：文件夹级开关——该夹已有手动封面时显示「✓ 设为文件夹封面」，再按=清除恢复自动；换新封面=先清再对新图设置（Feb 接受两次）。库根散图无卡片，不显示此项。

### 查重
- 扫描：当前 `folder_id` → `stat` 实际 size → 按 size 分桶（仅同尺寸读盘）→ 流式 MD5（并发 4）→ `size:md5` 分组，≥2 成组；进度 `picnest-dup-progress`。
- 结果：组按可省空间排序；每文件显示缩略图/文件名/所在文件夹/大小/时间；快捷「保留第一张 / 最新 / 最旧」（同内容尺寸相同，“最大”无意义），可手动勾选；默认不勾。
- 删除只走图巢回收站；确认卡列前 5 个文件名；删后组内 <2 自动消失、统计实时更新。
- 实测全库 6,724 文件 258ms（27 个同尺寸候选）→ 9 组 / 19 文件 / 可省 13.1MB。

### 简报 / 黑白 / 无标题栏大图
- **简报模式**：全屏黑底（页面级 `requestFullscreen`），单击下一张、←/A 上一张、→/D 下一张、Esc 退出；视频静音循环、文本占位；计数/提示/右上关闭。
- 简报**滚轮以光标为锚点缩放**（0.2–8×）+ 拖拽平移（4px 阈值，未拖动才算单击切图）；右键呼出上述图片菜单（简报 z-index 890 < 菜单 900）。
- **灯箱右键**：图片/视频/文本舞台右键 → 同一套菜单；输入框/dock/裁剪层保留原生；灯箱 ←/→ 与 A/D 翻页（输入框/裁剪态不拦截，Ctrl+A/D 不误触）。
- **大图顶栏完全透明**：`.titlebar.lb-clear` 关闭玻璃/模糊/拖尾，只留悬浮控件；浏览模式仍保留全宽玻璃+拖尾。
- **大图底部 dock 完全透明**：`.dock.dock-clear` 关闭玻璃底/边框/阴影/模糊（裁剪条仍玻璃底）。
- 大图「适应」上下各留 **70px** 安全区（42 标题栏+20 拖尾+8；dock 46+16+8）；旧版 110 已废弃。
- **旋转/翻转写回**：图片 dock「保存」按钮（有未保存变换时高亮）→ `picnest-apply-transform`：sharp 先 flop 再 rotate（与 CSS 同序），原件备份 `cache/transform-backup-*`，原子覆写；更新尺寸/大小/mtime，清色板/缩略图并重生成；保存后复位。图片/视频/网格/详情 URL 统一带 `?v=modify_time` 强制刷新。

### 文本 / 视频
- 文本类白名单：`.txt .md .markdown .log .json .jsonc .csv .tsv .ini .cfg .conf .yaml .yml`；代码类不收。
- 文本缩略图：前 26 行 → **800×1040** 纸面 SVG → `cache/md5(path)-v2.webp`；2 倍渲染；DB 写 800/1040（仅排版）；外部修改懒失效（源 mtime > 缩略图+1.5s 清缓存）。
- 大图文本编辑器：UTF-8/BOM/UTF-16LE/GB18030 自动识别、保留 CRLF、1.5s 自动保存+Ctrl+S、关闭/翻页前 flush、>2MB 只读、冲突提示；GBK 保存转 UTF-8（工具栏提示）。
- 视频：`<video>` 自绘 dock（播放/进度/时间/静音/音量/循环/全屏），进入自动播放；滚轮缩放/翻页照旧；裁切/旋转/翻转隐藏；`loadedmetadata` 回填宽高。
- 详情：文本尺寸显示「文本」、隐藏色板；视频/文本预览用缩略图，不直链原文件。

### 采集（M6，2026-11-09）
- **自研开源 MV3 扩展** `extension/`（开发者模式加载；Edge/Chrome **同一份代码**，Chrome 137+ 已禁用 `--load-extension`，用 `chrome://extensions` UI）：右键图片「保存图片到图巢」、右键页面「保存页面截图到图巢」；popup 选「根文件 / 保存到」，选择全局有效。
- **网页内按住采集**（2026-11-09）：网页图片上左键按住 380ms（光标处环形进度）→ 双栏面板：左大片「未分类/库根」，右 = 当前根下**全部文件夹**（缩进列表，原生滚动）；**面板固定白底**（不随浏览器暗色，任何主题页面都清晰）；拖到目标松开保存；松开在面板空白则面板停留可点击；提前移动 >6px 取消，不影响页面自身拖拽/点击；Esc/点外部取消。Shadow DOM 注入，只挂主 frame 的 `<img>`；popup 可关闭该手势。
- **主进程本地服务** `127.0.0.1:41600`（`picnest-handlers.js` 的 M6 块）：`/api/v1/ping`、`context`、`folders?rootId=`、`save`。只写目标根内的文件（`picnestCollectTarget` 防 `..` 逃逸）；写入后 `insertImagesBatch` + `sync-db add` 事件，渲染层自行补缩略图/尺寸；`url/annotation/star` 写 DB。
- **安全**：绑定 127.0.0.1；Origin 只放行 `chrome-extension://` / `extension://` / 本机 localhost 页面；CORS + Private-Network 预检；**暂无 token**（开源发布前补）。
- **目标根跟随活动根**：store `syncCollectRoot()` 在 init / addRootByPath / switchRoot / removeRoot 调 `picnest-collect-set-root`；扩展可另选根（服务端 `picnestCollectRootId`，默认第一个）。
- **Eagle 兼容层暂缓**：只读调研确认 Eagle for Edge 3.1.29 用 `41595`（library/folder/tag/item addFromURL）+ `41593`（form：image / save-url / screen capture / import-images）。但 Eagle 运行时会占这两个端口（不能共存），且闭源扩展 EULA 需在开源前核实；协议事实记录在此，代码不抄、不捆绑。未来作为「Eagle 关闭时可选开启」的桥。
- **采集查重**：服务端写入前按「同根 + 同 file_size」筛候选（≤6）→ MD5 确认；命中则不落盘，返回 `duplicate` + matches（文件名/所在夹）。按住面板显示「图库里已有相同图片」+ **跳过 / 仍然保存**（`force:true`）；右键存图与页面截图只提示跳过（通知/文案）。只查目标根内、未软删；历史已有重复需用应用内查重清理。
- 扩展 v0.1 边界：图片 + 可见区域截图；不支持整页滚动/视频/PDF；不发送标签（标签系统未做）；服务端下载不带 Cookie，防盗链图片可能失败；按住采集只支持主 frame 的 `<img>`（跨域 iframe、CSS 背景图暂不做）。

### 详情 / 视觉分层
- 单选图片：预览/名称/注释/色板/评分/文件夹/操作（**URL 输入栏已删，DB url 字段保留**）。**图片的「文件夹」chip 必须由 `file_path` 反推**（`relOfImage`），不能用 `currentDirRel`——根文件夹开「显示子文件夹内容」或合并视图时，视图位置≠图片所在夹（否则子夹图片被标成库根）。
- 多选图片：前 4 张扇形堆叠 + 已选 N + 批量注释/评分/文件夹 chips/移动/复制；单选/多选文件夹三态。
- 详情浮岛 right/bottom 10，竖向玻璃渐变（0.97 → 0.93@46% → 0.86@74% → 0.60）+ blur(22px)。**顶缘 top 40**（面板相对）：压进玻璃顶栏 2px、停在右上角窗控按钮下缘（39）之下；分层 `玻璃 20 < 详情 24 < 栏内容/窗控 26`——`.titlebar` 不再建 z 上下文，`.glass`/`::after` z20、`.bar-content` z26（Feb 指定「详情高于顶栏、低于右上角按钮」）。
- **三向尺寸拖拽**（InspResize）：左缘宽、顶边高、左上角自由变换；支点固定右下；高度 0=自适应满高，双击顶边/角柄恢复满高。
- **详情打开时正文真让位**：`.browse.insp-open` 提供 `--insp-reserve`，`.grid-viewport` padding-right 消费；**不要再给 ImageGrid 传 class（fragment 根会丢），也不要让卡片条二次扣详情宽**。
- 主面板 `margin: 上/右 8px、下 22px、左 20px`（上/右收紧让窗控按钮贴角；下/左保留孤岛水带）+ `--shadow-float`（2026-11-09 按 Feb「增强正文孤岛感」加深一档）+ 顶部高光；底座 `#eee7da`；圆角主面板 6 / 浮岛 14（既有定稿，勿改）。改 margin 要同步概览滑尺的 `right/top/height`（窗口 fixed，现 6/70/calc(100vh-100px)）。
- **左栏底子白光**：`.sidebar` 顶部 `--sidebar-glow` 白色渐变，150px 渐隐回 `--bg`（范围≈品牌区+「全部」行，图二口径）；暗色主题 `rgba(255,255,255,.07)`。
- **网格卡片浮岛**：每张图常驻 `--shadow-tile`（近影+中影+柔光）、`--tile-edge` 顶缘高光、圆角 12；hover 抬升 3px + `--shadow-tile-hover`（`--ease-overshoot`）；选中环叠在浮岛影上，子文件夹封面同款。`.wi` 入场波用 `animation-fill-mode: backwards`（`both` 会永久压住 hover transform）。
- **沉浸模式不做浮岛**：灯箱图片/视频 `.stage` 无投影、无圆角，平面贴在正文上；简报 `.brief img/video` 显式 `box-shadow:none; border-radius:0`。浮岛/抬升只属于浏览网格卡片。
- 顶栏**不要**改成浮岛：试过（c7b0844），Feb 当场要求回调（f90daf8），保留全宽玻璃+20px 拖尾。
- 随机自弹已移除；入场波 520ms；滑尺 48 槽 cos² 波峰 + 单条金色 dash。

### 主题
- 顶栏 **☀/☾/◐ 按钮** → 六选一弹板：**跟随系统 / 暖砂 / 靛夜 / 灰白（低饱和） / 炭黑（低饱和） / 墨黑（低饱和）**；持久化 `localStorage['picnest.theme']`。暖砂=原暖米+金浅色，靛夜=原蓝紫夜+金深色。三个顶栏按钮（漏斗/布局/主题）`vo-wrap` 改 flex 对齐，盒子统一 29×28。
- 主题按钮动效：同一套 `springAt`（640ms，旋转 16° + 缩放 1.10 峰值），挂载/hover/mousedown/换主题/`iconShake` 集体晃动都会播放——不是 SVG 层图标但绑进集体动效总线。
- `ui/src/lib/theme.js`：auto 模式读 `matchMedia('(prefers-color-scheme: dark)')` 并监听变化，**解析到 `mono-light`（灰白）/ `mono-dark`（墨黑）**；解析结果写 `<html data-theme="light|dark|mono-light|mono-charcoal|mono-dark">` + `style.colorScheme`（light/mono-light → light，其余 → dark）；五个主题各有 token 块（light 为 `:root` 默认，其余按 `data-theme` 覆盖）。
- **低饱和黑白**：`mono-light`（中性灰白）/ `mono-charcoal`（比墨黑浅一档的中性灰）/ `mono-dark`（中性近黑），强调色也去饱和；默认文件夹图标走 `--folder-default` token（普通主题金、黑白主题灰）。**黑白主题只改界面，不改图片/色板内容**。
- **概览滑尺是 canvas**：`ImageGrid` watch `theme.resolved` → `queueRuler()` 重绘，否则换主题后 dash 还是旧 `--accent`。
- `ui/index.html` 内联脚本在首屏样式前落定 `data-theme`，防止强制模式闪白；运行期由 theme.js 接管。
- 新增颜色必须同时补 light `:root`、dark、mono-light、mono-dark 四块；组件里不要直接写 `@media (prefers-color-scheme)`。

## 三、数据模型 / 关键约束

- `images.sort_order`；`images.trash_group`；`picnest_trash_folders(id, folder_id, rel, abs_path, trash_path, name, image_count, size, deleted_at)`。
- **sortMode 全局**（localStorage）；`sort_order` 各自存；每文件夹独立排序模式未做。
- **dirOrder 键 = `${folderId}|${rel || "__root__"}`**（多库隔离）；旧全局键启动时复制到每个库，读取只认新键。
- 文本缩略图/读取/保存、查重 IPC、rotate/flop IPC 见 PLAN 对应条目；**新增 IPC 必须 main / preload(apply.mjs P4b) / api.js 三处同步**。
- Pinia 响应式数组过 IPC 先 `[...arr]`（否则 structured clone 报错）。
- `ImageGrid` 是 fragment 根（canvas+viewport）：App 传 class 会丢；布局让位用 CSS 变量；`loadImages` 会清选中，本地增量别调它。
- 图片/视频/网格/详情 URL 带 `?v=modify_time`；文本缩略图同；`file://` 带 query 可正常加载。
- 内部移动/排序设 `suppressSyncUntil` / `suppressWaveUntil`；`_loadGen` 防过期加载。
- `window.picrand` 是 contextBridge 只读对象：不能替换方法做 spy（会静默失败）。
- **Vite dev 模板缓存**：新增组件/菜单后 Page.reload 可能不生效；fetch `/src/App.vue`、`/src/components/ContextMenu.vue` 看编译结果；重启 Vite+应用兜底（已开 polling）。
- **三份同形 worker 模板**（oversize/scan/stats）：改扫描后缀必须 P9a/P9d/P9e 都确认；watcher 单独 P9b。
- Chromium 内部拖拽带 `text/uri-list`：外部判定必须先看 `x-picnest-*`（`lib/dnd.js`）。
- 文本/视频/图片后缀判定：`ui/src/lib/fileKinds.js` 与 handlers `PICNEST_TEXT_EXTS` 同步。

## 四、未做 / 技术债

- 标签系统（筛选栏已预留标签位）。
- 尺寸/评分排序 SQL 补全（目前前端排序）；滑尺 hover 预览；既有同名副本「合并到同名文件夹…」。
- M6 采集后续：Eagle 兼容层（41595/41593，Eagle 关闭时可选开启）、采集 token 鉴权、整页滚动截图/视频/标签；M7 Eagle 库迁移（先只读预演）。
- 目录删除确认细化（是否「删除并清空回收站」）；大图无视频帧步进（Eagle Ctrl+←/→ 未做）。
- 查重无取消 IPC（关窗后主进程扫完丢弃）；同尺寸候选极多时首扫可能慢。
- 文件夹整包 MD5 查重仍在主进程同步执行；超大文件夹首次放入会卡。
- 手动封面若对应文件被外部删除/改名，卡片可能裂图（未做自动回落）；旋转/翻转对 GIF 可能丢失动画（sharp 单帧）。
- `picnestDirOrder` 只记顺序，不记“每层用名称还是时间排”的模式。

## 五、关键文件地图

| 文件 | 职责 |
|---|---|
| `ui/src/stores/library.js` | 全部状态/动作：资料库、树、录入、选择、排序/增量、复制粘贴、回收站、浏览历史、详情、查重、简报/灰度/封面/变换 |
| `ui/src/lib/winDrag.js` · `iconMotion.js` · `wave.js` · `fileKinds.js` · `dnd.js` · `theme.js` | 手动拖窗 · 图标弹簧/集体晃动 · 入场波 · 文本/视频后缀 · 拖拽载荷分类 · 主题解析切换（auto/light/dark → data-theme） |
| `ui/src/components/TitleBar.vue` | 顶栏：面包屑/历史/筛选/布局/缩放/搜索/窗控；大图模式 `.lb-clear` 透明 |
| `ui/src/components/SideBar.vue` · `DirTreeItem.vue` | 根文件+视图入口/树行/拖拽落点/右键；未分类/回收站拖入 |
| `ui/src/components/ImageGrid.vue` | 布局引擎+虚拟滚动+滑尺+子文件夹卡片+选中/框选/拖动排序+卡片封面+拖入落点 |
| `ui/src/components/Inspector.vue` · `InspResize.vue` | 图片/文件夹详情四态 · 详情三向尺寸拖拽 |
| `ui/src/components/Lightbox.vue` | 大图：图片/视频/文本三态、透明顶栏/dock、A/D、右键菜单、旋转翻转保存 |
| `ui/src/components/BriefMode.vue` | 简报模式：全屏、单击/右键、A/D、滚轮缩放/拖拽平移、灰度 |
| `ui/src/components/ContextMenu.vue` · `DirContextMenu.vue` | 图片菜单（封面开关/查重/简报/灰度/未分类）/文件夹菜单 |
| `ui/src/components/DupFinder.vue` | 查重结果分组面板（快捷保留、勾选、软删） |
| `ui/src/components/ConfirmDialog.vue` · `NamePromptDialog.vue` · `DuplicateDialog.vue` · `ImportResultCard.vue` · `TrashMenu.vue` | 确认/命名/录入三选一/结果卡/回收站菜单 |
| `ui/src/components/FilterBar.vue` · `ColorPicker.vue` | 筛选 · HSV 取色 |
| `ui/vite.config.js` | dev 绑定 127.0.0.1 + watch polling；build 输出到 app dist |
| `tools/patches/apply.mjs` · `picnest-handlers.js` | 补丁 P1-P9 + 文件夹/录入/回收站/统计/排序/文本/查重/变换 IPC + **M6 采集本地服务（127.0.0.1:41600）** |
| `extension/` | 自研 MV3 采集扩展（右键存图/页面截图 + popup 选根/文件夹）；安装见 `extension/README.md` |
| `tools/cdp-*.mjs` · `shot-prod.ps1` · `verify_counts.py` | CDP 探针/截屏 · 多库对账 |
| `docs/MOTION.md` | 动效规格/调参 |

## 六、工作纪律（血泪换的）

1. 改 JS 一律 Write 脚本文件再执行（新 shell 会截断多行命令）。
2. 主进程/preload 改动：`node tools/patches/apply.mjs` + 重启应用；改 store/新组件后整页 reload，必要时重启 Vite。
3. 生产验证前必须 `npm run build`。
4. 动画验证前窗口非最小化（冻结 rAF/timer）。
5. 生产构建无 `__vueParentComponent`，只能采样 DOM。
6. **物理交互只有用户的鼠标是真相**；CDP 合成 drag 只能证明分支，不能证明手感。
7. SQLite LIKE+Windows 路径整体转义；Vue 模板禁用 window/innerWidth；setup 新块放依赖声明之后。
8. 查重 SQL 必带 `folder_id`；import-check 分流 dirs/clean/conflicts/missing。
9. 物理移动/重命名目录必须同步 DB（move-dir 前缀 UPDATE；rename 全量 sync 兜底）。
10. 隐藏/最小化窗口会卡 Vue Transition → 结果卡 CSS 动画 + v-if。
11. sync/scan removed 跳过 `deleted_at` 非空行（P8a-P8d）。
12. 手动排序保护：`canReorder` 要求 `sortMode==='manual'`；非手动拖动不写 sort_order。
13. 增量优先：排序/移动不整表 loadImages；内部操作设 suppress 时间戳。
14. 新 IPC 三处同步；Pinia 数组过 IPC 先展开。
15. 每完成一役 git commit；`python tools/verify_counts.py` 对账。
16. `window.picrand` 只读，不能替换方法做 spy。
17. 三份同形 worker 模板，扫描后缀三处都打（P9a/P9d/P9e）。
18. Vite 会喂旧模板缓存：先 fetch 编译结果再怀疑代码；重启 Vite+应用。
19. 简报全屏是页面级 `requestFullscreen`，不是 Electron 窗口 fullscreen。
20. 内部拖拽带 `text/uri-list`，外部判定先看 `x-picnest-*`。
21. 图片拖入树行只认文件夹行、整行=into；根行不接图片；未分类走侧栏入口。
22. 详情让位已通过 viewport padding 实现，卡片条/列数不要再二次扣详情宽。
23. 旋转/翻转写回：flop 后 rotate；同路径刷新靠 `?v=modify_time`；封面若引用该图要更新 coverThumb。
24. 封面菜单是文件夹级开关（有手动封面即显示 ✓，再按清除），换新封面两次操作是预期。
25. 入场波 `.wi` 的 fill-mode 保持 `backwards`，不要改回 `both`（会永久压住 hover 的 transform）；卡片浮岛靠 `--shadow-tile*` / `--tile-edge` 双主题 token。
26. 颜色筛选依赖内存 `palettes`：`loadImages` 末尾必须 `ensurePalettes()`（init 只覆盖启动时文件夹，切换后不补建=颜色筛选恒 0）；FilterBar 取色/灰度、详情现算色板都要兜底触发/回写 `lib.palettes`。
27. 移出根文件 = 只清 DB 索引/排序键/回收站条目，磁盘文件永不动；回收站非空先拒；watcher 命中该根必须停并清 `_addQueue`，否则根会被 add 事件复活。新增根相关 IPC 走 `picnest-handlers.js` + `apply.mjs` 的 P4b preload 列表两处（渲染层直接 `window.picrand.*`）。
28. 主题只认 `<html data-theme>`：新颜色同时补 `:root`（light）、`[data-theme="dark"]`、`mono-light`、`mono-charcoal`、`mono-dark` 五块，组件里不要写 `prefers-color-scheme`；auto 的系统联动在 `lib/theme.js`，首屏防闪在 `index.html` 内联脚本；canvas（概览滑尺）换主题要主动重绘。
29. 采集服务只绑 `127.0.0.1:41600`；写文件前必须过 `picnestCollectTarget`（防 `..` 逃逸）；Origin 只放行 `chrome-extension://`/`extension://`/本机 localhost；扩展代码原创、不打包不引用 Eagle 资源，Eagle 兼容层不默认开启。改采集服务后 `apply.mjs` + 重启；扩展改完在 `edge://extensions` 点重载。

## 七、验收状态 / 最近提交

- 当前 dev 实例运行中，浏览位置「红油奇亚籽/新_2025-2026」；灰度关闭；无测试目录/测试封面残留。
- **对账**：`verify_counts.py` 好图 6718/6718、素材 42/42 全一致（修了根目录直属文件漏数）。
- **查重**：全库 6,724 文件 258ms → 9 组/19 文件/可省 13.1MB；临时目录图片/视频/文本正确分组、同尺寸不同内容未误报；批量软删后组自动收缩。
- **拖拽**：内部载荷+uri-list 拖到树行正确 move；行顶部 10% 强制 into 无插入线；根行不接；未分类入口落库根。
- **封面**：设置后卡片换图；同夹另一图菜单显示 ✓，再按恢复自动。
- **变换**：735×490 临时图保存后磁盘/DB 均 490×735，缩略图重生成、按钮复位、toast 正常。
- **其它**：详情宽 289 时卡片 4 列；简报 1/370、滚轮 1→1.12、拖拽 50/30、右键菜单 z900>890；灯箱/简报 A/D 通过；大图透明顶栏/dock、安全区 70px 通过。
- **最近提交**：`9cc6703` 查重+优化 → `47bd9b4` 简报/黑白/未分类 → `5063d7e` 去打开灯箱 → `5ace0a3` A/D+图片查重 → `32ec210` 卡片条/拖拽分类 → `c48e575` 拖入落点/封面 → `86539a3` 旋转翻转保存 + 封面开关 → `a61b86b` 网格图片浮岛化 → `e985fcf` 左栏顶部白色渐变 → `1a4c91c` 正文面板孤岛感加码 → `8eefc03` 详情浮岛升层 + 上/右缝收紧 → `5d44454` 色板索引跟随视图补建 → `4e28313` 灯箱/简报去浮岛 → `d6b3d4e` 移出根文件 → `57ed218` 主题系统 → `caab968` 根文件菜单「在文件管理器中打开」 → `f3ccc2f` 右键菜单统一「根文件」措辞 → `bc6735a` 清剩余可见「资料库」文案 → `20679c4` 两套低饱和黑白主题 → `dd25fcc` 再加「炭黑」档 → `61ae51f` 主题更名/跟随系统改灰白墨黑/炭黑提亮 → `504f50c` 顶栏三钮对齐 + 主题钮集体动效 → `18ec862` 详情文件夹 chip 反推修复 → `f780c65` M6 采集（自研扩展 + 本地服务） → `8132bd3` 网页内按住采集（长按面板） → `4f30cab` 采集面板固定白底 + Chrome 安装说明（再往前见 `git log`：文本/视频、多选、视觉分层、详情缩放、大图透明栏等）。
- **仍需 Feb 物理鼠标验收**：旋转/翻转保存、封面 ✓ 两段式、图片拖行边缘/根行/未分类、简报缩放平移右键与 A/D、灯箱右键/A/D、查重面板、详情三向缩放、大图透明顶栏/底栏、框选/拖动排序。
- dist 已构建；HANDOFF/PLAN 已同步（MOTION 未改）。
