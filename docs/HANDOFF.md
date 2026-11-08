# PicNest 图巢 — 交接文档（写给下一个窗口）

> **2026-11-09 第五版**。上一窗口（11-08 深夜）收官于 commit `4d84dd5`，工作区干净。
> 前一日的四版覆盖：拖窗战役 → 颜色对齐 Eagle 真源 → 资料库重构 → 动效系统 → 滑尺 → 生产模式验收。
> 本版为隔日续接版：状态全量核对 + 今日议题清单 + 开窗三步走。

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

**视图与设置**
- 全部 = 最新入库置顶（锁死，忽略升降序开关）；文件夹 = 排序面板（name/added/mtime/size × 升降序）
- 未分类 = 库根散图（侧栏在最近使用之下，当前 3 张）
- 持久化：布局方式 / 缩放 / 排序 / 资料库选择；详情面板初始收起

**其它**
- 手动拖窗（winDrag + P6）：尺寸守恒（resize 监听挂 whenReady + 拖动前自愈）
- 置顶按钮：接 isAlwaysOnTop 查询，点亮反馈
- 颜色筛选对齐 Eagle 真源（25% 门槛/白底特例/d2000+d76）+ 任意色板精确命中保原图 + HSV 面板 + 屏幕吸色
- 裁剪三选一：另存为副本（写原目录自动入库）/ 覆盖原图（自动备份）/ 取消
- 回收站：丢回收站=软删可还原；从库移除=只摘索引

## 四、今日议题（Feb 指定，按此顺序）

1. **录入的细分与归类规则** ← 首要议题
   - 待商讨：拖入落点规则细化（当前：拖到树行=进该文件夹，拖到侧栏空白=库根→未分类）、导入归类策略、批量导入的分流
   - 可挂在「未分类」视图上做收口（未分类 = 库根散图，天然是"待归类"入口）
2. 标签系统（筛选栏预留了标签位）
3. 主题切换按钮（明暗 tokens 已齐备）
4. 目录删除（含图确认流）、尺寸/评分排序补全
5. 滑尺 Monaco 细节（hover 预览）

**技术债**：`tools/verify_counts.py` 是单库时代脚本，多资料库下账目显示混乱，需升级。

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
| `tools/patches/apply.mjs` · `picnest-handlers.js` | 补丁 P1-P6 + 文件夹管理 5 原语 + 未分类 + 拖窗 |
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
8. 每完成一役 `git commit`；数量对账 `python tools/verify_counts.py`
