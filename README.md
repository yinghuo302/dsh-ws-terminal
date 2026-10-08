# DSH WebSocket Terminal

An independent Host+Client plugin that replaces the native terminal UI with a WebSocket-backed xterm page registered through `dsh-better-sidebar`'s public `betterSidebar.registerTab()` API. It does not patch or edit the `dsh-better-sidebar` source repository.

## Behavior

- Adds a **Terminal** page to the Better Sidebar page picker.
- Uses a fresh tab/content identity on every open, so concurrent terminals each own an independent PTY.
- Sends input, resize frames, and PTY output over one WebSocket per terminal instance.
- Places WebSocket and support routes under `/sidebar/` so DSH reverse-proxy deployments that forward the established plugin route prefix can reach them.
- Uses DSH's `subprocess.spawnTerminal()` service; no second PTY implementation or native dependency is bundled.
- Replays a bounded output transcript after a brief reconnect and terminates disconnected PTYs after the reconnect grace period.
- The bundle patch disables only `ui-sidebar-terminal`; the subprocess service remains enabled.
- If the profile already runs a locally modified `dsh-better-sidebar` that registers its own `terminal` page, that separate page remains enabled; disable it in Better Sidebar's tab settings if you want only this page shown.
- Limits a session to eight live terminals and checks the same-origin/Host trust fence before accepting WebSocket upgrades.

## Requirements

- DSH 0.2.0-rc.1 or newer.
- `dsh-better-sidebar` 0.24.1+ (the local fork in this workspace is already mounted in the `web` profile).
- A Host profile with the `webServer`, `sessions`, `subprocess`, and `webRuntime` services.

## Build and test

```sh
npm install --ignore-scripts --legacy-peer-deps
npm run build
node --test tests/*.test.mjs
```

The Client bundle in `lib/client.js` is included in the package. `@xterm/xterm` and `@xterm/addon-fit` are inlined into that browser artifact; React remains a DSH module-table external. The Host loads the `ws` dependency and serves xterm's stylesheet from a same-origin route.

## Install

Install the package directory as a DSH bundle with Plugin Manager. Its patch hides the native terminal UI and inserts this plugin row. The profile change affects all sessions using that profile; removing this bundle restores DSH's native terminal entry automatically.

The repo is intentionally separate from `DSH-better-sidebar` so its source tree and Git history remain untouched.
