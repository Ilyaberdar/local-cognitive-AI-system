/** What a paired device may approve on a computer a person uses (a desktop that hosts), unless that
 * person trusts the device: a file operation inside the run's own folders, or a public web page. A
 * command, files anywhere else, and anything not known to be one of these, a device may only decline.
 * Returns why an approval is refused, or nothing. */
export const deviceApprovalRefusal = (operation: Record<string, unknown>, hostName: string): string | undefined => {
  const what = refusedKind(operation);
  return what ? `Devices cannot approve this on ${hostName}: ${what}. Decline it, or on ${hostName} mark this device as trusted (Remote → This computer → Devices).` : undefined;
};

const refusedKind = (operation: Record<string, unknown>): string | undefined => {
  const kind = String(operation.operation ?? "");
  const file = operation.tool === "file" || /^file[._]/.test(kind);
  const command = operation.tool === "command" || /^command/.test(kind);
  if (file && operation.scope === "workspace") return undefined;
  // A web page fetched for a workflow; pages on the computer's own network are refused elsewhere.
  if (!file && !command && typeof operation.url === "string" && operation.place === undefined) return undefined;
  return command ? "it runs a command on that computer" : file ? "it reaches files outside this chat's own folder" : "it acts on that computer";
};

/** Whether only the host or a device trusted there may approve this: on a desktop what the policy
 * above refuses; on a server and a desktop alike, an application's tool (MCP) and a page on the
 * host's own network. Sent with an approval as a hint for devices; the host's refusal decides. */
export const approvalNeedsTrust = (operation: Record<string, unknown>, kind: "desktop" | "server"): boolean =>
  operation.tool === "mcp" || (typeof operation.url === "string" && typeof operation.place === "string")
  || (kind === "desktop" && refusedKind(operation) !== undefined);
