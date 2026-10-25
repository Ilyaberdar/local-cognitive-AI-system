import { PluginError, type CredentialVault } from "../../src/plugins/contracts";

/** A credential vault in memory: `values` holds its records, and a record named in `unreadable` fails
 * to read as one encrypted on another computer does. */
export function keyVault(): CredentialVault & { values: Map<string, string>; unreadable: Set<string> } {
  const values = new Map<string, string>(), unreadable = new Set<string>();
  return {
    values, unreadable,
    available: () => true,
    read: async key => {
      if (unreadable.has(key)) throw new PluginError("Protected credentials could not be read. Reconnect this account.", 503);
      return values.get(key);
    },
    write: async (key, value) => { values.set(key, value); },
    remove: async key => { values.delete(key); unreadable.delete(key); }
  };
}
