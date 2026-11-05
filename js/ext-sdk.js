/* ==================================================================
   ext-sdk.js —— GitHub Drive 扩展 SDK（v2）
   ------------------------------------------------------------------
   两种用法，同一个文件：

   1) 官方/仓库扩展：宿主创建 iframe 时把本文件全文注入 <head>，
      所以扩展 HTML 里直接写 GD.ready.then(...) 即可，不用引任何外链。
   2) 外部 URL 扩展：自己用 script 标签引入本文件，
      SDK 会通过 window.opener / window.parent 找到宿主。

   ★ 设计要点
     - 扩展永远拿不到原始 token。需要鉴权的操作（读写仓库文件、
       调用 GitHub API）全部由宿主代做，SDK 只是发消息。
     - 所有能力都要在扩展清单的 permissions 里声明，宿主按 session
       逐个校验，SDK 侧不设任何"绕过"开关。
     - 会话以 window 对象为键，不用 origin —— blob: iframe 的 origin
       是字符串 "null"，多个插件会互相顶掉（v1 plugin-api 的坑）。
   ================================================================== */
(function (root) {
    'use strict';
    if (root.GD && root.GD.__sdk) return;

    var CHANNEL = (root.parent !== root) ? root.parent : (root.opener || root.parent);
    var ctx = root.__GD_EXT__ || {};           // 宿主注入：extId / sessionId / kind
    var seq = 0;
    var pending = Object.create(null);
    var listeners = Object.create(null);
    var commandHandlers = Object.create(null);
    var readyResolve, readyReject;
    var ready = new Promise(function (res, rej) { readyResolve = res; readyReject = rej; });

    function post(msg) {
        try { CHANNEL.postMessage(msg, '*'); } catch (e) { /* 宿主已关闭 */ }
    }

    /** 发一条请求，等宿主配对回复 */
    function call(cap, params, timeout) {
        return new Promise(function (resolve, reject) {
            var id = ++seq;
            var timer = setTimeout(function () {
                if (pending[id]) { delete pending[id]; reject(new Error('请求超时: ' + cap)); }
            }, timeout || 30000);
            pending[id] = function (ok, data, error) {
                clearTimeout(timer);
                if (ok) resolve(data); else reject(new Error(error || ('能力调用失败: ' + cap)));
            };
            post({
                source: 'gd-ext', type: 'call', requestId: id,
                extId: ctx.extId, sessionId: ctx.sessionId,
                cap: cap, params: params || {}
            });
        });
    }

    root.addEventListener('message', function (e) {
        var d = e.data;
        if (!d || d.source !== 'gd-ext-host') return;
        // 只认宿主窗口发来的消息，其他 iframe / opener 伪造的一律丢弃
        if (CHANNEL && e.source !== CHANNEL) return;

        if (d.type === 'hello-ack') {
            ctx = Object.assign({}, ctx, d.payload || {});
            root.__GD_EXT__ = ctx;
            readyResolve(ctx);
            return;
        }
        if (d.type === 'response') {
            var p = pending[d.requestId];
            if (p) { delete pending[d.requestId]; p(!!d.ok, d.data, d.error); }
            return;
        }
        if (d.type === 'event') {
            var arr = listeners[d.name] || [];
            arr.slice().forEach(function (fn) {
                try { fn(d.payload); } catch (err) { console.warn('[GD] 事件回调异常', d.name, err); }
            });
            return;
        }
        if (d.type === 'command') {
            var fn = commandHandlers[d.commandId];
            var finish = function (ok, data, error) {
                post({
                    source: 'gd-ext', type: 'command-response',
                    requestId: d.requestId, extId: ctx.extId,
                    ok: ok, data: data, error: error
                });
            };
            if (!fn) { finish(false, null, '未注册的命令: ' + d.commandId); return; }
            Promise.resolve().then(function () { return fn(d.args || {}); })
                .then(function (r) { finish(true, r === undefined ? null : r); })
                .catch(function (err) { finish(false, null, String((err && err.message) || err)); });
            return;
        }
    });

    /* ---------------- 高层 API ---------------- */

    var files = {
        list: function (p) { return call('files.list', p); },
        stat: function (path) { return call('files.stat', { path: path }); },
        read: function (path, opts) { return call('files.read', Object.assign({ path: path }, opts || {})); },
        write: function (path, content) { return call('files.write', { path: path, content: content }); },
        remove: function (path) { return call('files.delete', { path: path }); },
        open: function (path) { return call('files.open', { path: path }); },   // 调宿主原生预览
        upload: function (p) { return call('files.upload', p); }
    };

    var net = {
        /** 完整 HTTP：{url, method, headers, body, mode, proxy, timeout} */
        fetch: function (p) { return call('net.fetch', p, (p && p.timeout) ? p.timeout + 10000 : 60000); },
        /** 走宿主令牌的 GitHub API，只允许相对路径如 "/user" */
        github: function (p) { return call('net.github', p); },
        /** 查询/撤销已授权的域名 */
        grants: function () { return call('net.grants', {}); },
        revoke: function (origin) { return call('net.revoke', { origin: origin }); }
    };

    function winOpen(p) { return call('ui.window', p || {}); }
    var windows = {
        open: winOpen,
        close: function () { return call('ui.close', {}); },
        setTitle: function (title) { return call('ui.setTitle', { title: title }); },
        fullscreen: function () { return call('ui.fullscreen', {}); },
        popout: function (p) { return call('ui.popout', p || {}); }
    };

    var sidebar = {
        setTitle: function (title) { return call('ui.sidebarTitle', { title: title }); },
        setBadge: function (n) { return call('ui.sidebarBadge', { badge: n }); },
        show: function () { return call('ui.sidebarShow', {}); },
        hide: function () { return call('ui.sidebarHide', {}); }
    };

    var commands = {
        register: function (id, title, fn) {
            commandHandlers[id] = fn;
            return call('ui.commandRegister', { id: id, title: title });
        },
        unregister: function (id) {
            delete commandHandlers[id];
            return call('ui.commandUnregister', { id: id });
        },
        execute: function (id, args) { return call('ui.commandExecute', { id: id, args: args || {} }); },
        list: function () { return call('ui.commandList', {}); }
    };

    var menus = {
        /** scope: 'file' | 'view'；items: [{command,label,icon,when}] */
        contribute: function (scope, items) {
            return call('ui.menuContribute', { scope: scope, items: items || [] });
        }
    };

    var storage = {
        get: function (key, def) { return call('storage.get', { key: key, def: def }); },
        set: function (key, value) { return call('storage.set', { key: key, value: value }); },
        remove: function (key) { return call('storage.remove', { key: key }); },
        keys: function () { return call('storage.keys', {}); },
        /** 把本扩展的全部键值同步到 Drive 隐藏目录（需 files.write） */
        sync: function () { return call('storage.sync', {}); },
        restore: function () { return call('storage.restore', {}); }
    };

    var events = {
        on: function (name, fn) {
            (listeners[name] || (listeners[name] = [])).push(fn);
            return function () { events.off(name, fn); };
        },
        off: function (name, fn) {
            var a = listeners[name];
            if (!a) return;
            var i = a.indexOf(fn);
            if (i >= 0) a.splice(i, 1);
        },
        once: function (name, fn) {
            var off = events.on(name, function (p) { off(); fn(p); });
            return off;
        }
    };

    var GD = {
        __sdk: true,
        version: 2,
        context: function () { return Object.assign({}, ctx); },
        ready: ready,
        call: call,
        files: files,
        net: net,
        window: windows,
        sidebar: sidebar,
        commands: commands,
        menus: menus,
        storage: storage,
        events: events,
        status: {
            set: function (text, opts) { return call('ui.status', Object.assign({ text: text }, opts || {})); },
            clear: function () { return call('ui.status', { text: '' }); }
        },
        ui: {
            toast: function (message, level) { return call('ui.toast', { message: String(message), level: level || 'info' }); },
            notify: function (p) { return call('ui.notify', p || {}); },
            progress: function (p) { return call('ui.progress', p || {}); },
            navigate: function (view) { return call('ui.navigate', { view: view }); }
        },
        selection: { get: function () { return call('selection.get', {}); } },
        clipboard: {
            read: function () { return call('clipboard.read', {}); },
            write: function (text) { return call('clipboard.write', { text: String(text) }); }
        },
        theme: { get: function () { return call('theme.get', {}); } },
        i18n: {
            t: function (key, fallback) { return call('i18n.t', { key: key, fallback: fallback }); },
            lang: function () { return call('i18n.lang', {}); }
        },
        host: { info: function () { return call('host.info', {}); } }
    };

    root.GD = GD;

    // 握手：宿主回 caps / 上下文 / 版本号。扩展应等 GD.ready 再调用能力。
    post({
        source: 'gd-ext', type: 'hello', requestId: ++seq,
        extId: ctx.extId, sessionId: ctx.sessionId
    });
    setTimeout(function () { readyReject(new Error('宿主未响应握手')); }, 8000);
})(typeof window !== 'undefined' ? window : this);
