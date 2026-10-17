const APP_VERSION = {
    internalVersion: '72',
    formalVersion: '0.0.72',
    displayVersion: 'v0.0.72',
    //   = 1：契约体系建立。移除侧边栏 nav-group 折叠结构。
    //   = 2：侧边栏图标从 emoji 换成 <img src="assets/icons/...">。
    //        HTML 结构变了（nav-icon 内新增 img 节点），CSS 也新增了
    //        .nav-icon img 规则 —— 老 CSS 配新 HTML 会导致图标尺寸失控。
    //   = 3：后台进程视图拆出「插件预览区」（#tm-stages / .tp-stage）。
    //        JS 会按 .tp-stage[data-pid] 收集占位并把插件窗口贴上去，
    //        老 CSS 没有 .tp-stage 规则 → 占位框没高度，预览会塌成一条线。
    apiVersion: '3'
};
