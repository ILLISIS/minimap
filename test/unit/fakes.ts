// Helpers for the minimap's unit tests. Not a test file: the runner only picks up *.test.js.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as lib from "@clusterio/lib";

export type Line = { level: string; message: string; meta: Record<string, any> };

/** A logger that keeps its lines: lifecycle() calls log(), rateLimited() warn(). */
export function fakeLogger(lines: Line[] = []): lib.Logger {
	const log = (level: string, message: string, meta: Record<string, any> = {}) => {
		lines.push({ level, message, meta });
	};
	return {
		log,
		warn: (message: string, meta?: Record<string, any>) => log("warn", message, meta),
		error: (message: string, meta?: Record<string, any>) => log("error", message, meta),
	} as unknown as lib.Logger;
}

export const tempDir = (prefix: string) => mkdtemp(join(tmpdir(), `mm-${prefix}-`));
