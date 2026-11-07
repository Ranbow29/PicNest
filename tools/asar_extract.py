# 临时探针：从 Eagle app.asar 抽取单个文件（只读）
import json, struct, sys

ASAR = r"D:\zcode工作区\eagle\Eagle\resources\app.asar"
TARGET = "app/app.bundle.js"
OUT = r"D:\zcode工作区\PicNest\tmp_eagle\app.bundle.js"

with open(ASAR, "rb") as f:
    f.seek(4)
    header_size = struct.unpack("<I", f.read(4))[0]
    f.seek(12)
    json_len = struct.unpack("<I", f.read(4))[0]
    header = json.loads(f.read(json_len).decode("utf-8", "ignore"))
    data_base = 8 + header_size

    node = header
    for part in TARGET.split("/"):
        node = node["files"][part]
    offset, size = node["offset"], node["size"]
    f.seek(data_base + int(offset))
    data = f.read(size)

import os
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "wb") as g:
    g.write(data)
print("extracted", size, "bytes →", OUT)
