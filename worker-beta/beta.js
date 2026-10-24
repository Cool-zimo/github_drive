/**
 * gd-beta · GitHub Drive 后端 beta
 *
 * ── 这个 Worker 不做什么 ──────────────────────────────
 * 它不存文件。Drive 的存储层仍然是 GitHub 仓库：
 * 免费、无容量上限、自带完整版本历史。
 * 换成 R2 只会换来 10GB 的免费上限和一次彻底重写，不划算。
 *
 * ── 它做什么 ──────────────────────────────────────────
 * 只做纯前端做不到、而 GitHub 本身也不提供的那几件事：
 *   1. 分享链接：带密码、可过期、能统计访问次数
 *      （现在的实现是把分享信息写进仓库 JSON，
 *        任何人能看到仓库就能看到你分享过什么）
 *   2. 用户配置跨设备同步
 *   3. 身份校验：拿 GitHub token 换 login，后端不存密码
 *
 * ── 存储 ──────────────────────────────────────────────
 * D1，两张表（schema.sql）。不碰 KV / R2 / Durable Object。
 */

const VERSION = '0.1.0';

// ── 来源白名单 ────────────────────────────────────────
// 写操作必须来自这些站点，否则任何人都能往你的库里塞数据。
const ALLOWED_HOSTS = [
    'cool-zimo.github.io',
    'fengzimo.eu.org',          // 免费域名，nic.eu.org 审核通过后启用
    'fengzimo.is-a.dev',        // is-a.dev 子域，NS 委派到 Cloudflare
    'fengzimo.is-a.bot',        // is-a.bot 子域（与主申请并行，哪个先批用哪个）
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
    // fork 之后你自己的 xxx.github.io 也能用
    if (host.endsWith('.github.io')) return true;
    if (host.endsWith('.fengzimo.eu.org')) return true;
    if (host.endsWith('.fengzimo.is-a.dev')) return true;
    if (host.endsWith('.fengzimo.is-a.bot')) return true;
    if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return true;
    return false;
}

function corsHeaders(origin) {
    return {
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

// ── 工具 ──────────────────────────────────────────────

// 短 id：去掉了 0/O/1/l 这些容易念错的字符，因为分享链接是要口述的
function newId() {
    const chars = 'abcdefghijkmnopqrstuvwxyz23456789';
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    let s = '';
    for (const b of buf) s += chars[b % chars.length];
    return s;
}

async function hashPassword(pw) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
    return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

// 拿 GitHub token 换用户名。后端不存任何凭证，
// 每次都去问 GitHub——token 被吊销了这里立刻失效。
async function githubLogin(token) {
    if (!token) return null;
    if (!/^(ghp_|github_pat_|gho_)/.test(token)) return null;
    try {
        const r = await fetch('https://api.github.com/user', {
            headers: {
                Authorization: 'Bearer ' + token,
                Accept: 'application/vnd.github+json',
                'User-Agent': 'gd-beta',
            },
        });
        if (!r.ok) return null;
        const j = await r.json();
        return j.login || null;
    } catch (e) {
        return null;
    }
}

function bearerToken(request) {
    const h = request.headers.get('Authorization') || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : null;
}

// ── 状态页 ────────────────────────────────────────────
// 浏览器直接打开能看到服务活着没有，不用 curl
function htmlPage(info) {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));
    const ok = info.d1 === 'ok';
    return new Response(`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GitHub Drive 后端 beta</title>
<style>
body{margin:0;padding:32px;font:15px/1.6 system-ui,-apple-system,sans-serif;
background:#0d1117;color:#c9d1d9}
.wrap{max-width:560px;margin:0 auto}
h1{font-size:20px;margin:0 0 4px}
.sub{color:#8b949e;font-size:13px;margin:0 0 24px}
.row{display:flex;justify-content:space-between;padding:10px 0;
border-bottom:1px solid #21262d}
.k{color:#8b949e}.v{font-variant-numeric:tabular-nums}
.ok{color:#3fb950}.bad{color:#f85149}
</style></head><body><div class="wrap">
<h1>GitHub Drive 后端 beta</h1>
<p class="sub">文件本体仍在 GitHub 仓库，这里只存分享与配置</p>
<div class="row"><span class="k">版本</span><span class="v">${esc(VERSION)}</span></div>
<div class="row"><span class="k">数据库</span><span class="v ${ok ? 'ok' : 'bad'}">${esc(info.d1)}</span></div>
<div class="row"><span class="k">分享条目</span><span class="v">${esc(info.shares)}</span></div>
<div class="row"><span class="k">用户配置</span><span class="v">${esc(info.users)}</span></div>
</div></body></html>`, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}

// ── 建表 ──────────────────────────────────────────────
// 不走 wrangler d1 execute，改成运行时惰性建表：
// 通过 binding 执行 SQL 不需要 D1 的 API 权限，
// 而 API Token 常常只有 Workers 权限、没有 D1 权限（此时会返回 401）。
let schemaReady = false;

async function ensureSchema(env) {
    if (schemaReady) return;
    await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS shares (
            id TEXT PRIMARY KEY,
            owner TEXT NOT NULL,
            repo TEXT NOT NULL,
            path TEXT NOT NULL,
            files TEXT NOT NULL,
            password_hash TEXT,
            expire_at INTEGER,
            views INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        )`
    ).run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_shares_owner ON shares(owner)').run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_shares_expire ON shares(expire_at)').run();
    await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS users (
            login TEXT PRIMARY KEY,
            config TEXT,
            updated_at INTEGER NOT NULL
        )`
    ).run();
    schemaReady = true;
}

// ── 主入口 ────────────────────────────────────────────
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const origin = request.headers.get('Origin') || '';
        const path = url.pathname.replace(/\/+$/, '') || '/';
        const method = request.method;

        if (method === 'OPTIONS') {
            if (!originAllowed(origin)) return new Response(null, { status: 403 });
            return new Response(null, { status: 204, headers: corsHeaders(origin) });
        }

        // 首次访问时建表（幂等，后续请求直接跳过）
        try {
            await ensureSchema(env);
        } catch (e) {
            return json({ error: 'db_init_failed', detail: String((e && e.message) || e) }, 500, origin);
        }

        // ── 状态页 ──
        if (method === 'GET' && path === '/') {
            let d1 = 'ok';
            let shares = '-';
            let users = '-';
            try {
                const s = await env.DB.prepare('SELECT COUNT(*) AS n FROM shares').first();
                const u = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
                shares = s.n;
                users = u.n;
            } catch (e) {
                d1 = 'error: ' + (e && e.message ? e.message : String(e));
            }
            return htmlPage({ d1: d1, shares: shares, users: users });
        }

        // ── 健康检查 ──
        if (method === 'GET' && path === '/api/health') {
            let db = 'ok';
            try {
                await env.DB.prepare('SELECT 1').first();
            } catch (e) {
                db = 'error';
            }
            return json({ ok: db === 'ok', version: VERSION, d1: db }, db === 'ok' ? 200 : 500, origin);
        }

        // ── 写操作必须校验来源 ──
        // 没有这一条，任何人都能往库里写东西、刷爆免费额度
        const isWrite = method === 'POST' || method === 'PUT' || method === 'DELETE';
        if (isWrite && !originAllowed(origin)) {
            return json({ error: 'forbidden_origin' }, 403, origin);
        }

        // ── 创建分享 ──
        if (method === 'POST' && path === '/api/share') {
            const token = bearerToken(request);
            const login = await githubLogin(token);
            if (!login) return json({ error: 'bad_token' }, 401, origin);

            let body;
            try {
                body = await request.json();
            } catch (e) {
                return json({ error: 'invalid_json' }, 400, origin);
            }
            if (!body.repo || !body.files) {
                return json({ error: 'missing_fields' }, 400, origin);
            }

            const id = newId();
            const now = Math.floor(Date.now() / 1000);
            const expireAt = body.expireDays
                ? now + Math.floor(body.expireDays) * 86400
                : null;
            const pwHash = body.password ? await hashPassword(body.password) : null;

            await env.DB.prepare(
                `INSERT INTO shares
                 (id, owner, repo, path, files, password_hash, expire_at, views, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
            )
                .bind(
                    id,
                    login,
                    String(body.repo),
                    String(body.path || '/'),
                    JSON.stringify(body.files),
                    pwHash,
                    expireAt,
                    now
                )
                .run();

            return json({ id: id, url: '/s/' + id }, 201, origin);
        }

        // ── 读取分享 ──
        // GET 允许无 Origin：用户点开链接时浏览器不发 Origin，
        // 而分享本来就是"知道 id 就能看"的东西
        const shareMatch = path.match(/^\/api\/share\/([a-z0-9]+)$/);
        if (shareMatch && method === 'GET') {
            const id = shareMatch[1];
            const row = await env.DB.prepare('SELECT * FROM shares WHERE id = ?').bind(id).first();
            if (!row) return json({ error: 'not_found' }, 404, origin);

            const now = Math.floor(Date.now() / 1000);
            if (row.expire_at && row.expire_at < now) {
                return json({ error: 'expired' }, 410, origin);
            }

            if (row.password_hash) {
                const given = url.searchParams.get('password') || '';
                const h = await hashPassword(given);
                if (h !== row.password_hash) {
                    return json({ error: 'password_required' }, 401, origin);
                }
            }

            // 访问次数自增。放在这里而不是前面，
            // 密码错了不该计数——否则可以拿它试探密码是否正确
            await env.DB.prepare('UPDATE shares SET views = views + 1 WHERE id = ?')
                .bind(id)
                .run();

            let files;
            try {
                files = JSON.parse(row.files);
            } catch (e) {
                files = [];
            }

            return json({
                id: row.id,
                owner: row.owner,
                repo: row.repo,
                path: row.path,
                files: files,
                createdAt: row.created_at,
                views: row.views + 1,
                hasPassword: !!row.password_hash,
            }, 200, origin);
        }

        // ── 删除分享 ──
        if (shareMatch && method === 'DELETE') {
            const token = bearerToken(request);
            const login = await githubLogin(token);
            if (!login) return json({ error: 'bad_token' }, 401, origin);

            const id = shareMatch[1];
            const row = await env.DB.prepare('SELECT owner FROM shares WHERE id = ?').bind(id).first();
            if (!row) return json({ error: 'not_found' }, 404, origin);
            // 只能删自己的
            if (row.owner !== login) return json({ error: 'not_owner' }, 403, origin);

            await env.DB.prepare('DELETE FROM shares WHERE id = ?').bind(id).run();
            return json({ ok: true }, 200, origin);
        }

        // ── 我的分享列表 ──
        if (method === 'GET' && path === '/api/shares') {
            const token = bearerToken(request);
            const login = await githubLogin(token);
            if (!login) return json({ error: 'bad_token' }, 401, origin);

            const rows = await env.DB.prepare(
                'SELECT id, repo, path, expire_at, views, created_at FROM shares WHERE owner = ? ORDER BY created_at DESC LIMIT 100'
            ).bind(login).all();

            return json({ shares: rows.results || [] }, 200, origin);
        }

        // ── 用户配置 ──
        if (path === '/api/config') {
            const token = bearerToken(request);
            const login = await githubLogin(token);
            if (!login) return json({ error: 'bad_token' }, 401, origin);

            if (method === 'GET') {
                const row = await env.DB.prepare('SELECT config, updated_at FROM users WHERE login = ?')
                    .bind(login).first();
                let cfg = null;
                if (row && row.config) {
                    try {
                        cfg = JSON.parse(row.config);
                    } catch (e) {
                        cfg = null;
                    }
                }
                return json({ config: cfg, updatedAt: row ? row.updated_at : null }, 200, origin);
            }

            if (method === 'PUT') {
                let body;
                try {
                    body = await request.json();
                } catch (e) {
                    return json({ error: 'invalid_json' }, 400, origin);
                }
                const now = Math.floor(Date.now() / 1000);
                // upsert：SQLite 的 ON CONFLICT，省一次查询
                await env.DB.prepare(
                    `INSERT INTO users (login, config, updated_at) VALUES (?, ?, ?)
                     ON CONFLICT(login) DO UPDATE SET config = excluded.config,
                     updated_at = excluded.updated_at`
                ).bind(login, JSON.stringify(body.config || {}), now).run();

                return json({ ok: true, updatedAt: now }, 200, origin);
            }
        }

        return json({ error: 'not_found' }, 404, origin);
    },
};
