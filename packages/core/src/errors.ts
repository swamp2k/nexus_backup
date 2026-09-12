export class NexusBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class JobNotFoundError extends NexusBackupError {}
export class DuplicateOperationError extends NexusBackupError {}
export class InvalidJobTransitionError extends NexusBackupError {}
export class LeaseConflictError extends NexusBackupError {}
export class LeaseExpiredError extends NexusBackupError {}
