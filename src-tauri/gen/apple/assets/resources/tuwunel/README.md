# Bundled tuwunel binary (embedded servitude)

This directory is where `scripts/build_linux_native.sh` stages the upstream
tuwunel Matrix homeserver binary before invoking `cargo tauri build`. The
Tauri bundler reads `bundle.resources` in `tauri.conf.json` and copies the
contents of this directory into the final AppImage/deb next to the main
Concord executable.

At runtime, `src-tauri/src/servitude/transport/matrix_federation.rs`
discovers the binary via `resolve_binary()`, which walks the same relative
paths the build script writes to.

## Contents (post-build)

```
tuwunel      # upstream tuwunel binary, extracted from the pinned .deb
```

## How the binary gets here

Run `scripts/build_linux_native.sh`. The script:

1. Downloads the pinned tuwunel release `.deb` from GitHub releases
   (`matrix-construct/tuwunel`, version pinned via `TUWUNEL_VERSION` in
   the build script) into `.build-cache/tuwunel/` at the repo root.
2. Extracts the binary from the `.deb` via `dpkg-deb -x` (or `ar + tar`
   on non-Debian hosts).
3. Copies the binary to `src-tauri/resources/tuwunel/tuwunel` and marks
   it executable.
4. Invokes `cargo tauri build`, which bundles the binary alongside the
   main Concord executable in the AppImage/deb output.

## Not committed to git

The tuwunel binary itself is gitignored — it is ~60MB and is fetched
fresh from the pinned upstream release on every build host. Only this
README and any hand-maintained config templates live under version
control.

## Dev workflow without bundling

For local development you can bypass the bundle entirely by setting
`TUWUNEL_BIN=/absolute/path/to/tuwunel` in the environment before
running Concord. `resolve_binary()` checks the env var first, so a
hand-built or distro-installed tuwunel will be used without rebuilding
the Concord bundle.
