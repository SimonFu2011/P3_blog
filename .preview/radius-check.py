# -*- coding: utf-8 -*-
"""沿 3 点方向做一次半径剖面，核对各层的实际边界（比肉眼量图可靠）"""
from PIL import Image

img = Image.open(r'D:\DS\.preview\dial-preview.png').convert('RGB')
CX, CY = 400, 404          # 预览里的表盘圆心
NAMES = {
    (4, 18, 30): 'VINYL',
    (56, 189, 248): 'SKY',
    (242, 240, 234): 'PAPER',
    (13, 13, 15): 'PLATE',
    (27, 27, 33): 'Q3',
    (138, 138, 144): 'Q4-hatch',
    (255, 31, 61): 'RED',
    (7, 46, 79): 'WATER(缺口!)',
}

def name_of(px):
    best, bd = None, 1e9
    for c, n in NAMES.items():
        d = sum((a - b) ** 2 for a, b in zip(px, c))
        if d < bd:
            bd, best = d, n
    return best

print('r(单位)  r(px)   颜色            判定')
prev = None
for ru in range(0, 122, 2):
    rpx = ru * 3
    x, y = CX + rpx, CY
    if x >= img.width:
        break
    px = img.getpixel((x, y))
    n = name_of(px)
    if n != prev:
        print(f'{ru:5d}   {rpx:5d}   #{px[0]:02x}{px[1]:02x}{px[2]:02x}   {n}  <-- 边界')
        prev = n

print()
print('各层应有的边界（单位）：黑胶 0~48 / 表盘 48~92 / 象限环 92~108 / 方盘 108~114(对角)')
