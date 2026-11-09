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

async function fetchJson(p) {
  const res = await fetch(`http://127.0.0.1:${debugPort}${p}`)
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
    const pending = new Map()
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (!msg.id) return
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
    }
    ws.onerror = () => reject(new Error('CDP WebSocket 失败'))
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const id = ++seq
          pending.set(id, { resolve: res, reject: rej })
          ws.send(JSON.stringify({ id, method, params }))
        })
      },
      close() { try { ws.close() } catch { /* 静默 */ } },
    })
  })
}

let sw = null
const results = []
function ok(name) { results.push(name); console.log('ok', name) }

try {
  const version = await waitBrowser()
  const browser = await connect(version.webSocketDebuggerUrl)
  const loaded = await browser.send('Extensions.loadUnpacked', { path: extDir })
  const extId = loaded.id
  assert.ok(extId, '扩展加载成功')
  console.log('扩展 id', extId)

  /* 打开 popup 唤醒 service worker（安装后 SW 可能尚未启动） */
  const popup = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` })
  let swTarget = null
  for (let i = 0; i < 50; i++) {
    const list = await fetchJson('/json/list')
    swTarget = list.find((t) => t.type === 'service_worker' && t.url.includes(extId))
    if (swTarget) break
    await sleep(200)
  }
  if (!swTarget) throw new Error('service worker 未启动')
  sw = await connect(swTarget.webSocketDebuggerUrl)
  await sw.send('Runtime.enable')
  await browser.send('Target.closeTarget', { targetId: popup.targetId })

  async function evalSW(expression) {
    const r = await sw.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
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

  console.log('\n真实 Chrome 冒烟测试全部通过：', results.length, '项')
} finally {
  try { sw?.close() } catch { /* 静默 */ }
  try { chrome.kill() } catch { /* 静默 */ }
  try { server.close() } catch { /* 静默 */ }
  await sleep(300)
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* 静默 */ }
}
