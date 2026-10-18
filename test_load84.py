#!/usr/bin/env python3
"""
v0.0.84 加载改造验证

背景：用户反馈"每次版本升级要等很久页面才有响应"。

这一版动的是两件事，都不改功能、只改加载方式：

  1) CORE 脚本 + CSS 从 document.write 改成静态标签
     原来 URL 是内联 JS 运行时拼的。浏览器的预加载扫描器只扫 HTML 文本、
     不执行 JS —— 它看不见这些 URL，必须等 HTML 下载完、那段 JS 跑完才
     发起请求，白等一到两个 RTT。CSS 还是渲染阻塞资源，这个等待直接压在
     首屏上。

  2) CSS 的 URL 从 ?v=N 改成 ?h=<内容 hash>；--stamp 移出 CSS
     bump_version.py 会把所有 ?v= 刷成新版本号，于是 66KB 的样式表跟着
     JS 一起失效 —— 哪怕这轮一行 CSS 都没改。而 --stamp 每轮都变，留在
     CSS 里会把内容 hash 也带着变，第 2 点的优化就白做了。

★ 本测试只做静态分析 + 语法检查，不启动浏览器（沙箱里装不上 Chromium）。
  它证明不了"快了多少毫秒"，只能证明"优化所依赖的前提成立"：
    - URL 是静态字符串（扫描器看得见）
    - 顺序没乱（跨文件顶层符号依赖顺序）
    - CSS 不再被版本号连坐
    - 版本戳换了位置之后仍然读得到
"""
import hashlib
import os
import re
import subprocess
import sys
import tempfile

ROOT = '/data/workspace/gd_live'
INDEX = os.path.join(ROOT, 'index.html')

CORE_FILES = [
    'icons', 'github-api', 'storage', 'file-manager', 'config-sync',
    'task-dock', 'ui', 'i18n', 'version', 'anim', 'gesture', 'custom',
    'theme', 'i18n-scan', 'app',
]
DEFERRED = ['bridge', 'cangshu-link', 'maintain', 'share', 'plugin-api']

html = open(INDEX, encoding='utf-8').read()

P = F = 0


def ok(cond, msg):
    global P, F
    if cond:
        P += 1
        print('  ✅ ' + msg)
    else:
        F += 1
        print('  ❌ ' + msg)


print('\n=== 1. 预加载扫描器可见性（本次改造的核心） ===')
# 扫描器的工作方式：拿 HTML 原始文本，正则抠 src=/href=，不执行任何 JS。
# 所以用"不执行 JS"的方式能否抠出 URL，就是它能否被发现。
scanned = re.findall(r'<(?:script|link)[^>]*?(?:src|href)="([^"]+)"', html)

# 1a. CSS
css_urls = [u for u in scanned if u.startswith('css/')]
ok(len(css_urls) >= 1, 'CSS 以静态 href 出现在 HTML 文本里: %s' % (css_urls[:1] or '无'))
ok(any('?h=' in u for u in css_urls),
   'CSS 的 URL 带内容 hash（不是 ?v=）: %s' % (css_urls[:1] or ''))
ok(not any('?v=' in u for u in css_urls),
   'CSS 不再挂 ?v=（否则每次 bump 都会被连坐重下）')

# 1b. CORE 脚本
core_static = re.findall(r'<script defer src="(js/[^"]+)" data-gd-core="([^"]+)"', html)
ok(len(core_static) == 15, 'CORE 静态标签 15 个（实测 %d）' % len(core_static))
ok([n for _, n in core_static] == CORE_FILES,
   '静态标签顺序 == CORE_FILES（ui 依赖 i18n 等跨文件符号，顺序不能乱）')

for f in CORE_FILES:
    url = 'js/%s.min.js' % f
    ok(any(u.startswith(url) for u in scanned), '%s 的 URL 是静态字符串，扫描器可见' % f)

# 1c. 确认 document.write 那条老路已经拆掉
ok('CORE.forEach' not in html, '不再用 document.write 循环注入 CORE')
ok(not re.search(r"document\.write\('<script src=\"'\s*\+\s*url", html),
   '没有残留的 document.write 脚本注入')

print('\n=== 1b. hash 与文件实际内容一致（手工改 min 最容易漏这一步）===')
# ★ 只要有人手工改了某个 .min.js 却没重算 hash，URL 就不变 ——
#   浏览器和 CDN 继续返回缓存里的旧文件，改了等于没改，而且毫无报错。
#   这轮就抓到三个：app / version 是我刚改的，storage 是历史遗留
#   （它的 min 其实是新的，但 URL 一直指着旧 hash，用户根本没拿到）。
inlined = dict(re.findall(r'<script defer src="js/([^"]+)\.min\.js\?h=([0-9a-f]+)"', html))
stale = []
for f, h in inlined.items():
    pth = os.path.join(ROOT, 'js', f + '.min.js')
    real = hashlib.sha256(open(pth, 'rb').read()).hexdigest()[:10]
    if real != h:
        stale.append('%s(%s→%s)' % (f, h, real))
ok(not stale, '15 个 CORE 的 ?h= 都等于文件实际 hash' + ('' if not stale else ': ' + ', '.join(stale)))

print('\n=== 2. CSS 增量：改 JS 不应影响 CSS 的 URL ===')
cur_css_h = re.search(r'css/style\.min\.css\?h=([0-9a-f]+)', html).group(1)
real_h = hashlib.sha256(open(os.path.join(ROOT, 'css/style.min.css'), 'rb').read()).hexdigest()[:10]
ok(cur_css_h == real_h, 'index.html 的 CSS hash == 实际文件内容 hash (%s)' % real_h)
ok('--stamp' not in open(os.path.join(ROOT, 'css/style.min.css'), encoding='utf-8').read(),
   'CSS 里不含 --stamp（它每轮都变，会把 hash 带变）')
ok(re.search(r'--api-stamp:\s*"7"', open(os.path.join(ROOT, 'css/style.min.css'), encoding='utf-8').read())
   is not None, 'CSS 仍带 --api-stamp（契约检测还要用）')

# 模拟一次"只改 JS 的 bump"：把 index.html 的 ?v= 全刷一遍，CSS hash 不该变
sim = re.sub(r'(\?v=)[0-9]+', r'\g<1>999', html)
ok(re.search(r'css/style\.min\.css\?h=([0-9a-f]+)', sim).group(1) == cur_css_h,
   '把 ?v= 刷成 999 之后 CSS hash 不变（这才是"改 JS 不重下 CSS"）')

print('\n=== 3. 版本戳换了位置之后仍可读 ===')
ok(re.search(r'<style>#gd-css-stamp\{--stamp:"\d+"\}</style>', html) is not None,
   '内联 <style> 提供 --stamp')
inline_stamp = re.search(r'--stamp:"(\d+)"', html).group(1)
vjs = open(os.path.join(ROOT, 'js/version.js'), encoding='utf-8').read()
want = re.search(r"internalVersion:\s*'([^']+)'", vjs).group(1)
ok(inline_stamp == want, '内联 --stamp(%s) == version.js internalVersion(%s)' % (inline_stamp, want))

appjs = open(os.path.join(ROOT, 'js/app.js'), encoding='utf-8').read()
i = appjs.find("if (r.selectorText === '#gd-css-stamp')")
seg = appjs[i:i + 700]
ok('const v =' in seg or 'const v=' in seg, 'app.js 用局部 const 承接两个值')
ok('if (v && !gotVer) gotVer = v' in seg, 'app.js 累加 --stamp（不覆盖已取到的）')
ok('if (a && !gotApi) gotApi = a' in seg, 'app.js 累加 --api-stamp')
ok('if (gotVer && gotApi) break' in seg,
   '两个都取到才 break —— 否则 --stamp(内联) 与 --api-stamp(css) 会漏一个')

appmin = open(os.path.join(ROOT, 'js/app.min.js'), encoding='utf-8').read()
ok('_gdv&&!s&&(s=_gdv)' in appmin and '_gda&&!o&&(o=_gda)' in appmin,
   'app.min.js 同步了累加逻辑（页面加载的是 min）')
ok('if(s&&o)break' in appmin, 'app.min.js 的 break 条件同步为 &&')

print('\n=== 4. 版本号四处一致 ===')
mv = re.search(r"internalVersion:\s*'([^']+)'", vjs).group(1)
ma = re.search(r"apiVersion:\s*'([^']+)'", vjs).group(1)
ok(re.search(r'\?v=%s&api_v=%s' % (mv, ma), html) is not None,
   'index.html 的 ?v=%s&api_v=%s' % (mv, ma))
ok('data-api-v="%s"' % ma in html, 'body 的 data-api-v=%s' % ma)
vmin = open(os.path.join(ROOT, 'js/version.min.js'), encoding='utf-8').read()
ok('internalVersion:"%s"' % mv in vmin, 'version.min.js internalVersion=%s' % mv)
ok('apiVersion:"%s"' % ma in vmin, 'version.min.js apiVersion=%s' % ma)
ok(re.search(r'--api-stamp:\s*"%s"' % ma,
             open(os.path.join(ROOT, 'css/style.min.css'), encoding='utf-8').read()) is not None,
   'CSS --api-stamp=%s' % ma)

print('\n=== 5. 语法（内联脚本语法错会让整页 JS 全崩）===')
blocks = re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', html, re.S)
bad = []
for n, b in enumerate(blocks):
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False, encoding='utf-8') as tf:
        tf.write(b)
        tmp = tf.name
    r = subprocess.run(['node', '--check', tmp], capture_output=True, text=True)
    os.unlink(tmp)
    if r.returncode != 0:
        bad.append('第%d段: %s' % (n + 1, r.stderr.strip()[:120]))
ok(not bad, 'index.html 内联脚本 %d 段全部语法正确%s' % (len(blocks), '' if not bad else ': ' + bad[0]))

for f in ['app', 'version']:
    for suf in ['.js', '.min.js']:
        p = os.path.join(ROOT, 'js', f + suf)
        r = subprocess.run(['node', '--check', p], capture_output=True, text=True)
        ok(r.returncode == 0, 'js/%s%s 语法正确' % (f, suf))

print('\n=== 6. 回归：文件都在，DEFER 没被误挪进首屏 ===')
for f in CORE_FILES + DEFERRED + ['branch-guard']:
    p = os.path.join(ROOT, 'js', f + '.min.js')
    ok(os.path.exists(p), 'js/%s.min.js 存在' % f)
for f in DEFERRED:
    ok('data-gd-core="%s"' % f not in html, '%s 不在 CORE 静态标签里（仍是 DEFER）' % f)
ok('var DEFER = [' in html or "DEFER = [" in html, 'DEFER 列表仍在')
ok('__GD_DEFER__' in html, '__GD_DEFER__ 仍会挂载')

print('\n=== 7. 分支覆盖：自定义分支时 CDN 版本不被本地 defer 盖掉 ===')
ok('if (base) {' in html and "window.addEventListener('DOMContentLoaded'" in html,
   '自定义分支的 CDN 加载挂在 DOMContentLoaded 之后')
seg2 = html[html.find('if (base) {'):html.find('window.__GD_DEFER__')]
ok('var i = 0' in seg2 and 'next()' in seg2, 'CDN 脚本按序串行加载（保住跨文件依赖）')

print('\n=== 8. build.py 能维护这两处 hash ===')
bp = open(os.path.join(ROOT, 'build.py'), encoding='utf-8').read()
ok('CORE_TAG_RE' in bp and '_sync_core_tags' in bp, 'build.py 会同步静态标签的 ?h=')
ok("css/style\\.min\\.css\\?h=" in bp, 'build.py 会同步 CSS 的 ?h=')
ok('找不到静态 CORE 标签块' in bp, '标签块丢了会报错中止（而不是静默留旧 URL）')

print('\n' + '=' * 52)
print('通过 %d / 失败 %d' % (P, F))
print('=' * 52)
sys.exit(1 if F else 0)
