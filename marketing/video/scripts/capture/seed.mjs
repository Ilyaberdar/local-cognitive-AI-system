// Puts already installed models into a recording profile without copying them: each GGUF becomes
// an APFS clone (`cp -c`, shares the owner's blocks, takes no space) and only the chosen records are
// written to the profile's library. Nothing in the owner's data folder is changed. Importing through
// the app would copy 15 GB and hash it twice; the app accepts a library entry whose file has the
// recorded size and is not a symlink (src/local/ModelLibraryStore.ts).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ownerData = path.join(os.homedir(), "Library", "Application Support", "Local Cognitive");

export const models = {
  qwen27b: "gguf-85b63afe4b46b873469f398c", // Qwen3.8-27B-GGUF, UD-Q4_K_M, 15.3 GiB
  bonsai27b: "gguf-4c0139a20d027bbd29e2d595", // Bonsai-27B-GGUF, Q1_0 (1-bit), 3.5 GiB + vision projector
};

// Models that are not in the owner's Local Cognitive library but in LM Studio's folder: the record is
// built here the way an import would describe the file (sha256 of the file, GGUF metadata read by
// the app itself on first start because there is no inspectionVersion).
const external = {
  "lmstudio-qwen35-9b-q8": {
    file: path.join(os.homedir(), ".lmstudio", "models", "lmstudio-community", "Qwen3.5-9B-GGUF", "Qwen3.5-9B-Q8_0.gguf"),
    displayName: "Qwen3.5-9B-GGUF",
    repoId: "lmstudio-community/Qwen3.5-9B-GGUF",
    quantization: "Q8_0",
    license: "apache-2.0",
  },
};
models.qwen35_9b = "lmstudio-qwen35-9b-q8";

function externalRecord(id) {
  const source = external[id];
  const sizeBytes = fs.statSync(source.file).size;
  const sha256 = execFileSync("shasum", ["-a", "256", source.file]).toString().split(" ")[0];
  return {
    record: {
      id, libraryId: id, displayName: source.displayName, providerId: "llamacpp", providerName: "Local models",
      repoId: source.repoId, variantId: path.basename(source.file), quantization: source.quantization, license: source.license,
      sizeBytes, installedAt: new Date().toISOString(), owned: true, vision: false,
      files: [{ path: path.basename(source.file), sizeBytes, sha256 }],
      loaded: false, loadedInstanceIds: [], state: "unloaded", busy: false,
    },
    sourceDir: path.dirname(source.file),
  };
}

export function seedModels(profileDir, ids) {
  const library = JSON.parse(fs.readFileSync(path.join(ownerData, "app", "local-models", "library.json"), "utf8"));
  const items = [];
  for (const id of ids) {
    const fromLmStudio = external[id] ? externalRecord(id) : null;
    const record = fromLmStudio?.record ?? library.items.find(item => item.id === id);
    if (!record) throw new Error(`model ${id} is not in the owner's library`);
    const sourceDir = fromLmStudio?.sourceDir ?? path.join(ownerData, "models", id);
    const target = path.join(profileDir, "models", id);
    fs.mkdirSync(target, { recursive: true });
    for (const file of [...record.files, ...(record.projector ? [record.projector] : [])]) {
      const source = path.join(sourceDir, file.path);
      const destination = path.join(target, file.path);
      if (fs.existsSync(destination) && fs.statSync(destination).size === file.sizeBytes) continue;
      execFileSync("cp", ["-c", source, destination]);
      if (fs.statSync(destination).size !== file.sizeBytes) throw new Error(`clone of ${file.path} has the wrong size`);
    }
    items.push({ ...record, loaded: false, loadedInstanceIds: [], state: "unloaded", busy: false });
  }
  const libraryDir = path.join(profileDir, "app", "local-models");
  fs.mkdirSync(libraryDir, { recursive: true });
  fs.writeFileSync(path.join(libraryDir, "library.json"), `${JSON.stringify({ version: 1, items }, null, 2)}\n`);
  return items.map(item => ({ id: item.id, displayName: item.displayName }));
}
