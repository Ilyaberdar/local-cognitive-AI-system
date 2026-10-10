import type { ReleaseKey } from "./manifest";

/** The public keys whose signatures this build accepts for server releases. Their private keys stay
 * with the project owner (`node scripts/release-key.mjs generate`), never in the repository: the
 * first one (2026-10-10) is kept outside it on the owner's Mac and goes to the release workflow as a
 * secret. Several keys allow rotation: a release signed by the old key brings in the new one. */
export const RELEASE_KEYS: readonly ReleaseKey[] = [
  { id: "589df7006601266a", publicKey: "NAxCiTlDJEPskczZWsru_6hRW7XMKxtw_GwHn4yuL5c" }
];
