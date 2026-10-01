import { CatalogPlugin, PluginError } from "./contracts";

// Release-owned metadata. Tools and OAuth consent are discovered from the provider,
// never inferred from this marketing copy. No remote executable packages are loaded.
export const pluginCatalog: readonly CatalogPlugin[] = [
  { id: "notion", name: "Notion", description: "Search your workspace and create or update pages.", category: "Knowledge", toolkit: "notion", documentation: "https://developers.notion.com/guides/mcp/build-mcp-client", privacy: "https://www.notion.so/privacy", color: "#9b9b9b", initials: "N", mcpEndpoint: "https://mcp.notion.com/mcp" },
  { id: "github", name: "GitHub", description: "Browse repositories, search issues and pull requests, and create issues.", category: "Development", toolkit: "github", documentation: "https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps", privacy: "https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement", color: "#aab4c4", initials: "GH" },
  { id: "slack", name: "Slack", description: "Find team conversations and send approved messages.", category: "Communication", toolkit: "slack", documentation: "https://docs.slack.dev/", privacy: "https://slack.com/trust/privacy/privacy-policy", color: "#c68bc8", initials: "S" },
  { id: "google-drive", name: "Google Drive", description: "Search, read and manage your shared files.", category: "Files", toolkit: "googledrive", documentation: "https://developers.google.com/drive/api/guides/about-sdk", privacy: "https://policies.google.com/privacy", color: "#7bc8a4", initials: "G" },
  { id: "linear", name: "Linear", description: "Find issues and manage projects and team work.", category: "Development", toolkit: "linear", documentation: "https://linear.app/docs/mcp", privacy: "https://linear.app/privacy", color: "#9a98ef", initials: "L", mcpEndpoint: "https://mcp.linear.app/mcp" },
  { id: "jira", name: "Jira / Atlassian", description: "Search issues and work with Atlassian Rovo's available tools.", category: "Development", toolkit: "jira", documentation: "https://developer.atlassian.com/cloud/rovo-mcp/guides/getting-started/", privacy: "https://www.atlassian.com/legal/privacy-policy", color: "#7ba8ed", initials: "J", mcpEndpoint: "https://mcp.atlassian.com/v2/mcp" },
  { id: "outlook-email", name: "Outlook Email", description: "Read mail, prepare drafts and send approved replies.", category: "Communication", toolkit: "outlook", documentation: "https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview", privacy: "https://privacy.microsoft.com/privacystatement", color: "#71b6ee", initials: "O" },
  { id: "outlook-calendar", name: "Outlook Calendar", description: "Check your schedule and manage calendar events.", category: "Productivity", toolkit: "outlook", documentation: "https://learn.microsoft.com/en-us/graph/api/resources/calendar", privacy: "https://privacy.microsoft.com/privacystatement", color: "#83cbe4", initials: "OC" },
  { id: "teams", name: "Microsoft Teams", description: "Read team channels and send approved messages.", category: "Communication", toolkit: "microsoft_teams", documentation: "https://learn.microsoft.com/en-us/graph/teams-concept-overview", privacy: "https://privacy.microsoft.com/privacystatement", color: "#a3a1e8", initials: "T" },
  { id: "dropbox", name: "Dropbox", description: "Find, read and manage files in your Dropbox.", category: "Files", toolkit: "dropbox", documentation: "https://www.dropbox.com/developers/documentation/http/documentation", privacy: "https://www.dropbox.com/privacy", color: "#7aa5f6", initials: "D" }
].map(plugin => ({ ...plugin, version: "1.0.0" }));

export function catalogEntry(id: string): CatalogPlugin {
  const plugin = pluginCatalog.find(item => item.id === id);
  if (!plugin) throw new PluginError("Plugin was not found in the application catalog.", 404);
  return plugin;
}
