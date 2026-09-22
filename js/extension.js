/**
 * GitHub Drive - 浏览器扩展通信模块
 * 功能：
 * 1. 检测扩展是否已安装
 * 2. 与扩展通信（获取 Token、API 代理）
 * 3. 如果扩展可用，优先使用扩展进行 API 请求
 */

class ExtensionHelper {
    constructor() {
        this.installed = false;
        this.version = null;
        this._messageId = 0;
        this._pendingRequests = new Map();
        // ── OAuth 配置（自带凭据，BYO）──────────────────────
        //
        // ★ 为什么不能把 client_id / client_secret 写死在源码里：
        //   这是公开仓库，写死 = 公开。任何人都能拿走这对凭据。
        //
        //   查了 GitHub 官方文档，无后端的静态站没有完美方案：
        //     · Web flow：token 交换必须带 client_secret（Required）
        //     · PKCE：GitHub 仍在交换步骤要求 client_secret，不免除
        //     · Device flow：确实不需要 secret，但官方明确警告
        //       "device flow does not require redirect URIs at all" ——
        //       没有 redirect_uri 保护，极易被钓鱼冒充，不适用于网页应用
        //
        //   所以走 BYO：每个用户注册自己的 OAuth App，凭据只存在自己
        //   浏览器的 localStorage 里，从来不进仓库、不上传给任何服务器。
        //
        // ⚠️ 若你曾在源码里见过真实的 client_secret，请立刻去
        //    GitHub Settings → OAuth Apps 重新生成 —— 那串已经泄露了。
        //
        this.clientId = '';
        this.clientSecret = '';
        this.redirectUri = 'https://cool-zimo.github.io/github_drive/oauth_callback';
        // --- END ---
        this._init();
    }

    /**
     * 从 localStorage 载入 OAuth 凭据（BYO）
     *
     * ★ 只读不写：凭据由用户在设置里填，代码从不自带默认值。
     *   读不到就是没配置，调用时会明确报错，不会静默用错的。
     */
    _loadOAuthCredentials() {
        try {
            this.clientId = localStorage.getItem('gd_oauth_client_id') || '';
            this.clientSecret = localStorage.getItem('gd_oauth_client_secret') || '';
        } catch (e) {
            this.clientId = '';
            this.clientSecret = '';
        }
    }

    /** OAuth 是否已配置（UI 用来决定能不能点登录） */
    isOAuthConfigured() {
        return !!(this.clientId && this.clientSecret);
    }

    /**
     * 取凭据，未配置则抛明确错误
     *
     * ★ 不能返回空串让请求发出去 —— 那会得到一个含义不清的 401，
     *   用户根本不知道是"没配置"还是"配置错了"。
     */
    _requireCredentials() {
        if (!this.isOAuthConfigured()) {
            throw new Error(
                '未配置 OAuth 凭据。请在设置里填入你自己的 Client ID 和 ' +
                'Client Secret（在 GitHub Settings → Developer settings → ' +
                'OAuth Apps 注册，回调地址填 ' + this.redirectUri + '）'
            );
        }
        return { clientId: this.clientId, clientSecret: this.clientSecret };
    }

    /**
     * 保存用户填写的凭据
     * @returns {{ok:boolean, error?:string}}
     */
    saveOAuthCredentials(clientId, clientSecret) {
        const id = String(clientId || '').trim();
        const sec = String(clientSecret || '').trim();
        if (!id || !sec) return { ok: false, error: 'Client ID 和 Secret 都不能为空' };
        // GitHub 的 client_id 形如 Ov23li...，secret 是 40 位十六进制
        if (!/^[A-Za-z0-9_]+$/.test(id)) return { ok: false, error: 'Client ID 格式不对' };
        if (sec.length < 8) return { ok: false, error: 'Client Secret 太短，疑似填错' };
        try {
            localStorage.setItem('gd_oauth_client_id', id);
            localStorage.setItem('gd_oauth_client_secret', sec);
            this.clientId = id;
            this.clientSecret = sec;
            return { ok: true };
        } catch (e) {
            return { ok: false, error: '保存失败：' + e.message };
        }
    }

    /** 清除凭据（换号/怀疑泄露时用） */
    clearOAuthCredentials() {
        try {
            localStorage.removeItem('gd_oauth_client_id');
            localStorage.removeItem('gd_oauth_client_secret');
        } catch (e) { /* 忽略 */ }
        this.clientId = '';
        this.clientSecret = '';
    }

    _init() {
        // 监听来自扩展的消息
        window.addEventListener('message', (event) => {
            if (event.source !== window) return;
            const message = event.data;
            if (!message || message.source !== 'github-drive-extension') return;

            // 扩展加载通知
            if (message.type === 'EXTENSION_LOADED') {
                this.installed = true;
                this.version = message.version;
                console.log('[Extension] 扩展已安装，版本:', this.version);
                return;
            }

            // 响应消息
            if (message.type && message.type.endsWith('_RESPONSE')) {
                const requestId = message.requestId;
                const resolve = this._pendingRequests.get(requestId);
                if (resolve) {
                    this._pendingRequests.delete(requestId);
                    resolve(message);
                }
            }
        });

        this._loadOAuthCredentials();

        // 检测扩展是否已安装（通过 window 标记）
        if (window.__GITHUB_DRIVE_EXTENSION__) {
            this.installed = true;
            this.version = window.__GITHUB_DRIVE_EXTENSION_VERSION__;
            console.log('[Extension] 检测到扩展已安装，版本:', this.version);
        } else {
            // 延迟检测（等待 content script 注入）
            setTimeout(() => {
                if (window.__GITHUB_DRIVE_EXTENSION__) {
                    this.installed = true;
                    this.version = window.__GITHUB_DRIVE_EXTENSION_VERSION__;
                    console.log('[Extension] 延迟检测到扩展已安装');
                } else {
                    console.log('[Extension] 未检测到扩展，将使用纯前端模式');
                }
            }, 1000);
        }
    }

    /**
     * 发送消息给扩展
     */
    _sendMessage(type, data = {}) {
        return new Promise((resolve, reject) => {
            if (!this.installed) {
                reject(new Error('扩展未安装'));
                return;
            }

            const requestId = ++this._messageId;
            this._pendingRequests.set(requestId, resolve);

            window.postMessage({
                source: 'github-drive-page',
                type: type,
                requestId: requestId,
                ...data
            }, '*');

            // 超时处理
            setTimeout(() => {
                if (this._pendingRequests.has(requestId)) {
                    this._pendingRequests.delete(requestId);
                    reject(new Error('扩展响应超时'));
                }
            }, 30000);
        });
    }

    /**
     * 检测扩展是否可用
     */
    isAvailable() {
        return this.installed;
    }

    /**
     * 获取扩展版本
     */
    getVersion() {
        return this.version;
    }

    /**
     * 获取存储在扩展中的 Token
     */
    async getToken() {
        try {
            const response = await this._sendMessage('GET_TOKEN');
            return response.token || null;
        } catch (e) {
            console.warn('[Extension] 获取 Token 失败:', e.message);
            return null;
        }
    }

    /**
     * 保存 Token 到扩展
     */
    async setToken(token) {
        try {
            const response = await this._sendMessage('SET_TOKEN', { token });
            return response.ok;
        } catch (e) {
            console.warn('[Extension] 保存 Token 失败:', e.message);
            return false;
        }
    }

    /**
     * 清除扩展中的 Token
     */
    async clearToken() {
        try {
            const response = await this._sendMessage('CLEAR_TOKEN');
            return response.ok;
        } catch (e) {
            console.warn('[Extension] 清除 Token 失败:', e.message);
            return false;
        }
    }

    /**
     * 获取用户信息
     */
    async getUser() {
        try {
            const response = await this._sendMessage('GET_USER');
            return response.user || null;
        } catch (e) {
            console.warn('[Extension] 获取用户信息失败:', e.message);
            return null;
        }
    }

    /**
     * 通过扩展代理 GitHub API 请求
     */
    async apiRequest(method, path, body = null, headers = {}, useToken = true) {
        try {
            const response = await this._sendMessage('API_REQUEST', {
                method,
                path,
                body,
                headers,
                useToken
            });
            return response;
        } catch (e) {
            console.warn('[Extension] API 请求失败:', e.message);
            throw e;
        }
    }

    /**
     * 触发 OAuth 登录
     * 此方法应在前端页面调用，启动 OAuth 流程
     */
    async oauthLogin() {
        const state = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        const scope = 'repo workflow'; // 根据需要调整权限范围

        const authUrl = new URL('https://github.com/login/oauth/authorize');
        // 未配置就别跳了 —— 跳过去用户授权完回来还是失败，更困惑
        this._requireCredentials();
        authUrl.searchParams.append('client_id', this.clientId);
        authUrl.searchParams.append('redirect_uri', this.redirectUri);
        authUrl.searchParams.append('scope', scope);
        authUrl.searchParams.append('state', state);

        // 存储 state 以便回调时验证
        sessionStorage.setItem('github_oauth_state', state);

        // 重定向到 GitHub 授权页面
        window.location.href = authUrl.toString();
    }

    /**
     * 处理 OAuth 回调
     * 此方法应在回调页面（如 oauth_callback.html）中调用
     */
    async handleCallback() {
        const urlParams = new URLSearchParams(window.location.search);
        const code = urlParams.get('code');
        const state = urlParams.get('state');
        const error = urlParams.get('error');
        const errorDescription = urlParams.get('error_description');

        if (error) {
            console.error('[Extension] OAuth Error:', error, errorDescription);
            alert(`OAuth Error: ${error}\n${errorDescription || ''}`);
            return;
        }

        if (!code) {
            console.error('[Extension] No authorization code received.');
            alert('No authorization code received.');
            return;
        }

        const storedState = sessionStorage.getItem('github_oauth_state');
        if (!storedState || state !== storedState) {
            console.error('[Extension] Invalid state parameter for CSRF protection.');
            alert('Invalid state parameter. Possible CSRF attack.');
            return;
        }

        try {
            const token = await this.exchangeCodeForToken(code);
            // 假设扩展提供了一个设置 token 的方法
            // 这部分需要与扩展内部逻辑配合，可能需要发送消息给扩展
            if (this.installed) {
                 await this._sendMessage('SET_TOKEN', { token });
                 console.log('[Extension] Token set in extension via callback.');
            } else {
                 // 如果扩展未安装，可以存储到 localStorage 作为备选
                 localStorage.setItem('github_drive_token', token);
                 console.log('[Extension] Token set in localStorage (no extension).');
            }
            // 成功后重定向回主应用页面
            window.location.href = 'https://cool-zimo.github.io/github_drive/'; // 替换为你的主应用地址
        } catch (e) {
            console.error('[Extension] Error during token exchange:', e);
            alert(`Error getting access token: ${e.message}`);
        }
    }

    /**
     * 通过授权码交换访问令牌
     * @param {string} code - GitHub 返回的授权码
     * @returns {Promise<string>} - 返回访问令牌
     */
    async exchangeCodeForToken(code) {
        const { clientId, clientSecret } = this._requireCredentials();
        const tokenUrl = 'https://github.com/login/oauth/access_token';
        const params = new URLSearchParams();
        params.append('client_id', clientId);
        params.append('client_secret', clientSecret);
        params.append('code', code);
        params.append('redirect_uri', this.redirectUri);

        const response = await fetch(tokenUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json'
            },
            body: params
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }

        const data = await response.json();
        if (data.error) {
            throw new Error(`${data.error}: ${data.error_description}`);
        }

        return data.access_token;
    }
}

// 创建全局实例
const extensionHelper = new ExtensionHelper();