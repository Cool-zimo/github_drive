#!/usr/bin/env python3
"""
发布脚本 - 内部版本号为纯数字计数器，每次更新加一
用法:
  python release.py patch "提交信息"   # 补丁版本 z+1
  python release.py minor "提交信息"   # 小版本 y+1, z归零
  python release.py major "提交信息"   # 大版本 x+1, y,z归零
"""
import json
import re
import sys
from datetime import datetime

VERSION_MAP_FILE = "assets/version-map.json"
VERSION_JS_FILE = "js/version.js"
INDEX_HTML_FILE = "index.html"

def load_version_map():
    with open(VERSION_MAP_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)

def save_version_map(data):
    with open(VERSION_MAP_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def get_latest_version():
    """获取最新版本，内部版本号为纯数字计数器"""
    data = load_version_map()
    versions = data['versions']
    # 找出所有数字版本号，取最大的
    numeric_versions = [(int(k), v) for k, v in versions.items() if k.isdigit()]
    if numeric_versions:
        latest = max(numeric_versions, key=lambda x: x[0])
        return str(latest[0]), latest[1]
    # 没有数字版本，从1开始
    return '0', '0.0.0'

def bump_version(last_formal_version, bump_type):
    """根据类型递增版本号，上级变化时下级归零"""
    x, y, z = map(int, last_formal_version.split('.'))
    
    if bump_type == 'major':
        x += 1
        y = 0
        z = 0
    elif bump_type == 'minor':
        y += 1
        z = 0
    elif bump_type == 'patch':
        z += 1
    else:
        raise ValueError(f"未知的版本类型: {bump_type}，应为 major/minor/patch")
    
    return f"{x}.{y}.{z}"

def update_version_js(internal_version, formal_version):
    """更新 version.js"""
    content = f"""// 版本信息 - 由 release.py 自动生成
const APP_VERSION = {{
    internalVersion: '{internal_version}',
    formalVersion: '{formal_version}',
    displayVersion: 'v{formal_version}'
}};
"""
    with open(VERSION_JS_FILE, 'w', encoding='utf-8') as f:
        f.write(content)

def update_index_html_version(new_version):
    """更新 index.html 里所有的版本号参数"""
    with open(INDEX_HTML_FILE, 'r', encoding='utf-8') as f:
        content = f.read()
    # 替换所有 v=数字 或 v=日期字母 格式的版本号
    content = re.sub(r'v=\d{8}[a-z]*', f'v={new_version}', content)
    content = re.sub(r'v=\d+', f'v={new_version}', content)
    with open(INDEX_HTML_FILE, 'w', encoding='utf-8') as f:
        f.write(content)

def main():
    if len(sys.argv) < 3:
        print("用法:")
        print("  python release.py patch \"提交信息\"   # 补丁版本 z+1")
        print("  python release.py minor \"提交信息\"   # 小版本 y+1, z归零")
        print("  python release.py major \"提交信息\"   # 大版本 x+1, y,z归零")
        print()
        print("示例:")
        print("  python release.py patch \"修复登录bug\"")
        print("  python release.py minor \"添加插件广场\"")
        print("  python release.py major \"2.0大版本重构\"")
        sys.exit(1)
    
    bump_type = sys.argv[1].lower()
    commit_msg = sys.argv[2]
    
    if bump_type not in ('major', 'minor', 'patch'):
        print(f"错误: 版本类型必须是 major/minor/patch，当前是 {bump_type}")
        sys.exit(1)
    
    # 获取最新版本
    last_internal_version, last_formal_version = get_latest_version()
    print(f"当前版本: v{last_formal_version} (内部: {last_internal_version})")
    print(f"更新类型: {bump_type}")
    
    # 计算新版本：内部版本号纯数字+1
    new_internal_version = str(int(last_internal_version) + 1)
    new_formal_version = bump_version(last_formal_version, bump_type)
    print(f"新版本: v{new_formal_version} (内部: {new_internal_version})")
    
    # 更新版本映射表
    data = load_version_map()
    data['versions'][new_internal_version] = new_formal_version
    save_version_map(data)
    
    # 更新 version.js
    update_version_js(new_internal_version, new_formal_version)
    
    # 更新 index.html 版本号
    update_index_html_version(new_internal_version)
    
    type_names = {'major': '大版本', 'minor': '小版本', 'patch': '补丁'}
    today = datetime.now().strftime('%Y%m%d')
    print(f"\n✅ {type_names[bump_type]}更新完成: v{last_formal_version} → v{new_formal_version}")
    print(f"内部版本号: {last_internal_version} → {new_internal_version}")
    print(f"版本长链: {today}-{new_internal_version}-v{new_formal_version}-<git_hash>")
    print(f"提交信息: {commit_msg}")
    print("\n下一步:")
    print(f"  git add -A")
    print(f"  git commit -m \"{commit_msg}\"")
    print(f"  git push")

if __name__ == '__main__':
    main()
