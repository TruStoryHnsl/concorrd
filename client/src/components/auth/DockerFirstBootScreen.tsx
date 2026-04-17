import { ConcordLogo } from "../brand/ConcordLogo";

interface Props {
  /** Domain of this instance (from CONCORD_DOMAIN / CONDUWUIT_SERVER_NAME env). */
  instanceDomain: string;
  /** User chose to host — fall through to admin account creation (LoginForm first-boot path). */
  onHost: () => void;
  /** User chose to join an external server — show ServerPickerScreen. */
  onJoin: () => void;
}

/**
 * First-boot Host/Join picker for Docker/web deployments (INS-050).
 *
 * Shown when `/api/instance` returns `first_boot: true` on a non-native
 * (web/Docker) build. Gives the operator two paths:
 *
 *   "Host this server" — the browser is pointing at the Docker stack
 *   the operator just stood up. Proceed to admin account creation.
 *
 *   "Join a server" — the user doesn't want to host; they want to
 *   connect to a different Concord instance. Opens the normal
 *   ServerPickerScreen discovery flow.
 */
export function DockerFirstBootScreen({ instanceDomain, onHost, onJoin }: Props) {
  const displayDomain = instanceDomain || "localhost";

  return (
    <div className="h-full w-full flex flex-col items-center justify-center bg-surface mesh-background p-6">
      <div className="flex flex-col items-center gap-8 w-full max-w-md">
        <div className="flex flex-col items-center gap-3">
          <ConcordLogo size={48} />
          <h1 className="text-2xl font-semibold text-on-surface">Welcome to Concord</h1>
          <p className="text-sm text-on-surface-variant text-center">
            How do you want to use this instance?
          </p>
        </div>

        <div className="flex flex-col gap-4 w-full">
          {/* Host card */}
          <button
            onClick={onHost}
            className="flex flex-col gap-2 p-5 rounded-xl bg-surface-container border border-outline-variant hover:bg-surface-container-high transition-colors text-left cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <span className="text-base font-semibold text-on-surface">Host this server</span>
            </div>
            <p className="text-sm text-on-surface-variant">
              Set up this Concord instance as your server. You'll create the admin account next.
            </p>
            <div className="flex items-center gap-1.5 mt-1">
              <span className="text-xs text-on-surface-variant">Domain:</span>
              <code className="text-xs font-mono bg-surface-container-highest rounded px-1.5 py-0.5 text-primary">
                {displayDomain}
              </code>
            </div>
          </button>

          {/* Join card */}
          <button
            onClick={onJoin}
            className="flex flex-col gap-2 p-5 rounded-xl bg-surface-container border border-outline-variant hover:bg-surface-container-high transition-colors text-left cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <span className="text-base font-semibold text-on-surface">Join a server</span>
            </div>
            <p className="text-sm text-on-surface-variant">
              Connect to an existing Concord instance run by someone else.
            </p>
          </button>
        </div>
      </div>
    </div>
  );
}
