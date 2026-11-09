const { parentPort } = require('worker_threads');
const { readFileSync } = require('fs');
require('ag-psd/initialize-canvas');
const { readPsd } = require('ag-psd');
parentPort.on('message', ({ psdPath }) => {
  try {
    const buf = readFileSync(psdPath);
    const psd = readPsd(buf, { skipLayerImageData: true, skipThumbnail: true, useImageData: true });
    const { data, width, height } = psd.imageData;
    parentPort.postMessage({ ok: true, psdPath, width, height, pixels: Buffer.from(data.buffer, data.byteOffset, data.byteLength) }, [data.buffer]);
  } catch(e) {
    parentPort.postMessage({ ok: false, psdPath, error: e.message || String(e) });
  }
});
parentPort.postMessage({ ready: true });
