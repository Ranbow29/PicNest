// PicNest 渲染层运行时探针：经 CDP 在页面里执行 JS 并回显结果
// 用法: node tools/cdp-eval.mjs "表达式"   （要求 PicNest 以 --remote-debugging-port=9222 启动）
const expr = process.argv[2]
if (!expr) { console.error('need expression'); process.exit(1) }

const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find((t) => t.type === 'page' && /127\.0\.0\.1:5173|picnest/i.test(t.url + t.title)) || list.find((t) => t.type === 'page')
if (!page) { console.error('no page target'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
const console_ = []
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    console_.push('TIMEOUT after 30s — console so far: ' + console_.slice(-8).join(' | '))
    resolve({ result: { value: '__TIMEOUT__\n' + console_.join('\n') } })
  }, 30000)
  ws.onopen = () => {
    ws.send(JSON.stringify({ id: 0, method: 'Runtime.enable' }))
    ws.send(JSON.stringify({ id: 1, method: 'Log.enable' }))
    ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true } }))
  }
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Runtime.consoleAPICalled') {
      console_.push('[' + msg.params.type + '] ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      console_.push('[EXC] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text))
    }
    if (msg.method === 'Log.entryAdded') {
      console_.push('[' + msg.params.entry.level + '] ' + msg.params.entry.text)
    }
    if (msg.id === 2) { clearTimeout(timer); resolve(msg.result) }
  }
  ws.onerror = (e) => { clearTimeout(timer); reject(new Error('ws error')) }
})
ws.close()
if (result.exceptionDetails) {
  console.log('EXCEPTION:', result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails))
} else {
  console.log(typeof result.result.value === 'string' ? result.result.value : JSON.stringify(result.result.value, null, 1))
}
