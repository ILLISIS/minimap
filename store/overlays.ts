import type { Recipe, RecipeMsg, Tag, TagMsg } from "../contracts.js";
import { area, recipesKey, tagsKey, unname, type Area } from "../shared/keys.js";
import type { Disk } from "./disk.js";
import type { Out } from "./index.js";

/** §8.9's tuple, for tags and recipes alike: [instance, id, force, start, end | null, x, y, a, b]. */
type Version = Tag | Recipe;
type State = [x: number, y: number, a: string, b: string];
type Open = { key: string; map: string; surface: string; v: Version };

export class Overlays {
	/** Every file's versions, in the order they opened. */
	private files = new Map<string, Version[]>();
	/** Each tag's ("t<instance>:<tag number>") and machine's ("r<instance>:<unit>") open version. */
	private open = new Map<string, Open>();
	private dirty = new Set<string>();
	/** Recipes files new since the last close: their area's index gets `recipes: true` (§8.5). */
	private fresh = new Map<string, Area>();
	/** §6.7: what each resyncing instance has re-sent since its mm.surfaces (plan ruling 6). */
	private seen = new Map<number, Set<string>>();

	constructor(private disk: Disk) {}

	/** Every tags and recipes file on disk, with its open versions, so a restart can't duplicate (Review Focus 3). */
	async load(keys: string[], unreadable: (key: string, err: Error) => void = () => {}): Promise<void> {
		for (const key of keys.filter(k => /\/(tags|recipes)\.json\.gz$/.test(k))) {
			let list: Version[];
			try {
				list = await this.disk.json<Version[]>(key) ?? [];
			} catch (err: any) {
				unreadable(key, err);
				continue;
			}
			this.files.set(key, list);
			const [map, surface] = key.split("/");
			const kind = key.endsWith("/tags.json.gz") ? "t" : "r";
			for (const v of list.filter(x => x[4] === null)) {
				this.open.set(`${kind}${v[0]}:${v[1]}`, { key, map, surface: unname(surface), v });
			}
		}
	}

	/** mm.tag (§6.4, K18): the tag's new state, or its removal (no x). */
	tag(instance: number, map: string, t: number, m: TagMsg, out: Out): void {
		const state: State | undefined = m.x === undefined ? undefined : [m.x, m.y ?? 0, m.icon ?? "", m.text ?? ""];
		this.version(`t${instance}:${m.n}`, instance, map, m.s, m.f, m.n, t, state, tagsKey(map, m.s, m.f), out);
	}

	/** mm.recipe (§6.6, K17): the machine's recipe and quality, filed with its level-0 area, or its removal (no r). */
	recipe(instance: number, map: string, t: number, m: RecipeMsg, out: Out): void {
		const a: Area = { map, surface: m.s, force: m.f, z: 0, ax: area(m.x ?? 0, 0), ay: area(m.y ?? 0, 0) };
		const state: State | undefined = m.r === undefined ? undefined : [m.x ?? 0, m.y ?? 0, m.r, m.q ?? ""];
		this.version(`r${instance}:${m.u}`, instance, map, m.s, m.f, m.u, t, state, recipesKey(a), out, a);
	}

	begin(instance: number): void {
		this.seen.set(instance, new Set());
	}

	/** mm.resynced (§8.9): the instance's open versions it didn't re-send since its mm.surfaces close at t. */
	resynced(instance: number, t: number, out: Out): void {
		const seen = this.seen.get(instance);
		if (!seen) {
			return;
		}
		this.seen.delete(instance);
		for (const [id, o] of this.open) {
			if (o.v[0] === instance && !seen.has(id)) {
				this.end(id, o, t, out);
			}
		}
	}

	/** The close: each changed file, whole (§8.9). Returns their keys, and the areas of new recipes files. */
	async close(failed: (key: string, err: Error) => void): Promise<{ keys: string[]; areas: Area[] }> {
		const keys: string[] = [];
		const areas: Area[] = [];
		for (const key of this.dirty) {
			try {
				await this.disk.put(key, JSON.stringify(this.files.get(key)));
				keys.push(key);
				this.dirty.delete(key);
				const a = this.fresh.get(key);
				if (a) {
					areas.push(a);
					this.fresh.delete(key);
				}
			} catch (err: any) {
				failed(key, err);
			}
		}
		return { keys, areas };
	}

	/**
	 * §8.9: a new state closes the open version at t and opens another; a state equal to the open one is ignored, so
	 * restarts can't duplicate (C3); a removal (no state) closes the open version.
	 */
	private version(
		id: string, instance: number, map: string, surface: string, force: string, n: number, t: number,
		state: State | undefined, key: string, out: Out, a?: Area,
	): void {
		this.seen.get(instance)?.add(id);
		const cur = this.open.get(id);
		if (cur && cur.map === map && state?.every((x, i) => x === cur.v[5 + i])) {
			return;
		}
		if (cur) {
			this.end(id, cur, t, out);
		}
		if (!state) {
			return;
		}
		const v = [instance, n, force, t, null, ...state] as Version;
		let list = this.files.get(key);
		if (!list) {
			list = [];
			this.files.set(key, list);
			if (a) {
				this.fresh.set(key, a);
			}
		}
		list.push(v);
		this.open.set(id, { key, map, surface, v });
		this.dirty.add(key);
		this.push(id, map, surface, v, out);
	}

	private end(id: string, o: Open, t: number, out: Out): void {
		o.v[4] = Math.max(t, o.v[3]);
		this.open.delete(id);
		this.dirty.add(o.key);
		this.push(id, o.map, o.surface, o.v, out);
	}

	/** The live event carries each version that opened or closed, once (§9.2). */
	private push(id: string, map: string, surface: string, v: Version, out: Out): void {
		const u = out(map, surface);
		const list: Version[] = id.startsWith("t") ? (u.tags ??= []) : (u.recipes ??= []);
		if (!list.includes(v)) {
			list.push(v);
		}
	}
}
