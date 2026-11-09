import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './style.css'

// PicRand 主进程会拦截窗口关闭并发 confirm-close；M0 阶段直接应答放行
window.picrand?.onConfirmClose?.(() => window.picrand.respondCloseConfirm(true))
// 超大文件夹确认框：默认放行（5 万文件阈值，后续做成设置项）
window.picrand?.onConfirmOversize?.(() => window.picrand.respondOversizeConfirm(true))

createApp(App).use(createPinia()).mount('#app')
