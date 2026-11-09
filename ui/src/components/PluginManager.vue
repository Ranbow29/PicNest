<script setup>
// 插件库：已安装管理 / 本地文件夹安装 / registry 仓库浏览安装 / renderer 插件沙箱面板
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useLibrary } from '../stores/library'
import { onPluginEvent, refreshPluginThemes } from '../lib/plugins'

const lib = useLibrary()
const tab = ref('installed')
const plugins = ref([])
const loading = ref(false)
const error = ref('')
const busyId = ref('')

const registryUrl = ref(localStorage.getItem('picnest.pluginRegistryUrl') || '')
const registry = ref([])
const regLoading = ref(false)
const regError = ref('')

const frame = ref(null)       // { plugin, html }
const frameEl = ref(null)
let offEvents = null

const API_VERSION = '1.0.0'
const typeLabel = (t) => ({ theme: '主题', renderer: '界面', main: '主进程' }[t] || t || '未知')
const canOpen = (p) => p.type === 'renderer' && p.enabled && !p.error && (p.permissions || []).includes('ui.panel')

async function load() {
  if (!window.picrand?.picnestPluginsList) return
  loading.value = true
  error.value = ''
  try {
    const r = await window.picrand.picnestPluginsList()
    if (!r?.ok) throw new Error(r?.error || '读取插件列表失败')
    plugins.value = r.plugins || []
    await refreshPluginThemes()
  } catch (e) {
    error.value = String(e?.message || e)
  } finally {
    loading.value = false
  }
}

async function toggle(p) {
  if (p.type === 'main' && !p.enabled) {
    lib.showNote('主进程插件暂未启用（需要 P3 的独立进程网关）', [], 'muted')
    return
  }
  busyId.value = p.id
  try {
    const r = await window.picrand.picnestPluginSetEnabled(p.id, !p.enabled)
    if (!r?.ok) throw new Error(r?.error || '切换失败')
    p.enabled = !p.enabled
    if (!p.enabled && frame.value?.plugin?.id === p.id) closeFrame()
    await refreshPluginThemes()
    lib.showNote(`${p.name}：${p.enabled ? '已启用' : '已停用'}`, [], 'ok')
  } catch (e) {
    lib.showNote(String(e?.message || e), [], 'error')
  } finally { busyId.value = '' }
}

async function installFolder() {
  const pick = await window.picrand.picnestPluginPickFolder()
  if (!pick?.ok || !pick.path) return
  busyId.value = 'install'
  try {
    const r = await window.picrand.picnestPluginInstallFolder(pick.path)
    if (!r?.ok) throw new Error(r?.error || '安装失败')
    await load()
    lib.showNote(`已安装插件「${r.plugin?.name || r.plugin?.id}」`, [], 'ok')
  } catch (e) {
    lib.showNote(String(e?.message || e), [], 'error')
  } finally { busyId.value = '' }
}

async function uninstall(p) {
  const ok = await lib.askConfirm({
    title: `卸载插件「${p.name}」？`,
    message: '插件文件会从插件目录删除；插件自己的 storage 一并移除。',
    confirmText: '卸载',
    danger: true,
  })
  if (!ok) return
  busyId.value = p.id
  try {
    const r = await window.picrand.picnestPluginUninstall(p.id)
    if (!r?.ok) throw new Error(r?.error || '卸载失败')
    await load()
    lib.showNote(`已卸载「${p.name}」`, [], 'ok')
  } catch (e) {
    lib.showNote(String(e?.message || e), [], 'error')
  } finally { busyId.value = '' }
}

async function fetchRegistry() {
  const url = registryUrl.value.trim()
  if (!url) { regError.value = '请填写 registry.json 的地址或本地路径'; return }
  localStorage.setItem('picnest.pluginRegistryUrl', url)
  regLoading.value = true
  regError.value = ''
  try {
    const r = await window.picrand.picnestPluginRegistryFetch(url)
    if (!r?.ok) throw new Error(r?.error || '拉取失败')
    registry.value = r.plugins || []
  } catch (e) {
    registry.value = []
    regError.value = String(e?.message || e)
  } finally { regLoading.value = false }
}

async function installRegistry(entry) {
  busyId.value = 'reg:' + entry.id
  try {
    const r = await window.picrand.picnestPluginInstallRegistry(entry)
    if (!r?.ok) throw new Error(r?.error || '安装失败')
    await load()
    lib.showNote(`已安装「${r.plugin?.name || entry.name}」`, [], 'ok')
  } catch (e) {
    lib.showNote(String(e?.message || e), [], 'error')
  } finally { busyId.value = '' }
}

async function openPanel(p) {
  if (!canOpen(p)) return
  busyId.value = p.id
  try {
    const r = await window.picrand.picnestPluginEntryHtml(p.id)
    if (!r?.ok) throw new Error(r?.error || '读取插件入口失败')
    offEvents?.()
    offEvents = null
    frame.value = { plugin: { ...p, ...r.plugin, permissions: p.permissions || r.plugin?.permissions || [] }, html: r.html }
    if ((frame.value.plugin.permissions || []).includes('events.read')) {
      offEvents = onPluginEvent((name, payload) => post({ source: 'picnest-host', type: 'event', name, payload }))
    }
  } catch (e) {
    lib.showNote(String(e?.message || e), [], 'error')
  } finally { busyId.value = '' }
}

function post(msg) {
  try { frameEl.value?.contentWindow?.postMessage(msg, '*') } catch { /* 静默 */ }
}
function postInit() {
  if (!frame.value) return
  post({
    source: 'picnest-host', type: 'init', pluginId: frame.value.plugin.id, apiVersion: API_VERSION,
    context: {
      rootId: lib.activeRootId,
      rootName: lib.activeRoot?.display_name || lib.activeRoot?.name || '',
      view: lib.view,
      rel: lib.currentDirRel || '',
      selection: [...lib.selectedPaths],
    },
  })
}
function reply(id, ok, data, errorMsg) {
  if (id == null) return
  post({ source: 'picnest-host', type: 'response', id, ok, data: data ?? null, error: errorMsg || '' })
}
function hasPerm(p, perm) { return (p.permissions || []).includes(perm) }

async function onMessage(e) {
  const f = frame.value
  const el = frameEl.value
  if (!f || !el || e.source !== el.contentWindow) return
  const m = e.data
  if (!m || m.source !== 'picnest-plugin' || m.pluginId !== f.plugin.id) return
  const p = f.plugin
  try {
    if (m.type === 'ready') { postInit(); return }
    if (m.type === 'close') { closeFrame(); return }
    if (m.type === 'query-images') {
      if (!hasPerm(p, 'data.images.read')) return reply(m.id, false, null, '缺少 data.images.read 权限')
      const r = await window.picrand.picnestPluginQueryImages({
        folderId: lib.activeRootId,
        rel: m.rel == null ? (lib.currentDirRel || '') : String(m.rel),
        limit: m.limit,
      })
      return reply(m.id, !!r?.ok, r?.ok ? { images: r.images, rootId: r.rootId, rel: r.rel } : null, r?.error)
    }
    if (m.type === 'storage-get') {
      if (!hasPerm(p, 'storage')) return reply(m.id, false, null, '缺少 storage 权限')
      const r = await window.picrand.picnestPluginStorageGet(p.id)
      const all = r?.ok ? (r.value || {}) : {}
      return reply(m.id, !!r?.ok, { value: all[String(m.key || '')] }, r?.error)
    }
    if (m.type === 'storage-set') {
      if (!hasPerm(p, 'storage')) return reply(m.id, false, null, '缺少 storage 权限')
      const r0 = await window.picrand.picnestPluginStorageGet(p.id)
      const all = r0?.ok ? (r0.value || {}) : {}
      all[String(m.key || '')] = m.value
      const r = await window.picrand.picnestPluginStorageSet(p.id, all)
      return reply(m.id, !!r?.ok, null, r?.error)
    }
    if (m.type === 'fetch') {
      const origin = (() => { try { return new URL(String(m.url || '')).origin } catch { return '' } })()
      const allowed = (p.permissions || []).filter((x) => x.startsWith('net:')).map((x) => x.slice(4))
      if (!origin || !allowed.includes(origin)) return reply(m.id, false, null, `未声明网络权限 net:${origin}`)
      const r = await window.picrand.picnestPluginFetch(String(m.url), m.init || {})
      return reply(m.id, !!r?.ok, r?.ok ? { status: r.status, contentType: r.contentType, body: r.body } : null, r?.error)
    }
  } catch (err) {
    reply(m.id, false, null, String(err?.message || err))
  }
}

function onFrameLoad() { postInit() }
function closeFrame() {
  offEvents?.()
  offEvents = null
  frame.value = null
}

watch(() => lib.pluginsOpen, (v) => { if (v) load() })
onMounted(() => {
  window.addEventListener('message', onMessage)
  if (lib.pluginsOpen) load()
})
onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage)
  offEvents?.()
})
</script>

<template>
  <Teleport to="body">
    <div v-if="lib.pluginsOpen" class="pl-layer" @click.self="lib.closePlugins()">
      <div class="pl-card">
        <header class="pl-head">
          <div class="pl-title">插件库 <span class="pl-api">API {{ API_VERSION }}</span></div>
          <div class="pl-tabs">
            <button :class="{ on: tab === 'installed' }" @click="tab = 'installed'">已安装</button>
            <button :class="{ on: tab === 'registry' }" @click="tab = 'registry'">插件仓库</button>
          </div>
          <button class="pl-x" title="关闭（Esc）" @click="lib.closePlugins()">✕</button>
        </header>

        <div v-if="tab === 'installed'" class="pl-body">
          <div class="pl-toolbar">
            <button class="pl-btn primary" :disabled="busyId === 'install'" @click="installFolder">{{ busyId === 'install' ? '安装中…' : '从文件夹安装…' }}</button>
            <button class="pl-btn" :disabled="loading" @click="load">刷新</button>
            <span class="pl-hint">插件放在数据目录 plugins/；开启后生效，卸载即删除插件文件</span>
          </div>
          <div v-if="error" class="pl-empty err">{{ error }}</div>
          <div v-else-if="loading" class="pl-empty">读取插件列表…</div>
          <div v-else-if="!plugins.length" class="pl-empty">
            还没有安装插件。可以「从文件夹安装」，或在「插件仓库」里填 registry.json 地址。
          </div>
          <div v-else class="pl-list">
            <section v-for="p in plugins" :key="p.id" class="pl-item" :class="{ off: !p.enabled }">
              <div class="pl-item-head">
                <div class="pl-name">
                  {{ p.name }}
                  <span class="pl-ver">v{{ p.version || '—' }}</span>
                  <span class="pl-type" :class="p.type">{{ typeLabel(p.type) }}</span>
                  <span v-if="p.error" class="pl-errbadge">清单错误</span>
                </div>
                <label class="pl-switch" :title="p.type === 'main' ? '主进程插件 P3 才可启用' : (p.enabled ? '停用' : '启用')">
                  <input type="checkbox" :checked="p.enabled" :disabled="!!p.error || busyId === p.id || p.type === 'main'" @change="toggle(p)" />
                  <span />
                </label>
              </div>
              <div class="pl-id">{{ p.id }}</div>
              <div v-if="p.description" class="pl-desc">{{ p.description }}</div>
              <div v-if="p.error" class="pl-error">{{ p.error }}</div>
              <div class="pl-meta">
                <span v-if="p.author">作者 {{ p.author }}</span>
                <span v-if="p.license">{{ p.license }}</span>
                <span v-if="p.type === 'main'" class="warn">主进程插件暂未启用（P3）</span>
                <span v-for="perm in p.permissions" :key="perm" class="pl-perm">{{ perm }}</span>
              </div>
              <div class="pl-actions">
                <button v-if="p.type === 'renderer'" class="pl-btn" :disabled="!canOpen(p) || busyId === p.id" :title="canOpen(p) ? '打开插件面板' : '清单需要 ui.panel 权限' " @click="openPanel(p)">打开面板</button>
                <button class="pl-btn danger" :disabled="busyId === p.id" @click="uninstall(p)">卸载</button>
              </div>
            </section>
          </div>
        </div>

        <div v-else class="pl-body">
          <div class="pl-toolbar">
            <input v-model="registryUrl" class="pl-url" placeholder="registry.json 地址（https://… 或本地路径）" spellcheck="false" />
            <button class="pl-btn primary" :disabled="regLoading" @click="fetchRegistry">{{ regLoading ? '拉取中…' : '刷新仓库' }}</button>
            <button class="pl-btn" @click="tab = 'installed'">返回已安装</button>
          </div>
          <div class="pl-hint">仓库格式：`{ "plugins": [{ id, name, version, type, api, download, sha256, ... }] }`；download 支持 http(s) 或本地 zip 路径。</div>
          <div v-if="regError" class="pl-empty err">{{ regError }}</div>
          <div v-else-if="regLoading" class="pl-empty">读取 registry…</div>
          <div v-else-if="!registry.length" class="pl-empty">填地址后点「刷新仓库」。本地调试可直接填 registry.json 的绝对路径。</div>
          <div v-else class="pl-list">
            <section v-for="e in registry" :key="e.id" class="pl-item">
              <div class="pl-item-head">
                <div class="pl-name">{{ e.name }} <span class="pl-ver">v{{ e.version }}</span><span class="pl-type">{{ typeLabel(e.type) }}</span></div>
              </div>
              <div class="pl-id">{{ e.id }}</div>
              <div v-if="e.description" class="pl-desc">{{ e.description }}</div>
              <div class="pl-meta">
                <span v-if="e.author">作者 {{ e.author }}</span>
                <span v-if="e.api">API {{ e.api }}</span>
                <span v-if="e.license">{{ e.license }}</span>
              </div>
              <div class="pl-actions">
                <button class="pl-btn primary" :disabled="busyId === 'reg:' + e.id" @click="installRegistry(e)">{{ busyId === 'reg:' + e.id ? '安装中…' : '安装 / 更新' }}</button>
                <a v-if="e.homepage" class="pl-link" :href="e.homepage" target="_blank" rel="noreferrer">主页</a>
              </div>
            </section>
          </div>
        </div>
      </div>

      <!-- renderer 插件沙箱面板：iframe sandbox=allow-scripts，只能走 postMessage -->
      <div v-if="frame" class="pf-layer" @click.self="closeFrame()">
        <div class="pf-card">
          <header class="pf-head">
            <span class="pf-title">{{ frame.plugin.name }}</span>
            <span class="pf-type">{{ typeLabel(frame.plugin.type) }}</span>
            <span class="pf-perms">{{ (frame.plugin.permissions || []).join(' · ') }}</span>
            <button class="pl-x" title="关闭插件面板" @click="closeFrame()">✕</button>
          </header>
          <iframe ref="frameEl" class="pf-frame" :srcdoc="frame.html" sandbox="allow-scripts" @load="onFrameLoad" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.pl-layer { position: fixed; inset: 0; z-index: 950; display: flex; align-items: center; justify-content: center; background: rgba(20, 18, 14, 0.38); backdrop-filter: blur(3px); }
.pl-card { width: min(980px, 94vw); height: min(84vh, 900px); display: flex; flex-direction: column; background: var(--panel-strong); backdrop-filter: blur(var(--blur)) saturate(1.1); border: 1px solid var(--border); border-radius: 16px; box-shadow: var(--shadow-float); animation: pl-in 0.18s var(--ease-overshoot); overflow: hidden; }
@keyframes pl-in { from { opacity: 0; transform: translateY(10px) scale(0.98); } to { opacity: 1; transform: none; } }
.pl-head { display: flex; align-items: center; gap: 14px; padding: 14px 18px 12px; border-bottom: 1px solid var(--border); }
.pl-title { font-size: 16px; font-weight: 700; letter-spacing: 0.5px; }
.pl-api { margin-left: 8px; font-size: 10.5px; font-weight: 500; color: var(--text-2); letter-spacing: 0; }
.pl-tabs { display: flex; gap: 2px; padding: 3px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg); margin-right: auto; }
.pl-tabs button { border: none; background: transparent; color: var(--text-2); font-size: 11.5px; padding: 4px 10px; border-radius: 7px; cursor: pointer; }
.pl-tabs button:hover { color: var(--text); }
.pl-tabs button.on { background: var(--panel-strong); color: var(--text); font-weight: 600; box-shadow: var(--shadow); }
.pl-x { margin-left: 10px; width: 30px; height: 30px; border: none; border-radius: 9px; background: transparent; color: var(--text-2); font-size: 13px; cursor: pointer; }
.pl-x:hover { background: var(--accent-weak); color: var(--text); }
.pl-body { flex: 1; overflow-y: auto; padding: 12px 16px 8px; scrollbar-width: thin; }
.pl-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.pl-hint { font-size: 11px; color: var(--text-2); opacity: 0.85; }
.pl-url { flex: 1; min-width: 260px; height: 28px; border: 1px solid var(--border); border-radius: 7px; background: var(--panel-strong); color: var(--text); font-size: 11.5px; padding: 0 8px; outline: none; }
.pl-url:focus { border-color: var(--accent); }
.pl-btn { border: 1px solid var(--border); background: transparent; color: var(--text); padding: 6px 12px; border-radius: 8px; font-size: 11.5px; cursor: pointer; }
.pl-btn:hover:not(:disabled) { background: var(--accent-weak); border-color: var(--accent); color: var(--accent); }
.pl-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
.pl-btn.primary:disabled { opacity: 0.45; }
.pl-btn.danger { color: #c25a4d; border-color: rgba(194, 90, 77, 0.5); }
.pl-btn.danger:hover { background: rgba(194, 90, 77, 0.08); border-color: #c25a4d; color: #c25a4d; }
.pl-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.pl-empty { padding: 32px 10px; text-align: center; color: var(--text-2); font-size: 12.5px; line-height: 1.7; }
.pl-empty.err { color: #b4463b; }
.pl-list { display: flex; flex-direction: column; gap: 10px; padding-bottom: 8px; }
.pl-item { border: 1px solid var(--border); border-radius: 12px; background: var(--bg); padding: 11px 13px 12px; }
.pl-item.off { opacity: 0.72; }
.pl-item-head { display: flex; align-items: center; gap: 10px; }
.pl-name { display: flex; align-items: center; gap: 7px; font-size: 13.5px; font-weight: 600; min-width: 0; flex-wrap: wrap; }
.pl-ver { font-size: 10.5px; color: var(--text-2); font-weight: 500; }
.pl-type { font-size: 9.5px; padding: 1px 6px; border-radius: 5px; background: var(--accent-weak); color: var(--accent); border: 1px solid var(--accent); }
.pl-type.theme { background: rgba(120, 170, 120, 0.12); color: #5f9a6a; border-color: rgba(95, 154, 106, 0.5); }
.pl-type.main { background: rgba(194, 90, 77, 0.1); color: #b4463b; border-color: rgba(180, 70, 59, 0.45); }
.pl-errbadge { font-size: 9.5px; padding: 1px 6px; border-radius: 5px; background: rgba(194, 90, 77, 0.12); color: #b4463b; }
.pl-switch { margin-left: auto; position: relative; width: 34px; height: 18px; flex: none; }
.pl-switch input { position: absolute; opacity: 0; inset: 0; cursor: pointer; }
.pl-switch span { position: absolute; inset: 0; border-radius: 999px; background: var(--border); transition: background 0.18s; }
.pl-switch span::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform 0.18s var(--ease-overshoot); box-shadow: 0 1px 3px rgba(0,0,0,.3); }
.pl-switch input:checked + span { background: var(--accent); }
.pl-switch input:checked + span::after { transform: translateX(16px); }
.pl-switch input:disabled { cursor: not-allowed; }
.pl-id { margin-top: 3px; font-family: Consolas, monospace; font-size: 10.5px; color: var(--text-2); opacity: 0.8; }
.pl-desc { margin-top: 6px; font-size: 12px; color: var(--text); line-height: 1.55; }
.pl-error { margin-top: 6px; font-size: 11px; color: #b4463b; }
.pl-meta { margin-top: 7px; display: flex; gap: 6px; flex-wrap: wrap; font-size: 10.5px; color: var(--text-2); }
.pl-meta .warn { color: #b8862e; }
.pl-perm { padding: 1px 6px; border-radius: 5px; border: 1px solid var(--border); background: var(--panel-strong); font-family: Consolas, monospace; font-size: 10px; }
.pl-actions { margin-top: 9px; display: flex; gap: 8px; align-items: center; }
.pl-link { font-size: 11px; color: var(--accent); text-decoration: none; }
.pf-layer { position: fixed; inset: 0; z-index: 960; display: flex; align-items: center; justify-content: center; background: rgba(20, 18, 14, 0.35); backdrop-filter: blur(3px); }
.pf-card { width: min(760px, 86vw); height: min(70vh, 720px); display: flex; flex-direction: column; background: var(--panel-strong); border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow-float); overflow: hidden; animation: pl-in 0.18s var(--ease-overshoot); }
.pf-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
.pf-title { font-size: 13px; font-weight: 600; }
.pf-type { font-size: 10px; color: var(--accent); }
.pf-perms { font-size: 10px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pf-frame { flex: 1; width: 100%; border: none; background: var(--bg); }
</style>
