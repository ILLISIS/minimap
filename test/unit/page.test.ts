import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pageFiles } from "../../s3/page.js";
import { Publisher } from "../../s3/publisher.js";
import { CONFIG, FAST, fakeFetch, fakeLogger, fakeStore, quiet, tempDir, until } from "./fakes.js";

test("the page's files (§10.8): viewer-<sha8>.js, the export's icons, then index.html naming the viewer", async () => {
	const dir = await tempDir("page");
	const root = join(dir, "store");
	const src = (f: string) => join(dir, f);
	await writeFile(src("viewer.js"), "console.log(1);");
	await writeFile(src("index.html"), "<script src=\"__VIEWER_JS__\"></script>");
	await writeFile(src("spritesheet.3f9a1c.png"), "png");
	await writeFile(src("metadata.77aa01.json"), "[]");
	const viewer = `viewer-${createHash("sha256").update("console.log(1);").digest("hex").slice(0, 8)}.js`;
	const keys = await pageFiles(root, src("viewer.js"), src("index.html"),
		[src("spritesheet.3f9a1c.png"), src("metadata.77aa01.json")]);
	assert.deepEqual(keys, [viewer, "icons/spritesheet.3f9a1c.png", "icons/metadata.77aa01.json", "index.html"]);
	assert.equal(await readFile(join(root, "index.html"), "utf8"), `<script src="${viewer}"></script>`);
	assert.equal(await readFile(join(root, viewer), "utf8"), "console.log(1);");
	assert.equal(await readFile(join(root, "icons", "metadata.77aa01.json"), "utf8"), "[]");
	assert.deepEqual(await pageFiles(root, src("viewer.js"), src("index.html"), []), [viewer, "index.html"],
		"no export, no icons (§11.7: the viewer draws text)");
});

test("each start PUTs the viewer and the icons first and index.html last, with their types and §10.4's Cache-Control",
	async () => {
		const store = await fakeStore();
		const dir = await tempDir("page");
		await writeFile(join(dir, "viewer.js"), "v");
		await writeFile(join(dir, "index.html"), "__VIEWER_JS__");
		await writeFile(join(dir, "spritesheet.3f9a1c.png"), "png");
		await store.close("a.c.gz");
		const pages = () => pageFiles(store.root, join(dir, "viewer.js"), join(dir, "index.html"),
			[join(dir, "spritesheet.3f9a1c.png")]);
		const { fetch, calls } = fakeFetch();
		const p = new Publisher(store, join(store.root, "s3.json"), fakeLogger(), () => CONFIG, pages, fetch, FAST);
		await p.restart();
		await until(() => calls.length === 4);
		const immutable = "public, max-age=31536000, immutable";
		assert.deepEqual(calls.map(c => [c.key.replace(/^viewer-\w+/, "viewer"), c.headers["content-type"],
			c.headers["cache-control"]]), [
			["viewer.js", "text/javascript", immutable],
			["icons/spritesheet.3f9a1c.png", "image/png", immutable],
			["a.c.gz", "application/gzip", immutable],
			["index.html", "text/html; charset=utf-8", "public, max-age=300"],
		], "the page loads only once what it reads is up (plan ruling 5)");
		await p.shutdown();
	});

test("Review Focus 5: a restart PUTs the page's files again, so a new icon export reaches the bucket", async () => {
	const store = await fakeStore();
	const sets = [["icons/spritesheet.aaaa.png"], ["icons/spritesheet.bbbb.png"]];
	const pages = async () => {
		const keys = sets.shift()!;
		await store.close(...keys);
		return keys;
	};
	const { fetch, calls } = fakeFetch();
	const p = new Publisher(store, join(store.root, "s3.json"), fakeLogger(), () => CONFIG, pages, fetch, FAST);
	await p.restart();
	await until(() => calls.length === 1);
	await p.restart();
	await until(() => calls.length === 2);
	await quiet(50);
	assert.deepEqual(calls.map(c => c.key), ["icons/spritesheet.aaaa.png", "icons/spritesheet.bbbb.png"],
		"no backfill on the second start: the target is the same");
	await p.shutdown();
});
