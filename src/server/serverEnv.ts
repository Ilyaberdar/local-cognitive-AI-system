import path from "path";
import { dataDirectories, ServerConfig } from "./dataRoot";
import type { ServerArgs } from "./args";
import type { InferenceSelection } from "./inference";

/** Environment of the server process. Every directory is derived from the data root, so the
 * data-root lock covers all of them, and nothing is read from the working directory. */
export const serverEnvironment = (input: { root: string; config: ServerConfig; args: ServerArgs; release: string; inference: InferenceSelection; base: NodeJS.ProcessEnv }) => {
  const directories = dataDirectories(input.root);
  const http = input.args.http ?? input.config.http.enabled;
  const derived: Record<string, string> = {
    APP_DATA_DIR: directories.app, MEMORY_DIR: directories.memory, SESSION_DIR: directories.sessions, OUTPUT_DIR: directories.output,
    LOCAL_MODELS_DIR: directories.models, OPENMEMORY_DB_PATH: path.join(directories.memory, "openmemory.db"),
    PLUGINS_DIR: path.join(input.release, "plugins"), UI_PUBLIC_DIR: path.join(input.release, "public"),
    LOCAL_MODEL_CATALOG_PATH: path.join(input.release, "resources", "models", "recommended.json"),
    HTTP_ENABLED: String(http), HOST: "127.0.0.1", PORT: String(input.args.httpPort ?? input.config.http.port), UI_SERVE: "false",
    LLAMA_RUNTIME_DIR: input.inference.runtimeDir, LOCAL_INFERENCE: input.inference.preference, LOCAL_INFERENCE_FALLBACK: input.inference.fallbackReason ?? "",
    // PTX for older GPUs is compiled on first load; the cache must be writable under systemd.
    CUDA_CACHE_PATH: path.join(directories.app, "runtime", "cuda-cache")
  };
  const env: NodeJS.ProcessEnv = { ...input.base };
  const overridden = Object.keys(derived).filter(name => input.base[name] !== undefined && input.base[name] !== derived[name]);
  Object.assign(env, derived);
  env.LOCAL_COGNITIVE_CONFIG = input.base.LOCAL_COGNITIVE_CONFIG || path.join(input.root, "local-cognitive.config.json");
  env.LOCAL_COGNITIVE_ENV_FILE = input.args.envFile ? path.resolve(input.args.envFile) : input.base.LOCAL_COGNITIVE_ENV_FILE || "none";
  env.NODE_ENV = input.base.NODE_ENV || "production";
  return { env, overridden };
};
