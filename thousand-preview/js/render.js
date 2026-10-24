/**
 * 千览 · 渲染层
 *
 * 每种文件类型一个渲染器，统一接口：
 *
 *     render(blob, fileInfo, container, opts) -> Promise<{
 *         savePosition: () => object | null,     // 采集当前阅读位置
 *         restorePosition: (pos) => void,        // 恢复到指定位置
 *         destroy: () => void                    // 切换文件时清理
 *     }>
 *
 * ★ 位置为什么分两种形态：
 *
 *   PDF 是分页的 → 记 { page, offsetInPage }，靠 PDF.js 定位
 *   其他都是连续滚动 → 记 { ratio }（滚动百分比），靠 scrollTop 还原
 *
 *   混用会出问题：给 PDF 记 ratio，换个窗口宽度重排后 ratio 指向的
 *   内容就变了；给长文记 page，文本根本没有"页"的概念。
 *
 * ★ 第三方库全部走 CDN 且按需加载：
 *
 *   PDF.js + mammoth 加起来 1MB+，首屏不需要它们。只有真的要预览
 *   PDF 时才去下载。加载失败不报错崩溃，降级到"下载后用本地软件打开"。
 */
(function () {
    'use strict';

    /**
     * 每个库给多个源，按顺序尝试。
     *
     * ★ 为什么不能只写一个 CDN：
     *   jsDelivr 在国内偶尔抽风，而 PDF.js / mammoth 是 PDF 和 Word 预览
     *   的【唯一】实现路径 —— 它一挂，这两类文件就完全打不开。
     *   多写两个源的成本是几行代码，收益是这类故障从"完全不可用"
     *   变成"换条路继续"。unpkg 和 jsdelivr 不是同一家，同时挂的概率很低。
     *
     * 版本号全部写死：上游发新版本可能改 API，自动跟最新版等于把
     * 稳定性交给别人。
     */
    const CDN = {
        pdfjs: [
            'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
            'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js',
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
        ],
        pdfjsWorker: [
            'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
            'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
        ],
        mammoth: [
            'https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js',
            'https://unpkg.com/mammoth@1.6.0/mammoth.browser.min.js',
        ],
        xlsx: [
            'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
            'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js',
        ],
    };

    const libCache = {};

    function loadOne(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.onload = () => resolve(src);
            // ★ 失败必须移除 <script> 节点，否则 DOM 里越堆越多死标签
            s.onerror = () => { s.remove(); reject(new Error(src)); };
            document.head.appendChild(s);
        });
    }

    /**
     * 按源顺序加载，第一个成功就返回
     * @param {string} key - CDN 里的键
     * @param {Function} [ready] - 判断全局符号是否就绪（脚本加载完不代表已执行完）
     */
    function loadScript(key, ready) {
        if (libCache[key]) return libCache[key];
        const sources = CDN[key] || [];
        libCache[key] = (async () => {
            const failed = [];
            for (const src of sources) {
                try {
                    await loadOne(src);
                    // 有些 CDN 返回 200 但内容是错误页，所以还要验符号
                    if (ready && !ready()) { failed.push(src + '（脚本已加载但符号缺失）'); continue; }
                    return src;
                } catch (e) {
                    failed.push(src);
                }
            }
            const err = new Error('全部 CDN 均不可用：' + failed.join(' / '));
            err.cdnFailed = true;
            throw err;
        })();
        return libCache[key];
    }

    function ext(name) {
        return String(name || '').split('.').pop().toLowerCase();
    }

    function fmtSize(n) {
        if (!n) return '0 B';
        const u = ['B', 'KB', 'MB', 'GB'];
        let i = 0;
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
        return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
    }

    // 简易 HTML 转义。文件名来自用户仓库，可能含 < > &，
    // 拼进 innerHTML 之前必须过这一道，否则一个文件名就能注入。
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ==================== 文本类 ====================

    const TEXT_EXT = ['txt', 'md', 'markdown', 'json', 'js', 'ts', 'jsx', 'tsx',
        'css', 'html', 'htm', 'xml', 'yaml', 'yml', 'ini', 'conf', 'toml',
        'py', 'java', 'c', 'h', 'cpp', 'cc', 'go', 'rs', 'rb', 'php', 'sh',
        'bat', 'sql', 'log', 'csv', 'tex', 'vue', 'swift', 'kt', 'scala', 'r'];

    /**
     * 解码文本：UTF-8 优先，失败退 GBK。
     *
     * 中文 Windows 生成的 txt 很多是 GBK，用 UTF-8 严格模式解会抛异常，
     * 不带 fatal 又只会得到一堆替换字符 —— 那还不如明确地退到 GBK。
     */
    function decodeText(buf) {
        try {
            return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), enc: 'UTF-8' };
        } catch { /* 不是 UTF-8，往下试 */ }
        try {
            return { text: new TextDecoder('gbk').decode(buf), enc: 'GBK' };
        } catch { /* 浏览器不支持 GBK */ }
        return { text: new TextDecoder('utf-8').decode(buf), enc: '未知' };
    }

    function renderText(blob, container, opts) {
        return blob.arrayBuffer().then(buf => {
            const d = decodeText(buf);
            const el = document.createElement('div');
            el.className = 'tp-text';
            el.textContent = d.text;

            const bar = document.createElement('div');
            bar.className = 'tp-metabar';
            bar.textContent = d.enc + ' · ' + fmtSize(blob.size) + ' · ' +
                d.text.split('\n').length + ' 行';
            container.innerHTML = '';
            container.appendChild(bar);
            container.appendChild(el);

            return {
                savePosition: () => ({ ratio: scrollRatio(container) }),
                restorePosition: (pos) => applyRatio(container, pos && pos.ratio),
                destroy: () => {},
            };
        });
    }

    function scrollRatio(el) {
        const max = el.scrollHeight - el.clientHeight;
        return max <= 0 ? 0 : Math.min(1, Math.max(0, el.scrollTop / max));
    }

    function applyRatio(el, ratio) {
        if (typeof ratio !== 'number' || !isFinite(ratio)) return;
        const max = el.scrollHeight - el.clientHeight;
        if (max <= 0) return;
        el.scrollTop = max * ratio;
    }

    // ==================== 图片 ====================

    const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'avif'];

    function renderImage(blob, container, fileInfo) {
        const url = URL.createObjectURL(blob);
        const wrap = document.createElement('div');
        wrap.className = 'tp-image-wrap';
        const img = document.createElement('img');
        img.src = url;
        img.alt = fileInfo.name;
        wrap.appendChild(img);
        container.innerHTML = '';
        container.appendChild(wrap);
        return Promise.resolve({
            savePosition: () => ({ ratio: scrollRatio(container) }),
            restorePosition: (pos) => applyRatio(container, pos && pos.ratio),
            destroy: () => URL.revokeObjectURL(url),
        });
    }

    // ==================== PDF ====================

    function renderPdf(blob, container, opts) {
        return loadScript('pdfjs', () => !!window.pdfjsLib).then(usedSrc => {
            const pdfjs = window.pdfjsLib;
            if (!pdfjs) throw new Error('PDF.js 未就绪');
            // ★ worker 必须和 pdf.js 来自同一个 CDN。
            //   混着用（主库 jsdelivr + worker unpkg）会触发跨域 worker 的
            //   限制，而且两边版本哪怕差一个小号也可能协议不匹配。
            const i = Math.max(0, CDN.pdfjs.indexOf(usedSrc));
            pdfjs.GlobalWorkerOptions.workerSrc = CDN.pdfjsWorker[i];

            // 必须复制一份：PDF.js 会在内部 transfer 这个 ArrayBuffer，
            // 之后原 buffer 变成 detached（byteLength=0）。如果外面还要
            // 拿同一个 buffer 做别的事，就会拿到空的。
            //
            // ★ 关于"一次性全加载"
            //   数据源是 GitHub 的 git/blobs，不支持 HTTP Range，
            //   所以文件本身只能整份下载 —— 做不到边看边下。
            //   真正的懒加载在页面这一层：一次只渲染当前页，
            //   只预取前后各一页，缓存上限 12 页（见 drawPage/cachePut）。
            //   大文件把等待感摊开：先给一句实在的体积提示，别让用户干等。
            return blob.arrayBuffer().then(ab => {
                const mb = ab.byteLength / 1048576;
                if (mb > 12 && opts && opts.onBigFile) {
                    opts.onBigFile(mb);
                }
                return pdfjs.getDocument({ data: ab.slice(0) }).promise;
            });
        }).then(pdf => {
            container.innerHTML = '';

            const bar = document.createElement('div');
            bar.className = 'tp-pdfbar';
            const label = document.createElement('span');
            label.className = 'tp-pdf-label';
            const prev = document.createElement('button');
            const next = document.createElement('button');
            prev.className = next.className = 'tp-btn tp-btn-sm';
            prev.textContent = '上一页';
            next.textContent = '下一页';
            const jump = document.createElement('input');
            jump.type = 'number';
            jump.min = '1';
            jump.className = 'tp-page-input';
            bar.appendChild(prev);
            bar.appendChild(jump);
            bar.appendChild(label);
            bar.appendChild(next);
            container.appendChild(bar);

            const stage = document.createElement('div');
            stage.className = 'tp-pdf-stage';
            container.appendChild(stage);

            let page = 1;
            let rendering = false;
            let pending = null;

            /**
             * 已渲染页的缓存：页号 → canvas。
             *
             * ★ 为什么必须缓存
             *   原来每次翻页都重新 getPage + render，往回翻一页要再解析一遍
             *   同样的内容。PDF 解析是重活（文字定位、字体、矢量图），
             *   几百页的文档来回翻会明显卡顿。
             *
             * ★ 为什么要有上限（LRU）
             *   一页 canvas 在 2x 屏上轻易几 MB（宽 × 高 × 4 × dpr²）。
             *   无上限缓存一本 500 页的 PDF 会直接把标签页拖垮。
             *   12 页足够覆盖"前后翻几页"的真实行为，再多就是浪费。
             */
            const CACHE_MAX = 12;
            const cache = new Map();

            function cachePut(p, cv) {
                cache.set(p, cv);
                // Map 的迭代顺序就是插入顺序，删最老的即可
                while (cache.size > CACHE_MAX) {
                    cache.delete(cache.keys().next().value);
                }
            }

            function updateLabel() {
                label.textContent = '/ ' + pdf.numPages;
                jump.value = page;
                prev.disabled = page <= 1;
                next.disabled = page >= pdf.numPages;
            }

            function drawPage(p) {
                return pdf.getPage(p).then(pg => {
                    const wrapW = stage.clientWidth || 800;
                    const base = pg.getViewport({ scale: 1 });
                    // 按容器宽度自适应，scale 上限 3 避免超大屏上糊成一团像素
                    const scale = Math.min(3, wrapW / base.width);
                    const vp = pg.getViewport({ scale });

                    const canvas = document.createElement('canvas');
                    canvas.className = 'tp-pdf-canvas';
                    const ctx = canvas.getContext('2d');
                    // 高分屏必须按 dpr 放大，否则文字边缘发虚
                    const dpr = window.devicePixelRatio || 1;
                    canvas.width = Math.floor(vp.width * dpr);
                    canvas.height = Math.floor(vp.height * dpr);
                    canvas.style.width = vp.width + 'px';
                    canvas.style.height = vp.height + 'px';
                    ctx.scale(dpr, dpr);

                    return pg.render({ canvasContext: ctx, viewport: vp })
                        .promise.then(() => pg.cleanup ? (pg.cleanup(), canvas) : canvas);
                });
            }

            /** 把某一页显示到舞台（从缓存取，或直接放上去） */
            function paint(cv) {
                stage.innerHTML = '';
                stage.appendChild(cv);
            }

            /**
             * 预取相邻页。
             *
             * ★ 独立的 pfBusy，不占用 rendering 锁：
             *   预取是"顺便做的"，绝不能挡住用户翻页。两者画的是不同的
             *   canvas，PDF.js 允许并发渲染不同目标，不会冲突。
             *   延迟 150ms 是为了连续翻页时不浪费算力在中间页上。
             */
            const prefetching = new Set();
            let pfTimer = null;

            function schedulePrefetch(cur) {
                clearTimeout(pfTimer);
                pfTimer = setTimeout(() => {
                    [cur + 1, cur - 1].forEach(q => {
                        if (q < 1 || q > pdf.numPages) return;
                        if (cache.has(q) || prefetching.has(q)) return;
                        prefetching.add(q);
                        drawPage(q).then(cv => {
                            prefetching.delete(q);
                            cachePut(q, cv);
                        }).catch(() => prefetching.delete(q));
                    });
                }, 150);
            }

            /**
             * 渲染某一页。
             *
             * ★ rendering 锁是必须的：快速连点翻页会并发起多个 render()，
             *   PDF.js 对同一个 canvas 并发渲染会抛错，且页面顺序可能错乱。
             *   有锁时记录 pending（最后一次请求），渲染完立刻补上，
             *   既不会并发，也不会丢掉用户的最后一次操作。
             */
            function show(p) {
                p = Math.min(Math.max(1, p), pdf.numPages);
                if (rendering) { pending = p; return; }
                page = p;
                updateLabel();

                const hit = cache.get(p);
                if (hit) {
                    paint(hit);
                    schedulePrefetch(p);
                    return Promise.resolve();
                }

                rendering = true;
                return drawPage(p).then(cv => {
                    cachePut(p, cv);
                    paint(cv);
                    rendering = false;
                    schedulePrefetch(p);
                    if (pending != null) {
                        const q = pending; pending = null;
                        if (q !== page) return show(q);
                    }
                }).catch(() => { rendering = false; });
            }

            prev.onclick = () => show(page - 1);
            next.onclick = () => show(page + 1);
            jump.onchange = () => show(parseInt(jump.value, 10) || 1);

            // 键盘翻页：只在 PDF 视图接管，避免抢走搜索框的按键
            function onKey(e) {
                if (document.activeElement === jump) return;
                if (e.key === 'ArrowLeft' || e.key === 'PageUp') { show(page - 1); e.preventDefault(); }
                if (e.key === 'ArrowRight' || e.key === 'PageDown') { show(page + 1); e.preventDefault(); }
            }
            document.addEventListener('keydown', onKey);

            updateLabel();
            return show(1).then(() => ({
                // ★ 必须带上 total。
                //   只存 page 的话，上层算"读了多少"时没有分母，
                //   会拿页码当百分比 —— 第 5 页变成 500%。
                savePosition: () => ({ page, total: pdf.numPages }),
                restorePosition: (pos) => { if (pos && pos.page) show(pos.page); },
                destroy: () => {
                    document.removeEventListener('keydown', onKey);
                    clearTimeout(pfTimer);
                    // ★ 缓存里的 canvas 不释放会一直占着显存/内存。
                    //   切走一个 200 页的 PDF 后它们没有任何用处，
                    //   但浏览器不会替你回收（canvas 元素仍被 Map 引用）。
                    cache.forEach(cv => {
                        cv.width = cv.height = 0;
                    });
                    cache.clear();
                    prefetching.clear();
                    pdf.destroy && pdf.destroy();
                },
            }));
        });
    }

    // ==================== DOCX ====================

    function renderDocx(blob, container, opts) {
        return loadScript('mammoth', () => !!window.mammoth).then(() => {
            if (!window.mammoth) throw new Error('mammoth 未就绪');
            return blob.arrayBuffer().then(ab =>
                window.mammoth.convertToHtml({ arrayBuffer: ab }));
        }).then(res => {
            const el = document.createElement('div');
            el.className = 'tp-doc';
            el.innerHTML = res.value;

            // mammoth 会把 docx 内嵌图片转成 base64 data URI，
            // 大文档能轻易塞进几十 MB。不清理的话切换几次就卡死。
            // 这里只提示，不主动移除 —— 移除会导致图片丢失。
            const imgs = el.querySelectorAll('img');
            const bar = document.createElement('div');
            bar.className = 'tp-metabar';
            bar.textContent = 'DOCX · ' + fmtSize(blob.size) +
                (imgs.length ? ' · 含 ' + imgs.length + ' 张图' : '');

            // 裸表格在 Word 里带边框，mammoth 转出来是光秃秃的，补一下
            el.querySelectorAll('table').forEach(t => {
                t.setAttribute('border', '1');
                t.style.borderCollapse = 'collapse';
            });

            container.innerHTML = '';
            container.appendChild(bar);
            container.appendChild(el);

            const msgs = res.messages || [];
            if (msgs.length) {
                const warn = document.createElement('div');
                warn.className = 'tp-note';
                warn.textContent = '转换提示：' + msgs.slice(0, 3).map(m => m.message).join('；');
                container.insertBefore(warn, el);
            }

            return {
                savePosition: () => ({ ratio: scrollRatio(container) }),
                restorePosition: (pos) => applyRatio(container, pos && pos.ratio),
                destroy: () => {},
            };
        });
    }

    // ==================== XLSX ====================

    function renderXlsx(blob, container, opts) {
        return loadScript('xlsx', () => !!window.XLSX).then(() => {
            if (!window.XLSX) throw new Error('SheetJS 未就绪');
            return blob.arrayBuffer().then(ab => window.XLSX.read(ab, { type: 'array' }));
        }).then(wb => {
            container.innerHTML = '';
            const bar = document.createElement('div');
            bar.className = 'tp-metabar';
            bar.textContent = '表格 · ' + wb.SheetNames.length + ' 个工作表';
            container.appendChild(bar);

            const tabs = document.createElement('div');
            tabs.className = 'tp-tabs';
            const body = document.createElement('div');
            body.className = 'tp-sheet';
            container.appendChild(tabs);
            container.appendChild(body);

            let cur = wb.SheetNames[0];

            function showSheet(name) {
                cur = name;
                [...tabs.children].forEach(b =>
                    b.classList.toggle('active', b.textContent === name));
                const rows = window.XLSX.utils.sheet_to_json(
                    wb.Sheets[name], { header: 1, defval: '', blankrows: false });
                if (!rows.length) { body.innerHTML = '<p class="tp-empty">空工作表</p>'; return; }
                // 只渲染前 500 行：几万行的表全量生成 DOM 会直接卡死浏览器
                const shown = rows.slice(0, 500);
                let html = '<table class="tp-table"><tbody>';
                shown.forEach(r => {
                    html += '<tr>' + r.map(c =>
                        '<td>' + esc(c == null ? '' : c) + '</td>').join('') + '</tr>';
                });
                html += '</tbody></table>';
                if (rows.length > shown.length) {
                    html += '<p class="tp-note">仅显示前 500 行（共 ' + rows.length + ' 行）</p>';
                }
                body.innerHTML = html;
            }

            wb.SheetNames.forEach(n => {
                const b = document.createElement('button');
                b.className = 'tp-tab';
                b.textContent = n;
                b.onclick = () => showSheet(n);
                tabs.appendChild(b);
            });
            showSheet(cur);

            return {
                savePosition: () => ({ sheet: cur }),
                restorePosition: (pos) => {
                    if (pos && pos.sheet && wb.SheetNames.includes(pos.sheet)) showSheet(pos.sheet);
                },
                destroy: () => {},
            };
        });
    }

    // ==================== 音视频 ====================

    const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'];
    const VIDEO_EXT = ['mp4', 'webm', 'ogg', 'mov', 'm4v'];

    function renderMedia(blob, container, fileInfo, kind) {
        const url = URL.createObjectURL(blob);
        const el = document.createElement(kind);
        el.src = url;
        el.controls = true;
        el.className = 'tp-media';
        container.innerHTML = '';
        container.appendChild(el);
        return Promise.resolve({
            // 音视频的"位置"是播放进度，单位秒
            savePosition: () => ({ time: el.currentTime || 0 }),
            restorePosition: (pos) => {
                if (pos && typeof pos.time === 'number' && pos.time > 0) {
                    // 元数据没加载完就设 currentTime 会被浏览器忽略，
                    // 必须等 loadedmetadata。这里不能用 await（同步回调），
                    // 所以走事件监听。
                    if (el.readyState >= 1) { try { el.currentTime = pos.time; } catch {} }
                    else el.addEventListener('loadedmetadata', () => {
                        try { el.currentTime = pos.time; } catch {}
                    }, { once: true });
                }
            },
            destroy: () => { el.pause && el.pause(); URL.revokeObjectURL(url); },
        });
    }

    // ==================== 派发 ====================

    const KIND = {
        pdf: ['pdf'],
        docx: ['docx'],
        xlsx: ['xlsx', 'xls', 'csv'],
    };

    function classify(name) {
        const e = ext(name);
        if (IMG_EXT.includes(e)) return 'image';
        if (KIND.pdf.includes(e)) return 'pdf';
        if (KIND.docx.includes(e)) return 'docx';
        if (KIND.xlsx.includes(e)) return 'xlsx';
        if (TEXT_EXT.includes(e)) return 'text';
        if (AUDIO_EXT.includes(e)) return 'audio';
        if (VIDEO_EXT.includes(e)) return 'video';
        return 'other';
    }

    /**
     * 统一入口
     * @returns {Promise<{savePosition, restorePosition, destroy}>}
     */
    function render(blob, fileInfo, container, opts) {
        const kind = classify(fileInfo.name);
        opts = opts || {};
        switch (kind) {
            case 'image': return renderImage(blob, container, fileInfo);
            case 'pdf': return renderPdf(blob, container, opts);
            case 'docx': return renderDocx(blob, container, opts);
            case 'xlsx': return renderXlsx(blob, container, opts);
            case 'text': return renderText(blob, container, opts);
            case 'audio': return renderMedia(blob, container, fileInfo, 'audio');
            case 'video': return renderMedia(blob, container, fileInfo, 'video');
            default: return renderOther(blob, container, fileInfo);
        }
    }

    function renderOther(blob, container, fileInfo) {
        const url = URL.createObjectURL(blob);
        container.innerHTML =
            '<div class="tp-unsupported">' +
            '<p>这个文件类型暂时没法在浏览器里直接渲染。</p>' +
            '<p class="tp-dim">' + esc(fileInfo.name) + ' · ' + fmtSize(blob.size) + '</p>' +
            '</div>';
        const btn = document.createElement('button');
        btn.className = 'tp-btn';
        btn.textContent = '下载后用本地软件打开';
        btn.onclick = () => {
            const a = document.createElement('a');
            a.href = url;
            a.download = fileInfo.name;
            a.click();
        };
        container.appendChild(btn);
        return Promise.resolve({
            savePosition: () => null,
            restorePosition: () => {},
            destroy: () => URL.revokeObjectURL(url),
        });
    }

    /**
     * MIME 类型
     *
     * 只影响 Blob 的 type，不影响渲染分支（那个看扩展名）。
     * 但 type 必须给对：给 .txt 标成 octet-stream 的话，
     * 某些浏览器下载时会保存成无扩展名的文件。
     */
    const MIME = {
        pdf: 'application/pdf',
        txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
        html: 'text/html', htm: 'text/html', css: 'text/css',
        js: 'application/javascript', json: 'application/json',
        xml: 'application/xml', csv: 'text/csv',
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
        bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
        mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
        flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
        mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
        m4v: 'video/mp4',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        xls: 'application/vnd.ms-excel',
    };

    function mimeOf(name) {
        return MIME[ext(name)] || 'application/octet-stream';
    }

    window.TPRender = { render, classify, ext, fmtSize, esc, mimeOf, TEXT_EXT, IMG_EXT };
})();
