import * as lib from "@clusterio/lib";
import type { InstancePluginContext } from "@clusterio/host";
import { LuaMsg, type Stamped, type TraceMsg } from "./contracts.js";
import { MinimapDataEvent } from "./messages.js";
import { lifecycle, newId, rateLimited } from "./runtime.js";

/** §7.3: Lua's messages go to the controller once a second. */
export const BATCH_MS = 1000;

/**
 * gridworld.tile (§7.3, M10), or undefined. Without GW the field doesn't exist, and Clusterio's config throws
 * "No field named …" (clusterio/packages/lib/src/config/classes.ts:628-631); an instance that isn't a tile holds null.
 */
export function tileOf(config: { get(name: string): unknown }): unknown {
	try {
		return config.get("gridworld.tile") ?? undefined;
	} catch (err) {
		if (err instanceof lib.InvalidField) {
			return undefined;
		}
		throw err;
	}
}

/**
 * The minimap's instance plugin (spec §7.2–7.3): it stamps Lua's messages with wall-clock time (K8), forwards them once
 * a second, logs Lua's trace lines, and sends the config and a resync over RCON at start, on a gridworld.tile change
 * and on a new controller session.
 */
export default async function loadInstancePlugin(context: InstancePluginContext) {
	const { instance, logger, plugin } = context;
	const warn = rateLimited(logger);
	const valid = lib.compile<LuaMsg>(LuaMsg as any);
	let items: Stamped[] = [];

	/**
	 * A trace line from Lua (§14), logged as UE's bridge logs them (universal_edges/runtime/bridge.ts:60-72): reserved
	 * keys, and the fields the cluster logger stamps from real context, never come from the payload.
	 */
	function log(msg: TraceMsg) {
		const { type, op, phase, level, message, timestamp, instance_id, instance_name, ...fields } =
			msg as TraceMsg & Record<string, unknown>;
		lifecycle(logger, op, phase, fields, level ?? "info");
	}

	/** One line on minimap:out: each message checked, trace lines logged, the rest stamped with this arrival's time. */
	function receive(data: unknown) {
		const msgs = (data as { msgs?: unknown } | null)?.msgs;
		if (!Array.isArray(msgs)) {
			warn("batch", "minimap.ipc invalid", { op: "minimap.ipc", phase: "invalid", type: "batch", errors: [] });
			return;
		}
		const t = Date.now();
		for (const msg of msgs) {
			if (!valid(msg)) {
				const type = String((msg as { type?: unknown } | null)?.type);
				const fields = { op: "minimap.ipc", phase: "invalid", type, errors: valid.errors };
				warn(`invalid:${type}`, "minimap.ipc invalid", fields);
				continue;
			}
			if (msg.type === "trace") {
				log(msg);
				continue;
			}
			if (msg.type === "mm.resynced") {
				lifecycle(logger, "minimap.resync", "done", { trace: msg.trace, counts: msg.counts }, "verbose");
			}
			items.push({ ...msg, t });
		}
	}

	function flush() {
		if (items.length > 0) {
			instance.sendTo("controller", new MinimapDataEvent(items));
			items = [];
		}
	}

	// ponytail: no chain. Clusterio parses a ?j line and emits it with no await in between
	// (clusterio/packages/host/src/server.ts:742-787), and receive awaits nothing, so lines are handled in arrival
	// order (spec §5.4, REV M-1).
	instance.server.handle("minimap:out", async (data: unknown) => receive(data));
	const timer = setInterval(flush, BATCH_MS);
	instance.hooks.exit.attach(plugin.name, () => {
		clearInterval(timer);
		flush();
	});

	/**
	 * §7.2: the config, then a resync, in one /sc so they arrive in order. Lua checks every field; a refusal comes
	 * back as RCON output, which sendRcon(…, true) throws and the hook logs.
	 */
	async function configure(reason: string) {
		const trace = newId();
		const tile = tileOf(instance.config as unknown as { get(name: string): unknown });
		lifecycle(logger, "minimap.resync", "start", { trace, reason }, "verbose");
		const config = lib.escapeString(JSON.stringify(tile === undefined ? {} : { tile }));
		await instance.sendRcon(`/sc mm_rt.config("${config}") mm_rt.resync("${trace}")`, true, plugin.name);
	}

	instance.hooks.start.attach(plugin.name, () => configure("start"));
	instance.hooks.instanceConfigFieldChanged.attach(plugin.name, async (field: string) => {
		if (field === "gridworld.tile" && instance.status === "running") {
			await configure("tile");
		}
	});
	// §6.7: a new session means the controller restarted and lost what it hadn't written; a resumed session lost
	// nothing (Clusterio keeps unacknowledged messages, DP :211), so only "connect" resyncs (plan ruling 13).
	instance.hooks.controllerConnectionEvent.attach(plugin.name, async (event: string) => {
		if (event === "connect" && instance.status === "running") {
			await configure("reconnect");
		}
	});
}
