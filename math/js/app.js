/**
 * 口算练习
 *
 * 三条硬约束：
 *   1. 零 emoji —— 所有图标都是内联线条 SVG，跟 Drive 同一套风格
 *   2. 要登录 —— 沿用 Drive 的身份（sessionStorage 的 tab_* 键），没登录就只能看登录卡
 *   3. 记录保留 —— 成绩按账号存 localStorage；未交卷的答题进度也存，刷新/关掉都能续
 */
(function () {
    'use strict';

    // ==================== 图标 ====================
    var P = {
        home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
        clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
        share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/>',
        copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
        user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
        list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
        logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
        back: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
        close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
        eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
        eyeOff: '<path d="M17.9 17.9A10.1 10.1 0 0 1 12 20C5 20 1 12 1 12a18.5 18.5 0 0 1 5.1-5.9"/><path d="M9.9 4.2A9.1 9.1 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.2 3.2"/><line x1="1" y1="1" x2="23" y2="23"/>',
        refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>',
        check: '<polyline points="20 6 9 17 4 12"/>',
        trophy: '<path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><polyline points="17 5h3v2a3 3 0 0 1-3 3"/><polyline points="7 5H4v2a3 3 0 0 0 3 3"/>',
        inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z"/>'
    };
    function icon(name) {
        var d = P[name] || '';
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
            'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
    }
    function setIcon(el, name) { if (el) el.innerHTML = icon(name); }

    var $ = function (id) { return document.getElementById(id); };

    // ==================== 身份（沿用 Drive 的存储键）====================
    var PREFIX = 'github_drive_';
    var sess = {
        get: function (k) { try { return sessionStorage.getItem(PREFIX + 'tab_' + k); } catch (e) { return null; } },
        set: function (k, v) { try { sessionStorage.setItem(PREFIX + 'tab_' + k, v); } catch (e) {} },
        del: function (k) { try { sessionStorage.removeItem(PREFIX + 'tab_' + k); } catch (e) {} }
    };
    function lsGet(k, d) {
        try { var v = localStorage.getItem(PREFIX + k); return v ? JSON.parse(v) : d; } catch (e) { return d; }
    }
    function lsSet(k, v) { try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch (e) {} }

    function savedAccounts() { return lsGet('accounts', []) || []; }

    function currentUser() {
        try {
            var u = sess.get('user');
            if (u) { var o = JSON.parse(u); if (o && o.login) return o; }
        } catch (e) {}
        var accs = savedAccounts();
        if (accs.length) {
            var cur = lsGet('current_account', null);
            var hit = accs.filter(function (a) { return a.id === cur; })[0] || accs[0];
            if (hit && hit.user && hit.user.login) return hit.user;
        }
        return null;
    }

    function persistLogin(user, token) {
        sess.set('user', JSON.stringify(user));
        sess.set('token', token || '');
        var accs = savedAccounts();
        var id = user.login;
        var hit = accs.filter(function (a) { return a.id === id; })[0];
        if (hit) { hit.user = user; if (token) hit.token = token; hit.lastUsed = new Date().toISOString(); }
        else accs.push({ id: id, token: token || '', user: user, addedAt: new Date().toISOString(), lastUsed: new Date().toISOString() });
        lsSet('accounts', accs);
        lsSet('current_account', id);
    }

    // ==================== 出题 ====================
    // mulberry32：同一个种子必然产出同一组题，这是分享链接能复现的前提
    function mulberry32(a) {
        return function () {
            a |= 0; a = a + 0x6D2B79F5 | 0;
            var t = Math.imul(a ^ a >>> 15, 1 | a);
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
    }
    function ri(rnd, lo, hi) { return lo + Math.floor(rnd() * (hi - lo + 1)); }

    var TYPE_LABEL = { mix: '混合', add: '两位数加两位数', mul: '两位数乘一位数' };

    function genSheet(seed, count, type) {
        var rnd = mulberry32(seed >>> 0);
        var qs = [];
        for (var i = 0; i < count; i++) {
            var t = type;
            if (type === 'mix') t = (i % 2 === 0) ? 'mul' : 'add';
            if (t === 'mul') {
                var a = ri(rnd, 11, 99), b = ri(rnd, 2, 9);
                qs.push({ t: 'mul', a: a, b: b, r: a * b, text: a + ' × ' + b });
            } else {
                var c = ri(rnd, 11, 99), d = ri(rnd, 11, 99);
                qs.push({ t: 'add', a: c, b: d, r: c + d, text: c + ' + ' + d });
            }
        }
        return qs;
    }

    // ==================== 状态 ====================
    var S = {
        user: null,
        type: 'mix',
        count: 50,
        sheet: null,
        seed: 0,
        answers: [],
        startedAt: 0,
        elapsed: 0,
        done: false,
        timer: null,
        shared: false      // 本次是不是别人分享来的
    };

    function recKey() { return 'math_records_' + (S.user ? S.user.login : 'anon'); }
    function draftKey() { return 'math_draft_' + (S.user ? S.user.login : 'anon'); }

    function getRecords() { return lsGet(recKey(), []) || []; }
    function addRecord(r) {
        var all = getRecords();
        all.unshift(r);
        if (all.length > 200) all = all.slice(0, 200);
        lsSet(recKey(), all);
    }
    function saveDraft() {
        if (!S.sheet || S.done) return;
        lsSet(draftKey(), {
            seed: S.seed, type: S.type, count: S.count,
            answers: S.answers, startedAt: S.startedAt, shared: S.shared
        });
    }
    function loadDraft() { return lsGet(draftKey(), null); }
    function clearDraft() { try { localStorage.removeItem(PREFIX + draftKey()); } catch (e) {} }

    function fmtTime(ms) {
        var s = Math.floor(ms / 1000);
        var m = Math.floor(s / 60);
        return (m < 10 ? '0' : '') + m + ':' + ((s % 60) < 10 ? '0' : '') + (s % 60);
    }
    function fmtDate(ts) {
        var d = new Date(ts);
        var p = function (n) { return (n < 10 ? '0' : '') + n; };
        return (d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    // ==================== 视图切换 ====================
    function show(view) {
        ['home', 'run', 'done', 'records'].forEach(function (v) {
            $('view-' + v).hidden = (v !== view);
        });
        if (view !== 'run') stopTimer();
        window.scrollTo(0, 0);
    }

    // ==================== 登录门 ====================
    function renderGate() {
        $('gate').hidden = false;
        $('app').hidden = true;
        var accs = savedAccounts().filter(function (a) { return a && a.user && a.user.login; });
        var box = $('gate-users');
        if (accs.length) {
            box.hidden = false;
            $('gate-users-list').innerHTML = accs.map(function (a) {
                return '<button type="button" class="gate-user-btn" data-login="' + esc(a.user.login) + '">' +
                    icon('user') + '<span><span class="gub-login">' + esc(a.user.login) + '</span>' +
                    '<span class="gub-sub">沿用此账号</span></span></button>';
            }).join('');
            Array.prototype.forEach.call(box.querySelectorAll('.gate-user-btn'), function (b) {
                b.addEventListener('click', function () {
                    var login = b.getAttribute('data-login');
                    var acc = accs.filter(function (a) { return a.user.login === login; })[0];
                    persistLogin(acc.user, acc.token || '');
                    enter(acc.user);
                });
            });
        } else {
            box.hidden = true;
        }
        setIcon($('gate-eye'), 'eye');
    }

    function checkToken(token) {
        return fetch('https://api.github.com/user', {
            headers: { Authorization: 'token ' + token, Accept: 'application/vnd.github+json' }
        }).then(function (r) {
            if (!r.ok) throw new Error(r.status === 401 ? '令牌无效或已过期' : '验证失败（' + r.status + '）');
            return r.json();
        });
    }

    function enter(user) {
        S.user = user;
        $('gate').hidden = true;
        $('app').hidden = false;
        $('who-name').textContent = user.login;
        setIcon($('btn-records'), 'list');
        setIcon($('btn-logout'), 'logout');
        setIcon($('btn-back'), 'back');
        Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (b) { setIcon(b, 'close'); });
        renderHome();
        // 分享链接进来的，直接开那一组
        var q = new URLSearchParams(location.search);
        if (q.get('s')) {
            startSheet(parseInt(q.get('s'), 10) || 0,
                parseInt(q.get('n'), 10) || 50,
                q.get('t') || 'mix', true);
        }
    }

    function logout() {
        sess.del('user'); sess.del('token');
        clearDraft();
        location.reload();
    }

    // ==================== 首页 ====================
    function renderHome() {
        show('home');
        var d = loadDraft();
        $('resume-box').hidden = !d;
        renderRecent();
    }

    function renderRecent() {
        var all = getRecords().slice(0, 5);
        $('recent-list').innerHTML = all.length
            ? all.map(recItem).join('')
            : emptyBox('还没有成绩记录');
    }

    function recItem(r) {
        var rate = Math.round(r.correct / r.total * 100);
        return '<div class="rec-item">' +
            '<div class="rec-main">' +
            '<div class="rec-title">' + r.correct + ' / ' + r.total + ' 题</div>' +
            '<div class="rec-sub">' + fmtDate(r.at) + ' · ' + TYPE_LABEL[r.type] + ' · ' + fmtTime(r.ms) + '</div>' +
            '</div>' +
            '<span class="rec-badge">' + rate + '%</span>' +
            '</div>';
    }

    function emptyBox(text) {
        return '<div class="empty">' + icon('inbox') + esc(text) + '</div>';
    }
    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // ==================== 练习 ====================
    function startSheet(seed, count, type, shared) {
        S.seed = seed >>> 0;
        S.count = count;
        S.type = type;
        S.shared = !!shared;
        S.sheet = genSheet(S.seed, count, type);
        S.answers = new Array(count).fill('');
        S.startedAt = Date.now();
        S.elapsed = 0;
        S.done = false;
        renderSheet();
        show('run');
        startTimer();
    }

    function renderSheet() {
        var html = S.sheet.map(function (q, i) {
            return '<div class="q" data-i="' + i + '">' +
                '<span class="q-idx">' + (i + 1) + '</span>' +
                '<span class="q-expr">' + q.text + ' =</span>' +
                '<input class="q-in" type="text" inputmode="numeric" autocomplete="off" ' +
                'aria-label="第' + (i + 1) + '题" value="' + esc(S.answers[i]) + '" data-i="' + i + '">' +
                '<span class="q-ans" hidden></span>' +
                '</div>';
        }).join('');
        $('sheet').innerHTML = html;

        Array.prototype.forEach.call($('sheet').querySelectorAll('.q-in'), function (inp) {
            inp.addEventListener('input', function () {
                var i = parseInt(inp.getAttribute('data-i'), 10);
                S.answers[i] = inp.value.replace(/[^\d-]/g, '');
                if (inp.value !== S.answers[i]) inp.value = S.answers[i];
                $('run-progress').textContent = answered() + ' / ' + S.count;
                saveDraft();
            });
            // 回车跳下一题，桌面端连续输入快很多
            inp.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    var i = parseInt(inp.getAttribute('data-i'), 10);
                    var next = $('sheet').querySelector('.q-in[data-i="' + (i + 1) + '"]');
                    if (next) next.focus();
                    else submit();
                }
            });
        });
        updateProgress();
    }

    function answered() {
        return S.answers.filter(function (a) { return a !== '' && a !== null && a !== undefined; }).length;
    }
    function updateProgress() {
        $('run-progress').textContent = answered() + ' / ' + S.count;
        $('run-time').textContent = fmtTime(S.elapsed);
    }

    function startTimer() {
        stopTimer();
        S.timer = setInterval(function () {
            S.elapsed = Date.now() - S.startedAt;
            $('run-time').textContent = fmtTime(S.elapsed);
        }, 500);
    }
    function stopTimer() { if (S.timer) { clearInterval(S.timer); S.timer = null; } }

    function submit() {
        if (S.done) return;
        if (answered() === 0) { toast('先做几道题吧'); return; }
        S.elapsed = Date.now() - S.startedAt;
        S.done = true;
        stopTimer();
        clearDraft();

        var correct = 0, wrong = [];
        S.sheet.forEach(function (q, i) {
            var v = S.answers[i];
            var ok = (v !== '' && parseInt(v, 10) === q.r);
            if (ok) correct++;
            else wrong.push({ q: q, v: v });
            var box = $('sheet').querySelector('.q[data-i="' + i + '"]');
            if (box) {
                box.classList.add(ok ? 'is-ok' : 'is-bad');
                if (!ok) {
                    var t = box.querySelector('.q-ans');
                    t.hidden = false;
                    t.textContent = q.r;
                }
                var inp = box.querySelector('.q-in');
                inp.disabled = true;
            }
        });

        addRecord({
            at: Date.now(), type: S.type, total: S.count,
            correct: correct, ms: S.elapsed, seed: S.seed, shared: S.shared
        });

        renderResult(correct, wrong);
        show('done');
    }

    // ==================== 结果 ====================
    function renderResult(correct, wrong) {
        $('score-val').textContent = correct;
        $('score-total').textContent = S.count;
        var pct = S.count ? correct / S.count : 0;
        var C = 2 * Math.PI * 52;
        var arc = $('score-arc');
        arc.style.strokeDasharray = C;
        arc.style.strokeDashoffset = C * (1 - pct);
        arc.style.stroke = pct >= 0.9 ? 'var(--success-color)' : (pct >= 0.6 ? 'var(--warning-color)' : 'var(--danger-color)');
        $('res-time').textContent = fmtTime(S.elapsed);
        $('res-rate').textContent = Math.round(pct * 100) + '%';
        $('res-type').textContent = TYPE_LABEL[S.type];

        var card = $('wrong-card');
        if (wrong.length) {
            card.hidden = false;
            $('wrong-list').innerHTML = wrong.map(function (w) {
                return '<div class="wrong-item">' +
                    '<span class="wi-l">' + w.q.text + ' =</span>' +
                    '<span class="wi-r">' + (w.v === '' ? '空' : esc(w.v)) + ' → <b>' + w.q.r + '</b></span>' +
                    '</div>';
            }).join('');
        } else {
            card.hidden = true;
        }
    }

    // ==================== 分享 ====================
    function shareUrl() {
        var base = location.href.split('?')[0].split('#')[0];
        return base + '?s=' + S.seed + '&n=' + S.count + '&t=' + S.type;
    }
    function openShare() {
        $('share-url').value = shareUrl();
        $('share-note').hidden = true;
        $('share-modal').hidden = false;
        var inp = $('share-url');
        inp.focus();
        try { inp.select(); } catch (e) {}
    }
    function copyShare() {
        var url = $('share-url').value;
        var ok = false;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(function () { copied(); }, function () { fallback(); });
            return;
        }
        fallback();
        function fallback() {
            var inp = $('share-url');
            inp.removeAttribute('readonly');
            inp.select();
            try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
            inp.setAttribute('readonly', '');
            if (ok) copied(); else { $('share-note').hidden = false; $('share-note').textContent = '复制失败，请手动全选复制'; }
        }
        function copied() {
            $('share-note').hidden = false;
            $('share-note').textContent = '已复制到剪贴板';
            toast('链接已复制');
        }
    }

    var toastTimer = null;
    function toast(msg) {
        var t = $('toast');
        t.textContent = msg;
        t.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { t.hidden = true; }, 1800);
    }

    // ==================== 记录页 ====================
    function renderRecords() {
        var all = getRecords();
        $('all-list').innerHTML = all.length ? all.map(recItem).join('') : emptyBox('还没有成绩记录');
        show('records');
    }

    // ==================== 启动 ====================
    function boot() {
        // 分段按钮
        bindSeg('seg-type', 'data-type', function (v) { S.type = v; });
        bindSeg('seg-count', 'data-count', function (v) { S.count = parseInt(v, 10); });

        $('btn-start').addEventListener('click', function () {
            startSheet((Math.random() * 0xffffffff) >>> 0, S.count, S.type, false);
        });
        $('btn-submit').addEventListener('click', submit);
        $('btn-submit2').addEventListener('click', submit);
        $('btn-back').addEventListener('click', function () {
            if (S.done) { renderHome(); } else {
                if (confirm('离开会保存当前进度，确定返回？')) renderHome();
            }
        });
        $('btn-again').addEventListener('click', function () {
            startSheet((Math.random() * 0xffffffff) >>> 0, S.count, S.type, false);
        });
        $('btn-review').addEventListener('click', function () { show('done'); $('wrong-card').scrollIntoView({ behavior: 'smooth' }); });
        $('btn-share').addEventListener('click', openShare);
        $('btn-share2').addEventListener('click', openShare);
        $('btn-copy').addEventListener('click', copyShare);
        $('btn-records').addEventListener('click', renderRecords);
        $('btn-all-records').addEventListener('click', renderRecords);
        $('btn-clear-records').addEventListener('click', function () {
            if (!confirm('清空全部成绩记录？此操作不可撤销。')) return;
            lsSet(recKey(), []);
            renderRecords();
            toast('记录已清空');
        });
        $('btn-logout').addEventListener('click', logout);
        $('btn-resume').addEventListener('click', function () {
            var d = loadDraft();
            if (!d) return;
            S.seed = d.seed; S.type = d.type; S.count = d.count; S.shared = !!d.shared;
            S.sheet = genSheet(S.seed, S.count, S.type);
            S.answers = d.answers || new Array(S.count).fill('');
            S.startedAt = d.startedAt || Date.now();
            S.elapsed = Date.now() - S.startedAt;
            S.done = false;
            renderSheet();
            show('run');
            startTimer();
        });
        $('btn-discard').addEventListener('click', function () {
            clearDraft();
            $('resume-box').hidden = true;
            toast('已放弃那组练习');
        });

        Array.prototype.forEach.call(document.querySelectorAll('#share-modal [data-close]'), function (b) {
            b.addEventListener('click', function () { $('share-modal').hidden = true; });
        });
        $('share-modal').addEventListener('click', function (e) {
            if (e.target.hasAttribute && e.target.hasAttribute('data-close')) $('share-modal').hidden = true;
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') $('share-modal').hidden = true;
        });

        $('gate-enter').addEventListener('click', function () {
            var token = $('gate-token').value.trim();
            var err = $('gate-err');
            if (!token) { err.hidden = false; err.textContent = '请填写令牌'; return; }
            err.hidden = true;
            var btn = $('gate-enter');
            btn.disabled = true; btn.textContent = '验证中…';
            checkToken(token).then(function (u) {
                persistLogin(u, token);
                enter(u);
            }).catch(function (e) {
                btn.disabled = false; btn.textContent = '登录并进入';
                err.hidden = false; err.textContent = e.message || '登录失败';
            });
        });
        $('gate-token').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') $('gate-enter').click();
        });
        $('gate-eye').addEventListener('click', function () {
            var i = $('gate-token'), b = $('gate-eye');
            var show = i.type === 'password';
            i.type = show ? 'text' : 'password';
            setIcon(b, show ? 'eyeOff' : 'eye');
        });

        // 身份：URL 上的 with_token 优先（换号/直链），其次是本机已登录
        var raw = (location.search || '') + ((location.hash || '').indexOf('with_token=') >= 0 ? '&' + location.hash.replace(/^#/, '') : '');
        var urlParams = new URLSearchParams(raw);
        var tk = urlParams.get('with_token');
        if (tk) {
            checkToken(tk).then(function (u) {
                persistLogin(u, tk);
                // 令牌用掉就从地址栏抹掉 —— 否则会留在浏览器历史记录里
                urlParams.delete('with_token');
                var rest = urlParams.toString();
                var clean = location.pathname + (rest ? '?' + rest : '');
                try { history.replaceState(null, '', clean); } catch (e) {}
                enter(u);
            }).catch(function () { afterAuth(); });
        } else {
            afterAuth();
        }

        function afterAuth() {
            var u = currentUser();
            if (u) enter(u); else renderGate();
        }
    }

    function bindSeg(id, attr, cb) {
        var box = $(id);
        box.addEventListener('click', function (e) {
            var b = e.target.closest('[' + attr + ']');
            if (!b || !box.contains(b)) return;
            Array.prototype.forEach.call(box.querySelectorAll('[' + attr + ']'), function (x) {
                var on = (x === b);
                x.classList.toggle('is-on', on);
                x.setAttribute('aria-checked', on ? 'true' : 'false');
            });
            cb(b.getAttribute(attr));
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
