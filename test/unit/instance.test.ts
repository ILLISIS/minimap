import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as lib from "@clusterio/lib";
import type { InstancePluginContext } from "@clusterio/host";
import loadInstancePlugin, { BATCH_MS, tileOf } from "../../instance.js";
import type { MinimapDataEvent } from "../../messages.js";

type Line = { level: string; message: string; meta: Record<string, any> };
type Hook = (...args: any[]) => any;

const noGridworld = () => {
	throw new lib.InvalidField("No field named 'gridworld.tile'");
};

/** An instance with what the plugin touches: its IPC handler, sendTo, sendRcon, four hooks, config and status. */
function fakeContext(tile: () => unknown = noGridworld) {
	const lines: Line[] = [];
	const sent: MinimapDataEvent[] = [];
	const rcon: string[] = [];
	const hooks: Record<string, Hook> = {};
	let ipc: Hook | undefined;
	const hook = (name: string) => ({
		attach: (_owner: string, fn: Hook) => {
			hooks[name] = fn;
		},
	});
	const logger = {
		log: (level: string, message: string, meta: Record<string, any> = {}) => {
			lines.push({ level, message, meta });
		},
		warn: (message: string, meta: Record<string, any> = {}) => {
			lines.push({ level: "warn", message, meta });
		},
	};
	const instance = {
		status: "running",
		server: {
			handle: (channel: string, fn: Hook) => {
				assert.equal(channel, "minimap:out");
				ipc = fn;
			},
		},
		sendTo: (dst: string, event: MinimapDataEvent) => {
			assert.equal(dst, "controller");
			sent.push(event);
		},
		sendRcon: async (command: string, expectEmpty: boolean, plugin: string) => {
			assert.equal(expectEmpty, true);
			assert.equal(plugin, "minimap");
			rcon.push(command);
			return "";
		},
		config: {
			get: (name: string) => {
				assert.equal(name, "gridworld.tile");
				return tile();
			},
		},
		hooks: {
			start: hook("start"),
			exit: hook("exit"),
			instanceConfigFieldChanged: hook("field"),
			controllerConnectionEvent: hook("connection"),
		},
	};
	const context = { instance, logger, plugin: { name: "minimap" } } as unknown as InstancePluginContext;
	return { context, lines, sent, rcon, hooks, instance, ipc: (data: unknown) => ipc!(data) };
}

/** Run fn with setInterval and Date mocked, from time `now`. */
async function withTimers(fn: () => Promise<void>, now = 0) {
	mock.timers.enable({ apis: ["setInterval", "Date"], now });
	try {
		await fn();
	} finally {
		mock.timers.reset();
	}
}

test("§7.3: messages are stamped at arrival and leave as one MinimapDataEvent a second", () => withTimers(async () => {
	const f = fakeContext();
	await loadInstancePlugin(f.context);
	await f.ipc({ tick: 5, msgs: [
		{ type: "mm.chunk", s: "nauvis", f: "player", x: 0, y: 0, d: "eJzt" },
		{ type: "mm.adopt", j: "4242.1.2", trace: "ab.1" },
	] });
	mock.timers.tick(500);
	await f.ipc({ tick: 6, msgs: [{ type: "mm.tag", s: "nauvis", f: "player", n: 7 }] });
	assert.equal(f.sent.length, 0, "nothing before the second");
	mock.timers.tick(500);
	assert.equal(f.sent.length, 1);
	assert.deepEqual(f.sent[0].items, [
		{ type: "mm.chunk", s: "nauvis", f: "player", x: 0, y: 0, d: "eJzt", t: 1_000 },
		{ type: "mm.adopt", j: "4242.1.2", trace: "ab.1", t: 1_000 },
		{ type: "mm.tag", s: "nauvis", f: "player", n: 7, t: 1_500 },
	]);
	mock.timers.tick(BATCH_MS);
	assert.equal(f.sent.length, 1, "no event without items");
}, 1_000));

test("§7.3, §14: an invalid message is dropped with a rate-limited minimap.ipc invalid; the rest of its batch passes",
	() => withTimers(async () => {
		const f = fakeContext();
		await loadInstancePlugin(f.context);
		const bad = { type: "mm.chunk", s: "nauvis", f: "player", x: 0.5, y: 0, d: "SECRETBYTES" };
		const badTag = { type: "mm.tag", s: "nauvis", f: "player", n: "x", text: "SECRETTEXT" };
		await f.ipc({ tick: 1, msgs: [bad, { type: "mm.adopt", j: "a", trace: "b" }, bad, badTag] });
		await f.ipc("not a batch");
		mock.timers.tick(BATCH_MS);
		assert.deepEqual(f.sent[0].items.map(i => i.type), ["mm.adopt"]);
		const warns = f.lines.filter(l => l.message === "minimap.ipc invalid");
		assert.deepEqual(warns.map(l => [l.meta.type, l.meta.count]),
			[["mm.chunk", 1], ["mm.tag", 1], ["batch", 1]]);
		assert.ok(!/SECRET/.test(JSON.stringify(f.lines)), "no chart bytes or tag text in the logs");
		assert.ok(warns.every(l => l.level === "warn" && l.meta.op === "minimap.ipc" && l.meta.phase === "invalid"));
	}));

test("§14: a trace line is logged with Lua's fields, reserved keys stripped, never forwarded; text survives the " +
	"line (Review Focus 3)", () => withTimers(async () => {
	const f = fakeContext();
	await loadInstancePlugin(f.context);
	// one line as Lua prints it: table_to_json escapes " \ and control characters, and writes UTF-8 as it is
	const line = "{\"tick\":9,\"msgs\":[{\"type\":\"trace\",\"op\":\"minimap.journey\",\"phase\":\"adopted\"," +
		"\"level\":\"verbose\",\"trace\":\"ab.2\",\"journey\":\"j\",\"instance_id\":1,\"message\":\"spoof\"}," +
		"{\"type\":\"mm.tag\",\"s\":\"nauvis\",\"f\":\"player\",\"n\":7,\"x\":1,\"y\":2,\"icon\":\"\"," +
		"\"text\":\"a \\\"q\\\" \\\\ b\\nü ✓\"}]}";
	await f.ipc(JSON.parse(line));
	mock.timers.tick(BATCH_MS);
	assert.deepEqual(
		f.lines.filter(l => l.message === "minimap.journey adopted").map(l => [l.level, l.meta]),
		[["verbose", { trace: "ab.2", journey: "j", op: "minimap.journey", phase: "adopted" }]],
	);
	assert.deepEqual(f.sent[0].items.map(i => i.type), ["mm.tag"]);
	assert.equal((f.sent[0].items[0] as { text?: string }).text, "a \"q\" \\ b\nü ✓");
}));

test("§14: mm.resynced logs minimap.resync done with its counts, and is forwarded", () => withTimers(async () => {
	const f = fakeContext();
	await loadInstancePlugin(f.context);
	const counts = { chunks: 3, movers: 1, tags: 0, machines: 0, drops: 0 };
	await f.ipc({ tick: 2, msgs: [{ type: "mm.resynced", trace: "ab.3", counts }] });
	mock.timers.tick(BATCH_MS);
	const done = f.lines.filter(l => l.message === "minimap.resync done");
	assert.deepEqual(done.map(l => [l.level, l.meta.trace, l.meta.counts]), [["verbose", "ab.3", counts]]);
	assert.deepEqual(f.sent[0].items.map(i => i.type), ["mm.resynced"]);
}));

test("§7.2, M10: at start, config then resync in one /sc; no gridworld (No field named) or a null tile send {}",
	() => withTimers(async () => {
		for (const tile of [noGridworld, () => null]) {
			const f = fakeContext(tile);
			await loadInstancePlugin(f.context);
			await f.hooks.start();
			assert.equal(f.rcon.length, 1);
			assert.match(f.rcon[0], /^\/sc mm_rt\.config\("\{\}"\) mm_rt\.resync\("[0-9a-f]{8}\.\d+"\)$/);
		}
		const tile = { world: "w1", x: 1, y: -2, size: 512, surface: "a\"b\\c'd\ne", seed: 5, trace: "t" };
		const f = fakeContext(() => tile);
		await loadInstancePlugin(f.context);
		await f.hooks.start();
		const config = /^\/sc mm_rt\.config\("(.*)"\) mm_rt\.resync\("(.*)"\)$/.exec(f.rcon[0])!;
		assert.ok(!/(^|[^\\])(\\\\)*"/.test(config[1]), "no unescaped quote inside the literal");
		const unescaped = config[1].replace(/\\(.)/g, (_m, c) => (c === "n" ? "\n" : c));
		assert.deepEqual(JSON.parse(unescaped), { tile });
		const start = f.lines.filter(l => l.message === "minimap.resync start");
		assert.deepEqual(start.map(l => [l.level, l.meta.reason, l.meta.trace]), [["verbose", "start", config[2]]]);
	}));

test("§6.7, §7.2: a gridworld.tile change and a new controller session reconfigure a running instance; nothing else",
	() => withTimers(async () => {
		const f = fakeContext(() => null);
		await loadInstancePlugin(f.context);
		await f.hooks.field("factorio.settings", {}, {});
		await f.hooks.field("gridworld.tile", null, null);
		await f.hooks.connection("resume");
		await f.hooks.connection("drop");
		await f.hooks.connection("connect");
		assert.deepEqual(f.lines.filter(l => l.message === "minimap.resync start").map(l => l.meta.reason),
			["tile", "reconnect"]);
		f.instance.status = "stopping";
		await f.hooks.field("gridworld.tile", null, null);
		await f.hooks.connection("connect");
		assert.equal(f.rcon.length, 2, "not while the instance isn't running");
	}));

test("the instance's exit sends what waits", () => withTimers(async () => {
	const f = fakeContext();
	await loadInstancePlugin(f.context);
	await f.ipc({ tick: 1, msgs: [{ type: "mm.adopt", j: "a", trace: "b" }] });
	f.hooks.exit();
	assert.equal(f.sent.length, 1);
	mock.timers.tick(BATCH_MS * 3);
	assert.equal(f.sent.length, 1, "the timer is gone");
}));

test("tileOf: No field named and null read as no tile; any other error is thrown", () => {
	assert.equal(tileOf({ get: noGridworld }), undefined);
	assert.equal(tileOf({ get: () => null }), undefined);
	assert.deepEqual(tileOf({ get: () => ({ world: "w" }) }), { world: "w" });
	assert.throws(() => tileOf({
		get: () => {
			throw new Error("boom");
		},
	}), /boom/);
});
