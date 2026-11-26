<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useLibrary } from '../stores/library'

/* ==========================================================================
   像素双宠伴侣栖息台：小紫猫 (Cat) & 小克 (Clawd)
   像素文法与角色灵感致谢：RMvdesi/obsidian-prism (GPL-3.0)
   - 零黑描边、纯方块几何、暗部阴影 's'、1x2 竖瞳 'o'
   - 8.3fps (120ms) 离散像素节拍 + 页面隐藏自动休眠 + 尊重减少动效
   ========================================================================== */
const lib = useLibrary()

const wrapEl = ref(null)
const canvasEl = ref(null)

const PX = 2
const H_CSS = 40
const TICK_MS = 120
const GROUND_G = 18 // y = 36px 踩地基准线

const PAL = {
  cat: { '#': '#947fd6', s: '#735eb5', o: '#141413' },
  clawd: { '#': '#d97757', s: '#bf684c', o: '#141413' },
}
const AURORA = ['#669df6', '#9b72cb', '#ea4335', '#fbbc04']

/* 16 宽像素点阵部件（纯方块几何，零黑边） */
const SPR = {
  catEars: [
    '..#..........#..',
    '..##........##..',
  ],
  catEarsFold: [
    '.#............#.',
    '.###........###.',
  ],
  catBody: [
    '..############..',
    '..############..',
    '..############..',
    '..############..',
    '..############..',
    '..############..',
    '..############..',
  ],
  catLoaf: [
    '..#..........#..',
    '..##........##..',
    '..############..',
    '.##############.',
    '.##############.',
    '.##############.',
    '.##############.',
  ],
  clawdBody: [
    '..############..',
    '..############..',
    '..############..',
    '..############..',
    '..############..',
    '..############..',
    '..############..',
    '..############..',
  ],
  clawdCrouch: [
    '..############..',
    '..############..',
    '..############..',
    '..############..',
    '..############..',
    '.##############.',
    '.##############.',
  ],
  eyesOpen: [
    '....o......o....',
    '....o......o....',
  ],
  eyesOpenL: [
    '...o......o.....',
    '...o......o.....',
  ],
  eyesOpenR: [
    '.....o......o...',
    '.....o......o...',
  ],
  eyesShut: [
    '...oo......oo...',
  ],
  eyesHappy: [
    '...o........o...',
    '..o.o......o.o..',
  ],
  legsStand: [
    '...#.#....#.#...',
    '...#.#....#.#...',
  ],
  legsWalkA: [
    '...#.s....#.s...',
    '...#........#...',
  ],
  legsWalkB: [
    '...s.#....s.#...',
    '.....#......#...',
  ],
  legsCheer: [
    '...#.#....#.#...',
    '..#..#....#..#..',
  ],
  clawsIdle: [
    '##............##',
    '##............##',
  ],
  clawsUp: [
    '##............##',
    '.#............#.',
  ],
  tailA: [
    '...............#',
    '..............##',
    '..............s.',
  ],
  tailB: [
    '..............#.',
    '.............##.',
    '..............s.',
  ],
  heart: [
    '.r.r.',
    'rrrrr',
    '.rrr.',
    '..r..',
  ],
  star: [
    '..y..',
    '.yyy.',
    'yyyyy',
    '.yyy.',
    '..y..',
  ],
  zzz: [
    'zzz',
    '.z.',
    'zzz',
  ],
}

/* 运行时物理与行为状态 */
let widthCss = 220
let timer = 0
let ro = null
let reduced = false
let lastInteractAt = Date.now()

const st = {
  tick: 0,
  aurora: false,
  catStreak: 0,
  catStreakUntil: 0,
  stackUntil: 0,
  cat: {
    x: 24,
    targetX: 24,
    dir: 1,
    jumpY: 0,
    vy: 0,
    mood: 'idle', // idle | happy | cheer | loaf
    moodUntil: 0,
  },
  clawd: {
    x: 68,
    targetX: 68,
    dir: -1,
    jumpY: 0,
    vy: 0,
    mood: 'idle', // idle | happy | cheer | sleep
    moodUntil: 0,
  },
  particles: [],
}

function clampX(x) {
  const max = Math.max(16, widthCss - 36)
  return Math.max(6, Math.min(max, x))
}

function spawnParticle(kind, x, y) {
  if (st.particles.length > 10) st.particles.shift()
  st.particles.push({ kind, x, y, life: 12 })
}

function triggerCelebrate(particleKind = 'heart') {
  lastInteractAt = Date.now()
  const until = Date.now() + 2600
  st.cat.mood = 'cheer'
  st.cat.moodUntil = until
  st.cat.vy = -4.2
  st.clawd.mood = 'cheer'
  st.clawd.moodUntil = until
  st.clawd.vy = -3.8
  spawnParticle(particleKind, st.cat.x + 11, GROUND_G * PX - 26)
  spawnParticle(particleKind, st.clawd.x + 11, GROUND_G * PX - 26)
  draw()
}

function enterQuietRest() {
  st.stackUntil = 0
  st.cat.mood = 'loaf'
  st.cat.moodUntil = Date.now() + 30000
  st.clawd.mood = 'sleep'
  st.clawd.moodUntil = Date.now() + 30000
  draw()
}

function pickWander(pet, other) {
  const minBound = 8
  const maxBound = Math.max(24, widthCss - 38)
  if (maxBound <= minBound) return
  let cand = minBound + Math.random() * (maxBound - minBound)
  // 防重叠安全间距（约 36px），接近时停步对望贴贴
  if (Math.abs(cand - other.x) < 34) {
    cand = other.x > (minBound + maxBound) / 2
      ? Math.max(minBound, other.x - 36)
      : Math.min(maxBound, other.x + 36)
  }
  pet.targetX = cand
  pet.dir = cand >= pet.x ? 1 : -1
}

function stepActor(pet, other, now, isSleeping) {
  // 垂直跳跃回落
  if (pet.jumpY < 0 || pet.vy !== 0) {
    pet.jumpY += pet.vy
    pet.vy += 1.4
    if (pet.jumpY >= 0) {
      pet.jumpY = 0
      pet.vy = 0
    }
  }
  if (pet.mood !== 'idle' && now > pet.moodUntil) {
    pet.mood = 'idle'
  }
  if (isSleeping || pet.mood === 'loaf' || pet.mood === 'sleep') return

  const dx = pet.targetX - pet.x
  if (Math.abs(dx) > 2.2) {
    const step = Math.sign(dx) * 2.4
    const nextX = clampX(pet.x + step)
    if (Math.abs(nextX - other.x) >= 32 || Math.abs(nextX - other.x) > Math.abs(pet.x - other.x)) {
      pet.x = nextX
    } else {
      pet.targetX = pet.x
    }
  } else if (Math.random() < 0.045) {
    pickWander(pet, other)
  }
}

function update() {
  const now = Date.now()
  st.tick += 1
  const idleLong = now - lastInteractAt > 14000
  const stacked = now < st.stackUntil

  if (idleLong && !stacked && st.cat.mood === 'idle') {
    st.cat.mood = 'loaf'
    st.cat.moodUntil = now + 8000
    st.clawd.mood = 'sleep'
    st.clawd.moodUntil = now + 8000
  }

  if (stacked) {
    // 叠罗汉期间下层小克稍微居中，上层小紫猫坐在它头顶同步跟随
    st.clawd.mood = 'idle'
    st.cat.mood = 'loaf'
    if (st.cat.jumpY < 0 || st.cat.vy !== 0) {
      st.cat.jumpY += st.cat.vy
      st.cat.vy += 1.4
      if (st.cat.jumpY >= 0) { st.cat.jumpY = 0; st.cat.vy = 0 }
    }
    st.cat.x = st.clawd.x
  } else {
    stepActor(st.cat, st.clawd, now, st.cat.mood === 'loaf')
    stepActor(st.clawd, st.cat, now, st.clawd.mood === 'sleep')
  }

  // 打盹呼吸 zZZ 粒子
  if (!stacked && (st.cat.mood === 'loaf' || st.clawd.mood === 'sleep') && st.tick % 16 === 0) {
    const sleeper = st.cat.mood === 'loaf' ? st.cat : st.clawd
    spawnParticle('zzz', sleeper.x + 24, GROUND_G * PX - 22)
  }

  // 粒子飘散生命周期
  for (let i = st.particles.length - 1; i >= 0; i--) {
    const p = st.particles[i]
    p.y -= 1.1
    p.life -= 1
    if (p.life <= 0) st.particles.splice(i, 1)
  }
}

function drawGrid(ctx, rows, x0, y0, pal) {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]
    for (let c = 0; c < row.length; c++) {
      const ch = row[c]
      if (ch === '.') continue
      const fill = pal[ch]
      if (!fill) continue
      ctx.fillStyle = fill
      ctx.fillRect(x0 + c * PX, y0 + r * PX, PX, PX)
    }
  }
}

function drawAuroraCape(ctx, x0, y0) {
  // 4 色流动彩虹极光披风像素带（每 2 tick 流动一格）
  const shift = Math.floor(st.tick / 2)
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = AURORA[(i + shift) % AURORA.length]
    ctx.fillRect(x0 + (1 + i) * PX, y0 + 2 * PX, PX, PX)
  }
  for (let r = 3; r <= 7; r++) {
    ctx.fillStyle = AURORA[(r + shift) % AURORA.length]
    ctx.fillRect(x0 + 1 * PX, y0 + r * PX, PX, PX)
    ctx.fillStyle = AURORA[(r + 2 + shift) % AURORA.length]
    ctx.fillRect(x0 + 14 * PX, y0 + r * PX, PX, PX)
  }
}

function drawCat(ctx, now, stacked) {
  const c = st.cat
  const x0 = Math.round(c.x)
  const walking = !stacked && c.mood === 'idle' && Math.abs(c.targetX - c.x) > 2.2
  const bounce = (walking && st.tick % 2 === 1) || c.mood === 'cheer' && st.tick % 2 === 1 ? -PX : 0

  if (stacked) {
    // 坐在小克头顶的面包猫（下层小克蹲在 y=GROUND_G-7，上层基准在 y=GROUND_G-14）
    const y0 = Math.round((GROUND_G - 14) * PX + c.jumpY)
    drawGrid(ctx, SPR.catLoaf, x0, y0, PAL.cat)
    drawGrid(ctx, SPR.eyesHappy, x0, y0 + 4 * PX, PAL.cat)
    if (st.aurora) drawAuroraCape(ctx, x0, y0 + PX)
    return
  }

  const y0 = Math.round((GROUND_G - 9) * PX + c.jumpY + bounce)
  if (c.mood === 'loaf') {
    const ly = Math.round((GROUND_G - 7) * PX + c.jumpY)
    // 地面柔影
    ctx.fillStyle = 'rgba(20, 20, 19, 0.14)'
    ctx.fillRect(x0 + 2 * PX, GROUND_G * PX, 12 * PX, PX)
    drawGrid(ctx, SPR.catLoaf, x0, ly, PAL.cat)
    drawGrid(ctx, SPR.eyesShut, x0, ly + 4 * PX, PAL.cat)
    if (st.aurora) drawAuroraCape(ctx, x0, ly + PX)
    return
  }

  // 地面柔影
  ctx.fillStyle = 'rgba(20, 20, 19, 0.14)'
  ctx.fillRect(x0 + 2 * PX, GROUND_G * PX, 12 * PX, PX)

  // 耳朵（偶发抖耳）
  const ears = (c.mood === 'cheer' || st.tick % 29 === 0) ? SPR.catEarsFold : SPR.catEars
  drawGrid(ctx, ears, x0, y0 - 2 * PX, PAL.cat)

  // 身体
  drawGrid(ctx, SPR.catBody, x0, y0, PAL.cat)

  // 极光披风彩蛋
  if (st.aurora) drawAuroraCape(ctx, x0, y0)

  // 尾巴轻摇
  const tail = st.tick % 6 < 3 ? SPR.tailA : SPR.tailB
  drawGrid(ctx, tail, x0, y0 + 2 * PX, PAL.cat)

  // 眼睛（开心 / 眨眼 / 左右张望）
  let eyes = c.dir > 0 ? SPR.eyesOpenR : SPR.eyesOpenL
  if (c.mood === 'happy' || c.mood === 'cheer') eyes = SPR.eyesHappy
  else if (st.tick % 24 === 0) eyes = SPR.eyesShut
  else if (!walking && Math.abs(c.x - st.clawd.x) < 42) eyes = st.clawd.x > c.x ? SPR.eyesOpenR : SPR.eyesOpenL
  drawGrid(ctx, eyes, x0, y0 + 2 * PX, PAL.cat)

  // 腿脚
  const legs = walking ? (st.tick % 2 === 0 ? SPR.legsWalkA : SPR.legsWalkB) : (c.mood === 'cheer' ? SPR.legsCheer : SPR.legsStand)
  drawGrid(ctx, legs, x0, y0 + 7 * PX, PAL.cat)

  // 欢呼举小爪
  if (c.mood === 'cheer') {
    const cy = st.tick % 2 === 0 ? y0 - PX : y0
    drawGrid(ctx, SPR.clawsUp, x0, cy, PAL.cat)
  }
}

function drawClawd(ctx, now, stacked) {
  const k = st.clawd
  const x0 = Math.round(k.x)
  const walking = !stacked && k.mood === 'idle' && Math.abs(k.targetX - k.x) > 2.2
  const bounce = (walking && st.tick % 2 === 0) || (k.mood === 'cheer' && st.tick % 2 === 0) ? -PX : 0

  // 地面柔影
  ctx.fillStyle = 'rgba(20, 20, 19, 0.14)'
  ctx.fillRect(x0 + 2 * PX, GROUND_G * PX, 12 * PX, PX)

  if (stacked) {
    const sy = Math.round((GROUND_G - 7) * PX + k.jumpY)
    drawGrid(ctx, SPR.clawdCrouch, x0, sy, PAL.clawd)
    drawGrid(ctx, SPR.eyesHappy, x0, sy + 2 * PX, PAL.clawd)
    drawGrid(ctx, SPR.clawsIdle, x0, sy + 3 * PX, PAL.clawd)
    return
  }

  const y0 = Math.round((GROUND_G - 10) * PX + k.jumpY + bounce)
  drawGrid(ctx, SPR.clawdBody, x0, y0, PAL.clawd)

  // 钳子（挥爪欢呼 / 常态）
  const clawY = k.mood === 'cheer' ? y0 + PX : y0 + 4 * PX
  drawGrid(ctx, k.mood === 'cheer' ? SPR.clawsUp : SPR.clawsIdle, x0, clawY, PAL.clawd)

  // 眼睛
  let eyes = k.dir > 0 ? SPR.eyesOpenR : SPR.eyesOpenL
  if (k.mood === 'sleep') eyes = SPR.eyesShut
  else if (k.mood === 'happy' || k.mood === 'cheer') eyes = SPR.eyesHappy
  else if (st.tick % 31 === 0) eyes = SPR.eyesShut
  else if (!walking && Math.abs(k.x - st.cat.x) < 42) eyes = st.cat.x > k.x ? SPR.eyesOpenR : SPR.eyesOpenL
  drawGrid(ctx, eyes, x0, y0 + 2 * PX, PAL.clawd)

  // 四条腿
  const legs = walking ? (st.tick % 2 === 0 ? SPR.legsWalkA : SPR.legsWalkB) : SPR.legsStand
  drawGrid(ctx, legs, x0, y0 + 8 * PX, PAL.clawd)
}

function drawParticles(ctx) {
  for (const p of st.particles) {
    const x0 = Math.round(p.x)
    const y0 = Math.round(p.y)
    if (p.kind === 'heart') {
      drawGrid(ctx, SPR.heart, x0, y0, { r: '#ff4d6d' })
    } else if (p.kind === 'star') {
      drawGrid(ctx, SPR.star, x0, y0, { y: '#fbbf24' })
    } else {
      drawGrid(ctx, SPR.zzz, x0, y0, { z: '#8ab4f8' })
    }
  }
}

function draw() {
  const cv = canvasEl.value
  if (!cv) return
  const ctx = cv.getContext('2d')
  if (!ctx) return
  const dpr = window.devicePixelRatio || 1
  const tw = Math.max(1, Math.round(widthCss * dpr))
  const th = Math.max(1, Math.round(H_CSS * dpr))
  if (cv.width !== tw || cv.height !== th) {
    cv.width = tw
    cv.height = th
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, widthCss, H_CSS)

  const now = Date.now()
  const stacked = now < st.stackUntil
  drawClawd(ctx, now, stacked)
  drawCat(ctx, now, stacked)
  drawParticles(ctx)
}

function syncSize() {
  const w = wrapEl.value?.clientWidth
  if (w && w > 0) {
    widthCss = w
    st.cat.x = clampX(st.cat.x)
    st.cat.targetX = clampX(st.cat.targetX)
    st.clawd.x = clampX(st.clawd.x)
    st.clawd.targetX = clampX(st.clawd.targetX)
    draw()
  }
}

function startLoop() {
  stopLoop()
  if (reduced || document.visibilityState === 'hidden') return
  timer = setInterval(() => {
    update()
    draw()
  }, TICK_MS)
}

function stopLoop() {
  if (timer) { clearInterval(timer); timer = 0 }
}

function onVisibility() {
  if (document.visibilityState === 'hidden') stopLoop()
  else { draw(); startLoop() }
}

/* 交互：单击戳戳（连点小紫猫 3 次解锁极光披风），双击触发叠罗汉，右键切换极光披风 */
function onStageClick(e) {
  const r = canvasEl.value?.getBoundingClientRect?.()
  if (!r) return
  const cx = e.clientX - r.left
  const now = Date.now()
  lastInteractAt = now

  // 若处于叠罗汉状态，点一下欢快跳下
  if (now < st.stackUntil) {
    st.stackUntil = 0
    st.cat.vy = -4.2
    st.cat.x = clampX(st.clawd.x - 34)
    st.cat.targetX = st.cat.x
    st.cat.mood = 'happy'
    st.cat.moodUntil = now + 1800
    spawnParticle('heart', st.cat.x + 12, GROUND_G * PX - 22)
    draw()
    return
  }

  const hitCat = Math.abs(cx - (st.cat.x + 16)) < 20
  const hitClawd = Math.abs(cx - (st.clawd.x + 16)) < 20

  if (hitCat) {
    st.cat.vy = -4.2
    st.cat.mood = 'happy'
    st.cat.moodUntil = now + 1800
    spawnParticle('heart', st.cat.x + 11, GROUND_G * PX - 24)
    if (now < st.catStreakUntil) st.catStreak += 1
    else st.catStreak = 1
    st.catStreakUntil = now + 900
    if (st.catStreak >= 3) {
      st.catStreak = 0
      st.aurora = !st.aurora
      spawnParticle('star', st.cat.x + 11, GROUND_G * PX - 28)
    }
  } else if (hitClawd) {
    st.clawd.vy = -4.0
    st.clawd.mood = 'happy'
    st.clawd.moodUntil = now + 1800
    spawnParticle('heart', st.clawd.x + 11, GROUND_G * PX - 24)
  } else {
    // 点空白地面：唤醒并吸引靠得更近的那只小跑过来贴贴
    st.cat.mood = 'idle'
    st.clawd.mood = 'idle'
    const dCat = Math.abs(cx - (st.cat.x + 16))
    const dClawd = Math.abs(cx - (st.clawd.x + 16))
    const runner = dCat <= dClawd ? st.cat : st.clawd
    runner.targetX = clampX(cx - 16)
    runner.dir = runner.targetX >= runner.x ? 1 : -1
    runner.vy = -2.4
  }
  draw()
}

function onStageDblClick() {
  const now = Date.now()
  lastInteractAt = now
  st.stackUntil = now + 6000
  st.cat.vy = -4.6
  st.cat.x = st.clawd.x
  spawnParticle('heart', st.clawd.x + 11, GROUND_G * PX - 30)
  draw()
}

function toggleAurora() {
  lastInteractAt = Date.now()
  st.aurora = !st.aurora
  spawnParticle(st.aurora ? 'star' : 'heart', st.cat.x + 11, GROUND_G * PX - 26)
  draw()
}

/* 图库真实交互联动：5 星评分 / 导入新图欢呼 / 灯箱安静陪伴 */
watch(
  () => [lib.selectedPath, lib.selected?.rating],
  ([newPath, newRating], [oldPath, oldRating]) => {
    if (newPath && newPath === oldPath && newRating === 5 && oldRating !== 5) {
      triggerCelebrate('star')
    }
  },
)

watch(
  () => lib.counts?.all,
  (n, o) => {
    if (typeof o === 'number' && o > 0 && n > o) {
      triggerCelebrate('heart')
    }
  },
)

watch(
  () => lib.lightbox?.open,
  (open) => {
    if (open) enterQuietRest()
  },
)

onMounted(() => {
  reduced = !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
  syncSize()
  if (wrapEl.value && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(syncSize)
    ro.observe(wrapEl.value)
  }
  document.addEventListener('visibilitychange', onVisibility)
  startLoop()
})

onBeforeUnmount(() => {
  stopLoop()
  ro?.disconnect()
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<template>
  <div
    ref="wrapEl"
    class="mascot-stage"
    title="小紫猫 & 小克 · 单击戳戳 / 双击叠罗汉 / 右键极光披风"
    @click="onStageClick"
    @dblclick.stop="onStageDblClick"
    @contextmenu.prevent="toggleAurora"
  >
    <canvas ref="canvasEl" class="mascot-canvas" />
  </div>
</template>

<style scoped>
.mascot-stage {
  flex: none;
  height: 40px;
  margin: 2px 0 0;
  border-top: 1px solid var(--border);
  background: color-mix(in srgb, var(--panel-strong) 42%, transparent);
  cursor: pointer;
  user-select: none;
  overflow: hidden;
  transition: background 0.18s ease;
}
.mascot-stage:hover {
  background: color-mix(in srgb, var(--accent-weak) 55%, transparent);
}
.mascot-canvas {
  display: block;
  width: 100%;
  height: 40px;
  image-rendering: pixelated;
}
</style>
