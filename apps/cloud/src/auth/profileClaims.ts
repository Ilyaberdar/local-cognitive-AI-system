import type { VerifiedIdentity } from "./verifyAccessToken.js";

/** Added to access tokens by the Auth0 Post-Login Action; access tokens for a custom API
 * carry no email otherwise. Only these namespaced claims are trusted. */
export const PROFILE_CLAIM_NAMESPACE = "https://local-cognitive.com/";

export interface ProfileClaims { email: string | null; emailVerified: boolean; displayName: string | null }

const text = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned ? cleaned.slice(0, max) : null;
};

export const extractProfileClaims = (claims: Record<string, unknown>): ProfileClaims => {
  const email = text(claims[`${PROFILE_CLAIM_NAMESPACE}email`], 320);
  const validEmail = email && email.includes("@") ? email : null;
  return {
    email: validEmail,
    // A missing Action or a non-boolean value fails closed: unverified accounts get no remote grant.
    emailVerified: Boolean(validEmail) && claims[`${PROFILE_CLAIM_NAMESPACE}email_verified`] === true,
    displayName: text(claims[`${PROFILE_CLAIM_NAMESPACE}name`], 200)
  };
};

/** Machine (client-credentials) tokens never create accounts. */
export const isUserToken = (identity: VerifiedIdentity): boolean =>
  identity.claims.gty !== "client-credentials" && !identity.subject.endsWith("@clients");
