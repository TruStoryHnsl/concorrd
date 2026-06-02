/**
 * Browser discovery posture — 2026-05-29 architecture redirect.
 *
 * Locks the invariant that the browser libp2p swarm has zero
 * automatic discovery once Kad-DHT and the project-run VPS bootstrap
 * fleet were dropped. Every peer the browser talks to has to come
 * from the Phase-5 peer-card flow (QR / `concord://` deeplink /
 * Matrix-room exchange) and be dialed explicitly.
 *
 * Browsers don't have a portable mDNS equivalent (no multicast UDP
 * from a tab), so this is a deliberate posture — not a regression.
 */
import {
  describe,
  expect,
  it,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  __setCreateLibp2pForTests,
  startBrowserNode,
  stopBrowserNode,
} from "../node";
import { resetBrowserIdentity } from "../identity";

function makeStubNode() {
  return {
    dial: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

describe("browser libp2p discovery posture", () => {
  let restoreCreate: (() => void) | null = null;

  beforeEach(() => {
    resetBrowserIdentity();
  });

  afterEach(async () => {
    if (restoreCreate) {
      restoreCreate();
      restoreCreate = null;
    }
    await stopBrowserNode();
  });

  it("browser node starts with no bootstrap and no automatic peers", async () => {
    const stub = makeStubNode();
    const createFn = vi.fn().mockResolvedValue(stub);
    restoreCreate = __setCreateLibp2pForTests(createFn as never);

    // No bootstrap parameter on the public API — the post-2026-05-29
    // signature is `startBrowserNode(): Promise<Libp2p>`. The swarm
    // must come up without dialing anything.
    const handle = await startBrowserNode();

    expect(handle).toBe(stub);
    // The defining assertion of the redirect: NO automatic dials
    // happen during start. Pairing is always intentional — every dial
    // is the result of a user action (Phase-5 peer card scan / click /
    // Matrix-room exchange).
    expect(stub.dial).not.toHaveBeenCalled();

    // And the public API doesn't accept a bootstrap list anymore.
    // TypeScript would catch this at compile time; we double-check at
    // runtime so the regression is loud if the signature ever drifts.
    // `length` reflects the number of declared parameters in the
    // function signature.
    expect(startBrowserNode.length).toBe(0);
  });
});
