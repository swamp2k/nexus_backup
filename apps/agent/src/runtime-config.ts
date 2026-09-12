export interface LocalBackupSource {
  id: string;
  paths: readonly string[];
}

export interface LocalResticRepository {
  id: string;
  repository: string;
  passwordFile?: string;
  environment?: Readonly<Record<string, string>>;
}

export interface LocalRcloneEndpoint {
  id: string;
  fs: string;
  /** Destructive rclone move jobs are rejected unless the source endpoint explicitly opts in. */
  allowMove?: boolean;
}

export interface AgentToolConfig {
  resticBinary?: string;
  rcloneBinary?: string;
  rcloneConfigPath?: string;
  rcloneArgs?: readonly string[];
}

export interface AgentRuntimeConfig {
  source(id: string): LocalBackupSource;
  resticRepository(id: string): LocalResticRepository;
  rcloneEndpoint(id: string): LocalRcloneEndpoint;
  tools: AgentToolConfig;
}

export interface StaticAgentRuntimeConfigInput {
  sources?: readonly LocalBackupSource[];
  resticRepositories?: readonly LocalResticRepository[];
  rcloneEndpoints?: readonly LocalRcloneEndpoint[];
  tools?: AgentToolConfig;
}

export class StaticAgentRuntimeConfig implements AgentRuntimeConfig {
  readonly #sources: Map<string, LocalBackupSource>;
  readonly #repositories: Map<string, LocalResticRepository>;
  readonly #rcloneEndpoints: Map<string, LocalRcloneEndpoint>;
  readonly tools: AgentToolConfig;

  constructor(input: StaticAgentRuntimeConfigInput = {}) {
    this.#sources = indexById(
      input.sources ?? [],
      "backup source",
      (item) => Object.freeze({
        id: requireNonEmpty(item.id, "backup source id"),
        paths: Object.freeze(item.paths.map((path, index) => requireNonEmpty(path, `backup source path ${index + 1}`))),
      }),
    );
    this.#repositories = indexById(
      input.resticRepositories ?? [],
      "restic repository",
      (item) => Object.freeze({
        id: requireNonEmpty(item.id, "restic repository id"),
        repository: requireNonEmpty(item.repository, "restic repository location"),
        ...(item.passwordFile === undefined ? {} : { passwordFile: requireNonEmpty(item.passwordFile, "restic password file") }),
        ...(item.environment === undefined ? {} : { environment: Object.freeze({ ...item.environment }) }),
      }),
    );
    this.#rcloneEndpoints = indexById(
      input.rcloneEndpoints ?? [],
      "rclone endpoint",
      (item) => Object.freeze({
        id: requireNonEmpty(item.id, "rclone endpoint id"),
        fs: requireNonEmpty(item.fs, "rclone endpoint fs"),
        ...(item.allowMove === undefined ? {} : { allowMove: item.allowMove }),
      }),
    );
    this.tools = normalizeTools(input.tools ?? {});
  }

  source(id: string): LocalBackupSource {
    return requireEntry(this.#sources, id, "backup source");
  }

  resticRepository(id: string): LocalResticRepository {
    return requireEntry(this.#repositories, id, "restic repository");
  }

  rcloneEndpoint(id: string): LocalRcloneEndpoint {
    return requireEntry(this.#rcloneEndpoints, id, "rclone endpoint");
  }
}

function indexById<T extends { id: string }>(
  items: readonly T[],
  kind: string,
  normalize: (item: T) => T,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const input of items) {
    const item = normalize(input);
    if (map.has(item.id)) throw new Error(`Duplicate ${kind} id: ${item.id}`);
    map.set(item.id, item);
  }
  return map;
}

function normalizeTools(input: AgentToolConfig): AgentToolConfig {
  return Object.freeze({
    ...(input.resticBinary === undefined ? {} : { resticBinary: requireNonEmpty(input.resticBinary, "restic binary") }),
    ...(input.rcloneBinary === undefined ? {} : { rcloneBinary: requireNonEmpty(input.rcloneBinary, "rclone binary") }),
    ...(input.rcloneConfigPath === undefined ? {} : { rcloneConfigPath: requireNonEmpty(input.rcloneConfigPath, "rclone config path") }),
    ...(input.rcloneArgs === undefined ? {} : {
      rcloneArgs: Object.freeze(input.rcloneArgs.map((arg, index) => requireNonEmpty(arg, `rclone argument ${index + 1}`))),
    }),
  });
}

function requireNonEmpty(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}

function requireEntry<T>(map: Map<string, T>, id: string, kind: string): T {
  const value = map.get(id);
  if (!value) throw new Error(`Unknown ${kind}: ${id}`);
  return value;
}
