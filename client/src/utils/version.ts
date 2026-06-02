/**
 * Minimal SemVer comparator.
 *
 * Why hand-rolled? The single consumer is the updater's
 * "is `latest` newer than `current`?" check. Pulling in `semver` (or any of
 * its lighter alternatives) for one comparison ships ~25 KB to a bundle
 * that is already heavier than we'd like. Two strings split on `.`, then
 * lex-compared per segment, gets us 100% of what we need:
 *
 *   - `0.7.11` vs `0.7.12`         -> -1
 *   - `0.7.12` vs `0.7.11`         -> +1
 *   - `0.7.12` vs `0.7.12`         ->  0
 *   - `0.7.12-rc.1` vs `0.7.12`    -> -1 (any pre-release tag < no tag)
 *   - `0.0.0-dev` vs anything real -> -1
 *
 * Pre-release ordering is the lightweight rule "any string with a `-`
 * sorts BEFORE the same triplet without one." That matches SemVer 2.0.0
 * for the simple case we care about (pre-releases of the SAME version);
 * we don't currently ship `-rc.1` vs `-rc.2` style chains.
 */

export function parseVersion(input: string): {
  major: number;
  minor: number;
  patch: number;
  pre: string;
} {
  const s = input.trim().replace(/^v/, "");
  const dashIdx = s.indexOf("-");
  const core = dashIdx === -1 ? s : s.slice(0, dashIdx);
  const pre = dashIdx === -1 ? "" : s.slice(dashIdx + 1);
  const parts = core.split(".").map((p) => parseInt(p, 10));
  return {
    major: Number.isFinite(parts[0]) ? parts[0] : 0,
    minor: Number.isFinite(parts[1]) ? parts[1] : 0,
    patch: Number.isFinite(parts[2]) ? parts[2] : 0,
    pre,
  };
}

/**
 * Returns -1 if `a < b`, 0 if equal, +1 if `a > b`.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  // Equal core triplet. Pre-release rules:
  //   no-pre  > with-pre  (SemVer 2.0.0 §11)
  //   pre vs pre — lex compare for our simple needs
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === "") return 1;
  if (pb.pre === "") return -1;
  return pa.pre < pb.pre ? -1 : 1;
}
