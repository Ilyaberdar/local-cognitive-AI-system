import { loadDatabaseConfig } from "../config.js";
import { createLogger } from "../log.js";
import { MIGRATIONS_DIR } from "../paths.js";
import { migrate } from "./migrate.js";
import { createPool } from "./pool.js";

const logger = createLogger();
const pool = createPool(loadDatabaseConfig().DATABASE_URL, logger);
try {
  const applied = await migrate(pool, MIGRATIONS_DIR);
  logger.info(applied.length ? "Migrations applied" : "Database is up to date", { applied });
} catch (error) {
  logger.error("Migration failed", { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await pool.end();
}
