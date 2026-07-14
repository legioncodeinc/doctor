import { renderGroupedHelp, renderProductBanner, type ProductBrand } from "@legioncodeinc/cli-kit";

import type { Colors } from "./colors.js";
import { DOCTOR_MANIFEST } from "./command-table.js";
import { DOCTOR_VERSION } from "../version.js";

/** Doctor-specific medical/watchdog motif, ASCII-only and comfortably below 80 columns. */
export const DOCTOR_BRAND: ProductBrand = Object.freeze({
	executable: "doctor",
	name: "DOCTOR",
	descriptor: "Doctor - Apiary service health and diagnostics",
	art: [
		"        .--------.",
		"     ___|   +    |___",
		"    /   |  /|\\   |   \\",
		"   |    | / | \\  |    |",
		"    \\___|   |    |___/",
		"        '--------'",
	].join("\n"),
});

/** Pure, shared-frame help renderer. Color remains a compatibility parameter. */
export function renderBanner(_colors: Colors, width = 80): string {
	const full = renderProductBanner({
		brand: DOCTOR_BRAND,
		version: DOCTOR_VERSION,
		manifest: { product: "doctor", commands: [] },
		width,
	});
	return full.split("\n\n")[0] ?? full;
}

export function renderMenu(_colors: Colors, width = 80): string {
	return [
		"Usage: doctor <command> [options]",
		"",
		"Commands:",
		renderGroupedHelp(DOCTOR_MANIFEST, width),
		"",
		"Global options",
		"  --help, -h  Show help",
		"  --version   Show version",
		"  --json      Emit machine-readable output",
		"  --no-color  Disable color",
	].join("\n");
}

export function renderBannerWithMenu(_colors: Colors, width = 80): string {
	return _colors.amber(renderProductBanner({ brand: DOCTOR_BRAND, version: DOCTOR_VERSION, manifest: DOCTOR_MANIFEST, width }))
		.replace("\nService lifecycle", "\n\nCommands:\nService lifecycle");
}
