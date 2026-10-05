import { readFile, stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import * as lib from "@clusterio/lib";
import { lifecycle, loadDataFile, rateLimited, saveDataFile, type Migration } from "../runtime.js";
import { CATALOG, cacheControl, liveKey } from "../shared/keys.js";
import type { Store } from "../store/index.js";
import { signedPut, type Target } from "./sigv4.js";

/** S3 PUTs by result (spec §14, Plan C2): ok; error (network, 5xx, 429); auth (401, 403); rejected (other 4xx). */
export const puts = new lib.Counter(
	"clusterio_minimap_s3_puts_total",
	"Minimap PUTs to S3 storage, by result",
	{ labels: ["result"] },
);
/** The file lane's length, the PUT in flight included (§14). */
export const queued = new lib.Gauge("clusterio_minimap_s3_queue", "Minimap files waiting for their PUT to S3 storage");

/** §10.1's fields as the controller config holds them, and W in ms for §10.4's day indexes (Plan B ruling 27). */
export type S3Config = {
	endpoint: string | null;
	bucket: string | null;
	accessKeyId: string | null;
	secretAccessKey: string | null;
	region: string;
	windowMs: number;
};

/** The waits, in ms (§10.5, §10.6, §8.10), and a live PUT's bound (plan ruling 7); tests shorten them. */
export const TIMING = {
	live: 5_000, drain: 60_000, backoff: 1_000, maxBackoff: 300_000, auth: 300_000, livePut: 10_000,
};
export type Timing = typeof TIMING;

/** s3.json (§10.5): the target, as host/bucket (never a key), and the keys still to PUT, in order. */
type Saved = { target: string; queue: string[] };
const MIGRATIONS: Migration[] = [];

const TYPES: Record<string, string> = {
	gz: "application/gzip",
	js: "text/javascript",
	html: "text/html; charset=utf-8",
	png: "image/png",
	json: "application/json",
};

function result(status: number): "ok" | "error" | "auth" | "rejected" {
	if (status >= 200 && status < 300) {
		return "ok";
	}
	if (status === 401 || status === 403) {
		return "auth";
	}
	return status >= 400 && status < 500 && status !== 429 ? "rejected" : "error";
}

const immutable = (key: string, asOf: number) => cacheControl(key, asOf).endsWith("immutable");
/** Mutable files that name no other file: a waiting one keeps its place, as it is read when PUT (plan ruling 5). */
const LEAF = /\/(tags|recipes)\.json\.gz$/;
const PAGE = "index.html";

/**
 * The S3 publisher (spec §10, K15): the file lane PUTs each closed window's files once, in order, one at a time, with
 * its queue in s3.json; the live lane PUTs live.json.gz every 5 s, latest wins. Off, it has no lane, timer or
 * network (§10.1). Starts, stops, enqueues and the shutdown run one at a time, in order.
 */
export class Publisher {
	private queue = new Set<string>();
	/** The key whose PUT is in flight, or being retried; out of `queue`. */
	private current?: string;
	private target?: Target;
	private id = "";
	private abort?: AbortController;
	private lane?: Promise<void>;
	private live?: Promise<void>;
	private timer?: ReturnType<typeof setInterval>;
	private wake = () => { };
	private chain: Promise<void> = Promise.resolve();
	private warn: ReturnType<typeof rateLimited>;
	/** When the last close handed over its keys: a mutable file written after it waits for its own close's turn. */
	private closedAt = Date.now();
	/** Each map surface's last live file, put again at a new target's first live round (plan ruling 13). */
	private lives = new Map<string, Buffer>();
	private resend = false;

	constructor(
		private store: Pick<Store, "onWindowClosed" | "path" | "keys" | "liveChanged">,
		private file: string,
		private logger: lib.Logger,
		private config: () => S3Config,
		private pages: () => Promise<string[]> = async () => [],
		private fetch: typeof globalThis.fetch = globalThis.fetch,
		private timing: Timing = TIMING,
	) {
		this.warn = rateLimited(logger);
		store.onWindowClosed(keys => {
			this.closedAt = Date.now();
			void this.serial(async () => {
				if (this.abort) {
					this.enqueue(keys);
					await this.save();
				}
			});
		});
	}

	get on(): boolean {
		return this.abort !== undefined;
	}

	/** At load and on any minimap.s3_* change (§10.1): stop, then start with the config as it is now. */
	restart(): Promise<void> {
		return this.serial(async () => {
			await this.stop();
			try {
				await this.start();
			} catch (err) {
				// A start that throws (a missing page file, an endpoint with no scheme) is off: forget the target, so
				// the next good start backfills what closes in between (plan ruling 4).
				queued.set(0);
				await saveDataFile(this.file, MIGRATIONS, { target: "", queue: [] });
				throw err;
			}
		});
	}

	/** §8.10 steps 3-4, after the store's last close: up to 60 s for the file lane, then a final live file. */
	shutdown(): Promise<void> {
		return this.serial(async () => {
			if (!this.abort) {
				return;
			}
			clearInterval(this.timer);
			const deadline = Date.now() + this.timing.drain;
			// ponytail: polled every 100 ms; the lane has no "idle" event to wait on.
			while ((this.current !== undefined || this.queue.size > 0) && Date.now() < deadline) {
				await sleep(Math.min(100, deadline - Date.now()));
			}
			await this.live;
			await this.liveRound(this.abort.signal).catch(() => undefined);
			await this.stop();
		});
	}

	private async start(): Promise<void> {
		const c = this.config();
		const saved = await loadDataFile(this.file, MIGRATIONS) as Saved | undefined;
		if (!c.endpoint || !c.bucket || !c.accessKeyId || !c.secretAccessKey) {
			queued.set(0);
			// Off: the saved target is forgotten, so the next start backfills (plan ruling 4).
			if (saved?.target) {
				await saveDataFile(this.file, MIGRATIONS, { target: "", queue: [] });
				lifecycle(this.logger, "minimap.s3", "disabled");
			}
			return;
		}
		const url = new URL(c.endpoint);
		if (url.origin === "null") {
			// "localhost:9000" parses with "localhost" as the scheme: refused like an endpoint with no scheme.
			throw new Error(`Invalid URL: ${url.protocol} is not an http(s) endpoint`);
		}
		const host = url.host;
		this.target = {
			endpoint: c.endpoint, bucket: c.bucket, accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey,
			region: c.region,
		};
		this.id = `${host}/${c.bucket}`;
		let keys = saved?.target === this.id ? saved.queue : undefined;
		if (!keys) {
			// §10.5's backfill: immutable files by key, then mutable ones, each before what names it: tags and
			// recipes, then area and day indexes, then the catalog (plan ruling 5).
			const all = await this.store.keys();
			const asOf = this.asOf();
			const group = (key: string) => {
				if (immutable(key, asOf)) {
					return 0;
				}
				if (key === CATALOG) {
					return 3;
				}
				return /(\/index|\/m\/[\d-]+)\.json\.gz$/.test(key) ? 2 : 1;
			};
			keys = [0, 1, 2, 3].flatMap(g => all.filter(key => group(key) === g));
			lifecycle(this.logger, "minimap.s3", "backfill", { files: keys.length });
			this.resend = true;
		}
		// The page's files: the viewer and icons first, index.html last, once its catalog is up (plan ruling 5).
		this.queue = new Set([...await this.pages(), ...keys]);
		if (this.queue.delete(PAGE)) {
			this.queue.add(PAGE);
		}
		this.current = undefined;
		await this.save();
		lifecycle(this.logger, "minimap.s3", "enabled", { host, bucket: c.bucket });
		const abort = new AbortController();
		abort.signal.addEventListener("abort", () => this.wake());
		this.abort = abort;
		this.lane = this.run(abort.signal).catch((err: Error) => {
			if (!abort.signal.aborted) {
				this.logger.error(`minimap.s3 file lane stopped:\n${err.stack ?? err.message}`);
			}
		});
		this.timer = setInterval(() => {
			this.live ??= this.liveRound(abort.signal).catch(() => undefined).finally(() => {
				this.live = undefined;
			});
		}, this.timing.live);
		this.timer.unref(); // the controller's own handles keep the process up; the shutdown drain keeps its own
	}

	private async stop(): Promise<void> {
		if (!this.abort) {
			return;
		}
		clearInterval(this.timer);
		this.abort.abort();
		await this.lane;
		await this.live;
		this.abort = undefined;
		this.target = undefined;
		await this.save();
	}

	/**
	 * §10.5: a key already waiting moves to the end, behind the files it names, unless its bytes never change
	 * (immutable, also while in flight) or it names no other file (tags, recipes: read when PUT).
	 */
	private enqueue(keys: string[]): void {
		const asOf = this.asOf();
		for (const key of keys) {
			const fixed = immutable(key, asOf);
			if ((this.queue.has(key) && (fixed || LEAF.test(key))) || (this.current === key && fixed)) {
				continue;
			}
			this.queue.delete(key);
			this.queue.add(key);
		}
		this.wake();
	}

	private save(): Promise<void> {
		const queue = [...(this.current === undefined ? [] : [this.current]), ...this.queue];
		queued.set(queue.length);
		return saveDataFile(this.file, MIGRATIONS, { target: this.id, queue } satisfies Saved);
	}

	/** The file lane (§10.5): one PUT at a time, retried by status. */
	private async run(signal: AbortSignal): Promise<void> {
		let backoff = this.timing.backoff;
		let attempt = 0;
		while (!signal.aborted) {
			if (this.current === undefined) {
				const next = this.queue.values().next();
				if (next.done) {
					queued.set(0);
					await new Promise<void>(resolve => {
						this.wake = resolve;
					});
					continue;
				}
				this.current = next.value;
				this.queue.delete(next.value);
				[attempt, backoff] = [0, this.timing.backoff];
			}
			queued.set(this.queue.size + 1);
			const key = this.current;
			const closedAt = this.closedAt;
			let body: Buffer;
			let rewritten = false;
			try {
				body = await readFile(this.store.path(key));
				// Read, then stat: a mutable store file written after the last hand-over belongs to a close whose
				// listener is still to come, and may name that close's files, still queued; it re-enqueues this one
				// behind them (plan ruling 6). mtime is floored to Date.now()'s whole milliseconds.
				if (key.endsWith(".gz") && !immutable(key, this.asOf())) {
					rewritten = Math.floor((await stat(this.store.path(key))).mtimeMs) > closedAt;
				}
			} catch (err: any) {
				if (err.code !== "ENOENT") {
					throw err;
				}
				this.current = undefined; // §10.5: a missing file is skipped
				continue;
			}
			if (rewritten) {
				if (this.closedAt !== closedAt) {
					// A hand-over ran during the read: its wake was lost, and its enqueue has the key (or will).
					this.current = undefined;
					continue;
				}
				// Keep its place and wait for the close's hand-over: carrying on would PUT the files naming it first.
				this.queue = new Set([key, ...this.queue]);
				this.current = undefined;
				await new Promise<void>(resolve => {
					this.wake = resolve;
				});
				continue;
			}
			attempt += 1;
			const status = await this.put(key, body, signal);
			const r = result(status);
			if (r === "ok") {
				this.current = undefined;
			} else if (r === "rejected") {
				lifecycle(this.logger, "minimap.s3", "dropped", { key, status }, "error");
				this.current = undefined;
			} else {
				this.failed("file", status, attempt);
				await sleep(r === "auth" ? this.timing.auth : backoff, undefined, { signal });
				backoff = Math.min(backoff * 2, this.timing.maxBackoff);
			}
		}
	}

	/**
	 * The live lane (§10.6): each changed map surface's live file, once, within livePut; nothing is retried. A new
	 * target's first round also puts every live file the publisher has made since it began (plan ruling 13).
	 */
	private async liveRound(signal: AbortSignal): Promise<void> {
		const round = new Map(this.resend ? this.lives : []);
		this.resend = false;
		for (const { map, surface, t, movers } of this.store.liveChanged()) {
			const body = gzipSync(JSON.stringify({ t, movers }));
			this.lives.set(liveKey(map, surface), body);
			round.set(liveKey(map, surface), body);
		}
		for (const [key, body] of round) {
			const status = await this.put(key, body, signal, this.timing.livePut);
			if (result(status) !== "ok") {
				this.failed("live", status, 1);
			}
		}
	}

	/** One signed PUT with §10.4's headers; 0 is a network error or a timeout. Throws once `signal` aborts. */
	private async put(key: string, body: Buffer, signal: AbortSignal, timeoutMs?: number): Promise<number> {
		const headers = {
			"cache-control": `public, ${cacheControl(key, this.asOf())}`,
			"content-type": TYPES[key.slice(key.lastIndexOf(".") + 1)],
		};
		const { url, init } = signedPut(this.target!, key, body, headers);
		let status = 0;
		try {
			const bound = timeoutMs === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
			const res = await this.fetch(url, { ...init, signal: bound });
			await res.arrayBuffer();
			status = res.status;
		} catch (err) {
			if (signal.aborted) {
				throw err;
			}
		}
		puts.labels(result(status)).inc();
		return status;
	}

	/** The clock less W: a day index is immutable once final (Plan B ruling 27). */
	private asOf(): number {
		return Date.now() - this.config().windowMs;
	}

	private failed(kind: "file" | "live", status: number, attempt: number): void {
		const fields = { op: "minimap.s3", phase: "put_failed", kind, status, attempt };
		this.warn(`put_failed ${kind} ${status}`, "minimap.s3 put_failed", fields);
	}

	/** Never rejects: a failure is logged, and the next call runs. */
	private serial(fn: () => Promise<void>): Promise<void> {
		this.chain = this.chain.then(fn).catch((err: Error) => {
			this.logger.error(`minimap.s3 failed:\n${err.stack ?? err.message}`);
		});
		return this.chain;
	}
}

/**
 * The publisher's restarts (§10.1): any minimap.s3_* field; and for the page's icons (§10.8, plan ruling 11), the
 * default mod pack's id and any mod pack change, an export upload included.
 */
export function attachRestarts(
	hooks: {
		controllerConfigFieldChanged: lib.AsyncHook<[field: string, curr: unknown, prev: unknown]>;
		modPacksUpdated: lib.AsyncHook<[modPacks: lib.ModPack[]]>;
	},
	name: string,
	publisher: { restart(): Promise<void> },
): void {
	hooks.controllerConfigFieldChanged.attach(name, async (field: string) => {
		if (field.startsWith("minimap.s3_") || field === "controller.default_mod_pack_id") {
			await publisher.restart();
		}
	});
	hooks.modPacksUpdated.attach(name, async () => {
		await publisher.restart();
	});
}
