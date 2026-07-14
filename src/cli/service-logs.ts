import { appendFileSync, mkdirSync, promises as fsPromises, watch } from "node:fs";
import { join } from "node:path";

import {
	parseLogTailOptions,
	tailProductLog,
	type LogFileSystem,
	type LogTailResult,
} from "@legioncodeinc/cli-kit";

import { SERVICE_LABEL } from "../service/platform.js";

export const DOCTOR_SERVICE_LOG = "service.log" as const;

export function doctorServiceLogPath(workspaceDir: string): string {
	return join(workspaceDir, DOCTOR_SERVICE_LOG);
}

const nodeLogFs: LogFileSystem = {
	readFile: (path) => fsPromises.readFile(path, "utf8"),
	realpath: (path) => fsPromises.realpath(path),
	watch(path, onChange) {
		const watcher = watch(path, onChange);
		return { close: () => watcher.close() };
	},
};

export interface TailDoctorServiceLogOptions {
	readonly argv: readonly string[];
	readonly workspaceDir: string;
	readonly write: (line: string) => void;
	readonly signal?: AbortSignal;
	readonly fs?: LogFileSystem;
}

/** Tail only Doctor's authoritative service log; no path or service identifier is user-controlled. */
export async function tailDoctorServiceLog(options: TailDoctorServiceLogOptions): Promise<LogTailResult> {
	const parsed = parseLogTailOptions(options.argv);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	const path = doctorServiceLogPath(options.workspaceDir);
	return tailProductLog({
		productId: "doctor",
		serviceId: SERVICE_LABEL,
		source: { productId: "doctor", serviceId: SERVICE_LABEL, root: options.workspaceDir, path },
		options: parsed.options,
		fs: options.fs ?? nodeLogFs,
		write: options.write,
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
}

/** Best-effort service boundary logging used on every platform, including Scheduled Tasks. */
export async function appendDoctorServiceLog(workspaceDir: string, message: string): Promise<void> {
	try {
		await fsPromises.mkdir(workspaceDir, { recursive: true });
		await fsPromises.appendFile(
			doctorServiceLogPath(workspaceDir),
			`${new Date().toISOString()} ${message.replace(/[\r\n]+/gu, " ")}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
	} catch {
		// A logging failure must never prevent Doctor from supervising the fleet.
	}
}

/**
 * Bind the long-running service process' stdout and stderr to Doctor's one authoritative
 * file. This is the Windows Scheduled Task capture path; launchd/systemd also point their
 * native stream destinations at the same file.
 */
export function captureDoctorServiceOutput(workspaceDir: string): () => void {
	const path = doctorServiceLogPath(workspaceDir);
	const originalOut = process.stdout.write.bind(process.stdout);
	const originalErr = process.stderr.write.bind(process.stderr);
	try {
		mkdirSync(workspaceDir, { recursive: true });
		const append = ((chunk: string | Uint8Array, encodingOrCallback?: unknown, callback?: unknown): boolean => {
			try {
				appendFileSync(path, chunk, { mode: 0o600 });
				const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
				if (typeof done === "function") done();
				return true;
			} catch (error) {
				const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
				if (typeof done === "function") done(error);
				return false;
			}
		}) as typeof process.stdout.write;
		process.stdout.write = append;
		process.stderr.write = append as typeof process.stderr.write;
	} catch {
		return () => undefined;
	}
	return () => {
		process.stdout.write = originalOut;
		process.stderr.write = originalErr;
	};
}
