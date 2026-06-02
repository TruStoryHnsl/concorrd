/**
 * F1c — Home-server data export API wrapper.
 *
 * Two Tauri commands:
 *   - home_export_package — atomic SQLite backup → tarball → Argon2id +
 *     ChaCha20-Poly1305 → file under `<app_data>/exports/`.
 *   - home_send_export    — stream the encrypted package to a paired
 *     peer over `/concord/home-export/1.0.0`.
 *
 * Both commands are NATIVE-ONLY (the export pipeline depends on the
 * Tauri-side SQLite + filesystem APIs). In a web build these wrappers
 * throw — the Settings → Hosting → Data sub-tab hides the button when
 * `isTauri()` is false.
 *
 * Wire shapes mirror the Rust types in:
 *   - `src-tauri/src/porch/home_export.rs::ExportManifest`
 *   - `src-tauri/src/porch/home_export_protocol.rs::DeliveryReceipt`
 *
 * Field names follow the Rust `serde(rename_all = "camelCase")`
 * attribute on those structs — the Tauri layer transcribes
 * snake_case Rust → camelCase JSON automatically.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./servitude";

/**
 * Return shape of `home_export_package`. The `packagePath` is an
 * absolute path on the host filesystem — surface it to the operator
 * so they can find the file later if they pick "Save package locally".
 */
export interface ExportManifest {
  packagePath: string;
  sha256: string;
  targetPeerId: string;
  sizeBytes: number;
}

/**
 * Return shape of `home_send_export`. Exactly one of `deliveredAt`
 * and `rejectedReason` is populated:
 *
 *   - `deliveredAt` is a Unix-milliseconds receiver-side timestamp when
 *     the package was accepted (sender is in the receiver's paired-peer
 *     list, payload was fully read).
 *   - `rejectedReason` is one of:
 *     - `"sender_not_paired"`      — receiver doesn't recognize us.
 *     - `"package_too_large"`      — > 512 MiB.
 *     - `"frame_too_large"`        — single chunk exceeded 1 MiB.
 *     - `"framing_error"`          — protocol violation (truncation, etc.).
 *
 * `packageSha256` is always set: on accept it's the receiver-reported
 * hash (must match the sender's local pre-flight hash); on reject it's
 * a best-effort sender-side hash of the bytes we tried to send.
 */
export interface DeliveryReceipt {
  packageSha256: string;
  bytesSent: number;
  deliveredAt: number | null;
  rejectedReason: string | null;
}

/**
 * Build an encrypted export package on disk.
 *
 * `passphrase` is the user-supplied secret; it is NEVER persisted — it
 * only exists in memory for the duration of the call. The on-disk
 * package can only be decrypted by re-supplying the same passphrase
 * (Argon2id KDF, see the Rust module docs for parameters).
 *
 * `targetPeerId` is the base58 libp2p PeerId of the trusted outside
 * instance the user picked from the paired-peers dropdown. It's baked
 * into `meta.json` inside the encrypted bundle for downstream audit.
 *
 * Native-only — throws in a browser build.
 */
export async function homeExportPackage(
  passphrase: string,
  targetPeerId: string,
): Promise<ExportManifest> {
  if (!isTauri()) {
    throw new Error(
      "homeExportPackage: native-only — the export pipeline requires the Tauri SQLite + filesystem layer.",
    );
  }
  return await invoke<ExportManifest>("home_export_package", {
    passphrase,
    targetPeerId,
  });
}

/**
 * Stream an encrypted package to a paired peer. Returns the receipt
 * describing whether the receiver accepted or rejected the delivery.
 *
 * Native-only — throws in a browser build.
 */
export async function homeSendExport(
  packagePath: string,
  targetPeerId: string,
): Promise<DeliveryReceipt> {
  if (!isTauri()) {
    throw new Error(
      "homeSendExport: native-only — the delivery path requires the embedded libp2p stream control.",
    );
  }
  return await invoke<DeliveryReceipt>("home_send_export", {
    packagePath,
    targetPeerId,
  });
}

/**
 * Copy a previously-built export package to a user-chosen path on the
 * host filesystem. The caller is expected to have driven the native
 * `save` dialog via `@tauri-apps/plugin-dialog` to pick `dstPath`.
 *
 * Native-only — throws in a browser build.
 */
export async function homeExportCopyTo(
  srcPath: string,
  dstPath: string,
): Promise<void> {
  if (!isTauri()) {
    throw new Error(
      "homeExportCopyTo: native-only — file copies require the Tauri filesystem layer.",
    );
  }
  await invoke<void>("home_export_copy_to", { srcPath, dstPath });
}
