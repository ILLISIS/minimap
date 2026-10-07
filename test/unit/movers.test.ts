import { test } from "node:test";
import assert from "node:assert/strict";
import type { MoverGone, MoverSample } from "../../contracts.js";
import { dayKey, keyframeKey, moveKey, type DayIndex } from "../../shared/keys.js";
import { Disk } from "../../store/disk.js";
import { gather } from "../../store/index.js";
import { Movers, ownerDrops } from "../../store/movers.js";
import { tempDir } from "./fakes.js";

const D = Date.UTC(2026, 9, 5);
const DAY = 86_400_000;
const train = (j: string, x: number, more: Partial<MoverSample> = {}): MoverSample => ({
	j, k: "t", f: "player", name: "locomotive", x, y: 0, vx: 1, vy: 0, n: 2, ...more,
});
const player = (name: string, x: number): MoverSample => ({
	j: `p:${name}`, k: "p", f: "player", name, x, y: 0, vx: 0, vy: 0,
});
const gone = (j: string): MoverGone => ({ j, gone: true });
const failed = (key: string, err: Error) => {
	throw new Error(`${key}: ${err.message}`);
};

async function setup(root?: string) {
	const disk = new Disk(root ?? await tempDir("movers"));
	return { disk, movers: new Movers(disk) };
}

test("K28: the first sampler owns, others are dropped, mm.adopt moves it, the owner's gone frees it", async () => {
	const { movers } = await setup();
	const { out, updates } = gather();
	const drops = ownerDrops.get();
	movers.move(1, "i-1", "nauvis", D + 1000, [train("1.5.9", 10)], out);
	movers.move(2, "i-2", "nauvis", D + 1100, [train("1.5.9", 20), gone("1.5.9")], out);
	assert.equal(ownerDrops.get() - drops, 2, "instance 2's sample and gone");
	assert.deepEqual(movers.live("i-1", "nauvis").map(m => m[5]), [10]);
	assert.equal(movers.live("i-2", "nauvis").length, 0);
	assert.equal(movers.adopt(2, "1.5.9"), 1, "adopt returns the owner before");
	movers.move(1, "i-1", "nauvis", D + 1200, [train("1.5.9", 11), gone("1.5.9")], out);
	assert.equal(ownerDrops.get() - drops, 4, "after mm.adopt: the source's braking sample and its gone at commit");
	assert.deepEqual(movers.live("i-1", "nauvis").map(m => m[5]), [10], "the source never moved or hid it");
	movers.move(2, "i-2", "nauvis", D + 1300, [train("1.5.9", 30)], out);
	assert.equal(movers.live("i-1", "nauvis").length, 0, "the destination's first sample ends it on the source's map");
	assert.deepEqual(movers.live("i-2", "nauvis").map(m => m[5]), [30]);
	assert.deepEqual(updates.get("i-1|nauvis")?.gone, ["1.5.9"]);
	movers.move(2, "i-2", "nauvis", D + 1400, [gone("1.5.9")], out);
	assert.equal(movers.owner.has("1.5.9"), false, "its owner's gone clears the owner");
	movers.move(1, "i-1", "nauvis", D + 1500, [train("1.5.9", 12)], out);
	assert.equal(movers.owner.get("1.5.9"), 1, "and the next sampler owns it");
});

test("a resync closes only what the instance owns and didn't re-send since its mm.surfaces (K28)", async () => {
	const { movers } = await setup();
	const { out } = gather();
	movers.move(1, "i-1", "nauvis", D, [train("a", 1), train("b", 2)], out);
	movers.move(2, "i-2", "nauvis", D, [train("c", 3)], out);
	movers.resynced(1, D + 1, out);
	assert.equal(movers.live("i-1", "nauvis").length, 2, "no mm.surfaces before it: nothing closes (plan ruling 6)");
	movers.begin(1);
	movers.move(1, "i-1", "nauvis", D + 2, [train("a", 1)], out);
	movers.resynced(1, D + 3, out);
	assert.deepEqual(movers.live("i-1", "nauvis").map(m => m[0]), ["a"]);
	assert.deepEqual(movers.live("i-2", "nauvis").map(m => m[0]), ["c"], "another instance's movers stay");
	assert.equal(movers.owner.has("b"), false);
});

test("a stopped instance's players are gone; its trains stay parked (§7.3)", async () => {
	const { movers } = await setup();
	const { out, updates } = gather();
	movers.move(1, "i-1", "nauvis", D, [player("alice", 1), train("1.1.1", 2)], out);
	movers.stopped(1, D + 5, out);
	assert.deepEqual(movers.live("i-1", "nauvis").map(m => m[0]), ["1.1.1"]);
	assert.deepEqual(updates.get("i-1|nauvis")?.gone, ["p:alice"]);
});

test("a mover that changes surface ends on the old one, with a gone row there (Review Focus 5)", async () => {
	const { disk, movers } = await setup();
	const { out, updates } = gather();
	movers.move(1, "i-1", "nauvis", D + 1000, [player("alice", 5)], out);
	movers.move(1, "i-1", "platform-1", D + 2000, [player("alice", 0)], out);
	assert.equal(movers.live("i-1", "nauvis").length, 0);
	assert.equal(movers.live("i-1", "platform-1").length, 1);
	assert.deepEqual(updates.get("i-1|nauvis")?.gone, ["p:alice"]);
	await movers.close(D + 60_000, false, failed);
	const win = (await disk.json<{ s: number[][] }>(moveKey("i-1", "nauvis", D + 1000)))!;
	assert.deepEqual(win.s, [[0, 0, 5, 0, 0, 0], [0, 1000]], "a sample, then [mover, dt] alone: gone");
});

test("a window file is named by its earliest sample; x, y to 0.1, velocity to 0.01, n for trains (§8.7)", async () => {
	const { disk, movers } = await setup();
	const { out } = gather();
	movers.move(2, "gw-w1", "nauvis", D + 2000, [train("2.1.1", 1.26, { vx: 0.126, vy: -2.004 })], out);
	movers.move(1, "gw-w1", "nauvis", D + 1500, [player("bob", -3.04)], out);
	const { files, samples } = await movers.close(D + 60_000, false, failed);
	assert.deepEqual(files, [moveKey("gw-w1", "nauvis", D + 1500)], "another tile's batch, stamped earlier, names it");
	assert.equal(samples, 2);
	assert.deepEqual(await disk.json(files[0]), {
		t: D + 1500,
		movers: [["2.1.1", "t", "player", "locomotive", 2, "", ""], ["p:bob", "p", "player", "bob"]],
		s: [[0, 500, 1.3, 0, 0.13, -2, 0], [1, 0, -3, 0, 0, 0]],
	});
});

test("a keyframe holds every owned mover's last sample, parked ones included, and joins the day index", async () => {
	const { disk, movers } = await setup();
	const { out } = gather();
	movers.move(1, "i-1", "nauvis", D + 1000, [train("1.1.1", 4, { vx: 0 })], out);
	await movers.close(D + 60_000, true, failed);
	assert.deepEqual(await disk.json(keyframeKey("i-1", "nauvis", D + 60_000)), {
		t: D + 60_000, movers: [["1.1.1", "t", "player", "locomotive", 2, 4, 0, 0, 0, D + 1000, "", "", 0]],
	});
	const { files } = await movers.close(D + 120_000, true, failed);
	assert.deepEqual(files, [keyframeKey("i-1", "nauvis", D + 120_000)], "a parked train is in every keyframe");
	const day = (await disk.json<DayIndex>(dayKey("i-1", "nauvis", "2026-10-05")))!;
	assert.deepEqual(day, { windows: [[D + 1000, D + 1000]], keys: [D + 60_000, D + 120_000] });
});

test("a restart within a window writes a new name and extends the day index (K35, Review Focus 3)", async () => {
	const first = await setup();
	const { out } = gather();
	first.movers.move(1, "i-1", "nauvis", D + 1000, [train("1.1.1", 1)], out);
	await first.movers.close(D + 60_000, false, failed);
	first.movers.move(1, "i-1", "nauvis", D + 61_000, [train("1.1.1", 2)], out); // lost: the controller dies
	const second = await setup(first.disk.root);
	second.movers.move(1, "i-1", "nauvis", D + 62_000, [train("1.1.1", 3)], out);
	const { files } = await second.movers.close(D + 120_000, false, failed);
	assert.deepEqual(files, [moveKey("i-1", "nauvis", D + 62_000)]);
	const day = (await first.disk.json<DayIndex>(dayKey("i-1", "nauvis", "2026-10-05")))!;
	assert.deepEqual(day.windows, [[D + 1000, D + 1000], [D + 62_000, D + 62_000]]);
});

test("a day index is final at the first close after midnight; a late sample lands in the new day (§8.7)", async () => {
	const { movers } = await setup();
	const { out } = gather();
	movers.move(1, "i-1", "nauvis", D + DAY - 120_000, [train("1.1.1", 1)], out);
	const before = await movers.close(D + DAY - 60_000, false, failed);
	assert.deepEqual(before.days, [dayKey("i-1", "nauvis", "2026-10-05")]);
	const midnight = await movers.close(D + DAY + 240_000, false, failed);
	assert.deepEqual(midnight.days, [dayKey("i-1", "nauvis", "2026-10-05")], "written once more: final");
	movers.move(1, "i-1", "nauvis", D + DAY - 1000, [train("1.1.1", 2)], out); // stamped 23:59:59, arriving late
	const next = await movers.close(D + DAY + 540_000, false, failed);
	assert.deepEqual(next.files, [moveKey("i-1", "nauvis", D + DAY + 240_001)], "filed after the midnight close");
	assert.deepEqual(next.days, [dayKey("i-1", "nauvis", "2026-10-06")]);
});

test("liveChanged gives each changed map surface once, with every owned live mover (§10.6)", async () => {
	const { movers } = await setup();
	const { out } = gather();
	movers.move(1, "i-1", "nauvis", D, [train("a", 1), train("b", 2)], out);
	assert.deepEqual(
		movers.liveChanged(D + 5).map(x => [x.map, x.surface, x.t, x.movers.map(m => m[0])]),
		[["i-1", "nauvis", D + 5, ["a", "b"]]],
	);
	assert.deepEqual(movers.liveChanged(D + 10), []);
	movers.move(1, "i-1", "nauvis", D + 11, [gone("a"), gone("b")], out);
	assert.deepEqual(movers.liveChanged(D + 15).map(x => x.movers), [[]], "the last one gone: an empty live file");
});

test("at start, a map surface with a day index is changed: its first live file goes out empty (plan ruling 25)",
	async () => {
		const { movers } = await setup();
		movers.load(["i-1/Bob~27s~20base/m/2026-10-05.json.gz", "i-1/nauvis/player/0/0_0/index.json.gz"]);
		assert.deepEqual(movers.liveChanged(D), [{ map: "i-1", surface: "Bob's base", t: D, movers: [] }]);
		assert.deepEqual(movers.liveChanged(D + 1), []);
	});

test("§22.2: a train's kinds and colour ride on its live tuple and its window row; a sample without them keeps them",
	async () => {
		const { disk, movers } = await setup();
		const { out } = gather();
		movers.move(1, "i-1", "nauvis", D + 1000, [train("1.1.1", 1, { o: "LCC", c: "eb1200" })], out);
		movers.move(1, "i-1", "nauvis", D + 2000, [train("1.1.1", 2)], out);
		assert.deepEqual(movers.live("i-1", "nauvis").map(m => m.slice(10)), [["LCC", "eb1200", 0]]);
		const { files } = await movers.close(D + 60_000, false, failed);
		const w = await disk.json<{ movers: unknown[][] }>(files[0]);
		assert.deepEqual(w?.movers, [["1.1.1", "t", "player", "locomotive", 2, "LCC", "eb1200"]]);
	});

test("the live file carries every sample of the last 16 s and each mover's last; a gone mover's none (§22.2, ruling " +
	"P2)", async () => {
	const { movers } = await setup();
	const { out } = gather();
	movers.move(1, "i-1", "nauvis", D, [train("a", 1)], out);
	movers.move(1, "i-1", "nauvis", D + 1000, [train("a", 2), player("bob", 5)], out);
	movers.move(1, "i-1", "nauvis", D + 20_000, [train("a", 3)], out);
	const [first] = movers.liveChanged(D + 20_000);
	assert.deepEqual(first.movers.map(m => [m[0], m[5]]), [["a", 3], ["p:bob", 5]], "a's older samples are past 16 s");
	movers.move(1, "i-1", "nauvis", D + 21_000, [train("a", 4), player("bob", 6)], out);
	movers.move(1, "i-1", "nauvis", D + 22_000, [gone("p:bob")], out);
	const [next] = movers.liveChanged(D + 22_000);
	assert.deepEqual(next.movers.map(m => [m[0], m[5]]), [["a", 3], ["a", 4]], "both of a's, in order; bob is gone");
});

test("the trail is trimmed as samples come, not only when the live file is built (S3 off)", async () => {
	const { movers } = await setup();
	const { out } = gather();
	for (let i = 0; i < 100; i++) {
		movers.move(1, "i-1", "nauvis", D + i * 1000, [train("a", i)], out);
	}
	const trail = [...movers["surfs"].values()][0].trail;
	assert.equal(trail.length, 17, "the samples of the last 16 s, 99 s down to 83 s");
});

test("§22.2: a train's heading rides on its live tuple and its window row, kept by a sample without it", async () => {
	const { disk, movers } = await setup();
	const { out } = gather();
	movers.move(1, "i-1", "nauvis", D + 1000, [train("1.1.1", 1, { h: 0.75 }), player("bob", 3)], out);
	movers.move(1, "i-1", "nauvis", D + 2000, [train("1.1.1", 2)], out);
	assert.deepEqual(movers.live("i-1", "nauvis").map(m => m[12]), [0.75, 0]);
	const { files } = await movers.close(D + 60_000, false, failed);
	const w = await disk.json<{ s: number[][] }>(files[0]);
	assert.deepEqual(w?.s, [[0, 0, 1, 0, 1, 0, 0.75], [1, 0, 3, 0, 0, 0], [0, 1000, 2, 0, 1, 0, 0.75]]);
});
