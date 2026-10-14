/* Which Bisq 2 node versions we will work with.
 *
 * 2.1.12 (22 Aug 2026) fixed vulnerabilities from Bisq's security audit, and
 * both it and 2.1.13 say "Updating to this version is required to continue
 * trading". An older node therefore cannot trade at all. It also still runs
 * the pre-audit reputation checks, which matters more for us than for most
 * clients: with mediation out of scope, the seller's reputation is the only
 * protection a buyer has. So an older node is refused, with a reason. */

export const MIN_BISQ_VERSION = '2.1.12';

/** Compare dotted versions numerically: "2.1.13" > "2.1.9". Any suffix such
 *  as "-SNAPSHOT" is ignored, so a development build of 2.1.12 counts as
 *  2.1.12. Returns -1, 0 or 1. Missing parts count as 0. */
export function compareVersions(a, b) {
  const parse = (v) => String(v ?? '').trim().split(/[^0-9.]/)[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** True when `version` is a real version string at or above the minimum.
 *  An empty or unparseable version is NOT supported: a node that cannot say
 *  what it is does not get the benefit of the doubt. */
export function isSupportedBisqVersion(version) {
  if (!/^\s*\d+(\.\d+)*/.test(String(version ?? ''))) return false;
  return compareVersions(version, MIN_BISQ_VERSION) >= 0;
}

export function unsupportedVersionMessage(version) {
  return `This Bisq node is version ${version || 'unknown'}. CryptoBridge needs ${MIN_BISQ_VERSION} or newer: ` +
    'older nodes can no longer trade and still use reputation checks that Bisq has since fixed. ' +
    'Update Bisq and reconnect.';
}
