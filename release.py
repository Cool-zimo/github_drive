#!/usr/bin/env python3
"""
发布脚本 - 自动计算版本号并更新所有文件
用法: python release.py [提交信息]
"""
import json
import re
import sys
import os
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

def get_next_date_version(current_date_version):
    """计算下一个日期版本号"""
    match = re.match(r'(\d{8})([a-z])', current_date_version)
    date_str, letter = match.groups()
    
    today = datetime.now().strftime('%Y%m%d')
    
    # 如果当前日期晚于或等于上一个版本的日期，用当前日期
    if today >= date_str:
        if date_str == today:
            # 同一天，字母后缀递增
            next_letter = chr(ord(letter) + 1)
            return today + next_letter
        else:
            # 新的一天，从 a 开始
            return today + 'a'
    else:
        # 如果当前日期早于上一个版本的日期（系统时间问题），继续用上一个版本的日期
        next_letter = chr(ord(letter) + 1)
        return date_str + next_letter

def calculate_formal_version(last_date_version, last_formal_version, new_date_version):
    """计算正式版本号"""
    last_date = last_date_version[:8]
    new_date = new_date_version[:8]
    
    x, y, z = map(int, last_formal_version.split('.'))
    
    last_dt = datetime.strptime(last_date, '%Y%m%d')
    new_dt = datetime.strptime(new_date, '%Y%m%d')
    
    # 年份或月份变化 -> x + 1
    if last_dt.year != new_dt.year or last_dt.month != new_dt.month:
        x += 1
        y = 0
        z = 0
    # 日期变化 -> y + 1
    elif last_dt.day != new_dt.day:
        y += 1
        z = 0
    # 同一天 -> z + 1
    else:
        z += 1
    
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
    with open(INDEX_HTML_FILE, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # 替换所有 ?v=xxx 的版本号
    content = content.replace(f'?v={old_version}', f'?v={new_version}')
    
    with open(INDEX_HTML_FILE, 'w', encoding='utf-8') as f:
        f.write(content)

def main():
    commit_msg = sys.argv[1] if len(sys.argv) > 1 else "update"
    
    # 获取最新版本
    last_date_version, last_formal_version = get_latest_version()
    print(f"当前版本: {last_date_version} -> v{last_formal_version}")
    
    # 计算下一个版本
    new_date_version = get_next_date_version(last_date_version)
    new_formal_version = calculate_formal_version(
        last_date_version, last_formal_version, new_date_version
    )
    print(f"新版本: {new_date_version} -> v{new_formal_version}")
    
    # 更新版本映射表
    data = load_version_map()
    data['versions'][new_date_version] = new_formal_version
    save_version_map(data)
    
    # 更新 version.js
    update_version_js(new_date_version, new_formal_version)
    
    # 更新 index.html 版本号
    update_index_html_version(last_date_version, new_date_version)
    
    print(f"\n✅ 版本已更新: v{new_formal_version} (内部: {new_date_version})")
    print(f"提交信息: {commit_msg}")
    print("\n下一步:")
    print(f"  git add -A")
    print(f"  git commit -m \"{commit_msg}\"")
    print(f"  git push")

if __name__ == '__main__':
    main()
