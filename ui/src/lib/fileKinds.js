// 文件类别判定（主进程同名白名单见 tools/patches/picnest-handlers.js PICNEST_TEXT_EXTS，两侧需同步）
export const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi', '.flv', '.f4v'])
export const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.log', '.json', '.jsonc', '.csv', '.tsv', '.ini', '.cfg', '.conf', '.yaml', '.yml'])

export function extOf(p) {
  const s = String(p || '')
  const i = s.lastIndexOf('.')
  const j = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  return i > j ? s.slice(i).toLowerCase() : ''
}
export const isVideoPath = (p) => VIDEO_EXTS.has(extOf(p))
export const isTextPath = (p) => TEXT_EXTS.has(extOf(p))
