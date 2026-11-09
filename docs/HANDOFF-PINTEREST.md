# Pinterest 采集「切标签不刷新就失效」交接

> 给下一个窗口的专注交接。**这是目前唯一剩下的硬骨头。**
> 阅读顺序：本文 → `extension/background.js` / `extension/content.js` → `docs/HANDOFF.md` 的「采集（M6）」小节 → `extension/README.md`。
>
> **2026-11-10 状态：已按方案 A+B+C 实现扩展 v0.1.4（`dev`），待 Feb 在 Chrome 重载扩展后物理验收。**
> 实现细节与决策表见第 9 节；无头回归 `node tools/test-collect-script.mjs` / `node tools/test-collect-background.mjs`。

## 0. 一句话结论

Chrome 里的扩展已经是 **v0.1.3**，background 的 `tabs.onActivated/onUpdated/onHighlighted` 事件也已注册，但**从已打开的 Pinterest 标签切回来时，页面里很可能还是旧 content script（或部分初始化的旧脚本）**。旧脚本的 `__picnestHoldCollectLoaded = true` 会挡住 v0.1.3 的补注入，所以后台探测到“未就绪”、注入却被页面守卫直接 return；刷新页面才会换成 v0.1.3。  
**下一步最可能需要做的是：版本化探测 + 对 stale content script 做一次性自动 reload（或提供等价的重建机制），而不是继续加注入重试。**

## 1. 用户症状（原话）

> 「pinterest 再次出现从标签进入不刷新页面采集就失效的 bug」
> 「我用的是谷歌那个，已经 0.1.3」
> 「从标签进入不刷新采集就失效；点开图片也没用，刷新就又可以用了」
> 「依然还有这个问题」

复现语义：
1. Pinterest 已在某个标签打开。
2. 切走再切回该标签（或从别的窗口切回）。
3. **不刷新**直接长按图片 → 无进度环/无面板/采集不工作。
4. 点开某张 pin（SPA 路由）也没用。
5. 手动刷新 Pinterest → 立刻恢复。

## 2. 当前环境证据（2026-11-10）

- 用户用的是 **Google Chrome**，不是 Edge。
- Chrome 配置：`C:\Users\feb\AppData\Local\Google\Chrome\User Data\Default\Secure Preferences`
- 扩展 id：`fpnalmdfdmlklipkfhhdmgoaaikhinam`
- 扩展路径：`D:\zcode工作区\PicNest\extension`（**开发版路径，不是 PicNest-Public**）
- 服务端：PicNest 主进程 `127.0.0.1:41600` 正常，采集日志只有 listening/saved/error，没有异常。
- Chrome 记录：
  - `service_worker_registration_info.version = "0.1.3"`
  - `serviceworkerevents = ["contextMenus.onClicked", "runtime.onInstalled", "runtime.onStartup", "tabs.onActivated", "tabs.onHighlighted", "tabs.onUpdated"]`
  - `windows.onFocusChanged` 未出现在记录里（可能只是没触发过，不一定是 bug）。

**这说明**：
- background.js v0.1.3 已经加载；
- 切标签时后台的补注入事件应该会跑；
- 用户已手动 reload 扩展并到 0.1.3；
- 问题不在“扩展没重载”这一层了。

## 3. 已做过的修复（时间线）

- **v0.1.1**（Public `44f36ff`）：Pinterest 给 `<img>` 设 `pointer-events:none`，`elementsFromPoint` 会跳过图片 → `imgAtPoint` 增加几何扫描；面板行选择加坐标兜底。
- **v0.1.2**（Public `b1a751b`）：background 在 `tabs.onActivated` / `tabs.onUpdated` / `onStartup` / `onInstalled` 注入 `content.js`；content.js 顶部 `__picnestHoldCollectLoaded` 守卫做幂等。
- **v0.1.3**（Public `68468b7` / 开发版 `bc255ed`）：
  - content.js 把 `Loaded/Version` 移到**所有监听器注册完成之后**；
  - background 先用 `executeScript(func)` 探测 `Loaded && Version`，未就绪才注入；
  - 注入失败按 350ms/1200ms 重试两次；
  - 监听 `tabs.onActivated`、`tabs.onUpdated`、`tabs.onHighlighted`、`windows.onFocusChanged`；
  - service worker 启动时 `ensurePinterestTabs()`，1.5s/4.5s 再补。

v0.1.3 之后用户仍然复现，说明**补注入被页面里的旧脚本挡住了**，或者注入成功但页面状态本身失效。结合“刷新就好”，前者概率最高。

## 4. 代码路径与关键点

### 4.1 扩展端

`extension/background.js`
- `contentReady(tabId)`：向页面执行
  ```js
  !!(window.__picnestHoldCollectLoaded && window.__picnestHoldCollectVersion)
  ```
  未就绪则 `executeScript({ files: ['content.js'] })`。
- 监听：`tabs.onActivated`、`tabs.onUpdated`（complete/url）、`tabs.onHighlighted`、`windows.onFocusChanged`。
- `ensurePinterestTabs()` + `ensurePinterestSoon()`（启动/1.5s/4.5s）。

`extension/content.js`
- 顶部：
  ```js
  (() => {
    if (window.__picnestHoldCollectLoaded) return
    ...
  ```
- 底部（v0.1.3 起）：
  ```js
  window.__picnestHoldCollectLoaded = true
  window.__picnestHoldCollectVersion = '0.1.3'
  ```
- 长按采集：`pointerdown` 捕获 → 380ms → 面板；`imgFromEvent` / `imgAtPoint`（含 pointer-events:none 几何扫描）。
- 没有 `chrome.runtime.onMessage` ping 监听，也没有“清理旧监听器”的机制。

### 4.2 关键冲突

旧版（v0.1.2 或更早）content script 在页面里已经设置了 `Loaded = true`，但没有 `Version`：

1. background `contentReady` 探测 → `Loaded && Version` 为 false；
2. background 尝试注入 v0.1.3 `content.js`；
3. 新脚本顶部看到 `Loaded` 已为 true → **直接 return**；
4. 旧脚本可能只是“部分初始化”（或被 bfcache/页面状态弄坏），于是页面永远没有可用的采集监听；
5. 刷新页面 → 旧脚本消失，manifest 注入 v0.1.3 → 正常。

这可以同时解释：
- 为什么扩展版本已经是 0.1.3；
- 为什么 background 事件也注册了；
- 为什么刷新一定好；
- 为什么“补注入重试”完全无效。

## 5. 下一步建议（按优先级）

### 方案 A（推荐）：版本化 + 对 stale 页面做一次自动 reload

修改 `contentReady` 返回对象而不是 boolean：

```js
const info = await chrome.scripting.executeScript({
  target: { tabId },
  func: () => ({
    loaded: !!window.__picnestHoldCollectLoaded,
    version: window.__picnestHoldCollectVersion || '',
  }),
})
```

`ensureCollectScript` 分支：
- `!loaded` → 注入 content.js（正常补注入）；
- `loaded && version === CONTENT_VERSION` → 正常，直接返回；
- `loaded && version !== CONTENT_VERSION` → **旧脚本/半初始化**：
  - 推荐：`chrome.tabs.reload(tabId)` 一次，并记录 `chrome.storage.session` 的 `tabId -> reloadedVersion`，避免循环；
  - 或 `chrome.scripting.executeScript` 注入一个只做 `location.reload()` 的小函数；
  - reload 后 manifest 自动注入最新 content script，用户不需要手动刷新。

注意：
- 只在 Pinterest 标签或用户切回该标签时做，不要全浏览器刷；
- 加 `session` 标记，避免每次 activation 都 reload；
- 如果用户正在该标签输入/滚动，自动 reload 会打断，需要在实现时权衡；可先只在 `tabs.onActivated` 且页面没有焦点/没有输入时 reload。

### 方案 B（长期）：content script 自己做 cleanup/rebuild

从下一版开始，在 content.js 里放：

```js
window.__picnestHoldCollectCleanup = () => { /* remove all listeners + host */ }
```

新版本启动时：
- 如果已有 `__picnestHoldCollectCleanup`，先调用它再重新初始化；
- 给页面脚本一个“重建”入口，background 注入一个 `bootstrap.js` 调用 cleanup + 重新注入 content.js。

旧版本没有 cleanup，所以**当前这一批旧页面仍然需要方案 A 的一次性 reload**；方案 B 是防止以后再出现同样问题。

### 方案 C（诊断/兜底）：popup 显示当前页状态 + 一键修复

- content.js 增加 `chrome.runtime.onMessage` 的 `picnest-ping`，返回 `{ok, version, enabled}`；
- popup 打开时向 active tab ping：
  - `未注入`
  - `已注入 v0.1.3`
  - `旧版 v0.1.2（需重建）`
- 增加「修复本页」按钮：
  - 旧版 → `chrome.tabs.reload(tab.id)`；
  - 未注入 → background 注入 content.js；
  - 已是最新但采集失败 → 提示用户把该页 DOM/控制台信息发回。
- 这个按钮可以先作为用户的临时 workaround，也能让下一次排查直接看到“脚本在不在”。

## 6. 验收清单

1. 打开 Pinterest，采集正常。
2. 在扩展页 reload 到 v0.1.4（或当前版本），**不刷新 Pinterest**，切走再切回：
   - 若 old content script 版本不匹配，后台自动 reload 一次；
   - reload 后长按采集正常；
   - 再次切走/切回不再 reload，采集仍正常。
3. 多个 Pinterest 标签、两个 Chrome 窗口之间切换，均正常。
4. 普通网页（非 Pinterest）切标签不被误 reload。
5. 关闭/重开 Chrome 后，已有 Pinterest 标签恢复，采集正常。
6. 扩展页版本号与 `content.js` 底部 `Version` 一致。

## 7. 仓库状态

- 开发版最新：`bc255ed`（扩展 v0.1.3）；工作区干净。
- 纯净版 `PicNest-Public` 最新：`68468b7`（扩展 v0.1.3）；`main` 本地领先 `origin/main`，**尚未 push**；工作区还有 Gemini 正在做的更新功能未提交文件（`App.vue` / `HelpDialog.vue` / `UpdateDialog.vue` / updater handlers 等），不要动。
- 用户 Chrome 加载的是 **开发版** `D:\zcode工作区\PicNest\extension`；改完 dev 后记得同步到 Public。
- 相关提交：
  - `44f36ff` v0.1.1 图片命中
  - `b1a751b` v0.1.2 自动补注入
  - `68468b7` v0.1.3 探测/重试/更多事件

## 8. 不要做的事

- 不要再单纯增加 `setTimeout` 重试次数；探测/注入链路已经证明会跑，问题是旧脚本守卫。
- 不要复制 Eagle 的代码/资源；本项目 GPL-3.0，Eagle 是闭源商业软件，只参考行为。
- 不要在用户真实素材库上做采集写入测试；用临时根/测试图片。
- 不要随便清 Chrome profile 或扩展数据；用户有登录态和配置。

## 9. v0.1.4 已实现（2026-11-10）

### 9.1 探测与决策表

`background.js` 的 `probeCollect(tabId)` 向页面注入一个自包含函数，返回：

| 字段 | 含义 |
|---|---|
| `loaded` | `__picnestHoldCollectLoaded` |
| `version` | `__picnestHoldCollectVersion` |
| `cleanup` | `__picnestHoldCollectCleanup` 是否为函数 |
| `alive` | 页面里的 `chrome.runtime.id` 是否还在（扩展更新后旧脚本会失去它） |
| `healthy` | 派发私有事件 `picnest-collect-probe` 前后 `__picnestHoldCollectHealth().ticks` 是否增加（document 监听器是否还活着） |
| `enabled` | 用户是否开启了按住采集 |

处理顺序：

1. `loaded && version === 0.1.4 && alive && healthy` → 正常，什么都不做。
2. `!loaded` → 注入 `content.js`，再探测一次。
3. 旧版、`alive && cleanup` → 注入新 `content.js`；新版顶部看到版本不一致会调用旧实例的 cleanup，原地清理 + 重建，**不刷新页面**。
4. 其余（无 cleanup 的极旧脚本 / `alive=false` 孤立脚本 / `healthy=false` 监听器失效）：
   - **Pinterest 标签**：`chrome.tabs.reload` 自动刷新一次；
   - 非 Pinterest：不自动刷新，留给 popup「修复本页」手动处理。
5. 自动刷新用 `chrome.storage.session` 记 `tabId -> {key: "0.1.4|URL", at}`，同一 tab 同 URL 只刷一次（2 小时过期），防止循环；刷新完成后的 `tabs.onUpdated` 会重新注入并显示正常。
6. `ensurePinterestTabs()`（SW 启动/安装）只补注入、传 `allowReload=false`，不会批量刷新后台标签；切到该标签时 `onActivated` 才允许刷新。

### 9.2 content.js 侧

- 新增 `const VERSION = '0.1.4'`；所有监听器注册完成后才写 `Loaded/Version`。
- 新增 `__picnestHoldCollectCleanup()`：关闭面板、移除全部 document/window 监听器、移除 `chrome.storage.onChanged`、删除 host。
- 新增 `__picnestHoldCollectHealth()`：返回 `{ version, ticks, alive, enabled, disposed }`；`ticks` 由私有事件 `picnest-collect-probe` 累加。
- 顶部接管逻辑：同版本幂等返回；旧版本带 cleanup 先 `cleanup()` 再初始化；旧版本无 cleanup 直接 return（交给后台刷新）。
- **以后每次升版本都必须保留 cleanup + health + 版本号三件套**，否则下一次更新又会退化成“只能刷新整页”。

### 9.3 popup

- 顶部新增「本页采集」：`已就绪 v0.1.4` / `未注入` / `旧版脚本 vX` / `需刷新页面` / `监听失效` / `页面未加载完成` / `此页面不支持`。
- 异常时显示「修复本页」：缺脚本或带 cleanup 的旧版 → 注入/原地重建；否则刷新页面；操作后自动复检。
- 新增后台消息：`collect-status`（返回 `state/tabId/version/contentVersion/...`）、`collect-repair`（返回 `action: injected|reloaded|none`）。

### 9.4 回归测试

```bash
node tools/test-collect-script.mjs      # 守卫/幂等/接管/cleanup/health/孤立脚本
node tools/test-collect-background.mjs  # 注入/一次刷新/防循环/非 Pinterest/popup 修复/chrome://
node tools/e2e-extension.mjs            # 真实 Chrome：CDP Extensions.loadUnpacked + 临时配置
```

前两套用最小 DOM + chrome API 桩，在 Node 里加载真实 `content.js` / `background.js`；
已覆盖：空白页注入、旧脚本（无 cleanup）刷新一次且重复激活不再刷新、刷新后自动注入、旧脚本（带 cleanup）原地接管、
非 Pinterest 不刷新（status=stale）、孤立脚本（status=orphan + 刷新）、popup missing→injected / 就绪→none、chrome:// 不注入。

第三套在**真实 Chrome 156**（`--enable-unsafe-extension-debugging`，headless，临时配置）里加载未打包扩展并驱动真实
`chrome.scripting` / `chrome.storage.session` / `chrome.tabs.reload`，7 项全部通过：
manifest 注入 + 健康探测、`collectStatus` current、旧版带 cleanup 原地接管（同 document 不刷新）、
极旧脚本 Pinterest 自动刷新一次并重新注入、同一 tab+URL 防循环、非 Pinterest 不自动刷新（status=stale）、
「修复本页」刷新后恢复。`tools/e2e-extension.mjs` 只碰临时 profile，不影响用户 Chrome。

### 9.5 待 Feb 验收（真实 Chrome）

> 自动化部分已在临时 Chrome 156 通过（见 9.4）；下面是用你**日常主 Chrome + 真实 Pinterest 登录态**的物理验收，
> 重点验证睡眠标签 / bookmarks / 多窗口切换这些自动化覆盖不到的路径。

1. `chrome://extensions` 重载扩展，确认版本 **0.1.4**（**不需要**先刷新 Pinterest 页）。
2. 切到已打开的 Pinterest 标签（旧脚本页）：
   - 若旧脚本无 cleanup / 孤立 → 页面应自动刷新一次，并出现「Pinterest 页面已自动刷新」通知；
   - 刷新后长按图片 → 面板正常；
   - 再切走/切回，不再刷新，采集仍正常。
3. 打开扩展面板：「本页采集」显示「已就绪 v0.1.4」；若显示异常，点「修复本页」应恢复。
4. 从书签栏 / 侧标入口进入 Pinterest（Feb 实测 100% 复现路径）：不应再需要手动刷新。
5. 多个 Pinterest 标签 / 两个 Chrome 窗口之间切换均正常；普通网页不被自动刷新。
6. 关掉/重开 Chrome 后，已有 Pinterest 标签恢复，采集正常。

### 9.6 剩余风险

- 自动刷新只对 Pinterest 生效；其它站点遇到孤立/极旧脚本时不会自动刷新，需要 popup 手动「修复本页」或在扩展更新后刷新页面。
- 自动刷新会丢失该 Pinterest 页的滚动位置（只发生一次；页面状态本来已失效）。
- 0.1.4 之前的旧实例没有 cleanup，无法原地接管，只能刷新一次；0.1.4 之后应不再需要整页刷新。
- Chrome 端到端已用临时 profile 覆盖 API 全流程；真实 PointerEvent（Pinterest `pointer-events:none` + 覆盖层）、
  睡眠标签恢复、登录态下的长按面板仍需 Feb 物理鼠标验收。
