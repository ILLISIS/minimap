import * as path from "node:path";
import type * as lib from "@clusterio/lib";
import type { ControllerPluginContext } from "@clusterio/controller";
import { edgeLines, mapOf, tileOf, ueApi, type Cluster, type EdgeApiLike } from "./integrations.js";
import { MinimapDataEvent } from "./messages.js";
import { lifecycle } from "./runtime.js";
import { Store, endsPlayers } from "./store/index.js";

export default async function loadControllerPlugin(context: ControllerPluginContext) {
	const { controller, logger, plugin } = context;
	// §12.1: each integration is logged once per start, when first seen.
	let gridworld = false;
	let ue: EdgeApiLike | undefined;
	const describe = (i: NonNullable<ReturnType<typeof controller.instances.get>>) => {
		const tile = tileOf(i.config);
		if (tile && !gridworld) {
			gridworld = true;
			lifecycle(logger, "minimap.integration", "gridworld");
		}
		return { id: i.id, name: i.config.get("instance.name"), tile };
	};
	const cluster: Cluster = {
		instance: id => {
			const i = controller.instances.get(id);
			return i && describe(i);
		},
		instances: () => [...controller.instances.values()].map(describe),
		// Controller ruling R2: the default mod pack's export (clusterio/packages/controller/src/routes.ts:279-298).
		assets: () => {
			const id = controller.config.get("controller.default_mod_pack_id");
			return id === null ? undefined : controller.modPacks.get(id)?.exportManifest?.assets;
		},
		edges: async () => {
			if (!ue) {
				ue = await ueApi(controller.pluginInfos);
				if (ue) {
					lifecycle(logger, "minimap.integration", "universal_edges");
				}
			}
			if (!ue) {
				return new Map();
			}
			const instances = new Map(cluster.instances().map(i => [i.id, i]));
			return edgeLines(ue.list(), (id, surface) => mapOf(instances.get(id) ?? { id, tile: null }, surface));
		},
	};
	const root = path.resolve(controller.config.get("controller.database_directory"), "minimap");
	const store = new Store(root, cluster, logger, () => controller.config.get("minimap.window_seconds"));
	await store.load();
	store.start();

	controller.handle(MinimapDataEvent, async (event: MinimapDataEvent, src: lib.Address) => {
		await store.ingest(src.id, event.items);
	});
	// §7.3: a stopped instance's players are gone, as v1's were.
	controller.hooks.instanceStatusChanged.attach(plugin.name, async instance => {
		if (endsPlayers(instance.status)) {
			await store.instanceStopped(instance.id);
		}
	});
	// §8.10's shutdown close: Clusterio awaits this hook (clusterio/packages/controller/src/Controller.ts:547).
	// Plan C's publisher drains its lane after it, in this hook.
	controller.hooks.shutdown.attach(plugin.name, async () => {
		await store.close();
	});
}
