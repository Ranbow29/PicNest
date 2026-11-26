<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useLibrary } from '../stores/library'
import { useTheme } from '../lib/theme'
import { motionState, startColdEntrance } from '../lib/motionDirector'

/* 风格主题专属：多动效协同舞台层（同时服务「酸性印刷」「终末工业」「黑曜棱镜」）
   承接纯 GPU 合成、pointer-events: none、0ms 阻塞的动效通道：
   1. 换肤扫光带（酸性=蓝黑斜刀；终末=荧光黄水平激光扫描；黑曜=四色羽化棱镜光幕）
   2. 空间锚点取景框（双击缩略图进灯箱时从卡片坐标拉满全屏）
   3. 侧栏 → 主画布激光引导脉冲（保留通道）
   4. 非阻塞战术过场印章/播报条（宏观模式切换时右下角高速闪过）
   老主题下整个舞台零渲染、零开销。 */
const lib = useLibrary()
const { resolved } = useTheme()

const isAcid = computed(() => resolved.value === 'acid-print')
const isEndfield = computed(() => resolved.value.startsWith('endfield-'))
const isObsidian = computed(() => resolved.value.startsWith('obsidian-'))
const isStyled = computed(() => isAcid.value || isEndfield.value || isObsidian.value)

const active = ref(false)
const seq = ref(0)
const code = ref('')
const sub = ref('')
let timer = null

const VIEW_CODE = {
  all: ['ARCHIVE', '全部图库'],
  recent: ['RECENT', '最近使用'],
  uncategorized: ['UNSORTED', '未分类'],
  random: ['SHUFFLE', '随机漫游'],
  trash: ['TRASH_BIN', '回收站'],
  search: ['SEARCH', '检索结果'],
}

function flash(c, s, delay = 0) {
  if (!isStyled.value) return
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
  if (reduce) return
  clearTimeout(timer)
  const run = () => {
    code.value = c
    sub.value = s
    seq.value += 1
    active.value = true
    timer = setTimeout(() => { active.value = false }, isEndfield.value ? 480 : 520)
  }
  if (delay > 0) timer = setTimeout(run, delay)
  else run()
}

/* 冷启动若直接是风格主题：播一遍开版因果序列 + 迎宾印章 */
onMounted(() => {
  if (isAcid.value) {
    startColdEntrance()
    flash('PICNEST', 'ACID_PRINT READY', 180)
  } else if (isEndfield.value) {
    startColdEntrance()
    const tag = resolved.value === 'endfield-light' ? 'LIGHT TERMINAL READY' : 'DARK TERMINAL READY'
    flash('ENDFIELD', tag, 140)
  } else if (isObsidian.value) {
    startColdEntrance()
    const isLight = resolved.value === 'obsidian-light'
    flash(isLight ? 'CRYSTAL' : 'OBSIDIAN', isLight ? 'LIGHT PRISM READY' : 'DARK PRISM READY', 150)
  }
})

watch(resolved, (v, old) => {
  if (v === 'acid-print' && old && old !== 'acid-print') {
    flash('ACID_PRINT', 'EDITORIAL MOTION READY', 260)
  } else if (v.startsWith('endfield-') && old !== v) {
    const tag = v === 'endfield-light' ? 'LIGHT TERMINAL READY' : 'DARK TERMINAL READY'
    flash('ENDFIELD', tag, 210)
  } else if (v.startsWith('obsidian-') && old !== v) {
    const isLight = v === 'obsidian-light'
    flash(isLight ? 'CRYSTAL' : 'OBSIDIAN', isLight ? 'LIGHT PRISM READY' : 'DARK PRISM READY', 230)
  } else if (!v.startsWith('endfield-') && !v.startsWith('obsidian-') && v !== 'acid-print') {
    active.value = false
    clearTimeout(timer)
  }
})

watch(() => lib.view, (v, old) => {
  if (!old || v === old) return
  const pair = VIEW_CODE[v] || [String(v || 'VIEW').toUpperCase(), '视图切换']
  flash(pair[0], pair[1])
})

watch(() => lib.lightbox.open, (open, old) => {
  if (old === undefined || open === old) return
  flash(open ? 'LIGHTBOX' : 'GRID_VIEW', open ? '大图检视模式' : '返回画廊网格')
})

watch(() => lib.brief.open, (open, old) => {
  if (old === undefined || open === old) return
  flash(open ? 'BRIEF_STAGE' : 'GRID_VIEW', open ? '全屏简报演示' : '退出简报演示')
})

/* 空间锚点取景框起始变量 */
const frameStyle = computed(() => {
  const r = motionState.frameRect
  if (!r) return {}
  return {
    '--fx': r.left + 'px',
    '--fy': r.top + 'px',
    '--fw': r.width + 'px',
    '--fh': r.height + 'px',
  }
})

onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <!-- 通道 1A：酸性印刷换肤丝网刮墨刀锋 -->
  <div v-if="motionState.bladeActive" :key="'blade-' + motionState.bladeSeq" class="acid-blade" aria-hidden="true" />
  <!-- 通道 1B：终末工业换肤精密水平激光扫描游标 -->
  <div v-if="motionState.scanActive" :key="'scan-' + motionState.scanSeq" class="ef-scan-cursor" aria-hidden="true" />
  <!-- 通道 1C：黑曜棱镜四色羽化棱镜折射光幕 -->
  <div v-if="motionState.prismActive" :key="'prism-' + motionState.prismSeq" class="op-prism-sweep" aria-hidden="true" />

  <template v-if="isStyled">
    <!-- 通道 2：空间锚点取景框（从点击缩略图坐标拉镜至全屏） -->
    <div
      v-if="motionState.frameActive"
      :key="'frame-' + motionState.frameSeq"
      :class="isEndfield ? 'ef-origin-frame' : (isObsidian ? 'op-origin-frame' : 'acid-origin-frame')"
      :style="frameStyle"
      aria-hidden="true"
    >
      <span :class="isEndfield ? 'ef-aof-tag' : (isObsidian ? 'op-aof-tag' : 'aof-tag')">
        {{ isEndfield ? '// TARGET_LOCK · ' : (isObsidian ? '✦ PRISM · ' : '// LOCK · ') }}{{ motionState.frameTag }}
      </span>
    </div>

    <!-- 通道 3：侧栏 → 主画布激光引导脉冲 -->
    <div
      v-if="motionState.pulseActive"
      :key="'pulse-' + motionState.pulseSeq"
      class="acid-side-pulse"
      :style="{ top: motionState.pulseY + 'px', left: motionState.pulseX + 'px' }"
      aria-hidden="true"
    />

    <!-- 通道 4：非阻塞过场播报条 -->
    <div
      v-if="active"
      :key="'ban-' + seq"
      :class="isEndfield ? 'ef-banner' : (isObsidian ? 'op-banner' : 'acid-banner')"
      aria-hidden="true"
    >
      <div v-if="isEndfield" class="ef-strip">
        <span class="ef-slash">//</span>
        <strong class="ef-code">{{ code }}</strong>
        <span class="ef-sep">::</span>
        <span class="ef-sub">{{ sub }}</span>
      </div>
      <div v-else-if="isObsidian" class="op-strip">
        <span class="op-prism-dot" />
        <strong class="op-code">{{ code }}</strong>
        <span class="op-sep">::</span>
        <span class="op-sub">{{ sub }}</span>
      </div>
      <div v-else class="ab-strip">
        <span class="ab-arrows">&gt;&gt;</span>
        <strong class="ab-code">{{ code }}</strong>
        <span class="ab-sep">//</span>
        <span class="ab-sub">{{ sub }}</span>
      </div>
    </div>
  </template>
</template>

<style scoped>
/* ---- 通道 1A：酸性印刷丝网刮墨刀锋光带 ---- */
.acid-blade {
  position: fixed;
  top: -12vh;
  left: 0;
  width: 72px;
  height: 124vh;
  z-index: 9999;
  pointer-events: none;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(24, 59, 255, 0.32) 18%,
    #183bff 52%,
    #111216 74%,
    transparent 100%
  );
  transform-origin: center;
  animation: acid-blade-run 430ms cubic-bezier(0.16, 1, 0.3, 1) both;
}
@keyframes acid-blade-run {
  0% {
    opacity: 0.95;
    transform: translate3d(-24vw, 0, 0) skewX(-14deg);
  }
  85% {
    opacity: 0.95;
  }
  100% {
    opacity: 0;
    transform: translate3d(122vw, 0, 0) skewX(-14deg);
  }
}

/* ---- 通道 1B：终末工业精密水平激光扫描游标 ---- */
.ef-scan-cursor {
  position: fixed;
  top: 0;
  left: 0;
  width: 28px;
  height: 100vh;
  z-index: 9999;
  pointer-events: none;
  background: linear-gradient(
    90deg,
    rgba(255, 250, 0, 0) 0%,
    rgba(255, 250, 0, 0.14) 72%,
    #fffa00 88%,
    #fffa00 100%
  );
  animation: ef-scan-run 360ms cubic-bezier(0.12, 0.88, 0.2, 1) both;
}
@keyframes ef-scan-run {
  0% {
    opacity: 0.96;
    transform: translate3d(-32px, 0, 0);
  }
  90% {
    opacity: 0.96;
  }
  100% {
    opacity: 0;
    transform: translate3d(102vw, 0, 0);
  }
}

/* ---- 通道 1C：黑曜棱镜四色羽化光谱折射光幕 ---- */
.op-prism-sweep {
  position: fixed;
  top: 0;
  left: 0;
  width: 96px;
  height: 100vh;
  z-index: 9999;
  pointer-events: none;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(66, 133, 244, 0.18) 28%,
    rgba(155, 114, 203, 0.34) 55%,
    rgba(234, 67, 53, 0.28) 76%,
    rgba(251, 188, 4, 0.38) 90%,
    rgba(255, 255, 255, 0.85) 97%,
    transparent 100%
  );
  animation: op-prism-run 430ms cubic-bezier(0.16, 1, 0.3, 1) both;
}
@keyframes op-prism-run {
  0% {
    opacity: 0.95;
    transform: translate3d(-96px, 0, 0);
  }
  88% {
    opacity: 0.92;
  }
  100% {
    opacity: 0;
    transform: translate3d(104vw, 0, 0);
  }
}

/* ---- 通道 2：空间锚点取景框 ---- */
.acid-origin-frame {
  position: fixed;
  left: 0;
  top: 0;
  z-index: 985;
  pointer-events: none;
  border: 2px solid #183bff;
  box-shadow: 0 0 0 1px #111216, inset 0 0 0 1px rgba(255, 255, 255, 0.45);
  background: rgba(24, 59, 255, 0.08);
  animation: acid-frame-expand 240ms cubic-bezier(0.16, 1, 0.3, 1) both;
}
.aof-tag {
  position: absolute;
  left: 6px;
  top: 5px;
  padding: 1px 6px;
  background: #183bff;
  color: #ffffff;
  font-family: Consolas, monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1px;
}

.ef-origin-frame {
  position: fixed;
  left: 0;
  top: 0;
  z-index: 985;
  pointer-events: none;
  border: 1.5px solid #fffa00;
  box-shadow: 0 0 0 1px #111214;
  background: rgba(255, 250, 0, 0.04);
  animation: acid-frame-expand 220ms cubic-bezier(0.12, 0.88, 0.2, 1) both;
}
.ef-aof-tag {
  position: absolute;
  left: 0;
  top: 0;
  padding: 2px 9px 2px 6px;
  background: #fffa00;
  color: #111214;
  font-family: Consolas, monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1.1px;
  clip-path: polygon(0 0, calc(100% - 6px) 0, 100% 6px, 100% 100%, 0 100%);
}

.op-origin-frame {
  position: fixed;
  left: 0;
  top: 0;
  z-index: 985;
  pointer-events: none;
  border-radius: 10px;
  border: 1.5px solid #669df6;
  box-shadow: 0 0 0 3px rgba(155, 114, 203, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.45);
  background: rgba(102, 157, 246, 0.08);
  animation: acid-frame-expand 240ms cubic-bezier(0.16, 1, 0.3, 1) both;
}
.op-aof-tag {
  position: absolute;
  left: 8px;
  top: 7px;
  padding: 2px 8px;
  border-radius: 999px;
  background: linear-gradient(90deg, #4285f4, #9b72cb);
  color: #ffffff;
  font-family: Consolas, monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35);
}

@keyframes acid-frame-expand {
  0% {
    left: var(--fx);
    top: var(--fy);
    width: var(--fw);
    height: var(--fh);
    opacity: 1;
  }
  65% {
    left: 24px;
    top: 46px;
    width: calc(100vw - 48px);
    height: calc(100vh - 70px);
    opacity: 0.92;
  }
  100% {
    left: 10px;
    top: 40px;
    width: calc(100vw - 20px);
    height: calc(100vh - 52px);
    opacity: 0;
  }
}

/* ---- 通道 3：侧栏 → 主画布激光引导脉冲 ---- */
.acid-side-pulse {
  position: fixed;
  right: 20px;
  height: 2px;
  z-index: 970;
  pointer-events: none;
  background: linear-gradient(90deg, #183bff 0%, #183bff 38%, rgba(24, 59, 255, 0) 100%);
  transform-origin: left center;
  animation: acid-pulse-shoot 260ms cubic-bezier(0.16, 1, 0.3, 1) both;
}
@keyframes acid-pulse-shoot {
  0% {
    opacity: 0.95;
    transform: scaleX(0);
  }
  45% {
    opacity: 0.9;
    transform: scaleX(0.65);
  }
  100% {
    opacity: 0;
    transform: scaleX(1) translateX(24px);
  }
}

/* ---- 通道 4A：酸性印刷非阻塞战术过场印章 ---- */
.acid-banner {
  position: fixed;
  right: 26px;
  bottom: 26px;
  z-index: 980;
  pointer-events: none;
  user-select: none;
}
.ab-strip {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 18px 9px 14px;
  background: #183bff;
  color: #ffffff;
  border: 2px solid #111216;
  box-shadow: 6px 6px 0 #111216;
  font-family: 'Segoe UI Black', 'Arial Black', 'Microsoft YaHei UI', sans-serif;
  letter-spacing: 1.5px;
  transform-origin: right center;
  animation: acid-slash 500ms cubic-bezier(0.16, 1, 0.3, 1) both;
}
.ab-arrows {
  font-family: Consolas, monospace;
  font-size: 13px;
  font-weight: 900;
  opacity: 0.9;
}
.ab-code {
  font-size: 16px;
  font-weight: 900;
  font-style: italic;
  letter-spacing: 2px;
}
.ab-sep {
  font-family: Consolas, monospace;
  font-size: 12px;
  opacity: 0.65;
}
.ab-sub {
  font-family: 'Microsoft YaHei UI', 'Segoe UI', sans-serif;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.8px;
  opacity: 0.95;
}
@keyframes acid-slash {
  0% {
    opacity: 0;
    transform: translate3d(42px, 0, 0) skewX(-16deg) scaleX(0.86);
    clip-path: polygon(18% 0, 100% 0, 82% 100%, 0 100%);
  }
  22% {
    opacity: 1;
    transform: translate3d(0, 0, 0) skewX(-10deg) scaleX(1);
    clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%);
  }
  78% {
    opacity: 1;
    transform: translate3d(0, 0, 0) skewX(-10deg) scaleX(1);
    clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%);
  }
  100% {
    opacity: 0;
    transform: translate3d(-24px, 0, 0) skewX(-16deg) scaleX(0.92);
    clip-path: polygon(0 0, 82% 0, 100% 100%, 18% 100%);
  }
}

/* ---- 通道 4B：终末工业精密切角终端播报条 ---- */
.ef-banner {
  position: fixed;
  right: 22px;
  bottom: 22px;
  z-index: 980;
  pointer-events: none;
  user-select: none;
}
.ef-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 16px 7px 13px;
  background: #121417;
  color: #f4f6f9;
  border: 1px solid rgba(255, 255, 255, 0.24);
  border-left: 5px solid #fffa00;
  clip-path: polygon(0 0, calc(100% - 9px) 0, 100% 9px, 100% 100%, 0 100%);
  font-family: 'Segoe UI', 'Microsoft YaHei UI', sans-serif;
  animation: ef-banner-scan 460ms cubic-bezier(0.12, 0.88, 0.2, 1) both;
}
.ef-slash {
  font-family: Consolas, monospace;
  font-size: 12px;
  font-weight: 700;
  color: #fffa00;
}
.ef-code {
  font-family: Consolas, monospace;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 2px;
}
.ef-sep {
  font-family: Consolas, monospace;
  font-size: 11px;
  color: #8a929e;
}
.ef-sub {
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 1px;
  color: #fffa00;
}
@keyframes ef-banner-scan {
  0% {
    opacity: 0;
    transform: translate3d(-14px, 0, 0);
    clip-path: inset(0 100% 0 0);
  }
  20% {
    opacity: 1;
    transform: none;
    clip-path: polygon(0 0, calc(100% - 9px) 0, 100% 9px, 100% 100%, 0 100%);
  }
  80% {
    opacity: 1;
    transform: none;
    clip-path: polygon(0 0, calc(100% - 9px) 0, 100% 9px, 100% 100%, 0 100%);
  }
  100% {
    opacity: 0;
    transform: translate3d(12px, 0, 0);
    clip-path: inset(0 0 0 100%);
  }
}

/* ---- 通道 4C：黑曜棱镜烟熏光谱胶囊播报条 ---- */
.op-banner {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 980;
  pointer-events: none;
  user-select: none;
}
.op-strip {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 16px 8px 12px;
  border-radius: 999px;
  background: rgba(14, 16, 22, 0.94);
  color: #f2f3f7;
  border: 1px solid rgba(218, 228, 255, 0.16);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 12px 30px -8px rgba(0, 0, 0, 0.52);
  font-family: 'Segoe UI', 'Microsoft YaHei UI', sans-serif;
  animation: op-banner-glide 480ms cubic-bezier(0.16, 1, 0.3, 1) both;
}
.op-prism-dot {
  width: 4px;
  height: 16px;
  border-radius: 999px;
  background: linear-gradient(180deg, #4285f4 0%, #9b72cb 40%, #ea4335 76%, #fbbc04 100%);
}
.op-code {
  font-family: Consolas, monospace;
  font-size: 12.5px;
  font-weight: 700;
  letter-spacing: 1.8px;
}
.op-sep {
  font-family: Consolas, monospace;
  font-size: 11px;
  color: #8ab4f8;
  opacity: 0.75;
}
.op-sub {
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.8px;
  color: #8ab4f8;
}
@keyframes op-banner-glide {
  0% {
    opacity: 0;
    transform: translate3d(-16px, 0, 0) scale(0.96);
  }
  22% {
    opacity: 1;
    transform: none;
  }
  80% {
    opacity: 1;
    transform: none;
  }
  100% {
    opacity: 0;
    transform: translate3d(14px, 0, 0) scale(0.97);
  }
}
</style>
