export type IdentityProvider = "google" | "email" | "apple" | "other";

export const providerFromSubject = (subject: string): IdentityProvider => {
  const prefix = subject.includes("|") ? subject.slice(0, subject.indexOf("|")) : "";
  return prefix === "google-oauth2" ? "google" : prefix === "auth0" ? "email" : prefix === "apple" ? "apple" : "other";
};

export interface AccountRecord {
  id: string; status: "active" | "disabled"; createdAt: Date;
  identities: Array<{ subject: string; email: string | null; emailVerified: boolean; displayName: string | null; linkedAt: Date; current: boolean }>;
}

export interface MeResponse {
  accountId: string; status: "active" | "disabled"; createdAt: string;
  email: string | null; emailVerified: boolean; displayName: string | null;
  identities: Array<{ provider: IdentityProvider; email: string | null; emailVerified: boolean; linkedAt: string; current: boolean }>;
}

/** Allowlisted DTO: issuer, subject and row ids are never exposed. */
export const toMeResponse = (record: AccountRecord): MeResponse => {
  const current = record.identities.find((identity) => identity.current) ?? record.identities[0];
  return {
    accountId: record.id, status: record.status, createdAt: record.createdAt.toISOString(),
    email: current?.email ?? null, emailVerified: current?.emailVerified ?? false, displayName: current?.displayName ?? null,
    identities: record.identities.map((identity) => ({ provider: providerFromSubject(identity.subject), email: identity.email,
      emailVerified: identity.emailVerified, linkedAt: identity.linkedAt.toISOString(), current: identity.current }))
  };
};
