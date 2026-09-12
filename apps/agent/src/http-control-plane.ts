import type { BackupJob } from "@nexus-backup/core";
import type { ControlPlaneClient, LeaseGrant } from "./control-plane.js";

export interface HttpControlPlaneClientOptions {
  baseUrl: string;
  agentToken: string;
  leaseTtlMs?: number;
  version?: string;
  fetchImpl?: typeof fetch;
}

export class HttpControlPlaneClient implements ControlPlaneClient {
  readonly #baseUrl: string;
  readonly #agentToken: string;
  readonly #leaseTtlMs: number | undefined;
  readonly #version: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: HttpControlPlaneClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#agentToken = options.agentToken;
    this.#leaseTtlMs = options.leaseTtlMs;
    this.#version = options.version;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async claim(_agentId: string): Promise<LeaseGrant | null> {
    const body: Record<string, unknown> = {};
    if (this.#leaseTtlMs !== undefined) body.leaseTtlMs = this.#leaseTtlMs;
    if (this.#version !== undefined) body.version = this.#version;
    const response = await this.#request("/v1/agent/claim", body);
    if (response.status === 204) return null;
    return await response.json() as LeaseGrant;
  }

  async heartbeat(jobId: string, _agentId: string, leaseToken: string): Promise<void> {
    const body: Record<string, unknown> = { leaseToken };
    if (this.#leaseTtlMs !== undefined) body.leaseTtlMs = this.#leaseTtlMs;
    await this.#request(`/v1/agent/jobs/${encodeURIComponent(jobId)}/heartbeat`, body);
  }

  async transition(jobId: string, _agentId: string, leaseToken: string, state: BackupJob["state"], error?: string): Promise<void> {
    const body: Record<string, unknown> = { leaseToken, state };
    if (error !== undefined) body.error = error;
    await this.#request(`/v1/agent/jobs/${encodeURIComponent(jobId)}/transition`, body);
  }

  async runtimeEvents(jobId: string, _agentId: string, leaseToken: string, events: readonly unknown[]): Promise<void> {
    if (events.length === 0) return;
    await this.#request(`/v1/agent/jobs/${encodeURIComponent(jobId)}/runtime`, { leaseToken, events });
  }

  async #request(path: string, body: unknown): Promise<Response> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#agentToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (response.ok || response.status === 204) return response;
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json() as { message?: string; code?: string };
      message = payload.message ?? payload.code ?? message;
    } catch {
      // Keep HTTP fallback.
    }
    throw new Error(`Control plane request failed: ${message}`);
  }
}
