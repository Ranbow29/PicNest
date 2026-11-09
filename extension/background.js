// PicNest 图巢采集 — MV3 后台
// 本地服务：PicNest 主进程 127.0.0.1:41600（无云端上传）
// 图片由 PicNest 服务端下载（保留浏览器登录态无法传递，遇到防盗链时回退失败提示）
const API = 'http://127.0.0.1:41600'
const MENU_IMAGE = 'picnest-save-image'
const MENU_PAGE = 'picnest-save-page'

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_IMAGE, title: '保存图片到图巢', contexts: ['image'] })
    chrome.contextMenus.create({ id: MENU_PAGE, title: '保存页面截图到图巢', contexts: ['page'] })
  })
})

/* 标签页恢复（Edge 睡眠标签 / bfcache / 扩展重载）时浏览器不会自动重新注入 content script。
   这里在标签激活、URL 更新、窗口聚焦、扩展启动时主动探测：
   - 页面没脚本 → 注入 content.js
   - 旧脚本带 __picnestHoldCollectCleanup → 注入新脚本原地清理并重建
   - 更老的脚本（无 cleanup）/ 扩展更新后失去 runtime 的孤立脚本 / document 监听器失效
     → 只在 Pinterest 标签自动刷新一次（chrome.storage.session 记标记防循环），其它站点走 popup「修复本页」。
   content.js 在监听器全部注册完成之后才置 Loaded，并提供健康事件，部分初始化也能被发现。 */
const CONTENT_VERSION = '0.1.4'
const RELOAD_KEY = 'picnestCollectReloads'
const INJECTABLE_RE = /^(https?|file):\/\//i
const PINTEREST_HOST_RE = /(^|\.)pinterest\.[a-z.]+$/i
const busyTabs = new Set()
let reloadMarksCache = {}

function isInjectableUrl(url) {
  return INJECTABLE_RE.test(url || '')
}
function isPinterestUrl(url) {
  try { return PINTEREST_HOST_RE.test(new URL(url).hostname) } catch { return false }
}
function probeCurrent(p) {
  return !!p && p.loaded === true && p.alive === true && p.healthy === true &&
    p.version === CONTENT_VERSION
}

/* 注入页面执行：Loaded/Version/Cleanup/Runtime 是否可用 + document 监听器是否还能收到事件 */
async function probeCollect(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          const read = () => {
            try { return window.__picnestHoldCollectHealth?.() || null } catch { return null }
          }
          let alive = false
          try { alive = !!chrome.runtime?.id } catch { alive = false }
          const before = read()
          try { document.dispatchEvent(new Event('picnest-collect-probe')) } catch { /* 静默 */ }
          const after = read()
          return {
            loaded: !!window.__picnestHoldCollectLoaded,
            version: String(window.__picnestHoldCollectVersion || ''),
            cleanup: typeof window.__picnestHoldCollectCleanup === 'function',
            alive,
            healthy: !!before && !!after && Number(after.ticks) > Number(before.ticks),
            enabled: !after || after.enabled !== false,
          }
        } catch (e) {
          return {
            loaded: false, version: '', cleanup: false, alive: false, healthy: false,
            enabled: true, error: String(e?.message || e),
          }
        }
      },
    })
    return (r && r.result) || {
      loaded: false, version: '', cleanup: false, alive: false, healthy: false, enabled: true,
    }
  } catch {
    return null
  }
}

async function injectCollect(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
    return true
  } catch {
    return false
  }
}

async function readReloadMarks() {
  try {
    const s = await chrome.storage.session.get(RELOAD_KEY)
    if (s && s[RELOAD_KEY] && typeof s[RELOAD_KEY] === 'object') reloadMarksCache = s[RELOAD_KEY]
  } catch { /* 退回内存标记 */ }
  return reloadMarksCache
}
async function writeReloadMarks(marks) {
  reloadMarksCache = marks
  try { await chrome.storage.session.set({ [RELOAD_KEY]: marks }) } catch { /* 仅内存 */ }
}
async function alreadyReloaded(tabId, url) {
  const marks = await readReloadMarks()
  const m = marks[tabId]
  return !!m && m.key === `${CONTENT_VERSION}|${url}` && Date.now() - (m.at || 0) < 2 * 60 * 60 * 1000
}
async function markReloaded(tabId, url) {
  const marks = await readReloadMarks()
  const now = Date.now()
  for (const [id, m] of Object.entries(marks)) {
    if (!m || now - (m.at || 0) > 2 * 60 * 60 * 1000) delete marks[id]
  }
  marks[tabId] = { key: `${CONTENT_VERSION}|${url}`, at: now }
  await writeReloadMarks(marks)
}
async function forgetReloadMark(tabId) {
  const marks = await readReloadMarks()
  if (!marks[tabId]) return
  delete marks[tabId]
  await writeReloadMarks(marks)
}

/* 同一个 tab 只自动刷新一次（同版本 + 同 URL）；刷新后由 onUpdated 重新探测 */
async function reloadTabOnce(tab) {
  const url = tab?.url || ''
  if (!tab?.id || !url) return false
  if (await alreadyReloaded(tab.id, url)) return false
  await markReloaded(tab.id, url)
  try {
    await chrome.tabs.reload(tab.id)
    notify(true, 'Pinterest 页面已自动刷新，以启用最新采集脚本')
    return true
  } catch {
    return false
  }
}

async function handleStale(tab, probe, allowReload) {
  /* 仍在运行、只是版本旧的实例：注入新 content.js 会先清理旧监听器再初始化，无需刷新 */
  if (probe?.cleanup && probe.alive && probe.version !== CONTENT_VERSION) {
    await injectCollect(tab.id)
    const after = await probeCollect(tab.id)
    if (probeCurrent(after)) return true
  }
  /* 无 cleanup / 孤立脚本 / 监听器失效：只在 Pinterest 页自动刷新一次 */
  if (allowReload && isPinterestUrl(tab.url)) return await reloadTabOnce(tab)
  return false
}

function scheduleRetry(tab, attempt, allowReload) {
  if (attempt >= 2) return
  setTimeout(() => {
    chrome.tabs.get(tab.id).then((x) => ensureCollectScript(x, attempt + 1, allowReload)).catch(() => {})
  }, attempt === 0 ? 350 : 1200)
}

async function ensureCollectScript(tab, attempt = 0, allowReload = true) {
  let t = tab
  try {
    if (!t?.id) return
    if (!isInjectableUrl(t.url)) t = await chrome.tabs.get(t.id)
  } catch {
    return
  }
  if (!t?.id || !isInjectableUrl(t.url) || t.discarded) return
  if (busyTabs.has(t.id)) return
  busyTabs.add(t.id)
  try {
    const probe = await probeCollect(t.id)
    if (!probe) { scheduleRetry(t, attempt, allowReload); return }
    if (probeCurrent(probe)) return
    if (!probe.loaded) {
      await injectCollect(t.id)
      const after = await probeCollect(t.id)
      if (probeCurrent(after)) return
      if (after && after.loaded) { await handleStale(t, after, allowReload); return }
      scheduleRetry(t, attempt, allowReload)
      return
    }
    await handleStale(t, probe, allowReload)
  } finally {
    busyTabs.delete(t.id)
  }
}

async function ensureActiveTab() {
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (t) await ensureCollectScript(t, 0, true)
  } catch { /* no active tab */ }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try { await ensureCollectScript(await chrome.tabs.get(tabId), 0, true) } catch { /* closed */ }
})
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' && !changeInfo.url) return
  if (changeInfo.url) void forgetReloadMark(tabId)
  return ensureCollectScript(tab, 0, !!tab.active)
})
chrome.tabs.onHighlighted.addListener(({ tabIds }) => {
  const id = tabIds?.[0]
  if (id == null) return
  return chrome.tabs.get(id).then((t) => ensureCollectScript(t, 0, t.active !== false)).catch(() => {})
})
chrome.tabs.onRemoved.addListener((tabId) => forgetReloadMark(tabId))
chrome.windows.onFocusChanged.addListener(() => ensureActiveTab())

async function ensurePinterestTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://*.pinterest.com/*', 'https://pinterest.com/*'] })
    /* 启动/安装时只补注入，不在后台批量刷新；切到该标签时再按需刷新 */
    for (const tab of tabs) await ensureCollectScript(tab, 0, false)
  } catch { /* 权限/页面限制 */ }
}
function ensurePinterestSoon() {
  void ensurePinterestTabs()
  setTimeout(() => { void ensurePinterestTabs() }, 1500)
  setTimeout(() => { void ensurePinterestTabs() }, 4500)
}
chrome.runtime.onStartup.addListener(ensurePinterestSoon)
chrome.runtime.onInstalled.addListener(ensurePinterestSoon)
/* service worker 启动即补一次：扩展重载/休眠唤醒不依赖 onInstalled */
ensurePinterestSoon()

async function apiRaw(path, body, method) {
  const init = { method: method || (body ? 'POST' : 'GET') }
  if (body) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const res = await fetch(API + path, init)
  return await res.json().catch(() => ({}))
}
async function api(path, body, method) {
  const data = await apiRaw(path, body, method)
  if (!data.ok) throw new Error(data.error || ('HTTP ' + (data.status || '?')))
  return data
}

async function getTarget() {
  const s = await chrome.storage.local.get(['rootId', 'rel'])
  return { rootId: s.rootId ?? null, rel: s.rel ?? '' }
}

function notify(ok, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon128.png'),
      title: ok ? 'PicNest 图巢' : 'PicNest 采集失败',
      message: String(message || '').slice(0, 180),
    })
  } catch { /* 通知权限异常时静默 */ }
}

/* blob: 图片在后台取不到，注入页面上下文转 dataURL */
async function blobToDataUrl(src, tabId, frameId) {
  const targets = { tabId }
  if (frameId != null) targets.frameIds = [frameId]
  const [r] = await chrome.scripting.executeScript({
    target: targets,
    func: async (u) => {
      const res = await fetch(u)
      const blob = await res.blob()
      return await new Promise((ok, no) => {
        const fr = new FileReader()
        fr.onload = () => ok(fr.result)
        fr.onerror = no
        fr.readAsDataURL(blob)
      })
    },
    args: [src],
  })
  return r?.result || ''
}

async function saveImage(info, tab) {
  const src = info.srcUrl || ''
  if (!src) throw new Error('没有图片地址')
  let payload
  if (src.startsWith('data:')) payload = { dataUrl: src }
  else if (src.startsWith('blob:')) {
    const dataUrl = await blobToDataUrl(src, tab.id, info.frameId)
    if (!dataUrl) throw new Error('blob 图片读取失败')
    payload = { dataUrl }
  } else payload = { src }
  const t = await getTarget()
  const r = await api('/api/v1/save', {
    kind: 'image',
    title: tab?.title || '',
    url: info.pageUrl || '',
    ...payload,
    ...t,
  })
  return r.saved?.[0]?.name || '已保存'
}

async function savePage(tab) {
  if (!tab?.id) throw new Error('没有活动标签页')
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 85 })
  const t = await getTarget()
  const r = await api('/api/v1/save', {
    kind: 'page',
    dataUrl,
    title: tab.title || '页面截图',
    url: tab.url || '',
    ...t,
  })
  return r.saved?.[0]?.name || '已保存'
}

/* popup：当前标签页的采集脚本状态（current / missing / stale / orphan / unhealthy / unavailable / unsupported） */
async function collectStatus() {
  let tab = null
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    tab = t || null
  } catch { /* 无活动标签 */ }
  if (!tab?.id) return { ok: false, error: '没有活动标签页' }
  const base = { ok: true, tabId: tab.id, url: tab.url || '', contentVersion: CONTENT_VERSION }
  if (!isInjectableUrl(tab.url)) return { ...base, state: 'unsupported' }
  const probe = await probeCollect(tab.id)
  if (!probe) return { ...base, state: 'unavailable' }
  let state = 'current'
  if (!probe.loaded) state = 'missing'
  else if (!probe.alive) state = 'orphan'
  else if (probe.version !== CONTENT_VERSION) state = 'stale'
  else if (probe.healthy !== true) state = 'unhealthy'
  return {
    ...base, state, version: probe.version,
    enabled: probe.enabled !== false, cleanup: !!probe.cleanup,
    pinterest: isPinterestUrl(tab.url),
  }
}

/* popup「修复本页」：能注入就注入（旧版带 cleanup 会原地重建），否则刷新页面 */
async function repairCollect(tabId) {
  let tab = null
  try { tab = await chrome.tabs.get(tabId) } catch { /* closed */ }
  if (!tab?.id || !isInjectableUrl(tab.url)) {
    return { ok: false, error: '当前页面不支持重新注入（仅 http/https/file）' }
  }
  let probe = await probeCollect(tab.id)
  if (probeCurrent(probe)) return { ok: true, action: 'none' }
  if (probe && probe.loaded && probe.version !== CONTENT_VERSION && probe.cleanup) {
    await injectCollect(tab.id)
    probe = await probeCollect(tab.id)
    if (probeCurrent(probe)) return { ok: true, action: 'injected' }
  }
  if (!probe || !probe.loaded) {
    await injectCollect(tab.id)
    probe = await probeCollect(tab.id)
    if (probeCurrent(probe)) return { ok: true, action: 'injected' }
  }
  await markReloaded(tab.id, tab.url || '')
  try {
    await chrome.tabs.reload(tab.id)
    return { ok: true, action: 'reloaded' }
  } catch (e) {
    return { ok: false, error: e?.message || '刷新页面失败' }
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    const name = info.menuItemId === MENU_IMAGE ? await saveImage(info, tab) : await savePage(tab)
    notify(true, '已保存：' + name)
  } catch (e) {
    notify(false, e?.message || String(e))
  }
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ;(async () => {
    try {
      if (msg?.type === 'save-page') {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
        sendResponse({ ok: true, name: await savePage(tab) })
      } else if (msg?.type === 'status') {
        sendResponse({ ok: true, data: await api('/api/v1/ping') })
      } else if (msg?.type === 'collect-folders') {
        const ctx = await api('/api/v1/context')
        let rootId = msg.rootId ?? ctx.rootId
        if (!ctx.roots.some((r) => String(r.id) === String(rootId))) rootId = ctx.rootId
        const data = await api('/api/v1/folders?rootId=' + encodeURIComponent(rootId))
        sendResponse({ ok: true, root: data.root, folders: data.folders, context: ctx })
      } else if (msg?.type === 'create-folder') {
        const data = await apiRaw('/api/v1/folder/create', {
          rootId: msg.rootId,
          parentRel: msg.parentRel || '',
          name: msg.name,
        })
        if (!data.ok) throw new Error(data.error || '新建文件夹失败')
        sendResponse({ ok: true, folder: data.folder })
      } else if (msg?.type === 'save-panel') {
        const body = {
          kind: 'image',
          src: msg.src,
          dataUrl: msg.dataUrl,
          url: msg.url,
          title: msg.title,
          rootId: msg.rootId,
          rel: msg.rel || '',
          force: !!msg.force,
          overwrite: !!msg.overwrite,
        }
        const data = await apiRaw('/api/v1/save', body)
        if (data.duplicate) {
          sendResponse({
            ok: false, duplicate: true, matches: data.matches || [],
            error: data.error || '已存在相同图片，未保存',
            rootId: data.rootId, rel: data.rel,
          })
          return
        }
        if (!data.ok) throw new Error(data.error || '保存失败')
        if (msg.rootId != null) await chrome.storage.local.set({ rootId: Number(msg.rootId), rel: msg.rel || '' })
        sendResponse({ ok: true, name: data.saved?.[0]?.name || '已保存', overwritten: data.saved?.[0]?.overwritten || 0 })
      } else if (msg?.type === 'collect-status') {
        sendResponse(await collectStatus())
      } else if (msg?.type === 'collect-repair') {
        sendResponse(await repairCollect(msg.tabId))
      } else {
        sendResponse({ ok: false, error: 'unknown message' })
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) })
    }
  })()
  return true
})
