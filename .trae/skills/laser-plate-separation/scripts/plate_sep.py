#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
水印木刻风格激光雕刻分板 v2（保清晰版）
Lab KMeans 感知分色 -> 纸白留纸 -> 圆盘保形最小线宽强制 -> 抗锯齿色版 PNG + 矢量 SVG
-> 叠印预览 + 分板示意 + CSV 清单 + 厂家说明

最小线宽要求（用户 2026-10-03 规定，三条取最严）：
  Illustrator >= 2pt (0.706mm) | Photoshop >= 10px @300dpi (0.847mm) | CorelDRAW >= 0.6mm
  -> 按 0.85mm 执行（三档全部满足，实测值写入 CSV）

v1 -> v2 的关键修正：
  v1 用 k×k 方形核做开闭运算，再拿"k 网格量化"兜底，等于把整幅画降成 k 像素方块
  ——画面碎成马赛克，这是错的，已被用户否决。
  v2 改用"圆盘结构元"（欧氏距离变换实现）做开运算：
    · 每个像素到背景的距离 > 半径 r 才保留 —— 等价于"墨区最小宽度 >= 2r"；
    · 宽度达标的笔画与色块完全不动，形状/曲线一点不改；
    · 只有不足 2r 的细线、碎点被整条圆滑抹去（激光雕刻的物理极限，必须去掉）；
    · 全程不做降采样、不做网格量化，边界保持原有曲线。
  再在高分辨率渲染后降采样 -> 抗锯齿，锯齿消失；
  另出矢量 SVG（贝塞尔曲线），在 AI/CDR 里放大任意倍率都无锯齿，线宽以 mm 精确可控。

成品尺寸决定细节保留量：最小线宽是绝对毫米值，成品越大，同一处细节的毫米数越大，
被抹掉的越少。用户 2026-10-03 定为**长边 400mm**（横图 400x300mm，竖图 225x400mm，均 300DPI）。

用法:
  python plate_sep.py 图1.jpg 图2.png [...] [--out 目录] [--colors 7] [--dpi 300]
                                   [--min-mm 0.85] [--width-mm 400]
依赖: pip install pillow numpy scikit-learn scipy scikit-image
"""
import argparse, csv, pathlib, re, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from sklearn.cluster import KMeans
from scipy.ndimage import distance_transform_edt, gaussian_filter
from skimage.measure import find_contours, approximate_polygon

RES = 2            # 渲染超采样倍率（越高抗锯齿越细腻，代价是像素翻倍）
SRC_CAP = 4        # 输出像素最多放大到源图的几倍（超过就是无意义插值，白白拖慢）
MARGIN = 100       # 画布留白（@输出 dpi）
REG_OFF, REG_ARM, REG_W = 58, 45, 14   # 规矩线：线宽 14px@300dpi = 1.19mm，满足最小线宽
SAMPLE_N = 200000
CHUNK = 1_500_000


def find_font():
    for p in ["/System/Library/Fonts/Hiragino Sans GB.ttc",
              "/System/Library/Fonts/PingFang.ttc",
              "/System/Library/Fonts/Supplemental/Songti.ttc",
              "/System/Library/Fonts/Helvetica.ttc"]:
        if pathlib.Path(p).exists():
            return p
    return None


def rgb2lab(arr):
    a = arr.astype(np.float32) / 255.0
    m = a > 0.04045
    a = np.where(m, ((a + 0.055) / 1.055) ** 2.4, a / 12.92)
    x = a[..., 0]*0.4124 + a[..., 1]*0.3576 + a[..., 2]*0.1805
    y = a[..., 0]*0.2126 + a[..., 1]*0.7152 + a[..., 2]*0.0722
    z = a[..., 0]*0.0193 + a[..., 1]*0.1192 + a[..., 2]*0.9505
    x /= 0.95047; z /= 1.08883
    f = lambda t: np.where(t > 0.008856, np.cbrt(t), 7.787*t + 16/116)
    fx, fy, fz = f(x), f(y), f(z)
    return np.stack([116*fy - 16, 500*(fx-fy), 200*(fy-fz)], -1)


def name_lab(L, a, b):
    c = float(np.hypot(a, b)); h = float(np.degrees(np.arctan2(b, a)) % 360)
    if L < 22: return "墨黑"
    if c < 8:
        base = "暖灰" if b > 2 else ("冷灰" if b < -2 else "中灰")
        if L >= 78: return "浅" + base
        if L < 48:  return "深" + base
        return base
    if 345 <= h or h < 15:   fam = "猩红" if L < 72 else "朱红"
    elif h < 45:   fam = "赭橙" if L < 78 else "橙黄"
    elif h < 100:  fam = "金黄" if L > 70 else "土黄"
    elif h < 120:  fam = "黄绿"
    elif h < 165:  fam = "草绿" if L > 58 else "墨绿"
    elif h < 205:  fam = "孔雀青"
    elif h < 260:  fam = "佛青蓝" if c > 24 else "灰蓝"
    elif h < 300:  fam = "紫"
    elif h < 345:  fam = "品桃红" if L > 60 else "紫红"
    else:          fam = "玫红"
    if c < 20 and fam != "灰蓝": fam = "灰" + fam[-1] if fam[-1] != "青" else "灰青"
    if L < 45 and not fam.startswith("墨"): fam = "深" + fam
    return fam


# ---------- 圆盘结构元形态学（欧氏距离变换实现，保形、无方块化） ----------
def _erode_disk(m, r):
    """圆盘腐蚀：保留"到最近背景像素距离 > r"的像素。
    必须与 _dilate_disk 的 `距离 <= r` 严格对偶（同一个圆盘结构元），
    否则开运算不幂等、实测最小线宽会误判为 0。"""
    if r <= 0:
        return m.copy()
    p = int(np.ceil(r)) + 2
    d = distance_transform_edt(np.pad(m, p, constant_values=False))
    return d[p:-p, p:-p] > r


def _dilate_disk(m, r):
    if r <= 0:
        return m.copy()
    p = int(np.ceil(r)) + 2
    d = distance_transform_edt(~np.pad(m, p, constant_values=False))
    return (d[p:-p, p:-p] <= r) | m


def open_disk(m, r):
    """圆盘开运算：结果中墨区任一点都落在某个直径 2r 且完全含于墨区的圆盘内
    —— 即"墨区最小宽度 >= 2r"，且原有达标的曲线边界一点不动（不产生方块）。"""
    return _dilate_disk(_erode_disk(m, r), r)


def close_disk(m, r):
    """圆盘闭运算：把窄于 2r 的空白缝并掉（避免激光/刻刀处理不了的发丝缝）"""
    return ~open_disk(~m, r)


def measured_min_width_px(mask, r_known, r_max):
    """实测：在已知满足半径 r_known 的基础上逐级加大圆盘半径，取仍满足开运算不变性
    的最大直径（像素）——即该版真实的墨区最小宽度。"""
    best = 0.0
    r = float(max(0, int(np.floor(r_known))))
    while r <= r_max:
        if np.array_equal(open_disk(mask, r), mask):
            best = r
            r += 1.0
        else:
            break
    return 2.0 * best


def enforce_min_width(mask, r):
    """保形强制最小线宽：墨区最小宽度 >= 2r。
    达标笔画原地保留；不足 2r 的细线/碎点整条圆滑移除。不做降采样、不做网格量化。"""
    m = open_disk(mask, r)
    m2 = close_disk(m, r)                        # 顺手并掉过窄空白缝
    if np.array_equal(open_disk(m2, r), m2):     # 只有不破坏线宽才采用
        m = m2
    return m


def render_aa(mask, out_w, out_h, sigma_out=0.55):
    """渲染抗锯齿覆盖度（0~1）：先按输出像素尺度做微小高斯，再缩放到输出尺寸。
    高斯对称，50% 等值线≈原边界，因此阈值 0.5 得到的仍是同一几何，
    但边缘成为连续过渡，不再有阶梯锯齿。"""
    W = mask.shape[1]
    sig = max(0.35, sigma_out * W / out_w)
    f = gaussian_filter(mask.astype(np.float32), sig)
    if (W, mask.shape[0]) != (out_w, out_h):
        f = np.asarray(Image.fromarray(f).resize((out_w, out_h), Image.BILINEAR))
    return np.clip(f, 0.0, 1.0)


def reg_positions(CW, CH):
    x0, y0, x1, y1 = MARGIN, MARGIN, CW-MARGIN, CH-MARGIN
    return [(x0-REG_OFF, y0-REG_OFF), (x1+REG_OFF, y0-REG_OFF),
            (x0-REG_OFF, y1+REG_OFF), (x1+REG_OFF, y1+REG_OFF)]


def draw_regs(draw, CW, CH, color):
    for cx, cy in reg_positions(CW, CH):
        draw.rectangle([cx-REG_ARM, cy-REG_W//2, cx+REG_ARM, cy+REG_W//2], fill=color)
        draw.rectangle([cx-REG_W//2, cy-REG_ARM, cx+REG_W//2, cy+REG_ARM], fill=color)


def svg_reg_rects(CW, CH):
    return "\n".join(
        f'<rect x="{cx-REG_ARM}" y="{cy-REG_W/2}" width="{2*REG_ARM}" height="{REG_W}"/>\n'
        f'<rect x="{cx-REG_W/2}" y="{cy-REG_ARM}" width="{REG_W}" height="{2*REG_ARM}"/>'
        for cx, cy in reg_positions(CW, CH))


def mask_to_path_d(mask, tolerance=0.9, min_area=4.0):
    """位图 -> 平滑贝塞尔矢量路径。
    亚像素等值线追踪 -> RDP 简化 -> Catmull-Rom 转三次贝塞尔；
    外轮廓与孔洞写进同一条 path，用 evenodd 填充规则渲染。
    边界是真正的曲线，在 AI/CDR 里放大任意倍率都无锯齿。"""
    parts = []
    for c in find_contours(mask.astype(np.float32), 0.5):
        if len(c) < 8:
            continue
        p = approximate_polygon(c, tolerance=tolerance)
        if len(p) > 1 and np.allclose(p[0], p[-1]):
            p = p[:-1]
        if len(p) < 3:
            continue
        x, y = p[:, 1], p[:, 0]
        if 0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) < min_area:
            continue
        pts = np.stack([x, y], 1)
        n = len(pts)
        d = [f"M{pts[0,0]:.2f} {pts[0,1]:.2f}"]
        for i in range(n):
            p0, p1 = pts[(i-1) % n], pts[i]
            p2, p3 = pts[(i+1) % n], pts[(i+2) % n]
            c1 = p1 + (p2 - p0) / 6.0
            c2 = p2 - (p3 - p1) / 6.0
            d.append(f"C{c1[0]:.2f} {c1[1]:.2f} {c2[0]:.2f} {c2[1]:.2f} {p2[0]:.2f} {p2[1]:.2f}")
        d.append("Z")
        parts.append("".join(d))
    return "".join(parts)


def clean_stem(stem):
    return re.sub(r"[-_]?(PhilGreenwood版画|版画|风格|AI生成|初版)$", "", stem).strip("-_") or stem


def separate(src, dirname, outroot, K, dpi, fonts, min_mm, width_mm):
    font_t, font_s, font_x = fonts
    im = Image.open(src).convert("RGB")
    w0, h0 = im.size
    # 抹右下角小水印（AI 角标）
    aa = np.asarray(im).copy()
    x1, y1, x2, y2 = w0-int(w0*0.12), h0-int(h0*0.05), w0-4, h0-2
    samp = aa[max(0, y1-int(h0*0.06)):y1-6, x1:x2].reshape(-1, 3)
    aa[y1:y2, x1:x2] = np.median(samp, 0).astype(np.uint8)
    im = Image.fromarray(aa)

    # ---- 分辨率规划：输出分辨率 <= 源图的 SRC_CAP 倍（再多就是无意义插值） ----
    # width_mm 指成品**长边**：横构图长边=宽，竖构图长边=高（否则竖图会被撑成超高巨幅且掉 dpi）
    mm_w = float(width_mm) if w0 >= h0 else float(width_mm) * w0 / h0
    out_w = min(int(round(mm_w / 25.4 * dpi)), w0 * SRC_CAP)
    out_w -= out_w % 2
    out_h = int(round(out_w * h0 / w0)); out_h -= out_h % 2
    dpi_tag = out_w / (mm_w / 25.4)
    work_w = min(out_w * RES, w0 * 6); work_w -= work_w % 2
    work_h = int(round(work_w * h0 / w0)); work_h -= work_h % 2
    dpi_work = work_w / (mm_w / 25.4)
    min_px_work = int(np.ceil(min_mm / 25.4 * dpi_work))
    if min_px_work % 2:
        min_px_work += 1                       # 取偶，半径才是整数
    r_work = min_px_work / 2.0
    min_mm_eff = min_px_work / dpi_work * 25.4

    src_rgb = im.resize((work_w, work_h), Image.LANCZOS)     # 高分辨率插值 -> 边界本就平滑
    a = np.asarray(src_rgb); H, W = work_h, work_w
    HW = H * W
    flat = a.reshape(-1, 3)
    rng = np.random.default_rng(42)
    sidx = np.sort(rng.choice(HW, min(SAMPLE_N, HW), replace=False))
    sl = [rgb2lab(flat[sidx[i:i+CHUNK]].reshape(-1, 1, 3)).reshape(-1, 3)
          for i in range(0, sidx.shape[0], CHUNK)]
    km = KMeans(n_clusters=K, n_init=4, random_state=42).fit(np.concatenate(sl))
    labels = np.empty(HW, np.uint8)
    for i in range(0, HW, CHUNK):
        labels[i:i+CHUNK] = km.predict(rgb2lab(flat[i:i+CHUNK].reshape(-1, 1, 3)).reshape(-1, 3))
    labels = labels.reshape(H, W)
    del flat, sl

    cl = km.cluster_centers_
    L, A, B = cl.T
    fy = (L+16)/116; fx = A/500 + fy; fz = fy - B/200
    inv = lambda t: np.where(t**3 > 0.008856, t**3, (t-16/116)/7.787)
    xr, yr, zr = inv(fx)*0.95047, inv(fy), inv(fz)*1.08883
    lin = np.clip(np.stack([xr*3.2406+yr*-1.5372+zr*-0.4986,
                            xr*-0.9689+yr*1.8758+zr*0.0415,
                            xr*0.0557+yr*-0.2040+zr*1.0570], 1), 0, 1)
    srgb = np.where(lin > 0.0031308, 1.055*lin**(1/2.4)-0.055, 12.92*lin)
    cents = (np.clip(srgb, 0, 1)*255).astype(int)
    chroma = np.sqrt(cl[:, 1]**2 + cl[:, 2]**2)
    paper_set = {i for i in range(K) if cl[i, 0] >= 88 and chroma[i] <= 15} or {int(np.argmax(cl[:, 0]))}
    paper_i = max(paper_set, key=lambda i: cl[i, 0])
    plate_idx = sorted([i for i in range(K) if i not in paper_set], key=lambda i: -cl[i, 0])
    name_of = {i: name_lab(*cl[i]) for i in range(K)}
    outdir = outroot / dirname; outdir.mkdir(parents=True, exist_ok=True)
    CW, CH = out_w + 2*MARGIN, out_h + 2*MARGIN
    mm_art_w, mm_art_h = out_w/dpi_tag*25.4, out_h/dpi_tag*25.4
    mm_plate_w, mm_plate_h = CW/dpi_tag*25.4, CH/dpi_tag*25.4

    # 叠印预览用累积器（输出分辨率），逐版渲染完立即合成，避免同时驻留 6 份大数组
    acc = np.zeros((out_h, out_w, 3), np.float32)
    wsum = np.zeros((out_h, out_w), np.float32)
    rows, used, meta, thumbs = [], {}, [], []
    tw2 = 620
    for order, ci in enumerate(plate_idx, 1):
        src_msk = (labels == ci)
        eff = enforce_min_width(src_msk, r_work)
        mv = measured_min_width_px(eff, r_work, r_work + 12)
        alpha = render_aa(eff, out_w, out_h)
        del eff, src_msk
        hard = alpha >= 0.5
        cov = float(alpha.mean()*100)
        rm = float((1 - cov / max(1e-9, float((labels == ci).mean()*100))) * 100)
        hexv = "#%02X%02X%02X" % tuple(cents[ci]); nm = name_of[ci]
        used[nm] = used.get(nm, 0) + 1
        if used[nm] > 1: nm = f"{nm}{used[nm]}"

        plate = np.full((CH, CW), 255, np.uint8)
        plate[MARGIN:MARGIN+out_h, MARGIN:MARGIN+out_w] = np.round(255 - 255*alpha).astype(np.uint8)
        pc = Image.fromarray(plate); del plate
        draw_regs(ImageDraw.Draw(pc), CW, CH, 0)
        fn = f"{order:02d}_{nm}_{hexv[1:]}.png"
        pc.save(outdir / fn, dpi=(dpi_tag, dpi_tag), optimize=True)

        dpath = mask_to_path_d(hard)
        (outdir / (fn[:-4] + ".svg")).write_text(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{mm_plate_w:.2f}mm" '
            f'height="{mm_plate_h:.2f}mm" viewBox="0 0 {CW} {CH}">\n'
            f'<rect width="{CW}" height="{CH}" fill="#FFFFFF"/>\n'
            f'<g transform="translate({MARGIN},{MARGIN})">'
            f'<path d="{dpath}" fill="#000000" fill-rule="evenodd"/></g>\n'
            f'{svg_reg_rects(CW, CH)}\n</svg>\n', encoding="utf-8")

        # 即时合成预览 + 生成示意小图，随后即可释放大数组
        acc += alpha[..., None] * cents[ci]
        wsum += alpha
        tint = np.full((out_h, out_w, 3), 255, np.uint8); tint[hard] = cents[ci]
        bm = np.full((out_h, out_w, 3), 255, np.uint8); bm[hard] = 30
        ti = Image.fromarray(tint); ti.thumbnail(((tw2-24)//2, 180))
        bi = Image.fromarray(bm); bi.thumbnail(((tw2-24)//2, 180))
        thumbs.append((ti, bi))
        del alpha, hard, tint, bm

        meta.append((order, ci, nm, cov, rm, mv))
        rows.append([dirname, order, fn, fn[:-4] + ".svg", nm, hexv,
                     f"{cents[ci][0]},{cents[ci][1]},{cents[ci][2]}",
                     f"{cov:.1f}", f"{rm:.1f}", f"{mv/dpi_work*25.4:.2f}",
                     f"{mm_art_w:.0f}x{mm_art_h:.0f}mm"])
    acc += np.clip(1.0 - wsum, 0, 1)[..., None] * cents[paper_i]
    prev_aa = np.clip(acc, 0, 255).astype(np.uint8)
    del acc, wsum
    canvas = Image.new("RGB", (CW, CH), (255, 255, 255)); canvas.paste(Image.fromarray(prev_aa), (MARGIN, MARGIN))
    draw_regs(ImageDraw.Draw(canvas), CW, CH, (60, 60, 60))
    canvas.save(outdir / "00_叠印预览.png", dpi=(dpi_tag, dpi_tag))

    pmask = np.isin(labels, list(paper_set))
    pcent = cents[paper_i]
    rows.append([dirname, "纸色", "（留纸不印）", "", "纸白", "#%02X%02X%02X" % tuple(pcent),
                 f"{pcent[0]},{pcent[1]},{pcent[2]}", f"{pmask.mean()*100:.1f}", "0.0", "—",
                 f"{mm_art_w:.0f}x{mm_art_h:.0f}mm"])
    del labels, pmask

    # 分板示意
    gap, rowh = 24, 250
    thumb = im.copy(); thumb.thumbnail((tw2, tw2))
    prev_t = canvas.copy(); prev_t.thumbnail((tw2, tw2))
    npn = len(plate_idx)
    sheet = Image.new("RGB", (tw2*2+gap*3, 200+max(thumb.height, prev_t.height)+((npn+1)//2)*(rowh+gap)), (245, 245, 242))
    sd = ImageDraw.Draw(sheet)
    sd.text((gap, 22), f"{dirname}  激光雕刻分板示意", font=font_t, fill=(20, 20, 20))
    sd.text((gap, 76), f"画面 {out_w}×{out_h}px @{dpi_tag:.0f}dpi ≈ {mm_art_w:.0f}×{mm_art_h:.0f}mm"
                       f" ｜ 版材含规矩线 {mm_plate_w:.0f}×{mm_plate_h:.0f}mm ｜ {npn} 块色版 + 留纸",
            font=font_s, fill=(90, 90, 90))
    sd.text((gap, 118), f"圆盘保形最小线宽 ≥{min_px_work}px@{dpi_work:.0f}dpi = {min_mm_eff:.2f}mm"
                        f"（要求 AI 2pt / PS 10px@300dpi / CDR 0.6mm，取最严）· 非量化、不降采样",
            font=font_s, fill=(150, 60, 40))
    sd.text((gap, 152), "缩放本页查看：色版边界应为连续曲线，出现方格/条带即为不合格",
            font=font_x, fill=(150, 150, 150))
    sheet.paste(thumb, (gap, 185)); sheet.paste(prev_t, (gap*2+tw2, 185))
    y = 185 + max(thumb.height, prev_t.height) + gap
    for kk, (order, ci, nm, cov, rm, mv) in enumerate(meta):
        col = kk % 2; x = gap + col*(tw2+gap); yy = y + (kk//2)*(rowh+gap)
        ti, bi = thumbs[kk]
        sheet.paste(ti, (x, yy)); sheet.paste(bi, (x+(tw2-gap)//2, yy))
        sd.text((x, yy+ti.height+8), f"第{order}版 {nm} {'#%02X%02X%02X' % tuple(cents[ci])}  覆盖{cov:.1f}%  并掉{rm:.0f}%",
                font=font_x, fill=(20, 20, 20))
        sd.text((x, yy+ti.height+38), f"实测最小线宽 {mv/dpi_work*25.4:.2f}mm ｜ 左=色区示意 右=黑白版 ｜ 附矢量SVG",
                font=font_x, fill=(120, 120, 120))
    sheet.save(outdir / "分板示意.png")

    avg_rm = np.mean([m[4] for m in meta])
    info = dict(min_mm_eff=min_mm_eff, dpi_tag=dpi_tag, dpi_work=dpi_work,
                mm_art_w=mm_art_w, mm_art_h=mm_art_h,
                mm_plate_w=mm_plate_w, mm_plate_h=mm_plate_h,
                out_w=out_w, out_h=out_h, nplates=npn)
    print(f"[OK] {dirname}: {npn}版, 圆盘核 {min_px_work}px@{dpi_work:.0f}dpi = {min_mm_eff:.2f}mm, "
          f"平均并掉{avg_rm:.0f}%, 最小线宽实测 {min(m[5] for m in meta)/dpi_work*25.4:.2f}mm, "
          f"画面 {out_w}x{out_h}px@{dpi_tag:.0f}dpi = {mm_art_w:.0f}x{mm_art_h:.0f}mm + {npn} 个 SVG")
    return rows, info


def manufacturer_txt(info):
    return f"""============================================================
激光雕刻分色版 · 厂家制作说明
水印木刻套色方式：一色一版，按规矩线逐版套印
============================================================

【最小线宽（甲方硬性要求，已按最严档执行）】
  要求：Illustrator >= 2pt(0.706mm) ｜ Photoshop >= 10px @300DPI(0.847mm) ｜ CorelDRAW >= 0.6mm
  取最严：0.847mm
  实际执行：所有版按 >= {info['min_mm_eff']:.2f}mm（{round(info['min_mm_eff']/25.4*info['dpi_work'])}px @{info['dpi_work']:.0f}DPI）强制校验通过，
            CSV「实测最小线宽mm」逐版列明，画面内不存在低于该值的墨线。
  做法说明：采用"圆盘保形开运算"——宽度达标的笔画与色块一点不动、曲线原样保留；
            只有不足该值的细线与碎点被整条圆滑抹去。
            未做任何降采样或网格量化，不会出现方块化/马赛克。
            原作里细于该值的飞尘颗粒与细排线属激光雕刻物理极限，无法保留。
  提示：最小线宽是"绝对毫米值"。若想保留更多细排线肌理，可整体放大成品尺寸
        （放大后细线同步变粗，更容易达标），全套餐版须同倍率等比缩放，规矩线一起缩放。

【尺寸】
  画面（实际印刷区域）：{info['mm_art_w']:.1f} x {info['mm_art_h']:.1f} mm
  版材（含四角规矩线留白）：{info['mm_plate_w']:.1f} x {info['mm_plate_h']:.1f} mm
  光栅分辨率 {info['dpi_tag']:.0f} DPI，画面 {info['out_w']} x {info['out_h']} px

【文件约定】
1. 每块色版提供两种格式，二选一使用：
   · NN_色名_HEX.png —— 灰阶位图。黑(0) = 该色上墨/保留区域，白(255) = 刻除/不上墨，
     边缘为 1px 抗锯齿过渡（视觉平滑），按 50% 灰作阈值即得精确边界。
   · NN_色名_HEX.svg —— 矢量路径（贝塞尔曲线），AI / CorelDRAW 直接可用。
     放大到任意倍率都无锯齿；请锁定文件自带的物理尺寸（见 SVG width/height 的 mm 值），
     或仅等比放大，不要单独缩小。
2. 四角黑色十字为套印规矩线，线宽 14px（1.19mm），所有色版坐标完全一致：
   禁止裁切/移动/单轴缩放；全部色版用同一靠身定位，先校第 1 版十字再逐版套印。
3. 印刷严格按文件名 01→06（浅色先印、深色后印）。
4. "纸色"不制版，靠纸张本色；请用暖白/米白纸（HEX 见 CSV），不要用冷白高光铜版纸。
5. 调色按文件名与 CSV 的 HEX/RGB，干膜色以米白纸上打样为准。
6. 建议先做覆盖率最高、对比最强的一套打样，校套印后再批量。
============================================================
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("images", nargs="+", help="待分板图片路径")
    ap.add_argument("--out", default=str(pathlib.Path.home() / "Desktop/版画激光分板"))
    ap.add_argument("--colors", type=int, default=7, help="聚类数（含纸色），默认7 → 约6块版")
    ap.add_argument("--dpi", type=int, default=300)
    ap.add_argument("--min-mm", type=float, default=0.85,
                    help="最小线宽(mm)。0.85 对应三条要求中最严的 PS 10px@300dpi")
    ap.add_argument("--width-mm", type=float, default=400,
                    help="成品画面**长边**(mm)，用户 2026-10-03 定为 400（横图=宽，竖图=高）。放大可保留更多细排线肌理")
    args = ap.parse_args()
    fp = find_font()
    if not fp:
        print("找不到中文字体", file=sys.stderr); sys.exit(1)
    fonts = (ImageFont.truetype(fp, 40), ImageFont.truetype(fp, 26), ImageFont.truetype(fp, 22))
    outroot = pathlib.Path(args.out)
    all_rows, info = [], None
    for i, s in enumerate(args.images, 1):
        src = pathlib.Path(s)
        if not src.exists():
            print(f"[跳过] 不存在: {s}", file=sys.stderr); continue
        rows, info = separate(src, f"{i:02d}_{clean_stem(src.stem)}", outroot,
                              args.colors, args.dpi, fonts, args.min_mm, args.width_mm)
        all_rows += rows
    with open(outroot / "分板清单.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["作品", "印刷次序", "色版PNG", "色版SVG", "色名", "HEX", "RGB",
                    "覆盖率%", "细部并掉%", "实测最小线宽mm", "画面尺寸"])
        w.writerows(all_rows)
    (outroot / "厂家制作说明.txt").write_text(
        manufacturer_txt(info or dict(min_mm_eff=0.93, dpi_work=600, dpi_tag=300,
                                      mm_art_w=0, mm_art_h=0, mm_plate_w=0, mm_plate_h=0,
                                      out_w=0, out_h=0)), encoding="utf-8")
    print(f"\n清单: {outroot/'分板清单.csv'}")


if __name__ == "__main__":
    main()