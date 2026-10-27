/**
 * 云端封禁同步（GdBan）
 * ------------------------------------------------------------------
 * 为什么要把封禁搬到云端、还要写进用户自己的仓库？
 *
 *   纯 localStorage 的封禁有个致命弱点：清一次浏览器数据就解了。
 *   所以这里做"双锚点"：
 *
 *     锚点 A（云端权威）  Cool-zimo/drive-bans 的 bans.json
 *                        —— 作者端写入，workflow 每小时重算剩余时长
 *     锚点 B（本地冗余）  被封用户【每个存储仓库】根目录下的 .gd-ban.json
 *                        —— 客户端自动写入，跟着他的账号走
 *
 *   两个锚点任意之一命中即封禁，且会自动互相补全：
 *     · 他删了自己仓库里的 .gd-ban.json → 下次启动由云端名单重建
 *     · 他清了 localStorage            → 云端 seenAt 把刑期拉回来
 *     · 他改本地代码绕过               → 换设备/换浏览器用官方版仍被拦
 *
 *   ⚠️ 诚实边界：改代码、本地跑源码终究能绕。这里做的是把绕过成本抬到
 *      "比换个号还麻烦"，不是密码学级别的防护。
 *
 *   全过程静默：不弹提示、不打日志、界面上不留任何与同步有关的痕迹。
 *     说出来就等于告诉他"这个文件是开关，删掉试试"。
 *
 * 计时规则：刑期自他【第一次看到封禁页】起算（seenAt），
 *   云端 seenAt 优先于本地，因此清缓存重新开始这一招失效。
 *
 * 解除封禁的收尾（用户最担心的"残留清理失败"）：
 *   workflow 从 bans.json 移除到期条目时，会把该账号写进 cleanup.json。
 *   客户端启动时只要发现 cleanup.json 里有自己，就逐个存储仓库删除
 *   .gd-ban.json；删干净后再提 PR 把自己从 cleanup.json 摘掉。
 *   用"待清理清单"驱动而不是"不在名单里"驱动，是因为后者在
 *   workflow 已删条目、客户端还没跑的情况下会漏一轮。
 */
(function () {
    'use strict';

    var CFG = {
        owner:  'Cool-zimo',
        repo:   'drive-bans',
        file:   'bans.json',
        cleanup: 'cleanup.json',
        marker: '.gd-ban.json',      // 写进用户存储仓库的封禁标记
        stateDir: 'state',           // 客户端上报 seenAt 的 PR 落在这里
        author: 'cool-zimo',
        maxRepos: 12                 // 一次最多处理多少个存储仓库，防 API 爆量
    };

    function api() {
        var a = window.app && window.app.api;
        if (!a) throw new Error('未登录');
        return a;
    }
    function me() {
        try { return ((window.app && window.app.storage && window.app.storage.getUser()) || {}).login || ''; }
        catch (e) { return ''; }
    }
    function isAuthor() { return (me() || '').toLowerCase() === CFG.author; }
    function nowMs() { return Date.now(); }
    function b64(s) { return btoa(unescape(encodeURIComponent(s))); }
    function unb64(s) {
        try { return decodeURIComponent(escape(atob(String(s || '').replace(/\s/g, '')))); }
        catch (e) { return ''; }
    }

    /* ── 读取云端 JSON（走 raw，不耗 API 额度；失败静默降级） ───────── */
    async function rawJson(file) {
        try {
            var url = 'https://raw.githubusercontent.com/' + CFG.owner + '/' + CFG.repo
                    + '/main/' + file + '?t=' + nowMs();
            var r = await fetch(url, { cache: 'no-store' });
            if (!r.ok) return null;
            return await r.json();
        } catch (e) { return null; }
    }

    /* ── 读/写/删 某个仓库的某个文件 ─────────────────────────────────── */
    async function getFile(owner, repo, path) {
        try {
            var got = await api().request('/repos/' + owner + '/' + repo + '/contents/' + path);
            return { sha: got.sha, obj: JSON.parse(unb64(got.content)) };
        } catch (e) { return null; }
    }
    async function putFile(owner, repo, path, obj, msg, sha) {
        var body = { message: msg, content: b64(JSON.stringify(obj, null, 2)) };
        if (sha) body.sha = sha;
        return await api().request('/repos/' + owner + '/' + repo + '/contents/' + path,
                                   { method: 'PUT', body: JSON.stringify(body) });
    }
    async function delFile(owner, repo, path, sha, msg) {
        return await api().request('/repos/' + owner + '/' + repo + '/contents/' + path,
                                   { method: 'DELETE', body: JSON.stringify({ message: msg, sha: sha }) });
    }

    /* ── 当前用户的所有存储仓库 ──────────────────────────────────────── */
    function myRepos() {
        var list = [];
        try {
            var u = me();
            var rs = (window.app && window.app.storage && window.app.storage.getRepos) ? window.app.storage.getRepos() : [];
            for (var i = 0; i < rs.length; i++) {
                var r = rs[i] || {};
                if (!r.owner || !r.repo) continue;
                if (u && String(r.owner).toLowerCase() !== String(u).toLowerCase()) continue;
                list.push({ owner: r.owner, repo: r.repo });
            }
        } catch (e) {}
        return list.slice(0, CFG.maxRepos);
    }

    /* ==================================================================
       一、云端名单
       ================================================================== */
    var Bans = {
        async list() {
            var j = await rawJson(CFG.file);
            return (j && Array.isArray(j.bans)) ? j.bans : [];
        },
        find(bans, login) {
            var k = String(login || '').toLowerCase();
            for (var i = 0; i < bans.length; i++) {
                if (String(bans[i] && bans[i].user || '').toLowerCase() === k) return bans[i];
            }
            return null;
        },
        async cleanupList() {
            var j = await rawJson(CFG.cleanup);
            return (j && Array.isArray(j.pending)) ? j.pending : [];
        }
    };

    /* ==================================================================
       二、锚点 B：把封禁标记写进用户自己的每个存储仓库（静默）
       ================================================================== */
    async function seal(login, hit, end) {
        var repos = myRepos();
        if (!repos.length) return 0;
        var payload = {
            v: 1, user: login, reason: hit.reason || '违反社区规则',
            by: hit.by || CFG.author, days: Number(hit.days) || 3,
            seenAt: Number(hit.seenAt) || 0, until: end,
            updatedAt: new Date().toISOString()
        };
        var n = 0;
        for (var i = 0; i < repos.length; i++) {
            try {
                var cur = await getFile(repos[i].owner, repos[i].repo, CFG.marker);
                if (cur && cur.obj && Number(cur.obj.until) === end) continue;  // 已是最新
                await putFile(repos[i].owner, repos[i].repo, CFG.marker, payload,
                              'chore: sync account state', cur ? cur.sha : null);
                n++;
            } catch (e) { /* 静默：一个仓库写不进不影响别的 */ }
        }
        return n;
    }

    /* ── 彻底清除残留：逐个存储仓库删标记 ────────────────────────────── */
    async function sweep() {
        var repos = myRepos();
        if (!repos.length) return 0;
        var n = 0;
        for (var i = 0; i < repos.length; i++) {
            try {
                var cur = await getFile(repos[i].owner, repos[i].repo, CFG.marker);
                if (!cur) continue;
                await delFile(repos[i].owner, repos[i].repo, CFG.marker, cur.sha,
                              'chore: clear expired account state');
                n++;
            } catch (e) { /* 静默 */ }
        }
        return n;
    }

    /* ── 扫一遍：自己的仓库里还有没有残留标记（只读判断，不写） ──────── */
    async function hasMarker() {
        var repos = myRepos();
        for (var i = 0; i < repos.length; i++) {
            try {
                if (await getFile(repos[i].owner, repos[i].repo, CFG.marker)) return true;
            } catch (e) {}
        }
        return false;
    }

    /* ==================================================================
       三、上报 seenAt：走 PR 落到云端仓库（用户要的"用 pr 传到某个仓库"）
       ================================================================== */
    async function reportSeen(login, seen) {
        try {
            var path = CFG.stateDir + '/' + String(login).toLowerCase() + '.json';
            var payload = { user: login, seenAt: seen, at: new Date().toISOString() };

            // 有写权限就直接提交（作者/协作者），否则 fork + PR
            try {
                var cur = await getFile(CFG.owner, CFG.repo, path);
                await putFile(CFG.owner, CFG.repo, path, payload,
                              'state: ' + login + ' seen ban notice', cur ? cur.sha : null);
                return true;
            } catch (e) { /* 没权限，走 PR */ }

            await api().request('/repos/' + CFG.owner + '/' + CFG.repo + '/forks', { method: 'POST', body: '{}' });
            var meLogin = me();
            var head = 'state-' + String(login).toLowerCase() + '-' + String(seen).slice(-6);
            // 建分支
            try {
                var base = await api().request('/repos/' + CFG.owner + '/' + CFG.repo);
                var sha = (await api().request('/repos/' + CFG.owner + '/' + CFG.repo
                           + '/git/ref/heads/' + (base.default_branch || 'main'))).object.sha;
                await api().request('/repos/' + meLogin + '/' + CFG.repo + '/git/refs',
                    { method: 'POST', body: JSON.stringify({ ref: 'refs/heads/' + head, sha: sha }) });
            } catch (e) { /* 分支可能已存在 */ }

            await putFile(meLogin, CFG.repo, path, payload, 'state: record ban notice time', null);
            await api().request('/repos/' + CFG.owner + '/' + CFG.repo + '/pulls', {
                method: 'POST',
                body: JSON.stringify({ title: 'state: ' + login, head: meLogin + ':' + head,
                                       base: 'main', body: '自动上报封禁发现时刻' })
            });
            return true;
        } catch (e) { return false; }
    }

    /* ── 清理完成后，提 PR 把自己从 cleanup.json 摘掉 ────────────────── */
    async function reportCleaned(login) {
        try {
            var j = await rawJson(CFG.cleanup);
            if (!j || !Array.isArray(j.pending)) return false;
            var k = String(login).toLowerCase();
            var left = j.pending.filter(function (x) { return String(x).toLowerCase() !== k; });
            if (left.length === j.pending.length) return false;
            var cur = await getFile(CFG.owner, CFG.repo, CFG.cleanup);
            if (!cur) return false;
            await putFile(CFG.owner, CFG.repo, CFG.cleanup, { pending: left },
                          'cleanup: ' + login + ' cleared', cur.sha);
            return true;
        } catch (e) { return false; }
    }

    /* ==================================================================
       四、总入口：启动前调用，返回 null=正常，否则返回封禁信息
       ================================================================== */
    async function resolve() {
        var u = me();
        if (!u || isAuthor()) return null;
        var key = u.toLowerCase();
        var LS = 'gd_ban_start_' + key;

        var bans = await Bans.list();
        var hit  = Bans.find(bans, u);

        /* ── 分支 1：不在名单里 → 只要仓库还有残留就清掉 ───────────── */
        if (!hit) {
            try { localStorage.removeItem(LS); } catch (e) {}
            var pending = await Bans.cleanupList();
            var inPending = pending.some(function (x) { return String(x).toLowerCase() === key; });
            if (inPending) {
                await sweep();                    // 静默删
                await reportCleaned(u);           // 静默销账
            } else if (await hasMarker()) {
                await sweep();                    // 名单外却有标记 = 残留，清掉
            }
            return null;
        }

        /* ── 分支 2：在名单里 → 先定 seenAt，再判是否到期 ───────────── */
        var seen = Number(hit.seenAt || 0);
        if (!seen) {
            var st = null;
            try { st = localStorage.getItem(LS); } catch (e) {}
            seen = st ? Number(st) : nowMs();
            try { localStorage.setItem(LS, String(seen)); } catch (e) {}
            reportSeen(u, seen);                  // 静默上报，不 await（不阻塞首屏）
        } else {
            // 云端 seenAt 更权威：覆盖本地，清缓存重开也不重新计时
            try { localStorage.setItem(LS, String(seen)); } catch (e) {}
        }

        var days = Number(hit.days) || 3;
        var end  = Number(hit.expireAt || 0) || (seen + days * 86400000);
        var now  = nowMs();

        if (now >= end) {                          // 刑满：先清残留再放行
            try { localStorage.removeItem(LS); } catch (e) {}
            await sweep();
            await reportCleaned(u);
            return null;
        }

        /* ── 命中且未到期：补全锚点 B，然后返回封禁信息 ─────────────── */
        seal(u, hit, end);                         // 静默补全，不 await
        return { user: u, reason: hit.reason || '违反社区规则', by: hit.by || CFG.author,
                 days: days, end: end, remain: end - now, seenAt: seen };
    }

    window.GdBan = {
        CFG: CFG, resolve: resolve, seal: seal, sweep: sweep,
        hasMarker: hasMarker, reportSeen: reportSeen,
        list: function () { return Bans.list(); },
        cleanupList: function () { return Bans.cleanupList(); }
    };
})();
