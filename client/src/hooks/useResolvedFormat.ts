import { useFormatStore, type FormatOverride, DEFAULT_FORMAT } from "../stores/format";
import type { ChatMessage } from "./useMatrix";

interface XConcordDisplay {
  alignment?: "left" | "center" | "right" | "justify";
  fontSize?: number;
  color?: string;
  fontFamily?: string;
}

function parseSenderDisplay(msg: ChatMessage): Partial<FormatOverride> {
  const raw = (msg as unknown as { content?: Record<string, unknown> }).content;
  if (!raw) return {};
  const display = raw["x.concord.display"] as XConcordDisplay | undefined;
  if (!display) return {};
  return {
    ...(display.alignment !== undefined && { alignment: display.alignment }),
    ...(display.fontSize !== undefined && { fontSize: display.fontSize }),
    ...(display.color !== undefined && { color: display.color }),
    ...(display.fontFamily !== undefined && { fontFamily: display.fontFamily }),
  };
}

export function useResolvedFormat(msg: ChatMessage): FormatOverride {
  const messageFormats = useFormatStore((s) => s.messageFormats);
  const senderFormats = useFormatStore((s) => s.senderFormats);

  const base: FormatOverride = { ...DEFAULT_FORMAT };
  const senderOverride = parseSenderDisplay(msg);
  const senderViewerOverride = senderFormats[msg.sender] ?? {};
  const messageViewerOverride = messageFormats[msg.id] ?? {};

  return {
    ...base,
    ...senderOverride,
    ...senderViewerOverride,
    ...messageViewerOverride,
  };
}
