import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as lib from "@clusterio/lib";
import { lifecycle, loadDataFile, newBootId, newId, rateLimited, saveDataFile, upgrade } from "../../runtime.js";

type Line = { level: string; message: string; meta: Record<string, any> };

function fakeLogger(lines: Line[]): lib.Logger {
	const log = (level: string, message: string, meta: Record<string, any> = {}) => {
		lines.push({ level, message, meta });
	};
	const warn = (message: string, meta?: Record<string, any>) => log("warn", message, meta);
	return { log, warn } as unknown as lib.Logger;
}

test("lifecycle logs '<op> <phase>' with op, phase and the fields as metadata", () => {
	const lines: Line[] = [];
	lifecycle(fakeLogger(lines), "minimap.resync", "start", { trace: "ab.1" }, "verbose");
	lifecycle(fakeLogger(lines), "minimap.integration", "gridworld");
	assert.deepEqual(lines, [
		{
			level: "verbose", message: "minimap.resync start",
			meta: { trace: "ab.1", op: "minimap.resync", phase: "start" },
		},
		{
			level: "info", message: "minimap.integration gridworld",
			meta: { op: "minimap.integration", phase: "gridworld" },
		},
	]);
});

test("a repeated warning is logged once per key per window, carrying the count", () => {
	const lines: Line[] = [];
	let now = 0;
	const warn = rateLimited(fakeLogger(lines), 60_000, () => now);
	warn("k", "bad thing", { type: "x" });
	warn("k", "bad thing", { type: "x" });
	warn("k", "bad thing", { type: "x" });
	warn("other", "other thing");
	now = 60_000;
	warn("k", "bad thing", { type: "x" });
	assert.deepEqual(
		lines.map(l => [l.message, l.meta.count]),
		[["bad thing", 1], ["other thing", 1], ["bad thing", 3]],
	);
});

const toV2 = (data: { n: number }) => ({ count: data.n });

test("upgrade applies the migrations above the file's schema; a newer or foreign file throws, never resets", () => {
	assert.deepEqual(upgrade({ schema: 1, data: { n: 3 } }, [toV2]), { count: 3 });
	assert.deepEqual(upgrade({ schema: 2, data: { count: 3 } }, [toV2]), { count: 3 });
	assert.throws(() => upgrade({ schema: 3, data: {} }, [toV2]), /schema 3/);
	assert.throws(() => upgrade("junk", []), /schema/);
});

test("a missing data file loads as undefined; a saved one round-trips; a corrupt one throws", async () => {
	const dir = await mkdtemp(join(tmpdir(), "minimap-datafile-"));
	const file = join(dir, "s3.json");
	assert.equal(await loadDataFile(file, [toV2]), undefined);
	await saveDataFile(file, [toV2], { count: 5 });
	assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { schema: 2, data: { count: 5 } });
	assert.deepEqual(await loadDataFile(file, [toV2]), { count: 5 });
	await writeFile(file, "{\"schema\": 1, \"da");
	await assert.rejects(loadDataFile(file, []), SyntaxError);
});

test("a boot id is 8 hex digits; ids are <process boot id>.<seq>, counting up", () => {
	assert.match(newBootId(), /^[0-9a-f]{8}$/);
	assert.notEqual(newBootId(), newBootId());
	const [boot, seq] = newId().split(".");
	assert.match(boot, /^[0-9a-f]{8}$/);
	assert.equal(newId(), `${boot}.${Number(seq) + 1}`);
});
