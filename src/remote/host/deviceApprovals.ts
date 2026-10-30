/** What a paired device may approve on a computer a person uses (a desktop that hosts), unless that
 * person allowed more: a file operation inside the run's own folders, or a public web page. A command,
 * files anywhere else, and anything not known to be one of these, a device may only decline.
 * Returns why an approval is refused, or nothing. */
export const deviceApprovalRefusal = (operation: Record<string, unknown>, hostName: string): string | undefined => {
  const kind = String(operation.operation ?? "");
  const file = operation.tool === "file" || /^file[._]/.test(kind);
  const command = operation.tool === "command" || /^command/.test(kind);
  if (file && operation.scope === "workspace") return undefined;
  // A web page fetched for a workflow; pages on the computer's own network are refused elsewhere.
  if (!file && !command && typeof operation.url === "string" && operation.place === undefined) return undefined;
  const what = command ? "it runs a command on that computer" : file ? "it reaches files outside this chat's own folder" : "it acts on that computer";
  return `Devices cannot approve this on ${hostName}: ${what}. Decline it, or on ${hostName} allow devices to approve commands and files (Remote → This computer).`;
};
