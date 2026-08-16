import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "../atomic-file.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineStore,
} from "./agent-timeline-store-types.js";

interface FileTimelineState {
  epoch: string;
  rows: AgentTimelineRow[];
  nextSeq: number;
}

const DEFAULT_TIMELINE_FETCH_LIMIT = 200;

function cloneRow(row: AgentTimelineRow): AgentTimelineRow {
  return { ...row };
}

interface FetchContext {
  state: FileTimelineState;
  direction: NonNullable<AgentTimelineFetchOptions["direction"]>;
  limit: number;
  selectAll: boolean;
  cursor: AgentTimelineFetchOptions["cursor"];
  minSeq: number;
  maxSeq: number;
  window: { minSeq: number; maxSeq: number; nextSeq: number };
}

function fetchTail(ctx: FetchContext): AgentTimelineFetchResult {
  const { state, direction, limit, selectAll, minSeq, window } = ctx;
  const selected =
    selectAll || limit >= state.rows.length
      ? state.rows
      : state.rows.slice(state.rows.length - limit);
  return {
    epoch: state.epoch,
    direction,
    reset: false,
    staleCursor: false,
    gap: false,
    window,
    hasOlder: selected.length > 0 && selected[0].seq > minSeq,
    hasNewer: false,
    rows: selected.map(cloneRow),
  };
}

function fetchAfter(ctx: FetchContext): AgentTimelineFetchResult {
  const { state, direction, limit, selectAll, cursor, minSeq, maxSeq, window } = ctx;
  const baseSeq = cursor?.seq ?? 0;
  const startIdx = state.rows.findIndex((row) => row.seq > baseSeq);
  if (startIdx < 0) {
    return {
      epoch: state.epoch,
      direction,
      reset: false,
      staleCursor: false,
      gap: false,
      window,
      hasOlder: baseSeq >= minSeq,
      hasNewer: false,
      rows: [],
    };
  }
  const selected = selectAll
    ? state.rows.slice(startIdx)
    : state.rows.slice(startIdx, startIdx + limit);
  const lastSelected = selected[selected.length - 1];
  return {
    epoch: state.epoch,
    direction,
    reset: false,
    staleCursor: false,
    gap: false,
    window,
    hasOlder: selected[0].seq > minSeq,
    hasNewer: lastSelected != null && lastSelected.seq < maxSeq,
    rows: selected.map(cloneRow),
  };
}

function fetchBefore(ctx: FetchContext): AgentTimelineFetchResult {
  const { state, direction, limit, selectAll, cursor, minSeq, window } = ctx;
  const beforeSeq = cursor?.seq ?? state.nextSeq;
  const endExclusive = state.rows.findIndex((row) => row.seq >= beforeSeq);
  const boundedRows = endExclusive < 0 ? state.rows : state.rows.slice(0, endExclusive);
  const selected =
    selectAll || limit >= boundedRows.length
      ? boundedRows
      : boundedRows.slice(boundedRows.length - limit);
  return {
    epoch: state.epoch,
    direction,
    reset: false,
    staleCursor: false,
    gap: false,
    window,
    hasOlder: selected.length > 0 && selected[0].seq > minSeq,
    hasNewer: endExclusive >= 0,
    rows: selected.map(cloneRow),
  };
}

function fetchReset(
  ctx: FetchContext,
  flags: { staleCursor: boolean; gap: boolean },
): AgentTimelineFetchResult {
  const { state, direction, limit, selectAll, minSeq, window } = ctx;
  const rows =
    selectAll || limit >= state.rows.length
      ? state.rows.map(cloneRow)
      : state.rows.slice(state.rows.length - limit).map(cloneRow);
  return {
    epoch: state.epoch,
    direction,
    reset: true,
    staleCursor: flags.staleCursor,
    gap: flags.gap,
    window,
    hasOlder: rows.length > 0 && rows[0].seq > minSeq,
    hasNewer: false,
    rows,
  };
}

export class FileAgentTimelineStore implements AgentTimelineStore {
  private readonly baseDir: string;
  private readonly pending = new Map<string, Promise<void>>();
  private readonly cache = new Map<string, FileTimelineState | null>();

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private filePath(agentId: string): string {
    // Use flat file per agentId to avoid cwd-encoded directory complexity.
    // AgentIds are UUIDs, safe for filenames.
    return path.join(this.baseDir, `${agentId}.json`);
  }

  private async loadState(agentId: string): Promise<FileTimelineState | null> {
    if (this.cache.has(agentId)) {
      return this.cache.get(agentId) ?? null;
    }
    const file = this.filePath(agentId);
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as FileTimelineState;
      // Validate shape
      if (
        typeof parsed.epoch !== "string" ||
        typeof parsed.nextSeq !== "number" ||
        !Array.isArray(parsed.rows)
      ) {
        this.cache.set(agentId, null);
        return null;
      }
      const state: FileTimelineState = {
        epoch: parsed.epoch,
        nextSeq: parsed.nextSeq,
        rows: parsed.rows,
      };
      this.cache.set(agentId, state);
      return state;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.cache.set(agentId, null);
        return null;
      }
      // Corrupt file: treat as empty but don't delete automatically
      this.cache.set(agentId, null);
      return null;
    }
  }

  private async saveState(agentId: string, state: FileTimelineState): Promise<void> {
    this.cache.set(agentId, state);
    const file = this.filePath(agentId);
    await writeFileAtomic(file, JSON.stringify(state, null, 2));
  }

  private queue<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.pending.get(agentId) ?? Promise.resolve();
    let nextResolve!: (v: T) => void;
    let nextReject!: (e: unknown) => void;
    const next = new Promise<T>((resolve, reject) => {
      nextResolve = resolve;
      nextReject = reject;
    });
    const task = prev
      .catch(() => undefined)
      .then(() => fn())
      .then(
        (v) => nextResolve(v),
        (e) => nextReject(e),
      )
      .finally(() => {
        if (this.pending.get(agentId) === task) {
          this.pending.delete(agentId);
        }
      });
    // task is void promise for queue tracking
    const voidTask: Promise<void> = task.then(() => undefined, () => undefined);
    this.pending.set(agentId, voidTask);
    return next;
  }

  async appendCommitted(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string },
  ): Promise<AgentTimelineRow> {
    return this.queue(agentId, async () => {
      let state = await this.loadState(agentId);
      if (!state) {
        state = { epoch: randomUUID(), rows: [], nextSeq: 1 };
      }
      const row: AgentTimelineRow = {
        seq: state.nextSeq,
        timestamp: options?.timestamp ?? new Date().toISOString(),
        item,
      };
      state.nextSeq += 1;
      state.rows.push(row);
      await this.saveState(agentId, state);
      return cloneRow(row);
    });
  }

  async fetchCommitted(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult> {
    const state = (await this.loadState(agentId)) ?? {
      epoch: randomUUID(),
      rows: [],
      nextSeq: 1,
    };
    const direction = options?.direction ?? "tail";
    const requestedLimit = options?.limit;
    const limit =
      requestedLimit === undefined
        ? DEFAULT_TIMELINE_FETCH_LIMIT
        : Math.max(0, Math.floor(requestedLimit));
    const cursor = options?.cursor;
    const minSeq = state.rows.length ? state.rows[0].seq : 0;
    const maxSeq = state.rows.length ? state.rows[state.rows.length - 1].seq : 0;
    const selectAll = limit === 0;
    const window = { minSeq, maxSeq, nextSeq: state.nextSeq };
    const ctx: FetchContext = {
      state,
      direction,
      limit,
      selectAll,
      cursor,
      minSeq,
      maxSeq,
      window,
    };
    if (cursor && typeof cursor.epoch === "string" && cursor.epoch !== state.epoch) {
      return fetchReset(ctx, { staleCursor: true, gap: false });
    }
    if (direction === "after" && cursor && state.rows.length > 0 && cursor.seq < minSeq - 1) {
      return fetchReset(ctx, { staleCursor: false, gap: true });
    }
    if (state.rows.length === 0) {
      return {
        epoch: state.epoch,
        direction,
        reset: false,
        staleCursor: false,
        gap: false,
        window,
        hasOlder: false,
        hasNewer: false,
        rows: [],
      };
    }
    if (direction === "tail") return fetchTail(ctx);
    if (direction === "after") return fetchAfter(ctx);
    return fetchBefore(ctx);
  }

  async getLatestCommittedSeq(agentId: string): Promise<number> {
    const state = await this.loadState(agentId);
    if (!state || state.rows.length === 0) return 0;
    return state.rows[state.rows.length - 1].seq;
  }

  async getCommittedRows(agentId: string): Promise<AgentTimelineRow[]> {
    const state = await this.loadState(agentId);
    if (!state) return [];
    return state.rows.map(cloneRow);
  }

  async getLastItem(agentId: string): Promise<AgentTimelineItem | null> {
    const state = await this.loadState(agentId);
    if (!state || state.rows.length === 0) return null;
    return state.rows[state.rows.length - 1].item;
  }

  async getLastAssistantMessage(agentId: string): Promise<string | null> {
    const state = await this.loadState(agentId);
    if (!state) return null;
    const rows = state.rows;
    const chunks: string[] = [];
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const item = rows[i].item;
      if (item.type !== "assistant_message") {
        if (chunks.length > 0) break;
        continue;
      }
      chunks.push(item.text);
    }
    if (chunks.length === 0) return null;
    return chunks.toReversed().join("");
  }

  async deleteAgent(agentId: string): Promise<void> {
    return this.queue(agentId, async () => {
      this.cache.delete(agentId);
      const file = this.filePath(agentId);
      try {
        await fs.unlink(file);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw error;
      }
    });
  }

  async bulkInsert(agentId: string, rows: readonly AgentTimelineRow[]): Promise<void> {
    if (rows.length === 0) return;
    return this.queue(agentId, async () => {
      let state = await this.loadState(agentId);
      if (!state) {
        state = { epoch: randomUUID(), rows: [], nextSeq: 1 };
      }
      // Merge rows, preserving seq order. If epoch differs from incoming, we keep existing epoch.
      // Rows are expected to be sorted by seq.
      for (const row of rows) {
        // Avoid duplicate seq
        if (state.rows.some((r) => r.seq === row.seq)) continue;
        state.rows.push(cloneRow(row));
      }
      state.rows.sort((a, b) => a.seq - b.seq);
      const maxSeq = state.rows.length ? state.rows[state.rows.length - 1].seq : 0;
      state.nextSeq = Math.max(state.nextSeq, maxSeq + 1);
      // If inserted rows carry epoch info via external, we keep our epoch; epoch is per-store lifecycle
      await this.saveState(agentId, state);
    });
  }

  async updateCommittedRow(agentId: string, row: AgentTimelineRow): Promise<void> {
    return this.queue(agentId, async () => {
      const state = await this.loadState(agentId);
      if (!state) return;
      const idx = state.rows.findIndex((r) => r.seq === row.seq);
      if (idx < 0) return;
      state.rows[idx] = cloneRow(row);
      await this.saveState(agentId, state);
    });
  }
}
