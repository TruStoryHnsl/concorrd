# Windows Test Machine — `corr@win11`

Empirical verification of the Windows native client requires a real
Windows host. This doc describes how to set up `corr@win11.local` as
the Concord test rig and how to run `scripts/verify_windows_bundle.sh`
against it.

> Why this matters — the Concord codebase has a "WRITTEN IN BLOOD"
> rule (`CLAUDE.md`): no feature is "verified" until somebody (or a
> tool acting as the user's eyes) has watched it install and launch.
> A green Linux build proves nothing about the Windows install
> experience. Don't ship Windows by inference.

---

## Host facts

| Field        | Value                                       |
|--------------|---------------------------------------------|
| Hostname     | `win11.local` (mDNS / Bonjour over IPv6)    |
| User         | `corr`                                      |
| OS           | Windows 11 (Pro or Home — either is fine)   |
| Reachability | LAN-only — IPv6 link-local + global         |
| Auth         | **SSH key only** (BatchMode=yes in script)  |

The script never uses passwords. A password prompt fails BatchMode,
which is intentional: it's how we guarantee a "verified" claim was
backed by a real, automated install on a real Windows host.

---

## One-time setup on `win11`

Run these in **PowerShell (Admin)** on win11:

```powershell
# 1. Install OpenSSH Server (Settings → Apps → Optional features works too)
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0

# 2. Start it on boot
Start-Service sshd
Set-Service -Name sshd -StartupType 'Automatic'

# 3. Open firewall (the OpenSSH installer usually does this; belt + braces)
New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server' `
    -Enabled True -Direction Inbound -Protocol TCP `
    -Action Allow -LocalPort 22

# 4. Pick PowerShell (not cmd.exe) as the default ssh shell — the
#    verify script uses powershell -NoProfile -Command "..." so this
#    isn't strictly required, but it makes interactive debugging sane.
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell `
    -Value 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
    -PropertyType String -Force
```

## Add your SSH key

From this Linux host (orrion):

```bash
# Easiest path — ssh-copy-id works against Windows OpenSSH:
ssh-copy-id corr@win11.local
```

If `ssh-copy-id` is unavailable, paste the key manually. **Two
locations matter on Windows OpenSSH:**

| User type        | authorized_keys location                            |
|------------------|-----------------------------------------------------|
| Standard user    | `C:\Users\corr\.ssh\authorized_keys`                |
| **Admin user**   | `C:\ProgramData\ssh\administrators_authorized_keys` |

If `corr` is a member of the local Administrators group (and it
usually is on a personal machine), the **second path is the one that
matters** — Windows OpenSSH ignores the per-user file for admins by
default. This trips up everyone on first setup. Fix the ACL too:

```powershell
icacls C:\ProgramData\ssh\administrators_authorized_keys `
    /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F'
```

## Verify reachability

From this Linux host:

```bash
bash scripts/verify_windows_bundle.sh --dry-run
```

Expected output on success:

```
[verify_win] Probing SSH to corr@win11.local with key-only auth (BatchMode)...
[verify_win] SSH OK — remote reports: Microsoft Windows 11 Pro
[verify_win] Dry run complete. corr@win11.local reachable with key auth.
```

If the script prints `BLOCKER: cannot reach corr@win11.local`, follow
the remediation steps it lists. The script never falls back to a
password prompt — that's the bug it exists to prevent.

---

## Running a full install verification

After `scripts/build_windows_wsl.sh` (or
`scripts/build_windows_native.ps1`) produces an MSI:

```bash
bash scripts/verify_windows_bundle.sh \
    src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/Concord_0.1.0_x64_en-US.msi
```

This will:

1. Probe SSH (hard-fail if key auth is missing).
2. SCP the MSI to `C:\Users\corr\AppData\Local\Temp\concord-verify\`.
3. Silent install (`msiexec /qn`) — failure dumps the last 40 lines of
   the install log.
4. Locate `Concord.exe` (Program Files for MSI, LOCALAPPDATA for NSIS
   currentUser installs).
5. Launch it, wait 8 seconds, screenshot the primary monitor with
   `System.Drawing` + `Screen.PrimaryScreen`.
6. Pull the screenshot back to `./artifacts/win11-launch-<utcts>.png`.
7. Kill `Concord.exe` and uninstall.

To skip teardown for manual poking, add `--no-uninstall`. To pin
artifacts elsewhere set `ARTIFACT_DIR=...`.

---

## What the screenshot proves

The screenshot is the user-oriented assertion (per CLAUDE.md
testing rules — "what does the user *see*"). You're looking for one
of two outcomes:

| What you see                              | What it means                       |
|-------------------------------------------|-------------------------------------|
| `ServerPickerScreen` (logo + Join/Host)   | First-launch flow works             |
| Concord chat UI                           | Shouldn't happen on a fresh install — bundle preserved state from a previous run, or first-launch is broken |
| Blank white window                        | Webview didn't render — likely a CSP / asset path bug |
| No window at all (process exits ~3s)      | Tauri shell failed to spin up its window — check Event Viewer |

If the screenshot is anything other than `ServerPickerScreen`, file
an INS-NNN entry; do NOT mark the build as verified.

---

## Known gaps (as of branch creation)

- **SSH key auth not yet provisioned on win11.** Probing
  `corr@win11.local` from orrion currently fails at
  `Host key verification failed` (resolved by the script via
  `StrictHostKeyChecking=accept-new` on first run) and then
  `Permission denied` because no key has been pushed. The user must
  complete the "Add your SSH key" section above before any developer
  agent can run real Windows verification. Until then,
  `--dry-run` will surface the blocker as exit code 2.

- **No code-signing cert.** The MSI/NSIS installers will trigger
  Windows SmartScreen ("Windows protected your PC") on a fresh
  download. The verify script handles this fine because it copies
  bundles via SCP into a trusted local path; SmartScreen only fires
  on Mark-of-the-Web tagged downloads. Real users downloading from
  GitHub Releases will see the warning until we ship a signed build.

- **No Concord-specific cleanup verification.** Teardown calls the
  uninstaller but does NOT verify that `%APPDATA%\com.concord.chat`
  is removed. Tauri-plugin-store data persists by design; if you
  want a true "fresh install" run between verifications, add a
  manual `Remove-Item -Recurse -Force "$env:APPDATA\com.concord.chat"`
  before re-running the script.
