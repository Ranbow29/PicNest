// 采集脚本无头自测：版本守卫 / 旧实例接管 / cleanup / 健康探测
// 运行：node tools/test-collect-script.mjs
// content.js 初始化只依赖 addEventListener + chrome.storage，这里用最小 DOM/事件桩即可跑。
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const extDir = path.join(root, 'extension')
const contentCode = fs.readFileSync(path.join(extDir, 'content.js'), 'utf8')
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'))
const backgroundCode = fs.readFileSync(path.join(extDir, 'background.js'), 'utf8')

class FakeEvent {
  constructor(type) {
    this.type = type
    this.defaultPrevented = false
  }
  preventDefault() { this.defaultPrevented = true }
  stopPropagation() {}
  stopImmediatePropagation() {}
}
class FakeTarget {
  constructor() { this.listeners = new Map() }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    const list = this.listeners.get(type)
    if (!list.includes(fn)) list.push(fn)
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type)
    if (!list) return
    const i = list.indexOf(fn)
    if (i >= 0) list.splice(i, 1)
  }
  dispatchEvent(e) {
    for (const fn of [...(this.listeners.get(e.type) || [])]) fn.call(this, e)
    return true
  }
  addListener(fn) { this.addEventListener('change', fn) }
  removeListener(fn) { this.removeEventListener('change', fn) }
  count(type) { return (this.listeners.get(type) || []).length }
}

function createPage({ runtimeAlive = true, locationHref = 'https://example.com/' } = {}) {
  const doc = new FakeTarget()
  const docEl = { style: {} }
  doc.documentElement = docEl
  doc.hidden = false
  doc.getElementById = () => null
  doc.elementsFromPoint = () => []
  doc.querySelectorAll = () => []
  doc.images = []

  const win = new FakeTarget()
  win.__picnestHoldCollectLoaded = false
  win.__picnestHoldCollectVersion = ''
  const parsedLoc = new URL(locationHref)
  win.location = { href: parsedLoc.href, hostname: parsedLoc.hostname, pathname: parsedLoc.pathname }

  const storageChanged = new FakeTarget()
  const chrome = {
    runtime: runtimeAlive ? { id: 'test-extension' } : {},
    storage: {
      local: { get(defaults, cb) { cb({ ...defaults }) } },
      onChanged: storageChanged,
    },
  }
  const timers = { timeouts: [], intervals: [] }
  const ctx = vm.createContext({
    window: win,
    document: doc,
    location: win.location,
    URL,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    chrome,
    Event: FakeEvent,
    setTimeout(fn, ms) { timers.timeouts.push({ fn, ms, cleared: false }); return timers.timeouts.length },
    clearTimeout(id) { const t = timers.timeouts[id - 1]; if (t) t.cleared = true },
    setInterval(fn, ms) { timers.intervals.push({ fn, ms, cleared: false }); return timers.intervals.length },
    clearInterval(id) { const t = timers.intervals[id - 1]; if (t) t.cleared = true },
    console,
  })
  const script = new vm.Script(contentCode, { filename: 'content.js' })
  return {
    win, doc, chrome, storageChanged, ctx, timers,
    run: () => script.runInContext(ctx),
    probeTicks() { return win.__picnestHoldCollectHealth ? win.__picnestHoldCollectHealth().ticks : -1 },
    dispatchProbe() { doc.dispatchEvent(new FakeEvent('picnest-collect-probe')) },
    tickWatchdog() {
      for (const t of timers.intervals) if (!t.cleared) t.fn()
    },
  }
}

/* 1. 版本号三处一致 */
const bgVersion = backgroundCode.match(/const CONTENT_VERSION = '([^']+)'/)?.[1]
const contentVersion = contentCode.match(/const VERSION = '([^']+)'/)?.[1]
assert.equal(manifest.version, contentVersion, 'manifest 与 content.js 版本一致')
assert.equal(bgVersion, contentVersion, 'background 与 content.js 版本一致')
console.log('ok 版本一致：', manifest.version)

/* 2. 首次注入：Loaded/Version/Cleanup/Health 全部就位，探测事件能收到 */
{
  const page = createPage()
  page.run()
  assert.equal(page.win.__picnestHoldCollectLoaded, true)
  assert.equal(page.win.__picnestHoldCollectVersion, contentVersion)
  assert.equal(typeof page.win.__picnestHoldCollectCleanup, 'function')
  assert.equal(typeof page.win.__picnestHoldCollectHealth, 'function')
  assert.equal(page.win.__picnestHoldCollectHealth().alive, true)
  const before = page.probeTicks()
  page.dispatchProbe()
  assert.equal(page.probeTicks(), before + 1, '探测事件累加 ticks')
  assert.equal(page.doc.count('pointerdown'), 2, 'pointerdown 两个监听器')
  assert.equal(page.storageChanged.count('change'), 1)
  console.log('ok 首次注入：健康探测 + 监听器注册')
}

/* 3. 同版本重复注入：幂等，不清理、不重复挂监听器 */
{
  const page = createPage()
  page.run()
  const cleanup = page.win.__picnestHoldCollectCleanup
  const before = page.probeTicks()
  page.run()
  assert.equal(page.win.__picnestHoldCollectCleanup, cleanup, '未重建实例')
  page.dispatchProbe()
  assert.equal(page.probeTicks(), before + 1)
  assert.equal(page.doc.count('pointerdown'), 2, '监听器没有翻倍')
  console.log('ok 同版本重复注入：幂等')
}

/* 4. 旧版带 cleanup：接管前清理旧监听器，版本升级，ticks 归零后继续工作 */
{
  const page = createPage()
  page.run()
  const oldCleanup = page.win.__picnestHoldCollectCleanup
  page.dispatchProbe()
  page.win.__picnestHoldCollectVersion = '0.1.3' // 模拟旧版实例
  page.run()
  assert.notEqual(page.win.__picnestHoldCollectCleanup, oldCleanup, '旧 cleanup 被调用后重建')
  assert.equal(page.win.__picnestHoldCollectVersion, contentVersion)
  assert.equal(page.probeTicks(), 0, '新实例 ticks 归零')
  page.dispatchProbe()
  assert.equal(page.probeTicks(), 1)
  assert.equal(page.doc.count('pointerdown'), 2, '旧监听器已移除，没有叠加')
  assert.equal(page.storageChanged.count('change'), 1, '旧 storage 监听器已移除')
  console.log('ok 旧版带 cleanup：原地接管')
}

/* 5. 极旧版无 cleanup：拒绝接管（交给后台刷新页面），监听器/版本保持原样 */
{
  const page = createPage()
  page.run()
  page.win.__picnestHoldCollectVersion = '0.1.2'
  delete page.win.__picnestHoldCollectCleanup
  page.run()
  assert.equal(page.win.__picnestHoldCollectVersion, '0.1.2', '无 cleanup 不接管')
  assert.equal(page.win.__picnestHoldCollectCleanup, undefined)
  assert.equal(page.doc.count('pointerdown'), 2, '监听器未叠加')
  assert.equal(page.win.__picnestHoldCollectLoaded, true)
  console.log('ok 极旧版无 cleanup：拒绝接管')
}

/* 6. cleanup：移除全部页面监听器，健康探测不再累加，chrome 监听器一并移除 */
{
  const page = createPage()
  page.run()
  page.win.__picnestHoldCollectCleanup()
  const frozen = page.probeTicks()
  page.dispatchProbe()
  assert.equal(page.probeTicks(), frozen, 'cleanup 后探测事件无人接收')
  assert.equal(page.doc.count('pointerdown'), 0)
  assert.equal(page.doc.count('pointermove'), 0)
  assert.equal(page.win.count('scroll'), 0)
  assert.equal(page.storageChanged.count('change'), 0)
  assert.equal(page.win.__picnestHoldCollectHealth().disposed, true)
  page.tickWatchdog()
  assert.equal(page.doc.count('pointerdown'), 0, 'cleanup 后看门狗不再重建')
  console.log('ok cleanup：监听器全部移除')
}

/* 7. document 监听器被清空（模拟 document.open/页面重建）：看门狗原地重建 */
{
  const page = createPage()
  page.run()
  page.dispatchProbe()
  const before = page.probeTicks()
  page.doc.listeners.clear()
  page.win.listeners.clear()
  page.tickWatchdog()
  page.dispatchProbe()
  assert.equal(page.probeTicks(), before + 1, '看门狗重建后探测恢复')
  assert.equal(page.doc.count('pointerdown'), 2)
  assert.equal(page.win.count('pointerdown'), 1, 'window 捕获哨兵重新挂上')
  assert.equal(page.win.__picnestHoldCollectHealth().disposed, false)
  console.log('ok document 监听器被清空：看门狗原地重建')
}

/* 8. 孤立脚本（扩展更新后 runtime 失效）：alive=false，供后台判定需刷新 */
{
  const page = createPage({ runtimeAlive: false })
  page.run()
  assert.equal(page.win.__picnestHoldCollectHealth().alive, false)
  page.dispatchProbe()
  assert.equal(page.probeTicks(), 1, '监听器还活着，但 runtime 已失效')
  console.log('ok 孤立脚本：alive=false 可被探测')
}

/* 9. 花瓣 / Pinterest / Pixiv 识别、原图升级计划、DOM 穿透与 cleanup */
{
  const page = createPage({ locationHref: 'https://huaban.com/discovery' })
  page.run()
  const hooks = page.win.__picnestCollectTestHooks
  assert.ok(hooks, '已导出测试钩子')

  // 9a. 花瓣发现页带 data-pin-id + display:contents + 同级遮罩层
  const card = {
    tagName: 'DIV',
    attributes: { 'data-pin-id': '7058355788' },
    getAttribute(k) { return this.attributes[k] || null },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 278, bottom: 207, width: 278, height: 207 }),
    querySelectorAll: () => [],
    closest(sel) {
      if (sel.includes('data-pin-id')) return this
      return null
    },
  }
  const contentsWrap = {
    tagName: 'DIV',
    parentElement: card,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    querySelectorAll(sel) {
      if (sel === 'img') return [imgEl]
      return []
    },
    closest(sel) { return card.closest(sel) },
  }
  const overlayEl = {
    tagName: 'DIV',
    parentElement: contentsWrap,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 278, bottom: 207, width: 278, height: 207 }),
    querySelectorAll: () => [],
    closest(sel) { return contentsWrap.closest(sel) },
  }
  const imgEl = {
    tagName: 'IMG',
    naturalWidth: 240,
    naturalHeight: 180,
    parentElement: contentsWrap,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 278, bottom: 207, width: 278, height: 207 }),
    closest(sel) { return contentsWrap.closest(sel) },
  }
  page.ctx.getComputedStyle = (el) => {
    if (el === contentsWrap) return { display: 'contents', visibility: 'visible', opacity: '1' }
    return { display: 'block', visibility: 'visible', opacity: '1' }
  }
  assert.equal(hooks.findPinUrl(imgEl), '', '花瓣 data-pin-id 不得误判为 Pinterest URL')
  assert.equal(hooks.findHuabanPinUrl(imgEl), 'https://huaban.com/pins/7058355788')
  const hit = hooks.mediaFromEvent({
    target: overlayEl,
    clientX: 120,
    clientY: 100,
    composedPath: () => [overlayEl, contentsWrap, card],
  })
  assert.equal(hit, imgEl, 'display:contents 包装层可穿透命中同级卡片图片')

  // 9b. 花瓣首页 new-home-header-active 祖先下的小图不被误判为头像
  const narrowBannerImg = {
    tagName: 'IMG',
    naturalWidth: 226,
    naturalHeight: 50,
    getBoundingClientRect: () => ({ left: 24, top: 400, right: 250, bottom: 450, width: 226, height: 50 }),
    closest(sel) {
      // 模拟首页最外层仅含 header，不含 avatar/user-head
      if (sel.includes('avatar') || sel.includes('user-head')) return null
      return sel.includes('head') ? {} : null
    },
  }
  page.doc.elementsFromPoint = () => [narrowBannerImg]
  assert.equal(hooks.mediaAtPoint(100, 420), narrowBannerImg, 'header 类名不再误杀 <80px 素材图')

  // 9c. 三大站高清原图升级与降级计划
  const clone = (x) => JSON.parse(JSON.stringify(x))
  const hbPlan = clone(hooks.buildImageUpgradePlan('https://gd-hbimg-edge.huaban.com/abc-123_fw240webp?auth_key=k1'))
  assert.deepEqual(hbPlan, {
    src: 'https://gd-hbimg-edge.huaban.com/abc-123?auth_key=k1',
    fallbackSrcs: [
      'https://gd-hbimg-edge.huaban.com/abc-123_fw1200webp?auth_key=k1',
      'https://gd-hbimg-edge.huaban.com/abc-123_fw240webp?auth_key=k1',
    ],
  })
  const hbSmallPlan = clone(hooks.buildImageUpgradePlan('https://gd-hbimg-edge.huaban.com/small/abc-123_fw240webp?auth_key=k2'))
  assert.deepEqual(hbSmallPlan, {
    src: 'https://gd-hbimg-edge.huaban.com/small/abc-123?auth_key=k2',
    fallbackSrcs: ['https://gd-hbimg-edge.huaban.com/small/abc-123_fw240webp?auth_key=k2'],
  })

  const pinPlan = clone(hooks.buildImageUpgradePlan('https://i.pinimg.com/236x/ab/cd/ef.jpg'))
  assert.deepEqual(pinPlan, {
    src: 'https://i.pinimg.com/originals/ab/cd/ef.jpg',
    fallbackSrcs: ['https://i.pinimg.com/236x/ab/cd/ef.jpg'],
  })

  const pxMasterPlan = clone(hooks.buildImageUpgradePlan('https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/01/01/00/00/00/999_p0_square1200.jpg'))
  assert.deepEqual(pxMasterPlan, {
    src: 'https://i.pximg.net/img-original/img/2026/01/01/00/00/00/999_p0.png',
    fallbackSrcs: [
      'https://i.pximg.net/img-original/img/2026/01/01/00/00/00/999_p0.jpg',
      'https://i.pximg.net/img-original/img/2026/01/01/00/00/00/999_p0.gif',
      'https://i.pximg.net/img-master/img/2026/01/01/00/00/00/999_p0_master1200.jpg',
      'https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/01/01/00/00/00/999_p0_square1200.jpg',
    ],
  })
  const pxOrigPlan = hooks.buildImageUpgradePlan(
    'https://i.pximg.net/img-master/img/2026/01/01/00/00/00/999_p0_master1200.jpg',
    { origHref: 'https://i.pximg.net/img-original/img/2026/01/01/00/00/00/999_p0.jpg' }
  )
  assert.equal(pxOrigPlan.src, 'https://i.pximg.net/img-original/img/2026/01/01/00/00/00/999_p0.jpg')

  // 9d. cleanup 清理测试钩子
  page.win.__picnestHoldCollectCleanup()
  assert.equal(page.win.__picnestCollectTestHooks, undefined)
  console.log('ok 花瓣 DOM 穿透 + 三大站原图升级计划 + cleanup 钩子清理')
}

console.log('\n全部通过')
