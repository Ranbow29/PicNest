import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')

console.log('--- Tauri + Vue 以图找图运行时与行为测试 ---')

const lib = read('ui/src-tauri/src/lib.rs')
for (const command of ['visual_search_query', 'visual_search_save', 'video_preview', 'set_always_on_top']) {
  assert.match(lib, new RegExp(`\\b${command}\\s*,`), `Tauri 必须注册 ${command}`)
}
console.log('  [PASS] Tauri 命令注册：检索、存库、视频预览、显式置顶')

const api = read('ui/src/api.js')
for (const [method, command] of [
  ['picnestVisualSearchQuery', 'visual_search_query'],
  ['picnestVisualSearchSave', 'visual_search_save'],
  ['picnestVideoPreview', 'video_preview'],
  ['picnestSetAlwaysOnTop', 'set_always_on_top'],
]) {
  assert.ok(api.includes(`case '${method}'`), `api.js 必须映射 ${method}`)
  assert.ok(api.includes(`tauriInvoke('${command}'`), `api.js 必须调用 ${command}`)
}
for (const wrapper of ['visualSearchQuery:', 'visualSearchSave:', 'videoPreview:', 'setAlwaysOnTop:']) {
  assert.ok(api.includes(wrapper), `api.js 必须导出 ${wrapper}`)
}
console.log('  [PASS] api.js 双层桥接与公共包装完整')

const dialog = read('ui/src/components/VisualSearchDialog.vue')
for (const selector of ['queue-sidebar', 'crop-viewport', 'waterfall-container']) {
  assert.ok(dialog.includes(selector), `VisualSearchDialog 缺少 ${selector}`)
}
for (const action of ['researchItem', 'saveItem', 'openSource']) {
  assert.ok(dialog.includes(`function ${action}`), `VisualSearchDialog 缺少 ${action}`)
}
for (const key of ["k === 'F'", "k === 'S'", "k === 'O'"]) {
  assert.ok(dialog.includes(key), `VisualSearchDialog 缺少快捷键 ${key}`)
}
assert.ok(dialog.includes('api.videoPreview('), '视频任务必须调用真实首帧预览')
assert.ok(dialog.includes('api.setAlwaysOnTop('), '置顶必须调用显式 setter')
console.log('  [PASS] 三栏结构、F/S/O 快捷键、视频预览与置顶接线')

const app = read('ui/src/App.vue')
assert.match(app, /<VisualSearchDialog\b[^>]*\/>/, 'App.vue 必须挂载 VisualSearchDialog')
assert.ok(app.includes('lib.openVisualSearchForSelected()'), 'App.vue 必须绑定 Shift+S')
const menu = read('ui/src/components/ContextMenu.vue')
assert.ok(menu.includes('以图找图') && menu.includes('lib.openVisualSearchForSelected()'), '右键菜单必须包含以图找图入口')
console.log('  [PASS] Shift+S 全局快捷键与右键菜单集成')

const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo'
const rustTests = spawnSync(cargo, [
  'test',
  '--manifest-path', path.join(root, 'ui/src-tauri/Cargo.toml'),
  '--locked',
  '--lib',
  'visual_search::tests',
], { cwd: root, stdio: 'inherit' })
assert.equal(rustTests.status, 0, 'Rust 视觉搜索行为测试失败')
console.log('  [PASS] Rust 产品代码测试：JPEG 输入、bbox 钳制、Pinterest originals URL')
console.log('\n所有以图找图运行时与行为测试通过')
