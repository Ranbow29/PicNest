# PicNest 插件示例 / 开发指南

这套示例可直接装进 PicNest：**侧栏底部「插件库」→ 插件仓库 → 填本目录 `registry.json` 的绝对路径 → 刷新 → 安装**。
也可以「从文件夹安装」直接选 `mono-mint/` 或 `view-stats/`。

## 目录

| 插件 | 类型 | 说明 |
|---|---|---|
| `mono-mint/` | `theme` | 纯 CSS token 主题，无代码执行 |
| `view-stats/` | `renderer` | 沙箱 iframe 界面插件，演示 query/events/storage 权限 |
| `zips/` | — | 打包好的示例插件 zip（registry 用） |
| `registry.json` | — | 本地仓库索引示例（`download` 相对本文件解析） |

## 插件清单 plugin.json

```jsonc
{
  "id": "com.example.my-plugin",   // 小写字母/数字/点/横线，1-64 位，= 安装目录名
  "name": "显示名",
  "version": "1.0.0",
  "api": "1.0.0",                  // 依赖的宿主插件 API 版本
  "type": "theme",                 // theme | renderer | main（main 暂未启用）
  "entry": "theme.css",            // theme: css；renderer: 单个 html；main: cjs
  "author": "",
  "license": "MIT",
  "description": "",
  "permissions": []
}
```

### theme 插件
- `entry` 是 CSS 文件（≤512KB），启用后由宿主注入 `<style data-picnest-plugin="id">`，在应用样式之后，因此可覆盖 CSS token。
- 只允许改 token/样式，不改布局；示例见 `mono-mint/theme.css`。
- 无权限、无脚本执行。

### renderer 插件（沙箱）
- `entry` 必须是一个**单文件 HTML**（≤2MB，可内联 CSS/JS；外部资源请用 data URL）。
- 宿主用 `<iframe sandbox="allow-scripts" srcdoc="...">` 加载：**没有同源权限、没有 Node、碰不到宿主 DOM**，只能 postMessage。
- 至少声明 `ui.panel` 才会出现「打开面板」按钮。

#### 消息协议

插件 → 宿主：

```js
parent.postMessage({ source: 'picnest-plugin', pluginId, type: 'ready' }, '*')
parent.postMessage({ source: 'picnest-plugin', pluginId, type: 'query-images', id, limit: 20, rel: '' }, '*')
parent.postMessage({ source: 'picnest-plugin', pluginId, type: 'storage-get', id, key: 'foo' }, '*')
parent.postMessage({ source: 'picnest-plugin', pluginId, type: 'storage-set', id, key: 'foo', value: {} }, '*')
parent.postMessage({ source: 'picnest-plugin', pluginId, type: 'fetch', id, url, init: {} }, '*')
parent.postMessage({ source: 'picnest-plugin', pluginId, type: 'close' }, '*')
```

宿主 → 插件：

```js
{ source: 'picnest-host', type: 'init', apiVersion: '1.0.0', context: { rootId, rootName, view, rel, selection } }
{ source: 'picnest-host', type: 'event', name: 'selection-changed' | 'view-changed' | 'image-opened' | 'image-closed', payload }
{ source: 'picnest-host', type: 'response', id, ok, data, error }
```

#### 权限（deny by default）

| 权限 | 能力 |
|---|---|
| `ui.panel` | 插件管理里显示「打开面板」 |
| `data.images.read` | `query-images`：只读当前资料库（最多 500 行）元数据：id/文件名/尺寸/大小/评分/注释/所在文件夹；**不能读任意磁盘文件** |
| `events.read` | 订阅选择/视图/灯箱事件 |
| `storage` | 插件私有 KV（`plugins/<id>/storage.json`，上限 5MB） |
| `net:https://api.example.com` | `fetch` 只放行声明过的 origin（主进程代理，15s 超时，2MB 上限） |

`query-images` 的 `folderId` 由宿主填当前活动资料库，插件传的 rel 只能限定其内；不能跨库。

### main 插件
清单可声明 `type: "main"`，当前只登记不执行（P3 会接 utilityProcess + 权限网关）。管理页会显示「主进程插件暂未启用」。

## 打包与 registry

```powershell
# 在插件目录内打包（plugin.json 在 zip 根）
Compress-Archive -Path 'mono-mint\*' -DestinationPath 'zips\mono-mint-1.0.0.zip' -Force
Get-FileHash 'zips\mono-mint-1.0.0.zip' -Algorithm SHA256
```

`registry.json`：

```json
{
  "plugins": [
    {
      "id": "com.example.my-plugin",
      "name": "显示名",
      "version": "1.0.0",
      "type": "theme",
      "api": "1.0.0",
      "download": "zips/my-plugin-1.0.0.zip",
      "sha256": "…"
    }
  ]
}
```

`download` 支持 http(s) URL、绝对本地路径、或相对 registry.json 的路径；`sha256` 可省略但仓库建议必填。
宿主安装时会校验 zip 大小（≤50MB）、解压总量（≤200MB）、路径穿越与 plugin.json；安装目录固定在数据目录 `plugins/<id>/`，卸载即删除。

## 开发者调试

- 开发时可直接把插件目录放到 `%APPDATA%\PicNest\plugins\<id>\`（dev 是 `app\_internal_data\plugins\`），重启应用或在插件库点「刷新」。
- renderer 插件 console 在宿主 DevTools 的 iframe 上下文中（或插件面板里右键检查）。
- 主题插件启用/停用即时生效；renderer 插件面板打开时若插件发 `ready`，宿主会回 `init`。
