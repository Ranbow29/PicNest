<script setup>
import { computed, ref, watch } from 'vue'
import { useLibrary } from '../stores/library'
import { fileUrl } from '../api'

// Eagle 式重复添加提示：已存在 vs 新的文件 对比卡
// files = 拖入图片冲突（二选一）；merge = 文件夹放入时库内查重（三选一：跳过旧/覆盖旧/都保留）
const lib = useLibrary()
const dlg = computed(() => lib.dupDialog)
const mode = computed(() => dlg.value.mode || 'files')
const count = computed(() => dlg.value.count || dlg.value.items.length)
const choice = ref('use-existing')
const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(0) + 'KB' : (n / 1024).toFixed(0) + 'KB')
watch(() => dlg.value.open, (v) => { if (v) choice.value = 'use-existing' })

function confirm() {
  lib.resolveDupDialog(choice.value)
}
function dismiss() {
  lib.resolveDupDialog('use-existing') // 关掉 = 不重复录入
}
</script>

<template>
  <Teleport to="body">
    <div v-if="dlg.open" class="dup-layer" @click.self="dismiss">
      <div class="dup-card glass-card">
        <div class="head">
          <b>{{ mode === 'merge' ? `文件夹内有 ${count} 张重复图片` : '重复添加提示' }}</b>
          <button class="close" @click="dismiss">✕</button>
        </div>
        <div v-if="mode === 'merge'" class="merge-note">这些图片在根文件其他位置已存在，选择处理方式：</div>
        <div class="pairs">
          <div v-for="(c, i) in dlg.items" :key="i" class="pair">
            <div class="side exist">
              <div class="thumb">
                <img :src="fileUrl(c.existing.file_path)" loading="lazy" draggable="false" />
                <span class="tag">已存在</span>
              </div>
              <div class="name" :title="c.existing.file_name">{{ lib.dispName(c.existing.file_name) }}</div>
              <div class="meta">{{ c.existing.width || '—' }} × {{ c.existing.height || '—' }} / {{ fmtSize(c.size) }}</div>
              <div class="folder">{{ c.existing.folderName }}</div>
            </div>
            <div class="side new">
              <div class="thumb dim">
                <img :src="fileUrl(c.path)" loading="lazy" draggable="false" />
                <span class="tag blue">新的文件</span>
              </div>
              <div class="name" :title="c.name">{{ lib.dispName(c.name) }}</div>
              <div class="meta">{{ fmtSize(c.size) }}</div>
              <div class="folder">{{ dlg.targetRel ? lib.dispName(dlg.targetRel.split('/').pop()) : '当前目录' }}</div>
            </div>
          </div>
        </div>
        <div v-if="count > dlg.items.length" class="more-note">仅显示前 {{ dlg.items.length }} 组，处理方式会应用到全部 {{ count }} 张</div>
        <div class="foot">
          <label class="radio"><input type="radio" value="use-existing" v-model="choice" />
            {{ mode === 'merge' ? '只保留旧位置（跳过新文件夹里的重复图）' : '使用已存在文件导入' }}
          </label>
          <label v-if="mode === 'merge'" class="radio"><input type="radio" value="use-new" v-model="choice" />
            覆盖到新文件夹（旧图移入回收站）
          </label>
          <label class="radio"><input type="radio" value="keep-both" v-model="choice" />
            {{ mode === 'merge' ? '两个文件夹都保留' : '保留两者' }}
          </label>
          <button class="go" @click="confirm">{{ mode === 'merge' ? '应用' : '导入文件' }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.dup-layer { position: fixed; inset: 0; z-index: 800; background: rgba(12, 11, 16, 0.6); backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; }
.glass-card {
  width: min(880px, 92vw); max-height: 86vh; display: flex; flex-direction: column;
  background: var(--panel-strong); backdrop-filter: blur(var(--blur));
  border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow);
}
.head { display: flex; align-items: center; padding: 14px 18px; border-bottom: 1px solid var(--border); }
.head b { font-size: 14px; }
.close { margin-left: auto; border: none; background: transparent; color: var(--text-2); font-size: 14px; cursor: pointer; }
.close:hover { color: var(--text); }
.merge-note { padding: 10px 18px 0; font-size: 12px; color: var(--text-2); }
.more-note { padding: 0 18px 10px; font-size: 11px; color: var(--text-2); }
.pairs { flex: 1; overflow-y: auto; padding: 14px 18px; display: flex; flex-direction: column; gap: 16px; }
.pairs::-webkit-scrollbar { width: 6px; }
.pairs::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.pair { display: flex; gap: 18px; justify-content: center; }
.side { width: 300px; text-align: center; }
.thumb { position: relative; height: 220px; border-radius: 10px; overflow: hidden; background: var(--bg-2); border: 1px solid var(--border); }
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.thumb.dim img { opacity: 0.45; }
.tag {
  position: absolute; top: 42%; left: 50%; transform: translate(-50%, -50%);
  padding: 3px 12px; border-radius: 6px; font-size: 12px;
  background: rgba(0, 0, 0, 0.55); color: #fff;
}
.tag.blue { background: var(--accent); color: #fff; }
.name { margin-top: 8px; font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { font-size: 11.5px; color: var(--text-2); margin-top: 3px; font-variant-numeric: tabular-nums; }
.folder {
  display: inline-block; margin-top: 6px; padding: 3px 10px; border-radius: 7px;
  background: var(--accent-weak); color: var(--accent); font-size: 11px;
}
.foot { display: flex; align-items: center; flex-wrap: wrap; gap: 14px 18px; padding: 12px 18px; border-top: 1px solid var(--border); }
.radio { display: flex; align-items: center; gap: 6px; font-size: 12.5px; cursor: pointer; }
.radio input { accent-color: var(--accent); }
.go {
  margin-left: auto; border: none; border-radius: 9px;
  background: var(--accent); color: #fff; font-size: 13px; font-weight: 600;
  padding: 9px 22px; cursor: pointer; transition: filter 0.15s;
}
.go:hover { filter: brightness(1.08); }
</style>
