import type { Logger } from "pino";

import type { ManagedAgent } from "./agent-manager.js";

/**
 * Runtime residency: an unarchived agent can stay `closed` and resumable, so the daemon is free to
 * release a provider process it no longer needs. Eviction picks agents that cannot produce anything
 * and that no client is looking at, and closes their runtime. The next prompt or timeline request
 * resumes them through `ensureAgentLoaded()` under the same Paseo agent ID.
 *
 * Residency defaults to indefinite (see docs/agent-lifecycle.md); the daemon only sweeps when
 * `PASEO_IDLE_AGENT_EVICTION_MINUTES` turns this on.
 */

const OPEN_AGENT_TAB_LABEL_PREFIX = "paseo.open-agent-tab.";

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/** Everything the eviction policy needs from a live agent, so the policy stays testable. */
export interface IdleEvictionAgent {
  id: string;
  lifecycle: ManagedAgent["lifecycle"];
  internal?: boolean;
  labels: Record<string, string>;
  pendingPermissionCount: number;
  hasActiveForegroundTurn: boolean;
  lastActivityAt: Date;
}

export interface IdleEvictionManager {
  listIdleEvictionAgents(): readonly IdleEvictionAgent[];
  hasInFlightRun(agentId: string): boolean;
  closeAgent(agentId: string): Promise<void>;
}

function hasOpenTab(labels: Record<string, string>): boolean {
  return Object.entries(labels).some(
    ([key, value]) => key.startsWith(OPEN_AGENT_TAB_LABEL_PREFIX) && value === "true",
  );
}

/**
 * Last time the agent did anything. `updatedAt` moves on every lifecycle and stream transition, and
 * a user message arriving after a turn started lands after it, so the newer of the two is enough.
 */
function lastActivityAt(agent: ManagedAgent): Date {
  const lastUserMessageAt = agent.lastUserMessageAt;
  if (!lastUserMessageAt || lastUserMessageAt.getTime() <= agent.updatedAt.getTime()) {
    return agent.updatedAt;
  }
  return lastUserMessageAt;
}

export function toIdleEvictionAgent(agent: ManagedAgent): IdleEvictionAgent {
  return {
    id: agent.id,
    lifecycle: agent.lifecycle,
    internal: agent.internal,
    labels: agent.labels,
    pendingPermissionCount: agent.pendingPermissions.size,
    hasActiveForegroundTurn: agent.activeForegroundTurnId !== null,
    lastActivityAt: lastActivityAt(agent),
  };
}

export interface IdleEvictionPolicyInput {
  agents: readonly IdleEvictionAgent[];
  nowMs: number;
  idleMs: number;
  hasInFlightRun: (agentId: string) => boolean;
}

/**
 * Evict only agents that are provably done and unwatched:
 * idle lifecycle, no foreground turn, no in-flight run, no permission waiting on the user, no
 * client-owned open tab, and no activity inside the idle window.
 */
export function selectIdleEvictionTargets(input: IdleEvictionPolicyInput): string[] {
  const { agents, nowMs, idleMs, hasInFlightRun } = input;
  const targets: string[] = [];

  for (const agent of agents) {
    if (agent.lifecycle !== "idle") continue;
    if (agent.internal) continue;
    if (agent.hasActiveForegroundTurn) continue;
    if (agent.pendingPermissionCount > 0) continue;
    if (hasOpenTab(agent.labels)) continue;
    if (hasInFlightRun(agent.id)) continue;
    if (nowMs - agent.lastActivityAt.getTime() < idleMs) continue;
    targets.push(agent.id);
  }

  return targets;
}

export interface AgentIdleEvictorOptions {
  manager: IdleEvictionManager;
  logger: Logger;
  idleMs: number;
  sweepIntervalMs?: number;
  now?: () => number;
}

export class AgentIdleEvictor {
  private readonly manager: IdleEvictionManager;
  private readonly logger: Logger;
  private readonly idleMs: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private sweepInFlight: Promise<string[]> | null = null;

  constructor(options: AgentIdleEvictorOptions) {
    this.manager = options.manager;
    this.logger = options.logger;
    this.idleMs = options.idleMs;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer || this.idleMs <= 0) {
      return;
    }
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.sweepIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Closes every evictable runtime and returns the agent ids that were released. */
  async sweep(): Promise<string[]> {
    if (this.sweepInFlight) {
      return this.sweepInFlight;
    }
    const sweep = this.runSweep();
    this.sweepInFlight = sweep;
    try {
      return await sweep;
    } finally {
      this.sweepInFlight = null;
    }
  }

  private async runSweep(): Promise<string[]> {
    const targets = selectIdleEvictionTargets({
      agents: this.manager.listIdleEvictionAgents(),
      nowMs: this.now(),
      idleMs: this.idleMs,
      hasInFlightRun: (agentId) => this.manager.hasInFlightRun(agentId),
    });

    const evicted: string[] = [];
    for (const agentId of targets) {
      try {
        await this.manager.closeAgent(agentId);
        evicted.push(agentId);
      } catch (error) {
        // A concurrent lifecycle action may have claimed the agent first; the next sweep retries.
        this.logger.warn({ err: error, agentId }, "Failed to close idle agent runtime");
      }
    }

    if (evicted.length > 0) {
      this.logger.info(
        { agentIds: evicted, idleMs: this.idleMs },
        "Closed idle agent runtimes to release provider processes",
      );
    }

    return evicted;
  }
}
