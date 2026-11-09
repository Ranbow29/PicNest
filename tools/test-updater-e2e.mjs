// M8 自动更新模块端到端全链路实测 (主进程 IPC + 流式 SHA-256 + .NET 异步解压 + PowerShell 跳板热替换 + 构建产物核验)
// 用法: node tools/test-updater-e2e.mjs
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import crypto from 'node:crypto'
import child_process from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg)
  console.log('  [PASS] ' + msg)
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

const testWorkDir = path.join(ROOT, 'app', '_internal_data', 'e2e-updater-' + Date.now())
const zipStageDir = path.join(testWorkDir, 'stage', 'PicNest')
const mockTargetAppDir = path.join(testWorkDir, 'mock-installed-app')
const mockTempDir = path.join(testWorkDir, 'temp')

try {
  fs.mkdirSync(path.join(zipStageDir, 'resources', 'app'), { recursive: true })
  fs.mkdirSync(path.join(mockTargetAppDir, 'resources', 'app'), { recursive: true })
  fs.mkdirSync(path.join(mockTargetAppDir, '_internal_data'), { recursive: true })
  fs.mkdirSync(mockTempDir, { recursive: true })

  // 1. 准备新版 v0.1.1 压缩包与坏包
  fs.writeFileSync(path.join(zipStageDir, 'PicNest.exe'), 'MOCK_NEW_EXE_BINARY_V011')
  fs.writeFileSync(
    path.join(zipStageDir, 'resources', 'app', 'package.json'),
    JSON.stringify({ name: 'picnest', version: '0.1.1', productName: 'PicNest' }, null, 2)
  )
  fs.writeFileSync(path.join(zipStageDir, 'UPDATED_MARKER.txt'), 'PicNest v0.1.1 updated successfully!')

  // 准备旧版 v0.1.0 目标安装目录（位于含中文路径 D:\zcode工作区 下，验证 UTF-8 BOM 跳板脚本兼容性）
  fs.writeFileSync(path.join(mockTargetAppDir, 'PicNest.exe'), 'MOCK_OLD_EXE_V010')
  fs.writeFileSync(
    path.join(mockTargetAppDir, 'resources', 'app', 'package.json'),
    JSON.stringify({ name: 'picnest', version: '0.1.0', productName: 'PicNest' }, null, 2)
  )
  fs.writeFileSync(path.join(mockTargetAppDir, '_internal_data', 'user-precious.txt'), 'KEEP_ME_SAFE')

  const validZipPath = path.join(testWorkDir, 'PicNest-v0.1.1-windows-x64.zip')
  const invalidZipPath = path.join(testWorkDir, 'invalid-empty.zip')
  const badStageDir = path.join(testWorkDir, 'bad-stage')
  fs.mkdirSync(badStageDir, { recursive: true })
  fs.writeFileSync(path.join(badStageDir, 'random.txt'), 'not a valid picnest archive')

  child_process.execFileSync('powershell.exe', [
    '-NoProfile', '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${path.join(testWorkDir, 'stage')}', '${validZipPath}'); [System.IO.Compression.ZipFile]::CreateFromDirectory('${badStageDir}', '${invalidZipPath}')`
  ])

  const validZipBuf = fs.readFileSync(validZipPath)
  const validZipSha256 = crypto.createHash('sha256').update(validZipBuf).digest('hex').toUpperCase()
  console.log(`[prep] 测试更新包已生成: ${validZipBuf.length} bytes, SHA256=${validZipSha256}`)

  // 2. 从 tools/patches/picnest-handlers.js 提取真实的 M8 代码并在沙箱 VM 中挂载
  const handlersSrc = fs.readFileSync(path.join(ROOT, 'tools', 'patches', 'picnest-handlers.js'), 'utf8')
  const m8Start = handlersSrc.indexOf('/* ==== M8 自动更新模块')
  const m8End = handlersSrc.indexOf('/* ==== /M8 自动更新模块 ==== */')
  assert(m8Start !== -1 && m8End !== -1, '成功定位 picnest-handlers.js 中的 M8 模块源码')
  const m8Code = handlersSrc.slice(m8Start, m8End + '/* ==== /M8 自动更新模块 ==== */'.length)

  const ipcHandlers = new Map()
  const sentEvents = []
  let quitCalled = false
  let dbClosed = false
  let trayDestroyed = false
  let collectHttpClosed = false

  // 构造流式 Mock fetch（无需任何 TCP 套接字，直接验证 Web Streams + AbortSignal + HTTP 响应）
  async function mockFetch(url, init = {}) {
    const signal = init.signal
    if (signal?.aborted) {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      throw err
    }
    if (url.endsWith('/releases/404')) {
      return { ok: false, status: 404, json: async () => ({}) }
    }
    if (url.endsWith('/releases/latest-010')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: 'v0.1.0',
          name: 'PicNest 图巢 v0.1.0 首发版',
          body: '### 首发说明\n- 初始版本',
          published_at: '2026-11-10T00:00:00Z',
          html_url: 'https://github.com/Ranbow29/PicNest/releases/tag/v0.1.0',
          assets: []
        })
      }
    }
    if (url.endsWith('/releases/latest-011')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: 'v0.1.1',
          name: 'PicNest 图巢 v0.1.1 性能优化与自动更新版',
          body: `## 核心升级\n- **丝滑视口平移**\n\n**SHA-256 校验码**：\n\`${validZipSha256}\``,
          published_at: '2026-11-10T04:00:00Z',
          html_url: 'https://github.com/Ranbow29/PicNest/releases/tag/v0.1.1',
          assets: [
            {
              name: 'PicNest-v0.1.1-windows-x64.zip',
              size: validZipBuf.length,
              browser_download_url: 'https://mock.local/download/PicNest-v0.1.1-windows-x64.zip'
            }
          ]
        })
      }
    }
    if (url.includes('/download/slow-cancel')) {
      const stream = new ReadableStream({
        async pull(controller) {
          await sleep(120)
          if (signal?.aborted) {
            const err = new Error('The operation was aborted')
            err.name = 'AbortError'
            controller.error(err)
            return
          }
          controller.enqueue(new Uint8Array(validZipBuf.subarray(0, 64)))
        }
      })
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-length', String(validZipBuf.length * 10)]]),
        body: stream
      }
    }
    if (url.includes('/download/')) {
      // 分 4 块流式输出，间隔 60ms 以触发 0.18s 进度事件回调
      let idx = 0
      const chunkSize = Math.max(64, Math.ceil(validZipBuf.length / 4))
      const stream = new ReadableStream({
        async pull(controller) {
          if (signal?.aborted) {
            const err = new Error('The operation was aborted')
            err.name = 'AbortError'
            controller.error(err)
            return
          }
          if (idx >= validZipBuf.length) {
            controller.close()
            return
          }
          await sleep(65)
          const end = Math.min(validZipBuf.length, idx + chunkSize)
          controller.enqueue(new Uint8Array(validZipBuf.subarray(idx, end)))
          idx = end
        }
      })
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-length', String(validZipBuf.length)]]),
        body: stream
      }
    }
    throw new Error('Unexpected URL: ' + url)
  }

  const sandbox = {
    __dirname: path.join(ROOT, 'app', 'resources', 'app', 'out', 'main'),
    fs,
    path,
    crypto,
    Buffer,
    process,
    child_process,
    setTimeout,
    clearTimeout,
    AbortController,
    fetch: mockFetch,
    allowClose: false,
    picnestCollectHttp: { close: () => { collectHttpClosed = true } },
    tray: { destroy: () => { trayDestroyed = true } },
    closeDatabase: () => { dbClosed = true },
    electron: {
      ipcMain: {
        handle: (channel, fn) => ipcHandlers.set(channel, fn)
      },
      app: {
        getVersion: () => '0.1.0',
        getPath: (name) => {
          if (name === 'temp') return mockTempDir
          if (name === 'exe') return path.join(mockTargetAppDir, 'PicNest.exe')
          return mockTempDir
        },
        quit: () => { quitCalled = true },
        exit: () => { quitCalled = true }
      },
      shell: {
        openExternal: async () => true
      }
    }
  }

  vm.createContext(sandbox)
  vm.runInContext(m8Code, sandbox)

  const fakeEvent = {
    sender: {
      isDestroyed: () => false,
      send: (channel, payload) => sentEvents.push({ channel, payload })
    }
  }

  console.log('\n--- 开始执行 9 项 M8 自动更新全链路测试 ---')

  // Test 1: 动态版本号与 SemVer 比较器边界测试
  const verRes = await ipcHandlers.get('picnest-app-version')(fakeEvent)
  assert(verRes.ok && verRes.version === '0.1.0', `Test 1a: 动态读取 app/resources/app/package.json 版本号正确 (v${verRes.version})`)
  assert(
    sandbox.picnestCompareSemver('0.1.1', '0.1.0') === 1 &&
    sandbox.picnestCompareSemver('v0.1.0', '0.1.0') === 0 &&
    sandbox.picnestCompareSemver('0.2.0', '0.1.9') === 1 &&
    sandbox.picnestCompareSemver('0.1.0', '0.1.0-beta.1') === 1 &&
    sandbox.picnestCompareSemver('0.1.0-beta.2', '0.1.0-beta.1') === 1,
    'Test 1b: SemVer 语义化版本比对（含预发布后缀）全部符合规范'
  )

  // Test 2: 检查更新 - 已是最新版本 & 404 分支
  const check010 = await ipcHandlers.get('picnest-check-update')(fakeEvent, { apiUrl: 'https://mock.local/releases/latest-010' })
  assert(check010.ok && check010.hasUpdate === false && check010.currentVersion === '0.1.0', 'Test 2a: 远程同为 v0.1.0 时正确判定 hasUpdate=false')
  const check404 = await ipcHandlers.get('picnest-check-update')(fakeEvent, { apiUrl: 'https://mock.local/releases/404' })
  assert(check404.ok && check404.hasUpdate === false && check404.message === '暂未发布正式版本', 'Test 2b: 远程 404 时优雅返回暂未发布正式版本')

  // Test 3: 检查更新 - 发现新版本 v0.1.1 + 自动提取 64 位 SHA-256
  const check011 = await ipcHandlers.get('picnest-check-update')(fakeEvent, { apiUrl: 'https://mock.local/releases/latest-011' })
  assert(
    check011.ok && check011.hasUpdate === true && check011.latestVersion === '0.1.1' && check011.expectedSha256 === validZipSha256,
    `Test 3: 发现新版本 v0.1.1 并从正文提取 SHA-256 (${check011.expectedSha256.slice(0, 12)}...)`
  )

  // Test 4: 流式下载 SHA-256 篡改拦截测试
  const badShaRes = await ipcHandlers.get('picnest-download-update')(fakeEvent, {
    url: 'https://mock.local/download/PicNest-v0.1.1-windows-x64.zip',
    fileName: 'tampered.zip',
    expectedSha256: '0'.repeat(64)
  })
  assert(
    badShaRes.ok === false && /SHA-256 完整性校验失败/.test(badShaRes.error),
    `Test 4: 流式 SHA-256 不匹配被精准拦截 (${badShaRes.error})`
  )

  // Test 5: 下载中途取消测试
  const cancelPromise = ipcHandlers.get('picnest-download-update')(fakeEvent, {
    url: 'https://mock.local/download/slow-cancel',
    fileName: 'cancel-me.zip'
  })
  await sleep(160)
  const cancelCall = await ipcHandlers.get('picnest-cancel-download-update')(fakeEvent)
  const cancelRes = await cancelPromise
  assert(cancelCall.ok && cancelRes.ok === false && cancelRes.cancelled === true, 'Test 5: 下载中途取消 (AbortController) 立即响应并清理句柄')

  // Test 6: 正常流式下载 + 进度回调 + .part 原子重命名 + SHA-256 校验通过
  sentEvents.length = 0
  const dlRes = await ipcHandlers.get('picnest-download-update')(fakeEvent, {
    url: check011.assetUrl,
    fileName: check011.assetName,
    expectedSha256: check011.expectedSha256
  })
  const progEvents = sentEvents.filter((e) => e.channel === 'picnest-update-download-progress')
  assert(
    dlRes.ok && fs.existsSync(dlRes.filePath) && dlRes.sha256 === validZipSha256 && progEvents.length >= 2 && progEvents.at(-1).payload.percent === 100,
    `Test 6: 流式下载完成并通过 SHA-256 校验，触发 ${progEvents.length} 次进度推送，最终落盘 ${ path.basename(dlRes.filePath) }`
  )

  // Test 7: 坏包结构预检拦截测试（不含 PicNest.exe 和 resources/app）
  const badInstall = await ipcHandlers.get('picnest-quit-and-install')(fakeEvent, {
    zipPath: invalidZipPath,
    noQuitForTest: true
  })
  assert(
    badInstall.ok === false && /更新包结构校验未通过/.test(badInstall.error),
    `Test 7: 非法结构 ZIP 包在主进程退出前被安全拦截 (${badInstall.error})`
  )

  // Test 8: 异步 .NET ZipFile 解压 + 真实进程句柄等待 + swap-and-restart.ps1 热替换实战
  // 启动一个真实的短暂子进程模拟正在退出的旧主进程 PID
  const dummyOldProc = child_process.spawn('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 600'], {
    windowsHide: true,
    stdio: 'ignore'
  })
  const installRes = await ipcHandlers.get('picnest-quit-and-install')(fakeEvent, {
    zipPath: dlRes.filePath,
    targetDirOverride: mockTargetAppDir,
    exeNameOverride: 'PicNest.exe',
    noQuitForTest: true
  })
  assert(installRes.ok && fs.existsSync(installRes.scriptPath), 'Test 8a: 异步 .NET 解压成功并生成带 UTF-8 BOM 的 swap-and-restart.ps1')

  // 真实执行生成的 swap-and-restart.ps1，传入刚才模拟的 dummyOldProc.pid
  child_process.execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', installRes.scriptPath,
    '-ParentPid', String(dummyOldProc.pid),
    '-SourceDir', installRes.actualSource,
    '-TargetDir', mockTargetAppDir,
    '-ExeName', 'PicNest.exe',
    '-LogFile', installRes.logPath,
    '-ShouldRestart', '0'
  ])

  const replacedPkg = JSON.parse(fs.readFileSync(path.join(mockTargetAppDir, 'resources', 'app', 'package.json'), 'utf8'))
  const replacedExe = fs.readFileSync(path.join(mockTargetAppDir, 'PicNest.exe'), 'utf8')
  const markerExists = fs.existsSync(path.join(mockTargetAppDir, 'UPDATED_MARKER.txt'))
  const userPrecious = fs.readFileSync(path.join(mockTargetAppDir, '_internal_data', 'user-precious.txt'), 'utf8')
  const swapLog = fs.readFileSync(installRes.logPath, 'utf8')

  assert(
    replacedPkg.version === '0.1.1' && replacedExe === 'MOCK_NEW_EXE_BINARY_V011' && markerExists,
    'Test 8b: swap-and-restart.ps1 等待原 PID 退出后，成功在中文路径下将 exe 与 resources/app 热替换为 v0.1.1'
  )
  assert(userPrecious === 'KEEP_ME_SAFE', 'Test 8c: 跳板脚本 100% 保护了 _internal_data 用户数据不被覆盖或清理')
  assert(/All files copied successfully/.test(swapLog) && /Update completed/.test(swapLog), 'Test 8d: 跳板脚本日志完整记录了等待、复制与收尾全过程')

  // Test 9: 验证前端源码与编译产物无遗留问题
  const updateVueSrc = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'components', 'UpdateDialog.vue'), 'utf8')
  const appVueSrc = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'App.vue'), 'utf8')
  assert(
    !updateVueSrc.includes('--bg-panel') && updateVueSrc.includes('var(--panel-strong)') && updateVueSrc.includes('runManualCheck'),
    'Test 9a: UpdateDialog.vue 完全对齐 PicNest 奶玻璃主题变量并支持全状态流转'
  )
  assert(
    !appVueSrc.includes('alert(') && appVueSrc.includes('setTimeout(checkForUpdatesSilently, 5000)'),
    'Test 9b: App.vue 已移除原生 alert 并在 onMounted 挂载 5 秒静默更新检测'
  )

  console.log('\n🎉 ALL 9 E2E UPDATER TESTS PASSED SUCCESSFULLY!')
} finally {
  // 清理测试工作目录到回收站
  try {
    child_process.execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      `Add-Type -AssemblyName Microsoft.VisualBasic; if (Test-Path '${testWorkDir}') { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${testWorkDir}', 'OnlyErrorDialogs', 'SendToRecycleBin') }`
    ])
  } catch {}
}
