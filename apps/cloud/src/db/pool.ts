import pg from "pg";
import type { Logger } from "../log.js";

export const createPool = (connectionString: string, logger?: Logger): pg.Pool => {
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000,
    application_name: "lc-cloud" });
  // An idle client can fail (database restart); without a listener this would crash the process.
  pool.on("error", (error) => logger?.warn("Idle database client error", { code: (error as { code?: string }).code }));
  return pool;
};
