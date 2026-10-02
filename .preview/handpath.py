# 指针造型生成器
# ------------------------------------------------------------
# 依据附图（.preview/ref-*.png）量出来的"沿轴宽度剖面"，把三根指针建成
# 光滑的 SVG 路径：右侧轮廓从针尾走到针尖，左侧镜像走回来，用 Catmull-Rom
# 转三次贝塞尔，所以曲线连续、节点少、好调。
#
# 产出：
#   .preview/hand-paths.txt    可直接粘进 index.html 的 <path d="...">
#   .preview/hands-{hour,minute,second}.png  由生成的 d 采样渲染的预览
import math
from PIL import Image, ImageDraw

CX = CY = 120.0          # viewBox 240×240 的圆心（指针转向轴）
S = 4                    # 预览倍率


def pt(r, w):
    """沿轴（正上方 = 0 度）半径 r、横向偏移 w 的点"""
    return (CX + w, CY - r)


def cr_chain(pts):
    """Catmull-Rom → 三次贝塞尔；返回 'C...' 指令串"""
    n = len(pts)
    out = []
    for i in range(n - 1):
        p0 = pts[i - 1] if i > 0 else pts[i]
        p1, p2 = pts[i], pts[i + 1]
        p3 = pts[i + 2] if i + 2 < n else pts[i + 1]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6.0, p1[1] + (p2[1] - p0[1]) / 6.0)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6.0, p2[1] - (p3[1] - p1[1]) / 6.0)
        out.append('C%.2f %.2f %.2f %.2f %.2f %.2f' % (c1[0], c1[1], c2[0], c2[1], p2[0], p2[1]))
    return ' '.join(out)


def outline(nodes):
    right = [pt(r, w) for r, w in nodes]
    left = [pt(r, -w) for r, w in reversed(nodes)]
    return 'M%.2f %.2f ' % right[0] + cr_chain(right) + ' ' + cr_chain(left) + ' Z'


def hole(nodes):
    right = [pt(r, w) for r, w in nodes]
    left = [pt(r, -w) for r, w in reversed(nodes)]
    return 'M%.2f %.2f ' % right[0] + cr_chain(right) + ' ' + cr_chain(left) + ' Z'


def circle(cy_off, r):
    """以 (120, 120-cy_off) 为圆心、半径 r 的整圆（两段半圆，便于采样）"""
    cy = CY - cy_off
    return ('M%.2f %.2f A%.2f %.2f 0 1 0 %.2f %.2f A%.2f %.2f 0 1 0 %.2f %.2f Z'
            % (CX, cy - r, r, r, CX, cy + r, r, r, CX, cy - r))


def annulus(cy_off, r_out, r_in):
    return circle(cy_off, r_out) + ' ' + circle(cy_off, r_in)


# ============================================================
# 时针：附图里"长尖 + 叶形腹"那根（剖面按 592px 归一化，×70）
# ============================================================
HOUR_L = 70.0
HOUR_PROFILE = [
    (-0.155, 0.000), (-0.090, 0.011), (0.000, 0.016), (0.100, 0.014),
    (0.240, 0.013), (0.360, 0.014), (0.420, 0.017), (0.450, 0.030),
    (0.475, 0.046), (0.500, 0.062), (0.520, 0.069), (0.545, 0.068),
    (0.575, 0.062), (0.610, 0.053), (0.650, 0.045), (0.690, 0.037),
    (0.730, 0.030), (0.770, 0.024), (0.810, 0.019), (0.850, 0.014),
    (0.890, 0.010), (0.930, 0.006), (0.965, 0.003), (1.000, 0.000),
]

# ============================================================
# 分针：附图里那根镂空卷草针（长度 94）
#   r 0..10 圆环配重 / 10..20 细腰 + 小圆眼 / 20..38 卷草镂空
#   38..57 长尖窗 / 57..94 长针
# ============================================================
MIN_L = 94.0
MIN_PROFILE = [
    (-0.150, 0.000), (-0.090, 0.020), (0.000, 0.030), (0.055, 0.026),
    (0.100, 0.019), (0.135, 0.030), (0.170, 0.018), (0.200, 0.028),
    (0.240, 0.055), (0.280, 0.074), (0.320, 0.066), (0.355, 0.046),
    (0.385, 0.032), (0.420, 0.033), (0.460, 0.031), (0.500, 0.027),
    (0.540, 0.023), (0.580, 0.020), (0.640, 0.018), (0.700, 0.015),
    (0.760, 0.012), (0.820, 0.009), (0.880, 0.006), (0.940, 0.003),
    (1.000, 0.000),
]

# ============================================================
# 秒针：同一套老式语言里的细长针 + 尾部小圆环配重
# ============================================================
SEC_L = 100.0
SEC_PROFILE = [
    (-0.240, 0.000), (-0.180, 0.006), (-0.120, 0.008), (-0.050, 0.009),
    (0.000, 0.010), (0.080, 0.009), (0.200, 0.008), (0.340, 0.007),
    (0.500, 0.0065), (0.640, 0.0055), (0.780, 0.0045), (0.880, 0.0032),
    (0.950, 0.0018), (1.000, 0.000),
]

HOUR = [(r * HOUR_L, w * HOUR_L) for r, w in HOUR_PROFILE]
MIN = [(r * MIN_L, w * MIN_L) for r, w in MIN_PROFILE]
SEC = [(r * SEC_L, w * SEC_L) for r, w in SEC_PROFILE]

MIN_HOLES = [
    hole([(11.5, 1.25), (14.0, 1.55), (16.5, 1.25), (18.0, 0.0),
          (16.5, -1.25), (14.0, -1.55), (11.5, -1.25)]),
    hole([(21.5, 2.1), (25.0, 5.4), (29.0, 5.9), (33.0, 4.6), (34.5, 2.4),
          (34.5, 0.9), (30.0, 1.5), (25.5, 2.2)]),
    hole([(21.5, -2.1), (25.0, -5.4), (29.0, -5.9), (33.0, -4.6), (34.5, -2.4),
          (34.5, -0.9), (30.0, -1.5), (25.5, -2.2)]),
    hole([(41.0, 0.0), (44.0, 0.95), (49.0, 1.15), (54.5, 0.95), (57.5, 0.0),
          (54.5, -0.95), (49.0, -1.15), (44.0, -0.95)]),
    circle(0.0, 4.6), circle(0.0, 2.2),
]

PATHS = {
    'hour': outline(HOUR),
    'minute': outline(MIN) + ' ' + ' '.join(MIN_HOLES) + ' ' + annulus(0.0, 10.4, 4.4),
    'second': outline(SEC) + ' ' + annulus(-18.0, 3.5, 1.5),
}

# ------------------------------------------------------------
# 由 d 采样成多边形，再用 PIL 填充/挖空 —— 预览用的就是 HTML 里那份数据
# ------------------------------------------------------------
def sample(d, steps=20):
    import re
    # 生成时是紧写（M120.00），这里把命令字母拆出来再分词
    toks = re.sub(r'([MLCAZmlcaz])', r' \1 ', d).split()
    i = 0
    cur = start = (0.0, 0.0)
    polys, poly = [], []

    def flush():
        nonlocal poly
        if len(poly) > 2:
            polys.append(poly)
        poly = []

    def cubic(p0, p1, p2, p3):
        for k in range(1, steps + 1):
            t = k / steps
            mt = 1 - t
            poly.append((mt ** 3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t ** 3 * p3[0],
                         mt ** 3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t ** 3 * p3[1]))

    def arc(p0, rx, ry, fA, fS, p1):
        x1, y1 = p0
        x2, y2 = p1
        dx2, dy2 = (x1 - x2) / 2.0, (y1 - y2) / 2.0
        lam = dx2 * dx2 / (rx * rx) + dy2 * dy2 / (ry * ry)
        if lam > 1:
            k = math.sqrt(lam)
            rx *= k; ry *= k
        num = rx * rx * ry * ry - rx * rx * dy2 * dy2 - ry * ry * dx2 * dx2
        den = rx * rx * dy2 * dy2 + ry * ry * dx2 * dx2
        co = math.sqrt(max(0.0, num / den))
        if fA == fS:
            co = -co
        cxp = co * rx * dy2 / ry
        cyp = -co * ry * dx2 / rx
        cx0 = cxp + (x1 + x2) / 2.0
        cy0 = cyp + (y1 + y2) / 2.0
        th1 = math.atan2((y1 - cyp - cy0) / ry, (x1 - cxp - cx0) / rx)
        th2 = math.atan2((y2 - cyp - cy0) / ry, (x2 - cxp - cx0) / rx)
        dth = th2 - th1
        if fS == 0 and dth > 0:
            dth -= 2 * math.pi
        if fS == 1 and dth < 0:
            dth += 2 * math.pi
        for k in range(1, steps + 1):
            th = th1 + dth * k / steps
            poly.append((cx0 + rx * math.cos(th), cy0 + ry * math.sin(th)))

    while i < len(toks):
        c = toks[i]
        if c == 'M':
            flush()
            cur = start = (float(toks[i + 1]), float(toks[i + 2]))
            poly = [cur]
            i += 3
        elif c == 'L':
            cur = (float(toks[i + 1]), float(toks[i + 2]))
            poly.append(cur)
            i += 3
        elif c == 'C':
            p1 = (float(toks[i + 1]), float(toks[i + 2]))
            p2 = (float(toks[i + 3]), float(toks[i + 4]))
            p3 = (float(toks[i + 5]), float(toks[i + 6]))
            cubic(cur, p1, p2, p3)
            cur = p3
            i += 7
        elif c == 'A':
            p1 = (float(toks[i + 6]), float(toks[i + 7]))
            arc(cur, float(toks[i + 1]), float(toks[i + 2]),
                int(toks[i + 4]), int(toks[i + 5]), p1)
            cur = p1
            i += 8
        elif c == 'Z':
            poly.append(start)
            flush()
            cur = start
            i += 1
        else:
            i += 1
    flush()
    return polys


def render(name, rot_deg, out):
    img = Image.new('RGB', (240 * S, 240 * S), (12, 34, 54))
    dr = ImageDraw.Draw(img)
    dr.ellipse([2 * S, 2 * S, 238 * S, 238 * S], fill=(242, 240, 234))
    dr.ellipse([20 * S, 20 * S, 220 * S, 220 * S], outline=(120, 150, 175), width=S)
    r = 45.6
    dr.ellipse([(CX - r) * S, (CY - r) * S, (CX + r) * S, (CY + r) * S], fill=(9, 28, 44))
    dr.ellipse([109 * S, 109 * S, 131 * S, 131 * S], fill=(58, 168, 220))

    polys = sample(PATHS[name])
    a = math.radians(rot_deg)
    ca, sa = math.cos(a), math.sin(a)

    def to_screen(p):
        # 指针本体画在"正上方"坐标系里，这里整体转到 rot_deg
        px, py = p[0] - CX, p[1] - CY
        return ((CX + px * ca - py * sa) * S, (CY + px * sa + py * ca) * S)

    outer = [to_screen(p) for p in polys[0]]
    base = img.copy()
    mask = Image.new('1', img.size, 0)
    md = ImageDraw.Draw(mask)
    md.polygon(outer, fill=1)
    for p in polys[1:]:
        md.polygon([to_screen(q) for q in p], fill=0)
    ink = Image.new('RGB', img.size, (11, 20, 32))
    img = Image.composite(ink, base, mask)
    img.resize((760, 760), Image.LANCZOS).save(out)
    print('rendered', out)


def render_all(out, hour_deg, min_deg, sec_deg):
    """三根针叠在一起 + 黑胶 + 表圈，用来看整体构图"""
    img = Image.new('RGB', (240 * S, 240 * S), (8, 26, 42))
    dr = ImageDraw.Draw(img)
    dr.ellipse([6 * S, 6 * S, 234 * S, 234 * S], fill=(206, 214, 220))       # 表圈
    dr.ellipse([24 * S, 24 * S, 216 * S, 216 * S], outline=(120, 140, 158), width=2 * S)
    dr.ellipse([26 * S, 26 * S, 214 * S, 214 * S], fill=(242, 240, 234))     # 盘面
    for k in range(12):                                                       # 刻度参照
        import math as _m
        a = _m.radians(k * 30)
        x1, y1 = CX + _m.sin(a) * 84, CY - _m.cos(a) * 84
        x2, y2 = CX + _m.sin(a) * 90, CY - _m.cos(a) * 90
        dr.line([x1 * S, y1 * S, x2 * S, y2 * S], fill=(90, 100, 112), width=S)
    r = 48.0
    dr.ellipse([(CX - r) * S, (CY - r) * S, (CX + r) * S, (CY + r) * S], fill=(9, 28, 44))
    dr.ellipse([(CX - 23) * S, (CY - 23) * S, (CX + 23) * S, (CY + 23) * S], fill=(58, 168, 220))    # 专辑封面占位
    for name, deg in (('hour', hour_deg), ('minute', min_deg), ('second', sec_deg)):
        draw_hand(img, name, deg)
    dr.ellipse([(CX - 3.2) * S, (CY - 3.2) * S, (CX + 3.2) * S, (CY + 3.2) * S], fill=(226, 232, 238))
    img.resize((820, 820), Image.LANCZOS).save(out)
    print('rendered', out)


def draw_hand(img, name, deg, rim=(150, 205, 240)):
    polys = sample(PATHS[name])
    a = math.radians(deg)
    ca, sa = math.cos(a), math.sin(a)

    def to_screen(p):
        px, py = p[0] - CX, p[1] - CY
        return ((CX + px * ca - py * sa) * S, (CY + px * sa + py * ca) * S)

    mask = Image.new('1', img.size, 0)
    md = ImageDraw.Draw(mask)
    md.polygon([to_screen(p) for p in polys[0]], fill=1)
    for p in polys[1:]:
        md.polygon([to_screen(q) for q in p], fill=0)
    fill = Image.new('RGB', img.size, (11, 20, 32))
    img.paste(fill, (0, 0), mask)
    if rim:
        edge = ImageDraw.Draw(img)
        for poly in polys:
            pts = [to_screen(q) for q in poly]
            edge.line(pts, fill=rim, width=2, joint='curve')


if __name__ == '__main__':
    with open(r'D:\DS\.preview\hand-paths.txt', 'w', encoding='utf-8') as f:
        for k in ('hour', 'minute', 'second'):
            f.write('--- %s ---\n%s\n\n' % (k, PATHS[k]))
    print('paths written')
    render('hour', 318, r'D:\DS\.preview\hands-hour.png')
    render('minute', 128, r'D:\DS\.preview\hands-minute.png')
    render('second', 42, r'D:\DS\.preview\hands-second.png')
    render_all(r'D:\DS\.preview\hands-all.png', 8 * 30 + 15, 34 * 6, 42 * 6)
