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
    // The one AppContainer profile the app reuses. Its package folder (the "moniker") is the name
    // lowercased: TEMP is rerouted there, so the launcher side pre-creates it under the work folder.
    private const string ProfileName = "LocalCognitive.Sandbox";
    // The stable capability the shipped Node runtime and this helper are granted read+execute, so the
    // container can run them. grant-tools sets it; the per-run capability grants the work folder.
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
                case "empty": return Builtin(args, "__empty");
                case "grant-tools": return GrantTools(args);
                case "uninstall": return Uninstall();
                // Internal commands: this helper, re-launched inside the container, running as the
                // AppContainer token. Never invoked from outside.
                case "__probe": return InnerProbe(args);
                case "__write": return InnerWrite(args);
                case "__remove": return InnerRemove(args);
                case "__empty": return InnerEmpty(args);
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
            "  exec    --run-cap NAME --roots DIRS --rw DIR [--granted] [--ro DIR]... [--cpu SECONDS] -- EXE ARGS...\n" +
            "  probe   --run-cap NAME --roots DIRS --rw DIR [--granted] [--ro DIR]... -- CANARY WRITTEN PORT\n" +
            "  write   --run-cap NAME --roots DIRS --rw DIR [--granted] -- REL        (stdin is written to <rw>\\REL)\n" +
            "  remove  --run-cap NAME --roots DIRS --rw DIR [--granted] -- REL\n" +
            "  empty   --run-cap NAME --roots DIRS --rw DIR [--granted]\n" +
            "  grant-tools DIR                                             (one time, at install)\n" +
            "  uninstall                                                   (removes the AppContainer profile)");
    }

    // ---- Option parsing -------------------------------------------------------------------------

    private sealed class SandboxError : Exception
    {
        public SandboxError(string message) : base(message) { }
    }

    private sealed class Options
    {
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

    // The work folder must be an absolute path inside one of the app's declared roots; a read-only
    // folder must be an absolute, existing directory that is not a drive root, the Windows folder or a
    // profile root. Both guard against a work/tool path the helper was handed by mistake.
    private static string RequireRw(Options options)
    {
        if (options.Rw == null) throw new SandboxError("--rw is required");
        if (options.Roots.Count == 0) throw new SandboxError("--roots is required");
        string rw = Path.GetFullPath(options.Rw);
        bool within = false;
        foreach (string root in options.Roots)
        {
            string full = Path.GetFullPath(root).TrimEnd('\\');
            if (rw.Equals(full, StringComparison.OrdinalIgnoreCase) ||
                rw.StartsWith(full + "\\", StringComparison.OrdinalIgnoreCase)) { within = true; break; }
        }
        if (!within) throw new SandboxError("the work folder is outside the app's work roots: " + rw);
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

    private static int Run(Options options, string exe, List<string> exeArgs)
    {
        string work = RequireRw(options);
        List<string> readOnly = ResolveReadOnly(options);
        IntPtr containerSid = Native.ContainerSid(ProfileName, true);
        string containerSidString = Native.SidString(containerSid);
        IntPtr toolsCapSid = Native.CapabilitySid(ToolsCapability);
        // Every grant goes to the run's own capability, never the shared package SID, so two runs (or two
        // agents' copies) never see each other's folders.
        if (string.IsNullOrEmpty(options.RunCap) || !options.RunCap.StartsWith("LocalCognitive.Run.", StringComparison.Ordinal))
            throw new SandboxError("--run-cap LocalCognitive.Run.<id> is required");
        IntPtr runCapSid = Native.CapabilitySid(options.RunCap);
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
        foreach (string dir in readOnly) Native.GrantPath(dir, grantee, Native.GENERIC_READ | Native.GENERIC_EXECUTE, true);

        // A window station and desktop of the run's own: node, curl and git do not start on the caller's.
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
            // The run's capability grant is removed from the read-only folders it was added to (the work
            // folder is deleted by the app). The profile, the tools grant and the desktop handle persist.
            if (runCapSid != IntPtr.Zero) foreach (string dir in readOnly) try { Native.RevokePath(dir, runCapSid); } catch { }
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

    private static int InnerWrite(string[] args)
    {
        if (args.Length < 2) throw new SandboxError("__write needs a relative path");
        string target = ResolveInside(Directory.GetCurrentDirectory(), args[1]);
        string dir = Path.GetDirectoryName(target);
        if (dir != null && dir.Length > 0) Directory.CreateDirectory(dir);
        using (Stream input = Console.OpenStandardInput())
        using (FileStream output = new FileStream(target, FileMode.Create, FileAccess.Write))
        {
            byte[] buffer = new byte[65536];
            int read;
            while ((read = input.Read(buffer, 0, buffer.Length)) > 0) output.Write(buffer, 0, read);
        }
        return 0;
    }

    private static int InnerRemove(string[] args)
    {
        if (args.Length < 2) throw new SandboxError("__remove needs a relative path");
        string target = ResolveInside(Directory.GetCurrentDirectory(), args[1]);
        if (File.Exists(target)) File.Delete(target);
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
        string full = Path.GetFullPath(Path.Combine(root, relative));
        string prefix = Path.GetFullPath(root).TrimEnd('\\') + "\\";
        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new SandboxError("the path leaves the folder: " + relative);
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
        string dir = Path.GetFullPath(args[1]);
        if (!Directory.Exists(dir)) throw new SandboxError("the folder does not exist: " + dir);
        IntPtr capSid = Native.CapabilitySid(ToolsCapability);
        Native.GrantPath(dir, capSid, Native.GENERIC_READ | Native.GENERIC_EXECUTE, true);
        Console.Out.WriteLine("granted " + dir);
        return 0;
    }

    private static int Uninstall()
    {
        int hr = Native.DeleteAppContainerProfile(ProfileName);
        // S_OK, or a profile that is not there (ERROR_FILE_NOT_FOUND / ERROR_NOT_FOUND): nothing is left.
        bool gone = hr == 0 || hr == unchecked((int)0x80070002) || hr == unchecked((int)0x80070490);
        Console.Out.WriteLine("uninstall hr=0x" + hr.ToString("X8") + (gone ? " (no profile left)" : ""));
        return gone ? 0 : 1;
    }

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
        private const int GRANT_ACCESS = 1, REVOKE_ACCESS = 4;
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

        public static IntPtr ContainerSid(string name, bool create)
        {
            IntPtr sid;
            if (create)
            {
                int hr = CreateAppContainerProfile(name, name, "Local Cognitive sandbox", IntPtr.Zero, 0, out sid);
                if (hr == unchecked((int)0x800700B7)) hr = DeriveAppContainerSidFromAppContainerName(name, out sid); // already exists
                if (hr != 0) throw new Exception("CreateAppContainerProfile 0x" + hr.ToString("X8"));
            }
            else
            {
                int hr = DeriveAppContainerSidFromAppContainerName(name, out sid);
                if (hr != 0) throw new Exception("DeriveAppContainerSidFromAppContainerName 0x" + hr.ToString("X8"));
            }
            return sid;
        }

        public static int DeleteAppContainerProfile(string name) { return DeleteAppContainerProfileNative(name); }

        public static IntPtr CapabilitySid(string name)
        {
            IntPtr g, c; uint gc, cc;
            if (!DeriveCapabilitySidsFromName(name, out g, out gc, out c, out cc)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return Marshal.ReadIntPtr(c);
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

        // Adds (or, mode REVOKE, removes) one SID's access to a file-system object, merging with its
        // existing ACL so nothing already there is lost.
        public static void GrantPath(string path, IntPtr sid, uint rights, bool inherit)
        {
            SetAce(path, sid, rights, inherit, GRANT_ACCESS);
        }

        public static void RevokePath(string path, IntPtr sid)
        {
            SetAce(path, sid, 0, false, REVOKE_ACCESS);
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
            IntPtr newAcl;
            uint error = SetEntriesInAclW(1, new EXPLICIT_ACCESS_W[] { access }, IntPtr.Zero, out newAcl);
            if (error != 0) throw new Win32Exception((int)error, "SetEntriesInAcl");
            try
            {
                error = SetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, newAcl, IntPtr.Zero);
                if (error != 0) throw new Win32Exception((int)error, "SetNamedSecurityInfo");
            }
            finally { if (newAcl != IntPtr.Zero) Marshal.FreeHGlobal(newAcl); }
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
