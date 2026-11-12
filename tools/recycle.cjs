const { execSync } = require('child_process');
const fs = require('fs');
const target = process.argv[2];
if (target && fs.existsSync(target)) {
  const ps = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${target.replace(/'/g, "''")}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
  execSync(`powershell.exe -NoProfile -Command "${ps}"`);
  console.log('Recycled:', target);
}
