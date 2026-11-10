// 采集后台无头集成测试：探测 → 注入 / 原地接管 / Pinterest 一次性刷新 / popup 状态与修复
// 运行：node tools/test-collect-background.mjs
// 用最小 chrome API 桩 + vm 页面世界加载真实 background.js / content.js。
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const settle = () => new Promise((r) => setTimeout(r, 15))

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const extDir = path.join(root, 'extension')
const backgroundCode = fs.readFileSync(path.join(extDir, 'background.js'), 'utf8')
const contentCode = fs.readFileSync(path.join(extDir, 'content.js'), 'utf8')
const CONTENT_VERSION = contentCode.match(/const VERSION = '([^']+)'/)[1]

class FakeEvent {
  constructor(type) { this.type = type; this.listeners = []; this.emitLog = [] }
  addListener(fn) { this.listeners.push(fn) }
  removeListener(fn) {
    const i = this.listeners.indexOf(fn)
    if (i >= 0) this.listeners.splice(i, 1)
  }
  async emit(...args) {
    this.emitLog.push(args)
    return Promise.all(this.listeners.map((fn) => fn(...args)))
  }
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

function createPageWorld({ runtimeAlive = true } = {}) {
  const doc = new FakeTarget()
  doc.documentElement = { style: {} }
  doc.hidden = false
  doc.getElementById = () => null
  const win = new FakeTarget()
  win.__picnestHoldCollectLoaded = false
  win.__picnestHoldCollectVersion = ''
  const storageChanged = new FakeTarget()
  const chromePage = {
    runtime: runtimeAlive ? { id: 'test-extension' } : {},
    storage: {
      local: { get(defaults, cb) { cb({ ...defaults }) } },
      onChanged: storageChanged,
    },
  }
  const ctx = vm.createContext({
    window: win, document: doc, chrome: chromePage, Event: FakeEvent,
    setTimeout: () => 0, clearTimeout: () => {},
    setInterval: () => 0, clearInterval: () => {}, console,
  })
  const script = new vm.Script(contentCode, { filename: 'content.js' })
  return {
    doc, win, chrome: chromePage,
    runContent: () => script.runInContext(ctx),
    evalInPage: (func) => vm.runInContext(`(${func.toString()})()`, ctx),
  }
}

function createBackground(worlds, tabs, opts = {}) {
  const events = {
    onInstalled: new FakeEvent('installed'),
    onStartup: new FakeEvent('startup'),
    onActivated: new FakeEvent('activated'),
    onUpdated: new FakeEvent('updated'),
    onHighlighted: new FakeEvent('highlighted'),
    onRemoved: new FakeEvent('removed'),
    onFocusChanged: new FakeEvent('focus'),
    onMessage: new FakeEvent('message'),
    onMenuClicked: new FakeEvent('menu'),
  }
  const reloads = []
  const notifications = []
  let activeTabId = opts.activeTabId ?? null
  const session = new Map()

  const chrome = {
    runtime: {
      onInstalled: events.onInstalled,
      onStartup: events.onStartup,
      onMessage: events.onMessage,
      getURL: (p) => 'chrome-extension://test/' + p,
    },
    tabs: {
      onActivated: events.onActivated,
      onUpdated: events.onUpdated,
      onHighlighted: events.onHighlighted,
      onRemoved: events.onRemoved,
      async query(q = {}) {
        let list = [...tabs.values()]
        if (q.active) list = list.filter((t) => t.id === activeTabId)
        if (q.url) {
          const pats = Array.isArray(q.url) ? q.url : [q.url]
          list = list.filter((t) => pats.some((p) => p.includes('pinterest') ? /pinterest\./.test(t.url) : t.url.includes(p)))
        }
        if (q.lastFocusedWindow != null) list = list.filter((t) => t.windowId === 1)
        return list
      },
      async get(id) {
        const t = tabs.get(id)
        if (!t) throw new Error('No tab with id ' + id)
        return t
      },
      async reload(id) {
        reloads.push(id)
        const t = tabs.get(id)
        /* 模拟真实刷新：页面世界清空，新 content script 尚未注入 */
        worlds.set(id, createPageWorld())
        return t
      },
      async captureVisibleTab() { return 'data:image/jpeg;base64,' },
      async sendMessage() { return null },
    },
    windows: { onFocusChanged: events.onFocusChanged },
    contextMenus: {
      removeAll(cb) { if (cb) cb() },
      create() {},
      onClicked: events.onMenuClicked,
    },
    notifications: {
      create(n) { notifications.push(n) },
    },
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return {}
          if (Array.isArray(keys)) return {}
          return { ...keys }
        },
        async set() {},
      },
      session: {
        async get(key) { return session.has(key) ? { [key]: session.get(key) } : {} },
        async set(obj) { for (const [k, v] of Object.entries(obj)) session.set(k, v) },
      },
    },
    scripting: {
      async executeScript(o) {
        const page = worlds.get(o.target.tabId)
        if (!page) throw new Error('No page world for tab ' + o.target.tabId)
        if (o.func) {
          let result
          try { result = page.evalInPage(o.func) } catch (e) { throw new Error('executeScript failed: ' + e.message) }
          return [{ result }]
        }
        if (o.files) {
          if (!o.files.includes('content.js')) throw new Error('unknown file')
          page.runContent()
          return []
        }
        throw new Error('bad executeScript options')
      },
    },
  }

  const ctx = vm.createContext({
    chrome,
    fetch: async () => { throw new Error('no network in test') },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
    URL,
  })
  vm.runInContext(backgroundCode, ctx, { filename: 'background.js' })

  async function message(msg) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('message timeout: ' + msg?.type)), 2000)
      let responded = false
      const done = (res) => { if (responded) return; responded = true; clearTimeout(timer); resolve(res) }
      const handlers = events.onMessage.listeners
      for (const fn of handlers) fn(msg, {}, done)
    })
  }

  return {
    chrome, events, message, reloads, notifications, session, worlds,
    setActiveTab(id) { activeTabId = id },
    get activeTabId() { return activeTabId },
  }
}

function addTab(tabs, worlds, id, url, world = createPageWorld()) {
  const tab = { id, url, active: true, windowId: 1, discarded: false, title: 'test' }
  tabs.set(id, tab)
  worlds.set(id, world)
  return tab
}

/* ---------- 1. 空白页：激活时注入（不刷新） ---------- */
{
  const worlds = new Map()
  const tabs = new Map()
  const bg = createBackground(worlds, tabs, { activeTabId: 1 })
  await settle()
  addTab(tabs, worlds, 1, 'https://www.pinterest.com/')
  await bg.events.onActivated.emit({ tabId: 1 })
  assert.equal(worlds.get(1).win.__picnestHoldCollectVersion, CONTENT_VERSION, '注入 v' + CONTENT_VERSION)
  assert.equal(bg.reloads.length, 0, '空白页不需要刷新')
  const st = await bg.message({ type: 'collect-status' })
  assert.equal(st.state, 'current')
  console.log('ok 空白页激活：注入 content.js')
}

/* ---------- 2. 旧脚本无 cleanup（Pinterest）：刷新一次，重复激活不再刷新 ---------- */
{
  const worlds = new Map()
  const tabs = new Map()
  const old = createPageWorld()
  old.win.__picnestHoldCollectLoaded = true
  old.win.__picnestHoldCollectVersion = '0.1.3'
  const bg = createBackground(worlds, tabs, { activeTabId: 2 })
  await settle()
  addTab(tabs, worlds, 2, 'https://www.pinterest.com/pin/123/', old)
  await bg.events.onActivated.emit({ tabId: 2 })
  assert.equal(bg.reloads.length, 1, '旧脚本刷新一次')
  assert.equal(bg.notifications.length, 1, '刷新有通知说明')
  // 真实刷新会换新页面；这里保留旧世界模拟“刷新尚未完成”，验证标记防循环
  await bg.events.onActivated.emit({ tabId: 2 })
  assert.equal(bg.reloads.length, 1, '同一 tab+URL 不重复刷新')
  // 模拟刷新完成：新页面 + onUpdated complete → 注入
  const fresh = createPageWorld()
  worlds.set(2, fresh)
  await bg.events.onUpdated.emit(2, { status: 'complete' }, tabs.get(2))
  assert.equal(fresh.win.__picnestHoldCollectVersion, CONTENT_VERSION, '刷新后自动注入')
  assert.equal(bg.reloads.length, 1)
  console.log('ok 旧脚本（无 cleanup）：一次性自动刷新 + 刷新后注入 + 防循环')
}

/* ---------- 3. 旧脚本带 cleanup：注入新脚本原地接管，不刷新 ---------- */
{
  const worlds = new Map()
  const tabs = new Map()
  const old = createPageWorld()
  old.runContent()
  old.win.__picnestHoldCollectVersion = '0.1.3' // 模拟上一版实例（有 cleanup/health）
  const bg = createBackground(worlds, tabs, { activeTabId: 3 })
  await settle()
  addTab(tabs, worlds, 3, 'https://www.pinterest.com/', old)
  await bg.events.onActivated.emit({ tabId: 3 })
  assert.equal(worlds.get(3).win.__picnestHoldCollectVersion, CONTENT_VERSION, '原地升级')
  assert.equal(bg.reloads.length, 0, '带 cleanup 不刷新')
  assert.equal(worlds.get(3).doc.count('pointerdown'), 2, '监听器不叠加')
  console.log('ok 旧脚本（带 cleanup）：原地接管，不刷新')
}

/* ---------- 3b. 当前版本但 document 监听器失效：原地重建，不刷新 ---------- */
{
  const worlds = new Map()
  const tabs = new Map()
  const dead = createPageWorld()
  dead.runContent()
  dead.doc.listeners.clear()
  dead.win.listeners.clear()
  const bg = createBackground(worlds, tabs, { activeTabId: 8 })
  await settle()
  addTab(tabs, worlds, 8, 'https://www.pinterest.com/', dead)
  const st = await bg.message({ type: 'collect-status' })
  assert.equal(st.state, 'unhealthy')
  await bg.events.onActivated.emit({ tabId: 8 })
  assert.equal(worlds.get(8).win.__picnestHoldCollectVersion, CONTENT_VERSION, '原地重建到当前版本')
  assert.equal(bg.reloads.length, 0, '监听器失效优先重建，不刷新')
  assert.equal(worlds.get(8).doc.count('pointerdown'), 2, '新监听器已挂上')
  const after = await bg.message({ type: 'collect-status' })
  assert.equal(after.state, 'current')
  console.log('ok 当前版本监听器失效：原地重建，不刷新')
}

/* ---------- 4. 旧脚本无 cleanup（非 Pinterest）：不自动刷新 ---------- */
{
  const worlds = new Map()
  const tabs = new Map()
  const old = createPageWorld()
  old.win.__picnestHoldCollectLoaded = true
  old.win.__picnestHoldCollectVersion = '0.1.2'
  const bg = createBackground(worlds, tabs, { activeTabId: 4 })
  await settle()
  addTab(tabs, worlds, 4, 'https://www.artstation.com/', old)
  await bg.events.onActivated.emit({ tabId: 4 })
  assert.equal(bg.reloads.length, 0, '非 Pinterest 不自动刷新')
  const st = await bg.message({ type: 'collect-status' })
  assert.equal(st.state, 'stale')
  assert.equal(st.version, '0.1.2')
  console.log('ok 旧脚本（非 Pinterest）：不刷新，status=stale')
}

/* ---------- 5. 孤立脚本（扩展更新后 runtime 失效）：Pinterest 刷新 ---------- */
{
  const worlds = new Map()
  const tabs = new Map()
  const orphan = createPageWorld()
  orphan.runContent()
  orphan.chrome.runtime = {} // 扩展重载后旧 content script 失去 runtime
  const bg = createBackground(worlds, tabs, { activeTabId: 5 })
  await settle()
  addTab(tabs, worlds, 5, 'https://www.pinterest.com/', orphan)
  const before = await bg.message({ type: 'collect-status' })
  assert.equal(before.state, 'orphan')
  await bg.events.onActivated.emit({ tabId: 5 })
  assert.equal(bg.reloads.length, 1, '孤立脚本刷新')
  console.log('ok 孤立脚本：status=orphan + 自动刷新')
}

/* ---------- 6. popup「修复本页」：缺脚本 → 注入；刷新兜底 ---------- */
{
  const worlds = new Map()
  const tabs = new Map()
  const bg = createBackground(worlds, tabs, { activeTabId: 6 })
  await settle()
  addTab(tabs, worlds, 6, 'https://example.com/')
  const st = await bg.message({ type: 'collect-status' })
  assert.equal(st.state, 'missing')
  const fixed = await bg.message({ type: 'collect-repair', tabId: 6 })
  assert.equal(fixed.action, 'injected')
  assert.equal(worlds.get(6).win.__picnestHoldCollectVersion, CONTENT_VERSION)
  const again = await bg.message({ type: 'collect-repair', tabId: 6 })
  assert.equal(again.action, 'none', '已就绪不重复操作')
  console.log('ok popup 修复：missing → injected；就绪 → none')
}

/* ---------- 7. 不支持页面：status=unsupported，不会误注入 ---------- */
{
  const worlds = new Map()
  const tabs = new Map()
  const bg = createBackground(worlds, tabs, { activeTabId: 7 })
  await settle()
  addTab(tabs, worlds, 7, 'chrome://extensions/')
  const st = await bg.message({ type: 'collect-status' })
  assert.equal(st.state, 'unsupported')
  await bg.events.onActivated.emit({ tabId: 7 })
  assert.equal(bg.reloads.length, 0)
  console.log('ok chrome:// 页面：unsupported，不注入不刷新')
}

console.log('\n全部通过')
process.exit(0)
