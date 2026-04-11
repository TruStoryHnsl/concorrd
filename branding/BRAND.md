# Concord — Brand

**Tagline:** Mesh Comms System

![Concord logo](logo.png)

The image at `branding/logo.png` is the **definitive master logo** for
Concord — a 1024×1024 RGBA image with full transparency. Two
interlocking circles form a linked symbol representing paired peers
and joined connections. The transparent layer is what iOS composites
over its dark / light / tinted homescreen backgrounds, and what the
web + native clients render through the `<ConcordLogo />` SVG
component, tinted to the active theme.

## Files

| Path                                           | Purpose                                    |
|------------------------------------------------|--------------------------------------------|
| `branding/logo.png`                            | **Active master.** 1024×1024 RGBA. Edit this to re-colour / re-theme. |
| `branding/logo-interlocking-circles.png`       | Immutable copy of the master source, for reference. |
| `branding/backup/icons-mesh-original/`         | Previous three-node mesh-glyph logo, archived during the 2026-04-10 migration from the mesh mark to the interlocking-circles mark. |
| `branding/backup/src-tauri-icons-original/`    | Pre-migration Tauri icon set.              |
| `branding/generate_favicons.py`                | Regenerates web favicons + assets from the master. |
| `branding/generate_tauri_icons.py`             | Regenerates desktop + mobile Tauri icons from the master. |
| `client/src/components/brand/ConcordLogo.tsx`  | Inline-SVG React component rendering the mark with CSS-variable fills. Use this in the UI instead of loading the PNG. |

## Rendering strategy

The mark is drawn **twice**:

1. **Raster PNGs** (`branding/logo.png` + generated variants) are used
   by the OS — window icons, app icons, Windows Store tiles, iOS
   AppIconset, macOS `.icns`, favicon / apple-touch-icon.
2. **Inline SVG** (`<ConcordLogo />`) is used in the app UI — login
   welcome, server picker header, future theme preview swatches.
   The SVG's two fills are driven by CSS custom properties
   (`--color-logo-primary`, `--color-logo-secondary`, see
   `client/src/index.css`), which default to the active theme's
   primary + secondary. Change the theme → the logo retints
   automatically. No PNG regeneration needed for in-app colour
   changes; only OS-level icons need the Python scripts.

## Regenerating after a master edit

```bash
python3 branding/generate_favicons.py      # web favicons
python3 branding/generate_tauri_icons.py   # desktop + iOS icons
```

iOS AppIcon assets are composited onto a solid white background at
generation time because Apple forbids transparent iOS app icons.
The master stays transparent so future re-themes can be done once
at the source and propagated everywhere via the two scripts.

## Glyph

Two interlocking circles — a "link" or "peering" symbol. The two
nodes join without either being above the other: flat, peer-to-peer,
no hierarchy. Each circle has a small solid inner dot offset toward
the opposite side, suggesting the nodes making contact across the
link.

## Color palette (placeholders pending recolour pass)

| Role       | Hex        | Name            | Use                                     |
|------------|------------|-----------------|-----------------------------------------|
| Primary    | `#08C838`  | Mesh Emerald    | Brand green, online state, send button  |
| Highlight  | `#08B838`  | Mesh Leaf       | Hover, focus, typing indicator          |
| Accent     | `#088838`  | Mesh Pine       | Secondary buttons, badges               |
| Deep       | `#087838`  | Mesh Root       | Outlines, borders, muted text           |
| Shadow     | `#085828`  | Mesh Soil       | Dark-mode background, deep shadow       |

## Usage

- Emerald is the **online / connected** color across the UI; never reuse it
  for error or warning states.
- Voice-active indicators pulse between Mesh Emerald and Mesh Leaf.
- Do not mix with the softer orrapus mints in the same composition —
  emerald and mint read as two different greens and make the palette
  feel accidental.
