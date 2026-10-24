/**
 * GitHub Drive · OAuth Device Flow 代理
 *
 * 存在的唯一理由：GitHub 的两个 OAuth 端点不返回 CORS 头，
 * 浏览器发不出跨域 POST，纯静态页面没法自己完成 device flow。
 * 本 Worker 只做转发，不存任何东西。
 *
 * 无状态设计：
 *   - 不保存 token、device_code、用户身份
 *   - 不写 KV、不写 Durable Object、不写缓存
 *   - 每个请求独立处理，请求之间没有共享数据
 *   - 唯一持有的是代码里写死的常量（下面 ALLOWED_ORIGINS）
 *
 * 只开放两个操作，其余一律 404：
 *   1. POST /device/code      申请设备码
 *   2. POST /device/token     轮询换 token
 */

// ── 允许的来源 ────────────────────────────────────────────────
// Pages 域名 + 本地开发。别人的站点调不动这个代理，
// 否则任何人都能拿你的 client_id 发起授权（App 名是你的，用户会被骗）。
const ALLOWED_HOSTS = [
    'cool-zimo.github.io',
];

function originAllowed(origin) {
    if (!origin) return false;
    let host;
    try {
        host = new URL(origin).host;
    } catch (e) {
        return false;
    }
    if (ALLOWED_HOSTS.includes(host)) return true;
    // 所有 GitHub Pages 子域放行：fork 之后你自己的 xxx.github.io 也能用
    if (host.endsWith('.github.io')) return true;
    // 本地开发
    if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return true;
    return false;
}

function corsHeaders(origin) {
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin',
    };
}

function json(body, status, origin) {
    return new Response(JSON.stringify(body), {
        status: status,
        headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(origin)),
    });
}

/**
 * 转发到 GitHub。原样透传状态码和响应体，
 * 让前端自己判断 authorization_pending / slow_down / expired_token。
 */
async function proxyTo(url, formBody) {
    const r = await fetch(url, {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'github-drive-oauth-proxy',
        },
        body: formBody,
    });

    const text = await r.text();
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        // GitHub 偶尔返回 form-encoded，手工转成对象，前端逻辑就不用分两套
        parsed = {};
        new URLSearchParams(text).forEach((v, k) => { parsed[k] = v; });
    }
    return { status: r.status, body: parsed };
}

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') || '';

        // 预检
        if (request.method === 'OPTIONS') {
            if (!originAllowed(origin)) return new Response(null, { status: 403 });
            return new Response(null, { status: 204, headers: corsHeaders(origin) });
        }

        if (request.method !== 'POST') {
            return json({ error: 'method_not_allowed' }, 405, originAllowed(origin) ? origin : '');
        }

        // 来源不对直接拒。这一条同时是 CSRF 防线：
        // 浏览器会自动带 Origin，攻击者伪造不了。
        if (!originAllowed(origin)) {
            return new Response('Forbidden origin', { status: 403 });
        }

        const path = new URL(request.url).pathname.replace(/\/+$/, '');
        let payload;
        try {
            payload = await request.json();
        } catch (e) {
            return json({ error: 'invalid_json' }, 400, origin);
        }

        // ── 1. 申请设备码 ──────────────────────────────────
        if (path === '/device/code') {
            if (!payload.client_id) return json({ error: 'missing_client_id' }, 400, origin);

            const form = new URLSearchParams();
            form.set('client_id', String(payload.client_id));
            // 只认这两个 scope，前端传什么都不采纳——
            // 否则有人能用你的 client_id 换到更高权限的 token
            form.set('scope', 'repo,workflow');

            try {
                const res = await proxyTo('https://github.com/login/device/code', form.toString());
                return json(res.body, res.status, origin);
            } catch (e) {
                return json({ error: 'upstream_failed' }, 502, origin);
            }
        }

        // ── 2. 轮询 / 换取 token ───────────────────────────
        if (path === '/device/token') {
            if (!payload.client_id || !payload.device_code) {
                return json({ error: 'missing_params' }, 400, origin);
            }

            const form = new URLSearchParams();
            form.set('client_id', String(payload.client_id));
            form.set('device_code', String(payload.device_code));
            form.set('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');

            try {
                const res = await proxyTo('https://github.com/login/oauth/access_token', form.toString());
                return json(res.body, res.status, origin);
            } catch (e) {
                return json({ error: 'upstream_failed' }, 502, origin);
            }
        }

        return json({ error: 'not_found' }, 404, origin);
    },
};
