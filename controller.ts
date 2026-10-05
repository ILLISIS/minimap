import * as path from "node:path";
import type * as lib from "@clusterio/lib";
import type { ControllerPluginContext } from "@clusterio/controller";
import { addRoutes } from "./http.js";
import { edgeLines, mapOf, tileOf, ueApi, type Cluster, type EdgeApiLike } from "./integrations.js";
import { MinimapDataEvent, MinimapLiveEvent } from "./messages.js";
import { lifecycle } from "./runtime.js";
import { iconPaths, pageFiles } from "./s3/page.js";
import { Publisher, attachRestarts } from "./s3/publisher.js";
import { Store, endsPlayers, type LiveUpdate } from "./store/index.js";

/** A LiveUpdate as the event (plan ruling 18: the constructor takes the contract's fields in order). */
function live(u: LiveUpdate): MinimapLiveEvent {
	return new MinimapLiveEvent(u.t, u.map, u.surface, u.chunks, u.movers, u.gone, u.tags, u.recipes);
}

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
	// §10.8: the public page's files, at each publisher start. The icons are the default mod pack's export, which
	// Clusterio keeps in static/ under its working directory (clusterio/packages/controller/src/routes.ts:298), under
	// the names the catalog gives them (Plan B's controller ruling R2).
	const pages = () => {
		const assets = cluster.assets();
		const icons = assets?.spritesheet && assets.metadata ? [assets.spritesheet, assets.metadata] : [];
		if (icons.length === 0) {
			lifecycle(logger, "minimap.s3", "no_icons");
		}
		return pageFiles(
			root,
			path.resolve(import.meta.dirname, "..", "public", "viewer.js"),
			path.resolve(import.meta.dirname, "..", "..", "web", "public", "index.html"),
			iconPaths("static", icons),
		);
	};
	// §10: the S3 publisher, off unless its four fields are set (§10.1); attachRestarts says what restarts it.
	const publisher = new Publisher(store, path.join(root, "s3.json"), logger, () => ({
		endpoint: controller.config.get("minimap.s3_endpoint"),
		bucket: controller.config.get("minimap.s3_bucket"),
		accessKeyId: controller.config.get("minimap.s3_access_key_id"),
		secretAccessKey: controller.config.get("minimap.s3_secret_access_key"),
		region: controller.config.get("minimap.s3_region"),
		windowMs: controller.config.get("minimap.window_seconds") * 1000,
	}), pages);
	await publisher.restart();
	attachRestarts(controller.hooks, plugin.name, publisher);

	// §9.2: one broadcast per arriving batch and map surface, to the subscribers of "<map>|<surface>".
	const broadcast = (updates: LiveUpdate[]) => {
		for (const u of updates) {
			controller.subscriptions.broadcast(live(u), `${u.map}|${u.surface}`);
		}
	};
	// Plan ruling 12: the replay answers the request's first filter; the viewer subscribes once per map surface.
	controller.subscriptions.handle(MinimapLiveEvent, async (request: lib.SubscriptionRequest) => {
		const [filter] = request.action === "unsubscribe" ? [] : [...request.filters];
		return filter === undefined ? null : live(store.subscribed(filter));
	});
	controller.handle(MinimapDataEvent, async (event: MinimapDataEvent, src: lib.Address) => {
		broadcast(await store.ingest(src.id, event.items));
	});
	// §7.3: a stopped instance's players are gone, as v1's were.
	controller.hooks.instanceStatusChanged.attach(plugin.name, async instance => {
		if (endsPlayers(instance.status)) {
			broadcast(await store.instanceStopped(instance.id));
		}
	});
	addRoutes(controller, store);
	// §8.10's shutdown: the store's last close, then the publisher's drain and final live file. Clusterio awaits this
	// hook for 15 s (plan ruling 7); past that it logs a timeout and stops anyway, and the drain's own timers keep the
	// process up until it ends.
	controller.hooks.shutdown.attach(plugin.name, async () => {
		try {
			await store.close();
		} finally {
			await publisher.shutdown();
		}
	});
}
