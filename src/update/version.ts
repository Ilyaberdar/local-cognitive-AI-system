/** Release versions: X.Y.Z with an optional pre-release (0.2.0-beta.1). */
const PATTERN = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,40}))?$/;

export const isVersion = (value: unknown): value is string => typeof value === "string" && PATTERN.test(value);

/** Negative, zero or positive as a is older than, the same as, or newer than b (semver order). */
export const compareVersions = (a: string, b: string): number => {
  const left = PATTERN.exec(a), right = PATTERN.exec(b);
  if (!left || !right) throw new Error(`Not a release version: ${!left ? a : b}`);
  for (let index = 1; index <= 3; index++) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference) return Math.sign(difference);
  }
  const [preLeft, preRight] = [left[4], right[4]];
  if (!preLeft || !preRight) return preLeft ? -1 : preRight ? 1 : 0;
  const partsLeft = preLeft.split("."), partsRight = preRight.split(".");
  for (let index = 0; index < Math.max(partsLeft.length, partsRight.length); index++) {
    const x = partsLeft[index], y = partsRight[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    const difference = numeric ? Number(x) - Number(y) : x < y ? -1 : x > y ? 1 : 0;
    if (difference) return Math.sign(difference);
  }
  return 0;
};
