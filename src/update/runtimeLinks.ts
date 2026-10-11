import fs from "fs";
import path from "path";

/** What repairRuntimeLinks did: links it pointed back into the folder, and links it could not fix. */
export interface RuntimeLinkRepair {
  relinked: string[];
  broken: string[];
}

/** A link that a llama.cpp runtime folder should hold: relative, to a name in the same folder, and
 * resolving there. Upstream builds ship such chains (libllama.so → libllama.so.0 → libllama.so.0.4.0). */
const isLocalLink = (directory: string, target: string) =>
  !target.includes("/") && !target.includes(path.sep) && fs.existsSync(path.join(directory, target));

/** Points every library link in a runtime folder back at the file of the same name in that folder.
 * Updates used to copy the CUDA runtime with fs.cpSync, which writes a link's target as an absolute
 * path into the release it came from; once that release was pruned, llama-server could not load its
 * libraries. A link is rewritten only to a regular file that sits beside it; nothing outside the
 * folder is followed or changed, and links with no such file are reported, not touched. */
export const repairRuntimeLinks = (directory: string): RuntimeLinkRepair => {
  const relinked: string[] = [], broken: string[] = [];
  for (const name of fs.readdirSync(directory)) {
    const link = path.join(directory, name);
    if (!fs.lstatSync(link).isSymbolicLink()) continue;
    const target = fs.readlinkSync(link);
    if (isLocalLink(directory, target)) continue;
    const local = path.basename(target), candidate = path.join(directory, local);
    if (local === name || !fs.existsSync(candidate) || !fs.lstatSync(candidate).isFile()) { broken.push(name); continue; }
    const temporary = path.join(directory, `.${name}.relink-${process.pid}`);
    fs.rmSync(temporary, { force: true });
    fs.symlinkSync(local, temporary);
    fs.renameSync(temporary, link);
    relinked.push(name);
  }
  return { relinked, broken };
};

/** Names of links in a runtime folder that point nowhere (for the server's choice of runtime). */
export const danglingRuntimeLinks = (directory: string): string[] => {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => {
    const link = path.join(directory, name);
    return fs.lstatSync(link).isSymbolicLink() && !fs.existsSync(link);
  });
};
