# PicNest Rust 版 · 性能优化交接（2026-11-14）

写给下一位接手的人（可能是 code 模式的同僚）。目标不是复述历史，而是让你在 10 分钟内能接着干。

> **2026-11-14 晚 · 第二轮（先读这段，覆盖下面部分结论）**
>
> 本轮最重要的一条：**上一轮的「缩略图 JPEG 化」把 DB 里的 thumbnail_path 全置空了，
> 而缩略图改为按需生成——中间过程中每张格子都在加载原图**（1.2MB / 解码 26.6ms 一张，
> 一屏 20 张 ≈ 500ms 纯解码）。这就是「不跟手」的直接来源，也是 §4 那个「500ms 无法归因」的真相。
>
> 已做的修正：
> 1. **离线迁移**（`D:\ai\picnest-parity\migrate_thumbs_jpeg.py`，14.6s 跑完 10758 张）：
>    webp 重编码成 `{hash}-q80.jpg` 并回写 DB。实测 167KB → 28KB，解码 1.9ms → 0.9ms。
>    旧 webp 一个没删（2.9GB），确认稳定后再走回收站。
> 2. `db.rs` 里「把 webp 路径置空」那段破坏性代码已拆除（只保留 kv 标记），避免将来重装/恢复备份再踩一次。
> 3. 媒体服务加 **HTTP keep-alive**：一条连接连发多个请求，省掉每张缩略图一次三次握手。
>    ⚠️ 必须配合 **PARK_CAP=8** 的挂位上限：空闲连接会占着一个 worker 线程等下一行请求，
>    24 个 worker 全被挂满时新连接要等 5 秒超时回收——实测不加限制时一次普通请求要 3.9s。
> 4. **诊断日志默认关闭**（`PICNEST_DIAG=1` 才开，且不再跟 CDP 端口联动）。
>    原来一次会话 2400+ 行日志，每次导航还要额外几条 `diag_event` IPC。
> 5. `openDir` 把 `collectiveShake()` 和两处 `localStorage.setItem` 挪到下一帧（`requestAnimationFrame`），
>    点击到首帧之间不再夹着「全树图标 watcher 唤醒 + 同步 storage 写」。
>    同时把 `library.js` 里两处 `import('@tauri-apps/api/core')`（每次 diag 都动态导入一次模块）换成缓存的 invoke。
>
> **TaskDuration 这个指标要重新理解**：它是 renderer 进程所有线程的 CPU 之和，不是主线程阻塞。
> 本轮实测一次切 731 张目录：TaskDuration ≈ 0.52s，其中主线程顶层 RunTask 只有 119ms、最长单任务 6.7ms，
> 其余是光栅/合成/GPU 进程的活。**主线程从未出现过 >40ms 的任务**。
> 空闲基线：900ms 窗口 TaskDuration 只有 8ms。所以别再拿「760ms」当「界面卡住 760ms」读。
>
> 本轮实测（同机同库，2026-11-14 晚）：
>
> | 指标 | 实测 |
> |---|---|
> | 真实鼠标点击 → 数据落位 | 13–106ms（冷）／13–40ms（热） |
> | 真实鼠标点击 → 网格卡片变化 | 6–33ms |
> | 真实滚轮 60 格（10803 张全部视图） | 229 帧，最大帧间隔 19.8ms，>33ms 的 0 帧 |
> | 真实滚轮 40 格（784 张目录，进场即滚） | 942 帧，最大 14.2ms，丢帧 0 |
> | 切目录主线程最长任务 | 6.7ms（无 >40ms 任务） |
> | 目录取数 | 3–7ms |
>
> **仍然没复现出来的**：Feb 报的「点一下要等半秒才跳」「吞点击」。用系统级 SendInput 打真实点击，
> 5–8 次连点全部落地、每次数据都换。反过来发现一条真问题：
> **一次切目录后，第一条 IPC 命令要等 0.6–3.2s 才回来**（第二、第三条就 1–2ms）。
> 也就是 Tauri IPC 通道会积压一次脏队列。它不阻塞画面（取数是 HTTP），但所有「等 IPC 结果」的动作
> （缩略图补全、元数据保存、色板、树刷新）都会跟着慢。还没定位到是哪条命令占着，下一步建议从这里查。
>
> ### 追「点侧栏文件夹，要等一下画面才跳」→ 找到了，是入场波
>
> Feb 确认症状就在这一步。把点击拆成水流线量（真实鼠标 → 数据 / 树高亮 / DOM / 首图解完 / 首帧）：
> 数据 4–8ms、DOM 29ms、首图解码 41ms、首帧 44ms —— 数字都很快，但**屏幕上是空的**：
>
> ```
> .thumb 硬挂着 class="wi" → animation: wave-in 520ms backwards; animation-delay: var(--d)
> waveDelay(gi=0) = 173ms
>
> 实测（点目录后采样第一张格子的 computed opacity）：
>   0–181ms   opacity 0        ← 屏幕上什么都没有
>   223ms     0.25
>   343ms     0.80
>   500ms     0.96
>   660ms     1.0             ← 才算落定
> ```
>
> 原因：上文「切目录不重播入场波」是靠「不调 `replayWave()`」实现的，但 `replayWave` 只控制
> header 的 `:key`；格子是 `v-for :key="img.id"`，换目录就是整批重建，而 `.wi` 在标签上硬写着——
> 新建元素必定重播 CSS 动画。所以每个目录都在播一遍「先空 173ms、再淡 520ms」，
> 靠后的格子 `--d` 还会涨到 338ms（`waveDelay` 上限 0.65×520）。
>
> 修法：`ImageGrid.vue` 加 `noWave`，`class="{ nowi: img.gi >= 48 || noWave }"`；
> 导航类（点文件夹、全部视图/库根）→ `noWave = true`；换视图（最近/随机/未分类/回收站/搜索）
> 与启动首帧 → 保留入场波。
>
> 修后实测：`animation: none`，opacity 第一帧就是 1，真实点击到新内容上屏 15–20ms。
>
> ⚠️ 坑：`.wi` 在 `style.css` 里是通类选择器，以后任何新元素加 `class="... wi"` 都会自动播
> 173ms 延迟 + 520ms 淡入。想要「立即出现」的元素要么不加 `wi`，要么自己加 `nowi`。
>
> ### 真正解掉「连续换文件夹 3–4 次就变慢」：collectiveShake
>
> 上一节那个 `nowi` 改动**已回退**：Feb 确认旧版也是同一套入场波、旧版不卡，它不是本质矛盾。
>
> **正确的量法**（这轮的核心贡献）——不要去数 renderer 的主线程：
> ```python
> user32.SendMessageTimeoutW(hwnd, WM_NULL, 0, 0, SMTO_ABORTIFHUNG, 3000, byref(out))
> ```
> 这是 Win32 标准的心跳：宿主消息泵堵住，它就不返回。再配 `GetThreadTimes(主线程)` 区分「在算」还是「在等」。
>
> 实测（修前）：
> | 指标 | 空闲 | 切目录后 |
> |---|---|---|
> | 宿主消息泵 WM_NULL 往返 | 0.1–0.3ms | **312 / 877 / 1891 / 3001ms** |
> | 主线程 CPU 占阻塞时长 | — | **68–80%**（在算，不是在等锁） |
> | 真实鼠标点击 → 页面收到 | 4ms | **1320 / 1880 / 3334ms** |
> | 切后首条 IPC 命令 | 1–2ms | 583 / 1314 / 1600 / 3926ms（随切换次数涨） |
>
> 这一组数就是「吞点击」「点一下等半秒」的真面目：**不是渲染慢，是宿主主线程被烧住，
> 所有鼠标/键盘消息和所有 IPC 一起排队**。renderer 是独立进程，所以画面还在动，反而更难归因。
>
> **元凶：`openDir()` 里的 `collectiveShake()`**（树上所有图标同时重播一次手势）。
> 判定方式：把 openDir 的每个动作做成可开关的替身逐个 A/B，只有去掉它，泵阻塞归零；
> 剩下的 `revealDir` / `loadImages` / `recordNav` / localStorage / syncDirSnapshot / diag_event
> 单独跑都是 0.2–0.3ms。
>
> 修法：`library.js` 的 openDir 不再调 `collectiveShake()`（localStorage 等照旧）。
> 卡片入场波 `.wi` **原样保留**（Feb 明确要求）。
>
> 修后实测：消息泵 0.2–0.4ms；真实点击 3–5ms（连点 3 次后仍然 3–4ms）；
> 切后首条 IPC 2–3ms（1/2/4/8 次切换都是 2–3ms）。
>
> **已排除、别再走一遭的**：图片加载量（拦掉 `*/m/*` 仍堵）、`.wi` 入场波、
> AnimIcon 的 rAF 循环（禁 `play()` 仍堵——开销在 `iconShake.value++` 引发的 60+ 个 watcher 调度本身）、
> 后台任务（palette/dims/harvest 全 stub 仍堵）、`AbortController.abort()`、
> 诊断日志、IPC 大响应（`get_palettes`×6 连发 0.2ms）、
> `--disable-gpu-vsync`/`--disable-frame-rate-limit`（已从 lib.rs 撤除）、
> GPU 那批 flag（`gpu-rasterization`/`zero-copy`/`CanvasOopRasterization`/`UseSkiaRenderer`，
> 也全部撤了，跑 WebView2 默认）。窗口最小化只能把阻塞从 1.4s 降到 0.3s，说明大部分在呈现路径，
> 但扣掉这个仍然剩着——所以别被「窗口看不见就不卡」骗了。
>
> 调试脚手架（可保留）：`PICNEST_DIAG=1` 开命令级计时（`cmd>` / `cmd<` 日志，已埋在 14 个热路径命令里）；
> `window.__picNoIconAnim` 可强制关掉图标动画。
>
> ### 原版对照与「新版独有冗余」清单（2026-11-14 夜）
>
> Feb 指出：集体抖动原版也有却不卡，那它不是本质差异。拿原版实测验证了这个判断——
> **原版切目录时宿主消息泵同样堵 826–1014ms**（三次连点，每次如此），和 Rust 版修前的量级一样。
> 所以「主线程忙 1 秒」两边都有，不是新版毛病。
>
> 差别在两点（这才是新版真正多的东西）：
> 1. **输入承载**：原版的 ipcRenderer 不经过窗口消息泵，主进程忙不忙不影响输入投递；
>    Tauri 的 IPC 和窗口消息共享同一条宿主主线程。所以同样的 1 秒阻塞，原版只毛损掉后台，
>    新版会直接弄丢你的点击。这解释了为什么两边泵都堵、只有新版「不跟手」。
> 2. **新版独有的调用**（grep 原版前端对比出来的）：
>
> | 项 | 原版 | Rust 版 | 现状 |
> |---|---|---|---|
> | `diagLog` → `diag_event` IPC | **无**（0 命中） | 每次导航 4–5 条 | 已改为默认不发（`localStorage.picnestDebug='1'` 才开） |
> | `syncDirSnapshot`（1.2s 后扫目录） | **无** | 每次切目录 1 次 | 待处理：20–32ms，SQL 用 `LOWER(file_path)` 全表扫 10803 行 |
> | 目录列表 LRU（`_lcSet`/`_lcGet`） | **无** | 有 | 保留，是优化不是冗余 |
> | HTTP 取数 / keep-alive / 目录缩略图 jpg | 无 | 有 | 保留，都是优化 |
>
> 下一批可挖的（按性价比）：
> - **`sync_dir_snapshot` 的 SQL**：现在 `WHERE folder_id=?1 AND LOWER(file_path)>=?2 AND LOWER(file_path)<?3`，
>   函数套在列上 → 每次全表扫 10803 行。仓库里已经有 `dir_rel` 和索引，改成
>   `WHERE folder_id=?1 AND dir_rel=?2` 就能走索引，返回结果不变。
> - **`ensurePalettes` 的自动触发**：`images.length <= 800` 就算，所以 784 张的目录每次切过去都会
>   跑 8 轮 `build_palettes_step`（每轮 12–20ms + 一次 IPC 往返）。而色板只在开颜色筛选时才有用。
>   原版也有这段逻辑，但原版走 ipcRenderer、单次代价低得多，所以在新版里这变成了真开销。
> - **「同步命令在主线程」这条路**：`set_image_meta` / `images_reorder` / `move_*` / `rename_*`
>   这 20 多个 `pub fn`（非 async）都在宿主主线程执行，一旦它们变重（写盘、批量改文件名）
>   就会直接堵输入。建议逐步改成 `async fn + spawn_blocking`。
>
> **上述三条的落地情况（同日稍后）**：
>
> 1. 实证了前提：`CmdTimer` 现在会把执行线程打出来——
>    `cmd> get_media_port [main]`（sync 命令确实在主线程）、
>    `cmd> build_palettes_step [tokio-rt-worker]`（async 命令不在）。所以这条不是猜测。
> 2. `sync_dir_snapshot` 已改为走 `dir_rel`：新增索引 `idx_images_dir_rel(folder_id, dir_rel)`，
>    查询从 `LOWER(file_path) >= / <` 换成 `dir_rel = ?`，保留前缀区间做退路（根路径取不到时）。
>    **784 张目录实测 20–32ms → 1ms**，返回结果不变。
> 3. 已从主线程卸下来（改 `async` + `spawn_blocking`）：`mkdir`、`set_image_meta`、
>    `images_reorder`、`apply_transform`（旋转/翻转写回，最重的一个）。
>    窗口操作类（`window_minimize` 等）和 OLE 拖放（`drag_begin` / `copy_files_to_clipboard`）
>    **必须留在主线程**，没动。
> 4. 还没改（都是破坏性文件操作，需要一边改一边验）：
>    `rename_image` / `rename_dir` / `rename_library` / `move_image` / `move_dir` /
>    `physical_order_images` / `physical_order_dirs` / `strip_order_prefixes` /
>    `remove_root` / `stage_drop_*`。改法机械（签名加 async + 整体包 spawn_blocking，body 一字不改），
>    但它们会改用户文件，得在能回滚的前提下逐个验。
> 5. `ensurePalettes` 的自动触发（784 张以下目录每次切跑 8 轮）**未改**：
>    砍掉自动算会让「第一次打开颜色筛选」当场等 1–2 秒，这是产品取舍，不是纯优化。
>
> ### 排序不再碰文件名（2026-11-14 深夜）
>
> Feb 的原始痛点：「新图拖入后置顶」与「库内移动改文件夹顺序」现在靠给名字加 `01_` 前缀。
> 查出直接原因：**她的 `localStorage['picnest.physicalOrder'] === '1'`**（代码默认关，但她这台开着），
> 而 `hideOrderNumbers: true` 又把序号藏了——所以界面看不到，磁盘文件名一直在真实变化。
>
> 改成全走元数据（—行文件名不动）：
> - 新增 `pinDir(parentRel, name)`：把目录提到同级第一位，只写 `picnest_dir_order`。
> - 新增 `pinDirAfterImport(rootId, rel)`：`reportImport` 里检测到真的落地了新图
>   （`copied+registered+downloaded+replaced > 0`）就调它；`t.index != null` 时跳过
>   （用户明确拖到缝隙位置，那个位置优先）。开关 `autoPinOnImport`，默认开。
> - `init()` 里一次性迁移：把 `picnest.physicalOrder` 强制写 0（标记 `physicalOrderMigrated`）。
>   要做「资源管理器里也按这个顺序」的人重新打开即可。
>
> 顺手修了三个同源的坑（都是 rel 大小写不一致）：
> 1. DB 的 `dir_rel` 是全小写（`06_gbf/sr`），树节点的 rel 是磁盘真实大小写（`06_GBF/SR`）。
>    `findNode` 是严格 `===` 比较 → 拿 DB 风格 rel 查树永远 null。
>    后果：`insertOrderAt`（新建文件夹插序）、各种拖拽换序都会**静默失效**——
>    很可能就是她当年不得不回去用文件名前缀的真原因。现在 `findNode` 改成「先精确、再不区分大小写」。
> 2. `pinDirAfterImport` 的 `parentRel` 原本从传入的 `t.rel` 切，改成从节点真实 `node.rel` 切。
> 3. 历史脏数据 `<folder>|__root__`（dir_tree 读的是 `<folder>|`，那批行永远读不到）：
>    db.rs 启动时搬到正确 key，已有新值的直接删。
>
> 验证：`SR` 从同级第 2 位置顶到第 1 位（故意用 DB 风格小写 rel 调用），
> 磁盘目录名仍是 `01_文档 02_好图 … 06_GBF`（一个没变），图片加载 0 破损。
>
> 遗留：磁盘上已经存在的 `01_`/`02_` 前缀是历史改名的结果，不会自动洗掉。
> 要清用现成的「清除排序编号」（`stripOrderPrefixes`），但那是批量改名，需用户确认。
>
> ### 物理排序（改文件名）已彻底拆除 + 那次灾难的复盘
>
> **一次 `physical_order_images` 全量执行 = 整库缩略图全没**。
> 原因：它的改名走 `db_move_image_path`，而那个函数是
> `UPDATE images SET file_path = ?1, thumbnail_path = NULL WHERE file_path = ?2`——
> 每改一个文件就把缩略图字段清掉。用户看到的：满屏灰卡 + 「PSD 不支持了」。
> 而缩略图缓存文件本身还在磁盘上，只是名字是旧哈希（`fnv1a(file_path)`），路径一改就对不上号，
> 而且经过多轮改名后旧哈希已经无法反推——只能重新生成。
>
> 拆除范围（2026-11-14）：
> - Rust：`physical_order_images` / `physical_order_dirs` / `strip_order_prefixes` 三个命令
>   已从 `commands.rs` 删除（备份 `commands.rs.bak-before-cut`），`lib.rs` 不再注册。
> - 前端：`physicalOrder` / `hideOrderNumbers` 状态、`togglePhysicalOrder`、
>   `applyImageOrderPhysical` / `applyDirOrderPhysical` / `syncDirOrderPhysical` / `stripOrderPrefixes`
>   全部移除（保留空实现防旧引用报错）；`dispName` 直返真实名、`orderPrefix` 恒为空、
>   `renameTarget` 用用户输入；`applyGridOrderToManual` 改成纯写 `sort_order`。
> - UI：右键菜单的「清除排序编号…」「✓ 排序同步文件名」、顶栏的 `01` 按钮均已删。
>
> **教训**：凡是以 `file_path` 做 key 的派生缓存（缩略图、色板、view 预览），
> 都不能在改名路径上一刀置 NULL——改名是重活，一旦中途失败/被打断就是大面积失联。
> 要么缓存 key 换成 `(size, mtime)` 或内容 hash，要么改名时把缓存文件一并迁移。

---

## 0. 铁律（先读这段）

1. **原版只读**：`D:\Gemini\picnest1`（Electron，180MB exe）和 `D:\zcode工作区\PicNest` 是基线，**只读、只跑，绝不修改**。可以启动它做对照测量。
2. **中文文件严禁用 PowerShell `Set-Content` 编辑**。我犯过一次：把 `ImageGrid.vue` 写成乱码，丢了 123 个字符，靠 git 回滚 + 手工重贴才恢复，还连带丢了 Gemini 在该文件里未提交的改动。改文件只用 `write` / `edit` 工具。
3. 用户 Feb 已授权自主操作：**发现问题直接改、直接测、直接判是不是主要矛盾**，不要每步都问。她会在验收时告诉我们"解决 / 回退 / 这是窗口设计就这样"。
4. 别把"语言红利"当战绩。Rust 在大数据量上快是应该的；真正要看的是**单位工作量的成本**和**人眼感知的体验**。

---

## 1. 现场

| 项 | 值 |
|---|---|
| 项目 | `D:\Gemini\PicNest-Rust`（Tauri 2 + Vue3 + rusqlite） |
| 基线 | `D:\Gemini\picnest1`（Electron 33 + PicRand 2.77 主进程补丁） |
| 构建 | `cd ui; npx --no-install tauri build --no-bundle` → `ui\src-tauri\target\release\app.exe` → 复制到仓库根 `PicNest.exe` |
| 带调试启动 | `$env:PICNEST_CDP_PORT='9222'; Start-Process 'D:\Gemini\PicNest-Rust\PicNest.exe' -WorkingDirectory 'D:\Gemini\PicNest-Rust'` |
| 数据库 | `%LOCALAPPDATA%\PicNest\picnest.db`（WAL），用户已备份 |
| 日志 | `%LOCALAPPDATA%\PicNest\diag.log`（异步落盘，含 `[JS]` 前缀的是前端写入） |
| 缩略图缓存 | `%LOCALAPPDATA%\PicNest\cache\thumbs` |
| 测量脚本 | `D:\ai\picnest-parity\`（见 §5） |
| git 状态 | 大量未提交改动（`ui/src/*` 多个文件 + `ui/src-tauri/` 全部 untracked） |

**注意**：`cargo build --release` 产出的 exe 会走 devUrl（页面报错），**必须用 tauri CLI 构建**。

---

## 2. 已经做完的事（按时间顺序，附理由）

### 2.1 取数通道：Tauri IPC → 本地 HTTP
- 症状：`images_by_dir` 后端 12ms 返回，前端 0.9–2.7 秒后才 `got`。
- 测量：同一时刻打本地 HTTP 平均 12ms / 最慢 47ms，打 Tauri IPC 平均 178ms / 最慢 929ms；连 `diag_event`、`get_media_port` 这种不碰库的命令也一起卡 → 堵的是 IPC 通道本身。
- 做法：媒体服务上开 `GET /api/images?folder=&rel=&offset=&limit=&sort=&asc=&rec=`，**独立端口**（避开缩略图占满同源 6 连接），前端 `api.imagesByDir` 改走 fetch，IPC 保留给写操作。
- 结果：单目录取数 30ms → 4–7ms；全部视图（10803 行）3160ms(原版) → 88ms。

### 2.2 数据模型：dir_rel + 索引
- 原先 `file_path LIKE '根\目录\%'` 全表扫，10798 行一张不少地扫。
- 加了 `images.dir_rel`（小写、正斜杠、相对根的父目录）+ `idx_images_nav(folder_id, deleted_at, dir_rel, sort_order, id)`；`db.rs::backfill_dir_rel` 按 `dir_rel IS NULL` 增量回填；`apply_file_snapshot_diff` 写入新行时同时写 dir_rel。
- 查询改为**两条索引扫描的 UNION ALL**（`dir_rel = ?` + `dir_rel LIKE 'rel/%'`，并给读连接开 `PRAGMA case_sensitive_like=ON` 前缀才走索引）。单条 OR 会被计划器降级成全扫。
- 顺带消掉 `01_文档` 这类名字被 `_` 当通配符误匹配的隐患。

### 2.3 连接与并发
- `with_read_conn`：只读连接池，**查询期间不持锁**（早先版本持锁导致请求串行排队，队尾被拖到 1 秒开外）。
- 媒体服务从"一连接一线程"改成**固定线程池**（24 个 worker），并给 socket 设读写超时（Chromium 会 preconnect，空连接会把 worker 占死）。
- 缩略图生成复用同一个 rayon 池（原来每次调用新建一个，线程反复创建销毁）。
- 前端给长命令加并发闸门：`generateThumbnailsBatch`(1)、`buildPalettesStep`(1)、`fillImageDims`(1)。

### 2.4 导航路径
- `loadImages`：**去掉 setTimeout 包装**，和原版一样直接 `await`。之前套 `setTimeout(0)`，主线程一忙整次导航就被推迟（日志实测 715ms 的空档）。
- 请求可取消：每次加载 `AbortController.abort()` 上一次；快速连点不再堆队列。
- 目录列表 LRU 缓存（最多 12 个位置）：回切同一目录 8–21ms，命中时**不阻塞**等待核对请求（核对异步回来，变了才替换）。
- 取消"先 60 行再补全量"的两段式：列表从 60 跳到 N 会重排一次，观感是"跳一下"。现在单次全量一次成型。
- **所有"预解码闸门"已按用户要求全部拆除**（store 的 `_preloadFirst`、ImageGrid 的换屏闸门）。她的取舍是：**切换优先，右侧图片可以慢**。因此现在可能出现"格子有、图没出"的灰卡，这是接受的行为。

### 2.5 渲染
- `v-for` 的 key 去掉 `waveSeq`（`img.id` 即可）；入场波只在**首次挂载 / 切视图 / 换根**时播放，切目录不重播。
- 大目录（>800 张）默认不再自动构建色板，只在打开颜色筛选时才算（色板每轮改 600 条响应式数据，每次都触发 masonry 重算）。

### 2.6 WebView2 启动参数（`lib.rs`）
```
--enable-gpu-rasterization --ignore-gpu-blocklist --enable-zero-copy
--enable-features=CanvasOopRasterization,UseSkiaRenderer
--disable-background-timer-throttling --disable-renderer-backgrounding
--disable-backgrounding-occluded-windows
--disable-gpu-vsync --disable-frame-rate-limit
--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion
```
来历：输入投递节拍实测 16ms → 12ms → 3–9ms（原版 8ms）。逐条加上去的，`CalculateNativeWinOcclusion` 那一条收益最大。
**副作用待观察**：`--disable-gpu-vsync` 可能带来撕裂，如有就只去掉这一条。

### 2.7 缩略图编码（本轮刚做，**效果未验证**）
- 发现：Rust `image` crate 0.25 的 WebP 编码**只有无损**，400px 缩略图约 **146KB**（20521 张，约 3GB），一屏 20 张 = 4MB。
- 改动：`commands.rs::save_thumb_jpeg`，改为 **JPEG q80**，文件名 `{hash}-q80.jpg`（原子写入）；`db.rs` 里一次性把 `thumbnail_path LIKE '%.webp'` 置空（kv 标记 `thumbs_jpeg_v1`），让旧图按需重生。
- **当前状态：新 JPEG 还是 0 张**——需要浏览目录触发按需生成。这是下一步验收的第一个数。
- 旧的 20521 张 webp 暂留（~3GB），确认有效后再清（按用户偏好走回收站）。

---

## 3. 关键测量（同机同库）

| 指标 | 原版 | 现状 |
|---|---|---|
| 单目录取数（15–450 张） | 50ms | 4–7ms |
| 全部视图（10803 张） | 3160ms | 88ms |
| 端到端首屏（冷 / 热） | ~1000ms 换内容 | 44–75ms / 0–23ms |
| 连点 8 次后收敛 | — | 12–188ms |
| 输入投递节拍 | 8ms | 3–12ms |
| 切目录期间掉帧（>33ms） | 未测 | 0 帧 |
| **每次切换主线程占用 `TaskDuration`** | **未测** | **545–766ms（可归因的仅 ~180ms）** |

---

## 4. 当前的主要矛盾（重要）

`TaskDuration` 每次切换 ~760ms，但可归因的只有：

```
ScriptDuration  20ms
LayoutDuration  75ms
RecalcStyle    115ms
```

剩下 **500ms 左右不在任何 JS 项里**。关掉后台任务（`fillDims`/`ensurePalettes`/`harvestThumbs`）只降到 545ms，不是主因。按 Chromium 记账习惯，这段大概率是**图片解码 + 光栅/合成**。

两条待验证的假设：

1. **缩略图太大**（146KB/张，无损）→ 已改 JPEG q80，等验证。
2. **WebView2 的合成路径**比 Electron 的独立 GPU 进程差 → 若体积降下来仍无改善，就转去查合成层（`backdrop-filter`、`box-shadow`、`will-change`、`contain` 等）。

用户还报了两个现象，**目前复现不出来**，加了日志等现场证据：
- 「点一下要等半秒才跳」：真实鼠标点击实测 18ms / 0ms / 1ms；日志里 `tree-click → openDir → loadImages start` 的空档 0–715ms 不等（那 715ms 已被"去掉 setTimeout"修掉，需复查）。
- 「吞点击」：某次日志 42 次 `tree-click` vs 43 次 `openDir`，数量对不上。怀疑主线程忙时事件被合并。
- 「截到全白 / 灰卡」：当前是**有意为之**（闸门已拆）。

---

## 5. 测量脚本（`D:\ai\picnest-parity\`）

node 脚本，`CDP_PORT` 环境变量指定端口（Rust 版 9222，原版启动时给 `--remote-debugging-port=9333`）。

| 脚本 | 作用 |
|---|---|
| `eval-port.mjs '@文件.js'` | 通用：在指定端口执行页面 JS |
| `input-latency.mjs` | 用 CDP **真实输入通道**每 8ms 发一次 mouseMoved，统计投递节拍（这是"跟手"的核心指标） |
| `real-click.mjs` | 真实鼠标点击树行，测 `高亮 / 出图` 时间 |
| `refresh-cost.mjs` | **Performance 计数器差分**：Script / Layout / RecalcStyle / TaskDuration |
| `bg-off.mjs` | 运行时把后台任务换成空实现，再量一次，用来隔离主因 |
| `frame-test.js` / `frame-heavy.js` | 切目录期间 rAF 帧间隔（掉帧统计） |
| `thumb-missing.js` | 统计目录内缺缩略图数量 |
| `check-rec.js` / `scaling.js` | 直接打 `/api/images` 验数据与耗时 |
| `rapid-gray.js` | 8 连切，统计"有卡片但零张图"的采样数 |
| `visual-paint3.js` | 数据到达 / 首图画出时间 |

**原版对照**：`$env:CDP_PORT='9333'; node eval-port.mjs '@…js'`。注意它的窗口被遮挡时 rAF 与 CDP Input 会被冻结，必须先用 Win32 `SetForegroundWindow` 拉到前台。

---

## 6. 下一步（按性价比排序）

1. **验收缩略图 JPEG 化**：浏览几个目录后看 `cache/thumbs/*-q80.jpg` 的平均体积（目标 25–35KB）与 `TaskDuration`（目标显著低于 760ms）。若有效 → 清旧 webp 释放 ~3GB。
2. **若解码不是主因**：查合成层。具体做法：临时用 CDP 注入 CSS 关掉 `backdrop-filter` / `box-shadow` / `border-radius` 后重跑 `refresh-cost.mjs`，看 `TaskDuration` 掉多少。
3. **masonry 布局**：每次加载对全部图片重算列高。可改为"只算可见区 + 缓存列高"，`LayoutDuration` 目前只 75ms，优先级低于第 2 条。
4. **前端残留的同步操作**：`openDir` 里两次 `localStorage.setItem`、`collectiveShake()` 触发的整树图标重建，都可挪到空闲期。
5. **回归待办（功能缺口，非性能）**：插件沙箱 14 条命令、AI 视觉查重 6 条、Eagle 迁移 4 条、缩略图修复 3 条、采集扩展服务端（41600 + token）、自动更新 —— 见会话早期的 parity 账本，`D:\ai\picnest-parity\diff3-report.txt` 与 `ledger.md`（549 条期望清单）。

---

## 7. 已知坑

- `tauri build` 才能产出带内嵌前端的 exe；`cargo build` 出来的会去连 5173 devUrl。
- 覆盖 `PicNest.exe` 前必须先 `Stop-Process`，否则文件被占用。
- 图片服务默认 `Connection: close`（没做 keep-alive），原版是 Node http（默认 keep-alive）。**这可能是"右侧出图"体感差异的另一条线索，尚未验证。**
- `dir_rel` 依赖 `apply_file_snapshot_diff` 维护；若将来新增其它写 `images.file_path` 的路径（rename / move / 物理排序），**必须同步更新 dir_rel**，否则那张图会从所有目录列表里消失。
- `with_read_conn` 里开了 `case_sensitive_like`，只对池内连接生效；其它地方用 LIKE 时要注意大小写行为不同。
