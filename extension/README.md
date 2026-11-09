# PicNest 图巢采集（浏览器扩展）

把网页图片 / 页面截图保存进 **PicNest 图巢**。扩展只与本机 `127.0.0.1:41600` 通信，
不经过任何云端；图片由 PicNest 主进程下载并落进你选的目标文件夹。

## 安装（Edge / Chrome / Chromium，开发者模式）

1. 启动 PicNest（主进程会自动监听 `127.0.0.1:41600`）。
2. 打开 `edge://extensions`（Chrome 用 `chrome://extensions`）。
3. 打开右上角「开发人员模式」。
4. 点「加载解压缩的扩展」，选择本目录 `PicNest/extension`。
5. 点扩展图标打开面板：应显示「已连接」，可选根文件与目标文件夹。

> **Chrome**：同一份扩展，不需要改 manifest；Chrome 137+ 已禁用 `--load-extension` 命令行，请用上面的
> `chrome://extensions` UI 加载。Edge/Chrome 都用标准 MV3 API（contextMenus / scripting / notifications /
> storage / tabs），扩展本身没有 Edge 专属调用。
>
> 首次保存 `file://` 页面图片时，需要在扩展详情里打开「允许访问文件 URL」。
>
> **更新扩展后**：在 `edge://extensions` / `chrome://extensions` 点重载，并**刷新所有已打开的网页**。
> 旧页面里的 content script 会失效，按住面板会提示「扩展已更新，请刷新此页面」。

## 用法

- **按住采集**：在网页图片上左键按住约 0.4 秒（光标处环形进度）→ 弹出面板：
  左侧大片「未分类」= 库根，右侧 = 当前根下全部文件夹（缩进列表，列表可滚动）。
  拖到目标松开即保存；松开在面板空白处则面板停留，可点击选择；Esc / 点外部取消。
  移动超过 6px 会取消长按，不影响页面自己的拖拽/点击。
- 网页图片上右键 → **保存图片到图巢**。
- 页面空白处右键 → **保存页面截图到图巢**（当前可见区域）。
- 扩展面板里选好「根文件 / 保存到」，之后右键/按住保存都进这个文件夹；选「根目录（库根）」= 库根。
- 面板里的「在网页上按住图片采集」可关闭长按手势（只保留右键）。
- **采集会查重**：同根内同尺寸候选 → MD5 相同即视为重复；按住面板会提示「图库里已有相同图片」，可选**跳过**、
  **覆盖旧图**（旧图移入图巢回收站，再保存新图）或**仍然保存**（保留两张）。右键/页面截图遇到重复只提示不保存。
- 未分类图标沿用 PicNest 的 FolderIcon 几何与弹簧手势（Wenku8 `archive_icon_fold_art`，GPL-2.0-or-later，与本体 GPL-3.0 兼容）。
- 面板右栏底部「＋ 新建文件夹…」：在当前根文件的**库根**新建（同名自动加序号），创建后新夹会高亮，点它即保存。
  暂不支持在子文件夹下新建；需要层级时先在 PicNest 里建好再采集。

## 当前范围 / 限制（v0.1）

- 支持：网页图片（含 `data:` / `blob:`）、页面可见区域截图、按住采集面板（全部文件夹 + 原生滚动）。
- 不支持：整页滚动截图、视频、PDF；标签（PicNest 标签系统尚未实现，扩展不发送标签）。
- 防盗链图片可能下载失败（PicNest 服务端下载不带浏览器 Cookie）；服务端会带页面 Referer + 常规浏览器 UA
  （Pixiv `i.pximg.net` 依赖 Referer）。`data:` / `blob:` 图片由扩展转 base64 发送。
- 按住采集只挂主 frame 的 `<img>`：跨域 iframe、CSS 背景图、canvas 图片暂不识别；被覆盖层 DIV 挡住的图片
  会先用 `elementsFromPoint` 找底层 `<img>`，找不到时按坐标扫描全部可见图片（Pinterest 会把图片设成
  `pointer-events:none`，`elementsFromPoint` 会跳过它）。面板行点击也用坐标兜底，兼容站点 `setPointerCapture`。
- 仅供本机使用：服务端绑定 `127.0.0.1`，并拒绝非扩展 Origin 的跨站请求；**暂无 token 鉴权**，
  开源发布前会补上（见根目录 HANDOFF 的未做清单）。
- 与本项目一样以 **GPL-3.0** 发布；代码原创，与 Eagle 官方无关联，也不包含 Eagle 的任何资源。

## 目录

| 文件 | 作用 |
|---|---|
| `manifest.json` | MV3 清单（contextMenus / notifications / storage / scripting） |
| `background.js` | 右键菜单、图片地址处理、页面截图、POST 到 PicNest 本地服务 |
| `popup.html/css/js` | 连接状态、根文件/文件夹选择、保存当前页面 |
| `icon*.png` | 扩展图标（巢 + 蛋） |
