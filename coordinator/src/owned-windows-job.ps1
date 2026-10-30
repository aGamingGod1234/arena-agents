param([string]$CommandJson, [switch]$LibraryOnly, [string]$EvidencePath)
$ErrorActionPreference = 'Stop'
# Progress records (e.g. first-use module preparation) are written as CLIXML into the child's redirected streams.
$ProgressPreference = 'SilentlyContinue'
# Auto-loading a cmdlet first analyzes every module on PSModulePath, and the built-in ones come last. With a cold
# module analysis cache and large module sets (GitHub runners) that took over 10 s of CPU per launch. Load the two
# built-in modules this script uses straight from PSHOME and never search.
$PSModuleAutoLoadingPreference = 'None'
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1", "$PSHOME\Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1"
$ownedJobSource = @"
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.IO;
using System.Runtime.InteropServices;
public static class ArenaOwnedJob {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr data, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr source, IntPtr handle, IntPtr target, out IntPtr duplicate, uint access, bool inherit, uint options);
    public static void AttachWithEvidence(string evidencePath, string witnessScript) {
        evidencePath = Path.GetFullPath(evidencePath);
        Directory.CreateDirectory(Path.GetDirectoryName(evidencePath));
        if (File.Exists(evidencePath)) throw new InvalidOperationException("Job evidence must use a fresh path");
        string control = evidencePath + ".control-" + Guid.NewGuid().ToString("N");
        var info = new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + Quote(witnessScript) + " -ControlPath " + Quote(control) + " -EvidencePath " + Quote(evidencePath));
        info.UseShellExecute = false; info.CreateNoWindow = true;
        using (var witness = Process.Start(info)) {
            Attach();
            IntPtr witnessJob, witnessWrapper;
            // The witness can query membership but cannot terminate the job.
            if (!DuplicateHandle(GetCurrentProcess(), ownedJob, witness.Handle, out witnessJob, 4, false, 0)) throw new Win32Exception();
            if (!DuplicateHandle(GetCurrentProcess(), GetCurrentProcess(), witness.Handle, out witnessWrapper, 0x00100000, false, 0)) throw new Win32Exception();
            File.WriteAllText(control + ".writing", witnessJob.ToInt64() + " " + witnessWrapper.ToInt64());
            File.Move(control + ".writing", control);
            var deadline = DateTime.UtcNow.AddSeconds(20);
            while (!File.Exists(control + ".ready")) {
                if (witness.HasExited || DateTime.UtcNow > deadline) throw new InvalidOperationException("Job witness did not become ready");
                System.Threading.Thread.Sleep(20);
            }
            File.Delete(control + ".ready");
        }
    }
    // Kept open for this wrapper's lifetime, non-inheritable and never reopened by PID.
    static IntPtr ownedJob;
    static string Quote(string value) {
        var output = new StringBuilder("\"");
        int slashes = 0;
        foreach (char ch in value) {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') { output.Append('\\', slashes * 2 + 1); output.Append(ch); }
            else { output.Append('\\', slashes); output.Append(ch); }
            slashes = 0;
        }
        output.Append('\\', slashes * 2); output.Append('"'); return output.ToString();
    }
    static System.Threading.Tasks.Task Pump(Stream from, Stream to) {
        return System.Threading.Tasks.Task.Factory.StartNew(() => {
            var buffer = new byte[65536];
            int read;
            while ((read = from.Read(buffer, 0, buffer.Length)) > 0) { to.Write(buffer, 0, read); to.Flush(); }
        }, System.Threading.Tasks.TaskCreationOptions.LongRunning);
    }
    public static int Run(string command, string[] args, System.Collections.IDictionary environment) {
        var arguments = new StringBuilder();
        foreach (string arg in args) { if (arguments.Length > 0) arguments.Append(' '); arguments.Append(Quote(arg)); }
        return RunCommandLine(command, arguments.ToString(), environment);
    }
    // For callers that already hold an exact Windows command line (cmd.exe /s /c parses its own quoting).
    public static int RunCommandLine(string command, string commandLine, System.Collections.IDictionary environment) {
        var info = new ProcessStartInfo(command, commandLine);
        info.UseShellExecute = false;
        // The wrapper runs with extra Windows system variables; the child gets exactly the requested environment.
        if (environment != null) {
            info.EnvironmentVariables.Clear();
            foreach (System.Collections.DictionaryEntry entry in environment) info.EnvironmentVariables[(string)entry.Key] = (string)entry.Value;
        }
        info.CreateNoWindow = true;
        // Copy raw streams, bypassing PowerShell's text pipeline and native-stdin policy.
        info.RedirectStandardInput = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        using (var child = Process.Start(info)) {
            // Flush every chunk: the child's stdin FileStream buffers, which would hold back line-delimited requests.
            var input = Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream);
            input.ContinueWith(done => { try { child.StandardInput.Close(); } catch {} var observed = done.Exception; });
            var output = Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput());
            var error = Pump(child.StandardError.BaseStream, Console.OpenStandardError());
            child.WaitForExit();
            StopRemainingMembers();
            System.Threading.Tasks.Task.WaitAll(output, error);
            return child.ExitCode;
        }
    }
    public static bool IsMember(uint pid) {
        if (ownedJob == IntPtr.Zero) return false;
        IntPtr handle = OpenProcess(0x1000, false, pid);
        if (handle == IntPtr.Zero) return false;
        try { bool member; return IsProcessInJob(handle, ownedJob, out member) && member; }
        finally { CloseHandle(handle); }
    }
    public static void StopRemainingMembers() {
        if (ownedJob == IntPtr.Zero) return;
        int size = 65536;
        while (true) {
            IntPtr data = Marshal.AllocHGlobal(size);
            try {
                uint returned;
                if (!QueryInformationJobObject(ownedJob, 3, data, (uint)size, out returned)) {
                    int error = Marshal.GetLastWin32Error();
                    if (error == 234) { size = checked(size * 2); continue; }
                    throw new Win32Exception(error);
                }
                int count = Marshal.ReadInt32(data, 4);
                bool found = false;
                for (int i = 0; i < count; i++) {
                    uint pid = checked((uint)Marshal.ReadIntPtr(data, 8 + i * IntPtr.Size).ToInt64());
                    if (pid == GetCurrentProcessId()) continue;
                    found = true;
                    IntPtr memberHandle = OpenProcess(0x1001, false, pid);
                    if (memberHandle == IntPtr.Zero) {
                        int error = Marshal.GetLastWin32Error();
                        if (error == 87) continue; // Already exited.
                        throw new Win32Exception(error);
                    }
                    try {
                        bool member;
                        if (!IsProcessInJob(memberHandle, ownedJob, out member)) throw new Win32Exception();
                        // Membership and termination use the same handle. A recycled PID outside
                        // this job can never be terminated, including between check and action.
                        if (member && !TerminateProcess(memberHandle, 1)) {
                            int error = Marshal.GetLastWin32Error();
                            if (error != 5) throw new Win32Exception(error); // Exit may already be pending.
                        }
                    } finally { CloseHandle(memberHandle); }
                }
                if (!found) return;
                System.Threading.Thread.Yield();
            } finally { Marshal.FreeHGlobal(data); }
        }
    }
    public static void Attach() {
        if (ownedJob != IntPtr.Zero) return;
        ownedJob = CreateJobObject(IntPtr.Zero, null);
        if (ownedJob == IntPtr.Zero) throw new Win32Exception();
        var limits = new ExtendedLimits();
        limits.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(ownedJob, 9, ref limits, (uint)Marshal.SizeOf(limits))) {
            int error = Marshal.GetLastWin32Error(); CloseHandle(ownedJob); ownedJob = IntPtr.Zero; throw new Win32Exception(error);
        }
        if (!AssignProcessToJobObject(ownedJob, GetCurrentProcess())) {
            int error = Marshal.GetLastWin32Error(); CloseHandle(ownedJob); ownedJob = IntPtr.Zero; throw new Win32Exception(error);
        }
    }
}
"@
# Compiling the helper takes seconds on a cold host and would delay every provider launch; reuse a per-user build
# keyed by the source hash, and fall back to an in-memory compile when the cache cannot be written.
$ownedJobHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($ownedJobSource))).Replace('-', '').Substring(0, 32)
$ownedJobAssembly = Join-Path ([IO.Path]::GetTempPath()) "arena-owned-job-$ownedJobHash.dll"
if (-not (Test-Path -LiteralPath $ownedJobAssembly)) {
	try {
		$ownedJobBuild = "$ownedJobAssembly.$PID.tmp"
		Add-Type -TypeDefinition $ownedJobSource -OutputAssembly $ownedJobBuild -OutputType Library
		try { [IO.File]::Move($ownedJobBuild, $ownedJobAssembly) } catch { Remove-Item -LiteralPath $ownedJobBuild -Force -ErrorAction SilentlyContinue }
	} catch { $ownedJobAssembly = $null }
}
if ($ownedJobAssembly) { Add-Type -LiteralPath $ownedJobAssembly } else { Add-Type -TypeDefinition $ownedJobSource }
if ($LibraryOnly) { return }
if ([string]::IsNullOrWhiteSpace($CommandJson)) { throw "CommandJson is required" }
# Fail closed before executing any workload if job ownership cannot be established.
if ($EvidencePath) { [ArenaOwnedJob]::AttachWithEvidence($EvidencePath, (Join-Path $PSScriptRoot 'owned-job-witness.ps1')) }
else { [ArenaOwnedJob]::Attach() }
$invocation = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($CommandJson)) | ConvertFrom-Json
$ownedCommand = [string]$invocation.command
$ownedArguments = @($invocation.args | ForEach-Object { [string]$_ })
$ownedEnvironment = $null
if ($null -ne $invocation.env) {
	$ownedEnvironment = @{}
	foreach ($variable in $invocation.env.PSObject.Properties) { $ownedEnvironment[$variable.Name] = [string]$variable.Value }
}
if ($null -ne $invocation.PSObject.Properties['commandLine']) {
	exit ([ArenaOwnedJob]::RunCommandLine($ownedCommand, [string]$invocation.commandLine, $ownedEnvironment))
}
exit ([ArenaOwnedJob]::Run($ownedCommand, [string[]]$ownedArguments, $ownedEnvironment))
