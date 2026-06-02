# Google TV / Android TV banner asset

Android TV's leanback launcher refuses to surface apps that do not
declare an `android:banner` attribute. The asset declared in
`AndroidManifest.xml.template` is `@drawable/tv_banner`, which resolves
to `res/drawable-xhdpi/tv_banner.png` in the generated Android project.

## Spec

- **Filename**: `tv_banner.png`
- **Dimensions**: **320 x 180 px** (16:9). Non-negotiable — this is
  the Google TV leanback fixed size.
- **Format**: PNG (24-bit, no alpha). Leanback does not animate the
  banner and the grid background is dark, so alpha is unnecessary.
- **Safe area**: keep the logo + "Concord" wordmark inside the inner
  288 x 162 px rectangle (8 px padding) to survive the TV grid's
  rounded-corner mask and scale animation.
- **Colour**: the existing Concord brand palette — primary violet
  `#7C4DFF` on the dark surface `#121214`. Mirror the shape language
  of `branding/icon-light.svg`.

## Where to drop it once generated

After `cargo tauri android init` runs on the Linux build host, the Android resource
tree at `src-tauri/gen/android/app/src/main/res/` will contain empty
`drawable-*` directories. Place the banner at:

```
src-tauri/gen/android/app/src/main/res/drawable-xhdpi/tv_banner.png
```

No other density buckets are needed — Google TV only pulls the xhdpi
banner. Commit the PNG alongside the rest of the init output.

## Blocker

This asset is a TODO for the design pass — no source file exists yet.
The Android TV build will install correctly without a banner, but the
launcher will hide the app. For v0.1 we can ship a placeholder banner
(the existing Concord logo centred on the surface colour) and replace
it with a designed version before the Google TV store submission.

Tracked under sprint task T3 (Android shell readiness).
