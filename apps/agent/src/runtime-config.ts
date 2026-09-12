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

export type RestoreOverwriteMode = "always" | "if-changed" | "if-newer" | "never";

export interface LocalRestoreTarget {
  id: string;
  path: string;
  label?: string;
  overwrite?: RestoreOverwriteMode;
}

export type RcloneVfsCacheMode = "off" | "minimal" | "writes" | "full";

export interface LocalRcloneMountConfig {
  mountPoint: string;
  daemonWait?: string;
  cacheDir?: string;
  vfsCacheMode?: RcloneVfsCacheMode;
  vfsCacheMaxSize?: string;
  dirCacheTime?: string;
  pollInterval?: string;
  bufferSize?: string;
  args?: readonly string[];
}

export interface LocalRcloneEndpoint {
  id: string;
  fs: string;
  /** Destructive rclone move jobs are rejected unless the source endpoint explicitly opts in. */
  allowMove?: boolean;
  /** Optional local-only mount policy used by remote-as-source backup jobs. */
  mount?: LocalRcloneMountConfig;
}

export interface AgentToolConfig {
  resticBinary?: string;
  rcloneBinary?: string;
  rcloneConfigPath?: string;
  rcloneArgs?: readonly string[];
  unmountBinary?: string;
  unmountArgs?: readonly string[];
  unmountTimeoutMs?: number;
}

export interface AgentRuntimeConfig {
  source(id: string): LocalBackupSource;
  resticRepository(id: string): LocalResticRepository;
  restoreTarget(id: string): LocalRestoreTarget;
  rcloneEndpoint(id: string): LocalRcloneEndpoint;
  tools: AgentToolConfig;
}

export interface StaticAgentRuntimeConfigInput {
  sources?: readonly LocalBackupSource[];
  resticRepositories?: readonly LocalResticRepository[];
  restoreTargets?: readonly LocalRestoreTarget[];
  rcloneEndpoints?: readonly LocalRcloneEndpoint[];
  tools?: AgentToolConfig;
}

export class StaticAgentRuntimeConfig implements AgentRuntimeConfig {
  readonly #sources: Map<string, LocalBackupSource>;
  readonly #repositories: Map<string, LocalResticRepository>;
  readonly #restoreTargets: Map<string, LocalRestoreTarget>;
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
    this.#restoreTargets = indexById(
      input.restoreTargets ?? [],
      "restore target",
      (item) => normalizeRestoreTarget(item),
    );
    this.#rcloneEndpoints = indexById(
      input.rcloneEndpoints ?? [],
      "rclone endpoint",
      (item) => Object.freeze({
        id: requireNonEmpty(item.id, "rclone endpoint id"),
        fs: requireNonEmpty(item.fs, "rclone endpoint fs"),
        ...(item.allowMove === undefined ? {} : { allowMove: item.allowMove }),
        ...(item.mount === undefined ? {} : { mount: normalizeMount(item.mount) }),
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

  restoreTarget(id: string): LocalRestoreTarget {
    return requireEntry(this.#restoreTargets, id, "restore target");
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

function normalizeRestoreTarget(input: LocalRestoreTarget): LocalRestoreTarget {
  const overwrite = input.overwrite ?? "never";
  if (!["always", "if-changed", "if-newer", "never"].includes(overwrite)) {
    throw new Error(`Unsupported restore overwrite mode: ${overwrite}`);
  }
  return Object.freeze({
    id: requireNonEmpty(input.id, "restore target id"),
    path: requireNonEmpty(input.path, "restore target path"),
    ...(input.label === undefined ? {} : { label: requireNonEmpty(input.label, "restore target label") }),
    overwrite,
  });
}

function normalizeMount(input: LocalRcloneMountConfig): LocalRcloneMountConfig {
  const vfsCacheMode = input.vfsCacheMode;
  if (vfsCacheMode !== undefined && !["off", "minimal", "writes", "full"].includes(vfsCacheMode)) {
    throw new Error(`Unsupported rclone VFS cache mode: ${vfsCacheMode}`);
  }
  return Object.freeze({
    mountPoint: requireNonEmpty(input.mountPoint, "rclone mount point"),
    ...(input.daemonWait === undefined ? {} : { daemonWait: requireNonEmpty(input.daemonWait, "rclone daemon wait") }),
    ...(input.cacheDir === undefined ? {} : { cacheDir: requireNonEmpty(input.cacheDir, "rclone cache directory") }),
    ...(vfsCacheMode === undefined ? {} : { vfsCacheMode }),
    ...(input.vfsCacheMaxSize === undefined ? {} : { vfsCacheMaxSize: requireNonEmpty(input.vfsCacheMaxSize, "rclone VFS cache max size") }),
    ...(input.dirCacheTime === undefined ? {} : { dirCacheTime: requireNonEmpty(input.dirCacheTime, "rclone dir cache time") }),
    ...(input.pollInterval === undefined ? {} : { pollInterval: requireNonEmpty(input.pollInterval, "rclone poll interval") }),
    ...(input.bufferSize === undefined ? {} : { bufferSize: requireNonEmpty(input.bufferSize, "rclone buffer size") }),
    ...(input.args === undefined ? {} : {
      args: Object.freeze(input.args.map((arg, index) => requireNonEmpty(arg, `rclone mount argument ${index + 1}`))),
    }),
  });
}

function normalizeTools(input: AgentToolConfig): AgentToolConfig {
  if (input.unmountTimeoutMs !== undefined && (!Number.isInteger(input.unmountTimeoutMs) || input.unmountTimeoutMs <= 0)) {
    throw new Error("unmountTimeoutMs must be a positive integer");
  }
  return Object.freeze({
    ...(input.resticBinary === undefined ? {} : { resticBinary: requireNonEmpty(input.resticBinary, "restic binary") }),
    ...(input.rcloneBinary === undefined ? {} : { rcloneBinary: requireNonEmpty(input.rcloneBinary, "rclone binary") }),
    ...(input.rcloneConfigPath === undefined ? {} : { rcloneConfigPath: requireNonEmpty(input.rcloneConfigPath, "rclone config path") }),
    ...(input.rcloneArgs === undefined ? {} : {
      rcloneArgs: Object.freeze(input.rcloneArgs.map((arg, index) => requireNonEmpty(arg, `rclone argument ${index + 1}`))),
    }),
    ...(input.unmountBinary === undefined ? {} : { unmountBinary: requireNonEmpty(input.unmountBinary, "unmount binary") }),
    ...(input.unmountArgs === undefined ? {} : {
      unmountArgs: Object.freeze(input.unmountArgs.map((arg, index) => requireNonEmpty(arg, `unmount argument ${index + 1}`))),
    }),
    ...(input.unmountTimeoutMs === undefined ? {} : { unmountTimeoutMs: input.unmountTimeoutMs }),
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