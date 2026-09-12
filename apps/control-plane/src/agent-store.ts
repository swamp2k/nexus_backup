import type { D1Database } from "./d1-types.js";

interface AgentRow {
  id: string;
  name: string | null;
  token_hash: string;
  enabled: number;
  created_at: string;
  last_seen_at: string | null;
  version: string | null;
}

export interface AgentRecord {
  id: string;
  name: string | null;
  enabled: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  version: string | null;
}

export class D1AgentStore {
  readonly #db: D1Database;
  constructor(db: D1Database) { this.#db = db; }

  async register(id: string, name: string | null, rawToken: string, now: Date): Promise<AgentRecord> {
    const tokenHash = await hashAgentToken(rawToken);
    const iso = now.toISOString();
    const result = await this.#db.prepare(`
      INSERT INTO backup_agents (id, name, token_hash, enabled, created_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        token_hash = excluded.token_hash,
        enabled = 1
      RETURNING *
    `).bind(id, name, tokenHash, iso).all<AgentRow>();
    const row = result.results?.[0];
    if (!row) throw new Error("D1 did not return the registered agent");
    return rowToAgent(row);
  }

  async findByRawToken(rawToken: string): Promise<AgentRecord | null> {
    const hash = await hashAgentToken(rawToken);
    const row = await this.#db.prepare(`
      SELECT * FROM backup_agents WHERE token_hash = ? AND enabled = 1
    `).bind(hash).first<AgentRow>();
    return row ? rowToAgent(row) : null;
  }

  async touch(agentId: string, now: Date, version?: string): Promise<void> {
    if (version === undefined) {
      await this.#db.prepare("UPDATE backup_agents SET last_seen_at = ? WHERE id = ?").bind(now.toISOString(), agentId).run();
      return;
    }
    await this.#db.prepare("UPDATE backup_agents SET last_seen_at = ?, version = ? WHERE id = ?").bind(now.toISOString(), version, agentId).run();
  }
}

export async function hashAgentToken(rawToken: string): Promise<string> {
  const bytes = new TextEncoder().encode(rawToken);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rowToAgent(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    version: row.version,
  };
}
