const APP_VERSION = {
    internalVersion: '74',
    formalVersion: '0.0.74',
    displayVersion: 'v0.0.74',
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
    //   = 5：动画行为层 js/anim.js 上线。JS 会往按钮里注入
    //        <span class="gd-ripple"> 并给宿主加 .gd-ripple-host，
    //        同时给仪表盘加 .dash-card / .dash-num[data-count]。
    //        老 CSS 没有 gd-ripple 规则 → 涟漪会是一个不透明的实心色块
    //        盖在按钮上；没有 dash-card → 仪表盘卡片没有入场动画。
    apiVersion: '5'
};
