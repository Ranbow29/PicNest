import fs from 'node:fs';
import path from 'node:path';

const file = 'D:/图巢迁移/好图/【338期】kazumi是什么软件？3万星开源追番神器，全平台免费_哔哩哔哩_bilibili (5).jpg';
if (fs.existsSync(file)) {
  const trashDir = 'D:/图巢迁移/.trash';
  if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir, { recursive: true });
  const dest = path.join(trashDir, path.basename(file));
  fs.renameSync(file, dest);
  console.log('Moved to local trash dir:', dest);
}
