<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useLibrary } from '../stores/library'
import { fileUrl, api } from '../api'
import { isTextPath, isVideoPath, extOf } from '../lib/fileKinds'
import CanvasStage from './CanvasStage.vue'

// 大图工作区：正文内的编辑舞台（顶栏由 TitleBar 按模式变形；底部悬浮工具条 ZCode 输入口风格）
const lib = useLibrary()
const V = computed(() => lib.viewer)
const stageEl = ref(null)
const imgEl = ref(null)
const dragging = ref(false)
/* 灯箱平移：拖动期间每帧最多一次 rAF，普通模式直接改 img.style.transform（不走 Pinia 响应式），
   松手才把最终 tx/ty 写回 store；裁剪模式仍逐帧写 store 以便裁剪框跟随。 */
const pan = { active: false, startX: 0, startY: 0, baseTx: 0, baseTy: 0, curTx: 0, curTy: 0, raf: 0 }
function stageTransform(tx, ty) {
  return `translate3d(${tx}px, ${ty}px, 0) scale(${lib.viewer.scale}) rotate(${lib.viewer.rot}deg)`
    + (lib.viewer.flopX ? ' scaleX(-1)' : '')
}
function applyPan(tx, ty) {
  if (canvasMode.value && canvasStage.value?.drawAt) {
    canvasStage.value.drawAt(tx, ty, lib.viewer.scale)
    return
  }
  const el = imgEl.value
  if (el) el.style.transform = stageTransform(tx, ty)
}
function commitPan() {
  if (!pan.active) return
  if (pan.raf) { cancelAnimationFrame(pan.raf); pan.raf = 0 }
  pan.active = false
  dragging.value = false
  lib.viewer.tx = pan.curTx
  lib.viewer.ty = pan.curTy
}

const meta = computed(() => lib.images.find((i) => i.file_path === lib.lightbox.path) || null)
const kind = computed(() => {
  const p = lib.lightbox.path
  return isVideoPath(p) ? 'video' : isTextPath(p) ? 'text' : 'image'
})
const url = computed(() => {
  const img = meta.value
  if (!img?.file_path) return ''
  const base = fileUrl(img.file_path)
  /* 图片/视频带版本号：保存旋转/翻转后同一路径能强制刷新 */
  return kind.value === 'text' ? base : base + '?v=' + (img.modify_time || 0)
})
const fileName = computed(() => String(lib.lightbox.path || '').split(/[\\/]/).pop())
const hasTransform = computed(() => lib.viewer.rot % 360 !== 0 || lib.viewer.flopX)
/* 氛围底：用当前图的小缩略图做超大模糊铺底（只取 400px 缩略图，GPU 成本可忽略），切图时交叉淡化 */
const ambientUrl = computed(() => {
  const img = meta.value
  if (!img || kind.value !== 'image') return ''
  if (img.thumbnail_path && img.thumbnail_path !== 'SKIP') return fileUrl(img.thumbnail_path) + '?v=' + (img.modify_time || 0)
  return url.value
})
/* 底部工具条仅在鼠标移到底部按钮区域时才缓慢浮现，其余时刻完全隐身，不抢画面 */
const dockHover = ref(false)
function onViewerPointerMove(e) {
  const el = stageEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const fromBottom = r.bottom - e.clientY
  const fromCenter = Math.abs(e.clientX - (r.left + r.width / 2))
  const halfW = kind.value === 'video' ? 280 : 210
  dockHover.value = fromBottom >= 0 && fromBottom <= 64 && fromCenter <= halfW
}
function onViewerLeave() {
  onUp()
  dockHover.value = false
}
let flipRaf = 0
const isPsd = computed(() => extOf(lib.lightbox.path) === '.psd')
/* PSD 原图：主进程用 ag-psd 合成整幅 PNG（不是 400/1024 缩略图），先显示缩略图占位 */
const psdFull = ref('')
const psdLoading = ref(false)
const psdError = ref('')
/* 大图显示用 2048 视口预览：平移只合成小纹理；放大到预览分辨率不够时才换原图 */
const previewPath = ref('')
const previewError = ref(false)
const useFull = computed(() => {
  if (lib.viewer.cropMode) return true
  const m = meta.value
  if (!m?.width || !m?.height) return false
  return lib.viewer.scale * Math.max(m.width, m.height) > 2200
})
/* 大图加载兜底：原图失败→缩略图；都失败→错误提示（不显示裂图） */
const stageFallback = ref(false)
const stageDead = ref(false)
const stageUrl = computed(() => {
  const img = meta.value
  if (!img) return ''
  const thumb = img.thumbnail_path && img.thumbnail_path !== 'SKIP'
    ? fileUrl(img.thumbnail_path) + '?v=' + (img.modify_time || 0) : ''
  if (stageFallback.value && thumb) return thumb
  if (isPsd.value) {
    const full = psdFull.value ? fileUrl(psdFull.value) + '?v=' + (img.modify_time || 0) : ''
    if (useFull.value) return full || thumb
    if (previewPath.value && !previewError.value) {
      return fileUrl(previewPath.value) + '?v=' + (img.modify_time || 0)
    }
    return thumb || full
  }
  if (useFull.value) return url.value
  if (previewPath.value && !previewError.value) {
    return fileUrl(previewPath.value) + '?v=' + (img.modify_time || 0)
  }
  return url.value
})
function onStageError() {
  const img = meta.value
  if (isPsd.value && psdLoading.value) return
  /* 2048 预览失败：退回原图/缩略图，避免在同一个坏预览上循环 */
  if (!useFull.value && previewPath.value && !previewError.value) {
    previewError.value = true
    return
  }
  if (isPsd.value && psdFull.value && !stageFallback.value) {
    psdError.value = 'PSD 原图加载失败，显示缩略图'
    stageFallback.value = true
    return
  }
  if (!stageFallback.value && img?.thumbnail_path && img.thumbnail_path !== 'SKIP') {
    stageFallback.value = true
    return
  }
  stageDead.value = true
}
watch(() => lib.lightbox.path, async (p) => {
  stageFallback.value = false
  stageDead.value = false
  psdFull.value = ''
  psdError.value = ''
  psdLoading.value = extOf(p) === '.psd'
  if (!psdLoading.value) return
  try {
    const res = await api.psdPreview(p)
    if (lib.lightbox.path !== p) return
    if (res?.ok && res.path) {
      /* 整幅 PNG 可能几十 MB：先在内存里解码完再切 src，避免灯箱从缩略图切到半张/空白大图 */
      const fullUrl = fileUrl(res.path) + '?v=' + (meta.value?.modify_time || 0)
      await new Promise((resolve, reject) => {
        const im = new Image()
        im.decoding = 'async'
        im.onload = () => {
          if (im.decode) im.decode().then(resolve).catch(resolve)
          else resolve()
        }
        im.onerror = () => reject(new Error('PSD 原图加载失败'))
        im.src = fullUrl
      })
      if (lib.lightbox.path !== p) return
      psdFull.value = res.path
    } else {
      psdError.value = res?.error || 'PSD 原图渲染失败'
    }
  } catch (e) {
    if (lib.lightbox.path === p) psdError.value = String(e?.message || e)
  } finally {
    if (lib.lightbox.path === p) psdLoading.value = false
  }
}, { immediate: true })
async function reloadPreview(p) {
  previewPath.value = ''
  previewError.value = false
  const ext = extOf(p)
  if (!p || isVideoPath(p) || isTextPath(p) || ext === '.gif' || ext === '.svg') return
  try {
    const res = await api.viewPreview(p)
    if (lib.lightbox.path !== p || !res?.ok || !res.path) return
    const u = fileUrl(res.path) + '?v=' + (meta.value?.modify_time || 0)
    await new Promise((resolve, reject) => {
      const im = new Image()
      im.decoding = 'async'
      im.onload = () => { if (im.decode) im.decode().then(resolve).catch(resolve); else resolve() }
      im.onerror = () => reject(new Error('preview load failed'))
      im.src = u
    })
    if (lib.lightbox.path === p) previewPath.value = res.path
  } catch (e) { /* 预览失败不阻塞原图 */ }
}
watch(() => [lib.lightbox.path, meta.value?.modify_time], async ([p]) => {
  await reloadPreview(p)
}, { immediate: true })

/* 图片舞台：正常查看走 canvas（只画可视区域）；裁剪/旋转/翻转继续用 <img> 以复用既有坐标逻辑 */
const canvasStage = ref(null)
const canvasMode = computed(() => kind.value === 'image' && !lib.viewer.cropMode
  && lib.viewer.rot % 360 === 0 && !lib.viewer.flopX && !stageDead.value
  && extOf(lib.lightbox.path) !== '.gif' && extOf(lib.lightbox.path) !== '.svg')
const canvasFullSrc = computed(() => {
  const img = meta.value
  if (!img) return ''
  if (isPsd.value) return psdFull.value ? fileUrl(psdFull.value) + '?v=' + (img.modify_time || 0) : ''
  return url.value
})
const canvasFallbackSrc = computed(() => {
  const img = meta.value
  return img?.thumbnail_path && img.thumbnail_path !== 'SKIP'
    ? fileUrl(img.thumbnail_path) + '?v=' + (img.modify_time || 0) : ''
})
const canvasPreviewSrc = computed(() => {
  const img = meta.value
  if (previewPath.value && !previewError.value) {
    return fileUrl(previewPath.value) + '?v=' + (img?.modify_time || 0)
  }
  return canvasFallbackSrc.value || canvasFullSrc.value
})
function onCanvasError() { stageDead.value = true }

function fitToWindow(animateFlip = false) {
  if (!stageEl.value || kind.value === 'text') return
  let iw = 0, ih = 0
  if (kind.value === 'video') {
    const v = videoEl.value
    if (!v || !v.videoWidth) return
    iw = v.videoWidth; ih = v.videoHeight
  } else {
    const img = meta.value
    if (!img?.width) { lib.viewer.scale = 1; return }
    const swapped = lib.viewer.rot % 180 !== 0
    iw = swapped ? img.height : img.width
    ih = swapped ? img.width : img.height
  }
  const rect = stageEl.value.getBoundingClientRect()
  const inspW = lib.viewer.showInspector ? lib.inspectorWidth + 16 : 0
  const availW = Math.max(120, rect.width - inspW - 32)
  /* 上下各让 70px：42 标题栏 + 20 玻璃拖尾 + 8 呼吸 / dock 46 + 16 底距 + 8 呼吸。
     旧版只留总 110px，居中后上下各 55px，顶边会钻进拖尾、底边会压到 dock。 */
  const TOP_INSET = 70, BOTTOM_INSET = 70
  const availH = Math.max(120, rect.height - TOP_INSET - BOTTOM_INSET)
  const targetScale = Math.min(availW / iw, availH / ih) || 1 /* 按工作区适配，可放大不超出 */
  if (flipRaf) { cancelAnimationFrame(flipRaf); flipRaf = 0 }
  const orig = animateFlip === true ? lib.lightboxOrigin : null
  if (orig) lib.lightboxOrigin = null
  if (orig && orig.path === lib.lightbox.path && Date.now() - orig.at < 900 && iw > 0 && ih > 0) {
    const startScale = Math.max(0.04, Math.min(orig.width / iw, orig.height / ih))
    const startTx = (orig.left + orig.width / 2) - (rect.left + rect.width / 2)
    const startTy = (orig.top + orig.height / 2) - (rect.top + rect.height / 2)
    const dur = 360
    const t0 = performance.now()
    lib.viewer.scale = startScale
    lib.viewer.tx = startTx
    lib.viewer.ty = startTy
    if (canvasMode.value) canvasStage.value?.drawAt(startTx, startTy, startScale)
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur)
      const ease = 1 - Math.pow(1 - p, 3.8)
      const curTx = startTx * (1 - ease)
      const curTy = startTy * (1 - ease)
      const curScale = startScale + (targetScale - startScale) * ease
      if (canvasMode.value && canvasStage.value?.drawAt) {
        canvasStage.value.drawAt(curTx, curTy, curScale)
      } else {
        lib.viewer.tx = curTx
        lib.viewer.ty = curTy
        lib.viewer.scale = curScale
      }
      if (p < 1) {
        flipRaf = requestAnimationFrame(step)
      } else {
        flipRaf = 0
        lib.viewer.scale = targetScale
        lib.viewer.tx = 0
        lib.viewer.ty = 0
        if (canvasMode.value) canvasStage.value?.drawAt(0, 0, targetScale)
      }
    }
    flipRaf = requestAnimationFrame(step)
    return
  }
  lib.viewer.scale = targetScale
  lib.viewer.tx = 0; lib.viewer.ty = 0
}
function oneToOne() { lib.viewer.scale = 1; lib.viewer.tx = 0; lib.viewer.ty = 0 }
function dblClick() {
  if (Math.abs(lib.viewer.scale - 1) < 0.02) fitToWindow()
  else oneToOne()
}
function onViewerDblclick() { if (canvasMode.value) dblClick() }

watch(() => lib.viewer.fitNonce, () => nextTick(fitToWindow))
/* 缩放/平移/详情开合时：裁剪层跟随重映射（保持选区在图片上的相对位置） */
watch(() => [lib.viewer.scale, lib.viewer.tx, lib.viewer.ty, lib.viewer.showInspector], () => {
  if (!lib.viewer.cropMode) return
  const old = crop.value ? { ...crop.value } : null
  const oldW = layerRect.value?.width || (old ? old.w : 0)
  nextTick(() => {
    if (!imgEl.value) return
    const nr = imgEl.value.getBoundingClientRect()
    layerRect.value = nr
    if (old && oldW > 0) {
      const k = nr.width / oldW
      crop.value = { x: old.x * k, y: old.y * k, w: old.w * k, h: old.h * k }
    }
  })
})
watch(() => lib.lightbox.path, () => { lib.viewer.rot = 0; lib.viewer.flopX = false; nextTick(fitToWindow) })
onMounted(() => { nextTick(() => fitToWindow(true)); window.addEventListener('keydown', onKey) })
onBeforeUnmount(() => { if (flipRaf) cancelAnimationFrame(flipRaf); window.removeEventListener('keydown', onKey) })

function onWheel(e) {
  if (kind.value === 'text') return // 文本编辑器里滚轮 = 滚动正文
  e.preventDefault()
  const s0 = lib.viewer.scale || 1
  const k = e.deltaY < 0 ? 1.12 : 1 / 1.12
  const s1 = Math.min(8, Math.max(0.05, s0 * k))
  if (s1 === s0) return
  const wasPan = pan.active
  /* 拖动中滚轮：先把当前拖动位移写进 store，再做锚点缩放，最后把 pan 基准
     重设到当前光标/新位移；否则下一次 mousemove 会用旧 base 把缩放后的位移顶回去。 */
  if (wasPan) {
    lib.viewer.tx = pan.curTx
    lib.viewer.ty = pan.curTy
  }
  const rect = stageEl.value?.getBoundingClientRect()
  if (rect) {
    const px = e.clientX - (rect.left + rect.width / 2)
    const py = e.clientY - (rect.top + rect.height / 2)
    lib.viewer.tx = px - (s1 / s0) * (px - (lib.viewer.tx || 0))
    lib.viewer.ty = py - (s1 / s0) * (py - (lib.viewer.ty || 0))
  }
  lib.viewer.scale = s1
  if (wasPan) {
    if (pan.raf) { cancelAnimationFrame(pan.raf); pan.raf = 0 }
    pan.baseTx = lib.viewer.tx
    pan.baseTy = lib.viewer.ty
    pan.startX = e.clientX
    pan.startY = e.clientY
    pan.curTx = lib.viewer.tx
    pan.curTy = lib.viewer.ty
    if (canvasMode.value) canvasStage.value?.drawAt(pan.curTx, pan.curTy, s1)
    else applyPan(pan.curTx, pan.curTy)
  }
}
function onDown(e) {
  if (kind.value !== 'image') return // 文本/视频不拖拽平移
  if (e.button !== 0) return // 右键交给菜单
  /* 裁剪中：落在选区/手柄上交给裁剪层；**选区外保留平移**（用户规格） */
  if (lib.viewer.cropMode && (cropAction.value || insideRect(e) || handleAt(e))) return
  pan.active = true
  pan.startX = e.clientX; pan.startY = e.clientY
  pan.baseTx = lib.viewer.tx; pan.baseTy = lib.viewer.ty
  pan.curTx = lib.viewer.tx; pan.curTy = lib.viewer.ty
  dragging.value = true
}
function onMove(e) {
  if (lib.viewer.cropMode && cropAction.value) return // 裁剪框拖拽由 window 级监听独占
  if (!pan.active) return
  pan.curTx = pan.baseTx + e.clientX - pan.startX
  pan.curTy = pan.baseTy + e.clientY - pan.startY
  if (pan.raf) return
  pan.raf = requestAnimationFrame(() => {
    pan.raf = 0
    if (!pan.active) return
    if (lib.viewer.cropMode) {
      lib.viewer.tx = pan.curTx
      lib.viewer.ty = pan.curTy
    } else {
      applyPan(pan.curTx, pan.curTy)
    }
  })
}
function onUp() { commitPan() }
/* 灯箱右键：图片/视频/文本舞台都可呼出同一套图片菜单；输入框保留原生右键 */
function onContext(e) {
  const t = e.target
  if (!lib.lightbox.open) return
  if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return
  if (t?.closest?.('.dock, .crop-bar, .crop-layer, .ask-veil, button, input')) return
  const m = meta.value
  if (!m) return
  e.preventDefault()
  lib.openContextMenu(e, m)
}

/* 把当前旋转/翻转写回原图（先备份、失效缩略图/色板） */
const saveBusy = ref(false)
const saveNote = ref('')
async function saveTransform() {
  if (!hasTransform.value || saveBusy.value) return
  saveBusy.value = true
  try {
    const r = await lib.applyImageTransform()
    if (r?.ok && r.changed !== false) {
      await reloadPreview(lib.lightbox.path)
      nextTick(fitToWindow)
    }
    saveNote.value = r?.ok ? (r.changed === false ? '没有可保存的变换' : '已保存到原图（原件已备份）') : (r?.error || '保存失败')
  } catch (e) {
    saveNote.value = String(e?.message || e)
  } finally {
    saveBusy.value = false
    setTimeout(() => { saveNote.value = '' }, 2600)
  }
}

/* ---------- 视频：自绘控制条（原生 UI 全关） ---------- */
const videoEl = ref(null)
const vid = ref({ time: 0, dur: 0, playing: false, vol: 0.8, muted: false, loop: false, ready: false })
const seekDrag = ref(false)
const progressPct = computed(() => (vid.value.dur ? Math.min(100, (vid.value.time / vid.value.dur) * 100) : 0))
function fmtTime(s) {
  if (!Number.isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60), sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}
function onVideoMeta() {
  const v = videoEl.value
  if (!v) return
  vid.value.dur = Number.isFinite(v.duration) ? v.duration : 0
  vid.value.ready = true
  const img = meta.value
  if (img && v.videoWidth && (!img.width || !img.height)) {
    img.width = v.videoWidth; img.height = v.videoHeight
    lib.layoutTick++
  }
  v.volume = vid.value.vol
  v.muted = vid.value.muted
  v.loop = vid.value.loop
  nextTick(fitToWindow)
  v.play?.().catch(() => {}) // 双击进入已有用户手势；被策略拦截就等用户点 ▶
}
function onVideoTime() { if (videoEl.value) vid.value.time = videoEl.value.currentTime || 0 }
function togglePlay() {
  const v = videoEl.value
  if (!v) return
  if (v.paused) v.play?.().catch(() => {})
  else v.pause()
}
function seekTo(clientX, track) {
  const v = videoEl.value
  if (!v || !vid.value.dur) return
  const r = track.getBoundingClientRect()
  const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
  v.currentTime = f * vid.value.dur
  vid.value.time = v.currentTime
}
function onSeekDown(e) {
  seekDrag.value = true
  try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 合成指针无法捕获 */ }
  seekTo(e.clientX, e.currentTarget)
}
function onSeekMove(e) { if (seekDrag.value) seekTo(e.clientX, e.currentTarget) }
function onSeekUp() { seekDrag.value = false }
function toggleMute() {
  const v = videoEl.value
  if (!v) return
  v.muted = !v.muted
  vid.value.muted = v.muted
}
function setVolume(e) {
  const v = videoEl.value
  if (!v) return
  const val = Number(e.target.value)
  v.volume = val
  v.muted = val <= 0
  vid.value.vol = val
  vid.value.muted = v.muted
}
function toggleLoop() {
  const v = videoEl.value
  if (!v) return
  v.loop = !v.loop
  vid.value.loop = v.loop
}
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await stageEl.value?.requestFullscreen?.()
  } catch { /* 静默 */ }
}
watch(() => [lib.lightbox.open, lib.lightbox.path], ([open]) => {
  if (!open || kind.value !== 'video') return
  nextTick(() => {
    const v = videoEl.value
    if (!v) return
    v.volume = vid.value.vol
    v.muted = vid.value.muted
    v.loop = vid.value.loop
    v.play?.().catch(() => {})
  })
})

/* ---------- 文本：内置编辑器（自动保存 + Ctrl+S；>2MB 只读预览） ---------- */
const textEl = ref(null)
const textFont = ref(Number(localStorage.getItem('picnest.textFont')) || 14)
const wrapText = ref(localStorage.getItem('picnest.textWrap') !== '0')
const emptyText = () => ({ path: '', draft: '', saved: '', encoding: '', eol: '\n', size: 0, mtimeMs: 0, truncated: false, readOnly: false, loading: false, dirty: false, conflict: false, note: '', savedAt: 0 })
const textState = ref(emptyText())
let textTimer = null
const lineCount = computed(() => (textState.value.draft ? textState.value.draft.split('\n').length : 0))
const saveLabel = computed(() => {
  const st = textState.value
  if (st.loading) return '载入中…'
  if (st.readOnly) return '只读'
  if (st.note) return '保存失败'
  if (st.dirty) return '未保存'
  return st.savedAt ? '已保存' : ''
})
function setTextFont(v) {
  textFont.value = Math.max(11, Math.min(28, v))
  localStorage.setItem('picnest.textFont', String(textFont.value))
}
function toggleWrap() {
  wrapText.value = !wrapText.value
  localStorage.setItem('picnest.textWrap', wrapText.value ? '1' : '0')
}
async function loadText(p) {
  const st = textState.value
  st.path = p
  st.loading = true
  st.note = ''
  try {
    const r = await api.readText(p)
    if (textState.value !== st || st.path !== p) return // 已切走
    if (!r?.ok) { st.note = r?.error || '读取失败'; st.readOnly = true; return }
    st.draft = r.content || ''
    st.saved = st.draft
    st.encoding = r.encoding || ''
    st.eol = r.eol || '\n'
    st.size = r.size || 0
    st.mtimeMs = r.mtimeMs || 0
    st.truncated = !!r.truncated
    st.readOnly = !!r.truncated
    st.dirty = false
    st.conflict = false
    st.savedAt = 0
  } catch (e) { st.note = String(e?.message || e) }
  finally { if (textState.value === st) st.loading = false }
}
function textContentForSave(st) {
  return st.eol === '\r\n' ? st.draft.replace(/\r?\n/g, '\r\n') : st.draft.replace(/\r\n/g, '\n')
}
async function saveTextNow(force = false) {
  const st = textState.value
  if (!st.path || st.readOnly || st.loading) return
  if (!st.dirty && !force) return
  clearTimeout(textTimer)
  if (!force) force = st.conflict // 冲突后再点一次保存 = 覆盖
  const content = textContentForSave(st)
  try {
    const r = await window.picrand.picnestSaveText(st.path, content, force ? 0 : st.mtimeMs)
    if (textState.value !== st) return // 期间已切走，不覆盖新状态
    if (r?.ok) {
      st.saved = st.draft
      st.dirty = false
      st.conflict = false
      st.mtimeMs = r.mtimeMs || st.mtimeMs
      st.encoding = r.encoding || 'UTF-8'
      st.savedAt = Date.now()
      st.note = ''
      const img = lib.images.find((i) => i.file_path === st.path)
      if (img) {
        if (r.size) img.file_size = r.size
        img.modify_time = Math.floor((r.mtimeMs || Date.now()) / 1000)
        /* 缩略图已失效：立刻重画纸面预览（URL 带修改时间版本号，浏览器不会吃旧缓存） */
        api.generateTextThumbnails([st.path]).then((t) => {
          const hit = (t?.results || [])[0]
          if (hit?.thumbnail_path && textState.value === st) {
            img.thumbnail_path = hit.thumbnail_path
            lib.layoutTick++
          }
        }).catch(() => {})
      }
    } else if (r?.conflict) {
      st.conflict = true
      st.note = '文件已被外部修改：再按 Ctrl+S 覆盖'
    } else {
      st.note = r?.error || '保存失败'
    }
  } catch (e) { if (textState.value === st) st.note = String(e?.message || e) }
}
function onTextInput() {
  const st = textState.value
  st.dirty = st.draft !== st.saved
  st.note = ''
  clearTimeout(textTimer)
  if (st.dirty && !st.readOnly) textTimer = setTimeout(() => saveTextNow(), 1500)
}
function flushTextSave() {
  clearTimeout(textTimer)
  const st = textState.value
  if (!st.path || st.readOnly || st.loading) return
  if (st.dirty) saveTextNow(true) // 离开前落盘（冲突也强制写，避免丢编辑）
}
function onTextEsc(e) { e.target.blur() }
function insertTab(e) {
  const el = e.target
  el.setRangeText('  ', el.selectionStart, el.selectionEnd, 'end')
  textState.value.draft = el.value
  onTextInput()
}
watch(() => [lib.lightbox.open, lib.lightbox.path], ([open, p]) => {
  flushTextSave() // 先保存上一个文本（此时 state 还指向旧文件）
  textState.value = emptyText()
  if (open && isTextPath(p)) loadText(p)
}, { immediate: true })
onBeforeUnmount(flushTextSave)

/* ---------- 专业裁切（Eagle 式）：屏幕坐标系，比例锁定 + 8 向手柄 + 三分网格 ---------- */
const cropLayer = ref(null)      // 覆盖在 img 上的固定定位层
const layerRect = ref(null)      // 进入裁切时的 img 客户端矩形
const crop = ref(null)           // {x,y,w,h} 层内坐标
const cropAction = ref(null)     // null | draw | move | resize
const activeHandle = ref('')
const dragOff = ref({ x: 0, y: 0 })
const ratioLock = ref('free')    // free | orig | 1:1 | 4:3 | 16:9
const cropBusy = ref(false)
const cropNote = ref('')
const cropAsk = ref(false) // 应用后三选一：另存为副本 / 覆盖原图 / 取消

function askCrop() {
  const n = cropNatural.value
  if (!n || n.width < 8 || n.height < 8) return
  cropAsk.value = true
}

/* 另存为副本：新文件写进原图所在目录（物理文件夹=真源，索引自动收录），原图不动 */
async function cropSaveAs() {
  const img = meta.value
  const n = cropNatural.value
  if (!img || !n || n.width < 8 || n.height < 8) return
  cropBusy.value = true
  try {
    const r = await window.picrand.picnestCropAs(img.file_path, { left: n.left, top: n.top, width: n.width, height: n.height })
    if (r?.ok) {
      cropAsk.value = false
      lib.viewer.cropMode = false
      crop.value = null
      cropNote.value = `已另存 ✓ ${r.path.split('\\').pop()}（${r.width}×${r.height}）`
      const root = lib.roots.find((r0) => r0.path && img.file_path.startsWith(r0.path))
      if (root) { try { await api.syncFolderSnapshot(root.path) } catch { /* 静默 */ } }
      await lib.refreshTree()
      await lib.loadImages()
      /* 索引到达有延迟（sync 异步）：轮询等到新图入库再选中（loadImages 会清 selectedPath，须在其后） */
      for (let i = 0; i < 12; i++) {
        await new Promise((k) => setTimeout(k, 250))
        await lib.loadImages()
        const np = lib.images.find((x) => x.file_path === r.path)
        if (np) { lib.selectedPath = np.file_path; lib.lightbox.path = np.file_path; break }
      }
    } else {
      cropNote.value = r?.error || '另存失败'
    }
  } finally {
    cropBusy.value = false
    setTimeout(() => { cropNote.value = '' }, 4000)
  }
}

const dispScale = computed(() => {
  if (!layerRect.value || !meta.value?.width) return 1
  return layerRect.value.width / meta.value.width
})
const cropNatural = computed(() => {
  if (!crop.value || !meta.value) return null
  const ds = dispScale.value
  return { left: crop.value.x / ds, top: crop.value.y / ds, width: crop.value.w / ds, height: crop.value.h / ds }
})
const cropDimsText = computed(() => {
  const n = cropNatural.value
  if (!n) return ''
  return `${Math.round(n.width)} × ${Math.round(n.height)}`
})

function enterCrop() {
  lib.viewer.cropMode = true
  nextTick(() => {
    if (imgEl.value) {
      layerRect.value = imgEl.value.getBoundingClientRect()
      // Eagle 式：进入裁切 = 全图即选区，直接在原图上拖手柄往里收
      crop.value = { x: 0, y: 0, w: layerRect.value.width, h: layerRect.value.height }
    }
  })
}
function exitCrop() {
  lib.viewer.cropMode = false
  crop.value = null
  cropAction.value = null
}
function toggleCrop() {
  if (kind.value !== 'image') return // 视频/文本没有裁切
  if (!lib.viewer.cropMode) {
    if (lib.viewer.rot % 180 !== 0 || lib.viewer.flopX) return
    enterCrop()
  } else exitCrop()
}

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
function handleAt(e) {
  if (!crop.value || !cropLayer.value) return null
  const r = cropLayer.value.getBoundingClientRect()
  const x = e.clientX - r.left, y = e.clientY - r.top
  const T = 9
  const c = crop.value
  const zones = {
    nw: [c.x, c.y], n: [c.x + c.w / 2, c.y], ne: [c.x + c.w, c.y],
    e: [c.x + c.w, c.y + c.h / 2], se: [c.x + c.w, c.y + c.h], s: [c.x + c.w / 2, c.y + c.h],
    sw: [c.x, c.y + c.h], w: [c.x, c.y + c.h / 2],
  }
  for (const h of HANDLES) {
    const [hx, hy] = zones[h]
    if (Math.abs(x - hx) <= T && Math.abs(y - hy) <= T) return h
  }
  return null
}
function insideRect(e) {
  if (!crop.value || !cropLayer.value) return false
  const r = cropLayer.value.getBoundingClientRect()
  const x = e.clientX - r.left, y = e.clientY - r.top
  return x >= crop.value.x && x <= crop.value.x + crop.value.w && y >= crop.value.y && y <= crop.value.y + crop.value.h
}
function clampCrop() {
  const L = layerRect.value
  const c = crop.value
  if (!L || !c) return
  c.x = Math.max(0, Math.min(c.x, L.width))
  c.y = Math.max(0, Math.min(c.y, L.height))
  c.w = Math.max(8, Math.min(c.w, L.width - c.x))
  c.h = Math.max(8, Math.min(c.h, L.height - c.y))
  applyRatio()
}
function applyRatio() {
  const c = crop.value
  if (!c || ratioLock.value === 'free' || !meta.value) return
  let ratio = 1
  if (ratioLock.value === 'orig') ratio = meta.value.width / meta.value.height
  else if (ratioLock.value === '1:1') ratio = 1
  else if (ratioLock.value === '4:3') ratio = 4 / 3
  else if (ratioLock.value === '16:9') ratio = 16 / 9
  if (cropAction.value === 'resize' && ['nw', 'ne', 'sw', 'se', 'n', 's'].includes(activeHandle.value)) c.h = Math.round(c.w / ratio)
  else if (cropAction.value === 'resize') c.w = Math.round(c.h * ratio)
  else c.h = Math.round(c.w / ratio)
}
function ratioChip(key) {
  ratioLock.value = key
  applyRatio()
  clampCrop()
}

function cropPointerDown(e) {
  /* 实时矩形：手动拖窗/任何漂移后旧快照会让整层错位（看着在框上、坐标已偏） */
  layerRect.value = imgEl.value?.getBoundingClientRect() || null
  const L = layerRect.value
  if (!L || !crop.value) return
  /* 手柄命中用未钳坐标 + 不做层内早退：框角贴图缘时，手柄露在图外的半边也能抓住 */
  const h = handleAt(e)
  if (h) {
    cropAction.value = 'resize'; activeHandle.value = h
    return
  }
  if (e.clientX < L.left || e.clientX > L.right || e.clientY < L.top || e.clientY > L.bottom) return
  if (insideRect(e)) {
    cropAction.value = 'move'
    dragOff.value = { x: (e.clientX - L.left) - crop.value.x, y: (e.clientY - L.top) - crop.value.y }
  }
  /* 无 draw：裁剪 = 拖动初始就有的框（用户规格），误触阴影区不再清空选区 */
}
function cropPointerMove(e) {
  if (!cropAction.value || !imgEl.value) return
  layerRect.value = imgEl.value.getBoundingClientRect() // 拖拽全程实时矩形：拖窗不脱靶
  const L = layerRect.value
  const lx = Math.max(0, Math.min(e.clientX - L.left, L.width))
  const ly = Math.max(0, Math.min(e.clientY - L.top, L.height))
  const c = crop.value
  if (cropAction.value === 'move') {
    c.x = Math.max(0, Math.min(lx - dragOff.value.x, L.width - c.w))
    c.y = Math.max(0, Math.min(ly - dragOff.value.y, L.height - c.h))
  } else if (cropAction.value === 'resize') {
    const h = activeHandle.value
    const fixedX = h.includes('w') ? c.x + c.w : c.x
    const fixedY = h.includes('n') ? c.y + c.h : c.y
    let x1 = lx, y1 = ly
    if (h === 'n' || h === 's') x1 = c.x + c.w
    if (h === 'e' || h === 'w') y1 = c.y + c.h
    /* 手柄不许穿过锚点（CSP 同款）：拖出图缘/越过锚点 → 钳在锚点旁 8px，不反转不塌缩，
       拖回来照常变换（此前 SE 角越过上边缘会瞬间反转成 8×8 = 「没法变换」） */
    const MIN = 8
    if (h.includes('e')) x1 = Math.max(fixedX + MIN, Math.min(x1, L.width))
    else if (h.includes('w')) x1 = Math.max(0, Math.min(x1, fixedX - MIN))
    if (h.includes('s')) y1 = Math.max(fixedY + MIN, Math.min(y1, L.height))
    else if (h.includes('n')) y1 = Math.max(0, Math.min(y1, fixedY - MIN))
    c.x = Math.min(fixedX, x1); c.y = Math.min(fixedY, y1)
    c.w = Math.abs(x1 - fixedX); c.h = Math.abs(y1 - fixedY)
    applyRatio()
    if (h === 'n') { c.y = fixedY - c.h }
    if (h === 'w') { c.x = fixedX - c.w }
    clampCrop()
  }
}
function cropPointerUp() { cropAction.value = null }
/* 全局跟踪：鼠标超出图片/裁剪层也不丢事件（工作区概念） */
window.addEventListener('mousemove', (e) => { if (cropAction.value) cropPointerMove(e) })
window.addEventListener('mouseup', () => { if (cropAction.value) cropPointerUp() })

async function applyCrop() {
  cropAsk.value = false
  const img = meta.value
  const n = cropNatural.value
  if (!img || !n || n.width < 8 || n.height < 8) return
  cropBusy.value = true
  try {
    const r = await window.picrand.picnestCrop(img.file_path, { left: n.left, top: n.top, width: n.width, height: n.height })
    if (r?.ok) {
      const img2 = lib.images.find((i) => i.file_path === img.file_path)
      if (img2) {
        img2.width = r.width; img2.height = r.height; img2.thumbnail_path = ''
        if (r.modify_time) img2.modify_time = r.modify_time
        else img2.modify_time = Math.floor(Date.now() / 1000)
      }
      delete lib.palettes[img.file_path]
      lib.viewer.cropMode = false
      crop.value = null
      await reloadPreview(lib.lightbox.path)
      nextTick(fitToWindow)
      /* toast 独立于裁剪条（crop-bar 随 cropMode 消失，曾把成功消息一起带走） */
      cropNote.value = `已裁切 ✓ ${r.width}×${r.height} 已入库（原图已备份）`
      lib.layoutTick++
      lib.fillAllThumbsInBackground()
    } else {
      cropNote.value = r?.error || '裁切失败'
    }
  } finally {
    cropBusy.value = false
    setTimeout(() => { cropNote.value = '' }, 4000)
  }
}

function onKey(e) {
  if (!lib.lightbox.open) return
  const t = e.target
  if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return // 控件内按键归控件
  if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 's' && kind.value === 'text') {
    e.preventDefault()
    saveTextNow(textState.value.conflict)
    return
  }
  if (e.key === ' ') {
    if (kind.value === 'video') { e.preventDefault(); togglePlay() }
    return
  }
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey
  const k = String(e.key || '').toLowerCase()
  if (e.key === 'Escape') {
    if (cropAsk.value) { cropAsk.value = false }
    else if (lib.viewer.cropMode) { exitCrop() }
    else lib.closeLightbox()
  }
  else if (e.key === 'Enter' && lib.viewer.cropMode && crop.value) applyCrop()
  else if ((e.key === 'ArrowLeft' || (plain && k === 'a')) && !lib.viewer.cropMode) lib.lightboxNav(-1)
  else if ((e.key === 'ArrowRight' || (plain && k === 'd')) && !lib.viewer.cropMode) lib.lightboxNav(1)
  else if (e.key === '0' && kind.value === 'image') fitToWindow()
}
</script>

<template>
  <div
    ref="stageEl" class="viewer" :class="{ 'dock-show': dockHover, 'has-ambient': !!ambientUrl }"
    @wheel="onWheel" @contextmenu="onContext"
    @mousedown="onDown" @mousemove="onMove" @mouseup="onUp" @mouseleave="onViewerLeave"
    @pointermove="onViewerPointerMove"
    @dblclick="onViewerDblclick"
    :style="canvasMode ? { cursor: dragging ? 'grabbing' : 'grab' } : undefined"
  >
    <!-- 氛围底：当前图的模糊放大铺底 + 暗角，切图交叉淡化 -->
    <Transition name="amb">
      <div v-if="ambientUrl" :key="ambientUrl" class="ambient" :style="{ backgroundImage: `url(&quot;${ambientUrl}&quot;)` }" />
    </Transition>
    <div v-if="ambientUrl" class="ambient-veil" />
    <!-- 视频：自绘控制条（无原生 UI） -->
    <video
      v-if="kind === 'video'"
      ref="videoEl" :src="url" class="stage video" :class="{ gray: lib.grayscaleMode }" playsinline
      :style="{ transform: `translate(${lib.viewer.tx}px, ${lib.viewer.ty}px) scale(${lib.viewer.scale})` }"
      @loadedmetadata="onVideoMeta" @timeupdate="onVideoTime"
      @play="vid.playing = true" @pause="vid.playing = false" @ended="vid.playing = false"
      @click="togglePlay" @dblclick="toggleFullscreen"
    />
    <!-- 文本：内置编辑器（自动保存 + Ctrl+S；超 2MB 只读预览） -->
    <div v-else-if="kind === 'text'" class="text-stage">
      <div class="text-bar">
        <button class="tb-btn nav" title="上一张（←/A）" @click="lib.lightboxNav(-1)">‹</button>
        <button class="tb-btn nav" title="下一张（→/D）" @click="lib.lightboxNav(1)">›</button>
        <span class="tb-name" :title="fileName">{{ lib.dispName(fileName) }}</span>
        <span v-if="textState.encoding" class="tb-badge">{{ textState.encoding }}</span>
        <span v-if="textState.truncated" class="tb-warn">超过 2MB · 只读预览</span>
        <span v-else-if="/GB/i.test(textState.encoding)" class="tb-warn">保存将转为 UTF-8</span>
        <span class="tb-spacer" />
        <span class="tb-stat">{{ lineCount }} 行 · {{ textState.draft.length }} 字符</span>
        <span class="tb-state" :class="{ dirty: textState.dirty, err: !!textState.note }">{{ saveLabel }}</span>
        <button class="tb-btn" title="减小字号" @click="setTextFont(textFont - 1)">A−</button>
        <button class="tb-btn" title="增大字号" @click="setTextFont(textFont + 1)">A＋</button>
        <button class="tb-btn" :class="{ on: wrapText }" title="自动换行" @click="toggleWrap">换行</button>
        <button class="tb-btn primary" :disabled="textState.readOnly || !textState.dirty" @click="saveTextNow(textState.conflict)">保存</button>
      </div>
      <div v-if="textState.loading" class="text-loading">载入中…</div>
      <textarea
        v-else ref="textEl" v-model="textState.draft" class="text-body" :class="{ wrap: wrapText }"
        :style="{ fontSize: textFont + 'px' }" spellcheck="false" :readonly="textState.readOnly"
        @input="onTextInput" @keydown.esc.stop="onTextEsc"
        @keydown.ctrl.s.prevent="saveTextNow(textState.conflict)" @keydown.meta.s.prevent="saveTextNow(textState.conflict)"
        @keydown.tab.prevent="insertTab"
      />
      <div v-if="textState.note" class="text-note">{{ textState.note }}</div>
    </div>
    <CanvasStage v-if="canvasMode"
      ref="canvasStage" :class="{ gray: lib.grayscaleMode }"
      :preview-src="canvasPreviewSrc" :full-src="canvasFullSrc" :fallback-src="canvasFallbackSrc"
      :width="meta?.width || 0" :height="meta?.height || 0"
      :scale="lib.viewer.scale" :tx="lib.viewer.tx" :ty="lib.viewer.ty"
      :use-full="useFull" @error="onCanvasError" />
    <img
      v-else-if="!stageDead"
      ref="imgEl" :src="stageUrl" class="stage" :class="{ gray: lib.grayscaleMode }" draggable="false"
      :style="{
        width: meta?.width ? meta.width + 'px' : undefined,
        height: meta?.height ? meta.height + 'px' : undefined,
        transform: `translate3d(${lib.viewer.tx}px, ${lib.viewer.ty}px, 0) scale(${lib.viewer.scale}) rotate(${lib.viewer.rot}deg)` + (lib.viewer.flopX ? ' scaleX(-1)' : ''),
        cursor: lib.viewer.cropMode ? 'default' : dragging ? 'grabbing' : 'grab',
      }"
      @error="onStageError"
      @dblclick="dblClick"
    />
    <div v-if="isPsd && (psdLoading || psdError)" class="psd-note">
      {{ psdError || 'PSD 原图渲染中，先显示缩略图…' }}
    </div>
    <!-- 专业裁切层：覆盖在图片上（外部压暗 + 三分网格 + 手柄） -->
    <div v-if="lib.viewer.cropMode && layerRect" ref="cropLayer" class="crop-layer"
         :style="{ left: layerRect.left + 'px', top: layerRect.top + 'px', width: layerRect.width + 'px', height: layerRect.height + 'px' }"
         @mousedown.prevent="cropPointerDown"
    >
      <div v-if="crop" class="crop-shade" :style="{ clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${crop.x}px ${crop.y}px, ${crop.x}px ${crop.y + crop.h}px, ${crop.x + crop.w}px ${crop.y + crop.h}px, ${crop.x + crop.w}px ${crop.y}px, ${crop.x}px ${crop.y}px)` }" />
      <div v-if="crop" class="crop-box" :style="{ left: crop.x + 'px', top: crop.y + 'px', width: crop.w + 'px', height: crop.h + 'px' }">
        <i v-for="gy in 2" :key="'gy' + gy" class="grid-line v" :style="{ left: (gy * 100) / 3 + '%' }" />
        <i v-for="gx in 2" :key="'gx' + gx" class="grid-line h" :style="{ top: (gx * 100) / 3 + '%' }" />
        <span v-for="h in HANDLES" :key="h" class="handle" :class="h" />
        <span class="dims">{{ cropDimsText }}</span>
      </div>
      
    </div>

    <!-- 裁切比例锁定 + 应用条 -->
    <div v-if="lib.viewer.cropMode" class="crop-bar glass-pill">
      <button v-for="r in [{ k: 'free', l: '自由' }, { k: 'orig', l: '原始' }, { k: '1:1', l: '1:1' }, { k: '4:3', l: '4:3' }, { k: '16:9', l: '16:9' }]"
              :key="r.k" class="dock-btn chip" :class="{ on: ratioLock === r.k }" @click="ratioChip(r.k)">{{ r.l }}</button>
      <i class="vsep" />
      <button class="dock-btn ok" :disabled="!crop || cropBusy" @click="askCrop">✓ 应用</button>
      <button class="dock-btn" @click="exitCrop">取消</button>
      <span v-if="cropNote" class="note">{{ cropNote }}</span>
    </div>

    <!-- 底部悬浮工具条（ZCode 输入口风格） -->
    <div v-if="kind === 'image'" class="dock glass-pill dock-clear">
      <button class="dock-btn" title="上一张（←/A）" @click="lib.lightboxNav(-1)">‹</button>
      <button class="dock-btn" title="下一张（→/D）" @click="lib.lightboxNav(1)">›</button>
      <i class="vsep" />
      <button class="dock-btn" :class="{ on: lib.viewer.flopX }" title="水平翻转" @click="lib.viewer.flopX = !lib.viewer.flopX">⇋</button>
      <button class="dock-btn" :class="{ on: lib.viewer.rot % 360 !== 0 }" title="旋转 90°" @click="lib.viewer.rot = (lib.viewer.rot + 90) % 360; lib.viewer.fitNonce++">↻</button>
      <button class="dock-btn" :class="{ on: lib.viewer.cropMode }" :disabled="lib.viewer.rot % 180 !== 0 || lib.viewer.flopX"
              :title="lib.viewer.cropMode ? '退出裁切' : '裁切（旋转/翻转时不可用）'"
              @click="toggleCrop">⛶</button>
      <i class="vsep" />
      <button class="dock-btn wide" :class="{ on: hasTransform }" :disabled="!hasTransform || saveBusy"
              title="保存旋转/翻转（写回原图，原件自动备份）" @click="saveTransform">{{ saveBusy ? '保存中…' : '保存' }}</button>
      <i class="vsep" />
      <button class="dock-btn wide" title="原始大小（1:1）" @click="oneToOne">1:1</button>
      <button class="dock-btn wide" title="缩放到窗口大小" @click="fitToWindow">⤢ 适应</button>
    </div>
    <!-- 视频工具条：播放/进度/音量/循环/全屏 -->
    <div v-else-if="kind === 'video'" class="dock glass-pill video-dock dock-clear">
      <button class="dock-btn play" :title="vid.playing ? '暂停（空格）' : '播放（空格）'" @click="togglePlay">{{ vid.playing ? '❚❚' : '▶' }}</button>
      <span class="vtime">{{ fmtTime(vid.time) }}</span>
      <div class="vtrack" @pointerdown.prevent="onSeekDown" @pointermove="onSeekMove" @pointerup="onSeekUp" @pointercancel="onSeekUp">
        <i class="vfill" :style="{ width: progressPct + '%' }" />
        <i class="vhead" :style="{ left: progressPct + '%' }" />
      </div>
      <span class="vtime dim">{{ fmtTime(vid.dur) }}</span>
      <i class="vsep" />
      <button class="dock-btn" :class="{ on: !vid.muted && vid.vol > 0 }" :title="vid.muted ? '取消静音' : '静音'" @click="toggleMute">{{ vid.muted || !vid.vol ? '✕' : '♪' }}</button>
      <input class="vrange" type="range" min="0" max="1" step="0.01" :value="vid.muted ? 0 : vid.vol" title="音量" @input="setVolume" />
      <button class="dock-btn" :class="{ on: vid.loop }" title="循环播放" @click="toggleLoop">↻</button>
      <button class="dock-btn" title="全屏" @click="toggleFullscreen">⛶</button>
      <i class="vsep" />
      <button class="dock-btn" title="上一张（←/A）" @click="lib.lightboxNav(-1)">‹</button>
      <button class="dock-btn" title="下一张（→/D）" @click="lib.lightboxNav(1)">›</button>
    </div>
    <div v-if="!url" class="empty">图片不存在</div>
    <div v-else-if="stageDead && kind === 'image'" class="empty">图片加载失败（原图与缩略图都不可读）</div>
    <!-- 裁剪结果 toast：不随 cropMode 消失（挂在舞台根层） -->
    <div v-if="cropNote" class="crop-toast">{{ cropNote }}</div>
    <div v-if="saveNote" class="crop-toast">{{ saveNote }}</div>

    <!-- 应用裁剪：三选一（另存为副本 / 覆盖原图 / 取消） -->
    <div v-if="cropAsk" class="ask-veil" @mousedown.self="cropAsk = false">
      <div class="ask-card glass-card" @mousedown.stop>
        <div class="ask-title">裁剪结果如何保存？</div>
        <button class="ask-btn" :disabled="cropBusy" @click="cropSaveAs">
          <b>另存为副本</b><span>存进原图所在文件夹，自动入库</span>
        </button>
        <button class="ask-btn" :disabled="cropBusy" @click="applyCrop">
          <b>覆盖原图</b><span>原件自动备份，可找回</span>
        </button>
        <button class="ask-btn ghost" @click="cropAsk = false">取消</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.viewer {
  flex: 1; position: relative; overflow: hidden;
  display: flex; align-items: center; justify-content: center;
  background: var(--panel-strong);
}
/* ---- 氛围底（Ambient）：亮色主题克制温润（不抢画面），暗色主题稍微浓郁（由 style.css --amb-* 控制） ---- */
.ambient {
  position: absolute; inset: -14%; z-index: 0; pointer-events: none;
  background-size: cover; background-position: center;
  filter: blur(var(--amb-blur, 92px)) saturate(var(--amb-sat, 1.16)) brightness(var(--amb-bright, 1.04));
  opacity: var(--amb-opacity, 0.20);
  transform: translateZ(0);
  animation: amb-drift 28s ease-in-out infinite alternate;
}
@keyframes amb-drift {
  from { transform: translateZ(0) scale(1) translate(0, 0); }
  to { transform: translateZ(0) scale(1.08) translate(-1.5%, 1%); }
}
/* 柔光罩：亮色主题只做极淡暖边晕，不压脏白底 */
.ambient-veil {
  position: absolute; inset: 0; z-index: 0; pointer-events: none;
  background: radial-gradient(ellipse 80% 74% at 50% 50%, transparent 46%, var(--amb-veil, rgba(60, 50, 30, 0.05)) 100%);
}
.amb-enter-active, .amb-leave-active { transition: opacity 0.6s ease; }
.amb-enter-from, .amb-leave-to { opacity: 0 !important; }
.viewer.has-ambient .stage:not(.video) {
  box-shadow: 0 14px 44px rgba(0, 0, 0, 0.16), 0 3px 10px rgba(0, 0, 0, 0.08);
}
@media (prefers-reduced-motion: reduce) { .ambient { animation: none; } }
.viewer :deep(.canvas-stage) { z-index: 1; }
.stage {
  /* 基础尺寸=原始像素，适配完全由 transform scale 负责（单一权威）
     沉浸模式不做浮岛：无投影/圆角，图片平面贴在正文上 */
  position: relative; z-index: 1;
  user-select: none;
  object-fit: contain;
  will-change: transform; /* 平移交给合成器，避免每帧重绘整张大图 */
  backface-visibility: hidden;
}
.glass-pill {
  position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%);
  z-index: 40; /* 高于 crop-layer(30)：裁剪时 应用/取消/比例/导航 按钮必须可点 */
  display: flex; align-items: center; gap: 4px;
  padding: 6px 10px; border-radius: 999px;
  background: var(--panel); backdrop-filter: blur(var(--blur)) saturate(1.2);
  border: 1px solid var(--border); box-shadow: var(--shadow);
}
/* 大图底部工具条：高透薄雾胶囊，默认完全隐身（0 不透明度），仅当鼠标移到底部按钮位置才缓慢浮现 */
.dock.dock-clear {
  background: rgba(255, 253, 249, 0.28);
  background: color-mix(in srgb, var(--glass-strong) 34%, transparent);
  backdrop-filter: blur(14px) saturate(1.15);
  -webkit-backdrop-filter: blur(14px) saturate(1.15);
  border-color: rgba(128, 128, 128, 0.14);
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.08);
  padding: 5px 8px;
  opacity: 0;
  transform: translateX(-50%) translateY(12px) scale(0.96);
  pointer-events: none;
  transition: opacity 0.48s cubic-bezier(0.22, 1, 0.36, 1), transform 0.48s cubic-bezier(0.22, 1, 0.36, 1);
}
.viewer.dock-show .dock.dock-clear,
.dock.dock-clear:hover {
  opacity: 1;
  transform: translateX(-50%) translateY(0) scale(1);
  pointer-events: auto;
}
.dock.dock-clear .dock-btn { color: var(--text); font-size: 14px; }
.dock.dock-clear .dock-btn:hover { background: var(--accent-weak); color: var(--accent); transform: translateY(-1px); }
.dock.dock-clear .dock-btn:active { transform: scale(0.92); }
.dock-btn {
  height: 32px; min-width: 32px; border: none; border-radius: 999px;
  background: transparent; color: var(--text-2); font-size: 13px;
  cursor: pointer; padding: 0 8px; transition: all 0.15s;
}
.dock-btn.wide { border-radius: 999px; }
.dock-btn:hover { background: var(--accent-weak); color: var(--text); }
.dock-btn.on { background: var(--accent-weak); color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.dock-btn.insp-toggle {
  width: 34px; height: 34px; border-radius: 50%;
  background: var(--accent); color: #fff; font-size: 14px;
  box-shadow: 0 2px 10px rgba(212, 169, 100, 0.4);
}
.dock-btn.insp-toggle:hover { filter: brightness(1.08); }
.dock-btn.ok { color: #6dbf90; }
.dock-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.vsep { width: 1px; height: 18px; background: var(--border); margin: 0 3px; }
.note { font-size: 11.5px; color: var(--accent); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---- 视频：自绘控制条 ---- */
.stage.video { max-width: none; background: #000; cursor: pointer; }
.stage.gray { filter: grayscale(1); }
.viewer :deep(.canvas-stage.gray) { filter: grayscale(1); }
.video-dock { gap: 6px; }
.video-dock .dock-btn.play { color: var(--accent); font-size: 12px; }
.vtime { font-family: Consolas, monospace; font-size: 11px; color: var(--text); min-width: 34px; text-align: center; }
.vtime.dim { color: var(--text-2); }
.vtrack { position: relative; width: min(36vw, 440px); height: 20px; display: flex; align-items: center; cursor: pointer; touch-action: none; }
.vtrack::before { content: none; }
.vtrack::after { content: ''; position: absolute; left: 0; right: 0; height: 3px; border-radius: 2px; background: var(--border); }
.vfill { position: absolute; left: 0; height: 3px; border-radius: 2px; background: var(--accent); z-index: 1; }
.vhead {
  position: absolute; top: 50%; width: 9px; height: 9px; margin-left: -4.5px; margin-top: -4.5px;
  border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px var(--accent-weak); z-index: 2;
}
.vrange { width: 74px; accent-color: var(--accent); cursor: pointer; }

/* ---- 文本：内置编辑器 ---- */
.text-stage {
  position: absolute; inset: 0; z-index: 10; /* 低于标题栏(20)：否则盖住左上角退出钮 */
  display: flex; flex-direction: column; gap: 8px;
  padding: 76px 22px 20px; /* 42 标题栏 + 20 玻璃拖尾 + 14 呼吸：工具栏不再被拖尾压住 */
  background: var(--panel-strong);
}
.text-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--text-2); }
.tb-name { color: var(--text); font-weight: 600; max-width: 32%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tb-badge { border: 1px solid var(--border); border-radius: 6px; padding: 1px 7px; font-size: 10.5px; letter-spacing: 0.4px; }
.tb-warn { color: #c25a4d; font-size: 11px; }
.tb-stat { font-size: 11px; opacity: 0.75; }
.tb-spacer { flex: 1; }
.tb-state { font-size: 11.5px; color: var(--text-2); }
.tb-state.dirty { color: var(--accent); font-weight: 600; }
.tb-state.err { color: #c25a4d; }
.tb-btn {
  border: 1px solid var(--border); background: transparent; color: var(--text-2);
  border-radius: 8px; font-size: 11.5px; padding: 4px 9px; cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.tb-btn:hover { background: var(--accent-weak); color: var(--accent); border-color: var(--accent); }
.tb-btn.on { background: var(--accent-weak); color: var(--accent); border-color: var(--accent); }
.tb-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
.tb-btn.primary:disabled { opacity: 0.4; cursor: not-allowed; background: transparent; color: var(--text-2); border-color: var(--border); }
.tb-btn.nav { padding: 3px 9px; font-size: 14px; line-height: 1; }
.text-body {
  flex: 1; width: 100%; min-height: 0; resize: none; outline: none;
  padding: 16px 18px; border: 1px solid var(--border); border-radius: 10px;
  background: var(--bg-2); color: var(--text);
  font-family: Consolas, 'Cascadia Mono', 'Microsoft YaHei', monospace;
  line-height: 1.65; tab-size: 2;
}
.text-body.wrap { white-space: pre-wrap; overflow-wrap: anywhere; overflow-y: auto; }
.text-body:not(.wrap) { white-space: pre; overflow: auto; }
.text-loading { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--text-2); font-size: 13px; }
.text-note { color: #c25a4d; font-size: 12px; }

/* 专业裁切层：选区外保留平移（grab），选区内 move，手柄 resize */
.crop-layer { position: fixed; z-index: 30; cursor: grab; }
.crop-layer:active { cursor: grabbing; }
.crop-shade { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.55); }
.crop-box { position: absolute; border: 1.5px solid #fff; box-shadow: 0 0 0 1px rgba(0,0,0,.4); cursor: move; }
.grid-line { position: absolute; background: rgba(255, 255, 255, 0.35); pointer-events: none; }
.grid-line.v { top: 0; bottom: 0; width: 1px; }
.grid-line.h { left: 0; right: 0; height: 1px; }
.handle {
  position: absolute; width: 11px; height: 11px;
  background: #fff; border: 1.5px solid var(--accent); border-radius: 2px;
}
.handle.nw { top: -6px; left: -6px; cursor: nwse-resize; }
.handle.n { top: -6px; left: 50%; margin-left: -5.5px; cursor: ns-resize; }
.handle.ne { top: -6px; right: -6px; cursor: nesw-resize; }
.handle.e { top: 50%; right: -6px; margin-top: -5.5px; cursor: ew-resize; }
.handle.se { bottom: -6px; right: -6px; cursor: nwse-resize; }
.handle.s { bottom: -6px; left: 50%; margin-left: -5.5px; cursor: ns-resize; }
.handle.sw { bottom: -6px; left: -6px; cursor: nesw-resize; }
.handle.w { top: 50%; left: -6px; margin-top: -5.5px; cursor: ew-resize; }
.dims {
  position: absolute; bottom: -26px; left: 50%; transform: translateX(-50%);
  font-size: 11px; color: #fff; background: rgba(0, 0, 0, 0.6);
  padding: 2px 8px; border-radius: 5px; white-space: nowrap;
}
.crop-hint {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  font-size: 13px; color: #fff; background: rgba(0, 0, 0, 0.5);
  padding: 8px 16px; border-radius: 9px; pointer-events: none;
}
.crop-bar { bottom: 70px; }
.crop-toast {
  position: absolute; top: 56px; left: 50%; transform: translateX(-50%);
  z-index: 45; padding: 7px 16px; border-radius: 999px;
  background: var(--panel-strong); border: 1px solid var(--accent);
  color: var(--accent); font-size: 12.5px; box-shadow: var(--shadow);
  animation: pop 0.18s ease;
}
/* 应用裁剪三选一对话框 */
.ask-veil {
  position: fixed; inset: 0; z-index: 60;
  background: rgba(0, 0, 0, 0.35); backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center;
}
.ask-card {
  display: flex; flex-direction: column; gap: 8px;
  min-width: 300px; padding: 16px 16px 14px; border-radius: 16px;
  background: var(--panel-strong); border: 1px solid var(--border);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.35);
  animation: pop 0.16s ease;
}
.ask-title { font-size: 13.5px; font-weight: 600; color: var(--text); padding-bottom: 2px; }
.ask-btn {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  border: 1px solid var(--border); border-radius: 10px; background: transparent;
  color: var(--text); padding: 9px 12px; cursor: pointer; text-align: left;
  transition: all 0.15s;
}
.ask-btn:hover { border-color: var(--accent); background: var(--accent-weak); }
.ask-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.ask-btn b { font-size: 13px; }
.ask-btn span { font-size: 11.5px; color: var(--text-2); }
.ask-btn.ghost { align-items: center; color: var(--text-2); border-style: dashed; }
.psd-note {
  position: absolute; left: 50%; top: 78px; transform: translateX(-50%); z-index: 26;
  padding: 5px 10px; border-radius: 8px; pointer-events: none;
  background: rgba(20, 18, 14, 0.58); color: #fff; font-size: 11.5px;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.18);
}
.empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--text-2); }
</style>
