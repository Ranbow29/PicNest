const { parentPort, workerData } = require('worker_threads')
const fs = require('fs')
const path = require('path')
const exts = new Set(['.jpg','.jpeg','.png','.gif','.bmp','.webp','.tiff','.tif','.avif','.svg','.psd','.heic','.heif','.mp4','.webm','.mov','.mkv','.avi','.flv','.f4v','.txt','.md','.markdown','.log','.json','.jsonc','.csv','.tsv','.ini','.cfg','.conf','.yaml','.yml']); /* PicNest:P9a */
let count = 0
const stack = [workerData.dir]
while (stack.length) {
  const cur = stack.pop()
  let entries
  try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
  for (const entry of entries) {
    if (entry.isDirectory()) { stack.push(path.join(cur, entry.name)); continue }
    if (entry.isFile() && exts.has(path.extname(entry.name).toLowerCase())) { count++; if (count >= workerData.limit) { parentPort.postMessage(true); return } }
  }
}
parentPort.postMessage(false)
