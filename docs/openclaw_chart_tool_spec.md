# OpenClaw `emit_chart` Tool — Wire Format Spec

**Status:** Authoritative · 2026-04-08
**Companion to:** `client/src/components/chat/MessageContent.tsx` (`validateChartAttachment`, `ChartRenderer`), `client/src/hooks/useMatrix.ts` (`ChartAttachment` interface)
**Task:** INS-019b (PLAN.md)
**Plugin location (out of this repo):** `~/.openclaw/workspace/plugins/openclaw-plugin-concord-chart/` on the `openclaw` VM
**Deploy script (in `~/projects/admin/`):** `openclaw-deploy-chart-plugin.sh` (tracked separately)

---

## 1. Purpose

OpenClaw is an agentic AI harness (upstream `openclaw@2026.4.8`, MIT) that runs chatbot personas inside Concord's Matrix rooms via `matrix-js-sdk`. Agents need a way to render inline data visualizations (bar, line, pie charts) from natural-language requests without manually formatting data.

This doc is the **on-wire contract** that the OpenClaw-side plugin and the Concord-side client both validate against. When either validator changes, the other must change in lockstep — see §6 "Lockstep discipline."

It is NOT the plugin implementation — that lives in the OpenClaw repo on the `openclaw` VM. This doc is the Concord-repo reference so that any Concord contributor can read it without SSH access to OpenClaw.

---

## 2. Transport shape

One `emit_chart` tool invocation produces **two** Matrix events, sent back-to-back in the same room:

### 2.1 Event A — `m.image` (PNG fallback for non-Concord clients)

A standard Matrix image event pointing at a PNG rendering of the chart, pre-uploaded to the Matrix media repo by the plugin (via a headless canvas library — candidates: `canvas`, `@napi-rs/canvas`, `skia-canvas`).

```jsonc
{
  "type": "m.room.message",
  "content": {
    "msgtype": "m.image",
    "body": "chart.png",              // filename hint for non-image-aware clients
    "url": "mxc://openclaw/xxxxxxxx", // media-repo URL returned by plugin upload
    "info": {
      "mimetype": "image/png",
      "w": 800,                        // PNG width
      "h": 480,                        // PNG height
      "size": 23456                    // bytes
    }
  }
}
```

**Why:** Generic Matrix clients (Element, Nheko, Beeper, FluffyChat, Cinny, …) ignore the `com.concord.chart` namespaced field on the sibling `m.text` event for safety. Without Event A, foreign clients see only fallback body text, while chart data sits invisible in the federated timeline. Event A guarantees every client sees *something*.

### 2.2 Event B — `m.text` (structured payload for Concord clients)

A standard Matrix text event with a fallback `body` string PLUS a namespaced `com.concord.chart` field containing the typed chart spec.

```jsonc
{
  "type": "m.room.message",
  "content": {
    "msgtype": "m.text",
    "body": "Q1 revenue by region (see chart above).",  // fallback text for non-Concord clients
    "com.concord.chart": {
      "type": "bar",
      "data": {
        "labels": ["North", "South", "East", "West"],
        "datasets": [
          {
            "label": "Q1 Revenue ($k)",
            "data": [120, 85, 140, 95]
          }
        ]
      },
      "title": "Q1 Revenue by Region"
    }
  }
}
```

Concord clients prefer the structured Event B and render an interactive chart via `react-chartjs-2`. Non-Concord clients silently drop the `com.concord.chart` field and display only the body text — Event A is the visual fallback, Event B is the accessible caption.

**Ordering:** Event A MUST be sent before Event B so a Concord client reading the timeline sees the image above the structured render. Plugin implementation detail — does not affect validation.

---

## 3. `com.concord.chart` schema

The normalized subset of chart.js options Concord supports in the first cut. Mirrors `ChartAttachment` in `client/src/hooks/useMatrix.ts:174`.

### 3.1 TypeBox source (authoritative — mirror in OpenClaw plugin)

```ts
import { Type, type Static } from "@sinclair/typebox";

export const TChartDataset = Type.Object({
  label: Type.Optional(Type.String()),
  data: Type.Array(Type.Number()),                              // must be finite; see §4
  backgroundColor: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String())]),
  ),
  borderColor: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String())]),
  ),
});

export const TChartAttachment = Type.Object({
  type: Type.Union([
    Type.Literal("bar"),
    Type.Literal("line"),
    Type.Literal("pie"),
  ]),
  data: Type.Object({
    labels: Type.Array(Type.String()),
    datasets: Type.Array(TChartDataset, { minItems: 1 }),
  }),
  options: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  title: Type.Optional(Type.String()),
});

export type ChartAttachment = Static<typeof TChartAttachment>;
```

### 3.2 TypeScript interface (for reference — defined in Concord client)

```ts
// client/src/hooks/useMatrix.ts:174
export interface ChartAttachment {
  type: "bar" | "line" | "pie";
  data: {
    labels: string[];
    datasets: Array<{
      label?: string;
      data: number[];                            // must be finite
      backgroundColor?: string | string[];
      borderColor?: string | string[];
    }>;
  };
  options?: Record<string, unknown>;
  title?: string;
}
```

---

## 4. Validation rules

Both sides of the contract enforce these. Concord's enforcement lives in `validateChartAttachment` at `client/src/components/chat/MessageContent.tsx:244`.

1. **`type`** must be exactly one of `"bar"`, `"line"`, `"pie"`. Unknown or missing → reject.
2. **`data.labels`** must be an array of strings. Empty array is permitted structurally but the mismatch check in rule 5 will reject any non-empty dataset paired with an empty-labels array.
3. **`data.datasets`** must be a non-empty array.
4. **Each dataset's `data`** must be an array of **finite** numbers. `NaN`, `+Infinity`, `-Infinity`, and non-numbers are all rejected. Concord uses `Number.isFinite(n)` as the single idiomatic guard — `typeof n === "number"` alone is insufficient because `typeof NaN === "number"`.
5. **Length alignment**: every dataset's `data.length` MUST equal `data.labels.length`. chart.js silently drops or pads mismatched series, which produces misleading charts with no user-facing error — reject at the boundary instead.
6. **`options`** is optional; when present, must be an object. Its internal shape is NOT validated — chart.js catches malformed options at render time and Concord's `ChartErrorBoundary` surfaces the failure as an `InvalidChartPill`.
7. **`title`** is optional; when present, must be a string.

On reject, Concord's validator returns `{ ok: false, error: <human-readable reason> }` and `ChartRenderer` renders the `InvalidChartPill` instead of a chart. Developer-only detail (the raw payload) is exposed in a collapsed `<details>` block per the `commercial` scope profile (no stack traces in user-facing output).

---

## 5. Dual-payload contract: what each client sees

| Client | Event A (`m.image`) | Event B (`m.text` + `com.concord.chart`) | Result |
|---|---|---|---|
| Concord (web / Tauri native) | Rendered as an image (existing image handler) | Rendered as a live chart via `ChartRenderer` | User sees both the PNG (as a normal image message) AND the interactive chart below. The plugin MAY choose to suppress the PNG locally on Concord clients via a future `com.concord.suppress_image_on_concord` hint, but the first cut ships both. |
| Element, Nheko, Beeper, etc. | Rendered as an image | Custom field silently dropped; body text rendered as a normal text message | User sees the PNG + the fallback caption. Good enough for accessibility. |
| Screen readers / text-only clients | `body` of Event A ("chart.png") | `body` of Event B (human-readable caption) | Screen reader reads the caption. PNG alt text is the filename, which is acceptable but improvable in a future revision by setting `body` on Event A to a more descriptive string. |

### 5.1 Plugin implementation order (reference only)

1. Validate the agent's tool arguments against `TChartAttachment` locally.
2. Render the chart to PNG via the chosen headless canvas library.
3. Upload the PNG to the Matrix media repo via matrix-js-sdk.
4. Send Event A (`m.image`) pointing at the uploaded URL.
5. Send Event B (`m.text`) with the `body` caption AND the `com.concord.chart` structured payload, via the `sendSingleTextMessageMatrix(...)` helper from `openclaw/plugin-sdk/extensions/matrix/...` with `extraContent` set. Template one-for-one from the `editMessageMatrix`/`com.openclaw.finalized_preview` pattern already in the deployed OpenClaw bundle (verified 2026-04-08 at `dist/monitor-Bl-05QFP.js:2822`).

---

## 6. Lockstep discipline

**This is the single most important rule in this document.** The TypeBox schema in §3.1 and the `validateChartAttachment` function in `client/src/components/chat/MessageContent.tsx` enforce the same contract from opposite ends of the wire. They MUST stay synchronized.

When the schema changes:

1. Update `ChartAttachment` in `client/src/hooks/useMatrix.ts`.
2. Update `validateChartAttachment` in `client/src/components/chat/MessageContent.tsx`.
3. Update the chart tests at `client/src/components/chat/__tests__/MessageContent.chart.test.tsx`.
4. Update the TypeBox schema in the OpenClaw plugin (on the `openclaw` VM).
5. Update this doc's §3 and §4.
6. Deploy the plugin update via `admin/openclaw-deploy-chart-plugin.sh`.
7. Build and deploy the Concord client.

**Order matters when loosening the schema vs tightening it:**

- **Loosening** (Concord accepts more than before): deploy Concord client FIRST, then update the plugin to send the loosened shape. Otherwise agents emit payloads old clients reject.
- **Tightening** (Concord accepts less than before): update the plugin FIRST to stop emitting the now-rejected shape, then deploy the Concord client. Otherwise in-flight messages show as invalid pills.

---

## 7. Known limits and gotchas

- **Event size budget**: keep the serialized `com.concord.chart` payload under ~32 KB to stay well inside Synapse's 65 KB event limit. The PNG fallback lives on a separate `m.image` event so it doesn't count toward Event B's size.
- **Small-model schema discipline**: all 9 OpenClaw agents run `openai-codex/gpt-5.4-mini`. Keep the `emit_chart` tool description and parameter schema tight so a small model reliably fills them in without drift. Long optional blocks invite hallucination.
- **Pie charts have no cartesian scales**: Concord's `ChartBody` uses a separate `darkPieDefaults` options object for pie. If future schema work adds pie-specific fields (e.g. cutout percentage for donuts), they live under `options`, not at the top level.
- **Chart types in the first cut**: `bar`, `line`, `pie` only. Phase 2 can widen to `scatter`, `bubble`, `radar` after chart.js component registration is verified in the Concord client.
- **`backgroundColor`/`borderColor`**: accepted as string or string-array but NOT validated for CSS-color correctness. Agents should use named CSS colors or hex strings; the risk of invalid colors is cosmetic (chart.js silently uses a default), not structural.
- **Matrix custom content field namespacing**: `com.concord.chart` is the canonical key. Do NOT use alternate namespaces like `m.concord.chart` or `org.concord.chart` — they won't round-trip through Concord clients because the client reads exactly `content["com.concord.chart"]` at `useMatrix.ts:334`.

---

## 8. Security posture

- **Concord client treats `chartRaw` as untrusted.** Even after the plugin validates the payload on the OpenClaw side, Concord re-validates at render time. A compromised OpenClaw instance, a man-in-the-middle (should not occur inside Matrix federation but assumed hostile for defense-in-depth), or a misconfigured upstream cannot cause Concord to render anything outside the validated schema.
- **chart.js render-time errors** are caught by `ChartErrorBoundary` at `MessageContent.tsx:374` and surfaced as `InvalidChartPill`. No stack traces leak to the user (commercial scope profile requirement).
- **No arbitrary HTML or markdown** inside chart data. `data.labels` are rendered as plain strings by chart.js; they are NOT sanitized by DOMPurify because they never flow into the DOM as HTML.
- **OpenClaw VM password hygiene**: the `~/.openclaw/openclaw.json` config stores matrix account passwords in cleartext. Tracked as a separate security followup at `~/projects/admin/openclaw-matrix-recovery/`; NOT part of INS-019b acceptance.

---

## 9. Acceptance (cross-checked with PLAN.md)

OpenClaw can produce a `bar`/`line`/`pie` chart in chat from a natural-language request without manual data formatting, end-to-end across Matrix federation:

- Concord clients render the live/interactive chart via `com.concord.chart`.
- Non-Concord Matrix clients see the PNG via the paired `m.image` event.
- Both events live in the same room timeline.
- Malformed payloads degrade to an `InvalidChartPill` in the Concord client, never a crash.
- Federated replay (leave room, rejoin, scroll timeline) shows the chart because Matrix preserves custom content fields verbatim.

---

## 10. Cross-references

- **Concord client validator**: `client/src/components/chat/MessageContent.tsx:244` (`validateChartAttachment`)
- **Concord client renderer**: `client/src/components/chat/MessageContent.tsx:441` (`ChartRenderer`)
- **Concord client type**: `client/src/hooks/useMatrix.ts:174` (`ChartAttachment`)
- **Concord client tests**: `client/src/components/chat/__tests__/MessageContent.chart.test.tsx` (10 cases covering validator + renderer paths)
- **OpenClaw plugin source**: `~/.openclaw/workspace/plugins/openclaw-plugin-concord-chart/` on the `openclaw` VM (out of this repo)
- **OpenClaw deploy script**: `~/projects/admin/openclaw-deploy-chart-plugin.sh` (out of this repo)
- **PLAN.md section**: "OpenClaw Visual Presentation Authoring (INS-019)" — fully resolved 2026-04-08 via Cluster 7 inspection + user answers
- **Upstream template pattern**: `dist/monitor-Bl-05QFP.js:2822` in the deployed OpenClaw bundle (verified 2026-04-08)
