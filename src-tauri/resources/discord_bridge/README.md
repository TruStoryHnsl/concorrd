# Bundled mautrix-discord binary (sandboxed Discord bridge)

This directory is where `scripts/build_linux_native.sh` stages the upstream
`mautrix-discord` binary before invoking `cargo tauri build`. The Tauri
bundler reads `bundle.resources` in `tauri.conf.json` and copies the
contents of this directory into the final AppImage/deb next to the main
Concord executable.

At runtime, `src-tauri/src/servitude/transport/discord_bridge.rs` discovers
the binary via `resolve_binary()`, which walks the same relative paths the
build script writes to. The transport then wraps execution in a
`bubblewrap` (`bwrap`) sandbox per INS-024 Wave 3 — see the module
documentation for the exact sandbox argv.

## Contents (post-build)

```
mautrix-discord   # upstream mautrix-discord binary, pinned version
```

## How the binary gets here

Run `scripts/build_linux_native.sh`. The script:

1. Downloads the pinned `mautrix-discord` release binary from GitHub
   releases (`mautrix/discord`, version pinned via `MAUTRIX_DISCORD_VERSION`
   in the build script) into `.build-cache/mautrix-discord/` at the repo
   root.
2. Copies the binary to `src-tauri/resources/discord_bridge/mautrix-discord`
   and marks it executable.
3. Invokes `cargo tauri build`, which bundles the binary alongside the
   main Concord executable in the AppImage/deb output.

## Not committed to git

The `mautrix-discord` binary itself is gitignored — it is ~20MB and is
fetched fresh from the pinned upstream release on every build host.
Only this README and any hand-maintained config templates live under
version control.

## bubblewrap requirement

This transport refuses to start without `bwrap` (bubblewrap) on the host
PATH. Commercial scope: there is no silent unsandboxed fallback. The
packaged `.deb` declares `bubblewrap` as a runtime `depends`; for
AppImage installs, operators must install it manually.

## Dev workflow without bundling

For local development you can bypass the bundle entirely by setting
`MAUTRIX_DISCORD_BIN=/absolute/path/to/mautrix-discord` in the environment
before running Concord. `resolve_binary()` checks the env var first, so a
hand-built or distro-installed `mautrix-discord` will be used without
rebuilding the Concord bundle. `bwrap` is still required — there is no
override for the sandbox.

## License notice

`mautrix-discord` is licensed under **AGPLv3**. Running it as a sandboxed
child process on user infrastructure does not, on its own, trigger
copyleft — operators self-hosting Concord are running the upstream
binary unchanged. See `docs/bridges/discord.md` §3 for the full license
audit.
