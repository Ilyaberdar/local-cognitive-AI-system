import http from "node:http";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { createLogger } from "./log.js";
import { Relay } from "./remote/relay.js";
import { createRemoteRepository } from "./remote/remoteRepository.js";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const pool = createPool(config.DATABASE_URL, logger);
const repo = createRemoteRepository(pool);
const relay = new Relay({ repo, origin: config.PUBLIC_ORIGIN, logger });
const app = createApp({ pool, auth: { issuer: config.AUTH0_ISSUER, audience: config.AUTH0_AUDIENCE }, trustProxy: config.TRUST_PROXY, logger, remote: { repo, relay } });
// A plain HTTP server so the relay can attach WebSocket upgrades to the same listener.
const server = http.createServer(app);
server.on("upgrade", relay.handleUpgrade);

server.listen(config.PORT, config.HOST, () => logger.info("Cloud API listening", { host: config.HOST, port: config.PORT }));

let stopping = false;
const stop = (signal: string) => {
  if (stopping) return;
  stopping = true;
  logger.info("Shutting down", { signal });
  relay.close();
  server.close(() => { void pool.end().finally(() => process.exit(0)); });
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.once("SIGTERM", () => stop("SIGTERM"));
process.once("SIGINT", () => stop("SIGINT"));
