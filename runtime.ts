import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as lib from "@clusterio/lib";

// The small copies from UE's runtime (spec §5.4, K26). ponytail: copied, not imported: the minimap depends only on
// Clusterio (M10), and a shared runtime package would edit UE and GW on main. The copies can drift (§19 item 7).

/** Log one lifecycle phase (universal_edges/runtime/log.ts:4-12): "<op> <phase>", with op and phase as metadata. */
export function lifecycle(
	logger: lib.Logger,
	op: string,
	phase: string,
	fields: Record<string, unknown> = {},
	level: "info" | "verbose" | "warn" | "error" = "info",
): void {
	logger.log(level, `${op} ${phase}`, { ...fields, op, phase });
}

/**
 * A warner for repeated warnings (universal_edges/runtime/log.ts:14-35). Each key reaches the log at most once per
 * window (60 s), and each line carries `count`: the occurrences since the key's previous line, this one included.
 */
export function rateLimited(logger: lib.Logger, windowMs = 60_000, now: () => number = Date.now) {
	const last = new Map<string, { at: number; count: number }>();
	return (key: string, message: string, fields: Record<string, unknown> = {}): void => {
		const at = now();
		const entry = last.get(key);
		if (entry && at - entry.at < windowMs) {
			entry.count += 1;
			return;
		}
		logger.warn(message, { ...fields, count: (entry?.count ?? 0) + 1 });
		// ponytail: an unbounded set of keys never expires; a global clear at 1000 is enough for a fixed set of
		// warning names. Switch to per-key TTL eviction if hostile input can mint new keys.
		if (last.size >= 1000) {
			last.clear();
		}
		last.set(key, { at, count: 0 });
	};
}

/** Upgrades a data file's `data` by one schema: migrations[n - 1] takes schema n to n + 1. */
export type Migration = (data: any) => any;

/**
 * The data of a stored `{ schema, data }`, brought to the latest schema (migrations.length + 1)
 * (universal_edges/runtime/datafile.ts:11-28). It never wipes: an unknown schema, or a value that isn't a data file,
 * throws.
 */
export function upgrade(file: unknown, migrations: Migration[]): unknown {
	const latest = migrations.length + 1;
	const stored = typeof file === "object" && file !== null ? file : {};
	const { schema, data } = stored as { schema?: unknown; data?: unknown };
	if (typeof schema !== "number" || !Number.isInteger(schema) || schema < 1 || schema > latest) {
		throw new Error(`data file schema ${String(schema)} is not one this code can read (1 to ${latest})`);
	}
	let result = data;
	for (let from = schema; from < latest; from++) {
		result = migrations[from - 1](result);
	}
	return result;
}

/** Load a file written by saveDataFile; undefined when it doesn't exist yet. */
export async function loadDataFile(file: string, migrations: Migration[]): Promise<unknown> {
	let text: string;
	try {
		text = await fs.readFile(file, "utf8");
	} catch (err: any) {
		if (err.code === "ENOENT") {
			return undefined;
		}
		throw err;
	}
	return upgrade(JSON.parse(text), migrations);
}

/** Write `{ schema: latest, data }` atomically (universal_edges/runtime/datafile.ts:40-42). */
export async function saveDataFile(file: string, migrations: Migration[], data: unknown): Promise<void> {
	await lib.safeOutputFile(file, JSON.stringify({ schema: migrations.length + 1, data }, null, "\t"));
}

/** A random 8-hex-digit boot id, new at every process start (universal_edges/runtime/ids.ts:3-6). */
export function newBootId(): string {
	return randomBytes(4).toString("hex");
}

const processBootId = newBootId();
let seq = 0;

/** `<bootId>.<seq>` for this process (universal_edges/runtime/ids.ts:8-15): unique across restarts. */
export function newId(): string {
	seq += 1;
	return `${processBootId}.${seq}`;
}
