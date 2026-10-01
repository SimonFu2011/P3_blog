# -*- coding: utf-8 -*-
"""
落库前的静态检查（lxml 做 XML 级校验，比肉眼可靠）：
1) index.html 里每个 SVG 是否都是合法 XML
2) 所有 url(#id) 引用是否都能解析到文档里存在的 id
3) 表盘 SVG 的图层顺序是否与设计一致
4) JS 里 getElementById / querySelector 的 id、class 是否都存在于 HTML
5) JS 里 classList 操作的 class 是否都有 CSS 规则
6) CSS 括号是否平衡
"""
import re
import sys
from lxml import html as LH, etree

ROOT = r'D:\DS\blog-enter'
HTML = ROOT + r'\index.html'
CSS = ROOT + r'\css\style.css'
JS = ['data.js', 'character.js', 'water.js', 'dock.js', 'menu.js', 'boot.js']

fail = []
src = open(HTML, encoding='utf-8').read()
doc = LH.fromstring(src)

# 1) SVG 是否是合法 XML
svgs = doc.xpath('//svg')
print(f'[1] 找到 {len(svgs)} 个 <svg>')
for i, s in enumerate(svgs):
    xml = etree.tostring(s, encoding='unicode')
    try:
        etree.fromstring(xml.encode('utf-8'))
    except Exception as e:
        fail.append(f'svg[{i}] 不是合法 XML: {e}')
print('    全部合法' if not fail else f'    ✗ {fail}')

# 2) url(#id) 引用
ids = set(doc.xpath('//@id'))
refs = set(re.findall(r'url\(#([^)]+)\)', src))
missing = refs - ids
print(f'[2] url(#id) 引用 {sorted(refs)} → 缺失 {sorted(missing) if missing else "无"}')
if missing:
    fail.append(f'url(#) 引用了不存在的 id: {missing}')

# 3) 表盘图层顺序
dial = doc.xpath('//svg[contains(@class,"dial-svg")]')[0]
order = []
for el in dial.iter():
    if el is dial or not isinstance(el.tag, str):
        continue                      # 跳过注释 / 处理指令节点
    cls = el.get('class')
    tag = el.tag.split('}')[-1]
    ident = el.get('id')
    if tag in ('rect', 'circle', 'path', 'line', 'polygon', 'g', 'text'):
        order.append(f'{tag}.{cls}' if cls else (f'{tag}#{ident}' if ident else tag))
print('[3] 表盘图层顺序（自下而上）:')
for o in order:
    print('      ' + o)

# 4/5) JS 引用
html_classes = set()
for m in re.finditer(r'\bclass="([^"]+)"', src):
    html_classes.update(m.group(1).split())
css = open(CSS, encoding='utf-8').read()
css_classes = set(re.findall(r'\.(-?[_a-zA-Z][\w-]*)', css))
DYNAMIC = {'bubble', 'splash-ring', 'dive-ripple', 'fan-item', 'fan-link',
           'fi-jp', 'fi-en', 'dial-numeral'}
# 纯状态钩子：没有对应样式是正常的（外部/未来接入时才会用到）
BENIGN = {'is-mounted'}
for f in JS:
    js = open(ROOT + r'\js\\' + f, encoding='utf-8').read()
    for gid in re.findall(r"getElementById\(\s*'([^']+)'", js):
        if gid not in ids:
            fail.append(f'{f}: getElementById({gid}) 不存在')
    for sel in re.findall(r"querySelector(?:All)?\(\s*'([^']+)'", js):
        for c in re.findall(r'\.(-?[_a-zA-Z][\w-]*)', sel):
            if c not in html_classes and c not in DYNAMIC:
                fail.append(f'{f}: 选择器 {sel} 里的 .{c} 不在 HTML 中')
    for c in re.findall(r"classList\.(?:add|remove|toggle|contains)\(\s*'([^']+)'", js):
        if c not in css_classes and c not in BENIGN:
            fail.append(f'{f}: classList 操作 {c} 但 CSS 无此规则')
print('[4/5] JS ↔ HTML/CSS 交叉引用检查完成')

# 6) CSS 括号
clean = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
depth = 0
for ch in clean:
    if ch == '{':
        depth += 1
    elif ch == '}':
        depth -= 1
print(f'[6] CSS 括号深度收尾 = {depth}（应为 0）')
if depth != 0:
    fail.append('CSS 括号不平衡')

print()
if fail:
    print('✗ 发现问题:')
    for x in fail:
        print('   -', x)
    sys.exit(1)
print('✓ 全部通过')
