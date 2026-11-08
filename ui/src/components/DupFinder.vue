<script setup>
// 重复文件查找结果：按内容 MD5 分组（仅当前资料库）；默认不删，勾选后才可移入回收站
import { computed } from 'vue'
import { useLibrary } from '../stores/library'
import { fileUrl } from '../api'
import { isTextPath, isVideoPath } from '../lib/fileKinds'

const lib = useLibrary()
const f = computed(() => lib.dupFinder)
const selectedSet = computed(() => new Set(f.value.selected))

const scopeLabel = computed(() => {
  const root = lib.roots.find((r) => r.id === f.value.rootId)
  const name = root?.display_name || root?.name || String(root?.path || '').split('\\').pop() || '根文件'
  return f.value.rel ? `${name} / ${f.value.rel.replace(/\//g, ' / ')}` : `${name} · 全库`
})
const pct = computed(() => {
  const p = f.value.progress
  return p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0
})
const selectedBytes = computed(() => {
  const sizes = new Map()
  for (const g of f.value.groups) for (const x of g.files) sizes.set(x.path, x.size)
  return f.value.selected.reduce((s, p) => s + (sizes.get(p) || 0), 0)
})

const fmtSize = (n) => {
  if (!n) return '0 B'
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB'
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'
  if (n >= 1024) return Math.round(n / 1024) + ' KB'
  return n + ' B'
}
const fmtDate = (ms) => {
  if (!ms) return '—'
  const d = new Date(ms > 1e12 ? ms : ms * 1000)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const extLabel = (p) => String(p || '').split('.').pop().toUpperCase()
function thumbOf(file) {
  if (file.thumb && file.thumb !== 'SKIP') return fileUrl(file.thumb)
  if (isTextPath(file.path) || isVideoPath(file.path)) return ''
  return fileUrl(file.path)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="f.open" class="df-layer" @click.self="lib.closeDupFinder()">
      <div class="df-card">
        <header class="df-head">
          <div class="df-title">
            查找重复
            <span class="df-scope">{{ scopeLabel }}</span>
          </div>
          <div v-if="f.stats && !f.loading" class="df-stats">
            <b>{{ f.stats.groups }}</b> 组 · <b>{{ f.stats.files }}</b> 个文件 · 可省 <b>{{ fmtSize(f.stats.wasted) }}</b>
          </div>
          <button class="df-x" title="关闭（Esc）" @click="lib.closeDupFinder()">✕</button>
        </header>

        <div v-if="f.loading" class="df-loading">
          <div class="df-spin" />
          <div class="df-progress"><i :style="{ width: pct + '%' }" /></div>
          <div class="df-ptext">
            {{ f.progress.total ? `正在按内容比对 ${f.progress.done}/${f.progress.total}` : '正在按文件大小预筛…' }}
          </div>
        </div>

        <div v-else-if="f.error" class="df-empty">{{ f.error }}</div>
        <div v-else-if="!f.groups.length" class="df-empty">
          没有发现重复文件
          <span v-if="f.stats">（扫描 {{ f.stats.scopes }} 个文件）</span>
        </div>

        <div v-else class="df-list">
          <section v-for="(g, gi) in f.groups" :key="g.hash" class="df-group">
            <div class="df-ghead">
              <span class="df-gtitle">{{ g.count }} 个重复 <em>· 可省 {{ fmtSize(g.wasted) }}</em></span>
              <div class="df-quick">
                <button @click="lib.dupKeep(gi, 'first')">保留第一张</button>
                <button @click="lib.dupKeep(gi, 'newest')">保留最新</button>
                <button @click="lib.dupKeep(gi, 'oldest')">保留最旧</button>
              </div>
            </div>
            <div class="df-files">
              <label v-for="file in g.files" :key="file.path" class="df-file" :class="{ sel: selectedSet.has(file.path) }">
                <input type="checkbox" :checked="selectedSet.has(file.path)" @change="lib.toggleDupSelected(file.path)" />
                <span class="df-thumb">
                  <img v-if="thumbOf(file)" :src="thumbOf(file)" loading="lazy" draggable="false" />
                  <b v-else>{{ extLabel(file.path) }}</b>
                </span>
                <span class="df-meta">
                  <span class="df-name" :title="file.path">{{ file.name }}</span>
                  <span class="df-dir" :title="file.path">{{ file.rel || '库根' }}</span>
                  <span class="df-sub">{{ fmtSize(file.size) }} · {{ fmtDate(file.mtime) }}</span>
                </span>
              </label>
            </div>
          </section>
        </div>

        <footer class="df-foot">
          <span class="df-selcount">已选 <b>{{ selectedSet.size }}</b> 张{{ selectedBytes ? ' · ' + fmtSize(selectedBytes) : '' }}</span>
          <span class="df-tip">只删勾选的；未勾选的保持不动</span>
          <span class="df-spacer" />
          <button class="df-btn" @click="lib.closeDupFinder()">取消</button>
          <button class="df-btn danger" :disabled="!selectedSet.size" @click="lib.applyDupTrash()">移入回收站</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.df-layer {
  position: fixed; inset: 0; z-index: 940;
  display: flex; align-items: center; justify-content: center;
  background: rgba(20, 18, 14, 0.38); backdrop-filter: blur(3px);
}
.df-card {
  width: min(1080px, 94vw); height: min(84vh, 900px);
  display: flex; flex-direction: column;
  background: var(--panel-strong); backdrop-filter: blur(var(--blur)) saturate(1.1);
  border: 1px solid var(--border); border-radius: 16px;
  box-shadow: var(--shadow-float);
  animation: df-in 0.18s var(--ease-overshoot);
  overflow: hidden;
}
@keyframes df-in { from { opacity: 0; transform: translateY(10px) scale(0.98); } to { opacity: 1; transform: none; } }
.df-head {
  display: flex; align-items: center; gap: 14px; padding: 14px 18px 12px;
  border-bottom: 1px solid var(--border);
}
.df-title { font-size: 16px; font-weight: 700; letter-spacing: 0.5px; }
.df-scope { margin-left: 10px; font-size: 12px; font-weight: 500; color: var(--text-2); letter-spacing: 0; }
.df-stats { margin-left: auto; font-size: 12px; color: var(--text-2); }
.df-stats b { color: var(--text); font-weight: 600; }
.df-x {
  margin-left: 10px; width: 30px; height: 30px; border: none; border-radius: 9px;
  background: transparent; color: var(--text-2); font-size: 13px; cursor: pointer;
}
.df-x:hover { background: var(--accent-weak); color: var(--text); }
.df-loading { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; }
.df-spin {
  width: 26px; height: 26px; border-radius: 50%;
  border: 2px solid var(--border); border-top-color: var(--accent);
  animation: df-spin 0.8s linear infinite;
}
@keyframes df-spin { to { transform: rotate(360deg); } }
.df-progress { width: min(360px, 60%); height: 4px; border-radius: 2px; background: var(--border); overflow: hidden; }
.df-progress i { display: block; height: 100%; background: var(--accent); border-radius: 2px; transition: width 0.2s ease; }
.df-ptext { font-size: 12px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.df-empty { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--text-2); font-size: 13px; }
.df-empty span { margin-left: 4px; font-size: 12px; }
.df-list { flex: 1; overflow-y: auto; padding: 12px 16px 8px; scrollbar-width: thin; }
.df-group { border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px 12px; margin-bottom: 12px; background: var(--bg); }
.df-ghead { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.df-gtitle { font-size: 12.5px; font-weight: 600; }
.df-gtitle em { font-style: normal; font-weight: 400; color: var(--text-2); }
.df-quick { display: flex; gap: 6px; margin-left: auto; }
.df-quick button {
  border: 1px solid var(--border); background: transparent; color: var(--text-2);
  border-radius: 7px; font-size: 11px; padding: 3px 8px; cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.df-quick button:hover { background: var(--accent-weak); color: var(--accent); border-color: var(--accent); }
.df-files { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 8px; }
.df-file {
  display: flex; align-items: center; gap: 9px; min-width: 0;
  padding: 7px 9px; border: 1px solid var(--border); border-radius: 9px;
  background: var(--panel); cursor: pointer;
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
}
.df-file:hover { border-color: var(--accent); }
.df-file.sel { border-color: #c25a4d; background: rgba(194, 90, 77, 0.07); box-shadow: inset 0 0 0 1px rgba(194, 90, 77, 0.25); }
.df-file input { accent-color: #c25a4d; flex: none; cursor: pointer; }
.df-thumb {
  width: 52px; height: 52px; flex: none; border-radius: 7px; overflow: hidden;
  background: var(--bg-2); border: 1px solid var(--border);
  display: flex; align-items: center; justify-content: center;
}
.df-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.df-thumb b { font-family: Consolas, monospace; font-size: 10px; color: var(--text-2); letter-spacing: 0.5px; }
.df-meta { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.df-name { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.df-dir { font-size: 11px; color: var(--accent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.df-sub { font-size: 10.5px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.df-foot {
  display: flex; align-items: center; gap: 12px; padding: 11px 18px;
  border-top: 1px solid var(--border); font-size: 12px; color: var(--text-2);
}
.df-selcount b { color: var(--text); }
.df-tip { font-size: 11px; opacity: 0.75; }
.df-spacer { flex: 1; }
.df-btn {
  border: 1px solid var(--border); background: transparent; color: var(--text);
  padding: 7px 16px; border-radius: 9px; font-size: 12.5px; cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.df-btn:hover { background: var(--accent-weak); border-color: var(--accent); }
.df-btn.danger { background: #c25a4d; border-color: #c25a4d; color: #fff; font-weight: 600; }
.df-btn.danger:hover { filter: brightness(1.05); }
.df-btn:disabled { opacity: 0.4; cursor: not-allowed; background: transparent; color: var(--text-2); border-color: var(--border); }
</style>
