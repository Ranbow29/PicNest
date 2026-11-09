// 拖拽载荷分类：内部拖拽（图片/文件夹）优先于 Chromium 自动附带的 text/uri-list
export const INTERNAL_DND_TYPES = [
  'application/x-picnest-file',
  'application/x-picnest-files',
  'application/x-picnest-dir',
  'application/x-picnest-dirs',
]

export function dndTypes(e) {
  return [...(e.dataTransfer?.types || [])]
}

export function isInternalDT(e) {
  const t = dndTypes(e)
  return INTERNAL_DND_TYPES.some((k) => t.includes(k))
}

/* 原生拖出（Electron startDrag）进行中：窗口内如果收到落回的文件拖拽，必须吞掉，
   否则会把刚拖出的文件又当成外部文件导入一遍（会弹重复添加）。 */
let nativeDragOutUntil = 0

export function markNativeDragOut(ms = 60000) {
  nativeDragOutUntil = Date.now() + ms
}

export function endNativeDragOut() {
  nativeDragOutUntil = 0
}

export function isNativeDragOutActive() {
  return Date.now() < nativeDragOutUntil
}

/* 外部拖入：Windows 文件/文件夹（Files）或浏览器图片 URL（text/uri-list）。
   内部拖拽即使被系统附加了 text/uri-list，也绝不按外部导入处理。 */
export function isExternalDT(e) {
  if (isInternalDT(e)) return false
  const t = dndTypes(e)
  return t.includes('Files') || t.includes('text/uri-list')
}
