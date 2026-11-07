const { Worker } = require('worker_threads')
const wp = 'D:/zcode工作区/PicNest/app/resources/app/out/main/scan-worker.cjs'
const w = new Worker(wp, { workerData: { dir: 'C:\\Users\\feb\\Desktop\\好图' } })
w.on('message', (r) => {
  console.log('worker 返回:', r.length, '个文件')
  console.log('样例:', r[0] && r[0].path)
})
w.on('error', (e) => console.log('worker 错误:', e.message))
w.on('exit', (c) => console.log('exit code:', c))
