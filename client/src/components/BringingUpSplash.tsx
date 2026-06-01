/**
 * BringingUpSplash — reusable boot-splash animation for in-app
 * "we're getting something up" states.
 *
 * The initial app splash (#boot-splash in client/index.html) is the
 * hand-crafted Blender mp4 + brand + status text. Once React mounts
 * and dismisses it, the same visual language is the right thing to
 * show for any subsequent long-running bring-up the user is waiting
 * on — most notably the HostOnboarding "Bringing up your Concord"
 * step, which previously used a generic Tailwind spinner that read
 * as a totally different surface.
 *
 * This component renders the same mp4, the same brand text, and an
 * optional status line, sized and laid out to match the boot splash
 * exactly. The video plays once and freezes on its last frame
 * (matches the boot-splash markup in index.html — no `loop` attr).
 *
 * NOT a replacement for the boot splash itself. The boot splash
 * still lives in index.html so it paints before React evaluates;
 * this component is for in-app screens that have already passed
 * through the initial handoff.
 */

interface BringingUpSplashProps {
  /** Headline shown under the animation. Defaults to "Concord". */
  brand?: string;
  /** Sub-line below the headline. */
  status?: string;
  /** data-testid passthrough for tests. */
  testId?: string;
}

export function BringingUpSplash({
  brand = "Concord",
  status,
  testId,
}: BringingUpSplashProps) {
  return (
    <div
      data-testid={testId}
      className="h-full w-full flex flex-col items-center justify-center gap-6"
    >
      <div
        className="relative flex items-center justify-center"
        style={{
          width: 204,
          height: 204,
          filter: "drop-shadow(0 20px 42px rgba(0, 0, 0, 0.35))",
        }}
      >
        <video
          src="/boot-splash.mp4"
          autoPlay
          muted
          playsInline
          preload="auto"
          aria-hidden="true"
          style={{
            width: 192,
            height: 192,
            display: "block",
            willChange: "transform",
            transform: "translateZ(0)",
            backfaceVisibility: "hidden",
          }}
        />
      </div>
      <div className="flex flex-col items-center gap-1">
        <div
          className="text-text-primary"
          style={{
            fontFamily:
              "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
            fontSize: "1.25rem",
            fontWeight: 600,
            letterSpacing: "0.02em",
            lineHeight: 1.3,
          }}
        >
          {brand}
        </div>
        {status ? (
          <div
            data-testid={testId ? `${testId}-status` : undefined}
            className="text-text-secondary"
            style={{
              fontFamily:
                "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
              fontSize: "0.8125rem",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              lineHeight: 1.3,
            }}
          >
            {status}
          </div>
        ) : null}
      </div>
    </div>
  );
}
