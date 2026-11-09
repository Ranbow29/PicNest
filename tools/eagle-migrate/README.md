# Eagle → PicNest 迁移

一次性把 Eagle `.library` 复制成 PicNest 普通文件夹树，并导入标签、URL、注释、评分。Eagle 原库只读，不修改。

## 前提

- Eagle 库有 `metadata.json` + `images/<id>.info/`。
- 目标目录不要放在 Eagle `.library` 内，也不建议放在 OneDrive 同步目录里（避免云同步复制 18GB）。
- 默认目标：`<目标迁移目录>\<库名>`（可通过 `--target-base` 自定义），库名取 `<库名>.library` 去掉 `.library`。

## 1. 预演（不写文件）

```bat
node tools\eagle-migrate\migrate.mjs
```

输出条目数、目标目录、空间、重名、未归类、失效文件夹引用、多文件夹、unsupported 等。默认库路径从 Eagle Settings 的 `rootDir` 读取；也可 `--library` 指定。

## 2. 执行复制

```bat
node tools\eagle-migrate\migrate.mjs --apply
```

- 完整复制（不硬链接）；目标根必须不存在或为空。
- 同级重名自动加 ` (2)`。
- 未归类 → `_未分类`；文件夹引用失效 → `_未分类\失效文件夹`。
- 多文件夹条目每个有效文件夹各复制一份；失效的副文件夹无法还原。
- 写出 `<目标根>.manifest.json`（在目标根外），记录 item id、源路径、目标路径、标签、URL、注释、评分。

## 3. 加入 PicNest 并索引

在 PicNest 里把目标目录加为根；等 `images` 表里目标根计数稳定。

## 4. 导入元数据（先退出 PicNest）

```bat
set ELECTRON_RUN_AS_NODE=1
app\PicNest.exe tools\eagle-migrate\import-meta.cjs "<目标根>.manifest.json"
```

写入 `url / annotation / rating / tags / image_tags`。标签保留 Eagle 原名。PDF 暂未被 PicNest 索引，会显示 missing；PSD 当前可索引。

## 5. 缩略图加速

Eagle 自带 `_thumbnail.png`，可先预置到 PicNest 缓存（极大加速首发缩略图展示）：

```bat
app\PicNest.exe tools\eagle-migrate\import-thumbs.cjs "<目标根>.manifest.json"
```

对仍缺失的图片（Eagle 没缩略图的 PNG/JPG）并发生成 400px JPEG：

```bat
app\PicNest.exe tools\eagle-migrate\gen-missing-thumbs.cjs --root <PicNest rootId>
```

`--root` 是刚加入的目标根 id；也可 `--db` 指定数据库。

## 验收 / 回滚

- 校验：目标根图片数、文件夹树、标签计数、URL 样本。
- 回滚：PicNest 里移出该根（只删索引），再删除目标目录；Eagle 原库只读不动。
