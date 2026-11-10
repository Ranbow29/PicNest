// PicNest 图巢采集 — 网页内按住采集
// 在网页图片上左键按住 → 光标处环形进度 → 弹出双栏面板（左：未分类/库根；右：全部文件夹）
// 拖到目标松开即保存；松开在面板空白处则面板停留，可点击/滚动选择；Esc / 点外部取消。
(() => {
  const VERSION = '0.1.5'
  const prevLoaded = !!window.__picnestHoldCollectLoaded
  const prevVersion = String(window.__picnestHoldCollectVersion || '')
  /* 同版本重复注入：幂等返回。旧版本实例：0.1.4 起会挂 __picnestHoldCollectCleanup，
     可原地清理后接管；更老的实例没有 cleanup，监听器无法移除，直接退出交给后台刷新页面。 */
  if (prevLoaded && prevVersion === VERSION) return
  if (prevLoaded) {
    let cleaned = false
    try {
      if (typeof window.__picnestHoldCollectCleanup === 'function') {
        window.__picnestHoldCollectCleanup()
        cleaned = true
      }
    } catch { /* 清理失败按不可接管处理 */ }
    if (!cleaned) return
  }

  const HOLD_MS = 380
  const RING_DELAY = 120
  const MOVE_TOL = 6
  const HOST_ID = 'picnest-collect-host'
  const PROBE_EVENT = 'picnest-collect-probe'

  let enabled = true
  let session = null
  let last = { rootId: null, rel: '' }
  let probeTicks = 0
  let disposed = false

  function onStorageChanged(changes) {
    if (changes.holdCollect) enabled = changes.holdCollect.newValue !== false
    if (changes.rootId) last.rootId = changes.rootId.newValue ?? null
    if (changes.rel) last.rel = changes.rel.newValue ?? ''
    if (!enabled) closePanel()
  }
  try {
    chrome.storage.local.get({ holdCollect: true, rootId: null, rel: '' }, (s) => {
      enabled = s.holdCollect !== false
      last = { rootId: s.rootId ?? null, rel: s.rel ?? '' }
    })
    chrome.storage.onChanged.addListener(onStorageChanged)
  } catch { /* 扩展上下文失效时不影响页面 */ }

  const FOLDER_ICO = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M1.8 4.3h4l1.4 1.6h7v6.3H1.8z"/></svg>'
  /* 未分类图标：移植 PicNest FolderIcon（Wenku8 archive_icon_fold_art, GPL-2.0-or-later） */
  const GESTURE_MS = 640
  const KF_T = [0, 0.1, 0.36, 0.64, 0.82, 1]
  const KF_V = [0, -0.12, 1, -0.2, 0.065, 0]
  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
  }
  function springAt(t) {
    if (t <= 0) return KF_V[0]
    if (t >= 1) return KF_V[KF_V.length - 1]
    for (let i = 1; i < KF_T.length; i++) {
      if (t <= KF_T[i]) {
        const k = (t - KF_T[i - 1]) / (KF_T[i] - KF_T[i - 1])
        return KF_V[i - 1] + (KF_V[i] - KF_V[i - 1]) * easeInOutCubic(k)
      }
    }
    return 0
  }
  function layerAt(t, delayMs) {
    const d = delayMs / GESTURE_MS
    const tt = t <= d ? 0 : (t - d) / (1 - d)
    return springAt(tt)
  }
  function folderIconSvg() {
    return `<svg class="folder-ico" data-folder-ico viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <path class="fi-back" d="M6 4.6 L15.8 4.6 L18.6 7.4 L18.6 17.9 L6 17.9 Z" fill="currentColor" stroke="currentColor" stroke-width="1.4" opacity=".4"/>
      <path class="fi-front" d="M3 8.4 L8 8.4 L10.4 10 L21.5 10 L19.7 20.2 L4.4 20.2 Z" fill="currentColor" stroke="currentColor" stroke-width="1.4" opacity=".85"/>
      <circle cx="6.2" cy="16.7" r="1.15" fill="#fff" stroke="none" opacity=".95"/>
      <line x1="9.2" y1="17.4" x2="12.5" y2="17.4" stroke="#fff" stroke-width="1.4" opacity=".95"/>
    </svg>`
  }
  function setFolderPhase(svg, p, q) {
    const cardY = 4.6 - 2.6 * q
    const lip = (b) => b + 2.1 * p
    const back = svg.querySelector('.fi-back')
    const front = svg.querySelector('.fi-front')
    if (back) back.setAttribute('d', `M6 ${cardY} L15.8 ${cardY} L18.6 ${cardY + 2.8} L18.6 ${cardY + 13.3} L6 ${cardY + 13.3} Z`)
    if (front) front.setAttribute('d', `M3 ${lip(8.4)} L8 ${lip(8.4)} L10.4 ${lip(10)} L21.5 ${lip(10)} L19.7 20.2 L4.4 20.2 Z`)
  }
  function playFolderIcon(panel) {
    const svg = panel?.querySelector('[data-folder-ico]')
    if (!svg) return
    cancelAnimationFrame(svg._picnestRaf)
    const t0 = performance.now()
    const tick = (now) => {
      if (!svg.isConnected) { svg._picnestRaf = 0; return }
      const t = (now - t0) / GESTURE_MS
      if (t >= 1) { setFolderPhase(svg, 0, 0); svg._picnestRaf = 0; return }
      setFolderPhase(svg, layerAt(t, 0), layerAt(t, 55))
      svg._picnestRaf = requestAnimationFrame(tick)
    }
    svg._picnestRaf = requestAnimationFrame(tick)
  }

  const CSS = `
    :host { all: initial; }
    .wrap { position: fixed; inset: 0; pointer-events: none;
      font-family: 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif; }
    .ring { position: fixed; width: 40px; height: 40px; margin: -20px 0 0 -20px;
      pointer-events: none; filter: drop-shadow(0 2px 8px rgba(0,0,0,.18)); }
    .ring svg { width: 40px; height: 40px; transform: rotate(-90deg); }
    .ring circle { fill: none; stroke-width: 5.2; } /* 加粗：按住采集的进度环要一眼可辨 */
    .ring .bg { stroke: rgba(0,0,0,.22); }
    .ring .fg { stroke: #c08a3e; stroke-linecap: round; stroke-dasharray: 94.25;
      stroke-dashoffset: 94.25; animation: ringfill ${HOLD_MS - RING_DELAY}ms linear forwards; }
    @keyframes ringfill { to { stroke-dashoffset: 0; } }
    .panel { position: fixed; pointer-events: auto; display: flex; flex-direction: column;
      width: 440px; max-width: calc(100vw - 16px); max-height: 70vh;
      background: #ffffff; color: #262626; border: 1px solid rgba(20,20,20,.12);
      border-radius: 16px; overflow: hidden; font-size: 12.5px; line-height: 1.45;
      box-shadow: 0 2px 6px rgba(0,0,0,.08), 0 18px 52px rgba(0,0,0,.18);
      animation: pop .16s cubic-bezier(.2,1.2,.3,1); }
    @keyframes pop { from { opacity: 0; transform: translateY(6px) scale(.97); } to { opacity: 1; transform: none; } }
    .head { display: flex; align-items: baseline; gap: 6px; padding: 10px 14px 8px;
      border-bottom: 1px solid rgba(0,0,0,.07); }
    .head b { font-size: 13px; }
    .head .sub { margin-left: auto; font-size: 10.5px; color: #8a8a8a; }
    .body { display: flex; gap: 8px; padding: 10px; min-height: 0; flex: 1; overflow: hidden; }
    .uncat { width: 138px; flex: none; border: 1px dashed rgba(0,0,0,.18); border-radius: 12px;
      background: #fbfaf7;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
      cursor: pointer; color: #6f6a60; text-align: center; padding: 12px 8px; }
    .uncat svg { width: 34px; height: 34px; color: #b4884b; overflow: visible; }
    .folder-ico { display: block; }
    .uncat b { color: #262626; font-size: 12.5px; }
    .uncat span { font-size: 10.5px; }
    .uncat:hover, .uncat.on { border-color: #b4884b; background: rgba(180,136,75,.10); }
    .listwrap { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
    .cap { font-size: 10.5px; color: #8a8a8a; padding: 0 4px 4px; letter-spacing: .5px; flex: none; }
    .list { flex: 1; min-height: 80px; overflow-y: auto; padding-right: 2px; }
    .row { display: flex; align-items: center; gap: 7px; padding: 6px 8px; border-radius: 8px;
      cursor: pointer; white-space: nowrap; overflow: hidden; }
    .row svg { width: 14px; height: 14px; flex: none; color: #b4884b; opacity: .9; }
    .row span { overflow: hidden; text-overflow: ellipsis; }
    .row:hover, .row.on { background: rgba(180,136,75,.12); color: #8a5f24; }
    .row.last { box-shadow: inset 0 0 0 1px rgba(180,136,75,.35); }
    .loading, .empty { padding: 10px 8px; font-size: 11px; color: #8a8a8a; }
    .auth-box { padding: 8px 4px; display: flex; flex-direction: column; gap: 6px; }
    .auth-title { font-size: 11.5px; font-weight: 600; color: #b4463b; }
    .auth-desc { font-size: 10.5px; color: #737373; line-height: 1.45; }
    .auth-row { display: flex; gap: 6px; margin-top: 4px; }
    .auth-input { flex: 1; min-width: 0; height: 26px; border-radius: 6px; border: 1px solid rgba(0,0,0,.2);
      padding: 0 8px; font-size: 11px; background: #fff; color: #262626; outline: none; }
    .auth-input:focus { border-color: #b4884b; box-shadow: 0 0 0 2px rgba(180,136,75,.2); }
    .auth-btn { height: 26px; padding: 0 12px; border-radius: 6px; border: none;
      background: #b4884b; color: #fff; font-size: 11px; cursor: pointer; flex: none; font-weight: 500; }
    .auth-btn:hover { background: #9e753c; }
    .auth-err { font-size: 10px; color: #b4463b; margin-top: 2px; }
    .foot { display: flex; align-items: center; gap: 8px; padding: 7px 14px 9px;
      border-top: 1px solid rgba(0,0,0,.07); color: #8a8a8a; font-size: 10.5px; }
    .state { margin-left: auto; color: #4f7d5e; }
    .state.err { color: #b4463b; }
    .state.saving { color: #8a8a8a; }
    .dup { margin: 0 10px 10px; padding: 10px 12px; border: 1px solid rgba(194,90,77,.35);
      background: #fff8f7; border-radius: 10px; color: #8a3b32; font-size: 11.5px; }
    .dup b { display: block; font-size: 12px; margin-bottom: 4px; }
    .dup ul { margin: 4px 0 8px; padding-left: 16px; max-height: 86px; overflow-y: auto; }
    .dup li { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dup .btns { display: flex; gap: 8px; }
    .dup button { flex: 1; height: 27px; border-radius: 7px; border: 1px solid rgba(194,90,77,.4);
      background: #fff; color: #8a3b32; font-size: 11.5px; cursor: pointer; }
    .dup button[data-act="overwrite"] { border-color: rgba(180,68,59,.5); color: #b4463b; }
    .dup button[data-act="force"] { background: #b4884b; border-color: #b4884b; color: #fff; }
    .dup button:hover { filter: brightness(.98); }
    .newdir { flex: none; margin-top: 4px; height: 28px; border: 1px dashed rgba(0,0,0,.18);
      border-radius: 8px; background: #fff; color: #8a6a3a; font-size: 11.5px; cursor: pointer; }
    .newdir:hover { border-color: #b4884b; background: rgba(180,136,75,.08); }
    .newdir[hidden], .newdir-form[hidden] { display: none; }
    .newdir-form { flex: none; display: flex; gap: 6px; margin-top: 4px; }
    .newdir-input { flex: 1; min-width: 0; height: 28px; border: 1px solid rgba(0,0,0,.16);
      border-radius: 7px; padding: 0 8px; font-size: 12px; color: #262626; background: #fff; outline: none; }
    .newdir-input:focus { border-color: #b4884b; }
    .nd-btn { height: 28px; padding: 0 10px; border-radius: 7px; border: 1px solid rgba(0,0,0,.14);
      background: #fff; color: #6f6a60; font-size: 11.5px; cursor: pointer; }
    .nd-btn.ok { background: #b4884b; border-color: #b4884b; color: #fff; }
    .nd-btn:hover { filter: brightness(.98); }
    @media (prefers-color-scheme: dark) {
      .ring .bg { stroke: rgba(255,255,255,.25); }
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
      let act = ''
      for (const n of (e.composedPath?.() || [])) {
        if (n && n.closest) {
          const a = n.closest('[data-act]')
          if (a) { act = a.dataset.act; break }
        }
      }
      if (act === 'newdir') { showNewDir(session); return }
      if (act === 'create') {
        createNewFolder(session, session.panel?.querySelector('.newdir-input')?.value || '')
        return
      }
      if (act === 'cancelnew') { hideNewDir(session); return }
      if (act === 'skip') { closePanel(); return }
      if (act === 'overwrite') { saveTo(session, session.pendingRel, false, true); return }
      if (act === 'force') { saveTo(session, session.pendingRel, true); return }
      const row = rowFromEvent(e)
      if (row) saveTo(session, row.dataset.rel)
    })
    document.documentElement.appendChild(host)
    return host
  }

  function inHost(e) {
    return !!session?.host && (e.composedPath?.() || []).includes(session.host)
  }
  function runtimeAlive() {
    try { return !!chrome.runtime?.id } catch { return false }
  }
  function refreshHint() { return '扩展已更新，请刷新此页面后再采集' }
  function imgFromEvent(e) {
    const path = e.composedPath?.() || [e.target]
    for (const n of path) {
      if (n && n.tagName === 'IMG') return n
    }
    return null
  }
  /* Pinterest 等站点会用覆盖层 DIV 盖住图片：事件目标不是 IMG，按坐标找底层可见图片 */
  function imgVisibleAt(el, x, y) {
    if (!el || el.tagName !== 'IMG') return false
    const r = el.getBoundingClientRect()
    if (r.width < 24 || r.height < 24) return false
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false
    if (!el.naturalWidth || !el.naturalHeight) return false
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false
    const cs = getComputedStyle(el)
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0
  }
  function imgAtPoint(x, y) {
    const list = document.elementsFromPoint?.(x, y) || []
    for (const el of list) {
      if (imgVisibleAt(el, x, y)) return el
    }
    /* 2026-11 Pinterest 把 <img> 设成 pointer-events:none，elementsFromPoint 会直接跳过它；
       退化为几何扫描：所有可见图片里取包含该点、面积最大的那张。 */
    let best = null
    let bestArea = 0
    for (const el of document.images) {
      if (!imgVisibleAt(el, x, y)) continue
      const r = el.getBoundingClientRect()
      const area = r.width * r.height
      if (area > bestArea) { bestArea = area; best = el }
    }
    return best
  }
  function panelAtPoint(x, y) {
    const p = session?.panel
    if (!p) return false
    const r = p.getBoundingClientRect()
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
  }
  function rowAtPoint(x, y) {
    const p = session?.panel
    if (!p) return null
    for (const row of p.querySelectorAll('[data-rel]')) {
      const r = row.getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return row
    }
    return null
  }
  function rowFromEvent(e) {
    if (!session?.panel) return null
    const path = e.composedPath?.() || []
    if (path.includes(session.panel)) {
      for (const n of path) {
        if (n && n.closest) {
          const row = n.closest('[data-rel]')
          if (row) return row
        }
      }
      return null
    }
    /* 站点若 setPointerCapture，事件会被重定向到页面元素，composedPath 里没有面板；
       用坐标兜底，面板里的行仍能悬停/点击。 */
    return rowAtPoint(e.clientX || 0, e.clientY || 0)
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
  function removeDup(s) {
    try { s.panel?.querySelector('.dup')?.remove() } catch { /* 静默 */ }
  }
  function showDuplicate(s, matches) {    removeDup(s)
    if (!s.panel) return
    const dup = document.createElement('div')
    dup.className = 'dup'
    const title = document.createElement('b')
    title.textContent = '图库里已有相同图片'
    const ul = document.createElement('ul')
    for (const m of (matches || []).slice(0, 3)) {
      const li = document.createElement('li')
      li.textContent = `${m.file_name || ''}${m.folder ? ' · ' + m.folder : ''}`
      ul.appendChild(li)
    }
    const btns = document.createElement('div')
    btns.className = 'btns'
    const skip = document.createElement('button')
    skip.dataset.act = 'skip'
    skip.textContent = '跳过'
    const overwrite = document.createElement('button')
    overwrite.dataset.act = 'overwrite'
    overwrite.textContent = '覆盖旧图'
    overwrite.title = '删除根文件下的旧图（移入图巢回收站），保存新图'
    const force = document.createElement('button')
    force.dataset.act = 'force'
    force.textContent = '仍然保存'
    btns.appendChild(skip)
    btns.appendChild(overwrite)
    btns.appendChild(force)
    dup.appendChild(title)
    dup.appendChild(ul)
    dup.appendChild(btns)
    s.panel.insertBefore(dup, s.panel.querySelector('.foot'))
    s.skipClick = 0
    setStatus(s, '', '发现相同图片')
  }
  function showNewDir(s) {
    const p = s.panel
    if (!p) return
    const btn = p.querySelector('.newdir')
    const form = p.querySelector('.newdir-form')
    if (!btn || !form) return
    btn.hidden = true
    form.hidden = false
    form.querySelector('.newdir-input')?.focus()
  }
  function hideNewDir(s) {
    const p = s.panel
    if (!p) return
    const btn = p.querySelector('.newdir')
    const form = p.querySelector('.newdir-form')
    if (!btn || !form) return
    form.hidden = true
    btn.hidden = false
    const input = form.querySelector('.newdir-input')
    if (input) input.value = ''
  }
  function createNewFolder(s, name) {
    if (!s.root || s.saving) return
    const clean = String(name || '').trim()
    if (!clean) { setStatus(s, 'err', '请输入文件夹名称'); return }
    if (!runtimeAlive()) { setStatus(s, 'err', refreshHint()); return }
    s.saving = true
    setStatus(s, 'saving', '新建中…')
    try {
      chrome.runtime.sendMessage({ type: 'create-folder', rootId: s.root.id, parentRel: '', name: clean }, (res) => {
        if (session !== s) return
        s.saving = false
        if (!res?.ok) { setStatus(s, 'err', res?.error || '新建失败'); return }
        s.createdRel = res.folder.id
        s.folders = (s.folders || []).concat([{ rel: res.folder.id, name: res.folder.name, depth: 0 }])
        renderPanel(s)
        const row = [...s.panel.querySelectorAll('.row')].find((r) => r.dataset.rel === res.folder.id)
        if (row) row.scrollIntoView({ block: 'nearest' })
        setStatus(s, '', '已创建：' + res.folder.name + '（点击它保存）')
      })
    } catch (e) {
      s.saving = false
      const msg = String(e?.message || e)
      setStatus(s, 'err', /context invalidated|Extension context/i.test(msg) ? refreshHint() : msg)
    }
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
    if (!runtimeAlive()) { renderPanel(s, refreshHint()); return }
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
      renderPanel(s, refreshHint())
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
        <div class="uncat" data-rel="">${folderIconSvg()}<b>未分类</b><span>库根</span></div>
        <div class="listwrap">
          <div class="cap">文件夹</div>
          <div class="list"></div>
          <button class="newdir" data-act="newdir" title="在当前根文件的库根新建文件夹">＋ 新建文件夹…</button>
          <div class="newdir-form" hidden>
            <input class="newdir-input" maxlength="80" placeholder="文件夹名称" spellcheck="false" />
            <button class="nd-btn ok" data-act="create">创建</button>
            <button class="nd-btn" data-act="cancelnew">取消</button>
          </div>
        </div>
      </div>
      <div class="foot"><span class="hint"></span><span class="state"></span></div>`
    wrap.appendChild(panel)
    s.panel = panel
    panel.querySelector('.root-name').textContent = s.root?.name || '…'

    const list = panel.querySelector('.list')
    if (error) {
      if (typeof error === 'string' && (error.includes('未授权') || error.includes('Token') || error.includes('401'))) {
        const box = document.createElement('div')
        box.className = 'auth-box'
        box.innerHTML = `
          <div class="auth-title">需配对密钥</div>
          <div class="auth-desc">安全防护已生效。请在 PicNest 顶栏「设置」中点击「复制密钥」，粘贴到下方配对：</div>
          <div class="auth-row">
            <input class="auth-input" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true" placeholder="在此粘贴 32 位配对密钥…" style="-webkit-text-security: disc;" />
            <button class="auth-btn" type="button">配对</button>
          </div>
          <div class="auth-err" style="display:none"></div>
        `
        const inp = box.querySelector('.auth-input')
        const btn = box.querySelector('.auth-btn')
        const errEl = box.querySelector('.auth-err')
        const doPair = () => {
          const val = inp.value.trim()
          if (!val) {
            errEl.textContent = '密钥不能为空'
            errEl.style.display = 'block'
            return
          }
          btn.disabled = true
          btn.textContent = '验证中…'
          chrome.runtime.sendMessage({ type: 'save-token', token: val }, (resp) => {
            if (resp?.ok) {
              btn.textContent = '已配对 ✓'
              setTimeout(() => {
                renderPanel(s)
                chrome.runtime.sendMessage({ type: 'collect-folders', rootId: last.rootId }, (res) => {
                  if (session !== s || !s.opened) return
                  if (!res?.ok) { renderPanel(s, res?.error || '读取文件夹失败'); return }
                  s.root = res.root
                  s.folders = flatten(res.folders)
                  renderPanel(s)
                })
              }, 300)
            } else {
              btn.disabled = false
              btn.textContent = '配对'
              errEl.textContent = resp?.error || '配对失败'
              errEl.style.display = 'block'
            }
          })
        }
        btn.addEventListener('click', (e) => { e.stopPropagation(); doPair() })
        inp.addEventListener('click', (e) => e.stopPropagation())
        inp.addEventListener('keydown', (e) => {
          e.stopPropagation()
          if (e.key === 'Enter') doPair()
        })
        list.appendChild(box)
        setStatus(s, 'err', '需配对')
        setTimeout(() => inp.focus(), 60)
      } else {
        const el = document.createElement('div')
        el.className = 'empty'
        el.textContent = error
        list.appendChild(el)
        setStatus(s, 'err', '未连接')
      }
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
        if (s.createdRel === f.rel) row.classList.add('last')
        list.appendChild(row)
      }
    }
    const uncat = panel.querySelector('.uncat')
    if (last.rootId != null && String(last.rootId) === String(s.root?.id) && (last.rel || '') === '') uncat.classList.add('last')
    uncat.addEventListener('mouseenter', () => playFolderIcon(panel))
    const ndInput = panel.querySelector('.newdir-input')
    if (ndInput) {
      ndInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          createNewFolder(s, ndInput.value)
        }
      })
    }
    setHint(s)
    positionPanel(s, panel)
    if (s.folders || error) playFolderIcon(panel)
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

  async function saveTo(s, rel, force, overwrite) {
    if (s.saving || !s.root) return
    s.saving = true
    s.pendingRel = rel
    s.skipClick = Date.now() + 500
    removeDup(s)
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

    if (!runtimeAlive()) {
      s.saving = false
      setStatus(s, 'err', refreshHint())
      return
    }
    try {
      chrome.runtime.sendMessage({
        type: 'save-panel',
        ...payload,
        rootId: s.root.id,
        rel,
        force: !!force,
        overwrite: !!overwrite,
      }, (res) => {
        if (session !== s) return
        if (res?.duplicate) {
          s.saving = false
          s.holding = false
          s.pendingRel = rel
          setHint(s)
          showDuplicate(s, res.matches || [])
          return
        }
        if (res?.ok) {
          const extra = res.overwritten ? `（旧图 ${res.overwritten} 张已进回收站）` : ''
          setStatus(s, '', '已保存：' + (res.name || '') + extra)
          setTimeout(() => { if (session === s) closePanel() }, 750)
        } else {
          s.saving = false
          setStatus(s, 'err', res?.error || '保存失败')
        }
      })
    } catch (e) {
      s.saving = false
      const msg = String(e?.message || e)
      setStatus(s, 'err', /context invalidated|Extension context/i.test(msg) ? refreshHint() : msg)
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
    if (panelAtPoint(e.clientX, e.clientY)) return
    if (session && !session.opened) return
    if (session?.opened) closePanel()
    const img = imgFromEvent(e) || imgAtPoint(e.clientX, e.clientY)
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
    const inPanel = (e.composedPath?.() || []).includes(s.panel) || panelAtPoint(e.clientX, e.clientY)
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
    if (inHost(e) || panelAtPoint(e.clientX, e.clientY)) return
    closePanel()
  }

  function onVisibility() {
    if (document.hidden) closePanel()
  }
  function onProbe() {
    probeTicks++
  }
  function onPageShow(e) {
    if (e?.persisted) selfCheck()
  }

  let listenersOn = false
  let watchdogTimer = 0
  let firstCheckTimer = 0
  let selfHeals = 0

  /* document.open()/页面重建会清掉已注册的监听器，但保留隔离世界里的 window 全局：
     用户表现为“按住无反应”，后台表现为 healthy=false。这里每 2.5s 自检一次，
     发现 document 监听器收不到私有事件就地重建；window 捕获哨兵让第一次按下也能自愈。 */
  function selfCheck() {
    if (disposed) return
    const before = probeTicks
    try { document.dispatchEvent(new Event(PROBE_EVENT)) } catch { /* 页面销毁中 */ }
    if (probeTicks !== before) return
    closePanel()
    removeListeners()
    installListeners()
    selfHeals++
  }

  function installListeners() {
    if (disposed || listenersOn) return
    try {
      document.addEventListener('pointerdown', onDown, true)
      document.addEventListener('pointermove', onMove, true)
      document.addEventListener('pointerup', onUp, true)
      document.addEventListener('pointercancel', closePanel, true)
      document.addEventListener('keydown', onKey, true)
      document.addEventListener('dragstart', onDragStart, true)
      document.addEventListener('contextmenu', onCtx, true)
      document.addEventListener('pointerdown', onOutside, true)
      document.addEventListener('visibilitychange', onVisibility)
      document.addEventListener(PROBE_EVENT, onProbe)
      document.addEventListener('pageshow', onPageShow)
      window.addEventListener('scroll', onScroll, true)
      window.addEventListener('blur', closePanel)
      window.addEventListener('resize', closePanel)
      /* window 捕获哨兵：document 监听器被清掉后，下一次按下仍能触发自愈 */
      window.addEventListener('pointerdown', selfCheck, true)
      listenersOn = true
    } catch { /* 页面销毁/权限异常：保持 Loaded，后台下次探测再修 */ }
  }

  function removeListeners() {
    if (!listenersOn) return
    listenersOn = false
    try { document.removeEventListener('pointerdown', onDown, true) } catch { /* 静默 */ }
    try { document.removeEventListener('pointermove', onMove, true) } catch { /* 静默 */ }
    try { document.removeEventListener('pointerup', onUp, true) } catch { /* 静默 */ }
    try { document.removeEventListener('pointercancel', closePanel, true) } catch { /* 静默 */ }
    try { document.removeEventListener('keydown', onKey, true) } catch { /* 静默 */ }
    try { document.removeEventListener('dragstart', onDragStart, true) } catch { /* 静默 */ }
    try { document.removeEventListener('contextmenu', onCtx, true) } catch { /* 静默 */ }
    try { document.removeEventListener('pointerdown', onOutside, true) } catch { /* 静默 */ }
    try { document.removeEventListener('visibilitychange', onVisibility) } catch { /* 静默 */ }
    try { document.removeEventListener(PROBE_EVENT, onProbe) } catch { /* 静默 */ }
    try { document.removeEventListener('pageshow', onPageShow) } catch { /* 静默 */ }
    try { window.removeEventListener('scroll', onScroll, true) } catch { /* 静默 */ }
    try { window.removeEventListener('blur', closePanel) } catch { /* 静默 */ }
    try { window.removeEventListener('resize', closePanel) } catch { /* 静默 */ }
    try { window.removeEventListener('pointerdown', selfCheck, true) } catch { /* 静默 */ }
  }

  /* 供后台/新版脚本接管：移除全部页面监听器与悬浮 UI。0.1.4 起每个版本都必须挂这个入口，
     下次扩展更新后向仍打开的页面注入新 content.js 即可原地重建，不必刷新整页。 */
  function cleanup() {
    if (disposed) return
    disposed = true
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = 0 }
    if (firstCheckTimer) { clearTimeout(firstCheckTimer); firstCheckTimer = 0 }
    closePanel()
    removeListeners()
    try { chrome.storage.onChanged.removeListener(onStorageChanged) } catch { /* 静默 */ }
    try { document.getElementById(HOST_ID)?.remove() } catch { /* 静默 */ }
  }

  /* 后台探测用：发一个私有事件，能收到就说明 document 监听器仍活着；
     chrome.runtime.id 用来识别“扩展已更新、旧脚本被孤立”的页面。 */
  function health() {
    let alive = false
    try { alive = !!chrome.runtime?.id } catch { alive = false }
    return { version: VERSION, ticks: probeTicks, alive, enabled, disposed, selfHeals }
  }

  installListeners()
  window.__picnestHoldCollectCleanup = cleanup
  window.__picnestHoldCollectHealth = health
  /* 只有监听器全部注册成功后才置 Loaded：部分初始化失败的页面可以被后台补注入修复 */
  window.__picnestHoldCollectLoaded = true
  window.__picnestHoldCollectVersion = VERSION
  firstCheckTimer = setTimeout(() => { firstCheckTimer = 0; selfCheck() }, 1200)
  watchdogTimer = setInterval(selfCheck, 2500)
})()
