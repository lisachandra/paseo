import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  AgentIdleEvictor,
  selectIdleEvictionTargets,
  type IdleEvictionAgent,
} from "./agent-idle-evictor.js";

const NOW_MS = Date.parse("2026-09-19T12:00:00.000Z");
const IDLE_MS = 60 * 60 * 1000;

function makeAgent(overrides: Partial<IdleEvictionAgent> = {}): IdleEvictionAgent {
  return {
    id: "agent-1",
    lifecycle: "idle",
    labels: {},
    pendingPermissionCount: 0,
    hasActiveForegroundTurn: false,
    lastActivityAt: new Date(NOW_MS - IDLE_MS - 1),
    ...overrides,
  };
}

function select(agents: readonly IdleEvictionAgent[], options?: { busyAgentIds?: string[] }) {
  const busy = new Set(options?.busyAgentIds ?? []);
  return selectIdleEvictionTargets({
    agents,
    nowMs: NOW_MS,
    idleMs: IDLE_MS,
    hasInFlightRun: (agentId) => busy.has(agentId),
  });
}

test("evicts agents whose last activity is older than the idle window", () => {
  const targets = select([
    makeAgent({ id: "stale" }),
    makeAgent({ id: "recent", lastActivityAt: new Date(NOW_MS - 60_000) }),
    makeAgent({ id: "exactly-at-window", lastActivityAt: new Date(NOW_MS - IDLE_MS) }),
  ]);

  expect(targets).toEqual(["stale", "exactly-at-window"]);
});

test("keeps agents resident while they can still produce work", () => {
  const targets = select([
    makeAgent({ id: "running", lifecycle: "running" }),
    makeAgent({ id: "initializing", lifecycle: "initializing" }),
    makeAgent({ id: "errored", lifecycle: "error" }),
    makeAgent({ id: "closed", lifecycle: "closed" }),
    makeAgent({ id: "turn-open", hasActiveForegroundTurn: true }),
    makeAgent({ id: "permission-pending", pendingPermissionCount: 1 }),
    makeAgent({ id: "internal", internal: true }),
  ]);

  expect(targets).toEqual([]);
});

test("keeps agents with an in-flight run", () => {
  const targets = select([makeAgent({ id: "queued" })], { busyAgentIds: ["queued"] });

  expect(targets).toEqual([]);
});

test("keeps agents with an open client tab label", () => {
  const targets = select([
    makeAgent({ id: "watched", labels: { "paseo.open-agent-tab.client-a": "true" } }),
    makeAgent({ id: "dismissed", labels: { "paseo.open-agent-tab.client-a": "false" } }),
    makeAgent({ id: "other-label", labels: { "paseo.parent-agent-id": "parent" } }),
  ]);

  expect(targets).toEqual(["dismissed", "other-label"]);
});

function createManager(agents: readonly IdleEvictionAgent[]) {
  const closed: string[] = [];
  const busy = new Set<string>();
  return {
    closed,
    busy,
    manager: {
      listIdleEvictionAgents: () => agents,
      hasInFlightRun: (agentId: string) => busy.has(agentId),
      closeAgent: async (agentId: string) => {
        closed.push(agentId);
      },
    },
  };
}

test("sweep closes every evictable runtime", async () => {
  const { closed, manager } = createManager([
    makeAgent({ id: "stale" }),
    makeAgent({ id: "recent", lastActivityAt: new Date(NOW_MS - 60_000) }),
  ]);
  const evictor = new AgentIdleEvictor({
    manager,
    logger: createTestLogger(),
    idleMs: IDLE_MS,
    now: () => NOW_MS,
  });

  const evicted = await evictor.sweep();

  expect(evicted).toEqual(["stale"]);
  expect(closed).toEqual(["stale"]);
});

test("a failing close does not stop the sweep", async () => {
  const { closed, manager } = createManager([
    makeAgent({ id: "broken" }),
    makeAgent({ id: "healthy" }),
  ]);
  manager.closeAgent = async (agentId: string) => {
    if (agentId === "broken") throw new Error("close failed");
    closed.push(agentId);
  };
  const evictor = new AgentIdleEvictor({
    manager,
    logger: createTestLogger(),
    idleMs: IDLE_MS,
    now: () => NOW_MS,
  });

  const evicted = await evictor.sweep();

  expect(evicted).toEqual(["healthy"]);
  expect(closed).toEqual(["healthy"]);
});

test("start sweeps on the configured interval and stop ends it", async () => {
  vi.useFakeTimers();
  try {
    const { closed, manager } = createManager([makeAgent({ id: "stale" })]);
    const evictor = new AgentIdleEvictor({
      manager,
      logger: createTestLogger(),
      idleMs: IDLE_MS,
      sweepIntervalMs: 30_000,
      now: () => NOW_MS,
    });

    evictor.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(closed).toEqual(["stale"]);

    evictor.stop();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(closed).toEqual(["stale"]);
  } finally {
    vi.useRealTimers();
  }
});
