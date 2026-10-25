// ==================== 第二代版本号（自 0.7.89 起启用）====================
// 格式：A.B.C = 超级大迭代号 . API版本号 . 小版本号
//
//   A 超级大迭代：架构级换代（整体重写、换框架、产品形态变化）。变化时 B、C 归零。
//   B API 版本  ：契约变化 —— HTML 结构、JS 操作的 class / 元素 id、
//                 CSS 里被 JS 依赖的规则。变化时 C 归零。
//   C 小版本    ：内容修复、样式微调、文案翻译、性能优化等。
//
// ★ 相对第一代（0.0.N + 独立 api_v）的好处：
//   第一代要同时维护「应用版本号」和「API 版本号」两个独立递增的数字。
//   曾经出现过 style.min.css 停在 75/6 而 version.js 已是 76/7 ——
//   自检因此误报「界面样式是旧版」，而样式其实是最新的。
//   第二代把 API 版本合成到中段，两者不可能再不同步，也不必分两次命名。
//
// 迁移：第一代 v0.0.89 + api_v=7  →  第二代 0.7.89（小版本保持连续）
// ==========================================================================
const APP_VERSION = {
    // ★ 唯一真值来源；下面 major/api/patch 与兼容字段由 bump 脚本同步
    version: '0.8.11',
    scheme: 2,
    major: '0',
    api: '8',
    patch: 8,
    internalVersion: '0.8.11',
    formalVersion: '0.8.11',
    displayVersion: '0.8.11',
    //   = 1：契约体系建立。移除侧边栏 nav-group 折叠结构。
    //   = 2：侧边栏图标从 emoji 换成 <img src="assets/icons/...">。
    //        HTML 结构变了（nav-icon 内新增 img 节点），CSS 也新增了
    //        .nav-icon img 规则 —— 老 CSS 配新 HTML 会导致图标尺寸失控。
    //   = 3：后台进程视图拆出「插件预览区」（#tm-stages / .tp-stage）。
    //        JS 会按 .tp-stage[data-pid] 收集占位并把插件窗口贴上去，
    //        老 CSS 没有 .tp-stage 规则 → 占位框没高度，预览会塌成一条线。
    //   = 4：弹窗退场。JS 会往 .modal-overlay 上加 .is-closing 并把节点
    //        挪进 #modal-exit-layer 播完动画再移除。老 CSS 没有这两条规则 →
    //        退场中的弹窗会以无定位状态挂在页面底部约 260ms。
    //   = 6：新增 js/theme.js（给内联硬编码标题打 data-gd-force 标记，
    //        并处理内联白底）、js/i18n-scan.js（英文兜底，依赖
    //        body 上有 [data-gd-force] 与 CSS 变量 --text-* 已定义）、
    //        js/plugin-api.js（插件接口，CSS 无依赖）。
    //        theme.js 依赖 CSS 里 [data-gd-force="title"] 等规则，
    //        老 CSS 没有 → 打了标记也不生效，暗色下标题依旧看不清。
    //
    //   = 7：侧边栏右边缘新增拖拽把手 div.gd-sb-resizer（由 js/custom.js
    //        动态插入）。老 CSS 没有这条规则 → 把手没有尺寸和 col-resize
    //        光标，表现为「右边缘拖不动」。同时 js/i18n.js 的 t(key, fallback)
    //        新增第二参数，i18n-scan 新增裸键清洗 —— 这两处 CSS 无依赖。
    //
    //   = 5：动画行为层 js/anim.js 上线。JS 会往按钮里注入
    //        <span class="gd-ripple"> 并给宿主加 .gd-ripple-host，
    //        同时给仪表盘加 .dash-card / .dash-num[data-count]。
    //        老 CSS 没有 gd-ripple 规则 → 涟漪会是一个不透明的实心色块
    //        盖在按钮上；没有 dash-card → 仪表盘卡片没有入场动画。
    //
    //   = 8：界面图标从 emoji 全面换成内联 SVG（js/icons.js 的 Icons.EMOJI
    //        映射 + Icons.scan() 运行时扫描）。JS 会往 DOM 里插入
    //        <svg class="ico gd-emoji-ico">，设置页还会插 .gd-set-ico。
    //        老 CSS 没有这三条规则 → SVG 默认是 display:inline 且尺寸取
    //        width 属性的固定 16px，既不随字号缩放、基线也下沉一截，
    //        表现为"图标大小不一、比旁边的字矮半截"。
    //
    //   = 7 期间的加载改造（v0.0.88，不涉及契约变化，故不 bump）：
    //       - index.html 里 15 个 CORE 脚本从 document.write 改成静态
    //         <script defer>，CSS 也改成静态 <link>。目的是让浏览器的
    //         预加载扫描器能看见它们 —— 原来 URL 是 JS 运行时拼的，
    //         扫描器不执行 JS，必须等 HTML 下载完才开始请求，白等 RTT。
    //       - CSS 的 URL 从 ?v=N 改成 ?h=<内容 hash>；--stamp 移到
    //         index.html 的内联 <style>，否则它每轮都变，会把 CSS 的
    //         内容 hash 也带着变，样式表每次升级都要重新下载。
    //       - app.js 的版本戳读取改为跨样式表累加：--stamp 在内联、
    //         --api-stamp 在 css 文件，原来遇到第一个就 break 会漏掉
    //         另一个。CSS 无依赖，故不 bump api。
    // ★ 兼容第一代：等于上面的 api，由 version 中段派生
    apiVersion: '8'
};
