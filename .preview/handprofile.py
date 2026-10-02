# 从附图里量出两根指针的"沿轴宽度剖面"，用来把造型按比例搬到 viewBox 里。
# 做法：手工给出每根针的轴（转轴 → 针尖），沿轴每隔一小段取一条垂线，
# 在垂线上量暗像素的左右边界 —— 得到的是真实轮廓（含不对称），不做任何猜测。
import numpy as np
from PIL import Image

SRC = r'C:\Users\Simon\.dsh\attachments\v1\objects\9c\9c041eb875295b95b2c93e46f25d45f6150be734716832e1982a70189076f51e'
PIVOT = np.array([690.0, 504.0])

HANDS = {
    # 名称: 针尖坐标
    'filigree': np.array([12.0, 513.0]),
    'spade': np.array([365.0, 9.0]),
}


def profile(tip, samples=61, half=70.0, step=0.5):
    im = Image.open(SRC).convert('L')
    a = np.asarray(im, dtype=np.float32)
    h, w = a.shape
    d = tip - PIVOT
    L = float(np.hypot(*d))
    d = d / L
    n = np.array([-d[1], d[0]])          # 左法线
    rows = []
    for i in range(samples):
        t = i / (samples - 1) * L
        base = PIVOT + d * t
        ss = np.arange(-half, half + 1, step)
        pts = base[None, :] + n[None, :] * ss[:, None]
        xs = np.clip(np.round(pts[:, 0]).astype(int), 0, w - 1)
        ys = np.clip(np.round(pts[:, 1]).astype(int), 0, h - 1)
        dark = a[ys, xs] < 110
        if not dark.any():
            rows.append((t / L, 0.0, 0.0))
            continue
        idx = np.nonzero(dark)[0]
        # 只取离轴最近的那一段连通暗区，避免把另一根针算进来
        groups, cur = [], [idx[0]]
        for k in idx[1:]:
            if k - cur[-1] <= 3:
                cur.append(k)
            else:
                groups.append(cur)
                cur = [k]
        groups.append(cur)
        best = min(groups, key=lambda g: min(abs(ss[g[0]]), abs(ss[g[-1]])))
        rows.append((t / L, float(ss[best[0]]), float(ss[best[-1]])))
    return L, rows


for name, tip in HANDS.items():
    L, rows = profile(tip)
    print('=== %s  length=%.1fpx ===' % (name, L))
    print('  t/L    r%%    left    right   width')
    for t, lo, hi in rows:
        print('  %.3f  %5.1f  %6.1f  %6.1f  %6.1f' % (t, t * 100, lo, hi, hi - lo))
