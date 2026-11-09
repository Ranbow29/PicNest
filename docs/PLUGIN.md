# PicNest 插件仓库设计（docs/PLUGIN.md）

> 2026-11-09 立项设计，供后续实现与外部开发者参考。目标：让第三方开发者能给 PicNest 写功能插件
> （界面面板 / 菜单项 / 数据处理 / 主题），并有一个可浏览、可安装、可卸载的插件仓库。
> 原则：**宿主是 GPLv3，插件是独立作品**；安全边界优先于功能丰富度；API 面向"能力"而非"内部对象"。

## 〇、一句话架构

```
插件 = 一个带 plugin.json 清单的文件夹
宿主 = 清单校验器 + 三种运行环境（theme 纯 CSS / renderer 沙箱 iframe / main 独立进程）
仓库 = 一个 Git 仓库：registry.json 索引 + plugins/<id>/<version>.zip（带 sha256）
安装 = 下载 zip → 校验 → 解压到 dataDir/plugins/<id>/ → 清单声明的权限给用户过目 → 启用
```

> **实现状态（2026-11-09）**：P1/P2 已落地——theme 插件（CSS 注入）、renderer 插件（`srcdoc` 单文件 HTML + `sandbox="allow-scripts"` + postMessage 桥 + query/storage/fetch/events）、插件库 UI（已安装/仓库页签、文件夹安装、registry zip 安装 + sha256、启停/卸载）。示例见 `examples/plugins/`（含 `registry.json` 与 zip）。
> 未实现：main 插件（P3）、签名校验（P4）、`ui.contextMenu` 插槽、多文件资源（renderer 目前要求单文件 HTML，资源用 data URL）、默认在线 registry。**安全边界沿用本文：renderer 无同源/无 Node/无宿主 DOM；query 只读当前资料库；fetch 只放行声明 origin。**

## 一、三种插件类型（按风险从低到高）

| 类型 | 运行环境 | 能力 | 风险 | 阶段 |
|---|---|---|---|---|
| `theme` | 渲染层直接注入 | CSS token 覆盖（颜色/圆角/动效参数） | 低：无代码执行 | P1 |
| `renderer` | 沙箱 `iframe sandbox="allow-scripts"` + postMessage RPC | UI 插槽、事件订阅、只读查询、自己的存储 | 中：无 Node、无 DOM 越权 | P2 |
| `main` | `utilityProcess`（独立进程，默认不给特权） | 宿主代理过的 fs/db/网络 | 高：必须过权限网关 | P3 |

**明确不做**：给插件直接 `require('better-sqlite3')` 或暴露 `db` 句柄；给渲染层插件 Node；
`webview` 标签（Chromium 老接口，攻击面大）。

## 二、清单 plugin.json（全部类型通用）

```jsonc
{
  "id": "com.example.fav-rank",        // 反域名，全局唯一，= 安装目录名
  "name": "收藏排行",
  "version": "1.2.0",                  // 插件自身 semver
  "api": "^1.0.0",                     // 依赖的 PicNest 插件 API 版本（宿主 semver 校验）
  "type": "renderer",                  // theme | renderer | main
  "author": "...",
  "license": "MIT",                    // 插件独立授权；GPLv3 宿主动态加载不强制传染，但仓库推荐 GPL 兼容
  "entry": "index.html",               // renderer: iframe 入口；main: index.cjs；theme: theme.css
  "permissions": [                     // 未声明 = 拒绝（deny by default）
    "events.read",                     //   订阅 选择/视图/开关灯箱 等事件
    "data.images.read",                //   只读查询图片元数据（自动限定已登记根）
    "ui.panel", "ui.context-menu",     //   UI 插槽
    "storage",                         //   插件私有 KV（宿主管存取）
    "net:https://api.example.com"      //   只允许声明的 origin
  ],
  "ui": {                              // 声明要占的插槽（宿主据此渲染入口）
    "panels": [{ "slot": "inspector-tab", "title": "排行", "icon": "star" }],
    "contextMenu": [{ "scope": "image", "label": "加入排行" }]
  }
}
```

## 三、权限模型

- 安装/更新时弹**权限确认卡**（复用 ConfirmDialog 风格）：逐条列出权限的人话解释。
- 运行期网关逐调用校验：`data.images.read` 只能查到**已登记根**内的元数据，永远拿不到任意路径读盘；
  `net:` 只放行清单里列过的 origin（主进程代理 fetch，插件进程不出网）。
- 权限变更（插件升级加了权限）→ 重新确认，否则保持禁用。
- 插件管理页可随时禁用/卸载；禁用 = 停止事件投递 + 隐藏 UI + main 进程 kill。

## 四、API 表面（`window.__picnestPluginHost__`，仅注入给插件 iframe）

```js
// 生命周期
picnest.ready({ apiVersion, locale, roots })
picnest.onDispose(fn)
// 事件（只读订阅；投递是异步快照，不给活引用）
picnest.on('selection-changed', ({ paths, dirs }) => {})
picnest.on('view-changed', ({ rootId, view, rel }) => {})
picnest.on('image-opened', ({ path }) => {})
// 数据（P2 只读；P3 以后再谈写回）
picnest.query.images({ rootId, rel, limit, sort })   // → 行快照
picnest.query.roots() / query.tags(rootId)
// UI（宿主把 DOM 挂进来，插件只拿到自己的容器）
picnest.ui.mountPanel(slot, (el, ctx) => { /* 渲染 */ })
picnest.ui.addContextMenuItem(scope, label, async (payload) => {})
// 存储（插件目录下 host-storage.json，宿主管并发与配额 5MB）
picnest.storage.get(key) / set(key, value)
// 网络（主进程代理，校验 origin 权限）
picnest.fetch(url, init)
```

版本策略：`PICNEST_API_VERSION` 主版本号变更 = 破坏性，旧插件标黄并停用；次版本号只加不拆。

## 五、仓库格式（GitHub 仓库即仓库）

```
picnest-plugins/                 # 一个 Git 仓库（Feb 的 GitHub 上）
  registry.json                  # 索引：元数据 + 最新版本 + 下载地址 + sha256
  plugins/
    com.example.fav-rank/
      1.2.0.zip                  # 内容 = 插件文件夹（plugin.json 在根）
      1.2.0.zip.sha256
```

- `registry.json` 条目：`{ id, name, description, author, license, latest, api, tags[], homepage, download }`。
- **收录规则**（写进仓库 README）：人工 PR 审核——清单完整、权限最小化、无混淆、无远程代码加载、
  许可证明确、不含 Eagle 等闭源资产（沿用本项目纪律）。
- 应用内「插件」页：已安装 / 仓库浏览（拉 registry.json）→ 安装（下载→校验→确认权限→落盘）/ 更新 / 卸载。
  也支持「从文件夹安装」（开发者路径）与 dev 模式 `--load-plugin=<path>` 热重载（chokidar 监听）。
- P4 之前不签名；P4 引入 minisign 式签名（私钥在维护者手里，registry 带公钥），安装器校验。

## 六、renderer 沙箱细节

- `<iframe sandbox="allow-scripts" src="plugin entry">`，**不加 allow-same-origin** → 插件拿不到
  `localStorage`/`document.cookie`/宿主 DOM，只有 postMessage。
- 宿主侧 bridge：所有调用走 `postMessage` + 序列化快照（structured clone 不传函数/元素）；
  每条消息带 `pluginId + seq`，网关先查权限再执行。
- CSP：iframe 内 `script-src 'self'`（插件自己的文件），禁止 `connect-src *`（网络一律走 picnest.fetch）。
- 崩溃隔离：iframe 死了不影响宿主；`onDispose` 超时 3s 强制拔 DOM。

## 七、main 插件细节（P3）

- `utilityProcess.fork(entry, [], { serviceName })`，插件进程**不注入 preload**，唯一通道 = MessagePort RPC。
- 宿主网关实现 `fs.read(rootPath 限定)`、`db.query(白名单 SQL 模板)`、`net(origin 白名单)`；
  插件进程永不接触 `dataDir` 配置、缩略图缓存写权、采集服务端口。
- 资源上限：单插件内存 >256MB / CPU 持续 >80% 10s → 宿主 kill + toast。

## 八、分阶段路线（每阶段独立可用、可验收）

- **P1 骨架（theme 插件 + 管理页）**：清单解析/校验器、`dataDir/plugins` 扫描、启用禁用持久化、
  theme 注入（`<style data-plugin="id">`，主题系统之后再叠）、设置里「插件」页、示例插件 `mono-mint`（灰绿主题包）。
- **P2 renderer**：沙箱 iframe + bridge + 事件 + 只读查询 + 插槽（详情页签 / 右键菜单项）+ 示例 `fav-rank`
  （详情页签显示当前根收藏 Top10）。
- **P3 main**：utilityProcess + 权限网关 + storage + fetch 代理 + 示例 `md5-export`（导出全库 MD5 清单 CSV）。
- **P4 仓库**：GitHub 仓库 + registry 拉取/安装/更新 + 签名校验 + 收录指南文档。

## 九、与现有架构的接缝（实现时注意）

- 渲染层入口点：插件管理页挂 `SideBar` 底部入口 + App.vue 新组件（沿用 Vite polling/重启纪律）。
- 事件源都在 store 已有 action 里（openDir/switchRoot/toggleInspector/…… 已接 `collectiveShake` 的位置顺手 `emitPluginEvent`）。
- 查询走主进程新 IPC `picnest-plugin-query-*`（复用 imagesByDir 的 SQL，但**强制 folder_id 限定 + LIMIT 上限**，见纪律 8）。
- 主题插件与 `lib/theme.js` 的关系：theme 插件只在 `data-theme` 基础上叠 token，不允许整页覆盖（保住五套内置主题口径）。
- 打包：`plugins/` 在 dataDir（用户数据），不进 asar；`--load-plugin` 仅 `PICNEST_DEV=1` 生效。
