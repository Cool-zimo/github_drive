/**
 * 应用接入中心（AppHub）
 *
 * 作用：把同一个人（cool-zimo.github.io）下的其它应用挂进 Drive 的侧边栏，
 *      并在跳转时把当前令牌带过去，实现"登录 Drive 就等于登录了它们"。
 *
 * ★ 为什么必须同源才有用：
 *   token 共享依赖 localStorage，而 localStorage 按 origin 隔离。
 *   这些应用都部署在 cool-zimo.github.io 下，因此天然共享。
 *   换成别的域名部署，共享就失效 —— 这是浏览器安全模型，绕不过去。
 *
 * ★ 为什么不把 token 拼进 URL（默认）：
 *   地址栏内容会进浏览历史、会被"复制网址"一起带走、可能被屏幕共享拍到。
 *   所以默认走 localStorage；只有目标应用读不到时，才由用户自行打开
 *   「带令牌跳转」这个开关。
 *
 * ★ 为什么每个应用都默认关闭：
 *   入口是侧边栏占位，开多了会把导航挤长；而且各应用是否真的部署
 *   在那个路径下我们无法验证，默认全开只会给出一堆 404 入口。
 */
(function (global) {
    'use strict';

    var LS_ON = 'gd_apphub_';        // 开关：gd_apphub_<id> = '1'
    var LS_URLTOK = 'gd_apphub_urltoken';  // 是否允许把 token 放进 URL

    /**
     * 应用注册表
     * seg  = Pages 路径第一段（cool-zimo.github.io/<seg>/）
     * icon = icons.js 里的图标名（源头就是 SVG，不写 emoji，避免闪烁）
     * keys = 目标应用可能读取的 localStorage 键，按顺序都写一份
     */
    var APPS = [
        { id: 'al', seg: 'al', name: '通学万义', icon: 'book',
          desc: '学习资料检索', keys: ['al.token', 'al_token'] },
        { id: 'cangshu', seg: 'cangshu', name: '仓鼠', icon: 'hamster',
          desc: 'GitHub 仓库管理面板', keys: ['cangshu.token', 'cangshu_token'] },
        { id: 'week', seg: 'week-of-week', name: '周周记录', icon: 'clock',
          desc: '周计划与记录', keys: ['week-of-week.token', 'week.token'] },
        { id: 'facehub', seg: 'FaceHub', name: 'FaceHub', icon: 'users',
          desc: '人脸/图片库', keys: ['FaceHub.token', 'facehub.token'] },
        { id: 'httpto', seg: 'HTTPto', name: 'HTTPto', icon: 'globe',
          desc: 'HTTP 调试与转发', keys: ['HTTPto.token', 'httpto.token'] },
        { id: 'coverfit', seg: 'coverfit', name: 'coverfit', icon: 'image',
          desc: '封面图适配', keys: ['coverfit.token', 'coverfit_token'] }
    ];

    function lsGet(k) { try { return global.localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { global.localStorage.setItem(k, v); } catch (e) {} }

    /** 当前项目根（…/github_drive），用于拼兄弟应用地址 */
    function rootPath() {
        var p = global.location.pathname || '/';
        var m = p.match(/^(.*\/)[^/]*$/);
        return (m ? m[1] : '/').replace(/\/$/, '');
    }

    /** 同 origin 下某应用的地址 */
    function appUrl(a, withToken) {
        var base = global.location.origin + '/' + a.seg + '/';
        if (withToken) {
            var t = AppHub.currentToken();
            if (t) base += '?with_token=' + encodeURIComponent(t);
        }
        return base;
    }

    /** 图标：源头给 SVG，拿不到返回空串（空白好过闪 emoji） */
    function ico(name, size) {
        try {
            if (typeof Icons !== 'undefined' && Icons.get) {
                return Icons.get(name, { size: size || 18, style: 'vertical-align:-3px;' });
            }
        } catch (e) {}
        return '';
    }

    var AppHub = {
        APPS: APPS,

        /** 某个应用是否开启 */
        isOn: function (id) { return lsGet(LS_ON + id) === '1'; },

        /** 切换开关 */
        toggle: function (id) {
            var next = !this.isOn(id);
            lsSet(LS_ON + id, next ? '1' : '0');
            this.renderSidebar();
            return next;
        },

        enabled: function () { return APPS.filter(function (a) { return AppHub.isOn(a.id); }); },

        /** 是否允许把 token 拼进 URL（默认否） */
        urlToken: function () { return lsGet(LS_URLTOK) === '1'; },
        toggleUrlToken: function () {
            var next = !this.urlToken();
            lsSet(LS_URLTOK, next ? '1' : '0');
            return next;
        },

        /**
         * 取当前令牌
         * 优先 Drive 自己的存储，其次 Bridge 能找到的（仓鼠那边同步过来的）
         */
        currentToken: function () {
            var t = null;
            try {
                if (typeof Storage !== 'undefined') {
                    var st = new Storage();
                    t = st.getToken && st.getToken();
                }
            } catch (e) {}
            if (!t) t = lsGet('github_drive_token');
            if (!t && global.Bridge && Bridge.findToken) {
                try { t = Bridge.findToken(); } catch (e) {}
            }
            return (t && /^(ghp_|gho_|github_pat_)/.test(t)) ? t : null;
        },

        /**
         * 把令牌写给目标应用
         *
         * ★ 为什么写多个键：
         *   各应用是自己独立开发的，存令牌用的键名各不相同，我们无法保证
         *   猜得准。写多个候选键是"广撒网"：命中一个对方便能免登录，
         *   一个都没命中也不影响 —— 只是过去后要再登一次，不会出错。
         */
        shareToken: function (a) {
            var t = this.currentToken();
            if (!t) return false;
            (a.keys || []).forEach(function (k) { lsSet(k, t); });
            lsSet('gd_shared_token', t);
            return true;
        },

        /** 打开某应用（先共享令牌再跳） */
        open: function (id) {
            var a = APPS.filter(function (x) { return x.id === id; })[0];
            if (!a) return;
            this.shareToken(a);
            global.open(appUrl(a, this.urlToken()), '_blank', 'noopener');
        },

        /**
         * 渲染侧边栏「我的应用」
         *
         * ★ 为什么用 JS 插入而不是写死在 HTML 里：
         *   开哪些应用是运行时状态，写死就要在 HTML 里塞 6 个 hidden 项，
         *   而且以后加应用还得改两处。插入节点的方式只维护注册表一处。
         */
        renderSidebar: function () {
            var host = document.getElementById('gd-apphub-nav');
            var list = this.enabled();
            if (!host) return;
            if (!list.length) { host.style.display = 'none'; return; }
            host.style.display = '';
            host.innerHTML =
                '<div class="nav-section-title"><span>我的应用</span></div>' +
                list.map(function (a) {
                    return '<a href="#" class="nav-item" data-apphub="' + a.id + '">' +
                           '<span class="nav-icon">' + ico(a.icon, 20) + '</span>' +
                           '<span>' + a.name + '</span></a>';
                }).join('');
            host.querySelectorAll('[data-apphub]').forEach(function (el) {
                el.addEventListener('click', function (e) {
                    e.preventDefault();
                    AppHub.open(el.getAttribute('data-apphub'));
                });
            });
        },

        /**
         * 「带令牌跳转」开关
         *
         * ★ 为什么默认关、且要显式说明风险：
         *   把 token 放进 URL 是最省事的共享方式（目标应用不用配合改存储键），
         *   但地址栏会进浏览历史、会被复制网址一起带走、会被屏幕共享拍到。
         *   默认只写 localStorage；确实读不到时再由用户自己打开这一项。
         */
        urlTokenRowHTML: function () {
            var on = this.urlToken();
            return '<div onclick="AppHub.toggleUrlToken();ui._renderSettingsView&&ui._renderSettingsView();" '
                + 'style="display:flex;align-items:center;gap:12px;padding:12px;border-radius:8px;cursor:pointer;margin-bottom:6px;" '
                + 'onmouseover="this.style.background=\'var(--bg-hover, #f3f4f6)\'" '
                + 'onmouseout="this.style.background=\'transparent\'">'
                + '<span style="width:22px;display:inline-flex;">' + ico('link', 18) + '</span>'
                + '<div style="flex:1;"><div style="font-weight:600;font-size:14px;color:var(--text-primary);">'
                + '带令牌跳转 <span style="font-weight:400;font-size:13px;color:#6b7280;">'
                + (on ? '开' : '关') + '</span></div>'
                + '<div style="font-size:12px;color:var(--text-secondary);">'
                + '把 token 拼进网址，目标应用读不到本地存储时才需要开 · token 会短暂停留在地址栏</div></div>'
                + '<span style="font-size:12px;color:' + (on ? '#16a34a' : '#9ca3af') + ';">'
                + (on ? '已开启' : '未开启') + '</span></div>';
        },

        /** 设置面板里的开关列表 HTML */
        settingsHTML: function () {
            return APPS.map(function (a) {
                var on = AppHub.isOn(a.id);
                return '<div onclick="AppHub.toggle(\'' + a.id + '\');ui._renderSettingsView&&ui._renderSettingsView();" '
                    + 'style="display:flex;align-items:center;gap:12px;padding:12px;border-radius:8px;cursor:pointer;margin-bottom:6px;" '
                    + 'onmouseover="this.style.background=\'var(--bg-hover, #f3f4f6)\'" '
                    + 'onmouseout="this.style.background=\'transparent\'">'
                    + '<span style="width:22px;display:inline-flex;">' + ico(a.icon, 18) + '</span>'
                    + '<div style="flex:1;"><div style="font-weight:600;font-size:14px;color:var(--text-primary);">'
                    + a.name + ' <span style="font-weight:400;font-size:13px;color:#6b7280;">'
                    + (on ? '开' : '关') + '</span></div>'
                    + '<div style="font-size:12px;color:var(--text-secondary);">' + a.desc + '</div></div>'
                    + '<span style="font-size:12px;color:' + (on ? '#16a34a' : '#9ca3af') + ';">'
                    + (on ? '已接入' : '未接入') + '</span></div>';
            }).join('');
        }
    };

    global.AppHub = AppHub;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { AppHub.renderSidebar(); });
    } else {
        AppHub.renderSidebar();
    }
})(window);
