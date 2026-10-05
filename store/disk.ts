import { readdir, readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import * as lib from "@clusterio/lib";

/** Bytes written under <database>/minimap/, gzipped (spec §14). */
export const bytesWritten = new lib.Counter(
	"clusterio_minimap_written_bytes_total",
	"Minimap bytes written to the store on disk, gzipped",
);

/** The key tree on disk (§8.1): every file gzip, written atomically (§8.10). */
export class Disk {
	constructor(readonly root: string) {}

	path(key: string): string {
		return join(this.root, ...key.split("/"));
	}

	/** Gzip and write the file; returns its size. */
	async put(key: string, data: Uint8Array | string): Promise<number> {
		const gz = gzipSync(data);
		await lib.safeOutputFile(this.path(key), gz);
		bytesWritten.inc(gz.length);
		return gz.length;
	}

	/** The file's gzip bytes, or undefined when there is none. */
	async get(key: string): Promise<Buffer | undefined> {
		try {
			return await readFile(this.path(key));
		} catch (err: any) {
			if (err.code === "ENOENT") {
				return undefined;
			}
			throw err;
		}
	}

	async json<T>(key: string): Promise<T | undefined> {
		const gz = await this.get(key);
		return gz === undefined ? undefined : JSON.parse(gunzipSync(gz).toString()) as T;
	}

	/** Every key on disk, sorted: the .gz files, less safeOutputFile's leftover temporaries. */
	async keys(): Promise<string[]> {
		let files: string[];
		try {
			files = await readdir(this.root, { recursive: true });
		} catch (err: any) {
			if (err.code === "ENOENT") {
				return [];
			}
			throw err;
		}
		return files
			.map(f => f.split(sep).join("/"))
			.filter(k => k.endsWith(".gz") && !k.endsWith(".tmp.gz"))
			.sort();
	}
}
