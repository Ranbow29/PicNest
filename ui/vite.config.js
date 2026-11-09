import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// dev: 主进程 isDev 模式加载 http://localhost:5173（PICNEST_DEV=1 启动 PicNest.exe）
// build: 产出直接进 fork 的 dist（主进程 loadFile 加载它）
export default defineConfig({
  plugins: [vue()],
  base: './', // 必须：主进程用 loadFile(file://) 加载 dist，绝对路径会指向盘符根
  server: {
    port: 5173, strictPort: true, host: '127.0.0.1', // IPv4：Chromium 对 ::1-only 监听会 ERR_CONNECTION_REFUSED
    watch: { usePolling: true, interval: 350 }, // 工作区盘/杀软下原生 watch 会漏改动，导致模板缓存不失效
  },
  build: {
    outDir: '../app/resources/app/dist',
    emptyOutDir: true,
  },
})
