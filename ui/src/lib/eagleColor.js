// Eagle 同款颜色筛选算法：sRGB→LAB(D65) + CIE DeltaE 1976/2000
// 公式为公开 CIE 标准；阈值语义与 Eagle 一致：d2000 < accuracy && d76 < accuracy + 50

export function rgb2lab(r, g, b) {
  let rr = r / 255, gg = g / 255, bb = b / 255
  const f = (c) => (c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92)
  rr = f(rr); gg = f(gg); bb = f(bb)
  // sRGB → XYZ（D65）
  let x = rr * 0.4124564 + gg * 0.3575761 + bb * 0.1804375
  let y = rr * 0.2126729 + gg * 0.7151522 + bb * 0.072175
  let z = rr * 0.0193339 + gg * 0.119192 + bb * 0.9503041
  // XYZ → LAB（参考白 D65）
  const xn = 0.95047, yn = 1.0, zn = 1.08883
  const g2 = (t) => (t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116))
  x = g2(x / xn); y = g2(y / yn); z = g2(z / zn)
  return { L: 116 * y - 16, A: 500 * (x - y), B: 200 * (y - z) }
}

export function deltaE76(c1, c2) {
  const a = rgb2lab(c1[0], c1[1], c1[2])
  const b = rgb2lab(c2[0], c2[1], c2[2])
  const dA = a.A - b.A, dB = a.B - b.B, dL = a.L - b.L
  return Math.sqrt(dA * dA + dB * dB + dL * dL)
}

// CIEDE2000 标准公式
export function deltaE2000(c1, c2) {
  const p1 = rgb2lab(c1[0], c1[1], c1[2])
  const p2 = rgb2lab(c2[0], c2[1], c2[2])
  const L1 = p1.L, a1 = p1.A, b1 = p1.B
  const L2 = p2.L, a2 = p2.A, b2 = p2.B
  const kL = 1, kC = 1, kH = 1
  const C1 = Math.sqrt(a1 * a1 + b1 * b1)
  const C2 = Math.sqrt(a2 * a2 + b2 * b2)
  const Cbar = (C1 + C2) / 2
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cbar, 7) / (Math.pow(Cbar, 7) + Math.pow(25, 7))))
  const a1p = (1 + G) * a1
  const a2p = (1 + G) * a2
  const C1p = Math.sqrt(a1p * a1p + b1 * b1)
  const C2p = Math.sqrt(a2p * a2p + b2 * b2)
  const h1p = C1p === 0 ? 0 : ((Math.atan2(b1, a1p) * 180) / Math.PI + 360) % 360
  const h2p = C2p === 0 ? 0 : ((Math.atan2(b2, a2p) * 180) / Math.PI + 360) % 360
  const dLp = L2 - L1
  const dCp = C2p - C1p
  let dhp = 0
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p
    if (dhp > 180) dhp -= 360
    else if (dhp < -180) dhp += 360
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360)
  const Lbp = (L1 + L2) / 2
  const Cbp = (C1p + C2p) / 2
  let hbp = h1p + h2p
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) {
      if (h1p + h2p < 360) hbp = (h1p + h2p + 360) / 2
      else hbp = (h1p + h2p - 360) / 2
    }
  } else {
    hbp = h1p + h2p
  }
  const T = 1 - 0.17 * Math.cos(((hbp - 30) * Math.PI) / 180) + 0.24 * Math.cos((2 * hbp * Math.PI) / 180) + 0.32 * Math.cos(((3 * hbp + 6) * Math.PI) / 180) - 0.2 * Math.cos(((4 * hbp - 63) * Math.PI) / 180)
  const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2))
  const Rc = 2 * Math.sqrt(Math.pow(Cbp, 7) / (Math.pow(Cbp, 7) + Math.pow(25, 7)))
  const Sl = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2))
  const Sc = 1 + 0.045 * Cbp
  const Sh = 1 + 0.015 * Cbp * T
  const Rt = -Math.sin((2 * dTheta * Math.PI) / 180) * Rc
  return Math.sqrt(
    Math.pow(dLp / (kL * Sl), 2) +
    Math.pow(dCp / (kC * Sc), 2) +
    Math.pow(dHp / (kH * Sh), 2) +
    Rt * (dCp / (kC * Sc)) * (dHp / (kH * Sh))
  )
}

// Eagle 灰度判定：所有占比 ≥2% 的色板通道两两差 <8
export function isGrayPalettes(palettes) {
  if (!palettes || !palettes.length) return false
  for (const p of palettes) {
    if ((p.percent ?? 0) >= 2) {
      if (Math.abs(p.r - p.g) >= 8 || Math.abs(p.r - p.b) >= 8 || Math.abs(p.g - p.b) >= 8) return false
    }
  }
  return true
}
