/* ==================================================================
   ext-host.js —— GitHub Drive 扩展宿主（v2 / "万能扩展"内核）
   ------------------------------------------------------------------
   目标：把插件从「一个全屏网页」升级成「像 VSCode 一样的能力单元」。

   提供四类宿主能力：
     视图   —— 常驻活动栏 + 侧边栏面板（iframe 保活，切主视图不重载）
     窗口   —— 多窗口 / 全屏 / 弹出成独立标签 / 窗口间命令
     网络   —— net.fetch（任意 URL，域名授权）+ net.github（宿主令牌代发）
     集成   —— 命令面板、右键菜单注入、状态栏、事件总线、命名空间存储

   ★ 三条硬规则
     1) token 不进 iframe。鉴权操作全部由宿主代做。
     2) 会话以 window 对象为键，绝不用 origin —— blob: iframe 的 origin
        是字符串 "null"，多个扩展会互相顶掉（v1 plugin-api 的坑）。
     3) blob iframe 一律加 sandbox 且**不给 allow-same-origin**。
        否则 opaque 变同源，扩展可以直接读宿主 localStorage 里的 token。
   ================================================================== */
(function (root) {
    'use strict';

    var API_VERSION = 2;

    /* 能力表：cap → 是否写操作（用于清单声明与提示） */
    var CAPS = {
        'files.list': false, 'files.stat': false, 'files.read': false,
        'files.write': true, 'files.delete': true, 'files.upload': true,
        'files.open': false,
        'net.fetch': true, 'net.github': true, 'net.grants': false, 'net.revoke': true,
        'ui.window': true, 'ui.close': true, 'ui.setTitle': false,
        'ui.fullscreen': true, 'ui.popout': true,
        'ui.sidebarTitle': false, 'ui.sidebarBadge': false,
        'ui.sidebarShow': false, 'ui.sidebarHide': false,
        'ui.commandRegister': false, 'ui.commandUnregister': false,
        'ui.commandExecute': false, 'ui.commandList': false,
        'ui.menuContribute': false, 'ui.status': false,
        'ui.toast': false, 'ui.notify': false, 'ui.progress': false,
        'ui.navigate': false,
        'storage.get': false, 'storage.set': true, 'storage.remove': true,
        'storage.keys': false, 'storage.sync': true, 'storage.restore': false,
        'selection.get': false, 'clipboard.read': false, 'clipboard.write': true,
        'theme.get': false, 'i18n.t': false, 'i18n.lang': false,
        'host.info': false
    };
    var DEFAULT_CAPS = [
        'files.list', 'files.stat', 'files.read', 'files.open',
        'ui.toast', 'ui.status', 'ui.sidebarTitle', 'ui.sidebarBadge',
        'ui.sidebarShow', 'ui.sidebarHide', 'ui.commandList',
        'storage.get', 'storage.set', 'storage.remove', 'storage.keys',
        'selection.get', 'theme.get', 'i18n.t', 'i18n.lang', 'host.info'
    ];

    var sessions = new Map();     // window → session（用于广播 / 回复）
    var sessionById = new Map();  // sessionId → session（稳定主键，见 onMessage 注释）
    var exts = new Map();         // extId → {plugin, caps, sessions, commands, menus, status, sidebar, grants}
    var cmdPending = new Map();   // requestId → {resolve,reject,timer}
    var sdkSource = '';
    var sdkReady = null;
    var dom = {};
    var seq = 0;
    var initialized = false;
    var activeSidebar = null;
    var paletteItems = [];

    function app() { return root.app || null; }
    function ui() { return root.ui || null; }
    // TaskDock 在 task-dock.js 里是顶层 const（挂在全局词法环境，不是 window
    // 属性）。只查 root.TaskDock 会拿到 undefined，openWindow 就会静默退化成
    // 兜底浮层 —— 用户看到的不是独立窗口。两处都试，兼容老版本与测试台注入。
    function td() {
        return root.TaskDock || (typeof TaskDock !== 'undefined' ? TaskDock : null);
    }
    function nowId() { return 's' + (++seq) + '-' + Math.random().toString(36).slice(2, 7); }
    function toast(msg, level) {
        if (ui() && ui().showToast) ui().showToast(String(msg), level || 'info');
        else console.log('[ExtHost] ' + msg);
    }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function clone(o) { try { return JSON.parse(JSON.stringify(o)); } catch (e) { return o; } }

    /* ==================== DOM ==================== */

    function ensureDOM() {
        var q = function (id) { return document.getElementById(id); };
        dom.activity = q('gd-ext-activity');
        dom.panel = q('gd-ext-panel');
        dom.panelTitle = q('gd-ext-panel-title');
        dom.panelBody = q('gd-ext-panel-body');
        dom.statusbar = q('gd-ext-statusbar');
        dom.palette = q('gd-ext-palette');
        dom.paletteInput = q('gd-ext-palette-input');
        dom.paletteList = q('gd-ext-palette-list');
        dom.grantLayer = q('gd-ext-grant-layer');
        dom.sidebar = document.querySelector('.sidebar');
        dom.navManage = q('gd-ext-nav-manage');
        dom.viewBack = q('gd-ext-view-back');
        dom.viewWindow = q('gd-ext-view-window');
        dom.viewClose = q('gd-ext-panel-close');
        dom.searchBox = q('gd-search-box');
        dom.searchInput = q('search-input');
        dom.searchMode = q('gd-search-mode');
        dom.searchOptions = q('gd-search-options');
        dom.searchResults = q('gd-search-results');

        // 兜底：宿主没给容器时，列表与视图都归到主侧边栏里，不再往 body 上挂右侧浮层
        if (!dom.activity) {
            dom.activity = document.createElement('div');
            dom.activity.id = 'gd-ext-activity';
            dom.activity.className = 'gd-ext-activity gd-ext-nav-list';
            var nav = document.querySelector('.sidebar-nav');
            (nav || document.body).appendChild(dom.activity);
        }
        if (!dom.panel) {
            dom.panel = document.createElement('div');
            dom.panel.id = 'gd-ext-panel';
            dom.panel.className = 'gd-ext-view';
            dom.panel.hidden = true;
            dom.panel.innerHTML =
                '<div class="gd-ext-view-head">' +
                '<button id="gd-ext-view-back" class="gd-ext-view-btn" title="返回文件导航">←</button>' +
                '<span id="gd-ext-panel-title"></span>' +
                '<button id="gd-ext-view-window" class="gd-ext-view-btn" title="在独立窗口打开">⧉</button>' +
                '<button id="gd-ext-panel-close" class="gd-ext-view-btn" title="收起">✕</button></div>' +
                '<div id="gd-ext-panel-body"></div>';
            (dom.sidebar || document.body).appendChild(dom.panel);
            dom.panelTitle = q('gd-ext-panel-title');
            dom.panelBody = q('gd-ext-panel-body');
            dom.viewBack = q('gd-ext-view-back');
            dom.viewWindow = q('gd-ext-view-window');
            dom.viewClose = q('gd-ext-panel-close');
        }
        if (!dom.statusbar) {
            dom.statusbar = document.createElement('div');
            dom.statusbar.id = 'gd-ext-statusbar';
            dom.statusbar.className = 'gd-ext-statusbar';
            dom.statusbar.hidden = true;
            document.body.appendChild(dom.statusbar);
        }
        if (!dom.grantLayer) {
            dom.grantLayer = document.createElement('div');
            dom.grantLayer.id = 'gd-ext-grant-layer';
            dom.grantLayer.className = 'gd-ext-grant-layer';
            dom.grantLayer.hidden = true;
            document.body.appendChild(dom.grantLayer);
        }
    }

    var searchMode = 'files';
    var searchItems = [];
    var searchIndex = 0;
    var statusTimer = null;

    function isCommandMode() { return searchMode === 'commands'; }

    /** 顶部搜索框的两种模式：搜文件 / 搜命令。选项栏展开后切换。 */
    function setSearchMode(mode, focus) {
        searchMode = mode === 'commands' ? 'commands' : 'files';
        if (dom.searchMode) {
            dom.searchMode.textContent = isCommandMode() ? '命令 ⌄' : '文件 ⌄';
            dom.searchMode.classList.toggle('on', isCommandMode());
        }
        if (dom.searchOptions) {
            dom.searchOptions.querySelectorAll('[data-mode]').forEach(function (b) {
                b.classList.toggle('active', b.dataset.mode === searchMode);
            });
            dom.searchOptions.hidden = true;
        }
        if (dom.searchInput) {
            dom.searchInput.placeholder = isCommandMode() ? '输入命令…' : 'Search files...';
            if (isCommandMode()) {
                dom.searchInput.value = '';
                renderSearchCommands();
                if (focus) dom.searchInput.focus();
            } else {
                if (dom.searchResults) dom.searchResults.hidden = true;
                if (dom.searchInput.value) {
                    try { if (app() && app().searchFiles) app().searchFiles(dom.searchInput.value); } catch (err) {}
                }
            }
        }
        renderStatus();
        return searchMode;
    }

    function renderSearchCommands() {
        if (!dom.searchResults) return;
        var q = ((dom.searchInput && dom.searchInput.value) || '').toLowerCase();
        searchItems = commandList().filter(function (c) {
            return !q || (c.title + c.id + c.source).toLowerCase().indexOf(q) >= 0;
        });
        searchIndex = 0;
        dom.searchResults.innerHTML = searchItems.length ? searchItems.map(function (c, i) {
            return '<div class="gd-search-cmd' + (i === 0 ? ' first' : '') + '" data-id="' + esc(c.id) + '">' +
                '<span>' + esc(c.title) + '</span><small>' + esc(c.source) + ' · ' + esc(c.id) + '</small></div>';
        }).join('') : '<div class="gd-search-empty">没有匹配的命令</div>';
        dom.searchResults.hidden = false;
        dom.searchResults.querySelectorAll('.gd-search-cmd').forEach(function (el) {
            el.addEventListener('click', function () { runSearchCommand(el.dataset.id); });
        });
    }

    function runSearchCommand(id) {
        setSearchMode('files');
        executeCommand(id, {}).catch(function (err) { toast(err.message, 'error'); });
    }

    function bindDOM() {
        if (dom.viewClose) dom.viewClose.addEventListener('click', function () { hideSidebar(); });
        if (dom.viewBack) dom.viewBack.addEventListener('click', function () { hideSidebar(); });
        if (dom.viewWindow) dom.viewWindow.addEventListener('click', function () {
            var id = dom.viewWindow.dataset.ext || activeSidebar;
            if (id) openWindow(id, {});
        });
        if (dom.navManage) dom.navManage.addEventListener('click', function () {
            if (ui() && ui().switchView) ui().switchView('plugins');
        });
        if (dom.searchMode) dom.searchMode.addEventListener('click', function (e) {
            e.stopPropagation();
            if (dom.searchOptions) dom.searchOptions.hidden = !dom.searchOptions.hidden;
        });
        if (dom.searchOptions) dom.searchOptions.querySelectorAll('[data-mode]').forEach(function (b) {
            b.addEventListener('click', function (e) {
                e.stopPropagation();
                setSearchMode(b.dataset.mode, b.dataset.mode === 'commands');
            });
        });
        if (dom.searchInput) {
            dom.searchInput.addEventListener('input', function () {
                if (isCommandMode()) renderSearchCommands();
            });
            dom.searchInput.addEventListener('keydown', function (e) {
                if (!isCommandMode()) return;
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    if (!searchItems.length) return;
                    searchIndex = (searchIndex + (e.key === 'ArrowDown' ? 1 : searchItems.length - 1)) % searchItems.length;
                    if (dom.searchResults) dom.searchResults.querySelectorAll('.gd-search-cmd').forEach(function (el, i) {
                        el.classList.toggle('first', i === searchIndex);
                    });
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    if (searchItems.length) runSearchCommand(searchItems[searchIndex].id);
                } else if (e.key === 'Escape') {
                    setSearchMode('files');
                }
            });
        }
        document.addEventListener('click', function (e) {
            if (dom.searchOptions && !dom.searchOptions.hidden &&
                dom.searchBox && !dom.searchBox.contains(e.target)) dom.searchOptions.hidden = true;
            if (dom.searchResults && !dom.searchResults.hidden && isCommandMode() &&
                dom.searchBox && !dom.searchBox.contains(e.target)) dom.searchResults.hidden = true;
        });
        // 旧命令面板 DOM（测试台仍可能带）留兼容，主站不再弹出独立面板
        if (dom.paletteInput) dom.paletteInput.addEventListener('input', renderPalette);
        document.addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
                e.preventDefault(); setSearchMode('commands', true);
            }
        });
    }

    /* ==================== 扩展清单 ==================== */

    function installed() {
        try {
            if (app() && app().getInstalledPlugins) return app().getInstalledPlugins();
            return JSON.parse(localStorage.getItem('gd_plugins') || '{}');
        } catch (e) { return {}; }
    }

    function isV2(p) {
        return !!(p && (p.api === 2 || p.api === '2' || p.contributes || p.permissions));
    }

    function getExt(id, plugin) {
        var e = exts.get(id);
        if (e) { if (plugin) e.plugin = plugin; return e; }
        e = {
            id: id, plugin: plugin || installed()[id] || {},
            caps: null, sessions: new Set(),
            commands: new Map(), menus: {},
            status: '', sidebar: null, grants: loadGrants(id)
        };
        e.caps = normalizeCaps(e.plugin.permissions);
        exts.set(id, e);
        return e;
    }

    function normalizeCaps(list) {
        if (!Array.isArray(list)) return DEFAULT_CAPS.slice();
        return list.filter(function (c) { return Object.prototype.hasOwnProperty.call(CAPS, c); });
    }

    function loadGrants(id) {
        try { return JSON.parse(localStorage.getItem('gd_ext_grant_' + id) || '[]'); }
        catch (e) { return []; }
    }
    function saveGrants(e) {
        try { localStorage.setItem('gd_ext_grant_' + e.id, JSON.stringify(e.grants)); } catch (err) { /* 忽略 */ }
    }

    /** 重建活动栏（安装/卸载后调用） */
    function refresh() {
        ensureDOM();
        exts.forEach(function (e) { e.plugin = installed()[e.id] || e.plugin; e.caps = normalizeCaps(e.plugin.permissions); });
        var list = Object.keys(installed()).map(function (id) {
            return { id: id, p: installed()[id] };
        }).filter(function (x) { return isV2(x.p); });

        var html = '<div class="gd-ext-nav-item gd-ext-nav-cmd" data-cmd="1" role="button" tabindex="0" ' +
            'title="命令搜索 (Ctrl+Shift+P)"><span class="gd-ext-nav-ico">⌘</span>' +
            '<span class="gd-ext-nav-name">命令搜索</span></div>';
        html += list.map(function (x) {
            var icon = x.p.icon || '🧩';
            return '<div class="gd-ext-nav-item" data-ext="' + esc(x.id) + '" role="button" tabindex="0" ' +
                'title="' + esc(x.p.name || x.id) + ' · 点击打开独立窗口">' +
                '<span class="gd-ext-nav-ico">' + esc(icon) + '</span>' +
                '<span class="gd-ext-nav-name">' + esc(x.p.name || x.id) + '</span>' +
                '<span class="gd-ext-act-badge" data-badge="' + esc(x.id) + '"></span>' +
                '</div>';
        }).join('');
        dom.activity.innerHTML = html;
        // 默认形态回到 v1：点一下就是独立浮窗。v2 只带来 API 能力，
        // 不把扩展塞进主侧边栏里挤着显示。
        dom.activity.querySelectorAll('[data-ext]').forEach(function (b) {
            b.addEventListener('click', function () { openWindow(b.dataset.ext, {}); });
            b.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWindow(b.dataset.ext, {}); }
            });
        });
        var cmd = dom.activity.querySelector('[data-cmd]');
        if (cmd) cmd.addEventListener('click', function () { setSearchMode('commands', true); });
        dom.activity.hidden = false;
        renderStatus();
        return list.length;
    }

    /* ==================== iframe / 会话 ==================== */

    function loadSDK() {
        if (sdkReady) return sdkReady;
        var url = new URL('js/ext-sdk.js', document.baseURI).href;
        sdkReady = fetch(url, { cache: 'no-cache' }).then(function (r) {
            if (!r.ok) throw new Error('SDK 加载失败 HTTP ' + r.status);
            return r.text();
        }).then(function (t) { sdkSource = t; return t; })
            .catch(function (e) {
                console.warn('[ExtHost] SDK 源码不可用，扩展将只能使用 postMessage 裸协议：', e.message);
                sdkSource = '';
                return '';
            });
        return sdkReady;
    }

    function injectSDK(html, session) {
        var boot = '<script>window.__GD_EXT__=' + JSON.stringify({
            extId: session.extId, sessionId: session.sid, kind: session.kind,
            apiVersion: API_VERSION
        }).replace(/</g, '\\u003c') + ';</script>';
        // ★ 源码里任何 </script 字面（哪怕只是注释）都会提前闭合注入块，
        //   必须转义。SDK 里曾因为一句示例注释带闭合标签而整个注入失败。
        var sdk = sdkSource ? '<script>' + sdkSource.replace(/<\/script/gi, '<\\/script') + '</script>' : '';
        var head = /<head[^>]*>/i;
        if (head.test(html)) return html.replace(head, function (m) { return m + boot + sdk; });
        return boot + sdk + html;
    }

    /**
     * 创建一个扩展 iframe 并登记会话。
     * ★ sandbox 不含 allow-same-origin：blob iframe 保持 opaque origin。
     */
    function createFrame(e, kind, opts) {
        opts = opts || {};
        var sid = nowId();
        var frame = document.createElement('iframe');
        frame.className = 'gd-ext-frame';
        frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups allow-downloads');
        frame.setAttribute('allow', 'clipboard-read; clipboard-write');
        var session = { extId: e.id, sid: sid, kind: kind, frame: frame, blob: null, winId: null };
        sessionById.set(sid, session);
        // detached iframe 的 contentWindow 可能还是 about:blank 那个窗口；
        // load 后再登记一次，确保 SDK hello 到达时 e.source 能对上。
        if (frame.contentWindow) sessions.set(frame.contentWindow, session);
        frame.addEventListener('load', function () {
            try { if (frame.contentWindow) sessions.set(frame.contentWindow, session); } catch (err) { /* 忽略 */ }
        });

        var srcP = Promise.resolve();
        if (opts.html) {
            // ★ srcdoc + 不含 allow-same-origin 的 sandbox：扩展保持 opaque origin，
            //   读不到宿主 localStorage（那里面有 token）。opaque iframe 加载
            //   blob: URL 会被浏览器拒绝，所以这里不能用 blob 方案。
            srcP = loadSDK().then(function () {
                frame.srcdoc = injectSDK(opts.html, session);
            });
        } else if (opts.url) {
            frame.src = opts.url;     // 外部扩展需自行引入 SDK，宿主无法注入
        }
        e.sessions.add(session);
        return { frame: frame, session: session, ready: srcP };
    }

    function disposeSession(session) {
        try { sessions.delete(session.frame.contentWindow); } catch (err) { /* 忽略 */ }
        sessionById.delete(session.sid);
        var e = exts.get(session.extId);
        if (e) {
            e.sessions.delete(session);
            e.commands.forEach(function (c, id) { if (c.session === session) e.commands.delete(id); });
        }
        if (session.blob) URL.revokeObjectURL(session.blob);
        // 清掉这个会话发出的未完成命令
        cmdPending.forEach(function (p, id) { if (p.session === session) { clearTimeout(p.timer); cmdPending.delete(id); p.reject(new Error('扩展已关闭')); } });
    }

    /* ==================== 侧边栏（常驻视图） ==================== */

    function openSidebar(id) {
        var e = getExt(id);
        if (!isV2(e.plugin)) { toast('该扩展不是 v2 扩展', 'error'); return null; }
        if (!e.sidebar) {
            var made = createFrame(e, 'sidebar', { html: e.plugin.html, url: e.plugin.externalUrl });
            e.sidebar = made.session;
            made.frame.classList.add('gd-ext-sidebar-frame');
            dom.panelBody.appendChild(made.frame);
            made.ready.catch(function (err) { toast('扩展视图加载失败: ' + err.message, 'error'); });
        }
        showSidebar(id, e.sidebar);
        emitTo(e.sidebar, 'sidebar.show', { extId: id });
        return e.sidebar.sid;
    }

    function showSidebar(id, session) {
        ensureDOM();
        dom.panel.hidden = false;
        dom.panel.dataset.ext = id;
        if (dom.sidebar) dom.sidebar.classList.add('gd-ext-mode');
        if (dom.panelTitle) dom.panelTitle.textContent = (exts.get(id) && exts.get(id).plugin.name) || id;
        if (dom.viewWindow) dom.viewWindow.dataset.ext = id;
        dom.panelBody.querySelectorAll('.gd-ext-sidebar-frame').forEach(function (f) {
            f.style.display = 'none';
        });
        if (session && session.frame) session.frame.style.display = 'block';
        dom.activity.querySelectorAll('[data-ext]').forEach(function (b) {
            b.classList.toggle('active', b.dataset.ext === id);
        });
        activeSidebar = id;
        renderStatus();
        try { localStorage.setItem('gd_ext_active_sidebar', id); } catch (err) { /* 忽略 */ }
    }

    function hideSidebar() {
        if (dom.panel) dom.panel.hidden = true;
        if (dom.sidebar) dom.sidebar.classList.remove('gd-ext-mode');
        if (dom.activity) dom.activity.querySelectorAll('[data-ext]').forEach(function (b) { b.classList.remove('active'); });
        activeSidebar = null;
        renderStatus();
        try { localStorage.removeItem('gd_ext_active_sidebar'); } catch (err) { /* 忽略 */ }
    }

    /* ==================== 窗口 ==================== */

    function openWindow(id, opts) {
        opts = opts || {};
        var e = getExt(id);
        // 同一个扩展已有窗口时唤醒它，不在屏幕上堆一堆重复窗口。
        // 扩展主动调 GD.ui.window() 想开第二个时传 forceNew，仍可多开。
        if (!opts.forceNew) {
            var alive = null;
            e.sessions.forEach(function (s) {
                if (!alive && s.kind === 'window' && s.winId) alive = s;
            });
            if (alive) {
                var T0 = td();
                if (T0 && T0.expandPlugin) T0.expandPlugin(alive.winId);
                renderStatus();
                return alive.sid;
            }
        }
        var made = createFrame(e, 'window', { html: opts.html || e.plugin.html, url: opts.url || e.plugin.externalUrl });
        var s = made.session;
        var T = td();
        var title = opts.title || e.plugin.name || id;
        if (T && T.openPlugin) {
            s.winId = T.openPlugin({
                title: title,
                icon: opts.icon || e.plugin.icon || '🧩',
                mount: made.frame,
                onClose: function () { disposeSession(s); }
            });
            if (s.winId) {
                // 扩展窗口默认比 v1 的 460×380 大一圈，内容不再被挤扁；
                // 用户依然能拖拽、resize、全屏。
                var el = document.querySelector('.tp-win[data-id="' + s.winId + '"]');
                if (el) el.classList.add('tp-win-ext');
            } else {
                // 任务坞拒收时兜底：漂浮层
                mountFallback(s, title, opts);
            }
        } else {
            mountFallback(s, title, opts);
        }
        made.ready.catch(function (err) { toast('扩展窗口加载失败: ' + err.message, 'error'); });
        return s.sid;
    }

    function mountFallback(s, title, opts) {
        var box = document.createElement('div');
        box.className = 'gd-ext-fallback';
        box.innerHTML = '<div class="gd-ext-fallback-head"><span>' + esc(title) + '</span><button>✕</button></div>';
        box.appendChild(s.frame);
        document.body.appendChild(box);
        box.querySelector('button').addEventListener('click', function () {
            box.remove(); disposeSession(s);
        });
        s.fallback = box;
    }

    function popupWindow(from, p) {
        var html = p.html || '';
        if (!html) throw new Error('popout 需要 html');
        var ext = exts.get(from.extId);
        if (!ext) throw new Error('扩展会话已失效');
        // ★ 同步开窗口保住用户手势；SDK 是异步取的，之后再往里写内容。
        //   新标签里只有一层「转发壳」+ 一个 opaque sandbox iframe：
        //   壳与宿主同源（about:blank 继承 opener），但扩展代码在 iframe 里
        //   是 opaque origin —— 读不到 opener.localStorage 里的 token。
        var w = root.open('', '_blank');
        if (!w) throw new Error('弹出窗口被拦截：请允许本站弹窗，或改用 GD.window.open()');
        var sid = nowId();
        var session = { extId: from.extId, sid: sid, kind: 'popout', frame: { contentWindow: w }, blob: null, winId: null };
        sessions.set(w, session);
        sessionById.set(sid, session);
        ext.sessions.add(session);
        return loadSDK().then(function () {
            var doc = injectSDK(html, session);
            // 把扩展 HTML 当 JS 字符串嵌入；< 全部转义，避免里面的 </script>
            // 提前结束转发脚本。
            var literal = JSON.stringify(doc).replace(/</g, '\\u003c');
            var wrap = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
                '<title>' + esc(p.title || ext.plugin.name || '扩展') + '</title>' +
                '<style>html,body,iframe{margin:0;width:100%;height:100%;border:0;overflow:hidden}</style>' +
                '</head><body><iframe id="f" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"></iframe>' +
                '<script>var f=document.getElementById("f");f.srcdoc=' + literal + ';' +
                'addEventListener("message",function(e){var d=e.data;if(!d)return;' +
                'if(e.source===f.contentWindow&&d.source==="gd-ext"){opener.postMessage(d,"*");}' +
                'else if(e.source===opener&&d.source==="gd-ext-host"){f.contentWindow.postMessage(d,"*");}});' +
                '</scr' + 'ipt></body></html>';
            w.document.open(); w.document.write(wrap); w.document.close();
            return { sessionId: sid, title: p.title || ext.plugin.name };
        }).catch(function (err) {
            sessions.delete(w); sessionById.delete(sid); ext.sessions.delete(session);
            try { w.close(); } catch (e2) { /* 忽略 */ }
            throw err;
        });
    }

    /** 供 app.runPlugin 调用：默认一律开独立窗口（v1 形态）。
     *  v2 的价值在 API 能力（联网 / 命令 / 状态栏 / 存储 / 多窗口），
     *  不在把界面塞进侧边栏。扩展仍可显式请求侧栏视图。 */
    function open(plugin, opts) {
        if (!isV2(plugin)) return false;   // v1 交给原 showPluginRunner
        var e = getExt(plugin.id, plugin);
        opts = opts || {};
        if (opts.sidebar === true) return openSidebar(e.id);
        return openWindow(e.id, opts);
    }

    /* ==================== 消息通道 ==================== */

    function reply(win, requestId, ok, data, error) {
        try {
            win.postMessage({
                source: 'gd-ext-host', type: 'response', requestId: requestId,
                ok: !!ok, data: data === undefined ? null : data,
                error: error ? String(error) : null
            }, '*');
        } catch (e) { /* iframe 已关闭 */ }
    }

    function emitTo(s, name, payload) {
        if (!s || !s.frame) return;
        try {
            s.frame.contentWindow.postMessage({ source: 'gd-ext-host', type: 'event', name: name, payload: payload || {} }, '*');
        } catch (e) { /* 忽略 */ }
    }

    /** 广播宿主事件给所有会话 */
    function emit(name, payload) {
        sessions.forEach(function (s) { emitTo(s, name, payload); });
    }

    function context() {
        var a = app(), u = ui();
        // getUser() 在首次加载 / 用户数据被清空时会返回 null，
        // 直接读 .login 会让扩展 iframe 的 hello 消息整条炸掉。
        var user = (a && a.storage && a.storage.getUser) ? a.storage.getUser() : null;
        return {
            view: (u && u._currentView) || null,
            path: (a && a.fileManager && a.fileManager.currentPath) || null,
            user: (user && user.login) || null,
            lang: (root.I18n && root.I18n.current) || 'zh',
            theme: document.documentElement.dataset.theme ||
                (document.body.classList.contains('dark-mode') ? 'dark' : 'light')
        };
    }

    function onMessage(e) {
        var d = e.data;
        if (!d || d.source !== 'gd-ext') return;
        var s = sessions.get(e.source);
        // ★ srcdoc / sandbox iframe 插入 DOM 后会换一个 WindowProxy，
        //   而 SDK 的 hello 在 load 事件之前就发了，此时按 window 查不到。
        //   用注入时写死的 sessionId 兜底，并校验来源必须仍是该会话的窗口，
        //   防止别的窗口猜到 id 冒充会话。
        if (!s && d.sessionId) {
            var byId = sessionById.get(d.sessionId);
            if (byId) {
                var cw = null;
                try { cw = byId.frame && byId.frame.contentWindow; } catch (err) { /* 忽略 */ }
                if (cw && e.source === cw) {
                    s = byId;
                    sessions.set(e.source, s);
                }
            }
        }
        if (!s) return;                       // 未登记的窗口一律不理
        var ext = exts.get(s.extId);
        if (!ext) return;

        if (d.type === 'hello') {
            // ★ 必须用 hello-ack，不能复用 response：SDK 的 hello 不进
            //   pending 表，回 response 会被静默丢弃，GD.ready 永远悬着。
            var ack = {
                apiVersion: API_VERSION, caps: ext.caps.slice(),
                extId: s.extId, sessionId: s.sid, kind: s.kind,
                context: context(), manifest: ext.plugin.contributes || {}
            };
            try {
                e.source.postMessage({
                    source: 'gd-ext-host', type: 'hello-ack',
                    requestId: d.requestId, payload: ack
                }, '*');
            } catch (err) { /* iframe 已关闭 */ }
            emitTo(s, 'extension.ready', { extId: s.extId });
            return;
        }
        if (d.type === 'command-response') {
            var p = cmdPending.get(d.requestId);
            if (p) {
                clearTimeout(p.timer); cmdPending.delete(d.requestId);
                if (d.ok) p.resolve(d.data); else p.reject(new Error(d.error || '命令执行失败'));
            }
            return;
        }
        if (d.type !== 'call') return;
        if (!Object.prototype.hasOwnProperty.call(CAPS, d.cap)) {
            reply(e.source, d.requestId, false, null, '未知能力: ' + d.cap); return;
        }
        if (ext.caps.indexOf(d.cap) < 0) {
            reply(e.source, d.requestId, false, null, '扩展未声明该能力: ' + d.cap); return;
        }
        Promise.resolve().then(function () { return dispatch(s, ext, d.cap, d.params || {}); })
            .then(function (r) { reply(e.source, d.requestId, true, r); })
            .catch(function (err) { reply(e.source, d.requestId, false, null, (err && err.message) || err); });
    }

    /* ==================== 能力实现 ==================== */

    function need(obj, msg) { if (!obj) throw new Error(msg); return obj; }

    function toBase64(buf) {
        var bytes = new Uint8Array(buf), out = '', chunk = 0x8000;
        for (var i = 0; i < bytes.length; i += chunk) {
            out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(out);
    }

    function fileList(p) {
        var a = need(app(), '宿主未就绪');
        var st = need(a.storage, '存储模块未就绪');
        var path = p.path || (a.fileManager && a.fileManager.currentPath) || '/drive_home';
        var items = st.listDirectory ? st.listDirectory(path) : [];
        return (items || []).map(function (f) {
            return { name: f.name, path: f.path, isFolder: !!f.isFolder, size: f.size || 0,
                type: f.type || (f.isFolder ? 'folder' : 'file'), modified: f.modified || f.updatedAt || null };
        });
    }

    async function fileRead(p) {
        var a = need(app(), '宿主未就绪');
        var fm = need(a.fileManager, '文件管理器未就绪');
        if (!p.path) throw new Error('缺少 path');
        var blob = await fm.getFileBlob(p.path);
        if (!blob || !(blob instanceof Blob)) throw new Error('文件读取失败');
        var buf = await blob.arrayBuffer();
        if (buf.byteLength > 8 * 1024 * 1024) throw new Error('文件超过 8MB，请用宿主原生预览');
        if (p.encoding === 'base64') return { path: p.path, size: buf.byteLength, encoding: 'base64', content: toBase64(buf) };
        var text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
        catch (err) { try { text = new TextDecoder('gbk').decode(buf); } catch (e2) { text = new TextDecoder('utf-8').decode(buf); } }
        return { path: p.path, size: buf.byteLength, encoding: 'utf8', content: text };
    }

    async function fileWrite(p) {
        var a = need(app(), '宿主未就绪');
        var fm = need(a.fileManager, '文件管理器未就绪');
        if (!p.path) throw new Error('缺少 path');
        var parts = String(p.path).split('/');
        var name = parts.pop() || 'untitled.txt';
        var dir = parts.join('/') || '/drive_home';
        var content = p.content == null ? '' : String(p.content);
        var blob = new Blob([content], { type: 'application/octet-stream' });
        await fm.uploadFile(new File([blob], name), dir);
        if (a.loadFiles) await a.loadFiles();
        return { path: p.path, size: content.length };
    }

    async function fileDelete(p) {
        var a = need(app(), '宿主未就绪');
        var fm = need(a.fileManager, '文件管理器未就绪');
        if (!p.path) throw new Error('缺少 path');
        var fn = fm.deleteFile || fm.removeFile;
        if (!fn) throw new Error('宿主不支持删除');
        await fn.call(fm, p.path);
        if (a.loadFiles) await a.loadFiles();
        return { path: p.path };
    }

    async function fileOpen(p) {
        var a = need(app(), '宿主未就绪');
        if (!p.path) throw new Error('缺少 path');
        var name = String(p.path).split('/').pop() || p.path;
        await a.previewFile({ path: p.path, name: name, isFolder: false });
        return true;
    }

    /* ---------- 网络 ---------- */

    function askGrant(ext, origin, detail) {
        return new Promise(function (resolve) {
            var layer = dom.grantLayer;
            layer.hidden = false;
            layer.innerHTML =
                '<div class="gd-ext-grant-box">' +
                '<div class="gd-ext-grant-title">🌐 扩展请求访问网络</div>' +
                '<p><b>' + esc(ext.plugin.name || ext.id) + '</b> 想访问</p>' +
                '<code>' + esc(detail) + '</code>' +
                '<p class="gd-ext-grant-note">请求由宿主代发，扩展拿不到你的 GitHub 令牌。' +
                '拒绝后该扩展仍可使用已授权的功能。</p>' +
                '<div class="gd-ext-grant-actions">' +
                '<button data-a="once">仅本次允许</button>' +
                '<button data-a="always">始终允许该域名</button>' +
                '<button data-a="deny" class="danger">拒绝</button>' +
                '</div></div>';
            var done = function (v) { layer.hidden = true; layer.innerHTML = ''; resolve(v); };
            layer.querySelectorAll('[data-a]').forEach(function (b) {
                b.addEventListener('click', function () { done(b.dataset.a); });
            });
        });
    }

    async function ensureGrant(ext, origin, detail) {
        if (ext.grants.indexOf(origin) >= 0) return true;
        var r = await askGrant(ext, origin, detail);
        if (r === 'deny') throw new Error('用户拒绝了网络访问: ' + origin);
        if (r === 'always') {
            ext.grants.push(origin); saveGrants(ext);
        }
        return true;   // once 不落盘
    }

    async function netFetch(s, p) {
        var ext = exts.get(s.extId);
        if (!p || !p.url) throw new Error('缺少 url');
        var u;
        try { u = new URL(p.url, location.href); } catch (err) { throw new Error('URL 不合法: ' + p.url); }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('只支持 http/https');
        await ensureGrant(ext, u.origin, (p.method || 'GET').toUpperCase() + ' ' + u.href);

        var method = (p.method || 'GET').toUpperCase();
        if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].indexOf(method) < 0) {
            throw new Error('不支持的方法: ' + method);
        }
        var timeout = Math.min(Math.max(Number(p.timeout) || 15000, 1000), 120000);
        var ctrl = new AbortController();
        var timer = setTimeout(function () { ctrl.abort(); }, timeout);

        // proxy:'backend' 时把请求交给用户配置的本地后端（可绕过 CORS）
        if (p.proxy === 'backend') {
            var cfg = (app() && app().getBackendConfig && app().getBackendConfig()) || {};
            var base = cfg.url || 'http://localhost:8787';
            var headers = { 'Content-Type': 'application/json' };
            if (cfg.token) headers['X-Auth-Token'] = cfg.token;
            var pr = await fetch(base + '/fetch', {
                method: 'POST', headers: headers, signal: ctrl.signal,
                body: JSON.stringify({ url: u.href, method: method, headers: p.headers || {}, body: p.body || null })
            });
            clearTimeout(timer);
            var txt = await pr.text();
            try { return JSON.parse(txt); } catch (err) { return { ok: pr.ok, status: pr.status, body: txt, encoding: 'text' }; }
        }

        var init = {
            method: method, headers: p.headers || {}, mode: p.mode || 'cors',
            credentials: 'omit', signal: ctrl.signal, redirect: 'follow'
        };
        if (p.body != null && method !== 'GET' && method !== 'HEAD') {
            init.body = typeof p.body === 'string' ? p.body : JSON.stringify(p.body);
        }
        var resp;
        try { resp = await fetch(u.href, init); }
        catch (err) {
            clearTimeout(timer);
            if (err.name === 'AbortError') throw new Error('请求超时 (' + timeout + 'ms)');
            throw new Error('请求失败：目标站点可能未允许跨域 (CORS)。可改用 proxy:"backend" 或 no-cors 模式。' + (err.message ? ' [' + err.message + ']' : ''));
        }
        clearTimeout(timer);
        var hdr = {};
        try { resp.headers.forEach(function (v, k) { hdr[k] = v; }); } catch (err) { /* 忽略 */ }
        var ct = resp.headers.get('content-type') || '';
        var buf = await resp.arrayBuffer();
        var textual = /text|json|xml|javascript|urlencoded|graphql/i.test(ct);
        var body;
        if (textual) { try { body = new TextDecoder('utf-8').decode(buf); } catch (err) { body = toBase64(buf); } }
        else body = toBase64(buf);
        return {
            ok: resp.ok, status: resp.status, statusText: resp.statusText,
            url: resp.url, headers: hdr, contentType: ct, size: buf.byteLength,
            encoding: textual ? 'text' : 'base64', body: body,
            truncated: buf.byteLength > 4 * 1024 * 1024
        };
    }

    async function netGithub(p) {
        var a = need(app(), '宿主未就绪');
        var api = need(a.api, 'GitHub API 未就绪');
        if (!p || !p.path || p.path.charAt(0) !== '/') throw new Error('只允许相对路径，例如 /user');
        if (p.url) throw new Error('不接受自定义 url');
        var method = (p.method || 'GET').toUpperCase();
        if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].indexOf(method) < 0) throw new Error('不支持的方法');
        var fn = api.request || api.call || api.fetch;
        if (!fn) throw new Error('宿主 API 不支持通用请求');
        return await fn.call(api, method, p.path, p.body);
    }

    /* ---------- 命令 / 菜单 / 状态栏 ---------- */

    function executeCommand(id, args) {
        var found = null;
        exts.forEach(function (e) { if (!found && e.commands.has(id)) found = { e: e, c: e.commands.get(id) }; });
        if (!found) {
            // 内置命令
            if (id === 'ext.market') { if (ui() && ui().switchView) ui().switchView('plugins'); return Promise.resolve(true); }
            if (id === 'ext.palette') { togglePalette(true); return Promise.resolve(true); }
            if (id === 'ext.refresh') { return Promise.resolve(refresh()); }
            return Promise.reject(new Error('未找到命令: ' + id));
        }
        var c = found.c, s = c.session;
        if (!s) return Promise.reject(new Error('命令所属扩展已关闭'));
        var rid = ++seq;
        return new Promise(function (resolve, reject) {
            var timer = setTimeout(function () {
                cmdPending.delete(rid); reject(new Error('命令执行超时: ' + id));
            }, 30000);
            cmdPending.set(rid, { resolve: resolve, reject: reject, timer: timer, session: s });
            try {
                s.frame.contentWindow.postMessage({
                    source: 'gd-ext-host', type: 'command', requestId: rid,
                    commandId: id, args: args || {}
                }, '*');
            } catch (err) {
                clearTimeout(timer); cmdPending.delete(rid); reject(err);
            }
        });
    }

    function commandList() {
        var out = [
            { id: 'ext.palette', title: '命令面板', source: '宿主' },
            { id: 'ext.market', title: '打开插件广场', source: '宿主' },
            { id: 'ext.refresh', title: '刷新扩展列表', source: '宿主' }
        ];
        exts.forEach(function (e) {
            e.commands.forEach(function (c, id) {
                out.push({ id: id, title: c.title, source: e.plugin.name || e.id });
            });
        });
        return out;
    }

    /** 给宿主右键菜单用：scope='file' */
    function menuItems(scope, file) {
        var out = [];
        // ★ 清单声明与运行时注入常常指向同一个 command（示例扩展两者都写了）。
        //   不去重的话右键菜单会出现两个一模一样的条目。运行时注入优先：
        //   扩展会话一定还活着，点下去命令必然可执行。
        var seen = Object.create(null);
        exts.forEach(function (e) {
            var declared = (e.plugin.contributes && e.plugin.contributes.menus &&
                e.plugin.contributes.menus[scope]) || [];
            var all = (e.menus[scope] || []).concat(declared);
            all.forEach(function (m) {
                if (!m || !m.command || !m.label) return;
                if (seen[m.command]) return;
                seen[m.command] = true;
                if (m.when === 'file' && (!file || file.isFolder)) return;
                out.push({
                    icon: m.icon || '🧩',
                    label: m.label + ' · ' + (e.plugin.name || e.id),
                    onClick: function () { executeCommand(m.command, { file: clone(file || {}) }).catch(function (err) { toast(err.message, 'error'); }); }
                });
            });
        });
        return out;
    }

    function renderStatus() {
        if (!dom.statusbar) return;
        var T = td(), tasks = [];
        try { if (T && T.all) tasks = T.all(); } catch (err) { /* 任务坞未就绪 */ }
        var running = tasks.filter(function (t) { return t.status === 'running'; });
        var failed = tasks.filter(function (t) { return t.error || t.status === 'error'; });
        var inst = installed();
        var enabled = Object.keys(inst).filter(function (id) { return isV2(inst[id]); }).length;
        var u = ui();

        function cell(inner, cls, title, act) {
            return '<span class="gd-ext-status-cell ' + (cls || '') + '"' +
                (title ? ' title="' + esc(title) + '"' : '') +
                (act ? ' data-act="' + esc(act) + '"' : '') + '>' + inner + '</span>';
        }
        var html = '';
        if (running.length) {
            var t = running[0];
            var pct = Math.max(0, Math.min(100, Math.round(t.percent || 0)));
            var kind = t.type === 'upload' ? '↑ 上传' : t.type === 'download' ? '↓ 下载' : '⟳ 同步';
            html += cell('<i class="gd-ext-status-dot busy"></i>' + kind +
                ' <span class="gd-ext-status-track"><i style="width:' + pct + '%"></i></span> ' + pct + '%' +
                (running.length > 1 ? ' +' + (running.length - 1) : ''),
                'clickable', t.title || '查看后台进程', 'tasks');
        } else {
            html += cell('<i class="gd-ext-status-dot' + (failed.length ? ' error' : '') + '"></i>' +
                (failed.length ? failed.length + ' 个任务失败' : '已同步'),
                failed.length ? 'warn clickable' : 'clickable', '查看后台进程', 'tasks');
        }
        // 扩展自己上报的零碎信息（字数、调试计数等）收进 title，悬停才看得到；
        // 底栏可见部分只保留：上传进度 / 扩展启用数与当前扩展 / 选中文件 / 搜索范围。
        var st = '', winCount = 0, winNames = [];
        exts.forEach(function (e) {
            if (e.status && !st) st = e.status;
            e.sessions.forEach(function (s) {
                if (s.kind === 'window' || s.kind === 'popout') {
                    winCount++;
                    winNames.push((inst[e.id] && inst[e.id].name) || e.id);
                }
            });
        });
        var tip = st ? '扩展状态：' + st
            : (winCount ? '打开的窗口：' + winNames.slice(-3).join('、') : '打开插件广场');
        html += cell('🧩 扩展 ' + enabled + ' 已启用' + (winCount ? ' · ' + winCount + ' 个窗口' : ''),
            'clickable gd-ext-status-hide-sm', tip, 'plugins');
        if (failed.length) html += cell('⚠ ' + failed.length + ' 错误', 'warn clickable gd-ext-status-hide-sm', '查看后台进程', 'tasks');

        var sel = '';
        try {
            var picked = (u && (u.selectedFiles || (u.selectedFile ? [u.selectedFile] : []))) || [];
            if (picked.length) sel = picked[0].name || '';
        } catch (err) { /* 忽略 */ }
        html += '<span class="gd-ext-status-right">';
        if (sel) html += cell('📄 ' + esc(sel), 'gd-ext-status-hide-sm', sel);
        html += cell('⌘ ' + (isCommandMode() ? '命令' : '文件') + '搜索', 'clickable', '点击切换搜索范围', 'search');
        // version.js 用顶层 const 声明 APP_VERSION，不会挂到 window 上
        var ver = (typeof APP_VERSION !== 'undefined' && APP_VERSION.version) ||
                  (root.APP_VERSION && root.APP_VERSION.version) || '';
        html += cell('v' + ver, 'gd-ext-status-ver');
        html += '</span>';

        dom.statusbar.innerHTML = html;
        dom.statusbar.hidden = false;
        dom.statusbar.querySelectorAll('[data-act]').forEach(function (el) {
            el.addEventListener('click', function () {
                var a = el.dataset.act;
                if (a === 'tasks' && u && u.showTaskManager) u.showTaskManager();
                else if (a === 'plugins' && u && u.switchView) u.switchView('plugins');
                else if (a === 'search') setSearchMode(isCommandMode() ? 'files' : 'commands', isCommandMode() ? false : true);
            });
        });
    }

    /* ---------- 命令面板 ---------- */

    function togglePalette(show) {
        // 不再弹独立面板：命令搜索复用顶部已有的搜索框
        if (show) setSearchMode('commands', true);
        else if (isCommandMode()) setSearchMode('files');
    }

    function renderPalette() {
        if (!dom.paletteList) return;
        var q = (dom.paletteInput.value || '').toLowerCase();
        paletteItems = commandList().filter(function (c) {
            return !q || (c.title + c.id + c.source).toLowerCase().indexOf(q) >= 0;
        });
        dom.paletteList.innerHTML = paletteItems.length ? paletteItems.map(function (c, i) {
            return '<div class="gd-ext-pal-item' + (i === 0 ? ' first' : '') + '" data-id="' + esc(c.id) + '">' +
                '<span>' + esc(c.title) + '</span><small>' + esc(c.source) + ' · ' + esc(c.id) + '</small></div>';
        }).join('') : '<div class="gd-ext-pal-empty">没有匹配的命令</div>';
        dom.paletteList.querySelectorAll('.gd-ext-pal-item').forEach(function (el) {
            el.addEventListener('click', function () {
                togglePalette(false);
                executeCommand(el.dataset.id, {}).catch(function (err) { toast(err.message, 'error'); });
            });
        });
    }

    /* ---------- 存储 ---------- */

    function storeKey(e, key) { return 'gd_ext_' + e.id + '__' + key; }
    function storeKeys(e) {
        var prefix = 'gd_ext_' + e.id + '__', out = [];
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (k && k.indexOf(prefix) === 0) out.push(k.slice(prefix.length));
        }
        return out;
    }
    async function storeSync(e) {
        var data = {};
        storeKeys(e).forEach(function (k) {
            try { data[k] = JSON.parse(localStorage.getItem(storeKey(e, k))); } catch (err) { /* 跳过坏值 */ }
        });
        await fileWrite({ path: '.gd/extensions/' + e.id + '.json', content: JSON.stringify(data, null, 2) });
        return { keys: Object.keys(data).length };
    }
    async function storeRestore(e) {
        var r = await fileRead({ path: '.gd/extensions/' + e.id + '.json' });
        var data = JSON.parse(r.content);
        Object.keys(data || {}).forEach(function (k) {
            localStorage.setItem(storeKey(e, k), JSON.stringify(data[k]));
        });
        return { keys: Object.keys(data || {}).length };
    }

    /* ==================== 分发 ==================== */

    function dispatch(s, ext, cap, p) {
        var a = app(), u = ui();
        switch (cap) {
            case 'files.list': return fileList(p);
            case 'files.stat': return fileRead(p).then(function (r) { return { path: r.path, size: r.size }; });
            case 'files.read': return fileRead(p);
            case 'files.write': return fileWrite(p);
            case 'files.upload': return fileWrite({ path: p.path, content: p.content });
            case 'files.delete': return fileDelete(p);
            case 'files.open': return fileOpen(p);
            case 'net.fetch': return netFetch(s, p);
            case 'net.github': return netGithub(p);
            case 'net.grants': return ext.grants.slice();
            case 'net.revoke': {
                var i = ext.grants.indexOf(p.origin);
                if (i >= 0) { ext.grants.splice(i, 1); saveGrants(ext); }
                return ext.grants.slice();
            }
            case 'ui.window': return openWindow(ext.id, { html: p.html, url: p.url, title: p.title, icon: p.icon, forceNew: true });
            case 'ui.close': {
                if (s.winId && td() && td().closePlugin) td().closePlugin(s.winId);
                else if (s.fallback) { s.fallback.remove(); disposeSession(s); }
                else hideSidebar();
                return true;
            }
            case 'ui.setTitle': {
                if (s.winId && td() && td().setPluginTitle) td().setPluginTitle(s.winId, p.title);
                if (s.kind === 'sidebar' && dom.panelTitle) dom.panelTitle.textContent = p.title;
                return true;
            }
            case 'ui.fullscreen': {
                if (s.winId && td() && td().togglePluginFull) td().togglePluginFull(s.winId);
                return true;
            }
            case 'ui.popout': return popupWindow(s, p);
            case 'ui.sidebarTitle': { if (dom.panelTitle && s.kind === 'sidebar') dom.panelTitle.textContent = p.title; return true; }
            case 'ui.sidebarBadge': {
                if (dom.activity) {
                    Array.prototype.forEach.call(dom.activity.querySelectorAll('[data-badge]'), function (b) {
                        if (b.dataset.badge === ext.id) b.textContent = p.badge == null || p.badge === '' ? '' : String(p.badge);
                    });
                }
                return true;
            }
            case 'ui.sidebarShow': return openSidebar(ext.id);
            case 'ui.sidebarHide': hideSidebar(); return true;
            case 'ui.commandRegister': {
                ext.commands.set(p.id, { title: p.title || p.id, session: s });
                return true;
            }
            case 'ui.commandUnregister': ext.commands.delete(p.id); return true;
            case 'ui.commandExecute': return executeCommand(p.id, p.args);
            case 'ui.commandList': return commandList();
            case 'ui.menuContribute': {
                ext.menus[p.scope] = (ext.menus[p.scope] || []).concat(p.items || []);
                return true;
            }
            case 'ui.status': { ext.status = String(p.text || ''); renderStatus(); return true; }
            case 'ui.toast': toast(p.message, p.level); return true;
            case 'ui.notify': {
                toast(p.title ? p.title + ' — ' + (p.body || '') : (p.body || '通知'), 'info');
                return true;
            }
            case 'ui.progress': { ext.status = p.label || '⏳ ' + (p.value || 0) + '%'; renderStatus(); return true; }
            case 'ui.navigate': { if (u && u.switchView) u.switchView(p.view); return true; }
            case 'storage.get': {
                var raw = localStorage.getItem(storeKey(ext, p.key));
                return raw == null ? (p.def === undefined ? null : p.def) : JSON.parse(raw);
            }
            case 'storage.set': localStorage.setItem(storeKey(ext, p.key), JSON.stringify(p.value)); return true;
            case 'storage.remove': localStorage.removeItem(storeKey(ext, p.key)); return true;
            case 'storage.keys': return storeKeys(ext);
            case 'storage.sync': return storeSync(ext);
            case 'storage.restore': return storeRestore(ext);
            case 'selection.get': {
                var sel = (u && (u.selectedFiles || (u.selectedFile ? [u.selectedFile] : []))) || [];
                return sel.map(function (f) { return { name: f.name, path: f.path, isFolder: !!f.isFolder }; });
            }
            case 'clipboard.write': return root.navigator.clipboard.writeText(String(p.text));
            case 'clipboard.read': return root.navigator.clipboard.readText();
            case 'theme.get': return context().theme;
            case 'i18n.t': return (root.I18n && root.I18n.t) ? root.I18n.t(p.key, p.fallback) : (p.fallback || p.key);
            case 'i18n.lang': return context().lang;
            case 'host.info': return {
                apiVersion: API_VERSION,
                version: (typeof APP_VERSION !== 'undefined' && APP_VERSION.version) ||
                         (root.APP_VERSION && root.APP_VERSION.version) || 'unknown',
                extId: ext.id, caps: ext.caps.slice(),
                sessions: sessions.size, extensions: exts.size,
                context: context()
            };
            default: throw new Error('能力未实现: ' + cap);
        }
    }

    /* ==================== 启动 ==================== */

    /**
     * 把宿主的关键动作变成扩展事件。
     * 用一层薄包装而不是散落在 app.js / ui.js 各处埋点：换账号重建 UI 后
     * refresh() 会再调一次，且每个方法只包装一次（_gdExtPatched 标记）。
     */
    function hookHost() {
        var a = app(), u = ui();
        if (!a || !u) return;
        // 同一对象要包装多个方法，用集合避免重复包装
        function mark(obj, key) {
            if (!obj.__gdHooked) obj.__gdHooked = {};
            if (obj.__gdHooked[key]) return false;
            obj.__gdHooked[key] = true; return true;
        }
        function wrap(obj, name, event, payload) {
            if (!obj || !mark(obj, name)) return;
            var orig = obj[name];
            if (typeof orig !== 'function') return;
            obj[name] = function () {
                var r = orig.apply(this, arguments);
                try { emit(event, payload ? payload.apply(this, arguments) : {}); }
                catch (err) { /* 事件不能影响宿主本身 */ }
                return r;
            };
        }
        wrap(u, 'switchView', 'view.change', function (v) { return { view: v }; });
        wrap(u, 'selectFile', 'selection.change', function (el, f) {
            return { files: f ? [{ name: f.name, path: f.path, isFolder: !!f.isFolder }] : [] };
        });
        wrap(u, 'deselectFile', 'selection.change', function () { return { files: [] }; });
        wrap(a, 'openFile', 'file.open', function (f) {
            return { file: f ? { name: f.name, path: f.path, isFolder: !!f.isFolder } : null };
        });
        wrap(a, 'loadFiles', 'files.changed', function () { return {}; });
        wrap(a, 'previewFile', 'file.preview', function (f) {
            return { file: f ? { name: f.name, path: f.path } : null };
        });
    }

    function init() {
        if (initialized) return; initialized = true;
        ensureDOM();
        bindDOM();
        root.addEventListener('message', onMessage);
        loadSDK();
        refresh();
        hookHost();
        // 上传/下载进度与扩展状态是活数据，1 秒刷一次
        if (!statusTimer) statusTimer = setInterval(renderStatus, 1000);
        // v1 形态：窗口不自动恢复。清掉旧版残留的侧栏状态，
        // 否则用户刷新后又会冒出一个占主导航的扩展面板。
        try { localStorage.removeItem('gd_ext_active_sidebar'); } catch (err) { /* 忽略 */ }
    }

    root.ExtHost = {
        version: API_VERSION,
        caps: CAPS,
        defaultCaps: DEFAULT_CAPS,
        init: init,
        refresh: refresh,
        open: open,
        openSidebar: openSidebar,
        openWindow: openWindow,
        hideSidebar: hideSidebar,
        emit: emit,
        menuItems: menuItems,
        executeCommand: executeCommand,
        commandList: commandList,
        togglePalette: togglePalette,
        setSearchMode: setSearchMode,
        isCommandMode: isCommandMode,
        renderStatus: renderStatus,
        isV2: isV2,
        debug: function () {
            return { sessions: sessions.size, exts: Array.from(exts.keys()), activeSidebar: activeSidebar };
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(typeof window !== 'undefined' ? window : this);
