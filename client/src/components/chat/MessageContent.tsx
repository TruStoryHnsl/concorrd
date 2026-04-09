import { useState, useEffect, useMemo, Component, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  type ChartOptions,
} from "chart.js";
import { Bar, Line, Pie } from "react-chartjs-2";
import type { ChatMessage, ChartAttachment } from "../../hooks/useMatrix";
import { useAuthStore } from "../../stores/auth";

// Register chart.js components once at module load. chart.js v4 uses
// tree-shakable registration; without this, Bar/Line/Pie will throw at render.
ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
);

interface MessageContentProps {
  message: ChatMessage;
}

interface PreviewData {
  title: string;
  description: string | null;
  image: string | null;
  url: string;
}

// Module-level cache so the same URL isn't fetched multiple times across renders
const previewCache = new Map<string, PreviewData | null>();

const URL_REGEX = /https?:\/\/[^\s<>"]+[^\s<>"',;)]+/g;

function extractUrls(text: string): string[] {
  return [...new Set(text.match(URL_REGEX) ?? [])].slice(0, 3);
}

/**
 * Sanitize schema for chat-message markdown.
 *
 * Extends rehype-sanitize's defaultSchema to:
 *  - Drop dangerous tags (script, iframe, style, object, embed) — these are
 *    not in defaultSchema's allow-list, so dropping is implicit, but we list
 *    them explicitly via tagNames filter as a defensive measure.
 *  - Strip every `on*` event-handler attribute from every tag.
 *  - Restrict `href` URLs to http, https, and mailto protocols.
 *  - Allow `className` on the common content tags so the Tailwind classes
 *    injected by our `components` map survive sanitization.
 */
const FORBIDDEN_TAGS = new Set([
  "script",
  "iframe",
  "style",
  "object",
  "embed",
]);

const CLASSNAME_TAGS = [
  "a",
  "p",
  "code",
  "pre",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "strong",
  "em",
  "span",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
];

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter(
    (t) => !FORBIDDEN_TAGS.has(t),
  ),
  protocols: {
    ...(defaultSchema.protocols ?? {}),
    href: ["http", "https", "mailto"],
    src: ["http", "https"],
  },
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    // Allow className on the tags our components map styles
    ...Object.fromEntries(
      CLASSNAME_TAGS.map((tag) => {
        const existing = (defaultSchema.attributes?.[tag] ?? []) as Array<
          string | [string, ...unknown[]]
        >;
        return [tag, [...existing, "className"]];
      }),
    ),
    // Ensure anchor attributes are allowed and safe
    a: [
      ...((defaultSchema.attributes?.a ?? []) as Array<
        string | [string, ...unknown[]]
      >),
      "className",
      "target",
      "rel",
    ],
  },
} as typeof defaultSchema;

/**
 * Components map: applies Tailwind utility classes to rendered markdown
 * elements so they match the rest of the chat surface tokens.
 */
const markdownComponents: Components = {
  p: ({ children, ...props }) => (
    <p className="mb-1 last:mb-0" {...props}>
      {children}
    </p>
  ),
  a: ({ children, href, ...props }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary hover:underline break-all"
      {...props}
    >
      {children}
    </a>
  ),
  code: ({ className, children, ...props }) => {
    // react-markdown v9 no longer passes `inline`; detect fenced blocks via
    // the language-* className that GFM/markdown adds, and let the `pre`
    // renderer handle the block wrapper. Inline code = no className.
    const isBlock = typeof className === "string" && /language-/.test(className);
    if (isBlock) {
      return (
        <code
          className={`block bg-surface-container-high text-on-surface p-3 rounded overflow-x-auto text-sm font-mono ${className ?? ""}`}
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <code
        className="bg-surface-container-high text-on-surface px-1 py-0.5 rounded text-sm font-mono"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children, ...props }) => (
    <pre className="my-1" {...props}>
      {children}
    </pre>
  ),
  ul: ({ children, ...props }) => (
    <ul className="list-disc list-inside" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol className="list-decimal list-inside" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }) => <li {...props}>{children}</li>,
  h1: ({ children, ...props }) => (
    <h1 className="text-xl font-bold font-headline mt-1 mb-1" {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 className="text-lg font-bold font-headline mt-1 mb-1" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 className="text-base font-bold font-headline mt-1 mb-1" {...props}>
      {children}
    </h3>
  ),
  h4: ({ children, ...props }) => (
    <h4 className="text-sm font-bold font-headline mt-1 mb-1" {...props}>
      {children}
    </h4>
  ),
  h5: ({ children, ...props }) => (
    <h5 className="text-xs font-bold font-headline mt-1 mb-1" {...props}>
      {children}
    </h5>
  ),
  h6: ({ children, ...props }) => (
    <h6 className="text-xs font-semibold font-headline mt-1 mb-1" {...props}>
      {children}
    </h6>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote
      className="border-l-4 border-primary/60 bg-surface-container-high/40 pl-3 pr-2 py-1 my-1 ml-1 text-on-surface-variant italic rounded-r"
      {...props}
    >
      {children}
    </blockquote>
  ),
  strong: ({ children, ...props }) => <strong {...props}>{children}</strong>,
  em: ({ children, ...props }) => <em {...props}>{children}</em>,
};

/**
 * Validate an untrusted chart payload against the ChartAttachment schema.
 * Returns the typed object on success, or a string error on failure. We do
 * structural checks only — chart.js will reject malformed `options` at render
 * time, which the ErrorBoundary-style fallback below will catch.
 */
export function validateChartAttachment(
  raw: unknown,
): { ok: true; value: ChartAttachment } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "chart payload must be an object" };
  }
  const r = raw as Record<string, unknown>;
  if (r.type !== "bar" && r.type !== "line" && r.type !== "pie") {
    return { ok: false, error: `unsupported chart type: ${String(r.type)}` };
  }
  const data = r.data;
  if (!data || typeof data !== "object") {
    return { ok: false, error: "missing data object" };
  }
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.labels) || !d.labels.every((l) => typeof l === "string")) {
    return { ok: false, error: "data.labels must be string[]" };
  }
  if (!Array.isArray(d.datasets) || d.datasets.length === 0) {
    return { ok: false, error: "data.datasets must be a non-empty array" };
  }
  for (const [i, ds] of d.datasets.entries()) {
    if (!ds || typeof ds !== "object") {
      return { ok: false, error: `datasets[${i}] is not an object` };
    }
    const dsr = ds as Record<string, unknown>;
    // Number.isFinite rejects NaN, ±Infinity, and non-numbers in one check —
    // `typeof n === "number"` alone would accept NaN/Infinity, which chart.js
    // renders as blank bars or zero-length wedges with no user-facing error.
    if (
      !Array.isArray(dsr.data) ||
      !dsr.data.every((n) => Number.isFinite(n))
    ) {
      return {
        ok: false,
        error: `datasets[${i}].data must be an array of finite numbers`,
      };
    }
    // Each dataset's series must line up with the shared label axis. A
    // mismatched length silently drops or pads data points in chart.js, so
    // reject at the boundary instead of rendering a misleading chart.
    if (dsr.data.length !== d.labels.length) {
      return {
        ok: false,
        error: `datasets[${i}].data length (${dsr.data.length}) must match data.labels length (${d.labels.length})`,
      };
    }
  }
  if (r.options !== undefined && (typeof r.options !== "object" || r.options === null)) {
    return { ok: false, error: "options must be an object if present" };
  }
  if (r.title !== undefined && typeof r.title !== "string") {
    return { ok: false, error: "title must be a string if present" };
  }
  return { ok: true, value: r as unknown as ChartAttachment };
}

/** Dark-theme chart.js defaults — light grid lines, light labels, legend on top. */
const darkChartDefaults: ChartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: {
      position: "top",
      labels: { color: "rgba(230, 230, 235, 0.9)" },
    },
    tooltip: {
      backgroundColor: "rgba(20, 20, 24, 0.95)",
      titleColor: "rgba(240, 240, 245, 1)",
      bodyColor: "rgba(220, 220, 230, 1)",
      borderColor: "rgba(120, 120, 140, 0.4)",
      borderWidth: 1,
    },
  },
  scales: {
    x: {
      ticks: { color: "rgba(210, 210, 220, 0.85)" },
      grid: { color: "rgba(120, 120, 140, 0.15)" },
    },
    y: {
      ticks: { color: "rgba(210, 210, 220, 0.85)" },
      grid: { color: "rgba(120, 120, 140, 0.15)" },
    },
  },
};

/** Pie charts have no cartesian scales — provide a separate defaults object. */
const darkPieDefaults: ChartOptions<"pie"> = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: {
      position: "top",
      labels: { color: "rgba(230, 230, 235, 0.9)" },
    },
    tooltip: {
      backgroundColor: "rgba(20, 20, 24, 0.95)",
      titleColor: "rgba(240, 240, 245, 1)",
      bodyColor: "rgba(220, 220, 230, 1)",
      borderColor: "rgba(120, 120, 140, 0.4)",
      borderWidth: 1,
    },
  },
};

function InvalidChartPill({
  error,
  raw,
}: {
  error: string;
  raw: unknown;
}) {
  let rawDump: string;
  try {
    rawDump = JSON.stringify(raw, null, 2);
  } catch {
    rawDump = String(raw);
  }
  return (
    <div className="mt-2 inline-flex flex-col gap-1 max-w-sm">
      <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-error-container text-on-error-container text-xs font-medium self-start">
        <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
          <path
            fillRule="evenodd"
            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
            clipRule="evenodd"
          />
        </svg>
        Invalid chart
      </span>
      <details className="text-xs text-on-surface-variant">
        <summary className="cursor-pointer select-none hover:underline">
          Details
        </summary>
        <p className="mt-1 text-on-error">{error}</p>
        <pre className="mt-1 p-2 rounded bg-surface-container-high text-[10px] overflow-x-auto max-h-40">
          {rawDump}
        </pre>
      </details>
    </div>
  );
}

/**
 * Error boundary wrapping chart.js rendering. chart.js v4 can throw during
 * render on malformed options beyond what structural validation catches;
 * an error boundary is the React-idiomatic way to contain the failure.
 */
class ChartErrorBoundary extends Component<
  { raw: unknown; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Commercial profile: log for observability without leaking stack to user.
    console.warn("ChartRenderer crashed:", error.message);
  }

  render() {
    if (this.state.error) {
      return (
        <InvalidChartPill
          error={`render error: ${this.state.error.message}`}
          raw={this.props.raw}
        />
      );
    }
    return this.props.children;
  }
}

function ChartBody({ chart }: { chart: ChartAttachment }) {
  // Merge user-supplied options over dark defaults. User options win so
  // agents can customize, but they inherit the dark palette for free.
  const baseDefaults =
    chart.type === "pie" ? darkPieDefaults : darkChartDefaults;
  const mergedOptions = {
    ...baseDefaults,
    ...(chart.options ?? {}),
    plugins: {
      ...baseDefaults.plugins,
      ...((chart.options as { plugins?: object })?.plugins ?? {}),
    },
  } as ChartOptions;

  return (
    <div className="mt-2 max-w-lg">
      {chart.title && (
        <p className="text-sm font-medium text-on-surface mb-1">
          {chart.title}
        </p>
      )}
      <div
        className="bg-surface-container rounded-lg p-3 border border-outline-variant/15"
        style={{ height: 280 }}
      >
        {chart.type === "bar" && (
          <Bar data={chart.data} options={mergedOptions as ChartOptions<"bar">} />
        )}
        {chart.type === "line" && (
          <Line data={chart.data} options={mergedOptions as ChartOptions<"line">} />
        )}
        {chart.type === "pie" && (
          <Pie data={chart.data} options={mergedOptions as ChartOptions<"pie">} />
        )}
      </div>
    </div>
  );
}

export function ChartRenderer({ raw }: { raw: unknown }) {
  const result = useMemo(() => validateChartAttachment(raw), [raw]);
  if (!result.ok) {
    return <InvalidChartPill error={result.error} raw={raw} />;
  }
  return (
    <ChartErrorBoundary raw={raw}>
      <ChartBody chart={result.value} />
    </ChartErrorBoundary>
  );
}

function LinkPreview({ url }: { url: string }) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [data, setData] = useState<PreviewData | null | undefined>(
    previewCache.has(url) ? previewCache.get(url) : undefined,
  );

  useEffect(() => {
    if (!accessToken || previewCache.has(url)) return;

    fetch(`/api/preview?url=${encodeURIComponent(url)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: PreviewData | null) => {
        previewCache.set(url, d);
        setData(d);
      })
      .catch(() => {
        previewCache.set(url, null);
        setData(null);
      });
  }, [url, accessToken]);

  if (!data) return null;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="block mt-2 max-w-sm border border-outline-variant/15 rounded-lg overflow-hidden hover:border-outline-variant transition-colors bg-surface-container"
    >
      {data.image && (
        <img
          src={data.image}
          alt=""
          className="w-full h-32 object-cover"
          loading="lazy"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      )}
      <div className="p-3">
        <p className="text-sm font-medium text-on-surface truncate">{data.title}</p>
        {data.description && (
          <p className="text-xs text-on-surface-variant mt-1 line-clamp-2">{data.description}</p>
        )}
        <p className="text-xs text-on-surface-variant mt-1 truncate">{new URL(url).hostname}</p>
      </div>
    </a>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MessageContent({ message }: MessageContentProps) {
  if (message.redacted) {
    return (
      <span className="text-sm text-on-surface-variant italic">[Message deleted]</span>
    );
  }

  const { msgtype, body, url, info } = message;

  if (msgtype === "m.image" && url) {
    return (
      <div className="mt-1">
        <a href={url} target="_blank" rel="noopener noreferrer">
          <img
            src={url}
            alt={body}
            className="max-w-sm max-h-80 rounded-lg object-contain"
            style={
              info?.w && info?.h
                ? {
                    aspectRatio: `${info.w} / ${info.h}`,
                    maxWidth: Math.min(info.w, 384),
                  }
                : undefined
            }
            loading="lazy"
          />
        </a>
        {body && body !== "image" && (
          <p className="text-xs text-on-surface-variant mt-1">{body}</p>
        )}
      </div>
    );
  }

  if (msgtype === "m.audio" && url) {
    return (
      <div className="mt-1">
        <audio controls src={url} className="max-w-sm" preload="none">
          <a href={url}>{body}</a>
        </audio>
        {info?.size && (
          <p className="text-xs text-on-surface-variant mt-0.5">{formatSize(info.size)}</p>
        )}
      </div>
    );
  }

  if (msgtype === "m.video" && url) {
    return (
      <div className="mt-1">
        <video
          controls
          src={url}
          className="max-w-sm max-h-80 rounded-lg"
          preload="none"
        >
          <a href={url}>{body}</a>
        </video>
      </div>
    );
  }

  if (msgtype === "m.file" && url) {
    return (
      <div className="mt-1 flex items-center gap-2 px-3 py-2 bg-surface-container rounded-lg max-w-sm">
        <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 text-on-surface-variant flex-shrink-0">
          <path d="M3 3.5A1.5 1.5 0 014.5 2h6.879a1.5 1.5 0 011.06.44l4.122 4.12A1.5 1.5 0 0117 7.622V16.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 013 16.5v-13z" />
        </svg>
        <div className="min-w-0 flex-1">
          <a
            href={url}
            download={body}
            className="text-sm text-primary hover:text-primary truncate block"
          >
            {body}
          </a>
          {info?.size && (
            <span className="text-xs text-on-surface-variant">{formatSize(info.size)}</span>
          )}
        </div>
      </div>
    );
  }

  // m.text or fallback — render markdown (sanitized) with URL previews.
  // URL extraction runs on the RAW body so previews work even when the URL
  // is wrapped in markdown link syntax.
  //
  // If the message carries a `com.concord.chart` custom field (authored by
  // an agent, preserved verbatim across federation), append a chart render
  // after the body. Malformed payloads degrade to a fallback pill inside
  // ChartRenderer, never a crash.
  const urls = extractUrls(body);
  const hasChart = message.chartRaw !== undefined && message.chartRaw !== null;
  return (
    <div className="text-sm text-on-surface markdown-content concord-message-body">
      {body && (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
          components={markdownComponents}
        >
          {body}
        </ReactMarkdown>
      )}
      {hasChart && <ChartRenderer raw={message.chartRaw} />}
      {urls.map((u) => (
        <LinkPreview key={u} url={u} />
      ))}
    </div>
  );
}
