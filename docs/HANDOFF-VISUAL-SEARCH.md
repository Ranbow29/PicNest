# PicNest 以图找图（Visual Search & Lens Pipeline）架构方案与交接文档

## 📌 一、 v0.1.0 首发正式版交付基线（已完成与全绿封包）

在启动新功能前，PicNest v0.1.0 已完成全链路自动化测试、文档更新与免安装便携版压制：

- **便携包文件**：`D:\zcode工作区\PicNest-v0.1.0-windows-x64.zip`
- **文件体积**：224,182,737 字节 (213.80 MB)
- **文件总数**：5,749 个
- **最终 SHA-256 校验码**：`8A719652B88F880BDA20F58D164016B1A49B6E9BF3FC0F70A3A5AFE26DF02C13`
- **Git 提交基线**：
  - 主工程（`PicNest`）：`fed507f`
  - 公开镜像（`PicNest-Public`）：`993882c`
- **已彻底闭环问题**：
  1. **Popup 脚本初始化崩溃**：补齐 `elTokenInput` / `elTokenBox` / `elUnpair` 声明与事件绑定。
  2. **Pinterest 右键上下文菜单丢失**：将 `contexts` 拓展至 `['image', 'link']`，并在 `onCtx` 中通过空间几何坐标穿透提取底层真实图片。
  3. **Edge `String contains non ISO-8859-1 code point` 崩溃**：对 `X-PicNest-Token` 进行 32 位严格十六进制清洗，非法字符自动清除防死锁；桌面端脱敏文本添加 `user-select: none` 并支持整行点击复制。
  4. **花瓣网右键拦截兼容**：明确指引 `Shift + 右键` 穿透以及原生支持左键 0.4s 长按采集。
  5. **元数据持久化增强**：30 秒防抖增量写入 + `.tmp` 原子重命名替换 + 空排序数组稀疏裁剪。
  6. **AI 查重水平翻转感知**：基于 2D-DCT 奇偶对称性实现水平镜像不变特征匹配。
  7. **文档与帮助同步**：更新软件内建帮助弹窗、`extension/README.md` 与主工程 `README.md`。

---

## 🚀 二、 新功能目标：以图找图（Visual Search & Lens）

### 1. 功能定义
在 PicNest 桌面端构建类似 Eagle 官方插件的以图找图能力，整合 **Pinterest Lens** 与 **花瓣网找相似** 双引擎，支持本地多选排队、局部区域裁剪（ROI）、卡片内快捷衍生搜索（`F` 键）以及原图一键落盘入库（`S` 键）。

### 2. 界面布局规范（三栏式奶玻璃视窗）
参考设计原型：
- **最左栏 · 任务队列（QueueSidebar，宽约 60px）**：
  - 展示多选传入的图片缩略图列表（纵向滚动，带悬停遮罩与选中高亮边框）。
  - 支持悬停点击 `✕` 剔除出队；支持点击切换当前主查询任务。
- **中栏 · 查询与局部框选（CropViewport，宽约 340px）**：
  - 呈现当前活动原图，支持鼠标拖拽 4 角 / 4 边手柄进行矩形框选（ROI Bounding Box）。
  - 下方显示图片原始尺寸与文件名/描述信息。
  - 选区调整后 350ms 防抖自动触发新检索。
- **右栏 · 瀑布流结果与衍生操作（ResultWaterfall，自适应宽度）**：
  - 响应式等宽不等高瀑布流布局（支持顶部列宽滑块调节 120px ~ 360px）。
  - 卡片悬停操作：
    - `图片搜索 F`（快捷键 F）：将该在线图作为新任务压入最左侧队列末尾，发起下一轮递归搜索。
    - `保存到图巢 S`（快捷键 S 或下载图标 ↓）：直接无损下载原图并写入当前本地文件夹。
    - `原网链接 O`（快捷键 O）：在外部默认浏览器中打开该 Pin/画板页面。
- **顶栏 · 控制中心（TopBar）**：
  - 引擎选择器：`[📌 Pinterest Lens | 🌸 花瓣网 | 🔀 聚合视图]`
  - 列宽缩放滑块（Zoom Slider）
  - 窗口置顶图钉按钮（`setAlwaysOnTop`，方便画师悬浮在绘图软件旁作画参考）
  - 最小化 / 最大化 / 关闭按钮

---

## 🛠️ 三、 详细技术架构与模块拆分

### 模块 1：主进程网络适配层（`picnest-visual-search.js`）
位于 `tools/patches/` 或主进程扩展中，注册 IPC 接口：

```typescript
// 统一返回的数据契约
interface VisualSearchResultItem {
  id: string;               // 平台唯一ID
  engine: 'pinterest' | 'huaban';
  thumbUrl: string;         // 缩略图地址
  origUrl: string;          // 原图下载直链
  title: string;            // 标题 / 描述
  width: number;            // 宽
  height: number;           // 高
  aspectRatio: number;      // 宽高比（预占位）
  sourceUrl: string;        // 来源网页链接
  boardName?: string;       // 画板信息
}
```

1. **Pinterest Lens Adapter**：
   - 协议链路：向 Pinterest 视觉搜索端点发送请求。对于本地图片，先通过流式请求换取临时图片上传签名/标识，随后携带归一化坐标 `[x1, y1, x2, y2]` 请求 `VisualSearchResource`。
   - 会话与凭证：使用独立持久化会话（如 `session.fromPartition('persist:pinterest')`），若遇到 401/403，弹出轻量 Webview 引导用户登录一次即可永久记住。
   - 分页：提取响应中的 `bookmark` 游标。
2. **Huaban Similar Adapter**：
   - 协议链路：提交图片 Base64 或二进制流至花瓣网相似图片端点，模拟真实浏览器 UA 与 Referer 头。
   - 分页：基于 `page` 与 `limit`。
3. **混合流聚合器（Hybrid Aggregator）**：
   - 并发调用双引擎，按宽高比交错归并为一个统一的列表。

### 模块 2：前端视窗组件（`VisualSearchDialog.vue`）
- 采用 Vue 3 `<Teleport to="body">` 悬浮视窗或独立窗口模式。
- 引入状态机管理：
  ```typescript
  interface SearchTask {
    id: string;
    filePath?: string;
    dataUrl: string;
    bbox: [number, number, number, number]; // [0, 0, 1, 1] 为全图
    engine: 'pinterest' | 'huaban' | 'hybrid';
    results: VisualSearchResultItem[];
    cursor?: string | null;
    page: number;
    hasMore: boolean;
    loading: boolean;
  }
  ```
- 切换左侧队列小图时，内存保存各自的 `results` 与 `bbox`，无须重新打网络请求。

### 模块 3：下载入库打通
- 复用 PicNest 现有的 `picnest-save` 流水线：
  - 传入 `origUrl`、目标 `rootId` 与 `rel`；
  - 主进程通过已有的防盗链下载器直接落盘为物理文件，并自动刷新主网格。

---

## 📅 四、 推进步骤

1. **Step 1 · 接口逆向与适配器原型**：在 Node 脚本中验证 Pinterest Lens 与花瓣网以图搜图的请求流，提取并标准化返回数据。
2. **Step 2 · IPC 通道搭建**：在 `tools/patches/picnest-handlers.js` 接入搜图通道，暴露给 preload。
3. **Step 3 · 前端视窗开发**：编写 `VisualSearchDialog.vue`，实现左侧队列、中栏框选、右侧瀑布流。
4. **Step 4 · 快捷键与入口集成**：在图片右键菜单、灯箱、以及主菜单加入「以图找图（Shift+S）」，多选批量入队。
5. **Step 5 · 全链路冒烟与测试用例验证**。
