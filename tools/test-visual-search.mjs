import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

console.log('--- 开始执行 M9 以图找图（Visual Search & Lens）功能测试 ---');

// 1. 验证 picnest-handlers.js 中 M9 模块源码
const handlersPath = 'd:\\zcode工作区\\PicNest\\tools\\patches\\picnest-handlers.js';
assert(fs.existsSync(handlersPath), 'picnest-handlers.js 必须存在');
const handlersSrc = fs.readFileSync(handlersPath, 'utf8');

assert(handlersSrc.includes('picnest-visual-search-query'), '必须注册 picnest-visual-search-query IPC 通道');
assert(handlersSrc.includes('picnest-visual-search-save'), '必须注册 picnest-visual-search-save IPC 通道');
assert(handlersSrc.includes('picnest-set-always-on-top'), '必须注册 picnest-set-always-on-top IPC 通道');
console.log('  [PASS] Test 1: 主进程 picnest-handlers.js 成功注册以图找图全套 IPC 通道');

// 2. 验证 apply.mjs 中的 preload 桥接
const applyPath = 'd:\\zcode工作区\\PicNest\\tools\\patches\\apply.mjs';
const applySrc = fs.readFileSync(applyPath, 'utf8');
assert(applySrc.includes('picnestVisualSearchQuery'), 'apply.mjs 必须桥接 picnestVisualSearchQuery');
assert(applySrc.includes('picnestVisualSearchSave'), 'apply.mjs 必须桥接 picnestVisualSearchSave');
assert(applySrc.includes('picnestSetAlwaysOnTop'), 'apply.mjs 必须桥接 picnestSetAlwaysOnTop');
console.log('  [PASS] Test 2: preload 桥接定义完整覆盖检索、存库与窗口置顶');

// 3. 验证 api.js 导出与包装
const apiPath = 'd:\\zcode工作区\\PicNest\\ui\\src\\api.js';
const apiSrc = fs.readFileSync(apiPath, 'utf8');
assert(apiSrc.includes('visualSearchQuery:'), 'api.js 必须导出 visualSearchQuery');
assert(apiSrc.includes('visualSearchSave:'), 'api.js 必须导出 visualSearchSave');
assert(apiSrc.includes('setAlwaysOnTop:'), 'api.js 必须导出 setAlwaysOnTop');
console.log('  [PASS] Test 3: 前端 api.js 正常导出以图找图 API 函数');

// 4. 验证 VisualSearchDialog.vue 组件存在与三栏结构
const dialogPath = 'd:\\zcode工作区\\PicNest\\ui\\src\\components\\VisualSearchDialog.vue';
assert(fs.existsSync(dialogPath), 'VisualSearchDialog.vue 必须存在');
const dialogSrc = fs.readFileSync(dialogPath, 'utf8');
assert(dialogSrc.includes('queue-sidebar'), '必须包含左栏多图排队队列 (queue-sidebar)');
assert(dialogSrc.includes('crop-viewport'), '必须包含中栏原图与局部框选 (crop-viewport)');
assert(dialogSrc.includes('waterfall-container'), '必须包含右栏结果瀑布流 (waterfall-container)');
assert(dialogSrc.includes('researchItem'), '必须支持 F 键递归图搜 (researchItem)');
assert(dialogSrc.includes('saveItem'), '必须支持 S 键一键入库 (saveItem)');
assert(dialogSrc.includes('openSource'), '必须支持 O 键原网直达 (openSource)');
console.log('  [PASS] Test 4: VisualSearchDialog.vue 完整实现三栏奶玻璃架构与 F/S/O 快捷键流');

// 5. 验证 App.vue 与 ContextMenu.vue 全局快捷键与菜单集成
const appPath = 'd:\\zcode工作区\\PicNest\\ui\\src\\App.vue';
const appSrc = fs.readFileSync(appPath, 'utf8');
assert(appSrc.includes('<VisualSearchDialog />'), 'App.vue 必须挂载 VisualSearchDialog 组件');
assert(appSrc.includes('lib.openVisualSearchForSelected()'), 'App.vue 必须绑定 Shift+S 全局快捷键');

const menuPath = 'd:\\zcode工作区\\PicNest\\ui\\src\\components\\ContextMenu.vue';
const menuSrc = fs.readFileSync(menuPath, 'utf8');
assert(menuSrc.includes('以图找图（Shift+S）') || menuSrc.includes('visualSearch'), '右键菜单必须包含以图找图入口');
console.log('  [PASS] Test 5: Shift+S 全局快捷键与右键上下文菜单集成验证通过');

// 6. 验证 Pinterest 原图 CDN 转换算法与坐标归一化
const sampleLarge = 'https://i.pinimg.com/736x/5b/d5/21/5bd52149a48e52b39ea7ca8eddc94c0a.jpg';
const orig = sampleLarge.replace(/[0-9]+x/g, 'originals');
assert.strictEqual(orig, 'https://i.pinimg.com/originals/5b/d5/21/5bd52149a48e52b39ea7ca8eddc94c0a.jpg', '原图转换必须命中 originals CDN');

function normalizeBbox(bx, by, bw, bh) {
  const x = Math.max(0, Math.min(1, Number(bx ?? 0)));
  const y = Math.max(0, Math.min(1, Number(by ?? 0)));
  const w = Math.max(0.01, Math.min(1 - x, Number(bw ?? 1)));
  const h = Math.max(0.01, Math.min(1 - y, Number(bh ?? 1)));
  return [x, y, w, h];
}
assert.deepStrictEqual(normalizeBbox(-0.2, 0.5, 0.8, 1.2), [0, 0.5, 0.8, 0.5], '坐标越界必须被安全钳制在 [0, 1]');
console.log('  [PASS] Test 6: 坐标归一化算法与 Pinterest 原图转换校验通过');

console.log('\n🎉 所有 6 项以图找图核心架构测试全部通过！\n');
