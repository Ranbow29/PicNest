import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_UNSUPPORTED_ERROR, pluginUnsupported } from '../ui/src/lib/plugins.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const api = fs.readFileSync(path.join(root, 'ui/src/api.js'), 'utf8')
const lib = fs.readFileSync(path.join(root, 'ui/src-tauri/src/lib.rs'), 'utf8')
const dirMenu = fs.readFileSync(path.join(root, 'ui/src/components/DirContextMenu.vue'), 'utf8')
const proxyStart = api.indexOf('window.picrand = new Proxy({')
const proxyEnd = api.indexOf('\n  }, {', proxyStart)
assert.ok(proxyStart >= 0 && proxyEnd > proxyStart, '必须存在 window.picrand Proxy 桥接')
const proxySource = api.slice(proxyStart, proxyEnd)
const bridged = new Set([...proxySource.matchAll(/^\s{4}([A-Za-z_$][\w$]*)\s*:/gm)].map((match) => match[1]))
const facadeStart = api.indexOf('export const api = {')
const facadeEnd = api.indexOf('\n}', facadeStart)
assert.ok(facadeStart >= 0 && facadeEnd > facadeStart, '必须存在导出的 api facade')
const facade = new Set([...api.slice(facadeStart, facadeEnd).matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*:/gm)].map((match) => match[1]))

const used = new Set()
const facadeUsed = new Set()
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (/\.(js|vue)$/.test(entry.name)) {
      const source = fs.readFileSync(file, 'utf8')
      for (const match of source.matchAll(/(?:window\.)?picrand\??\.([A-Za-z_$][\w$]*)/g)) used.add(match[1])
      if (file !== path.join(root, 'ui/src/api.js')) {
        for (const match of source.matchAll(/(?<![\w$/.])api\??\.([A-Za-z_$][\w$]*)/g)) {
          if (match[1] !== 'js') facadeUsed.add(match[1])
        }
      }
    }
  }
}
walk(path.join(root, 'ui/src'))
const missing = [...used].filter((name) => !bridged.has(name)).sort()
assert.deepEqual(missing, [], `以下真实调用仍会落入空桩: ${missing.join(', ')}`)
const missingFacade = [...facadeUsed].filter((name) => !facade.has(name)).sort()
assert.deepEqual(missingFacade, [], `以下 api facade 调用未导出: ${missingFacade.join(', ')}`)
const dispatched = new Set([...api.matchAll(/case '([^']+)'/g)].map((match) => match[1]))
const facadeDispatches = [...api.slice(facadeStart, facadeEnd).matchAll(/\binvoke\('([^']+)'/g)].map((match) => match[1])
const missingDispatch = [...new Set(facadeDispatches)].filter((name) => !dispatched.has(name)).sort()
assert.deepEqual(missingDispatch, [], `以下 api facade 方法没有 switch 实现: ${missingDispatch.join(', ')}`)

for (const [method, command] of [
  ['picnestVideoPreview', 'video_preview'],
  ['picnestSetAlwaysOnTop', 'set_always_on_top'],
  ['picnestDirMemoryGet', 'dir_memory_get'],
  ['picnestThumbsMissing', 'thumbs_missing'],
  ['picnestAppVersion', 'app_version'],
  ['picnestEagleInspect', 'eagle_inspect'],
]) {
  assert.ok(api.includes(`case '${method}'`), `api.js 缺少 ${method} switch 映射`)
  assert.ok(api.includes(`tauriInvoke('${command}'`), `api.js 缺少 ${command} 调用`)
  assert.match(lib, new RegExp(`\\b${command}\\s*,`), `lib.rs 未注册 ${command}`)
}

assert.ok(proxySource.includes("safeInvoke('open_folder', { path: p })"), 'openWithDefault 必须调用 open_folder')
assert.ok(proxySource.includes("typeof result === 'string' ? result"), 'open_folder 空字符串成功不得被误报为失败')
assert.match(lib, /\bopen_folder\s*,/, 'lib.rs 未注册 open_folder')
assert.ok(dirMenu.includes('<button class="mi" @click="reveal">在文件管理器中打开</button>'), '普通文件夹右键菜单缺少打开入口')
assert.ok(dirMenu.includes(': lib.absPathOf(relOf(menu.value.rel))'), '普通文件夹必须解析为已登记图库内的绝对路径')

assert.doesNotMatch(proxySource, /picnestAppVersion:\s*async\s*\(\)\s*=>\s*['"]/, '版本号不得在前端写死')
assert.ok(proxySource.includes('count: 1'), '缩略图检测失败必须阻止“已齐”假成功')
assert.ok(proxySource.includes('Eagle 库检测失败，已停止按普通文件夹扫描'), 'Eagle 检测失败必须 fail-closed')
for (const method of [
  'picnestPluginsList', 'picnestPluginThemeCss', 'picnestPluginSetEnabled', 'picnestPluginPickFolder',
  'picnestPluginInstallFolder', 'picnestPluginUninstall', 'picnestPluginRegistryFetch',
  'picnestPluginInstallRegistry', 'picnestPluginEntryHtml', 'picnestPluginQueryImages',
  'picnestPluginStorageGet', 'picnestPluginStorageSet', 'picnestPluginFetch',
]) {
  assert.ok(proxySource.includes(`${method}: async () => pluginUnsupported()`), `${method} 必须显式不可用`)
}
const unsupported = pluginUnsupported()
assert.equal(unsupported.ok, false)
assert.equal(unsupported.unsupported, true)
assert.equal(unsupported.error, PLUGIN_UNSUPPORTED_ERROR)
assert.deepEqual(unsupported.plugins, [])

console.log(`运行时桥接审计通过：${used.size} 个 preload 调用、${facadeUsed.size} 个 api facade 调用全部有显式实现`)
