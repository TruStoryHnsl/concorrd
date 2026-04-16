import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface ConcordSource {
  id: string;
  host: string;
  instanceName?: string;
  enabled: boolean;
  status: "connected" | "connecting" | "error" | "unknown";
}

interface SourcesState {
  sources: ConcordSource[];
  addSource: (source: Omit<ConcordSource, "id" | "enabled" | "status">) => void;
  removeSource: (id: string) => void;
  toggleSource: (id: string) => void;
  setSourceStatus: (id: string, status: ConcordSource["status"]) => void;
}

export const useSourcesStore = create<SourcesState>()(
  persist(
    (set) => ({
      sources: [],

      addSource: (source) =>
        set((state) => ({
          sources: [
            ...state.sources,
            {
              ...source,
              id: crypto.randomUUID(),
              enabled: true,
              status: "connecting" as const,
            },
          ],
        })),

      removeSource: (id) =>
        set((state) => ({
          sources: state.sources.filter((s) => s.id !== id),
        })),

      toggleSource: (id) =>
        set((state) => ({
          sources: state.sources.map((s) =>
            s.id === id ? { ...s, enabled: !s.enabled } : s,
          ),
        })),

      setSourceStatus: (id, status) =>
        set((state) => ({
          sources: state.sources.map((s) =>
            s.id === id ? { ...s, status } : s,
          ),
        })),
    }),
    { name: "concord-sources" },
  ),
);
