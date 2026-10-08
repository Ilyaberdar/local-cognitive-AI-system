import { readFileSync } from "node:fs";
import { z } from "zod";

const databaseUrl = z.url({ protocol: /^postgres(ql)?$/ });
const issuer = z.url({ protocol: /^https$/ }).transform((value) => (value.endsWith("/") ? value : `${value}/`));

const databaseSchema = z.object({ DATABASE_URL: databaseUrl });
const schema = databaseSchema.extend({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  AUTH0_ISSUER: issuer,
  AUTH0_AUDIENCE: z.string().min(1),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  // Hosts sign relay challenges for this origin; it must be the URL they connect to.
  PUBLIC_ORIGIN: z.url({ protocol: /^https?$/ }).transform((value) => new URL(value).origin).default("https://api.local-cognitive.com"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info")
});

export type CloudConfig = z.infer<typeof schema>;
export type DatabaseConfig = z.infer<typeof databaseSchema>;

/** Secrets may be mounted as files (DATABASE_URL_FILE) instead of plain variables. */
const withFileSecrets = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const file = env.DATABASE_URL_FILE;
  if (!file || env.DATABASE_URL) return env;
  return { ...env, DATABASE_URL: readFileSync(file, "utf8").trim() };
};

const parse = <T extends z.ZodType>(target: T, env: NodeJS.ProcessEnv): z.infer<T> => {
  const result = target.safeParse(withFileSecrets(env));
  if (!result.success) throw new Error(`Invalid cloud configuration:\n${z.prettifyError(result.error)}`);
  return result.data;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): CloudConfig => parse(schema, env);

/** Migrations need only the database, not the Auth0 settings of the API. */
export const loadDatabaseConfig = (env: NodeJS.ProcessEnv = process.env): DatabaseConfig => parse(databaseSchema, env);
