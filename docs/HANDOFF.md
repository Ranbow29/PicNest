# PicNest 图巢 — 交接文档（写给下一个窗口）

> **2026-11-09 第六版·录入定稿**（当日新增：位置即意图录入语义 / 文件夹整包复制 / 缝隙插入排序 / 汇总结果卡 / 按库查重修正）。
> 前一日第五版：大图进出晃动 + 挂载兜底 / 浏览位置记忆 / 持久化全清单 / 宽度缩放全记忆。
> 更早：拖窗战役 → 颜色对齐 Eagle 真源 → 资料库重构 → 动效系统 → 滑尺 → 生产模式验收。

## 〇、开窗三步走（照做即可）

```bash
# 1) 确认工作区干净 & 看上次进度
cd D:\zcode工作区\PicNest && git status --short && git log --oneline -n 5

# 2) 起 dev 环境（Vite + 带调试口的应用；-WorkingDirectory 必须给 app\，否则数据目录跑偏）
cd ui && npm run dev
powershell "$env:PICNEST_DEV='1'; Start-Process 'D:\zcode工作区\PicNest\app\PicNest.exe' -ArgumentList '--remote-debugging-port=9222' -WorkingDirectory 'D:\zcode工作区\PicNest\app'"

# 3) 探针自检（窗口别最小化——最小化会冻结 rAF，动画验证全失效）
node tools/cdp-eval.mjs "location.href"          # 期望 http://127.0.0.1:5173/
node tools/cdp-eval.mjs "@C:\path\any_probe.js"  # 表达式走文件，免 shell 转义
```

**要发布到双击模式**：`cd ui && npm run build`（改了源码不 build，双击跑的仍是旧 JS）。
**要同步数据**（dev ↔ 生产）：关应用 → 拷 `picrand.db` / `config.json` / `cache` 到 `C:\Users\feb\AppData\Roaming\PicNest`。

## 一、项目定位

PicNest 图巢：**GPL-3.0 fork 自 PicRand 2.77.0**，替代 Eagle 日常使用。
**直链索引**：不复制文件，SQLite 只存 file_path，物理文件夹 = 真源，层级从路径派生。

- 仓库 `D:\zcode工作区\PicNest` · 布局 `app\`（运行时+dist）· `ui\`（Vite+Vue3）· `tools\`（补丁/探针）· `docs\`
- **文档三件套**：`PLAN.md`（规格+踩坑 20 条）· `MOTION.md`（动效规格/调参速查）· 本文
- 双资料库：好图（6,674）· 素材（38）；Eagle 参照本体 `D:\zcode工作区\eagle\Eagle`（可拆 asar 挖真源）

## 二、两种运行模式

| | 双击模式（生产） | dev 模式（开发） |
|---|---|---|
| 启动 | 双击 `app\PicNest.exe` | `PICNEST_DEV=1` + Vite 5173 |
| 界面 | `app\resources\app\dist`（改完必须 build） | 实时热更 |
| 数据 | `C:\Users\feb\AppData\Roaming\PicNest` | `app\_internal_data\`（CWD 相对） |
| 已同步 | ✅ 11-08 深夜已同步数据 + 重建 dist | — |

## 三、已验证的全部能力（别重做）

**资料库（Eagle 式）**
- 侧栏资料库区：多根切换 + localStorage 记忆上次使用
- `＋`（文件夹区）= 当前库根新建文件夹；`⌂`（资料库区）= 添加资料库
- 文件夹右键菜单：新建子/同级、重命名（order+memory 键迁移）、排序（当前层级 A→Z/Z→A、全部层级递归 ×2、修改时间 ×2）、移动到…、导出（递归保结构+重名去重）、图标颜色 8 预设
- 空文件夹可见（dir-tree 合并文件系统真实目录）；颜色/展开态持久化（dirMemory）

**动效系统**（Wenku8_Flutter GPL-2.0-or-later 移植，合规声明见 PLAN）
- 入场波 520ms（1/24 墨水步进）：切视图/排序/筛选/内容更新重放；滚动补挂载不重放（gi≥48）
- 动效图标六字形（AnimIcon）：滑轨横移 / 侧栏⇄顶栏 reflow / 方格上浮 / 自适应三横条 / star 旋转 / contents 滑线
- **集体晃动总线**：切视图、换文件夹、切库、关大图、漏斗与布局弹板开关、详情开合 → 全体图标同步
- **随机自弹已彻底移除**（FolderIcon ambient 默认 false + 顶栏 ambient 属性清除）——这是 Feb 明确要求，勿复活

**概览滑尺**（ZCode/Monaco 语义）
- fixed 钉窗口右缘（right 10 / top 74 / height calc(100vh−94px)），详情浮岛 z12 覆盖滑尺 z10
- 48 槽内容轮廓 + 视口邻近 cos² 波峰行进 + 单条金色指示 dash（12px 右对齐）
- 原生滚动条已隐藏；点击/拖拽跳转

**录入（位置即意图，Feb 2026-11-09 定稿）**
- **主展示区/窗口空白** → 当前浏览文件夹；非文件夹视图（全部/最近/未分类/随机/回收站）→ 库根（= 全部/未分类）
- **树行** → 该文件夹；**树行上/下 30% 缝隙** → 该层父级，文件夹按缝隙序号插入排序（图片落进该层父级）
- **资料库栏** → 对应资料库的库根；侧栏空白 → 当前库根
- **文件夹整包复制**：拖入文件夹 → 复制为目标下的同名子文件夹，保留内部结构（仅图片/视频）；同名目标合并、同名同大小跳过、同名不同内容加序号；空目录不落盘；`Thumbs.db`/`desktop.ini`/隐藏项静默忽略；**自包含防护**（拖入的文件夹包含目标 / 已在同名位置 → 拒绝）
- **汇总结果卡**：录入 N 张 · 文件夹 N 个 · 跳过 · 不支持 · 失败；点开看明细（各文件夹/不支持文件名/错误）；悬停停留、6.5s 自动收起；跨库录入标 `→ 资料库名`
- **拖入反馈（无全窗遮罩）**：主面板虚线内框、资料库行虚线框、树行虚线高亮、缝隙 2px 插入线；光标旁浮签实时写落点（`录入到「x」` / `插入到「x」第 n 位`）
- **查重按目标资料库**（folder_id 过滤）——不同库互不干扰；冲突仍走 Eagle 式对比弹窗
- 未闭环：真实鼠标拖拽手感/落点需 Feb 物理验收（CDP 注入对 drag 是假阳性）

**视图与设置**
- 全部 = 最新入库置顶（锁死，忽略升降序开关）；文件夹 = 排序面板（name/added/mtime/size × 升降序）
- 未分类 = 库根散图（侧栏在最近使用之下，当前 3 张）
- **持久化全清单**（均已实测跨重载恢复）：布局方式 · 缩放 · 排序 · 资料库选择 · 侧栏宽度 · 详情宽度 · 树展开态（dirMemory）· **上次浏览位置（视图 + 文件夹；目录失效自动回退全部）**；详情面板初始收起
- **大图进出双触发集体晃动**（openLightbox / closeLightbox 各自 collectiveShake）
  - 注意：大图模式顶栏是另一套模板，漏斗/布局钮在大图期间**被卸载**；退出时新挂载晚于总线触发，
    故 `AnimIcon` 有**挂载即晃一次**（delay 80ms）的兜底 —— 改这两颗的渲染位置时别把这条去掉，否则"退出大图不晃"复发

**其它**
- 手动拖窗（winDrag + P6）：尺寸守恒（resize 监听挂 whenReady + 拖动前自愈）
- 置顶按钮：接 isAlwaysOnTop 查询，点亮反馈
- 颜色筛选对齐 Eagle 真源（25% 门槛/白底特例/d2000+d76）+ 任意色板精确命中保原图 + HSV 面板 + 屏幕吸色
- 裁剪三选一：另存为副本（写原目录自动入库）/ 覆盖原图（自动备份）/ 取消
- 回收站：丢回收站=软删可还原；从库移除=只摘索引

## 四、议题状态

- [x] **录入的细分与归类规则**（2026-11-09 完成：位置即意图 / 文件夹整包复制 / 缝隙排序 / 结果卡 / 按库查重）
- [ ] 标签系统（筛选栏预留了标签位）
- [ ] 主题切换按钮（明暗 tokens 已齐备）
- [ ] 目录删除（含图确认流）、尺寸/评分排序补全
- [ ] 滑尺 Monaco 细节（hover 预览）

**技术债**
- `tools/verify_counts.py` 是单库时代脚本，多资料库下账目显示混乱，需升级。
- `picnestDirOrder` 以 `rel` 为键、**跨资料库共享**（历史结构）：多库根层同名顺序会互相影响；目前无实际冲突，后续可改成 `rootId::rel`。
- 文件夹整包导入只做同名同大小去重，不做全库 MD5（大批量性能取舍）；整包重复内容可能跨文件夹重复收录。

## 五、关键文件地图

| 文件 | 职责 |
|---|---|
| `ui/src/stores/library.js` | 全部状态与动作（switchRoot/文件夹管理/筛选/灯箱/色板索引/collectiveShake 调用点） |
| `ui/src/lib/winDrag.js` · `iconMotion.js` · `wave.js` | 手动拖窗 · 图标弹簧+集体晃动总线 · 入场波 |
| `ui/src/components/AnimIcon.vue` · `FolderIcon.vue` | 动效图标六字形 · 文件夹动效图标 |
| `ui/src/components/TitleBar.vue` · `SideBar.vue` · `DirTreeItem.vue` | 顶栏 · 资料库区+视图入口 · 树行 |
| `ui/src/components/ImageGrid.vue` | 布局引擎+虚拟滚动+概览滑尺+入场波 |
| `ui/src/components/DirContextMenu.vue` · `NamePromptDialog.vue` | 文件夹菜单 · 名称对话框 |
| `ui/src/components/FilterBar.vue` · `ColorPicker.vue` · `Inspector.vue` | 筛选 · HSV 取色 · 详情（色板可点） |
| `ui/src/components/ImportResultCard.vue` | 录入汇总结果卡（明细展开/悬停停留/自动收起） |
| `tools/patches/apply.mjs` · `picnest-handlers.js` | 补丁 P1-P6 + 文件夹管理 5 原语 + 未分类 + 拖窗 + 录入（import-check/import-dir-copy） |
| `tools/cdp-eval.mjs` · `cdp-active-eval.mjs` · `cdp-shot.mjs` · `cdp-reload-probe.mjs` · `shot-prod.ps1` | 探针家族 |
| `docs/MOTION.md` | 动效规格/调参速查（改手感先看它） |

## 六、工作纪律（血泪换的）

1. **改 JS 一律 Write 脚本文件再执行**——新 shell 会截断多行 `python -c` 且静默失败（PLAN #7 变体）
2. **改完 touch 目标文件**；主进程改动重放 `node tools/patches/apply.mjs` + 重启应用
3. **生产验证前必须 `npm run build`**（PLAN #20）
4. **动画验证前确认窗口非最小化**（PLAN #19：最小化冻结 rAF，600ms 仅 1 帧，采样全同态误判"动效坏了"）
5. **生产构建无 `__vueParentComponent`**（dev 专属），生产只能采样 DOM 属性
6. **物理交互只有用户的鼠标是真相**（PLAN #11：app-region 四连败，CDP 注入全是假阳性）
7. SQLite LIKE + Windows 路径必须整体转义含分隔符（PLAN #16）；Vue 模板禁用 window/innerWidth（#17）；setup 内新代码块放全部依赖声明之后（#18）
8. **查重 SQL 必须带 `folder_id = ?`**（曾全局查重：往 A 库导入会弹 B 库的重复）；目录与文件在 `picnest-import-check` 里分流返回（`dirs` / `clean` / `conflicts` / `missing`）
9. **改主进程/preload 后必须重放 `apply.mjs` 并重启应用**（HMR 只覆盖渲染层）；改 store 后若行为没变先整页 reload（无 acceptHMRUpdate）
10. **物理移动/重命名目录后必须同步 DB**：目录树从 `images.file_path` 派生，只 rename 不 UPDATE 会让旧位置留数、新位置显示 0（PLAN #24）；`moveDir` 已在主进程按前缀批量更新
11. **窗口隐藏/最小化会冻结 CSS 动画与 Vue 过渡**：transitionend 不触发 → `<Transition>` 元素会永久留在 DOM（隐形但可挡点击）。结果卡已改为 **CSS 入场动画 + `v-if` 立即卸载**（不依赖 transitionend）；验证动效前先还原并前置窗口（遮挡也可能报 hidden）
12. 每完成一役 `git commit`；数量对账 `python tools/verify_counts.py`
