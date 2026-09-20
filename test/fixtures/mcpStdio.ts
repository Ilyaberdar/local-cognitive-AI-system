import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpFixtureServer } from "./mcpServer";

const { server } = createMcpFixtureServer({ account: process.env.FIXTURE_ACCOUNT, onCrash: () => process.exit(7) });
const close = () => { void server.close(); };
process.stdin.once("end", close);
process.once("SIGTERM", close);
process.once("SIGINT", close);
void server.connect(new StdioServerTransport()).catch(() => process.exit(1));
