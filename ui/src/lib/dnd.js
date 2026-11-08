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

/* 外部拖入：Windows 文件/文件夹（Files）或浏览器图片 URL（text/uri-list）。
   内部拖拽即使被系统附加了 text/uri-list，也绝不按外部导入处理。 */
export function isExternalDT(e) {
  if (isInternalDT(e)) return false
  const t = dndTypes(e)
  return t.includes('Files') || t.includes('text/uri-list')
}
