"""
Regenerate Tauri desktop + mobile icon artefacts from the master logo.

Run from the concord project root:
    python3 branding/generate_tauri_icons.py

Reads:
    branding/logo.png                                   — RGBA master (square)

Writes (Tauri desktop, `bundle.icon` array + Linux/Windows artefacts):
    src-tauri/icons/32x32.png
    src-tauri/icons/128x128.png
    src-tauri/icons/128x128@2x.png
    src-tauri/icons/icon.png                            — 512x512 fallback
    src-tauri/icons/icon.ico                            — multi-size Windows
    src-tauri/icons/icon.icns                           — macOS (best-effort, skipped if tooling absent)
    src-tauri/icons/Square*Logo.png                     — Windows Store/UWP tiles
    src-tauri/icons/StoreLogo.png

Writes (iOS AppIconset — must be RGB, no alpha, per Apple):
    src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/*.png

For iOS, the logo is composited onto a solid white background — Apple
rejects AppIcon assets that contain transparency. The transparent
master stays in `branding/logo.png` so operators can recolour or
re-theme it without losing the layer. Re-run this script after any
master edit to propagate the change through every platform target.
"""
from __future__ import annotations
import subprocess
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "branding" / "logo.png"
TAURI_ICONS = ROOT / "src-tauri" / "icons"
APPLE_ICONSET = (
    ROOT
    / "src-tauri"
    / "gen"
    / "apple"
    / "Assets.xcassets"
    / "AppIcon.appiconset"
)

# Background colour used when flattening to RGB for iOS. Apple's
# HIG suggests white for logos that are primarily non-white.
IOS_BG = (255, 255, 255, 255)

DESKTOP_PNG_SIZES = {
    "32x32.png": 32,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
}

# Windows Store tile sizes. Names match the existing Square*Logo.png
# layout on disk.
WINDOWS_SQUARE_SIZES = {
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
    "StoreLogo.png": 50,
}

# AppIcon-*.png filename → pixel size for iOS AppIconset.
# Derived from the Contents.json in the existing iconset.
IOS_SIZES: dict[str, int] = {
    "AppIcon-20x20@1x.png": 20,
    "AppIcon-20x20@2x.png": 40,
    "AppIcon-20x20@2x-1.png": 40,
    "AppIcon-20x20@3x.png": 60,
    "AppIcon-29x29@1x.png": 29,
    "AppIcon-29x29@2x.png": 58,
    "AppIcon-29x29@2x-1.png": 58,
    "AppIcon-29x29@3x.png": 87,
    "AppIcon-40x40@1x.png": 40,
    "AppIcon-40x40@2x.png": 80,
    "AppIcon-40x40@2x-1.png": 80,
    "AppIcon-40x40@3x.png": 120,
    "AppIcon-60x60@2x.png": 120,
    "AppIcon-60x60@3x.png": 180,
    "AppIcon-76x76@1x.png": 76,
    "AppIcon-76x76@2x.png": 152,
    "AppIcon-83.5x83.5@2x.png": 167,
    "AppIcon-512@2x.png": 1024,
}


def resize(src: Image.Image, size: int) -> Image.Image:
    """High-quality LANCZOS resize to a square."""
    return src.resize((size, size), Image.LANCZOS)


def flatten_on_white(img: Image.Image) -> Image.Image:
    """Composite a transparent RGBA image onto an opaque white canvas.

    Apple rejects iOS AppIcon assets with alpha channels. We flatten
    here (not at source) so the editable master stays transparent.
    """
    bg = Image.new("RGBA", img.size, IOS_BG)
    bg.alpha_composite(img)
    return bg.convert("RGB")


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"missing master logo at {SRC}")
    master = Image.open(SRC).convert("RGBA")
    if master.size[0] != master.size[1]:
        raise SystemExit(
            f"master logo must be square, got {master.size}. "
            f"Re-export with a square canvas and retry."
        )
    print(f"master: {SRC} {master.size}")

    TAURI_ICONS.mkdir(parents=True, exist_ok=True)

    # Desktop PNGs (transparent RGBA).
    for name, size in DESKTOP_PNG_SIZES.items():
        resize(master, size).save(TAURI_ICONS / name, "PNG", optimize=True)
        print(f"  desktop: {name} ({size}x{size})")

    # Windows Store tiles.
    for name, size in WINDOWS_SQUARE_SIZES.items():
        resize(master, size).save(TAURI_ICONS / name, "PNG", optimize=True)
        print(f"  windows: {name} ({size}x{size})")

    # Windows .ico (multi-size bundle).
    ico_sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    resize(master, 256).save(
        TAURI_ICONS / "icon.ico", format="ICO", sizes=ico_sizes
    )
    print(f"  windows: icon.ico ({', '.join(f'{w}x{h}' for w, h in ico_sizes)})")

    # macOS .icns — best-effort via `png2icns`. Skip cleanly if the
    # tool is missing (Linux CI usually lacks it; macOS builds
    # regenerate the .icns themselves via iconutil).
    _try_build_icns(master, TAURI_ICONS / "icon.icns")

    # iOS AppIconset (flattened, RGB).
    if APPLE_ICONSET.exists():
        for name, size in IOS_SIZES.items():
            flat = flatten_on_white(resize(master, size))
            flat.save(APPLE_ICONSET / name, "PNG", optimize=True)
            print(f"  ios: {name} ({size}x{size})")
    else:
        print(f"  ios: SKIP (no iconset at {APPLE_ICONSET})")


def _try_build_icns(master: Image.Image, out: Path) -> None:
    """Best-effort .icns build; skip silently if tools missing."""
    if _which("png2icns"):
        sizes = [16, 32, 128, 256, 512, 1024]
        tmp_dir = out.parent / "_icns_tmp"
        tmp_dir.mkdir(exist_ok=True)
        try:
            files = []
            for sz in sizes:
                p = tmp_dir / f"icon_{sz}x{sz}.png"
                resize(master, sz).save(p, "PNG")
                files.append(str(p))
            subprocess.run(
                ["png2icns", str(out), *files],
                check=True,
                capture_output=True,
            )
            print(f"  macos: icon.icns (via png2icns)")
        except subprocess.CalledProcessError as e:
            print(f"  macos: icon.icns SKIPPED (png2icns failed: {e})")
        finally:
            for p in tmp_dir.glob("*"):
                p.unlink()
            tmp_dir.rmdir()
        return
    print(f"  macos: icon.icns SKIPPED (png2icns not installed)")


def _which(cmd: str) -> bool:
    from shutil import which
    return which(cmd) is not None


if __name__ == "__main__":
    main()
