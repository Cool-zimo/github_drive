const APP_VERSION = {
    internalVersion: '71',
    formalVersion: '0.0.71',
    displayVersion: 'v0.0.71',
    //   = 1：契约体系建立。移除侧边栏 nav-group 折叠结构。
    //   = 2：侧边栏图标从 emoji 换成 <img src="assets/icons/...">。
    //        HTML 结构变了（nav-icon 内新增 img 节点），CSS 也新增了
    //        .nav-icon img 规则 —— 老 CSS 配新 HTML 会导致图标尺寸失控。
    apiVersion: '2'
};
