# Minimap v2

One map of a Clusterio cluster, drawn from the game's own chart, live and through time, at `/minimap`. It can also publish a public copy to an S3-compatible bucket. It needs only Clusterio; with Gridworld it stitches tiles by planet, and with Universal Edges it draws edge lines and follows trains across servers.

## Requirements

- Clusterio 2.0, built from source: a checkout of tag `v2.0.2` or later in the 2.0 series. The plugin builds inside Clusterio's pnpm workspace. 2.0.0-alpha.27 and older lack APIs this uses, and Clusterio 2.1 may change the plugin API.
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

`prepare` compiles the plugin and bundles its web page. Add the plugin to the controller's plugin list with `npx clusteriocontroller plugin add ./external_plugins/minimap` and to each host's with `npx clusteriohost plugin add ./external_plugins/minimap`, from the checkout (a path needs the `./`).

## Test and lint

Run these from inside the Clusterio checkout, where ESLint is installed:

```sh
pnpm --filter minimap run test   # TypeScript and Lua unit tests; run prepare first
pnpm --filter minimap run lint   # ESLint with Clusterio's rules, and luacheck
```

Game tests (headless Factorio, the `*_game_test.lua` files) and multi-instance end-to-end tests run from the clusterio-v2 integration repo, which isn't public. The design documents that code comments cite by section (§) live there too.

## Licence

Blue Oak Model License 1.0.0, in `LICENSE.md`.
