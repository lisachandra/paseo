import type { Agent } from "@/stores/session-store";

export type CloseAgentTabPolicy = { kind: "archive-on-close" } | { kind: "layout-only" };

export type CloseAgentTabReason = "user-tab-close" | "window-close" | "quit";

export function resolveCloseAgentTabPolicy(
  agent: Pick<Agent, "parentAgentId"> | null | undefined,
  reason: CloseAgentTabReason = "user-tab-close",
): CloseAgentTabPolicy {
  // Closing the window / quitting the app should never archive — it is a layout hide.
  // Only an explicit tab X (user-tab-close) on a root agent archives. This prevents
  // idle Dirac roots from silently archiving when the desktop window is closed.
  if (reason === "window-close" || reason === "quit") {
    return { kind: "layout-only" };
  }
  if (agent?.parentAgentId) {
    return { kind: "layout-only" };
  }

  return { kind: "archive-on-close" };
}
