// PicNest 采集扩展真实 Chrome 冒烟测试（CDP Extensions.loadUnpacked + Service Worker 求值）
// 运行：node tools/e2e-extension.mjs
// 需要 Chrome 137+；用 --enable-unsafe-extension-debugging 加载未打包扩展，不碰用户配置。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const extDir = path.join(root, 'extension')
const contentCode = fs.readFileSync(path.join(extDir, 'content.js'), 'utf8')
const CONTENT_VERSION = contentCode.match(/const VERSION = '([^']+)'/)[1]
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!fs.existsSync(chromePath)) {
  console.error('找不到 Chrome：', chromePath)
  process.exit(2)
}

/* ---------- 本地测试页（Pinterest 域名映射到本机，触发自动刷新分支） ---------- */
const server = http.createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return }
  if (req.url === '/pic.svg') {
    res.writeHead(200, { 'content-type': 'image/svg+xml' })
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#b4884b"/><circle cx="160" cy="100" r="60" fill="#fff"/></svg>')
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><html><body style="margin:0"><img id="pic" src="/pic.svg" width="320" height="200"></body></html>')
})
const port = await new Promise((resolve, reject) => {
  const s = server.listen(0, '127.0.0.1', () => resolve(s.address().port))
  s.on('error', reject)
})

/* ---------- 启动临时 Chrome ---------- */
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'picnest-e2e-'))
const debugPort = await new Promise((resolve, reject) => {
  const s = net.createServer()
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
  s.on('error', reject)
})
const chrome = spawn(chromePath, [
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${debugPort}`,
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--enable-unsafe-extension-debugging',
  '--no-proxy-server',
  `--host-resolver-rules=MAP www.pinterest.test 127.0.0.1`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
let chromeErr = ''
chrome.stderr.on('data', (d) => { chromeErr += d.toString() })

async function fetchJson(p, timeout = 3000) {
  const res = await fetch(`http://127.0.0.1:${debugPort}${p}`, { signal: AbortSignal.timeout(timeout) })
  if (!res.ok) throw new Error(`CDP HTTP ${res.status}: ${p}`)
  return await res.json()
}
async function waitBrowser() {
  for (let i = 0; i < 80; i++) {
    try { return await fetchJson('/json/version') } catch { await sleep(250) }
  }
  throw new Error('Chrome 未启动：' + chromeErr.slice(-500))
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let seq = 0
    let settled = false
    let eventHandler = null
    const pending = new Map()
    const events = []
    const failAll = (error) => {
      for (const p of pending.values()) p.reject(error)
      pending.clear()
    }
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.method) {
        if (eventHandler) eventHandler(msg)
        else events.push(msg)
        return
      }
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
    }
    ws.onerror = () => {
      const error = new Error('CDP WebSocket 失败')
      failAll(error)
      if (!settled) { settled = true; reject(error) }
    }
    ws.onclose = () => {
      const error = new Error('CDP WebSocket 已关闭')
      failAll(error)
      if (!settled) { settled = true; reject(error) }
    }
    ws.onopen = () => {
      settled = true
      resolve({
        send(method, params = {}, timeout = 15000) {
          return new Promise((res, rej) => {
            const id = ++seq
            const timer = setTimeout(() => {
              pending.delete(id)
              rej(new Error(`CDP 超时: ${method}`))
            }, timeout)
            pending.set(id, {
              resolve: (value) => { clearTimeout(timer); res(value) },
              reject: (error) => { clearTimeout(timer); rej(error) },
            })
            ws.send(JSON.stringify({ id, method, params }))
          })
        },
        onEvent(handler) {
          eventHandler = handler
          for (const event of events.splice(0)) handler(event)
        },
        close() { try { ws.close() } catch { /* 静默 */ } },
      })
    }
  })
}

let sw = null
let pageCdp = null
let browser = null
const results = []
function ok(name) { results.push(name); console.log('ok', name) }

try {
  const version = await waitBrowser()
  browser = await connect(version.webSocketDebuggerUrl)
  const loaded = await browser.send('Extensions.loadUnpacked', { path: extDir })
  const extId = loaded.id
  assert.ok(extId, '扩展加载成功')
  console.log('扩展 id', extId)

  /* 打开 popup 唤醒 service worker（安装后 SW 可能尚未启动） */
  const popup = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` })
  let swTarget = null
  const swDeadline = Date.now() + 12000
  while (Date.now() < swDeadline) {
    const list = await fetchJson('/json/list')
    swTarget = list.find((t) => t.type === 'service_worker' && t.url.includes(extId))
    if (swTarget) break
    await sleep(200)
  }
  if (!swTarget) throw new Error('service worker 未在 12 秒内启动')
  sw = await connect(swTarget.webSocketDebuggerUrl)
  const contexts = new Set()
  const extensionOrigin = `chrome-extension://${extId}`
  sw.onEvent((msg) => {
    if (msg.method !== 'Runtime.executionContextCreated') return
    const context = msg.params?.context || {}
    const origin = context.origin || ''
    const url = context.url || ''
    if (origin === extensionOrigin || origin.startsWith(`${extensionOrigin}/`) || url.startsWith(`${extensionOrigin}/`)) {
      contexts.add(context.id)
    }
  })
  await sw.send('Runtime.enable')
  const contextDeadline = Date.now() + 12000
  while (!contexts.size && Date.now() < contextDeadline) await sleep(100)
  if (!contexts.size) throw new Error('service worker execution context 未在 12 秒内就绪')
  const swContextId = contexts.values().next().value
  await browser.send('Target.closeTarget', { targetId: popup.targetId })

  async function evalSW(expression) {
    const r = await sw.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      contextId: swContextId,
    })
    if (r.exceptionDetails) {
      throw new Error('SW 求值失败：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    }
    return r.result.value
  }
  async function tabs() { return await evalSW('chrome.tabs.query({})') }
  async function waitTab(urlPart, timeout = 12000) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      const t = (await tabs()).find((x) => (x.url || '').includes(urlPart) && x.status === 'complete')
      if (t) return t
      await sleep(200)
    }
    throw new Error('标签页未就绪：' + urlPart)
  }
  async function probe(tabId) { return await evalSW(`probeCollect(${tabId})`) }
  async function waitCurrent(tabId, timeout = 8000) {
    const t0 = Date.now()
    let last = null
    while (Date.now() - t0 < timeout) {
      last = await probe(tabId)
      if (last && last.loaded && last.version === CONTENT_VERSION && last.alive && last.healthy) return last
      await sleep(200)
    }
    throw new Error('脚本未就绪：' + JSON.stringify(last))
  }
  async function pageEval(tabId, func) {
    return await evalSW(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: ${func.toString()} }).then((r) => r[0] && r[0].result)`)
  }

  const manifestVersion = await evalSW('chrome.runtime.getManifest().version')
  assert.equal(manifestVersion, CONTENT_VERSION)
  ok('扩展 v' + CONTENT_VERSION + ' 加载成功')

  /* ---------- Pinterest 页面：注入 + 状态 ---------- */
  const pinUrl = `http://www.pinterest.test:${port}/`
  await browser.send('Target.createTarget', { url: pinUrl })
  const pinTab = await waitTab(`www.pinterest.test:${port}`)
  await waitCurrent(pinTab.id)
  ok('Pinterest 页面：manifest 自动注入 + 健康探测通过')

  await evalSW(`chrome.tabs.update(${pinTab.id}, { active: true })`)
  await sleep(300)
  let st = await evalSW('collectStatus()')
  assert.equal(st.state, 'current')
  assert.equal(st.version, CONTENT_VERSION)
  ok('popup collectStatus：current v' + CONTENT_VERSION)

  /* ---------- 旧版带 cleanup：原地接管，不刷新 ---------- */
  await pageEval(pinTab.id, () => {
    window.__pnE2eMarker = 'takeover'
    window.__picnestHoldCollectVersion = '0.1.3'
  })
  const beforeMarker = await pageEval(pinTab.id, () => window.__pnE2eMarker || null)
  await evalSW(`(async () => ensureCollectScript(await chrome.tabs.get(${pinTab.id}), 0, true))()`)
  const afterProbe = await probe(pinTab.id)
  assert.equal(afterProbe.version, CONTENT_VERSION)
  assert.equal(afterProbe.healthy, true)
  const afterMarker = await pageEval(pinTab.id, () => window.__pnE2eMarker || null)
  assert.equal(beforeMarker, 'takeover')
  assert.equal(afterMarker, 'takeover', '原地接管没有刷新页面')
  ok('旧版带 cleanup：原地接管（同 document，不刷新）')

  /* ---------- document.open 清空监听器：后台「修复本页」原地重建 ---------- */
  await pageEval(pinTab.id, () => {
    document.open()
    document.write('<!doctype html><html><body><img id="x" src="/pic.svg" width="320" height="200"><p>rebuilt</p></body></html>')
    document.close()
  })
  await sleep(350)
  const wiped = await probe(pinTab.id)
  assert.equal(wiped.loaded, true)
  assert.equal(wiped.version, CONTENT_VERSION)
  assert.equal(wiped.healthy, false)
  const repairedPin = await evalSW(`repairCollect(${pinTab.id})`)
  assert.ok(['rebuilt', 'none'].includes(repairedPin.action), '修复动作：' + repairedPin.action)
  const afterRepair = await probe(pinTab.id)
  assert.equal(afterRepair.healthy, true)
  ok('document.open 清空监听器：popup 修复原地重建')

  /* ---------- content 看门狗：document.open 后不靠后台也能自愈 ---------- */
  await pageEval(pinTab.id, () => {
    document.open()
    document.write('<!doctype html><html><body><img id="y" src="/pic.svg" width="320" height="200"></body></html>')
    document.close()
  })
  await sleep(350)
  const wiped2 = await probe(pinTab.id)
  assert.equal(wiped2.healthy, false)
  await sleep(3500)
  const healed = await probe(pinTab.id)
  assert.equal(healed.healthy, true)
  assert.equal(healed.version, CONTENT_VERSION)
  ok('document.open 清空监听器：content 看门狗自愈')

  /* ---------- 极旧脚本（无 cleanup）：Pinterest 自动刷新一次 ---------- */
  await pageEval(pinTab.id, () => {
    window.__pnE2eMarker = 'ancient'
    window.__picnestHoldCollectLoaded = true
    window.__picnestHoldCollectVersion = '0.1.2'
    delete window.__picnestHoldCollectCleanup
    delete window.__picnestHoldCollectHealth
  })
  const ancient = await probe(pinTab.id)
  assert.equal(ancient.version, '0.1.2')
  assert.equal(ancient.cleanup, false)
  await evalSW(`(async () => ensureCollectScript(await chrome.tabs.get(${pinTab.id}), 0, true))()`)
  await sleep(600)
  await waitCurrent(pinTab.id, 12000)
  const gone = await pageEval(pinTab.id, () => window.__pnE2eMarker || null)
  assert.equal(gone, null, '自动刷新换掉了 document')
  ok('极旧脚本：Pinterest 自动刷新一次 + 刷新后注入当前版')

  /* ---------- 防循环：同一 tab+URL 不再刷新 ---------- */
  await pageEval(pinTab.id, () => {
    window.__pnE2eMarker = 'keep'
    window.__picnestHoldCollectLoaded = true
    window.__picnestHoldCollectVersion = '0.1.2'
    delete window.__picnestHoldCollectCleanup
    delete window.__picnestHoldCollectHealth
  })
  await evalSW(`(async () => ensureCollectScript(await chrome.tabs.get(${pinTab.id}), 0, true))()`)
  await sleep(800)
  const kept = await pageEval(pinTab.id, () => window.__pnE2eMarker || null)
  assert.equal(kept, 'keep', '同一 tab+URL 不应再次刷新')
  ok('防循环：同一 tab+URL 只自动刷新一次')
  /* 手动恢复，便于后续测试 */
  await evalSW(`chrome.tabs.reload(${pinTab.id})`)
  await sleep(1200)
  await waitCurrent(pinTab.id, 12000)

  /* ---------- 非 Pinterest：不自动刷新，status=stale，repair 兜底刷新 ---------- */
  const plainUrl = `http://127.0.0.1:${port}/`
  await browser.send('Target.createTarget', { url: plainUrl })
  const plainTab = await waitTab(`127.0.0.1:${port}`)
  await waitCurrent(plainTab.id)
  await evalSW(`chrome.tabs.update(${plainTab.id}, { active: true })`)
  await sleep(250)
  await pageEval(plainTab.id, () => {
    window.__pnE2eMarker = 'plain'
    window.__picnestHoldCollectLoaded = true
    window.__picnestHoldCollectVersion = '0.1.2'
    delete window.__picnestHoldCollectCleanup
    delete window.__picnestHoldCollectHealth
  })
  await evalSW(`(async () => ensureCollectScript(await chrome.tabs.get(${plainTab.id}), 0, true))()`)
  await sleep(500)
  const stillThere = await pageEval(plainTab.id, () => window.__pnE2eMarker || null)
  assert.equal(stillThere, 'plain', '非 Pinterest 不应自动刷新')
  st = await evalSW('collectStatus()')
  assert.equal(st.state, 'stale')
  assert.equal(st.version, '0.1.2')
  const repaired = await evalSW(`repairCollect(${plainTab.id})`)
  assert.equal(repaired.action, 'reloaded')
  await sleep(1200)
  await waitCurrent(plainTab.id, 12000)
  const repairedGone = await pageEval(plainTab.id, () => window.__pnE2eMarker || null)
  assert.equal(repairedGone, null)
  ok('非 Pinterest：不自动刷新 → status=stale →「修复本页」刷新后恢复')

  /* ---------- 采集面板「＋ 新建文件夹…」：拖拽直达 + 花瓣式捕获拦截 + 键盘隔离 + 遗留宿主替换 ---------- */
  await evalSW(`(() => {
    globalThis.__origFetchForE2e = globalThis.fetch
    globalThis.__e2eCreatedFolders = []
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('http://127.0.0.1:41600')) {
        if (url.includes('/api/v1/context')) {
          return new Response(JSON.stringify({ ok: true, roots: [{ id: 1, name: '图源' }], rootId: 1 }))
        }
        if (url.includes('/api/v1/folders')) {
          return new Response(JSON.stringify({ ok: true, root: { id: 1, name: '图源' }, folders: [{ id: 'Ceramic', name: 'Ceramic', children: [] }] }))
        }
        if (url.includes('/api/v1/folder/create')) {
          const body = JSON.parse(init.body)
          globalThis.__e2eCreatedFolders.push(body.name)
          return new Response(JSON.stringify({ ok: true, folder: { id: body.name, name: body.name, parent: null } }))
        }
        return new Response(JSON.stringify({ ok: true }))
      }
      return globalThis.__origFetchForE2e(url, init)
    }
  })()`)

  const panelUrl = `http://127.0.0.1:${port}/?panel=1`
  const panelTarget = await browser.send('Target.createTarget', { url: panelUrl })
  const panelTab = await waitTab('panel=1')
  await waitCurrent(panelTab.id)
  await evalSW(`chrome.tabs.update(${panelTab.id}, { active: true })`)
  const targetList = await fetchJson('/json/list')
  const pageTarget = targetList.find((t) => t.id === panelTarget.targetId)
  assert.ok(pageTarget, '找到面板测试页 CDP target')
  pageCdp = await connect(pageTarget.webSocketDebuggerUrl)
  await pageCdp.send('Runtime.enable')
  const evalPage = async (expr) => {
    const r = await pageCdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })
    if (r.exceptionDetails) throw new Error('页面求值失败：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  const clickAt = async (x, y) => {
    await pageCdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
    await pageCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await pageCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  }

  // 1) 长按图片后直接拖到「＋ 新建文件夹…」松手：应直接展开输入框并聚焦，Esc 只关输入框不关面板
  await pageCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 100, button: 'left', buttons: 1, clickCount: 1 })
  await sleep(550)
  const dragRects = await evalPage(`(() => {
    const sr = document.getElementById('picnest-collect-host')?.shadowRoot
    const btn = sr?.querySelector('.newdir')
    return {
      hasPanel: !!sr?.querySelector('.panel'),
      btn: btn?.getBoundingClientRect()?.toJSON(),
    }
  })()`)
  assert.equal(dragRects.hasPanel, true, '长按弹出采集面板')
  const dbx = dragRects.btn.x + dragRects.btn.width / 2
  const dby = dragRects.btn.y + dragRects.btn.height / 2
  await pageCdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dbx, y: dby, buttons: 1 })
  await pageCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dbx, y: dby, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(150)
  const afterDragNewdir = await evalPage(`(() => {
    const sr = document.getElementById('picnest-collect-host')?.shadowRoot
    const form = sr?.querySelector('.newdir-form')
    return {
      panelAlive: !!sr?.querySelector('.panel'),
      formHidden: form?.hidden,
      activeCls: sr?.activeElement?.className || '',
    }
  })()`)
  assert.equal(afterDragNewdir.panelAlive, true)
  assert.equal(afterDragNewdir.formHidden, false, '拖拽松开在新建文件夹按钮上应直接展开输入框')
  assert.equal(afterDragNewdir.activeCls, 'newdir-input')

  await pageCdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await pageCdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(100)
  const afterEscForm = await evalPage(`(() => {
    const sr = document.getElementById('picnest-collect-host')?.shadowRoot
    return { panelAlive: !!sr?.querySelector('.panel'), formHidden: sr?.querySelector('.newdir-form')?.hidden }
  })()`)
  assert.equal(afterEscForm.panelAlive, true, '第一次 Esc 只收起新建文件夹表单，面板保持打开')
  assert.equal(afterEscForm.formHidden, true)
  await pageCdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await pageCdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(100)
  ok('拖拽直达「＋ 新建文件夹…」松手即展开 + Esc 分层关闭')

  // 2) 模拟花瓣捕获阶段 click 拦截 + window 键盘窃听 + 遗留旧宿主 DOM 节点
  await evalPage(`(() => {
    window.__e2eBlockedKeys = []
    window.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault() }, true)
    document.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault() }, true)
    window.addEventListener('keydown', (e) => { window.__e2eBlockedKeys.push(e.key) }, true)
    const stale = document.createElement('div')
    stale.id = 'picnest-collect-host'
    stale.attachShadow({ mode: 'open' }).innerHTML = '<div class="wrap"><div class="stale-marker"></div></div>'
    document.documentElement.appendChild(stale)
  })()`)
  await pageCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 100, button: 'left', buttons: 1, clickCount: 1 })
  await sleep(550)
  const panelRects = await evalPage(`(() => {
    const sr = document.getElementById('picnest-collect-host')?.shadowRoot
    return {
      staleRemoved: !sr?.querySelector('.stale-marker'),
      head: sr?.querySelector('.head')?.getBoundingClientRect()?.toJSON(),
      btn: sr?.querySelector('.newdir')?.getBoundingClientRect()?.toJSON(),
    }
  })()`)
  assert.equal(panelRects.staleRemoved, true, '遗留旧宿主节点已被当前实例安全替换')
  await pageCdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: panelRects.head.x + 20, y: panelRects.head.y + 10, buttons: 1 })
  await pageCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: panelRects.head.x + 20, y: panelRects.head.y + 10, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(100)

  await clickAt(panelRects.btn.x + panelRects.btn.width / 2, panelRects.btn.y + panelRects.btn.height / 2)
  await sleep(150)
  const formState = await evalPage(`(() => {
    const sr = document.getElementById('picnest-collect-host')?.shadowRoot
    return {
      formHidden: sr?.querySelector('.newdir-form')?.hidden,
      activeCls: sr?.activeElement?.className || '',
      okRect: sr?.querySelector('[data-act="create"]')?.getBoundingClientRect()?.toJSON(),
    }
  })()`)
  assert.equal(formState.formHidden, false, '即使页面捕获拦截 click，新建文件夹表单仍可打开')
  assert.equal(formState.activeCls, 'newdir-input')

  await pageCdp.send('Input.insertText', { text: '花瓣新建测试' })
  await sleep(100)
  await clickAt(formState.okRect.x + formState.okRect.width / 2, formState.okRect.y + formState.okRect.height / 2)
  await sleep(250)
  const afterCreate = await evalPage(`(() => {
    const sr = document.getElementById('picnest-collect-host')?.shadowRoot
    return {
      panelAlive: !!sr?.querySelector('.panel'),
      state: sr?.querySelector('.state')?.textContent,
      rows: [...(sr?.querySelectorAll('.row') || [])].map((r) => r.dataset.rel),
      leakedKeys: window.__e2eBlockedKeys,
    }
  })()`)
  assert.equal(afterCreate.panelAlive, true)
  assert.equal(afterCreate.state, '已创建：花瓣新建测试（点击它保存）')
  assert.ok(afterCreate.rows.includes('花瓣新建测试'))
  const createdFolders = await evalSW('globalThis.__e2eCreatedFolders')
  assert.deepEqual(createdFolders, ['花瓣新建测试'])
  await evalSW('(() => { if (globalThis.__origFetchForE2e) globalThis.fetch = globalThis.__origFetchForE2e })()')
  ok('捕获阶段 click 拦截 + 遗留宿主替换 + 新建文件夹创建闭环')

  console.log('\n真实 Chrome 冒烟测试全部通过：', results.length, '项')
} finally {
  try { pageCdp?.close() } catch { /* 静默 */ }
  try { sw?.close() } catch { /* 静默 */ }
  try { browser?.close() } catch { /* 静默 */ }
  try { chrome.kill() } catch { /* 静默 */ }
  try { server.close() } catch { /* 静默 */ }
  await sleep(300)
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* 静默 */ }
}
