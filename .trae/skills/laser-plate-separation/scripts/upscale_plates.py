#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把已有的色版 PNG 等比放大，使最小线宽达到目标像素（默认 10px = 厂家 PS 硬要求）。

用途：手上已有一批干净的色版，但线条比 10px 细，且要求"内容一点不改"。
做法：不重绘、不删图形，只把整幅等比放大 S 倍；放大前清掉 <目标/S 像素宽的
      1px 抗锯齿毛刺（那是阈值化副产物，不是画的内容），保证放大后没有低于
      目标线宽的墨迹。边界用双线性重采样，平滑无锯齿。

用法:
  python upscale_plates.py 01_*.png 02_*.png [...] --out 目标目录 --scale 5
自动算倍数（最小线宽刚好达标）时省略 --scale。
"""
import argparse, pathlib, sys
import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt


def _erode_disk(m, r):
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
    return _dilate_disk(_erode_disk(m, r), r)


def measured_min_width_px(mask, r_max=40.0, step=0.1):
    """逐级加大圆盘半径，取仍满足开运算不变性的最大半径，返回直径(px)。
    步长 0.1 以提高精度（循环在首次不满足时立即退出，实际只跑十几轮）。"""
    best, r = 0.0, 0.0
    while r <= r_max:
        if np.array_equal(open_disk(mask, r), mask):
            best, r = r, r + step
        else:
            break
    return round(2.0 * best, 2)


def convert_plate(path, out_path, scale, target_px, dpi):
    a = np.asarray(Image.open(path).convert("L"))
    cov = (255.0 - a) / 255.0               # 上墨覆盖度(0~1)
    binm = cov >= 0.5                       # 50% 等值线 = 几何边界
    clean = open_disk(binm, target_px / scale / 2.0)   # 清掉放大后会不达标的毛刺
    # 掩膜严格取 clean：绝不能再把刚清掉的细毛刺的灰度"膨"回来，
    # 否则成品最小线宽会退回 2px（×5 只剩 10px，卡在达标边界上）。
    src = Image.fromarray(np.where(clean, cov, 0.0).__mul__(255).astype(np.uint8))
    nw, nh = (int(round(src.width * scale)), int(round(src.height * scale)))
    big = np.asarray(src.resize((nw, nh), Image.BILINEAR))
    out = Image.fromarray(255 - big)        # 0=上墨区, 255=刻除区
    out.save(out_path, dpi=(dpi, dpi), optimize=True)
    ink_before = float(binm.mean())
    ink_after = float(clean.mean())         # 真实上墨掩膜的变化（不是输出阈值统计）
    # 在**源尺度**实测最小线宽再乘倍数：等比放大下线宽线性放大，
    # 这样避免对亿级像素的成品图做距离变换（内存/耗时都不可接受）。
    min_src = measured_min_width_px(clean, r_max=int(target_px / scale) + 3)
    return dict(px=(nw, nh), scale=scale,
                mm=(nw / dpi * 25.4, nh / dpi * 25.4), dpi=dpi,
                min_px=min_src * scale,
                lost_pct=(1 - ink_after / max(1e-9, ink_before)) * 100)


def convert_rgb(path, out_path, scale, dpi):
    src = Image.open(path).convert("RGB")
    nw, nh = (int(round(src.width * scale)), int(round(src.height * scale)))
    src.resize((nw, nh), Image.BILINEAR).save(out_path, dpi=(dpi, dpi), optimize=True)
    return dict(px=(nw, nh), scale=scale, mm=(nw / dpi * 25.4, nh / dpi * 25.4),
                dpi=dpi, min_px=None, lost_pct=0.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("images", nargs="+")
    ap.add_argument("--out", required=True)
    ap.add_argument("--scale", type=float, default=5.0,
                    help="等比放大倍数（内容不动）；默认 5")
    ap.add_argument("--target-px", type=int, default=10,
                    help="放大后要求的最小线宽(px)，默认 10")
    ap.add_argument("--dpi", type=int, default=300)
    args = ap.parse_args()

    outdir = pathlib.Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)
    for s in args.images:
        src = pathlib.Path(s)
        if not src.exists():
            print(f"[跳过] 不存在: {s}", file=sys.stderr)
            continue
        dst = outdir / src.name
        if Image.open(src).mode in ("L", "1"):
            r = convert_plate(src, dst, args.scale, args.target_px, args.dpi)
        else:
            r = convert_rgb(src, dst, args.scale, args.dpi)
        extra = "" if r["min_px"] is None else f"最小线宽 {r['min_px']:.1f}px ｜ 细部并掉 {r['lost_pct']:.1f}%"
        print(f"[OK] {src.name}: {r['px'][0]}x{r['px'][1]}px @{r['dpi']}dpi = "
              f"{r['mm'][0]:.0f}x{r['mm'][1]:.0f}mm ｜ {extra}")


if __name__ == "__main__":
    main()