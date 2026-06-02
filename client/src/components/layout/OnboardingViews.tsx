// Onboarding / rules / help views extracted from ChatLayout. Pure
// presentational components with no internal state, no store reads —
// safe to lift cleanly out of the main shell.

/** Full-panel screen shown to members who haven't accepted the server rules yet. */
export function RulesGate({
  rulesText,
  onAccept,
}: {
  rulesText: string;
  onAccept: () => void;
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 gap-6 min-h-0 overflow-y-auto">
      <div className="max-w-lg w-full space-y-4">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-primary text-2xl">gavel</span>
          <h2 className="text-xl font-headline font-semibold text-on-surface">Server Rules</h2>
        </div>
        <p className="text-xs text-on-surface-variant">
          Please read and accept the rules before participating in this server.
        </p>
        <div className="px-4 py-4 bg-surface-container border border-outline-variant/20 rounded-lg text-sm text-on-surface whitespace-pre-wrap leading-relaxed max-h-80 overflow-y-auto">
          {rulesText}
        </div>
        <button
          onClick={onAccept}
          className="w-full py-2.5 primary-glow hover:brightness-110 text-on-surface font-medium text-sm rounded-lg transition-colors"
        >
          I accept the rules
        </button>
      </div>
    </div>
  );
}

/** First-launch welcome guide. Also embedded inside HelpModal. */
export function OnboardingGuide() {
  return (
    <div className="max-w-md w-full space-y-6 animate-[fadeSlideUp_0.5s_ease-out]">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-headline font-bold text-on-surface">Welcome to Concord</h2>
        <p className="text-on-surface-variant text-sm font-body" style={{ lineHeight: "1.6" }}>
          Get started by joining or creating a server.
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-start gap-3 p-4 rounded-xl bg-surface-container">
          <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
            <span className="material-symbols-outlined text-primary text-lg">add</span>
          </div>
          <div>
            <p className="text-sm font-medium text-on-surface font-headline">Create or browse servers</p>
            <p className="text-xs text-on-surface-variant mt-0.5 font-body">
              Tap the <strong className="text-on-surface">+</strong> button to create your own server or browse public ones.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 p-4 rounded-xl bg-surface-container">
          <div className="w-8 h-8 rounded-full bg-secondary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
            <span className="material-symbols-outlined text-secondary text-lg">link</span>
          </div>
          <div>
            <p className="text-sm font-medium text-on-surface font-headline">Got an invite link?</p>
            <p className="text-xs text-on-surface-variant mt-0.5 font-body">
              Paste the invite URL in your browser to automatically join a server.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 p-4 rounded-xl bg-surface-container">
          <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
            <span className="material-symbols-outlined text-primary text-lg">tune</span>
          </div>
          <div>
            <p className="text-sm font-medium text-on-surface font-headline">Customize your profile</p>
            <p className="text-xs text-on-surface-variant mt-0.5 font-body">
              Open settings to configure two-factor auth, passwords, and audio devices.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Help dialog. Wraps OnboardingGuide in a dismissable modal. */
export function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative glass-panel rounded-2xl p-6 animate-[fadeSlideUp_0.3s_ease-out]">
        <button
          onClick={onClose}
          className="absolute -top-3 -right-3 w-8 h-8 flex items-center justify-center rounded-full bg-surface-container-highest text-on-surface-variant hover:text-on-surface transition-colors z-10"
          title="Close"
        >
          <span className="material-symbols-outlined text-lg">close</span>
        </button>
        <OnboardingGuide />
      </div>
    </div>
  );
}
