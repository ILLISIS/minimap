// The viewer's state (spec §11): the catalog, the selection, the view, the time shown, both caches (K22), the movers
// and the overlays. Each frame loads what the view shows at that time; a frame is asked for only when something
// changed (§11.8). DOM-free: the page passes `frame` (requestAnimationFrame) and `draw` (layers.ts).
import type { Recipe, Tag } from "../../contracts.js";
import { decodeChange } from "../../shared/codec.js";
import {
	CATALOG, areaKey, changeKey, chunkArea, dayKey, indexKey, keyframeKey, moveKey, recipesKey, snapKey, tagsKey,
	utcDay, type Area, type AreaIndex, type Catalog, type DayIndex,
} from "../../shared/keys.js";
import { replay, select } from "../../shared/replay.js";
import { Clock, Tracks, type Keyframe, type Shown, type Window } from "./movers.js";
import { Versions } from "./overlays.js";
import { chart, type Live, type Source } from "./source.js";
import { Lru, MAX_SCALE, MIN_SCALE, paint, paintChunk, rgba, visible, type View } from "./terrain.js";

/** What the viewer shows: a map surface and force; with `instance`, clipped to that instance's bounds (§11.5). */
export type Selection = { map: string; surface: string; force: string; instance?: string };

/** `want` where the catalog has it, else the first map, surface or force there; undefined for an empty catalog. */
export function choose(catalog: Catalog, want: Partial<Selection> = {}): Selection | undefined {
	const has = (o: object, k: string | undefined): k is string => k !== undefined && Object.hasOwn(o, k);
	const map = has(catalog.maps, want.map) ? want.map : Object.keys(catalog.maps)[0];
	const info = catalog.maps[map];
	const surface = info && has(info.surfaces, want.surface) ? want.surface : Object.keys(info?.surfaces ?? {})[0];
	const forces = info?.surfaces[surface]?.forces ?? {};
	const force = has(forces, want.force) ? want.force : Object.keys(forces)[0];
	const instance = info && has(info.instances, want.instance) ? want.instance : undefined;
	return force === undefined ? undefined : { map, surface, force, instance };
}

/** One decoded area: its RGBA at time t. A live area follows live chunks and the refresh. */
export type Entry = {
	a: Area;
	rgba: Uint8ClampedArray<ArrayBuffer>;
	index: AreaIndex;
	/** History: the time replayed to. Live: the newest record applied when it loaded. */
	t: number;
	live: boolean;
	/** The index may be out of date: the next frame refreshes a live area. */
	stale: boolean;
	/** Bumped at every change, so the drawing's cache knows. */
	version: number;
};

/** K22. */
const AREAS = 64;
const BYTES = 32 * 1024 * 1024;
const DAY = 86_400_000;

type Chunk = [cx: number, cy: number, raw: Uint8Array | undefined];

export class Viewer {
	catalog?: Catalog;
	sel?: Selection;
	view: View = { x: 0, y: 0, s: 1 };
	width = 0;
	height = 0;
	/** The time shown; undefined is live, following the data clock. */
	at?: number;
	/** The areas the last frame showed: listed in the catalog, at the view's level. */
	shown: { key: string; a: Area }[] = [];
	/** The movers the last frame showed. */
	movers: Shown[] = [];
	rev = 0;
	readonly areas = new Lru<Entry>(AREAS);
	readonly bytes = new Lru<Uint8Array>(Infinity, BYTES, b => b.byteLength);
	/** History's movers, from files; the live view's, from live updates. */
	readonly past = new Tracks();
	readonly present = new Tracks(16);
	readonly tags = new Versions<Tag>();
	readonly recipes = new Versions<Recipe>();
	/** Bumped at each switch: results of older loads and live updates are dropped (C7). */
	private gen = 0;
	/** In-flight loads: area keys, movement keys, day indexes, tags and recipes keys. */
	private loads = new Set<string>();
	/** Live chunks that arrived while their area was loading, painted when it lands. */
	private held = new Map<string, Chunk[]>();
	private days = new Map<string, DayIndex>();
	private done = new Set<string>();
	/** Keys whose load failed: not asked for again until the next refresh, switch or seek. */
	private failed = new Set<string>();
	private framed = false;
	private closed = false;
	private stopLive = () => {};
	/** Live updates, applied one after another; `queued` counts those not yet applied. */
	private chain = Promise.resolve();
	private queued = 0;
	private listeners = new Set<() => void>();

	constructor(
		private source: Source,
		readonly clock: Clock,
		private frame: (cb: () => void) => void,
		private draw: (v: Viewer) => void,
	) {}

	/** Loads in flight, and live updates not yet applied. */
	get loading(): number {
		return this.loads.size + this.queued;
	}

	time(): number {
		return this.at ?? this.clock.now();
	}

	/** For the page's controls: called when the catalog, the selection or the time shown changes; `rev` counts them. */
	subscribe(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	/** The catalog, at start and every 60 s (§11.3). With nothing selected yet, selects its first map surface. */
	async refresh(): Promise<void> {
		const catalog = await this.json<Catalog>(CATALOG);
		if (!catalog) {
			return;
		}
		this.catalog = catalog;
		this.clock.see(catalog.updated);
		if (this.sel) {
			for (const key of this.areas.keys()) {
				this.areas.peek(key)!.stale = true;
			}
			this.days.clear();
			this.failed.clear();
			for (const key of [...this.done].filter(k => k.endsWith("/recipes.json.gz"))) {
				this.done.delete(key);
			}
			this.loadTags();
		} else {
			const first = choose(catalog);
			if (first) {
				this.select(first);
			}
		}
		this.changed();
		this.invalidate();
	}

	/** A switch clears every cache and drops whatever is still in flight (C7; v1 kept them). */
	select(sel: Selection): void {
		this.gen += 1;
		this.stopLive();
		for (const c of [
			this.areas, this.bytes, this.past, this.present, this.tags, this.recipes, this.loads, this.held, this.days,
			this.done, this.failed,
		]) {
			c.clear();
		}
		this.sel = sel;
		const gen = this.gen;
		if (this.catalog) {
			this.stopLive = this.source.live(sel.map, sel.surface, this.catalog, u => {
				// In order: a chunk's inflate is async, and a later state must land last.
				this.queued += 1;
				this.chain = this.chain.then(() => this.onLive(u, gen)).finally(() => {
					this.queued -= 1;
				});
			});
		}
		this.loadTags();
		this.changed();
		this.invalidate();
	}

	/** Pan and zoom; the scale is clamped to [1/8, 32] tiles a pixel (§11.2). */
	move(view: View): void {
		this.view = { x: view.x, y: view.y, s: Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.s)) };
		this.invalidate();
	}

	resize(width: number, height: number): void {
		this.width = width;
		this.height = height;
		this.invalidate();
	}

	/** Show time t, or live (undefined). */
	seek(t: number | undefined): void {
		this.at = t;
		this.failed.clear();
		this.changed();
		this.invalidate();
	}

	/** The page is gone: no more frames, live updates or results. */
	close(): void {
		this.gen += 1;
		this.closed = true;
		this.stopLive();
	}

	/** Ask for a frame, unless one is already coming. */
	invalidate(): void {
		if (!this.framed) {
			this.framed = true;
			this.frame(() => {
				this.framed = false;
				this.render();
			});
		}
	}

	/** Whether map point (x, y) is on screen. */
	onScreen(x: number, y: number): boolean {
		const { view, width, height } = this;
		return Math.abs(x - view.x) <= width * view.s / 2 && Math.abs(y - view.y) <= height * view.s / 2;
	}

	private changed(): void {
		this.rev += 1;
		for (const cb of this.listeners) {
			cb();
		}
	}

	private render(): void {
		if (this.closed) {
			return;
		}
		const t = this.time();
		this.sync(t);
		this.movers = (this.at === undefined ? this.present : this.past).at(t);
		this.draw(this);
		// §11.8: live, a frame follows only while a mover on screen still moves (K31 stops it after 60 s).
		if (this.at === undefined && this.movers.some(m => m.moving && this.onScreen(m.x, m.y))) {
			this.invalidate();
		}
	}

	/** Start loading whatever this frame shows and doesn't have at t (§11.2: only areas the catalog lists). */
	private sync(t: number): void {
		const { sel, catalog } = this;
		const listed = sel && catalog?.maps[sel.map]?.surfaces[sel.surface]?.forces[sel.force]?.areas;
		this.shown = [];
		if (!sel || !listed) {
			return;
		}
		const { z, list } = visible(this.view, this.width, this.height);
		// ponytail: K22's 64 assumes 1920 × 1080 CSS px (54 areas); a bigger screen, or the browser zoomed out, keeps
		// every area on it, or each frame would evict and reload some.
		this.areas.maxCount = Math.max(AREAS, list.length);
		const have = new Set(listed[z]);
		const live = this.at === undefined;
		for (const [ax, ay] of list) {
			if (!have.has(`${ax}_${ay}`)) {
				continue;
			}
			const a: Area = { map: sel.map, surface: sel.surface, force: sel.force, z, ax, ay };
			const key = areaKey(a);
			this.shown.push({ key, a });
			const e = this.areas.get(key);
			if (e?.index.recipes && z === 0) {
				this.loadRecipes(a);
			}
			const need = !e || e.live !== live || (live ? e.stale : e.t !== t);
			if (need && !this.loads.has(key) && !this.failed.has(key)) {
				this.load(key, a, e, t, live);
			}
		}
		if (!live) {
			this.loadMovers(t);
		}
	}

	private load(key: string, a: Area, e: Entry | undefined, t: number, live: boolean): void {
		const gen = this.gen;
		this.loads.add(key);
		// In the same callback as the paint: a chunk queued in between would be held, then dropped.
		const done = () => {
			this.loads.delete(key);
			this.held.delete(key);
		};
		this.step(a, e, t, live, gen).then(next => {
			if (gen !== this.gen) {
				return;
			}
			for (const [cx, cy, raw] of this.held.get(key) ?? []) {
				this.paintLive(next, cx, cy, raw);
			}
			done();
			this.areas.set(key, next);
			this.invalidate();
		}, () => {
			// ponytail: a failed load leaves the area as it was (black when new); the next refresh or seek retries.
			if (gen === this.gen) {
				done();
				this.failed.add(key);
			}
		});
	}

	/** The area at t (§11.3): the snapshot at or before t and the change files after it; live, the open window too. */
	private async step(a: Area, e: Entry | undefined, t: number, live: boolean, gen: number): Promise<Entry> {
		// The open window before the index: a close between the two then shows its records twice, never not at all.
		const open = live && a.z === 0 && this.source.open ? await this.source.open(areaKey(a)) : undefined;
		const index = await this.json<AreaIndex>(indexKey(a)) ?? { snaps: [], changes: [] };
		const to = live ? Infinity : t;
		const out = await this.reload(a, index, to, gen);
		const newest = index.changes.at(-1)?.[1] ?? -Infinity;
		Object.assign(out, { live, t: live ? newest : t, version: (e?.version ?? 0) + 1 });
		for (const rec of open ? decodeChange(open.t, open.bytes) : []) {
			paint(out.rgba, rec);
			out.t = Math.max(out.t, rec.t);
		}
		return out;
	}

	/** The snapshot at or before `to` and the change files after it (§8.4 bounds them), replayed up to `to`. */
	private async reload(a: Area, index: AreaIndex, to: number, gen: number): Promise<Entry> {
		const { snap, changes } = select(index, to);
		const base = snap === undefined ? undefined : await this.file(snapKey(a, snap), gen);
		const files: { t: number; bytes: Uint8Array }[] = [];
		for (const first of changes) {
			const bytes = await this.file(changeKey(a, first), gen);
			if (bytes) {
				files.push({ t: first, bytes });
			}
		}
		return { a, rgba: rgba(replay(base, files, to)), index, t: to, live: false, stale: false, version: 0 };
	}

	/** A live update (§9.2) for the selection: the data clock, movers, tags, recipes and level-0 chunks. */
	private async onLive(u: Live, gen: number): Promise<void> {
		const sel = this.sel;
		if (gen !== this.gen || !sel || u.map !== sel.map || u.surface !== sel.surface) {
			return;
		}
		this.clock.see(u.t);
		this.present.live(u.t, u.movers, u.gone);
		this.tags.add(u.tags ?? [], sel.force);
		this.recipes.add(u.recipes ?? [], sel.force);
		for (const [force, cx, cy, d] of u.chunks ?? []) {
			// A chunk that isn't valid zlib, or isn't 2,048 bytes inflated, is skipped (§8.2).
			const raw = force === sel.force ? await chart(d).catch(() => null) : null;
			if (gen !== this.gen) {
				return;
			}
			if (force !== sel.force || raw === null || (raw && raw.length !== 2048)) {
				continue;
			}
			const a: Area = { map: sel.map, surface: sel.surface, force, z: 0, ax: chunkArea(cx), ay: chunkArea(cy) };
			const key = areaKey(a);
			const e = this.areas.peek(key);
			if (this.loads.has(key)) {
				this.held.set(key, [...this.held.get(key) ?? [], [cx, cy, raw]]);
			} else if (e) {
				this.paintLive(e, cx, cy, raw);
			}
		}
		this.invalidate();
	}

	/** Live chunks update live level-0 areas; coarse levels catch up at the refresh after the next close (§11.3). */
	private paintLive(e: Entry, cx: number, cy: number, raw: Uint8Array | undefined): void {
		if (e.live) {
			paintChunk(e.rgba, cx, cy, raw);
			e.version += 1;
		}
	}

	private loadTags(): void {
		const sel = this.sel;
		if (sel && this.catalog?.maps[sel.map]?.surfaces[sel.surface]?.forces[sel.force]?.tags) {
			this.once(tagsKey(sel.map, sel.surface, sel.force), (list: Tag[]) => this.tags.add(list, sel.force), false);
		}
	}

	private loadRecipes(a: Area): void {
		this.once(recipesKey(a), (list: Recipe[]) => this.recipes.add(list, a.force), true);
	}

	/** History's movers (§11.4): the keyframe before t and the windows since, from t's UTC day and the day before. */
	private loadMovers(t: number): void {
		const sel = this.sel!;
		const surf = this.catalog?.maps[sel.map]?.surfaces[sel.surface];
		const days = [utcDay(t - DAY), utcDay(t)].filter(day => surf?.days.includes(day));
		for (const day of days.filter(d => !this.days.has(d))) {
			this.once(dayKey(sel.map, sel.surface, day), (index: DayIndex) => this.days.set(day, index), false);
		}
		const indexes = days.flatMap(day => this.days.get(day) ?? []);
		const k = Math.max(...indexes.flatMap(i => i.keys.filter(key => key <= t)));
		const keys = indexes.flatMap(i => i.windows.filter(([first, last]) => last >= k && first <= t))
			.map(([first]) => moveKey(sel.map, sel.surface, first));
		if (k > -Infinity) {
			keys.push(keyframeKey(sel.map, sel.surface, k));
		}
		for (const key of keys) {
			this.once(key, (file: Window | Keyframe) => (key.endsWith(".k.gz")
				? this.past.keyframe(file as Keyframe)
				: this.past.window(file as Window)), true);
		}
	}

	/**
	 * Fetch a JSON key once per selection (`keep`), or once at a time; hand it to `use` unless the selection changed.
	 * ponytail: a failed fetch is tried again after the next refresh, switch or seek.
	 */
	private once<T>(key: string, use: (value: T) => void, keep: boolean): void {
		if (this.loads.has(key) || this.done.has(key) || this.failed.has(key)) {
			return;
		}
		const gen = this.gen;
		this.loads.add(key);
		this.json<T>(key).then(value => {
			if (gen === this.gen && value === undefined) {
				this.failed.add(key);
			} else if (gen === this.gen) {
				use(value as T);
				if (keep) {
					this.done.add(key);
				}
				this.invalidate();
			}
		}, () => {
			if (gen === this.gen) {
				this.failed.add(key);
			}
		}).finally(() => {
			if (gen === this.gen) {
				this.loads.delete(key);
			}
		});
	}

	private async json<T>(key: string): Promise<T | undefined> {
		const bytes = await this.source.get(key);
		return bytes && JSON.parse(new TextDecoder().decode(bytes)) as T;
	}

	/** An immutable file through the 32 MB cache (K22). */
	private async file(key: string, gen: number): Promise<Uint8Array | undefined> {
		let bytes = this.bytes.get(key);
		if (!bytes) {
			bytes = await this.source.get(key);
			if (bytes && gen === this.gen) {
				this.bytes.set(key, bytes);
			}
		}
		return bytes;
	}
}
