/**
 * 千览 · 主逻辑
 *
 * 职责：列出 Drive 里的文件 → 点开 → 拉取内容 → 交给渲染层 →
 *       记住读到哪 → 下次打开自动回到那个位置。
 *
 * ★ 为什么不直接复用 Drive 的 file-manager.js：
 *
 *   它依赖 Storage / UI / I18n 一整套 Drive 全局对象，而且那些对象
 *   在构造时就会写 localStorage、注册事件。千览是独立页面，为了用它
 *   而把整套 Drive 初始化一遍，代价远高于重写那 40 行取分片的代码。
 *   这里只保留真正需要的：按 sha 取 blob、并发合并。
 */
(function () {
    'use strict';

    const GH = 'https://api.github.com';

    // ==================== 极简 GitHub 客户端 ====================

    class Api {
        constructor(token) { this.token = token; }

        async _get(path, raw) {
            const headers = {
                'Authorization': 'token ' + this.token,
                'Accept': raw ? 'application/vnd.github.v3.raw' : 'application/vnd.github.v3+json',
                'X-GitHub-Api-Version': '2022-11-28',
            };
            let lastErr;
            // 429/5xx 重试。GitHub 偶发 502，不重试会让用户以为文件坏了
            for (let i = 0; i <= 2; i++) {
                try {
                    const r = await fetch(GH + path, { headers });
                    if (r.ok) return raw ? r.arrayBuffer() : r.json();
                    const txt = await r.text().catch(() => '');
                    const err = new Error('HTTP ' + r.status + ' ' + txt.slice(0, 120));
                    err.status = r.status;
                    throw err;
                } catch (e) {
                    lastErr = e;
                    const transient = !e.status || e.status === 429 ||
                        e.status === 500 || e.status === 502 || e.status === 503;
                    if (!transient || i === 2) throw e;
                    await new Promise(r => setTimeout(r, 800 * Math.pow(2, i)));
                }
            }
            throw lastErr;
        }

        async getMe() { return this._get('/user'); }
        async validateToken() { await this.getMe(); return true; }

        /**
         * 按 sha 取原始字节
         *
         * ★ 用 git/blobs 而不是 contents：contents 接口对 >1MB 的文件
         *   会返回空 content 逼你再走一次 blob 接口，等于白跑一趟。
         *   git/blobs 一步到位，且不受仓库默认分支影响。
         */
        async getBlobBytes(owner, repo, sha) {
            const b = await this._get(`/repos/${owner}/${repo}/git/blobs/${sha}`);
            const content = b && b.content;
            if (!content) throw new Error('blob 内容为空: ' + sha);
            if (b.encoding === 'base64') {
                // 大文件不能一次性 atob 后逐字符 charCodeAt —— 几十 MB 时
                // 会卡住主线程好几秒。分块处理，每块 64KB。
                const bin = atob(content);
                const out = new Uint8Array(bin.length);
                const CH = 65536;
                for (let i = 0; i < bin.length; i += CH) {
                    const end = Math.min(i + CH, bin.length);
                    for (let j = i; j < end; j++) out[j] = bin.charCodeAt(j);
                }
                return out;
            }
            return new TextEncoder().encode(content);
        }

        /**
         * 通用写请求（PUT / POST / DELETE）
         *
         * ★ 单独写一份而不是复用 _get：_get 带 429/5xx 重试，而写操作
         *   重试有副作用——第一次其实已经成功了只是响应丢了，再发一次
         *   会变成重复提交。所以写请求只发一次，让调用方决定怎么办。
         *
         * ★ 409 要单独抛出来：config.json 是多人争抢的单文件，
         *   sha 冲突意味着"我读完之后有人改过"，必须重读再改，
         *   硬覆盖会把别人的改动吞掉。
         */
        async _send(method, path, body) {
            const headers = {
                'Authorization': 'token ' + this.token,
                'Accept': 'application/vnd.github.v3+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'Content-Type': 'application/json',
            };
            const r = await fetch(GH + path, {
                method,
                headers,
                body: body ? JSON.stringify(body) : undefined,
            });
            const txt = await r.text().catch(() => '');
            let data = null;
            try { data = txt ? JSON.parse(txt) : null; } catch { data = null; }
            if (!r.ok) {
                const e = new Error('HTTP ' + r.status + ' ' + txt.slice(0, 160));
                e.status = r.status;
                throw e;
            }
            return data;
        }

        /** 读 Drive 的 config.json，连 sha 一起返回（写回要用） */
        async getConfig() {
            const owner = app.login;
            if (!owner) throw new Error('还没拿到账号名，稍等一下再试');
            const d = await this._send('GET',
                `/repos/${owner}/github-drive-config/contents/config.json`);
            return { sha: d.sha, cfg: JSON.parse(b64Decode(d.content)) };
        }

        /** 写回 config.json。sha 不对会被 GitHub 拒（409），由调用方重读重来 */
        async putConfig(cfg, sha, msg) {
            const owner = app.login;
            return this._send('PUT',
                `/repos/${owner}/github-drive-config/contents/config.json`,
                { message: msg, content: b64Encode(JSON.stringify(cfg)), sha, branch: 'main' });
        }
    }

    // ---------- base64（UTF-8 安全） ----------

    /**
     * ★ 不能直接 btoa(中文)：btoa 只吃 Latin-1，中文会抛异常。
     *   也不能 unescape(encodeURIComponent()) 那套老写法——它已经被
     *   标准废弃。走 TextEncoder + 分块 String.fromCharCode 最稳。
     */
    function b64Encode(str) {
        const bytes = new TextEncoder().encode(str);
        let bin = '';
        const CH = 32768;   // 一次 apply 太多参数会爆栈，分片拼接
        for (let i = 0; i < bytes.length; i += CH) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        }
        return btoa(bin);
    }

    function b64Decode(b64) {
        const bin = atob(b64.replace(/\s/g, ''));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder().decode(bytes);
    }

    /**
     * 拉取整个文件（多分片并发合并）
     *
     * ★ 并发而非串行：一个 10MB 文件切成 10 片，串行要等 10 个 RTT，
     *   并发 6 路只要 2 轮。这是预览体验里最影响"点了多久才出来"的一环。
     *
     * ★ 但并发数不能太高：GitHub 对单 token 有速率限制，并发 20 路
     *   很容易触发 403 secondary rate limit，反而更慢。
     */
    async function fetchFile(api, fileInfo, onProgress) {
        const chunks = fileInfo.chunks || [];
        if (!chunks.length) throw new Error('分片信息缺失');

        const CONC = 6;
        const parts = new Array(chunks.length);
        let done = 0;
        let idx = 0;

        async function worker() {
            while (idx < chunks.length) {
                const i = idx++;
                const c = chunks[i];
                parts[i] = await api.getBlobBytes(c.owner, c.repo, c.sha);
                done++;
                if (onProgress) onProgress(done, chunks.length);
            }
        }
        await Promise.all(Array.from({ length: Math.min(CONC, chunks.length) }, worker));

        const total = parts.reduce((s, p) => s + (p ? p.length : 0), 0);
        if (total === 0) throw new Error('文件内容为空');
        const merged = new Uint8Array(total);
        let off = 0;
        for (const p of parts) { merged.set(p, off); off += p.length; }
        return new Blob([merged], { type: TPRender.mimeOf(fileInfo.name) });
    }

    // ==================== 图标（黑白线性，与 Drive 设置页同一套风格）====================

    const IC = {
        folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
        file: '<path d="M6 2h7l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M13 2v5h5"/>',
        image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m3 18 5-5 4 4 3-3 6 6"/>',
        text: '<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/>',
        pdf: '<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v4h4"/><path d="M9 13h6M9 17h4"/>',
        doc: '<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v4h4"/><path d="M9 12h6M9 16h6"/>',
        sheet: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>',
        media: '<circle cx="12" cy="12" r="9"/><path d="M10 9l5 3-5 3z"/>',
        other: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
        back: '<path d="M15 6l-6 6 6 6"/>',
        search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/>',
        clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        close: '<path d="M6 6l12 12M18 6L6 18"/>',
        download: '<path d="M12 3v12M7 11l5 5 5-5"/><path d="M4 20h16"/>',
        home: '<path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/>',
        user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
        edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
        copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    };

    function icon(name, cls) {
        return '<svg class="ico ' + (cls || '') + '" viewBox="0 0 24 24" fill="none" ' +
            'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ' +
            'stroke-linejoin="round" aria-hidden="true">' + (IC[name] || IC.other) + '</svg>';
    }

    const KIND_ICON = { image: 'image', pdf: 'pdf', docx: 'doc', xlsx: 'sheet', text: 'text', audio: 'media', video: 'media', other: 'other' };

    // ==================== 应用 ====================

    const app = {
        api: null,
        accountId: null,
        vfs: { files: {}, folders: {} },
        files: [],          // 扁平化后的文件列表
        filtered: [],
        current: null,      // 当前打开的文件
        handle: null,       // 渲染句柄
        dir: '/drive_home',
        settings: null,
        saveTimer: null,
    };

    const $ = (s) => document.querySelector(s);

    // ---------- URL 参数：?file=路径&with_token=xxx ----------

    /**
     * 路径归一：链接里带的是 "Drive Home/a.py"、"+"" 代表空格，
     * 而 VFS 里存的是 "/drive_home/xxx"。两边对不上就直接打开失败，
     * 所以统一成小写、去斜杠再比，并且最后退一步按文件名匹配。
     */
    function normPath(p) {
        return String(p || '').replace(/\+/g, ' ').trim()
            .replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
    }

    /**
     * 剥掉链接里的 Owner 前缀。
     * 链接形态是 file=Cool-zimo/Drive+Home/a.py —— 第一段是 GitHub 用户名，
     * 不是真实目录。VFS 里存的是 /drive_home/a.py，硬比必然落空。
     * 只在首段确实是某个已存账号的 login 时才剥，否则可能是同名真目录。
     */
    function stripOwner(p) {
        const s = String(p || '').replace(/^\/+/, '');
        const slash = s.indexOf('/');
        if (slash <= 0) return { owner: null, path: s };
        const head = s.slice(0, slash);
        const known = TPStore.listAccounts().map(
            a => String((a.user && (a.user.login || a.user.name)) || '').toLowerCase()
        ).filter(Boolean);
        if (known.indexOf(head.toLowerCase()) === -1) return { owner: null, path: s };
        return { owner: head, path: s.slice(slash + 1) };
    }

    function findByPath(p) {
        if (!p) return null;
        let want = normPath(p);
        // 先剥 Owner，再走原来的三级宽容匹配
        want = normPath(stripOwner(want).path);
        let hit = app.files.find(f => normPath(f.path) === want);
        if (hit) return hit;
        // 去掉首段目录再试一次（链接可能省略 /drive_home）
        const tail = want.includes('/') ? want.slice(want.indexOf('/') + 1) : want;
        hit = app.files.find(f => {
            const fp = normPath(f.path);
            return fp === tail || fp.endsWith('/' + tail);
        });
        if (hit) return hit;
        // 最后按文件名兜底
        const base = want.split('/').pop();
        return app.files.find(f => normPath(f.name) === base) || null;
    }

    /** URL 里带了 file= 就在列表加载完后自动打开 */
    function openFromUrl() {
        const raw = new URLSearchParams(location.search).get('file');
        if (!raw) return;
        let target;
        try { target = decodeURIComponent(raw); } catch (e) { target = raw; }
        const f = findByPath(target);
        if (f) {
            // 文件在子目录里时先切过去，否则左侧列表高亮不到
            const slash = f.path.lastIndexOf('/');
            if (slash > 0) app.dir = f.path.slice(0, slash) || '/drive_home';
            openFile(f);
        } else {
            $('#tp-body').innerHTML =
                '<div class="tp-error"><p>没找到这个文件：' +
                TPRender.esc(target) + '</p><p class="tp-dim">可能是路径变了，' +
                '或者这个 token 的仓库里没有它。左侧列表可以继续找。</p></div>';
        }
    }

    /** 用 URL 里的 token 静默登录（复用已有账号，不重复创建） */
    async function loginWithUrlToken(token) {
        const exist = TPStore.listAccounts().find(a => a.token === token);
        if (exist) { useAccount(exist); return; }
        const api = new Api(token);
        const me = await api.getMe();
        const id = TPStore.addAccount(token, me);
        useAccount(TPStore.getAccount(id));
    }

    function boot() {
        app.settings = TPStore.getSettings();
        applySettings();
        bindUI();

        const params = new URLSearchParams(location.search);
        const urlToken = (params.get('with_token') || '').trim();

        if (urlToken) {
            loginWithUrlToken(urlToken).then(openFromUrl).catch(e => {
                showLogin('链接里的 token 无效或已过期：' + e.message);
            });
            return;
        }

        const accounts = TPStore.listAccounts();
        if (!accounts.length) { showLogin(); return; }

        const saved = TPStore.getLastAccountId();
        const acc = (saved && TPStore.getAccount(saved)) || accounts[0];
        useAccount(acc);
        openFromUrl();
    }

    // ---------- 账号 ----------

    function showLogin(msg) {
        $('#tp-login').classList.add('show');
        if (msg) $('#tp-login-msg').textContent = msg;
    }

    function useAccount(acc) {
        app.accountId = acc.id;
        app.login = (acc.user && (acc.user.login || acc.user.name)) || acc.id;
        app.api = new Api(acc.token);
        TPStore.setLastAccountId(acc.id);
        $('#tp-login').classList.remove('show');
        renderAccountBar(acc);
        loadFiles();
    }

    function renderAccountBar(acc) {
        const u = acc.user || {};
        const el = $('#tp-user');
        el.innerHTML = icon('user') + '<span>' +
            TPRender.esc(u.login || u.name || acc.id) + '</span>';
        el.title = '点击切换账号';
    }

    // ---------- 文件列表 ----------

    function loadFiles() {
        app.vfs = TPStore.getVFS(app.accountId);
        const list = [];
        Object.keys(app.vfs.files).forEach(p => {
            const f = app.vfs.files[p];
            list.push({
                path: p,
                name: f.name || p.split('/').pop(),
                size: f.size || 0,
                chunks: f.chunks || [],
                updatedAt: f.updatedAt || f.createdAt,
                kind: TPRender.classify(f.name || p),
            });
        });
        // 名称排序用中文友好的 localeCompare，否则中文文件名会按
        // UTF-16 码点排，顺序看起来是乱的
        list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
        app.files = list;
        app.filtered = list;
        renderList();
        renderContinue();
    }

    /**
     * 当前目录下的条目 + 面包屑
     *
     * 支持两种模式：
     *   目录模式 —— 逐级进入（默认）
     *   搜索模式 —— 全库匹配，忽略目录
     */
    function entriesOf(dir) {
        const base = dir.endsWith('/') ? dir : dir + '/';
        const dirs = new Set();
        const files = [];
        for (const f of app.files) {
            if (!f.path.startsWith(base)) continue;
            const rest = f.path.slice(base.length);
            const slash = rest.indexOf('/');
            if (slash === -1) files.push(f);
            else dirs.add(rest.slice(0, slash));
        }
        return {
            dirs: [...dirs].map(d => ({ name: d, path: base + d })),
            files,
        };
    }

    function renderList() {
        const q = $('#tp-search').value.trim().toLowerCase();
        const box = $('#tp-list');
        box.innerHTML = '';

        let items, isSearch = false;
        if (q) {
            isSearch = true;
            // 搜索直接全库匹配文件名，不做目录过滤 ——
            // 用户在找东西时不想先记住它在哪一层
            items = app.files.filter(f => f.name.toLowerCase().includes(q));
        } else {
            const e = entriesOf(app.dir);
            items = e.dirs.map(d => ({ ...d, isDir: true }))
                .concat(e.files.map(f => ({ ...f, isDir: false })));
        }

        $('#tp-crumb').innerHTML = isSearch
            ? '<span class="tp-dim">搜索 “' + TPRender.esc(q) + '” · ' + items.length + ' 个结果</span>'
            : crumbs(app.dir);

        if (!items.length) {
            box.innerHTML = '<p class="tp-empty">' +
                (isSearch ? '没有匹配的文件' : '这个文件夹是空的') + '</p>';
            return;
        }

        const frag = document.createDocumentFragment();
        for (const it of items) {
            const row = document.createElement('button');
            row.className = 'tp-item' + (app.current && app.current.path === it.path ? ' active' : '');
            row.dataset.path = it.path;   // 右键菜单要靠它找回是哪一行
            row._it = it;                 // 文件夹条目不在 app.files 里，直接挂对象引用
            const ic = it.isDir ? 'folder' : (KIND_ICON[it.kind] || 'other');
            const meta = it.isDir ? '文件夹'
                : TPRender.fmtSize(it.size) + (it.chunks.length > 1 ? ' · ' + it.chunks.length + ' 片' : '');
            row.innerHTML =
                '<span class="tp-item-ico">' + icon(ic) + '</span>' +
                '<span class="tp-item-name">' + TPRender.esc(it.name) + '</span>' +
                '<span class="tp-item-meta">' + TPRender.esc(meta) + '</span>';
            row.onclick = () => it.isDir ? enterDir(it.path) : openFile(it);
            frag.appendChild(row);
        }
        box.appendChild(frag);
    }

    function crumbs(dir) {
        let html = '<button class="tp-crumb" data-d="/drive_home">' + icon('home') + '</button>';
        const parts = dir.replace(/^\/drive_home\/?/, '').split('/').filter(Boolean);
        let acc = '/drive_home';
        for (const p of parts) {
            acc += '/' + p;
            html += '<span class="tp-sep">/</span>' +
                '<button class="tp-crumb" data-d="' + TPRender.esc(acc) + '">' +
                TPRender.esc(p) + '</button>';
        }
        return html;
    }

    function enterDir(p) { app.dir = p; renderList(); }

    // ---------- 重命名（侧边栏右键） ----------

    /**
     * 在虚拟文件系统里重命名，同时改云端 config.json 和本地缓存
     *
     * ★ 为什么两边都要改：
     *   云端 config.json 是权威（Drive 也读它），本地 VFS 是千览渲染用的
     *   缓存。只改云端 → 界面上还是旧名字；只改缓存 → 一刷新就打回原形。
     *
     * ★ 文件夹重命名不是改一个键就完事：/a/b 改成 /a/c 之后，
     *   /a/b/xx.jpg、/a/b/sub/ 这些子项的路径键全都得跟着换前缀，
     *   否则文件会"消失"——它们还挂在已经不存在的父目录下。
     *
     * ★ 写之前重新 GET 一次拿最新 sha：config.json 是单文件，
     *   Drive 那边可能刚改过。拿旧 sha 去 PUT 会被 409 拒掉。
     */
    async function doRename(it, newName) {
        const oldPath = it.path;
        const isDir = !!it.isDir;

        newName = String(newName || '').trim();
        if (!newName) { toast('名字不能为空'); return false; }
        if (newName.indexOf('/') !== -1) { toast('名字里不能有 /'); return false; }
        if (newName === it.name) return false;

        const cut = oldPath.lastIndexOf('/');
        const parent = cut > 0 ? oldPath.slice(0, cut) : '';
        const newPath = parent + '/' + newName;
        const now = new Date().toISOString();

        // 同级重名先在本地缓存里挡一道，省一次网络往返
        const vfs = TPStore.getVFS(app.accountId);
        const bucket = isDir ? vfs.folders : vfs.files;
        if (bucket && bucket[newPath]) { toast('已经有同名' + (isDir ? '文件夹' : '文件') + '了'); return false; }

        try {
            const { sha, cfg } = await app.api.getConfig();
            applyRename(cfg, oldPath, newPath, newName, isDir, now);
            await app.api.putConfig(cfg, sha,
                (isDir ? '重命名文件夹 ' : '重命名 ') + it.name + ' → ' + newName);
        } catch (e) {
            // 409：读完之后有人改过 config.json，重读一次再试，只重试一轮
            if (e.status === 409) {
                try {
                    const again = await app.api.getConfig();
                    applyRename(again.cfg, oldPath, newPath, newName, isDir, now);
                    await app.api.putConfig(again.cfg, again.sha,
                        (isDir ? '重命名文件夹 ' : '重命名 ') + it.name + ' → ' + newName);
                } catch (e2) { toast('重命名失败：' + e2.message); return false; }
            } else {
                toast('重命名失败：' + (e.message || e));
                return false;
            }
        }

        // 云端改成功了，同步本地缓存
        applyRename(vfs, oldPath, newPath, newName, isDir, now);
        TPStore.setVFS(app.accountId, vfs);

        // 继续阅读里存的名字也跟着换，否则卡片上还是旧名
        // （fingerprint 只算 sha+size 不含名字，所以进度不会丢）
        try {
            const hist = TPStore.getHistory();
            const hit = hist.find(h => h && h.name === it.name);
            if (hit && TPStore.addHistory) {
                TPStore.addHistory(Object.assign({}, hit, { name: newName }));
            }
        } catch { /* 历史改名失败不影响重命名本身 */ }

        if (app.current && app.current.path === oldPath) {
            app.current = Object.assign({}, app.current, { path: newPath, name: newName });
            $('#tp-view-title').textContent = newName;
            closeView();
        }
        loadFiles();
        toast('已改名为 ' + newName);
        return true;
    }

    /** 纯函数：把一次重命名应用到任意一份 {files, folders} 结构上 */
    function applyRename(root, oldPath, newPath, newName, isDir, now) {
        const fi = root.fileIndex || root;
        if (!fi.files) fi.files = {};
        if (!fi.folders) fi.folders = {};
        const pref = oldPath + '/';
        const np = newPath + '/';

        if (isDir) {
            if (fi.folders[newPath]) throw new Error('已存在同名文件夹');
            const node = fi.folders[oldPath];
            if (!node) throw new Error('找不到这个文件夹');
            fi.folders[newPath] = Object.assign({}, node, { name: newName });
            delete fi.folders[oldPath];
        } else {
            if (fi.files[newPath]) throw new Error('已存在同名文件');
            const node = fi.files[oldPath];
            if (!node) throw new Error('找不到这个文件');
            fi.files[newPath] = Object.assign({}, node, { name: newName, updatedAt: now });
            delete fi.files[oldPath];
        }

        // 子项前缀迁移（文件夹重命名时才会命中）
        for (const k of Object.keys(fi.files)) {
            if (k.indexOf(pref) === 0) {
                const v = fi.files[k]; delete fi.files[k];
                fi.files[np + k.slice(pref.length)] = v;
            }
        }
        for (const k of Object.keys(fi.folders)) {
            if (k.indexOf(pref) === 0) {
                const v = fi.folders[k]; delete fi.folders[k];
                fi.folders[np + k.slice(pref.length)] = v;
            }
        }

        // 收藏 / 最近 里存的是路径字符串，改名后一并换掉，
        // 否则点收藏会跳到一个已经不存在的路径
        ['starred', 'recent'].forEach(key => {
            if (!Array.isArray(root[key])) return;
            root[key] = root[key].map(p => {
                if (typeof p !== 'string') return p;
                if (p === oldPath) return newPath;
                if (p.indexOf(pref) === 0) return np + p.slice(pref.length);
                return p;
            });
        });

        if (root.fileIndex) root.updatedAt = now;
    }

    /** 把某一行变成输入框，回车提交 / Esc 取消 / 失焦提交 */
    function startInlineRename(row, it) {
        const nameEl = row.querySelector('.tp-item-name');
        if (!nameEl || row.dataset.renaming === '1') return;
        row.dataset.renaming = '1';

        const old = it.name;
        const input = document.createElement('input');
        input.className = 'tp-rename-input';
        input.value = old;
        // 有后缀的文件只选中主文件名，符合常见系统的习惯
        const dot = old.lastIndexOf('.');
        nameEl.textContent = '';
        nameEl.appendChild(input);
        input.focus();
        try { input.setSelectionRange(0, dot > 0 ? dot : old.length); } catch { input.select(); }

        let done = false;
        const finish = async (commit) => {
            if (done) return;
            done = true;
            const val = commit ? input.value : null;
            row.dataset.renaming = '0';
            nameEl.textContent = old;          // 先还原，等云端结果再刷新
            if (commit && val && val.trim() !== old) await doRename(it, val);
            else loadFiles();
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
            e.stopPropagation();               // 别让 Esc 触发"关闭阅读区"
        });
        input.addEventListener('click', e => e.stopPropagation());
        input.addEventListener('blur', () => finish(true));
    }

    // ---------- 右键菜单 ----------

    function ctxMenu() {
        let el = $('#tp-ctx');
        if (el) return el;
        el = document.createElement('div');
        el.className = 'tp-ctx';
        el.id = 'tp-ctx';
        el.innerHTML =
            '<button data-act="rename">' + icon('edit') + '<span>重命名</span></button>' +
            '<button data-act="copy">' + icon('copy') + '<span>复制路径</span></button>';
        document.body.appendChild(el);
        el.addEventListener('click', (e) => {
            const b = e.target.closest('button');
            if (!b) return;
            const it = el._item;
            hideCtx();
            if (!it) return;
            if (b.dataset.act === 'rename') {
                const row = $('#tp-list').querySelector('[data-path="' + cssEsc(it.path) + '"]');
                if (row) startInlineRename(row, it);
            } else if (b.dataset.act === 'copy') {
                navigator.clipboard && navigator.clipboard.writeText(it.path)
                    .then(() => toast('路径已复制'), () => toast('复制失败'));
            }
        });
        return el;
    }

    function showCtx(x, y, it) {
        const el = ctxMenu();
        el._item = it;
        el.classList.add('show');
        // ★ 必须先 add('show') 再量尺寸 —— display:none 时 offsetWidth 是 0，
        //   拿 0 去算边界会让菜单永远贴在左上角
        const w = el.offsetWidth, h = el.offsetHeight;
        el.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 8)) + 'px';
        el.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 8)) + 'px';
    }

    function hideCtx() {
        const el = $('#tp-ctx');
        if (el) el.classList.remove('show');
    }

    function cssEsc(s) {
        return String(s).replace(/["\\]/g, '\\$&');
    }

    let toastTimer = null;
    function toast(msg) {
        let el = $('#tp-toast');
        if (!el) {
            el = document.createElement('div');
            el.className = 'tp-toast';
            el.id = 'tp-toast';
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
    }

    // ---------- 继续阅读 ----------

    function renderContinue() {
        const box = $('#tp-continue');
        const hist = TPStore.getHistory().slice(0, 6);
        if (!hist.length) { box.innerHTML = ''; return; }
        // 只显示当前账号仍存在的文件，删掉的条目不展示（点了会报错）
        const alive = hist.filter(h =>
            app.files.some(f => TPStore.fingerprint(f) === h.fingerprint));
        if (!alive.length) { box.innerHTML = ''; return; }

        let html = '<div class="tp-sec-title">' + icon('clock') + '继续阅读</div><div class="tp-cards">';
        alive.forEach(h => {
            const f = app.files.find(x => TPStore.fingerprint(x) === h.fingerprint);
            // 分页型显示"第 X / Y 页"，滚动型显示百分比
            const label = (h.page && h.total)
                ? h.page + ' / ' + h.total + ' 页'
                : (h.progress != null ? Math.round(h.progress * 100) + '%' : '');
            const width = h.progress != null
                ? Math.min(100, Math.round(h.progress * 100)) : 0;
            html += '<button class="tp-card" data-fp="' + TPRender.esc(h.fingerprint) + '">' +
                '<span class="tp-card-ico">' + icon(KIND_ICON[f.kind] || 'other') + '</span>' +
                '<span class="tp-card-name">' + TPRender.esc(h.name) + '</span>' +
                '<span class="tp-card-bar"><i style="width:' + width + '%"></i></span>' +
                '<span class="tp-card-pct">' + label + '</span>' +
                '</button>';
        });
        html += '</div>';
        box.innerHTML = html;
        box.querySelectorAll('.tp-card').forEach(b => {
            b.onclick = () => {
                const f = app.files.find(x => TPStore.fingerprint(x) === b.dataset.fp);
                if (f) openFile(f);
            };
        });
    }

    // ---------- 打开与渲染 ----------

    let openToken = 0;

    async function openFile(f) {
        const my = ++openToken;
        app.current = f;

        $('#tp-view').classList.add('open');
        $('#tp-view-title').textContent = f.name;
        $('#tp-body').innerHTML = '<div class="tp-loading">正在读取…</div>';
        renderList();

        try {
            const blob = await fetchFile(app.api, f, (done, total) => {
                if (my !== openToken) return;
                if (total > 1) {
                    $('#tp-body').innerHTML = '<div class="tp-loading">正在读取… ' +
                        done + '/' + total + '</div>';
                }
            });
            if (my !== openToken) return;   // 期间用户点了别的文件，丢弃这次结果

            if (app.handle && app.handle.destroy) app.handle.destroy();
            app.handle = null;

            $('#tp-body').innerHTML = '';
            app.handle = await TPRender.render(blob, f, $('#tp-body'), {
                onBigFile: mb => {
                    // 大 PDF 解析前一秒会卡住主线程，先说清楚在干嘛
                    const tip = document.createElement('div');
                    tip.className = 'tp-bigfile-tip';
                    tip.textContent = '文件 ' + mb.toFixed(1) +
                        ' MB，正在解析…（页面仍是逐页加载，不会一次读进屏幕）';
                    $('#tp-body').appendChild(tip);
                }
            });

            // 恢复位置：记住位置开关打开且有历史记录才跳
            const fp = TPStore.fingerprint(f);
            if (app.settings.rememberPosition && app.handle.restorePosition) {
                const pos = TPStore.getPosition(fp);
                if (pos) {
                    // 等一帧：刚插入的 DOM 还没布局完，scrollHeight 是 0，
                    // 此时设 scrollTop 会被忽略
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => app.handle.restorePosition(pos));
                    });
                }
            }

            $('#tp-view-meta').textContent = TPRender.fmtSize(f.size) +
                ' · ' + (f.chunks.length > 1 ? f.chunks.length + ' 个分片' : '单文件');
            bindDownload(blob, f);
            startAutoSave(fp);

        } catch (e) {
            if (my !== openToken) return;
            let why = '';
            if (e.status === 401) why = '这个账号的 token 已失效或权限不足，重新登录试试。';
            else if (e.cdnFailed) why = '渲染这个类型需要的组件没能加载成功（网络或 CDN 问题）。' +
                '文件本身已经读到了，可以先下载下来用本地软件打开。';
            else why = '通常是网络问题，稍后重试即可。';

            const box = document.createElement('div');
            box.className = 'tp-error';
            box.innerHTML = '<p>读取失败：' + TPRender.esc(e.message) + '</p>' +
                '<p class="tp-dim">' + TPRender.esc(why) + '</p>';
            $('#tp-body').innerHTML = '';
            $('#tp-body').appendChild(box);

            // ★ CDN 挂掉时尤其需要这个按钮：文件其实已经下载到内存了，
            //   只是渲染不了。给用户一条能走通的路，比只报错有用得多。
            if (e.cdnFailed) {
                const btn = document.createElement('button');
                btn.className = 'tp-btn';
                btn.textContent = '下载这个文件';
                btn.onclick = () => retryDownload(f);
                box.appendChild(btn);
            }
        }
    }

    /**
     * 渲染失败后的补救下载
     *
     * 重新走一遍取文件的流程（不用缓存的 blob，因为那时可能已经失败）。
     * 这条路径慢一点，但它是用户最后能拿到文件的方式，值得多花几秒。
     */
    async function retryDownload(f) {
        try {
            const blob = await fetchFile(app.api, f);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = f.name;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
        } catch (e2) {
            alert('下载也失败了：' + e2.message);
        }
    }

    function bindDownload(blob, f) {
        const btn = $('#tp-download');
        btn.onclick = () => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = f.name;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
        };
    }

    /**
     * 自动保存阅读位置
     *
     * ★ 为什么是"滚动停下来才存"而不是每次滚动都存：
     *   scroll 事件每秒能触发几十次，每次都 JSON.stringify 整个
     *   positions 对象写 localStorage，长文档连续滚动会明显掉帧。
     *   节流到停止 600ms 后写一次，既不会丢进度也不会卡。
     */
    function startAutoSave(fp) {
        if (app.saveTimer) clearInterval(app.saveTimer);
        let idleTimer = null;
        const body = $('#tp-body');

        function grab() {
            if (!app.handle || !app.handle.savePosition) return;
            const pos = app.handle.savePosition();
            if (!pos) return;
            // ★ 两类进度不能混算：
            //   滚动型（文本/Word）已有 0~1 的 ratio，直接用；
            //   分页型（PDF）只有 page/total，得自己除 —— 少了这一步，
            //   第 5 页会被当成 500%。
            let progress = null;
            if (typeof pos.ratio === 'number') progress = pos.ratio;
            else if (pos.page && pos.total) progress = pos.page / pos.total;

            TPStore.setPosition(fp, pos);
            TPStore.addHistory({
                fingerprint: fp,
                name: app.current.name,
                progress: progress,
                // 分页型记页码，界面上显示"第 5 / 20 页"比"25%"直观
                page: pos.page || null,
                total: pos.total || null,
            });
        }

        const onScroll = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(grab, 600);
        };
        body.addEventListener('scroll', onScroll, { passive: true });
        // 翻页/切工作表不产生 scroll 事件，所以再补一个定时兜底
        app.saveTimer = setInterval(grab, 5000);

        // 离开页面前强制存一次，否则最后几秒的进度会丢
        const saveNow = () => { clearTimeout(idleTimer); grab(); };
        window.addEventListener('pagehide', saveNow);
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) saveNow();
        });
        app._cleanupScroll = () => {
            body.removeEventListener('scroll', onScroll);
            window.removeEventListener('pagehide', saveNow);
            clearInterval(app.saveTimer);
            app.saveTimer = null;
        };
    }

    function closeView() {
        // 关闭前存一次，进度不会丢
        if (app.current && app.handle && app.handle.savePosition) {
            const pos = app.handle.savePosition();
            if (pos) TPStore.setPosition(TPStore.fingerprint(app.current), pos);
        }
        if (app._cleanupScroll) { app._cleanupScroll(); app._cleanupScroll = null; }
        if (app.handle && app.handle.destroy) app.handle.destroy();
        app.handle = null;
        app.current = null;
        $('#tp-view').classList.remove('open');
        renderList();
        renderContinue();
    }

    // ---------- 设置 ----------

    function applySettings() {
        const s = app.settings;
        const root = document.documentElement;
        root.style.setProperty('--tp-font', s.fontSize + 'px');
        root.style.setProperty('--tp-lh', String(s.lineHeight));
        root.style.setProperty('--tp-maxw', s.maxWidth + 'px');
        const theme = s.theme;
        root.dataset.theme = theme;
        if (theme === 'auto') {
            root.removeAttribute('data-theme');
        }
    }

    // ---------- 事件 ----------

    function bindUI() {
        $('#tp-search').addEventListener('input', () => renderList());
        $('#tp-crumb').addEventListener('click', (e) => {
            const b = e.target.closest('.tp-crumb');
            if (b) enterDir(b.dataset.d);
        });
        $('#tp-close').addEventListener('click', closeView);

        // 侧边栏右键 → 重命名 / 复制路径
        $('#tp-list').addEventListener('contextmenu', (e) => {
            const row = e.target.closest('.tp-item');
            if (!row || !row._it) return;
            e.preventDefault();
            showCtx(e.clientX, e.clientY, row._it);
        });
        // 点别处、滚动、Esc 都把菜单收起来，否则它会一直浮在屏幕上
        document.addEventListener('click', hideCtx);
        document.addEventListener('scroll', hideCtx, true);
        window.addEventListener('resize', hideCtx);
        // F2：给"当前打开的那个文件"改名，桌面端的通用习惯
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'F2' || !app.current) return;
            const row = $('#tp-list').querySelector('[data-path="' + cssEsc(app.current.path) + '"]');
            if (row) { e.preventDefault(); startInlineRename(row, row._it || app.current); }
        });
        $('#tp-user').addEventListener('click', showAccountMenu);

        // 搜索框 Esc 清空，符合大多数阅读器的习惯
        $('#tp-search').addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { $('#tp-search').value = ''; renderList(); }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && $('#tp-view').classList.contains('open')) closeView();
        });

        // 登录框提交
        $('#tp-login-go').addEventListener('click', submitLogin);
        $('#tp-login-token').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submitLogin();
        });

        // 设置面板
        $('#tp-set-toggle').addEventListener('click', () => {
            $('#tp-settings').classList.toggle('show');
        });
        bindRange('#tp-fs', 'fontSize', v => parseInt(v, 10));
        bindRange('#tp-lh', 'lineHeight', v => parseFloat(v));
        bindRange('#tp-mw', 'maxWidth', v => parseInt(v, 10));
        $('#tp-theme').addEventListener('change', (e) => {
            app.settings = TPStore.setSettings({ theme: e.target.value }) || app.settings;
            app.settings = TPStore.getSettings();
            applySettings();
        });
        $('#tp-remember').addEventListener('change', (e) => {
            TPStore.setSettings({ rememberPosition: e.target.checked });
            app.settings = TPStore.getSettings();
        });
        $('#tp-clear-hist').addEventListener('click', () => {
            if (!confirm('清空所有浏览记录和阅读位置？')) return;
            TPStore.clearHistory();
            TPStore._write('positions', {});
            renderContinue();
        });
    }

    function bindRange(sel, key, cast) {
        const el = $(sel);
        if (!el) return;
        el.value = app.settings[key];
        el.addEventListener('input', () => {
            const patch = {};
            patch[key] = cast(el.value);
            TPStore.setSettings(patch);
            app.settings = TPStore.getSettings();
            applySettings();
        });
    }

    async function submitLogin() {
        const token = $('#tp-login-token').value.trim();
        if (!token) { $('#tp-login-msg').textContent = '请填写 token'; return; }
        $('#tp-login-msg').textContent = '正在验证…';
        const api = new Api(token);
        try {
            const me = await api.getMe();
            const id = TPStore.addAccount(token, me);
            const acc = TPStore.getAccount(id);
            $('#tp-login-token').value = '';
            useAccount(acc);
        } catch (e) {
            $('#tp-login-msg').textContent = '验证失败：' + e.message +
                (e.status === 401 ? '（token 无效或已过期）' : '');
        }
    }

    function showAccountMenu() {
        const accounts = TPStore.listAccounts();
        if (accounts.length <= 1) {
            // 只有一个账号时弹菜单没意义，直接给登录入口
            showLogin('切换或添加一个账号');
            return;
        }
        const menu = $('#tp-acct-menu');
        menu.innerHTML = accounts.map(a =>
            '<button data-id="' + TPRender.esc(a.id) + '">' +
            TPRender.esc((a.user && (a.user.login || a.user.name)) || a.id) + '</button>'
        ).join('') + '<button data-id="__add">＋ 添加账号</button>';
        menu.classList.add('show');
        menu.querySelectorAll('button').forEach(b => {
            b.onclick = () => {
                menu.classList.remove('show');
                if (b.dataset.id === '__add') { showLogin(); return; }
                const acc = TPStore.getAccount(b.dataset.id);
                if (acc) useAccount(acc);
            };
        });
    }

    // 点击空白处收起账号菜单
    document.addEventListener('click', (e) => {
        const menu = $('#tp-acct-menu');
        if (!menu) return;
        if (menu.classList.contains('show') &&
            !e.target.closest('#tp-acct-menu') && !e.target.closest('#tp-user')) {
            menu.classList.remove('show');
        }
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else { boot(); }

    window.TPApp = app;
})();
