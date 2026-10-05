import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import * as lib from "@clusterio/lib";
import type { LiveMover } from "../../contracts.js";
import { Publisher, attachRestarts, puts, queued, type S3Config } from "../../s3/publisher.js";
import { sha256 } from "../../s3/sigv4.js";
import { CONFIG, FAST, fakeFetch, fakeLogger, fakeStore, quiet, until, type Line } from "./fakes.js";

function setup(
	store: Awaited<ReturnType<typeof fakeStore>>,
	fetch: typeof globalThis.fetch,
	config: () => S3Config = () => CONFIG,
	lines: Line[] = [],
	timing = FAST,
) {
	return new Publisher(store, join(store.root, "s3.json"), fakeLogger(lines), config, undefined, fetch, timing);
}

test("one PUT at a time, in order; a mutable key sent again moves to the end, unless it names no file or never " +
	"changes", async () => {
	const store = await fakeStore();
	let release!: () => void;
	const held = new Promise<number>(resolve => {
		release = () => resolve(200);
	});
	const { fetch, calls } = fakeFetch((_, all) => (all.length === 1 ? held : 200));
	const p = setup(store, fetch);
	await p.restart();
	const [one, two, index, tags] = ["0/0_0/1.c.gz", "0/0_0/2.c.gz", "0/0_0/index.json.gz", "tags.json.gz"]
		.map(k => `i-1/nauvis/player/${k}`);
	await store.close(one, tags, index, "maps.json.gz");
	await until(() => calls.length === 1);
	await store.close(two, index, tags, "maps.json.gz", one, two);
	release();
	await until(() => calls.length === 5);
	await quiet(50);
	assert.deepEqual(calls.map(c => c.key), [one, tags, two, index, "maps.json.gz"],
		"the index and the catalog behind 2.c.gz; tags keeps its place (it names nothing); 1 and 2 once each");
	await p.shutdown();
});

test("§10.4's headers: path-style URL, every header signed, Cache-Control by kind, gzip with no Content-Encoding",
	async () => {
		const store = await fakeStore();
		const { fetch, calls } = fakeFetch();
		const p = setup(store, fetch);
		await p.restart();
		await store.close("i-1/nauvis/m/7.m.gz", "maps.json.gz");
		store.moved({ map: "i-1", surface: "nauvis", t: 9, movers: [] });
		await until(() => calls.length === 3);
		const [data, catalog, live] = calls;
		assert.equal(data.url, "https://acct.example.com/map/i-1/nauvis/m/7.m.gz");
		assert.equal(data.headers["cache-control"], "public, max-age=31536000, immutable");
		assert.equal(catalog.headers["cache-control"], "public, max-age=60");
		assert.equal(live.key, "i-1/nauvis/live.json.gz");
		assert.equal(live.headers["cache-control"], "public, max-age=5");
		for (const call of calls) {
			assert.equal(call.headers["content-type"], "application/gzip");
			assert.equal(call.headers["content-encoding"], undefined);
			assert.equal(call.headers.host, undefined);
			assert.equal(call.headers["x-amz-content-sha256"], sha256(call.body));
			assert.match(call.headers.authorization, new RegExp(
				"^AWS4-HMAC-SHA256 Credential=KEYID1234/\\d{8}/auto/s3/aws4_request," +
				"SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date,Signature=[0-9a-f]{64}$",
			));
		}
		assert.equal(data.body.toString("hex"), (await readFile(store.path("i-1/nauvis/m/7.m.gz"))).toString("hex"),
			"the file's own bytes");
		await p.shutdown();
	});

test("retries by status: back off on network errors, 5xx and 429; auth waits; another 4xx drops", async () => {
	const store = await fakeStore();
	const answers: Record<string, number[]> = {
		"a.c.gz": [500, 429, 0, 200],
		"b.c.gz": [403, 200],
		"c.c.gz": [400],
		"d.c.gz": [200],
	};
	const { fetch, calls } = fakeFetch(call => answers[call.key].shift()!);
	const lines: Line[] = [];
	const before = ["ok", "error", "auth", "rejected"].map(r => puts.labels(r).get());
	const p = setup(store, fetch, () => CONFIG, lines);
	await p.restart();
	await store.close("a.c.gz", "b.c.gz", "c.c.gz", "d.c.gz");
	await until(() => calls.some(c => c.key === "d.c.gz"));
	assert.deepEqual(calls.map(c => c.key), [
		"a.c.gz", "a.c.gz", "a.c.gz", "a.c.gz", "b.c.gz", "b.c.gz", "c.c.gz", "d.c.gz",
	]);
	assert.deepEqual(["ok", "error", "auth", "rejected"].map((r, i) => puts.labels(r).get() - before[i]), [3, 3, 1, 1]);
	const failed = lines.filter(l => l.message === "minimap.s3 put_failed");
	assert.deepEqual(failed.map(l => [l.level, l.meta.kind, l.meta.status, l.meta.attempt]), [
		["warn", "file", 500, 1], ["warn", "file", 429, 2], ["warn", "file", 0, 3], ["warn", "file", 403, 1],
	]);
	const dropped = lines.find(l => l.message === "minimap.s3 dropped")!;
	assert.deepEqual([dropped.level, dropped.meta.key, dropped.meta.status], ["error", "c.c.gz", 400]);
	await p.shutdown();
	const logged = JSON.stringify(lines);
	assert.ok(!logged.includes(CONFIG.accessKeyId!) && !logged.includes(CONFIG.secretAccessKey!));
});

test("a missing file is skipped", async () => {
	const store = await fakeStore();
	const { fetch, calls } = fakeFetch();
	const p = setup(store, fetch);
	await p.restart();
	await store.close("b.c.gz");
	store.announce("gone.c.gz", "c.c.gz");
	await store.close("d.c.gz");
	await until(() => calls.length === 2);
	await quiet(50);
	assert.deepEqual(calls.map(c => c.key), ["b.c.gz", "d.c.gz"]);
	await p.shutdown();
});

test("the queue persists in s3.json: a restart with the same target resumes it, a new target backfills", async () => {
	const store = await fakeStore();
	await store.close("i-1/n/p/0/0_0/1.c.gz", "i-1/n/p/0/0_0/index.json.gz", "maps.json.gz", "i-1/n/m/2.m.gz",
		"i-1/n/m/2020-01-01.json.gz", "i-1/n/p/tags.json.gz", "i-1/n/p/0/0_0/recipes.json.gz");
	const stuck = fakeFetch(() => new Promise<number>(() => undefined));
	const lines: Line[] = [];
	let config = CONFIG;
	const first = setup(store, stuck.fetch, () => config, lines);
	await first.restart();
	assert.deepEqual(lines.filter(l => l.message === "minimap.s3 backfill").map(l => l.meta.files), [7]);
	await until(() => stuck.calls.length === 1);
	assert.deepEqual(stuck.calls.map(c => c.key), ["i-1/n/m/2.m.gz"], "backfill: immutable files by key first");
	await store.close("i-1/n/p/0/0_0/3.c.gz", "i-1/n/p/0/0_0/index.json.gz", "maps.json.gz");
	await until(() => queued.get() === 8);
	await first.shutdown();
	const saved = JSON.parse(await readFile(join(store.root, "s3.json"), "utf8"));
	assert.deepEqual(saved, { schema: 1, data: { target: "acct.example.com/map", queue: [
		"i-1/n/m/2.m.gz", "i-1/n/m/2020-01-01.json.gz", "i-1/n/p/0/0_0/1.c.gz", "i-1/n/p/0/0_0/recipes.json.gz",
		"i-1/n/p/tags.json.gz", "i-1/n/p/0/0_0/3.c.gz", "i-1/n/p/0/0_0/index.json.gz", "maps.json.gz",
	] } }, "a finished day index is immutable; a close's keys after the backfill's, its index and catalog moved last");

	const ok = fakeFetch();
	const second = setup(store, ok.fetch, () => config, lines);
	await second.restart();
	await until(() => ok.calls.length === 8);
	assert.deepEqual(ok.calls.map(c => c.key), saved.data.queue, "resumed, in order, with no backfill");
	assert.equal(lines.filter(l => l.message === "minimap.s3 backfill").length, 1);
	config = { ...CONFIG, accessKeyId: "KEYID5678", secretAccessKey: "other" };
	await second.restart();
	await quiet(50);
	assert.equal(ok.calls.length, 8, "new keys, same target: nothing to send");
	config = { ...CONFIG, bucket: "map2" };
	await second.restart();
	await until(() => ok.calls.length === 16);
	assert.deepEqual(ok.calls.slice(8).map(c => c.url.split("/")[3]), Array(8).fill("map2"));
	assert.deepEqual(ok.calls.slice(8).map(c => c.key), [
		"i-1/n/m/2.m.gz", "i-1/n/m/2020-01-01.json.gz", "i-1/n/p/0/0_0/1.c.gz", "i-1/n/p/0/0_0/3.c.gz",
		"i-1/n/p/0/0_0/recipes.json.gz", "i-1/n/p/tags.json.gz", "i-1/n/p/0/0_0/index.json.gz", "maps.json.gz",
	], "a new bucket: the whole store again, each file before what names it");
	await second.shutdown();
});

test("the live lane PUTs each changed map surface's live file every period; the latest wins, nothing is retried",
	async () => {
		const store = await fakeStore();
		let release!: () => void;
		const held = new Promise<number>(resolve => {
			release = () => resolve(200);
		});
		const answers = [held, 500];
		const { fetch, calls } = fakeFetch(() => answers.shift() ?? 200);
		const p = setup(store, fetch);
		await p.restart();
		const car = (t: number): LiveMover => ["i-1.5.v7", "v", "player", "car", 0, t, 0, 1, 0, t];
		store.moved({ map: "i-1", surface: "nauvis", t: 1, movers: [car(1)] });
		await until(() => calls.length === 1);
		store.moved({ map: "i-1", surface: "nauvis", t: 2, movers: [car(2)] });
		await quiet(100);
		store.moved({ map: "i-1", surface: "nauvis", t: 3, movers: [car(3)] });
		assert.equal(calls.length, 1, "no second PUT while the first is in flight");
		release();
		await until(() => calls.length === 2);
		store.moved({ map: "i-1", surface: "nauvis", t: 4, movers: [car(4)] });
		await until(() => calls.length === 3);
		await quiet(150);
		const bodies = calls.map(c => JSON.parse(gunzipSync(c.body).toString()) as { t: number; movers: LiveMover[] });
		assert.deepEqual(bodies.map(b => b.t), [1, 3, 4], "t = 2 was never sent: t = 3 replaced it");
		assert.deepEqual(bodies[1], { t: 3, movers: [car(3)] });
		assert.equal(calls.length, 3, "the second (t = 3) answered 500 and wasn't retried");
		await p.shutdown();
	});

test("off unless the endpoint, the bucket and both keys are set: no PUT, no timer, no s3.json", async () => {
	for (const field of ["endpoint", "bucket", "accessKeyId", "secretAccessKey"] as const) {
		const store = await fakeStore();
		const { fetch, calls } = fakeFetch();
		const p = setup(store, fetch, () => ({ ...CONFIG, [field]: null }));
		await p.restart();
		assert.equal(p.on, false, field);
		await store.close("a.c.gz");
		store.moved({ map: "i-1", surface: "nauvis", t: 1, movers: [] });
		await quiet(80);
		await p.shutdown();
		assert.equal(calls.length, 0, field);
		assert.equal(existsSync(join(store.root, "s3.json")), false, field);
	}
});

test("turning it off forgets the target, so turning it on again backfills; neither key is ever logged or saved",
	async () => {
		const store = await fakeStore();
		await store.close("a.c.gz");
		const lines: Line[] = [];
		let config: S3Config = CONFIG;
		const { fetch, calls } = fakeFetch();
		const p = setup(store, fetch, () => config, lines);
		await p.restart();
		await until(() => calls.length === 1);
		config = { ...CONFIG, secretAccessKey: null };
		await p.restart();
		assert.equal(p.on, false);
		config = CONFIG;
		await p.restart();
		await until(() => calls.length === 2);
		assert.deepEqual(lines.filter(l => l.meta.op === "minimap.s3").map(l => [l.level, l.meta.phase]), [
			["info", "backfill"], ["info", "enabled"], ["info", "disabled"], ["info", "backfill"], ["info", "enabled"],
		]);
		assert.deepEqual(lines.find(l => l.meta.phase === "enabled")!.meta,
			{ host: "acct.example.com", bucket: "map", op: "minimap.s3", phase: "enabled" });
		await p.shutdown();
		const text = [JSON.stringify(lines), await readFile(join(store.root, "s3.json"), "utf8"),
			...calls.map(c => c.url + c.body.toString("latin1"))].join("\n");
		assert.ok(!text.includes(CONFIG.accessKeyId!) && !text.includes(CONFIG.secretAccessKey!));
	});

test("shutdown drains the file lane, then PUTs the final live file", async () => {
	const store = await fakeStore();
	const { fetch, calls } = fakeFetch(async () => {
		await quiet(20);
		return 200;
	});
	const p = setup(store, fetch, () => CONFIG, [], { ...FAST, live: 60_000 });
	await p.restart();
	await store.close("a.c.gz", "b.c.gz", "c.c.gz", "maps.json.gz");
	store.moved({ map: "i-1", surface: "nauvis", t: 5, movers: [] });
	await p.shutdown();
	assert.deepEqual(calls.map(c => c.key), ["a.c.gz", "b.c.gz", "c.c.gz", "maps.json.gz", "i-1/nauvis/live.json.gz"]);
	assert.equal(p.on, false);
});

test("shutdown waits for the lane no longer than its bound, then still tries the final live file, itself bounded",
	async () => {
		const store = await fakeStore();
		const hang = new Promise<number>(() => undefined);
		const { fetch, calls } = fakeFetch(call => (call.key === "a.c.gz" ? 503 : hang));
		const p = setup(store, fetch, () => CONFIG, [], { ...FAST, live: 60_000, drain: 200, livePut: 100 });
		await p.restart();
		await store.close("a.c.gz", "b.c.gz");
		store.moved({ map: "i-1", surface: "nauvis", t: 5, movers: [] });
		const started = Date.now();
		await p.shutdown();
		const took = Date.now() - started;
		assert.ok(took >= 290 && took < 1000, `${took} ms: the drain's 200, then the live PUT's 100`);
		assert.ok(calls.some(c => c.key === "i-1/nauvis/live.json.gz"), "the final live file was tried");
		assert.ok(!calls.some(c => c.key === "b.c.gz"), "b waits behind a: one at a time, in order");
		const saved = JSON.parse(await readFile(join(store.root, "s3.json"), "utf8"));
		assert.deepEqual(saved.data.queue, ["a.c.gz", "b.c.gz"], "kept for the next start");
	});

test("Review Focus 1: a secret fixed during 403 retries is used at once, with no backfill", async () => {
	const store = await fakeStore();
	const { fetch, calls } = fakeFetch(call => (call.headers.authorization.includes("KEYID1234") ? 403 : 200));
	const lines: Line[] = [];
	let config = CONFIG;
	const p = setup(store, fetch, () => config, lines, { ...FAST, auth: 60_000 });
	await p.restart();
	await store.close("a.c.gz", "b.c.gz");
	await until(() => calls.length === 1);
	config = { ...CONFIG, accessKeyId: "KEYID5678" };
	await p.restart();
	await until(() => calls.length === 3);
	assert.deepEqual(calls.map(c => [c.key, c.headers.authorization.includes("KEYID5678")]),
		[["a.c.gz", false], ["a.c.gz", true], ["b.c.gz", true]]);
	assert.equal(lines.filter(l => l.message === "minimap.s3 backfill").length, 1, "only the first start's");
	await p.shutdown();
});

test("Review Focus 2: a close during a start is kept, after the start's own queue", async () => {
	const store = await fakeStore();
	await store.close("a.c.gz");
	let release!: () => void;
	const held = new Promise<string[]>(resolve => {
		release = () => resolve([]);
	});
	const { fetch, calls } = fakeFetch();
	const p = new Publisher(store, join(store.root, "s3.json"), fakeLogger(), () => CONFIG, () => held, fetch, FAST);
	const started = p.restart();
	await quiet(20);
	await store.close("b.c.gz");
	release();
	await started;
	await until(() => calls.length === 2);
	assert.deepEqual(calls.map(c => c.key), ["a.c.gz", "b.c.gz"]);
	await p.shutdown();
});

test("Review Focus 3: a mutable file rewritten during its own PUT goes up again, with its new bytes", async () => {
	const store = await fakeStore();
	let release!: () => void;
	const held = new Promise<number>(resolve => {
		release = () => resolve(200);
	});
	const { fetch, calls } = fakeFetch((_, all) => (all.length === 1 ? held : 200));
	const p = setup(store, fetch);
	await p.restart();
	await store.close("maps.json.gz");
	await until(() => calls.length === 1);
	await writeFile(store.path("maps.json.gz"), "newer");
	store.announce("maps.json.gz");
	release();
	await until(() => calls.length === 2);
	assert.equal(calls[1].body.toString(), "newer");
	await p.shutdown();
});

test("Review Focus 4: a start that throws (an endpoint without its scheme) is off, and the next good one backfills",
	async () => {
		const store = await fakeStore();
		const lines: Line[] = [];
		const { fetch, calls } = fakeFetch();
		let config = CONFIG;
		const p = setup(store, fetch, () => config, lines);
		await p.restart();
		await store.close("a.c.gz");
		await until(() => calls.length === 1);
		config = { ...CONFIG, endpoint: "acct.example.com" };
		await p.restart();
		assert.equal(p.on, false);
		assert.ok(lines.some(l => l.level === "error" && l.message.includes("Invalid URL")));
		config = { ...CONFIG, endpoint: "localhost:9000" };
		await p.restart();
		assert.equal(p.on, false);
		assert.equal(lines.filter(l => l.level === "error" && l.message.includes("Invalid URL")).length, 2);
		await store.close("b.c.gz");
		config = CONFIG;
		await p.restart();
		await until(() => calls.length === 3);
		assert.deepEqual(calls.map(c => c.key), ["a.c.gz", "a.c.gz", "b.c.gz"],
			"a backfill (plan ruling 4): b.c.gz, closed while it was off, isn't lost");
		await p.shutdown();
	});

test("Review Focus 3: a mutable file rewritten by a close still handing over waits behind the files it names",
	async () => {
		const store = await fakeStore();
		let release!: () => void;
		const held = new Promise<number>(resolve => {
			release = () => resolve(200);
		});
		const { fetch, calls } = fakeFetch((_, all) => (all.length === 1 ? held : 200));
		const p = setup(store, fetch);
		await p.restart();
		await store.close("a/1.c.gz", "a/index.json.gz");
		await until(() => calls.length === 1);
		await quiet(20); // past the hand-over's millisecond, and a coarse file clock's tick
		// The next close writes 2.c.gz and rewrites the index; its listener hasn't run, and the lane reaches the index.
		await writeFile(store.path("a/2.c.gz"), gzipSync("2"));
		await writeFile(store.path("a/index.json.gz"), gzipSync("names 1 and 2"));
		release();
		await quiet(50);
		store.announce("a/2.c.gz", "a/index.json.gz");
		await until(() => calls.length === 3);
		await quiet(50);
		assert.deepEqual(calls.map(c => c.key), ["a/1.c.gz", "a/2.c.gz", "a/index.json.gz"]);
		assert.equal(gunzipSync(calls[2].body).toString(), "names 1 and 2");
		await p.shutdown();
	});

test("a new target's first live round puts every live file again, parked surfaces included (plan ruling 13)",
	async () => {
		const store = await fakeStore();
		const { fetch, calls } = fakeFetch();
		let config = CONFIG;
		const p = setup(store, fetch, () => config);
		await p.restart();
		store.moved({ map: "i-1", surface: "nauvis", t: 1, movers: [] });
		store.moved({ map: "i-1", surface: "vulcanus", t: 2, movers: [] });
		await until(() => calls.length === 2);
		config = { ...CONFIG, bucket: "map2" };
		await p.restart();
		store.moved({ map: "i-1", surface: "nauvis", t: 3, movers: [] });
		await until(() => calls.length === 4);
		await quiet(100);
		const t = (body: Buffer) => (JSON.parse(gunzipSync(body).toString()) as { t: number }).t;
		assert.deepEqual(calls.slice(2).map(c => [c.url.split("/")[3], c.key, t(c.body)]), [
			["map2", "i-1/nauvis/live.json.gz", 3], ["map2", "i-1/vulcanus/live.json.gz", 2],
		]);
		assert.equal(calls.length, 4, "once each");
		await p.shutdown();
	});

test("a minimap.s3_* change, the default mod pack's id and a mod pack change restart the publisher; W doesn't",
	async () => {
		const hooks = {
			controllerConfigFieldChanged: new lib.AsyncHook<[string, unknown, unknown]>(fakeLogger()),
			modPacksUpdated: new lib.AsyncHook<[lib.ModPack[]]>(fakeLogger()),
		};
		let restarts = 0;
		attachRestarts(hooks, "minimap", {
			restart: async () => {
				restarts += 1;
			},
		});
		await hooks.controllerConfigFieldChanged.invoke("minimap.s3_secret_access_key", "x", null);
		await hooks.controllerConfigFieldChanged.invoke("minimap.window_seconds", 60, 300);
		await hooks.controllerConfigFieldChanged.invoke("controller.default_mod_pack_id", 2, 1);
		await hooks.modPacksUpdated.invoke([]);
		assert.equal(restarts, 3);
	});

test("a file the lane reaches before its close's hand-over waits at the head: no catalog or index naming a file " +
	"not yet up goes first", async () => {
	const store = await fakeStore();
	let release!: () => void;
	const held = new Promise<number>(resolve => {
		release = () => resolve(200);
	});
	const { fetch, calls } = fakeFetch((_, all) => (all.length === 1 ? held : 200));
	const p = setup(store, fetch);
	await p.restart();
	await store.close("a/1.c.gz", "a/index.json.gz", "maps.json.gz");
	await until(() => calls.length === 1);
	await quiet(20);
	// The next close writes 2.c.gz, then the index; its listener is yet to run: the lane reaches index, catalog.
	await writeFile(store.path("a/2.c.gz"), gzipSync("2"));
	await writeFile(store.path("a/index.json.gz"), gzipSync("names 1 and 2"));
	release();
	await quiet(50);
	await writeFile(store.path("maps.json.gz"), gzipSync("names the index"));
	store.announce("a/2.c.gz", "a/index.json.gz", "maps.json.gz");
	await until(() => calls.length === 4);
	await quiet(50);
	assert.deepEqual(calls.map(c => c.key), ["a/1.c.gz", "a/2.c.gz", "a/index.json.gz", "maps.json.gz"]);
	await p.shutdown();
});

test("a restart stops the old live timer and lane: one live PUT per change, one lane's retries", async () => {
	const store = await fakeStore();
	const { fetch, calls } = fakeFetch(call => (call.key.endsWith("live.json.gz") ? 200 : 403));
	let config = CONFIG;
	const p = setup(store, fetch, () => config, [], { ...FAST, auth: 100 });
	await p.restart();
	await store.close("a.c.gz");
	await until(() => calls.length === 1);
	config = { ...CONFIG, accessKeyId: "KEYID5678" };
	await p.restart();
	const before = calls.length;
	for (let t = 1; t <= 5; t += 1) {
		const n = calls.length;
		store.moved({ map: "i-1", surface: "nauvis", t, movers: [] });
		await until(() => calls.length > n && calls[calls.length - 1].key.endsWith("live.json.gz"));
	}
	await quiet(250);
	const lane = calls.slice(before).filter(c => c.key === "a.c.gz").length;
	assert.ok(lane <= 6, `${lane} retries of a.c.gz in about 0.5 s: one lane at 100 ms`);
	assert.equal(calls.filter(c => c.key.endsWith("live.json.gz")).length, 5);
	await p.shutdown();
});

test("off, no live round runs and the queue gauge is 0", async () => {
	const store = await fakeStore();
	let rounds = 0;
	const counted = {
		onWindowClosed: store.onWindowClosed, path: store.path, keys: store.keys,
		liveChanged: () => {
			rounds += 1;
			return store.liveChanged();
		},
	};
	let config = CONFIG;
	const { fetch } = fakeFetch(() => 503);
	const p = new Publisher(counted, join(store.root, "s3.json"), fakeLogger(), () => config, undefined, fetch, FAST);
	await p.restart();
	await store.close("a.c.gz");
	await until(() => queued.get() === 1);
	config = { ...CONFIG, secretAccessKey: null };
	await p.restart();
	rounds = 0;
	await quiet(120);
	assert.equal(rounds, 0);
	assert.equal(queued.get(), 0);
	await p.shutdown();
});

test("a start that throws zeroes the queue gauge", async () => {
	const store = await fakeStore();
	let config = CONFIG;
	const { fetch } = fakeFetch(() => 503);
	const p = setup(store, fetch, () => config);
	await p.restart();
	await store.close("a.c.gz");
	await until(() => queued.get() === 1);
	config = { ...CONFIG, endpoint: "acct.example.com" };
	await p.restart();
	assert.equal(queued.get(), 0);
	await p.shutdown();
});

test("a mutable file written in the same millisecond as its close's hand-over is PUT, not left waiting", async () => {
	const store = await fakeStore();
	const { fetch, calls } = fakeFetch();
	const p = setup(store, fetch);
	await p.restart();
	const now = Date.now;
	const frozen = 1_700_000_000_000;
	await writeFile(store.path("maps.json.gz"), gzipSync("x"));
	await utimes(store.path("maps.json.gz"), frozen / 1000, frozen / 1000);
	Date.now = () => frozen;
	try {
		store.announce("maps.json.gz");
		await quiet(150);
	} finally {
		Date.now = now;
	}
	assert.equal(calls.length, 1);
	await p.shutdown();
});

test("a hand-over during the lane's read of a mutable file isn't a lost wake: the key goes up at once", async () => {
	const store = await fakeStore();
	let armed = false;
	const slow = {
		...store,
		path: (key: string) => {
			if (armed) {
				armed = false;
				// The next close's whole hand-over runs inside the lane's read: file written, listeners called.
				for (const end = Date.now() + 3; Date.now() < end;) { /* a later mtime than the last hand-over */ }
				writeFileSync(store.path(key), "newer");
				store.announce(key);
			}
			return store.path(key);
		},
	};
	// The first PUT fails, so the retry's read comes when the queue and the hand-over chain are idle.
	const { fetch, calls } = fakeFetch((_, all) => {
		armed = all.length === 1;
		return all.length === 1 ? 503 : 200;
	});
	const p = setup(slow, fetch);
	await p.restart();
	await writeFile(store.path("maps.json.gz"), gzipSync("old"));
	store.announce("maps.json.gz");
	await until(() => calls.length >= 2, 1000);
	assert.equal(calls[calls.length - 1].body.toString(), "newer");
	await p.shutdown();
});
