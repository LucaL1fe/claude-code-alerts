#!/usr/bin/env python3
"""Turns a screen recording into a README animated WebP: trims, blurs private areas, scales.

make_webp.py in.mov out.webp --start 1.5 --end 13 [--fps 12] [--width 1280] [--blur x0,y0,x1,y1 ...]
Blur boxes are in full-resolution pixels of the recording.
"""
import argparse, glob, os, subprocess, tempfile
from PIL import Image, ImageFilter

ap = argparse.ArgumentParser()
ap.add_argument("src"); ap.add_argument("dst")
ap.add_argument("--start", type=float, default=0); ap.add_argument("--end", type=float, default=0)
ap.add_argument("--fps", type=int, default=12); ap.add_argument("--width", type=int, default=1280)
ap.add_argument("--quality", type=int, default=72)
ap.add_argument("--blur", nargs="*", default=[])
ap.add_argument("--hold", type=float, default=1.2, help="seconds to hold the last frame")
ap.add_argument("--blur-if", default="", help="x,y,r,g,b: blur only frames whose pixel at x,y is near this color")
ap.add_argument("--cut", nargs="*", default=[], help="time ranges a-b (seconds of the source) to drop")
a = ap.parse_args()

boxes = [tuple(int(v) for v in b.split(",")) for b in a.blur]
tmp = tempfile.mkdtemp()
cmd = ["ffmpeg", "-v", "error", "-ss", str(a.start)]
if a.end:
    cmd += ["-to", str(a.end)]
cmd += ["-i", a.src, "-vf", f"fps={a.fps}", f"{tmp}/f_%04d.png"]
subprocess.run(cmd, check=True)
cuts = [tuple(float(v) for v in c.split("-")) for c in a.cut]
frames = []
for i, path in enumerate(sorted(glob.glob(f"{tmp}/f_*.png"))):
    t = a.start + i / a.fps
    if any(c0 <= t < c1 for c0, c1 in cuts):
        continue
    im = Image.open(path).convert("RGB")
    apply = True
    if a.blur_if:
        x, y, r, g, b = (int(v) for v in a.blur_if.split(","))
        pr, pg, pb = im.getpixel((x, y))
        apply = abs(pr - r) + abs(pg - g) + abs(pb - b) < 90
    for (x0, y0, x1, y1) in (boxes if apply else []):
        region = im.crop((x0, y0, x1, y1)).filter(ImageFilter.GaussianBlur(14))
        im.paste(region, (x0, y0))
    h = round(im.height * a.width / im.width)
    frames.append(im.resize((a.width, h), Image.LANCZOS))
durations = [round(1000 / a.fps)] * len(frames)
durations[-1] += int(a.hold * 1000)
frames[0].save(a.dst, save_all=True, append_images=frames[1:], duration=durations, loop=0,
               quality=a.quality, method=6)
print(f"{a.dst}: {len(frames)} frames, {os.path.getsize(a.dst) / 1e6:.1f} MB")
