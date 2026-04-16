import { useState, useEffect } from "react";
import { loginWithPassword } from "../../api/matrix";
import { registerUser, validateInvite, getInstanceInfo, getTOTPStatus, loginVerifyTOTP } from "../../api/concord";
import { useAuthStore } from "../../stores/auth";
import { INVITE_STORAGE_KEY } from "../../App";
import { ConcordLogo } from "../brand/ConcordLogo";

export function LoginForm() {
  const login = useAuthStore((s) => s.login);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [serverName, setServerName] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [validatingInvite, setValidatingInvite] = useState(false);
  const [instanceName, setInstanceName] = useState("Concord");
  const [showDownloads, setShowDownloads] = useState(false);
  const [openRegistration, setOpenRegistration] = useState(false);
  const [firstBoot, setFirstBoot] = useState(false);
  /**
   * Set to true when the admin account was just created in this page session
   * (first_boot was true before registration, false after).
   * Triggers the post-setup OPEN_REGISTRATION banner.
   */
  const [firstBootJustCompleted, setFirstBootJustCompleted] = useState(false);
  const [showRegBanner, setShowRegBanner] = useState(false);

  // TOTP verification state
  const [pendingLogin, setPendingLogin] = useState<{
    accessToken: string;
    userId: string;
    deviceId: string;
  } | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [totpError, setTotpError] = useState("");

  useEffect(() => {
    getInstanceInfo()
      .then((info) => {
        if (info.name) {
          setInstanceName(info.name);
          document.title = info.name;
        }
        setOpenRegistration(info.open_registration ?? false);
        if (info.first_boot) {
          setFirstBoot(true);
          setMode("register");
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("invite") || sessionStorage.getItem(INVITE_STORAGE_KEY);
    if (token) {
      setInviteToken(token);
      setMode("register");
      setValidatingInvite(true);
      validateInvite(token)
        .then((result) => {
          if (result.valid) {
            setServerName(result.server_name);
          } else {
            setInviteToken("");
            setError("Invite link is invalid or expired — you can still create an account");
          }
        })
        .catch(() => {
          setInviteToken("");
          setError("Failed to validate invite link — you can still create an account");
        })
        .finally(() => setValidatingInvite(false));
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      if (mode === "login") {
        const result = await loginWithPassword(username, password);
        try {
          const totpStatus = await getTOTPStatus(result.accessToken);
          if (totpStatus.enabled) {
            setPendingLogin({
              accessToken: result.accessToken,
              userId: result.userId,
              deviceId: result.deviceId,
            });
            setLoading(false);
            return;
          }
        } catch (totpErr: unknown) {
          const status = (totpErr as { status?: number })?.status;
          if (status !== 404) {
            setError("Could not verify two-factor authentication status. Please try again.");
            setLoading(false);
            return;
          }
        }
        login(result.accessToken, result.userId, result.deviceId);
      } else {
        if (!firstBoot && !openRegistration && !inviteToken.trim()) {
          setError("A valid registration token is required to create an account.");
          setLoading(false);
          return;
        }
        const wasFirstBoot = firstBoot;
        const result = await registerUser(username, password, inviteToken || undefined);
        if (wasFirstBoot && openRegistration) {
          // Admin account just created; registration is still open — warn the admin.
          setFirstBootJustCompleted(true);
          setShowRegBanner(true);
        }
        login(result.access_token, result.user_id, result.device_id);
        sessionStorage.removeItem(INVITE_STORAGE_KEY);
        window.history.replaceState({}, "", window.location.pathname);
      }
    } catch (err: unknown) {
      const error = err as { message?: string; data?: { error?: string } };
      setError(error.data?.error || error.message || "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  const handleTOTPVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingLogin || totpCode.length !== 6) return;
    setTotpError("");
    setLoading(true);
    try {
      await loginVerifyTOTP(totpCode, pendingLogin.accessToken);
      login(pendingLogin.accessToken, pendingLogin.userId, pendingLogin.deviceId);
      setPendingLogin(null);
    } catch (err) {
      setTotpError(err instanceof Error ? err.message : "Invalid code");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center p-4 relative mesh-background">
      <div className="w-full max-w-sm relative z-10">
        {/* TOTP verification screen */}
        {pendingLogin ? (
          <div className="text-center">
            <h1 className="text-3xl font-headline font-bold text-on-surface mb-2">{instanceName}</h1>
            <p className="text-on-surface-variant text-sm mb-6 font-body">Enter the 6-digit code from your authenticator app</p>
            <form onSubmit={handleTOTPVerify} className="space-y-4">
              <input
                type="text"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                className="w-full px-4 py-4 bg-surface-container rounded-xl text-on-surface text-center text-2xl font-mono tracking-[0.5em] placeholder-on-surface-variant/30 focus:outline-none focus:ring-1 focus:ring-primary/30 focus:bg-surface-container-high transition-all"
                maxLength={6}
                autoFocus
              />
              {totpError && <p className="text-error text-sm font-body">{totpError}</p>}
              <button
                type="submit"
                disabled={loading || totpCode.length !== 6}
                className="w-full py-3 primary-glow text-on-primary font-headline font-semibold rounded-xl transition-all hover:brightness-110 disabled:opacity-40 disabled:hover:brightness-100 shadow-lg shadow-primary/20"
              >
                {loading ? "Verifying..." : "Verify"}
              </button>
              <button
                type="button"
                onClick={() => { setPendingLogin(null); setTotpCode(""); setTotpError(""); }}
                className="text-on-surface-variant hover:text-on-surface text-sm transition-colors font-body"
              >
                Back to login
              </button>
            </form>
          </div>
        ) : (
        <>
        <ConcordLogo size={80} className="mx-auto mb-5" />
        <h1 className="text-3xl font-headline font-bold text-on-surface text-center mb-2">
          {instanceName}
        </h1>

        {/* ── OPEN_REGISTRATION warning banner (post first-boot) ── */}
        {showRegBanner && firstBootJustCompleted && openRegistration && (
          <div
            className="mb-4 px-4 py-3 bg-tertiary/15 border border-tertiary/40 rounded-xl text-sm font-body"
            data-testid="open-registration-banner"
          >
            <div className="flex items-start gap-2">
              <span className="material-symbols-outlined text-base text-tertiary mt-0.5 flex-shrink-0">
                warning
              </span>
              <div className="min-w-0">
                <p className="text-on-surface font-medium mb-1">Registration is open</p>
                <p className="text-on-surface-variant text-xs leading-relaxed">
                  Anyone can create an account on this instance. When setup is
                  complete, set{" "}
                  <code className="font-mono bg-surface-container px-1 rounded text-xs">
                    OPEN_REGISTRATION=false
                  </code>{" "}
                  in your <code className="font-mono bg-surface-container px-1 rounded text-xs">.env</code>{" "}
                  and restart the server.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowRegBanner(false)}
                className="text-on-surface-variant hover:text-on-surface flex-shrink-0 transition-colors"
                aria-label="Dismiss"
              >
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>
          </div>
        )}

        {/* ── First-boot: create admin account ── */}
        {firstBoot ? (
          <>
            <p className="text-center text-on-surface-variant text-sm mt-2 mb-6 font-body">
              Welcome! Create your admin account to get started.
            </p>
            <form onSubmit={handleSubmit} className="space-y-4">
              <input
                type="text"
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-4 py-3 bg-surface-container rounded-xl text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30 focus:bg-surface-container-high transition-all font-body"
                required
                autoFocus
              />
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 bg-surface-container rounded-xl text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30 focus:bg-surface-container-high transition-all font-body"
                required
              />
              {error && <p className="text-error text-sm font-body">{error}</p>}
              <button
                type="submit"
                disabled={loading}
                className="w-full py-3 primary-glow text-on-primary font-headline font-semibold rounded-xl transition-all hover:brightness-110 disabled:opacity-40 shadow-lg shadow-primary/20"
              >
                {loading ? "Creating account..." : "Create Admin Account"}
              </button>
            </form>
          </>
        ) : (
          /* ── Normal login / register ── */
          <>

        {validatingInvite && (
          <p className="text-center text-on-surface-variant text-sm mb-6 mt-6 font-body">
            Validating invite...
          </p>
        )}

        {!validatingInvite && serverName && (
          <p className="text-center text-primary text-sm mb-6 font-body">
            You've been invited to <strong>{serverName}</strong>
          </p>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 mt-6">
          <input
            type="text"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full px-4 py-3 bg-surface-container rounded-xl text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30 focus:bg-surface-container-high transition-all font-body"
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-3 bg-surface-container rounded-xl text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30 focus:bg-surface-container-high transition-all font-body"
            required
          />
          {/* Invite token — only visible in register mode. Not required
              when the server has OPEN_REGISTRATION enabled. */}
          {mode === "register" && (
            <input
              type="text"
              placeholder={openRegistration ? "Invite token (optional)" : "Invite token"}
              value={inviteToken}
              onChange={(e) => setInviteToken(e.target.value)}
              className="w-full px-4 py-3 bg-surface-container rounded-xl text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30 focus:bg-surface-container-high transition-all font-body font-mono tracking-wider"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              required={!openRegistration}
            />
          )}
          {error && <p className="text-error text-sm font-body">{error}</p>}

          {/* Login + Register buttons */}
          <div className="flex gap-2">
            <button
              type={mode === "login" ? "submit" : "button"}
              onClick={mode !== "login" ? () => setMode("login") : undefined}
              disabled={mode === "login" && (loading || validatingInvite)}
              className={`flex-1 py-3 font-headline font-semibold rounded-xl transition-all ${
                mode === "login"
                  ? "primary-glow text-on-primary hover:brightness-110 shadow-lg shadow-primary/20 disabled:opacity-40"
                  : "bg-surface-container text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high"
              }`}
            >
              {mode === "login" && loading ? "..." : "Login"}
            </button>
            <button
              type={mode === "register" ? "submit" : "button"}
              onClick={mode !== "register" ? () => setMode("register") : undefined}
              disabled={
                mode === "register" &&
                (loading || validatingInvite || (!openRegistration && !inviteToken.trim()))
              }
              className={`flex-1 py-3 font-headline font-semibold rounded-xl transition-all ${
                mode === "register"
                  ? "primary-glow text-on-primary hover:brightness-110 shadow-lg shadow-primary/20 disabled:opacity-40"
                  : "bg-surface-container text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high"
              }`}
            >
              {mode === "register" && loading
                ? "..."
                : serverName
                  ? `Join ${serverName}`
                  : "Register"}
            </button>
          </div>
        </form>

        {/* Download client — hidden on native builds (the user IS the native client).
            `__TAURI_INTERNALS__` is the canonical Tauri v2 global; see the
            comment in `client/src/api/serverUrl.ts` for the history. */}
        {!("__TAURI_INTERNALS__" in window) && (
        <div className="mt-8 text-center">
          {!showDownloads ? (
            <button
              onClick={() => setShowDownloads(true)}
              className="text-on-surface-variant hover:text-on-surface text-sm transition-colors font-label"
            >
              Download Client
            </button>
          ) : (
            <div className="flex justify-center gap-4 text-sm animate-[fadeSlideUp_0.3s_ease-out] font-label">
              <a href="/downloads/Concord Setup.exe" className="text-on-surface-variant hover:text-primary transition-colors">
                Windows
              </a>
              <span className="text-outline-variant">|</span>
              <a href="/downloads/Concord.AppImage" className="text-on-surface-variant hover:text-primary transition-colors">
                Linux
              </a>
              <span className="text-outline-variant">|</span>
              <a href="/downloads/Concord-mac.zip" className="text-on-surface-variant hover:text-primary transition-colors">
                macOS
              </a>
            </div>
          )}
        </div>
        )}
          </>
          /* end normal login/register */
        )}
        </>
        )}
      </div>
    </div>
  );
}
