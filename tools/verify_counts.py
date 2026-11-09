# PicNest 验收：多资料库对账（文件系统真相 vs 库内索引，逐库 + 顶层目录）
# 运行中的应用持有 WAL，先拷 db/wal/shm 副本再查（打开副本自动回放 WAL）
# 用法: python tools/verify_counts.py [资料库路径（可选，只查该库）]
import sqlite3, os, sys, tempfile, shutil

DB = r'D:\zcode工作区\PicNest\app\_internal_data\picrand.db'
EXTS = {
    '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.avif', '.svg', '.psd', '.heic', '.heif',
    '.mp4', '.webm', '.mov', '.mkv', '.avi', '.flv', '.f4v',
    # 文本类（与 ui/src/lib/fileKinds.js 同步）
    '.txt', '.md', '.markdown', '.log', '.json', '.jsonc', '.csv', '.tsv', '.ini', '.cfg', '.conf', '.yaml', '.yml',
}


def copy_db():
    tmp = tempfile.mkdtemp()
    for suffix in ('', '-wal', '-shm'):
        try:
            shutil.copy(DB + suffix, os.path.join(tmp, 'copy.db' + suffix))
        except OSError:
            pass
    return tmp


def under(root, p):
    return p == root or p.startswith(root + os.sep) or p.startswith(root + '/')


root_filter = sys.argv[1].rstrip('\\/') if len(sys.argv) > 1 else None
tmp = copy_db()
con = sqlite3.connect(os.path.join(tmp, 'copy.db'))
cur = con.cursor()

try:
    roots = cur.execute('SELECT id, path FROM folders ORDER BY id').fetchall()
except sqlite3.Error:
    roots = []

if not roots:
    print('没有资料库记录（folders 表为空？）')

all_ok = True
for rid, root in roots:
    if root_filter and os.path.normcase(root) != os.path.normcase(root_filter):
        continue
    print(f'\n=== 资料库 #{rid}  {root} ===')
    if not os.path.isdir(root):
        print('  路径不存在，跳过')
        all_ok = False
        continue

    # 文件系统真相（直属文件数，按相对目录；根目录直属文件单独计入总数）
    truth = {}
    root_files = 0
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if not d.startswith('.')]  # .picnest 等隐藏目录不参与对账
        rel = os.path.relpath(dp, root).replace(os.sep, '/')
        n = sum(1 for f in fns if not f.startswith('.') and os.path.splitext(f)[1].lower() in EXTS)
        if rel == '.':
            root_files = n
            continue
        truth[rel] = n
    fs_total = sum(truth.values()) + root_files

    # 递归口径（与 picnest-dir-tree 的 total 对齐）
    truth_recur = dict(truth)
    for rel in sorted(truth, key=lambda k: -k.count('/')):
        if '/' in rel:
            parent = rel.rsplit('/', 1)[0]
            truth_recur[parent] = truth_recur.get(parent, 0) + truth_recur[rel]

    rows = cur.execute(
        'SELECT file_path, thumbnail_path, deleted_at, trash_group FROM images WHERE folder_id = ?', (rid,)
    ).fetchall()
    active = sum(1 for fp, _t, da, _g in rows if da is None)
    soft_in_place = sum(1 for fp, _t, da, g in rows if da is not None and g is None and under(root, fp))
    trashed_outside = sum(1 for fp, _t, da, _g in rows if da is not None and not under(root, fp))
    thumbs = sum(1 for _fp, t, _da, _g in rows if t and t != 'SKIP')
    under_root = active + soft_in_place

    ok = under_root == fs_total
    all_ok = all_ok and ok
    print(f'  库内有效 {active}  ·  原地软删 {soft_in_place}  ·  已移出库外(回收区) {trashed_outside}')
    print(f'  文件系统 {fs_total}  ·  库内(有效+原地软删) {under_root}  ·  {"一致 [OK]" if ok else "不一致 [NG]"}')
    print(f'  缩略图已生成 {thumbs}/{len(rows)}')

    # 顶层目录逐项对账（计入原地软删，匹配磁盘真相）
    db_dirs = {}
    for fp, _t, da, g in rows:
        if da is not None and g is not None:
            continue
        if not under(root, fp):
            continue
        rel = os.path.relpath(os.path.dirname(fp), root).replace(os.sep, '/')
        if rel == '.':
            continue
        top = rel.split('/')[0]
        db_dirs[top] = db_dirs.get(top, 0) + 1
    diffs = [(d, n, truth_recur.get(d, -1)) for d, n in sorted(db_dirs.items()) if truth_recur.get(d, -1) != n]
    print(f'  顶层目录对账: {"全部一致 [OK]" if not diffs else f"存在 {len(diffs)} 处差异 [NG]"}（顶层目录 {len(db_dirs)} 个）')
    for d, n, t in diffs[:10]:
        print(f'    {d}: 库={n} 实际={t}')

con.close()
shutil.rmtree(tmp, ignore_errors=True)
print('\n[总体]', '全部资料库一致 [OK]' if all_ok else '存在差异 [NG]')
sys.exit(0 if all_ok else 1)
