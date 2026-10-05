import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import type { LiveMover } from "../../contracts.js";
import { liveKey } from "../../shared/keys.js";
import { apiSource, bucketSource, type Live } from "../../web/view/source.js";
import { catalog } from "./view_fakes.js";

type Call = { url: string; token?: string; cache?: RequestInit["cache"] };

/** A fetch answering from `answers` (url → [status, gzipped body?, headers?]), logging each call. */
function fakeFetch(answers: Map<string, [number, unknown?, Record<string, string>?]>, calls: Call[]): typeof fetch {
	return (async (url: string, init?: RequestInit) => {
		const token = (init?.headers as Record<string, string> | undefined)?.["X-Access-Token"];
		calls.push({ url, token, ...init?.cache && { cache: init.cache } });
		const [status, json, headers] = answers.get(url) ?? [404];
		const bytes = json === undefined ? null : gzipSync(JSON.stringify(json));
		return new Response(bytes, { status, headers });
	}) as typeof fetch;
}

const noLive = () => () => {};

test("the controller source: the data route with the user's token, gunzipped; missing: undefined (§9.1)", async () => {
	const calls: Call[] = [];
	const get = fakeFetch(new Map([["/root/api/minimap/data/maps.json.gz", [200, { a: 1 }]]]), calls);
	const source = apiSource("/root/", () => "tok", noLive, get);
	assert.deepEqual(JSON.parse(new TextDecoder().decode(await source.get("maps.json.gz"))), { a: 1 });
	assert.equal(await source.get("i-1/nope/index.json.gz"), undefined);
	await source.get("i-1/nauvis/player/0/0_0/100.c.gz");
	assert.deepEqual(calls.map(c => [c.url.slice(23), c.token, c.cache]), [
		["maps.json.gz", "tok", "no-cache"], ["i-1/nope/index.json.gz", "tok", "no-cache"],
		["i-1/nauvis/player/0/0_0/100.c.gz", "tok", "default"],
	], "the root and the token; mutable keys revalidated, immutable ones cached (I-1)");
	assert.equal(source.icon("icons/spritesheet.ab12.png"), "/root/static/spritesheet.ab12.png", "R2: static/");
});

test("the open route: 204 is nothing open; 200 is records relative to X-Minimap-T (B's ruling 9)", async () => {
	const calls: Call[] = [];
	const get = fakeFetch(new Map<string, [number, unknown?, Record<string, string>?]>([
		["/api/minimap/open/i-1/nauvis/player/0/0_0", [200, "rec", { "X-Minimap-T": "1759600000123" }]],
		["/api/minimap/open/i-1/nauvis/player/0/1_0", [204]],
	]), calls);
	const source = apiSource("/", () => "tok", noLive, get);
	const open = await source.open!("i-1/nauvis/player/0/0_0");
	assert.deepEqual([open?.t, new TextDecoder().decode(open?.bytes)], [1759600000123, "\"rec\""]);
	assert.equal(await source.open!("i-1/nauvis/player/0/1_0"), undefined);
	assert.deepEqual(calls.map(c => c.cache), ["no-store", "no-store"]);
});

test("the bucket source fetches keys relative to the page, and each answer's Date feeds the clock", async () => {
	const calls: Call[] = [];
	const dates: number[] = [];
	const date = "Sun, 05 Oct 2026 12:00:00 GMT";
	const get = fakeFetch(new Map([["maps.json.gz", [200, { a: 1 }, { Date: date }]]]), calls);
	const source = bucketSource(t => dates.push(t), get);
	assert.ok(await source.get("maps.json.gz"));
	assert.deepEqual([calls[0].url, calls[0].token, dates], ["maps.json.gz", undefined, [Date.UTC(2026, 9, 5, 12)]]);
	assert.equal(source.open, undefined, "no open window in a bucket");
	assert.equal(source.icon("icons/metadata.ab12.json"), "icons/metadata.ab12.json");
});

test("the bucket's live file is polled every live_ms while the catalog lists it (§10.6, §11.1)", async t => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const calls: Call[] = [];
	const key = liveKey("i-1", "nauvis");
	const bob: LiveMover = ["p:bob", "p", "player", "bob", 0, 1, 2, 0, 0, 1000];
	const amy: LiveMover = ["p:amy", "p", "player", "amy", 0, 3, 4, 0, 0, 1500];
	const answers = new Map<string, [number, unknown?]>([[key, [200, { t: 2000, movers: [bob, amy] }]]]);
	const source = bucketSource(() => {}, fakeFetch(answers, calls));
	const seen: Live[] = [];
	// Gunzip runs on the threadpool: wait (real time) until the updates land.
	const until = async (n: number) => {
		for (let i = 0; i < 500 && seen.length < n; i++) {
			await new Promise(resolve => setTimeout(resolve, 2));
		}
	};
	assert.equal(source.live("i-1", "nauvis", catalog([], { live: false }), u => seen.push(u))(), undefined);
	assert.equal(calls.length, 0, "not listed: never probed");
	const stop = source.live("i-1", "nauvis", catalog([]), u => seen.push(u));
	await until(1);
	t.mock.timers.tick(5000);
	await new Promise(resolve => setTimeout(resolve, 50));
	answers.set(key, [200, { t: 7000, movers: [amy] }]);
	t.mock.timers.tick(5000);
	await until(2);
	assert.equal(calls.length, 3);
	assert.equal(calls[0].cache, "no-cache", "the live key is revalidated");
	answers.set(key, [200, { t: 3000, movers: [bob] }]);
	t.mock.timers.tick(5000);
	await new Promise(resolve => setTimeout(resolve, 50));
	assert.equal(calls.length, 4);
	assert.equal(seen.length, 2, "an older file than the last accepted is skipped");
	assert.deepEqual(seen, [
		{ t: 2000, map: "i-1", surface: "nauvis", movers: [bob, amy], gone: [] },
		{ t: 7000, map: "i-1", surface: "nauvis", movers: [amy], gone: ["p:bob"] },
	], "the same file twice is one update");
	stop();
	t.mock.timers.tick(5000);
	assert.equal(calls.length, 4, "stopped");
});
