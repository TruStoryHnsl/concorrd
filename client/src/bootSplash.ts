const BOOT_SPLASH_ID = "boot-splash";
const BOOT_SPLASH_STATUS_ID = "boot-splash-status";

export function getBootSplashWaitingLabel(
  host = typeof window !== "undefined" ? window.location.host : "host",
): string {
  return `Waiting for ${host}`;
}

function getBootSplash(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.getElementById(BOOT_SPLASH_ID);
}

function getBootSplashStatus(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.getElementById(BOOT_SPLASH_STATUS_ID);
}

export function showBootSplash(statusText = getBootSplashWaitingLabel()): void {
  const splash = getBootSplash();
  if (!splash) return;
  const status = getBootSplashStatus();
  if (status) status.textContent = statusText;
  splash.setAttribute("data-state", "visible");
}

export function handoffBootSplash(): void {
  const splash = getBootSplash();
  if (!splash) return;
  splash.setAttribute("data-state", "handoff");
}
