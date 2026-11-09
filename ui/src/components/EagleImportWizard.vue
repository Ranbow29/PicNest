<script setup>
// 根文件 ⌂ 选中 Eagle .library 时的迁移向导：预览 → 复制 → 索引 → 元数据/标签 → 完成
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { useLibrary } from '../stores/library'

const props = defineProps({ info: { type: Object, required: true } })
const emit = defineEmits(['close'])
const lib = useLibrary()
const phase = ref('preview')
const progress = ref({ done: 0, total: 0, gb: 0, sec: 0 })
const error = ref('')
const doneStats = ref(null)
const doneRootId = ref(null)
const canceling = ref(false)
const running = computed(() => ['copy', 'thumbs', 'index', 'meta'].includes(phase.value))
const busy = computed(() => running.value || canceling.value)
const progressPct = computed(() => {
  const p = progress.value
  return p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0
})
const phaseLabel = computed(() => {
  if (phase.value === 'copy') return '正在复制 Eagle 文件'
  if (phase.value === 'thumbs') return '正在准备缩略图'
  if (phase.value === 'index') return '正在建立 PicNest 索引'
  if (phase.value === 'meta') return '正在导入标签与元数据'
  if (phase.value === 'done') return '导入完成'
  if (phase.value === 'error') return '导入失败'
  return '确认导入'
})
const targetTaken = computed(() => !!props.info.targetExists && !props.info.existingRootId)
const copySize = computed(() => {
  const b = Number(props.info.copyBytes) || 0
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB'
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB'
  if (b >= 1024) return Math.round(b / 1024) + ' KB'
  return b + ' B'
})

function onProgress(d) {
  if (!running.value) return
  if (d?.phase) phase.value = d.phase
  progress.value = {
    done: Number(d?.done) || 0,
    total: Number(d?.total) || 0,
    gb: Number(d?.gb) || 0,
    sec: Number(d?.sec) || 0,
  }
}
onMounted(() => window.picrand?.onPicnestEagleProgress?.(onProgress))
onBeforeUnmount(() => { /* preload listener 无 off；running 守卫避免卸载后写状态 */ })

function findRoot() {
  const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase()
  return lib.roots.find((r) => norm(r.path) === norm(props.info.targetRoot)) || null
}
function openExisting() {
  const id = props.info.existingRootId || doneRootId.value
  if (id) lib.switchRoot(id)
  emit('close')
}
async function start() {
  if (busy.value || targetTaken.value) return
  error.value = ''
  doneStats.value = null
  progress.value = { done: 0, total: 0, gb: 0, sec: 0 }
  phase.value = 'copy'
  try {
    const copy = await window.picrand.picnestEagleCopy({ library: props.info.library, targetRoot: props.info.targetRoot })
    if (!copy?.ok) {
      if (copy?.canceled) error.value = '已取消。目标目录可能保留半成品，需手动删除后再试。'
      else error.value = copy?.error || '复制失败'
      phase.value = 'error'
      return
    }
    phase.value = 'index'
    await lib.addRootByPath(props.info.targetRoot)
    let root = findRoot()
    if (!root) {
      error.value = lib.error || '索引完成但找不到新根'
      phase.value = 'error'
      return
    }
    // 同名根只改显示名区分，物理目录保持 <库名>
    const dupe = lib.roots.some((r) => r.id !== root.id && r.display_name === root.display_name)
    if (dupe) {
      await lib.renameLibrary(root.id, root.display_name + '（Eagle）', { displayOnly: true })
      root = findRoot() || root
    }
    phase.value = 'meta'
    const fin = await window.picrand.picnestEagleFinish({ manifestPath: copy.manifestPath, rootId: root.id })
    if (!fin?.ok) {
      error.value = fin?.error || '元数据导入失败'
      phase.value = 'error'
      return
    }
    await lib.refreshTags()
    doneRootId.value = root.id
    doneStats.value = fin
    phase.value = 'done'
  } catch (e) {
    error.value = String(e?.message || e)
    phase.value = 'error'
  }
}
async function cancel() {
  if (!running.value || canceling.value) return
  if (!['copy', 'thumbs'].includes(phase.value)) return
  canceling.value = true
  try { await window.picrand.picnestEagleCancel() } catch { /* 静默 */ }
}
function close() {
  if (busy.value) return
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div class="eg-layer" @click.self="close">
      <div class="eg-card">
        <header class="eg-head">
          <div>
            <div class="eg-title">导入 Eagle 库</div>
            <div class="eg-sub">从根文件进入 · 只读源库 · 完整复制</div>
          </div>
          <button class="eg-x" :disabled="busy" title="关闭" @click="close">✕</button>
        </header>

        <div class="eg-body">
          <div class="eg-path">
            <span>源库</span><b :title="info.library">{{ info.library }}</b>
          </div>
          <div class="eg-path">
            <span>目标</span><b :title="info.targetRoot">{{ info.targetRoot }}</b>
          </div>

          <div class="eg-grid">
            <div><em>图片</em><b>{{ Number(info.items || 0).toLocaleString() }}</b></div>
            <div><em>复制大小</em><b>{{ copySize }}</b></div>
            <div><em>文件夹</em><b>{{ info.folders }}</b></div>
            <div><em>重名处理</em><b>{{ info.conflicts }}</b></div>
            <div><em>未归类</em><b>{{ info.unfiled }}</b></div>
            <div><em>失效引用</em><b>{{ info.missingFolderRefs }}</b></div>
            <div><em>标签 / URL</em><b>{{ info.uniqueTags }} / {{ info.urlItems }}</b></div>
            <div><em>可用空间</em><b>{{ info.freeGB }} GB</b></div>
          </div>

          <div v-if="info.existingRootId" class="eg-warn ok">
            这个 Eagle 库已经导入过：{{ info.existingRootName || info.targetRoot }}
          </div>
          <div v-else-if="targetTaken" class="eg-warn err">
            目标目录已存在且不是 PicNest 根，向导不会覆盖。请先删除或改名：{{ info.targetRoot }}
          </div>
          <div v-else class="eg-warn">
            会完整复制 {{ copySize }} 到目标目录；Eagle 原库不会被修改。多文件夹条目每个有效文件夹各一份；PDF 会复制但不索引。
          </div>

          <div v-if="running" class="eg-progress">
            <div class="eg-phase">{{ phaseLabel }}</div>
            <div class="eg-bar"><i :style="{ width: progressPct + '%' }" /></div>
            <div class="eg-detail">
              <span v-if="phase === 'copy'">{{ progress.done }}/{{ progress.total }} · {{ progress.gb }} GB · {{ progress.sec }}s</span>
              <span v-else-if="phase === 'thumbs'">{{ progress.done }}/{{ progress.total }} 张</span>
              <span v-else-if="phase === 'index'">首次索引 1 万多张，稍等…</span>
              <span v-else-if="phase === 'meta'">{{ progress.done }}/{{ progress.total }} 条</span>
            </div>
          </div>

          <div v-if="error" class="eg-warn err">{{ error }}</div>

          <div v-if="phase === 'done' && doneStats" class="eg-warn ok">
            已导入 {{ doneStats.found }} 个路径 · {{ doneStats.tags }} 个标签 · {{ doneStats.tagsLinked }} 条标签关联
            <span v-if="doneStats.missing"> · {{ doneStats.missing }} 个未索引（PDF 等）</span>
          </div>
        </div>

        <footer class="eg-foot">
          <button v-if="info.existingRootId && phase === 'preview'" class="eg-btn" @click="openExisting">打开已有根</button>
          <button v-if="running && ['copy','thumbs'].includes(phase)" class="eg-btn danger" :disabled="canceling" @click="cancel">{{ canceling ? '取消中…' : '取消导入' }}</button>
          <span class="eg-spacer" />
          <button v-if="phase !== 'done'" class="eg-btn" :disabled="busy" @click="close">取消</button>
          <button v-if="!info.existingRootId && !targetTaken && !running && phase !== 'done'" class="eg-btn primary" @click="start">开始导入</button>
          <button v-if="phase === 'done'" class="eg-btn primary" @click="openExisting">打开新库</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.eg-layer {
  position: fixed; inset: 0; z-index: 900;
  background: rgba(12, 11, 16, 0.42); backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
}
.eg-card {
  width: min(600px, 92vw); max-height: 86vh; display: flex; flex-direction: column;
  background: var(--panel-strong); border: 1px solid var(--border); border-radius: 16px;
  box-shadow: var(--shadow); overflow: hidden;
}
.eg-head { display: flex; align-items: flex-start; justify-content: space-between; padding: 16px 18px 12px; border-bottom: 1px solid var(--border); }
.eg-title { font-size: 16px; font-weight: 700; color: var(--text); }
.eg-sub { margin-top: 4px; font-size: 11px; color: var(--text-2); }
.eg-x { width: 30px; height: 30px; border: none; border-radius: 8px; background: transparent; color: var(--text-2); cursor: pointer; font-size: 13px; }
.eg-x:hover:not(:disabled) { background: var(--accent-weak); color: var(--text); }
.eg-x:disabled { opacity: 0.35; cursor: default; }
.eg-body { padding: 14px 18px; overflow-y: auto; scrollbar-width: thin; }
.eg-path { display: flex; gap: 8px; margin-bottom: 8px; font-size: 11px; color: var(--text-2); }
.eg-path span { flex: none; width: 34px; }
.eg-path b { min-width: 0; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.eg-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; margin: 12px 0; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: var(--border); }
.eg-grid > div { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; background: var(--bg); }
.eg-grid em { font-style: normal; font-size: 10px; color: var(--text-2); }
.eg-grid b { font-size: 13px; font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
.eg-warn { margin-top: 10px; padding: 9px 11px; border-radius: 9px; background: var(--bg-2); color: var(--text-2); font-size: 11.5px; line-height: 1.55; }
.eg-warn.ok { border: 1px solid rgba(79, 125, 94, 0.35); color: #4f7d5e; }
.eg-warn.err { border: 1px solid rgba(180, 70, 59, 0.35); color: #b4463b; }
.eg-progress { margin-top: 12px; padding: 10px 11px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg); }
.eg-phase { font-size: 12px; color: var(--text); margin-bottom: 7px; }
.eg-bar { height: 4px; border-radius: 2px; background: var(--border); overflow: hidden; }
.eg-bar i { display: block; height: 100%; background: var(--accent); border-radius: 2px; transition: width 0.2s ease; }
.eg-detail { margin-top: 7px; font-size: 10.5px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.eg-foot { display: flex; align-items: center; gap: 8px; padding: 12px 18px 14px; border-top: 1px solid var(--border); }
.eg-spacer { flex: 1; }
.eg-btn { height: 30px; padding: 0 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2); color: var(--text); font-size: 12px; cursor: pointer; }
.eg-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.eg-btn:disabled { opacity: 0.5; cursor: default; }
.eg-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
.eg-btn.danger { color: #b4463b; border-color: rgba(180, 70, 59, 0.4); }
</style>
