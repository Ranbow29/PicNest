// PicNest 图巢采集 — 网页内按住采集
// 在网页图片上左键按住 → 光标处环形进度 → 弹出双栏面板（左：未分类/库根；右：全部文件夹）
// 拖到目标松开即保存；松开在面板空白处则面板停留，可点击/滚动选择；Esc / 点外部取消。
(() => {
  if (window.__picnestHoldCollectLoaded) return
  window.__picnestHoldCollectLoaded = true

  const HOLD_MS = 380
  const RING_DELAY = 120
  const MOVE_TOL = 6
  const HOST_ID = 'picnest-collect-host'

  let enabled = true
  let session = null
  let last = { rootId: null, rel: '' }

  try {
    chrome.storage.local.get({ holdCollect: true, rootId: null, rel: '' }, (s) => {
      enabled = s.holdCollect !== false
      last = { rootId: s.rootId ?? null, rel: s.rel ?? '' }
    })
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.holdCollect) enabled = changes.holdCollect.newValue !== false
      if (changes.rootId) last.rootId = changes.rootId.newValue ?? null
      if (changes.rel) last.rel = changes.rel.newValue ?? ''
      if (!enabled) closePanel()
    })
  } catch { /* 扩展上下文失效时不影响页面 */ }

  const FOLDER_ICO = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M1.8 4.3h4l1.4 1.6h7v6.3H1.8z"/></svg>'
  const NEST_ICO = '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 17c0 6 5 10 11 10s11-4 11-10"/><path d="M7 15c1-3 4-5 9-5s8 2 9 5"/><ellipse cx="16" cy="12" rx="4.2" ry="5" fill="currentColor" stroke="none" opacity=".85"/></svg>'

  const CSS = `
    :host { all: initial; }
    .wrap { position: fixed; inset: 0; pointer-events: none;
      font-family: 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif; }
    .ring { position: fixed; width: 40px; height: 40px; margin: -20px 0 0 -20px;
      pointer-events: none; filter: drop-shadow(0 2px 8px rgba(0,0,0,.18)); }
    .ring svg { width: 40px; height: 40px; transform: rotate(-90deg); }
    .ring circle { fill: none; stroke-width: 3.2; }
    .ring .bg { stroke: rgba(0,0,0,.18); }
    .ring .fg { stroke: #b4884b; stroke-linecap: round; stroke-dasharray: 94.25;
      stroke-dashoffset: 94.25; animation: ringfill ${HOLD_MS - RING_DELAY}ms linear forwards; }
    @keyframes ringfill { to { stroke-dashoffset: 0; } }
    .panel { position: fixed; pointer-events: auto; display: flex; flex-direction: column;
      width: 440px; max-width: calc(100vw - 16px); max-height: 70vh;
      background: #fbf8f2; color: #2c2a26; border: 1px solid rgba(60,50,30,.14);
      border-radius: 16px; overflow: hidden; font-size: 12.5px; line-height: 1.45;
      box-shadow: 0 2px 6px rgba(60,50,30,.10), 0 18px 52px rgba(60,50,30,.22);
      animation: pop .16s cubic-bezier(.2,1.2,.3,1); }
    @keyframes pop { from { opacity: 0; transform: translateY(6px) scale(.97); } to { opacity: 1; transform: none; } }
    .head { display: flex; align-items: baseline; gap: 6px; padding: 10px 14px 8px;
      border-bottom: 1px solid rgba(60,50,30,.08); }
    .head b { font-size: 13px; }
    .head .sub { margin-left: auto; font-size: 10.5px; color: #8a8170; }
    .body { display: flex; gap: 8px; padding: 10px; min-height: 0; flex: 1; }
    .uncat { width: 138px; flex: none; border: 1px dashed rgba(60,50,30,.22); border-radius: 12px;
      background: linear-gradient(160deg, rgba(180,136,75,.10), rgba(180,136,75,.03));
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
      cursor: pointer; color: #6f6a60; text-align: center; padding: 12px 8px; }
    .uncat svg { width: 30px; height: 30px; color: #b4884b; }
    .uncat b { color: #2c2a26; font-size: 12.5px; }
    .uncat span { font-size: 10.5px; }
    .uncat:hover, .uncat.on { border-color: #b4884b; background: rgba(180,136,75,.14); }
    .listwrap { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .cap { font-size: 10.5px; color: #8a8170; padding: 0 4px 4px; letter-spacing: .5px; }
    .list { overflow-y: auto; min-height: 80px; max-height: calc(70vh - 132px); padding-right: 2px; }
    .row { display: flex; align-items: center; gap: 7px; padding: 6px 8px; border-radius: 8px;
      cursor: pointer; white-space: nowrap; overflow: hidden; }
    .row svg { width: 14px; height: 14px; flex: none; color: #b4884b; opacity: .9; }
    .row span { overflow: hidden; text-overflow: ellipsis; }
    .row:hover, .row.on { background: rgba(180,136,75,.14); color: #8a5f24; }
    .row.last { box-shadow: inset 0 0 0 1px rgba(180,136,75,.35); }
    .loading, .empty { padding: 10px 8px; font-size: 11px; color: #8a8170; }
    .foot { display: flex; align-items: center; gap: 8px; padding: 7px 14px 9px;
      border-top: 1px solid rgba(60,50,30,.08); color: #8a8170; font-size: 10.5px; }
    .state { margin-left: auto; color: #4f7d5e; }
    .state.err { color: #b4463b; }
    .state.saving { color: #8a8170; }
    @media (prefers-color-scheme: dark) {
      .panel { background: #242428; color: #e7e7e7; border-color: rgba(255,255,255,.12);
        box-shadow: 0 2px 6px rgba(0,0,0,.4), 0 18px 52px rgba(0,0,0,.55); }
      .ring .bg { stroke: rgba(255,255,255,.25); }
      .head { border-color: rgba(255,255,255,.08); }
      .head .sub, .cap, .foot, .loading, .empty { color: #a3a3a3; }
      .uncat { border-color: rgba(255,255,255,.16); background: rgba(255,255,255,.04); color: #b3b3b3; }
      .uncat b { color: #f0f0f0; }
      .uncat:hover, .uncat.on { border-color: #c9a86c; background: rgba(201,168,108,.12); }
      .row svg, .uncat svg { color: #c9a86c; }
      .row:hover, .row.on { background: rgba(201,168,108,.14); color: #e5c68d; }
      .row.last { box-shadow: inset 0 0 0 1px rgba(201,168,108,.35); }
    }
  `

  function ensureHost() {
    let host = document.getElementById(HOST_ID)
    if (host && host.shadowRoot) return host
    host = document.createElement('div')
    host.id = HOST_ID
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;'
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = `<style>${CSS}</style><div class="wrap"></div>`
    shadow.addEventListener('pointerdown', (e) => e.stopPropagation(), true)
    shadow.addEventListener('click', (e) => {
      e.stopPropagation()
      if (!session || !session.opened || session.saving) return
      if (Date.now() < (session.skipClick || 0)) return
      const row = rowFromEvent(e)
      if (row) saveTo(session, row.dataset.rel)
    })
    document.documentElement.appendChild(host)
    return host
  }

  function inHost(e) {
    return !!session?.host && (e.composedPath?.() || []).includes(session.host)
  }
  function imgFromEvent(e) {
    const path = e.composedPath?.() || [e.target]
    for (const n of path) {
      if (n && n.tagName === 'IMG') return n
    }
    return null
  }
  function rowFromEvent(e) {
    if (!session?.panel) return null
    const path = e.composedPath?.() || []
    if (!path.includes(session.panel)) return null
    for (const n of path) {
      if (n && n.closest) {
        const row = n.closest('[data-rel]')
        if (row) return row
      }
    }
    return null
  }

  function setStatus(s, cls, text) {
    const el = s.panel?.querySelector('.state')
    if (!el) return
    el.className = 'state' + (cls ? ' ' + cls : '')
    el.textContent = text || ''
  }
  function setHint(s) {
    const el = s.panel?.querySelector('.foot .hint')
    if (!el) return
    el.textContent = s.holding
      ? '拖到目标松开 · 松开空白处停留 · Esc 取消'
      : '点击目标保存 · 滚轮列表 · Esc 取消'
  }

  function showRing(s) {
    if (session !== s || s.opened || s.canceled) return
    const host = ensureHost()
    s.host = host
    s.shadow = host.shadowRoot
    const wrap = host.shadowRoot.querySelector('.wrap')
    const ring = document.createElement('div')
    ring.className = 'ring'
    ring.style.left = s.x0 + 'px'
    ring.style.top = s.y0 + 'px'
    ring.innerHTML = '<svg viewBox="0 0 40 40"><circle class="bg" cx="20" cy="20" r="15"/><circle class="fg" cx="20" cy="20" r="15"/></svg>'
    wrap.appendChild(ring)
    s.ringEl = ring
  }

  function openPanel(s) {
    if (session !== s || s.canceled) return
    s.opened = true
    clearTimeout(s.ringTimer)
    if (!s.host) {
      const host = ensureHost()
      s.host = host
      s.shadow = host.shadowRoot
    }
    try { s.prevDraggable = s.img.draggable; s.img.draggable = false } catch { /* 静默 */ }
    renderPanel(s)
    try {
      chrome.runtime.sendMessage({ type: 'collect-folders', rootId: last.rootId }, (res) => {
        if (session !== s || !s.opened) return
        if (!res?.ok) { renderPanel(s, res?.error || '读取文件夹失败'); return }
        s.root = res.root
        s.folders = flatten(res.folders)
        renderPanel(s)
      })
    } catch {
      renderPanel(s, '扩展上下文不可用')
    }
  }

  function flatten(nodes, depth = 0, out = []) {
    for (const n of nodes || []) {
      out.push({ rel: n.id, name: n.name, depth })
      flatten(n.children, depth + 1, out)
    }
    return out
  }

  function renderPanel(s, error) {
    if (!s.shadow) return
    const wrap = s.shadow.querySelector('.wrap')
    s.ringEl?.remove()
    s.ringEl = null
    s.panel?.remove()

    const panel = document.createElement('div')
    panel.className = 'panel'
    panel.innerHTML = `
      <div class="head"><span>保存到</span><b class="root-name"></b><span class="sub">PicNest 图巢</span></div>
      <div class="body">
        <div class="uncat" data-rel="">${NEST_ICO}<b>未分类</b><span>库根</span></div>
        <div class="listwrap">
          <div class="cap">文件夹</div>
          <div class="list"></div>
        </div>
      </div>
      <div class="foot"><span class="hint"></span><span class="state"></span></div>`
    wrap.appendChild(panel)
    s.panel = panel
    panel.querySelector('.root-name').textContent = s.root?.name || '…'

    const list = panel.querySelector('.list')
    if (error) {
      const el = document.createElement('div')
      el.className = 'empty'
      el.textContent = error
      list.appendChild(el)
      setStatus(s, 'err', '未连接')
    } else if (!s.folders) {
      const el = document.createElement('div')
      el.className = 'loading'
      el.textContent = '读取文件夹…'
      list.appendChild(el)
    } else if (!s.folders.length) {
      const el = document.createElement('div')
      el.className = 'empty'
      el.textContent = '这个根文件下还没有子文件夹'
      list.appendChild(el)
    } else {
      for (const f of s.folders) {
        const row = document.createElement('div')
        row.className = 'row'
        row.dataset.rel = f.rel
        row.style.paddingLeft = (10 + f.depth * 14) + 'px'
        const ico = document.createElement('span')
        ico.innerHTML = FOLDER_ICO
        const name = document.createElement('span')
        name.textContent = f.name
        row.appendChild(ico.firstChild)
        row.appendChild(name)
        if (last.rootId != null && String(last.rootId) === String(s.root?.id) && last.rel === f.rel) row.classList.add('last')
        list.appendChild(row)
      }
    }
    const uncat = panel.querySelector('.uncat')
    if (last.rootId != null && String(last.rootId) === String(s.root?.id) && (last.rel || '') === '') uncat.classList.add('last')
    setHint(s)
    positionPanel(s, panel)
  }

  function positionPanel(s, panel) {
    const pad = 8
    const gap = 18
    const w = panel.offsetWidth
    const h = panel.offsetHeight
    let left = s.x0 + gap
    let top = s.y0 + gap
    if (left + w > innerWidth - pad) left = s.x0 - w - gap
    if (top + h > innerHeight - pad) top = s.y0 - h - gap
    left = Math.max(pad, Math.min(left, innerWidth - w - pad))
    top = Math.max(pad, Math.min(top, innerHeight - h - pad))
    panel.style.left = left + 'px'
    panel.style.top = top + 'px'
  }

  function highlightRow(s, row) {
    if (!s.panel) return
    for (const el of s.panel.querySelectorAll('.row.on, .uncat.on')) el.classList.remove('on')
    if (row) row.classList.add('on')
  }

  async function blobToDataUrl(u) {
    try {
      const r = await fetch(u)
      const b = await r.blob()
      return await new Promise((ok, no) => {
        const fr = new FileReader()
        fr.onload = () => ok(fr.result)
        fr.onerror = no
        fr.readAsDataURL(b)
      })
    } catch {
      try {
        const img = session?.img
        if (!img) return ''
        const c = document.createElement('canvas')
        c.width = img.naturalWidth
        c.height = img.naturalHeight
        c.getContext('2d').drawImage(img, 0, 0)
        return c.toDataURL('image/png')
      } catch { return '' }
    }
  }

  async function saveTo(s, rel) {
    if (s.saving || !s.root) return
    s.saving = true
    s.skipClick = Date.now() + 500
    setStatus(s, 'saving', '保存中…')
    const src = (s.img.currentSrc || s.img.src || '').trim()
    if (!src) { s.saving = false; setStatus(s, 'err', '没有图片地址'); return }
    const payload = { url: location.href, title: (s.img.alt || document.title || '').trim() }
    if (src.startsWith('data:')) payload.dataUrl = src
    else if (src.startsWith('blob:')) {
      const dataUrl = await blobToDataUrl(src)
      if (!dataUrl) { s.saving = false; setStatus(s, 'err', 'blob 图片读取失败'); return }
      payload.dataUrl = dataUrl
    } else payload.src = src

    try {
      chrome.runtime.sendMessage({
        type: 'save-panel',
        ...payload,
        rootId: s.root.id,
        rel,
      }, (res) => {
        if (session !== s) return
        if (res?.ok) {
          setStatus(s, '', '已保存：' + (res.name || ''))
          setTimeout(() => { if (session === s) closePanel() }, 750)
        } else {
          s.saving = false
          setStatus(s, 'err', res?.error || '保存失败')
        }
      })
    } catch (e) {
      s.saving = false
      setStatus(s, 'err', String(e?.message || e))
    }
  }

  function startSession(e, img) {
    closePanel()
    const s = {
      img, x0: e.clientX, y0: e.clientY,
      opened: false, holding: true, canceled: false, saving: false, skipClick: 0,
      ringTimer: 0, holdTimer: 0,
      host: null, shadow: null, panel: null, ringEl: null,
      root: null, folders: null, prevDraggable: img.draggable,
      prevSelect: document.documentElement.style.userSelect,
    }
    session = s
    document.documentElement.style.userSelect = 'none'
    s.holdTimer = setTimeout(() => openPanel(s), HOLD_MS)
    s.ringTimer = setTimeout(() => showRing(s), RING_DELAY)
  }

  function closePanel() {
    const s = session
    if (!s) return
    session = null
    clearTimeout(s.holdTimer)
    clearTimeout(s.ringTimer)
    try { s.img.draggable = s.prevDraggable } catch { /* 静默 */ }
    document.documentElement.style.userSelect = s.prevSelect || ''
    try { s.host?.remove() } catch { /* 静默 */ }
  }

  function onDown(e) {
    if (!enabled || e.button !== 0 || e.isPrimary === false) return
    if (e.pointerType === 'touch') return // 触屏长按留给系统/页面滚动
    if (inHost(e)) return
    if (session && !session.opened) return
    if (session?.opened) closePanel()
    const img = imgFromEvent(e)
    if (!img) return
    const r = img.getBoundingClientRect()
    if (r.width < 24 || r.height < 24) return
    startSession(e, img)
  }

  function onMove(e) {
    if (!session) return
    if (!session.opened) {
      const dx = e.clientX - session.x0
      const dy = e.clientY - session.y0
      if (dx * dx + dy * dy > MOVE_TOL * MOVE_TOL) { closePanel(); return }
      if (session.ringEl) {
        session.ringEl.style.left = e.clientX + 'px'
        session.ringEl.style.top = e.clientY + 'px'
      }
      return
    }
    highlightRow(session, rowFromEvent(e))
  }

  function onUp(e) {
    const s = session
    if (!s) return
    clearTimeout(s.holdTimer)
    if (!s.opened) { closePanel(); return }
    const row = rowFromEvent(e)
    if (row) { saveTo(s, row.dataset.rel); return }
    const inPanel = (e.composedPath?.() || []).includes(s.panel)
    if (!inPanel) { closePanel(); return }
    s.holding = false
    setHint(s)
  }

  function onKey(e) {
    if (!session) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closePanel()
    }
  }
  function onDragStart(e) {
    if (session && session.holding) e.preventDefault()
  }
  function onCtx(e) {
    if (session && !inHost(e)) e.preventDefault()
  }
  function onScroll(e) {
    if (!session) return
    if (inHost(e) || e.target === session.host) return
    closePanel()
  }
  function onOutside(e) {
    if (!session || !session.opened || session.holding) return
    if (inHost(e)) return
    closePanel()
  }

  document.addEventListener('pointerdown', onDown, true)
  document.addEventListener('pointermove', onMove, true)
  document.addEventListener('pointerup', onUp, true)
  document.addEventListener('pointercancel', closePanel, true)
  document.addEventListener('keydown', onKey, true)
  document.addEventListener('dragstart', onDragStart, true)
  document.addEventListener('contextmenu', onCtx, true)
  document.addEventListener('pointerdown', onOutside, true)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('blur', closePanel)
  window.addEventListener('resize', closePanel)
  document.addEventListener('visibilitychange', () => { if (document.hidden) closePanel() })
})()
