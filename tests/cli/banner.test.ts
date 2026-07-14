/**
 * Banner + menu rendering tests (PRD-064f AC-064f.1).
 */

import { describe, expect, it } from "vitest";

import { renderBanner, renderMenu, renderBannerWithMenu } from "../../src/cli/banner.js";
import { createColors } from "../../src/cli/colors.js";

const plain = createColors({ env: {}, isTty: false });

describe("renderBanner", () => {
	it("has product-only art and exactly one shared credit line", () => {
		const b = renderBanner(plain);
		expect(b).toContain("DOCTOR");
		expect(b.match(/Legion Code Inc\. x Activeloop/gu)).toHaveLength(1);
		expect(b).not.toContain("LEGION CODE INC.");
		expect(b).not.toContain("ACTIVELOOP");
		expect(b).not.toContain("powered by");
	});

	it("includes the single-sourced version", () => {
		// In tests __DOCTOR_VERSION__ is undefined, so version falls to the dev sentinel.
		expect(renderBanner(plain)).toContain("v0.0.0-dev");
	});
});

describe("renderMenu", () => {
	it("lists Usage + Commands + every command", () => {
		const m = renderMenu(plain);
		expect(m).toContain("Usage:");
		expect(m).toContain("Commands:");
		expect(m).toContain("status");
		expect(m).toContain("self-update");
		expect(m).not.toContain("clear-credentials");
	});
});

describe("renderBannerWithMenu", () => {
	it("concatenates the banner and the menu", () => {
		const full = renderBannerWithMenu(plain);
		expect(full).toContain("Doctor");
		expect(full).toContain("Commands:");
	});

	it("color mode wraps in ANSI escapes; plain mode does not", () => {
		const ESC = String.fromCharCode(27);
		const colored = renderBannerWithMenu(createColors({ env: {}, isTty: true }));
		expect(colored.includes(ESC)).toBe(true);
		expect(renderBannerWithMenu(plain).includes(ESC)).toBe(false);
	});

	it("matches the exact 80-column and narrow plain-text goldens", () => {
		expect(renderBannerWithMenu(plain, 80)).toMatchSnapshot("80 columns");
		expect(renderBannerWithMenu(plain, 42)).toMatchSnapshot("42 columns");
		const noColor = createColors({ env: { NO_COLOR: "1" }, isTty: true });
		expect(renderBannerWithMenu(noColor, 80)).toBe(renderBannerWithMenu(plain, 80));
	});
});
