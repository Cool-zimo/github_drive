#!/usr/bin/env python3
"""
构建脚本 - 生成 minified 资源，并给每个文件单独打 content-hash 版本号。

★ 为什么要有这个脚本

原来 index.html 里所有 JS 共用同一个查询串 ?v=75。版本号一变，
20 个文件的 URL 全部改变，浏览器缓存全部作废 —— 即使这次只改了
其中一个文件，用户也要把 793KB（gzip 216KB）整个重新下载一遍。
这就是"每次版本升级都要等很久"的直接原因。

改成按文件内容算 hash 之后：改哪个文件，只有那个文件的 URL 变，
其余 19 个继续命中缓存。典型的一次改动涉及 1~3 个文件，
下载量从 216KB 降到几十 KB。

★ 设计取舍

- 源文件 js/*.js 保持可读、可继续直接编辑；产物是 js/*.min.js。
  代价是仓库里存两份。好处是不破坏"直接改 js 再提交"的工作方式。
- hash 挂在 ?h= 而不是 ?v= 上。release.py 里有个正则会把
  ([?&]v=)\d+ 统一替换成新版本号 —— 如果 hash 也用 ?v= 且恰好是纯数字，
  会被那条规则一起改掉，content-hash 就失效了。
- CSS 仍用 ?v=N。CSS 只有一个文件，不存在"被别的改动连坐"的问题。

用法:
  python build.py            # 构建
  python build.py --check    # 只检查产物是否过期，不改文件
"""
import hashlib
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
JS_DIR = os.path.join(ROOT, 'js')
CSS_DIR = os.path.join(ROOT, 'css')
INDEX = os.path.join(ROOT, 'index.html')
MANIFEST = os.path.join(ROOT, 'assets', 'asset-manifest.json')

# 由 index.html 里的加载顺序决定，这里只用来生成 manifest 和做校验
CORE_FILES = [
    'icons', 'github-api', 'storage', 'file-manager', 'config-sync',
    'task-dock', 'ui', 'i18n', 'version', 'anim', 'gesture', 'custom',
    'theme', 'i18n-scan', 'app',
]
# 这些不阻塞首屏：登录成功后才加载
DEFERRED_FILES = ['bridge', 'cangshu-link', 'maintain', 'share', 'plugin-api']



def _check_inline_scripts(html):
    """校验 index.html 里所有内联 <script> 的语法。

    出过的事故：GD_HASH 里 'branch-guard' 写成裸键，含连字符是非法标识符，
    整段内联脚本语法错误 -> CORE 脚本一个都没加载 -> 点"进入 Drive"完全没反应。
    """
    import tempfile
    blocks = re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', html, re.S)
    for i, b in enumerate(blocks):
        with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False,
                                         encoding='utf-8') as tf:
            tf.write(b)
            tmp = tf.name
        r = subprocess.run(['node', '--check', tmp], capture_output=True, text=True)
        os.unlink(tmp)
        if r.returncode != 0:
            raise RuntimeError(
                'index.html 第 %d 段内联 <script> 语法错误，已中止构建:\n%s'
                % (i + 1, r.stderr[:800]))


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError('命令失败: %s\n%s' % (' '.join(cmd), r.stderr))
    return r.stdout


def sha10(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()[:10]


def minify(src, dst):
    """压缩单个文件。

    ★ 只开 --minify-syntax 和 --minify-whitespace，不开 --minify-identifiers。

      这些 js 是靠"顶层符号互相引用"串起来的（ui.js 里 new Maintain(...)，
      app.js 里 new ShareManager(...)），每个文件又是独立压缩的。
      一旦允许重命名顶层标识符，maintain.min.js 把 Maintain 改成短名，
      而 ui.min.js 里的 Maintain 被改成另一个短名 —— 两边对不上，
      运行时才会炸 ReferenceError，构建期一点迹象都没有。

      实测：允许重命名 gzip 后 126KB，不允许 133KB。
      多省 7KB 换一个跨文件符号错位的风险，不值得。

    ★ 也不能加 --keep-names：它会给每个函数插一段
      Object.defineProperty(..., "name", ...) 来保住函数名，
      实测 795KB 的源码压完反而涨到 973KB。
    """
    run(['esbuild', src, '--minify-syntax', '--minify-whitespace',
         '--target=es2019', '--outfile=' + dst, '--log-level=error'])


# ★ 注意：注释结尾用的是中文句号「。」，不是 "."。第一次写成 \. 时
#   正则整体匹配不上，函数直接抛"找不到标签块" —— 表现得像标签被删了，
#   实际只是标点不匹配。这里不写死结尾标点。
CORE_TAG_RE = re.compile(
    r'(    <!-- ★ CORE 静态化 \+ defer.*?-->\n)'
    r'((?:    <script defer src="js/[^"]+" data-gd-core="[^"]+"></script>\n)+)',
    re.S)


def _sync_core_tags(html, hashes):
    """按 CORE_FILES 重写 head 里的静态 script 标签（顺序 + hash 都要对）。"""
    tags = "".join(
        '    <script defer src="js/%s.min.js?h=%s" data-gd-core="%s"></script>\n'
        % (f, hashes[f], f)
        for f in CORE_FILES)
    new_html, n = CORE_TAG_RE.subn(lambda m: m.group(1) + tags, html, count=1)
    if n == 0:
        raise RuntimeError(
            'index.html 里找不到静态 CORE 标签块 —— 标签被改动过或注释被删了，'
            '会导致改了 js 而 URL 不变，用户一直拿到旧文件')
    return new_html


def build():
    hashes = {}

    # ---- JS ----
    for name in sorted(os.listdir(JS_DIR)):
        if not name.endswith('.js') or name.endswith('.min.js'):
            continue
        src = os.path.join(JS_DIR, name)
        dst = os.path.join(JS_DIR, name[:-3] + '.min.js')
        minify(src, dst)
        hashes[name[:-3]] = sha10(dst)

    # ---- CSS ----
    css_src = os.path.join(CSS_DIR, 'style.css')
    css_dst = os.path.join(CSS_DIR, 'style.min.css')
    minify(css_src, css_dst)
    css_hash = sha10(css_dst)

    # ★ CSS 也走 content-hash。
    #   原来是 ?v=N —— bump_version.py 每次升级把全部 ?v= 刷一遍，于是
    #   66KB 的样式表跟着 JS 一起失效，哪怕这轮一个字节的 CSS 都没改。
    #   这是"每次升级都要等很久"里最不该花的那笔下载。
    #
    #   配套：CSS 里的 --stamp 已移到 index.html 的内联 <style>。
    #   它原本每次 bump 都变，留在 CSS 里会让内容 hash 跟着变，
    #   content-hash 就白做了。
    with open(INDEX, 'r', encoding='utf-8') as f:
        _h = f.read()
    _h2, n = re.subn(r'(css/style\.min\.css\?h=)[0-9a-f]+',
                     r'\g<1>' + css_hash, _h, count=1)
    if n == 0:
        raise RuntimeError(
            'index.html 里找不到 css/style.min.css?h= —— CSS 的 URL 被改回 ?v= 了？'
            '那每次升级都会连带重新下载整份样式表')
    with open(INDEX, 'w', encoding='utf-8') as f:
        f.write(_h2)

    # ---- 写 manifest（供排查用，页面运行时不读它）----
    with open(MANIFEST, 'w', encoding='utf-8') as f:
        json.dump({'hashes': hashes}, f, ensure_ascii=False, indent=2)

    # ---- 把 hash 表内联进 index.html ----
    with open(INDEX, 'r', encoding='utf-8') as f:
        html = f.read()

    # ---- 同步 head 里的静态 <script defer> 标签 ----
    #
    # ★ 这 15 个标签是 v0.0.84 从 document.write 改过来的（让预加载扫描器
    #   能看见它们）。改完之后 hash 有两处：内联的 GD_HASH 表 + 这些标签的
    #   ?h= 。只更新前者会让静态标签一直指向旧文件，表现得比不改还糟 ——
    #   表是新的、实际加载的是旧的，版本自检会误判。
    html = _sync_core_tags(html, hashes)

    # ★ 键必须加引号：文件名含连字符（如 branch-guard）时，裸键是非法标识符，
    #   会让整段内联 <script> 语法错误 —— 表现是"页面 JS 全崩、点按钮没反应"，
    #   而语法检查只报一句 Unexpected token '-'，极难联想到这里。
    table = ',\n'.join("            '%s': '%s'" % (k, v)
                       for k, v in sorted(hashes.items()))
    block = (
        "        // ★ 由 build.py 生成：每个文件的内容 hash。\n"
        "        //   改哪个文件，只有那个文件的 URL 变，其余继续命中缓存。\n"
        "        var GD_HASH = {\n" + table + "\n        };\n"
    )
    new_html, n = re.subn(
        r'        // ★ 由 build\.py 生成.*?var GD_HASH = \{.*?\};\n',
        block, html, flags=re.S)
    if n == 0:
        new_html, n = re.subn(r'(        var files = \[)', block + r'\1',
                              html, count=1)
        if n == 0:
            raise RuntimeError('index.html 里找不到 GD_HASH 注入点')

    with open(INDEX, 'w', encoding='utf-8') as f:
        f.write(new_html)

    # ★ 自检：注入完后立刻校验 index.html 里所有内联 <script> 的语法。
    #   GD_HASH 的裸键事故就是靠这一步才能当场拦住。
    _check_inline_scripts(new_html)

    return hashes


def check():
    """检查 js/*.js 是否已经构建过（min 产物的 hash 与源码构建结果一致）"""
    stale = []
    for name in sorted(os.listdir(JS_DIR)):
        if not name.endswith('.js') or name.endswith('.min.js'):
            continue
        if name == 'version.js':
            continue
        src = os.path.join(JS_DIR, name)
        dst = os.path.join(JS_DIR, name[:-3] + '.min.js')
        if not os.path.exists(dst):
            stale.append(name + ' (缺产物)')
            continue
        tmp = '/tmp/_gd_chk.min.js'
        minify(src, tmp)
        if sha10(tmp) != sha10(dst):
            stale.append(name)
    return stale


if __name__ == '__main__':
    if '--check' in sys.argv:
        s = check()
        if s:
            print('⚠️ 以下源文件的压缩产物已过期，请跑 python build.py：')
            for x in s:
                print('   -', x)
            sys.exit(1)
        print('✅ 所有压缩产物都是最新的')
        sys.exit(0)

    h = build()
    raw = sum(os.path.getsize(os.path.join(JS_DIR, n))
              for n in os.listdir(JS_DIR)
              if n.endswith('.js') and not n.endswith('.min.js'))
    mini = sum(os.path.getsize(os.path.join(JS_DIR, n))
               for n in os.listdir(JS_DIR) if n.endswith('.min.js'))
    print('✅ 构建完成：%d 个文件' % len(h))
    print('   JS  %d → %d 字节 (%.0f%%)' % (raw, mini, 100.0 * mini / raw))
