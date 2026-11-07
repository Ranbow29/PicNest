const fs = require('fs')
const d = 'C:\\Users\\feb\\Desktop\\好图'
console.log('exists:', fs.existsSync(d))
try {
  const items = fs.readdirSync(d, { withFileTypes: true })
  console.log('顶层条目:', items.length)
  console.log('样例:', items.slice(0, 6).map((i) => (i.isDirectory() ? '[D]' : '[F]') + i.name).join(' | '))
  // 手动走一遍 worker 的逻辑
  const exts = new Set(['.jpg','.jpeg','.png','.gif','.bmp','.webp','.tiff','.tif','.avif','.svg','.psd','.heic','.heif','.mp4','.webm','.mov','.mkv','.avi','.flv','.f4v'])
  let n = 0
  function walk(dir) {
    let items2
    try { items2 = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of items2) {
      if (e.isDirectory()) { walk(require('path').join(dir, e.name)); continue }
      if (e.isFile() && exts.has(require('path').extname(e.name).toLowerCase())) n++
    }
  }
  walk(d)
  console.log('worker 同款递归计数:', n)
} catch (e) {
  console.log('readdir error:', e.message)
}
