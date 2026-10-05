import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import jwt from "jsonwebtoken";
import type { ControllerPluginContext } from "@clusterio/controller";
import { cacheControl, validKey } from "./shared/keys.js";
import type { Store } from "./store/index.js";

type Controller = ControllerPluginContext["controller"];
/** The user lookup core's check uses (clusterio/packages/controller/src/routes.ts:221-233). */
type Users = {
	getByName(name: string): { tokenValidAfter: number; checkPermission(permission: string): void } | undefined;
};

/**
 * Core's user token check (routes.ts:175-185, 214-241), then minimap.view (§9.1, K14): plugins get no auth of their
 * own. Returns the status to answer, 200 when allowed.
 */
export function authorize(header: (name: string) => string | undefined, secret: Buffer, users: Users): 200 | 401 | 403 {
	let token = header("x-access-token");
	const authorization = header("authorization");
	if (!token && authorization && /^Bearer /i.test(authorization)) {
		token = authorization.slice("Bearer ".length).trim();
	}
	const user = token ? verify(token, secret, users) : undefined;
	if (!user) {
		return 401;
	}
	try {
		user.checkPermission("minimap.view");
	} catch {
		return 403;
	}
	return 200;
}

/** The token's user, as core's validateUserToken finds it: audience "user", and issued after tokenValidAfter. */
function verify(token: string, secret: Buffer, users: Users) {
	try {
		const payload = jwt.verify(token, secret, { audience: "user" });
		if (typeof payload === "string") {
			return undefined;
		}
		const user = users.getByName(payload.user);
		return user && payload.iat && payload.iat >= user.tokenValidAfter ? user : undefined;
	} catch {
		return undefined;
	}
}

/** §9.1's routes (K14, K25): a file of the key tree, and an area's open window, both behind authorize(). */
export function addRoutes(controller: Controller, store: Store): void {
	const allowed = (get: (name: string) => string | undefined) => authorize(
		get, controller.authSecret, controller.users,
	);
	controller.app.get("/api/minimap/data/*key", async (req, res) => {
		const status = allowed(header => req.get(header));
		const key = req.params.key.join("/");
		// Only the key tree's files, all .gz: not Plan C's s3.json beside them.
		if (status !== 200 || !validKey(key) || !key.endsWith(".gz")) {
			res.sendStatus(status === 200 ? 400 : status);
			return;
		}
		let body: Buffer;
		try {
			body = await readFile(store.path(key));
		} catch {
			res.sendStatus(404);
			return;
		}
		const asOf = Date.now() - (controller.config.get("minimap.window_seconds") * 1000); // plan ruling 27
		res.set("Cache-Control", `private, ${cacheControl(key, asOf)}`).type("application/gzip").send(body);
	});
	controller.app.get("/api/minimap/open/*key", (req, res) => {
		const status = allowed(header => req.get(header));
		const key = req.params.key.join("/");
		if (status !== 200 || !validKey(key)) {
			res.sendStatus(status === 200 ? 400 : status);
			return;
		}
		res.set("Cache-Control", "no-store");
		const open = store.open(key);
		if (!open) {
			res.sendStatus(204);
			return;
		}
		// Plan ruling 9: the file's t (its first record's time), which its bytes don't carry.
		res.set("X-Minimap-T", String(open.t)).type("application/gzip").send(gzipSync(open.bytes));
	});
}
