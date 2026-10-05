import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import * as lib from "@clusterio/lib";

/**
 * The icon files in `dir`. The names come from a mod pack's export manifest, which anyone who may update a mod pack
 * can set, so only each name's last segment counts: a "../config-controller.json" never leaves `dir`.
 */
export const iconPaths = (dir: string, names: string[]) => names.map(n => resolve(dir, basename(n)));

/**
 * The public page's files (spec §10.8), written into the store's folder for the file lane to PUT like any key:
 * the viewer bundle as viewer-<sha8>.js, each icon file as icons/<its name> (the catalog names them so, Plan B's
 * controller ruling R2), and index.html with the viewer's name in place of __VIEWER_JS__ (Plan D's Task 4). Returns
 * the keys in upload order: the viewer and the icons before the page that loads them.
 */
export async function pageFiles(root: string, viewer: string, html: string, icons: string[]): Promise<string[]> {
	const js = await readFile(viewer);
	const name = `viewer-${createHash("sha256").update(js).digest("hex").slice(0, 8)}.js`;
	const files: [string, Buffer | string][] = [[name, js]];
	for (const icon of icons) {
		// An unreadable name (not in static/, or "." and the like) is no icon: the viewer draws text (§11.7).
		if ((await stat(icon).catch(() => undefined))?.isFile()) {
			files.push([`icons/${basename(icon)}`, await readFile(icon)]);
		}
	}
	files.push(["index.html", (await readFile(html, "utf8")).replaceAll("__VIEWER_JS__", name)]);
	for (const [key, data] of files) {
		await lib.safeOutputFile(join(root, ...key.split("/")), data);
	}
	return files.map(([key]) => key);
}
