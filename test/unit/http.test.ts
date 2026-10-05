import { test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { authorize } from "../../http.js";
import { MinimapLiveEvent } from "../../messages.js";
import { Store } from "../../store/index.js";
import { fakeLogger, tempDir } from "./fakes.js";

const secret = Buffer.from("minimap test secret");
type User = { tokenValidAfter: number; checkPermission(permission: string): void };
const viewer: User = { tokenValidAfter: 100, checkPermission: () => undefined };
const stranger: User = {
	tokenValidAfter: 100,
	checkPermission: () => {
		throw new Error("Permission denied");
	},
};
const known: Record<string, User> = { viewer, stranger };
const users = { getByName: (n: string): User | undefined => known[n.toLowerCase()] };
function token(user: string, iat: number, aud = "user", key: Buffer | string = secret): string {
	return jwt.sign({ aud, user, iat }, key);
}
const auth = (headers: Record<string, string>) => authorize(n => headers[n], secret, users);

test("auth (§9.1, K14): 401 without a token, or a bad, stale, foreign or host one; 403 without minimap.view", () => {
	assert.equal(auth({}), 401);
	assert.equal(auth({ "x-access-token": "junk" }), 401);
	assert.equal(auth({ "x-access-token": token("viewer", 99) }), 401, "issued before the user's tokenValidAfter");
	assert.equal(auth({ "x-access-token": token("ghost", 200) }), 401, "no such user");
	assert.equal(auth({ "x-access-token": token("viewer", 200, "host") }), 401, "a host token");
	assert.equal(auth({ "x-access-token": token("viewer", 200, "user", "another secret") }), 401);
	assert.equal(auth({ "x-access-token": token("stranger", 200) }), 403);
	assert.equal(auth({ "x-access-token": token("viewer", 200) }), 200);
	assert.equal(auth({ authorization: `Bearer ${token("viewer", 200)}` }), 200, "Authorization: Bearer");
});

test("MinimapLiveEvent asks minimap.view of a subscriber (§9.2; v1's asked nothing)", () => {
	assert.equal(MinimapLiveEvent.permission, "minimap.view");
});

test("a subscriber's replay: the owned live movers of its <map>|<surface>, split at the first |", async () => {
	const instances = [{ id: 3, name: "solo", tile: null }];
	const cluster = {
		instance: (id: number) => instances.find(i => i.id === id),
		instances: () => instances,
		edges: async () => new Map(),
		assets: () => undefined,
	};
	const store = new Store(await tempDir("http"), cluster, fakeLogger(), () => 300, () => 42);
	await store.ingest(3, [{
		type: "mm.move", s: "a|b", t: 1,
		m: [{ j: "3.1.1", k: "v", f: "player", name: "car", x: 1, y: 2, vx: 0, vy: 0 }],
	}]);
	const replay = store.subscribed("i-3|a|b");
	assert.deepEqual(
		[replay.t, replay.map, replay.surface, replay.movers?.map(m => m[0])], [42, "i-3", "a|b", ["3.1.1"]],
	);
	assert.deepEqual(store.subscribed("i-3|nauvis").movers, []);
	assert.deepEqual(store.subscribed("junk").movers, [], "a filter without | names nothing");
});
