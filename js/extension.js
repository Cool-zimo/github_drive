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
        // --- 新增：OAuth 配置 ---
        this.clientId = 'Ov23liH51YfXFWysljeU';
        this.clientSecret = '20a8407220227eaac73c41e5f874f641037306d5';
        this.redirectUri = 'https://cool-zimo.github.io/github_drive/oauth_callback'; // 请替换为你的实际回调地址
        // --- END 新增 ---
        this._init();
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
        const tokenUrl = 'https://github.com/login/oauth/access_token';
        const params = new URLSearchParams();
        params.append('client_id', this.clientId);
        params.append('client_secret', this.clientSecret);
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