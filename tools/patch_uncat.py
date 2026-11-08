# 临时补丁脚本：viewCounts 加 uncategorized + images-by-dir 支持 __loose__
import io

p = r"D:\zcode工作区\PicNest\tools\patches\picnest-handlers.js"
s = io.open(p, encoding="utf-8").read()

old = '''    trash: db.prepare("SELECT COUNT(*) c FROM images WHERE folder_id = ? AND deleted_at IS NOT NULL").get(folderId).c,
  };'''
new = '''    trash: db.prepare("SELECT COUNT(*) c FROM images WHERE folder_id = ? AND deleted_at IS NOT NULL").get(folderId).c,
    uncategorized: (() => {
      const root = db.prepare("SELECT path FROM folders WHERE id = ?").get(folderId);
      if (!root) return 0;
      const esc = picnestLikeEscape(root.path + path.sep);
      return db.prepare("SELECT COUNT(*) c FROM images WHERE folder_id = ? AND deleted_at IS NULL AND file_path LIKE ? ESCAPE '\\\\' AND file_path NOT LIKE ? ESCAPE '\\\\'").get(folderId, esc + "%", esc + "%" + path.sep + "%").c;
    })(),
  };'''
assert old in s, "viewCounts anchor missing"
s = s.replace(old, new)

old = '''  const sep = root.path.includes("\\\\") ? "\\\\" : "/";
  const platRel = dirRel ? dirRel.split("/").join(sep) + sep : "";
  const pattern = picnestLikeEscape(root.path + sep + platRel) + "%";'''
new = '''  const sep = root.path.includes("\\\\") ? "\\\\" : "/";
  const rootEsc = picnestLikeEscape(root.path + sep);
  let pattern = picnestLikeEscape(root.path + sep + (dirRel && dirRel !== "__loose__" ? dirRel.split("/").join(sep) + sep : "")) + "%";
  const looseOnly = dirRel === "__loose__";
  if (looseOnly) pattern = rootEsc + "%";'''
assert old in s, "imagesByDir head anchor missing"
s = s.replace(old, new)

old = '''  const rows = getDb().prepare(
    `SELECT id, file_path, file_name, file_size, modify_time, width, height, thumbnail_path, is_favorite
     FROM images WHERE folder_id = ? AND deleted_at IS NULL AND file_path LIKE ? ESCAPE '\\\\' ORDER BY ${order} LIMIT ? OFFSET ?`
  ).all(folderId, pattern, limit, offset);'''
new = '''  const rows = looseOnly
    ? getDb().prepare(
      `SELECT id, file_path, file_name, file_size, modify_time, width, height, thumbnail_path, is_favorite
       FROM images WHERE folder_id = ? AND deleted_at IS NULL AND file_path LIKE ? ESCAPE '\\\\' AND file_path NOT LIKE ? ESCAPE '\\\\' ORDER BY ${order} LIMIT ? OFFSET ?`
    ).all(folderId, pattern, rootEsc + "%" + sep + "%", limit, offset)
    : getDb().prepare(
      `SELECT id, file_path, file_name, file_size, modify_time, width, height, thumbnail_path, is_favorite
       FROM images WHERE folder_id = ? AND deleted_at IS NULL AND file_path LIKE ? ESCAPE '\\\\' ORDER BY ${order} LIMIT ? OFFSET ?`
    ).all(folderId, pattern, limit, offset);'''
assert old in s, "rows anchor missing"
s = s.replace(old, new)

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("handlers patched")
