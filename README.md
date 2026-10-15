# Minimap v2

One map of a Clusterio cluster, drawn from the game's own chart, live and through time, at `/minimap`. It can also publish a public copy to an S3-compatible bucket. It needs only Clusterio; with Gridworld it stitches tiles by planet, and with Universal Edges it draws edge lines and follows trains across servers.

## Requirements

- Clusterio built from source, master at commit `4c0c89c` or later. 2.0.0-alpha.27, the latest release, lacks APIs this uses, and before `4c0c89c` the plugins' web pages don't load.
- Node 22 or later, and pnpm at the version in Clusterio's `packageManager`.
- `lua5.2` and `luacheck` (tests and lint).

## Install

In a Clusterio checkout:

```sh
git clone https://github.com/ILLISIS/minimap.git external_plugins/minimap
pnpm install
pnpm build
pnpm run -r --if-present prepare
```

`prepare` compiles the plugin and bundles its web page. Add the plugin to the controller's plugin list with `npx clusteriocontroller plugin add <path to external_plugins/minimap>` and to each host's with `npx clusteriohost plugin add <that path>`.

## Test and lint

Run these from inside the Clusterio checkout, where ESLint is installed:

```sh
pnpm --filter minimap run test   # TypeScript and Lua unit tests; run prepare first
pnpm --filter minimap run lint   # ESLint with Clusterio's rules, and luacheck
```

Game tests (headless Factorio, the `*_game_test.lua` files) and multi-instance end-to-end tests run from the clusterio-v2 integration repo, which isn't public. The design documents that code comments cite by section (§) live there too.

## Licence

Blue Oak Model License 1.0.0, in `LICENSE.md`.
