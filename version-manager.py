#!/usr/bin/env python3
"""
版本号管理工具
内部日期表达法: V20260831m (YYYYMMDD + 字母后缀)
对外正式表达法: V0.0.1 (x.y.z)

规则:
- 同一天内字母后缀递增 -> z + 1
- 日期变化(新的一天) -> y + 1, z = 0
- 月份变化 -> x + 1, y = 0, z = 0
- 年份变化 -> x + 1
- 上级变化时下级归零
"""
import json
import re
import sys
from datetime import datetime

VERSION_MAP_FILE = "assets/version-map.json"

def load_version_map():
    with open(VERSION_MAP_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)

def save_version_map(data):
    with open(VERSION_MAP_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def parse_date_version(version_str):
    """解析日期版本号: 20260831m -> (date_str, letter)"""
    match = re.match(r'(\d{8})([a-z])', version_str)
    if not match:
        raise ValueError(f"无效的日期版本号: {version_str}")
    return match.group(1), match.group(2)

def parse_formal_version(version_str):
    """解析正式版本号: 0.0.1 -> (x, y, z)"""
    parts = version_str.split('.')
    if len(parts) != 3:
        raise ValueError(f"无效的正式版本号: {version_str}")
    return int(parts[0]), int(parts[1]), int(parts[2])

def get_next_letter(letter):
    """获取下一个字母: a->b, m->n"""
    return chr(ord(letter) + 1)

def calculate_next_formal_version(last_date_version, last_formal_version, new_date_version):
    """
    根据上一个版本和新版本计算正式版本号
    """
    last_date, last_letter = parse_date_version(last_date_version)
    new_date, new_letter = parse_date_version(new_date_version)
    x, y, z = parse_formal_version(last_formal_version)
    
    last_dt = datetime.strptime(last_date, '%Y%m%d')
    new_dt = datetime.strptime(new_date, '%Y%m%d')
    
    # 年份变化 -> x + 1
    if last_dt.year != new_dt.year:
        x += 1
        y = 0
        z = 0
    # 月份变化 -> x + 1 (按用户规则，月份变化属于大版本)
    elif last_dt.month != new_dt.month:
        x += 1
        y = 0
        z = 0
    # 日期变化(新的一天) -> y + 1
    elif last_dt.day != new_dt.day:
        y += 1
        z = 0
    # 同一天 -> z + 1
    else:
        z += 1
    
    return f"{x}.{y}.{z}"

def add_version(new_date_version):
    """添加新版本到映射表"""
    data = load_version_map()
    versions = data['versions']
    
    if new_date_version in versions:
        print(f"版本 {new_date_version} 已存在: {versions[new_date_version]}")
        return versions[new_date_version]
    
    # 找到最新的版本
    sorted_versions = sorted(versions.keys())
    last_date_version = sorted_versions[-1]
    last_formal_version = versions[last_date_version]
    
    # 计算新的正式版本号
    new_formal_version = calculate_next_formal_version(
        last_date_version, last_formal_version, new_date_version
    )
    
    versions[new_date_version] = new_formal_version
    save_version_map(data)
    
    print(f"新版本: {new_date_version} -> v{new_formal_version}")
    return new_formal_version

def get_formal_version(date_version):
    """根据日期版本号获取正式版本号"""
    data = load_version_map()
    return data['versions'].get(date_version, '0.0.0')

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("用法:")
        print("  python version-manager.py add <日期版本号>  - 添加新版本")
        print("  python version-manager.py get <日期版本号>  - 查询正式版本号")
        print("  python version-manager.py list              - 列出所有版本")
        sys.exit(1)
    
    command = sys.argv[1]
    
    if command == 'add' and len(sys.argv) >= 3:
        add_version(sys.argv[2])
    elif command == 'get' and len(sys.argv) >= 3:
        print(get_formal_version(sys.argv[2]))
    elif command == 'list':
        data = load_version_map()
        for dv, fv in sorted(data['versions'].items()):
            print(f"  {dv} -> v{fv}")
    else:
        print("无效的命令")
