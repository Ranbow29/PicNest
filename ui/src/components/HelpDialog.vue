<script setup>
// 帮助与使用说明：常驻在顶栏 ? 按钮；内容按功能分区，重点写清「排序会改磁盘文件名」和消除方式
import { useLibrary } from '../stores/library'

const lib = useLibrary()
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
            <h3>6. 筛选 / 标签 / 颜色</h3>
            <ul>
              <li>顶栏漏斗打开筛选：颜色、形状/比例、评分、格式、文件夹、标签；颜色取色器支持自定义 HSV。</li>
              <li>标签在详情面板添加；筛选栏「TAGS」按当前资料库计数，支持管理（改名/删除）。</li>
            </ul>
          </section>

          <section>
            <h3>7. 主题 / 左栏 / 编号</h3>
            <ul>
              <li>顶栏主题按钮：跟随系统 / 暖砂 / 靛夜 / 灰白 / 炭黑 / 墨黑；会记住并跨启动方式保存。</li>
              <li>顶栏 ◧ 左侧的侧栏按钮收起/展开左边栏，状态会记住。</li>
              <li>顶栏「01」按钮控制是否隐藏排序编号（见第 1 节）。</li>
            </ul>
          </section>

          <section>
            <h3>8. 根文件与本地元数据</h3>
            <ul>
              <li>每个根目录下会自动生成隐藏目录 <code>.picnest/meta.json</code>，保存标签、评分/注释/URL/收藏、文件夹颜色/描述/封面、
                手动排序。移出根文件后再重新加回，会自动恢复这些数据。</li>
              <li>「移出根文件」只清图巢索引，不动磁盘文件；回收站非空时会先拦截。</li>
            </ul>
          </section>

          <section>
            <h3>9. 查重 / 缩略图 / 插件</h3>
            <ul>
              <li>右键文件夹/根文件「查找重复…」：精确 MD5 查重，可选 AI 视觉二次查重；删除只进图巢回收站。</li>
              <li>右键根文件「修复缩略图…」：补齐缺失/缓存丢失的缩略图。</li>
              <li>侧栏底部「插件库」：安装主题（纯 CSS）或界面插件（沙箱 iframe）；支持从文件夹安装和 registry.json 仓库安装，
                权限逐条在插件卡片显示。</li>
            </ul>
          </section>

          <section>
            <h3>10. 常用快捷键</h3>
            <ul class="hp-keys">
              <li><b>Ctrl+A</b> 全选可见图片</li>
              <li><b>Esc</b> 逐层退出（输入框→大图/裁剪→确认→菜单→清空选择）</li>
              <li><b>← →</b> / <b>A D</b> 大图翻页；<b>空格</b> 视频暂停</li>
              <li><b>Ctrl+C / Ctrl+V</b> 复制 / 粘贴</li>
              <li><b>F2</b> 重命名（详情面板）</li>
              <li><b>Ctrl+Shift+F</b> 打开筛选面板</li>
            </ul>
          </section>

          <div class="hp-foot">
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
</style>
