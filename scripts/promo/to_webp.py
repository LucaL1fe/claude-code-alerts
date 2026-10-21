#!/usr/bin/env python3
"""Frames folder (2x PNGs) → animated WebP at 1280 px wide. Usage: to_webp.py <dir> <out.webp> <fps>"""
import glob, os, sys
from PIL import Image

src, dst, fps = sys.argv[1], sys.argv[2], int(sys.argv[3])
frames = [Image.open(p).convert("RGB").resize((1280, 800), Image.LANCZOS) for p in sorted(glob.glob(os.path.join(src, "f_*.png")))]
durations = [round(1000 / fps)] * len(frames)
durations[-1] += 1400  # hold the last frame before looping
frames[0].save(dst, save_all=True, append_images=frames[1:], duration=durations, loop=0, quality=72, method=6)
print(f"{dst}: {len(frames)} frames, {os.path.getsize(dst) / 1e6:.1f} MB")
