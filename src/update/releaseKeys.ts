import type { ReleaseKey } from "./manifest";

/** The public keys whose signatures this build accepts for server releases. Their private keys stay
 * with the project owner (`node scripts/release-key.mjs generate`), never in the repository. Empty
 * until the first key is made: updates are then refused as unverifiable. Several keys allow rotation. */
export const RELEASE_KEYS: readonly ReleaseKey[] = [];
