#!/usr/bin/env python3
"""Cuts the YouTube video: frame folders in out/yt/<clip> → one 1080p MP4 with music.

Cuts are short crossfades placed on the beat of the music. Usage: assemble.py <music.mp3> [bpm]
Needs ffmpeg and numpy.
"""
import json, os, subprocess, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
YT = os.path.join(HERE, "out", "yt")
CLIPS = ["intro", "hero", "menubar", "tabs", "sessions", "snooze", "mac", "talk", "outro"]
FPS = 30
XF = 0.3  # crossfade length (s)
music = sys.argv[1]
bpm = float(sys.argv[2]) if len(sys.argv) > 2 else 112.0
beat = 60.0 / bpm


def run(cmd):
    subprocess.run(cmd, check=True)


def first_beat(path):
    """Phase of the beat grid that best matches the music's onsets in the first 20 s."""
    sr = 22050
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-t", "20", "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"],
                         capture_output=True).stdout
    x = np.frombuffer(raw, np.int16).astype(np.float32) / 32768
    hop, n = 256, 1024
    frames = np.lib.stride_tricks.sliding_window_view(x, n)[::hop]
    spec = np.abs(np.fft.rfft(frames * np.hanning(n), axis=1))
    flux = np.maximum(0, np.diff(np.log1p(spec), axis=0)).sum(1)
    t = np.arange(len(flux)) * hop / sr
    best, best_score = 0.0, -1
    for phase in np.arange(0, beat, 0.01):
        grid = np.arange(phase, t[-1], beat)
        idx = np.clip(np.round(grid * sr / hop).astype(int), 0, len(flux) - 1)
        score = flux[idx].sum()
        if score > best_score:
            best, best_score = phase, score
    return best


# 1. each clip as its own segment
lengths = []
for c in CLIPS:
    d = os.path.join(YT, c)
    n = len([f for f in os.listdir(d) if f.endswith(".png")])
    lengths.append(n / FPS)
    run(["ffmpeg", "-v", "error", "-y", "-framerate", str(FPS), "-i", os.path.join(d, "f_%04d.png"),
         "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", os.path.join(YT, f"{c}.mp4")])

# 2. cut points on the beat: each crossfade starts on a beat
phase = first_beat(music)
offsets, t = [], 0.0
for i, L in enumerate(lengths[:-1]):
    want = t + L - XF
    cut = phase + round((want - phase) / beat) * beat
    if cut > t + L - XF:  # never cut later than the clip lasts
        cut -= beat
    offsets.append(round(cut, 3))
    t = cut
total = offsets[-1] + lengths[-1]

# 3. video: xfade chain
inputs = []
for c in CLIPS:
    inputs += ["-i", os.path.join(YT, f"{c}.mp4")]
chain, prev = [], "[0:v]"
for i, off in enumerate(offsets):
    out = f"[v{i + 1}]"
    chain.append(f"{prev}[{i + 1}:v]xfade=transition=fade:duration={XF}:offset={off}{out}")
    prev = out
filt = ";".join(chain)
video = os.path.join(YT, "video_only.mp4")
run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", filt, "-map", prev, "-c:v", "libx264", "-preset", "slow",
     "-crf", "17", "-pix_fmt", "yuv420p", "-r", str(FPS), video])

# 4. music under it: fade in, fade out at the end, YouTube loudness
final = os.path.join(YT, "claude-code-alerts-youtube.mp4")
af = f"atrim=0:{total:.3f},afade=t=in:d=0.4,afade=t=out:st={total - 2.6:.3f}:d=2.6,loudnorm=I=-15:TP=-1.5:LRA=11,aresample=48000"
run(["ffmpeg", "-v", "error", "-y", "-i", video, "-i", music, "-filter_complex", f"[1:a]{af}[a]", "-map", "0:v", "-map", "[a]",
     "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", final])

# 5. where each part starts (for chapters)
starts = [0.0] + offsets
json.dump({"clips": CLIPS, "starts": starts, "total": total, "beat": beat, "phase": phase},
          open(os.path.join(YT, "timeline.json"), "w"), indent=1)
print(f"{final}: {total:.1f} s, beat {beat:.3f} s, first beat {phase:.2f} s")
print("starts:", ", ".join(f"{c} {s:.1f}" for c, s in zip(CLIPS, starts)))
