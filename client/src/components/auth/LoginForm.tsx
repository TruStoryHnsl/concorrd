import { useState, useEffect } from "react";
import { loginWithPassword } from "../../api/matrix";
import { registerUser, validateInvite, getInstanceInfo } from "../../api/concorrd";
import { useAuthStore } from "../../stores/auth";
import { INVITE_STORAGE_KEY } from "../../App";

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

  // Fetch instance name
  useEffect(() => {
    getInstanceInfo()
      .then((info) => {
        setInstanceName(info.name);
        document.title = info.name;
      })
      .catch(() => {});
  }, []);

  // Check URL and sessionStorage for invite token
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token =
      params.get("invite") || sessionStorage.getItem(INVITE_STORAGE_KEY);
    if (token) {
      setInviteToken(token);
      setMode("register");
      setValidatingInvite(true);
      validateInvite(token)
        .then((result) => {
          if (result.valid) {
            setServerName(result.server_name);
          } else {
            // Invite is invalid but user can still register without it
            setInviteToken("");
            setError("Invite link is invalid or expired — you can still create an account");
          }
        })
        .catch(() => {
          setInviteToken("");
          setError("Failed to validate invite link — you can still create an account");
        })
        .finally(() => {
          setValidatingInvite(false);
        });
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      if (mode === "login") {
        const result = await loginWithPassword(username, password);
        login(result.accessToken, result.userId, result.deviceId);
      } else {
        const result = await registerUser(
          username,
          password,
          inviteToken || undefined,
        );
        login(result.access_token, result.user_id, result.device_id);
        // Clear invite from URL and sessionStorage
        sessionStorage.removeItem(INVITE_STORAGE_KEY);
        window.history.replaceState({}, "", window.location.pathname);
      }
    } catch (err: unknown) {
      const error = err as { message?: string; data?: { error?: string } };
      // matrix-js-sdk errors have data.error, our API errors have message
      setError(error.data?.error || error.message || "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-900 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <h1 className="text-3xl font-bold text-white text-center mb-2">
          {instanceName}
        </h1>

        {validatingInvite && (
          <p className="text-center text-zinc-400 text-sm mb-6 mt-6">
            Validating invite...
          </p>
        )}

        {!validatingInvite && serverName && (
          <p className="text-center text-indigo-400 text-sm mb-6">
            You've been invited to <strong>{serverName}</strong>
          </p>
        )}

        {!validatingInvite && (
          <div className="flex mb-6 mt-6 bg-zinc-800 rounded-lg p-1">
            <button
              type="button"
              onClick={() => setMode("login")}
              className={`flex-1 py-2 rounded-md text-sm font-medium transition-colors ${
                mode === "login"
                  ? "bg-zinc-700 text-white"
                  : "text-zinc-400 hover:text-white"
              }`}
            >
              Login
            </button>
            <button
              type="button"
              onClick={() => setMode("register")}
              className={`flex-1 py-2 rounded-md text-sm font-medium transition-colors ${
                mode === "register"
                  ? "bg-zinc-700 text-white"
                  : "text-zinc-400 hover:text-white"
              }`}
            >
              Register
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="text"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full px-4 py-3 bg-zinc-800 border border-zinc-700 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500"
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-3 bg-zinc-800 border border-zinc-700 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500"
            required
          />
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button
            type="submit"
            disabled={loading || validatingInvite}
            className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white font-medium rounded-lg transition-colors"
          >
            {loading
              ? "..."
              : validatingInvite
                ? "..."
                : mode === "login"
                  ? "Login"
                  : serverName
                    ? `Join ${serverName}`
                    : "Create Account"}
          </button>
        </form>

        <div className="mt-8 flex justify-center gap-4 text-sm">
          <a
            href="/downloads/Concord Setup.exe"
            className="text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Windows
          </a>
          <span className="text-zinc-700">|</span>
          <a
            href="/downloads/Concord.AppImage"
            className="text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Linux
          </a>
          <span className="text-zinc-700">|</span>
          <a
            href="/downloads/Concord-mac.zip"
            className="text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            macOS
          </a>
        </div>
      </div>
    </div>
  );
}
