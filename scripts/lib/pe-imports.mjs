// The DLLs a Windows program needs, read from its PE headers (imports and delay-loaded imports). It
// checks on any machine that a Windows runtime folder brings everything that Windows itself and the
// GPU driver do not provide.
import fs from 'node:fs/promises';
import path from 'node:path';

/** DLL names a PE file imports, lowercased. */
export async function peImports(file) {
  const data = await fs.readFile(file);
  const fail = () => { throw new Error(`${file} is not a PE file`); };
  if (data.length < 64 || data.readUInt16LE(0) !== 0x5a4d) fail();
  const pe = data.readUInt32LE(0x3c);
  if (pe + 24 > data.length || data.readUInt32LE(pe) !== 0x4550) fail();
  const sections = data.readUInt16LE(pe + 6), optional = pe + 24, sectionTable = optional + data.readUInt16LE(pe + 20);
  const plus = data.readUInt16LE(optional) === 0x20b;
  const directoryCount = data.readUInt32LE(optional + (plus ? 108 : 92)), directories = optional + (plus ? 112 : 96);
  const offsetOf = (rva) => {
    for (let index = 0; index < sections; index++) {
      const header = sectionTable + index * 40;
      const start = data.readUInt32LE(header + 12), size = Math.max(data.readUInt32LE(header + 8), data.readUInt32LE(header + 16));
      if (rva >= start && rva < start + size) return rva - start + data.readUInt32LE(header + 20);
    }
    return undefined;
  };
  const imports = new Set();
  // Import descriptors (20 bytes, name RVA at 12) and delay-load descriptors (32 bytes, name RVA at 4)
  // each end with an empty entry.
  for (const [index, size, nameAt] of [[1, 20, 12], [13, 32, 4]]) {
    if (index >= directoryCount) continue;
    const rva = data.readUInt32LE(directories + index * 8);
    let offset = rva ? offsetOf(rva) : undefined;
    for (; offset !== undefined && offset + size <= data.length; offset += size) {
      const nameRva = data.readUInt32LE(offset + nameAt);
      if (!nameRva) break;
      const start = offsetOf(nameRva);
      if (start === undefined) fail();
      imports.add(data.toString('latin1', start, data.indexOf(0, start)).toLowerCase());
    }
  }
  return [...imports];
}

// Always on Windows 10 and 11.
const SYSTEM = new Set(['kernel32.dll', 'kernelbase.dll', 'ntdll.dll', 'user32.dll', 'gdi32.dll', 'advapi32.dll', 'shell32.dll', 'shlwapi.dll', 'ole32.dll', 'oleaut32.dll',
  'ws2_32.dll', 'wsock32.dll', 'mswsock.dll', 'crypt32.dll', 'bcrypt.dll', 'ncrypt.dll', 'secur32.dll', 'psapi.dll', 'dbghelp.dll', 'version.dll', 'winmm.dll',
  'iphlpapi.dll', 'userenv.dll', 'setupapi.dll', 'cfgmgr32.dll', 'dxgi.dll', 'd3d11.dll', 'd3d12.dll', 'dwmapi.dll', 'comctl32.dll', 'comdlg32.dll', 'imm32.dll',
  'winhttp.dll', 'wininet.dll', 'powrprof.dll', 'ucrtbase.dll', 'msvcrt.dll', 'rpcrt4.dll', 'normaliz.dll', 'wldap32.dll']);
// From the GPU driver: a copy in the runtime folder would hide the real one.
export const DRIVER_DLLS = new Set(['nvcuda.dll', 'vulkan-1.dll', 'nvml.dll', 'opencl.dll']);
const provided = (name) => SYSTEM.has(name) || DRIVER_DLLS.has(name) || /^(api|ext)-ms-win-/.test(name);

/** Imports of the folder's programs that neither the folder, Windows nor the GPU driver provide. */
export async function missingImports(directory) {
  const names = await fs.readdir(directory);
  const present = new Set(names.map(name => name.toLowerCase()));
  const missing = new Map();
  for (const name of names.filter(name => /\.(exe|dll)$/i.test(name))) {
    for (const library of await peImports(path.join(directory, name))) {
      if (!present.has(library) && !provided(library)) missing.set(library, [...(missing.get(library) ?? []), name]);
    }
  }
  return missing;
}
