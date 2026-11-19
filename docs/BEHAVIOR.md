# PicNest Rust 版 · 功能行为基线

> 用途：后续优化的地基。每条只写「触发 → 行为 → 影响」，不写实现细节。
> 更新：2026-11-14。标 ⚠️ 的是已知坑，标 🆕 的是这一轮改的。

---

## 1. 基本模型

**库 = SQLite 索引 + 磁盘原文件。图巢不存图片副本，只记路径和元数据。**

| 存在哪 | 内容 |
|---|---|
| SQLite（`%LOCALAPPDATA%\PicNest\picnest.db`） | 路径、尺寸、评分、标签、备注、排序值、目录顺序、缩略图路径 |
| 磁盘（你的图库目录） | 图片/视频/文本原文件，以及**文件名** |
| 缓存（`cache\thumbs`） | 400px 缩略图，文件名是路径的哈希 |

**推论**：磁盘文件名是唯一能被其他软件看到的信息。库里排得再好，不改文件名，资源管理器里就看不出来。

---

## 2. 数据读取

| 项 | 实际通道 | 说明 |
|---|---|---|
| 目录图片列表 | **HTTP** `GET /api/images`（独立端口） | 不用 Tauri IPC——IPC 在连续操作时会堵到 1–3 秒 |
| 目录树 | IPC `dir_tree` | 每次**重新 walk 磁盘**，所以新建/删除文件夹立刻可见，不依赖数据库 |
| 缩略图 / 原图 | HTTP `/m/<路径>` | 独立端口 + keep-alive，避免占满同源 6 连接 |

**含义**：文件夹结构永远实时（读磁盘）；图片列表来自数据库（需要同步才更新）。

---

## 3. 缩略图

| 项 | 值 |
|---|---|
| 一档 400 | 不透明：`{hash}-q80.jpg`（约 28KB）；**有透明：`{hash}-lossless.webp`**（无损，约 175–260KB） |
| 二档 1024 | 不透明：`{hash}-1024-q80.jpg`（约 90–190KB）；**有透明：`{hash}-1024-lossless.webp`**（约 1.0–1.4MB） |
| 三档 2048 | `{hash}-2048-q80.jpg`，仅灯箱用，且只在原图长边 > 2400px 时生成 |
| PSD 中间缓存 | `psd-{hash}.webp`（PSD 内嵌预览，解析后留着复用） |
| 大图预览（旧） | `view-{hash}.webp`（读到时仍兼容） |
| 生成时机 | 可见区缺图时按需生成；批量修复按钮 |

⚠️ 1024 档的两个坑（都踩过）：

1. **路径要给 `fileUrl()`**。`displaySrc` 存的是磁盘路径，直接 `withVer(path)` 会生成 `C:\...jpg?v=` 这种非法 src，浏览器当坏图 → 中大格全破图。
2. **切源时的 error 不一定是真坏图**。400 → 1024 换源那瞬，被中止的旧请求也会吐 error。处理方式是“重新单独载一次，真坏才拉黑”，并且显示分支要优先于 `imgFix` 的降级状态（否则一旦降级到原图就再也回不到 1024）。

⚠️ **透明图绝不能存 JPEG**：PNG 在 alpha=0 的像素里照样存 RGB（本库实测 2154 张透明图里有大量这种“隐形颜色”），JPEG 一丢 alpha 就变成黑底上的彩色毛刺。判定用 `has_visible_alpha()`（alpha < 250），走无损 WebP。

⚠️ **`save_thumb_jpeg` / `write_webp_lossless` 必须先 flush 再 rename**：BufWriter 没 flush 就改名，磁盘上是半截文件，浏览器可能读到截断图。

⚠️ **关键：缓存 key 是文件路径的哈希。路径一变（改名/移动），缓存就对不上号。**

- 正确做法：改名时 `migrate_thumb_cache` 把 `old_hash` 的文件改名为 `new_hash`（已实现）
- 错误做法：改名时把 `thumbnail_path` 置 NULL（历史 bug，一次全量改名清空整库缩略图 → 满屏灰卡、PSD 显示不了）

---

## 4. 排序（三层，最容易混）

> 2026-11-16：**「排序同步文件名」默认关**。排序平时只存元数据（`picnest_dir_order` / DB），不动磁盘名。想让它同步，右击根文件勾「排序同步文件名」，或排序面板点「写入文件名…」（先预览再确认）。勾上后的行为：手动拖完防抖 800ms 写一次、只当前层、迁移缩略图缓存、监听抑制 6s；库根/未分类/回收站不自动改名。顶栏「01」只隐藏前缀，不改名。

| 层 | 存在哪 | 谁读它 | 什么操作会改它 |
|---|---|---|---|
| **图片顺序** | `images.sort_order` | 图巢网格 | 手动拖拽、应用为手动排序 |
| **目录顺序** | `picnest_dir_order`（JSON 数组） | 左栏树 | 拖动文件夹、新图入库自动置顶 |
| **文件名前缀** | 磁盘文件名（`001_原名.jpg`） | 资源管理器、其他软件 | 「排序同步文件名」开关（自动）、导出时可选 |

**关系：前两层是"主"，第三层是它们的投影。** 同步做完三者一致；之后只有显式操作才会再对齐。

`sort_order = 0` 表示"未分配"→ 排最前（新入库的图在最前）。`(sort_order=0) DESC, sort_order ASC, id DESC`。

| 现象 | 原因 |
|---|---|
| 点「标题」排序看不出变化 | 已经同步过，文件名顺序 = 手动顺序 |
| 「标题」模式下拖不动 | 有意为之：非手动模式允许拖动会按临时画面重建 `sort_order`，覆盖手动排序 |
| 移动一张图会改好几个文件名 | 编号是 1..N 连续的，插入会让中间几张顺移 |

---

## 5. 两个方向的同步

**别混，这是最容易搞错的地方。**

| 方向 | 入口 | 行为 | 处理删除？ |
|---|---|---|---|
| **磁盘 → 库** | 切进目录后 1.2s 自动、文件监听（新增/删/改名） | 新文件入库、大小/mtime 变了就更新、磁盘没了就软删 | 已补（见 §6） |
| **库 → 磁盘** | 「排序同步文件名」开关（拖完 800ms 自动，只当前层）、导出时可选去前缀 | 按库里顺序写 `001_` 前缀；缓存跟着迁移 | — |

**两个方向都是自动的**。手动入口（旧版右键的「从磁盘重新读取」「同步到文件夹」）已删——监听已盖住前者，开关已盖住后者。

**落地排序 = 库改变磁盘**，不是反过来。它的意义是：把你在图巢里排好的顺序，变成资源管理器也能看到的顺序。

---

## 6. 删除

| 场景 | 行为 |
|---|---|
| 在图巢里删 | 进图巢回收站（`deleted_at`），可从回收站恢复 |
| 在资源管理器里删 | 文件监听捕获 Remove 事件 → 库里立即软删（进回收站视图），同时通知前端刷新 |
| 兜底 | `sync_dir_snapshot` 现在也会检测「库里有、磁盘没有」并软删，返回 changed=true |
| 本轮之前 | ❌ **完全没处理** → 库里的记录变成孤儿（张数比磁盘多、里面夹灰卡） |

**为什么会漏**：`sync_folder_snapshot` / `sync_dir_snapshot` 的 diff 只遍历「磁盘上的文件」，判断「磁盘有但库里没有」和「大小/mtime 变了」，从未反向检查「库里有但磁盘没有」。所以删除一条从来没被发现过。

**修复时的两个坑**（值得记住）：
1. watcher 在 Rust 侧已经抢先软删后，前端再调 `sync_dir_snapshot` 会看到“没变化”返回 false，从而不刷新。所以前端不能拿返回值二次判断——**事件本身就是磁盘变了的信号**。
2. 删除后必须清目录列表 LRU（`_listCache`），否则 `loadImages` 会把旧列表又吐出来。

⚠️ 历史遗留的孤儿行需要一次性清理（已清过一批 33 条）。判断脚本按「根目录可读」做安全阀，防止盘临时断开误删全库。

---

## 7. 文件监听（自动部分）

| 项 | 值 |
|---|---|
| 机制 | `notify` crate → Windows `ReadDirectoryChangesW`（内核事件，不轮询） |
| 范围 | 所有资料库根目录，递归 |
| 关心的事件 | 新建 / 删除 / 改名（内容写入忽略） |
| 防抖 | 静默 600ms 收口，硬上限 2s |
| 前端反应 | 若变化落在当前目录（或其上下级），调 `sync_dir_snapshot` 入库；**真有变化**才刷新列表 |

**含义**：从浏览器另存、从资源管理器拖图进当前目录，界面会自己更新，不用切走再切回。

---

## 8. 性能相关（已改，供后续参考）

| 改动 | 原因 |
|---|---|
| 取数走 HTTP 而非 IPC | Tauri IPC 在连续操作后排队 1–3 秒，HTTP 稳定 3–7ms |
| `sync_dir_snapshot` 走 `dir_rel` 索引 | 原来是 `LOWER(file_path)` 全表扫 10803 行，784 张目录 20–32ms → 1ms |
| 切目录不再 `collectiveShake()` | 树上 60+ 图标同时重播动画，把宿主主线程烧到 70–80%，消息泵堵 0.6–3s，真实点击延迟 1.3–3.3s |
| 缩略图 JPEG q80 | 无损 webp 167KB → 28KB，解码 1.9ms → 0.9ms |
| 改名的 DB 写入包事务 | 原来逐个提交，6224 次 fsync |
| 诊断日志默认关 | 原来一次会话 2400+ 行，每次导航还要几条 IPC |
| 同步命令卸下主线程 | `mkdir` / `set_image_meta` / `images_reorder` / `apply_transform` / `rename_image` 改 async |
| 自动同步走本地增量 | 改名后用后端返回的 `map` 本地换字段，**不整表 loadImages**，选中/滚动/缩略图不丢 |
| 内部操作抑制 watcher | 拖拽与自动改名期间设 `_suppressFsSyncUntil`，否则改名产生的事件会把刚写好的顺序盖回去 |
| `collectiveShake` 加 400ms 节流 | 单次重播要跑 60 图标 × 640ms ≈ 2280 次响应式更新。连点按钮时动画首尾相接，主线程持续被占，表现是“多点几下就卡”。400ms 内的后续触发直接丢弃 |
| `switchView` 同视图短路 + 160ms 防抖 | 无重入保护时，连点 10 次就是 10 次全库查询（10774 条），消息泵实测被砸出 200ms。防抖后只跑最后一次，72ms |
| 侧栏 `contain: layout paint` + 去 `will-change: width` | 原来过渡 `width`/`padding`（都是 layout 属性）且声明 `will-change: width`，折叠时每帧重排整个网格 |

### 8.1 窗口交互层：拖窗与 hover 是互斥的（2026-11-15）

**这一节是踩过坑之后写的结论，动手前先读完。**

**结论：拖窗交给 JS，不要用 CSS `-webkit-app-region: drag`。**

- `-webkit-app-region: drag` 会让 WebView2 在 `WM_NCHITTEST` 直接返回 `HTCAPTION`，**整块区域被系统拖窗循环接管**，鼠标移动不再走 DOM。结果是这块区域里的按钮 hover 高亮明显滞后（用户原话：“鼠标掠过顶栏按钮都卡”）。
- CSS 方案还有一个副作用：**优先级高于 JS**。`api.js` 里那套 `mousedown → startDragging` 的实现一直存在，但只要 CSS 写了 `drag`，它就是死代码。

**现行实现**

| 环节 | 位置 | 说明 |
|---|---|---|
| 判定拖拽区 | `api.js`：`target.closest('.titlebar .bar-content, .sidebar .brand')` | 只有这两块能拖 |
| 排除交互控件 | 同处 `closest('button, a, input, textarea, select, option, label, [role="button"], [contenteditable], [data-no-drag], .no-drag, .vo-wrap, .zoom-slider, .search, .bar-controls, .win-btn')` | 点按钮不会拖窗 |
| 再查祖先链 | 同处 while 循环读 `app-region === 'no-drag'` | **所以 `no-drag` 规则必须保留**，删了会让按钮变成拖拽区 |
| 双击 | 同处 `ev.detail >= 2` → `toggleMaximize()` | 双击最大化也在这条路径 |
| 真正拖动 | `win.startDragging()` | 权限 `core:window:allow-start-dragging`（已在 capabilities 配好） |

**三条硬性约束**

1. **`.titlebar` 必须带 `z-index`**（现在是 5）。它是 `position: absolute`，没有 z-index 时会被 DOM 后面的 `.browse` 盖住——顶栏事件要穿透一层才能到，拖拽面收不到、hover 也绕远。这不是调参，是层级 bug。5 这个值要**低于详情浮岛（24）**，否则会破坏“详情压在顶栏之上”的设计。
2. **不要把 `-webkit-app-region: drag` 加回顶栏或侧栏品牌区**。加了就回到 hover 滞后的老路。
3. **`VisualSearchDialog.vue` 里那 3 处 `drag` 不能动**：JS 的 `dragRoot` 只认顶栏和侧栏品牌区，弹窗的拖拽仍然靠 CSS。

**验证方法**（不靠肉眼）

```js
// 1. 顶栏不该再是 drag 区
getComputedStyle(document.querySelector('.bar-content'))['-webkit-app-region']  // 期望空/none
// 2. 按钮必须是 no-drag（JS 的判定依据）
getComputedStyle(document.querySelector('.bar-content button'))['-webkit-app-region']  // 期望 no-drag
// 3. 顶栏空白处命中自己，而不是内容区
document.elementFromPoint(x, y)  // 期望 .bar-content，而不是 .grid-viewport
```

第 3 条尤其重要：**如果返回的是 `.grid-viewport` / `.page-head`，说明 z-index 又丢了**。

### 8.2 数据口径：`dir_rel` 与 `file_path` 必须同步（2026-11-15）

**这一节也是坑出来的，改任何涉及路径的代码前先读。**

**背景：同一个“文件在哪个目录”有三套实现**

| 用途 | 依据 | 位置 |
|---|---|---|
| 列表取数 | `dir_rel` | `query_images_http`（`commands.rs` 的 HTTP 版）|
| 侧边栏徽章 / 未分类计数 | `file_path LIKE` | `view_counts` |
| 目录树每层计数 | `file_path` 字符串切分 | `dir_tree` |
| 目录统计 / 封面 | `file_path LIKE` | `dir_stats` / `dir_covers` |

**只要 `dir_rel` 和 `file_path` 漂移一次，就会出现“徽章 N、列表 0”**——用户会以为图丢了。

**铁律：凡是写 `file_path` 的地方，同一语句里必须更新 `dir_rel`**

```rust
// 正确写法（五处共用）
let dr = root_path_for(&conn, &old_path)
    .map(|root| crate::db::dir_rel_of(&root, &new_path))
    .unwrap_or_default();
conn.execute(
    "UPDATE images SET file_path = ?1, dir_rel = ?2 WHERE file_path = ?3",
    rusqlite::params![new_path, dr, old_path],
);
```

辅助函数 `root_path_for(conn, file_path)` 在 `commands.rs`，从路径反查库根；
`dir_rel_of(root, file_path)` 在 `db.rs`，算相对路径（小写、正斜杠、无首尾斜杠）。

**已覆盖的写入点（2026-11-15 补齐）**

- `commands.rs` `move_image`（单图跨目录）
- `commands.rs` `move_dir`（整棵子树，逐行重算）
- `commands.rs` `db_move_image_path`（`rename_dir` 也走这条）
- `commands.rs` `add_folder_by_path`（登记资料库的批量 INSERT）
- `importer.rs` `index_disk_paths`（导入 INSERT + 恢复软删 UPDATE）
- `trash_ops.rs` `finalize_restore_folder_db`（重名还原成 `name (2)` 时）

**不管的两种（故意）**

- **库根改名**（`rename_library`）：只改 `file_path`。`dir_rel` 是相对库根的，根名变了相对路径不变。
- **同目录改名**（`rename_image`）：重算出来与原来一致，写一遍也无害（共用 `db_move_image_path`）。

**漏了会怎样（实测过的两例）**

1. **移动后图从列表消失**，但徽章/树还数着。
2. 更重：源目录下一次 `sync_dir_snapshot` 会把这行当成“库里存在、磁盘上没有” → **软删进回收站**。文件其实好好躺在目标目录。

**回归验证方式**（真图往返，两分钟）

```
移前 dir_rel='好图/风格化'
→ 移到 zz_move_test：dir_rel='zz_move_test' 且 deleted_at 为 NULL
→ 移回原处：dir_rel 回到 '好图/风格化'
```

**两个相关口径**

- **缩略图缓存文件名是 `{hash}-q80.jpg`，hash 用 `format!("{:x}")`，不是 `{:016x}`**。
  生产端（`commands.rs` / `collector.rs`）全是 `{:x}`；查重与以图找图曾经用 `{:016x}`，
  高位为 0 的约 6% 的图找不到缩略图 → 退回传原图（查重变慢、AI 更费钱）。已统一成 `{:x}`。
- **`file_path LIKE` 拼接必须转义 `_` 和 `%`**（用 `escape_like_pattern` + `ESCAPE '\'`）。
  这库的目录名全是 `01_好图` 这种下划线开头——不转义的话 `_` 当通配符，
  统计和封面会串到兄弟目录（`01_好图` 与 `011好图` 会合并）。

---

## 9. 已知限制与坑

1. **文件名前缀只认 2–3 位数字 + 下划线**。`0524_`、`2023_` 这类 4 位日期开头的一律不碰（旧的 1–4 位规则会误伤）。
2. **目录顺序的 key 用磁盘真实大小写**（`folder_id|好图/精选`），而 `dir_rel` 是小写。两者混用会导致顺序/置顶静默失效——`findNode` 已做大小写回退，但写库时要注意。
3. **改名 = 缓存全部失效**，除非走 `migrate_thumb_cache`。任何新增的改名路径都必须迁移缓存。
4. **`unique_target_path` 会在重名时加 `(2)`**。同步取名时如果目标已存在，实际文件名可能和预览不一致。
5. **PSD 缩略图**如果没解析出内嵌预览就没有图，会显示占位；这不是“不支持 PSD”，而是该文件本身没有预览层。
6. **导出**只有「含子文件夹」和「去掉数字前缀」两项，没有“只导出选中”。
7. **非手动排序模式下不能拖动换位**（防止覆盖手动顺序）。
8. **上传/下载与自动同步可能错节**：边往目录里拷图边触发自动同步，新拷进来的可能不进本次改名计划。拷完再挪一下顺序即可。
9. **文件监听不分场合**：库目录里的任何新建/删除/改名都会触发同步，包括你自己在资源管理器里的操作和 OneDrive 的云端变更。这是意图之内，但事件密集时会有几次刷新。
10. **顶栏拖窗不能退回 CSS**：`-webkit-app-region: drag` 与 hover 灵敏度互斥，详见 §8.1。同理，`.titlebar` 的 `z-index` 不要删。
11. **`collectiveShake` 有 400ms 节流**：连续操作时后面的抖动会被丢弃。这是故意的，不是 bug；如果你发现“连点两下只有第一下抖”，原因在此。
12. **改 `file_path` 必须同步 `dir_rel`**：列表按 `dir_rel` 取数，徽章/树按 `file_path` 计数，两者一分就出现“徽章 N、列表 0”，且可能被误软删。详见 §8.2。
13. **缩略图哈希用 `{:x}` 不是 `{:016x}`**：生产端与查找端必须同格式，否则约 6% 的图会找不到缩略图。
14. **`file_path LIKE` 必须转义 `_` 和 `%`**：目录名普遍是 `01_好图` 这种下划线开头，不转义会串兄弟目录。

---

## 10. 本轮改动清单（2026-11-14）

- 缩略图：无损 webp → JPEG q80（10782 张离线迁移）；`db_move_image_path` 不再清空 `thumbnail_path`，改为迁移缓存
- 取数：`images_by_dir` 走 HTTP；新 `dir_rel` 列 + 索引
- 切目录：去掉 `collectiveShake()`、把 localStorage/抖动挪出首帧、去掉 diag 动态 import
- 诊断：默认关闭（`PICNEST_DIAG=1` 才开），带命令级耗时
- 同步：`sync_dir_snapshot` 改走 `dir_rel` 索引（20–32ms → 1ms）
- 排序：拆掉旧的「物理排序」三个命令（会自动清空缩略图）；重做「排序同步文件名」开关（默认关、拖停 800ms、只当前层、缓存迁移、本地增量不打断选中）
- 前缀显示：恢复顶栏 `01` 隐藏按钮；`renameTarget` 保留前缀
- 导出：新增「导出（去掉数字前缀）」
- 目录：新建文件夹合并为一个（建在右键的文件夹内）；两个手动同步入口已移除（全部自动）
- 文件监听：`notify` 递归监听 + 600ms 防抖；新增删除事件 → 库里软删
- 数据修复：清理 33 条孤儿记录；恢复目录顺序（从改名前的备份库按 `NN_` 前缀还原）

## 11. 本轮改动清单（2026-11-15）

**AI 查重（对齐旧版 `picnest-handlers.js`）**

- 候生成修正：`threshold` 8→10、补 `hashFlip` 镜像检测、**去掉自己加的 `aspect_diff < 0.20`**（它把“同版式不同裁切”这类最需要 AI 判断的候选全筛掉了）
- 灰度改 **Rec.601**（sharp/libvips 口径），缩放改 **Lanczos3**；Rust 原生 `to_luma8` 是 Rec.709，梯度符号会翻转
- `file_to_data_url` 修好 base64（原来用 `serde_json::to_string` 生成的是 JSON 数字数组，API 一律回 `Param Incorrect`）
- 输入图统一 384×384 白底 q95；AI 调用补 429/5xx 重试 3 次，超时 45s→90s
- 新增进度事件 `picnest-ai-dup-progress`（前后端都补上）
- 新增「继续查剩下的 N 对」：扫描会话缓存在内存（`AiScanSession`），不重扫全库
- `dupFinder.ai.allowed`（允许上传缩略图）改为 localStorage 持久化——之前写死 `false`，每次重开 app 都回到未勾选，按钮永久置灰，于是“AI 查重根本不走 AI”

**以图找图**

- curl 不读系统代理 → 显式探测（环境变量 / 注册表 / 本地端口）传 `--proxy`
- 透明图白底：原来 `to_rgb8()` 只是丢 alpha，透明区变黑底，Pinterest 认不出
- 解析器兼容扁平结构（`image_large_url` / `image_square_url`）——之前只认 `images` 对象，所有结果都被当“无缩略图”丢掉
- 字段映射对齐旧版：`thumbUrl=474x` / `largeUrl=1200x` / `origUrl=originals`（之前取 90×90，所以模糊）
- 衍生图搜支持远程 URL（先下载再上传）；本地大图 >800KB 才重编码（原来 2MB 原图直传要 14s）

**交互与性能**

- 拖窗改 JS 接管（详见 §8.1）；`.titlebar` 补 `z-index: 5`
- `collectiveShake` 400ms 节流；`openLightbox`/`closeLightbox`/`switchView`/`toggleSidebar`/`toggleInspector` 去 shake
- `closeLightbox` 复位 `viewer.scale/tx/ty`（之前停在 0.57 这类残留值）
- `switchView` 同视图短路 + 160ms 防抖（防连点）
- `onFsDirChanged` 加 350ms 防抖（旧版有 300/600ms 合并，移植时丢了）
- 回窗同步 `syncActiveRootOnFocus` 6s→30s，页面隐藏时不跑
- `switchIndex`（1.2s 补偿同步）3s 且检测交互后退
- `gridOrder` 加浅比较（顺序没变就不回写，避免每次补缩略图都触发 TitleBar/BriefMode 重渲染）
- 缩略图补齐批量 8→24
- 侧栏去 `will-change: width` + `contain: layout paint` + 去 padding 过渡

**设置与筛选**

- 移除「文档隐私折叠」开关（`docPrivacyMode` 状态保留，文本卡片分支还在用）
- 格式筛选选中项后面加 `✓`

**数据口径修正（`dir_rel` 全链路）**

- `move_image` / `move_dir` / `db_move_image_path` 改 `file_path` 时同步重算 `dir_rel`
- `importer.rs` 导入 INSERT 与恢复软删 UPDATE 补 `dir_rel`
- `add_folder_by_path` 登记资料库的批量 INSERT 补 `dir_rel`
- `trash_ops` 重名还原（`name (2)`）后重算 `dir_rel`
- `__loose__` 误判成“根目录递归”修正（`is_recursive = !loose_only && ...`）
- 列表 SQL 的散图分支兼容 `dir_rel IS NULL`
- 采集器 `collector.rs` INSERT 补 `dir_rel`（新采集的图之前是 NULL）
- 缩略图哈希统一 `{:x}`；`dir_stats` / `dir_covers` 加 LIKE 转义
- `applyFilters` 的 `f.color` 加空检查
- 实测：真图往返移动，`dir_rel` 正确跟随，未被误软删

---

## 12. 本轮收尾（2026-11-15 晚）：自动更新 + 帮助对齐

### 12.1 自动更新（新文件 `src-tauri/src/updater.rs`）

- `check_update`：打 GitHub Releases API（`Ranbow29/PicNest`），semver 比较（兼容 `v` 前缀与预发布）；挑资产优先 `.zip` 且排除 extension 包；SHA-256 先看 asset 的 `digest`，取不到再扫 release 正文里的 64 位 hex
- 代理：复用 `visual_search::detect_proxy`（环境变量 → 注册表 → 本地端口探测）传 `--proxy`；curl 失败重试一次（代理节点偶发 `schannel: 35`）
- **API 限流不再等于功能变哑**：同 IP 超 60 次/时，改跟 `releases/latest` 的 HTML 重定向取 tag，返回 `hasUpdate` + `htmlUrl`、`assetUrl=null`，前端提示改用「浏览器下载」
- `download_update`：curl 流式下载到 `%TEMP%\picnest-update\`，轮询文件增长发 `picnest-update-progress`（received/speed），内置纯 Rust SHA-256（不引依赖），校验失败删包并报错；`cancel_download_update` 置标志 + taskkill
- `quit_and_install`：`prepare_install` 解压 → 定位真正的程序根 → 预检 exe → 生成带 BOM 的 `swap-and-restart.ps1`；然后拉起 detached powershell 跳板（等主进程退出 → 清残留子进程 → 覆盖复制，跳过 `_internal_data`、6 次重试 → 重启 → 回收站清理解压目录），最后 `app.exit(0)`
- `PICNEST_UPDATE_DRYRUN=1` 只准备不执行（自动化测试入口）
- 前端：`api.js` 补 4 个 case；`picrand` 暴露 `onPicnestUpdateProgress/onPicnestUpdateStatus`（之前 `p().onPicnestUpdateProgress` 根本不存在，进度条永远是 0）；`quitAndInstall` 实际传 `{zipPath}`，桥接层现在同时接受 zipPath/filePath；进度条 total 用 `assetSize` 兜底、percent 在前端算

### 12.2 验证记录

- `cargo test --lib updater`：8 项通过——SHA-256 三组标准向量 + 增量一致、semver、release 载荷解析（含跳过 extension 资产）、zip 解压/坏包拒绝、嵌套目录识别
- 真实网络：拿到 tag `0.1.0`、资产 `PicNest-v0.1.0-windows-x64.zip`、SHA 与正文一致；当前版本同为 `0.1.0` → `hasUpdate:false`（符合预期）
- 真机 CDP（release exe）：`download_update` 用 8MB 本地文件跑通（`verified:true`；SHA 不符时拒绝并删包）；`quit_and_install` dry-run 生成的脚本过 PowerShell 语法检查（0 错误、UTF-8 BOM 正确）
- 未验：真正跑一次「解压 → 覆盖 → 重启」（会替换正在使用的 exe），留给发版后第一次真实更新

### 12.3 发版注意

- tag 必须大于当前 `0.1.0`；资产名建议 `PicNest-vX.Y.Z-windows-x64.zip`（不含 `extension` 字样）
- release 正文里带上 64 位 SHA-256（会被自动提取用于校验）
- 便携包根目录直接放 `PicNest.exe`；若压缩包里多一层 `PicNest/`，会自动剥掉一层

### 12.4 帮助面板对齐实际

- §1 排序：原来写成「永不改文件名」，和排序面板里的「写入文件名…」矛盾 → 改成「默认不改名 + 显式按钮会加 `01_` 前缀（先预览、只改名字、迁移缩略图缓存）」，并写明顶栏 `01` 只影响显示、「清除排序编号」已移除
- §12 AI 查重：Key 并不是 safeStorage 加密 → 改为「明文存本机数据目录的 `ai_config.json`」
- §13：Rust 版没有插件后端（`picrand` 的 Proxy 对未知键返回 null 桩）→ 侧栏入口改成真探活（`picnestPluginsList` 返回 ok 才显示），帮助里写明暂未接入
- §14/§16：去掉过时的 `v0.1.6` 字样；`F2` 重命名其实没有全局快捷键（只有详情面板按钮）→ 换成真实存在的 `0–5` 评分键

### 12.5 缩略图缓存验收
- 10744 张 `-q80.jpg` 平均 **27.1KB**（目标 25–35KB），合计 283.8MB；另有 40 个旧 webp（93.8MB）
- `cleanup_orphan_thumbs` 实测 checked 10784 / deleted 0：这 40 个 webp 的 hash 仍对得上现存图片，不是孤儿，所以不删
- 库里还有 42 张没有缩略图（多为 PSD/视频），右键「修复缩略图…」可补

### 12.6 灯箱入场动画与缩放的抢写（残影）

- 现象：双击进大图后立即滚轮放大，会闪一下“放大的残影”，约半秒后稳定。
- 原因：开场 FLIP 过渡（360ms）每帧都在写 `viewer.scale/tx/ty`，滚轮也在写同一组值——两个写入者每帧互相覆盖，屏幕上的尺寸来回跳，看起来就是残影。动画跑完后又把缩放拍回适配值，所以“半秒后恢复”。
- 修法：新增 `finishFlip()`：滚轮、拖拽平移、双击缩放、进裁剪任一开始就取消 `flipRaf` 并直接停在终态（同一帧内完成，不会多画一帧），之后完全由用户输入控制。
- 验证：CDP 注入双击 + 50ms 后派发 `wheel`，采样 5 次（间隔 110ms）——`flip=false`、`scale` 恒定在 `fit×1.12`，不再被动画覆写。
- 调试探针：`window.__picViewer()` 返回当前 `scale/tx/ty` 与 `flip` 是否在跑。

### 12.7 大图/简报拖拽的“果冻感”

- 现象：拖图时图像橡皮筋跟上来，手感发滞。
- 原因不是动画：canvas 每帧都在重绘可见区（含高质量采样），一张大图一遍重绘就要十几毫秒以上，帧跟不上指针就成了拖尾。
- **已回滚的方案**：拖动时只给 canvas 加 `translate3d`（合成器直移，零重绘）。实测位移是 1:1 跟手的，但**会看到残影**：旧画面腾出的区域是空的，底下氛围底透出来就是双重像；每 80px 一次真重绘又变成跳一下。所以退回每帧重绘（原行为）。
- 下一步可试的方向（未做）：拖拽期间把 `imageSmoothingQuality` 降到 `low`，重绘便宜很多且不产生残影，松手后再用 high 重绘一次。

### 12.8 网格滚轮频闪（400 → 1024 换档）

- 现象：滚轮滚动时，中等以上的格子会闪一下；最小格子（只走 400）不闪。
- 原因两条叠加：
  1. 曾用 `:key="img.src"` 来区分“旧请求晚到的 error”，代价是换档时整张 `<img>` 被销毁重建，缓存命中也要重新解码 → 闪一下。
  2. 旧逻辑一见 `error` 就降级（1024 → 400 → 原图），而滚动出屏/换源中止也会报 error → 连换几次源，闪成一片。
- 修法：去掉 `:key`（换源只改 `src`，浏览器保留上一帧直到新图解码）；`onCellImgError` 先重新载一次当前 src，加载得通就当成假失败，真坏才 `degradeCell()`。
- 教训：**为了区分假错误去重建元素，代价比错误本身大**；先验证再降级才是正解。

---

## 13. 工程纪律：硬件友好度 + 进程卫生

> Feb 定的规矩（2026-11-15）：**软件不能加速硬件损耗；不能留下会被遗忘的孤儿进程。**
> 后续开发都按这两条卡。

### 13.1 硬件友好度（发热 / 磨损 / 电）

1. **不允许无界子进程**：ffmpeg / ffprobe 碰到坏文件、网络流会无限期挂着——解码器持续占 CPU/GPU，机器发烫、风扇狂转，硬盘也跟着被反复读。所有外部命令必须有硬超时 + 超时后连整棵进程树一起收。
2. **后台不画**：窗口最小化/隐藏时，定时器驱动的环境动画直接跳过，不产生 rAF 重绘（功耗与唤醒次数）。
3. **不做无意义轮询**：fs 监听用 `notify` 事件驱动，事件空窗期 0 CPU；轮询只允许出现在「用户正在交互」的窗口里（如拖拽时 25ms 读一下鼠标键状态）。
4. **网络请求必须带超时**：所有 curl 都带 `--max-time` + `--connect-timeout`（采集/查重/以图找图/更新全局统一）。
5. **不写满盘**：缩略图 JPEG q80（27KB 级）、缓存有界、临时文件有回收。
6. **未做但值得盯**：网格里视频海报用 `preload="metadata"`（每格会读头），悬停预览已限制同时只解一个视频。

### 13.2 进程卫生（不留垃圾）

| 位置 | 以前的风险 | 现在 |
|---|---|---|
| `extract_video_dims`（ffprobe） | `.output()` 无限等 | `output_with_timeout(15s)` |
| `extract_video_poster`（ffmpeg 截图） | 同上，且最多试 3 次 | 每次 25s 上限 |
| 视频兼容转码（libx264） | 长视频/坏文件能挂几小时 | 600s 上限 + `-loglevel error -nostats` |
| 更新包解压目录 | 失败/取消后 `%TEMP%` 越躺越多 | `prepare_install` 顺手清 24h 前的 `extracted-*` / `*.part` |
| 下载中的 curl | 取消后要等它自己超时 | 置取消标志 + `taskkill /PID … /F` |
| 热替换跳板 PowerShell | — | 等主进程最多 15s、复制 6 次重试后继续，自带日志与收尾 |
| AI 查重的请求/响应临时 JSON | 不可重试错误（Key/模型错）只删响应，请求体（含两张 base64 图）永久留下 | 统一 `cleanup_ai_temps`，且每次扫描前扫掉 1 小时前的 `picnest_ai_req_*` / `picnest_ai_resp_*` |
| 单测临时目录 | 测试末尾手动删，断言失败（panic）就跳过，几天攒了 134 个 / 94.4MB | `testutil::TempDir` 的 Drop 守卫，panic 也会清；已存的已进回收站 |

`output_with_timeout` 实测：`cmd /c ping -n 20` 在 400ms 上限下 **0.5s 内返回 None**，且用 `taskkill /T /F` 连孙进程一起收（只杀直接子进程不够——孙进程会继承管道句柄，反过来把读取线程拖住，这个坑就是测试里显出来的）。覆盖测试：`commands::tests::output_with_timeout_*`。

### 13.3 还没改、下次碰到再处理

- `drag.rs` 拖拽期间 25ms 轮询鼠标/键盘状态：只在 `active` 时跑，算可接受，若以后改低功耗可换 `WH_MOUSE_LL` 回呼。
- 顶栏/文件夹图标的「环境自弹」：已加 hidden 判断，但定时器本身仍在跑（只是不画）；若要彻底归零，可在 `visibilitychange` 时停掉 `scheduleAmbient` 链。


