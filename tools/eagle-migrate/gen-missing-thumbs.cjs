#!/usr/bin/env node
// 补齐迁移根的缺失缩略图（400px JPEG；文本/视频/PSD/PDF 跳过，交给现有管线或保持未索引）。
// 用法：ELECTRON_RUN_AS_NODE=1 app\PicNest.exe tools\eagle-migrate\gen-missing-thumbs.cjs
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

const root = path.resolve(__dirname, '..', '..')
const dbPath = process.argv.includes('--db')
  ? process.argv[process.argv.indexOf('--db') + 1]
  : [path.join(root, 'app/_internal_data/picrand.db'), path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'PicNest', 'picrand.db')].find((p) => fs.existsSync(p))
if (!dbPath) { console.error('no db'); process.exit(2) }
const folderId = Number(process.argv[process.argv.indexOf('--root') + 1]) || 456
const cacheDir = path.join(path.dirname(dbPath), 'cache')
fs.mkdirSync(cacheDir, { recursive: true })
const Database = require(path.join(root, 'app/resources/app/node_modules/better-sqlite3'))
const sharp = require(path.join(root, 'app/resources/app/node_modules/sharp'))
const db = new Database(dbPath)
db.pragma('busy_timeout = 8000')
const rows = db.prepare(`SELECT id, file_path, file_name FROM images
  WHERE folder_id = ? AND deleted_at IS NULL
    AND (thumbnail_path IS NULL OR thumbnail_path = '' OR thumbnail_path = 'SKIP')`).all(folderId)
const SKIP = new Set(['.txt', '.md', '.markdown', '.log', '.json', '.jsonc', '.csv', '.tsv', '.ini', '.cfg', '.conf', '.yaml', '.yml', '.psd', '.pdf', '.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v', '.gif'])
const jobs = rows.filter((r) => {
  const ext = path.extname(r.file_name).toLowerCase()
  return !SKIP.has(ext) && fs.existsSync(r.file_path)
})
const upd = db.prepare('UPDATE images SET thumbnail_path = ? WHERE id = ?')
let next = 0, ok = 0, fail = 0
const failures = []
const t0 = Date.now()
async function worker() {
  while (true) {
    const i = next++
    if (i >= jobs.length) return
    const r = jobs[i]
    const ext = path.extname(r.file_name).toLowerCase()
    const dest = path.join(cacheDir, crypto.createHash('md5').update(r.file_path).digest('hex') + '.jpg')
    try {
      await sharp(r.file_path, { animated: false }).rotate()
        .flatten({ background: '#ffffff' })
        .resize({ width: 400, withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toFile(dest)
      upd.run(dest, r.id)
      ok++
    } catch (e) {
      fail++
      failures.push({ file: r.file_path, error: String(e?.message || e) })
    }
    if ((ok + fail) % 200 === 0) console.log(`thumbs ${ok + fail}/${jobs.length} · ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  }
}
async function main() {
  await Promise.all(Array.from({ length: 4 }, worker))
  console.log(JSON.stringify({ db: dbPath, folderId, candidates: jobs.length, ok, fail, elapsedSec: Math.round((Date.now() - t0) / 1000), failures: failures.slice(0, 10) }, null, 1))
}
main().catch((e) => { console.error(e); process.exit(1) })
