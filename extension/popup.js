// PicNest 图巢采集 — popup：连接状态 / 目标根与文件夹 / 保存当前页面截图
const API = 'http://127.0.0.1:41600'
const $ = (s) => document.querySelector(s)

const elStatus = $('#status')
const elRoot = $('#root')
const elFolder = $('#folder')
const elSave = $('#save')
const elHold = $('#hold')
const elMsg = $('#msg')
const elPage = $('#page-state')
const elRepair = $('#repair')

const PAGE_TEXT = {
  current: ['已就绪', 'ok'],
  missing: ['未注入', 'warn'],
  stale: ['旧版脚本', 'warn'],
  orphan: ['需刷新页面', 'warn'],
  unhealthy: ['监听失效', 'warn'],
  unavailable: ['页面未加载完成', 'idle'],
  unsupported: ['此页面不支持', 'idle'],
}
const REPAIRABLE = ['missing', 'stale', 'orphan', 'unhealthy']
let repairTabId = null

function renderPageState(res) {
  if (!res?.ok) {
    elPage.className = 'pstate idle'
    elPage.textContent = res?.error || '检测失败'
    elRepair.hidden = true
    return
  }
  repairTabId = res.tabId
  const [text, cls] = PAGE_TEXT[res.state] || ['未知状态', 'idle']
  let label = text
  if (res.state === 'current') label = `已就绪 v${res.contentVersion}`
  else if (res.state === 'stale' && res.version) label = `${text} v${res.version}`
  else if (res.state === 'missing') label = `未注入 v${res.contentVersion}`
  elPage.className = 'pstate ' + cls
  elPage.textContent = label
  elPage.title = res.url || ''
  elRepair.hidden = !REPAIRABLE.includes(res.state)
}
function refreshPageState() {
  elPage.className = 'pstate idle'
  elPage.textContent = '检测中…'
  elRepair.hidden = true
  chrome.runtime.sendMessage({ type: 'collect-status' }, renderPageState)
}

function setStatus(state, text) {
  elStatus.className = 'status ' + state
  elStatus.querySelector('span').textContent = text
}
function msg(text, err) {
  elMsg.textContent = text || ''
  elMsg.className = 'msg' + (err ? ' err' : '')
}
async function api(path) {
  const s = await chrome.storage.local.get(['picnestToken'])
  const headers = {}
  if (s.picnestToken) headers['X-PicNest-Token'] = s.picnestToken
  const res = await fetch(API + path, { headers })
  if (res.status === 401) throw new Error('TOKEN_REQUIRED')
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status))
  return data
}
function flatten(nodes, depth = 0, out = []) {
  for (const n of nodes || []) {
    out.push({ id: n.id, name: n.name, depth })
    flatten(n.children, depth + 1, out)
  }
  return out
}
async function loadFolders(rootId, selectedRel) {
  elFolder.disabled = true
  elFolder.innerHTML = '<option value="">根目录（库根）</option>'
  try {
    const data = await api('/api/v1/folders?rootId=' + encodeURIComponent(rootId))
    for (const f of flatten(data.folders)) {
      const opt = document.createElement('option')
      opt.value = f.id
      opt.textContent = '　'.repeat(f.depth) + f.name
      elFolder.appendChild(opt)
    }
    const hit = flatten(data.folders).some((f) => f.id === selectedRel)
    elFolder.value = hit ? selectedRel : ''
    elFolder.disabled = false
  } catch (e) {
    msg('读取文件夹失败：' + e.message, true)
  }
}
async function init() {
  refreshPageState()
  try {
    await api('/api/v1/ping')
    setStatus('on', '已连接')
  } catch (e) {
    setStatus('off', '未连接')
    msg('连不上 PicNest（127.0.0.1:41600）。先启动图巢，再点开此面板。', true)
    return
  }
  try {
    const s = await chrome.storage.local.get(['picnestToken'])
    if (s.picnestToken) elTokenInput.value = s.picnestToken
    const ctx = await api('/api/v1/context')
    elTokenBox.style.display = 'none'
    if (elUnpair) elUnpair.style.display = 'inline-block' 
    const saved = await chrome.storage.local.get(['rootId', 'rel'])
    elRoot.innerHTML = ''
    for (const r of ctx.roots) {
      const opt = document.createElement('option')
      opt.value = String(r.id)
      opt.textContent = r.name
      elRoot.appendChild(opt)
    }
    const rootId = saved.rootId != null && ctx.roots.some((r) => String(r.id) === String(saved.rootId))
      ? String(saved.rootId) : String(ctx.rootId)
    elRoot.value = rootId
    elRoot.disabled = false
    await loadFolders(rootId, saved.rel || '')
    elSave.disabled = false
  } catch (e) {
    if (e.message === 'TOKEN_REQUIRED') {
      setStatus('off', '需配对密钥')
      elTokenBox.style.display = 'flex'
      if (elUnpair) elUnpair.style.display = 'none'
      msg('请在图巢「设置」中点击「复制密钥」，粘贴到上方完成配对。', true)
    } else {
      msg('初始化失败：' + e.message, true)
    }
  }
}

elRoot.addEventListener('change', async () => {  const rootId = elRoot.value
  await chrome.storage.local.set({ rootId: Number(rootId), rel: '' })
  await loadFolders(rootId, '')
  msg('已切换根文件')
})
elFolder.addEventListener('change', async () => {
  await chrome.storage.local.set({ rel: elFolder.value })
  msg(elFolder.value ? '目标文件夹已更新' : '目标：库根')
})
elSave.addEventListener('click', () => {
  elSave.disabled = true
  msg('正在保存…')
  chrome.runtime.sendMessage({ type: 'save-page' }, (res) => {
    elSave.disabled = false
    if (res?.ok) msg('已保存：' + res.name)
    else msg('保存失败：' + (res?.error || '未知错误'), true)
  })
})

chrome.storage.local.get({ holdCollect: true }, (s) => {
  elHold.checked = s.holdCollect !== false
})
elHold.addEventListener('change', () => {
  chrome.storage.local.set({ holdCollect: elHold.checked })
})

elRepair.addEventListener('click', () => {
  if (repairTabId == null) return
  elRepair.disabled = true
  msg('正在修复本页…')
  chrome.runtime.sendMessage({ type: 'collect-repair', tabId: repairTabId }, (res) => {
    elRepair.disabled = false
    if (!res?.ok) { msg('修复失败：' + (res?.error || '未知错误'), true); return }
    if (res.action === 'reloaded') {
      msg('页面已刷新，采集脚本将重新注入')
      setTimeout(refreshPageState, 1500)
    } else if (res.action === 'rebuilt') {
      msg('已原地重建采集脚本')
      setTimeout(refreshPageState, 400)
    } else if (res.action === 'injected') {
      msg('已重新注入采集脚本')
      setTimeout(refreshPageState, 400)
    } else {
      msg('采集脚本已是最新')
      setTimeout(refreshPageState, 150)
    }
  })
})

init()
