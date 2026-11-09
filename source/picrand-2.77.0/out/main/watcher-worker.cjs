const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const IMAGE_EXTS = new Set(['.jpg','.jpeg','.png','.gif','.bmp','.webp','.tiff','.tif','.avif','.svg','.psd','.heic','.heif','.mp4','.webm','.mov','.mkv','.avi','.flv','.f4v','.txt','.md','.markdown','.log','.json','.jsonc','.csv','.tsv','.ini','.cfg','.conf','.yaml','.yml']); /* PicNest:P9b */
function extOf(p){ const i=p.lastIndexOf('.'); return i<0?'':p.slice(i).toLowerCase(); }
function isImg(p){ return IMAGE_EXTS.has(extOf(p)); }
// 等价旧 chokidar ignored:/(^|[\\/])\\./ —— 相对路径任一段以点开头则忽略
function inDotEntry(rel){ return String(rel).split(/[\\/]+/).some(function(s){ return s.length > 0 && s.charAt(0) === '.'; }); }
let watcher = null;
let curGen = 0;
parentPort.on('message', (msg) => {
  if (msg && msg.cmd === 'start' && msg.dir) {
    if (watcher) { try { watcher.close(); } catch(e){} watcher = null; }
    curGen = msg.gen;
    try {
      watcher = fs.watch(msg.dir, { recursive: true }, (event, filename) => {
        if (!filename) return;
        if (inDotEntry(filename)) return;
        const full = path.join(msg.dir, filename);
        if (event === 'change') {
          if (isImg(full)) parentPort.postMessage({ evt: 'change', path: full, gen: curGen });
          return;
        }
        // 'rename' 在 fs.watch 语义里 = 创建/删除/改名，用 stat 区分；目录本身忽略（递归监听自动覆盖其内容）
        fs.stat(full, (err, st) => {
          if (err) { parentPort.postMessage({ evt: 'unlink', path: full, gen: curGen }); return; }
          if (st.isFile() && isImg(full)) parentPort.postMessage({ evt: 'add', path: full, gen: curGen });
        });
      });
      watcher.on('error', (e) => parentPort.postMessage({ evt: 'error', msg: String(e && e.message || e), gen: curGen }));
      // 递归监听立即生效，无需像 chokidar 那样先全盘爬目录树
      parentPort.postMessage({ evt: 'ready', ms: 0, gen: curGen });
    } catch(e) {
      parentPort.postMessage({ evt: 'fatal', msg: String(e && e.message || e), gen: curGen });
    }
  } else if (msg && msg.cmd === 'stop') {
    if (watcher) { try { watcher.close(); } catch(e){} watcher = null; }
    parentPort.postMessage({ evt: 'stopped' });
  }
});
