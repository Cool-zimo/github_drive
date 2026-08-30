class GitHubAPI {
    constructor(token) {
        this.token = token;
        // 添加日志输出，确认 token 是否被正确加载
        console.log("[GitHubAPI] 初始化，Token 已加载:", this.token ? '已设置' : '未设置');
    }

    async request(url, options = {}) {
        const headers = {
            'Accept': 'application/vnd.github.v3+json',
            'Authorization': `token ${this.token}`, // 确保 token 正确注入
            ...options.headers
        };

        // 添加调试日志，记录请求 URL 和 header
        console.log("[GitHubAPI] 发起请求:", url, "Headers:", headers);

        try {
            const response = await fetch(url, {
                ...options,
                headers
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error("[GitHubAPI] 请求失败:", response.status, response.statusText, errorText);
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }

            return await response.json();
        } catch (err) {
            console.error("[GitHubAPI] 请求异常:", err.message);
            throw err;
        }
    }

    async getMe() {
        console.log("[GitHubAPI] 尝试获取用户信息...");
        return this.request('https://api.github.com/user');
    }
}