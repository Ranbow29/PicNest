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
   这里在标签激活、URL 更新、窗口聚焦、扩展启动时主动探测并补注入；content.js 在监听器全部
   注册成功后才置 __picnestHoldCollectLoaded，部分初始化失败的页面也能被补一次。 */
async function contentReady(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!(window.__picnestHoldCollectLoaded && window.__picnestHoldCollectVersion),
    })
    return !!r?.result
  } catch {
    return false
  }
}

async function ensureCollectScript(tab, attempt = 0) {
  let t = tab
  try {
    if (!t?.id) return
    if (!/^https?:\/\//i.test(t.url || '')) t = await chrome.tabs.get(t.id)
  } catch {
    return
  }
  if (!t?.id || !/^https?:\/\//i.test(t.url || '')) return
  if (await contentReady(t.id)) return
  try {
    await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] })
  } catch {
    /* 睡眠标签还原/页面正在导航：短暂延迟再试两次 */
    if (attempt < 2) {
      setTimeout(() => {
        chrome.tabs.get(t.id).then((x) => ensureCollectScript(x, attempt + 1)).catch(() => {})
      }, attempt === 0 ? 350 : 1200)
    }
  }
}

async function ensureActiveTab() {
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (t) await ensureCollectScript(t)
  } catch { /* no active tab */ }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try { await ensureCollectScript(await chrome.tabs.get(tabId)) } catch { /* closed */ }
})
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url) void ensureCollectScript(tab)
})
chrome.tabs.onHighlighted.addListener(({ tabIds }) => {
  const id = tabIds?.[0]
  if (id != null) chrome.tabs.get(id).then((t) => ensureCollectScript(t)).catch(() => {})
})
chrome.windows.onFocusChanged.addListener(() => { void ensureActiveTab() })

async function ensurePinterestTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://*.pinterest.com/*', 'https://pinterest.com/*'] })
    for (const tab of tabs) await ensureCollectScript(tab)
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
      } else {
        sendResponse({ ok: false, error: 'unknown message' })
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) })
    }
  })()
  return true
})
