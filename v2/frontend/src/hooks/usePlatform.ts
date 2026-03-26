import { useState, useEffect } from "react";
import { platform as tauriPlatform } from "@tauri-apps/plugin-os";

export type Platform = "ios" | "android" | "macos" | "windows" | "linux" | "web";

interface PlatformInfo {
  platform: Platform;
  isMobile: boolean;
  isIOS: boolean;
  isAndroid: boolean;
  isDesktop: boolean;
}

export function usePlatform(): PlatformInfo {
  const [plat, setPlat] = useState<Platform>("web");

  useEffect(() => {
    try {
      const p = tauriPlatform() as Platform;
      setPlat(p);
    } catch {
      // Fallback: not running in Tauri (browser guest mode)
      setPlat("web");
    }
  }, []);

  return {
    platform: plat,
    isMobile: plat === "ios" || plat === "android",
    isIOS: plat === "ios",
    isAndroid: plat === "android",
    isDesktop: plat === "macos" || plat === "windows" || plat === "linux",
  };
}
