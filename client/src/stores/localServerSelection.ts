/**
 * Zustand surface for which local server tile is active inside the
 * local source.
 *
 * Per the 2026-06-01 CONSOLIDATED ARCHITECTURE filing in
 * `instructions_inbox.md`, the local source contains TWO intrinsic
 * default servers — `"porch"` (ephemeral, in-memory, F1a parallel PR)
 * and `"home"` (persistent SQLite, this PR). The renderer needs a
 * tiny piece of state to remember which tile the user last clicked
 * so `LocalChannelSidebar` and `LocalChatPane` know whose data to
 * read.
 *
 * Default: `"home"`. The home server is the user's actual data, so
 * landing on it directly is the right "default surface" for a fresh
 * launch. The porch tile becomes interesting only when the user is
 * about to receive a visitor.
 *
 * The porch's channels are exposed by the F1a in-memory store
 * (parallel PR, not yet landed). Until F1a lands, the porch tile is
 * inert — clicking it switches the selection but the channel column
 * shows the ephemeral-porch-not-yet-implemented placeholder. The
 * `LocalServerSidebar` still renders the tile so the visual contract
 * for the two-tile sidebar lands now.
 */

import { create } from "zustand";

/** Discriminator for which intrinsic local server is active. Future
 *  user-created persistent servers will add a third variant
 *  (`"custom"` carrying an id) — out of scope for F1b. */
export type ActiveLocalServer = "porch" | "home";

interface LocalServerSelectionState {
  active: ActiveLocalServer;
  setActive: (next: ActiveLocalServer) => void;
}

export const useLocalServerSelectionStore = create<LocalServerSelectionState>(
  (set) => ({
    active: "home",
    setActive: (next: ActiveLocalServer) => set({ active: next }),
  }),
);
