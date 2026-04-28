import { beforeEach, describe, expect, it } from "vitest";
import {
  getSourceMatrixDomains,
  sourceMatchesMatrixDomain,
  useSourcesStore,
} from "../sources";

describe("sources store", () => {
  beforeEach(() => {
    useSourcesStore.setState({
      boundUserId: "@alice:example.concordchat.net",
      sources: [
        {
          id: "src_matrix",
          host: "chat.mozilla.org",
          instanceName: "Mozilla",
          inviteToken: "",
          apiBase: "https://chat.mozilla.org/api",
          homeserverUrl: "https://mozilla.modular.im",
          serverName: "mozilla.org",
          delegatedFrom: "chat.mozilla.org",
          status: "connected",
          enabled: true,
          addedAt: new Date().toISOString(),
          platform: "matrix",
          ownerUserId: "@alice:example.concordchat.net",
        },
        {
          id: "src_concord",
          host: "example.concordchat.net",
          instanceName: "Concorrd",
          inviteToken: "",
          apiBase: "https://example.concordchat.net/api",
          homeserverUrl: "https://example.concordchat.net",
          status: "connected",
          enabled: true,
          addedAt: new Date().toISOString(),
          platform: "concord",
          ownerUserId: null,
        },
      ],
    });
  });

  it("reorders source tiles in persisted store order", () => {
    useSourcesStore.getState().reorderSources("src_concord", "src_matrix");
    expect(useSourcesStore.getState().sources.map((source) => source.id)).toEqual([
      "src_concord",
      "src_matrix",
    ]);
  });

  it("can replace the full source order explicitly", () => {
    useSourcesStore.getState().setSourceOrder(["src_concord", "src_matrix"]);
    expect(useSourcesStore.getState().sources.map((source) => source.id)).toEqual([
      "src_concord",
      "src_matrix",
    ]);
  });

  it("matches delegated Matrix domains for discovery-driven sources", () => {
    const source = useSourcesStore.getState().sources[0];
    expect(getSourceMatrixDomains(source)).toEqual([
      "chat.mozilla.org",
      "mozilla.org",
      "mozilla.modular.im",
    ]);
    expect(sourceMatchesMatrixDomain(source, "mozilla.org")).toBe(true);
    expect(sourceMatchesMatrixDomain(source, "mozilla.modular.im")).toBe(true);
    expect(sourceMatchesMatrixDomain(source, "matrix.org")).toBe(false);
  });

  it("drops user-owned sources when a different Concord user binds to the store", () => {
    useSourcesStore.getState().bindToUser("@bob:example.concordchat.net");
    expect(useSourcesStore.getState().sources.map((source) => source.id)).toEqual([
      "src_concord",
    ]);
  });

  it("does not transfer legacy unowned sources to a newly bound user", () => {
    useSourcesStore.setState((state) => ({
      ...state,
      boundUserId: null,
      sources: [
        ...state.sources,
        {
          id: "src_legacy",
          host: "matrix.org",
          instanceName: "Matrix",
          inviteToken: "",
          apiBase: "https://matrix.org",
          homeserverUrl: "https://matrix.org",
          status: "connected",
          enabled: true,
          addedAt: new Date().toISOString(),
          platform: "matrix",
        },
      ],
    }));

    useSourcesStore.getState().bindToUser("@bo-peep:example.concordchat.net");

    expect(useSourcesStore.getState().sources.map((source) => source.id)).toEqual([
      "src_concord",
    ]);
  });

  it("re-attributes legacy sources only when the same persisted user binds again", () => {
    useSourcesStore.setState((state) => ({
      ...state,
      sources: state.sources.map((source) =>
        source.id === "src_matrix"
          ? { ...source, ownerUserId: undefined }
          : source,
      ),
    }));

    useSourcesStore.getState().bindToUser("@alice:example.concordchat.net");

    const matrixSource = useSourcesStore.getState().sources.find((source) => source.id === "src_matrix");
    expect(matrixSource?.ownerUserId).toBe("@alice:example.concordchat.net");
  });

  it("preserves instance-global primary sources on logout", () => {
    useSourcesStore.getState().bindToUser(null);
    expect(useSourcesStore.getState().sources.map((source) => source.id)).toEqual([
      "src_concord",
    ]);
  });

  // W2-09 — Owner badge data model. The Host onboarding flow (W2-06)
  // calls markOwner(id, true) after servitude_start + owner registration
  // + admin elevation. The Sources rail tile (W2-10) keys its owner
  // badge on this flag; "Server Settings" gates on it.
  it("markOwner flips isOwner on the matching source only", () => {
    expect(
      useSourcesStore.getState().sources.find((s) => s.id === "src_concord")?.isOwner,
    ).toBeFalsy();

    useSourcesStore.getState().markOwner("src_concord", true);

    expect(
      useSourcesStore.getState().sources.find((s) => s.id === "src_concord")?.isOwner,
    ).toBe(true);
    // Other sources stay untouched.
    expect(
      useSourcesStore.getState().sources.find((s) => s.id === "src_matrix")?.isOwner,
    ).toBeFalsy();

    useSourcesStore.getState().markOwner("src_concord", false);
    expect(
      useSourcesStore.getState().sources.find((s) => s.id === "src_concord")?.isOwner,
    ).toBe(false);
  });

  it("markOwner is a no-op for an unknown id", () => {
    const before = useSourcesStore.getState().sources.map((s) => ({ ...s }));
    useSourcesStore.getState().markOwner("src_does_not_exist", true);
    const after = useSourcesStore.getState().sources;
    expect(after.length).toBe(before.length);
    after.forEach((s, i) => expect(s.isOwner).toBe(before[i].isOwner));
  });
});
