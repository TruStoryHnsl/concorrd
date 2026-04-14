import { describe, expect, it, vi } from "vitest";

const { createClientMock } = vi.hoisted(() => ({
  createClientMock: vi.fn((opts: Record<string, unknown>) => ({
    ...opts,
    supportsVoip: () => true,
  })),
}));

vi.mock("matrix-js-sdk", () => ({
  createClient: createClientMock,
  IndexedDBStore: vi.fn().mockImplementation(() => ({})),
}));

import { createMatrixClient } from "../matrix";

describe("createMatrixClient", () => {
  it("disables matrix-js-sdk voip polling because Concord uses LiveKit", () => {
    const client = createMatrixClient(
      "token",
      "@alice:concorrd.com",
      "DEVICE1",
      "https://concorrd.com",
    ) as { supportsVoip: () => boolean };

    expect(createClientMock).toHaveBeenCalled();
    expect(client.supportsVoip()).toBe(false);
  });
});
