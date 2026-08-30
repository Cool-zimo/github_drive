async function login() {
    const tokenInput = document.getElementById('token-input');
    const token = tokenInput.value.trim();

    // 校验 Token 格式（必须以 ghp_ 或 github_pat_ 开头）
    if (!token) {
        alert("请输入 GitHub Personal Access Token");
        return;
    }

    if (!/^ghp_|^github_pat_/.test(token)) {
        alert("Token 格式错误，请使用以 ghp_ 或 github_pat_ 开头的 Token");
        return;
    }

    // 添加日志输出
    console.log("[App] 登录尝试，Token 长度:", token.length);

    try {
        const api = new GitHubAPI(token);
        const user = await api.getMe();
        console.log("[App] 登录成功，用户信息:", user.login);

        // 保存 token 到 localStorage
        localStorage.setItem('github_token', token);
        window.location.href = '#drive'; // 进入 Drive 页面
    } catch (err) {
        console.error("[App] 登录失败:", err.message);
        alert("登录失败：" + err.message);
    }
}