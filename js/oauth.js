/**
 * OAuth Device Flow 客户端
 *
 * 为什么需要它：GitHub 的 OAuth 端点不返回 CORS 头，浏览器发不出跨域 POST。
 * 所以这两步必须借道一个无状态代理（见 worker/oauth-proxy.js）。
 * 代理不存任何东西，只做转发。
 *
 * Device Flow 的过程（用户视角）：
 *   1. 页面显示一个 8 位码，例如 ABCD-1234
 *   2. 你去 github.com/login/device 输入这个码，点授权
 *   3. 页面每隔几秒问一次「好了没」，好了就拿到 token
 *
 * 为什么选它而不是普通的 OAuth 跳转：
 *   Device Flow 只需要 client_id，不需要 client_secret。
 *   纯静态页面里放 secret 等于公开，所以只能用这种无密钥流程。
 */

class GitHubDeviceFlow {
    constructor() {
        // ── 配置 ──────────────────────────────────────────
        // 部署 Worker 后把地址填到这里。也可以运行时改，不用改代码：
        //   localStorage.setItem('gd_oauth_proxy', 'https://xxx.workers.dev')
        //   localStorage.setItem('gd_oauth_client_id', 'Iv1.xxxx')
        this.proxy =
            (typeof localStorage !== 'undefined' &&
                localStorage.getItem('gd_oauth_proxy')) ||
            window.GD_OAUTH_PROXY ||
            '';

        this.clientId =
            (typeof localStorage !== 'undefined' &&
                localStorage.getItem('gd_oauth_client_id')) ||
            window.GD_OAUTH_CLIENT_ID ||
            '';

        // 展示用。代理端会强制改写成 repo,workflow，这里传什么都不采纳 ——
        // 否则有人能拿你的 client_id 去换更高权限的 token
        this.scope = 'repo,workflow';

        this.deviceCode = null;
        this.interval = 5;
        this.expiresAt = 0;
        this._polling = false;
    }

    /** 配置齐全才谈得上启用，否则老老实实用 PAT */
    get configured() {
        return !!(this.proxy && this.clientId);
    }

    /**
     * 探测代理是否活着。
     * 用 OPTIONS 预检而不是 GET —— Worker 只为 OPTIONS / POST 设计过，
     * 发 GET 必然 404，那样测出来的是「路径不对」而不是「连不上」。
     */
    async available() {
        const d = await this.diagnose();
        return d.ok;
    }

    /**
     * 探测代理，并返回「卡在哪一步」的结构化结果。
     *
     * 原来的 available() 只回 true/false，探测失败时没有任何线索，
     * 排障只能靠猜。这里把失败拆成三种阶段：
     *   network     —— fetch 直接抛错（DNS 不通、被墙、被 CORS 拒绝）
     *   http-status —— 连上了，但状态码不对（代理没部署 / 路径错 / 来源被拒）
     *   no-config   —— 压根没配
     *
     * ⚠️ 一个必须说清的局限：浏览器出于安全考虑，把所有网络层失败
     *    统一报成 TypeError，不区分「DNS 解析失败」「连接被重置」
     *    和「CORS 被拒」。所以 network 阶段只能给出可能原因，
     *    无法精确判定是哪一种。
     */
    async diagnose() {
        if (!this.configured) {
            return { ok: false, stage: 'no-config', detail: '未配置代理地址或 client_id' };
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        const t0 = Date.now();
        try {
            const r = await fetch(this._url('/device/code'), {
                method: 'OPTIONS',
                signal: ctrl.signal,
            });
            clearTimeout(timer);
            const ms = Date.now() - t0;
            if (r.status === 204 || r.status === 200) {
                return { ok: true, stage: 'ok', detail: 'HTTP ' + r.status + ' · ' + ms + 'ms' };
            }
            return {
                ok: false,
                stage: 'http-status',
                detail: 'HTTP ' + r.status + ' · ' + ms + 'ms',
            };
        } catch (e) {
            clearTimeout(timer);
            const name = (e && e.name) || 'Error';
            let why = '未知原因';
            if (name === 'AbortError') {
                why = '超时（6 秒无响应）—— 多半是网络到不了这个地址';
            } else if (name === 'TypeError') {
                why = '请求发不出去。可能是 DNS 解析失败、网络不通，或被 CORS 拒绝（浏览器不细分这几种）';
            }
            return { ok: false, stage: 'network', detail: name + ' · ' + why };
        }
    }

    _url(path) {
        return this.proxy.replace(/\/+$/, '') + path;
    }

    async _post(path, body) {
        let r;
        try {
            r = await fetch(this._url(path), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
        } catch (e) {
            // fetch 抛异常 = 请求根本没到服务器：DNS 失败、被墙、或 CORS 被拒。
            // 浏览器统一报 "Failed to fetch"，看不出是哪一种，这里补上排查方向。
            throw new Error(
                '连不上代理（' + this.proxy + '）。可能是地址写错、代理没部署，' +
                '或者浏览器拦掉了跨域响应。按 F12 看网络面板能确认是哪一种。'
            );
        }
        let data = {};
        try {
            data = await r.json();
        } catch (e) {
            data = { error: 'bad_response' };
        }
        return { status: r.status, data };
    }

    /**
     * 第一步：申请设备码。
     * 返回 { userCode, verifyUrl, expiresIn }
     * userCode 就是给用户抄走的那 8 位。
     */
    async requestCode() {
        const res = await this._post('/device/code', { client_id: this.clientId });
        if (res.data.error) {
            throw new Error(this._humanError(res.data.error));
        }
        if (!res.data.device_code || !res.data.user_code) {
            throw new Error('代理返回的数据不完整');
        }
        this.deviceCode = res.data.device_code;
        // GitHub 给的间隔是秒，至少 5 秒，别把接口打爆
        this.interval = Math.max(5, parseInt(res.data.interval, 10) || 5);
        this.expiresAt = Date.now() + (parseInt(res.data.expires_in, 10) || 900) * 1000;
        return {
            userCode: res.data.user_code,
            verifyUrl: res.data.verification_uri || 'https://github.com/login/device',
            expiresIn: parseInt(res.data.expires_in, 10) || 900,
        };
    }

    /**
     * 第二步：轮询直到拿到 token。
     * onPending 每次空等时回调（前端用它刷新倒计时）。
     */
    async pollForToken(onPending) {
        this._polling = true;
        let wait = this.interval;

        while (this._polling) {
            if (Date.now() > this.expiresAt) {
                this._polling = false;
                throw new Error('授权码已过期，请重新开始');
            }

            await new Promise((r) => setTimeout(r, wait * 1000));

            // 等待期间可能已被取消，醒了要先确认
            if (!this._polling) break;

            const res = await this._post('/device/token', {
                client_id: this.clientId,
                device_code: this.deviceCode,
            });

            const d = res.data;

            if (d.access_token) {
                this._polling = false;
                return d.access_token;
            }

            const err = d.error;
            if (err === 'authorization_pending') {
                // 正常状态：用户还没输码。保持原间隔继续等
                if (onPending) onPending();
                continue;
            }
            if (err === 'slow_down') {
                // GitHub 嫌你问得太快，间隔 +5 秒
                wait += 5;
                if (onPending) onPending();
                continue;
            }

            this._polling = false;
            throw new Error(this._humanError(err));
        }
        throw new Error('已取消');
    }

    cancel() {
        this._polling = false;
    }

    /** 把 GitHub 的错误码翻成人话，别把 authorization_pending 之类丢给用户 */
    _humanError(code) {
        const map = {
            access_denied: '你在 GitHub 上取消了授权',
            expired_token: '授权码已过期，请重新开始',
            device_flow_disabled: '这个 OAuth App 没有开启 Device Flow，请到 App 设置里打开',
            incorrect_client_credentials: 'client_id 不对',
            unsupported_grant_type: '代理的 grant_type 有误',
            rate_limit_exceeded: '请求太频繁，请稍后再试',
            not_found: '代理地址不对',
            upstream_failed: '连不上 GitHub，请稍后再试',
            bad_response: '代理返回了无法解析的内容',
        };
        return map[code] || code || '授权失败';
    }
}

window.GitHubDeviceFlow = GitHubDeviceFlow;
