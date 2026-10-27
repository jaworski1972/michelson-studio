#!/usr/bin/env python3
"""Michelson Studio — processing engine for jewelry videos and photos.

Usage:
    python3 studio.py --input IN --outdir OUT --params params.json

Writes into OUT:
    progress.json      live progress {stage, pct, message}
    manifest.json      final list of outputs (written last)
    *.mp4 / *.jpg      outputs
    preview_before.jpg / preview_after.jpg   comparison frame
"""
import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import time

import cv2
import numpy as np

FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE", "ffprobe")

VIDEO_EXT = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".mts"}
PHOTO_EXT = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp", ".heic", ".heif"}

DEFAULTS = {
    "deflicker": {"enabled": "auto", "strength": 1.0, "grid": 16, "window": 9, "passes": 2},
    "stabilize": {"enabled": False, "smoothing": 20},
    "denoise": {"enabled": False, "strength": 3},
    "color": {"exposure": 0.0, "contrast": 1.0, "saturation": 1.0,
              "temperature": 6500, "gamma": 1.0},
    "sharpen": {"enabled": True, "amount": 0.5},
    "deblur": {"enabled": False, "strength": 0.4},   # photos only
    "outputs": ["master", "web"],
    "crop_offset": {"x": 0.5, "y": 0.5},
    # photos
    "photo": {"auto_wb": False, "max_side": 3000, "square": False,
              "packshot": False, "background": "none", "autocrop": False, "margin": 1.5, "target_side": 2000, "studio": 0,
              "format": "jpg"},
}


# ---------------------------------------------------------------- helpers
class Progress:
    def __init__(self, outdir):
        self.path = os.path.join(outdir, "progress.json")
        self.t0 = time.time()
        self.last = 0

    def __call__(self, stage, pct, message="", force=False):
        now = time.time()
        if not force and now - self.last < 1.0:
            return
        self.last = now
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"stage": stage, "pct": round(float(pct), 1), "message": message,
                       "elapsed": round(now - self.t0, 1)}, f)
        os.replace(tmp, self.path)
        print(f"[{stage}] {pct:5.1f}% {message}", flush=True)


def merge(defaults, override):
    out = {}
    for k, v in defaults.items():
        if isinstance(v, dict):
            out[k] = merge(v, (override or {}).get(k) or {})
        else:
            out[k] = (override or {}).get(k, v)
    for k, v in (override or {}).items():
        if k not in out:
            out[k] = v
    return out


def run(cmd):
    print("$ " + " ".join(cmd), flush=True)
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if r.returncode != 0:
        sys.stderr.write(r.stderr[-4000:])
        raise RuntimeError(f"command failed: {cmd[0]} (exit {r.returncode})")
    return r


def probe(path):
    r = run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
             "stream=width,height,r_frame_rate,nb_frames,duration:stream_side_data=rotation"
             ":stream_tags=rotate:format=duration",
             "-of", "json", path])
    info = json.loads(r.stdout)
    s = info["streams"][0]
    num, den = s["r_frame_rate"].split("/")
    fps = float(num) / float(den or 1)
    dur = float(s.get("duration") or info.get("format", {}).get("duration") or 0)
    nb = int(s.get("nb_frames") or 0) or int(round(dur * fps))
    rot = 0
    for sd in s.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(sd["rotation"])
    if "tags" in s and "rotate" in s["tags"]:
        rot = int(s["tags"]["rotate"])
    w, h = int(s["width"]), int(s["height"])
    if abs(rot) in (90, 270):
        w, h = h, w
    # audio?
    ra = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "a", "-show_entries",
                         "stream=index", "-of", "csv=p=0", path],
                        stdout=subprocess.PIPE, text=True)
    return {"w": w, "h": h, "fps": fps, "frames": nb, "duration": dur,
            "audio": bool(ra.stdout.strip())}


def even(x):
    x = int(round(x))
    return x - (x % 2)


# ---------------------------------------------------------------- color / sharpen (shared)
def color_filters(p):
    """ffmpeg filter chain for denoise + color + sharpening."""
    f = []
    if p["denoise"]["enabled"]:
        s = float(p["denoise"]["strength"])
        f.append(f"hqdn3d={s:.2f}:{s*0.75:.2f}:{s*1.5:.2f}:{s*1.1:.2f}")
    c = p["color"]
    temp = int(c["temperature"])
    if temp != 6500:
        f.append(f"colortemperature=temperature={temp}:pl=0.6")
    exp = float(c["exposure"])
    con = float(c["contrast"])
    sat = float(c["saturation"])
    gam = float(c["gamma"])
    if abs(exp) > 1e-3 or abs(con - 1) > 1e-3 or abs(sat - 1) > 1e-3 or abs(gam - 1) > 1e-3:
        f.append(f"eq=brightness={exp*0.25:.4f}:contrast={con:.4f}:saturation={sat:.4f}:gamma={gam:.4f}")
    if p["sharpen"]["enabled"]:
        a = max(0.0, min(1.0, float(p["sharpen"]["amount"])))
        # contrast-adaptive sharpen for edges + gentle unsharp for micro detail of stones
        f.append(f"cas=strength={0.25 + 0.6*a:.3f}")
        if a > 0.4:
            f.append(f"unsharp=5:5:{0.3 + 0.7*(a-0.4):.3f}:5:5:0")
    return f


# ---------------------------------------------------------------- deflicker 2D
def read_frames(path, w, h, vf=None):
    cmd = [FFMPEG, "-v", "error", "-i", path]
    if vf:
        cmd += ["-vf", vf]
    cmd += ["-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=w * h * 3 * 2)
    size = w * h * 3
    try:
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    finally:
        proc.stdout.close()
        proc.wait()


def block_means(frame, gw, gh):
    y = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float32)
    small = cv2.resize(y, (gw, gh), interpolation=cv2.INTER_AREA)
    return np.log(np.maximum(small, 2.0))


def temporal_smooth(arr, window):
    """Gaussian smoothing along axis 0 with reflect padding."""
    sigma = max(1.0, window / 3.0)
    r = int(math.ceil(sigma * 3))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    pad = np.pad(arr, [(r, r)] + [(0, 0)] * (arr.ndim - 1), mode="reflect")
    out = np.zeros_like(arr)
    for i, wgt in enumerate(k):
        out += wgt * pad[i:i + arr.shape[0]]
    return out


def deflicker_pass(src, dst, info, p, progress, label, pct0, pct1):
    w, h, fps = info["w"], info["h"], info["fps"]
    d = p["deflicker"]
    gw = int(d["grid"])
    gh = max(4, int(round(gw * h / w)))
    window = int(d["window"])
    strength = float(d["strength"])
    n_est = max(1, info["frames"])

    # pass A: statistics
    stats = []
    for i, fr in enumerate(read_frames(src, w, h)):
        stats.append(block_means(fr, gw, gh))
        progress("deflicker", pct0 + (pct1 - pct0) * 0.35 * min(1, i / n_est), f"{label}: analiza klatek")
    if not stats:
        raise RuntimeError("no frames decoded")
    stats = np.stack(stats)                        # (n, gh, gw) log-luma
    ref = temporal_smooth(stats, window)
    gain = np.clip((ref - stats) * strength, math.log(0.6), math.log(1.6))
    # spatially smooth gains so moving edges do not create blotches
    gain = np.stack([cv2.GaussianBlur(g, (0, 0), 1.0) for g in gain])
    n = len(stats)

    # pass B: apply
    enc = encoder_proc(dst, w, h, fps, crf=12)
    for i, fr in enumerate(read_frames(src, w, h)):
        if i >= n:
            break
        g = np.exp(cv2.resize(gain[i], (w, h), interpolation=cv2.INTER_CUBIC))
        out = fr.astype(np.float32) * g[:, :, None]
        enc.stdin.write(np.clip(out, 0, 255).astype(np.uint8).tobytes())
        progress("deflicker", pct0 + (pct1 - pct0) * (0.35 + 0.65 * min(1, i / n)), f"{label}: korekta")
    enc.stdin.close()
    if enc.wait() != 0:
        raise RuntimeError("encoder failed in deflicker")


FLICKER_THRESHOLD = 0.4


def measure_flicker(path, info):
    """Median (over image blocks) std of high-frequency temporal luma change, in 8-bit units."""
    w = 192
    h = even(w * info["h"] / info["w"])
    means = []
    for fr in read_frames(path, w, h, vf=f"scale={w}:{h}"):
        y = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY).astype(np.float32)
        means.append(cv2.resize(y, (12, max(4, int(12 * h / w))), interpolation=cv2.INTER_AREA))
    if len(means) < 10:
        return 0.0
    m = np.stack(means)
    hf = m - temporal_smooth(m, 7)
    # flicker is coherent across blocks; motion is not -> use the frame-wide mean of the residual
    coherent = hf.reshape(len(m), -1).mean(axis=1)
    return float(coherent.std())


def encoder_proc(dst, w, h, fps, crf=14):
    cmd = [FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
           "-s", f"{w}x{h}", "-r", f"{fps:.6f}", "-i", "-",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf), "-pix_fmt", "yuv420p", dst]
    return subprocess.Popen(cmd, stdin=subprocess.PIPE)


# ---------------------------------------------------------------- video
def process_video(inp, outdir, p, progress):
    info = probe(inp)
    progress("start", 1, f"{info['w']}x{info['h']} {info['fps']:.2f} fps, {info['duration']:.1f}s", force=True)
    work = os.path.join(outdir, "_work")
    os.makedirs(work, exist_ok=True)

    # 0. normalise: decode once to a high-quality intermediate (handles rotation, HDR->SDR, odd codecs)
    cur = os.path.join(work, "src.mp4")
    run([FFMPEG, "-v", "error", "-y", "-i", inp, "-map", "0:v:0",
         "-vf", "format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "12",
         "-r", f"{info['fps']:.6f}", cur])
    progress("start", 5, "plik wczytany", force=True)

    # 1. stabilisation (two-pass vidstab)
    if p["stabilize"]["enabled"]:
        trf = os.path.join(work, "transforms.trf")
        run([FFMPEG, "-v", "error", "-y", "-i", cur, "-vf",
             f"vidstabdetect=shakiness=6:accuracy=12:result={trf}", "-f", "null", "-"])
        nxt = os.path.join(work, "stab.mp4")
        sm = int(p["stabilize"]["smoothing"])
        run([FFMPEG, "-v", "error", "-y", "-i", cur, "-vf",
             f"vidstabtransform=input={trf}:smoothing={sm}:zoom=2:optzoom=0:interpol=bicubic",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", nxt])
        cur = nxt
        progress("stabilize", 20, "stabilizacja gotowa", force=True)

    # 2. deflicker 2D (one or two passes); "auto" = only when flicker is measured
    do_defl = p["deflicker"]["enabled"]
    if do_defl == "auto":
        score = measure_flicker(cur, info)
        do_defl = score > FLICKER_THRESHOLD
        progress("analyze", 22, f"migotanie: {score:.2f} ({'korekta' if do_defl else 'brak, pomijam'})", force=True)
    if do_defl:
        passes = max(1, min(3, int(p["deflicker"]["passes"])))
        span = 55.0 / passes
        for k in range(passes):
            nxt = os.path.join(work, f"defl{k}.mp4")
            deflicker_pass(cur, nxt, info, p, progress, f"przebieg {k+1}/{passes}",
                           20 + k * span, 20 + (k + 1) * span)
            cur = nxt
        progress("deflicker", 75, "migotanie usunięte", force=True)

    # 3. colour + denoise + sharpen -> master
    master = os.path.join(outdir, "master.mp4")
    vf = color_filters(p) + ["format=yuv420p"]
    cmd = [FFMPEG, "-v", "error", "-y", "-i", cur]
    if info["audio"]:
        cmd += ["-i", inp, "-map", "0:v:0", "-map", "1:a:0?", "-c:a", "aac", "-b:a", "192k", "-shortest"]
    cmd += ["-vf", ",".join(vf), "-c:v", "libx264", "-preset", "veryfast", "-crf", "16",
            "-movflags", "+faststart", master]
    run(cmd)
    progress("export", 85, "wersja główna gotowa", force=True)

    outputs = [{"key": "master", "file": "master.mp4", "label": "Pełna jakość"}]
    outs = set(p.get("outputs") or [])
    W, H = info["w"], info["h"]
    cx, cy = float(p["crop_offset"]["x"]), float(p["crop_offset"]["y"])

    def crop_expr(ar_w, ar_h):
        # largest crop with given aspect ratio, positioned by crop_offset
        if W / H > ar_w / ar_h:
            ch = H
            cw = even(H * ar_w / ar_h)
        else:
            cw = W
            ch = even(W * ar_h / ar_w)
        x = even((W - cw) * cx)
        y = even((H - ch) * cy)
        return f"crop={cw}:{ch}:{x}:{y}"

    variants = {
        "web": ("web.mp4", "Strona (1080p, lekki)", None, 1920),
        "9x16": ("reels_9x16.mp4", "Reels / Stories 9:16", (9, 16), 1920),
        "1x1": ("post_1x1.mp4", "Post 1:1", (1, 1), 1080),
        "4x5": ("post_4x5.mp4", "Post 4:5", (4, 5), 1350),
        "16x9": ("wide_16x9.mp4", "Poziomy 16:9", (16, 9), 1080),
    }
    todo = [k for k in variants if k in outs]
    for i, key in enumerate(todo):
        fname, label, ar, maxdim = variants[key]
        vf = []
        if ar:
            vf.append(crop_expr(*ar))
            vf.append(f"scale='if(gt(iw,ih),min({maxdim},iw),-2)':'if(gt(iw,ih),-2,min({maxdim},ih))'")
        else:
            vf.append(f"scale='if(gt(iw,ih),min({maxdim},iw),-2)':'if(gt(iw,ih),-2,min({maxdim},ih))'")
        vf.append("format=yuv420p")
        cmd = [FFMPEG, "-v", "error", "-y", "-i", master, "-vf", ",".join(vf),
               "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-profile:v", "high",
               "-movflags", "+faststart"]
        cmd += (["-c:a", "aac", "-b:a", "128k"] if info["audio"] else ["-an"])
        run(cmd + [os.path.join(outdir, fname)])
        outputs.append({"key": key, "file": fname, "label": label})
        progress("export", 85 + 12 * (i + 1) / max(1, len(todo)), label, force=True)

    # comparison frames (same timestamp, before vs after)
    t = max(0.0, info["duration"] * 0.4)
    run([FFMPEG, "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", inp, "-frames:v", "1",
         "-vf", "scale='min(1600,iw)':-2", "-q:v", "3", os.path.join(outdir, "preview_before.jpg")])
    run([FFMPEG, "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", master, "-frames:v", "1",
         "-vf", "scale='min(1600,iw)':-2", "-q:v", "3", os.path.join(outdir, "preview_after.jpg")])
    shutil.rmtree(work, ignore_errors=True)
    return outputs, info


# ---------------------------------------------------------------- photos
def gray_world_wb(img):
    f = img.astype(np.float32)
    # ignore near-white and near-black pixels (backgrounds, metal highlights)
    lum = f.mean(axis=2)
    mask = (lum > 30) & (lum < 225)
    if mask.sum() < 1000:
        return img
    means = f[mask].mean(axis=0)
    g = means.mean() / np.maximum(means, 1)
    g = np.clip(g, 0.85, 1.18)
    return np.clip(f * g, 0, 255).astype(np.uint8)


def apply_color_photo(img, c):
    f = img.astype(np.float32) / 255.0
    temp = int(c["temperature"])
    if temp != 6500:
        # simple warm/cool shift: >6500 warmer (more red, less blue)
        k = (temp - 6500) / 3000.0
        f[:, :, 2] *= 1 + 0.12 * k   # R
        f[:, :, 0] *= 1 - 0.12 * k   # B
    exp = float(c["exposure"])
    if abs(exp) > 1e-3:
        f *= 2 ** exp
    gam = float(c["gamma"])
    if abs(gam - 1) > 1e-3:
        f = np.power(np.clip(f, 0, 1), 1.0 / gam)
    con = float(c["contrast"])
    if abs(con - 1) > 1e-3:
        f = (f - 0.5) * con + 0.5
    sat = float(c["saturation"])
    if abs(sat - 1) > 1e-3:
        gray = f.mean(axis=2, keepdims=True)
        f = gray + (f - gray) * sat
    return np.clip(f * 255, 0, 255).astype(np.uint8)


def sharpen_photo(img, amount):
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    L = lab[:, :, 0].astype(np.float32)
    # two radii: fine detail (facets) + medium (edges of the setting)
    fine = L - cv2.GaussianBlur(L, (0, 0), 0.8)
    mid = L - cv2.GaussianBlur(L, (0, 0), 2.5)
    # protect flat areas (skin, background) from noise amplification
    edge = cv2.GaussianBlur(np.abs(mid), (0, 0), 2.0)
    m = np.clip(edge / 6.0, 0, 1)
    L2 = L + m * (amount * 1.2 * fine + amount * 0.6 * mid)
    lab[:, :, 0] = np.clip(L2, 0, 255).astype(np.uint8)
    return cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)


def deblur_photo(img, strength):
    """Richardson-Lucy deconvolution on luma with a Gaussian PSF.
    Recovers detail lost to slight defocus (prongs, pave stones). Edge-masked so skin/background stay clean."""
    sigma = 1.1 + 1.5 * max(0.0, min(1.0, strength))
    iters = 10 + int(6 * strength)
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    L = lab[:, :, 0].astype(np.float32) / 255.0 + 1e-3
    est = L.copy()
    blur = lambda x: cv2.GaussianBlur(x, (0, 0), sigma)
    for _ in range(iters):
        est = np.clip(est * blur(L / np.maximum(blur(est), 1e-3)), 0, 1.2)
    e = cv2.GaussianBlur(np.abs(L - cv2.GaussianBlur(L, (0, 0), 2)), (0, 0), 3)
    m = np.clip(e / 0.02, 0, 1)
    out = L * (1 - m) + est * m
    lab[:, :, 0] = np.clip(out * 255, 0, 255).astype(np.uint8)
    return cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)


MODEL_PATH = os.environ.get("ISNET_MODEL", "/opt/models/isnet-general-use.onnx")
_SESSION = None


def product_mask(img):
    """Foreground (product) mask 0..1 using IS-Net (dichotomous image segmentation)."""
    global _SESSION
    import onnxruntime as ort
    if _SESSION is None:
        _SESSION = ort.InferenceSession(MODEL_PATH, providers=["CPUExecutionProvider"])
    h, w = img.shape[:2]
    x = cv2.resize(cv2.cvtColor(img, cv2.COLOR_BGR2RGB), (1024, 1024),
                   interpolation=cv2.INTER_LANCZOS4).astype(np.float32) / 255.0
    x = x / max(1e-6, float(x.max())) - 0.5
    x = x.transpose(2, 0, 1)[None]
    out = _SESSION.run(None, {_SESSION.get_inputs()[0].name: x})[0][0, 0]
    m = (out - out.min()) / max(1e-6, float(out.max() - out.min()))
    m = cv2.resize(m, (w, h), interpolation=cv2.INTER_LINEAR)
    # keep only significant blobs (drops dust specks)
    bin_ = (m > 0.5).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(bin_, 8)
    if n > 1:
        areas = stats[1:, cv2.CC_STAT_AREA]
        keep = np.zeros(n, bool)
        keep[1:] = areas >= max(50, areas.max() * 0.02)
        support = cv2.dilate(keep[lab].astype(np.uint8), np.ones((15, 15), np.uint8))
        m = m * support
    return m.astype(np.float32)


def studio_look(f, alpha, strength):
    """Catalogue look on the product only: local contrast (polished metal), deeper blacks and
    brighter highlights (crisp facets), neutral metal."""
    img = np.clip(f, 0, 255).astype(np.uint8)
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    L = lab[:, :, 0]
    clahe = cv2.createCLAHE(clipLimit=1.5 + 2.5 * strength, tileGridSize=(8, 8))
    L2 = clahe.apply(L).astype(np.float32) / 255.0
    # S-curve: deeper shadows in facets/edges, cleaner highlights on metal
    k = 0.6 + 1.6 * strength
    L2 = 0.5 + np.tanh((L2 - 0.5) * (1 + k)) / (2 * np.tanh(0.5 * (1 + k)))
    # clarity: unsharp at medium radius
    blur = cv2.GaussianBlur(L2, (0, 0), 6)
    L2 = np.clip(L2 + (L2 - blur) * 0.6 * strength, 0, 1)
    Lf = L.astype(np.float32) / 255.0
    w = alpha * strength
    Lout = Lf * (1 - w) + L2 * w
    lab[:, :, 0] = np.clip(Lout * 255, 0, 255).astype(np.uint8)
    # slightly reduce colour noise / cast on the product (white metals look cleaner)
    ab = lab[:, :, 1:].astype(np.float32) - 128
    lab[:, :, 1:] = np.clip(ab * (1 - 0.35 * w[:, :, None]) + 128, 0, 255).astype(np.uint8)
    return cv2.cvtColor(lab, cv2.COLOR_LAB2BGR).astype(np.float32)


def add_soft_shadow(f, alpha, strength=0.35):
    """Soft contact shadow under the product (catalogue style), only on the background."""
    h, w = alpha.shape
    ys, xs = np.where(alpha > 0.5)
    if not len(ys):
        return f
    y0, y1 = ys.min(), ys.max()
    oh = max(1, y1 - y0)
    # squash the silhouette vertically onto its base line -> an ellipse-like footprint
    sq = cv2.resize(alpha, (w, max(2, int(h * 0.12))), interpolation=cv2.INTER_AREA)
    canvas = np.zeros_like(alpha)
    top = int(y1 - sq.shape[0] * (y1 / h) + oh * 0.02)
    top = max(0, min(h - sq.shape[0], top))
    canvas[top:top + sq.shape[0], :] = sq
    sh = cv2.GaussianBlur(canvas, (0, 0), max(6, oh * 0.09))
    sh = sh / max(1e-6, sh.max()) * strength
    sh = sh * (1 - alpha)
    return f * (1 - sh[:, :, None])


def packshot(img, ph):
    """Neutralise colour cast and exposure using the background, optionally put product on pure white."""
    m = product_mask(img)
    f = img.astype(np.float32)
    bg = m < 0.05
    if bg.sum() > 1000:
        bgc = np.median(f[bg], axis=0)
        f = f * (bgc.mean() / np.maximum(bgc, 1))         # remove colour cast
        lum = float(f[bg].mean())
        target = 238.0
        f = f * min(2.2, max(0.6, target / max(lum, 1)))   # background -> near white
    f = np.clip(f, 0, 255)
    a2 = cv2.GaussianBlur(np.clip((m - 0.12) / 0.76, 0, 1), (0, 0), 0.8)
    studio = float(ph.get("studio", 0) or 0)
    if studio > 0:
        f = studio_look(f, a2, studio)
    if ph.get("background") == "white":
        a = a2[:, :, None]
        f = f * a + 255.0 * (1 - a)
        if ph.get("shadow", studio > 0):
            f = add_soft_shadow(f, a2, float(ph.get("shadow_strength", 0.22)))
    out = np.clip(f, 0, 255).astype(np.uint8)
    if ph.get("autocrop"):
        ys, xs = np.where(m > 0.5)
        if len(xs):
            x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            margin = float(ph.get("margin", 1.5))
            side = int(max(x1 - x0, y1 - y0) * margin)
            pad = side
            fill = (255, 255, 255) if ph.get("background") == "white" else None
            if fill:
                cp = cv2.copyMakeBorder(out, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=fill)
            else:
                cp = cv2.copyMakeBorder(out, pad, pad, pad, pad, cv2.BORDER_REFLECT)
            X, Y = int(cx - side / 2 + pad), int(cy - side / 2 + pad)
            out = cp[Y:Y + side, X:X + side]
    return out


def load_photo(path):
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        # HEIC and others: let ffmpeg decode
        tmp = path + ".decoded.png"
        run([FFMPEG, "-v", "error", "-y", "-i", path, "-frames:v", "1", tmp])
        img = cv2.imread(tmp, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError("cannot read image")
    return img


def process_photo(inp, outdir, p, progress):
    img = load_photo(inp)
    h, w = img.shape[:2]
    progress("start", 5, f"{w}x{h}", force=True)
    ph = p["photo"]
    out = img
    if p["denoise"]["enabled"]:
        s = float(p["denoise"]["strength"])
        out = cv2.fastNlMeansDenoisingColored(out, None, s, s, 7, 21)
        progress("denoise", 30, "odszumianie", force=True)
    if ph.get("auto_wb"):
        out = gray_world_wb(out)
    if ph.get("packshot") or ph.get("background") == "white" or ph.get("autocrop"):
        out = packshot(out, ph)
        ts = int(ph.get("target_side") or 0)
        if ts and max(out.shape[:2]) < ts:
            k = ts / max(out.shape[:2])
            out = cv2.resize(out, (int(out.shape[1] * k), int(out.shape[0] * k)), interpolation=cv2.INTER_LANCZOS4)
        progress("packshot", 40, "tło i kadr", force=True)
    out = apply_color_photo(out, p["color"])
    progress("color", 50, "kolor", force=True)
    if p["deblur"]["enabled"]:
        out = deblur_photo(out, float(p["deblur"]["strength"]))
        progress("deblur", 60, "odzyskiwanie ostrości", force=True)
    if p["sharpen"]["enabled"]:
        out = sharpen_photo(out, float(p["sharpen"]["amount"]))
        progress("sharpen", 70, "wyostrzenie", force=True)
    if ph.get("square"):
        hh, ww = out.shape[:2]
        side = max(hh, ww)
        canvas = np.full((side, side, 3), 255, np.uint8)
        y0, x0 = (side - hh) // 2, (side - ww) // 2
        canvas[y0:y0 + hh, x0:x0 + ww] = out
        out = canvas
    ms = int(ph.get("max_side") or 0)
    if ms and max(out.shape[:2]) > ms:
        s = ms / max(out.shape[:2])
        out = cv2.resize(out, (int(out.shape[1] * s), int(out.shape[0] * s)), interpolation=cv2.INTER_AREA)
    fmt = (ph.get("format") or "jpg").lower()
    fname = "photo.png" if fmt == "png" else "photo.jpg"
    params = [] if fmt == "png" else [cv2.IMWRITE_JPEG_QUALITY, 93]
    cv2.imwrite(os.path.join(outdir, fname), out, params)
    # comparison previews
    def prev(im, name):
        s = min(1.0, 1600 / max(im.shape[:2]))
        cv2.imwrite(os.path.join(outdir, name),
                    cv2.resize(im, (int(im.shape[1] * s), int(im.shape[0] * s)), interpolation=cv2.INTER_AREA),
                    [cv2.IMWRITE_JPEG_QUALITY, 88])
    prev(img, "preview_before.jpg")
    prev(out, "preview_after.jpg")
    progress("export", 97, "zapisano", force=True)
    return [{"key": "photo", "file": fname, "label": "Zdjęcie"}], {"w": w, "h": h}


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--params", default=None)
    a = ap.parse_args()
    os.makedirs(a.outdir, exist_ok=True)
    user = {}
    if a.params:
        with open(a.params) as f:
            user = json.load(f)
    p = merge(DEFAULTS, user)
    progress = Progress(a.outdir)
    ext = os.path.splitext(a.input)[1].lower()
    kind = user.get("type") or ("photo" if ext in PHOTO_EXT else "video")
    t0 = time.time()
    try:
        if kind == "photo":
            outputs, info = process_photo(a.input, a.outdir, p, progress)
        else:
            outputs, info = process_video(a.input, a.outdir, p, progress)
        manifest = {"ok": True, "type": kind, "outputs": outputs, "info": info,
                    "seconds": round(time.time() - t0, 1)}
    except Exception as e:  # noqa
        manifest = {"ok": False, "error": str(e), "seconds": round(time.time() - t0, 1)}
    with open(os.path.join(a.outdir, "manifest.json"), "w") as f:
        json.dump(manifest, f, ensure_ascii=False)
    progress("done" if manifest["ok"] else "error", 100, manifest.get("error", "gotowe"), force=True)
    sys.exit(0 if manifest["ok"] else 1)


if __name__ == "__main__":
    main()
