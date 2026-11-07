// PicNest 渲染层截屏探针：经 CDP Page.captureScreenshot 存 PNG（比 PrintWindow 稳，无旧帧竞态）
// 用法: node tools/cdp-shot.mjs [输出路径]   （要求 PicNest 以 --remote-debugging-port=9222 启动）
import fs from 'node:fs'

const out = process.argv[2] || 'tools/shot.png'

const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find((t) => t.type === 'page' && /127\.0\.0\.1:5173|picnest/i.test(t.url + t.title)) || list.find((t) => t.type === 'page')
if (!page) { console.error('no page target'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timeout')), 15000)
  ws.onopen = () => {
    ws.send(JSON.stringify({ id: 1, method: 'Page.enable' }))
    ws.send(JSON.stringify({ id: 2, method: 'Page.captureScreenshot', params: { format: 'png' } }))
  }
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id === 2) { clearTimeout(timer); resolve(msg.result) }
  }
  ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')) }
})
ws.close()
fs.writeFileSync(out, Buffer.from(result.data, 'base64'))
console.log('saved:', out)
