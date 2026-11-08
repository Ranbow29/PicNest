# PicNest 图巢 — 交接文档（写给下一个窗口）

> 2026-11-08 第三版。前两版覆盖拖窗/颜色战役；本版覆盖资料库重构+动效系统+滑尺+未分类。

## 一、这是什么项目

PicNest 图巢：**GPL-3.0 fork 自 PicRand 2.77.0** 的看图软件，目标是替代 Eagle 的日常使用。
核心设计：**直链索引**（不复制文件，SQLite 只存 file_path，物理文件夹 = 真源）。

- 仓库：`D:\zcode工作区\PicNest`（git ✓）
- 布局：`app\`（运行时）· `ui\`（Vite+Vue3）· `tools\`（补丁/探针）· `docs\PLAN.md`（踩坑 18 条必读）
- 数据：dev=`app\_internal_data\`（**CWD 相对，启动必须 -WorkingDirectory app\**，踩坑 #13）
- 库：好图（6672+）与素材（38）两个资料库；Eagle 参照本体在 `D:\zcode工作区\eagle\Eagle`

## 二、环境启动

```bash
cd D:\zcode工作区\PicNest\ui && npm run dev     # 127.0.0.1:5173
powershell "$env:PICNEST_DEV='1'; Start-Process 'D:\zcode工作区\PicNest\app\PicNest.exe' -ArgumentList '--remote-debugging-port=9222' -WorkingDirectory 'D:\zcode工作区\PicNest\app'"
node tools/cdp-eval.mjs "表达式"    # store 经 #app.__vue_app__ 取（window.$pinia 未挂）
node tools/cdp-shot.mjs out.png    # CDP 截图
node tools/cdp-reload-probe.mjs    # reload+抓页面异常（页内 reload 会断 WS，用它）
```

## 三、当前状态（cf8f796 之后）

### 已完成
- **资料库（Eagle 式）**：侧栏资料库区（多根切换+记忆）· ＋=库内新建 / ⌂=加库 · 文件夹右键菜单（新建子/同级、重命名、排序 6 式、移动到…、递归导出、8 色图标）· dirMemory 全表缓存（颜色/展开态）· 空文件夹可见（dir-tree 合并 fs）
- **动效系统**（Wenku8_Flutter GPL-2.0-or-later 移植，合规声明在 PLAN）：入场波 520ms · AnimIcon 原版几何动效图标（滑轨/ Reflow/方格/自适应三横条/pin twinkle/contents 滑线）· 集体晃动总线（切视图/文件夹/库、关大图、面板开关、详情开合全触发）· FolderIcon 后纸抽拉（环境自弹仅当前高亮文件夹 6-14s）
- **概览滑尺**（ZCode/Monaco 语义）：固定窗口右缘，详情浮岛覆盖之；48 槽内容轮廓 + cos² 波峰随滚动行进 + 金色指示 dash（12px 右对齐）；原生滚动条已隐藏
- **视图分离**：全部=最新入库置顶（锁死）· 文件夹=排序面板（name/added/mtime/size×升降序，已接线到 SQL）· **未分类**视图（库根散图，入口在最近使用之下）
- 前情：拖入手动拖窗（winDrag.js+P6，见踩坑 #11/#12）、颜色筛选对齐 Eagle 真源、HSV 取色面板、裁剪三选一（另存为副本 picnest-crop-as）

### 已知边界
- 尺寸/评分排序暂回退默认序；目录删除未做；导出/移动为系统对话框（CDP 测不了，物理验收）
- 原生吸管吸像素色可能与主色不匹配（与 Eagle 一致），正道=详情面板点色板

> 动效系统规格/踩坑/调参速查：**docs/MOTION.md**（Wenku8 移植收获全记录）。详情面板初始收起。

## 四、关键文件地图

| 文件 | 职责 |
|---|---|
| `ui/src/stores/library.js` | 全部状态与动作（switchRoot/文件夹管理 7 式/筛选/灯箱/色板索引） |
| `ui/src/lib/winDrag.js` · `iconMotion.js` · `wave.js` | 手动拖窗 · 图标弹簧手势+集体晃动总线 · 入场波编排 |
| `ui/src/components/TitleBar.vue` | 顶栏（玻璃三层/动效图标/布局弹板分段钮） |
| `ui/src/components/AnimIcon.vue` · `FolderIcon.vue` | Wenku8 动效图标 · 彩色文件夹动效图标 |
| `ui/src/components/DirContextMenu.vue` · `NamePromptDialog.vue` | 文件夹右键菜单 · 名称对话框 |
| `ui/src/components/SideBar.vue` · `DirTreeItem.vue` | 资料库区+视图入口+树 · 树行（拖拽/右键/展开持久化） |
| `ui/src/components/ImageGrid.vue` | 布局引擎+虚拟滚动+**概览滑尺**+入场波 |
| `ui/src/components/FilterBar.vue` · `ColorPicker.vue` · `Inspector.vue` | 筛选四区 · HSV 取色 · 详情浮岛（色板可点筛选） |
| `tools/patches/apply.mjs` · `picnest-handlers.js` | 补丁（P1-P6 + 文件夹管理 5 原语 + 未分类） |
| `tools/cdp-eval.mjs` · `cdp-shot.mjs` · `cdp-reload-probe.mjs` · `asar_*.py` | 探针家族 |

## 五、验收习惯（保持）

- CDP 实证 store/几何；**物理交互只有用户物理鼠标是真相**（app-region 血泪 #11）
- SQLite LIKE+Windows 路径必须整体转义含分隔符（#16）；模板禁用 window/innerWidth（#17）；setup 内新块放全部依赖声明之后（#18）
- 每完成一役 git commit；JS 一律 Write 直写；改完必 touch；主进程改动必重启（-WorkingDirectory app\）
