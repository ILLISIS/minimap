// Helpers for the minimap's unit tests. Not a test file: the runner only picks up *.test.js.
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { gzipSync } from "node:zlib";
import type * as lib from "@clusterio/lib";
import type { LiveMover } from "../../contracts.js";
import type { S3Config, Timing } from "../../s3/publisher.js";

export type Line = { level: string; message: string; meta: Record<string, any> };

/** A logger that keeps its lines: lifecycle() calls log(), rateLimited() warn(). */
export function fakeLogger(lines: Line[] = []): lib.Logger {
	const log = (level: string, message: string, meta: Record<string, any> = {}) => {
		lines.push({ level, message, meta });
	};
	return {
		log,
		warn: (message: string, meta?: Record<string, any>) => log("warn", message, meta),
		error: (message: string, meta?: Record<string, any>) => log("error", message, meta),
	} as unknown as lib.Logger;
}

export const tempDir = (prefix: string) => mkdtemp(join(tmpdir(), `mm-${prefix}-`));

/** The publisher's waits, shortened; and a config with S3 storage on (§10.1). */
export const FAST: Timing = { live: 30, drain: 300, backoff: 5, maxBackoff: 20, auth: 25, livePut: 1000 };
export const CONFIG: S3Config = {
	endpoint: "https://acct.example.com", bucket: "map", accessKeyId: "KEYID1234", secretAccessKey: "s3cr3t-value",
	region: "auto", windowMs: 300_000,
};

export type Live = { map: string; surface: string; t: number; movers: LiveMover[] };
export type Call = { key: string; headers: Record<string, string>; body: Buffer; url: string };

/** A Store as the publisher sees it (K36), over a temp folder; close(keys) plays a window's close. */
export async function fakeStore() {
	const root = await tempDir("s3");
	const listeners: ((keys: string[]) => void)[] = [];
	const live = new Map<string, Live>();
	return {
		root,
		onWindowClosed: (cb: (keys: string[]) => void) => {
			listeners.push(cb);
		},
		path: (key: string) => join(root, ...key.split("/")),
		keys: async () => (await readdir(root, { recursive: true }))
			.map(f => f.split(sep).join("/")).filter(k => k.endsWith(".gz")).sort(),
		liveChanged: () => {
			const out = [...live.values()];
			live.clear();
			return out;
		},
		/** A window closed: its files are written, then the listeners get the keys. */
		close: async (...keys: string[]) => {
			for (const key of keys) {
				await mkdir(dirname(join(root, ...key.split("/"))), { recursive: true });
				await writeFile(join(root, ...key.split("/")), gzipSync(key));
			}
			for (const listener of listeners) {
				listener(keys);
			}
		},
		/** The listeners get keys whose files aren't written. */
		announce: (...keys: string[]) => {
			for (const listener of listeners) {
				listener(keys);
			}
		},
		moved: (l: Live) => {
			live.set(`${l.map}|${l.surface}`, l);
		},
	};
}

/** A fetch that records each PUT and answers with answer(call): a status, or 0 for a network error. */
export function fakeFetch(answer: (call: Call, calls: Call[]) => number | Promise<number> = () => 200) {
	const calls: Call[] = [];
	const fetch = (async (url: string, init: RequestInit) => {
		const call = {
			key: new URL(url).pathname.split("/").slice(2).join("/"),
			headers: init.headers as Record<string, string>,
			body: Buffer.from(init.body as Uint8Array),
			url,
		};
		calls.push(call);
		const status = await new Promise<number>((resolve, reject) => {
			init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
			Promise.resolve(answer(call, calls)).then(resolve, reject);
		});
		if (status === 0) {
			throw new TypeError("fetch failed");
		}
		return new Response(null, { status });
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

export async function until(check: () => boolean, ms = 3000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) {
			throw new Error("timed out");
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}

export const quiet = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
