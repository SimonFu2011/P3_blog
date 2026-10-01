# -*- coding: utf-8 -*-
"""
把 index.html 里的构成主义表盘 SVG 用 PIL 近似渲染成 PNG，用来肉眼检查
构图 / 比例 / 配色 / 数字位置。

注意：这是"几何 + 配色"的近似预览，不是浏览器截图 —— 斜线网点用中灰代替、
字体用系统里最接近的粗体、backdrop-filter 与混合模式都简化了。
真值仍然以浏览器为准。
"""
import math
import os
from lxml import html as LH
from PIL import Image, ImageDraw, ImageFont

HTML = r'D:\DS\blog-enter\index.html'
OUT = r'D:\DS\.preview\dial-preview.png'

VOX, VOY = 120.0, 120.0          # viewBox 中心
S = 3                            # 每 viewBox 单位 = 3 px
DIAL_PX = 240 * S
OX, OY = 40, 44                  # 表盘左上角在画布里的位置

C = {
    'ink': '#0d0d0f', 'paper': '#f2f0ea', 'sky': '#38bdf8',
    'red': '#ff1f3d', 'q3': '#1b1b21', 'hatch': '#8a8a90',
}

CANVAS = (DIAL_PX + 80, DIAL_PX + 190)


def P(x, y):
    return (OX + x * S, OY + y * S)


def rot(px, py, deg, cx=VOX, cy=VOY):
    a = math.radians(deg)
    dx, dy = px - cx, py - cy
    return (cx + dx * math.cos(a) - dy * math.sin(a),
            cy + dx * math.sin(a) + dy * math.cos(a))


def pick_font(size):
    for name in ('bahnschrift.ttf', 'arialbd.ttf', 'seguisb.ttf', 'calibrib.ttf'):
        p = os.path.join(r'C:\Windows\Fonts', name)
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size), name
            except Exception:
                pass
    return ImageFont.load_default(), 'default'


def main():
    doc = LH.fromstring(open(HTML, encoding='utf-8').read())
    svg = doc.xpath('//svg[contains(@class,"dial-svg")]')
    assert svg, 'index.html 里找不到 .dial-svg'
    svg = svg[0]

    img = Image.new('RGB', CANVAS, '#04121e')
    d = ImageDraw.Draw(img)

    # ---- 背景：近似 .water（上亮下深的青蓝）----
    for y in range(CANVAS[1]):
        t = y / CANVAS[1]
        r = int(13 + (5 - 13) * t)
        g = int(95 + (35 - 95) * t * t)
        b = int(138 + (54 - 138) * t * t)
        d.line([(0, y), (CANVAS[0], y)], fill=(r, g, b))

    # ---- 左侧 dock 面板（近似：半透明深蓝 + 天蓝左边框）----
    panel = Image.new('RGBA', CANVAS, (0, 0, 0, 0))
    pd = ImageDraw.Draw(panel)
    pd.rounded_rectangle([12, 12, CANVAS[0] - 12, CANVAS[1] - 12], radius=4,
                         fill=(6, 20, 49, 150))
    pd.rectangle([12, 12, 15, CANVAS[1] - 12], fill=(56, 189, 248, 255))
    img = Image.alpha_composite(img.convert('RGBA'), panel).convert('RGB')
    d = ImageDraw.Draw(img)

    # ---- 黑胶（在表盘之下）：46% → r=55.2，比表盘内缘 52 略大，塞在下面 ----
    disc_r = 0.46 * 240 / 2
    bb = [P(VOX - disc_r, VOY - disc_r), P(VOX + disc_r, VOY + disc_r)]
    d.ellipse(bb, fill='#04121e', outline='#7dd3fc66')
    for i in range(1, 8):                          # 纹路
        rr = disc_r * (0.46 + i * 0.068)
        d.ellipse([P(VOX - rr, VOY - rr), P(VOX + rr, VOY + rr)],
                  outline='#38bdf833')
    cover_r = disc_r * 0.24                        # inset 26% → 直径 48%
    d.ellipse([P(VOX - cover_r, VOY - cover_r), P(VOX + cover_r, VOY + cover_r)],
              fill='#38bdf8', outline='#02121e')
    d.ellipse([P(VOX - cover_r * .12, VOY - cover_r * .12),
               P(VOX + cover_r * .12, VOY + cover_r * .12)], fill='#031420')

    # ---- 方盘：黑方挖掉 r<92 的圆（对应 SVG 的 mask）----
    plate = Image.new('RGBA', CANVAS, (0, 0, 0, 0))
    pl = ImageDraw.Draw(plate)
    pl.rectangle([P(6, 6), P(234, 234)], fill=(13, 13, 15, 255))
    pl.ellipse([P(120 - 92, 120 - 92), P(120 + 92, 120 + 92)], fill=(0, 0, 0, 0))
    img = Image.alpha_composite(img.convert('RGBA'), plate).convert('RGB')
    d = ImageDraw.Draw(img)

    # 方盘描边
    d.rectangle([P(6, 6), P(234, 234)], outline=C['sky'], width=int(2.5 * S))

    # ---- 四象限色环（r=100，线宽 16）----
    # 注意：PIL 的 outline 是"从 bbox 往内"画，而 SVG 的 stroke 是以路径为中心
    # 两侧各画一半。所以这里 bbox 取外缘 r+w/2，才能和浏览器一致。
    quads = [(-90, 0, C['paper']), (0, 90, C['sky']),
             (90, 180, C['q3']), (180, 270, C['hatch'])]
    for a0, a1, col in quads:
        d.arc([P(120 - 108, 120 - 108), P(120 + 108, 120 + 108)],
              a0, a1, fill=col, width=int(16 * S))

    # ---- 表盘：r=72、线宽 40 → 覆盖 52~92（bbox 取外缘 92）----
    d.ellipse([P(120 - 92, 120 - 92), P(120 + 92, 120 + 92)],
              outline=C['paper'], width=int(40 * S))
    # 表盘与色环之间的细分隔环（r=92，线宽 2.2 → PIL 往内画，bbox 取外缘）
    d.ellipse([P(120 - 93.1, 120 - 93.1), P(120 + 93.1, 120 + 93.1)],
              outline=C['ink'], width=int(2.2 * S))

    # ---- 对角线（近黑 30% → 在米白上约 #a9a8a4）+ 角棒 ----
    d.line([P(52, 188), P(188, 52)], fill='#a9a8a4', width=max(1, int(1.6 * S)))
    d.line([P(16, 42), P(42, 16)], fill=C['red'], width=int(5 * S))
    d.line([P(198, 224), P(224, 198)], fill=C['sky'], width=int(5 * S))

    # ---- 罗马数字（r=75，粗体）----
    font, fname = pick_font(int(16 * S))
    Roman = ['XII', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI']
    for i, t in enumerate(Roman):
        a = (i / 12) * math.tau - math.pi / 2
        x = VOX + math.cos(a) * 75
        y = VOY + math.sin(a) * 75
        d.text(P(x, y), t, font=font, fill=C['ink'], anchor='mm')

    # ---- 指针：10:10 ----
    hour_deg = (10 + 10 / 60) * 30
    min_deg = 10 * 6
    wedge = [(114.6, 120), (125.4, 120), (120, 54)]
    d.polygon([P(*rot(*p, hour_deg)) for p in wedge],
              fill=C['red'], outline=C['ink'])
    bar = [(118.3, 54), (121.7, 54), (121.7, 126), (118.3, 126)]
    d.polygon([P(*rot(*p, min_deg)) for p in bar],
              fill=C['sky'], outline=C['ink'])

    # ---- 中心 ----
    d.ellipse([P(120 - 6.4, 120 - 6.4), P(120 + 6.4, 120 + 6.4)],
              fill=C['ink'], outline=C['paper'], width=int(2.2 * S))
    dot = [(116, 116), (124, 116), (124, 124), (116, 124)]
    d.polygon([P(*rot(*p, 45)) for p in dot], fill=C['red'])

    # ---- 下方面板文字（近似尺寸）----
    dial_px = 330                                  # 桌面档 --dial
    tf, _ = pick_font(int(dial_px * 0.056))
    sf, _ = pick_font(int(dial_px * 0.042))
    cx = CANVAS[0] // 2
    d.line([(cx - 16, OY + DIAL_PX + 26), (cx + 16, OY + DIAL_PX + 26)],
           fill=C['red'], width=3)
    d.text((cx, OY + DIAL_PX + 44), '暂无播放', font=tf, fill=C['paper'], anchor='mm')
    d.text((cx, OY + DIAL_PX + 74), 'NO TRACK', font=sf, fill=C['sky'], anchor='mm')

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img.save(OUT)
    print('font =', fname)
    print('saved =', OUT, img.size)


main()
