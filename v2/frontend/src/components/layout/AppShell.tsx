import { type ReactNode } from "react";
import { useLocation, Link } from "react-router-dom";
import { useWindowSize } from "@/hooks/useWindowSize";
import { usePlatform } from "@/hooks/usePlatform";
import BottomNav from "./BottomNav";
import TopBar from "./TopBar";
import WidgetView from "./WidgetView";
import VoiceConnectionBar from "@/components/voice/VoiceConnectionBar";
import ToastContainer from "@/components/ui/Toast";

interface AppShellProps {
  children: ReactNode;
}

function AppShell({ children }: AppShellProps) {
  const { tier } = useWindowSize();
  const { isMobile: isMobileDevice } = usePlatform();

  // Widget mode: render only the compact status widget
  if (tier === "widget") {
    return <WidgetView />;
  }

  // On mobile devices (iOS/Android), always use mobile layout regardless of
  // screen size tier — the device IS a phone/tablet.
  const forceMobileLayout = isMobileDevice;
  const showSidebar = !forceMobileLayout && tier === "desktop";
  const showBottomNav = forceMobileLayout || tier === "mobile";
  const compactTopBar = forceMobileLayout || tier === "compact";

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-on-surface overflow-hidden">
      {/* Top bar — safe-top adds padding for iOS notch */}
      <div className={isMobileDevice ? "safe-top bg-surface-container-low" : ""}>
        <TopBar compact={compactTopBar} />
      </div>

      {/* Main content area */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Desktop sidebar */}
        {showSidebar && (
          <aside className="flex w-16 flex-col items-center gap-2 py-3 bg-surface-container-low border-r border-outline-variant/30 shrink-0">
            <NavIcon icon="hub" href="/" label="Home" matchExact />
            <NavIcon icon="forum" href="/forum" label="Forums" />
            <NavIcon icon="dns" href="/servers" label="Servers" matchPrefixes={["/servers", "/server/"]} />
            <NavIcon icon="chat" href="/direct" label="Direct" />
            <NavIcon icon="group" href="/friends" label="Friends" />
            <NavIcon icon="map" href="/map" label="Map" />
            <div className="flex-1" />
            <NavIcon icon="add_circle" href="/host" label="Host" />
            <NavIcon icon="monitor_heart" href="/health" label="Health" />
            <NavIcon icon="settings_input_component" href="/settings" label="Settings" />
          </aside>
        )}

        {/* Page content — safe-x for landscape orientation on mobile */}
        <main className={`flex-1 min-h-0 min-w-0 overflow-y-auto ${isMobileDevice ? "safe-x" : ""}`}>
          {children}
        </main>
      </div>

      {/* Voice connection bar -- visible on all pages when connected */}
      <VoiceConnectionBar compact={tier === "compact" || isMobileDevice} />

      {/* Bottom nav — safe-bottom adds padding for iOS home indicator */}
      <div className={isMobileDevice ? "safe-bottom bg-surface-container-low" : ""}>
        <BottomNav visible={showBottomNav} />
      </div>

      {/* Toast notifications */}
      <ToastContainer />
    </div>
  );
}

function NavIcon({
  icon,
  href,
  label,
  matchExact = false,
  matchPrefixes,
}: {
  icon: string;
  href: string;
  label: string;
  matchExact?: boolean;
  matchPrefixes?: string[];
}) {
  const location = useLocation();

  let isActive: boolean;
  if (matchPrefixes) {
    isActive = matchPrefixes.some((prefix) => location.pathname.startsWith(prefix));
  } else if (matchExact) {
    isActive = location.pathname === href;
  } else {
    isActive =
      (location.pathname.startsWith(href) && href !== "/") ||
      location.pathname === href;
  }

  return (
    <Link
      to={href}
      title={label}
      className={`flex items-center justify-center w-10 h-10 rounded-xl transition-all duration-200 ${
        isActive
          ? "bg-primary/20 text-primary"
          : "text-on-surface-variant hover:text-on-surface hover:bg-surface-container"
      }`}
    >
      <span className="material-symbols-outlined text-xl">{icon}</span>
    </Link>
  );
}

export default AppShell;
