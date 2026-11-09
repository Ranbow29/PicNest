# PicNest (图巢) 🪺

<p align="center">
  <img src="branding/final/picnest-icon-256.png" width="128" height="128" alt="PicNest Logo" />
</p>

<p align="center">
  <strong>直链索引 · 物理无损 · 暖纸金调 · 专为画师与创作者打造的桌面图片素材管理中心</strong><br>
  <em>The in-place, non-destructive desktop digital asset manager for artists and creators.</em>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue.svg" alt="License: GPL-3.0"></a>
  <img src="https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-brightgreen.svg" alt="Platform">
  <img src="https://img.shields.io/badge/version-v0.1.0-orange.svg" alt="Version">
  <img src="https://img.shields.io/badge/electron-33.4-informational.svg" alt="Electron">
  <img src="https://img.shields.io/badge/vue-3.5-brightgreen.svg" alt="Vue">
</p>

---

## 📖 为什么诞生？(Our Philosophy)

市面上许多传统的素材管理软件（如 Eagle），习惯将用户珍藏的图片复制打碎进私有的 `images/<id>.info/` 深度平铺结构中。一旦脱离软件，原本整洁的文件夹层级就会化为乌有，原图名也被剥夺，形成了事实上的“数据黑盒绑定”。

**PicNest 坚信：你的物理文件系统本身才是唯一的真理。**

- **直链索引（In-place Direct Link）**：直接以你的本地文件夹为根。PicNest **绝不复制、绝不搬迁、绝不打散**你的原图，物理目录就是分类树。
- **数据随盘（In-root Metadata）**：根内隐藏 `.picnest/meta.json` 自动跟随硬盘漫游，标签、注释、评分与层级信息拔盘即走。
- **移出不伤骨肉**：在 PicNest 中“移出根目录”只解除索引，磁盘文件永不触碰。
- **自由与纯净**：开源遵循 **GPL-3.0**，彻底剥离第三方商业平台与遥测代码，无内购、无联网绑定，完全离线可用。

---

## ✨ 核心特性 (Highlights)

### 🎨 创作者级视觉与交互手感
- **纸金美学与浮岛微光**：主面板采用浮岛投影设计，卡片边缘配备细腻顶缘高光，搭配自然入场波浪。
- **六套定制主题**：暖砂（温暖米金）、靛夜（深邃蓝紫）、灰白（中性低饱和）、炭黑（深沉微灰）、墨黑（纯粹极夜）、跟随系统。
- **Wenku8 灵动微动效**：文件夹展开与交互配备丝滑弹簧回弹手势，兼具高级感与灵动生命力。
- **有界虚拟网格**：网格采用 1024px 有界缩略图缓存降级链，即使浏览十万张大图也不会击穿 Chromium 解码内存预算，彻底告别裂图与卡死。

### 📂 灵活排序与物理改名双轨制
- **默认手动排序**：支持鼠标任意拖动自由调序，新图入库自动置顶（`sort_order=0`）。
- **物理改名同步（可选开关）**：开启后，调序会自动执行原子两阶段文件重命名（`01_原名.ext`），资源管理器里也能直接呈现相同顺序。
- **一键隐藏排序编号**：顶栏一键切换 `01` 隐藏编号模式，只在显示层剔除数字前缀，磁盘文件名不动。
- **一键清除全局编号**：如果不想保留文件名编号，右键根文件即可一键安全恢复全库原始干净文件名。

### 🔍 双轨查重引擎 (Duplicate Hunter)
- **精确查重**：按文件体积智能分桶，并发流式 MD5 比对，支持随时秒级取消与进度反馈，保留最新/最大/最旧快捷清理。
- **视觉 AI 查重**：
  - 本地流水线：**dHash 候选初筛 → 32×32 色块比对 + 64-bit pHash 二次筛选**，在本地斩断 97.5% 无效计算。
  - 云端大模型视觉判断：仅将高度疑似的候选缩略图（绝不上传原图）交给 OpenAI 兼容的视觉 API 判定，支持费用预估与本地密钥安全加密存储。

### 🧩 画师零门槛插件系统 (Plugin Sandbox)
无需配置任何编程环境，画师和创作者也能轻松打造属于自己的扩展：
- **Theme 插件**：纯 CSS 变量覆盖，改改颜色就能做出一套全新皮肤！
- **Renderer 插件**：单文件 HTML 沙箱隔离（无 Node 越权风险），通过 postMessage 安全接口读取当前库只读数据，轻松写出色卡面板、番茄钟、参考画板。
- **插件管理库**：应用内自带插件库，支持直接从文件夹加载或从社区 Registry ZIP 安装/启停/卸载。

### 🌐 自研浏览器采集扩展 (MV3 Extension)
- 支持 Edge 与 Chrome（开发者模式一键加载）。
- **按住采集手势**：网页图片上按住 0.4 秒弹出环形分类面板，支持拖拽保存到指定文件夹或库根，支持覆盖/跳过查重。
- 本地专用接口 `127.0.0.1:41600`，图片由主进程下载并自动附带页面 Referer 防盗链头。

### 🦅 Eagle 库无损物化迁移向导
- 内置向导工具，一键解析 Eagle `.library` 的平铺碎片，自动将其还原重构成直观、清晰的常规物理文件夹树。
- 完整恢复 100% 的原始标签、URL、评分与缩略图。

---

## 🚀 画师与用户快速上手 (Portable Download)

PicNest 是专为创作者打造的绿色便携软件：

1. 前往 [Releases 页面](https://github.com/Ranbow29/PicNest/releases) 下载最新的便携包：  
   `PicNest-v0.1.0-windows-x64.zip`
2. 解压到你的电脑任意目录（如 `D:\PicNest`）。
3. 双击运行 `PicNest.exe`，点击左侧添加你的本地图片文件夹，即刻开启极致看图体验！

> 💡 **绿色便携**：数据存储在本地，不写注册表。若想卸载，直接将软件目录扔进回收站即可，你的原始图片绝不受任何影响。

---

## 🎨 画师 5 分钟极速插件教程

做插件完全不需要碰底层代码！

### 制作专属配色主题 (Theme)
1. 新建一个文件夹 `my-theme`；
2. 里面放两个文件：
   - `plugin.json`：
     ```json
     {
       "id": "com.artist.mytheme",
       "name": "初音绿微光",
       "version": "1.0.0",
       "type": "theme",
       "entry": "theme.css"
     }
     ```
   - `theme.css`：
     ```css
     :root {
       --accent: #39c5bb;
       --accent-hover: #4de0d6;
     }
     ```
3. 打开 PicNest，左下角进入「插件库」→ 点击「从文件夹安装」选择你的目录，秒级生效！

*(更多高级插件接口与示例见 [docs/PLUGIN.md](docs/PLUGIN.md) 与 [examples/plugins/](examples/plugins/))*

---

## 💻 开发者从零构建 (Developer Setup)

PicNest 采用 Electron 33 + Vite 6 + Vue 3.5 技术栈：

```bash
# 1. 克隆仓库
git clone https://github.com/Ranbow29/PicNest.git
cd PicNest

# 2. 安装并构建前端界面 (产物自动同步至 app/resources/app/dist)
cd ui
npm ci
npm run build
cd ..

# 3. 运行主进程补丁 (自动从 source/ 源码镜像同步并幂等打补丁)
node tools/patches/apply.mjs

# 4. (可选) 写入 exe 图标与 VersionInfo 资源
node tools/patches/patch-exe-resources.mjs
```

### 本地 Dev 调试模式
```bash
# 终端 1: 启动 Vite 开发服务器
cd ui && npm run dev

# 终端 2: 启动 Electron (监听 9222 调试端口与本地开发服务)
powershell "$env:PICNEST_DEV='1'; Start-Process 'app\PicNest.exe' -ArgumentList '--remote-debugging-port=9222' -WorkingDirectory 'app'"
```

---

## 📜 许可证与归属 (License & Attribution)

- **主项目授权**：本项目遵循 **[GNU General Public License v3.0 (GPL-3.0)](LICENSE)** 自由软件协议开源。
  - 版权归属：Copyright (C) 2026 **Ranbow29**
- **上游血统**：衍生自 **PicRand 2.77.0**，保留其 GPL-3.0 原始授权声明。
- **动效文件夹图标**：移植自 **Wenku8** (`archive_icon_fold_art`)，遵循 GPL-2.0-or-later 许可。
- **完整第三方组件与法务说明**：请参阅根目录 **[NOTICE](NOTICE)** 文件。

---

<p align="center">
  <em>Made with 💖 for digital artists, illustrators, and creators everywhere.</em>
</p>
