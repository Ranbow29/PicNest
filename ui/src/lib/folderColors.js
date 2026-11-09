// 文件夹配色（8 色预设）：dirMemory[rel].color 的 key → CSS 颜色
// 与 FolderIcon 的 FILLS 保持一致（两处共用同一套色板语义）
export const FOLDER_COLORS = {
  '': '#c9a86c',
  blue: '#5b9bd5',
  green: '#6dbf90',
  red: '#e57373',
  orange: '#f0a45c',
  purple: '#a48ad4',
  cyan: '#5bc4c4',
  pink: '#e88ab8',
}

export function folderTint(key, fallback = 'var(--accent)') {
  if (!key) return FOLDER_COLORS['']
  return FOLDER_COLORS[key] || key || fallback
}
