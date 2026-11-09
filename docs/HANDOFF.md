# PicNest 图巢 — 交接文档（写给下一个窗口）

> **2026-11-09 第十三版·统一拖拽到 CSP/PS + 封版交接**（在第十二版基础上新增：浏览页普通拖动 = 窗口内 HTML5 高亮排序/移动，拖出 PicNest 窗口自动升级为原生文件拖拽到 CSP/PS/资源管理器 + 落回保护；插件库 P1/P2、15 节帮助、AI 查重风险提示、手动排序置顶/应用为手动、隐藏与清除编号、根内元数据、物理排序、纯黑 #000000 分级 N 图标、PicRand→PicNest 应用名与任务栏、两段式关闭（关窗隐藏到托盘 / 托盘退出彻底结束）、托盘移除参考板、裁剪模式窗控优先级）。
> 之前：第七版录入语义、第八版多选收尾、第九版收官、第十版查重收尾、第十一版根元数据/主题/缩略图/插件设计。本版按「开窗 → 现状 → 数据约束 → 未做 → 文件地图 → 纪律 → 验收」组织。
> 统一拖拽提交 `7001b8e`；最终检查点 `checkpoint-2026-11-09-r4`；工作区干净；dist 已构建；dev 数据已清理（无测试目录、无手动封面残留）。
> **开源接手**：看 `docs/HANDOFF-GEMINI.md`（GPL 合规、对应源码、隐私清理、README/Release/CI 的优先顺序与验收命令）。
> **Pinterest 遗留硬骨头**：看 `docs/HANDOFF-PINTEREST.md`。**2026-11-10 已按方案 A+B+C 实现扩展 v0.1.4**（版本化探测 + cleanup 原地接管 + stale/孤立页 Pinterest 一次性自动刷新 + popup 本页状态/修复按钮），待 Feb 物理验收；细节见该文档第 9 节。

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
- **根文件重命名 = 物理目录 rename**（2026-11-09）：同步 `folders.path`、该根所有 `images.file_path`、`picnest_trash_folders.abs_path`、`dirMemory.cover` 绝对路径；主进程先停 watcher，渲染层用新路径重新 `startWatcher`（不能复用旧 onAdd 闭包）；失败会回滚目录并恢复旧 watcher。显示名跟随新目录名。文件夹重命名本来就是物理 rename，并同步 `dirMemory` 的 rel/cover。Eagle 向导为避免同名根冲突只改显示名，走 `displayOnly` 分支不动磁盘。
- **文件夹树不显示库根行**（2026-11-09）：根由「根文件」区选中/高亮；树只渲染根下子文件夹（顶层 depth=0，默认折叠，不再自动展开根）。根文件的编辑在「根文件」区（资料库行菜单：**在文件管理器中打开**/新建/重命名显示名/排序/导出/颜色/复制/粘贴/查找重复/**移出根文件**）。「打开」用 `openWithDefault`（`shell.openPath`）直接进目录本身；图片右键的「在文件管理器打开」是 `showItemInFolder`（选中文件），两者语义不同。
- **移出根文件**（2026-11-09）：只解除图巢登记——删该根 `images` 行/`picnest_trash_folders`/`folders` 行、config 里 `folderId|*` 排序键；**磁盘文件夹与文件一律不动**，可重新添加。移出后清孤儿标签：先清指向已删图片的 `image_tags`，再 `DELETE tags WHERE id NOT IN (SELECT tag_id FROM image_tags)`；只删不再被任何图片引用的标签，其他根仍在使用的保留。回收站非空时主进程拒绝（先清空/还原）；被移出根若正在被 watcher 监听则 `stopWatching()` + 清 `_addQueue`（否则 add 事件会 `getOrCreateFolder` 把根复活）；活动根被移出 → 切到 roots[0] 或空态，并重启新根的 watcher；浏览历史过滤掉该根位置。
- 文件夹右键：新建子/同级、重命名、排序（当前层/全部层，名称/修改时间）、移动到…、导出、查找重复、图标颜色 8 色（多选时批量应用到所有选中文件夹；混合色不显示选中态）、删除。
- 空文件夹可见（dir-tree 合并真实目录）；颜色/展开/描述/封面存 `dirMemory`（config.json；封面键 `cover`/`coverThumb`）。
- **根文件本地元数据 `.picnest/meta.json`（2026-11-09）**：点开头目录，PicNest 扫描/监听/树全部忽略，并 `attrib +h` 在资源管理器隐藏。内容：标签列表 + 每张图的评分/注释/URL/收藏/标签、文件夹颜色/描述/展开/封面（相对路径）、手动排序（目录数组 + 每夹图片名数组）。`picnest-root-meta-export/import` 读写；**移出根文件前强制导出**，重新添加根后自动导入并 toast 恢复项；没有文件时启动/加根自动创建。单文件目前约 774KB（10,764 图 / 2,431 条图片元数据）。

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
- **树根行已移除**：文件夹拖回库根用「根文件」当前库行承接（`dropOnDirs(..., '', 'into')`）；不再有根行 before/after，避免根名与同名子文件夹“好图”撞名。`dropOnDir` 对根行排序、自身/后代目标直接拒绝，`moveDir` 失败也不写 `dirOrder`。
- **树行拖拽排序（before/after）**：`dropOnDirs` 必须先把被移动项从 names 过滤掉，但**目标名要保留**再 `indexOf(targetName)`；曾把 targetName 也过滤 → index=-1 → 永远插到末尾。拖到自身直接忽略（valid 过滤 `r !== targetRel`）。
- **内部拖拽优先判定**：Chromium 自动附带 `text/uri-list`；所有落点用 `ui/src/lib/dnd.js` 的 `isExternalDT`：先认 `x-picnest-file/files/dir/dirs`，命中即内部。
- 外部文件夹整包复制：同名目标合并；同名同大小按 MD5（同内容跳过/不同加序号）；空目录不落盘；隐藏项/Thumbs.db 忽略。
- 汇总结果卡：录入/文件夹/跳过/不支持/替换/失败 + 明细，6.5s 收起；拖入浮签按住显示、松开/离开 450ms 消失。

### 选择 / 排序 / 拖动
- 图片：单击单选；`Shift` 按 `filteredImages` 顺序范围选；`Alt/Ctrl` 加减选；`Shift+Alt` 范围并入。
- `Ctrl+A` 选全部可见（输入框/灯箱/右键菜单内不拦截）；空白框选（4px 阈值、Shift 加选、贴边 34px rAF 自动滚动、松手 320ms 内抑制 click）。
- `Esc` 分层退出：输入框 → 灯箱（含裁剪）→ 确认卡 → 重复三选一 → 右键菜单 → 布局/筛选弹板 → `clearSelections()`（合并视图回原浏览文件夹）。
- 文件夹树行：单击打开；Shift 范围；Alt/Ctrl 加减（不打开）；多选进 selectionView 合并内容视图。
- 正文文件夹卡片：单击只选中（详情看文件夹）、双击进入；Shift/Alt 只更新选中与详情、不切中央网格；选中样式与图片一致。
- **手动排序新图置顶（2026-11-09 验证）**：新录入/移入一律 `sort_order=0`（`insertImage` 默认值 / move-image 显式置 0）；manual SQL `(sort_order = 0) DESC, sort_order ASC, id DESC`。临时根实测：排序后复制新图 → sync/ watcher 入库 → `c.png` 排在 `01_b/02_a` 之前；多条新图按 id DESC。**注意全量 `scan-folder` 会按遍历序号写 sort_order（新增根时），日常 watcher/sync 都是 0**。
- **手动排序为默认/首项（2026-11-09）**：排序面板顺序改为「手动排序 → 标题 → 添加日期 → 修改日期 → 文件大小 → 尺寸 → 评分 → 随机模式」；`sortMode` 无 localStorage 时默认 `manual`（已有用户存值不受影响）。手动排序是拖动换位/物理改名/新图置顶的统一基准。
- **应用为手动排序（2026-11-09）**：排序面板底部全宽按钮。把 ImageGrid 当前**实际显示顺序**（`lib.gridOrder` 由 `sortedImages` 回写，含筛选/前端排序）先弹确认（明确说明会改磁盘原名，列出张数/物理开关状态/前缀替换风险），确认后调 `picnest-physical-order-images` 一次批量重命名为 `01_原名` 并写 `sort_order`，然后切 `manual`；取消则完全不动。物理排序失败时退回只写 sort_order 并提示。manual 时禁用（文案「已是手动排序」），回收站禁用。实测 `c,b,a` 确认后 → `01_c,02_b,03_a` + manual；取消保持原样。
- **拖动排序只在手动排序模式生效**：拖到正文任意位置按最近图中心算插入点，金色竖线距目标 12px，左半插前/右半插后；非手动模式拒绝并提示。
- **拖动抖动修复（2026-11-10）**：拖动时 `.cell:hover .thumb` 的 `-3px` 上浮 + `0.26s` overshoot 会随光标扫过卡片反复抬落；`ImageGrid` 在 `dragstart` 给 `.canvas` 加 `.dragging`，关闭 thumb 过渡与 hover 位移（保留选中环），`dragend`/drop 清除。插入线对同一张卡加 6–14px 中点死区、`path`/`before` 不变时不再赋值，避免中心附近左右跳。**同日再优化**：默认整卡拖影换成 `dragstart` 时 96px canvas 小拖影；dragover 用 rAF 合并（drop 前 flush），最近卡片只扫 `visible` 可视区；拖动中隐藏 hover 信息条过渡。
- **物理排序开关（2026-11-09，默认关）**：文件夹/资料库右键「✓ 排序同步文件名」。开启后手动换序会把同目录文件重命名为 `NN_原名.ext`（文件夹同理 `NN_原名`），资源管理器里也按此顺序；两阶段临时名避免互换撞名；改名时暂停 watcher（否则 rename 事件的旧路径会被当 unlink 删 DB 行），同步 DB 路径 / 缩略图缓存（按新路径 md5）/ dirMemory 键 / dirOrder 嵌套键 / 回收站 abs_path，完成后重开 watcher。默认关闭时顺序只写 `.picnest/meta.json`，不碰文件名。
- **隐藏排序编号（2026-11-09，默认开）**：顶栏 `01` 按钮（`lib.hideOrderNumbers`，持久化 `localStorage['picnest.hideOrderNumbers']`，只有 `'0'` 关闭）。只在显示层剥前缀，磁盘名不动；正则 `^(?:\d{1,3}|0\d{3})_+`——**只认下划线 + 1~3 位或 0 开头 4 位**，避免把 `2026-08-23` / `2026_08_23` 这类日期误当编号。覆盖网格 hover/文本卡、子文件夹卡片、树行/拖拽浮签、面包屑、详情图片名/文件夹 chip/移动下拉、查重结果、灯箱文本栏。改名时 `lib.renameTarget()` 会把原 `01_` 前缀接回去（关闭隐藏时按输入原样），不会因一次改名打乱物理排序。
- **帮助按钮（2026-11-09）**：顶栏 `?` 打开使用说明，15 节：排序与文件名（重点）/浏览选择/录入拖拽/详情/大图裁剪旋转/**简报模式**/**黑白预览**/筛选标签颜色/主题左栏/根元数据/查重（精确）/**AI 查重怎么做**（配置/模型/单价估算/上传同意/流程/停止/注意）/缩略图+插件库/**浏览器采集插件（安装/三种采集/重复三选一/注意事项）**/快捷键；Esc/遮罩关闭。**页头大标题也走 `lib.dispName`**（此前标题仍显示 `03_` 前缀）。
- **一键清除排序编号（2026-11-09）**：根文件右键「清除排序编号…」→ 危险色确认 → 主进程扫描整个根目录，把文件名/文件夹名里匹配同一前缀正则的部分去掉。**先子后父**（父改名不会让子路径失效），重名自动 `(2)`，跳过 `.picnest` 等点目录；watcher 暂停再重启；同步 DB 路径/缩略图缓存名/dirMemory 键/dirOrder 嵌套键与父级数组/回收站 abs_path；`sort_order` 不动（手动顺序保留）。物理排序开关仍开时，下次手动拖拽会重新加编号。实测临时根 3 文件 + 1 文件夹 → `Alpha/x.png`、`y.png`、`a.png`、`a (2).png`，`.picnest` 未动。
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
- **精确查重可取消**：`picnest-dup-cancel` + store `dupCancel()`；loading 区不分页签都有「停止」，关面板/切页签自动取消；取消后空态显示「已停止扫描」。每轮扫描开始重置 flag，`picnestMapLimit` 回调读盘前检查。
- **文件夹整包查重（合并/粘贴前）改为流式异步**：`picnest-dir-dup-check` 先同步收目录（仅元数据），再 `fs.promises.stat` + 流式 MD5（并发 4，per-scan Map 缓存同路径）；进度 `picnest-dir-dup-progress`；`picnest-dir-dup-cancel` 可停止。store 在 `mergeDirWithDupes` 期间显示底部浮条 `TaskProgress.vue`（「正在检查文件夹重复 done/total + 停止」，z870），弹重复三选一前收起；取消则 `paste()`/`importDrop()` 立即中断并标「已取消」。
- **拖入查重 / 采集查重**：`picnest-import-check`、`picnestCollectDupes` 也改流式 `picnestMd5Of`（不再 `readFileSync` 整文件）；`import-dir-copy` 内部同名同大小 MD5 仍同步（copy 本身同步，待整体异步化）。
- 结果：组按可省空间排序；每文件显示缩略图/文件名/所在文件夹/大小/时间；快捷「保留第一张 / 最新 / 最旧」（同内容尺寸相同，“最大”无意义），可手动勾选；默认不勾。
- 删除只走图巢回收站；确认卡列前 5 个文件名；删后组内 <2 自动消失、统计实时更新。
- **一键保留全部组**：`dupKeepAll(largest|newest|oldest)` 对当前模式的所有组统一保留，其余全部勾选；会覆盖当前勾选。每组原有的快捷按钮继续保留，并遵循同一套后缀规则。
- **不同后缀各保留一张**：勾选后组内每个后缀各留一张（按最大/最新/最旧选），jpg/jpeg/jpe/jfif 视为同一后缀、tif/tiff 合并；关闭则整组只留一张。偏好存 `localStorage.picnest.dupPreserveExt`，默认开启。
- **弹层关闭**：查重面板用右上角 ✕ 或 Esc 关闭；遮罩点击、底栏「取消」已移除，避免误触。AI 扫描中关闭（✕/Esc）会走 `aiCancel()` 并丢弃当前进度，属显式操作。
- 实测合成组：最大/最新/最旧、开启/关闭跨后缀的勾选结果均正确；遮罩点击保持打开，Esc 与右上角 ✕ 正常关闭，底栏无「取消」。
- 实测全库 6,724 文件 258ms（27 个同尺寸候选）→ 9 组 / 19 文件 / 可省 13.1MB。
- **AI 二次查重**（DupFinder 顶部「AI 查重」页签）：配置 OpenAI 兼容 `/chat/completions` 视觉 API（地址/模型/Key；Key 用 `electron.safeStorage` 加密存 `dataDir/picnest-ai.json`，**不回传渲染层**）；「保存并测试」用两张 64×64 色块验证视觉连通。
- **模型列表**：`GET {base}/models` 自动拉取（兼容填 base 或完整 `/chat/completions`；已输入未保存的 Key 也可用；去重排序最多 500 个），结果显示为可搜索的 datalist 供选择，仍允许手填；进入 AI 页签或保存配置后自动刷新，「获取模型」可手动重试。401/403 提示地址与 Key 不匹配，404 提示该地址无 `/models`；错误体里的 Key 统一打码。
- **推理模型额度**：MiMo / o 系列用 `max_completion_tokens=2048`，普通模型用 `max_tokens=1024`；MiMo 思考模式不传 `temperature`。空 `content` 会报 `finish_reason`、思考 token 数、是否只有 `reasoning_content`，避免只显示“无法解析”。
- **速度**：MiMo 聊天接口加 `thinking:{type:"disabled"}`（查重只需 JSON 判断，关思考后单次视觉测试 3.7s）；AI 比对 4 路并发，429/5xx 最多重试 3 次（1s/2s 退避）。本地 mock 1.2s/对 × 40 对 → 整轮 20.0s（hash ~7.8s + AI ~12.2s）；串行约 56s。并发可能触发服务商限流，失败会中止并显示错误。
- **流程**：范围同精确查重 → 缩略图 dHash（9×8 灰度 64-bit）→ 汉明距离 ≤10 生成候选对 → **32×32 色块 + 64-bit pHash 二次筛选**（色块差异 ≤128 且 pHash≤6；dHash≤4 的强结构对直接放行）→ 按距离排序，最多 `maxPairs` 默认 40、可调 1–200 → 候选对的 384px 白底 JPEG 缩略图发 API 问 `{same}` → 并查集成组。
- **筛选设计**：8×8 色块太粗（文字/小结构会被平均掉），32×32 能区分“同版式不同内容”；pHash 用 32×32 灰度 DCT 左上 8×8 低频中位数二值化，对缩放/JPEG 更稳，补上色块对文字版式不敏感的问题。dHash≤4 直接放行，避免误杀同图换色/轻微裁剪。stats：`dhashPairs / colorFiltered / candidates / colorLimit=128 / phashLimit=6 / colorBypass=4 / aiConcurrency=4`；UI 显示「dHash X 对 → 本地预筛后 Y 对，已查 Z」。
- **选型记录**：imagededup 的结论也是 dHash 最快、CNN 对裁剪/旋转最稳但重；实测 256-bit dHash / SSIM 也能分，但 256-bit 对轻微裁切更敏感、SSIM 需逐对算且更怕裁切；CLIP/CNN 语义相似会把“同角色不同图”拉进来，不适合作为精确查重预筛。当前 dHash→色块+pHash→视觉 AI 是成本/召回折中。
- **结果**：组带 AI 徽标；可省=sum−max（保留最大有意义，快捷「保留最大/最新/最旧」）；进度 `picnest-ai-dup-progress`（hash / ai 两阶段），可停止；只处理图片（跳过视频/文本），**只上传候选缩略图、不上传原图**；必须勾选允许上传才能开始；删除仍只走图巢回收站。
- 实测（本地 mock 视觉 API）：3 张测试图（128/64 同图 + 噪声图）→ 1 候选对、1 次 AI 调用、正确成组；配置返回 encrypted:true。模型列表 mock 返回 2 个模型 → datalist 可选、选中写回模型框；401 路径提示 Key 与地址不匹配且 Key 已打码。
- 实测 MiMo `mimo-v2.6-flash`（`https://api.xiaomimimo.com/v1`，7 个模型）：`/v1/models` 正常；视觉测试（两张异色 64×64）返回 `same:false`。此前 `max_tokens:80` 被思考阶段吃光，`content` 为空。
- **风险提示（2026-11-09）**：AI 面板底部小字（琥珀色 10.5px）提示「图片可能因暴露度较高或不符合所选 AI 的使用准则而被服务商拒绝/弹回；请自行甄别素材并确认该服务条款」。
- **费用/上传量预估**：AI 参数区「单价 ¥/1M tok」（可选，localStorage `picnest.aiPricePerM`）→ 按 maxPairs×2 张 384px 缩略图（≈45KB/张）与每对 ≈340 tokens 粗估「最多 N 对 · ≈X 张 / Y MB · ≈Z 元」；不填单价只显示上传量。结果头部在 `stats.capped` 时提示「候选超出上限，只查最接近的 N 对」。
- 实测本地预筛（Fate Grand Order material 1~9，3,372 张；本地 mock 视觉 API）：dHash 候选 4,145 对 → 色块+pHash 筛掉 4,041 对 → 104 对进入 AI 队列（减少 97.5%）；整轮 7.8s（hash+色块+pHash+40 次本地 AI 调用）。只上色块时是 286 对（减少 93.1%），pHash 再砍掉 63.6%。

### 缩略图（2026-11-09 修复）
- **缓存目录改为 `dataDir/picnest-thumbs`**（主进程补丁 P10）。旧 `dataDir/cache` 在 Windows 上与 Chromium 自己的 `Cache` 同名（大小写不敏感），浏览器缓存清理会把缩略图一起清掉；生产数据目录实测 340MB 只剩 `Cache_Data`。启动时 `picnestMigrateThumbCacheDir` 把旧目录里仍被 DB 引用的文件搬进新目录并改写 `thumbnail_path`，死路径直接清空。
- `picnest-images-by-dir` 发现 `thumbnail_path` 文件不存在时**同步清 DB**（旧版只清内存，导致每次查询都拿着死路径）。
- 资料库右键新增 **「修复缩略图…」**：先统计缺失数并确认，再 `picnest-repair-thumbs` 用 `ensureQuickThumb`（sharp / PSD / 视频）并发 2 生成，进度走 `picnest-thumb-repair-progress` + 底部浮条（可停止）；完事刷新列表。可见格子仍保留按需补图（一次最多 80 张）。
- 实测：4 张缺失 → 4 张补成 / 0 剩；全库 10,764 行从 10,450 个死路径清空后按需/批量重建。
- **网格显示图（2026-11-09）**：网格不再直接解码原图（>500px 大格原图可能 10MB+，Chromium 解码缓存预算会偶发 `EncodingError`/裂图）。大格优先 `picnest-display-thumbs` 生成的 1024px 有界缓存（`md5(path|d1024|modify_time)-d1024.webp`，sharp 生成、并发 2、失败返回空串），没有就先显示 400 缩略图；加载失败链：显示图/400 → 原图带 nonce 重试一次 → `.noimg.broken`（点击重试）。灯箱/详情预览也有「原图→缩略图→无法预览」降级。`img` 统一 `loading="lazy" decoding="async"`；gif 大格仍保留原图动画。
- **PSD 灯箱原图（2026-11-10）**：灯箱对 `.psd` 不再把原文件塞给 `<img>`（Chromium 解不了 PSD，只会 onerror 退回 400 缩略图）。新增 `picnest-psd-preview`：复用 `ensurePsdPng` 的整幅合成 PNG（ag-psd worker），缓存 PNG 比源 PSD 旧时先删再重建；`path.resolve` 统一路径避免同一 PSD 出现两套缓存。Lightbox 先显示缩略图占位，IPC 返回后切整幅 PNG；失败提示并回退缩略图。实测 `1.psd` 4203×5939，灯箱 natural 4203×5939，src 为 `psd-419e…png`（49MB）。缓存清理会保留 `psd-*` 文件。
- **网页检索结论（2026-11-09）**：Chromium 的 decoded-image 工作集默认约 128MB，单张 2700×4000 RGBA ≈ 40MB+，并行多张会触顶；`img.decode()` 的 `EncodingError` 不能当作文件损坏的可靠信号；最佳实践是网格只加载有界缩略图、原图只留给显式预览（灯箱），并用 onerror 做降级而不是把 decode 失败当永久坏图。

### 标签（2026-11-09）
- 表：`tags(id, name COLLATE NOCASE UNIQUE, created_at)` + `image_tags(image_id, tag_id, created_at, PK)`；迁移在 `picnestMigrate()`；图片永久删除由 trigger 清关联，软删保留（还原后标签还在）。
- IPC：`picnest-tags-list(folderId)` 返回当前根 `tags(count)` + `imageTags`（imageId → [tagId]）；`picnest-tag-assign({imageIds,name|tagId,action})`、`picnest-tag-rename({tagId,name})`、`picnest-tag-delete(tagId)`。标签名全局、ASCII 大小写不敏感；保留 `#` 前缀（兼容 Eagle `#白系`）、空白压缩、最长 60 字。
- UI：Inspector 单图标签 chips + 输入（回车/＋）；多选显示共同标签，添加应用到全部、× 从全部移除。FilterBar「TAGS」按当前根计数，多选为**任一标签**；搜索同时匹配文件名和标签名。
- 管理：FilterBar「管理」→ 点标签改名（NamePromptDialog）、× 删除（确认）；空标签只在管理模式可见，便于清理。
- 计数按当前根；关联按 `image_id`，移动/改名/软删不丢。实测：两图同标签 count=2、大小写合并、筛选/搜索/多选移除/改名/删除均通过，测试标签已清空。

### 简报 / 黑白 / 无标题栏大图
- **简报模式**：全屏黑底（页面级 `requestFullscreen`），单击下一张、←/A 上一张、→/D 下一张、Esc 退出；视频静音循环、文本占位；计数/提示/右上关闭。
- 简报**滚轮以光标为锚点缩放**（0.2–8×）+ 拖拽平移（4px 阈值，未拖动才算单击切图）；右键呼出上述图片菜单（简报 z-index 890 < 菜单 900）。
- **简报 PSD / 平移（2026-11-10）**：简报图片源改走 `mediaSrc`——PSD 用 `picnest-psd-preview` 的整幅 PNG（`new Image()+decode()` 预解码后才切，期间显示缩略图 + `brief-note`）；普通图失败退缩略图，再失败显示「图片加载失败」。平移不再逐 pointermove 写 `brief.tx/ty`，改成 rAF + `mediaEl.style.transform`（`translate3d`），松手才提交；媒体元素已有 `will-change: transform`。
- **灯箱右键**：图片/视频/文本舞台右键 → 同一套菜单；输入框/dock/裁剪层保留原生；灯箱 ←/→ 与 A/D 翻页（输入框/裁剪态不拦截，Ctrl+A/D 不误触）。
- **大图顶栏完全透明**：`.titlebar.lb-clear` 关闭玻璃/模糊/拖尾，只留悬浮控件；浏览模式仍保留全宽玻璃+拖尾。
- **大图底部 dock 完全透明**：`.dock.dock-clear` 关闭玻璃底/边框/阴影/模糊（裁剪条仍玻璃底）。
- 大图「适应」上下各留 **70px** 安全区（42 标题栏+20 拖尾+8；dock 46+16+8）；旧版 110 已废弃。
- **旋转/翻转写回**：图片 dock「保存」按钮（有未保存变换时高亮）→ `picnest-apply-transform`：sharp 先 flop 再 rotate（与 CSS 同序），原件备份 `picnest-thumbs/transform-backup-*`，原子覆写；更新尺寸/大小/mtime，清色板/缩略图并重生成；保存后复位。图片/视频/网格/详情 URL 统一带 `?v=modify_time` 强制刷新。
- **裁剪模式交互（2026-11-09 修）**：裁剪中滚轮仍缩放（crop 层随图片矩形按比例重映射）；选区外拖拽 = 平移图片（crop 框跟随内容），选区内拖拽 = 移动选区，手柄 = 缩放；`.crop-layer` cursor grab、`.crop-box` move、手柄 resize。`onDown` 只在选区内/手柄/cropAction 已激活时让位给裁剪层。

### 文本 / 视频
- 文本类白名单：`.txt .md .markdown .log .json .jsonc .csv .tsv .ini .cfg .conf .yaml .yml`；代码类不收。
- 文本缩略图：前 26 行 → **800×1040** 纸面 SVG → `cache/md5(path)-v2.webp`；2 倍渲染；DB 写 800/1040（仅排版）；外部修改懒失效（源 mtime > 缩略图+1.5s 清缓存）。
- 大图文本编辑器：UTF-8/BOM/UTF-16LE/GB18030 自动识别、保留 CRLF、1.5s 自动保存+Ctrl+S、关闭/翻页前 flush、>2MB 只读、冲突提示；GBK 保存转 UTF-8（工具栏提示）。
- 视频：`<video>` 自绘 dock（播放/进度/时间/静音/音量/循环/全屏），进入自动播放；滚轮缩放/翻页照旧；裁切/旋转/翻转隐藏；`loadedmetadata` 回填宽高。
- 详情：文本尺寸显示「文本」、隐藏色板；视频/文本预览用缩略图，不直链原文件。

### 采集（M6，2026-11-09）
- **自研开源 MV3 扩展** `extension/`（开发者模式加载；Edge/Chrome **同一份代码**，Chrome 137+ 已禁用 `--load-extension`，用 `chrome://extensions` UI）：右键图片「保存图片到图巢」、右键页面「保存页面截图到图巢」；popup 选「根文件 / 保存到」，选择全局有效。**重载扩展后已打开的网页必须刷新**——旧 content script 的 `chrome.runtime` 会失效，按住面板会提示「扩展已更新，请刷新此页面」（不是服务端问题）。
- **网页内按住采集**（2026-11-09）：网页图片上左键按住 380ms（光标处环形进度）→ 双栏面板：左大片「未分类/库根」，右 = 当前根下**全部文件夹**（缩进列表，原生滚动）；**面板固定白底**（不随浏览器暗色，任何主题页面都清晰）；左块用移植的 PicNest FolderIcon 几何（Wenku8 `archive_icon_fold_art`，GPL-2.0-or-later，来源见 `content.js` 注释），**面板打开 / 悬停未分类时播放 640ms 弹簧手势**；拖到目标松开保存；松开在面板空白则面板停留可点击；提前移动 >6px 取消，不影响页面自身拖拽/点击；Esc/点外部取消。Shadow DOM 注入，只挂主 frame 的 `<img>`；popup 可关闭该手势。**覆盖层 DIV 挡住图片时用 `elementsFromPoint` 按坐标找底层可见 `<img>`**（Pinterest 实测）。**2026-11-10 补**：Pinterest 现在会给 `<img>` 设 `pointer-events:none`，`elementsFromPoint` 会直接跳过它（实测设置后 `includes(img)` 变 false）；`imgAtPoint` 增加几何扫描兜底（`document.images` 里找包含该点、面积最大的可见图）。面板行选择增加 `rowAtPoint`/`panelAtPoint` 坐标兜底，兼容站点 `setPointerCapture` 把事件重定向到页面元素；扩展版本 `0.1.1`。**同日再补**：切回旧标签（Edge 睡眠标签/bfcache/扩展重载遗留页）时 content script 可能根本不在，点图片不会触发注入，刷新才恢复；`background.js` 现在在 `tabs.onActivated`、`tabs.onUpdated`（complete/url 变化）以及 `onStartup`/`onInstalled` 主动 `executeScript` 补注入，`content.js` 守卫保证幂等；扩展版本 `0.1.2`。**v0.1.3 再补**：content.js 只有全部监听器注册成功后才置 `Loaded`/`Version`（避免半初始化被守卫挡住）；background 先 `executeScript(func)` 探测再注入，失败 350ms/1200ms 重试两次，并监听 `onActivated`/`onUpdated`/`onHighlighted`/`windows.onFocusChanged`；service worker 启动即补 Pinterest 标签（1.5s/4.5s 再补），不依赖 onInstalled。**更新后需在扩展页重载并刷新一次已打开的 Pinterest 页**。**v0.1.4（2026-11-10）**：v0.1.3 的探测/重试仍会被页面里的旧脚本守卫挡住（旧版已置 `Loaded` 无 `Version`，新脚本注入后直接 return），刷新一定好正是这个原因。改为版本化探测对象 `{loaded, version, alive, healthy, cleanup}`：content.js 从 0.1.4 起在**所有监听器注册后**挂 `__picnestHoldCollectCleanup` / `__picnestHoldCollectHealth`（health 用私有事件确认 document 监听器仍活着），新版注入时若发现旧实例有 cleanup 就**先清理再原地重建**；无 cleanup 的极旧脚本、扩展更新后失去 runtime 的孤立脚本（`alive=false`）、监听器失效（`healthy=false`）→ **仅 Pinterest 标签自动 `tabs.reload` 一次**（`chrome.storage.session` 按 tab+URL+版本记标记防循环，其它站点不动），刷新后 onUpdated 自动再注入。popup 顶部新增「本页采集」状态与「修复本页」按钮（缺脚本→注入；旧版带 cleanup→原地重建；否则刷新），后台消息 `collect-status` / `collect-repair`。无头测试：`node tools/test-collect-script.mjs`、`node tools/test-collect-background.mjs`（守卫/接管/cleanup/孤立/一次性刷新/状态/修复全覆盖）。
- **主进程本地服务** `127.0.0.1:41600`（`picnest-handlers.js` 的 M6 块）：`/api/v1/ping`、`context`、`folders?rootId=`、`folder/create`、`save`。只写目标根内的文件（`picnestCollectTarget` 防 `..` 逃逸）；写入后 `insertImagesBatch` + `sync-db add` 事件，渲染层自行补缩略图/尺寸；新建文件夹在库根 mkdir（非法字符清理、同名自动 `(n)`），发 `sync-db {type:'dirs-changed', rootId, rel}`，store 收到后 `refreshTree()`；`url/annotation/star` 写 DB。下载外部图片时带**页面 Referer + 常规 Edge/Chrome UA**（Pixiv `i.pximg.net` 防盗链必需；扩展传的 `url` 即页面 URL）。
- **采集面板新建文件夹**：右栏底部「＋ 新建文件夹…」→ 内联输入 → `folder/create`（当前根文件的库根）→ 新夹追加进列表并高亮，**点击新夹即保存**；同名自动加序号。暂不支持在子文件夹下新建。
- **安全**：绑定 127.0.0.1；Origin 只放行 `chrome-extension://` / `extension://` / 本机 localhost 页面；CORS + Private-Network 预检；**暂无 token**（开源发布前补）。
- **目标根跟随活动根**：store `syncCollectRoot()` 在 init / addRootByPath / switchRoot / removeRoot 调 `picnest-collect-set-root`；扩展可另选根（服务端 `picnestCollectRootId`，默认第一个）。
- **Eagle 兼容层暂缓**：只读调研确认 Eagle for Edge 3.1.29 用 `41595`（library/folder/tag/item addFromURL）+ `41593`（form：image / save-url / screen capture / import-images）。但 Eagle 运行时会占这两个端口（不能共存），且闭源扩展 EULA 需在开源前核实；协议事实记录在此，代码不抄、不捆绑。未来作为「Eagle 关闭时可选开启」的桥。
- **采集查重**：服务端写入前按「同根 + 同 file_size」筛候选（≤6）→ MD5 确认；命中则不落盘，返回 `duplicate` + matches（文件名/所在夹）。按住面板显示「图库里已有相同图片」+ **跳过 / 覆盖旧图 / 仍然保存**：覆盖=先写新图，成功后把旧匹配项软删（`deleted_at`，进图巢回收站）并发 unlink，物理文件保留可彻底删除；仍然保存=`force:true` 保留旧图再存一份。右键存图与页面截图只提示跳过（通知/文案）。只查目标根内、未软删；历史已有重复需用应用内查重清理。
- 扩展 v0.1 边界：图片 + 可见区域截图；不支持整页滚动/视频/PDF；扩展暂不带标签（标签系统已有，采集链路未接线）；服务端下载不带 Cookie，防盗链图片可能失败；按住采集只支持主 frame 的 `<img>`（跨域 iframe、CSS 背景图暂不做）。

### 插件（P1/P2，2026-11-09）
- 入口：侧栏底部 **「插件库」**；面板两页签 **已安装 / 插件仓库**。数据在 `dataDir/plugins/<id>/`（dev：`app/_internal_data/plugins`）。
- **theme 插件**：`plugin.json type=theme` + CSS 入口（≤512KB），启用后注入 `<style data-picnest-plugin=id>`（在应用样式之后）；停用/卸载移除。示例 `examples/plugins/mono-mint`。
- **renderer 插件**：单文件 HTML 入口（≤2MB），宿主用 `<iframe sandbox="allow-scripts" srcdoc=…>`（**无 allow-same-origin、无 Node、无宿主 DOM**）+ postMessage 桥。协议见 `examples/plugins/README.md`：`ready / init / event / query-images / storage-get/set / fetch / close`。
- **权限**（清单声明、宿主逐调用校验）：`ui.panel`（显示打开面板）、`data.images.read`（只读当前资料库 ≤500 行）、`events.read`（selection-changed / view-changed / image-opened / image-closed）、`storage`（插件私有 JSON ≤5MB）、`net:<origin>`（主进程代理 fetch，15s/2MB）。`query-images` 的 folderId 由宿主填当前活动库，插件不能跨库。
- **安装**：文件夹安装（系统选目录）；registry 安装（http(s) 或本地 `registry.json`，download 支持 URL/绝对路径/相对 registry 路径，sha256 校验，zip 50MB / 解压 200MB / 路径穿越防护）。安装/更新直接替换 `plugins/<id>`；卸载删目录并从启用列表移除。
- **主进程插件（type=main）只登记不运行**，管理页显示「P3 未启用」。
- 示例与开发指南：`examples/plugins/`（`mono-mint` 主题、`view-stats` 沙箱面板、`registry.json`、zip、README）。
- 实测：文件夹安装两例成功；theme CSS 437B 注入/停用移除；renderer 面板 srcdoc 5502B、bridge 收到 `ready` + `query-images#1/#2`；`query-images` 返回 3 行；storage set/get 正常；本地 registry 解析 2 条；zip 安装 + sha256 通过；最后已卸载示例，插件目录为空。

### 应用名 / 任务栏（2026-11-09）
- 软件名统一 **PicNest 图巢**：窗口 title、`package.json`（name/productName）、`app.setName`/`setAppUserModelId`、托盘 tooltip/菜单、crashReporter、wmic 进程名、exe VersionInfo（FileDescription `PicNest` / ProductName `PicNest 图巢` / OriginalFilename `PicNest.exe`）全部改过；exe 原件备份 `app/PicNest.exe.picrand.bak`。
- **任务栏按钮组标签不是窗口 title**：只改 title/AppUserModelID 仍会显示旧名；必须给窗口 `win.setAppDetails({ appId: "PicNest", relaunchDisplayName: "PicNest", appIconPath: …icon.ico })`（见 handlers 的 `browser-window-created`），Windows UIAutomation 才会显示 `PicNest - 1 个运行窗口`。
- exe 的图标与 VersionInfo 用临时安装的 `resedit`（纯 JS PE 资源库）修改；`app/` 目录被 gitignore，打包/重新复制原始 exe 时需要重跑这一步。

### 关闭 / 托盘（2026-11-09）
- **两段式关闭**：点主窗口 X / Alt+F4 **只隐藏到托盘**（P13a：`preventDefault()` + `mainWindow.hide()`）；窗口从任务栏消失、进程与托盘图标保留。**托盘菜单「退出」才彻底结束进程**（先 `allowClose = true` 再 `app.quit()`）。不要把 close 改成直接退出，否则会丢掉“隐藏到托盘”的语义。
- **退出顺序**：P13b 的 `window-all-closed` 必须**先 `tray.destroy()`**，再用 try/catch 跑 `cleanupOnExit()` / `closeDatabase()`，最后无条件 `app.exit(0)`。原实现先清理，任一步抛错就会跳过托盘销毁和退出——表现为退出后托盘图标/进程滞留、需要再点一次退出。
- **托盘菜单**：P12 已移除原 PicRand 的「新建/隐藏/显示/关闭参考板」四项（PicNest 未实现参考板），只保留「显示 PicNest 图巢 / 退出」。

### 窗口拖动（2026-11-10）
- **用 Windows 原生拖拽区**：`.bar-content`、`.brand`、`.page-head` 设 `-webkit-app-region: drag`；交互控件（button/input/a、`.vo-wrap`、`.zoom-slider`、`.search`、`.bar-controls`、`[data-no-drag]`）设 `no-drag`。窗口位置由系统移动循环驱动，不再逐 mousemove IPC `setBounds`，非 100% DPI 下也不会重排/掉帧；双击空白由原生处理最大化。
- **不要再加**渲染层 `mousedown -> startWindowDrag / windowMoveBy` 路径（旧的 `ui/src/lib/winDrag.js` 已删除）；旧 IPC 仍留在主进程但无 UI 调用。新增顶栏/页头控件时记得给它 `no-drag`，否则会被当成标题栏拖走。

### 拖出到外部应用（CSP / PS，2026-11-09）
- **统一手势**：只有一种拖动。窗口内 = HTML5 内部拖拽（落点高亮/排序/移动）；把图拖出 PicNest 窗口 = `picnest-drag-begin` 的轮询检测到光标离开（外扩 4px、连续 2 次、左键仍按下）→ 主进程 `webContents.startDrag({ file, files, icon })`，可拖进 Clip Studio Paint/Photoshop/资源管理器。多选后拖其中一张会带全部选中文件。
- **为什么不在 dragstart 直接 startDrag**：Windows 上 `startDrag` 与 HTML5 内部拖拽互斥（electron#7118）；在 dragstart 调用会让内部高亮/排序失效。现在先保留 HTML5，离开窗口后才升级。
- **轮询**：`picnest-drag-begin` 拿 `BrowserWindow.fromWebContents`，45ms 轮询 `screen.getCursorScreenPoint()` 与 `win.getBounds()`，并用 koffi `GetAsyncKeyState(VK_LBUTTON)` 确认左键还按着；`picnest-drag-end`（页面 dragend）清理。升级后发 `picnest-drag-out-start`，`startDrag` 返回后发 `picnest-drag-out-end`。
- **落回保护**：`ui/src/lib/dnd.js` 的 `markNativeDragOut()` 在 out-start 时置标记；`App.vue` 捕获阶段吞掉 `dragenter/dragover/drop` 的 Files，拖动途中落回 PicNest 不会弹「重复添加」。out-end 后延迟 500ms 清标记；60s 兜底。
- **图标**：首图是 png/jpg/webp/gif/bmp 时用它生成 96px 拖拽预览；PSD/视频/文本/失败回退 `_internal_data/icon.png`。
- **验证**：普通拖动（不按任何键）从网格拖出窗口 → 外部 WinForms 文件拖放目标收到真实文件路径；主进程日志 `begin → escalate → startDrag returned`；落回不再弹重复添加。实际 CSP 画布接收需人工确认。
- **已知限制**：升级判定基于 PicNest 窗口 bounds + 左键；若另一个窗口覆盖在 PicNest 内部、光标坐标仍在 PicNest 范围内，不会升级。遇到这种情况把目标窗口拖到 PicNest 外侧即可。

### 详情 / 视觉分层
- **灯箱平移（2026-11-10）**：拖动期间不要逐 mousemove 写 `lib.viewer.tx/ty`（会触发 Pinia/组件重渲染 + 裁剪 watcher）。Lightbox 的 `pan` 普通对象记录 base，`onMove` 用 rAF 合并，普通模式直接改 `imgEl.style.transform`，松手 `commitPan()` 才提交 tx/ty；裁剪模式仍逐帧写 store 以带动裁剪框。`.stage` 用 `will-change: transform / backface-visibility: hidden`。PSD 整幅 PNG 先 `new Image()+decode()` 预解码，成功后才切 src，期间保持缩略图。
- **2048 视口预览（2026-11-10，Eagle 参考）**：灯箱/简报适配视图不再直接合成 25MP 整幅图。新增 `picnest-view-preview` 生成 `view-<md5(abs|2048|mtime)>.webp`（PSD 先走整幅 PNG，再 sharp 缩到 2048；GIF/SVG/视频/文本跳过）。Lightbox 在 `scale×max(w,h) > 2200` 或裁剪时换原图/整幅 PSD；Brief 在 `scale ≥ 2` 换原图。`<img>` 显式 `width/height = meta` 保证预览→原图不改变布局；预览先预解码再切。实测 2048 平移 avg 5.6ms / p95 ≈6.1–6.2ms、0 帧 >33ms（全幅图 p95 55.6ms）。高倍仍会换原图，Eagle 式 canvas 瓦片是后续终极方案。
- **Canvas 视图舞台（2026-11-10，clean-room）**：`ui/src/components/CanvasStage.vue` 用整窗 canvas + DPR，按 scale/tx/ty 只 `drawImage` 可视源矩形；preview 先加载、full 在 `useFull` 时懒加载、fallback 缩略图兜底，`fitMode` 给简报按视口适配。Lightbox 在非裁剪/非旋转/非翻转/非 GIF/SVG 时走 canvas（其余 `<img>` 保留裁剪/旋转坐标逻辑）；Brief 图片默认 canvas，GIF/SVG 退回 `<img>`。PSD 4203×5939：Lightbox 适配/1:1、Brief 适配/2× 平移均 avg 5.7ms、p95 ≈6.1–6.3ms、0 帧 >33ms。**只参考 Eagle 行为，未复制其代码/常量/worker；提取文件已删。** 当前不是多级 tile cache，超大图 first full 解码与裁剪/旋转回退仍有成本。
- **拖动中滚轮缩放抽搐（2026-11-10）**：pan 的 `baseTx/baseTy` 在 pointerdown 冻结；wheel 改 scale/tx/ty 后下一次 pointermove 仍从旧 base 算，会把锚点缩放顶回去。修法：wheel 时若 pan 活跃，先落当前位移到 store → 光标锚点缩放 → 把 pan `start/base/cur` 全部重设到当前光标/新值 → 取消挂起 rAF 立即重绘；Lightbox 同时补上光标锚点缩放。新增顶栏/视图手势时不要保留“拖动中改 scale 但不重设 pan base”的写法。

- 单选图片：预览/名称/注释/色板/评分/文件夹/操作（**URL 输入栏已删，DB url 字段保留**）。**图片的「文件夹」chip 必须由 `file_path` 反推**（`relOfImage`），不能用 `currentDirRel`——根文件夹开「显示子文件夹内容」或合并视图时，视图位置≠图片所在夹（否则子夹图片被标成库根）。
- **灯箱详情是第二个 Inspector 实例**（`.insp-overlay` 新挂载）：`selectedPath` 的 meta/色板 watch 必须 `{ immediate: true }` 才能拿到当前选中项；`lib.palettes[p]` 的**空数组**必须视为未命中（`ensurePalettes` 用空数组标记 SKIP/失败），否则灯箱色板永远显示「—」。
- 多选图片：前 4 张扇形堆叠 + 已选 N + 批量注释/评分/文件夹 chips/移动/复制；单选/多选文件夹三态。
- 详情浮岛 right/bottom 10，竖向玻璃渐变（0.97 → 0.93@46% → 0.86@74% → 0.60）+ blur(22px)。**顶缘 top 40**（面板相对）：压进玻璃顶栏 2px、停在右上角窗控按钮下缘（39）之下；分层 `玻璃 20 < 详情 24 < 裁剪层 30 < 裁剪条 40 < 栏内容/窗控 45`——`.titlebar` 不建 z 上下文，`.glass`/`::after` z20、`.bar-content` z45（**裁剪时左上返回/右上窗控必须优先于裁剪层**）。
- **左栏开合（2026-11-09）**：窗控组最左（详情按钮左边）新增 sidebar 按钮，`AnimIcon name="sidebar"`（收起时分隔线左移、列内线段淡出；挂载/悬停/`iconShake` 集体晃动都走同一套弹簧）。`lib.sidebarCollapsed` 持久化 `localStorage['picnest.sidebarCollapsed']`；收起时 SideBar 宽度 0 + padding 0 + opacity 0，`ResizeHandle` 隐藏，主面板自动铺满；展开恢复 `sidebarWidth`。
- **动效图标幅度（2026-11-09 加码）**：`grid` 四格上浮 2.8（原 1.3 被判不够）；`sidebar` 面板 1.4 / 分隔线 2.4 / 短线 1.2 / 收起位移 -5.4px。**Feb 口径：动效幅度宜大不宜小，第一版宁大勿小**（与滑尺波浪同教训）。
- **插件系统**：P1/P2 已实现（theme + renderer 沙箱 + 插件库/registry zip 安装），详见上文「插件」小节与 `docs/PLUGIN.md`；main/P3、签名/在线默认仓库未做。
- **三向尺寸拖拽**（InspResize）：左缘宽、顶边高、左上角自由变换；支点固定右下；高度 0=自适应满高，双击顶边/角柄恢复满高。
- **窗口收缩时详情高度必须钳制（2026-11-09 修）**：`inspectorHeight` 是用户偏好（如最大化时 1137px），窗口变矮后不能直接套用，否则浮岛从底部往上顶出视口、顶部内容被窗控盖住。App 用 `ResizeObserver` 监听 `.browse` 高度，`--insp-h = min(偏好, browseH-50)` 只作用于显示（偏好值不改），窗口放大自动恢复；InspResize 起拖用当前显示高度而非偏好值，避免跳变。
- **详情打开时正文真让位**：`.browse.insp-open` 提供 `--insp-reserve`，`.grid-viewport` padding-right 消费；**不要再给 ImageGrid 传 class（fragment 根会丢），也不要让卡片条二次扣详情宽**。
- 主面板 `margin: 上/右 8px、下 22px、左 20px`（上/右收紧让窗控按钮贴角；下/左保留孤岛水带）+ `--shadow-float`（2026-11-09 按 Feb「增强正文孤岛感」加深一档）+ 顶部高光；底座 `#eee7da`；圆角主面板 6 / 浮岛 14（既有定稿，勿改）。改 margin 要同步概览滑尺的 `right/top/height`（窗口 fixed，现 6/70/calc(100vh-100px)）。
- **左栏底子白光**：`.sidebar` 顶部 `--sidebar-glow` 白色渐变，150px 渐隐回 `--bg`（范围≈品牌区+「全部」行，图二口径）；暗色主题 `rgba(255,255,255,.07)`。
- **网格卡片浮岛**：每张图常驻 `--shadow-tile`（近影+中影+柔光）、`--tile-edge` 顶缘高光、圆角 12；hover 抬升 3px + `--shadow-tile-hover`（`--ease-overshoot`）；选中环叠在浮岛影上，子文件夹封面同款。`.wi` 入场波用 `animation-fill-mode: backwards`（`both` 会永久压住 hover transform）。
- **灯箱退出保留浏览位置**（2026-11-09）：浏览区不再用 `v-show`（`display:none` 会丢 `.grid-viewport.scrollTop`）；改为始终留在布局，灯箱打开时加 `.lb-behind`（`position:absolute; inset:0; visibility:hidden; pointer-events:none`），关闭后原滚动位置原样恢复，与简报覆盖层退出效果一致。
- **沉浸模式不做浮岛**：灯箱图片/视频 `.stage` 无投影、无圆角，平面贴在正文上；简报 `.brief img/video` 显式 `box-shadow:none; border-radius:0`。浮岛/抬升只属于浏览网格卡片。
- 顶栏**不要**改成浮岛：试过（c7b0844），Feb 当场要求回调（f90daf8），保留全宽玻璃+20px 拖尾。
- 随机自弹已移除；入场波 520ms；滑尺 48 槽 cos² 波峰 + 单条金色 dash。

### 主题
- 顶栏 **☀/☾/◐ 按钮** → 六选一弹板：**跟随系统 / 暖砂 / 靛夜 / 灰白（低饱和） / 炭黑（低饱和） / 墨黑（低饱和）**；持久化 `localStorage['picnest.theme']`。暖砂=原暖米+金浅色，靛夜=原蓝紫夜+金深色。三个顶栏按钮（漏斗/布局/主题）`vo-wrap` 改 flex 对齐，盒子统一 29×28。
- **跨运行方式记忆**：主题同时写 `config.json` 的 `picnestTheme`；`theme.js` 启动后从 config 对齐并回写 localStorage。localStorage 按 origin 隔离（dev `127.0.0.1` / 生产 `file://`），只靠它会看起来“换种启动方式就丢主题”。
- 主题按钮动效：同一套 `springAt`（640ms，旋转 16° + 缩放 1.10 峰值），挂载/hover/mousedown/换主题/`iconShake` 集体晃动都会播放——不是 SVG 层图标但绑进集体动效总线。
- `ui/src/lib/theme.js`：auto 模式读 `matchMedia('(prefers-color-scheme: dark)')` 并监听变化，**解析到 `mono-light`（灰白）/ `mono-dark`（墨黑）**；解析结果写 `<html data-theme="light|dark|mono-light|mono-charcoal|mono-dark">` + `style.colorScheme`（light/mono-light → light，其余 → dark）；五个主题各有 token 块（light 为 `:root` 默认，其余按 `data-theme` 覆盖）。
- **低饱和黑白**：`mono-light`（中性灰白）/ `mono-charcoal`（比墨黑浅一档的中性灰）/ `mono-dark`（中性近黑），强调色也去饱和；默认文件夹图标走 `--folder-default` token（普通主题金、黑白主题灰）。**黑白主题只改界面，不改图片/色板内容**。
- **概览滑尺是 canvas**：`ImageGrid` watch `theme.resolved` → `queueRuler()` 重绘，否则换主题后 dash 还是旧 `--accent`。
- `ui/index.html` 内联脚本在首屏样式前落定 `data-theme`，防止强制模式闪白；运行期由 theme.js 接管。
- 新增颜色必须同时补 light `:root`、dark、mono-light、mono-dark 四块；组件里不要直接写 `@media (prefers-color-scheme)`。

### Eagle 库迁移（M7，2026-11-09 本库已执行）
- **结论**：不直接索引 `.library/images`。Eagle 把文件平铺在 `images/<id>.info/`，文件夹层级只在 `metadata.json`，直接登记会丢整棵树；物化成普通文件夹树。
- **工具** `tools/eagle-migrate/`：`migrate.mjs`（默认 dry-run，`--apply` 完整复制，`--json` 给向导预检）、`import-meta.cjs`（URL/注释/评分/标签）、`import-thumbs.cjs`（Eagle `_thumbnail.png` 预置缓存）、`gen-missing-thumbs.cjs`（400px 并发补缺）、README。
- **应用内向导**：根文件 ⌂ 选目录 → 主进程 `picnest-eagle-inspect` 检测 `metadata.json` + `images/*.info`；普通目录原样加根，Eagle `.library` 才弹 `EagleImportWizard`。向导预览（条目/大小/文件夹/重名/未归类/标签 URL/空间）→ `picnest-eagle-copy`（复制 + 预置缩略图，进度事件）→ 渲染层 `addRootByPath` 索引 → `picnest-eagle-finish`（URL/注释/评分/标签写 DB，复用缩略图）→ 完成页；支持取消复制、目标已存在/已导入检测、同名根自动显示 `（Eagle）`。IPC/preload：`picnestEagleInspect/Copy/Finish/Cancel` + `onPicnestEagleProgress`。
- **本次实测**：源 `D:\OneDrive\好图\好图.library`；目标 `D:\图巢迁移\好图`；根 id 456，显示名改为 `好图（Eagle）`（物理文件夹仍按库名 `好图`）。11,365 活跃条目 → 11,372 个目标文件（7 个多文件夹各两份）→ 18.25GB；2 个 PDF 已复制但 PicNest 不索引。293 未归类 + 40 个全部文件夹引用失效 → `_未分类`/`_未分类\失效文件夹`；16 个多文件夹条目有一个失效引用（放有效文件夹）；589 个目标路径重名加 `(2)` 后缀。
- **元数据**：导入 23 个标签（保留 `#白系` 等原名）、2,538 个 URL、1 条注释、1 个评分，共 411 条标签关联；`metaUpdated` 2,544。
- **缩略图**：预置 8,654 张 Eagle 缩略图，另用 sharp 生成 2,500 张；当前 11,370 个索引行全部有缩略图。
- **回滚**：PicNest 移出目标根（只删索引）→ 删除 `D:\图巢迁移\好图`；Eagle 原库只读未动。
- **后续**：增量同步、PDF 索引、多文件夹条目在 UI 中的重复提示；打包时需把 `tools/eagle-migrate/` 一起分发（当前向导从项目根调用脚本）。

## 三、数据模型 / 关键约束

- `images.sort_order`；`images.trash_group`；`picnest_trash_folders(id, folder_id, rel, abs_path, trash_path, name, image_count, size, deleted_at)`。
- **sortMode 全局**（localStorage）；`sort_order` 各自存；每文件夹独立排序模式未做。
- **dirOrder 键 = `${folderId}|${rel || "__root__"}`**（多库隔离）；旧全局键启动时复制到每个库，读取只认新键。
- **dirMemory 键也改为 `${folderId}|${rel || ""}`**（2026-11-09）：`picnestMigrateDirMemoryKeys` 把旧全局 rel 键复制到每个根（已有根键不覆盖）；渲染层 `refreshTree` 只取当前根切片（rel 键），`patchDirMemory` 必须带 `activeRootId`；目录改名走 `picnest-dir-memory-rename` 整体搬键。
- **根文件元数据 `.picnest/meta.json`**：导出前必须确认根目录真实存在（避免 `D:xxx` 这类 drive-relative 垃圾路径建目录）；`picnest-root-meta-ensure` 只在缺失时创建；移出根文件前、`before-quit` 都会兜底导出。导入只按相对路径匹配当前索引，找不到的条目保留在文件里不报错。
- **缩略图缓存目录 = `dataDir/picnest-thumbs`**：禁止改回 `dataDir/cache`（与 Chromium `Cache` 撞名）；新增缩略图生成必须写这里，缓存文件名 = `md5(file_path) + ext`（`discoverThumbnailPath` 的寻址规则）。
- 文本缩略图/读取/保存、查重 IPC、rotate/flop IPC 见 PLAN 对应条目；**新增 IPC 必须 main / preload(apply.mjs P4b) / api.js 三处同步**。
- Pinia 响应式数组过 IPC 先 `[...arr]`（否则 structured clone 报错）。
- `ImageGrid` 是 fragment 根（canvas+viewport）：App 传 class 会丢；布局让位用 CSS 变量；`loadImages` 会清选中，本地增量别调它。
- **DirContextMenu 节点包装层**：`lib.openDirMenu(e, { rel, node, isLibrary?, absPath? })` 的 `menu.node` 是包装对象，实际节点在 `.node`。根文件操作（移出/重命名/导出/排序/复制/粘贴/查重）必须用 `menuNode = menu.node?.node || menu.node`；直接读 `menu.node.id` 会得到 undefined（曾导致「移出根文件」点击无反应）。
- 图片/视频/网格/详情 URL 带 `?v=modify_time`；文本缩略图同；`file://` 带 query 可正常加载。
- 内部移动/排序设 `suppressSyncUntil` / `suppressWaveUntil`；`_loadGen` 防过期加载。
- `window.picrand` 是 contextBridge 只读对象：不能替换方法做 spy（会静默失败）。
- **Vite dev 模板缓存**：新增组件/菜单后 Page.reload 可能不生效；fetch `/src/App.vue`、`/src/components/ContextMenu.vue` 看编译结果；重启 Vite+应用兜底（已开 polling）。
- **三份同形 worker 模板**（oversize/scan/stats）：改扫描后缀必须 P9a/P9d/P9e 都确认；watcher 单独 P9b。
- Chromium 内部拖拽带 `text/uri-list`：外部判定必须先看 `x-picnest-*`（`lib/dnd.js`）。
- 文本/视频/图片后缀判定：`ui/src/lib/fileKinds.js` 与 handlers `PICNEST_TEXT_EXTS` 同步。

## 四、未做 / 技术债

### P0 发布前
- **Eagle 向导打包**：向导主进程从项目根 `tools/eagle-migrate/` 调脚本；打包版必须把该目录随 app 分发，或在主进程内置迁移逻辑，否则打包版向导会找不到脚本。
- **开源发布准备**：README/截图/构建脚本、许可证与第三方声明（PicRand GPL-3.0、Wenku8 GPL-2.0-or-later）、扩展打包、去除个人路径/示例库/测试数据。**详细交接与优先级见 `docs/HANDOFF-GEMINI.md`**（含 `app/` 源码缺口、对应源码方案、隐私清理清单）。
- **查重收尾（余项）**：AI 候选超过上限时目前只查最接近的 200 对、不做多轮分批；`import-dir-copy` 的同名同大小 MD5 与整体 copy 仍是同步（超大文件夹拖入会卡主进程）；AI 定时后台扫描未做。

### 元数据 / 物理排序 / 缩略图（2026-11-09 新增）
- 元数据导入目前是“文件覆盖 DB”：只在添加根时导入一次；外部同时改 PicNest 时以最后一次加根为准，无冲突合并/双向同步。
- 物理排序无撤销、无预览；开启后每次手动拖拽都可能改名（每个目录全量重命名）。建议只在小文件夹开启；改名前不弹确认。
- 全库缩略图批量修复是单次全量任务（并发 2、可停止），10k 图预计数分钟；停止后再点会重新统计缺失，无断点续跑。
- 物理改名对符号链接/权限不足目录只记错误继续，不回滚整批；极端情况下可能残留 `__pn_tmp_*` 临时名（可手动改回或再跑一次排序）。

### P1 后续
- **Eagle 迁移后续**：增量同步、PDF 索引、多文件夹条目 UI 提示（当前 7 条完整多夹、16 条部分失效、2 条 PDF 未索引）。
- **标签 v2**（使用频率低，后置）：采集带标签、标签颜色、层级/合并。
- **采集**：token 鉴权、整页滚动截图、视频/标签、跨域 iframe/CSS 背景图、Chrome 安装包。
- **AI 查重**：费用预估、定时后台扫描；本地 CLIP/embedding 暂缓（语义方案会混入同角色不同图）。

### 采集 / 扩展
- 采集 token 鉴权；整页滚动截图、视频、标签；跨域 iframe/CSS 背景图；Chrome 安装包/说明。
- Eagle 兼容层（41595/41593）明确暂缓：Eagle 运行时占端口、许可/兼容风险；自研扩展已覆盖主流程。

### 体验 / 稳定性
- 尺寸/评分排序 SQL 补全（目前前端排序）；滑尺 hover 预览；既有同名副本「合并到同名文件夹…」。
- 目录删除确认细化（是否「删除并清空回收站」）；大图视频帧步进（Eagle Ctrl+←/→ 未做）。
- 手动封面若对应文件被外部删除/改名，卡片可能裂图（未做自动回落）；旋转/翻转对 GIF 可能丢失动画（sharp 单帧）。
- `picnestDirOrder` 只记顺序，不记“每层用名称还是时间排”的模式；**每文件夹独立排序模式已明确不做**（默认手动排序，避免混乱）。

### 工程 / 开源
- 打包时一并携带 `tools/eagle-migrate/`；去除个人路径/数据后再公开仓库。
- AI 本地 CLIP/embedding 离线方案、定时后台扫描（暂不急；当前 dHash→色块+pHash→视觉 AI 已够用，语义方案会混入同角色不同图）。

## 五、关键文件地图

| 文件 | 职责 |
|---|---|
| `ui/src/stores/library.js` | 全部状态/动作：资料库、树、录入、选择、排序/增量、复制粘贴、回收站、浏览历史、详情、查重、简报/灰度/封面/变换 |
| `ui/src/lib/winDrag.js` · `iconMotion.js` · `wave.js` · `fileKinds.js` · `dnd.js` · `theme.js` | 手动拖窗（顶栏 drag-surface + 左栏图巢标签）· 图标弹簧/集体晃动 · 入场波 · 文本/视频后缀 · 拖拽载荷分类 · 主题解析切换（auto/light/dark → data-theme） |
| `ui/src/components/TitleBar.vue` | 顶栏：面包屑/历史/筛选/布局/缩放/搜索/窗控；大图模式 `.lb-clear` 透明 |
| `ui/src/components/SideBar.vue` · `DirTreeItem.vue` | 根文件+视图入口/树行/拖拽落点/右键；未分类/回收站拖入；⌂ 目录检测分流 Eagle 向导 |
| `ui/src/components/EagleImportWizard.vue` | Eagle 库预览/复制/索引/元数据/完成/取消向导 |
| `ui/src/components/ImageGrid.vue` | 布局引擎+虚拟滚动+滑尺+子文件夹卡片+选中/框选/拖动排序+卡片封面+拖入落点 |
| `ui/src/components/Inspector.vue` · `InspResize.vue` | 图片/文件夹详情四态 · 详情三向尺寸拖拽 |
| `ui/src/components/Lightbox.vue` | 大图：图片/视频/文本三态、透明顶栏/dock、A/D、右键菜单、旋转翻转保存 |
| `ui/src/components/BriefMode.vue` | 简报模式：全屏、单击/右键、A/D、滚轮缩放/拖拽平移、灰度 |
| `ui/src/components/ContextMenu.vue` · `DirContextMenu.vue` | 图片菜单（封面开关/查重/简报/灰度/未分类）/文件夹菜单 |
| `ui/src/components/DupFinder.vue` | 查重结果分组面板（精确/AI 页签、精确停止、AI 设置/预估、快捷保留、勾选、软删） |
| `ui/src/components/HelpDialog.vue` | 顶栏 `?` 使用说明（排序前缀/清除方式重点、各功能与快捷键） |
| `docs/PLUGIN.md` | 插件系统设计定稿 + 实现状态（theme/renderer 已实现；main/签名未做） |
| `docs/HANDOFF-GEMINI.md` | 开源接手交接：GPL 合规/对应源码/隐私清理/README/Release/CI 优先级 + 验收命令 |
| `branding/` | Logo 概念底稿（A 巢照片 / B 巢鸮 / C N 标）、2048 PSD 模板、深色变体与尺寸预览；终稿**纯黑底 N 标**在 `final/`（最新 PSD 母版 + 1212 原生 tile + 2048…16 PNG + 10 帧 ICO；纯白 N/浅金蛋点/底部保留分隔缺口，底色 `#000000`；16–48px N 88%，64px+ 76%）；已接入窗口/任务栏/exe 图标（`app/_internal_data/icon.png`/`icon.ico`，旧件备份 `icon-old.*`；exe 图标与 VersionInfo 已用 resedit 写入，原件备份 `PicNest.exe.picrand.bak`）；任务栏改图标后需清 Windows icon cache |
| `ui/src/components/PluginManager.vue` · `ui/src/lib/plugins.js` | 插件库面板（已安装/仓库/文件夹安装/启停/卸载）· 主题注入 + 插件事件总线 |
| `examples/plugins/` | 示例插件（mono-mint 主题、view-stats 沙箱面板）、registry.json、zip、开发指南 |
| `ui/src/components/ConfirmDialog.vue` · `NamePromptDialog.vue` · `DuplicateDialog.vue` · `ImportResultCard.vue` · `TrashMenu.vue` · `TaskProgress.vue` | 确认/命名/录入三选一/结果卡/回收站菜单/长任务进度浮条 |
| `ui/src/components/FilterBar.vue` · `ColorPicker.vue` | 筛选 · HSV 取色 |
| `ui/vite.config.js` | dev 绑定 127.0.0.1 + watch polling；build 输出到 app dist |
| `tools/patches/apply.mjs` · `picnest-handlers.js` | 补丁 P1-P10 + 文件夹/录入/回收站/统计/排序/文本/查重/变换/根元数据/物理排序/缩略图修复/插件 IPC + **M6 采集本地服务（127.0.0.1:41600）** |
| `extension/` | 自研 MV3 采集扩展（右键存图/页面截图 + popup 选根/文件夹 + 按住采集环 + 本页状态/修复）；**v0.1.4**：版本化探测 + cleanup 原地接管 + Pinterest 一次性自动刷新；安装见 `extension/README.md` |
| `tools/cdp-*.mjs` · `shot-prod.ps1` · `verify_counts.py` | CDP 探针/截屏 · 多库对账 |
| `tools/test-collect-script.mjs` · `test-collect-background.mjs` · `e2e-extension.mjs` | 采集扩展回归：守卫/接管/cleanup/health · 注入/一次刷新/popup 状态与修复 · 真实 Chrome CDP 端到端 7 项 |
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
27. 移出根文件 = 只清 DB 索引/排序键/回收站条目 + **清孤儿标签**（无任何 image 引用的 tags），磁盘文件永不动；回收站非空先拒；watcher 命中该根必须停并清 `_addQueue`，否则根会被 add 事件复活。新增根相关 IPC 走 `picnest-handlers.js` + `apply.mjs` 的 P4b preload 列表两处（渲染层直接 `window.picrand.*`）。
28. 主题只认 `<html data-theme>`：新颜色同时补 `:root`（light）、`[data-theme="dark"]`、`mono-light`、`mono-charcoal`、`mono-dark` 五块，组件里不要写 `prefers-color-scheme`；auto 的系统联动在 `lib/theme.js`，首屏防闪在 `index.html` 内联脚本；canvas（概览滑尺）换主题要主动重绘。
29. 采集服务只绑 `127.0.0.1:41600`；写文件前必须过 `picnestCollectTarget`（防 `..` 逃逸）；Origin 只放行 `chrome-extension://`/`extension://`/本机 localhost；扩展代码原创、不打包不引用 Eagle 资源，Eagle 兼容层不默认开启。改采集服务后 `apply.mjs` + 重启；扩展改完在 `edge://extensions` 点重载，**并刷新所有已打开网页**（旧 content script 的 runtime 失效，会提示扩展已更新）。
30. 长扫描必须可取消 + 流式：`picnest-find-duplicates` / `picnest-dir-dup-check` 的 cancel flag 每轮重置，检查点放在 `picnestMapLimit` 回调读盘前；MD5 一律用 `picnestMd5Of`（`createReadStream` + per-scan Map 缓存），不要再 `readFileSync` 整文件。文件夹查重进度走 `picnest-dir-dup-progress` → store `taskProgress`（`TaskProgress.vue`），弹重复三选一/开始复制前收起浮条；取消要让 `paste()`/`importDrop()` break 并标「已取消」。
31. **根内元数据目录只能是点开头的 `.picnest`**：scan-worker 原本不跳过点目录（P9f 才补上），watcher 自带 dot 过滤；`verify_counts.py` 也跳过点目录/文件。别把 meta.json 放到非隐藏目录——`.json` 会被当文本类图片入库。
32. **dirMemory 键一律 `${rootId}|${rel}`**：渲染层 `dirMemory` 只保存当前根切片（rel 键，组件不用改），写入走 `patchDirMemory`→`api.dirMemorySet(activeRootId, rel, patch)`；切根/refreshTree 重新取切片；目录改名走 `picnest-dir-memory-rename`。不要再做 `dirMemoryGet('')` 全表缓存（多根会同名串色，根图标颜色 `dirMemory['']` 也会串）。
33. **缩略图缓存固定 `dataDir/picnest-thumbs`**（禁止 `dataDir/cache`，Windows 大小写不敏感会撞 Chromium `Cache`）；生成/迁移/修复都遵守 `md5(file_path)+ext` 寻址；`imagesByDir` 发现缩略图文件丢失必须同时清 DB 字段。
34. **物理改名必须暂停 watcher**（rename 旧路径会触发 unlink，主进程会按旧路径删 DB 行），用两阶段临时名避免互换撞名；同步 DB `file_path`、缩略图缓存名（按新路径 md5）、dirMemory/dirOrder 键、回收站 `abs_path`，完成后重开 watcher。默认开关关闭，仅手动排序时生效。
35. **同一组件可能有两个实例**（详情在 `.browse` 与灯箱 `.insp-overlay` 各一份）：所有依赖 `selectedPath` 的 watch 必须 `{ immediate: true }`，否则新挂载的灯箱详情拿不到当前值；`palettes[p]` 空数组是「未命中/SKIP」不是命中。改 Inspector 的 ref 声明时别顺手删掉 `palette`/`paletteLoading`——ReferenceError 会让整个 `<aside>` 渲染消失，DOM 里连 `.inspector` 都查不到（先看 console.error）。
37. **裁剪层层级**：`.crop-layer` z30、`.crop-bar` z40、`.bar-content`（面包屑/返回/窗控）z45；裁剪时顶栏按钮必须盖住裁剪层，否则大图里左上返回和右上窗控点不到。改这几个 z-index 要一起核对。
36. **网格禁止直链原图**（gif 大格除外）：大格用 `picnest-display-thumbs` 的 1024px 有界缓存，缺失时先用 400 thumb；`img` 必须带 `loading="lazy" decoding="async"` + `@error` 降级链（显示图→thumb→原图 nonce 重试→占位）。Chromium 解码缓存有预算，大图 `decode()` 失败 ≠ 文件损坏；原图只在灯箱/详情显式预览里加载，也要有缩略图回退。

## 七、验收状态 / 最近提交

- 当前 dev 实例运行中，浏览位置「红油奇亚籽/新_2025-2026」；灰度关闭；无测试目录/测试封面残留。
- **对账**：`verify_counts.py` 好图 6718/6718、素材 42/42 全一致（修了根目录直属文件漏数）。
- **查重**：全库 6,724 文件 258ms → 9 组/19 文件/可省 13.1MB；临时目录图片/视频/文本正确分组、同尺寸不同内容未误报；批量软删后组自动收缩。
- **查重收尾（2026-11-09）**：精确扫描关面板取消 → 空态「已停止扫描」；全库 10,764 行 317ms / 38 个同尺寸候选（Eagle 入库已按内容去重 → 0 组；抽检 19 对同尺寸文件 MD5 均不同，非回归）；120×2.9MB 临时目录文件夹查重 900ms、进度 12→102、取消 `canceled:true`；30 副本走真实 `mergeDirWithDupes`：浮条 3/30→30/30、弹窗 count=30、复制 30 张；`cancelTask` 中途停止不复制；import-check 3 冲突 / 1 干净 / 1 缺失。
- **根内元数据（2026-11-09）**：临时根 4 图：加根自动建 `.picnest/meta.json`（Hidden 属性生效）；打标签 + 评分 5 + `Alpha` 颜色红/描述 + 图片顺序写入；移出根后 meta.json 保留（DB tagsRemoved=1）；重新加根恢复标签关联/颜色/描述/评分/顺序；`picnest-root-meta-load` 返回 counts（tags 0 已有、tagLinks 0 已有、images 1、dirs 1、imageOrder 2）。真实根导出 774KB（23 标签 / 2,431 图片元数据 / 47 文件夹 / 83 目录排序 / 102 图片排序）。`verify_counts.py` 跳过 `.picnest` 后 10,764/10,764 一致。
- **主题（2026-11-09）**：config `picnestTheme=mono-light`；把 localStorage 改成 dark 后 reload，仍回 mono-light 并回写 localStorage（跨 origin 记忆生效）；重启后主题保持。
- **缩略图（2026-11-09）**：缓存迁移到 `picnest-thumbs`；临时根删 4 张缓存文件 → 缺失计数 4 → 修复 4/4、失败 0 → 缺失计数 0；全库死路径清理后按需生成（浏览中从 22 → 821+）。
- **生产实例缩略图修复（2026-11-09）**：Desktop 好图 6,630 / 素材 30；批量修复 6,619 张（生成 6,618，失败 1 个坏 mp4 `26a60135….mp4`）+ 素材 30/30；`Fate Grand Order material 1~9` 3,353 图 0 缺缩略图 / 0 裂图，`src` 全部走 `AppData/Roaming/PicNest/picnest-thumbs`；主题 config=dark；两个根均生成 `.picnest/meta.json`（Hidden 属性生效）。
- **物理排序（2026-11-09）**：临时根 3 图 + 2 子夹：开关开→拖拽换序 `a/b/c` → `Alpha/01_a`、`Alpha/02_b`、`Beta/01_c`，DB/缩略图路径同步；再同步文件夹顺序 → `01_Beta/01_c`、`02_Alpha/01_a`、`02_Alpha/02_b`；watcher 暂停/恢复、缩略图缓存改名均通过；停开关/移出临时根后无残留。
- **拖拽**：内部载荷+uri-list 拖到树行正确 move；行顶部 10% 强制 into 无插入线；根行不接；未分类入口落库根。
- **封面**：设置后卡片换图；同夹另一图菜单显示 ✓，再按恢复自动。
- **变换**：735×490 临时图保存后磁盘/DB 均 490×735，缩略图重生成、按钮复位、toast 正常。
- **其它**：详情宽 289 时卡片 4 列；简报 1/370、滚轮 1→1.12、拖拽 50/30、右键菜单 z900>890；灯箱/简报 A/D 通过；大图透明顶栏/dock、安全区 70px 通过。
- **最近提交**：`9cc6703` 查重+优化 → `47bd9b4` 简报/黑白/未分类 → `5063d7e` 去打开灯箱 → `5ace0a3` A/D+图片查重 → `32ec210` 卡片条/拖拽分类 → `c48e575` 拖入落点/封面 → `86539a3` 旋转翻转保存 + 封面开关 → `a61b86b` 网格图片浮岛化 → `e985fcf` 左栏顶部白色渐变 → `1a4c91c` 正文面板孤岛感加码 → `8eefc03` 详情浮岛升层 + 上/右缝收紧 → `5d44454` 色板索引跟随视图补建 → `4e28313` 灯箱/简报去浮岛 → `d6b3d4e` 移出根文件 → `57ed218` 主题系统 → `caab968` 根文件菜单「在文件管理器中打开」 → `f3ccc2f` 右键菜单统一「根文件」措辞 → `bc6735a` 清剩余可见「资料库」文案 → `20679c4` 两套低饱和黑白主题 → `dd25fcc` 再加「炭黑」档 → `61ae51f` 主题更名/跟随系统改灰白墨黑/炭黑提亮 → `504f50c` 顶栏三钮对齐 + 主题钮集体动效 → `18ec862` 详情文件夹 chip 反推修复 → `f780c65` M6 采集（自研扩展 + 本地服务） → `8132bd3` 网页内按住采集（长按面板） → `4f30cab` 采集面板固定白底 + Chrome 安装说明 → `2572965` 采集查重（跳过/仍然保存） → `94f5595` Pixiv Referer / Pinterest 覆盖层兜底 → `15d0c3a` 扩展上下文失效提示 + 重载后刷新纪律 → `d1857c4` 采集覆盖旧图 + 未分类 FolderIcon 动效 → `e2f0da1` 采集面板新建文件夹 → `6cfea18` 查重 AI 视觉二次查重（再往前见 `git log`：文本/视频、多选、视觉分层、详情缩放、大图透明栏等） → `b161ec5` 模型列表 → `74c6850` MiMo 思考额度 → `7abf1a7` 色块预筛 → `032b7e1` pHash 预筛 → `141fab9` 关思考/4 并发 → `13ba4bd` 一键保留/跨后缀/弹层修复 → `ba0be79` 查重收尾（精确取消/流式 MD5/进度浮条/AI 预估） → `9ac0c6b` 左栏图巢标签可拖窗 → `ac42e7c` 根内元数据/目录记忆按根/主题 config/缩略图缓存迁移+批量修复/物理排序开关 → `8946418` 左栏开合按钮 → `d9d8fee` 动效幅度加码 + `docs/PLUGIN.md` 插件仓库设计 → `61ebbf8` 灯箱详情色板 / 裁剪滚轮缩放 + 选区外平移修复 → `8978f37` 窗口收缩时详情高度钳制 → `e36bccc` 网格 1024 显示图 + 加载降级链 → `5543e30` 隐藏排序编号按钮（默认开） → `f10b118` 排序面板「应用为手动排序」 → `f8e2d67` 应用时真实重命名原文件 + 确认卡 → `a786393` 手动排序升为默认/首项 → `7081017` 一键清除根目录排序编号 → `474ec21` 插件库 P1/P2（theme/renderer 沙箱/管理页/registry zip/示例） → `b4df711` 帮助按钮 + 页头标题隐藏编号 → `ea85383` 帮助补全简报/黑白/精确查重/AI 查重 → `5845ca0` 浏览器采集帮助 + 扩展进度环/白底 → `85998ae` AI 查重风险提示 → `dcee375` Logo 概念与 PSD 底稿 → `ef6c5d3` 黑底 N 标 → `1436f87` 按 Feb PSD 导出终稿并接入窗口/任务栏图标 → `dfc762c` N 缩至 84%、黑边加大 → `0e9f9fb` N 提为中性白 → `32f8042` 最新 PSD 白 N 图标 + 软件名/任务栏改 PicNest → `3cc19f9` N 再缩至 76% + 裁剪层不再挡顶栏按钮 → `3fcb81d` 纯黑 #000000 底 + 分级 N（16–48px 88%）+ 10 帧 ICO + exe 图标资源 → `9e4aa37` 托盘清理顺序 + 托盘移除参考板四项 → `6486af9` 两段式关闭（关窗隐藏到托盘，托盘退出才彻底结束） → `dd1a769` P13b 幂等标记修正；封版/开源交接见 `docs/HANDOFF-GEMINI.md` → `ac5edf2` 浏览页 Alt+拖动 / ↗ 手柄拖图到 CSP/PS（原生 startDrag + 落回保护） → `7001b8e` 合并为统一拖拽：普通拖动窗口内高亮排序，拖出窗口自动原生拖到 CSP/PS。
- **仍需 Feb 物理鼠标验收**：旋转/翻转保存、封面 ✓ 两段式、图片拖行边缘/根行/未分类、简报缩放平移右键与 A/D、灯箱右键/A/D、查重面板（精确停止 / 文件夹查重浮条与停止）、详情三向缩放、大图透明顶栏/底栏、框选/拖动排序。
- dist 已构建；HANDOFF/PLAN 已同步（MOTION 未改）。

## 八、2026-11-09 阶段检查点

- **当前运行态**：**生产实例运行中**（`app\PicNest.exe`，无 `PICNEST_DEV`，数据目录 `AppData\Roaming\PicNest`，CDP 9222）；根文件 `好图`（Desktop，6,630）与 `素材`（30）；缩略图已全量补齐（仅 1 个坏 mp4 无海报）；主题 dark 已写入 config；两个根都有 `.picnest/meta.json`。dev 数据 `app\_internal_data` 保留（根 456 `D:\图巢迁移\好图` 10,764 张，缩略图 10,762/10,764）；无测试临时根（已删 520）；主进程补丁与 UI 构建均为最新。
- **本轮成果**：标签系统 v1（单图/多选、任一筛选、搜索、改名/删除）；Eagle 库迁移（11,365 活跃条目 / 18.25GB / 23 标签 / 2,538 URL）+ 根文件 ⌂ 应用内向导；根文件夹物理重命名；文件夹树移除库根行；树行拖拽排序修正；多选文件夹批量图标颜色；侧栏顶部紧凑化；灯箱退出恢复滚动；文件夹树换成 Wenku8 动效图标；移出根文件自动清理孤儿标签（旧遗留 `材质/精选` 已删，临时根验证 `tagsRemoved=1`）。
- **迁移已知项**：2 个 PDF 已复制但未索引；7 个完整多文件夹条目各两份；16 个多文件夹条目有一条失效引用（放有效文件夹）；40 个全部引用失效 + 293 未归类在 `_未分类`；589 个重名加后缀。Eagle 原库只读未改。
- **关键提交**：`b8df2a5` 迁移工具/本库导入 → `8b683f8` Eagle 向导 → `0e34544` 树移除根行 → `020c36a` 根物理重命名 → `713d719` 拖拽排序/侧栏紧凑 → `60fdd03` 灯箱滚动 → `09c8e3b` 多选颜色 → `d6543cf` 树动效文件夹图标。
- **仍需验收**：文件夹动效图标视觉/物理鼠标拖拽、Eagle 向导完整跑一次新库、灯箱/简报切换手感；P0 待办见第四节（向导打包、开源准备、查重收尾）。
