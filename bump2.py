#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
第二代版本号 bump 工具
=====================
格式：A.B.C = 超级大迭代号 . API版本号 . 小版本号

用法：
    python3 bump2.py           # 默认 patch：0.7.89 -> 0.7.90
    python3 bump2.py patch     # 同上
    python3 bump2.py api       # 0.7.89 -> 0.8.0   契约变化
    python3 bump2.py major     # 0.7.89 -> 1.0.0   架构换代

规则：
  patch —— 内容修复、样式微调、文案翻译、性能优化。只 +C。
           ★ 不动 CSS 的 --api-stamp，样式表内容 hash 不变，用户不必重下 66KB。
  api   —— HTML 结构 / JS 操作的 class / 元素 id / CSS 里被 JS 依赖的规则 变了。
           +B，C 归零；同时更新 CSS 的 --api-stamp 和 body 的 data-api-v。
  major —— 架构级换代。+A，B、C 归零。

★ 为什么只维护一个串：
  第一代要同时维护「应用版本号 0.0.N」和「API 版本号 api_v」两个独立递增的数字，
  曾出现 style.min.css 停在 75/6 而 version.js 已是 76/7 —— 自检误报「样式是旧版」。
  第二代把 API 版本合成到中段，不可能再不同步，也不必分两次命名。
"""
import re
import sys
import hashlib
import os

FILES = {
    'version_js':  'js/version.js',
    'version_min': 'js/version.min.js',
    'index':       'index.html',
    'css':         'css/style.css',
    'css_min':     'css/style.min.css',
}


def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()


def write(p, s):
    with open(p, 'w', encoding='utf-8') as f:
        f.write(s)


def get_version(s):
    m = re.search(r"^\s*version:\s*'([0-9]+\.[0-9]+\.[0-9]+)'", s, re.M)
    if not m:
        raise SystemExit('✗ 在 version.js 里找不到 version: 字段')
    return m.group(1)


def bump(v, level):
    a, b, c = (int(x) for x in v.split('.'))
    if level == 'patch':
        c += 1
    elif level == 'api':
        b, c = b + 1, 0
    elif level == 'major':
        a, b, c = a + 1, 0, 0
    else:
        raise SystemExit('✗ 未知的级别：%s（可用 patch / api / major）' % level)
    return '%d.%d.%d' % (a, b, c)


def sync_version_fields(s, new_v):
    """把 version.js / version.min.js 里所有版本字段同步为 new_v

    ★ 事故：原来每条正则都要求 `^\s*字段名:`（行首 + 单引号）。
      version.js 确实是这样，但 version.min.js 是真正压缩过的单行文件
      （`version:"0.8.0"` —— 双引号、无空格、且不在行首）。
      结果 min 一条都匹配不到，脚本却照样打印 ✓ —— 于是线上自检永远
      读到旧版本号，而版本号恰恰是判断"要不要提示刷新"的依据。
      现在统一放宽：不要求行首，单双引号都认。
    """
    a, b, c = new_v.split('.')
    # \2 反向引用保证替换后仍是原来的引号风格（min 用双引号，源码用单引号）
    fields = [
        ('version', new_v, r"[0-9.]+"),
        ('major', a, r"[0-9]+"),
        ('api', b, r"[0-9]+"),
        ('patch', c, r"[0-9]+"),
        ('internalVersion', new_v, r"[0-9.]+"),
        ('formalVersion', new_v, r"[0-9.]+"),
        ('displayVersion', new_v, r"[0-9.]+"),
        ('apiVersion', b, r"[0-9]+"),
    ]
    # ★ 引号必须可选：patch 字段是裸数字（patch: 13），其余是带引号字符串。
    #   原正则强制要求引号 → patch 永远匹配不到 → 每次 bump 都悄悄漏改它，
    #   表现为 version 写着 0.9.13 而 patch 还停在上一轮的数字。
    #   现在用可选引号分组，替换时还原原引号风格（无引号则保持无引号）。
    for field, val, pat in fields:
        PAT = r"(\b" + field + r":\s*)(?:(['\"])(?:v?" + pat + r")\2|(v?" + pat + r"))"
        s = re.sub(PAT,
                   lambda m: m.group(1) + (m.group(2) + val + m.group(2)
                                           if m.group(2) is not None else val),
                   s, count=1)
    return s


def content_hash(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()[:10]


def main():
    level = (sys.argv[1] if len(sys.argv) > 1 else 'patch').lower()
    if level not in ('patch', 'api', 'major'):
        raise SystemExit('✗ 可用级别：patch / api / major')

    vsrc = read(FILES['version_js'])
    old = get_version(vsrc)
    new = bump(old, level)
    print('第二代版本号  %s  ->  %s   [%s]' % (old, new, level))

    # 1) version.js
    write(FILES['version_js'], sync_version_fields(vsrc, new))
    print('  ✓ js/version.js')

    # 2) version.min.js（min 只是去注释+去空行，字段写法一致）
    write(FILES['version_min'], sync_version_fields(read(FILES['version_min']), new))
    print('  ✓ js/version.min.js')

    # 3) index.html：?v= 与内联 --stamp
    h = read(FILES['index'])
    h = re.sub(r'\?v=[0-9]+\.[0-9]+\.[0-9]+', '?v=%s' % new, h)
    h = re.sub(r'--stamp:"[0-9.]+"', '--stamp:"%s"' % new, h)
    write(FILES['index'], h)
    print('  ✓ index.html  ?v=%s   --stamp:"%s"' % (new, new))

    # 4) API 契约戳 —— 只在 api / major 级变化时动
    #    放这里而不是 index.html，是因为它就是「CSS 支持哪代契约」的标记。
    #    patch 不动它，CSS 内容 hash 才不会变，样式表不必重下。
    if level in ('api', 'major'):
        b = new.split('.')[1]
        for p in (FILES['css'], FILES['css_min']):
            s = read(p)
            s2 = re.sub(r'(--api-stamp:\s*)"[^"]*"', r'\g<1>"%s"' % b, s, count=1)
            if s2 != s:
                write(p, s2)
                print('  ✓ %s  --api-stamp="%s"' % (p, b))
        h = read(FILES['index'])
        h2 = re.sub(r'data-api-v="[^"]*"', 'data-api-v="%s"' % b, h, count=1)
        if h2 != h:
            write(FILES['index'], h2)
            print('  ✓ index.html  data-api-v="%s"' % b)
    else:
        print('  · patch 级：不动 --api-stamp（值 %s），CSS 内容 hash 不变' % old.split('.')[1])

    # 5) 内容 hash 提醒
    for p in (FILES['css_min'], FILES['version_min']):
        print('  ℹ %s 内容 hash = %s' % (p, content_hash(p)))

    print('\n★ 记得校验：index.html 里各 ?h= 必须与文件实际内容 hash 一致，')
    print('  否则浏览器/CDN 继续返旧文件 —— 改了等于没改，且毫无报错。')


if __name__ == '__main__':
    main()
