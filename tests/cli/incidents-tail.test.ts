/**
 * Incident-tail tests (PRD-064f `logs`): tail the last N NDJSON lines; a missing file
 * is an empty list, never a throw.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createIncidentsTail } from "../../src/cli/incidents-tail.js";

describe("createIncidentsTail", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "doctor-logs-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns an empty list when no incident file exists", async () => {
		expect(await createIncidentsTail(dir, ["honeycomb"])(20)).toEqual([]);
	});

	it("returns the last N lines", async () => {
		const lines = Array.from({ length: 5 }, (_, i) => `{"id":${i}}`).join("\n");
		writeFileSync(join(dir, "incidents-honeycomb.ndjson"), `${lines}\n`, "utf8");
		const tail = createIncidentsTail(dir, ["honeycomb"]);
		expect(await tail(2, "honeycomb")).toEqual(['{"id":3}', '{"id":4}']);
	});

	it("ignores blank lines", async () => {
		writeFileSync(join(dir, "incidents-honeycomb.ndjson"), '{"id":1}\n\n{"id":2}\n', "utf8");
		expect(await createIncidentsTail(dir, ["honeycomb"])(10, "honeycomb")).toEqual(['{"id":1}', '{"id":2}']);
	});

	it("falls back to a sane limit for a non-positive request", async () => {
		writeFileSync(join(dir, "incidents-honeycomb.ndjson"), '{"id":1}\n', "utf8");
		expect(await createIncidentsTail(dir, ["honeycomb"])(0, "honeycomb")).toEqual(['{"id":1}']);
	});

	it("b-AC-7: without a daemon filter, prefixes each line with its daemon name", async () => {
		writeFileSync(join(dir, "incidents-honeycomb.ndjson"), '{"id":"h1","closedAt":"2026-07-01T00:00:00.000Z"}\n', "utf8");
		writeFileSync(join(dir, "incidents-hive.ndjson"), '{"id":"t1","closedAt":"2026-07-01T00:01:00.000Z"}\n', "utf8");
		const lines = await createIncidentsTail(dir, ["honeycomb", "hive"])(20);
		expect(lines).toEqual([
			'[honeycomb] {"id":"h1","closedAt":"2026-07-01T00:00:00.000Z"}',
			'[hive] {"id":"t1","closedAt":"2026-07-01T00:01:00.000Z"}',
		]);
	});

	it("security: rejects a --daemon name that is not in the registry (no wrong-path read)", async () => {
		// An unregistered daemon name is invalid CLI input; it must be rejected loudly rather than
		// interpolated into an out-of-registry filename or silently returning an empty list.
		const tail = createIncidentsTail(dir, ["honeycomb", "hive"]);
		await expect(tail(20, "nectar")).rejects.toThrow(/unknown daemon "nectar"/);
	});

	it("security: rejects a path-traversal --daemon name rather than selecting a file", async () => {
		const tail = createIncidentsTail(dir, ["honeycomb"]);
		await expect(tail(20, "../../etc/passwd")).rejects.toThrow(/unknown daemon/);
	});

	it("security: still reads a registered daemon's shard normally", async () => {
		writeFileSync(join(dir, "incidents-honeycomb.ndjson"), '{"id":1}\n', "utf8");
		const tail = createIncidentsTail(dir, ["honeycomb"]);
		expect(await tail(20, "honeycomb")).toEqual(['{"id":1}']);
	});
});
