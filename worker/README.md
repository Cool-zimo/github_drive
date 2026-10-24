# OAuth 代理（GitHub 登录用）

## 为什么需要它

GitHub 的两个 OAuth 端点**不返回 CORS 头**，浏览器发不出跨域 POST：

```
OPTIONS https://github.com/login/device/code          → 403（无 ACAO 头）
OPTIONS https://github.com/login/oauth/access_token   → 403（无 ACAO 头）
```

所以纯静态页面没法自己走完 Device Flow，必须借道一个转发服务。

## 它不是后端

| 常见后端 | 本 Worker |
|---|---|
| 存 token | **不存** |
| 存 session | **不存** |
| 有数据库 | **没有** |
| 持有 client_secret | **没有**（Device Flow 不需要） |

只做两件事：把 `/device/code` 和 `/device/token` 的 POST 原样转给 GitHub，
把响应原样带回来，并加上 CORS 头。请求之间没有共享状态。

## 部署

```bash
npm i -g wrangler
wrangler login
cd worker
wrangler deploy
```

部署完会得到一个地址，例如 `https://gd-oauth.<你的子域>.workers.dev`。

## 填入配置

不用改代码，在浏览器控制台执行（或让 Drive 的设置页去写）：

```js
localStorage.setItem('gd_oauth_proxy', 'https://gd-oauth.<你的子域>.workers.dev');
localStorage.setItem('gd_oauth_client_id', 'Iv1.xxxxxxxxxxxxxxxx');
```

刷新页面，登录框上就会多出「用 GitHub 账号登录」。

想给所有用户预置，把这两个值写进 `js/oauth.js` 顶部的
`window.GD_OAUTH_PROXY` / `window.GD_OAUTH_CLIENT_ID`。

## 安全边界

- **来源白名单**：只放行 `*.github.io` 与 localhost。别人的站点调不动。
- **scope 写死**：无论前端传什么，代理强制改成 `repo,workflow`。
  否则有人能拿你的 client_id 换更高权限的 token。
- **无状态**：不落盘任何 token，被攻破也拿不到历史数据。

## 已知代价

client_id 是公开的（必然如此，前端要用）。别人可以拿它发起授权，
用户在 GitHub 上看到的却是**你的** App 名。个人项目可接受，
公开大范围分发前请三思。
