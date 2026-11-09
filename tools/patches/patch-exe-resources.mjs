#!/usr/bin/env node
/**
 * PicNest exe 资源写入工具 (patch-exe-resources.mjs)
 * 作用：用纯 JS (resedit) 将 PicNest 终稿图标和 VersionInfo 写入 Electron 主程序 (PicNest.exe)。
 * 运行前提：需要在本地安装 resedit (npm i -D resedit 或 npx resedit)
 * 用法：node tools/patches/patch-exe-resources.mjs [--exe path] [--ico path] [--out path]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

// 命令行参数简单解析
const args = process.argv.slice(2);
function getArg(key, defVal) {
  const idx = args.indexOf(key);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return defVal;
}

const exePath = path.resolve(getArg('--exe', path.join(REPO_ROOT, 'app/PicNest.exe')));
const icoPath = path.resolve(getArg('--ico', path.join(REPO_ROOT, 'branding/final/picnest.ico')));
const outPath = path.resolve(getArg('--out', exePath)); // 默认原子覆盖原 exe

async function main() {
  console.log('[PicNest] 开始为可执行文件写入品牌图标与 VersionInfo...');
  console.log(`  - 目标 EXE : ${exePath}`);
  console.log(`  - 图标 ICO : ${icoPath}`);
  console.log(`  - 输出路径 : ${outPath}`);

  if (!fs.existsSync(exePath)) {
    console.error(`[Error] 未找到目标可执行文件: ${exePath}`);
    process.exit(1);
  }
  if (!fs.existsSync(icoPath)) {
    console.error(`[Error] 未找到图标文件: ${icoPath}`);
    process.exit(1);
  }

  let ResEdit;
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    ResEdit = require('resedit');
  } catch {
    try {
      ResEdit = (await import('resedit')).default || (await import('resedit'));
    } catch {
      console.error('[Error] 缺少 resedit 依赖。请在当前或开发环境中安装: npm i -D resedit');
      process.exit(1);
    }
  }

  const exeBuf = fs.readFileSync(exePath);
  const exe = ResEdit.NtExecutable.from(exeBuf, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  // 1. 替换图标组
  const icoBuf = fs.readFileSync(icoPath);
  const ifile = ResEdit.Data.IconFile.from(icoBuf);
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    1,
    1033,
    ifile.icons.map(i => i.data)
  );
  console.log(`  [ok] 已注入 ${ifile.icons.length} 帧图标 (picnest.ico)`);

  // 2. 更新 VersionInfo
  let viList = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  let vi = viList[0];
  if (!vi) {
    vi = ResEdit.Resource.VersionInfo.createEmpty();
    vi.outputToResourceEntries(res.entries);
  }

  vi.setFileVersion(0, 1, 0, 0);
  vi.setProductVersion(0, 1, 0, 0);
  vi.setStringValues(
    { lang: 1033, codepage: 1200 },
    {
      FileDescription: 'PicNest 图巢 - 本地素材管理中心',
      ProductName: 'PicNest 图巢',
      CompanyName: 'Ranbow29',
      InternalName: 'PicNest',
      OriginalFilename: 'PicNest.exe',
      LegalCopyright: 'Copyright (C) 2026 Ranbow29. Derived from PicRand 2.77.0 under GPL-3.0.',
      ProductVersion: '0.1.0',
      FileVersion: '0.1.0.0',
    }
  );
  vi.outputToResourceEntries(res.entries);
  console.log('  [ok] 已写入 VersionInfo (v0.1.0, Ranbow29, GPL-3.0)');

  // 3. 生成新二进制
  res.outputResource(exe);
  const newBuf = Buffer.from(exe.generate());

  const tmpOut = outPath + '.tmp';
  fs.writeFileSync(tmpOut, newBuf);
  fs.renameSync(tmpOut, outPath);

  console.log(`[PicNest] 成功！已将图标和 VersionInfo 写入: ${outPath}\n`);
}

main().catch(err => {
  console.error('[PicNest] 资源写入失败:', err);
  process.exit(1);
});
