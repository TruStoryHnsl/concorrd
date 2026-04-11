"""
Generate favicon assets from the Concord master logo.

Run from the concord project root:
    python3 branding/generate_favicons.py

Outputs to client/public/:
    favicon.png         — 32x32 (browser tab default)
    favicon-16.png      — 16x16
    favicon-32.png      — 32x32
    favicon-48.png      — 48x48
    apple-touch-icon.png — 192x192
    favicon.ico         — multi-size 16/32/48 bundle
    logo.png            — full-size source (for LoginForm <img> fallback)

The source at `branding/logo.png` is the clean, transparent master
logo — already properly alpha-channelled and tight-cropped. This
script just resizes it to each target size with an unsharp-mask pass
on the very small variants so the glyph stays crisp at 16x16.

Prior mesh-era versions of this script did a green-channel extraction
to clean up a noisy mint-green source; that step is no longer needed
and would mangle the current multi-colour glyph, so it was removed.
The legacy cleanup helper lives in git history (pre-2026-04-10).
"""
from __future__ import annotations
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "branding" / "logo.png"
PUBLIC = ROOT / "client" / "public"
ASSETS = ROOT / "client" / "src" / "assets"


def tight_crop_square(img: Image.Image) -> Image.Image:
    alpha = np.array(img)[..., 3]
    mask = alpha > 20
    if not mask.any():
        return img
    ys, xs = np.where(mask)
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    margin = int(max(x1 - x0, y1 - y0) * 0.05)
    x0 = max(0, x0 - margin)
    y0 = max(0, y0 - margin)
    x1 = min(img.width, x1 + margin)
    y1 = min(img.height, y1 + margin)

    cropped = img.crop((x0, y0, x1, y1))
    cw, ch = cropped.size
    side = max(cw, ch)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(cropped, ((side - cw) // 2, (side - ch) // 2), cropped)
    return square


def scale_to(square: Image.Image, sz: int) -> Image.Image:
    im = square.resize((sz, sz), Image.LANCZOS)
    if sz <= 16:
        im = im.filter(ImageFilter.UnsharpMask(radius=0.5, percent=220, threshold=1))
    elif sz <= 32:
        im = im.filter(ImageFilter.UnsharpMask(radius=0.6, percent=170, threshold=2))
    elif sz <= 48:
        im = im.filter(ImageFilter.UnsharpMask(radius=0.7, percent=150, threshold=2))
    else:
        im = im.filter(ImageFilter.UnsharpMask(radius=0.8, percent=130, threshold=2))
    return im


def main() -> None:
    PUBLIC.mkdir(parents=True, exist_ok=True)
    ASSETS.mkdir(parents=True, exist_ok=True)

    src = Image.open(SRC).convert("RGBA")
    print(f"source: {SRC} {src.size}")

    square = tight_crop_square(src)
    print(f"squared transparent: {square.size}")

    sizes = {
        16: "favicon-16.png",
        32: "favicon-32.png",
        48: "favicon-48.png",
        192: "apple-touch-icon.png",
    }
    for sz, name in sizes.items():
        scale_to(square, sz).save(PUBLIC / name, "PNG", optimize=True)
        print(f"  public/{name}")

    (PUBLIC / "favicon.png").write_bytes((PUBLIC / "favicon-32.png").read_bytes())
    scale_to(square, 48).save(
        PUBLIC / "favicon.ico",
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48)],
    )
    print("  public/favicon.ico (16/32/48)")

    # Full-size logo for the LoginForm welcome overlay <img>
    src.save(PUBLIC / "logo.png", "PNG", optimize=True)
    src.save(ASSETS / "concord-logo.png", "PNG", optimize=True)
    print("  public/logo.png, src/assets/concord-logo.png")


if __name__ == "__main__":
    main()
