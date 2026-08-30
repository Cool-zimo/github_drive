#!/usr/bin/env python3
"""
发布脚本 - 手动指定版本类型，自动计算版本号
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
    data = load_version_map()
    versions = data['versions']
    sorted_keys = sorted(versions.keys())
    latest = sorted_keys[-1]
    return latest, versions[latest]

def increment_letter(letter_str):
    """递增字母后缀，支持单字母和双字母（a-z, aa-zz）"""
    if len(letter_str) == 1:
        if letter_str < 'z':
            return chr(ord(letter_str) + 1)
        else:
            return 'aa'  # z -> aa
    else:
        # 双字母
        first, second = letter_str[0], letter_str[1]
        if second < 'z':
            return first + chr(ord(second) + 1)
        elif first < 'z':
            return chr(ord(first) + 1) + 'a'
        else:
            return 'aaa'  # zz -> aaa（极端情况）

def get_next_date_version(current_date_version):
    """计算下一个内部日期版本号（用于缓存刷新）"""
    match = re.match(r'(\d{8})([a-z]+)', current_date_version)
    date_str, letter = match.groups()
    
    today = datetime.now().strftime('%Y%m%d')
    
    if today >= date_str:
        if date_str == today:
            next_letter = increment_letter(letter)
            return today + next_letter
        else:
            return today + 'a'
    else:
        # 系统时间早于上一个版本，继续用上一个日期递增字母
        next_letter = increment_letter(letter)
        return date_str + next_letter

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

def update_version_js(date_version, formal_version):
    """更新 version.js"""
    content = f"""// 版本信息 - 由 release.py 自动生成
const APP_VERSION = {{
    dateVersion: '{date_version}',
    formalVersion: '{formal_version}',
    displayVersion: 'v{formal_version}'
}};
"""
    with open(VERSION_JS_FILE, 'w', encoding='utf-8') as f:
        f.write(content)

def update_index_html_version(old_version, new_version):
    """更新 index.html 里所有的版本号参数"""
    import re
    with open(INDEX_HTML_FILE, 'r', encoding='utf-8') as f:
        content = f.read()
    # 替换所有 v=YYYYMMDDx 格式的版本号，不只是 old_version
    content = re.sub(r'v=\d{8}[a-z]', f'v={new_version}', content)
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
    last_date_version, last_formal_version = get_latest_version()
    print(f"当前版本: v{last_formal_version} (内部: {last_date_version})")
    print(f"更新类型: {bump_type}")
    
    # 计算新版本
    new_date_version = get_next_date_version(last_date_version)
    new_formal_version = bump_version(last_formal_version, bump_type)
    print(f"新版本: v{new_formal_version} (内部: {new_date_version})")
    
    # 更新版本映射表
    data = load_version_map()
    data['versions'][new_date_version] = new_formal_version
    save_version_map(data)
    
    # 更新 version.js
    update_version_js(new_date_version, new_formal_version)
    
    # 更新 index.html 版本号
    update_index_html_version(last_date_version, new_date_version)
    
    type_names = {'major': '大版本', 'minor': '小版本', 'patch': '补丁'}
    print(f"\n✅ {type_names[bump_type]}更新完成: v{last_formal_version} → v{new_formal_version}")
    print(f"提交信息: {commit_msg}")
    print("\n下一步:")
    print(f"  git add -A")
    print(f"  git commit -m \"{commit_msg}\"")
    print(f"  git push")

if __name__ == '__main__':
    main()
