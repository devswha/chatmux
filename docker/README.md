# ChatMux sandboxes

ChatMux sandbox templates are built and used locally. The application template tags are:

| Agent | Local template |
| --- | --- |
| Claude Code | `chatmux-sandbox:claude-code` |
| Codex | `chatmux-sandbox:codex` |

The local lifecycle never pulls or publishes an application image and never installs ChatMux from a package registry. Build the template from a prepared repository runtime before invoking `sbx`.

## Prerequisites

- Docker and the `sbx` CLI. See the [Docker Sandboxes guide](https://docs.docker.com/ai/sandboxes/get-started/).
- A local ChatMux repository runtime for Linux x64 and Node 22. It must contain the built client and server plus its local dependencies.
- Agent credentials stored with `sbx`, for example `sbx secret set -g anthropic` or `sbx secret set -g openai`.

From the repository root, confirm the required local source exists:

```bash
test -f package.json
test -f dist/index.html
test -f dist-server/server/cli.js
test -d node_modules
```

The Dockerfiles validate these inputs, Node 22, Linux x64, and the required native modules. A missing input stops the build with a `ChatMux sandbox build failed` message; obtain or build the prepared repository runtime locally rather than falling back to an external application image or package installation.

## Build local templates

Run these commands from the repository root. The build context must be the repository root, not `docker/`.

```bash
docker build --file docker/claude-code/Dockerfile --tag chatmux-sandbox:claude-code .
docker build --file docker/codex/Dockerfile --tag chatmux-sandbox:codex .
```

Each image installs the prepared repository runtime at `/opt/chatmux` and exposes its canonical CLI as `chatmux`. Sandbox data and logs remain under `/home/agent/.chatmux`; the server log is `/home/agent/.chatmux/logs/sandbox.log`.

Before starting a sandbox, verify that the exact local template exists. Do not substitute a different image when this check fails.

```bash
AGENT=claude-code
docker image inspect "chatmux-sandbox:${AGENT}" >/dev/null 2>&1 || {
  printf 'Missing local template chatmux-sandbox:%s. Build it from this repository first.\n' "$AGENT" >&2
  exit 1
}
```

## Launch and manage

The installed CLI selects the local template for its supported agents:

```bash
chatmux sandbox ~/my-project
chatmux sandbox ~/my-project --agent codex --port 8080
chatmux sandbox ls
chatmux sandbox logs my-project
```

Use `sbx` directly for branch mode, multiple workspaces, prompts, and other generic agent workflows. Supply one of the local ChatMux templates explicitly:

```bash
sbx run --template chatmux-sandbox:claude-code claude ~/my-project --branch my-feature
sbx run --template chatmux-sandbox:codex codex ~/my-project -- "Fix the auth bug"
sbx ports my-project --publish 3001:3001
```

Generic agents remain usable through `sbx` with a user-provided local template. Only `chatmux-sandbox:claude-code` and `chatmux-sandbox:codex` include ChatMux.

Manage sandbox lifecycle with `sbx`:

```bash
sbx ls
sbx stop my-project
sbx start my-project
sbx rm my-project
sbx exec my-project bash
```

## Logs and configuration

The sandbox startup script runs from the agent shell and starts ChatMux on port `3001` unless `SERVER_PORT` is set. It binds to `0.0.0.0` so `sbx ports` can publish it.

Read the canonical server log with:

```bash
sbx exec my-project bash -c 'cat ~/.chatmux/logs/sandbox.log'
```

`/tmp/chatmux-ui.log` is an internal compatibility symlink to that canonical log. Do not use it as a data location.

Use `--env SERVER_PORT=<port>` with `chatmux sandbox` when creating a sandbox, then publish the matching port with `sbx ports`.
