# 临时探针：解 Eagle app.asar 的目录树（只读，不动原文件）
import json, struct, sys

ASAR = r"D:\zcode工作区\eagle\Eagle\resources\app.asar"

with open(ASAR, "rb") as f:
    f.seek(4)
    header_size = struct.unpack("<I", f.read(4))[0]
    f.seek(12)
    json_len = struct.unpack("<I", f.read(4))[0]
    header = json.loads(f.read(json_len).decode("utf-8", "ignore"))

def walk(node, prefix=""):
    for name, child in node.get("files", {}).items():
        path = prefix + "/" + name if prefix else name
        if "files" in child:
            walk(child, path)
        else:
            size = child.get("size", 0)
            if size > 500_000 or path.endswith((".js", ".html")) and size > 50_000:
                print(f"{size:>10}  {path}")

walk(header)
