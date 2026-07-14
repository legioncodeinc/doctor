import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { isDirectInvocation } from "../../src/cli/direct-invocation.js";

describe("packed CLI direct-invocation detection", () => {
	it("accepts macOS /var and /private/var aliases of the same executable", () => {
		const invoked = "/var/folders/fixture/doctor/bundle/cli.js";
		const modulePath = "/private/var/folders/fixture/doctor/bundle/cli.js";
		const canonicalize = (path: string): string => path
			.replaceAll("\\", "/")
			.replace(/^[A-Za-z]:/u, "")
			.replace(/^\/var\//u, "/private/var/");

		expect(isDirectInvocation(invoked, pathToFileURL(modulePath).href, canonicalize)).toBe(true);
	});

	it("rejects an import from a different process entrypoint", () => {
		const canonicalize = (path: string): string => path;
		expect(
			isDirectInvocation("/tmp/fixture-runner.js", pathToFileURL("/tmp/doctor/bundle/cli.js").href, canonicalize),
		).toBe(false);
	});

	it("falls back to exact URL equality when canonicalization is unavailable", () => {
		const invoked = resolve("fixture", "doctor-cli.js");
		const unavailable = (): string => {
			throw new Error("realpath unavailable");
		};
		expect(isDirectInvocation(invoked, pathToFileURL(invoked).href, unavailable)).toBe(true);
	});
});
