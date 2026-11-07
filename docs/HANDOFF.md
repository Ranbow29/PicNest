# PicNest 图巢 — 交接文档（写给下一个窗口）

> 本文档由 2026-11-08 深夜会话刷新（同日第二版，覆盖拖窗/颜色两大战役）。
> 配套记忆已在 ZCode auto-memory（feb-image-reference-workflow.md），本文是工程视角的完整版。

## 一、这是什么项目

PicNest 图巢：**GPL-3.0 fork 自 PicRand 2.77.0** 的看图软件，目标是替代 Eagle 的日常使用。
核心设计：**直链索引**（不复制文件，SQLite 只存 file_path，物理文件夹 = 真源，层级从路径派生）。

- 仓库：`D:\zcode工作区\PicNest`（git 已初始化，回滚用 `git log`/`checkout`）
- 布局：`app\`（fork 运行时，PicNest.exe）· `ui\`（Vite+Vue3 渲染层）· `tools\`（补丁/脚本/探针）· `docs\PLAN.md`（规格+踩坑 15 条，必读）
- 用户数据：开发模式 `app\_internal_data\`（便携，**CWD 相对，重启必须 -WorkingDirectory app\**）；正式模式 `AppData\Roaming\PicNest`
- 当前库：`C:\Users\feb\Desktop\好图`，6,673 张
- Eagle 参照本体：`D:\zcode工作区\eagle\Eagle`（可拆 app.asar 挖真源，tools/asar_probe.py / asar_extract.py）

## 二、环境启动（每次会话必做）

```bash
# 1) Vite 开发服务器（渲染层热更）
cd D:\zcode工作区\PicNest\ui && npm run dev   # 127.0.0.1:5173

# 2) 应用（另开；WorkingDirectory 必须是 app\，见踩坑 #13）
powershell "$env:PICNEST_DEV='1'; Start-Process 'D:\zcode工作区\PicNest\app\PicNest.exe' -ArgumentList '--remote-debugging-port=9222' -WorkingDirectory 'D:\zcode工作区\PicNest\app'"

# 3) 运行时探针
node tools/cdp-eval.mjs "表达式"     # CDP 求值（store 经 #app.__vue_app__ 取，window.$pinia 未挂）
node tools/cdp-shot.mjs out.png      # CDP 截图（比 PrintWindow 稳）
```

⚠️ 主进程/preload（tools/patches/*）改后必须重启应用；渲染层改后 touch + reload。用户双击 exe 会加载过期 dist。

## 三、当前状态（截至本次提交）

### 已完成并验证
- M0-M4 全量 + 拖入录入/查重、Eagle 五件套筛选、色板系统、专业裁切、大图工作区、顶栏玻璃
- **拖窗战役收官**：app-region 四种结构全灭（踩坑 #11）→ 弃用，winDrag.js 手动拖窗 + P6 补丁（规范尺寸/物理网格/resizable 冻结），抖动与膨胀全灭（踩坑 #12），用户物理验收通过
- **颜色筛选对齐 Eagle 真源**（拆 app.asar）：色板 12 真值 + none/gray 点、HSV 取色面板（150² SV 方块 + 色相条 + ⌖屏幕吸色 EyeDropper）、hex 输入、准确度 5-40 默认 20；colorMatch 对齐搜索窗实时版（25% 门槛/白底特例/d2000+d76 双阈值）；**任意色板精确命中不受占比门槛**（点图自身色板必保原图，Inspector 色板已可点击）
- 色板索引三连修：ensurePalettes 挂上 init（曾零调用）、循环终止修复（曾只回填 40/6673）、Inspector 双形状归一（踩坑 #14）
- 顶栏计数器预留 126px（到 10,000），位数进位不再推挤按钮
- 筛选面板砍掉文件夹区（左侧栏已有）；▤ 布局弹板重排为分组标题+网格（布局 3 列图标格/排列 4 列）
- 大图 dock 加 ‹ › 上一张/下一张（键盘 ←→ 本就有）；灯箱返回钮补样式（曾裸奔）

### 已知边界（非 bug）
- 原生吸管吸的是像素色，像素≠主色时仍可能 miss（与 Eagle 一致）；正道是详情面板点色板
- 拖窗手感与原生有差（IPC 移动）；Aero Snap 无

## 四、关键文件地图

| 文件 | 职责 |
|---|---|
| `ui/src/stores/library.js` | 全部状态与动作（视图/筛选/排序/灯箱/导入/移动/色板索引） |
| `ui/src/lib/winDrag.js` | 手动拖窗（mousedown→增量 IPC→mouseup drag-end） |
| `ui/src/lib/eagleColor.js` | rgb2lab/DeltaE76/2000/isGrayPalettes（Eagle 同款） |
| `ui/src/components/TitleBar.vue` | 顶栏（双模式/玻璃分层 glass+drag-surface/布局弹板网格） |
| `ui/src/components/ColorPicker.vue` | Eagle 式 HSV 取色面板 + 屏幕吸色 |
| `ui/src/components/FilterBar.vue` | 筛选面板（颜色/形状/评分/格式 四区） |
| `ui/src/components/ImageGrid.vue` | 布局引擎 + 虚拟滚动 + 缩略图泵（page-head 手动拖窗） |
| `ui/src/components/Lightbox.vue` | 大图舞台（dock 工具条含 ‹ › 导航） |
| `ui/src/components/Inspector.vue` | 详情浮岛（色板可点筛选） |
| `tools/patches/apply.mjs` | 主进程+preload 补丁（幂等；P6 拖窗 IPC 在此桥接） |
| `tools/patches/picnest-handlers.js` | 追加型主进程 handler（picnest-* 全部 + P6 拖窗） |
| `tools/cdp-eval.mjs` / `cdp-shot.mjs` | CDP 求值 / 截图探针 |
| `tools/asar_probe.py` / `asar_extract.py` | Eagle app.asar 目录树 / 抽文件 |
| `docs/PLAN.md` | 规格 + 踩坑 15 条（必读） |

## 五、验收习惯（保持）

- CDP 实证 store/几何层（elementFromPoint、getBoundingClientRect、clientWidth 稳定性）
- **物理交互只有用户的物理鼠标是真相**（app-region 血泪：CDP 注入全是假阳性）
- 数量对账 `python tools/verify_counts.py`；每完成一役 `git add -A && git commit`
- 写 JS 一律 Write 工具直写；改完必 touch；主进程改动必重启（-WorkingDirectory app\）
