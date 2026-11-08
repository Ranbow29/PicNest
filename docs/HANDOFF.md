# PicNest 图巢 — 交接文档（写给下一个窗口）

> 2026-11-08 第四版（收官版）。前三版覆盖拖窗/颜色/资料库动效战役；本版加入生产模式与验收流程。

## 一、这是什么项目

PicNest 图巢：**GPL-3.0 fork 自 PicRand 2.77.0** 的看图软件，替代 Eagle 日常使用。
核心设计：**直链索引**（不复制文件，SQLite 只存 file_path，物理文件夹 = 真源）。

- 仓库：`D:\zcode工作区\PicNest`（git ✓，最新 commit 见 `git log`）
- 布局：`app\`（运行时 + dist 构建产物）· `ui\`（Vite+Vue3）· `tools\`（补丁/探针）· `docs\`
- **文档三件套**：`PLAN.md`（规格 + 踩坑 20 条，必读）· `MOTION.md`（动效规格/密度学/调参速查）· 本文
- 库：好图（6,674）+ 素材（38）双资料库；Eagle 参照本体 `D:\zcode工作区\eagle\Eagle`

## 二、两种运行模式（务必分清）

| | 双击模式（生产） | dev 模式（开发） |
|---|---|---|
| 启动 | 双击 `app\PicNest.exe` | `PICNEST_DEV=1` + Vite 5173 |
| 界面 | `app\resources\app\dist`（**改完必须 npm run build**） | 实时热更 |
| 数据 | `C:\Users\feb\AppData\Roaming\PicNest` | `app\_internal_data\`（CWD 相对！） |

```bash
# dev 启动（-WorkingDirectory 必须给 app\，否则数据目录建到错误位置）
cd D:\zcode工作区\PicNest\ui && npm run dev
powershell "$env:PICNEST_DEV='1'; Start-Process 'D:\zcode工作区\PicNest\app\PicNest.exe' -ArgumentList '--remote-debugging-port=9222' -WorkingDirectory 'D:\zcode工作区\PicNest\app'"

# 发布到双击模式：build（+ 需要时同步数据）
cd ui && npm run build
# 数据同步（dev → 生产）：拷 picrand.db / config.json / cache 到 Roaming\PicNest（应用需先关）
```

## 三、验证工具（本轮新增，重要）

```bash
node tools/cdp-eval.mjs "表达式"              # 常规求值
node tools/cdp-eval.mjs "@C:\path\probe.js"   # 表达式走文件（免 shell 转义，推荐）
node tools/cdp-active-eval.mjs "@probe.js"    # 动画验证专用：强制 active + 焦点模拟
node tools/cdp-shot.mjs out.png               # 渲染层截图
node tools/cdp-reload-probe.mjs               # reload 并抓页面异常
powershell -File tools/shot-prod.ps1 <out.png>  # 生产窗口截图（PrintWindow；输出用 ASCII 路径）
```

⚠️ **验证动画前必须确认窗口非最小化**（踩坑 #19）：最小化时 rAF 冻结，采样全同态会误判"动效坏了"。
⚠️ **生产构建无 `__vueParentComponent`**，只能采样 DOM 属性。

## 四、当前状态（全部已验收）

- **资料库（Eagle 式）**：多库切换+记忆 · ＋=库内新建 / ⌂=加库 · 右键菜单（新建子/同级、重命名、排序 6 式、移动、递归导出、8 色图标）· 空文件夹可见
- **动效系统**（Wenku8 Flutter GPL-2.0-or-later 移植，合规声明在 PLAN）：入场波 520ms · 动效图标原版几何（滑轨横移/reflow/方格上浮/自适应三横条/star 旋转/contents 滑线）· **集体晃动总线**（切视图/文件夹/库、关大图、面板开关、详情开合）· **随机自弹已彻底移除**（ambient 默认 false、顶栏 ambient 属性已清）
- **概览滑尺**：fixed 钉窗口右缘、详情浮岛覆盖；48 槽内容轮廓 + cos² 波峰行进 + 金色指示 12px
- **视图**：全部=最新入库置顶 · 文件夹=排序面板（name/added/mtime/size × 升降序）· **未分类**（库根散图，3 张）
- **设置持久化**：布局方式 / 缩放 / 排序 / 资料库选择（localStorage）；**详情面板初始收起**
- **拖窗**：手动拖窗 + 尺寸守恒（resize 监听挂 whenReady + 拖动前自愈）
- **置顶按钮**：接 isAlwaysOnTop 状态查询，点亮反馈（此前是盲 toggle，事故已修）
- 前情：颜色筛选对齐 Eagle 真源、HSV+屏幕吸色、裁剪三选一（另存为副本）

## 五、待办 / 下窗口议题

1. **录入的细分与归类规则**（Feb 指定议题）：拖入落点细化、导入归类策略，可挂在未分类视图上
2. 标签系统（筛选栏预留位）· 主题切换按钮（明暗 tokens 已齐）
3. 目录删除（含图确认流）· 尺寸/评分排序补全
4. 滑尺 Monaco 细节（hover 预览）
5. `tools/verify_counts.py` 仍是单库时代脚本，多资料库下账目显示混乱，需要升级

## 六、关键文件地图

| 文件 | 职责 |
|---|---|
| `ui/src/stores/library.js` | 全部状态与动作（switchRoot/文件夹管理/筛选/灯箱/色板索引/collectiveShake 调用点） |
| `ui/src/lib/winDrag.js` · `iconMotion.js` · `wave.js` | 手动拖窗 · 图标弹簧+集体晃动总线 · 入场波 |
| `ui/src/components/AnimIcon.vue` · `FolderIcon.vue` | Wenku8 动效图标（六字形）· 文件夹动效图标 |
| `ui/src/components/TitleBar.vue` · `SideBar.vue` · `DirTreeItem.vue` | 顶栏（动效钮/分段钮/置顶态）· 资料库区+视图入口 · 树行 |
| `ui/src/components/ImageGrid.vue` | 布局引擎+虚拟滚动+**概览滑尺**+入场波 |
| `ui/src/components/DirContextMenu.vue` · `NamePromptDialog.vue` | 文件夹菜单 · 名称对话框 |
| `ui/src/components/FilterBar.vue` · `ColorPicker.vue` · `Inspector.vue` | 筛选（eyebrow 分区）· HSV 取色 · 详情（色板可点） |
| `tools/patches/apply.mjs` · `picnest-handlers.js` | 补丁 P1-P6 + 文件夹管理 5 原语 + 未分类 + 拖窗 |
| `docs/MOTION.md` | 动效规格/调参速查（改手感先看它） |

## 七、工作纪律（保持）

- 改 JS 一律 Write 脚本文件再执行（**新 shell 会截断多行 `python -c` 且静默**，踩坑 #7 变体）
- 改完 touch 目标文件；主进程改动重放 patch + 重启；**生产验证前必须 npm run build**
- CDP 实证优先，物理交互只有用户的鼠标是真相（app-region 血泪 #11）
- 每完成一役 git commit；数量对账 `python tools/verify_counts.py`
