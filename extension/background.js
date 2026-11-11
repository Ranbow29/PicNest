// PicNest 图巢采集 — MV3 后台
// 本地服务：PicNest 主进程 127.0.0.1:41600（无云端上传）
// 图片由 PicNest 服务端下载（保留浏览器登录态无法传递，遇到防盗链时回退失败提示）
const API = 'http://127.0.0.1:41600'
const MENU_IMAGE = 'picnest-save-image'
const MENU_PAGE = 'picnest-save-page'

function setupMenus() {
  try {
    chrome.contextMenus.removeAll(() => {
      if (chrome.runtime.lastError) {}
      chrome.contextMenus.create({ id: MENU_IMAGE, title: '保存至图巢', contexts: ['image', 'video', 'link'] }, () => {
        if (chrome.runtime.lastError) {}
      })
      chrome.contextMenus.create({ id: MENU_PAGE, title: '保存页面截图到图巢', contexts: ['page'] }, () => {
        if (chrome.runtime.lastError) {}
      })
    })
  } catch {}
}

chrome.runtime.onInstalled.addListener(setupMenus)

/* 标签页恢复（Edge 睡眠标签 / bfcache / 扩展重载）时浏览器不会自动重新注入 content script。
   这里在标签激活、URL 更新、窗口聚焦、扩展启动时主动探测：
   - 页面没脚本 → 注入 content.js
   - 旧脚本带 __picnestHoldCollectCleanup → 注入新脚本原地清理并重建
   - 更老的脚本（无 cleanup）/ 扩展更新后失去 runtime 的孤立脚本 / document 监听器失效
     → 只在 Pinterest 标签自动刷新一次（chrome.storage.session 记标记防循环），其它站点走 popup「修复本页」。
   content.js 在监听器全部注册完成之后才置 Loaded，并提供健康事件，部分初始化也能被发现。 */
const CONTENT_VERSION = '0.3.1'
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
var isPinterest = isPinterestUrl
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

/* 原地重建：调用旧实例 cleanup 移除监听器 → 清掉隔离世界全局 → 注入新 content.js。
   适用于旧版本（带 cleanup）/ 扩展更新后 runtime 失效 / document 监听器被清掉但全局还在的页面。
   比重载整页温和，且能修复“healthy=false 但 version 已是当前版”的死监听器状态。 */
async function rebuildCollect(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        let cleaned = false
        try {
          if (typeof window.__picnestHoldCollectCleanup === 'function') {
            window.__picnestHoldCollectCleanup()
            cleaned = true
          }
        } catch { cleaned = false }
        if (!cleaned) return false
        for (const k of ['__picnestHoldCollectLoaded', '__picnestHoldCollectVersion', '__picnestHoldCollectHealth', '__picnestHoldCollectCleanup']) {
          try { delete window[k] } catch { /* 静默 */ }
        }
        return true
      },
    })
    if (!r?.result) return false
    if (!(await injectCollect(tabId))) return false
    return probeCurrent(await probeCollect(tabId))
  } catch {
    return false
  }
}

async function handleStale(tab, probe, allowReload) {
  /* 旧版（带 cleanup）/ 孤立脚本 / 监听器失效：优先原地重建，不刷新页面 */
  if (probe?.loaded && probe.cleanup) {
    if (await rebuildCollect(tab.id)) return true
  }
  /* 无 cleanup 的极旧脚本：只在 Pinterest 页自动刷新一次；其它站点交给 popup */
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

function sanitizeToken(token) {
  if (!token || typeof token !== 'string') return ''
  return token.replace(/[^a-fA-F0-9]/g, '').trim()
}

async function apiRaw(path, body, method) {
  const init = { method: method || (body ? 'POST' : 'GET'), headers: {} }
  try {
    const s = await chrome.storage.local.get(['picnestToken'])
    const token = sanitizeToken(s.picnestToken)
    if (token && token.length === 32) {
      init.headers['X-PicNest-Token'] = token
    } else if (s.picnestToken) {
      // 存储了不合法的脏数据（如包含非 ISO-8859-1 的遮罩圆点 • 或截断字符），清除存储防死锁
      await chrome.storage.local.remove(['picnestToken'])
    }
  } catch (e) {}
  if (body) {
    init.headers['Content-Type'] = 'application/json'
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
  // 采集结果（成功/失败/HTTP等）已全面由页面内右下角单色优雅读条 Toast 接管，彻底屏蔽系统气泡弹窗
  if (!message || message.includes('已保存') || message.includes('采集失败') || message.includes('Assignment') || message.includes('HTTP')) return
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon128.png'),
      title: 'PicNest 图巢',
      message: String(message || '').slice(0, 180),
    })
  } catch { /* 静默 */ }
}

function createTabToast(tabId, initial) {
  const toastId = 'toast_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
  let sentStart = false
  const send = (type, data) => {
    if (!tabId) return
    chrome.tabs.sendMessage(tabId, { type, toastId, ...data }).catch(() => {})
  }
  return {
    toastId,
    start() {
      sentStart = true
      send('toast-start', initial)
    },
    updateStatus(status) {
      if (!sentStart) this.start()
      send('toast-status', { status })
    },
    done(name, extra) {
      send('toast-done', { name, extra })
    },
    error(err) {
      send('toast-error', { error: String(err?.message || err) })
    }
  }
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

/* 规范化 Pinterest 媒体 URL：保留其真实路径，严禁暴力替换为不存在的 S3 路径 */
function normalizePinterestVideoUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return ''
  const u = rawUrl.trim()
  if (!u.includes('pinimg.com')) return u
  // 若已是明确的 .mp4 静态直链，原样返回（严禁拼入不存在的 /mc/）
  if (/\.mp4(\?.*)?$/i.test(u)) return u
  // 若包含视频目录且为切片/manifest，尝试移除切片后缀
  if (u.includes('/videos/')) {
    return u.replace(/(_\d+[wp]|_\d+p)?\.(cmfv|cmfa|m3u8|ts|mpd).*$/i, '.mp4')
  }
  return u
}

/* 借由标签页环境拉取媒体流（原生携带 Pinterest 同域凭据与合规 Referer） */
async function downloadMediaViaTab(tabId, url) {
  if (!tabId || !url || !/^https?:\/\//i.test(url)) return null
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (mediaUrl) => {
        try {
          const res = await fetch(mediaUrl, { credentials: 'omit' })
          if (!res.ok) return { ok: false, status: res.status }
          const blob = await res.blob()
          const dataUrl = await new Promise((resolve, reject) => {
            const fr = new FileReader()
            fr.onload = () => resolve(fr.result)
            fr.onerror = reject
            fr.readAsDataURL(blob)
          })
          return { ok: true, dataUrl, size: blob.size, contentType: blob.type || 'video/mp4' }
        } catch (e) {
          return { ok: false, error: String(e?.message || e) }
        }
      },
      args: [url],
    })
    if (r?.result?.ok && r.result.dataUrl) return r.result
  } catch (e) {
    console.warn('downloadMediaViaTab error:', e)
  }
  return null
}

async function downloadMediaInBrowser(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null
  const fixedUrl = normalizePinterestVideoUrl(url) || url
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 60000)
  try {
    const headers = {}
    if (fixedUrl.includes('pinimg.com')) {
      headers['Accept'] = 'video/mp4,video/*;q=0.9,*/*;q=0.8'
    }
    const res = await fetch(fixedUrl, { signal: ctl.signal, headers, credentials: 'omit' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const contentType = res.headers.get('content-type') || 'video/mp4'
    const blob = await res.blob()
    let dataUrl = ''
    if (typeof FileReader !== 'undefined') {
      dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(fr.result)
        fr.onerror = reject
        fr.readAsDataURL(blob)
      })
    } else {
      const ab = await blob.arrayBuffer()
      const bytes = new Uint8Array(ab)
      let binary = ''
      const chunkSize = 0x8000
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize))
      }
      dataUrl = `data:${contentType};base64,${btoa(binary)}`
    }
    return {
      dataUrl,
      size: blob.size,
      contentType,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function resolveVideoSource({ src, pinUrl, url, tabId }) {
  let finalSrc = normalizePinterestVideoUrl(src || '')
  let resolvedPinUrl = pinUrl || url || ''

  // 1. 如果已是有效 MP4 直链，直接返回
  if (/^https?:\/\//i.test(finalSrc) && /\.mp4(\?.*)?$/i.test(finalSrc)) {
    return { ok: true, src: finalSrc }
  }

  // 2. 如果已是其它有效 http(s) 视频直链
  if (/^https?:\/\//i.test(finalSrc) && /\.(webm|mov|mkv|avi|flv|f4v)(\?.*)?$/i.test(finalSrc)) {
    return { ok: true, src: finalSrc }
  }

  // 3. 针对 tabId 页面上下文进行深度嗅探（Performance Resource Timeline、React Fiber、__PWS_DATA__）
  if (tabId && typeof chrome.scripting?.executeScript === 'function') {
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          try {
            // 3a. Performance Resource Timeline (直接取浏览器已在请求的真实 MP4)
            const entries = performance.getEntriesByType('resource') || []
            for (let i = entries.length - 1; i >= 0; i--) {
              const u = entries[i].name || ''
              if (!u.includes('pinimg.com')) continue
              if (/\.mp4(\?.*)?$/i.test(u)) return u
            }

            // 3b. 递归探测对象树中的真实 video_list（只挑真实存在的 .mp4）
            const scanObj = (obj, depth = 0) => {
              if (!obj || typeof obj !== 'object' || depth > 8) return ''
              if (obj.video_list && typeof obj.video_list === 'object') {
                const vl = obj.video_list
                for (const k of ['V_720P', 'V_1080P', 'V_EXP720P', 'V_EXPMP4']) {
                  if (vl[k]?.url && /\.mp4(\?.*)?$/i.test(vl[k].url)) return vl[k].url
                }
                for (const v of Object.values(vl)) {
                  if (v?.url && /\.mp4(\?.*)?$/i.test(v.url)) return v.url
                }
              }
              if (typeof obj.url === 'string' && obj.url.includes('pinimg.com/videos/') && /\.mp4(\?.*)?$/i.test(obj.url)) {
                return obj.url
              }
              for (const k of Object.keys(obj)) {
                if (k === 'parent' || k === 'return' || k === '_owner' || k === 'stateNode') continue
                if (typeof obj[k] === 'object') {
                  const res = scanObj(obj[k], depth + 1)
                  if (res) return res
                }
              }
              return ''
            }

            // 3c. 检查 React Fiber 树
            for (const v of document.querySelectorAll('video')) {
              let cur = v
              let depth = 0
              while (cur && cur !== document.body && depth < 10) {
                for (const key of Object.keys(cur)) {
                  if (key.startsWith('__reactFiber$') || key.startsWith('__reactProps$') || key.startsWith('__reactInternalInstance$')) {
                    try {
                      const u = scanObj(cur[key], 0)
                      if (u) return u
                    } catch {}
                  }
                }
                cur = cur.parentElement
                depth++
              }
            }

            // 3d. 检查页面中所有 script JSON
            const scripts = Array.from(document.querySelectorAll('script[type="application/json"], script#__PWS_DATA__'))
            for (const s of scripts) {
              const txt = s.textContent || ''
              if (!txt.includes('video_list') && !txt.includes('pinimg.com')) continue
              try {
                const data = JSON.parse(txt)
                const found = scanObj(data)
                if (found) return found
              } catch {}
            }
          } catch {}
          return ''
        },
      })
      if (r?.result && /\.mp4(\?.*)?$/i.test(r.result)) {
        return { ok: true, src: r.result }
      }
    } catch (e) {
      console.warn('executeScript probe error:', e)
    }
  }

  // 4. PinResource 接口深度查询
  const pinMatch = resolvedPinUrl.match(/\/pin\/(\d+)/) || finalSrc.match(/\/pin\/(\d+)/)
  const pinId = pinMatch ? pinMatch[1] : ''
  if (pinId) {
    try {
      const apiUrl = `https://www.pinterest.com/resource/PinResource/get/?source_url=%2Fpin%2F${pinId}%2F&data=%7B%22options%22%3A%7B%22isPrefetch%22%3Afalse%2C%22id%22%3A%22${pinId}%22%2C%22field_set_key%22%3A%22auth_web_main_pin%22%2C%22is_landing_page%22%3Afalse%2C%22allowStale%22%3Afalse%2C%22no_fetch_context_on_resource%22%3Afalse%7D%2C%22context%22%3A%7B%7D%7D`
      const r = await fetch(apiUrl, {
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json',
          'x-pinterest-pws-handler': 'www/pin/[id].js',
        },
        signal: AbortSignal.timeout(8000),
      })
      if (r.ok) {
        const j = await r.json()
        const data = j?.resource_response?.data
        if (data) {
          const vl = data.videos?.video_list
          if (vl) {
            for (const k of ['V_720P', 'V_1080P', 'V_EXP720P', 'V_EXPMP4']) {
              if (vl[k]?.url && /\.mp4(\?.*)?$/i.test(vl[k].url)) return { ok: true, src: vl[k].url, pinId }
            }
            for (const v of Object.values(vl)) {
              if (v?.url && /\.mp4(\?.*)?$/i.test(v.url)) return { ok: true, src: v.url, pinId }
            }
          }
          const hlsUrl = data.story_pin_data?.pages?.[0]?.blocks?.[0]?.video?.video_list?.V_HLSV3_MOBILE?.url ||
                         vl?.V_HLS?.url || vl?.V_HLSV4?.url || ''
          if (hlsUrl) {
            if (hlsUrl.includes('iht/hls')) {
              const cand = hlsUrl.replace('iht/hls', 'iht/expMp4').replace('.m3u8', '_720w.mp4')
              return { ok: true, src: cand, pinId }
            }
            const cand = hlsUrl.replace('hls', '720p').replace('.m3u8', '.mp4')
            return { ok: true, src: cand, pinId }
          }
        }
      }
    } catch (e) {
      console.warn('PinResource fetch error:', e)
    }
  }

  return { ok: false, src: finalSrc }
}

async function saveImage(info, tab, toast) {
  let src = info.srcUrl || ''
  let title = tab?.title || ''
  let isVideo = info.mediaType === 'video' || /\.(mp4|webm|mov|mkv|avi|flv|f4v)(\?.*)?$/i.test(src)
  let pinUrl = ''
  let poster = ''
  let dataUrl = ''

  toast?.updateStatus(isVideo ? '正在探测视频地址…' : '正在获取图片信息…')

  if (tab?.id) {
    if (typeof chrome.tabs?.sendMessage === 'function') {
      try {
        const res = await chrome.tabs.sendMessage(tab.id, {
          type: 'get-contextmenu-media',
          linkUrl: info.linkUrl || '',
        })
        if (res?.ok) {
          if (res.src) src = res.src
          if (res.title) title = res.title
          if (res.isVideo) isVideo = true
          if (res.pinUrl) pinUrl = res.pinUrl
          if (res.poster) poster = res.poster
          if (res.dataUrl) dataUrl = res.dataUrl
        }
      } catch { /* content script 未响应 */ }
    }
  }

  if (!src && info.linkUrl && /\.(jpe?g|png|webp|gif|avif|bmp|svg|mp4|webm)(\?.*)?$/i.test(info.linkUrl)) {
    src = info.linkUrl
    if (/\.(mp4|webm)(\?.*)?$/i.test(src)) isVideo = true
  }

  if (!src && tab?.id && info.linkUrl && typeof chrome.scripting?.executeScript === 'function') {
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (linkUrl) => {
          try {
            const urlObj = new URL(linkUrl)
            const pathname = urlObj.pathname
            const links = Array.from(document.querySelectorAll('a'))
            const targetA = links.find((el) => el.href === linkUrl || (pathname.length > 2 && el.href && el.href.includes(pathname)))
            if (targetA) {
              const video = targetA.querySelector('video') || targetA.parentElement?.querySelector('video') || targetA.closest('[data-test-id="pin"]')?.querySelector('video')
              if (video) {
                return { isVideo: true, src: (video.currentSrc || video.src || '').trim(), title: (video.title || document.title || '').trim() }
              }
              const img = targetA.querySelector('img') || targetA.parentElement?.querySelector('img') || targetA.closest('[data-test-id="pin"]')?.querySelector('img')
              if (img) return { isVideo: false, src: (img.currentSrc || img.src || '').trim(), title: (img.alt || img.title || document.title || '').trim() }
            }
          } catch {}
          return null
        },
        args: [info.linkUrl],
      })
      if (r?.result?.src) {
        src = r.result.src
        if (r.result.title) title = r.result.title
        if (r.result.isVideo) isVideo = true
      }
    } catch { /* 静默 */ }
  }

  if (isVideo || (src && src.startsWith('blob:')) || isPinterestUrl(tab?.url)) {
    toast?.updateStatus('正在解析视频原片…')
    const res = await resolveVideoSource({
      src,
      pinUrl: pinUrl || info.linkUrl || info.pageUrl || tab?.url || '',
      url: info.pageUrl || tab?.url || '',
      tabId: tab?.id,
    })
    if (res?.ok && res.src) {
      src = res.src
      isVideo = true
    }
  }

  if (!src && !dataUrl) throw new Error(isVideo ? '未能解析视频地址' : '未能识别图片地址')

  let payload = {}
  if (isVideo && src && /^https?:\/\//i.test(src)) {
    toast?.updateStatus('正在下载视频流…')
    let dl = null
    if (tab?.id) {
      dl = await downloadMediaViaTab(tab.id, src)
    }
    if (!dl?.dataUrl) {
      try {
        dl = await downloadMediaInBrowser(src)
      } catch (e) {
        console.warn('downloadMediaInBrowser error:', e)
      }
    }
    if (dl?.dataUrl) {
      payload = {
        kind: 'video',
        dataUrl: dl.dataUrl,
        poster: poster || dataUrl,
      }
    } else if (dataUrl || poster) {
      // 优雅降级：若网络或 CDN 拦截未能下载独立 mp4，使用高质量视频截帧入库，绝不抛 403 崩溃
      payload = {
        kind: 'image',
        dataUrl: dataUrl || poster,
      }
      toast?.updateStatus('已保存高清视频画面（流媒体切片）')
    } else {
      payload = {
        kind: 'video',
        src,
        poster: poster || dataUrl,
      }
    }
  } else if (src.startsWith('data:')) {
    payload = { kind: isVideo ? 'video' : 'image', dataUrl: src }
  } else if (src.startsWith('blob:')) {
    const du = dataUrl || await blobToDataUrl(src, tab.id, info.frameId)
    if (!du) throw new Error(isVideo ? '视频抓取失败' : 'blob 图片读取失败')
    payload = { kind: isVideo ? 'video' : 'image', dataUrl: du }
  } else {
    payload = {
      kind: isVideo ? 'video' : 'image',
      src,
      poster: poster || dataUrl,
      dataUrl: isVideo ? '' : dataUrl,
    }
  }

  toast?.updateStatus('正在存入图巢…')
  const t = await getTarget()
  const r = await api('/api/v1/save', {
    kind: isVideo ? 'video' : 'image',
    title,
    url: pinUrl || info.pageUrl || tab?.url || '',
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
  /* 有 cleanup 的实例（包括当前版本但监听器失效）：原地重建，不刷新页面 */
  if (probe && probe.loaded && probe.cleanup) {
    if (await rebuildCollect(tab.id)) return { ok: true, action: 'rebuilt' }
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
  const t = await getTarget().catch(() => ({ rel: '' }))
  const folderName = t?.rel ? t.rel : '未分类'
  const toast = createTabToast(tab?.id, { thumb: info.srcUrl || '', title: tab?.title || '', folderName })
  toast.start()
  try {
    const name = info.menuItemId === MENU_IMAGE ? await saveImage(info, tab, toast) : await savePage(tab)
    toast.done(name)
  } catch (e) {
    const errMsg = e?.message || String(e)
    toast.error(errMsg)
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
      } else if (msg?.type === 'save-token') {
        const token = sanitizeToken(msg.token)
        if (!token || token.length !== 32) throw new Error('密钥格式错误：请输入有效的 32 位十六进制密钥（请点击图巢顶栏设置中的「复制密钥」按钮，切勿手工划选中间带圆点的遮罩文本）')
        await chrome.storage.local.set({ picnestToken: token })
        sendResponse({ ok: true })
      } else if (msg?.type === 'create-folder') {
        const data = await apiRaw('/api/v1/folder/create', {
          rootId: msg.rootId,
          parentRel: msg.parentRel || '',
          name: msg.name,
        })
        if (!data.ok) throw new Error(data.error || '新建文件夹失败')
        sendResponse({ ok: true, folder: data.folder })
      } else if (msg?.type === 'save-panel') {
        let src = msg.src || ''
        let dataUrl = msg.dataUrl || ''
        let poster = msg.poster || ''
        let kind = msg.kind || 'image'

        // 针对视频，利用多级逆向解析器换取真实的 MP4 原始直链并下载完整流
        if (kind === 'video' || isPinterestUrl(msg.url || sender?.tab?.url)) {
          let videoSrc = src
          let dl = null
          if (!videoSrc || !/\.mp4(\?.*)?$/i.test(videoSrc)) {
            const res = await resolveVideoSource({
              src: videoSrc,
              pinUrl: msg.pinUrl || msg.url || '',
              url: msg.url || '',
              tabId: sender?.tab?.id,
            })
            if (res?.ok && res.src) videoSrc = res.src
          }
          if (videoSrc && /^https?:\/\//i.test(videoSrc) && /\.mp4(\?.*)?$/i.test(videoSrc)) {
            kind = 'video'
            src = videoSrc
            poster = poster || dataUrl
            // 优先在当前标签页内借同域凭据下载为 Base64
            if (sender?.tab?.id) {
              dl = await downloadMediaViaTab(sender.tab.id, videoSrc)
            }
            if (!dl?.dataUrl) {
              try {
                dl = await downloadMediaInBrowser(videoSrc)
              } catch (dlErr) {
                console.warn('Browser download failed:', dlErr)
              }
            }
            if (dl?.dataUrl) {
              dataUrl = dl.dataUrl
              src = '' // 已转为完整 MP4 dataUrl，走本地无障碍写入
            }
          }
          // 优雅降级：若网络未拉取到独立 MP4（某些流媒体切片无单体 mp4 文件），自动采用高清 Canvas 视频截帧
          if (kind === 'video' && !dataUrl && (!src || src.startsWith('blob:'))) {
            if (msg.frameDataUrl || poster) {
              kind = 'image'
              dataUrl = msg.frameDataUrl || poster
              src = ''
            }
          }
        }

        const body = {
          kind,
          src: src.startsWith('blob:') ? '' : src,
          poster,
          dataUrl,
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
