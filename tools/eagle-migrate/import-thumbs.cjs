#!/usr/bin/env node
// 把 Eagle 的 _thumbnail.png 预置到 PicNest 缓存，避免迁移后重生成 1.1 万张缩略图。
// 需在目标根索引完成后运行；建议先退出 PicNest 避免 DB 写锁。
// 用法：ELECTRON_RUN_AS_NODE=1 app\PicNest.exe tools\eagle-migrate\import-thumbs.cjs <manifest.json>
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

const root = path.resolve(__dirname, '..', '..')
const argv = process.argv.slice(2)
const manifestPath = path.resolve(argv.find((a) => !a.startsWith('--')) || '')
const dbArg = (() => { const i = argv.indexOf('--db'); return i >= 0 ? argv[i + 1] : '' })()
if (!manifestPath || !fs.existsSync(manifestPath)) {
  console.error('need manifest: import-thumbs.cjs <manifest.json> [--db path]')
  process.exit(2)
}
const dbPath = [dbArg, path.join(root, 'app/_internal_data/picrand.db'), path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'PicNest', 'picrand.db')].filter(Boolean).find((p) => fs.existsSync(p))
if (!dbPath) { console.error('找不到 PicNest 数据库'); process.exit(2) }
const cacheDir = path.join(path.dirname(dbPath), 'cache')
fs.mkdirSync(cacheDir, { recursive: true })
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const Database = require(path.join(root, 'app/resources/app/node_modules/better-sqlite3'))
const db = new Database(dbPath)
db.pragma('busy_timeout = 8000')
const rootRow = db.prepare('SELECT id FROM folders WHERE path = ? COLLATE NOCASE').get(manifest.targetRoot)
if (!rootRow) { console.error('目标根尚未加入 PicNest'); process.exit(3) }
const findImg = db.prepare('SELECT id FROM images WHERE folder_id = ? AND file_path = ? COLLATE NOCASE')
const upd = db.prepare('UPDATE images SET thumbnail_path = ? WHERE id = ?')
let items = 0, thumbs = 0, copied = 0, missingThumb = 0, missingImg = 0
const tx = db.transaction(() => {
  for (const it of manifest.items || []) {
    items++
    const src = String(it.source || '')
    const itemDir = path.dirname(src)
    let thumb = ''
    try {
      const files = fs.readdirSync(itemDir)
      thumb = files.find((f) => /_thumbnail\.[^.]+$/i.test(f)) || ''
      if (thumb) thumb = path.join(itemDir, thumb)
    } catch (e) {}
    if (!thumb || !fs.existsSync(thumb)) { missingThumb++; continue }
    thumbs++
    for (const t of it.targets || []) {
      const row = findImg.get(rootRow.id, t.path)
      if (!row) { missingImg++; continue }
      const ext = path.extname(thumb).toLowerCase() || '.png'
      const dest = path.join(cacheDir, crypto.createHash('md5').update(t.path).digest('hex') + ext)
      try {
        fs.copyFileSync(thumb, dest)
        upd.run(dest, row.id)
        copied++
      } catch (e) {}
    }
  }
})
tx()
console.log(JSON.stringify({ db: dbPath, rootId: rootRow.id, cacheDir, items, thumbs, copied, missingThumb, missingImg }, null, 1))
