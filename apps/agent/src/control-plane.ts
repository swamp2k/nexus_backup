import type { BackupJob } from "@nexus-backup/core";

export interface LeaseGrant {
  job: BackupJob;
  leaseToken: string;
  leaseTtlMs: number;
}

export interface ControlPlaneClient {
  claim(agentId: string): Promise<LeaseGrant | null>;
  heartbeat(jobId: string, agentId: string, leaseToken: string): Promise<void>;
  transition(jobId: string, agentId: string, leaseToken: string, state: BackupJob["state"], error?: string): Promise<void>;
}
