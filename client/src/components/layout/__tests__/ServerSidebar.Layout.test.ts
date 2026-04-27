// @ts-nocheck
import { describe, expect, it } from "vitest";
import serverSidebarSource from "../ServerSidebar.tsx?raw";
import sourcesPanelSource from "../SourcesPanel.tsx?raw";

describe("rail layout contracts", () => {
  it("keeps the server rail on a unified draggable order with a movable add tile anchor", () => {
    expect(serverSidebarSource).toContain('const ADD_SERVER_TILE_ID = "__add_server_tile__";');
    expect(serverSidebarSource).toContain("const topRailIds = useMemo");
    expect(serverSidebarSource).toContain("const bottomRailIds = useMemo");
    expect(serverSidebarSource).toContain("renderMobileRailItem");
    expect(serverSidebarSource).toContain("renderDesktopRailItem");
  });

  it("keeps the source rail on a unified draggable order with a movable add tile anchor", () => {
    expect(sourcesPanelSource).toContain('const ADD_SOURCE_TILE_ID = "__add_source_tile__";');
    expect(sourcesPanelSource).toContain("const topRailIds = useMemo");
    expect(sourcesPanelSource).toContain("const bottomRailIds = useMemo");
    expect(sourcesPanelSource).toContain("SortableAddSourceTile");
  });

  it("leaves the DM and Explore tiles outside the sortable rail order", () => {
    expect(serverSidebarSource).toContain("title=\"Direct Messages\"");
    expect(serverSidebarSource).not.toContain("ADD_DM_TILE_ID");
    expect(sourcesPanelSource).toContain("title=\"Explore\"");
    expect(sourcesPanelSource).not.toContain("ADD_EXPLORE_TILE_ID");
  });

  it("constrains draggable rails to vertical motion only", () => {
    expect(serverSidebarSource).toContain("const constrainedTransform = transform ? { ...transform, x: 0 } : null;");
    expect(sourcesPanelSource).toContain("const constrainedTransform = transform ? { ...transform, x: 0 } : null;");
    expect(serverSidebarSource).toContain("modifiers={[restrictToVerticalAxis]}");
    expect(sourcesPanelSource).toContain("modifiers={[restrictToVerticalAxis]}");
  });

  it("keeps the source rail compact after the shell-size rollback", () => {
    expect(sourcesPanelSource).toContain("className={`group w-8 h-8");
    expect(sourcesPanelSource).toContain("className=\"w-8 h-8 rounded-xl");
    expect(sourcesPanelSource).toContain("size={28}");
  });

  it("keeps the rails separated with explicit source/server edge spacing", () => {
    expect(sourcesPanelSource).toContain("pl-[3px]");
    expect(serverSidebarSource).toContain("w-[51px] pr-[3px] bg-surface");
    expect(serverSidebarSource).toContain("gap-2");
  });
});
