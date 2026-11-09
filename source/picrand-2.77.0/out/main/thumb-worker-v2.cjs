const fs = require('fs');
const sharp = require('sharp');
const taskFile = process.argv[2];
const tasks = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
(async () => {
  const out = [];
  for (const t of tasks) {
    try {
      if (fs.existsSync(t.output)) { out.push({ ok: true, file_path: t.file_path, thumbnail_path: t.output, skipped: true }); continue; }
      const m = await sharp(t.input).metadata();
      let p = sharp(t.input).toColourspace('srgb');
      if (!t.noResize) p = p.resize({ width: 400, withoutEnlargement: true });
      const fmt = t.format === 'jpg' ? 'jpeg' : 'webp';
      await p[fmt]({ quality: t.quality || 75 }).toFile(t.output);
      out.push({ ok: true, file_path: t.file_path, thumbnail_path: t.output, width: m.width || 0, height: m.height || 0 });
    } catch (e) {
      out.push({ ok: false, file_path: t.file_path, error: (e && e.message) || String(e) });
    }
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
})().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
