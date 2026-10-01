import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { PluginError, PluginInvocationError } from "./contracts";

type Arguments = Record<string, unknown>;
interface NativeTool { definition: Tool; request(args: Arguments): { url: string; method?: string; body?: unknown;
  rawBody?: string; headers?: Record<string, string>; text?: boolean }; }
const string = { type: "string", minLength: 1, maxLength: 2000 };
const text = { type: "string", maxLength: 100_000 };
const number = { type: "integer", minimum: 1, maximum: 1_000_000 };
const part = (value: unknown) => encodeURIComponent(String(value));
const url = (base: string, params: Record<string, unknown>) => `${base}?${new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))}`;
const tool = (name: string, description: string, readOnly: boolean, properties: Record<string, object>, required: string[], request: NativeTool["request"]): NativeTool => ({
  definition: { name, description, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: true },
    inputSchema: { type: "object", properties, required, additionalProperties: false } }, request
});
const graph = "https://graph.microsoft.com/v1.0";
export const nativeTools: Record<string, NativeTool[]> = {
  github: [
    tool("list_repositories", "List repositories accessible to the signed-in GitHub user (100 per page).", true, { page: number }, [], a => ({ url: url("https://api.github.com/user/repos", { per_page: 100, page: a.page ?? 1, sort: "updated" }) })),
    tool("search_issues", "Search GitHub issues and pull requests. Use GitHub query syntax, e.g. repo:owner/name is:open.", true, { query: string, page: number }, ["query"], a => ({ url: url("https://api.github.com/search/issues", { q: a.query, per_page: 30, page: a.page ?? 1 }) })),
    tool("get_issue", "Read a GitHub issue or pull request by repository and number.", true, { owner: string, repo: string, number }, ["owner", "repo", "number"], a => ({ url: `https://api.github.com/repos/${part(a.owner)}/${part(a.repo)}/issues/${a.number}` })),
    tool("create_issue", "Create a GitHub issue. This writes to the selected repository and requires approval.", false, { owner: string, repo: string, title: string, body: text }, ["owner", "repo", "title", "body"], a => ({ url: `https://api.github.com/repos/${part(a.owner)}/${part(a.repo)}/issues`, method: "POST", body: { title: a.title, body: a.body } }))
  ],
  slack: [
    tool("search_messages", "Search Slack messages as the connected user. Supports Slack search syntax and pagination.", true, { query: string, page: number }, ["query"], a => ({ url: url("https://slack.com/api/search.messages", { query: a.query, count: 30, page: a.page ?? 1 }) })),
    tool("list_channels", "List Slack channels accessible to the user. Pass response_metadata.next_cursor for another page.", true, { cursor: string }, [], a => ({ url: url("https://slack.com/api/conversations.list", { limit: 100, types: "public_channel,private_channel", cursor: a.cursor }) })),
    tool("channel_history", "Read recent Slack messages in one channel; use next_cursor to paginate.", true, { channel: string, cursor: string }, ["channel"], a => ({ url: url("https://slack.com/api/conversations.history", { channel: a.channel, limit: 50, cursor: a.cursor }) })),
    tool("send_message", "Send a Slack message as the connected user. Approval required; does not auto-retry.", false, { channel: string, text, thread_ts: string }, ["channel", "text"], a => ({ url: "https://slack.com/api/chat.postMessage", method: "POST", body: { channel: a.channel, text: a.text, thread_ts: a.thread_ts } }))
  ],
  "google-drive": [
    tool("search_files", "List/search Google Drive file metadata, not file contents. To list files, pass {} (query defaults to trashed = false). To filter, use Drive q syntax, e.g. name contains 'report' and trashed = false. Do not use an empty query or wildcard '*'. Returns IDs, names, MIME types, links and a nextPageToken.", true, { query: string, pageToken: string }, [], a => ({ url: url("https://www.googleapis.com/drive/v3/files", { q: a.query ?? "trashed = false", pageToken: a.pageToken, pageSize: 100, fields: "nextPageToken,files(id,name,mimeType,webViewLink,modifiedTime)", supportsAllDrives: true, includeItemsFromAllDrives: true }) })),
    tool("read_text_file", "Read a UTF-8 text file (up to 128 KiB) from Drive. For native Google Docs set googleDoc=true to export plain text. Not for binary files.", true, { fileId: string, googleDoc: { type: "boolean" } }, ["fileId"], a => ({ url: a.googleDoc ? url(`https://www.googleapis.com/drive/v3/files/${part(a.fileId)}/export`, { mimeType: "text/plain" }) : url(`https://www.googleapis.com/drive/v3/files/${part(a.fileId)}`, { alt: "media", supportsAllDrives: true }), text: true })),
    tool("create_text_file", "Create a UTF-8 text file in Google Drive. Does not overwrite existing files. Approval required.", false, { name: string, content: text, parentId: string }, ["name", "content"], a => {
      // JSON multipart metadata is escaped independently of the text payload.
      const boundary = "local-cognitive-drive-boundary";
      if (String(a.content).includes(boundary)) throw new PluginError("File content contains the multipart boundary.");
      return { url: "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink", method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        rawBody: `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: a.name, mimeType: "text/plain", ...(a.parentId ? { parents: [a.parentId] } : {}) })}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${a.content}\r\n--${boundary}--` };
    })
  ],
  "outlook-email": [
    tool("list_messages", "List Outlook messages. Optional search searches subject/body; skip paginates 25 messages at a time.", true, { search: string, skip: { type: "integer", minimum: 0, maximum: 100_000 } }, [], a => ({ url: url(`${graph}/me/messages`, { $top: 25, $skip: a.skip, $select: "id,subject,from,receivedDateTime,bodyPreview,isRead", $search: a.search ? JSON.stringify(a.search) : undefined }) })),
    tool("read_message", "Read an Outlook message including plain-text body.", true, { messageId: string }, ["messageId"], a => ({ url: `${graph}/me/messages/${part(a.messageId)}`, headers: { Prefer: 'outlook.body-content-type="text"' } })),
    tool("create_draft", "Create an Outlook draft; does not send it. Approval required.", false, { to: { type: "array", items: string, minItems: 1, maxItems: 20 }, subject: string, body: text }, ["to", "subject", "body"], a => ({ url: `${graph}/me/messages`, method: "POST", body: { subject: a.subject, body: { contentType: "Text", content: a.body }, toRecipients: (a.to as string[]).map(address => ({ emailAddress: { address } })) } })),
    tool("send_draft", "Send an existing Outlook draft to its recipients. Explicit approval required. Never retry after an unknown outcome.", false, { messageId: string }, ["messageId"], a => ({ url: `${graph}/me/messages/${part(a.messageId)}/send`, method: "POST" }))
  ],
  "outlook-calendar": [
    tool("list_events", "Read Outlook calendar events in a time range, including recurring occurrences. Supply ISO 8601 start/end with timezone offset. Skip paginates 100 results.", true, { start: string, end: string, skip: { type: "integer", minimum: 0, maximum: 100_000 } }, ["start", "end"], a => ({ url: url(`${graph}/me/calendarView`, { startDateTime: a.start, endDateTime: a.end, $top: 100, $skip: a.skip }) })),
    tool("create_event", "Create an Outlook calendar event. Start/end are local date-time strings and timeZone is a Microsoft-supported zone (e.g. UTC). Invitations are sent to attendees; approval required.", false,
      { subject: string, start: string, end: string, timeZone: string, body: text, attendees: { type: "array", items: string, maxItems: 20 } }, ["subject", "start", "end", "timeZone"], a => ({ url: `${graph}/me/events`, method: "POST", body: { subject: a.subject,
        start: { dateTime: a.start, timeZone: a.timeZone }, end: { dateTime: a.end, timeZone: a.timeZone }, body: { contentType: "Text", content: a.body ?? "" },
        attendees: ((a.attendees ?? []) as string[]).map(address => ({ emailAddress: { address }, type: "required" })) } }))
  ],
  teams: [
    tool("list_teams", "List Microsoft Teams the connected work/school account belongs to.", true, {}, [], () => ({ url: `${graph}/me/joinedTeams` })),
    tool("list_channels", "List channels in a Microsoft Team.", true, { teamId: string }, ["teamId"], a => ({ url: `${graph}/teams/${part(a.teamId)}/channels` })),
    tool("list_messages", "Read the latest 50 messages in a Teams channel. Requires tenant-approved delegated ChannelMessage.Read.All.", true, { teamId: string, channelId: string }, ["teamId", "channelId"], a => ({ url: `${graph}/teams/${part(a.teamId)}/channels/${part(a.channelId)}/messages?$top=50` })),
    tool("send_message", "Post a plain-text message in a Teams channel as the connected user. Approval required.", false, { teamId: string, channelId: string, text }, ["teamId", "channelId", "text"], a => ({ url: `${graph}/teams/${part(a.teamId)}/channels/${part(a.channelId)}/messages`, method: "POST", body: { body: { contentType: "text", content: a.text } } }))
  ],
  dropbox: [
    tool("list_folder", "List a Dropbox folder. Use empty path for root; pass cursor to continue a previous listing.", true, { path: { type: "string", maxLength: 2000 }, cursor: string }, [], a => ({ url: `https://api.dropboxapi.com/2/files/list_folder${a.cursor ? "/continue" : ""}`, method: "POST", body: a.cursor ? { cursor: a.cursor } : { path: a.path ?? "", limit: 100 } })),
    tool("read_text_file", "Download a UTF-8 Dropbox text file (up to 128 KiB). path is the full Dropbox path or file ID. Not for binary files.", true, { path: string }, ["path"], a => ({ url: "https://content.dropboxapi.com/2/files/download", method: "POST", headers: { "Dropbox-API-Arg": headerJson({ path: a.path }) }, text: true })),
    tool("upload_text_file", "Upload a new UTF-8 Dropbox text file. Conflicts fail; existing files are never overwritten. Approval required.", false, { path: string, content: text }, ["path", "content"], a => ({ url: "https://content.dropboxapi.com/2/files/upload", method: "POST", rawBody: String(a.content), headers: { "Content-Type": "application/octet-stream", "Dropbox-API-Arg": headerJson({ path: a.path, mode: "add", autorename: false, strict_conflict: true }) } }))
  ]
};
function headerJson(value: unknown) { return JSON.stringify(value).replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`); }
async function boundedBody(response: Response, maximum: number) {
  const reader = response.body?.getReader(); if (!reader) return "";
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length;
      if (size > maximum) throw new PluginError("Response is too large. Narrow the query or select a smaller file."); chunks.push(value); }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally { await reader.cancel().catch(() => {}); }
}
export async function serviceRequest(pluginId: string, token: string, request: ReturnType<NativeTool["request"]>, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(request.url, { method: request.method ?? "GET", redirect: "error", signal,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(request.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(pluginId === "github" ? { "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Local-Cognitive" } : {}), ...request.headers },
    body: request.rawBody ?? (request.body !== undefined ? JSON.stringify(request.body) : undefined) });
  if (!response.ok) {
    await response.body?.cancel();
    const Failure = response.status >= 400 && response.status < 500 && response.status !== 408 ? PluginInvocationError : PluginError;
    throw new Failure(response.status === 401 ? "Authorization expired. Reconnect this account." : response.status === 403 ? "The service denied access. Check account permissions and administrator consent." : `Service returned HTTP ${response.status}. Nothing was retried.`, response.status === 401 ? 401 : 502);
  }
  const content = await boundedBody(response, request.text ? 128 * 1024 : 2 * 1024 * 1024);
  if (request.text) { if (content.includes("\0")) throw new PluginError("This is not a supported UTF-8 text file."); return { text: content }; }
  const json = content ? JSON.parse(content) : { accepted: true };
  if (pluginId === "slack" && json.ok === false) {
    const unauthorized = ["invalid_auth", "token_revoked", "token_expired", "not_authed", "account_inactive"].includes(json.error);
    const rejected = unauthorized || ["missing_scope", "channel_not_found", "not_in_channel", "invalid_arguments", "invalid_arg_name", "is_archived", "no_text", "msg_too_long", "ratelimited"].includes(json.error);
    throw new (rejected ? PluginInvocationError : PluginError)("Slack rejected the request. Check the user scopes, channel access and workspace policy.", unauthorized ? 401 : 502);
  }
  return json;
}
export async function nativeAccount(pluginId: string, token: string, signal: AbortSignal): Promise<string> {
  const request = pluginId === "github" ? { url: "https://api.github.com/user" }
    : pluginId === "slack" ? { url: "https://slack.com/api/auth.test", method: "POST" }
    : pluginId === "google-drive" ? { url: "https://www.googleapis.com/drive/v3/about?fields=user" }
    : pluginId === "dropbox" ? { url: "https://api.dropboxapi.com/2/users/get_current_account", method: "POST", rawBody: "null", headers: { "Content-Type": "application/json" } }
    : { url: `${graph}/me?$select=displayName,mail,userPrincipalName` };
  const result = await serviceRequest(pluginId, token, request, signal) as Record<string, any>;
  return String(result.login ?? result.email ?? result.user?.emailAddress ?? (typeof result.user === "string" ? `${result.user} · ${result.team ?? "Slack"}` : undefined) ?? result.mail ?? result.userPrincipalName ?? result.displayName ?? "Connected account").slice(0, 500);
}
export async function callNative(pluginId: string, name: string, args: Arguments, token: string, signal: AbortSignal): Promise<CallToolResult> {
  const operation = nativeTools[pluginId]?.find(item => item.definition.name === name);
  if (!operation) throw new PluginError("Tool is not supported by this integration.");
  const result = await serviceRequest(pluginId, token, operation.request(args), signal);
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}
