import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { amzDate, authorization, sha256, signedPut } from "../../s3/sigv4.js";

// AWS's published example (spec §16.2), "Example: PUT Object" of
// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html, copied 2026-10-05 from the Wayback
// Machine's 2025-01-02 capture (the live URL now redirects to the API reference's front page; plan ruling 2).
const AWS = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
	region: "us-east-1" };

test("SigV4: AWS's published PUT Object example", () => {
	const body = "Welcome to Amazon S3.";
	assert.equal(sha256(body), "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
	assert.equal(amzDate(new Date(Date.UTC(2013, 4, 24))), "20130524T000000Z");
	const auth = authorization(AWS, "PUT", "/test%24file.text", {
		"date": "Fri, 24 May 2013 00:00:00 GMT",
		"host": "examplebucket.s3.amazonaws.com",
		"x-amz-content-sha256": sha256(body),
		"x-amz-date": "20130524T000000Z",
		"x-amz-storage-class": "REDUCED_REDUNDANCY",
	});
	assert.equal(auth, "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request," +
		"SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class," +
		"Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
});

test("a PUT is path-style, sets no Host header, and signs every header it sends, the endpoint's host with its port " +
	"(REV M-6)", () => {
	const target = { ...AWS, endpoint: "http://127.0.0.1:9000", bucket: "map", region: "auto" };
	const now = new Date(Date.UTC(2026, 9, 5, 12));
	const body = Buffer.from("data");
	const { url, init } = signedPut(target, "i-1/nauvis/player/0/0_0/1.c.gz", body, { "content-type": "x" }, now);
	assert.equal(url, "http://127.0.0.1:9000/map/i-1/nauvis/player/0/0_0/1.c.gz");
	const headers = init.headers as Record<string, string>;
	assert.equal(headers.host, undefined);
	assert.equal(headers["content-type"], "x");
	const signed = { "content-type": "x", "x-amz-content-sha256": sha256(body), "x-amz-date": "20261005T120000Z" };
	const path = "/map/i-1/nauvis/player/0/0_0/1.c.gz";
	assert.equal(headers.authorization, authorization(target, "PUT", path, { host: "127.0.0.1:9000", ...signed }));
	assert.match(headers.authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date,/);
	assert.notEqual(headers.authorization, authorization(target, "PUT", path, { host: "127.0.0.1", ...signed }));
	const slash = signedPut({ ...target, endpoint: "http://127.0.0.1:9000/" }, "i-1/nauvis/player/0/0_0/1.c.gz", body,
		{ "content-type": "x" }, now);
	const again = slash.init.headers as Record<string, string>;
	assert.deepEqual([slash.url, again.authorization], [url, headers.authorization],
		"Review Focus 4: an endpoint pasted with a trailing slash");
});

test("fetch sends the port in Host and the signed headers as signed, so a server checking them accepts the PUT",
	async () => {
		const seen: { host?: string; ok: boolean }[] = [];
		const server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c: Buffer) => chunks.push(c));
			req.on("end", () => {
				// As S3 does: every header the request lists in SignedHeaders, as received, and the body's hash.
				const names = /SignedHeaders=([^,]+)/.exec(req.headers.authorization ?? "")?.[1].split(";") ?? [];
				const headers = Object.fromEntries(names.map(n => [n, String(req.headers[n])]));
				const ok = headers["x-amz-content-sha256"] === sha256(Buffer.concat(chunks))
					&& req.headers.authorization === authorization(AWS, "PUT", req.url!, headers);
				seen.push({ host: req.headers.host, ok });
				res.writeHead(ok ? 200 : 403).end();
			});
		});
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		try {
			const target = { ...AWS, endpoint: `http://127.0.0.1:${port}`, bucket: "map" };
			const headers = { "cache-control": "public, max-age=60", "content-type": "application/gzip" };
			const { url, init } = signedPut(target, "maps.json.gz", Buffer.from([0x1f, 0x8b, 0x08, 0xff]), headers);
			assert.equal((await fetch(url, init)).status, 200);
			assert.deepEqual(seen, [{ host: `127.0.0.1:${port}`, ok: true }]);
		} finally {
			server.close();
		}
	});
