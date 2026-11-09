<script setup>
// 重复文件查找结果：精确 MD5 分组 / AI 相似分组（仅当前资料库）；默认不删，勾选后才可移入回收站
import { computed, ref } from 'vue'
import { useLibrary } from '../stores/library'
import { fileUrl } from '../api'
import { isTextPath, isVideoPath } from '../lib/fileKinds'

const lib = useLibrary()
const f = computed(() => lib.dupFinder)
const selectedSet = computed(() => new Set(f.value.selected))
const groups = computed(() => (f.value.mode === 'ai' ? f.value.ai.groups : f.value.groups))
const stats = computed(() => (f.value.mode === 'ai' ? f.value.ai.stats : f.value.stats))
const activeError = computed(() => (f.value.mode === 'ai' ? f.value.ai.error : f.value.error))
const activeLoading = computed(() => (f.value.mode === 'ai' ? f.value.ai.loading : f.value.loading))
const aiKey = ref('')

const scopeLabel = computed(() => {
  const root = lib.roots.find((r) => r.id === f.value.rootId)
  const name = root?.display_name || root?.name || String(root?.path || '').split('\\').pop() || '根文件'
  return f.value.rel ? `${name} / ${f.value.rel.replace(/\//g, ' / ')}` : `${name} · 全库`
})
const pct = computed(() => {
  const p = f.value.progress
  return p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0
})
const aiPct = computed(() => {
  const p = f.value.ai.progress
  return p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0
})
/* 费用/上传量粗估：384px 缩略图按 ~45KB、每对约 340 tokens（2×85 视觉 + 提示/输出）估；
   单价由用户自填（不同厂商/模型差异大，不内置价目表），只作量级参考 */
const aiEstimate = computed(() => {
  const pairs = Math.max(1, Math.min(200, Number(f.value.ai.maxPairs) || 40))
  const imgs = pairs * 2
  const mb = (imgs * 45) / 1024
  const tokens = pairs * 340
  let s = `最多 ${pairs} 对 · ≈ ${imgs} 张缩略图 / ${mb.toFixed(1)} MB`
  const price = Number(f.value.ai.pricePerM) || 0
  if (price > 0) {
    const cost = (tokens / 1e6) * price
    s += ` · ≈ ${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)} 元`
  }
  return s
})
const activePct = computed(() => (f.value.mode === 'ai' ? aiPct.value : pct.value))
const activeLoadingText = computed(() => {
  if (f.value.mode !== 'ai') {
    return f.value.progress.total ? `正在按内容比对 ${f.value.progress.done}/${f.value.progress.total}` : '正在按文件大小预筛…'
  }
  const p = f.value.ai.progress
  if (p.phase === 'hash') return p.total ? `分析缩略图 ${p.done}/${p.total}` : '准备缩略图…'
  if (p.phase === 'ai') return p.total ? `AI 比对 ${p.done}/${p.total} 对（候选 ${p.candidates || p.total} 对）` : 'AI 比对…'
  return '准备中…'
})
const selectedBytes = computed(() => {
  const sizes = new Map()
  for (const g of groups.value) for (const x of g.files) sizes.set(x.path, x.size)
  return f.value.selected.reduce((s, p) => s + (sizes.get(p) || 0), 0)
})
async function saveAi() {
  const r = await lib.saveAiConfig({
    baseUrl: f.value.ai.baseUrl,
    model: f.value.ai.model,
    apiKey: aiKey.value,
  })
  if (r?.ok) aiKey.value = ''
}

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
    <div v-if="f.open" class="df-layer">
      <div class="df-card">
        <header class="df-head">
          <div class="df-title">
            查找重复
            <span class="df-scope">{{ scopeLabel }}</span>
          </div>
          <div class="df-modes">
            <button :class="{ on: f.mode === 'exact' }" @click="lib.setDupMode('exact')">精确查重</button>
            <button :class="{ on: f.mode === 'ai' }" @click="lib.setDupMode('ai')">AI 查重</button>
          </div>
          <div v-if="stats && !activeLoading" class="df-stats">
            <b>{{ stats.groups }}</b> 组 · <b>{{ stats.files }}</b> 个文件 · 可省 <b>{{ fmtSize(stats.wasted) }}</b>
            <span v-if="f.mode === 'ai'" class="df-cap">（dHash {{ stats.dhashPairs ?? stats.candidates }} 对 → 本地预筛后 {{ stats.candidates }} 对，已查 {{ stats.checked }}<template v-if="stats.capped">；候选超出上限，只查最接近的 {{ stats.caps }} 对</template>）</span>
          </div>
          <button class="df-x" title="关闭（Esc）" @click="lib.closeDupFinder()">✕</button>
        </header>

        <div v-if="f.mode === 'ai'" class="ai-box">
          <div class="ai-grid">
            <label>API 地址<input v-model="f.ai.baseUrl" placeholder="https://api.openai.com/v1" spellcheck="false" /></label>
            <label>模型<input v-model="f.ai.model" list="picnest-ai-models" placeholder="gpt-4o-mini" spellcheck="false" /></label>
            <label>API Key<input v-model="aiKey" type="password" autocomplete="off" :placeholder="f.ai.hasKey ? '已保存（留空不改）' : 'sk-…'" /></label>
            <label class="ai-num">最多比对<input v-model.number="f.ai.maxPairs" type="number" min="1" max="200" /></label>
            <label class="ai-num">单价 ¥/1M tok<input v-model.number="f.ai.pricePerM" type="number" min="0" step="0.01" placeholder="可选" @change="lib.setAiPricePerM($event.target.value)" /></label>
          </div>
          <div class="ai-estimate">{{ aiEstimate }}</div>
          <datalist id="picnest-ai-models">
            <option v-for="m in f.ai.models" :key="m" :value="m" />
          </datalist>
          <div v-if="f.ai.modelsLoading || f.ai.modelsError || f.ai.models.length" class="ai-modelbar" :class="{ err: !!f.ai.modelsError }">
            <span v-if="f.ai.modelsLoading">正在获取模型列表…</span>
            <span v-else-if="f.ai.modelsError">{{ f.ai.modelsError }}</span>
            <span v-else>已获取 {{ f.ai.models.length }} 个模型，点「模型」输入框选择，或继续手填</span>
          </div>
          <label class="ai-allow">
            <input v-model="f.ai.allowed" type="checkbox" />
            <span>允许把候选缩略图发送到该 API（会产生调用费用；不上传原图）</span>
          </label>
          <div class="ai-actions">
            <button class="df-btn" :disabled="f.ai.testing" @click="saveAi">{{ f.ai.testing ? '测试中…' : '保存并测试' }}</button>
            <button class="df-btn" :disabled="f.ai.modelsLoading" @click="lib.fetchAiModels(aiKey)">{{ f.ai.modelsLoading ? '获取中…' : '获取模型' }}</button>
            <button class="df-btn primary" :disabled="f.ai.loading || f.ai.testing || !f.ai.hasKey || !f.ai.allowed" @click="lib.aiFindDuplicates()">开始 AI 查重</button>
            <span v-if="f.ai.note" class="ai-note" :class="{ err: f.ai.noteErr }">{{ f.ai.note }}</span>
          </div>
          <div class="ai-hint">OpenAI 兼容 /chat/completions + /models，模型需支持图片输入。先本地 dHash 缩圈，再用 32×32 色块 + pHash 预筛（dHash≤4 的强结构对直接保留），最后把候选缩略图交给 AI 确认；AI 阶段 4 路并发，最多检查 {{ f.ai.maxPairs }} 对。</div>
          <div class="ai-risk">注意：图片可能因暴露度较高或不符合所选 AI 的使用准则而被服务商拒绝/弹回；请自行甄别素材并确认该服务条款。</div>
        </div>

        <div v-if="!activeLoading && groups.length" class="df-bulk">
          <span class="df-bulk-label">一键保留</span>
          <button class="df-bulk-btn" title="每组保留最大的文件，其余全部勾选" @click="lib.dupKeepAll('largest')">最大</button>
          <button class="df-bulk-btn" title="每组保留最新的文件，其余全部勾选" @click="lib.dupKeepAll('newest')">最新</button>
          <button class="df-bulk-btn" title="每组保留最旧的文件，其余全部勾选" @click="lib.dupKeepAll('oldest')">最旧</button>
          <label class="df-bulk-ext" title="jpg/jpeg 视为同一后缀；开启后每组每种后缀各保留一张">
            <input type="checkbox" :checked="f.preserveExt" @change="lib.setDupPreserveExt($event.target.checked)" />
            <span>不同后缀各保留一张</span>
          </label>
          <span class="df-bulk-hint">会覆盖当前勾选</span>
        </div>

        <div v-if="activeLoading" class="df-loading">
          <div class="df-spin" />
          <div class="df-progress"><i :style="{ width: activePct + '%' }" /></div>
          <div class="df-ptext">{{ activeLoadingText }}</div>
          <button
            class="df-btn"
            :disabled="f.mode === 'ai' ? f.ai.canceling : f.canceling"
            @click="f.mode === 'ai' ? lib.aiCancel() : lib.dupCancel()"
          >{{ (f.mode === 'ai' ? f.ai.canceling : f.canceling) ? '停止中…' : '停止' }}</button>
        </div>

        <div v-else-if="activeError" class="df-empty">{{ activeError }}</div>
        <div v-else-if="!groups.length" class="df-empty">
          {{ f.mode === 'ai' ? '没有发现相似图片' : (f.canceled ? '已停止扫描' : '没有发现重复文件') }}
          <span v-if="stats">（扫描 {{ stats.scopes }} 个文件）</span>
        </div>

        <div v-else class="df-list">
          <section v-for="(g, gi) in groups" :key="g.hash" class="df-group">
            <div class="df-ghead">
              <span class="df-gtitle"><em v-if="g.ai" class="df-ai-badge">AI</em>{{ g.count }} 个{{ g.ai ? '相似' : '重复' }} <em>· 可省 {{ fmtSize(g.wasted) }}</em></span>
              <div class="df-quick">
                <button v-if="f.mode === 'ai'" @click="lib.dupKeep(gi, 'largest')">保留最大</button>
                <button v-else @click="lib.dupKeep(gi, 'first')">保留第一张</button>
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
                  <span class="df-name" :title="file.path">{{ lib.dispName(file.name) }}</span>
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
.df-stats { margin-left: 0; font-size: 12px; color: var(--text-2); }
.df-stats b { color: var(--text); font-weight: 600; }
.df-cap { margin-left: 6px; font-size: 10.5px; color: var(--text-2); }
.df-modes {
  display: flex; gap: 2px; padding: 3px; margin-right: auto;
  border: 1px solid var(--border); border-radius: 9px; background: var(--bg);
}
.df-modes button {
  border: none; background: transparent; color: var(--text-2);
  font-size: 11.5px; padding: 4px 10px; border-radius: 7px; cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.df-modes button:hover { color: var(--text); }
.df-modes button.on { background: var(--panel-strong); color: var(--text); font-weight: 600; box-shadow: var(--shadow); }
.df-ai-badge {
  display: inline-block; margin-right: 6px; padding: 1px 5px; border-radius: 5px;
  background: var(--accent-weak); color: var(--accent); font-size: 10px;
  font-style: normal; font-weight: 700; vertical-align: 1px;
}
.ai-box {
  flex: none; margin: 10px 16px 0; padding: 10px 12px;
  border: 1px solid var(--border); border-radius: 12px; background: var(--bg);
}
.ai-grid { display: grid; grid-template-columns: 1.2fr 1fr 1.2fr 104px 132px; gap: 8px; }
.ai-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 10.5px; color: var(--text-2); }
.ai-grid input {
  height: 28px; border: 1px solid var(--border); border-radius: 7px;
  background: var(--panel-strong); color: var(--text); font-size: 11.5px;
  padding: 0 8px; outline: none; min-width: 0;
}
.ai-grid input:focus { border-color: var(--accent); }
.ai-num input { width: 100%; }
.ai-estimate { margin-top: 7px; font-size: 10.5px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.ai-allow { display: flex; align-items: flex-start; gap: 6px; margin-top: 8px; font-size: 11px; color: var(--text-2); line-height: 1.5; cursor: pointer; }
.ai-modelbar { margin-top: 6px; font-size: 10.5px; line-height: 1.5; color: var(--text-2); }
.ai-modelbar.err { color: #b4463b; }
.ai-allow input { accent-color: var(--accent); margin-top: 1px; }
.ai-actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.ai-note { font-size: 11px; color: #4f7d5e; }
.ai-note.err { color: #b4463b; }
.ai-hint { margin-top: 7px; font-size: 10.5px; line-height: 1.5; color: var(--text-2); opacity: 0.85; }
.ai-risk { margin-top: 5px; font-size: 10.5px; line-height: 1.5; color: #b8862e; }
.df-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
.df-btn.primary:disabled { opacity: 0.45; }
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
.df-bulk {
  flex: none; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 10px 16px 0; padding: 8px 10px; border: 1px solid var(--border);
  border-radius: 10px; background: var(--bg);
}
.df-bulk-label { font-size: 11px; color: var(--text-2); }
.df-bulk-btn {
  height: 26px; padding: 0 10px; border: 1px solid var(--border); border-radius: 7px;
  background: var(--panel-strong); color: var(--text); font-size: 11px; cursor: pointer;
}
.df-bulk-btn:hover { border-color: var(--accent); color: var(--accent); }
.df-bulk-ext { display: flex; align-items: center; gap: 6px; margin-left: 4px; font-size: 11px; color: var(--text-2); cursor: pointer; }
.df-bulk-ext input { accent-color: var(--accent); }
.df-bulk-hint { margin-left: auto; font-size: 10.5px; color: var(--text-2); opacity: 0.8; }
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
