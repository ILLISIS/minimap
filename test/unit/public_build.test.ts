import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

// Compiled to dist/node/test/unit/; dist/ is three levels up. `./dev test unit` runs webpack before the tests.
const dist = join(import.meta.dirname, "..", "..", "..");

test("the public build is one self-contained file, dist/public/viewer.js, that Plan C uploads (§10.8)", async () => {
	assert.deepEqual(await readdir(join(dist, "public")), ["viewer.js"]);
	const js = await readFile(join(dist, "public", "viewer.js"), "utf8");
	assert.doesNotMatch(js, /sourceMappingURL/, "no source map to fetch");
	for (const chunky of ["__webpack_require__.p", "__webpack_require__.e", "import("]) {
		assert.ok(!js.includes(chunky), `no runtime chunk loading: ${chunky}`);
	}
});

test("the public page's script is the placeholder Plan C fills in", async () => {
	const html = await readFile(join(dist, "..", "web", "public", "index.html"), "utf8");
	assert.match(html, /<script src="__VIEWER_JS__"><\/script>/);
	assert.equal(html.split("__VIEWER_JS__").length - 1, 1, "the placeholder appears once");
});
