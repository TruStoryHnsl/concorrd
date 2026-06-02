import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

// Inline error boundary for ChatLayout subtrees. Replaces the prior
// SilentBoundary that swallowed errors and auto-reset every 100ms —
// a hard render error there caused a 10 Hz crash/recover oscillation
// that hid real bugs.
//
// On error: render the supplied fallback (or a small default UI with a
// Retry button). Stay rendered until the user clicks Retry, or until
// React un/remounts the boundary.
export class SectionBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.error("SectionBoundary caught:", error.message, error);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-4 text-sm text-zinc-400">
        <span>Section unavailable.</span>
        <button
          type="button"
          onClick={this.reset}
          className="rounded border border-zinc-600 px-3 py-1 text-zinc-200 hover:bg-zinc-800"
        >
          Retry
        </button>
      </div>
    );
  }
}
