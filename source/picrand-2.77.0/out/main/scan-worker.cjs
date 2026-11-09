const fs = require('fs')
const path = require('path')
const { parentPort, workerData } = require('worker_threads')
const exts = new Set(['.jpg','.jpeg','.png','.gif','.bmp','.webp','.tiff','.tif','.avif','.svg','.psd','.heic','.heif','.mp4','.webm','.mov','.mkv','.avi','.flv','.f4v','.txt','.md','.markdown','.log','.json','.jsonc','.csv','.tsv','.ini','.cfg','.conf','.yaml','.yml']); /* PicNest:P9d */
const result = []
function walk(dir) {
  let items
  try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of items) {
    if (entry.name.startsWith(".")) continue
    if (entry.isDirectory()) { walk(path.join(dir, entry.name)); continue } /* PicNest:P9f */
    if (entry.isFile() && exts.has(path.extname(entry.name).toLowerCase())) {
      let s
      try { s = fs.statSync(path.join(dir, entry.name)) } catch { continue }
      result.push({ path: path.join(dir, entry.name), size: s.size, mtimeMs: s.mtimeMs })
    }
  }
}
walk(workerData.dir)
parentPort.postMessage(result)
