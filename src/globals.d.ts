/**
 * Ambient declaration for Doctor's build-time version token (PRD-064f).
 *
 * The later-wave esbuild bundle step replaces `__DOCTOR_VERSION__` with a string
 * literal via esbuild `define`, mirroring the parent package's `__HONEYCOMB_VERSION__`
 * and Doctor's own `__HONEYCOMB_POSTHOG_*` tokens. Declared `string | undefined`
 * so the `typeof` guard in `src/version.ts` is required, keeping the un-bundled
 * dev/test path explicit and `tsc --noEmit` clean without a build present.
 */

/* eslint-disable no-var */
declare var __DOCTOR_VERSION__: string | undefined;
