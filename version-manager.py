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

def date_style_keys(versions):
    """只取 'YYYYMMDDx' 形式的键

    ★ 为什么必须过滤：
      version-map.json 里现在混着两套键 ——
        日期式  20260831m  (version-manager.py 写的)
        数字式  44         (release.py 写的)
      早期 add_version 直接 sorted(versions.keys())[-1]，
      字典序 '20260831m' < '44'，取到的是数字键 '44'，
      再交给 parse_date_version('44') → ValueError。
      实测：只要 release.py 跑过一次，本脚本的 add 就必崩。
    """
    return [k for k in versions if re.match(r'^\d{8}[a-z]+$', str(k))]


def add_version(new_date_version):
    """添加新版本到映射表"""
    data = load_version_map()
    versions = data['versions']

    if new_date_version in versions:
        print(f"版本 {new_date_version} 已存在: {versions[new_date_version]}")
        return versions[new_date_version]

    date_keys = date_style_keys(versions)
    if not date_keys:
        raise SystemExit(
            "version-map.json 里没有日期式键（YYYYMMDDx）。\n"
            "现在版本号由 release.py 维护（纯数字计数器），请改用：\n"
            "    python release.py patch '提交信息'")

    numeric = [int(k) for k in versions if str(k).isdigit()]
    if numeric and max(numeric) > 0:
        newest_date = sorted(date_keys)[-1]
        print(f"注意：version-map.json 里已有 release.py 写入的数字键（最大 {max(numeric)}），"
              f"日期式键最新只到 {newest_date}。\n"
              f"      两套键并存时本脚本只能按日期式那一串推算，结果可能与实际发布不符。\n"
              f"      建议统一用 release.py。")

    last_date_version = sorted(date_keys)[-1]
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
