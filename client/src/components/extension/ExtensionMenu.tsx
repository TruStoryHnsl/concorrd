import { useEffect, useState, type RefObject } from "react";
import { useExtensionStore, type ActiveExtension } from "../../stores/extension";

interface ExtensionMenuProps {
  open: boolean;
  onClose: () => void;
  activeExtension: ActiveExtension | null;
  onStart: (extensionId: string) => void;
  onStop: () => void;
  isHost: boolean;
  /** Ref to the trigger button — menu positions below it */
  anchorRef: RefObject<HTMLButtonElement | null>;
}

/** Shortens a Matrix user ID to just the localpart. */
function displayName(userId: string): string {
  return userId.split(":")[0].replace("@", "");
}

export default function ExtensionMenu({
  open,
  onClose,
  activeExtension,
  onStart,
  onStop,
  isHost,
  anchorRef,
}: ExtensionMenuProps) {
  const catalog = useExtensionStore((s) => s.catalog);
  const [pos, setPos] = useState({ top: 0, right: 0 });

  // Calculate position from anchor button
  useEffect(() => {
    if (!open || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    setPos({
      top: rect.bottom + 4,
      right: window.innerWidth - rect.right,
    });
  }, [open, anchorRef]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50" onClick={onClose} />

      {/* Menu — fixed position, escapes overflow:hidden ancestors */}
      <div
        className="fixed z-50 w-72 rounded-xl bg-surface-container border border-outline-variant/20 shadow-xl overflow-hidden"
        style={{ top: pos.top, right: pos.right }}
      >
        <div className="px-3 py-2 border-b border-outline-variant/20">
          <h3 className="text-sm font-headline font-semibold text-on-surface">
            Extensions
          </h3>
        </div>

        <div className="p-2">
          {catalog.map((ext) => {
            const isActive = activeExtension?.extensionId === ext.id;

            return (
              <div
                key={ext.id}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-surface-container-high/60 transition-colors"
              >
                <span className="material-symbols-outlined text-xl text-on-surface-variant flex-shrink-0">
                  {ext.icon}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-label font-medium text-on-surface truncate">
                    {ext.name}
                  </div>
                  {isActive ? (
                    <div className="text-xs text-primary font-label">
                      Active — hosted by {displayName(activeExtension!.hostUserId)}
                    </div>
                  ) : (
                    <div className="text-xs text-on-surface-variant font-label truncate">
                      {ext.description}
                    </div>
                  )}
                </div>
                {isActive ? (
                  isHost ? (
                    <button
                      onClick={() => {
                        onStop();
                        onClose();
                      }}
                      className="px-2 py-1 rounded-lg text-xs font-label text-error hover:bg-error/10 transition-colors flex-shrink-0"
                    >
                      Stop
                    </button>
                  ) : null
                ) : (
                  <button
                    onClick={() => {
                      onStart(ext.id);
                      onClose();
                    }}
                    className="px-2.5 py-1 rounded-lg text-xs font-label font-medium text-on-primary bg-primary hover:brightness-110 transition-all flex-shrink-0"
                  >
                    Start
                  </button>
                )}
              </div>
            );
          })}

          {catalog.length === 0 && (
            <div className="text-sm text-on-surface-variant text-center py-4 font-body">
              No extensions available
            </div>
          )}
        </div>
      </div>
    </>
  );
}
