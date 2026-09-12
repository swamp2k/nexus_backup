# M3 agent execution foundation

M3 introduces the process and tool adapters that perform work on the local agent. The control plane still sends only identifiers and policy; it cannot send arbitrary local filesystem paths, repository credentials or rclone remote strings.

## Job types

### `restic-backup`

Payload:

```json
{
  "sourceId": "photos",
  "repositoryId": "repo-main",
  "tags": ["nightly"]
}
```

`sourceId` and `repositoryId` must exist in the agent-local runtime configuration. The agent resolves them to local paths, repository URI and password-file/environment configuration.

The restic executor:

- runs `restic backup --json`
- inserts `--` before source paths so a path cannot be interpreted as an option
- emits structured progress and summary events from JSONL output
- maps exit code `0` to `completed`
- maps exit code `3` to `partial`
- maps other exits to `ToolExitError`
- honors job cancellation through the process runner

### `rclone-transfer`

Payload:

```json
{
  "sourceEndpointId": "seedbox",
  "destinationEndpointId": "downloads",
  "mode": "copy"
}
```

Both endpoint IDs resolve locally. The control plane cannot provide `seedbox:/path`, `/mnt/user/...` or a config-file path directly.

`move` is destructive and is rejected unless the local source endpoint has `allowMove: true`. This is a local capability boundary: a compromised or buggy scheduler cannot turn a copy-only source into a destructive move source.

The rclone executor enables JSON logging and periodic stats and converts those stats to structured execution progress.

## Local runtime configuration

Example only; values are intentionally host-local:

```ts
new StaticAgentRuntimeConfig({
  sources: [
    { id: "photos", paths: ["/local/path/chosen-by-agent-admin"] },
  ],
  resticRepositories: [
    {
      id: "repo-main",
      repository: "/local/repository/path",
      passwordFile: "/local/secret/path",
    },
  ],
  rcloneEndpoints: [
    { id: "seedbox", fs: "configured-remote:/path", allowMove: false },
    { id: "downloads", fs: "/local/destination" },
  ],
  tools: {
    rcloneConfigPath: "/local/rclone.conf",
  },
});
```

These values must not be copied into D1 merely to make configuration easier. D1 stores orchestration metadata; filesystem and credential authority remains with the agent.

## Process cancellation

`NodeCommandRunner` starts tools without a shell and passes each argument separately. On cancellation it sends `SIGTERM`, waits a configurable grace period, then sends `SIGKILL` if the process remains alive. Output capture is bounded so a noisy tool cannot grow agent memory without limit.

Heartbeat loss aborts the executor signal through `AgentRunner`, which in turn terminates the underlying tool process.

## Remote source / mount work still pending

A cloud remote used as a **source** for restic needs a filesystem view (for example an rclone FUSE mount). That lifecycle is deliberately not hard-coded yet because the correct choices depend on the actual Unraid container/runtime:

- foreground managed mount vs daemon/RC mount
- FUSE device/capabilities available to the container
- mount and unmount mechanism
- VFS cache directory and size limits
- read-only mount policy
- crash cleanup and stale-mount detection

Those choices belong in agent-local runtime configuration. No concrete remote name, cache path, mount path or storage location should be invented by the control plane.
