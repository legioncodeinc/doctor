/**
 * The doctor -> hive SSE producer (doctor PRD-002a; ADR-0001 decision 3).
 *
 * Exactly ONE stream, doctor to hive, served at `GET /events` on the EXISTING
 * loopback status page (`../status-page/server.js`, `:3852`), alongside `/` and
 * `/status.json` (PRD-002a implementation note: "reuse the loopback server rather than
 * adding a new listener"). There is no service-to-doctor stream and no other
 * streaming surface (ADR-0001 decision 3, a-AC-1). One event type, `fleet-telemetry`,
 * carrying the in-memory model the poll loop (`./poll-loop.js`) maintains (Contract C).
 * This module never re-opens SQLite itself; it only forwards the loop's snapshots.
 *
 * Fail-soft by construction (PRD-002a a-AC-5/a-AC-6, PRD-002 AC-6):
 *   - a write to a disconnected or backpressured socket is caught and triggers cleanup
 *     rather than throwing back into the poll loop's listener fan-out (one slow/dead
 *     consumer can never affect another connection or the loop itself);
 *   - a per-service telemetry gap already degrades gracefully UPSTREAM (the poll loop's
 *     own c-AC-6 isolation produces a `telemetryFault`-flagged model for that service
 *     while every other service's fields stay populated), so this module only has to
 *     forward whatever snapshot it is given -- it never needs its own per-service logic.
 *
 * Zero external dependency: `node:http` types only (PRD-002a a-AC-7).
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { Logger } from "../logger.js";
import type { FleetTelemetryEvent } from "../telemetry/schema.js";
import type { PollLoop } from "./poll-loop.js";

/** The one event type this stream ever emits (Contract C). */
export const FLEET_TELEMETRY_EVENT_NAME = "fleet-telemetry" as const;

/** Format one SSE frame: a named event plus a single-line JSON `data:` payload. */
function formatSseEvent(event: FleetTelemetryEvent): string {
	return `event: ${FLEET_TELEMETRY_EVENT_NAME}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Options for {@link handleSseRequest}. */
export interface SseHandlerOptions {
	/** The poll loop whose snapshots this connection streams. */
	readonly pollLoop: PollLoop;
	readonly logger: Logger;
}

/**
 * Serve one `GET /events` connection to completion: write the CURRENT snapshot
 * immediately (so a new connection does not wait a full poll interval for its first
 * frame, PRD-002a a-AC-2 "near real time"), then one `fleet-telemetry` frame per
 * subsequent poll tick until the client disconnects or the write itself fails.
 *
 * Never throws: every write is guarded, and a disconnect/error/backpressured socket
 * unsubscribes from the poll loop and ends the response defensively.
 */
export function handleSseRequest(req: IncomingMessage, res: ServerResponse, options: SseHandlerOptions): void {
	const { pollLoop, logger } = options;

	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-store",
		Connection: "keep-alive",
	});

	let unsubscribed = false;
	let unsubscribe: (() => void) | null = null;

	function cleanup(): void {
		if (unsubscribed) return;
		unsubscribed = true;
		if (unsubscribe !== null) unsubscribe();
	}

	function endQuietly(): void {
		try {
			res.end();
		} catch {
			// The socket may already be gone; nothing left to do.
		}
	}

	function safeWrite(frame: string): void {
		if (unsubscribed) return;
		try {
			const buffered = !res.write(frame);
			if (buffered) {
				// a-AC-5: a consumer that cannot keep up with backpressure is dropped rather
				// than buffered without bound -- the bounded-slice discipline (PRD-002c)
				// extends to the transport, not just the SQLite query window.
				logger.warn("sse.slow_consumer_disconnected", {});
				cleanup();
				endQuietly();
			}
		} catch (error) {
			logger.warn("sse.write_failed", { reason: error instanceof Error ? error.message : "unknown" });
			cleanup();
			endQuietly();
		}
	}

	safeWrite(formatSseEvent(pollLoop.snapshot()));
	unsubscribe = pollLoop.onSnapshot((event) => safeWrite(formatSseEvent(event)));

	const onDisconnect = (): void => cleanup();
	req.on("close", onDisconnect);
	req.on("error", onDisconnect);
	res.on("close", onDisconnect);
	res.on("error", onDisconnect);
}
