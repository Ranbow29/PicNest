// 临时探针：CDP 侧触发 reload 并抓取页面异常/控制台（连接保持不断）
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find((t) => t.type === 'page' && /127\.0\.0\.1:5173|picnest/i.test(t.url + t.title)) || list.find((t) => t.type === 'page')

const ws = new WebSocket(page.webSocketDebuggerUrl)
const seen = []
ws.onopen = () => {
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }))
  ws.send(JSON.stringify({ id: 2, method: 'Log.enable' }))
  ws.send(JSON.stringify({ id: 3, method: 'Page.enable' }))
  ws.send(JSON.stringify({ id: 4, method: 'Page.reload' }))
}
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.method === 'Runtime.exceptionThrown') {
    seen.push('[EXC] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 400))
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    seen.push('[err] ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300))
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    seen.push('[log] ' + m.params.entry.text.slice(0, 300))
  }
}
setTimeout(() => {
  console.log(seen.length ? seen.join('\n') : '(no exceptions captured)')
  process.exit(0)
}, 6000)
