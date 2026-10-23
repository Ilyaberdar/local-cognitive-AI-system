// LcSandbox.exe — the Windows sandbox helper for Local Cognitive's Synthesis.
//
// It runs one command (a contract-test runner, or an agent's terminal tool) isolated from everything
// else on the computer: inside a regular AppContainer with no capabilities of its own, so loopback, the
// LAN, the internet and DNS are all refused; with read and write only inside the run's work folder
// (granted to a per-run capability and labelled low integrity) and read-only in the folders it is told;
// held in a kill-on-close Job object with UI restrictions, so whatever the command starts dies when the
// command ends or when this helper is killed (a run's timeout). It is the Windows counterpart of
// sandbox-exec on macOS and bubblewrap on Linux.
//
// It builds with the .NET Framework's own compiler (no Visual C++ toolchain), so C# 5 only:
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:exe /optimize+ /platform:x64 /unsafe
//
// Commands (see Usage()). exec and the probe/write/remove/empty built-ins set up the same container;
// grant-tools and uninstall change nothing about a run. It opens no network and loads only system DLLs.

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class LcSandbox
{
    // Every sandbox profile this app makes is named with this prefix; app start and uninstall remove only
    // these. A profile of its own per work folder (name LocalCognitive.Sandbox.<id>, passed in with
    // --profile) keeps two runs out of each other's package folder and named-object namespace.
    private const string ProfilePrefix = "LocalCognitive.Sandbox";
    // The stable capability the shipped Node runtime and this helper are granted read+execute, so the
    // container can run them (they are the app's own files, not secret, so a fixed name is fine). grant-tools
    // sets it once; a per-work-folder capability grants that folder.
    private const string ToolsCapability = "LocalCognitive.SandboxTools";

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 0) { Usage(); return 2; }
            string command = args[0];
            switch (command)
            {
                case "exec": return Exec(args);
                case "probe": return Builtin(args, "__probe");
                case "write": return Builtin(args, "__write");
                case "remove": return Builtin(args, "__remove");
                case "empty": return Empty(args);
                case "grant-tools": return GrantTools(args);
                case "clean-stale": return CleanStale();
                case "uninstall": return Uninstall();
                // Internal commands: this helper, re-launched inside the container, running as the
                // AppContainer token. Never invoked from outside.
                case "__probe": return InnerProbe(args);
                case "__write": return InnerWrite(args);
                case "__remove": return InnerRemove(args);
                case "__empty": return InnerEmpty(args);
#if LC_SANDBOX_TEST
                // Compiled only into a test build (csc /define:LC_SANDBOX_TEST): run the handle-based
                // package-folder walk alone on a folder, so a live check can prove the walk itself deletes.
                // The release build from prepare-sandbox-helper.mjs leaves this out, so it is not a command.
                case "__walk": if (Environment.GetEnvironmentVariable("LC_SANDBOX_TEST") == "1" && args.Length > 1) { Native.DeleteTreeContents(args[1]); return 0; } Usage(); return 2;
#endif
                default: Usage(); return 2;
            }
        }
        catch (SandboxError error)
        {
            Console.Error.WriteLine("lc-sandbox: " + error.Message);
            return 3;
        }
        catch (Exception error)
        {
            Win32Exception win32 = error as Win32Exception;
            Console.Error.WriteLine("lc-sandbox: " + error.GetType().Name + ": " + error.Message + (win32 != null ? " (error " + win32.NativeErrorCode + ")" : ""));
            return 3;
        }
    }

    private static void Usage()
    {
        Console.Error.WriteLine(
            "lc-sandbox commands:\n" +
            "  exec    --profile NAME --run-cap NAME --roots DIRS --rw DIR [--granted] [--ro DIR]... [--cpu SECONDS] -- EXE ARGS...\n" +
            "  probe   --profile NAME --run-cap NAME --roots DIRS --rw DIR [--granted] [--ro DIR]... -- CANARY WRITTEN PORT\n" +
            "  write   --profile NAME --run-cap NAME --roots DIRS --rw DIR [--granted] -- REL   (stdin is written to <rw>\\REL)\n" +
            "  remove  --profile NAME --run-cap NAME --roots DIRS --rw DIR [--granted] -- REL\n" +
            "  empty   --profile NAME --run-cap NAME --roots DIRS --rw DIR [--granted]  (last command of a folder; deletes the profile)\n" +
            "  grant-tools DIR                                             (one time, at install; only the helper's own folder)\n" +
            "  clean-stale                                                 (app start: removes LocalCognitive.Sandbox* profiles whose owner is gone)\n" +
            "  uninstall                                                   (removes every LocalCognitive.Sandbox* profile)");
    }

    // ---- Option parsing -------------------------------------------------------------------------

    private sealed class SandboxError : Exception
    {
        public SandboxError(string message) : base(message) { }
    }

    private sealed class Options
    {
        public string Profile;        // the per-work-folder AppContainer profile name (LocalCognitive.Sandbox.<id>)
        public string RunCap;         // the per-run capability name (grants the work folder); may be null
        public string Rw;             // the work folder, read-write
        public bool Granted;          // the work folder already carries the run's grant (set before any code ran)
        public readonly List<string> Ro = new List<string>();   // folders granted read-only
        public readonly List<string> Roots = new List<string>(); // the app's work roots: Rw must be inside one
        public int Cpu;               // a per-process CPU-seconds limit, 0 for none
        public readonly List<string> Rest = new List<string>(); // after "--"
    }

    private static Options Parse(string[] args, int from)
    {
        Options options = new Options();
        int i = from;
        bool afterDashDash = false;
        for (; i < args.Length; i++)
        {
            string arg = args[i];
            if (afterDashDash) { options.Rest.Add(arg); continue; }
            switch (arg)
            {
                case "--": afterDashDash = true; break;
                case "--profile": options.Profile = Next(args, ref i); break;
                case "--run-cap": options.RunCap = Next(args, ref i); break;
                case "--rw": options.Rw = Next(args, ref i); break;
                case "--granted": options.Granted = true; break;
                case "--ro": options.Ro.Add(Next(args, ref i)); break;
                case "--cpu": options.Cpu = int.Parse(Next(args, ref i), CultureInfo.InvariantCulture); break;
                case "--roots":
                    foreach (string part in Next(args, ref i).Split(';'))
                        if (part.Length > 0) options.Roots.Add(part);
                    break;
                default: throw new SandboxError("unknown option " + arg);
            }
        }
        return options;
    }

    private static string Next(string[] args, ref int i)
    {
        if (i + 1 >= args.Length) throw new SandboxError("option " + args[i] + " needs a value");
        return args[++i];
    }

    // Whether a full path is strictly inside one of the app's declared work roots (never equal to one):
    // a run folder is always a child, so --rw = %TEMP% or the data root, which would grant and low-label a
    // whole tree, is refused. The helper changes an ACL only inside these.
    private static bool WithinRoots(string full, List<string> roots)
    {
        string path = full.TrimEnd('\\');
        foreach (string root in roots)
        {
            string r = Path.GetFullPath(root).TrimEnd('\\');
            if (path.StartsWith(r + "\\", StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    // The per-work-folder profile name, tied to this run: it must be exactly
    // "LocalCognitive.Sandbox." + the run capability's id, so a run can only ever create or delete its own
    // container, never the bare prefix or another run's profile.
    private static string RequireProfile(Options options)
    {
        string cap = RequireRunCap(options);
        string expected = ProfilePrefix + "." + cap.Substring("LocalCognitive.Run.".Length);
        if (options.Profile != expected) throw new SandboxError("--profile must be " + expected + " for this --run-cap");
        return options.Profile;
    }

    // The per-run capability name; the folder's grant and its profile both derive from its id, which must
    // be exactly 16 lowercase hex characters (every command enforces this, not only empty).
    private static string RequireRunCap(Options options)
    {
        const string prefix = "LocalCognitive.Run.";
        if (string.IsNullOrEmpty(options.RunCap) || !options.RunCap.StartsWith(prefix, StringComparison.Ordinal))
            throw new SandboxError("--run-cap LocalCognitive.Run.<id> is required");
        string id = options.RunCap.Substring(prefix.Length);
        if (id.Length != 16 || !IsLowerHex(id)) throw new SandboxError("the run capability id must be 16 lowercase hex characters: " + id);
        return options.RunCap;
    }

    // The work folder must be an absolute path strictly inside one of the app's declared roots; a
    // read-only folder must be an absolute, existing directory that is not a drive root, the Windows folder
    // or a profile root. Both guard against a work/tool path the helper was handed by mistake.
    private static string RequireRw(Options options)
    {
        if (options.Rw == null) throw new SandboxError("--rw is required");
        if (options.Roots.Count == 0) throw new SandboxError("--roots is required");
        string rw = Path.GetFullPath(options.Rw);
        if (!WithinRoots(rw, options.Roots)) throw new SandboxError("the work folder is not inside the app's work roots: " + rw);
        if (!Directory.Exists(rw)) throw new SandboxError("the work folder does not exist: " + rw);
        return rw;
    }

    private static List<string> ResolveReadOnly(Options options)
    {
        List<string> result = new List<string>();
        foreach (string dir in options.Ro)
        {
            string full = Path.GetFullPath(dir).TrimEnd('\\');
            if (full.Length < 4 || full.IndexOf('\\') < 0) throw new SandboxError("a read-only folder must be a path, not a drive root: " + full);
            string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows).TrimEnd('\\');
            string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile).TrimEnd('\\');
            if (full.Equals(windows, StringComparison.OrdinalIgnoreCase) || full.Equals(profile, StringComparison.OrdinalIgnoreCase))
                throw new SandboxError("a read-only folder may not be the Windows or profile root: " + full);
            if (Directory.Exists(full) && !result.Contains(full)) result.Add(full);
        }
        return result;
    }

    // ---- exec and the built-ins ----------------------------------------------------------------

    private static int Exec(string[] args)
    {
        Options options = Parse(args, 1);
        if (options.Rest.Count == 0) throw new SandboxError("exec needs -- EXE ARGS...");
        string exe = Path.GetFullPath(options.Rest[0]);
        string ext = Path.GetExtension(exe).ToLowerInvariant();
        if (ext == ".bat" || ext == ".cmd") throw new SandboxError("a .bat or .cmd target is refused; name the interpreter instead");
        if (!File.Exists(exe)) throw new SandboxError("the program does not exist: " + exe);
        return Run(options, exe, options.Rest.GetRange(1, options.Rest.Count - 1));
    }

    // A built-in runs this same helper inside the container with an internal command, so the operation
    // (reading a file, writing one, emptying the folder) happens as the AppContainer token, never ours.
    private static int Builtin(string[] args, string inner)
    {
        Options options = Parse(args, 1);
        string self = GetExecutablePath();
        List<string> innerArgs = new List<string>();
        innerArgs.Add(inner);
        if (inner == "__empty") innerArgs.Add(RequireRw(options));
        else innerArgs.AddRange(options.Rest);
        return Run(options, self, innerArgs);
    }

    // The folder's last command: empty the work folder inside the container, then empty the run's real
    // package folder by handle and delete the profile. The profile outlives a single command but not the
    // folder.
    private static int Empty(string[] args)
    {
        Options options = Parse(args, 1);
        string profile = RequireProfile(options);
        string self = GetExecutablePath();
        int code = Run(options, self, new List<string> { "__empty", RequireRw(options) });
        DeleteProfileSafely(profile, Native.ContainerSid(profile));
        return code;
    }

    // Empties a profile's real package folder with the handle-based, reparse-safe walk, then deletes the
    // profile. The package folder comes from the container SID (GetAppContainerFolderPath returns
    // …\Packages\<moniker>\AC); its parent, the <moniker> folder, is what is emptied, and only when the
    // shape is exactly Packages\<moniker>\AC. If the walk cannot be done safely the profile is LEFT in
    // place (a later clean-stale retries) rather than handed to userenv's own recursive delete, which
    // might follow a link. `sid` may be Zero for a profile being cleaned up (then it is derived).
    // Returns true when the profile is gone afterwards, false when it was left in place (its package
    // folder could not be emptied safely, or the delete failed).
    private static bool DeleteProfileSafely(string profile, IntPtr sid)
    {
        bool safe;
        try { safe = EmptyPackageFolder(sid == IntPtr.Zero ? Native.DeriveContainerSid(profile) : sid, profile); }
        catch (Exception error) { safe = false; Console.Error.WriteLine("lc-sandbox: could not empty the package folder of " + profile + ": " + error.Message); }
        if (!safe) { Console.Error.WriteLine("lc-sandbox: left the profile " + profile + " in place (its package folder could not be emptied safely); a later clean-stale will retry"); return false; }
        int hr;
        try { hr = Native.DeleteAppContainerProfile(profile); }
        catch (Exception error) { Console.Error.WriteLine("lc-sandbox: could not delete the profile " + profile + ": " + error.Message); return false; }
        // S_OK, or a profile that is not there (ERROR_FILE_NOT_FOUND / ERROR_NOT_FOUND): gone.
        bool gone = hr == 0 || hr == unchecked((int)0x80070002) || hr == unchecked((int)0x80070490);
        if (!gone) Console.Error.WriteLine("lc-sandbox: could not delete the profile " + profile + " (hr=0x" + hr.ToString("X8") + ")");
        return gone;
    }

    // true when the package folder is (now) safely empty or absent; false when it exists but could not be
    // walked safely (unknown shape, enumeration error, a reparse point at the top).
    private static bool EmptyPackageFolder(IntPtr sid, string profile)
    {
#if LC_SANDBOX_TEST
        // Test-only: simulate an enumeration error, to prove a failed walk leaves the profile in place.
        if (Environment.GetEnvironmentVariable("LC_SANDBOX_TEST_FAIL_WALK") == "1") throw new Exception("test-induced walk failure");
#endif
        if (sid == IntPtr.Zero) return false; // SID could not be derived: do not hand an unknown folder to the recursive delete
        string ac = Native.AppContainerFolderPath(sid);
        if (ac == null) return false; // the folder could not be located: keep the profile, a later clean-stale retries
        ac = ac.TrimEnd('\\');
        string pkg = Path.GetDirectoryName(ac);
        // The shape must be exactly …\Packages\<moniker>\AC, with <moniker> the profile name lowercased.
        if (pkg == null ||
            !string.Equals(Path.GetFileName(ac), "AC", StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(Path.GetFileName(pkg), profile.ToLowerInvariant(), StringComparison.Ordinal) ||
            !string.Equals(Path.GetFileName(Path.GetDirectoryName(pkg)), "Packages", StringComparison.OrdinalIgnoreCase))
            return false;
        if (Directory.Exists(pkg)) Native.DeleteTreeContents(pkg); // throws on an unsafe walk
        return true;
    }

    private static bool IsLowerHex(string s)
    {
        foreach (char c in s) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
        return s.Length > 0;
    }

    private static int Run(Options options, string exe, List<string> exeArgs)
    {
        string work = RequireRw(options);
        string profile = RequireProfile(options);
        string runCap = RequireRunCap(options);
        List<string> readOnly = ResolveReadOnly(options);
        // A profile (and so a container SID, a package folder and a named-object namespace) of this work
        // folder's own: another run's sandbox cannot reach this one's package folder or its named objects.
        // Always created, never only derived — the create is idempotent (already-exists derives), so a
        // command whose profile a crash or a prior "empty" removed brings it back instead of failing.
        IntPtr containerSid = Native.ContainerSid(profile);
        string containerSidString = Native.SidString(containerSid);
        IntPtr toolsCapSid = Native.CapabilitySid(ToolsCapability);
        // The folder's grant goes to a capability of its own, never the shared package SID.
        IntPtr runCapSid = Native.CapabilitySid(runCap);
        IntPtr grantee = runCapSid;

        // The work folder: read, write and delete for the run's capability, with inheritance, and a
        // low-integrity label so the low-integrity container may write what we (medium) put there. Never
        // WRITE_DAC or WRITE_OWNER: the code inside cannot change who may reach the folder. Applied once,
        // before any code runs in the folder (--granted after that): re-propagating it over a tree the
        // code has since changed is never done.
        if (!options.Granted)
        {
            Native.GrantPath(work, grantee, Native.FILE_MODIFY_NO_DAC, true);
            Native.SetLowIntegrity(work);
        }
        // Read-only folders change no ACL at all: a tool folder (an interpreter, the bundled Node) is left
        // exactly as the system or grant-tools set it. The container reads one only if it already may
        // (through the tools capability, or ALL APPLICATION PACKAGES in Program Files); a folder it cannot
        // read leaves its tool unavailable. So nothing is granted here and nothing is left to revoke — no
        // window between a grant and a revoke, and no shared folder is ever rewritten. They are still
        // validated (ResolveReadOnly) as a guard on what the helper was handed.

        // A window station and desktop of the run's own, opened to this run's container SID (the per-folder
        // profile's), so node, curl and git start; the caller's desktop refuses them.
        string userSid = Native.CurrentUserSid();
        string desktop = Native.CreateDesktop(containerSidString, userSid);

        List<IntPtr> capabilities = new List<IntPtr>();
        capabilities.Add(toolsCapSid);
        if (runCapSid != IntPtr.Zero) capabilities.Add(runCapSid);

        // The command starts where the caller stands (an agent's cwd such as src), when that is inside the
        // work folder; anywhere else, at the work folder itself.
        string cwd = Path.GetFullPath(Directory.GetCurrentDirectory()).TrimEnd('\\');
        if (!cwd.Equals(work, StringComparison.OrdinalIgnoreCase) && !cwd.StartsWith(work + "\\", StringComparison.OrdinalIgnoreCase)) cwd = work;

        try
        {
            return Native.Launch(containerSid, capabilities.ToArray(), exe, exeArgs, cwd, desktop, options.Cpu);
        }
        finally
        {
            // No per-command ACL was added (only the work folder's one grant, which the folder's deletion
            // carries away), so there is nothing to revoke. The profile is deleted by the folder's last
            // command (empty); the tools grant and the desktop handle persist.
            Native.CloseDesktop();
        }
    }

    // ---- Built-ins as they run inside the container --------------------------------------------

    private static int InnerProbe(string[] args)
    {
        // args: __probe CANARY WRITTEN PORT. Each line says what the sandboxed process could do; the
        // launcher checks that the canary's content never appears, WRITTEN was not created, and nothing
        // reached its listener.
        string canary = args.Length > 1 ? args[1] : "";
        string written = args.Length > 2 ? args[2] : "";
        int port = args.Length > 3 ? int.Parse(args[3], CultureInfo.InvariantCulture) : 0;
        Say("readCanary", TryRead(canary));
        Say("writeReadOnly", TryWrite(written));
        Say("writeWork", TryWriteWork());
        Say("loopback", TryConnect("127.0.0.1", port));
        Say("loopbackV6", TryConnect("::1", port));
        Say("internet", TryConnect("1.1.1.1", 443));
        Say("dns", TryResolve("example.com"));
        Console.Out.WriteLine("LC_PROBE_RAN");
        Console.Out.Flush();
        return 0;
    }

    // Just before the final open, re-check (fail closed) that the held parent is a real directory and that
    // no component inside the work folder on the way to the target has become a reparse point. This closes
    // the window between ResolveInside's name checks and OpenDirHold, where an in-folder ancestor could be
    // swapped for a junction. GetFinalPathNameByHandle cannot be used here (it returns nothing inside an
    // AppContainer); components above the work folder are never opened, and the OS ACL keeps the write
    // inside the folder regardless, so re-checking the in-folder chain is the practical defence.
    private static void RequireParentInsideWork(IntPtr parent, string root, string rel)
    {
        if (Native.HandleIsReparse(parent)) throw new SandboxError("the parent of " + rel + " is a reparse point");
        ResolveInside(root, rel); // throws if any in-folder ancestor is now a reparse point
    }

    private static int InnerWrite(string[] args)
    {
        if (args.Length < 2) throw new SandboxError("__write needs a relative path");
        string target = ResolveInside(Directory.GetCurrentDirectory(), args[1]);
        string dir = Path.GetDirectoryName(target);
        if (dir != null && dir.Length > 0) Directory.CreateDirectory(dir);
        // Hold the parent directory open (no share-delete) so it cannot be renamed under us, then open the
        // final component without following a link (OPEN_REPARSE_POINT) and write through that same handle.
        // A reparse point at the target is refused: writing through a link the code planted would write
        // outside the folder.
        IntPtr parent = Native.OpenDirHold(dir != null && dir.Length > 0 ? dir : Directory.GetCurrentDirectory());
        try
        {
            RequireParentInsideWork(parent, Directory.GetCurrentDirectory(), args[1]);
            // Refuse an existing reparse point at the target up front (fail closed); the post-open check
            // below is the backstop if one is swapped in during the open.
            if (Native.IsReparsePoint(target)) throw new SandboxError("the target " + args[1] + " is a reparse point");
            IntPtr handle = Native.OpenFinalForWrite(target);
            try
            {
                if (Native.HandleIsReparse(handle)) throw new SandboxError("the target " + args[1] + " is a reparse point");
                using (Stream input = Console.OpenStandardInput())
                using (FileStream output = Native.StreamForWrite(handle))
                {
                    byte[] buffer = new byte[65536];
                    int read;
                    while ((read = input.Read(buffer, 0, buffer.Length)) > 0) output.Write(buffer, 0, read);
                }
            }
            finally { Native.CloseRaw(handle); }
        }
        finally { Native.CloseRaw(parent); }
        return 0;
    }

    private static int InnerRemove(string[] args)
    {
        if (args.Length < 2) throw new SandboxError("__remove needs a relative path");
        string target = ResolveInside(Directory.GetCurrentDirectory(), args[1]);
        string dir = Path.GetDirectoryName(target);
        IntPtr parent = Native.OpenDirHold(dir != null && dir.Length > 0 ? dir : Directory.GetCurrentDirectory());
        try
        {
            RequireParentInsideWork(parent, Directory.GetCurrentDirectory(), args[1]);
            // The final component may be a reparse point here — removing unlinks the link itself (opened
            // with OPEN_REPARSE_POINT), never its target — and is deleted through its own handle.
            IntPtr handle = Native.OpenFinalForRemove(target);
            if (handle == (IntPtr)(-1)) return 0; // already gone
            try { Native.Delete(handle); }
            finally { Native.CloseRaw(handle); }
        }
        finally { Native.CloseRaw(parent); }
        return 0;
    }

    private static int InnerEmpty(string[] args)
    {
        string root = args.Length > 1 ? args[1] : Directory.GetCurrentDirectory();
        EmptyFolder(root);
        return 0;
    }

    // Removes everything under the folder without ever following a reparse point (a junction or symlink
    // the sandboxed code may have planted leads nowhere but itself): such an entry is unlinked, not
    // descended into.
    private static void EmptyFolder(string root)
    {
        DirectoryInfo directory = new DirectoryInfo(root);
        if (!directory.Exists) return;
        foreach (FileSystemInfo entry in directory.GetFileSystemInfos())
        {
            bool reparse = (entry.Attributes & FileAttributes.ReparsePoint) != 0;
            try
            {
                if (entry is DirectoryInfo && !reparse)
                {
                    EmptyFolder(entry.FullName);
                    ((DirectoryInfo)entry).Delete(false);
                }
                else
                {
                    entry.Attributes = FileAttributes.Normal;
                    if (entry is DirectoryInfo) ((DirectoryInfo)entry).Delete(false); else entry.Delete();
                }
            }
            catch { /* best effort: a locked entry is left for the app's own rmdir of the empty folder */ }
        }
    }

    private static string ResolveInside(string root, string relative)
    {
        if (Path.IsPathRooted(relative) || relative.Contains("..")) throw new SandboxError("a path inside the folder is relative and has no \"..\": " + relative);
        string rootFull = Path.GetFullPath(root).TrimEnd('\\');
        string full = Path.GetFullPath(Path.Combine(root, relative));
        if (!full.StartsWith(rootFull + "\\", StringComparison.OrdinalIgnoreCase)) throw new SandboxError("the path leaves the folder: " + relative);
        // No folder on the way to the target (every component but the last) may be a reparse point, so the
        // operation never descends through a junction or symlink out of the folder. Each is checked from a
        // handle opened without following it; the check fails closed (any error but not-found is a refusal).
        // The final component is opened and verified by the caller, through the handle it then writes or
        // deletes with.
        string cursor = rootFull;
        string[] parts = full.Substring(rootFull.Length + 1).Split('\\');
        for (int i = 0; i < parts.Length - 1; i++)
        {
            cursor = cursor + "\\" + parts[i];
            if (Native.IsReparsePoint(cursor)) throw new SandboxError("a folder on the way to " + relative + " is a reparse point");
        }
        return full;
    }

    private static void Say(string name, string value) { Console.Out.WriteLine(name + ": " + value); }

    private static string TryRead(string file)
    {
        if (string.IsNullOrEmpty(file)) return "skip";
        try { return File.ReadAllText(file); } catch (Exception e) { return "ERR " + e.GetType().Name; }
    }

    private static string TryWrite(string file)
    {
        if (string.IsNullOrEmpty(file)) return "skip";
        try { File.WriteAllText(file, "x"); return "WROTE"; } catch (Exception e) { return "ERR " + e.GetType().Name; }
    }

    private static string TryWriteWork()
    {
        try { File.WriteAllText(Path.Combine(Directory.GetCurrentDirectory(), "lc-probe-work.txt"), "x"); return "ok"; }
        catch (Exception e) { return "ERR " + e.GetType().Name; }
    }

    private static string TryConnect(string host, int port)
    {
        if (port <= 0 && host == "127.0.0.1") return "skip";
        System.Net.Sockets.Socket socket = null;
        try
        {
            System.Net.IPAddress address = System.Net.IPAddress.Parse(host);
            socket = new System.Net.Sockets.Socket(address.AddressFamily, System.Net.Sockets.SocketType.Stream, System.Net.Sockets.ProtocolType.Tcp);
            IAsyncResult pending = socket.BeginConnect(address, port <= 0 ? 443 : port, null, null);
            bool ok = pending.AsyncWaitHandle.WaitOne(2500);
            if (ok && socket.Connected) { socket.EndConnect(pending); return "CONNECTED"; }
            return "closed";
        }
        catch (Exception e) { return "closed:" + e.GetType().Name; }
        finally { if (socket != null) try { socket.Close(); } catch { } }
    }

    private static string TryResolve(string name)
    {
        try { System.Net.Dns.GetHostEntry(name); return "RESOLVED"; }
        catch (Exception e) { return "fail:" + e.GetType().Name; }
    }

    // ---- grant-tools and uninstall --------------------------------------------------------------

    private static int GrantTools(string[] args)
    {
        if (args.Length < 2) throw new SandboxError("grant-tools needs a folder");
        string dir = Path.GetFullPath(args[1]).TrimEnd('\\');
        // Only the helper's own folder (where the shipped Node sits beside it) may be opened to the tools
        // capability; grant-tools can never be pointed at another folder.
        string own = Path.GetFullPath(Path.GetDirectoryName(GetExecutablePath())).TrimEnd('\\');
        if (!dir.Equals(own, StringComparison.OrdinalIgnoreCase)) throw new SandboxError("grant-tools only grants the helper's own folder (" + own + ")");
        if (!Directory.Exists(dir)) throw new SandboxError("the folder does not exist: " + dir);
        IntPtr capSid = Native.CapabilitySid(ToolsCapability);
        // A no-op when the capability may already read and run the folder: the Node tree is not walked
        // again on every app start.
        if (Native.FolderGrants(dir, capSid, Native.GENERIC_READ | Native.GENERIC_EXECUTE))
        {
            Console.Out.WriteLine("already granted " + dir);
            return 0;
        }
        Native.GrantPath(dir, capSid, Native.GENERIC_READ | Native.GENERIC_EXECUTE, true);
        Console.Out.WriteLine("granted " + dir);
        return 0;
    }

    // Removes AppContainer profiles this app made (prefix LocalCognitive.Sandbox), read from the user's
    // AppContainer mappings; a profile with any other name is never touched. uninstall removes all of them
    // (the NSIS uninstaller); clean-stale (app start) removes only those whose owning app process is gone,
    // so a second instance's live runs — which share the user's registry — are left alone. A profile from
    // before owner tags existed (no "lcowner=" display name) is removed by clean-stale only once its
    // registry key is more than a day old. Each removal first empties the package folder by handle, and a
    // profile whose folder cannot be emptied safely is left for a later run.
    private static int RemoveProfiles(bool onlyStale)
    {
        int removed = 0, kept = 0, left = 0;
        long dayAgo = DateTime.UtcNow.AddDays(-1).ToFileTimeUtc();
        foreach (string[] profile in Native.SandboxProfiles(ProfilePrefix))
        {
            string moniker = profile[0], owner = profile[1];
            if (onlyStale)
            {
                bool tagged = !string.IsNullOrEmpty(owner) && owner.StartsWith("lcowner=", StringComparison.Ordinal);
                if (tagged)
                {
                    if (Native.OwnerAlive(owner)) { kept++; continue; }
                }
                else
                {
                    // Untagged (from before owner tags): stale only if its key's last-write time read and is
                    // more than a day old. An unreadable time ("err") keeps it, rather than reading it as old.
                    long lastWrite;
                    if (!long.TryParse(profile[2], out lastWrite) || lastWrite <= 0 || lastWrite > dayAgo) { kept++; continue; }
                }
            }
            // Empty the package folder safely, then delete the profile; left in place if the walk is unsafe.
            if (DeleteProfileSafely(moniker, Native.DeriveContainerSid(moniker))) removed++; else left++;
        }
        Console.Out.WriteLine((onlyStale ? "clean-stale" : "uninstall") + " removed " + removed + " profile(s)" + (kept > 0 ? ", kept " + kept + " in use" : "") + (left > 0 ? ", left " + left + " for later" : ""));
        return left > 0 ? 1 : 0;
    }
    private static int Uninstall() { return RemoveProfiles(false); }
    private static int CleanStale() { return RemoveProfiles(true); }

    private static string GetExecutablePath()
    {
        return System.Reflection.Assembly.GetExecutingAssembly().Location;
    }

    // ---- Win32 ---------------------------------------------------------------------------------

    private static class Native
    {
        public const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000, GENERIC_EXECUTE = 0x20000000, GENERIC_ALL = 0x10000000;
        // FILE_ALL_ACCESS (0x1F01FF) without WRITE_DAC (0x40000) and WRITE_OWNER (0x80000): read, write,
        // execute, delete and delete-child, but no say over the folder's security.
        public const uint FILE_MODIFY_NO_DAC = 0x1301FF;
        private const uint EXTENDED_STARTUPINFO_PRESENT = 0x80000, CREATE_SUSPENDED = 0x4, CREATE_NO_WINDOW = 0x08000000;
        private static readonly IntPtr ATTR_SECURITY_CAPABILITIES = (IntPtr)0x20009, ATTR_HANDLE_LIST = (IntPtr)0x20002;
        private const int SE_FILE_OBJECT = 1;
        private const uint DACL_SECURITY_INFORMATION = 0x4, LABEL_SECURITY_INFORMATION = 0x10;
        private const uint PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000, UNPROTECTED_DACL_SECURITY_INFORMATION = 0x20000000;
        private const ushort SE_DACL_PROTECTED = 0x1000;
        private const int GRANT_ACCESS = 1;
        private const int TRUSTEE_IS_SID = 0, TRUSTEE_IS_UNKNOWN = 0;
        private const uint OBJECT_INHERIT_ACE = 0x1, CONTAINER_INHERIT_ACE = 0x2;
        private const uint STD_INPUT = 0xFFFFFFF6, STD_OUTPUT = 0xFFFFFFF5, STD_ERROR = 0xFFFFFFF4;

        [StructLayout(LayoutKind.Sequential)] private struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }
        [StructLayout(LayoutKind.Sequential)] private struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct STARTUPINFO {
            public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
        [StructLayout(LayoutKind.Sequential)] private struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
        [StructLayout(LayoutKind.Sequential)] private struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
        [StructLayout(LayoutKind.Sequential)] private struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
        [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
            public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
        [StructLayout(LayoutKind.Sequential)] private struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
        [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic; public IO_COUNTERS Io;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct TRUSTEE_W {
            public IntPtr pMultipleTrustee; public int MultipleTrusteeOperation; public int TrusteeForm; public int TrusteeType; public IntPtr ptstrName; }
        [StructLayout(LayoutKind.Sequential)] private struct EXPLICIT_ACCESS_W {
            public uint grfAccessPermissions; public int grfAccessMode; public uint grfInheritance; public TRUSTEE_W Trustee; }

        [DllImport("userenv.dll", CharSet = CharSet.Unicode)] private static extern int CreateAppContainerProfile(string name, string display, string desc, IntPtr caps, uint count, out IntPtr sid);
        [DllImport("userenv.dll", CharSet = CharSet.Unicode)] private static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
        // userenv exports it without an A/W suffix (it takes a wide string only).
        [DllImport("userenv.dll", CharSet = CharSet.Unicode, EntryPoint = "DeleteAppContainerProfile", ExactSpelling = true)] private static extern int DeleteAppContainerProfileNative(string name);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr str);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ConvertStringSidToSidW(string str, out IntPtr sid);
        [DllImport("kernelbase.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool DeriveCapabilitySidsFromName(string name, out IntPtr groupSids, out uint groupCount, out IntPtr capSids, out uint capCount);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint SetEntriesInAclW(uint count, EXPLICIT_ACCESS_W[] list, IntPtr oldAcl, out IntPtr newAcl);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint SetNamedSecurityInfoW(string name, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetNamedSecurityInfoW(string name, int type, uint info, IntPtr owner, IntPtr group, out IntPtr dacl, IntPtr sacl, out IntPtr securityDescriptor);
        [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetSecurityDescriptorControl(IntPtr sd, out ushort control, out uint revision);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr LocalFree(IntPtr mem);
        [DllImport("advapi32.dll", SetLastError = true)] private static extern int GetLengthSid(IntPtr sid);
        [DllImport("advapi32.dll", SetLastError = true)] private static extern bool CopySid(int destLength, IntPtr dest, IntPtr src);
        [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetAce(IntPtr acl, int index, out IntPtr ace);
        [DllImport("advapi32.dll")] private static extern bool EqualSid(IntPtr a, IntPtr b);
        [DllImport("advapi32.dll", SetLastError = true)] private static extern bool InitializeAcl(IntPtr acl, uint length, uint revision);
        [DllImport("advapi32.dll", SetLastError = true)] private static extern bool AddMandatoryAce(IntPtr acl, uint revision, uint flags, uint policy, IntPtr labelSid);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr info, uint length, out uint used);
        [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GetStdHandle(uint n);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr ret);
        [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObjectW(IntPtr sa, string name);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint code);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr t);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr h, uint ms);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr h, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr h);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateWindowStationW(string name, uint flags, uint access, ref SECURITY_ATTRIBUTES sa);
        [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr GetProcessWindowStation();
        [DllImport("user32.dll", SetLastError = true)] private static extern bool SetProcessWindowStation(IntPtr h);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateDesktopW(string name, IntPtr dev, IntPtr dm, uint flags, uint access, ref SECURITY_ATTRIBUTES sa);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint rev, out IntPtr sd, IntPtr size);

        public static string SidString(IntPtr sid)
        {
            IntPtr s;
            if (!ConvertSidToStringSidW(sid, out s)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return Marshal.PtrToStringUni(s);
        }

        // Creates the profile, or derives its SID when it exists already (idempotent), so a command whose
        // profile was removed re-creates it rather than failing. The display name records the owning app
        // process (its parent), so a later app start can tell this run's live profile from a stale one.
        public static IntPtr ContainerSid(string name)
        {
            IntPtr sid;
            int hr = CreateAppContainerProfile(name, OwnerTag(), "Local Cognitive sandbox", IntPtr.Zero, 0, out sid);
            if (hr == unchecked((int)0x800700B7)) hr = DeriveAppContainerSidFromAppContainerName(name, out sid); // already exists
            if (hr != 0) throw new Exception("CreateAppContainerProfile 0x" + hr.ToString("X8"));
            return sid;
        }

        public static int DeleteAppContainerProfile(string name) { return DeleteAppContainerProfileNative(name); }

        // The SID of an existing profile, or Zero when it does not exist. Never creates it (unlike
        // ContainerSid), so cleanup can locate a stale profile's folder without reviving it.
        public static IntPtr DeriveContainerSid(string name)
        {
            IntPtr sid;
            return DeriveAppContainerSidFromAppContainerName(name, out sid) == 0 ? sid : IntPtr.Zero;
        }

        [StructLayout(LayoutKind.Sequential)] private struct PROCESSENTRY32 {
            public uint dwSize; public uint cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID, cntThreads, th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile; }
        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);

        // The id of this helper's parent — the app process that owns the run. A snapshot gives the parent
        // PID; Process gives its start time, so a recycled PID is told apart.
        public static int ParentPid()
        {
            int me = System.Diagnostics.Process.GetCurrentProcess().Id;
            IntPtr snapshot = CreateToolhelp32Snapshot(0x2 /*SNAPPROCESS*/, 0);
            if (snapshot == (IntPtr)(-1)) return 0;
            try
            {
                PROCESSENTRY32 entry = new PROCESSENTRY32();
                entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
                for (bool ok = Process32First(snapshot, ref entry); ok; ok = Process32Next(snapshot, ref entry))
                    if (entry.th32ProcessID == (uint)me) return (int)entry.th32ParentProcessID;
                return 0;
            }
            finally { CloseHandle(snapshot); }
        }

        private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        private const int ERROR_INVALID_PARAMETER = 87;
        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);

        // The raw creation FILETIME (a 64-bit integer, no local-time round trip) of a process, or 0 if it
        // cannot be read.
        private static long ProcessCreationTime(uint pid)
        {
            IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (handle == IntPtr.Zero) return 0;
            try { long creation, exit, kernel, user; return GetProcessTimes(handle, out creation, out exit, out kernel, out user) ? creation : 0; }
            finally { CloseHandle(handle); }
        }

        // "lcowner=<pid>:<creationFileTime>" of the owning app process; "lcowner=0:0" if it cannot be read
        // (then the profile is always kept — never deleted as stale).
        public static string OwnerTag()
        {
            int pid = ParentPid();
            long creation = pid > 0 ? ProcessCreationTime((uint)pid) : 0;
            return pid > 0 && creation != 0 ? "lcowner=" + pid + ":" + creation : "lcowner=0:0";
        }

        // Whether the app process in a profile's owner tag is still running. It is treated as DEAD only when
        // the process plainly does not exist (OpenProcess → ERROR_INVALID_PARAMETER) or its creation time
        // differs (a recycled PID). Access denied (an elevated owner a non-elevated instance cannot query),
        // any other error, and an unreadable or old-format tag all count as ALIVE, so a live owner is never
        // mistaken for a dead one and its profile is kept.
        public static bool OwnerAlive(string ownerTag)
        {
            if (string.IsNullOrEmpty(ownerTag) || !ownerTag.StartsWith("lcowner=", StringComparison.Ordinal)) return true;
            string[] parts = ownerTag.Substring("lcowner=".Length).Split(':');
            int pid; long recorded;
            if (parts.Length != 2 || !int.TryParse(parts[0], out pid) || !long.TryParse(parts[1], out recorded)) return true;
            if (pid == 0 || recorded == 0) return true;
            IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)pid);
            if (handle == IntPtr.Zero) return Marshal.GetLastWin32Error() != ERROR_INVALID_PARAMETER; // no such process ⇒ dead; anything else ⇒ keep
            try
            {
                long creation, exit, kernel, user;
                if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) return true; // cannot tell ⇒ keep
                return creation == recorded;
            }
            finally { CloseHandle(handle); }
        }

        // The capability SID for a name, copied into a small stable buffer so the group/capability arrays
        // DeriveCapabilitySidsFromName allocated (with LocalAlloc) can be freed instead of leaked.
        public static IntPtr CapabilitySid(string name)
        {
            IntPtr groups, caps; uint groupCount, capCount;
            if (!DeriveCapabilitySidsFromName(name, out groups, out groupCount, out caps, out capCount)) throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                if (capCount == 0) throw new SandboxError("no capability SID for " + name);
                IntPtr first = Marshal.ReadIntPtr(caps);
                int length = GetLengthSid(first);
                IntPtr copy = Marshal.AllocHGlobal(length);
                if (!CopySid(length, copy, first)) { Marshal.FreeHGlobal(copy); throw new Win32Exception(Marshal.GetLastWin32Error()); }
                return copy;
            }
            finally { if (groups != IntPtr.Zero) LocalFree(groups); if (caps != IntPtr.Zero) LocalFree(caps); }
        }

        [DllImport("advapi32.dll", SetLastError = true)] private static extern int RegQueryInfoKey(Microsoft.Win32.SafeHandles.SafeRegistryHandle key, IntPtr cls, IntPtr clsLen, IntPtr reserved, IntPtr subKeys, IntPtr maxSubKeyLen, IntPtr maxClassLen, IntPtr values, IntPtr maxValueNameLen, IntPtr maxValueLen, IntPtr securityDescriptor, out long lastWriteTime);

        // The AppContainer profiles whose name carries the prefix. Each is {moniker, ownerTag, lastWrite},
        // where ownerTag is the display name and lastWrite is the registry key's last-write FILETIME (a
        // 64-bit integer, "0" if it cannot be read). Read from the user's AppContainer mappings; a profile
        // with any other name is never returned, so cleanup cannot touch another application's container.
        public static List<string[]> SandboxProfiles(string prefix)
        {
            List<string[]> result = new List<string[]>();
            string key = @"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer\Mappings";
            using (Microsoft.Win32.RegistryKey mappings = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(key))
            {
                if (mappings == null) return result;
                foreach (string sid in mappings.GetSubKeyNames())
                {
                    using (Microsoft.Win32.RegistryKey entry = mappings.OpenSubKey(sid))
                    {
                        string moniker = entry == null ? null : entry.GetValue("Moniker") as string;
                        if (string.IsNullOrEmpty(moniker) ||
                            !(moniker.Equals(prefix, StringComparison.OrdinalIgnoreCase) || moniker.StartsWith(prefix + ".", StringComparison.OrdinalIgnoreCase))) continue;
                        // The key's last-write FILETIME, or "err" when it cannot be read (so cleanup keeps
                        // an untagged profile rather than reading an unknown age as old).
                        string lastWrite = "err";
                        try { long t; if (RegQueryInfoKey(entry.Handle, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out t) == 0 && t > 0) lastWrite = t.ToString(); } catch { lastWrite = "err"; }
                        result.Add(new string[] { moniker, (entry.GetValue("DisplayName") as string) ?? "", lastWrite });
                    }
                }
            }
            return result;
        }

        // Whether `path` already carries an access-allowed ACE for `sid` that includes `rights`, so a grant
        // would add nothing. `rights` may be given in generic form (GENERIC_READ|GENERIC_EXECUTE); Windows
        // stores a directory ACE with the mapped specific bits (FILE_GENERIC_READ|FILE_GENERIC_EXECUTE), so
        // the match accepts either form.
        public static bool FolderGrants(string path, IntPtr sid, uint rights)
        {
            IntPtr dacl, securityDescriptor;
            uint error = GetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, out dacl, IntPtr.Zero, out securityDescriptor);
            if (error != 0) throw new Win32Exception((int)error, "GetNamedSecurityInfo");
            try
            {
                if (dacl == IntPtr.Zero) return false;
                // The specific bits a directory ACE carries once GENERIC_READ|GENERIC_EXECUTE is mapped.
                uint mapped = 0;
                if ((rights & GENERIC_READ) != 0) mapped |= 0x120089;    // FILE_GENERIC_READ
                if ((rights & GENERIC_EXECUTE) != 0) mapped |= 0x1200A0; // FILE_GENERIC_EXECUTE
                if ((rights & GENERIC_WRITE) != 0) mapped |= 0x120116;   // FILE_GENERIC_WRITE
                int count = Marshal.ReadInt16(dacl, 4); // ACL.AceCount
                for (int index = 0; index < count; index++)
                {
                    IntPtr ace;
                    if (!GetAce(dacl, index, out ace)) continue;
                    byte type = Marshal.ReadByte(ace, 0); // ACE_HEADER.AceType
                    if (type != 0) continue; // ACCESS_ALLOWED_ACE_TYPE
                    uint mask = (uint)Marshal.ReadInt32(ace, 4); // ACCESS_ALLOWED_ACE.Mask
                    IntPtr aceSid = (IntPtr)(ace.ToInt64() + 8); // ACCESS_ALLOWED_ACE.SidStart
                    if (EqualSid(aceSid, sid) && ((mask & rights) == rights || (mapped != 0 && (mask & mapped) == mapped))) return true;
                }
                return false;
            }
            finally { if (securityDescriptor != IntPtr.Zero) LocalFree(securityDescriptor); }
        }

        [DllImport("userenv.dll", CharSet = CharSet.Unicode)] private static extern int GetAppContainerFolderPath(string sid, out IntPtr path);
        [DllImport("ole32.dll")] private static extern void CoTaskMemFree(IntPtr p);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetFileInformationByHandle(IntPtr file, int cls, IntPtr info, uint size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetFileInformationByHandleEx(IntPtr file, int cls, IntPtr info, uint size);

        // The real package folder of a container, from its SID (not an env var or the Shell Folders key).
        public static string AppContainerFolderPath(IntPtr sid)
        {
            IntPtr path;
            int hr = GetAppContainerFolderPath(SidString(sid), out path);
            if (hr != 0 || path == IntPtr.Zero) return null;
            try { return Marshal.PtrToStringUni(path); }
            finally { CoTaskMemFree(path); }
        }

        private const uint FILE_SHARE_READ_WRITE = 0x1 | 0x2; // never FILE_SHARE_DELETE
        private const uint FLAG_BACKUP_OPEN_REPARSE = 0x02000000 | 0x00200000; // BACKUP_SEMANTICS | OPEN_REPARSE_POINT
        private const uint DELETE = 0x10000, FILE_LIST_DIRECTORY = 0x1, FILE_READ_ATTRIBUTES = 0x80, FILE_WRITE_ATTRIBUTES = 0x100;
        private const int ERROR_FILE_NOT_FOUND = 2, ERROR_PATH_NOT_FOUND = 3, ERROR_NO_MORE_FILES = 18;

        // Deletes the object the handle names. Prefers FileDispositionInfoEx (so a read-only file goes, and
        // the name is freed at once), and falls back to FileDispositionInfo where Ex is not supported (an
        // older Windows), first clearing the read-only attribute so that path works too.
        private static void DeleteViaHandle(IntPtr handle)
        {
            IntPtr ex = Marshal.AllocHGlobal(4);
            try
            {
                // FILE_DISPOSITION_FLAG_DELETE | POSIX_SEMANTICS | IGNORE_READONLY_ATTRIBUTE.
                Marshal.WriteInt32(ex, 0, 0x1 | 0x2 | 0x10);
                if (SetFileInformationByHandle(handle, 21 /*FileDispositionInfoEx*/, ex, 4)) return;
                int err = Marshal.GetLastWin32Error();
                // Not on this Windows (pre-1709): fall back. Any other error is real.
                if (err != ERROR_INVALID_PARAMETER && err != 50 /*ERROR_NOT_SUPPORTED*/ && err != 1 /*ERROR_INVALID_FUNCTION*/)
                    throw new Win32Exception(err, "SetFileInformationByHandle (delete-ex)");
                ClearReadOnly(handle);
                IntPtr info = Marshal.AllocHGlobal(1);
                try { Marshal.WriteByte(info, 0, 1); if (!SetFileInformationByHandle(handle, 4 /*FileDispositionInfo*/, info, 1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "SetFileInformationByHandle (delete)"); }
                finally { Marshal.FreeHGlobal(info); }
            }
            finally { Marshal.FreeHGlobal(ex); }
        }

        // Clears the read-only attribute on a handle (FILE_BASIC_INFO, times left at 0 = unchanged), so the
        // non-Ex disposition can delete it. The handle must carry FILE_WRITE_ATTRIBUTES; a failure stops the
        // walk rather than letting a read-only file be silently skipped.
        private static void ClearReadOnly(IntPtr handle)
        {
            IntPtr basic = Marshal.AllocHGlobal(40);
            try
            {
                for (int off = 0; off < 32; off += 8) Marshal.WriteInt64(basic, off, 0); // leave all four times unchanged
                Marshal.WriteInt32(basic, 32, 0x80 /*FILE_ATTRIBUTE_NORMAL*/);
                if (!SetFileInformationByHandle(handle, 0 /*FileBasicInfo*/, basic, 40)) throw new Win32Exception(Marshal.GetLastWin32Error(), "clear read-only");
            }
            finally { Marshal.FreeHGlobal(basic); }
        }

        // The child names under a directory handle, read from the handle itself (FILE_FULL_DIR_INFO), so
        // the names come from the held directory, not a fresh path lookup. "." and ".." are left out. The
        // enumeration fails closed: it stops only at ERROR_NO_MORE_FILES, and throws on any other error
        // (never reads an error as an empty folder).
        private static List<string> ChildNames(IntPtr dirHandle)
        {
            List<string> names = new List<string>();
            int size = 64 * 1024;
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                int cls = 15; // FileFullDirectoryRestartInfo, then FileFullDirectoryInfo (14)
                while (true)
                {
                    if (!GetFileInformationByHandleEx(dirHandle, cls, buffer, (uint)size))
                    {
                        int err = Marshal.GetLastWin32Error();
                        if (err == ERROR_NO_MORE_FILES) break;
                        throw new Win32Exception(err, "enumerate directory");
                    }
                    cls = 14;
                    long at = buffer.ToInt64();
                    while (true)
                    {
                        IntPtr entry = (IntPtr)at;
                        int next = Marshal.ReadInt32(entry, 0);
                        int nameLen = Marshal.ReadInt32(entry, 60); // FileNameLength, bytes
                        string name = Marshal.PtrToStringUni((IntPtr)(at + 68), nameLen / 2);
                        if (name != "." && name != "..") names.Add(name);
                        if (next == 0) break;
                        at += next;
                    }
                }
                return names;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        // Empties a directory's contents by handle, failing closed: each child is opened without following
        // a reparse point (OPEN_REPARSE_POINT) and its type read from that handle; a reparse point is
        // unlinked, never descended into; a real sub-directory is emptied then removed; a file is removed —
        // all through SetFileInformationByHandle on the child's own handle. The parent handle is held open
        // (no share-delete) throughout. Any unexpected error stops the walk (the caller leaves the rest).
        public static void DeleteTreeContents(string path)
        {
            IntPtr dir = CreateFileW(path, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES, FILE_SHARE_READ_WRITE, IntPtr.Zero, 3 /*OPEN_EXISTING*/, FLAG_BACKUP_OPEN_REPARSE, IntPtr.Zero);
            if (dir == (IntPtr)(-1))
            {
                int err = Marshal.GetLastWin32Error();
                if (err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND) return;
                throw new Win32Exception(err, "open " + path);
            }
            try
            {
                // The top of the walk must be a real directory: if it is a reparse point, refuse rather than
                // treat its target as the package folder.
                if (HandleIsReparse(dir)) throw new SandboxError("the folder to empty is a reparse point: " + path);
                DeleteContents(dir, path);
            }
            finally { CloseHandle(dir); }
        }

        private static void DeleteContents(IntPtr dirHandle, string dirPath)
        {
            foreach (string name in ChildNames(dirHandle))
            {
                string full = dirPath + "\\" + name;
                IntPtr child = CreateFileW(full, DELETE | FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES, FILE_SHARE_READ_WRITE, IntPtr.Zero, 3 /*OPEN_EXISTING*/, FLAG_BACKUP_OPEN_REPARSE, IntPtr.Zero);
                if (child == (IntPtr)(-1))
                {
                    int err = Marshal.GetLastWin32Error();
                    if (err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND) continue; // already gone
                    throw new Win32Exception(err, "open " + full);
                }
                try
                {
                    BY_HANDLE_FILE_INFORMATION info;
                    if (!GetFileInformationByHandle(child, out info)) throw new Win32Exception(Marshal.GetLastWin32Error(), "stat " + full);
                    bool reparse = (info.FileAttributes & 0x400) != 0;
                    bool directory = (info.FileAttributes & 0x10) != 0;
                    if (!reparse && directory) DeleteContents(child, full); // empty a real sub-directory first
                    DeleteViaHandle(child); // unlink the reparse point, the now-empty directory, or the file
                }
                finally { CloseHandle(child); }
            }
        }

        public static string CurrentUserSid()
        {
            IntPtr token;
            if (!OpenProcessToken(GetCurrentProcess(), 0x8 /*TOKEN_QUERY*/, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                uint used;
                GetTokenInformation(token, 1 /*TokenUser*/, IntPtr.Zero, 0, out used);
                IntPtr buffer = Marshal.AllocHGlobal((int)used);
                try
                {
                    if (!GetTokenInformation(token, 1, buffer, used, out used)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    return SidString(Marshal.ReadIntPtr(buffer)); // TOKEN_USER.User.Sid is first
                }
                finally { Marshal.FreeHGlobal(buffer); }
            }
            finally { CloseHandle(token); }
        }

        // Adds one capability's access to a file-system object (the work folder, or the tools folder at
        // install), merging it into the object's current DACL so every other ACE — explicit, inherited, or
        // on a folder whose DACL is protected — is preserved, and leaving the protected/unprotected state
        // as it was. Nothing is ever revoked: the work folder's grant goes with the folder when it is
        // deleted, and the tools grant is permanent. Read-modify-write under a per-path named mutex, so two
        // helper processes touching the same folder cannot lose an update.
        public static void GrantPath(string path, IntPtr sid, uint rights, bool inherit)
        {
            SetAce(path, sid, rights, inherit, GRANT_ACCESS);
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFinalPathNameByHandleW(IntPtr file, StringBuilder path, uint count, uint flags);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(IntPtr file, out BY_HANDLE_FILE_INFORMATION info);
        [StructLayout(LayoutKind.Sequential)] private struct BY_HANDLE_FILE_INFORMATION {
            public uint FileAttributes; public long CreationTime, LastAccessTime, LastWriteTime;
            public uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow; }

        // Whether the component is a reparse point, read from a handle opened without following it. Fails
        // closed: a component that is not there is not a reparse point, but any other open or stat failure
        // is thrown (never silently treated as "safe").
        public static bool IsReparsePoint(string path)
        {
            IntPtr handle = CreateFileW(path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ_WRITE, IntPtr.Zero, 3 /*OPEN_EXISTING*/, FLAG_BACKUP_OPEN_REPARSE, IntPtr.Zero);
            if (handle == (IntPtr)(-1))
            {
                int err = Marshal.GetLastWin32Error();
                if (err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND) return false;
                throw new Win32Exception(err, "open " + path);
            }
            try
            {
                BY_HANDLE_FILE_INFORMATION info;
                if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error(), "stat " + path);
                return (info.FileAttributes & 0x400 /*FILE_ATTRIBUTE_REPARSE_POINT*/) != 0;
            }
            finally { CloseHandle(handle); }
        }

        public static bool HandleIsReparse(IntPtr handle)
        {
            BY_HANDLE_FILE_INFORMATION info;
            if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error(), "stat handle");
            return (info.FileAttributes & 0x400) != 0;
        }

        // Opens a directory and holds it open (no share-delete) so it cannot be renamed or deleted while a
        // child under it is written or removed.
        public static IntPtr OpenDirHold(string path)
        {
            IntPtr handle = CreateFileW(path, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES, FILE_SHARE_READ_WRITE, IntPtr.Zero, 3 /*OPEN_EXISTING*/, FLAG_BACKUP_OPEN_REPARSE, IntPtr.Zero);
            if (handle == (IntPtr)(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "open directory " + path);
            return handle;
        }

        // Opens (creating or truncating) the final component without following a link, sharing read only
        // (no write or delete), so the write goes to that exact object and the caller can reject a reparse.
        public static IntPtr OpenFinalForWrite(string path)
        {
            IntPtr handle = CreateFileW(path, GENERIC_WRITE | DELETE, 0x1 /*FILE_SHARE_READ*/, IntPtr.Zero, 2 /*CREATE_ALWAYS*/, FLAG_BACKUP_OPEN_REPARSE, IntPtr.Zero);
            if (handle == (IntPtr)(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "open for write " + path);
            return handle;
        }

        // Opens the final component for deletion without following a link; -1 (not an error) when it is not
        // there, any other failure thrown.
        public static IntPtr OpenFinalForRemove(string path)
        {
            IntPtr handle = CreateFileW(path, DELETE | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES, FILE_SHARE_READ_WRITE, IntPtr.Zero, 3 /*OPEN_EXISTING*/, FLAG_BACKUP_OPEN_REPARSE, IntPtr.Zero);
            if (handle == (IntPtr)(-1))
            {
                int err = Marshal.GetLastWin32Error();
                if (err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND) return (IntPtr)(-1);
                throw new Win32Exception(err, "open for remove " + path);
            }
            return handle;
        }

        public static FileStream StreamForWrite(IntPtr handle)
        {
            return new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(handle, false), FileAccess.Write);
        }

        public static void Delete(IntPtr handle) { DeleteViaHandle(handle); }
        public static void CloseRaw(IntPtr handle) { if (handle != IntPtr.Zero && handle != (IntPtr)(-1)) CloseHandle(handle); }

        // The real, canonical path of a folder: the final path by handle (which resolves links and expands
        // 8.3 names), with the \\?\ prefix stripped and any trailing separator removed, so two spellings of
        // the same folder hash to one mutex name. Falls back to the normalized input if the handle cannot
        // be opened.
        private static string CanonicalPath(string path)
        {
            IntPtr handle = CreateFileW(path, 0, 0x7 /*share all*/, IntPtr.Zero, 3 /*OPEN_EXISTING*/, 0x02000000 /*BACKUP_SEMANTICS, for a directory*/, IntPtr.Zero);
            if (handle == (IntPtr)(-1)) return Path.GetFullPath(path).TrimEnd('\\');
            try { return HandleFinalPath(handle) ?? Path.GetFullPath(path).TrimEnd('\\'); }
            finally { CloseHandle(handle); }
        }

        // The real path an open handle resolves to (links followed, 8.3 expanded, \\?\ stripped, trailing
        // separator removed), or null if it cannot be read.
        public static string HandleFinalPath(IntPtr handle)
        {
            StringBuilder buffer = new StringBuilder(600);
            uint n = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
            if (n == 0 || n >= buffer.Capacity) return null;
            string full = buffer.ToString();
            if (full.StartsWith("\\\\?\\UNC\\", StringComparison.Ordinal)) full = "\\\\" + full.Substring(8);
            else if (full.StartsWith("\\\\?\\", StringComparison.Ordinal)) full = full.Substring(4);
            return full.TrimEnd('\\');
        }

        private static string AclMutexName(string path)
        {
            using (System.Security.Cryptography.MD5 md5 = System.Security.Cryptography.MD5.Create())
            {
                byte[] hash = md5.ComputeHash(Encoding.Unicode.GetBytes(CanonicalPath(path).ToLowerInvariant()));
                StringBuilder name = new StringBuilder("Local\\lc-sandbox-acl-");
                foreach (byte b in hash) name.Append(b.ToString("x2"));
                return name.ToString();
            }
        }

        private static void SetAce(string path, IntPtr sid, uint rights, bool inherit, int mode)
        {
            EXPLICIT_ACCESS_W access = new EXPLICIT_ACCESS_W();
            access.grfAccessPermissions = rights;
            access.grfAccessMode = mode;
            access.grfInheritance = inherit ? (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) : 0;
            access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
            access.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
            access.Trustee.ptstrName = sid;

            using (System.Threading.Mutex mutex = new System.Threading.Mutex(false, AclMutexName(path)))
            {
                bool held = false;
                try
                {
                    try { held = mutex.WaitOne(30000); } catch (System.Threading.AbandonedMutexException) { held = true; }
                    if (!held) throw new SandboxError("timed out waiting to change the access of " + path);

                    IntPtr currentDacl, securityDescriptor;
                    uint error = GetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, out currentDacl, IntPtr.Zero, out securityDescriptor);
                    if (error != 0) throw new Win32Exception((int)error, "GetNamedSecurityInfo");
                    IntPtr newAcl = IntPtr.Zero;
                    try
                    {
                        // A NULL DACL means "everyone, full control": the helper refuses to touch such a
                        // folder rather than replace that with a single ACE (it only ever grants folders it
                        // or the app created, which always have a DACL).
                        if (currentDacl == IntPtr.Zero) throw new SandboxError("refusing to change the access of " + path + ": it has no DACL");
                        // Keep the object's protected/unprotected DACL state: writing it back the other way
                        // would turn inheritance on or off under us. A failed read is fatal, so a protected
                        // DACL is never written back unprotected by accident.
                        ushort control; uint revision;
                        if (!GetSecurityDescriptorControl(securityDescriptor, out control, out revision)) throw new Win32Exception(Marshal.GetLastWin32Error(), "GetSecurityDescriptorControl");
                        uint info = DACL_SECURITY_INFORMATION | ((control & SE_DACL_PROTECTED) != 0 ? PROTECTED_DACL_SECURITY_INFORMATION : UNPROTECTED_DACL_SECURITY_INFORMATION);
                        // Merge the change into the current DACL.
                        error = SetEntriesInAclW(1, new EXPLICIT_ACCESS_W[] { access }, currentDacl, out newAcl);
                        if (error != 0) throw new Win32Exception((int)error, "SetEntriesInAcl");
                        error = SetNamedSecurityInfoW(path, SE_FILE_OBJECT, info, IntPtr.Zero, IntPtr.Zero, newAcl, IntPtr.Zero);
                        if (error != 0) throw new Win32Exception((int)error, "SetNamedSecurityInfo");
                    }
                    finally
                    {
                        // SetEntriesInAcl and GetNamedSecurityInfo allocate with LocalAlloc: LocalFree, not
                        // the C# heap. The DACL points into the security descriptor, so it is not freed on its own.
                        if (newAcl != IntPtr.Zero) LocalFree(newAcl);
                        if (securityDescriptor != IntPtr.Zero) LocalFree(securityDescriptor);
                    }
                }
                finally { if (held) mutex.ReleaseMutex(); }
            }
        }

        // Labels the folder (and, by inheritance, its new contents) low integrity, with no-write-up, so a
        // low-integrity sandboxed process can write there.
        public static void SetLowIntegrity(string path)
        {
            IntPtr lowSid;
            if (!ConvertStringSidToSidW("S-1-16-4096", out lowSid)) throw new Win32Exception(Marshal.GetLastWin32Error());
            uint aclSize = 128;
            IntPtr acl = Marshal.AllocHGlobal((int)aclSize);
            try
            {
                if (!InitializeAcl(acl, aclSize, 2 /*ACL_REVISION*/)) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (!AddMandatoryAce(acl, 2, OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE, 0x1 /*NO_WRITE_UP*/, lowSid)) throw new Win32Exception(Marshal.GetLastWin32Error());
                uint error = SetNamedSecurityInfoW(path, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, acl);
                if (error != 0) throw new Win32Exception((int)error, "SetNamedSecurityInfo (label)");
            }
            finally { Marshal.FreeHGlobal(acl); }
        }

        private static IntPtr windowStation = IntPtr.Zero;
        private static IntPtr desktopHandle = IntPtr.Zero;

        public static string CreateDesktop(string containerSid, string userSid)
        {
            string sddl = "D:(A;;GA;;;" + containerSid + ")(A;;GA;;;" + userSid + ")(A;;GA;;;SY)S:(ML;;NW;;;LW)";
            IntPtr sd;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
            SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
            sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            sa.lpSecurityDescriptor = sd;
            sa.bInheritHandle = 0;
            string stationName = "lcws-" + Guid.NewGuid().ToString("N").Substring(0, 12);
            windowStation = CreateWindowStationW(stationName, 0, 0x37F /*WINSTA_ALL_ACCESS*/, ref sa);
            if (windowStation == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateWindowStation");
            IntPtr previous = GetProcessWindowStation();
            if (!SetProcessWindowStation(windowStation)) throw new Win32Exception(Marshal.GetLastWin32Error(), "SetProcessWindowStation");
            desktopHandle = CreateDesktopW("lcdesk", IntPtr.Zero, IntPtr.Zero, 0, 0x10000000 /*GENERIC_ALL*/, ref sa);
            int error = Marshal.GetLastWin32Error();
            SetProcessWindowStation(previous);
            if (desktopHandle == IntPtr.Zero) throw new Win32Exception(error, "CreateDesktop");
            return stationName + "\\lcdesk";
        }

        public static void CloseDesktop()
        {
            // The desktop and window-station handles close with the process; nothing to free per run.
        }

        public static int Launch(IntPtr containerSid, IntPtr[] capabilities, string exe, List<string> exeArgs, string cwd, string desktop, int cpuSeconds)
        {
            // The command's three standard handles, made inheritable, are the only handles the child may
            // inherit (the handle list), so nothing else of ours leaks in.
            IntPtr hIn = GetStdHandle(STD_INPUT), hOut = GetStdHandle(STD_OUTPUT), hErr = GetStdHandle(STD_ERROR);
            foreach (IntPtr h in new IntPtr[] { hIn, hOut, hErr }) if (h != IntPtr.Zero && h != (IntPtr)(-1)) SetHandleInformation(h, 0x1 /*INHERIT*/, 0x1);

            IntPtr capArray = IntPtr.Zero;
            int capCount = capabilities == null ? 0 : capabilities.Length;
            if (capCount > 0)
            {
                int size = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
                capArray = Marshal.AllocHGlobal(size * capCount);
                for (int i = 0; i < capCount; i++)
                {
                    SID_AND_ATTRIBUTES item = new SID_AND_ATTRIBUTES();
                    item.Sid = capabilities[i];
                    item.Attributes = 4; // SE_GROUP_ENABLED
                    Marshal.StructureToPtr(item, (IntPtr)(capArray.ToInt64() + i * size), false);
                }
            }
            SECURITY_CAPABILITIES caps = new SECURITY_CAPABILITIES();
            caps.AppContainerSid = containerSid;
            caps.Capabilities = capArray;
            caps.CapabilityCount = (uint)capCount;
            IntPtr pCaps = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
            Marshal.StructureToPtr(caps, pCaps, false);

            List<IntPtr> handleList = new List<IntPtr>();
            foreach (IntPtr h in new IntPtr[] { hIn, hOut, hErr }) if (h != IntPtr.Zero && h != (IntPtr)(-1) && !handleList.Contains(h)) handleList.Add(h);
            IntPtr handles = Marshal.AllocHGlobal(IntPtr.Size * handleList.Count);
            for (int i = 0; i < handleList.Count; i++) Marshal.WriteIntPtr(handles, i * IntPtr.Size, handleList[i]);

            IntPtr listSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref listSize);
            IntPtr list = Marshal.AllocHGlobal(listSize);
            if (!InitializeProcThreadAttributeList(list, 2, 0, ref listSize)) throw new Win32Exception(Marshal.GetLastWin32Error(), "InitializeProcThreadAttributeList");
            if (!UpdateProcThreadAttribute(list, 0, ATTR_SECURITY_CAPABILITIES, pCaps, (IntPtr)Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "SECURITY_CAPABILITIES");
            if (!UpdateProcThreadAttribute(list, 0, ATTR_HANDLE_LIST, handles, (IntPtr)(IntPtr.Size * handleList.Count), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "HANDLE_LIST");

            STARTUPINFOEX si = new STARTUPINFOEX();
            si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            si.lpAttributeList = list;
            si.StartupInfo.dwFlags = 0x100; // STARTF_USESTDHANDLES
            si.StartupInfo.lpDesktop = desktop;
            si.StartupInfo.hStdInput = hIn;
            si.StartupInfo.hStdOutput = hOut;
            si.StartupInfo.hStdError = hErr;

            IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            // KILL_ON_JOB_CLOSE | DIE_ON_UNHANDLED_EXCEPTION | ACTIVE_PROCESS | JOB_MEMORY (+ PROCESS_TIME).
            uint limitFlags = 0x2000 | 0x400 | 0x8 | 0x200;
            if (cpuSeconds > 0) { limitFlags |= 0x2 /*PROCESS_TIME*/; limits.Basic.PerProcessUserTimeLimit = (long)cpuSeconds * 10000000L; }
            limits.Basic.LimitFlags = limitFlags;
            limits.Basic.ActiveProcessLimit = 128;
            limits.JobMemoryLimit = (UIntPtr)(4UL << 30);
            IntPtr pLimits = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
            Marshal.StructureToPtr(limits, pLimits, false);
            if (!SetInformationJobObject(job, 9 /*ExtendedLimit*/, pLimits, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject");
            IntPtr pUi = Marshal.AllocHGlobal(4);
            Marshal.WriteInt32(pUi, 0x40 | 0x10 | 0x80 | 0x20 | 0x1 | 0x2 | 0x4 | 0x8); // handles, read clipboard, exit windows, display, global atoms, desktop, system parameters, write clipboard
            if (!SetInformationJobObject(job, 4 /*BasicUIRestrictions*/, pUi, 4)) throw new Win32Exception(Marshal.GetLastWin32Error(), "UIRestrictions");

            StringBuilder commandLine = BuildCommandLine(exe, exeArgs);
            PROCESS_INFORMATION pi;
            if (!CreateProcessW(exe, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, cwd, ref si, out pi))
            {
                int error = Marshal.GetLastWin32Error();
                CloseHandle(job);
                throw new Win32Exception(error, "CreateProcess (0x" + error.ToString("X") + ")");
            }
            if (!AssignProcessToJobObject(job, pi.hProcess))
            {
                int error = Marshal.GetLastWin32Error();
                TerminateJobObject(job, 1);
                throw new Win32Exception(error, "AssignProcessToJobObject");
            }
            ResumeThread(pi.hThread);
            CloseHandle(pi.hThread);
            WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
            uint code;
            GetExitCodeProcess(pi.hProcess, out code);
            CloseHandle(pi.hProcess);
            DeleteProcThreadAttributeList(list);
            // Ends anything the command left running, then closing the handle tears the job down. If this
            // helper is killed first (a run's timeout), the same close happens and the tree dies too.
            TerminateJobObject(job, code);
            CloseHandle(job);
            return unchecked((int)code);
        }

        // The Microsoft C/C++ argv quoting rules, so each argument reaches the program exactly as given.
        private static StringBuilder BuildCommandLine(string exe, List<string> args)
        {
            StringBuilder builder = new StringBuilder();
            AppendArg(builder, exe);
            foreach (string arg in args) { builder.Append(' '); AppendArg(builder, arg); }
            return builder;
        }

        private static void AppendArg(StringBuilder builder, string arg)
        {
            if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) { builder.Append(arg); return; }
            builder.Append('"');
            for (int i = 0; ; i++)
            {
                int backslashes = 0;
                while (i < arg.Length && arg[i] == '\\') { i++; backslashes++; }
                if (i == arg.Length) { builder.Append('\\', backslashes * 2); break; }
                if (arg[i] == '"') { builder.Append('\\', backslashes * 2 + 1); builder.Append('"'); }
                else { builder.Append('\\', backslashes); builder.Append(arg[i]); }
            }
            builder.Append('"');
        }
    }
}
