import { type ReactNode } from "react";
import { useLocation, Link } from "react-router-dom";
import { useWindowSize } from "@/hooks/useWindowSize";
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

  // Widget mode: render only the compact status widget
  if (tier === "widget") {
    return <WidgetView />;
  }

  const showSidebar = tier === "desktop";
  const showBottomNav = tier === "mobile";
  const compactTopBar = tier === "compact";

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-on-surface overflow-hidden">
      {/* Top bar */}
      <TopBar compact={compactTopBar} />

      {/* Main content area */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Desktop sidebar */}
        {showSidebar && (
          <aside className="flex w-16 flex-col items-center gap-2 py-3 bg-surface-container-low border-r border-outline-variant/30 shrink-0">
            <NavIcon icon="hub" href="/" label="Dashboard" />
            <NavIcon icon="share_reviews" href="/" label="Nodes" matchExact />
            <NavIcon icon="group" href="/friends" label="Friends" />
            <NavIcon icon="map" href="/map" label="Map" />
            <div className="flex-1" />
            <NavIcon icon="add_circle" href="/host" label="Host" />
            <NavIcon icon="monitor_heart" href="/health" label="Health" />
            <NavIcon icon="settings_input_component" href="/settings" label="Settings" />
          </aside>
        )}

        {/* Page content */}
        <main className="flex-1 min-h-0 min-w-0 overflow-y-auto">
          {children}
        </main>
      </div>

      {/* Voice connection bar -- visible on all pages when connected */}
      <VoiceConnectionBar compact={tier === "compact"} />

      {/* Mobile bottom nav -- only in mobile tier (500-768px) */}
      <BottomNav visible={showBottomNav} />

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
}: {
  icon: string;
  href: string;
  label: string;
  matchExact?: boolean;
}) {
  const location = useLocation();
  const isActive = matchExact
    ? location.pathname === href
    : (location.pathname.startsWith(href) && href !== "/") || location.pathname === href;

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
