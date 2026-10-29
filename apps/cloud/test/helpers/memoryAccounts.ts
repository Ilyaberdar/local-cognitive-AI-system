import { randomUUID } from "node:crypto";
import type { AccountRepository, IdentityInput } from "../../src/accounts/accountRepository.js";
import type { AccountRecord } from "../../src/accounts/meResponse.js";

/** In-memory AccountRepository for HTTP tests that do not need Postgres. */
export const memoryAccounts = () => {
  const accounts = new Map<string, { status: AccountRecord["status"]; createdAt: Date }>();
  const links = new Map<string, IdentityInput & { accountId: string; linkedAt: Date }>();
  const repository: AccountRepository = {
    async upsertIdentity(input) {
      const key = `${input.issuer}\n${input.subject}`, existing = links.get(key);
      if (existing) {
        // As the SQL upsert: a token without an email keeps the identity's email, verification and name.
        links.set(key, { ...existing, email: input.email ?? existing.email, emailVerified: input.email === null ? existing.emailVerified : input.emailVerified,
          displayName: input.displayName ?? existing.displayName });
        return { accountId: existing.accountId, created: false };
      }
      const accountId = randomUUID();
      accounts.set(accountId, { status: "active", createdAt: new Date() });
      links.set(key, { ...input, accountId, linkedAt: new Date() });
      return { accountId, created: true };
    },
    async loadAccount(accountId, issuer, subject) {
      const account = accounts.get(accountId);
      if (!account) return undefined;
      return { id: accountId, status: account.status, createdAt: account.createdAt, identities: [...links.values()]
        .filter((link) => link.accountId === accountId)
        .map((link) => ({ subject: link.subject, email: link.email, emailVerified: link.emailVerified, displayName: link.displayName,
          linkedAt: link.linkedAt, current: link.issuer === issuer && link.subject === subject })) };
    }
  };
  return { repository, disable: (accountId: string) => { accounts.get(accountId)!.status = "disabled"; } };
};
