/**
 * 千览 · 数据层
 *
 * 只做一件事：把 Drive 已经写在浏览器里的数据读出来，以及把千览自己的
 * 数据（浏览记录、阅读位置）写回去。所有读写都在本地 localStorage，
 * 不经过任何服务器。
 *
 * ★ 最大的坑：token 读不到。
 *
 *   Drive 把当前 token 存在 sessionStorage 里（github_drive_tab_token），
 *   因为 localStorage 是同源共享的 —— 两个标签页开 Drive，B 登录会把
 *   A 的身份顶掉。sessionStorage 每标签页一份，正好隔离。
 *
 *   但代价是：千览作为【新标签页】打开，sessionStorage 是空的，
 *   直接读 github_drive_tab_token 只会拿到 null。
 *
 *   能用的备份在 localStorage 的 github_drive_accounts 里 —— 它是多账号
 *   名单，每个条目都带 token（否则切换账号时无从取用）。这份是共享的，
 *   千览读得到。所以登录入口不靠 session，靠 accounts。
 */
(function () {
    'use strict';

    const PREFIX = 'github_drive_';
    const TP_PREFIX = 'gd_thousand_';   // 千览自己的数据，前缀隔离避免污染 Drive

    const Store = {
        // ==================== 账号 ====================

        /**
         * 列出所有已保存的账号（含 token）
         *
         * Drive 登录过至少一个账号，这里就有内容。lastUsed 最新的排前面，
         * 因为用户最可能想用刚登录的那个。
         */
        listAccounts() {
            try {
                const raw = localStorage.getItem(PREFIX + 'accounts');
                let arr = raw ? JSON.parse(raw) : [];
                if (!Array.isArray(arr)) arr = [];
                return arr.slice().sort((a, b) => {
                    const ta = Date.parse(a.lastUsed || a.addedAt || 0) || 0;
                    const tb = Date.parse(b.lastUsed || b.addedAt || 0) || 0;
                    return tb - ta;
                });
            } catch { return []; }
        },

        /**
         * 当前账号 id。
         *
         * 三个来源按可靠性排序：
         *   1. sessionStorage（当前标签页正在用谁）—— 千览里通常没有
         *   2. localStorage current_account —— Drive 迁移时可能删掉，但不绝对
         *   3. accounts 里 lastUsed 最新的那条
         *
         * 拿不到就返回 null，由界面弹登录框，不猜。
         */
        currentAccountId() {
            try {
                const s = sessionStorage.getItem(PREFIX + 'tab_current_account');
                if (s) return JSON.parse(s);
            } catch { /* 读不到继续 */ }
            try {
                const v = localStorage.getItem(PREFIX + 'current_account');
                if (v) return JSON.parse(v);
            } catch { /* 读不到继续 */ }
            const acc = this.listAccounts();
            return acc.length ? acc[0].id : null;
        },

        getAccount(id) {
            return this.listAccounts().find(a => a.id === id) || null;
        },

        /**
         * 手动添加账号（用户在千览里直接填 token 时用）
         *
         * 写进 accounts 而不是只存内存，这样回到 Drive 也能看到这个账号，
         * 不用再登一次。
         */
        addAccount(token, user) {
            const accounts = this.listAccounts();
            const id = (user && (user.login || user.id)) || token.slice(0, 8);
            const existing = accounts.find(a => a.id === id);
            if (existing) {
                existing.token = token;
                existing.user = user;
                existing.lastUsed = new Date().toISOString();
            } else {
                accounts.push({
                    id, token, user,
                    addedAt: new Date().toISOString(),
                    lastUsed: new Date().toISOString()
                });
            }
            try {
                localStorage.setItem(PREFIX + 'accounts', JSON.stringify(accounts));
            } catch { /* 配额满就算了 */ }
            return id;
        },

        // ==================== VFS ====================

        /**
         * 读某个账号的虚拟文件系统
         *
         * ★ VFS 的 key 带账号前缀：github_drive_account_<id>_vfs
         *   不带前缀的旧 key（github_drive_vfs）在 Drive 迁移时已被删掉，
         *   但仍留一条回退，防止读到空数据却误判为"没文件"。
         */
        getVFS(accountId) {
            const tryKey = (k) => {
                try {
                    const raw = localStorage.getItem(k);
                    if (!raw) return null;
                    const v = JSON.parse(raw);
                    if (!v || typeof v !== 'object') return null;
                    if (!v.files || typeof v.files !== 'object') v.files = {};
                    if (!v.folders || typeof v.folders !== 'object') v.folders = {};
                    return v;
                } catch { return null; }
            };
            if (accountId) {
                const scoped = tryKey(PREFIX + 'account_' + accountId + '_vfs');
                if (scoped) return scoped;
            }
            return tryKey(PREFIX + 'vfs') || { files: {}, folders: {} };
        },

        /**
         * 写回某个账号的 VFS 缓存
         *
         * ★ 重命名这类"改了云端 config.json"的操作必须同步写回这里。
         *   千览的列表是从这份缓存渲染的（loadFiles 读 getVFS），
         *   只改云端不改缓存，界面上会一直显示旧名字，直到 Drive 那边
         *   重新推一次缓存——那可能是几天后。
         *
         * ★ 只写带账号前缀的那份 key，绝不回写不带前缀的旧 key：
         *   那份是历史遗留，多账号场景下会被别的账号读到。
         */
        setVFS(accountId, vfs) {
            if (!accountId || !vfs) return false;
            try {
                localStorage.setItem(
                    PREFIX + 'account_' + accountId + '_vfs',
                    JSON.stringify(vfs));
                return true;
            } catch (e) {
                // localStorage 写满（配额 5MB）时静默失败，不打断重命名——
                // 云端已经改成功了，缓存这次没跟上不是致命错误
                return false;
            }
        },

        /**
         * 扫出所有账号的 VFS —— 用于"这个账号没文件"时提示切换账号。
         * 不做切换猜测，只是让用户知道别的账号里有东西。
         */
        scanAllVFS() {
            const out = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (!k || k.indexOf(PREFIX + 'account_') !== 0) continue;
                if (k.slice(-4) !== '_vfs') continue;
                const id = k.slice((PREFIX + 'account_').length, -4);
                const vfs = this.getVFS(id);
                out.push({ id, count: Object.keys(vfs.files).length });
            }
            return out;
        },

        // ==================== 千览自己的数据 ====================

        _read(key, def) {
            try {
                const raw = localStorage.getItem(TP_PREFIX + key);
                return raw ? JSON.parse(raw) : def;
            } catch { return def; }
        },
        _write(key, val) {
            try {
                localStorage.setItem(TP_PREFIX + key, JSON.stringify(val));
                return true;
            } catch { return false; }
        },

        // ---- 最近账号 ----
        getLastAccountId() { return this._read('last_account', null); },
        setLastAccountId(id) { this._write('last_account', id); },

        // ---- 阅读位置 ----
        //
        // key 用文件指纹而不是路径：路径可以被改名/移动，
        // 而分片 sha 只在内容变了才变。改个名不该丢失阅读进度。
        getPositions() { return this._read('positions', {}); },
        getPosition(fingerprint) {
            return this.getPositions()[fingerprint] || null;
        },
        setPosition(fingerprint, pos) {
            const all = this.getPositions();
            all[fingerprint] = Object.assign({ updatedAt: Date.now() }, pos);
            // 只保留最近 500 条，避免无上限增长把 localStorage 撑爆
            const keys = Object.keys(all);
            if (keys.length > 500) {
                keys.sort((a, b) => (all[b].updatedAt || 0) - (all[a].updatedAt || 0));
                const keep = {};
                keys.slice(0, 500).forEach(k => { keep[k] = all[k]; });
                this._write('positions', keep);
            } else {
                this._write('positions', all);
            }
        },

        // ---- 浏览记录 ----
        getHistory() { return this._read('history', []); },
        addHistory(entry) {
            let list = this.getHistory();
            list = list.filter(e => e.fingerprint !== entry.fingerprint);
            list.unshift(Object.assign({ at: Date.now() }, entry));
            this._write('history', list.slice(0, 200));
        },
        clearHistory() { this._write('history', []); },

        // ---- 设置 ----
        getSettings() {
            return Object.assign({
                theme: 'auto',          // auto / light / dark
                fontSize: 16,
                lineHeight: 1.7,
                maxWidth: 820,
                rememberPosition: true,
            }, this._read('settings', {}));
        },
        setSettings(patch) {
            this._write('settings', Object.assign(this.getSettings(), patch));
        },

        /**
         * 文件指纹：内容变则变，改名不变。
         *
         * 用第一个分片的 sha + 总大小。多分片文件只取首片 sha 有极小碰撞
         * 概率（改了后面的分片但首片不变且大小相同），加总长度已经把这种
         * 情况压到可忽略。这里要的是"够稳"，不是密码学强度。
         */
        fingerprint(fileInfo) {
            const c = (fileInfo && fileInfo.chunks && fileInfo.chunks[0]) || {};
            return (c.sha || fileInfo.name || '?') + ':' + (fileInfo.size || 0);
        },
    };

    window.TPStore = Store;
})();
