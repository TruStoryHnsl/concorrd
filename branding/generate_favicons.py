"""
Generate favicon assets from the Concord master logo halves.

Run from the concord project root:
    python3 branding/generate_favicons.py

Outputs to client/public/:
    favicon.png         — 32x32 (browser tab default)
    favicon-16.png      — 16x16
    favicon-32.png      — 32x32
    favicon-48.png      — 48x48
    apple-touch-icon.png — 192x192
    favicon.ico         — multi-size 16/32/48 bundle
    logo.png            — full-size composited reference (default tint)

The brand mark ships as TWO grayscale-alpha mask PNGs:

    branding/logo-upper.png   — upper-right ring + node
    branding/logo-lower.png   — lower-left  ring + node

Both halves are 1024×1024 with binary alpha and pure-white luminance.
The application UI tints them at runtime via CSS `mask-image` +
`background-color` from theme variables. For OS-level icons (favicon,
apple-touch-icon, manifest icons) we composite the two halves with a
fixed default tint so the icon is always recognisable in places where
the OS — not Concord — chooses the rendering colour.

The default tint is the project's "bronze-teal" theme:
    primary    #a5823f  (warm bronze)  → upper half
    secondary  #408c96  (cool teal)    → lower half

Edit the masks (or add a new pair) to change the brand glyph itself;
edit the constants below to change the OS-icon tint.
"""
from __future__ import annotations
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
UPPER_MASK = ROOT / "branding" / "logo-upper.png"
LOWER_MASK = ROOT / "branding" / "logo-lower.png"
PUBLIC = ROOT / "client" / "public"

# Default-theme tint applied at OS-icon generation time.
# Tinting is per-half: upper = primary, lower = secondary.
TINT_PRIMARY = (0xA5, 0x82, 0x3F, 0xFF)    # bronze
TINT_SECONDARY = (0x40, 0x8C, 0x96, 0xFF)  # teal


def tint_half(mask_path: Path, color: tuple[int, int, int, int]) -> Image.Image:
    """Convert a grayscale-alpha mask to a solid-coloured RGBA layer.

    The mask's alpha channel becomes the alpha channel of the output;
    every visible pixel is painted with the supplied colour. Luminance
    of the source mask is discarded — the file is treated purely as a
    silhouette.
    """
    half = Image.open(mask_path)
    if half.mode != "LA":
        half = half.convert("LA")
    alpha = half.split()[1]
    layer = Image.new("RGBA", half.size, color)
    layer.putalpha(alpha)
    return layer


def composite_master() -> Image.Image:
    """Stack the two tinted halves into the canonical full-colour mark.

    Lower painted first, upper on top — matches the React component's
    z-order so the chain weave reads correctly at every size.
    """
    upper = tint_half(UPPER_MASK, TINT_PRIMARY)
    lower = tint_half(LOWER_MASK, TINT_SECONDARY)
    canvas = Image.new("RGBA", upper.size, (0, 0, 0, 0))
    canvas = Image.alpha_composite(canvas, lower)
    canvas = Image.alpha_composite(canvas, upper)
    return canvas


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

    if not UPPER_MASK.exists() or not LOWER_MASK.exists():
        raise SystemExit(
            f"missing logo masks; expected {UPPER_MASK} and {LOWER_MASK}"
        )

    master = composite_master()
    print(f"composited master: {master.size}")

    square = tight_crop_square(master)
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

    # Full-size composited reference. Not consumed by the runtime UI
    # (the React mark composites halves on the fly with theme colours),
    # but kept for documentation, README screenshots, and any tooling
    # that wants a one-file flattened render.
    master.save(PUBLIC / "logo.png", "PNG", optimize=True)
    print("  public/logo.png (default-tinted reference)")


if __name__ == "__main__":
    main()
