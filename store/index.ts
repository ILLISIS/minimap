import * as lib from "@clusterio/lib";
import type { LiveMover, Recipe, Stamped, Tag } from "../contracts.js";
import { mapInfo, mapOf, type Cluster, type Instance } from "../integrations.js";
import { lifecycle, rateLimited } from "../runtime.js";
import { CATALOG, indexKey, unname, type Area, type AreaIndex } from "../shared/keys.js";
import { Catalog } from "./catalog.js";
import { Disk, bytesWritten } from "./disk.js";
import { Movers } from "./movers.js";
import { Overlays } from "./overlays.js";
import { Terrain } from "./terrain.js";

/** Lua's dropped pushes and messages, per instance, as its last mm.resynced counted them (spec §14). */
export const luaDrops = new lib.Gauge(
	"clusterio_minimap_lua_drops",
	"Minimap pushes and messages Lua dropped, as of each instance's last resync",
	{ labels: ["instance_id"] },
);

/** One map surface's share of a MinimapLiveEvent (§9.2); controller.ts sends it as the event. */
export type LiveUpdate = {
	t: number;
	map: string;
	surface: string;
	chunks?: [force: string, cx: number, cy: number, d: string][];
	movers?: LiveMover[];
	gone?: string[];
	tags?: Tag[];
	recipes?: Recipe[];
};
/** Where the store's parts put what changed, per map surface. */
export type Out = (map: string, surface: string) => LiveUpdate;

/** A fresh Out, and the updates it gathers. */
export function gather(): { out: Out; updates: Map<string, LiveUpdate> } {
	const updates = new Map<string, LiveUpdate>();
	const out: Out = (map, surface) => {
		const key = `${map}|${surface}`;
		let u = updates.get(key);
		if (!u) {
			u = { t: 0, map, surface };
			updates.set(key, u);
		}
		return u;
	};
	return { out, updates };
}

/** The level-0 area of a key `<map>/<surface>/<force>/0/<ax>_<ay>/recipes.json.gz`. */
function recipesArea(key: string): Area {
	const [map, surface, force, , xy] = key.split("/");
	const [ax, ay] = xy.split("_").map(Number);
	return { map, surface: unname(surface), force: unname(force), z: 0, ax, ay };
}

/** §7.3: a stopped instance's players are gone; a host crash leaves its instances "unknown", which is the same. */
export const endsPlayers = (status: string) => status === "stopped" || status === "unknown";

/** §8.10: after a close at c, the next is at the next multiple of W. */
export function nextClose(c: number, w: number): number {
	return (Math.floor(c / w) + 1) * w;
}

/**
 * The minimap's store (§8): terrain, movers, tags, recipes and the catalog under <database>/minimap/. Ingests and
 * closes run one at a time, in arrival order. Plan C's publisher reads it through onWindowClosed, path, keys,
 * liveChanged and close (K36).
 */
export class Store {
	readonly disk: Disk;
	private terrain: Terrain;
	private movers: Movers;
	private overlays: Overlays;
	private catalog = new Catalog();
	private listeners: ((keys: string[]) => void)[] = [];
	private chain: Promise<unknown> = Promise.resolve();
	private timer?: ReturnType<typeof setTimeout>;
	private ended = false;
	/** The UTC hour of the last close, for K12's keyframes (plan ruling 10). */
	private hour?: number;
	/** Areas whose recipes file was written at the last close: their index gets the flag at the next (ruling 24). */
	private recipeAreas: Area[] = [];

	constructor(
		root: string,
		private cluster: Cluster,
		private logger: lib.Logger,
		private windowSeconds: () => number,
		private now: () => number = Date.now,
	) {
		this.disk = new Disk(root);
		this.terrain = new Terrain(this.disk, rateLimited(logger));
		this.movers = new Movers(this.disk);
		this.overlays = new Overlays(this.disk);
	}

	/**
	 * From disk (§8.8, §8.9): the catalog's keys, the open tag and recipe versions, the map surfaces with movement,
	 * and the recipes files whose area index lacks its flag (written by the last close before a stop, ruling 24).
	 */
	async load(): Promise<void> {
		const keys = await this.disk.keys();
		for (const key of keys) {
			this.catalog.add(key);
		}
		await this.overlays.load(keys);
		this.movers.load(keys);
		for (const key of keys.filter(k => k.endsWith("/recipes.json.gz"))) {
			const index = await this.disk.json<AreaIndex>(key.replace(/recipes\.json\.gz$/, "index.json.gz"));
			if (!index?.recipes) {
				this.recipeAreas.push(recipesArea(key));
			}
		}
	}

	/** Closes at multiples of W, with W read at each close (§8.10, M13; plan ruling 4), until close(). */
	start(): void {
		const now = this.now();
		this.timer = setTimeout(() => {
			this.closeWindow().catch((err: Error) => {
				this.logger.error(`minimap.window close failed:\n${err.stack ?? err.message}`);
			}).finally(() => {
				if (!this.ended) {
					this.start();
				}
			});
		}, nextClose(now, this.windowSeconds() * 1000) - now);
	}

	/** One MinimapDataEvent's items from `instance`, in order (§7.3). Returns a live update per map surface touched. */
	ingest(instance: number, items: Stamped[]): Promise<LiveUpdate[]> {
		return this.serial(async () => {
			const inst = this.cluster.instance(instance) ?? { id: instance, name: "", tile: null };
			const { out, updates } = gather();
			for (const item of items) {
				await this.item(inst, item, out);
			}
			return this.stamp(updates);
		});
	}

	/** instanceStatusChanged to stopped (§7.3): the instance's players are gone. */
	instanceStopped(instance: number): Promise<LiveUpdate[]> {
		return this.serial(async () => {
			const { out, updates } = gather();
			this.movers.stopped(instance, this.now(), out);
			return this.stamp(updates);
		});
	}

	/**
	 * One close, now (§8.3-8.10): every file in K36's upload order (data files, area indexes, movement files, day
	 * indexes, tags and recipes), then the catalog; then the listeners get the keys.
	 */
	closeWindow(): Promise<string[]> {
		return this.serial(async () => {
			const c = this.now();
			const started = performance.now();
			const bytes = bytesWritten.get();
			const failed = (key: string, err: Error) => {
				lifecycle(this.logger, "minimap.store", "write_failed", { key, error: err.message }, "error");
			};
			const hour = Math.floor(c / 3_600_000);
			const keyframe = hour !== this.hour;
			this.hour = hour;
			// Ruling 24: the last close's new recipes files are queued ahead of this close's indexes, so an index never
			// names a recipes file the publisher hasn't put yet (§10.5's order puts recipes after indexes).
			const pending = this.recipeAreas;
			this.recipeAreas = [];
			for (const area of pending) {
				try {
					await this.terrain.markRecipes(area);
				} catch (err: any) {
					failed(indexKey(area), err);
					this.recipeAreas.push(area); // kept for the next close
				}
			}
			const overlays = await this.overlays.close(failed);
			this.recipeAreas.push(...overlays.areas);
			const terrain = await this.terrain.close(c, failed);
			const movers = await this.movers.close(c, keyframe, failed);
			const keys = [...terrain.data, ...terrain.indexes, ...movers.files, ...movers.days, ...overlays.keys];
			for (const key of keys) {
				this.catalog.add(key);
			}
			const info = mapInfo(this.cluster.instances());
			const edges = await this.cluster.edges();
			const catalog = this.catalog.json(info, edges, c, this.windowSeconds() * 1000, this.cluster.assets());
			try {
				await this.disk.put(CATALOG, JSON.stringify(catalog));
				keys.push(CATALOG);
			} catch (err: any) {
				failed(CATALOG, err);
			}
			lifecycle(this.logger, "minimap.window", "closed", {
				ms: Math.round(performance.now() - started), areas: terrain.indexes.length, files: keys.length,
				bytes: bytesWritten.get() - bytes, samples: movers.samples,
			}, "verbose");
			for (const listener of this.listeners) {
				listener(keys);
			}
			return keys;
		});
	}

	/** K36: each close's keys, in upload order (§10.5). */
	onWindowClosed(cb: (keys: string[]) => void): void {
		this.listeners.push(cb);
	}

	/** K36: the file on disk. */
	path(key: string): string {
		return this.disk.path(key);
	}

	/** K36: every key on disk, for a backfill. */
	keys(): Promise<string[]> {
		return this.disk.keys();
	}

	/** K36: the map surfaces whose movers changed since the last call (§10.6). */
	liveChanged(): { map: string; surface: string; t: number; movers: LiveMover[] }[] {
		return this.movers.liveChanged(this.now());
	}

	/** K36, §8.10 steps 1-2: the timer stops, and one last close enqueues its files; the publisher drains after. */
	async close(): Promise<void> {
		this.ended = true;
		clearTimeout(this.timer);
		await this.closeWindow();
	}

	private async item(inst: Instance, m: Stamped, out: Out): Promise<void> {
		const id = inst.id;
		switch (m.type) {
			case "mm.chunk": {
				const map = mapOf(inst, m.s);
				if (await this.terrain.chunk(id, map, m.s, m.f, m.x, m.y, m.t, m.d) === "changed") {
					(out(map, m.s).chunks ??= []).push([m.f, m.x, m.y, m.d ?? ""]);
				}
				break;
			}
			case "mm.move":
				this.movers.move(id, mapOf(inst, m.s), m.s, m.t, m.m, out);
				break;
			case "mm.adopt": {
				const previous = this.movers.adopt(id, m.j);
				const fields = { trace: m.trace, journey: m.j, instance: id, previous };
				lifecycle(this.logger, "minimap.journey", "owner", fields, "verbose");
				break;
			}
			case "mm.tag":
				this.overlays.tag(id, mapOf(inst, m.s), m.t, m, out);
				break;
			case "mm.recipe":
				this.overlays.recipe(id, mapOf(inst, m.s), m.t, m, out);
				break;
			case "mm.surfaces":
				// Plan ruling 6: §6.7's first resync message starts the instance's resync here too.
				this.movers.begin(id);
				this.overlays.begin(id);
				break;
			case "mm.resynced":
				this.movers.resynced(id, m.t, out);
				this.overlays.resynced(id, m.t, out);
				luaDrops.labels(String(id)).set(m.counts.drops ?? 0);
				break;
			default:
				break;
		}
	}

	private stamp(updates: Map<string, LiveUpdate>): LiveUpdate[] {
		const t = this.now();
		return [...updates.values()].map(u => ({ ...u, t }));
	}

	/** Ingests and closes, one at a time in arrival order (§5.4: nothing reorders an instance's items). */
	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.chain.then(fn);
		this.chain = run.catch(() => undefined);
		return run;
	}
}
