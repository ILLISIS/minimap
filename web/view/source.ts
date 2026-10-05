// Where the viewer's files come from (spec §11.1): the controller's routes, or the S3 bucket the public page is
// served from. Gunzip is the browser's DecompressionStream (§5.3), which Node has too. DOM-free.
import type { LiveMover } from "../../contracts.js";
import type { MinimapLiveEvent } from "../../messages.js";
import { liveKey, type Catalog } from "../../shared/keys.js";

/** A live update for one map surface: MinimapLiveEvent's fields (§9.2). */
export type Live = Omit<MinimapLiveEvent, "constructor">;

export interface Source {
	/** A key of §8.1's tree, gunzipped; undefined when it isn't there. */
	get(key: string): Promise<Uint8Array | undefined>;
	/** The open window of the area at `key` (§9.1, the controller only): records relative to t (B's ruling 9). */
	open?(key: string): Promise<{ t: number; bytes: Uint8Array } | undefined>;
	/** Live updates for one map surface until the returned function is called (plan ruling 2: the catalog too). */
	live(map: string, surface: string, catalog: Catalog, on: (u: Live) => void): () => void;
	/** The URL of an icon file the catalog names, `icons/<file>`: plain PNG or JSON, not gzip (ruling R2). */
	icon(key: string): string;
}

/** The DOM's BufferSource, which Node's types don't name. */
type Bytes = ArrayBufferView<ArrayBuffer> | ArrayBuffer;

/** A gzip or zlib ("deflate") stream's bytes. */
export async function inflate(body: ReadableStream<Bytes>, format: "gzip" | "deflate"): Promise<Uint8Array> {
	return new Uint8Array(await new Response(body.pipeThrough(new DecompressionStream(format))).arrayBuffer());
}

/** A live chunk's d (Lua's encode_string: zlib, then base64) as the chart's bytes; "" (deleted) as undefined. */
export async function chart(d: string): Promise<Uint8Array | undefined> {
	const bytes = Uint8Array.from(atob(d), c => c.charCodeAt(0));
	return d === "" ? undefined : inflate(new Blob([bytes]).stream(), "deflate");
}

/** A fetched body, gunzipped; undefined unless the answer is 200 with a body. */
async function unzip(res: Response): Promise<Uint8Array | undefined> {
	return res.status === 200 && res.body ? inflate(res.body, "gzip") : undefined;
}

/**
 * The Clusterio page's files (§9.1, K14): the controller's routes, under the web UI's root, with the user's token.
 * `live` is the subscription (web/index.tsx), which needs the web UI's control link.
 */
export function apiSource(
	root: string, token: () => string, live: Source["live"], get: typeof fetch = fetch,
): Source {
	const call = (path: string, cache: RequestInit["cache"]) => get(`${root}api/minimap/${path}`, {
		headers: { "X-Access-Token": token() }, cache,
	});
	return {
		// A mutable key is revalidated (an ETag, so mostly a 304): an index the browser held for its max-age=60 would
		// miss the file a close just wrote, which the open window fetched first no longer has.
		get: async key => unzip(await call(`data/${key}`, /\.[smck]\.gz$/.test(key) ? "default" : "no-cache")),
		// B's ruling 9: 204 when nothing is open; the records are relative to X-Minimap-T.
		async open(key) {
			const res = await call(`open/${key}`, "no-store");
			const bytes = await unzip(res);
			return bytes && { t: Number(res.headers.get("X-Minimap-T")), bytes };
		},
		live,
		// R2: the export's files, from the controller's public static route.
		icon: key => `${root}static/${key.slice("icons/".length)}`,
	};
}

/**
 * The public page's files (§10.3): keys relative to the page, in the bucket it is served from. Each answer's Date
 * header is the server's clock, which feeds the data clock (plan ruling 3). `live` polls live.json.gz every
 * `live_ms` while the catalog lists it (§11.1, REV M-7), and shapes each new one as a live update: every mover, and
 * the ids gone since the last. A file no newer than the last accepted is skipped (a slow poll out of order), and
 * the live key is revalidated, so an early tick doesn't get the browser's cached file.
 */
export function bucketSource(onDate: (t: number) => void, get: typeof fetch = fetch): Source {
	const fetchKey = async (key: string, init?: RequestInit) => {
		const res = await get(key, init);
		const date = Date.parse(res.headers.get("Date") ?? "");
		if (!Number.isNaN(date)) {
			onDate(date);
		}
		return unzip(res);
	};
	return {
		get: key => fetchKey(key),
		icon: key => key,
		live(map, surface, catalog, on) {
			if (!catalog.maps[map]?.surfaces[surface]?.live) {
				return () => {};
			}
			let stopped = false;
			let last = -Infinity;
			let ids = new Set<string>();
			const poll = async () => {
				const bytes = await fetchKey(liveKey(map, surface), { cache: "no-cache" });
				const file = bytes && JSON.parse(new TextDecoder().decode(bytes)) as { t: number; movers: LiveMover[] };
				if (stopped || !file || file.t <= last) {
					return;
				}
				last = file.t;
				const now = new Set(file.movers.map(m => m[0]));
				on({ t: file.t, map, surface, movers: file.movers, gone: [...ids].filter(id => !now.has(id)) });
				ids = now;
			};
			// ponytail: a failed poll is skipped; the next one, live_ms later, tries again.
			const tick = () => {
				poll().catch(() => {});
			};
			tick();
			const timer = setInterval(tick, catalog.live_ms);
			return () => {
				stopped = true;
				clearInterval(timer);
			};
		},
	};
}
