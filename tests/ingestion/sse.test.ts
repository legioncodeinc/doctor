/**
 * Tests for the PRD-002a SSE producer (`GET /events`).
 *
 * Coverage:
 *   a-AC-1 - exactly one SSE stream/endpoint (content-type + framing are well-formed).
 *   a-AC-2 - the current snapshot is emitted immediately, then a fresh frame per poll tick.
 *   a-AC-5 - a client disconnect unsubscribes from the poll loop and never throws.
 *   a-AC-6 - a fault-flagged service in the snapshot still flows through unchanged (the
 *            producer forwards whatever the poll loop hands it; it never re-derives per-
 *            service state itself).
 *   a-AC-7 - built on node:http only (implicit: no other import used here).
 *
 * A real `node:http` server + a real client socket are used so the SSE framing and the
 * disconnect-triggers-cleanup path are exercised end-to-end; the poll loop itself is a
 * lightweight fake so no real SQLite/timers are involved.
 */

import { createServer, get, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handleSseRequest } from "../../src/ingestion/sse.js";
import type { PollLoop } from "../../src/ingestion/poll-loop.js";
import { silentLogger } from "../../src/logger.js";
import type { FleetTelemetryEvent } from "../../src/telemetry/schema.js";

function fakeEvent(asOf: string): FleetTelemetryEvent {
	return {
		asOf,
		services: [
			{
				name: "honeycomb",
				health: "ok",
				lastSeen: asOf,
				metrics: { actionsTaken: 1 },
				deeplake: { connected: true, lastCommunicationAt: asOf },
				telemetryFault: null,
			},
		],
		logs: [{ service: "honeycomb", ts: asOf, level: "info", message: "hello" }],
	};
}

/** A minimal fake PollLoop: a fixed snapshot + a manually-triggerable subscriber list. */
function fakePollLoop(initial: FleetTelemetryEvent): {
	loop: PollLoop;
	emit(event: FleetTelemetryEvent): void;
	subscriberCount(): number;
} {
	const listeners = new Set<(event: FleetTelemetryEvent) => void>();
	let current = initial;
	const loop: PollLoop = {
		start: async () => undefined,
		stop: () => undefined,
		tick: async () => current,
		snapshot: () => current,
		reload: () => undefined,
		onSnapshot: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		close: () => undefined,
	};
	return {
		loop,
		emit(event: FleetTelemetryEvent): void {
			current = event;
			for (const listener of listeners) listener(event);
		},
		subscriberCount: () => listeners.size,
	};
}

let server: Server | null = null;
afterEach(async () => {
	if (server !== null) {
		await new Promise<void>((resolve) => server?.close(() => resolve()));
		server = null;
	}
});

function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
	return new Promise((resolve) => {
		server = createServer(handler);
		server.listen(0, "127.0.0.1", () => {
			resolve((server?.address() as AddressInfo).port);
		});
	});
}

/** Read raw bytes off a `get()` response until at least one full SSE frame (`\n\n`) has arrived. */
function readOneFrame(port: number, path = "/events"): Promise<{ statusCode: number | undefined; headers: Record<string, string | string[] | undefined>; frame: string; req: ReturnType<typeof get> }> {
	return new Promise((resolve, reject) => {
		const req = get(`http://127.0.0.1:${port}${path}`, (res) => {
			let buffer = "";
			res.on("data", (chunk: Buffer) => {
				buffer += chunk.toString("utf8");
				if (buffer.includes("\n\n")) {
					resolve({ statusCode: res.statusCode, headers: res.headers, frame: buffer, req });
				}
			});
			res.on("error", reject);
		});
		req.on("error", reject);
	});
}

describe("handleSseRequest (PRD-002a)", () => {
	it("a-AC-1/a-AC-2: responds text/event-stream and emits the current snapshot immediately as a well-formed fleet-telemetry frame", async () => {
		const fake = fakePollLoop(fakeEvent("2026-07-01T18:00:00.000Z"));
		const port = await startServer((req, res) => handleSseRequest(req, res, { pollLoop: fake.loop, logger: silentLogger }));

		const { statusCode, headers, frame, req } = await readOneFrame(port);
		expect(statusCode).toBe(200);
		expect(headers["content-type"]).toContain("text/event-stream");
		expect(headers["cache-control"]).toBe("no-store");

		expect(frame).toMatch(/^event: fleet-telemetry\n/);
		const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
		expect(dataLine).toBeDefined();
		const payload = JSON.parse((dataLine as string).slice("data: ".length)) as FleetTelemetryEvent;
		expect(payload.asOf).toBe("2026-07-01T18:00:00.000Z");
		expect(payload.services).toEqual(fakeEvent("2026-07-01T18:00:00.000Z").services);
		expect(payload.logs).toEqual(fakeEvent("2026-07-01T18:00:00.000Z").logs);

		req.destroy();
	});

	it("a-AC-2: a subsequent poll-loop snapshot is forwarded as a fresh frame on the same connection", async () => {
		const fake = fakePollLoop(fakeEvent("2026-07-01T18:00:00.000Z"));
		const port = await startServer((req, res) => handleSseRequest(req, res, { pollLoop: fake.loop, logger: silentLogger }));

		const collected: string[] = [];
		const req = get(`http://127.0.0.1:${port}/events`, (res) => {
			res.on("data", (chunk: Buffer) => collected.push(chunk.toString("utf8")));
		});
		await new Promise((resolve) => req.on("socket", (s) => s.on("connect", resolve)));
		// Wait for the initial frame to land.
		for (let i = 0; i < 50 && collected.join("").indexOf("\n\n") === -1; i += 1) {
			await new Promise((r) => setTimeout(r, 5));
		}

		fake.emit(fakeEvent("2026-07-01T18:00:01.000Z"));
		for (let i = 0; i < 50 && collected.join("").split("\n\n").length < 3; i += 1) {
			await new Promise((r) => setTimeout(r, 5));
		}

		const frames = collected.join("").split("\n\n").filter((f) => f.trim() !== "");
		expect(frames.length).toBeGreaterThanOrEqual(2);
		expect(frames[1]).toContain("2026-07-01T18:00:01.000Z");

		req.destroy();
	});

	it("a-AC-5: a client disconnect unsubscribes from the poll loop and never throws", async () => {
		const fake = fakePollLoop(fakeEvent("2026-07-01T18:00:00.000Z"));
		const port = await startServer((req, res) => handleSseRequest(req, res, { pollLoop: fake.loop, logger: silentLogger }));

		const { req } = await readOneFrame(port);
		expect(fake.subscriberCount()).toBe(1);

		req.destroy();
		// Give the server's 'close'/'error' handlers a turn to fire.
		for (let i = 0; i < 50 && fake.subscriberCount() !== 0; i += 1) {
			await new Promise((r) => setTimeout(r, 5));
		}
		expect(fake.subscriberCount()).toBe(0);

		// Emitting after disconnect must never throw, and no further writes go anywhere.
		expect(() => fake.emit(fakeEvent("2026-07-01T18:00:02.000Z"))).not.toThrow();
	});

	it("a-AC-6: a service flagged with a telemetryFault in the snapshot still flows through untouched", async () => {
		const faulted: FleetTelemetryEvent = {
			asOf: "2026-07-01T18:00:00.000Z",
			services: [
				{ name: "honeycomb", health: "ok", lastSeen: "2026-07-01T18:00:00.000Z", metrics: { actionsTaken: 1 }, deeplake: null, telemetryFault: null },
				{ name: "nectar", health: "degraded", lastSeen: null, metrics: {}, deeplake: null, telemetryFault: "missing" },
			],
			logs: [],
		};
		const fake = fakePollLoop(faulted);
		const port = await startServer((req, res) => handleSseRequest(req, res, { pollLoop: fake.loop, logger: silentLogger }));

		const { frame, req } = await readOneFrame(port);
		const dataLine = frame.split("\n").find((line) => line.startsWith("data: ")) as string;
		const payload = JSON.parse(dataLine.slice("data: ".length)) as FleetTelemetryEvent;
		expect(payload.services.find((s) => s.name === "nectar")).toEqual({
			name: "nectar",
			health: "degraded",
			lastSeen: null,
			metrics: {},
			deeplake: null,
			telemetryFault: "missing",
		});
		expect(payload.services.find((s) => s.name === "honeycomb")?.health).toBe("ok");

		req.destroy();
	});

	it("never throws when res.write itself throws (fail-soft transport)", async () => {
		const fake = fakePollLoop(fakeEvent("2026-07-01T18:00:00.000Z"));
		const warn = vi.fn();
		const port = await startServer((req, res) => {
			const originalWrite = res.write.bind(res);
			let calls = 0;
			res.write = ((chunk: unknown, ...rest: unknown[]) => {
				calls += 1;
				if (calls === 1) return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
				throw new Error("socket exploded");
			}) as ServerResponse["write"];
			handleSseRequest(req, res, { pollLoop: fake.loop, logger: { ...silentLogger, warn } });
		});

		const { req } = await readOneFrame(port);
		expect(() => fake.emit(fakeEvent("2026-07-01T18:00:01.000Z"))).not.toThrow();
		req.destroy();
	});
});
