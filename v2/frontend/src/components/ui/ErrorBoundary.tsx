import { Component, type ReactNode, type ErrorInfo } from "react";
import GlassPanel from "./GlassPanel";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  retryCount: number;
  isRetrying: boolean;
  nextRetryIn: number | null; // seconds until next auto-retry
  maxRetriesHit: boolean;
  diagnosis: string | null;
}

/** Max auto-retries before stopping and showing diagnosis */
const MAX_AUTO_RETRIES = 5;

/** Backoff schedule in seconds: 2, 4, 8, 16, 32 */
function getBackoffSeconds(retryCount: number): number {
  return Math.min(2 ** (retryCount + 1), 32);
}

/** Diagnose the most likely issue from the error message */
function diagnoseError(error: Error | null, retryCount: number): string {
  if (!error) return "Unknown error.";
  const msg = error.message.toLowerCase();

  if (msg.includes("undefined is not an object") || msg.includes("cannot read propert")) {
    return "A data format mismatch between the Rust backend and the frontend. The backend may be sending snake_case fields where the UI expects camelCase. This typically happens after a backend update.";
  }
  if (msg.includes("tauri") || msg.includes("invoke")) {
    return "The Tauri IPC bridge is not responding. The Rust backend may have crashed or is still starting up. Check the terminal running 'cargo tauri dev' for errors.";
  }
  if (msg.includes("network") || msg.includes("fetch")) {
    return "A network request failed. The Vite dev server may have stopped. Check if http://localhost:1420 is still reachable.";
  }
  if (retryCount >= MAX_AUTO_RETRIES) {
    return `The app failed ${retryCount} times in a row. The most likely cause is a persistent bug in the UI code or an incompatible backend state. Try restarting 'cargo tauri dev'.`;
  }
  return `Unexpected error: ${error.message}`;
}

class ErrorBoundary extends Component<Props, State> {
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;

  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      retryCount: 0,
      isRetrying: false,
      nextRetryIn: null,
      maxRetriesHit: false,
      diagnosis: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const count = this.state.retryCount + 1;
    console.error(
      `[ErrorBoundary] CAUGHT (attempt ${count}/${MAX_AUTO_RETRIES}):`,
      error.message,
      "\n  Component stack:", errorInfo.componentStack?.split("\n").slice(0, 3).join(" > "),
    );
    this.scheduleAutoRetry();
  }

  componentWillUnmount() {
    this.clearTimers();
  }

  clearTimers() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.retryTimer = null;
    this.countdownTimer = null;
  }

  scheduleAutoRetry() {
    const { retryCount, error } = this.state;
    const nextCount = retryCount + 1;

    if (nextCount > MAX_AUTO_RETRIES) {
      const diag = diagnoseError(error, nextCount);
      console.warn(
        `[ErrorBoundary] MAX RETRIES HIT (${MAX_AUTO_RETRIES}). Stopping auto-retry.`,
        "\n  Diagnosis:", diag,
        "\n  Last error:", error?.message,
      );
      this.setState({
        maxRetriesHit: true,
        diagnosis: diag,
        nextRetryIn: null,
        isRetrying: false,
      });
      return;
    }

    const backoff = getBackoffSeconds(retryCount);
    console.info(
      `[ErrorBoundary] Auto-retry ${nextCount}/${MAX_AUTO_RETRIES} in ${backoff}s`,
      `(error: ${error?.message?.slice(0, 80)})`,
    );
    this.setState({ nextRetryIn: backoff, retryCount: nextCount });

    // Countdown timer (updates every second)
    this.countdownTimer = setInterval(() => {
      this.setState((prev) => {
        if (prev.nextRetryIn === null || prev.nextRetryIn <= 1) {
          if (this.countdownTimer) clearInterval(this.countdownTimer);
          return { nextRetryIn: null };
        }
        return { nextRetryIn: prev.nextRetryIn - 1 };
      });
    }, 1000);

    // Actual retry
    this.retryTimer = setTimeout(() => {
      this.clearTimers();
      this.setState({ isRetrying: true });
      // Small delay for visual feedback
      setTimeout(() => {
        this.setState({ hasError: false, error: null, isRetrying: false });
      }, 200);
    }, backoff * 1000);
  }

  handleManualRetry = () => {
    console.info("[ErrorBoundary] Manual retry — resetting retry counter");
    this.clearTimers();
    this.setState({
      hasError: false,
      error: null,
      isRetrying: false,
      retryCount: 0,
      maxRetriesHit: false,
      diagnosis: null,
      nextRetryIn: null,
    });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      const { error, retryCount, nextRetryIn, maxRetriesHit, diagnosis, isRetrying } = this.state;

      return (
        <div className="mesh-background min-h-full flex items-center justify-center p-6">
          <div className="relative z-10 w-full max-w-md">
            <GlassPanel className="p-8 text-center space-y-4 rounded-2xl">
              <div className={`flex items-center justify-center w-16 h-16 rounded-full mx-auto ${
                maxRetriesHit ? "bg-error/10" : "bg-primary/10"
              }`}>
                <span className={`material-symbols-outlined text-4xl ${
                  maxRetriesHit ? "text-error" : isRetrying ? "text-primary animate-spin" : "text-primary"
                }`}>
                  {maxRetriesHit ? "error" : isRetrying ? "sync" : "warning"}
                </span>
              </div>

              <h2 className="font-headline font-bold text-xl text-on-surface">
                {maxRetriesHit ? "Connection Failed" : "Reconnecting..."}
              </h2>

              {!maxRetriesHit && nextRetryIn !== null && (
                <p className="text-sm text-on-surface-variant font-body">
                  Retrying in{" "}
                  <span className="text-primary font-bold">{nextRetryIn}s</span>
                  <span className="text-on-surface-variant/50 ml-2">
                    (attempt {retryCount}/{MAX_AUTO_RETRIES})
                  </span>
                </p>
              )}

              {!maxRetriesHit && isRetrying && (
                <p className="text-sm text-primary font-body font-medium">
                  Attempting reconnection...
                </p>
              )}

              {maxRetriesHit && diagnosis && (
                <div className="bg-surface-container-lowest/30 rounded-xl p-4 text-left space-y-2">
                  <p className="font-label text-[10px] uppercase tracking-widest text-error">
                    Diagnosis
                  </p>
                  <p className="text-sm text-on-surface-variant font-body leading-relaxed">
                    {diagnosis}
                  </p>
                </div>
              )}

              {error && (
                <div className="bg-surface-container-lowest/30 rounded-xl p-3 text-left">
                  <p className="font-mono text-[11px] text-error/80 break-all">
                    {error.message}
                  </p>
                </div>
              )}

              <button
                onClick={this.handleManualRetry}
                className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-gradient-to-br from-primary to-primary-container text-on-primary-container font-bold text-sm shadow-lg shadow-primary/10 hover:brightness-110 transition-all active:scale-95"
              >
                <span className="material-symbols-outlined text-lg">refresh</span>
                {maxRetriesHit ? "Try Again" : "Retry Now"}
              </button>
            </GlassPanel>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
