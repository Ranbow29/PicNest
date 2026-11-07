# PicNest 验收：文件系统真相 vs 库内索引 逐目录对账
# 运行中的应用持有 WAL，先拷 db/wal/shm 副本再查（打开副本自动回放 WAL）
# 用法: python tools/verify_counts.py [根目录=Desktop好图]
import sqlite3, os, sys, tempfile, shutil

root = sys.argv[1] if len(sys.argv) > 1 else r'C:\Users\feb\Desktop\好图'
db = r'D:\zcode工作区\PicNest\app\_internal_data\picrand.db'
exts = {'.jpg','.jpeg','.png','.gif','.bmp','.webp','.tiff','.tif','.avif','.svg','.psd','.heic','.heif','.mp4','.webm','.mov','.mkv','.avi','.flv','.f4v'}

tmp = tempfile.mkdtemp()
for suffix in ('', '-wal', '-shm'):
    try:
        shutil.copy(db + suffix, os.path.join(tmp, 'copy.db' + suffix))
    except OSError:
        pass

truth = {}          # 每个目录直属文件数
for dp, dns, fns in os.walk(root):
    rel = os.path.relpath(dp, root).replace(os.sep, '/')
    if rel == '.':
        continue
    truth[rel] = sum(1 for f in fns if os.path.splitext(f)[1].lower() in exts)

# 递归口径（与 picnest-dir-tree 的 total 对齐）：父目录 = 直属 + 全部子孙
truth_recur = dict(truth)
for rel in sorted(truth, key=lambda k: -k.count('/')):
    if '/' in rel:
        parent = rel.rsplit('/', 1)[0]
        truth_recur[parent] = truth_recur.get(parent, 0) + truth_recur[rel]

con = sqlite3.connect(os.path.join(tmp, 'copy.db'))
cur = con.cursor()
total = cur.execute('SELECT COUNT(*) FROM images').fetchone()[0]
fs_total = sum(truth.values())
print(f'库总数: {total}   文件系统总数: {fs_total}   一致: {total == fs_total}')

db_dirs = {}
thumbs = 0
for (p, t) in cur.execute('SELECT file_path, thumbnail_path FROM images').fetchall():
    rel = os.path.relpath(os.path.dirname(p), root).replace(os.sep, '/')
    if rel != '.':
        top = rel.split('/')[0]
        db_dirs[top] = db_dirs.get(top, 0) + 1
    if t:
        thumbs += 1

diffs = [(d, n, truth_recur.get(d, -1)) for d, n in sorted(db_dirs.items()) if truth_recur.get(d, -1) != n]
print('逐目录对账:', '全部一致 [OK]' if not diffs else f'存在 {len(diffs)} 处差异 [NG]', f'(顶层目录 {len(db_dirs)} 个)')
for d, n, t in diffs[:10]:
    print(f'  {d}: 库={n} 实际={t}')
print(f'缩略图已生成: {thumbs}/{total}')
con.close()
shutil.rmtree(tmp, ignore_errors=True)
