#!/usr/bin/env node
// 把 Eagle 迁移 manifest 里的 URL/注释/评分/标签写进 PicNest DB。
// 需在目标根已经加入 PicNest 并完成索引之后运行。
// 用法：ELECTRON_RUN_AS_NODE=1 app\PicNest.exe tools\eagle-migrate\import-meta.cjs <manifest.json>
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const root = path.resolve(__dirname, '..', '..')
const argv = process.argv.slice(2)
const manifestPath = path.resolve(argv.find((a) => !a.startsWith('--')) || '')
const dbArg = (() => {
  const i = argv.indexOf('--db')
  return i >= 0 ? argv[i + 1] : ''
})()
if (!manifestPath || !fs.existsSync(manifestPath)) {
  console.error('need manifest: import-meta.cjs <manifest.json> [--db path]')
  process.exit(2)
}
const candidates = [
  dbArg,
  path.join(root, 'app', '_internal_data', 'picrand.db'),
  path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'PicNest', 'picrand.db'),
].filter(Boolean)
const dbPath = candidates.find((p) => fs.existsSync(p))
if (!dbPath) {
  console.error('找不到 PicNest 数据库，请用 --db 指定')
  process.exit(2)
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const Database = require(path.join(root, 'app', 'resources', 'app', 'node_modules', 'better-sqlite3'))
const db = new Database(dbPath)
db.pragma('busy_timeout = 8000')
db.pragma('journal_mode = WAL')

const rootRow = db.prepare('SELECT id, path FROM folders WHERE path = ? COLLATE NOCASE').get(manifest.targetRoot)
if (!rootRow) {
  console.error('目标根尚未加入 PicNest：' + manifest.targetRoot)
  process.exit(3)
}
const folderId = rootRow.id
const findImage = db.prepare('SELECT id FROM images WHERE folder_id = ? AND file_path = ? COLLATE NOCASE')
const updateMeta = db.prepare('UPDATE images SET url = ?, annotation = ?, rating = ? WHERE id = ?')
const findTag = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE')
const insertTag = db.prepare('INSERT INTO tags(name, created_at) VALUES (?, ?)')
const linkTag = db.prepare('INSERT OR IGNORE INTO image_tags(image_id, tag_id, created_at) VALUES (?, ?, ?)')
db.exec(`CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at INTEGER NOT NULL DEFAULT 0
)`)
db.exec(`CREATE TABLE IF NOT EXISTS image_tags (
  image_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (image_id, tag_id)
)`)

const tagIds = new Map()
function ensureTag(name) {
  const k = String(name || '').trim()
  if (!k) return 0
  const key = k.toLowerCase()
  if (tagIds.has(key)) return tagIds.get(key)
  let row = findTag.get(k)
  if (!row) {
    const info = insertTag.run(k, Date.now())
    row = { id: Number(info.lastInsertRowid) }
  }
  tagIds.set(key, row.id)
  return row.id
}

const stats = { items: 0, targets: 0, found: 0, missing: 0, metaUpdated: 0, tagsLinked: 0, tags: 0, errors: [] }
const tx = db.transaction(() => {
  for (const it of manifest.items || []) {
    stats.items++
    const tags = [...new Set((it.tags || []).map((t) => String(t || '').trim()).filter(Boolean))]
    const ids = tags.map(ensureTag).filter(Boolean)
    stats.tags = tagIds.size
    for (const t of it.targets || []) {
      stats.targets++
      const row = findImage.get(folderId, t.path)
      if (!row) { stats.missing++; continue }
      stats.found++
      if (it.url || it.annotation || it.star) {
        updateMeta.run(it.url || '', it.annotation || '', Number(it.star) || 0, row.id)
        stats.metaUpdated++
      }
      for (const tagId of ids) {
        const info = linkTag.run(row.id, tagId, Date.now())
        stats.tagsLinked += info.changes || 0
      }
    }
  }
})
try { tx() } catch (e) { stats.errors.push(String(e?.message || e)); throw e }
console.log(JSON.stringify({
  db: dbPath,
  rootId: folderId,
  targetRoot: manifest.targetRoot,
  ...stats,
  tags: [...tagIds.entries()].length,
  tagNames: [...new Set((manifest.items || []).flatMap((x) => x.tags || []))],
}, null, 1))
