import { Component, type ReactNode, type ErrorInfo } from "react";
import GlassPanel from "./GlassPanel";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="mesh-background min-h-full flex items-center justify-center p-6">
          <div className="relative z-10 w-full max-w-md">
            <GlassPanel className="p-8 text-center space-y-4 rounded-2xl">
              <div className="flex items-center justify-center w-16 h-16 rounded-full bg-error/10 mx-auto">
                <span className="material-symbols-outlined text-4xl text-error">
                  warning
                </span>
              </div>
              <h2 className="font-headline font-bold text-xl text-on-surface">
                Something went wrong
              </h2>
              <p className="text-sm text-on-surface-variant font-body leading-relaxed">
                An unexpected error occurred. This is likely a temporary issue
                with the local node.
              </p>
              {this.state.error && (
                <div className="bg-surface-container-lowest/30 rounded-xl p-3 text-left">
                  <p className="font-mono text-[11px] text-error/80 break-all">
                    {this.state.error.message}
                  </p>
                </div>
              )}
              <button
                onClick={this.handleReset}
                className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-gradient-to-br from-primary to-primary-container text-on-primary-container font-bold text-sm shadow-lg shadow-primary/10 hover:brightness-110 transition-all active:scale-95"
              >
                <span className="material-symbols-outlined text-lg">
                  refresh
                </span>
                Try Again
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
