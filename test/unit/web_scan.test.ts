import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

// Compiled to dist/node/test/unit/; the plugin root is four levels up.
const web = join(import.meta.dirname, "..", "..", "..", "..", "web");
const HTML = /innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML|document\.write/;

test("no file under web/ writes HTML from strings: game text goes through textContent or fillText (M-13)", async () => {
	const files = (await readdir(web, { recursive: true })).filter(f => /\.(ts|tsx|js|jsx|mjs|cjs|html)$/.test(f));
	assert.ok(files.includes(join("view", "viewer.ts")) && files.includes("layers.ts"), files.join(", "));
	for (const file of files) {
		assert.doesNotMatch(await readFile(join(web, file), "utf8"), HTML, file);
	}
});
