/**
 * Native harness releases Clankie admits by a validated floor rather than an
 * exact pin (VUH-2417). Only a plain `MAJOR.MINOR.PATCH` release counts:
 * pre-release and local builds report other forms, and none has been validated.
 */
const RELEASE = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/u;

function isNativeRelease(version: string): boolean {
  return RELEASE.test(version);
}

/** True when `version` is a plain release at or above `floor`. */
export function releaseAtLeast(version: string, floor: string): boolean {
  const found = RELEASE.exec(version);
  const minimum = RELEASE.exec(floor);
  if (!found || !minimum) return false;
  for (let index = 1; index <= 3; index += 1) {
    const order = Number(found[index]) - Number(minimum[index]);
    if (order !== 0) return order > 0;
  }
  return true;
}

/** The found release, or a refusal that names the harness, what it reported and the floor. */
export function admitNativeRelease(harness: string, found: string, floor: string): string {
  if (!isNativeRelease(found))
    throw new Error(`${harness} reported an unrecognized version "${found.slice(0, 64)}"; no fallback`);
  if (!releaseAtLeast(found, floor))
    throw new Error(`${harness} ${found} is older than the validated floor ${floor}; update it to hire`);
  return found;
}
