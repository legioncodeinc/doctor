/**
 * The update/rollback telemetry seam (PRD-064e AC-064e.5).
 *
 * Every update and every rollback emits a telemetry event recording from-version,
 * to-version, and outcome. The event is emitted through an injected {@link UpdateEmit}
 * seam so AC-064e.5 can be asserted with a mock (the test injects a recorder and reads
 * the from/to/outcome it captured) and so the engine never depends on a live network.
 *
 * The production seam ({@link createDefaultUpdateEmit}) adapts these events onto the
 * existing 064d telemetry chokepoint ({@link file://../telemetry/emit.ts}) -- the ONE
 * place anything leaves the box -- by mapping an update event onto the `error` stream
 * (it reuses the chokepoint's allow-listed `error_class` / `error_detail` fields, which
 * already pass the closed allow-list, rather than widening that allow-list from this
 * out-of-scope wave). The from/to/outcome triple is encoded into `error_detail` as a
 * compact, secret-free `from=..;to=..;outcome=..` fact string. Version strings are not
 * secrets; no token, path, or credential is ever in the payload.
 *
 * Fail-soft: the default seam delegates to `emitTelemetry`, which never throws and never
 * rejects. The engine awaits the emit but a failed send is a swallowed no-op.
 *
 * ADDITIVE (lifecycle capture events): when the composition root supplies a
 * {@link LifecycleTelemetry} emitter, a SUCCESSFUL update outcome ("updated" /
 * "updated_unverified") ALSO fires the `hivedoctor_updated` PostHog CAPTURE event
 * ({@link file://../telemetry/capture.ts}), deduped per to_version via the state store.
 * The OTLP log emission above is untouched; the capture emit is a second, equally
 * fail-soft leg that can never affect the engine. No lifecycle injected = no capture
 * leg (so bare test/dev constructions never read env, disk, or network implicitly).
 */

import type { LifecycleTelemetry } from "../telemetry/capture.js";
import { emitTelemetry, type EmitDeps } from "../telemetry/emit.js";

/** The outcome of an update or rollback transaction (the `outcome` of AC-064e.5). */
export type UpdateOutcome =
	| "updated" // installed + post-update /health verified healthy
	| "updated_unverified" // installed, but no healthy baseline / no supervised daemon to verify against -> health verification skipped, new version KEPT (no rollback)
	| "rolled_back" // post-update /health failed; reinstalled the prior version, healthy again
	| "rollback_failed" // post-update /health failed AND the rollback reinstall did not recover
	| "install_failed" // the npm install itself failed (no version change took effect)
	| "skipped" // a transaction was attempted but short-circuited (e.g. lock held)
	;

/** One update/rollback telemetry event (from/to/outcome, AC-064e.5). */
export interface UpdateTelemetryEvent {
	/** The kind of transaction this event describes. */
	readonly kind: "update" | "rollback";
	/** The version the daemon was on before the transaction. */
	readonly fromVersion: string;
	/** The version the transaction targeted (the blessed version, or the prior version on a rollback). */
	readonly toVersion: string;
	/** The terminal outcome. */
	readonly outcome: UpdateOutcome;
	/** The stable per-install device id (PRD-033 UUID) for correlation. */
	readonly deviceId: string;
	/** Timestamp in ms. */
	readonly timestampMs: number;
}

/** The injectable emit seam. Tests inject a recorder; production adapts onto 064d. */
export type UpdateEmit = (event: UpdateTelemetryEvent) => Promise<void>;

/**
 * Build the production emit seam that adapts an update/rollback event onto the 064d
 * telemetry chokepoint. The from/to/outcome triple is packed into the allow-listed
 * `error_class` (a stable label) + `error_detail` (the compact fact string). Fail-soft:
 * `emitTelemetry` swallows all transport errors and never throws.
 *
 * Additive lifecycle leg: when `lifecycle` is supplied, a SUCCESSFUL update outcome
 * ("updated" / "updated_unverified") also fires the `hivedoctor_updated` capture event
 * (deduped per to_version inside the lifecycle emitter). Rollbacks and failures fire NO
 * capture event. Absent `lifecycle` = the pre-existing OTLP-log-only behavior.
 */
export function createDefaultUpdateEmit(deps: EmitDeps = {}, lifecycle?: LifecycleTelemetry): UpdateEmit {
	return async (event: UpdateTelemetryEvent): Promise<void> => {
		await emitTelemetry(
			{
				kind: "error",
				errorClass: `auto_${event.kind}_${event.outcome}`,
				errorDetail: `from=${event.fromVersion};to=${event.toVersion};outcome=${event.outcome}`,
				deviceId: event.deviceId,
				timestampMs: event.timestampMs,
			},
			deps,
		);

		// The additive capture leg: only a landed update reports (kind "update" + a kept
		// new version). The lifecycle emitter is itself gated + deduped + fail-soft, and
		// the extra try/catch keeps this seam total even against a broken injected stub.
		if (
			lifecycle !== undefined &&
			event.kind === "update" &&
			(event.outcome === "updated" || event.outcome === "updated_unverified")
		) {
			try {
				await lifecycle.updated(event.fromVersion, event.toVersion, event.outcome);
			} catch {
				// A capture-event failure must never surface into the update transaction.
			}
		}
	};
}
