import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { plugin } from "../../index.js";
import { MinimapDataEvent, MinimapLiveEvent } from "../../messages.js";

// Compiled to dist/node/test/unit/; the plugin root is four levels up.
const pluginRoot = join(import.meta.dirname, "..", "..", "..", "..");
const readJson = async (file: string) => JSON.parse(await readFile(join(pluginRoot, file), "utf8"));

test("the declaration names the plugin, and its compiled entrypoints exist and export a default function", async () => {
	assert.equal(plugin.name, "minimap");
	assert.deepEqual(plugin.features, ["SavePatching", "ScriptCommands"]);
	for (const entry of [plugin.controllerEntrypoint, plugin.instanceEntrypoint]) {
		assert.ok(entry, "entrypoint declared");
		await access(join(pluginRoot, entry));
		const loaded = await import(pathToFileURL(join(pluginRoot, entry)).href);
		assert.equal(typeof loaded.default, "function", entry);
	}
});

test("module.json carries the name and version the save patcher validates", async () => {
	const moduleJson = await readJson(join("module", "module.json"));
	const pkg = await readJson("package.json");
	assert.equal(moduleJson.name, plugin.name);
	assert.equal(moduleJson.version, pkg.version);
});

test("M10: package.json and module.json depend on Clusterio only, never on UE or GW", async () => {
	const moduleJson = await readJson(join("module", "module.json"));
	assert.deepEqual(Object.keys(moduleJson.dependencies), ["clusterio"]);
	const pkg = await readJson("package.json");
	for (const deps of [pkg.dependencies, pkg.peerDependencies, pkg.devDependencies]) {
		const names = Object.keys(deps ?? {});
		assert.ok(!names.includes("universal_edges") && !names.includes("gridworld"), names.join(", "));
	}
});

test("§10.1: W defaults to 300 s and refuses less than 60 (K27); S3 is unset and off; the keys are credentials", () => {
	const fields = plugin.controllerConfigFields!;
	const window = fields["minimap.window_seconds"];
	assert.equal(window.initialValue, 300);
	assert.throws(() => window.validator!(59, undefined as any), /at least 60/);
	window.validator!(60, undefined as any);
	for (const name of ["s3_endpoint", "s3_bucket", "s3_access_key_id", "s3_secret_access_key"]) {
		assert.equal(fields[`minimap.${name}`].optional, true, name);
		assert.equal(fields[`minimap.${name}`].initialValue, undefined, name);
	}
	assert.deepEqual(fields["minimap.s3_access_key_id"].credential, ["controller"]);
	assert.deepEqual(fields["minimap.s3_secret_access_key"].credential, ["controller"]);
	assert.equal(fields["minimap.s3_region"].initialValue, "auto");
});

test("§9.2–9.3: minimap.view is granted by default and guards the live event; the messages and /minimap", () => {
	assert.deepEqual(plugin.permissions?.map(p => [p.name, p.grantByDefault]), [["minimap.view", true]]);
	assert.equal(MinimapLiveEvent.permission, "minimap.view");
	assert.equal(MinimapLiveEvent.dst, "control");
	assert.equal(MinimapDataEvent.src, "instance");
	assert.equal(MinimapDataEvent.dst, "controller");
	assert.deepEqual(plugin.messages, [MinimapDataEvent, MinimapLiveEvent]);
	assert.deepEqual(plugin.routes, ["/minimap"]);
});
