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
            <b>先看这条：</b>图巢只记录文件路径，不复制图片。
            <b>排序默认只存在图巢自己的元数据里，不会碰磁盘文件名。</b>
            除非你自己在排序面板点「写入文件名…」（会先给预览，加 <code>01_</code> 前缀）。
          </div>

          <section id="hp-sort">
            <h3>1. 排序与文件名（重点）</h3>
            <ul>
              <li><b>手动排序是默认排序</b>（排序面板第一项）：直接拖动图片/文件夹换位；新录入、拖入、粘贴的图片会排到最前。</li>
              <li><b>「应用为手动排序」</b>（排序面板底部）：把当前屏幕上的显示顺序（含筛选/搜索）固化成手动排序。
                只写图巢内部的排序值，<b>不会改任何磁盘文件名</b>。</li>
              <li><b>「写入文件名…」</b>（排序面板右侧）：显式把手动顺序写成磁盘文件名的 <code>01_</code>、<code>02_</code> 前缀。
                点下去先给预览清单，确认后才动手；只改名字不改内容，同时迁移缩略图缓存，不会因为改名而丢缩略图。</li>
              <li><b>顶栏「01」按钮</b>：只影响<b>界面显示</b>——开着就把 <code>01_</code> 前缀藏起来，关掉就显示真实文件名；控制盘上的名字。</li>
              <li><b>文件夹顺序</b>：在左栏拖动文件夹即可换位，顺序存在 <code>picnest_dir_order</code> 里；
                把一个新图拖进某个文件夹，那个文件夹会自动提到同级第一位（可在设置用 <code>autoPinOnImport</code> 关闭）。</li>
              <li><b>默认不改名</b>：图巢不会再“拖一下就把磁盘文件名改了”。以前那套自动改名和「清除排序编号」已移除，
                现在要不要带前缀完全由你自己点那一下「写入文件名…」决定；想洗掉已有的 <code>01_</code>，直接在资源管理器里改名。</li>
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
              <li><b>增量防抖落盘与同步盘友好：</b>标签、评分、排序等写操作约 30 秒后通过临时文件原子写入 <code>meta.json</code>（防止强杀/断电丢失快照），并自动裁剪空排序数组，显著减少 OneDrive 等同步盘的整文件重复上传。</li>
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
              <li><b>配置：</b>「查找重复」面板顶部切到 <b>AI 查重</b> → 填地址/模型/Key → <b>保存并测试</b>（会用两张 64×64 色块验证视觉连通）。Key 明文存在本机数据目录的 <code>ai_config.json</code>，不会上传到别处——但别把这个文件发给别人。</li>
              <li><b>模型：</b>点「获取模型」自动拉 <code>/models</code> 列表；也可以手填。模型必须支持图片输入。</li>
              <li><b>参数：</b>「最多比对」默认 40 对（1–200）；「单价 ¥/1M tok」可选，填了会按「对数 × 2 张缩略图 × 约 340 tokens」粗估费用和上传量，不填只显示上传量。</li>
              <li><b>同意上传：</b>必须勾选「允许把候选缩略图发送到该 API」；只上传 384px 候选缩略图，<b>不上传原图</b>，会产生 API 费用。</li>
              <li><b>流程：</b>先本地算 dHash（64-bit）找相似候选 → 32×32 色块 + pHash 二次预筛（dHash≤4 的强结构对直接放行）→ 只把候选对交给 AI 判断是否同图 → 并查集成组。AI 阶段 4 路并发，429/5xx 自动重试。</li>
              <li><b>水平镜像感知：</b>本地特征对比基于 2D-DCT 奇偶对称性（自动计算水平翻转指纹并取双向最小汉明距离），画师素材库中的镜像翻转同图同样能够精准入组。</li>
              <li><b>结果：</b>组带 AI 徽标；快捷「保留最大/最新/最旧」；勾选后「移入回收站」，同样可还原。候选超过上限时只查最接近的 N 对（结果头部会提示）。</li>
              <li><b>停止/失败：</b>扫描中可「停止」，已得到的组会保留；地址/Key/模型不匹配会显示错误；换配置后重试即可。</li>
              <li><b>注意：</b>AI 查重会把「同角色不同图」「同版式不同内容」也当成相似候选，最终仍要人工看结果勾选；精确重复优先用精确查重。</li>
            </ul>
          </section>

          <section>
            <h3>13. 缩略图 / 插件库</h3>
            <ul>
              <li>右键根文件 <b>「修复缩略图…」</b>：统计缺失/缓存丢失的缩略图并批量生成，进度浮条可停止；平时浏览也会按需补图。</li>
              <li><b>插件库暂未接入本版：</b>旧版 Electron 的插件系统（主题 CSS / 沙箱界面插件）还没移植到 Rust 版，
                侧栏入口暂时隐藏；现有主题直接走顶栏主题按钮。</li>
            </ul>
          </section>

          <section>
            <h3>14. 浏览器采集插件（重要）</h3>
            <ul>
              <li><b>安装：</b>保持 PicNest 正在运行。打开 Edge 的 <code>edge://extensions</code>（Chrome 用 <code>chrome://extensions</code>）→ 打开「开发人员模式」→
                「加载解压缩的扩展」→ 选择项目或便携包内的 <code>extension/</code> 文件夹。装好后可把图标固定到工具栏。</li>
              <li><b>首次安全密钥配对（仅需一次）：</b>本地采集服务（<code>127.0.0.1:41600</code>）启用了 <code>X-PicNest-Token</code> 密钥鉴权，防范其他网页或恶意扩展越权探测图库路径。
                <ol>
                  <li>点击图巢顶栏右上角<b>「窗口与个性化设置」</b>图标（图钉图标）→ 找到<b>「采集扩展配对密钥」</b>→ 点击<b>「复制密钥」</b>。</li>
                  <li>点击浏览器右上角「PicNest 图巢采集」图标打开弹窗（或在任意网页直接长按图片弹出的面板中），将密钥粘贴进<b>「配对密钥」</b>输入框并点击<b>「配对」</b>。</li>
                  <li>弹窗右上角变成绿色「已连接」并载入根文件列表即永久完成绑定（凭证保存在扩展本地沙箱内，后续无需重复输入）。如需解绑或重测未配对状态，可点弹窗右上角<b>「解除配对」</b>，或在图巢设置内点击<b>「重置」</b>使旧密钥失效。</li>
                </ol>
              </li>
              <li><b>选择保存目标：</b>在扩展弹窗里选好 <b>根文件</b>（资料库）和 <b>保存到</b>（根目录/某个文件夹）；这两个选择全局有效，之后右键保存都会进入此目标。</li>
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
              <li><b>站点特别适配（Pinterest / 花瓣网）：</b>
                <ul>
                  <li><b>Pinterest：</b>已适配卡片链接覆盖层与 <code>pointer-events: none</code>，直接在瀑布流图片上点右键即可正常呼出「保存图片到图巢」。</li>
                  <li><b>花瓣网（huaban.com）：</b>花瓣前端主动拦截了浏览器原生右键并替换为站内浮层菜单，可使用 <b><code>Shift + 鼠标右键</code></b> 强行穿透唤出系统原生菜单保存，或直接<b>左键按住图片 0.4 秒</b>唤出图巢长按面板（不受右键拦截影响）。</li>
                </ul>
              </li>
              <li><b>注意：</b>重载扩展后，旧脚本会优先自动原地重建或刷新（也可在扩展弹窗点「修复本页」）；按住采集支持主 frame 可见图片，跨域 iframe/CSS 背景图暂不支持；采集会附带页面 Referer 与浏览器 UA 应对防盗链。</li>
            </ul>
          </section>

          <section>
            <h3>15. 以图找图（Pinterest Lens / 花瓣网）</h3>
            <ul>
              <li><b>随时唤起：</b>网格或大图选中图片后按 <b>Shift+S</b>，或右键选择「以图找图」，支持多图批量入队排队。</li>
              <li><b>三栏视窗：</b>左栏纵向排队（点击切换、悬停删除 ✕、支持拖入与点 ＋ 加图）；中栏原图支持 8 向手柄交互框选局部（ROI），350ms 防抖自动发起局部搜索；右栏响应式瀑布流展示结果，支持列宽滑块无级缩放。</li>
              <li><b>卡片快捷流：</b>悬停卡片按 <b>F</b>（以此图继续深挖递归搜图，压入左侧队列）、按 <b>S</b>（一键直存原图到当前本地库文件夹）、按 <b>O</b>（在系统默认浏览器中打开原网页）。</li>
              <li><b>画师置顶：</b>顶栏提供「📌 置顶」图钉按钮，开启后悬浮于绘图软件（SAI/Photoshop/CSP）旁作为实时找参考工具。</li>
            </ul>
          </section>

          <section>
            <h3>16. 常用快捷键</h3>
            <ul class="hp-keys">
              <li><b>Shift+S</b> 以图找图（多选排队 / 大图唤起）</li>
              <li><b>F / S / O</b> 图搜卡片快捷操作：深挖图搜 / 一键存库 / 来源网页</li>
              <li><b>Ctrl+A</b> 全选可见图片</li>
              <li><b>Esc</b> 逐层退出（帮助/插件→输入框→大图/裁剪→确认→菜单→清空选择）</li>
              <li><b>← →</b> / <b>A D</b> 大图/简报翻页；<b>空格</b> 视频暂停</li>
              <li><b>Ctrl+C / Ctrl+V</b> 复制 / 粘贴</li>
              <li><b>0–5</b> 给选中图片打星级（0 清除）</li>
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
            提示：所有「删除」默认进图巢回收站；图巢不会修改你的文件内容，排序也不会再改文件名。
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
