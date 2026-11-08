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

        async _get(path, raw, signal) {
            const headers = {
                'Authorization': 'token ' + this.token,
                'Accept': raw ? 'application/vnd.github.v3.raw' : 'application/vnd.github.v3+json',
                'X-GitHub-Api-Version': '2022-11-28',
            };
            let lastErr;
            // 429/5xx 重试。GitHub 偶发 502，不重试会让用户以为文件坏了
            for (let i = 0; i <= 2; i++) {
                try {
                    const r = await fetch(GH + path, { headers, signal });
                    if (r.ok) return raw ? r.arrayBuffer() : r.json();
                    const txt = await r.text().catch(() => '');
                    const err = new Error('HTTP ' + r.status + ' ' + txt.slice(0, 120));
                    err.status = r.status;
                    throw err;
                } catch (e) {
                    if (signal && signal.aborted) throw e;
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
         * 按 sha 取原始字节（RAW 优先，失败回退 base64）
         *
         * ★ 用 git/blobs 而不是 contents：contents 接口对 >1MB 的文件
         *   会返回空 content 逼你再走一次 blob 接口，等于白跑一趟。
         *   git/blobs 一步到位，且不受仓库默认分支影响。
         *
         * ★ 为什么必须走 RAW：
         *   默认 Accept 会把二进制包进 base64 的 JSON，体积凭空涨 33%，
         *   浏览器还要 atob + 逐字节 charCodeAt 循环（同步阻塞主线程）。
         *   Accept: application/vnd.github.raw 直接给原始字节。
         *   线上实测同一 blob：RAW 155628 B / 0.899s，JSON 214712 B / 1.075s。
         *   Drive 主站的 github-api.js 早就换过来了，千览这份独立客户端
         *   一直没跟上 —— 这正是「预览慢」最主要的来源。
         *
         * ★ 为什么保留回退：
         *   少数老仓库 / 超大 blob 上 raw 媒体类型不生效，GitHub 会回 JSON，
         *   按 content-type 识别出来走老路径，行为完全不变。
         *
         * ★ 流式读取：response.body 逐块上报字节，进度条才有真实百分比，
         *   而不是干等一句「正在读取…」。
         */
        async _fetchBlobRaw(path, signal, onBytes) {
            const headers = {
                'Authorization': 'token ' + this.token,
                'Accept': 'application/vnd.github.raw',
                'X-GitHub-Api-Version': '2022-11-28',
            };
            let lastErr;
            for (let i = 0; i <= 2; i++) {
                try {
                    const r = await fetch(GH + path, { headers, signal });
                    if (!r.ok) {
                        const e = new Error('HTTP ' + r.status);
                        e.status = r.status;
                        throw e;
                    }
                    const ct = r.headers.get('content-type') || '';
                    if (ct.includes('application/json')) {
                        const e = new Error('服务端返回 JSON，RAW 未生效');
                        e.rawUnsupported = true;
                        throw e;
                    }
                    const len = parseInt(r.headers.get('content-length') || '0', 10) || 0;
                    // 老 WebView 没有 ReadableStream，退回一次性读取
                    if (!r.body || !r.body.getReader) {
                        const ab = await r.arrayBuffer();
                        if (!ab.byteLength) throw new Error('blob RAW 内容为空');
                        if (onBytes) onBytes(ab.byteLength, ab.byteLength || len);
                        return new Uint8Array(ab);
                    }
                    const reader = r.body.getReader();
                    const pieces = [];
                    let got = 0;
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        pieces.push(value);
                        got += value.length;
                        if (onBytes) onBytes(got, len || got);
                    }
                    if (!got) throw new Error('blob RAW 内容为空');
                    const out = new Uint8Array(got);
                    let off = 0;
                    for (const p of pieces) { out.set(p, off); off += p.length; }
                    return out;
                } catch (e) {
                    if (signal && signal.aborted) throw e;
                    if (e.rawUnsupported) throw e;   // 直接回退，别浪费重试
                    lastErr = e;
                    const transient = !e.status || e.status === 429 ||
                        e.status === 500 || e.status === 502 || e.status === 503;
                    if (!transient || i === 2) throw e;
                    await new Promise(r => setTimeout(r, 500 * Math.pow(2, i)));
                }
            }
            throw lastErr;
        }

        async getBlobBytes(owner, repo, sha, opts) {
            opts = opts || {};
            const path = `/repos/${owner}/${repo}/git/blobs/${sha}`;
            try {
                return await this._fetchBlobRaw(path, opts.signal, opts.onBytes);
            } catch (e) {
                if (opts.signal && opts.signal.aborted) throw e;
                // 只有「服务端确实没给 RAW」或「拿不到 HTTP 状态的传输故障」
                // 才值得再走一次 base64。401/403/404 是明确结论，回退只会
                // 让每个分片多发一次请求 —— 6 片并发时被放大成 6 次无用
                // 往返，连「读取失败」都要多等一轮才显示。
                if (e.status >= 400 && !e.rawUnsupported) throw e;
            }

            const b = await this._get(path, false, opts.signal);
            const content = b && b.content;
            if (!content) throw new Error('blob 内容为空: ' + sha);
            let out;
            if (b.encoding === 'base64') {
                // 大文件不能一次性 atob 后逐字符 charCodeAt —— 几十 MB 时
                // 会卡住主线程好几秒。分块处理，每块 64KB。
                const bin = atob(content);
                out = new Uint8Array(bin.length);
                const CH = 65536;
                for (let i = 0; i < bin.length; i += CH) {
                    const end = Math.min(i + CH, bin.length);
                    for (let j = i; j < end; j++) out[j] = bin.charCodeAt(j);
                }
            } else {
                out = new TextEncoder().encode(content);
            }
            if (opts.onBytes) opts.onBytes(out.length, out.length);
            return out;
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

    // ==================== 全局网络闸门 ====================
    /**
     * 单个文件内部并发 6 路是快的，但「预取 6 个文件 + 用户又连点 3 个」
     * 会叠成 6×N 路请求，GitHub 的 secondary rate limit 一触发，反而比
     * 串行更慢 —— 而且最先被拖住的往往是用户正在看的那个文件。
     *
     * 这里给所有分片请求套一个全局闸门：同时在途不超过 6 路，队列按
     * 优先级出队。前台打开的文件是 1，后台预取是 0；预取进行到一半
     * 用户点了同一个文件，entry 的优先级会被提升，队列里剩下的分片
     * 立刻插到前面（prio 是函数而不是快照，就是为了这个）。
     */
    const NET_LIMIT = 6;
    const netQueue = [];
    let netActive = 0;

    function netAcquire(prio) {
        return new Promise(resolve => {
            netQueue.push({ prio, resolve });
            netPump();
        });
    }

    function netPump() {
        if (netActive >= NET_LIMIT) return;
        netQueue.sort((a, b) => (b.prio() || 0) - (a.prio() || 0));
        while (netActive < NET_LIMIT && netQueue.length) {
            const t = netQueue.shift();
            netActive++;
            t.resolve();
        }
    }

    function netRelease() {
        netActive = Math.max(0, netActive - 1);
        netPump();
    }

    /**
     * 拉取整个文件（多分片并发合并）
     *
     * ★ 并发而非串行：一个 10MB 文件切成 10 片，串行要等 10 个 RTT，
     *   并发 6 路只要 2 轮。这是预览体验里最影响"点了多久才出来"的一环。
     *
     * ★ 但并发数不能太高：GitHub 对单 token 有速率限制，并发 20 路
     *   很容易触发 403 secondary rate limit，反而更慢。
     *
     * ★ 进度按【字节】而不是【分片数】：RAW 是流式的，2.4MB 的图在第
     *   一片还没下完时就有反馈了，干等一句「正在读取…」才是最难受的。
     */
    async function fetchFile(api, fileInfo, onProgress, signal, onPartial, opts) {
        opts = opts || {};
        const chunks = fileInfo.chunks || [];
        if (!chunks.length) throw new Error('分片信息缺失');

        const CONC = Math.min(6, chunks.length);
        const prio = opts.priority || (() => 1);
        const expected = fileInfo.size || 0;
        const mime = TPRender.mimeOf(fileInfo.name);
        const parts = new Array(chunks.length);
        const got = new Array(chunks.length).fill(0);
        let done = 0;
        let idx = 0;
        let lastPrefix = 0;

        function report() {
            if (!onProgress) return;
            const loaded = got.reduce((a, b) => a + b, 0);
            onProgress({ phase: 'net', loaded, total: expected || loaded,
                         done, count: chunks.length });
        }

        /**
         * 连续前缀到齐就交给上层试着先画一帧。
         * 分片本来就是按原文件顺序切的，所以 parts[0..k) 拼起来就是原文件
         * 的前 k 段字节。baseline JPEG 被截断时 Chromium 会按已解码的扫描行
         * 渲染出上半部分（实测 1/3 片 → 33%，2/3 片 → 66%），尺寸仍正确。
         */
        function tryPartial() {
            // 纯后台预取没有渐进帧接收方，别白做一次全量前缀拼接
            if (!onPartial || (opts.wantPartial && !opts.wantPartial())) return;
            let k = 0;
            while (k < parts.length && parts[k]) k++;
            if (k <= lastPrefix || k >= parts.length) return;
            lastPrefix = k;
            const head = parts.slice(0, k);
            const n = head.reduce((s, p) => s + p.length, 0);
            const merged = new Uint8Array(n);
            let off = 0;
            for (const p of head) { merged.set(p, off); off += p.length; }
            try { onPartial(new Blob([merged], { type: mime }), k, parts.length); }
            catch (e) { /* 渐进帧失败不影响主下载 */ }
        }

        async function worker() {
            while (idx < chunks.length) {
                const i = idx++;
                const c = chunks[i];
                // 纯预取在用户正在打开文件期间让出带宽；一旦被点开，
                // priority 会升到 1，这个等待立刻结束。
                while (prio() === 0 && opts.paused && opts.paused()) {
                    await new Promise(r => setTimeout(r, 80));
                }
                await netAcquire(prio);
                try {
                    parts[i] = await api.getBlobBytes(c.owner, c.repo, c.sha, {
                        signal,
                        onBytes: (n) => { got[i] = n; report(); }
                    });
                } finally {
                    netRelease();
                }
                done++;
                got[i] = parts[i].length;
                report();
                tryPartial();
            }
        }
        await Promise.all(Array.from({ length: CONC }, worker));

        const total = parts.reduce((s, p) => s + (p ? p.length : 0), 0);
        if (total === 0) throw new Error('文件内容为空');
        const merged = new Uint8Array(total);
        let off = 0;
        for (const p of parts) { merged.set(p, off); off += p.length; }
        return new Blob([merged], { type: TPRender.mimeOf(fileInfo.name) });
    }

    // ==================== 预览缓存 ====================
    /**
     * 三级：内存 → IndexedDB → 网络。
     *
     * ★ 为什么必须用内容寻址的 key：
     *   路径能改名、能移动，但分片 sha 只在内容变了才变。用 sha 串做 key，
     *   重命名后缓存仍然命中；反过来，文件被覆盖上传后 key 也跟着变，
     *   绝不会把旧内容显示成新文件。
     *
     * ★ 为什么既存内存又存 IndexedDB：
     *   内存命中是 0 等待（同一会话反复翻图）；IndexedDB 能跨刷新、跨标签页，
     *   且 Blob 可以直接结构化克隆进去，不用再转 base64。
     *   隐私模式 / 配额不足时 IDB 会失败，全链路降级成纯内存，不影响功能。
     *
     * ★ inflight 去重：预取到一半用户点了同一个文件，复用同一个 Promise，
     *   既不重复发请求，进度也会广播给所有等待者。
     */
    const DB_NAME = 'gd_thousand_blob';
    const DB_STORE = 'blobs';
    const CACHE_MAX_BYTES = 96 * 1024 * 1024;
    const CACHE_MAX_ITEMS = 40;
    const MEM_MAX_BYTES = 32 * 1024 * 1024;

    const memCache = new Map();     // key -> Blob（Map 顺序即 LRU）
    const inflight = new Map();     // key -> { promise, cbs }
    let dbPromise = null;

    function openDB() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise(resolve => {
            try {
                const req = indexedDB.open(DB_NAME, 1);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains(DB_STORE)) {
                        const os = db.createObjectStore(DB_STORE, { keyPath: 'key' });
                        os.createIndex('at', 'at');
                    }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => resolve(null);
                req.onblocked = () => resolve(null);
            } catch (e) { resolve(null); }
        });
        return dbPromise;
    }

    function idbGet(key) {
        return openDB().then(db => {
            if (!db) return null;
            return new Promise(resolve => {
                try {
                    const r = db.transaction(DB_STORE, 'readonly')
                        .objectStore(DB_STORE).get(key);
                    r.onsuccess = () => resolve(r.result ? r.result.blob : null);
                    r.onerror = () => resolve(null);
                } catch (e) { resolve(null); }
            });
        }).catch(() => null);
    }

    function idbPut(key, blob) {
        return openDB().then(db => {
            if (!db) return;
            return new Promise(resolve => {
                try {
                    const tx = db.transaction(DB_STORE, 'readwrite');
                    tx.objectStore(DB_STORE).put({
                        key, blob, size: blob.size, at: Date.now()
                    });
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => resolve();
                    tx.onabort = () => resolve();
                } catch (e) { resolve(); }
            });
        }).catch(() => {});
    }

    /**
     * 命中即刷新「最近使用」时间戳。
     * 不刷新的话，LRU 是按写入时间排的：天天看的那个文件反而最老，
     * 缓存一满就被 trim 掉，等于把最该留的删了。
     */
    function idbTouch(key) {
        return openDB().then(db => {
            if (!db) return;
            return new Promise(resolve => {
                try {
                    const tx = db.transaction(DB_STORE, 'readwrite');
                    const os = tx.objectStore(DB_STORE);
                    const r = os.get(key);
                    r.onsuccess = () => {
                        if (r.result) { r.result.at = Date.now(); os.put(r.result); }
                    };
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => resolve();
                    tx.onabort = () => resolve();
                } catch (e) { resolve(); }
            });
        }).catch(() => {});
    }

    /** 预取一次会连写 6 个文件，别跟着全表扫 6 次 */
    let trimTimer = null;
    let trimPending = false;
    function scheduleTrim() {
        if (trimPending) return;
        trimPending = true;
        clearTimeout(trimTimer);
        trimTimer = setTimeout(() => {
            trimPending = false;
            idbTrim().catch(() => {});
        }, 1200);
    }

    /** 超配额时按时间从老到新删，不让缓存把浏览器存储撑爆 */
    function idbTrim() {
        return openDB().then(db => {
            if (!db) return;
            return new Promise(resolve => {
                try {
                    const tx = db.transaction(DB_STORE, 'readwrite');
                    const os = tx.objectStore(DB_STORE);
                    const rows = [];
                    const req = os.index('at').openCursor();
                    req.onsuccess = (ev) => {
                        const cur = ev.target.result;
                        if (cur) {
                            rows.push({ key: cur.primaryKey, size: cur.value.size });
                            cur.continue();
                        } else {
                            let total = rows.reduce((s, r) => s + r.size, 0);
                            let n = rows.length;
                            for (const r of rows) {
                                if (total <= CACHE_MAX_BYTES && n <= CACHE_MAX_ITEMS) break;
                                os.delete(r.key);
                                total -= r.size;
                                n--;
                            }
                            resolve();
                        }
                    };
                    req.onerror = () => resolve();
                    tx.onabort = () => resolve();
                } catch (e) { resolve(); }
            });
        }).catch(() => {});
    }

    function cacheStats() {
        return openDB().then(db => {
            if (!db) return { count: 0, bytes: 0 };
            return new Promise(resolve => {
                try {
                    const rows = [];
                    const req = db.transaction(DB_STORE, 'readonly')
                        .objectStore(DB_STORE).openCursor();
                    req.onsuccess = (ev) => {
                        const cur = ev.target.result;
                        if (cur) { rows.push(cur.value.size); cur.continue(); }
                        else resolve({ count: rows.length,
                                       bytes: rows.reduce((a, b) => a + b, 0) });
                    };
                    req.onerror = () => resolve({ count: 0, bytes: 0 });
                } catch (e) { resolve({ count: 0, bytes: 0 }); }
            });
        }).catch(() => ({ count: 0, bytes: 0 }));
    }

    function clearPreviewCache() {
        memCache.clear();
        return openDB().then(db => {
            if (!db) return;
            return new Promise(resolve => {
                try {
                    const tx = db.transaction(DB_STORE, 'readwrite');
                    tx.objectStore(DB_STORE).clear();
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => resolve();
                    tx.onabort = () => resolve();
                } catch (e) { resolve(); }
            });
        }).catch(() => {});
    }

    function cacheKey(f) {
        const cs = f.chunks || [];
        return 'v1:' + cs.map(c => c.sha || '').join('_') +
               ':' + cs.length + ':' + (f.size || 0);
    }

    function rememberMem(key, blob) {
        memCache.delete(key);       // 重新插入，刷新 LRU 位置
        memCache.set(key, blob);
        let sum = 0;
        for (const b of memCache.values()) sum += b.size;
        while (sum > MEM_MAX_BYTES && memCache.size > 1) {
            const oldest = memCache.keys().next().value;
            const b = memCache.get(oldest);
            memCache.delete(oldest);
            sum -= b.size;
        }
    }

    function getFileBlob(api, f, onProgress, opts) {
        opts = opts || {};
        const key = cacheKey(f);
        // 1 = 用户正在打开，0 = 后台预取。默认按前台处理。
        const prio = opts.priority != null ? opts.priority : 1;

        const hit = memCache.get(key);
        if (hit) {
            if (onProgress) onProgress({ phase: 'mem', pct: 1 });
            return Promise.resolve(hit);
        }
        if (inflight.has(key)) {
            const e = inflight.get(key);
            // 预取跑到一半被点开：提升优先级，队列里剩余分片马上插队
            if (prio > e.priority) e.priority = prio;
            if (onProgress) e.cbs.add(onProgress);
            if (opts.onPartial) e.partials.add(opts.onPartial);
            return e.promise;
        }

        const cbs = new Set();
        if (onProgress) cbs.add(onProgress);
        const emit = (p) => { cbs.forEach(cb => { try { cb(p); } catch (e) {} }); };
        const partials = new Set();
        if (opts.onPartial) partials.add(opts.onPartial);
        const emitPartial = (blob, k, n) => {
            partials.forEach(fn => { try { fn(blob, k, n); } catch (e) {} });
        };
        const entry = { promise: null, cbs, partials, priority: prio };
        inflight.set(key, entry);

        const p = (async () => {
            const disk = await idbGet(key);
            if (disk) {
                rememberMem(key, disk);
                idbTouch(key).catch(() => {});   // 刷新 LRU，别把常看的淘汰掉
                emit({ phase: 'disk', pct: 1 });
                return disk;
            }
            const blob = await fetchFile(api, f, emit, opts.signal, emitPartial, {
                priority: () => entry.priority,
                wantPartial: () => partials.size > 0,
                paused: () => app.prefetchPaused,
            });
            rememberMem(key, blob);
            // 不 await：写盘不该挡住首屏渲染
            idbPut(key, blob).then(scheduleTrim).catch(() => {});
            return blob;
        })();
        entry.promise = p;
        const clean = () => {
            if (inflight.get(key) === entry) inflight.delete(key);
            cbs.clear();
            partials.clear();
        };
        p.then(clean, clean);
        return p;
    }

    // ==================== 空闲预取 ====================
    /**
     * 列表渲染完，趁用户还在看文件名，把当前目录里最可能点开的几个文件
     * 悄悄拉进缓存。点开时直接命中，等于把网络等待从「点击之后」挪到
     * 「点击之前」—— 这是体感上最有效的一招。
     *
     * 严格限流：单文件 ≤3MB、总量 ≤10MB、最多 6 个、串行 1 路，
     * 且用户正在打开文件时暂停。不会为了预取把 API 额度或带宽吃光。
     */
    const PREFETCH_MAX_FILE = 3 * 1024 * 1024;
    const PREFETCH_BUDGET = 10 * 1024 * 1024;
    const PREFETCH_FAIL_COOLDOWN = 60 * 1000;
    const prefetchFailed = new Map();   // key -> 上次失败时刻
    let prefetchGen = 0;
    let prefetchTimer = null;
    let hoverTimer = null;

    function prefetchOne(f) {
        // 鼠标划过列表这路预取原本没看这个开关：用户正在打开大图时，
        // 手指/光标带过几行就会再起几组下载，正好把当前文件挤慢。
        if (app.prefetchPaused) return;
        if (!app.api || !f || f.isDir || !f.size || f.size > PREFETCH_MAX_FILE) return;
        const key = cacheKey(f);
        const failedAt = prefetchFailed.get(key);
        // 分片被删 / token 没权限这类失败是稳定的：每次 renderList 都
        // 重新预取一遍，只会不停刷 404，还占掉正常预取的队列位置。
        if (failedAt && Date.now() - failedAt < PREFETCH_FAIL_COOLDOWN) return;
        if (memCache.has(key) || inflight.has(key)) return;
        return getFileBlob(app.api, f, null, { priority: 0 }).then(
            () => prefetchFailed.delete(key),
            () => prefetchFailed.set(key, Date.now()));
    }

    function schedulePrefetch() {
        const my = ++prefetchGen;
        if (prefetchTimer) clearTimeout(prefetchTimer);
        prefetchTimer = setTimeout(() => {
            if (my !== prefetchGen || !app.api || app.current) return;
            const e = entriesOf(app.dir);
            let budget = PREFETCH_BUDGET;
            const queue = [];
            for (const f of e.files) {
                if (queue.length >= 6 || budget <= 0) break;
                if (!f.size || f.size > PREFETCH_MAX_FILE || f.size > budget) continue;
                const key = cacheKey(f);
                if (memCache.has(key) || inflight.has(key)) continue;
                const failedAt = prefetchFailed.get(key);
                if (failedAt && Date.now() - failedAt < PREFETCH_FAIL_COOLDOWN) continue;
                budget -= f.size;
                queue.push(f);
            }
            (async () => {
                for (const f of queue) {
                    if (my !== prefetchGen) return;
                    while (app.prefetchPaused) await new Promise(r => setTimeout(r, 100));
                    await prefetchOne(f);
                    await new Promise(r => setTimeout(r, 40));
                }
            })();
        }, 300);
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
            // 桌面端鼠标移上去到真正点击，通常有几百毫秒，够把小文件拉完。
            // 移动端 pointerenter 也会触发，但此时多半已经点开，正好复用 inflight。
            row.addEventListener('pointerenter', () => {
                if (it.isDir) return;
                clearTimeout(hoverTimer);
                hoverTimer = setTimeout(() => prefetchOne(it), 160);
            });
            row.addEventListener('pointerleave', () => clearTimeout(hoverTimer));
            frag.appendChild(row);
        }
        box.appendChild(frag);
        schedulePrefetch();
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
        // 先过滤再截断：原来先取 6 条再过滤，前面几条恰好是已删文件时，
        // 卡片会莫名变少，即使后面还躺着一堆有效记录
        const alive = TPStore.getHistory().filter(h =>
            app.files.some(f => TPStore.fingerprint(f) === h.fingerprint)).slice(0, 6);
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

    function showLoading() {
        $('#tp-body').innerHTML =
            '<div class="tp-loading tp-loadbox">' +
              '<div class="tp-load-title">' +
                '<span id="tp-load-word">正在读取…</span>' +
                '<span id="tp-load-pct">0%</span>' +
              '</div>' +
              '<div class="tp-load-bar"><i id="tp-load-fill"></i></div>' +
              '<div class="tp-load-sub" id="tp-load-sub">准备中…</div>' +
            '</div>';
    }

    function updateLoading(p) {
        const fill = $('#tp-load-fill');
        if (!fill) {
            // 渐进首帧把加载框整个替换掉了，但后面还有分片在下载：
            // 不能让百分比就此消失，改更新图片下方那条细条。
            if (p.phase === 'net') {
                const pfill = $('#tp-partial-bar i');
                const ppct = $('#tp-partial-pct');
                if (pfill && ppct) {
                    const v = p.total ? Math.min(100, Math.round(p.loaded / p.total * 100)) : 0;
                    pfill.style.width = v + '%';
                    ppct.textContent = p.done + ' / ' + p.count + ' 片 · ' + v + '%';
                }
            }
            return;
        }
        const pctEl = $('#tp-load-pct');
        const sub = $('#tp-load-sub');
        if (p.phase === 'mem' || p.phase === 'disk') {
            $('#tp-load-word').textContent = p.phase === 'mem' ? '内存命中' : '本地缓存命中';
            pctEl.textContent = '100%';
            fill.style.width = '100%';
            sub.textContent = '无需联网，直接打开';
            return;
        }
        const pctv = p.total ? Math.min(100, Math.round(p.loaded / p.total * 100)) : 0;
        fill.style.width = pctv + '%';
        pctEl.textContent = pctv + '%';
        sub.textContent = p.done + ' / ' + p.count + ' 片 · ' +
            TPRender.fmtSize(p.loaded) +
            (p.total ? ' / ' + TPRender.fmtSize(p.total) : '');
    }

    async function openFile(f) {
        const my = ++openToken;
        // 直接从列表点开下一个文件时，先撤掉上一个文件的滚动 / pagehide /
        // 可见性监听和定时器。否则旧闭包会带着旧 fingerprint 继续写进度，
        // 把新文件的阅读位置串到旧档里，监听器还会一次滚动触发 N 次写盘。
        if (app._cleanupScroll) { app._cleanupScroll(); app._cleanupScroll = null; }
        app.current = f;

        $('#tp-view').classList.add('open');
        $('#tp-view-title').textContent = f.name;
        showLoading();
        renderList();
        app.prefetchPaused = true;

        /**
         * 渐进首帧：第一片到齐就先把上 1/3 画出来，后面每多一片就补一段。
         * 只对多分片 JPEG 开 —— baseline JPEG 截断时 Chromium 能按已解码的
         * 扫描行渲染（实测 1/3 片→33%、2/3 片→66%，尺寸仍正确）；
         * PNG/WebP/GIF 截断会直接解码失败，开了只会闪一张坏图。
         */
        const canPartial = f.chunks && f.chunks.length > 1 &&
            f.kind === 'image' && /\.jpe?g$/i.test(f.name);
        const partialUrls = [];
        let finished = false;
        let partialWrap = null, partialImg = null, partialTag = null, lastLabel = '';

        function showPartial(pblob, k, n) {
            if (!canPartial || finished || my !== openToken) return;
            if (!$('#tp-view').classList.contains('open')) return;
            const label = '已载入 ' + k + '/' + n + ' 片 · 继续加载中…';
            // 文案不挂在 probe.onload 里：截断 JPEG 的解码回调可能延迟到
            // 下一帧之后才触发，旧帧会把已经更新的「2/3」覆盖回「1/3」。
            lastLabel = label;
            if (partialTag) partialTag.textContent = label;
            const url = URL.createObjectURL(pblob);
            partialUrls.push(url);
            const probe = new Image();
            probe.onload = () => {
                if (finished || my !== openToken || probe.naturalHeight <= 0) return;
                if (!$('#tp-view').classList.contains('open')) return;
                if (!partialWrap) {
                    $('#tp-body').innerHTML = '';
                    partialWrap = document.createElement('div');
                    partialWrap.className = 'tp-image-wrap tp-image-partial';
                    // 直接用已经解码完成的 probe，不再新建 img 重新解码一次，
                    // 否则首帧会先白一下再出内容
                    partialImg = probe;
                    partialImg.alt = f.name;
                    partialTag = document.createElement('div');
                    partialTag.className = 'tp-partial-tag';
                    partialTag.textContent = lastLabel;
                    // 加载框已被替换，进度不能跟着断：在图片下方留一条细条，
                    // 由 updateLoading 继续喂真实字节百分比
                    const bar = document.createElement('div');
                    bar.className = 'tp-load-bar tp-partial-bar';
                    bar.id = 'tp-partial-bar';
                    bar.innerHTML = '<i></i>';
                    const pct = document.createElement('div');
                    pct.className = 'tp-partial-pct';
                    pct.id = 'tp-partial-pct';
                    partialWrap.appendChild(partialImg);
                    partialWrap.appendChild(partialTag);
                    partialWrap.appendChild(bar);
                    partialWrap.appendChild(pct);
                    $('#tp-body').appendChild(partialWrap);
                } else {
                    partialImg.src = url;
                }
                // 旧帧的 onload 可能晚于下一片抵达才触发，这里必须写
                // 最新的 lastLabel，否则会把已经更新的「2/3」盖回「1/3」
                partialTag.textContent = lastLabel;
            };
            probe.onerror = () => {};
            probe.src = url;
        }

        try {
            const blob = await getFileBlob(app.api, f, (p) => {
                if (my !== openToken) return;
                updateLoading(p);
            }, { onPartial: showPartial, priority: 1 });
            if (my !== openToken) return;   // 期间用户点了别的文件，丢弃这次结果

            if (app.handle && app.handle.destroy) app.handle.destroy();
            app.handle = null;

            finished = true;
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
        } finally {
            partialUrls.forEach(u => URL.revokeObjectURL(u));
            partialUrls.length = 0;
            if (my === openToken) app.prefetchPaused = false;
        }
    }

    /**
     * 渲染失败后的补救下载
     *
     * 失败原因是渲染组件没加载好，文件字节其实是好的，所以直接走缓存，
     * 不必再联网重下一遍。
     */
    async function retryDownload(f) {
        try {
            const blob = await getFileBlob(app.api, f);
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
            // 旧闭包可能还挂在上一个文件上：拿旧 fingerprint 配新文件的
            // 位置写回去，就会把两个文件的阅读进度串在一起。
            if (!app.current || TPStore.fingerprint(app.current) !== fp) return;
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
        // 必须是命名函数：匿名监听没法 remove，每打开一个文件就多留一个
        const onVis = () => { if (document.hidden) saveNow(); };
        window.addEventListener('pagehide', saveNow);
        document.addEventListener('visibilitychange', onVis);
        app._cleanupScroll = () => {
            body.removeEventListener('scroll', onScroll);
            window.removeEventListener('pagehide', saveNow);
            document.removeEventListener('visibilitychange', onVis);
            clearTimeout(idleTimer);
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

    async function updateCacheInfo() {
        const el = $('#tp-cache-info');
        if (!el) return;
        el.textContent = '统计中…';
        const s = await cacheStats();
        el.textContent = s.count
            ? s.count + ' 个 · ' + TPRender.fmtSize(s.bytes)
            : '空';
    }

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
        // 控件回显：主题下拉原本永远是「跟随系统」、记住位置永远不勾，
        // 而 store 里默认是 true。改过设置再打开面板会以为没生效。
        const themeSel = $('#tp-theme');
        if (themeSel) themeSel.value = theme;
        const remember = $('#tp-remember');
        if (remember) remember.checked = !!s.rememberPosition;
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
            if (e.key !== 'Escape') return;
            const t = e.target;
            // 焦点在输入框里时 Esc 交给输入框自己（清空搜索），别顺手关掉阅读区
            if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' ||
                      t.isContentEditable)) return;
            if ($('#tp-settings').classList.contains('show')) {
                $('#tp-settings').classList.remove('show');
                return;
            }
            if ($('#tp-view').classList.contains('open')) closeView();
        });

        // 登录框提交
        $('#tp-login-go').addEventListener('click', submitLogin);
        $('#tp-login-token').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submitLogin();
        });

        // 设置面板
        $('#tp-set-toggle').addEventListener('click', () => {
            $('#tp-settings').classList.toggle('show');
            updateCacheInfo();
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
        const clearCacheBtn = $('#tp-clear-cache');
        if (clearCacheBtn) {
            clearCacheBtn.addEventListener('click', async () => {
                clearCacheBtn.disabled = true;
                await clearPreviewCache();
                clearCacheBtn.disabled = false;
                updateCacheInfo();
            });
        }
        updateCacheInfo();
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
