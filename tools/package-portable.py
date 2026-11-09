#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
PicNest 便携分发包打包脚本 (package-portable.py)
生成: D:\zcode工作区\PicNest-v0.1.0-windows-x64.zip
符合画师全合一绿色便携规范与安全约定。
"""

import os
import sys
import subprocess
import zipfile
import hashlib
from pathlib import Path

REPO_ROOT = Path(r"D:\zcode工作区\PicNest")
APP_DIR = REPO_ROOT / "app"
EXT_DIR = REPO_ROOT / "extension"
OUTPUT_ZIP = Path(r"D:\zcode工作区\PicNest-v0.1.0-windows-x64.zip")
TMP_ZIP = Path(r"D:\zcode工作区\PicNest-v0.1.0-windows-x64.zip.tmp")

def send_to_recycle_bin(path: Path):
    if not path.exists():
        return
    print(f"  [recycle] 将旧文件安全移入回收站: {path.name}")
    ps_cmd = f"Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('{str(path)}', [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)"
    res = subprocess.run(["powershell", "-NoProfile", "-Command", ps_cmd], capture_output=True, text=True)
    if res.returncode != 0:
        print(f"  [warn] 回收站操作受限: {res.stderr.strip()}")

def main():
    print("=" * 60)
    print("🪺 [PicNest] 开始打包画师免安装便携版 (PicNest-v0.1.0-windows-x64.zip)...")
    print(f"  - 源码根目录 : {REPO_ROOT}")
    print(f"  - App 运行时 : {APP_DIR}")
    print(f"  - 目标产物   : {OUTPUT_ZIP}")
    print("=" * 60)

    # 1. 移走旧包
    if OUTPUT_ZIP.exists():
        send_to_recycle_bin(OUTPUT_ZIP)
    if TMP_ZIP.exists():
        send_to_recycle_bin(TMP_ZIP)

    # APP 运行时排除名单（开发缓存与冗余二进制）
    APP_EXCLUDE_DIRS = {"_internal_data", ".git", ".vite", ".vite-temp"}
    APP_EXCLUDE_FILES = {"debug.log", "steam_api64.dll", "LICENSE"} # LICENSE 统一使用根目录的 GPL-3.0

    def should_skip_app_file(name: str):
        if name in APP_EXCLUDE_FILES:
            return True
        if name.endswith(".bak") or name.endswith(".tmp") or name.endswith(".log"):
            return True
        return False

    total_added = 0

    with zipfile.ZipFile(TMP_ZIP, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        # 1. 打包 app/ 下的所有文件 (包含 resources/app/node_modules 生产运行时依赖)
        print("\n[1/3] 正在封装主程序与运行时 (app/)...")
        for root, dirs, files in os.walk(APP_DIR):
            dirs[:] = [d for d in dirs if d not in APP_EXCLUDE_DIRS]
            rel_dir = os.path.relpath(root, APP_DIR)
            for f in files:
                if should_skip_app_file(f):
                    continue
                full_path = os.path.join(root, f)
                if rel_dir == ".":
                    arcname = f"PicNest/{f}"
                else:
                    arcname = f"PicNest/{rel_dir.replace(os.sep, '/')}/{f}"
                z.write(full_path, arcname)
                total_added += 1

        # 2. 打包根目录文档
        print("\n[2/3] 正在封装开源合规与说明文档 (README/LICENSE/NOTICE)...")
        doc_files = ["README.md", "LICENSE", "NOTICE"]
        for doc in doc_files:
            doc_path = REPO_ROOT / doc
            if doc_path.exists():
                z.write(doc_path, f"PicNest/{doc}")
                total_added += 1
                print(f"  + PicNest/{doc}")

        # 3. 打包浏览器采集扩展
        print("\n[3/3] 正在封装浏览器采集扩展 (extension/)...")
        EXT_EXCLUDE_DIRS = {".git", "node_modules", ".vite"}
        for root, dirs, files in os.walk(EXT_DIR):
            dirs[:] = [d for d in dirs if d not in EXT_EXCLUDE_DIRS]
            rel_dir = os.path.relpath(root, EXT_DIR)
            for f in files:
                if f.endswith(".bak") or f.endswith(".tmp") or f.endswith(".log"):
                    continue
                full_path = os.path.join(root, f)
                if rel_dir == ".":
                    arcname = f"PicNest/浏览器采集扩展 (extension)/{f}"
                else:
                    arcname = f"PicNest/浏览器采集扩展 (extension)/{rel_dir.replace(os.sep, '/')}/{f}"
                z.write(full_path, arcname)
                total_added += 1

    # 4. 重命名为正式文件
    TMP_ZIP.rename(OUTPUT_ZIP)
    size_bytes = OUTPUT_ZIP.stat().st_size
    size_mb = size_bytes / (1024 * 1024)

    # 5. 计算 SHA-256
    print("\n[calc] 正在计算发布包 SHA-256 校验码...")
    sha256 = hashlib.sha256()
    with open(OUTPUT_ZIP, "rb") as f:
        while chunk := f.read(1024 * 1024):
            sha256.update(chunk)
    digest = sha256.hexdigest().upper()

    print("\n" + "=" * 60)
    print("✨ 便携全家桶包压制完毕！")
    print(f"📦 文件路径 : {OUTPUT_ZIP}")
    print(f"📊 文件大小 : {size_bytes:,} 字节 ({size_mb:.2f} MB)")
    print(f"🔑 文件总数 : {total_added} 个")
    print(f"🔒 SHA-256  : {digest}")
    print("=" * 60)

if __name__ == "__main__":
    main()
