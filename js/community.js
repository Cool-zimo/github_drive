/**
 * 社区模块：公共聊天室 + 用户反馈
 *
 * 为什么走 GitHub Issues 而不是自建后端：
 *   这是个纯前端静态应用，没有自己的服务器。Issue 评论自带作者、时间戳、
 *   Markdown，且支持 ?since= 增量拉取 —— 一个"免费且带审计"的消息总线。
 *
 * 两个子模块：
 *   GdChat     公共聊天室（侧边栏入口）—— 单一 Issue 下的评论流
 *   GdFeedback 用户反馈  （设置页入口）—— 一条反馈 = 一个 Issue，点对点可回复
 *
 * 匿名机制：
 *   GitHub 的 Issue 作者必然是真实账号（API 不给匿名）。所以显示层用随机
 *   昵称（形容词-动物），账号只作身份凭证。注意：仓库公开，通过 API 仍能
 *   查到每条消息背后的真实账号 —— 这是 GitHub 的底层限制，纯前端绕不过去。
 *   面板里已写明这一点。
 *
 * 消息格式（聊天室）：
 *   <!--gd:nick|seq-->正文
 *   用 HTML 注释是刻意选的：GitHub 网页端不渲染它，但 API 能原样取回，
 *   所以仓库页面看起来是干净的聊天记录，机器侧又能拿到结构化元数据。
 */
(function () {
    'use strict';

    var CFG = {
        chat:     { owner: 'Cool-zimo', repo: 'drive-chat',     issue: 1 },
        feedback: { owner: 'Cool-zimo', repo: 'drive-feedback'  },
        author:   'cool-zimo'
    };

    // ── 图标：全部内联 SVG，不用 emoji ──────────────────────────────────
    //   emoji 在高频 innerHTML 重绘的容器里会和 Icons.scan 的 80ms 防抖
    //   打架（后台进程面板就是这么闪的）。这里源头就给 SVG，不依赖扫描。
    function ico(d, size) {
        size = size || 16;
        return '<svg class="ico" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" '
             + 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" '
             + 'stroke-linejoin="round" aria-hidden="true" focusable="false">' + d + '</svg>';
    }
    var ICON = {
        chat:    '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
        send:    '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
        inbox:   '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
        user:    '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
        reply:   '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
        close:   '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
        refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
        warn:    '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
        bug:     '<path d="M8 2v4M16 2v4"/><rect x="7" y="6" width="10" height="12" rx="3"/><path d="M7 12H2M22 12h-5M7.5 18l-2 3M16.5 18l2 3"/>',
        idea:    '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
        folder:  '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'
    };

    // ── 小工具 ─────────────────────────────────────────────────────────
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function api() {
        var a = window.app && window.app.api;
        if (!a) throw new Error('未登录');
        return a;
    }
    function me() {
        try { return ((window.app && window.app.storage && window.app.storage.getUser()) || {}).login || ''; }
        catch (e) { return ''; }
    }
    function isAuthor() {
        return (me() || '').toLowerCase() === CFG.author;
    }
    function fmtTime(iso) {
        var d = new Date(iso);
        if (isNaN(d)) return '';
        var p = function (n) { return n < 10 ? '0' + n : '' + n; };
        return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    var T = function (k, fb) {
        try { return (window.I18n && window.I18n.t) ? (window.I18n.t(k, fb) || fb) : fb; }
        catch (e) { return fb; }
    };

    // ── 昵称：随机生成，存本地 ──────────────────────────────────────────
    var ADJ = ['敏捷的', '安静的', '聪明的', '慢慢的', '勇敢的', '温柔的', '好奇的',
               '认真的', '快乐的', '神秘的', '努力的', '淡定的'];
    var ANI = ['狐狸', '水獭', '猫头鹰', '海豚', '松鼠', '刺猬', '鲸鱼',
               '兔子', '小鹿', '熊猫', '企鹅', '山雀'];
    function nick() {
        try {
            var n = localStorage.getItem('gd_nickname');
            if (n) return n;
            n = ADJ[Math.floor(Math.random() * ADJ.length)] + ANI[Math.floor(Math.random() * ANI.length)];
            localStorage.setItem('gd_nickname', n);
            return n;
        } catch (e) {
            return '匿名';
        }
    }

    /* ==================================================================
       公共聊天室
       ================================================================== */
    var Chat = {
        timer: null,
        lastSince: null,
        msgs: [],
        busy: false,
        lastSent: 0,
        burst: 0,
        mutedUntil: 0,

        /** 解析消息体：<!--gd:昵称|序号-->正文 */
        parse: function (body) {
            var m = /^<!--gd:([^|]*)\|([^>]*)-->([\s\S]*)$/.exec(String(body || ''));
            if (m) return { nick: m[1] || '匿名', seq: m[2], text: m[3] };
            return { nick: '匿名', seq: '', text: String(body || '') };
        },

        encode: function (text) {
            var seq = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
                    + String(Math.floor(Math.random() * 1000)).padStart(3, '0');
            return '<!--gd:' + nick() + '|' + seq + '-->' + text;
        },

        async load(incremental) {
            var a = api();
            var p = '/repos/' + CFG.chat.owner + '/' + CFG.chat.repo
                  + '/issues/' + CFG.chat.issue + '/comments?per_page=100';
            if (incremental && this.lastSince) p += '&since=' + encodeURIComponent(this.lastSince);
            var list = await a.request(p);
            if (!Array.isArray(list)) return;
            var self = this;
            var fresh = list.map(function (c) {
                var o = self.parse(c.body);
                o.id = c.id;
                o.at = c.created_at;
                o.mine = (c.user && c.user.login) === me();
                return o;
            });
            if (incremental && this.lastSince) {
                var known = {};
                this.msgs.forEach(function (m) { known[m.id] = 1; });
                fresh = fresh.filter(function (m) { return !known[m.id]; });
                this.msgs = this.msgs.concat(fresh);
            } else {
                this.msgs = fresh;
            }
            // 消息保序：按 seq 排（服务端不保证 PR/Issue 评论顺序稳定）
            this.msgs.sort(function (x, y) { return String(x.seq).localeCompare(String(y.seq)); });
            var last = list.length ? list[list.length - 1].created_at : null;
            if (last) this.lastSince = last;
        },

        async send(text) {
            text = (text || '').trim();
            if (!text) return;
            if (text.length > 500) { this.toast('消息最多 500 字', 'error'); return; }
            var now = Date.now();
            if (now < this.mutedUntil) {
                this.toast('发言太快，请 ' + Math.ceil((this.mutedUntil - now) / 1000) + ' 秒后再试', 'error');
                return;
            }
            if (now - this.lastSent < 3000) {
                this.toast('请稍等 3 秒再发言', 'error');
                return;
            }
            this.burst = (now - this.lastSent < 20000) ? this.burst + 1 : 1;
            this.lastSent = now;
            if (this.burst >= 5) {
                this.mutedUntil = now + 60000;
                this.burst = 0;
                this.toast('连续发言过多，暂停 60 秒', 'error');
                return;
            }
            await api().request('/repos/' + CFG.chat.owner + '/' + CFG.chat.repo
                + '/issues/' + CFG.chat.issue + '/comments',
                { method: 'POST', body: { body: this.encode(text) } });
            await this.load(true);
            this.paint();
            var box = document.getElementById('gd-chat-list');
            if (box) box.scrollTop = box.scrollHeight;
        },

        toast: function (m, t) { try { window.ui && window.ui.showToast && window.ui.showToast(m, t || 'info'); } catch (e) {} },

        /** 渲染到主内容区 */
        async mount(container) {
            var self = this;
            container.className = '';
            container.innerHTML =
                '<div class="gd-community">'
              +   '<div class="gd-cm-head">'
              +     '<div class="gd-cm-title">' + ico(ICON.chat, 18) + '<span>公共聊天室</span></div>'
              +     '<div class="gd-cm-sub">大家的留言公开可见 · 显示昵称，不显示账号</div>'
              +   '</div>'
              +   '<div class="gd-cm-warn">' + ico(ICON.warn, 14)
              +     '<span>仓库是公开的：通过 GitHub API 仍可查到每条消息对应的真实账号。'
              +     '请勿在此发送密码、令牌等私密信息。</span></div>'
              +   '<div id="gd-chat-list" class="gd-chat-list">'
              +     '<div class="gd-cm-loading">加载中…</div></div>'
              +   '<div class="gd-chat-input">'
              +     '<input id="gd-chat-text" type="text" maxlength="500" placeholder="说点什么…（回车发送）">'
              +     '<button id="gd-chat-send" class="gd-cm-btn">' + ico(ICON.send, 16) + '<span>发送</span></button>'
              +   '</div>'
              + '</div>';
            var input = document.getElementById('gd-chat-text');
            var btn = document.getElementById('gd-chat-send');
            function go() {
                var v = input.value;
                if (!v.trim()) return;
                input.value = '';
                btn.disabled = true;
                self.send(v).catch(function (e) {
                    self.toast('发送失败：' + (e.message || e), 'error');
                }).then(function () { btn.disabled = false; input.focus(); });
            }
            btn.addEventListener('click', go);
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); }
            });
            try { await this.load(false); this.paint(); } catch (e) {
                document.getElementById('gd-chat-list').innerHTML =
                    '<div class="gd-cm-error">加载失败：' + esc(e.message || e) + '</div>';
                return;
            }
            var box = document.getElementById('gd-chat-list');
            if (box) box.scrollTop = box.scrollHeight;
            this.start();
        },

        paint: function () {
            var box = document.getElementById('gd-chat-list');
            if (!box) return;
            if (!this.msgs.length) {
                box.innerHTML = '<div class="gd-cm-empty">'
                    + ico(ICON.chat, 28) + '<div>还没有人说话，来抢第一条</div></div>';
                return;
            }
            box.innerHTML = this.msgs.map(function (m) {
                return '<div class="gd-msg' + (m.mine ? ' mine' : '') + '">'
                     +   '<div class="gd-msg-meta"><span class="gd-msg-nick">' + esc(m.nick) + '</span>'
                     +     '<span class="gd-msg-time">' + fmtTime(m.at) + '</span></div>'
                     +   '<div class="gd-msg-text">' + esc(m.text).replace(/\n/g, '<br>') + '</div>'
                     + '</div>';
            }).join('');
        },

        start: function () {
            var self = this;
            this.stop();
            // 12 秒增量轮询：带 since 只拉新评论，一次通常只有几百字节
            this.timer = setInterval(function () {
                if (document.hidden || !document.getElementById('gd-chat-list')) { self.stop(); return; }
                self.load(true).then(function () { self.paint(); }).catch(function () {});
            }, 12000);
        },
        stop: function () { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
    };

    /* ==================================================================
       用户反馈
       ================================================================== */
    var TYPES = [
        { key: 'bug',    label: '题目/功能有问题', icon: ICON.bug },
        { key: 'idea',   label: '建议',           icon: ICON.idea },
        { key: 'complain', label: '投诉',         icon: 'warn' },
        { key: 'other',  label: '其它',           icon: ICON.chat }
    ];

    var Feedback = {
        /** 打开反馈面板（模态） */
        async open() {
            var self = this;
            var overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.id = 'gd-fb-overlay';
            overlay.innerHTML =
                '<div class="modal gd-fb-modal">'
              +   '<div class="modal-header"><h3>' + ico(ICON.inbox, 16) + ' <span>反馈</span></h3>'
              +     '<button class="modal-close" id="gd-fb-close">' + ico(ICON.close, 16) + '</button></div>'
              +   '<div class="modal-body" id="gd-fb-body"><div class="gd-cm-loading">加载中…</div></div>'
              + '</div>';
            document.body.appendChild(overlay);
            overlay.querySelector('#gd-fb-close').addEventListener('click', function () { self.close(); });
            overlay.addEventListener('click', function (e) { if (e.target === overlay) self.close(); });
            await this.render();
        },
        close: function () {
            var o = document.getElementById('gd-fb-overlay');
            if (o) o.remove();
        },

        async render() {
            var body = document.getElementById('gd-fb-body');
            if (!body) return;
            var self = this;
            var author = isAuthor();
            body.innerHTML =
                '<div class="gd-fb-tabs">'
              +   '<button class="gd-fb-tab active" data-tab="mine">我的反馈</button>'
              +   (author ? '<button class="gd-fb-tab" data-tab="inbox">收到的反馈</button>' : '')
              + '</div>'
              + '<div id="gd-fb-pane"><div class="gd-cm-loading">加载中…</div></div>';
            body.querySelectorAll('.gd-fb-tab').forEach(function (b) {
                b.addEventListener('click', function () {
                    body.querySelectorAll('.gd-fb-tab').forEach(function (x) { x.classList.remove('active'); });
                    b.classList.add('active');
                    self.pane(b.dataset.tab);
                });
            });
            // 作者端未回复计数：GitHub 不会给仓库主发自己 Issue 的通知，
            // 所以必须自己数，否则用户提了反馈永远不会知道。
            if (author) {
                try {
                    var n = await this.unanswered();
                    if (n > 0 && window.ui && window.ui.setFeedbackBadge) window.ui.setFeedbackBadge(n);
                } catch (e) {}
            }
            await this.pane('mine');
        },

        async pane(tab) {
            var pane = document.getElementById('gd-fb-pane');
            if (!pane) return;
            var self = this;
            if (tab === 'inbox') return this.renderInbox(pane);
            pane.innerHTML = '<div class="gd-cm-loading">加载中…</div>';
            var mine = [];
            try { mine = await this.myList(); }
            catch (e) {
                pane.innerHTML = '<div class="gd-cm-error">加载失败：' + esc(e.message || e) + '</div>';
                return;
            }
            var form =
                '<div class="gd-fb-form">'
              +   '<div class="gd-fb-label">类型</div>'
              +   '<div class="gd-fb-types">' + TYPES.map(function (t) {
                    return '<button class="gd-fb-type" data-type="' + t.key + '">'
                         + ico(typeof t.icon === 'string' && t.icon.length < 40 ? ICON[t.icon] || ICON.chat : t.icon, 14)
                         + '<span>' + t.label + '</span></button>';
                }).join('') + '</div>'
              +   '<textarea id="gd-fb-text" maxlength="1000" placeholder="说说遇到的问题或想法…"></textarea>'
              +   '<button id="gd-fb-submit" class="gd-cm-btn">' + ico(ICON.send, 16) + '<span>提交反馈</span></button>'
              +   '<div class="gd-cm-warn">' + ico(ICON.warn, 13)
              +     '<span>反馈仓库是公开的，内容所有人可见。不要写令牌、密码等私密信息。</span></div>'
              + '</div>';
            pane.innerHTML = form + '<div class="gd-fb-list"></div>';
            var picked = 'bug';
            function mark(k) {
                picked = k;
                pane.querySelectorAll('.gd-fb-type').forEach(function (b) {
                    b.classList.toggle('active', b.dataset.type === k);
                });
            }
            mark(picked);
            pane.querySelectorAll('.gd-fb-type').forEach(function (b) {
                b.addEventListener('click', function () { mark(b.dataset.type); });
            });
            var listEl = pane.querySelector('.gd-fb-list');
            listEl.innerHTML = this.renderMyList(mine);
            document.getElementById('gd-fb-submit').addEventListener('click', function () {
                var text = (document.getElementById('gd-fb-text').value || '').trim();
                if (!text) { self.toast('请先写点内容', 'error'); return; }
                var btn = this;
                btn.disabled = true;
                self.submit(picked, text).then(function () {
                    self.toast('反馈已提交，感谢！', 'success');
                    return self.pane('mine');
                }).catch(function (e) {
                    self.toast('提交失败：' + (e.message || e), 'error');
                    btn.disabled = false;
                });
            });
        },

        renderMyList: function (list) {
            if (!list.length) return '<div class="gd-cm-empty">' + ico(ICON.inbox, 26) + '<div>还没有提交过反馈</div></div>';
            return list.map(function (f) {
                return '<div class="gd-fb-card">'
                     +   '<div class="gd-fb-card-head"><span class="gd-fb-type-tag">' + esc(f.type) + '</span>'
                     +     '<span class="gd-fb-state">' + esc(f.state) + '</span></div>'
                     +   '<div class="gd-fb-card-text">' + esc(f.text).replace(/\n/g, '<br>') + '</div>'
                     +   (f.replies.length
                            ? '<div class="gd-fb-replies">' + f.replies.map(function (r) {
                                return '<div class="gd-fb-reply' + (r.author ? ' author' : '') + '">'
                                     +   '<div class="gd-fb-reply-meta">'
                                     +     (r.author ? '<span class="gd-fb-badge">作者</span>' : '')
                                     +     '<span>' + fmtTime(r.at) + '</span></div>'
                                     +   '<div>' + esc(r.text).replace(/\n/g, '<br>') + '</div></div>';
                              }).join('') + '</div>'
                            : '<div class="gd-fb-noreply">暂无回复</div>')
                     + '</div>';
            }).join('');
        },

        /** 我提交过的反馈（本地记住 issue 号） */
        async myList() {
            var nums = [];
            try { nums = JSON.parse(localStorage.getItem('gd_fb_issues') || '[]'); }
            catch (e) { nums = []; }
            if (!nums.length) return [];
            var out = [];
            for (var i = 0; i < nums.length; i++) {
                try {
                    var iss = await api().request('/repos/' + CFG.feedback.owner + '/' + CFG.feedback.repo
                        + '/issues/' + nums[i]);
                    var cmts = await api().request('/repos/' + CFG.feedback.owner + '/' + CFG.feedback.repo
                        + '/issues/' + nums[i] + '/comments?per_page=50');
                    var meta = this.parseIssue(iss);
                    out.push({
                        number: nums[i],
                        type: meta.type,
                        text: meta.text,
                        state: iss.state === 'closed' ? '已关闭' : '待处理',
                        replies: (Array.isArray(cmts) ? cmts : []).map(function (c) {
                            return {
                                text: String(c.body || ''),
                                at: c.created_at,
                                author: !!c.user && c.user.login.toLowerCase() === CFG.author
                            };
                        })
                    });
                } catch (e) { /* 单个失败（如已删除）不影响其余 */ }
            }
            return out.reverse();
        },

        /* ★ 标题只用来带类型，正文才是用户写的内容。
           曾经把标题里 `[类型]` 后面的昵称当成正文取出来 —— 于是每条反馈
           显示的都是"好奇的猫头鹰"这种昵称，真内容一条都看不见。 */
        parseIssue: function (iss) {
            var m = /^\[([^\]]+)\]/.exec(String(iss.title || ''));
            return { type: m ? m[1] : '其它', text: String(iss.body || '') };
        },

        async submit(type, text) {
            var label = (TYPES.filter(function (t) { return t.key === type; })[0] || TYPES[0]).label;
            /* 标题带类型 + 昵称 + 前 24 字摘要：作者在 Issue 列表里一眼能扫，
               不用点进去才知道是什么事。正文仍存完整内容（parseIssue 取 body）。 */
            var brief = text.replace(/\s+/g, ' ').slice(0, 24);
            var iss = await api().request('/repos/' + CFG.feedback.owner + '/' + CFG.feedback.repo
                + '/issues', { method: 'POST', body: { title: '[' + label + '] ' + nick() + '：' + brief, body: text } });
            var nums = [];
            try { nums = JSON.parse(localStorage.getItem('gd_fb_issues') || '[]'); } catch (e) {}
            nums.push(iss.number);
            localStorage.setItem('gd_fb_issues', JSON.stringify(nums));
        },

        /** 作者端：列出全部反馈 */
        async renderInbox(pane) {
            pane.innerHTML = '<div class="gd-cm-loading">加载中…</div>';
            var list;
            try {
                list = await api().request('/repos/' + CFG.feedback.owner + '/' + CFG.feedback.repo
                    + '/issues?state=open&per_page=50&sort=created&direction=desc');
            } catch (e) {
                pane.innerHTML = '<div class="gd-cm-error">加载失败：' + esc(e.message || e) + '</div>';
                return;
            }
            if (!Array.isArray(list) || !list.length) {
                pane.innerHTML = '<div class="gd-cm-empty">' + ico(ICON.inbox, 26) + '<div>暂无待处理反馈</div></div>';
                return;
            }
            var self = this;
            pane.innerHTML = list.map(function (iss) {
                var meta = self.parseIssue(iss);
                return '<div class="gd-fb-card" data-num="' + iss.number + '">'
                     +   '<div class="gd-fb-card-head"><span class="gd-fb-type-tag">' + esc(meta.type) + '</span>'
                     +     '<span class="gd-fb-from">' + ico(ICON.user, 12) + esc(iss.user && iss.user.login || '') + '</span>'
                     +     '<span class="gd-fb-time">' + fmtTime(iss.created_at) + '</span></div>'
                     +   '<div class="gd-fb-card-text">' + esc(meta.text).replace(/\n/g, '<br>') + '</div>'
                     +   '<div class="gd-fb-actions">'
                     +     '<input class="gd-fb-reply-input" placeholder="回复这位用户…">'
                     +     '<button class="gd-cm-btn sm" data-act="reply">' + ico(ICON.reply, 14) + '<span>回复</span></button>'
                     +     '<button class="gd-cm-btn sm ghost" data-act="close">' + ico(ICON.close, 14) + '<span>关闭</span></button>'
                     +   '</div><div class="gd-fb-msg"></div>'
                     + '</div>';
            }).join('');
            pane.querySelectorAll('.gd-fb-card').forEach(function (card) {
                var num = card.dataset.num;
                var msg = card.querySelector('.gd-fb-msg');
                card.querySelector('[data-act=reply]').addEventListener('click', function () {
                    var v = (card.querySelector('.gd-fb-reply-input').value || '').trim();
                    if (!v) return;
                    msg.textContent = '发送中…';
                    api().request('/repos/' + CFG.feedback.owner + '/' + CFG.feedback.repo
                        + '/issues/' + num + '/comments', { method: 'POST', body: { body: v } })
                        .then(function () { msg.textContent = '已回复'; self.refreshBadge(); })
                        .catch(function (e) { msg.textContent = '失败：' + (e.message || e); });
                });
                card.querySelector('[data-act=close]').addEventListener('click', function () {
                    msg.textContent = '关闭中…';
                    api().request('/repos/' + CFG.feedback.owner + '/' + CFG.feedback.repo
                        + '/issues/' + num, { method: 'PATCH', body: { state: 'closed' } })
                        .then(function () { card.remove(); self.refreshBadge(); })
                        .catch(function (e) { msg.textContent = '失败：' + (e.message || e); });
                });
            });
        },

        /** 未回复计数（作者端） */
        async unanswered() {
            var list = await api().request('/repos/' + CFG.feedback.owner + '/' + CFG.feedback.repo
                + '/issues?state=open&per_page=50');
            if (!Array.isArray(list)) return 0;
            var n = 0;
            for (var i = 0; i < list.length; i++) {
                var c = await api().request('/repos/' + CFG.feedback.owner + '/' + CFG.feedback.repo
                    + '/issues/' + list[i].number + '/comments?per_page=10');
                var hasAuthor = (Array.isArray(c) ? c : []).some(function (x) {
                    return x.user && String(x.user.login).toLowerCase() === CFG.author;
                });
                if (!hasAuthor) n++;
            }
            return n;
        },

        async refreshBadge() {
            try {
                var n = await this.unanswered();
                if (window.ui && window.ui.setFeedbackBadge) window.ui.setFeedbackBadge(n);
            } catch (e) {}
        },

        toast: function (m, t) { try { window.ui && window.ui.showToast && window.ui.showToast(m, t || 'info'); } catch (e) {} }
    };

    window.GdCommunity = { CFG: CFG, Chat: Chat, Feedback: Feedback, ICON: ICON, ico: ico,
                           nick: nick, isAuthor: isAuthor };
})();
