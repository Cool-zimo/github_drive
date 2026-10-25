/**
 * Emath 反馈通道 —— 借 GitHub PR 做双向通信
 *
 * 为什么是 PR 而不是 Issue：
 *   用户的令牌只需要 public_repo，就能 fork + 建分支 + 开 PR，
 *   全程不碰我的仓库数据；我这边只读 PR 列表和评论，天然是收件箱。
 *   而且每条反馈自带一个 json 文件，内容是结构化的，不会被当成普通闲聊。
 *
 * 提交链路：fork → 建分支 → 写 json → 开 PR → 本地记住 PR 号
 * 收信链路：客户端拉 comments 看回复；作者端拉 pulls 看内容、发 comment 回信
 *
 * 硬约束：零 emoji，图标一律内联线条 SVG
 */
(function () {
    'use strict';

    var UP = { owner: 'Cool-zimo', repo: 'Emath-feedback' };
    var AUTHOR = 'cool-zimo';
    var PREFIX = 'github_drive_';
    var API = 'https://api.github.com';

    // ==================== 图标 ====================
    var P = {
        inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z"/>',
        send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
        close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
        back: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
        user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
        check: '<polyline points="20 6 9 17 4 12"/>',
        clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
        alert: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
        bug: '<rect x="8" y="6" width="8" height="14" rx="4"/><path d="M8 10H4M20 10h-4M9 3l-1 3M15 3l1 3M6 14h2M16 14h2M6 18h2M16 18h2"/>',
        idea: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V18h8v-3.3A7 7 0 0 0 12 2z"/>',
        chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
        plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
        ext: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'
    };
    function icon(n, cls) {
        return '<svg class="' + (cls || 'ico') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            (P[n] || '') + '</svg>';
    }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function $(id) { return document.getElementById(id); }
    function fmtDate(ts) {
        var d = new Date(ts);
        var p = function (n) { return (n < 10 ? '0' : '') + n; };
        return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    // ==================== 身份与令牌 ====================
    function lsGet(k, d) {
        try { var v = localStorage.getItem(PREFIX + k); return v ? JSON.parse(v) : d; } catch (e) { return d; }
    }
    function lsSet(k, v) { try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch (e) {} }

    function currentUser() {
        try {
            var u = sessionStorage.getItem(PREFIX + 'tab_user');
            if (u) { var o = JSON.parse(u); if (o && o.login) return o; }
        } catch (e) {}
        var accs = lsGet('accounts', []) || [];
        if (accs.length) {
            var cur = lsGet('current_account', null);
            var hit = accs.filter(function (a) { return a.id === cur; })[0] || accs[0];
            if (hit && hit.user && hit.user.login) return hit.user;
        }
        return null;
    }
    function currentToken() {
        var t = '';
        try { t = sessionStorage.getItem(PREFIX + 'tab_token') || ''; } catch (e) {}
        if (t) return t;
        var accs = lsGet('accounts', []) || [];
        var cur = lsGet('current_account', null);
        var hit = accs.filter(function (a) { return a.id === cur; })[0] || accs[0];
        return (hit && hit.token) || '';
    }
    function isAuthor() {
        var u = currentUser();
        return !!u && String(u.login).toLowerCase() === AUTHOR;
    }

    // ==================== GitHub API ====================
    function gh(path, opt) {
        opt = opt || {};
        var headers = { Accept: 'application/vnd.github+json' };
        var tk = currentToken();
        if (tk) headers.Authorization = 'token ' + tk;
        if (opt.body) headers['Content-Type'] = 'application/json';
        return fetch(API + path, {
            method: opt.method || 'GET',
            headers: headers,
            body: opt.body ? JSON.stringify(opt.body) : undefined
        }).then(function (r) {
            if (r.status === 204) return null;
            return r.json().then(function (j) {
                if (!r.ok) {
                    var e = new Error((j && j.message) || ('HTTP ' + r.status));
                    e.status = r.status; e.payload = j;
                    throw e;
                }
                return j;
            });
        });
    }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    // ==================== 本地台账 ====================
    function mineKey() {
        var u = currentUser();
        return 'emath_fb_' + (u ? u.login : 'anon');
    }
    function myFeedbacks() { return lsGet(mineKey(), []) || []; }
    function noteMine(rec) {
        var all = myFeedbacks();
        for (var i = 0; i < all.length; i++) {
            if (all[i].number === rec.number) { all[i] = rec; lsSet(mineKey(), all); return; }
        }
        all.unshift(rec);
        lsSet(mineKey(), all);
    }

    // ==================== 提交反馈 ====================
    var TYPES = [
        { k: 'bug', label: '题目有问题', ico: 'bug', hint: '算错了、答案不对、显示异常' },
        { k: 'idea', label: '功能建议', ico: 'idea', hint: '想要新题型、新玩法' },
        { k: 'complain', label: '投诉', ico: 'alert', hint: '体验很差，想让作者知道' },
        { k: 'other', label: '其它', ico: 'chat', hint: '随便说点什么' }
    ];
    function typeOf(k) {
        return TYPES.filter(function (t) { return t.k === k; })[0] || TYPES[3];
    }

    function ensureFork() {
        var me = currentUser().login;
        // 先看看 fork 在不在
        return gh('/repos/' + me + '/' + UP.repo).then(function (r) {
            return r;
        }).catch(function () {
            // 不存在就 fork，GitHub 是异步建的，得等
            return gh('/repos/' + UP.owner + '/' + UP.repo + '/forks', { method: 'POST' }).then(function () {
                var tries = 0;
                function poll() {
                    tries++;
                    return gh('/repos/' + me + '/' + UP.repo).then(function (r) {
                        return r;
                    }).catch(function (e) {
                        if (tries >= 12) throw e;
                        return sleep(1500).then(poll);
                    });
                }
                return poll();
            });
        });
    }

    function submitFeedback(kind, text) {
        var me = currentUser().login;
        var branch = 'fb-' + Date.now();
        var t = typeOf(kind);
        var now = new Date().toISOString();
        var payload = {
            app: 'Emath',
            type: t.k,
            typeLabel: t.label,
            text: text,
            from: me,
            at: now,
            ua: navigator.userAgent || '',
            lang: navigator.language || ''
        };
        var title = '[' + t.label + '] ' + (text.length > 40 ? text.slice(0, 40) + '…' : text);
        var body = [
            '## ' + t.label,
            '',
            text,
            '',
            '---',
            '- 来自：`' + me + '`',
            '- 时间：' + now,
            '- 语言：' + (navigator.language || '-'),
            '- UA：' + (navigator.userAgent || '-')
        ].join('\n');

        return ensureFork().then(function (fork) {
            var base = (fork && fork.default_branch) || 'main';
            return gh('/repos/' + me + '/' + UP.repo + '/git/ref/heads/' + base).then(function (ref) {
                return gh('/repos/' + me + '/' + UP.repo + '/git/refs', {
                    method: 'POST',
                    body: { ref: 'refs/heads/' + branch, sha: ref.object.sha }
                });
            });
        }).then(function () {
            return gh('/repos/' + me + '/' + UP.repo + '/contents/feedback/' + me + '-' + Date.now() + '.json', {
                method: 'PUT',
                body: {
                    message: 'feedback: ' + t.label,
                    content: btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2)))),
                    branch: branch
                }
            });
        }).then(function () {
            return gh('/repos/' + UP.owner + '/' + UP.repo + '/pulls', {
                method: 'POST',
                body: { title: title, body: body, head: me + ':' + branch, base: 'main' }
            });
        }).then(function (pr) {
            var rec = {
                number: pr.number,
                branch: branch,
                title: title,
                type: t.k,
                text: text,
                at: Date.now(),
                url: pr.html_url
            };
            noteMine(rec);
            return rec;
        });
    }

    // ==================== 我的反馈（含作者回复） ====================
    function loadMyReplies(number) {
        return gh('/repos/' + UP.owner + '/' + UP.repo + '/issues/' + number + '/comments?per_page=100')
            .then(function (list) { return list || []; })
            .catch(function () { return []; });
    }
    function loadMine() {
        var list = myFeedbacks();
        if (!list.length) return Promise.resolve([]);
        return Promise.all(list.map(function (f) {
            return loadMyReplies(f.number).then(function (cs) {
                var copy = JSON.parse(JSON.stringify(f));
                copy.replies = cs.map(function (c) {
                    return {
                        who: c.user ? c.user.login : '?',
                        author: !!(c.user && String(c.user.login).toLowerCase() === AUTHOR),
                        body: c.body || '',
                        at: c.created_at
                    };
                });
                return copy;
            });
        }));
    }

    // ==================== 作者收件箱 ====================
    function loadInbox(state) {
        return gh('/repos/' + UP.owner + '/' + UP.repo + '/pulls?state=' + state + '&per_page=100&sort=updated&direction=desc')
            .then(function (prs) {
                return Promise.all((prs || []).map(function (pr) {
                    var from = pr.head && pr.head.repo && pr.head.repo.owner ? pr.head.repo.owner.login : '?';
                    var item = {
                        number: pr.number,
                        title: pr.title || '',
                        body: pr.body || '',
                        from: from,
                        at: pr.created_at,
                        state: pr.state,
                        merged: !!pr.merged_at,
                        url: pr.html_url,
                        replies: []
                    };
                    return loadMyReplies(pr.number).then(function (cs) {
                        item.replies = cs.map(function (c) {
                            return {
                                who: c.user ? c.user.login : '?',
                                author: !!(c.user && String(c.user.login).toLowerCase() === AUTHOR),
                                body: c.body || '',
                                at: c.created_at
                            };
                        });
                        return item;
                    });
                }));
            });
    }
    function replyTo(number, text) {
        return gh('/repos/' + UP.owner + '/' + UP.repo + '/issues/' + number + '/comments', {
            method: 'POST', body: { body: text }
        });
    }
    function closePR(number) {
        return gh('/repos/' + UP.owner + '/' + UP.repo + '/pulls/' + number, {
            method: 'PATCH', body: { state: 'closed' }
        });
    }

    // ==================== 面板 ====================
    var TAB = 'mine';

    function panel() {
        var el = $('fb-panel');
        if (!el) { buildPanel(); el = $('fb-panel'); }
        return el;
    }

    function buildPanel() {
        var wrap = document.createElement('div');
        wrap.id = 'fb-panel';
        wrap.className = 'fb-panel';
        wrap.hidden = true;
        wrap.innerHTML =
            '<div class="fb-bar">' +
            '  <button type="button" class="icon-btn" id="fb-close" aria-label="关闭">' + icon('close') + '</button>' +
            '  <div class="fb-bar-title">反馈</div>' +
            '  <button type="button" class="btn btn-sm btn-primary" id="fb-new">' + icon('plus') + '写反馈</button>' +
            '</div>' +
            '<div class="fb-tabs" id="fb-tabs"></div>' +
            '<div class="fb-body" id="fb-body"><div class="fb-loading">加载中…</div></div>' +
            // ---- 写反馈 ----
            '<div class="fb-sheet" id="fb-sheet" hidden>' +
            '  <div class="fb-sheet-mask" data-fbclose></div>' +
            '  <div class="fb-sheet-box">' +
            '    <div class="fb-sheet-head"><h3>写一条反馈</h3>' +
            '      <button type="button" class="icon-btn" data-fbclose aria-label="关闭">' + icon('close') + '</button></div>' +
            '    <div class="fb-types" id="fb-types"></div>' +
            '    <textarea id="fb-text" class="fb-textarea" rows="5" placeholder="说清楚一点，作者才帮得上忙"></textarea>' +
            '    <p class="fb-note">' + icon('alert') + '反馈会<b>公开发布在 GitHub</b>，别写密码和私密信息。</p>' +
            '    <div class="fb-sheet-foot">' +
            '      <button type="button" class="btn" data-fbclose>取消</button>' +
            '      <button type="button" class="btn btn-primary" id="fb-send">' + icon('send') + '提交</button>' +
            '    </div>' +
            '    <div class="fb-progress" id="fb-progress" hidden></div>' +
            '  </div>' +
            '</div>';
        document.body.appendChild(wrap);

        $('fb-close').addEventListener('click', close);
        $('fb-new').addEventListener('click', openSheet);
        $('fb-send').addEventListener('click', send);
        Array.prototype.forEach.call(wrap.querySelectorAll('[data-fbclose]'), function (b) {
            b.addEventListener('click', function () { $('fb-sheet').hidden = true; });
        });

        var kinds = $('fb-types');
        kinds.innerHTML = TYPES.map(function (t, i) {
            return '<button type="button" class="fb-type' + (i === 0 ? ' is-on' : '') + '" data-k="' + t.k + '">' +
                icon(t.ico) + '<span class="fb-type-l">' + t.label + '</span>' +
                '<span class="fb-type-h">' + esc(t.hint) + '</span></button>';
        }).join('');
        kinds.addEventListener('click', function (e) {
            var b = e.target.closest ? e.target.closest('.fb-type') : null;
            if (!b) return;
            Array.prototype.forEach.call(kinds.querySelectorAll('.fb-type'), function (x) { x.classList.remove('is-on'); });
            b.classList.add('is-on');
        });
    }

    function renderTabs() {
        var box = $('fb-tabs');
        if (!box) return;
        var tabs = [{ k: 'mine', label: '我的反馈' }];
        if (isAuthor()) tabs.push({ k: 'inbox', label: '收到的反馈' });
        box.innerHTML = tabs.map(function (t) {
            return '<button type="button" class="fb-tab' + (TAB === t.k ? ' is-on' : '') + '" data-k="' + t.k + '">' +
                esc(t.label) + '</button>';
        }).join('');
        if (tabs.length < 2) box.hidden = true; else box.hidden = false;
        Array.prototype.forEach.call(box.querySelectorAll('.fb-tab'), function (b) {
            b.addEventListener('click', function () { TAB = b.getAttribute('data-k'); renderTabs(); refresh(); });
        });
    }

    function open() {
        var p = panel();
        var u = currentUser();
        if (!u) { toastFB('先登录再反馈'); return; }
        if (!isAuthor() && TAB === 'inbox') TAB = 'mine';
        p.hidden = false;
        document.body.classList.add('fb-open');
        renderTabs();
        refresh();
    }
    function close() {
        var p = panel();
        p.hidden = true;
        document.body.classList.remove('fb-open');
    }

    var busy = false;
    function refresh() {
        var body = $('fb-body');
        if (!body) return;
        body.innerHTML = '<div class="fb-loading">加载中…</div>';
        var job = (TAB === 'inbox') ? loadInbox('all') : loadMine();
        job.then(function (list) {
            body.innerHTML = renderList(list);
            bindList(body);
        }).catch(function (e) {
            body.innerHTML = '<div class="fb-empty">' + icon('alert') +
                '<div>' + esc(e.message || '加载失败') + '</div>' +
                '<button type="button" class="btn btn-sm" id="fb-retry">重试</button></div>';
            var r = $('fb-retry');
            if (r) r.addEventListener('click', refresh);
        });
    }

    function statusOf(it) {
        var replied = (it.replies || []).filter(function (r) { return r.author; }).length > 0;
        var closed = it.state === 'closed' && !it.merged;
        // 有回复优先 —— 关闭不代表没回过，混在一起看会误判成"没人理"
        if (replied) return { k: 'replied', label: closed ? '已回复 · 已关闭' : '作者已回复' };
        if (closed) return { k: 'closed', label: '已关闭' };
        return { k: 'wait', label: '等待回复' };
    }

    function card(it, mine) {
        var st = statusOf(it);
        var t = typeOf(it.type);
        var head = mine
            ? '<div class="fb-c-top"><span class="fb-badge fb-b-' + t.k + '">' + icon(t.ico) + esc(t.label) + '</span>' +
              '<span class="fb-st fb-st-' + st.k + '">' + (st.k === 'wait' ? icon('clock') : icon('check')) + esc(st.label) + '</span></div>' +
              '<div class="fb-c-text">' + esc(it.text || it.title) + '</div>'
            : '<div class="fb-c-top"><span class="fb-who">' + icon('user') + esc(it.from) + '</span>' +
              '<span class="fb-st fb-st-' + st.k + '">' + (st.k === 'wait' ? icon('clock') : icon('check')) + esc(st.label) + '</span></div>' +
              '<div class="fb-c-text">' + esc(it.title) + '</div>';

        var replies = (it.replies || []).map(function (r) {
            return '<div class="fb-reply' + (r.author ? ' is-author' : '') + '">' +
                '<div class="fb-r-top">' + icon('chat') + '<b>' + esc(r.who) + '</b>' +
                (r.author ? '<span class="fb-r-tag">作者</span>' : '') +
                '<span class="fb-r-at">' + esc(fmtDate(r.at)) + '</span></div>' +
                '<div class="fb-r-body">' + esc(r.body) + '</div></div>';
        }).join('');

        var foot = '';
        if (!mine) {
            foot = '<div class="fb-c-foot">' +
                '<textarea class="fb-reply-in" rows="2" placeholder="回复 ' + esc(it.from) + '…"></textarea>' +
                '<div class="fb-c-acts">' +
                '<button type="button" class="btn btn-sm btn-primary" data-act="reply" data-n="' + it.number + '">' + icon('send') + '回复</button>' +
                (it.state === 'open' ? '<button type="button" class="btn btn-sm" data-act="close" data-n="' + it.number + '">关闭</button>' : '') +
                '<a class="btn btn-sm fb-ext" href="' + esc(it.url) + '" target="_blank" rel="noopener">' + icon('ext') + 'GitHub</a>' +
                '</div></div>';
        } else {
            foot = '<div class="fb-c-foot"><a class="btn btn-sm fb-ext" href="' + esc(it.url) + '" target="_blank" rel="noopener">' +
                icon('ext') + '在 GitHub 查看</a></div>';
        }

        return '<div class="fb-card" data-n="' + it.number + '">' + head +
            '<div class="fb-c-at">' + esc(fmtDate(it.at)) + ' · #' + it.number + '</div>' +
            (replies ? '<div class="fb-replies">' + replies + '</div>' : '') +
            foot + '</div>';
    }

    function renderList(list) {
        if (!list.length) {
            return '<div class="fb-empty">' + icon('inbox') +
                '<div>' + (TAB === 'inbox' ? '还没有人反馈' : '你还没反馈过') + '</div></div>';
        }
        var mine = (TAB === 'mine');
        return list.map(function (it) { return card(it, mine); }).join('');
    }

    function bindList(body) {
        Array.prototype.forEach.call(body.querySelectorAll('[data-act]'), function (b) {
            b.addEventListener('click', function () {
                if (busy) return;
                var n = b.getAttribute('data-n');
                var act = b.getAttribute('data-act');
                var cardEl = b.closest('.fb-card');
                if (act === 'reply') {
                    var ta = cardEl.querySelector('.fb-reply-in');
                    var txt = (ta.value || '').trim();
                    if (!txt) { toastFB('先写点什么'); return; }
                    busy = true; b.disabled = true;
                    replyTo(n, txt).then(function () {
                        toastFB('已回复'); busy = false; refresh();
                    }).catch(function (e) {
                        busy = false; b.disabled = false; toastFB('回复失败：' + (e.message || ''));
                    });
                } else if (act === 'close') {
                    busy = true; b.disabled = true;
                    closePR(n).then(function () { toastFB('已关闭'); busy = false; refresh(); })
                        .catch(function (e) { busy = false; b.disabled = false; toastFB('失败：' + (e.message || '')); });
                }
            });
        });
    }

    function openSheet() {
        var u = currentUser();
        if (!u) { toastFB('先登录'); return; }
        $('fb-sheet').hidden = false;
        $('fb-text').value = '';
        $('fb-progress').hidden = true;
        var first = $('fb-types').querySelector('.fb-type');
        Array.prototype.forEach.call($('fb-types').querySelectorAll('.fb-type'), function (x) { x.classList.remove('is-on'); });
        if (first) first.classList.add('is-on');
    }

    function send() {
        if (busy) return;
        var txt = ($('fb-text').value || '').trim();
        if (txt.length < 2) { toastFB('多写几个字'); return; }
        var on = $('fb-types').querySelector('.fb-type.is-on');
        var kind = on ? on.getAttribute('data-k') : 'other';
        var btn = $('fb-send');
        var prog = $('fb-progress');
        busy = true; btn.disabled = true;
        prog.hidden = false;
        function step(msg) { prog.textContent = msg; }
        step('准备分支…');
        submitFeedback(kind, txt).then(function (rec) {
            prog.hidden = true;
            busy = false; btn.disabled = false;
            $('fb-sheet').hidden = true;
            TAB = 'mine';
            renderTabs();
            refresh();
            toastFB('已提交 #' + rec.number);
        }).catch(function (e) {
            prog.hidden = true;
            busy = false; btn.disabled = false;
            var s = e.status;
            var msg = (s === 401) ? '令牌无效，重新登录试试'
                : (s === 403) ? '令牌权限不够，需要 public_repo（能 fork 和提交）'
                : (s === 422) ? '已经提交过同样的反馈了'
                : (e.message || '提交失败');
            toastFB(msg);
        });
    }

    var toastTimer = null;
    function toastFB(msg) {
        var t = $('fb-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'fb-toast'; t.className = 'fb-toast'; t.hidden = true;
            document.body.appendChild(t);
        }
        t.textContent = msg; t.hidden = false;
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { t.hidden = true; }, 2400);
    }

    // ==================== 入口按钮 ====================
    function mountEntry() {
        if ($('fb-entry')) return;
        var bar = document.querySelector('#app .top-right');
        if (!bar) return;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'fb-entry';
        btn.className = 'icon-btn';
        btn.title = '反馈';
        btn.setAttribute('aria-label', '反馈');
        btn.innerHTML = icon('inbox');
        btn.addEventListener('click', open);
        bar.insertBefore(btn, bar.firstChild);
    }

    function boot() {
        mountEntry();
        // 作者进来时，若 URL 带 ?author 就直接开收件箱
        var q = new URLSearchParams(location.search);
        if (q.get('author') === '1' && isAuthor()) { TAB = 'inbox'; open(); }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

    window.EmathFeedback = { open: open, close: close, isAuthor: isAuthor, refresh: refresh };
})();
