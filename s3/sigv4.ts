import { createHash, createHmac } from "node:crypto";

// AWS Signature Version 4 for S3 (spec §10.2), over node:crypto: no SDK (§5.3).

/** Where the public copy goes, and the keys that sign for it (§10.1). */
export type Target = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region: string };

export function sha256(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/** x-amz-date's form of a time: 20130524T000000Z. */
export function amzDate(t: Date): string {
	return t.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * The Authorization header of one S3 request with no query string. `path` is already URI-encoded; `headers` are
 * lower-case, include x-amz-date and x-amz-content-sha256 (the body's SHA-256), and are all signed.
 */
export function authorization(
	c: Pick<Target, "accessKeyId" | "secretAccessKey" | "region">,
	method: string,
	path: string,
	headers: Record<string, string>,
): string {
	const names = Object.keys(headers).sort();
	const date = headers["x-amz-date"];
	const scope = `${date.slice(0, 8)}/${c.region}/s3/aws4_request`;
	const request = [
		method, path, "", ...names.map(n => `${n}:${headers[n]}`), "", names.join(";"), headers["x-amz-content-sha256"],
	].join("\n");
	let key = createHmac("sha256", `AWS4${c.secretAccessKey}`).update(date.slice(0, 8)).digest();
	for (const part of [c.region, "s3", "aws4_request"]) {
		key = createHmac("sha256", key).update(part).digest();
	}
	const signature = createHmac("sha256", key)
		.update(["AWS4-HMAC-SHA256", date, scope, sha256(request)].join("\n"))
		.digest("hex");
	const credential = `${c.accessKeyId}/${scope}`;
	return `AWS4-HMAC-SHA256 Credential=${credential},SignedHeaders=${names.join(";")},Signature=${signature}`;
}

/**
 * A path-style PUT of `key` (§10.2): `PUT <endpoint>/<bucket>/<key>`, signed over every header it sends: host,
 * x-amz-content-sha256, x-amz-date and `headers` (lower-case; Cache-Control and Content-Type, plan ruling 3). The
 * signed host is the endpoint's, port included, and no Host header is set: fetch sends the URL's own (REV M-6). Keys
 * need no URI-encoding (K13).
 */
export function signedPut(
	t: Target,
	key: string,
	body: Uint8Array,
	headers: Record<string, string>,
	now = new Date(),
): { url: string; init: RequestInit } {
	const url = new URL(t.endpoint);
	const path = `/${t.bucket}/${key}`;
	const sent = { ...headers, "x-amz-content-sha256": sha256(body), "x-amz-date": amzDate(now) };
	const auth = authorization(t, "PUT", path, { host: url.host, ...sent });
	return { url: `${url.origin}${path}`, init: { method: "PUT", body, headers: { ...sent, authorization: auth } } };
}
