const { app, net } = require('electron');
const fs = require('fs');

const logPath = 'd:\\zcode工作区\\PicNest\\tools\\test-fetch.log';
function log(...args) {
  const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n';
  fs.appendFileSync(logPath, line);
}

fs.writeFileSync(logPath, '[start] Running electron test...\n');

app.whenReady().then(async () => {
  try {
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    const crlf = '\r\n';
    const minimalJpg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
    
    const parts = [
      Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="x"${crlf}${crlf}0`),
      Buffer.from(`${crlf}--${boundary}${crlf}Content-Disposition: form-data; name="y"${crlf}${crlf}0`),
      Buffer.from(`${crlf}--${boundary}${crlf}Content-Disposition: form-data; name="w"${crlf}${crlf}1`),
      Buffer.from(`${crlf}--${boundary}${crlf}Content-Disposition: form-data; name="h"${crlf}${crlf}1`),
      Buffer.from(`${crlf}--${boundary}${crlf}Content-Disposition: form-data; name="page_size"${crlf}${crlf}10`),
      Buffer.from(`${crlf}--${boundary}${crlf}Content-Disposition: form-data; name="image"; filename="query.jpg"${crlf}Content-Type: image/jpeg${crlf}${crlf}`),
      minimalJpg,
      Buffer.from(`${crlf}--${boundary}--${crlf}`)
    ];
    const multipartBody = Buffer.concat(parts);

    log('[test] Sending net.fetch with Uint8Array body and without Content-Length...');
    const res = await net.fetch('https://api.pinterest.com/v3/visual_search/extension/image/', {
      method: 'PUT',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.pinterest.com/',
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body: new Uint8Array(multipartBody)
    });
    log('[test] Status:', res.status, res.statusText);
    const json = await res.json();
    log('[test] JSON status:', json.status);
    log('[test] Results:', json.data?.length);
  } catch (err) {
    log('[test] Error:', err.message, err.stack);
  } finally {
    app.quit();
  }
});
