# PicNest 图巢 — 交接文档（写给下一个窗口）

> 本文档由 2026-11-08 深夜会话生成。当前窗口上下文过载，新窗口从此文档接续。
> 配套记忆已在 ZCode auto-memory（feb-image-reference-workflow.md），本文是工程视角的完整版。

## 一、这是什么项目

PicNest 图巢：**GPL-3.0 fork 自 PicRand 2.77.0** 的看图软件，目标是替代 Eagle 的日常使用。
核心设计：**直链索引**（不复制文件，SQLite 只存 file_path，物理文件夹 = 真源，层级从路径派生）。

- 仓库：`D:\zcode工作区\PicNest`（**git 已初始化**，有提交历史，回滚用 `git log`/`checkout`）
- 布局：`app\`（fork 运行时，PicNest.exe）· `ui\`（Vite+Vue3 渲染层）· `tools\`（补丁/脚本）· `docs\PLAN.md`（规格+踩坑）
- 用户数据：开发模式 `app\_internal_data\`（便携）；正式模式 `AppData\Roaming\PicNest`
- 当前库：`C:\Users\feb\Desktop\好图`，6,675 张已索引（含用户自己删改的变动）

## 二、环境启动（每次会话必做）

```bash
# 1) Vite 开发服务器（渲染层热更）
cd D:\zcode工作区\PicNest\ui && npm run dev   # 127.0.0.1:5173

# 2) 应用（另开）
cd D:\zcode工作区\PicNest\app
PICNEST_DEV=1 ./PicNest.exe --remote-debugging-port=9222

# 3) 运行时探针（查状态/模拟动作的常备武器）
node tools/cdp-eval.mjs "表达式"   # 经 CDP 在渲染层求值
```

⚠️ 电脑重启后 Vite 和应用都死了，必须先拉起。用户若自己双击 exe（无 dev 服务器/PICNEST_DEV），会加载**过期的 dist 旧构建**——看到"改了没生效"先确认这一点。

## 三、当前状态（截至交接）

### 已完成并验证
- M0-M4 全量：fork+补丁、层级树侧栏（拖拽挪位/排序/参考线/高亮）、三布局虚拟网格、灯箱→大图工作区、四视图+搜索、软删回收站闭环
- 拖入录入三层落点 + Eagle 式查重弹窗（内容级 MD5，已存在 vs 新的文件对比卡）
- Eagle 筛选五件套：颜色（DeltaE76+2000）/形状（含 4:3 精确比与全景 ≥2.5）/评分/格式（左选右排）/文件夹
- 色板系统：详情面板 + 颜色筛选共享 `palettes` 列（后台分步构建 40 张/批）
- Eagle 式专业裁切：全图即选区、8 向手柄、三分网格、比例锁定、**原地替换+原件自动备份**（缓存 crop-backup-*）
- 大图进正文（非覆盖层）：侧栏常驻、顶栏随模式变形、详情=计划式浮岛可收起可拖宽、底部悬浮工具条
- 顶栏回归**顶部玻璃**（用户回滚了底栏方案）：overlay + 拖尾渐隐、面包屑/筛选/布局/排列/滑条(±翼标)/搜索、窗控平贴图标内联右端、◧ 详情开关在窗控组首位

### 最后一个未闭环项（新窗口第一件事）
顶栏交互命中测试修复（drag-surface/controls 兄弟层拆分）**已提交但未经用户物理鼠标验证**：
- 根因：`app-region: drag` 元素自带 backdrop-filter 时，物理鼠标命中测试无视子元素 no-drag（CDP 注入绕过命中测试→之前所有"验证通过"都是假阳性）
- 修法：header 拆成 `.drag-surface`（drag+玻璃）与 `.bar-content`（pointer-events:none 容器 + 交互子元素 auto/no-drag）兄弟层
- **验证方式：只有用户的物理鼠标是真相**。让用户拖滑条/点搜索。若仍失效 → 下一步排查方向：Electron 版本对 no-drag 的支持、或改用无边框窗口+自绘标题栏方案

## 四、关键文件地图

| 文件 | 职责 |
|---|---|
| `ui/src/stores/library.js` | 全部状态与动作（视图/筛选/排序/灯箱/导入/移动/裁剪调度） |
| `ui/src/components/TitleBar.vue` | 顶栏（双模式变形 + 拖拽面/控件分层） |
| `ui/src/components/ImageGrid.vue` | 布局引擎（网格/自适应/瀑布流）+ 虚拟滚动 + 缩略图泵 |
| `ui/src/components/Lightbox.vue` | 大图舞台（变换/裁切交互/底部工具条） |
| `ui/src/components/Inspector.vue` | 详情浮岛（改名/注释/URL/移动/色板/评分） |
| `ui/src/components/FilterBar.vue` | 筛选面板（五分区平铺） |
| `ui/src/lib/eagleColor.js` | Eagle 颜色算法（rgb2lab/DeltaE76/2000/灰度判定） |
| `tools/patches/apply.mjs` | 主进程+preload 补丁（幂等，P1a-P4b，改前自动 .bak） |
| `tools/patches/picnest-handlers.js` | 追加型主进程 handler（picnest-* 全部 IPC） |
| `tools/cdp-eval.mjs` | CDP 运行时探针 |
| `tools/verify_counts.py` | 库/文件系统对账（先拷 db+wal 再查） |
| `docs/PLAN.md` | 规格 + 踩坑记录（10 条，必读） |

## 五、踩坑清单（浓缩版，全量见 PLAN.md）

1. **Vite watcher 漏推**：写文件后 HMR 不触发 → 服务过期模块。**写完必 touch 所有改过的文件**；怀疑时 `curl 127.0.0.1:5173/src/xxx` 比对磁盘内容；不行就 CDP Page.reload
2. **python heredoc 转义链吃字符**（`\n` `\/` `\\`）→ JS 里一律 Write 工具直写；反斜杠用 chr(92)*2；每步 esbuild 仲裁（node --check 不认 ESM）
3. **批编辑一脚 assert 全批丢** → 小步提交，每步落盘验证
4. **CDP 注入绕过 app-region 命中测试** → getComputedStyle/注入事件都可能是假阳性，app-region 问题只有物理鼠标是真相
5. **SQLite WAL**：运行中应用外部只读会读不到 → 拷 db+wal+shm 副本再查
6. **PrintWindow 截图**：最小化窗口只出白帧；偶发旧帧竞态——失败就重试或放弃
7. PicRand 批量缩略图管线会挂死 cpu 信号量 → 我们的分步调用 40 张/批 + 20s 超时
8. app-region: drag 元素自带 backdrop-filter → 子元素 no-drag 物理失效（见三/未闭环项）
9. 单实例锁：与运行中 Steam PicRand 抢 userData → P1c 已修，勿动
10. dev 数据在 `app\_internal_data\`（cwd 相对），正式在 AppData/Roaming/PicNest——别查错库

## 六、待办队列

- **M5 收尾**：主题切换按钮（明暗 tokens 已齐）、dir 记忆持久化（config.json 的 picnestDirMemory/picnestDirOrder 已有读写通道）、标签系统（筛选栏预留了标签 tab 位）
- **M6 采集**：Eagle 兼容 localhost:41595 端点（addFromURL/addFromPath/addFromClipboard），用户 Edge 装着 Eagle for Edge 扩展可直接复用
- **M7 Eagle 迁移**：读 好图.library metadata.json → 按侧栏层级落物理目录树 → 注释/URL/评分/色板灌入（DB 列已备好）
- **用户对齐清单**：随时会发新一批"别扭点"

## 七、验收习惯（保持）

- 每个功能改完：CDP 实证 store 层 → 物理鼠标请用户验证交互层
- 数量对账：`python tools/verify_counts.py`
- 每完成一个里程碑：`git add -A && git commit`（信息写清楚）
- UI 截图验证：PowerShell PrintWindow（最小化窗口会白帧，失败就跳过别纠缠）
