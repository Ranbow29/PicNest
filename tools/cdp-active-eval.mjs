// 一次性探针：强制页面 active（解计时器节流）后执行采样表达式
import fs from 'node:fs'
const exprFile = process.argv[2]
const expr = fs.readFileSync(exprFile, 'utf8')

const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find((t) => t.type === 'page') || list[0]
const ws = new WebSocket(page.webSocketDebuggerUrl)

const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => resolve({ value: '__TIMEOUT__' }), 40000)
  let id = 0
  const send = (method, params) => ws.send(JSON.stringify({ id: ++id, method, params }))
  ws.onopen = async () => {
    ws.send(JSON.stringify({ id: 100, method: 'Page.enable' }))
    ws.send(JSON.stringify({ id: 101, method: 'Page.setWebLifecycleState', params: { state: 'active' } }))
    ws.send(JSON.stringify({ id: 103, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } }))
    await new Promise((r) => setTimeout(r, 400))
    ws.send(JSON.stringify({ id: 102, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true } }))
  }
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id === 102) {
      clearTimeout(timer)
      if (m.result.exceptionDetails) resolve({ exception: m.result.exceptionDetails.exception?.description || 'err' })
      else resolve({ value: m.result.result.value })
    }
  }
  ws.onerror = () => reject(new Error('ws error'))
})
ws.close()
console.log(result.exception ? 'EXCEPTION: ' + result.exception : (typeof result.value === 'string' ? result.value : JSON.stringify(result.value)))
