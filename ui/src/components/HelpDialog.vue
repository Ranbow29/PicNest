<script setup>
// 帮助与使用说明：常驻在顶栏 ? 按钮；内容按功能分区，重点写清「排序会改磁盘文件名」和消除方式
import { useLibrary } from '../stores/library'

const lib = useLibrary()

import { ref, onMounted } from 'vue'
import { api } from '../api.js'

const appVer = ref('0.1.0')
onMounted(async () => {
  try {
    const r = await api.appVersion()
    if (r?.version) appVer.value = r.version
  } catch (e) {}
})

function triggerCheckUpdate() {
  lib.closeHelp()
  window.dispatchEvent(new CustomEvent('picnest-check-update-trigger'))
}

function openGithubRepo() {
  api.openExternal('https://github.com/Ranbow29/PicNest')
}

</script>

<template>
  <Teleport to="body">
    <div v-if="lib.helpOpen" class="hp-layer" @click.self="lib.closeHelp()">
      <div class="hp-card">
        <header class="hp-head">
          <div class="hp-title">PicNest 图巢 · 使用说明</div>
          <span class="hp-sub">直链索引 · 不复制图片 · 排序可能改磁盘文件名</span>
          <button class="hp-x" title="关闭（Esc）" @click="lib.closeHelp()">✕</button>
        </header>

        <div class="hp-body">
          <div class="hp-warn">
            <b>先看这条：</b>图巢只记录文件路径，不复制图片。但「应用为手动排序」和「排序同步文件名」会
            <b>真实修改磁盘上的文件名</b>（加 <code>01_</code> 前缀）；如果不想要，见下面「排序编号怎么消除」。
          </div>

          <section id="hp-sort">
            <h3>1. 排序与文件名（重点）</h3>
            <ul>
              <li><b>手动排序是默认排序</b>（排序面板第一项）：直接拖动图片/文件夹换位；新录入、拖入、粘贴的图片会排到最前。</li>
              <li><b>「应用为手动排序」</b>（排序面板底部）：把当前屏幕上的显示顺序（含筛选/搜索）固化。点击会先弹确认——
                确认后会按顺序把原文件真实重命名为 <code>01_原名.ext</code>、<code>02_原名.ext</code>…（按所在文件夹分组，文件夹同理）。
                <b>取消则完全不动。</b></li>
              <li><b>「排序同步文件名」开关</b>（根文件/文件夹右键）：开启后，每次手动拖动都会立刻按新顺序重命名原文件；
                关闭后，拖动只写内部排序值，不改磁盘名。此开关默认关闭，但已开启状态会记住。</li>
              <li><b>「01 隐藏编号」按钮</b>（顶栏）：<b>默认开启</b>，只把界面里的 <code>01_</code> 前缀隐藏，磁盘名不变；
                再点关闭就显示真实文件名。日期名（如 <code>2026-08-23</code>）不会被误认成编号。</li>
              <li><b>排序编号怎么消除：</b>
                <ol>
                  <li>只是不想在界面看到 → 保持顶栏「01」按钮开启（默认）。</li>
                  <li>想真正去掉磁盘文件名上的编号 → 右键「根文件」行 → <b>「清除排序编号…」</b> → 确认。
                    会扫描整个根目录，去掉文件和文件夹的 <code>01_</code> 前缀（重名自动加 <code>(2)</code>），
                    <b>不改手动排序值</b>。</li>
                  <li>清除后若「排序同步文件名」还开着，下次手动拖动会重新加编号；想长期保持无编号，请先关掉该开关。</li>
                </ol>
              </li>
              <li><b>前缀规则：</b><code>01_</code>、<code>02_</code>…（按图片数量自动用 2~4 位补零）；只匹配「下划线」方案，
                不会把 <code>2026_08_23</code> 这类日期当编号。</li>
            </ul>
          </section>

          <section>
            <h3>2. 浏览与选择</h3>
            <ul>
              <li>左侧「根文件」区点根文件切库；点当前根文件回到库根。「全部 / 最近使用 / 未分类 / 随机模式 / 回收站」是视图入口。</li>
              <li>单击选中，<b>Shift</b> 范围选，<b>Alt/Ctrl</b> 加减选；<b>Ctrl+A</b> 全选当前可见；空白处拖拽框选。</li>
              <li>子文件夹卡片：单击只选中/看详情，<b>双击进入</b>；顶部「显示子文件夹内容」开关控制是否递归显示。</li>
              <li>面包屑（顶栏路径）每一级可点；← → 是浏览历史，不是图片翻页。</li>
            </ul>
          </section>

          <section>
            <h3>3. 录入 / 拖拽 / 复制粘贴</h3>
            <ul>
              <li>把文件/文件夹拖进窗口：位置即意图——拖到主展示区=当前文件夹；拖到左侧文件夹行=进该文件夹；
                拖到两个文件夹中间的缝隙=父级并插入该位置；拖到「根文件」/库根=放进对应库根。</li>
              <li>拖文件夹进来会复制为同名子文件夹（合并同名；同大小同 MD5 跳过；不同内容加序号）。</li>
              <li>Ctrl+C / Ctrl+V 复制粘贴图片或文件夹；支持跨根文件。移动到别的文件夹用右键「移动到…」。</li>
              <li>拖图片到左侧「回收站」=软删除（进图巢回收站，可还原）；拖到「未分类」=移回库根。</li>
              <li><b>拖到 CSP / PS：</b>直接拖动图片——在窗口内松开 = 图巢内部排序/移动（落点会高亮）；
                把图片拖出 PicNest 窗口 = 自动变成原生文件拖拽，拖进 Clip Studio Paint / Photoshop / 资源管理器松开即可。
                多选后拖其中一张会带上全部选中文件。</li>
            </ul>
          </section>

          <section>
            <h3>4. 详情面板</h3>
            <ul>
              <li>点顶栏 ◧ 或选中图片后打开；可改名、写注释、看色板、点星评分、加标签、看所在文件夹、设文件夹封面。</li>
              <li>左缘拖宽度、顶边拖高度、左上角自由缩放；双击顶边/角柄恢复满高。</li>
              <li>点详情里的色板色块 = 按该颜色筛选；库根散图不能设封面。</li>
            </ul>
          </section>

          <section>
            <h3>5. 大图 / 裁剪 / 旋转</h3>
            <ul>
              <li>双击图片进大图；← → 或 A/D 翻页；滚轮缩放，拖拽平移。</li>
              <li>裁剪模式：拖选区内=移动选区，拖手柄=缩放，<b>拖选区外=平移图片</b>，滚轮仍然缩放；「应用」后可另存副本/覆盖原图（自动备份）。</li>
              <li>旋转/翻转后点「保存」写回原图（会备份原件并重建缩略图/色板）。</li>
            </ul>
          </section>

          <section>
            <h3>6. 简报模式（全屏看板）</h3>
            <ul>
              <li>入口：图片右键 → <b>✓ 简报模式</b>（再次点击取消勾选即可退出）。效果：整屏黑底、只留图片和计数；适合快速过一遍整套图。</li>
              <li>操作：<b>单击</b>=下一张，<b>右键</b>=上一张；<b>← / A</b> 上一张，<b>→ / D</b>=下一张；<b>Esc</b> 退出（右上角也有关闭）。</li>
              <li>简报里仍可<b>滚轮以光标为锚点缩放</b>（0.2–8×）+ 拖拽平移；视频静音循环，文本显示占位；右键也能呼出图片菜单。</li>
              <li>删除/移入未分类等会改变路径的操作会自动退出简报，避免看着已不存在的图。</li>
            </ul>
          </section>

          <section>
            <h3>7. 黑白预览</h3>
            <ul>
              <li>入口：图片右键 → <b>✓ 黑白预览</b>（全局显示开关）。效果：网格、大图、详情预览、简报全部变灰度，只是显示滤镜。</li>
              <li><b>不改动任何磁盘文件</b>，也不改色板数据；关闭后原色恢复。</li>
              <li>开关状态会记住，下次启动仍保持；适合快速看明暗/构图。</li>
            </ul>
          </section>

          <section>
            <h3>8. 筛选 / 标签 / 颜色</h3>
            <ul>
              <li>顶栏漏斗打开筛选：颜色、形状/比例、评分、格式、文件夹、标签；颜色取色器支持自定义 HSV。</li>
              <li>标签在详情面板添加；筛选栏「TAGS」按当前资料库计数，支持管理（改名/删除）。颜色筛选可用详情色板点选。</li>
            </ul>
          </section>

          <section>
            <h3>9. 主题 / 左栏 / 编号</h3>
            <ul>
              <li>顶栏主题按钮：跟随系统 / 暖砂 / 靛夜 / 灰白 / 炭黑 / 墨黑；会记住并跨启动方式保存。</li>
              <li>顶栏 ◧ 左侧的侧栏按钮收起/展开左边栏，状态会记住。</li>
              <li>顶栏「01」按钮控制是否隐藏排序编号（见第 1 节）。</li>
            </ul>
          </section>

          <section>
            <h3>10. 根文件与本地元数据</h3>
            <ul>
              <li>每个根目录下会自动生成隐藏目录 <code>.picnest/meta.json</code>，保存标签、评分/注释/URL/收藏、文件夹颜色/描述/封面、
                手动排序。移出根文件后再重新加回，会自动恢复这些数据。</li>
              <li>「移出根文件」只清图巢索引，不动磁盘文件；回收站非空时会先拦截。</li>
            </ul>
          </section>

          <section>
            <h3>11. 查重（精确）</h3>
            <ul>
              <li>入口：文件夹/根文件右键 <b>「查找重复…」</b>；图片右键也会扫它所在文件夹（库根散图=全库）。只查当前资料库，不跨库。</li>
              <li>原理：先按<b>文件大小分桶</b>（不同尺寸不可能同内容，不读盘），同尺寸再<b>流式 MD5</b>；同内容才成组。视频/文本也参与。</li>
              <li>结果按可省空间排序；每组可「保留第一/最新/最旧」；勾选要删的，默认一张都不勾。</li>
              <li>「不同后缀各保留一张」：jpg/jpeg 视为同后缀，tif/tiff 合并；开启后每种后缀各留一张。</li>
              <li>扫描中可「停止」或关面板；删除只移入<b>图巢回收站</b>（不是立即销毁），可还原。</li>
              <li>精确查重只认内容完全相同；缩放、重压缩、裁剪过的相似图用下面的 AI 查重。</li>
            </ul>
          </section>

          <section>
            <h3>12. AI 查重（怎么做）</h3>
            <ul>
              <li><b>准备：</b>需要一个支持图片输入的 OpenAI 兼容接口（地址、模型名、API Key）。地址可填 <code>https://…/v1</code> 或完整 <code>/chat/completions</code>。</li>
              <li><b>配置：</b>「查找重复」面板顶部切到 <b>AI 查重</b> → 填地址/模型/Key → <b>保存并测试</b>（会用两张 64×64 色块验证视觉连通）。Key 用系统 safeStorage 加密存在本机，不会回传界面。</li>
              <li><b>模型：</b>点「获取模型」自动拉 <code>/models</code> 列表；也可以手填。模型必须支持图片输入。</li>
              <li><b>参数：</b>「最多比对」默认 40 对（1–200）；「单价 ¥/1M tok」可选，填了会按「对数 × 2 张缩略图 × 约 340 tokens」粗估费用和上传量，不填只显示上传量。</li>
              <li><b>同意上传：</b>必须勾选「允许把候选缩略图发送到该 API」；只上传 384px 候选缩略图，<b>不上传原图</b>，会产生 API 费用。</li>
              <li><b>流程：</b>先本地算 dHash（64-bit）找相似候选 → 32×32 色块 + pHash 二次预筛（dHash≤4 的强结构对直接放行）→ 只把候选对交给 AI 判断是否同图 → 并查集成组。AI 阶段 4 路并发，429/5xx 自动重试。</li>
              <li><b>结果：</b>组带 AI 徽标；快捷「保留最大/最新/最旧」；勾选后「移入回收站」，同样可还原。候选超过上限时只查最接近的 N 对（结果头部会提示）。</li>
              <li><b>停止/失败：</b>扫描中可「停止」，已得到的组会保留；地址/Key/模型不匹配会显示错误；换配置后重试即可。</li>
              <li><b>注意：</b>AI 查重会把「同角色不同图」「同版式不同内容」也当成相似候选，最终仍要人工看结果勾选；精确重复优先用精确查重。</li>
            </ul>
          </section>

          <section>
            <h3>13. 缩略图 / 插件库</h3>
            <ul>
              <li>右键根文件 <b>「修复缩略图…」</b>：统计缺失/缓存丢失的缩略图并批量生成，进度浮条可停止；平时浏览也会按需补图。</li>
              <li>侧栏底部 <b>「插件库」</b>：安装主题（纯 CSS）或界面插件（沙箱 iframe）；支持从文件夹安装和 registry.json 仓库安装，
                权限逐条显示，停用即可关闭插件。</li>
            </ul>
          </section>

          <section>
            <h3>14. 浏览器采集插件（重要）</h3>
            <ul>
              <li><b>安装：</b>保持 PicNest 正在运行。打开 Edge 的 <code>edge://extensions</code>（Chrome 用 <code>chrome://extensions</code>）→ 打开「开发人员模式」→
                「加载解压缩的扩展」→ 选择项目里的 <code>extension/</code> 文件夹。装好后可把图标固定到工具栏。</li>
              <li><b>连接：</b>点扩展图标，弹窗右上角变成绿色「已连接」。首次使用在弹窗里选 <b>根文件</b>（资料库）和 <b>保存到</b>（根目录/某个文件夹）；
                这两个选择全局有效，之后右键保存都进这个目标。</li>
              <li><b>三种采集方式：</b>
                <ol>
                  <li><b>右键图片 → 保存图片到图巢</b>：存原图到弹窗选中的目标文件夹。</li>
                  <li><b>右键页面 → 保存页面截图到图巢</b>：保存当前可见区域截图（不是整页滚动）。</li>
                  <li><b>按住网页图片约 0.4 秒</b>：光标处出现进度环（转满一圈）→ 弹出采集面板。左栏是「未分类/库根」，右栏是当前根下全部文件夹；
                    把图拖到目标上松开即保存；面板空白处松开则面板保留可点击；右下角「＋ 新建文件夹…」可直接建夹并保存。
                    <b>移动超过 6px 会取消</b>（不影响网页自身拖拽）；Esc 或点面板外关闭。</li>
                </ol>
              </li>
              <li><b>重复图片：</b>采集前会按目标根 + 大小 + MD5 检查。按住面板遇到重复会三选一：<b>跳过 / 覆盖旧图 / 仍然保存</b>
                （覆盖=旧图移入图巢回收站后再存新图；仍然保存=两份都留）；右键保存只提示跳过。</li>
              <li><b>注意：</b>重载扩展后，已经打开的网页必须刷新（旧 content script 会提示「扩展已更新」）；按住采集只支持主 frame 的
                <code>&lt;img&gt;</code>，跨域 iframe/背景图/CSS 图暂不支持；整页滚动截图、视频、采集带标签暂未做。</li>
              <li>采集写入的是真实文件（下载原图/截图），需要防盗链的站点会带页面 Referer 与浏览器 UA；失败会显示在弹窗消息里。</li>
            </ul>
          </section>

          <section>
            <h3>15. 常用快捷键</h3>
            <ul class="hp-keys">
              <li><b>Ctrl+A</b> 全选可见图片</li>
              <li><b>Esc</b> 逐层退出（帮助/插件→输入框→大图/裁剪→确认→菜单→清空选择）</li>
              <li><b>← →</b> / <b>A D</b> 大图/简报翻页；<b>空格</b> 视频暂停</li>
              <li><b>Ctrl+C / Ctrl+V</b> 复制 / 粘贴</li>
              <li><b>F2</b> 重命名（详情面板）</li>
              <li><b>Ctrl+Shift+F</b> 打开筛选面板；<b>Esc</b> 关简报</li>
            </ul>
          </section>

          <div class="hp-foot">
            <div class="hp-version-row">
              <div class="hp-ver-left">
                <span class="hp-ver-text">PicNest 图巢 v{{ appVer }} · 基于 GPL-3.0 纯净开源</span>
                <button class="hp-repo-link" @click="openGithubRepo" title="在浏览器中打开 GitHub 开源主页">
                  开源主页：https://github.com/Ranbow29/PicNest ↗
                </button>
              </div>
              <button class="hp-update-btn" @click="triggerCheckUpdate">🚀 检查新版本</button>
            </div>
            提示：所有「删除」默认进图巢回收站；「应用为手动排序」和「排序同步文件名」是真实的磁盘改名操作，确认前请看清提示。
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.hp-layer { position: fixed; inset: 0; z-index: 945; display: flex; align-items: center; justify-content: center; background: rgba(20, 18, 14, 0.38); backdrop-filter: blur(3px); }
.hp-card { width: min(760px, 92vw); height: min(84vh, 900px); display: flex; flex-direction: column; background: var(--panel-strong); backdrop-filter: blur(var(--blur)) saturate(1.1); border: 1px solid var(--border); border-radius: 16px; box-shadow: var(--shadow-float); animation: hp-in 0.18s var(--ease-overshoot); overflow: hidden; }
@keyframes hp-in { from { opacity: 0; transform: translateY(10px) scale(0.98); } to { opacity: 1; transform: none; } }
.hp-head { display: flex; align-items: baseline; gap: 10px; padding: 14px 18px 12px; border-bottom: 1px solid var(--border); }
.hp-title { font-size: 16px; font-weight: 700; letter-spacing: 0.5px; }
.hp-sub { font-size: 10.5px; color: var(--text-2); }
.hp-x { margin-left: auto; width: 30px; height: 30px; border: none; border-radius: 9px; background: transparent; color: var(--text-2); font-size: 13px; cursor: pointer; }
.hp-x:hover { background: var(--accent-weak); color: var(--text); }
.hp-body { flex: 1; overflow-y: auto; padding: 12px 20px 22px; scrollbar-width: thin; }
.hp-warn { margin: 4px 0 12px; padding: 10px 12px; border: 1px solid rgba(194, 90, 77, 0.35); border-radius: 10px; background: rgba(194, 90, 77, 0.07); font-size: 12px; line-height: 1.65; color: var(--text); }
.hp-warn b { color: #b4463b; }
section { margin: 14px 0 0; }
h3 { margin: 0 0 6px; font-size: 13.5px; color: var(--text); letter-spacing: 0.3px; }
ul, ol { margin: 0; padding-left: 19px; font-size: 12px; line-height: 1.75; color: var(--text); }
li { margin: 3px 0; }
li b { color: var(--accent); font-weight: 600; }
ol li { margin: 3px 0; }
code { padding: 0 4px; border-radius: 4px; background: var(--bg-2); font-family: Consolas, monospace; font-size: 11px; color: var(--text); }
.hp-keys { columns: 2; column-gap: 24px; }
.hp-foot { margin-top: 18px; padding-top: 10px; border-top: 1px dashed var(--border); font-size: 11px; color: var(--text-2); line-height: 1.7; }

.hp-version-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px dashed var(--border);
}
.hp-ver-left {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.hp-ver-text {
  font-weight: 600;
  color: var(--accent);
}
.hp-repo-link {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-2);
  font-size: 11px;
  text-align: left;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.hp-repo-link:hover {
  color: var(--accent);
}
.hp-update-btn {
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 500;
  border-radius: 6px;
  border: 1px solid var(--accent);
  background: var(--accent-weak, rgba(212, 154, 55, 0.1));
  color: var(--accent);
  cursor: pointer;
  transition: all 0.16s ease;
}
.hp-update-btn:hover {
  background: var(--accent);
  color: #fff;
}

</style>
