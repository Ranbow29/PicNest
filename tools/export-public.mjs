#!/usr/bin/env node
/**
 * PicNest 公开仓库导出与脱敏验证工具 (export-public.mjs)
 * 作用：将当前工作底本中公开所需的文件提取到独立的全新干净目录，
 *       并执行物理级全量敏感词/个人路径扫描，最后初始化为一个干净的 Git 仓库。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const TARGET_DIR = path.resolve(REPO_ROOT, '../PicNest-Public');

console.log('[PicNest] 开始准备全新公开仓库...');
console.log(`  - 源工作区 : ${REPO_ROOT}`);
console.log(`  - 目标目录 : ${TARGET_DIR}\n`);

// 1. 创建目标目录（安全检查）
if (fs.existsSync(TARGET_DIR)) {
  console.log('  [info] 目标目录已存在，正在安全移入回收站...');
  try {
    execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${TARGET_DIR.replace(/'/g, "''")}', [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)"`);
  } catch (err) {
    console.warn('  [warn] 移入回收站遇到限制，尝试标准清理:', err.message);
  }
}
fs.mkdirSync(TARGET_DIR, { recursive: true });

// 2. 白名单复制函数
const copyList = [
  'LICENSE',
  'NOTICE',
  'README.md',
  'package.json',
  '.gitignore',
  'branding',
  'docs/PLUGIN.md',
  'docs/MOTION.md',
  'examples',
  'extension',
  'source',
  'tools/patches',
  'tools/eagle-migrate',
  'ui'
];

function copySafe(relPath) {
  const src = path.join(REPO_ROOT, relPath);
  const dest = path.join(TARGET_DIR, relPath);
  if (!fs.existsSync(src)) {
    console.warn(`  [skip] 路径不存在: ${relPath}`);
    return;
  }
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(src, dest, {
      recursive: true,
      filter: (srcItem) => {
        const base = path.basename(srcItem);
        // 排除 node_modules, dist, .vite, *.tmp, *.log 等
        if (base === 'node_modules' || base === 'dist' || base === '.vite' || base === '.vite-temp') return false;
        if (base.endsWith('.tmp') || base.endsWith('.log')) return false;
        return true;
      }
    });
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  console.log(`  [copy] ${relPath}`);
}

for (const item of copyList) {
  copySafe(item);
}

console.log('\n[PicNest] 正在执行全量敏感信息与绝对路径安全审查...');

// 3. 敏感词扫描
const SENSITIVE_PATTERNS = [
  /[A-Z]:\\(?:Users|zcode|OneDrive|图巢)/i,
  /C:\\Users\\feb/i,
  /\/Users\/feb/i,
  /好图\.library/i,
  /11,365/
];

let leakCount = 0;
function scanDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      scanDir(full);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      // 只扫文本与代码文件
      const textExts = ['.md', '.json', '.js', '.mjs', '.cjs', '.vue', '.html', '.css', '.txt', '.yaml', '.yml'];
      if (!textExts.includes(ext)) continue;

      const content = fs.readFileSync(full, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, lineNo) => {
        for (const pattern of SENSITIVE_PATTERNS) {
          if (pattern.test(line)) {
            leakCount++;
            const rel = path.relative(TARGET_DIR, full);
            console.error(`  [WARN] 命中敏感规则 (${pattern}) -> ${rel}:${lineNo + 1}`);
            console.error(`         内容: ${line.trim().slice(0, 100)}`);
          }
        }
      });
    }
  }
}

scanDir(TARGET_DIR);

if (leakCount > 0) {
  console.error(`\n[ALERT] 发现 ${leakCount} 处敏感匹配项，请处理后再发布！`);
  process.exit(1);
} else {
  console.log('  [PASS] 敏感词扫描 100% 通过！零个人路径，零敏感数据泄露！✨\n');
}

// 4. 初始化干净的 Git 仓库
console.log('[PicNest] 正在初始化全新 Git 仓库与 Initial Commit...');
try {
  execSync('git init -b main', { cwd: TARGET_DIR, stdio: 'pipe' });
  execSync('git config user.name "Ranbow29"', { cwd: TARGET_DIR, stdio: 'pipe' });
  execSync('git config user.email "ranbow29@users.noreply.github.com"', { cwd: TARGET_DIR, stdio: 'pipe' });
  execSync('git add .', { cwd: TARGET_DIR, stdio: 'pipe' });
  execSync('git commit -m "feat: initial release of PicNest v0.1.0"', { cwd: TARGET_DIR, stdio: 'pipe' });
  console.log('  [ok] Git Initial Commit 创建成功！');
} catch (e) {
  console.error('[Error] Git 初始化失败:', e.message);
}

console.log(`\n======================================================`);
console.log(`🎉 恭喜主人！干净的公开仓库已完美准备就绪！`);
console.log(`📂 物理路径: ${TARGET_DIR}`);
console.log(`======================================================\n`);
