// Where the viewer's files come from (spec §11.1): the controller's routes, or the S3 bucket the public page is
// served from. Gunzip is the browser's DecompressionStream (§5.3), which Node has too. DOM-free.
import type { MinimapLiveEvent } from "../../messages.js";
import type { Catalog } from "../../shared/keys.js";

/** A live update for one map surface: MinimapLiveEvent's fields (§9.2). */
export type Live = Omit<MinimapLiveEvent, "constructor">;

export interface Source {
	/** A key of §8.1's tree, gunzipped; undefined when it isn't there. */
	get(key: string): Promise<Uint8Array | undefined>;
	/** The open window of the area at `key` (§9.1, the controller only): records relative to t (B's ruling 9). */
	open?(key: string): Promise<{ t: number; bytes: Uint8Array } | undefined>;
	/** Live updates for one map surface until the returned function is called (plan ruling 2: the catalog too). */
	live(map: string, surface: string, catalog: Catalog, on: (u: Live) => void): () => void;
	/** The URL of an icon file the catalog names, `icons/<file>`: plain PNG or JSON, not gzip (ruling R2). */
	icon(key: string): string;
}

/** The DOM's BufferSource, which Node's types don't name. */
type Bytes = ArrayBufferView<ArrayBuffer> | ArrayBuffer;

/** A gzip or zlib ("deflate") stream's bytes. */
export async function inflate(body: ReadableStream<Bytes>, format: "gzip" | "deflate"): Promise<Uint8Array> {
	return new Uint8Array(await new Response(body.pipeThrough(new DecompressionStream(format))).arrayBuffer());
}

/** A live chunk's d (Lua's encode_string: zlib, then base64) as the chart's bytes; "" (deleted) as undefined. */
export async function chart(d: string): Promise<Uint8Array | undefined> {
	const bytes = Uint8Array.from(atob(d), c => c.charCodeAt(0));
	return d === "" ? undefined : inflate(new Blob([bytes]).stream(), "deflate");
}
