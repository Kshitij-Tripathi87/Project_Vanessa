import * as path from "node:path";

/**
 * Windows Job Object wrapper for the registered incident-lab test runner.
 *
 * The requested executable and argv are passed through environment data, never
 * interpolated into PowerShell source. The inner process is created suspended,
 * assigned to a KILL_ON_JOB_CLOSE Job Object, and only then resumed.
 */
export const WINDOWS_JOB_RUNNER_UNVERIFIED_EXIT_CODE = 71;

export const WINDOWS_JOB_RUNNER_SCRIPT = String.raw`$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class VanessaWindowsJobRunner
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint GENERIC_READ = 0x80000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_FAILED = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint infoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, uint infoLength, IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int stdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFile(string name, uint desiredAccess, uint shareMode, ref SECURITY_ATTRIBUTES security, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateProcessW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);

    private static string QuoteArgument(string value)
    {
        if (value == null) value = "";
        bool quote = value.Length == 0;
        for (int i = 0; i < value.Length && !quote; i++)
        {
            char c = value[i];
            if (c == ' ' || c == '\t' || c == '\n' || c == '\v' || c == '"') quote = true;
        }
        if (!quote) return value;

        StringBuilder result = new StringBuilder();
        result.Append('"');
        int slashes = 0;
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if (c == '\\')
            {
                slashes++;
                continue;
            }
            if (c == '"')
            {
                result.Append('\\', slashes * 2 + 1);
                result.Append('"');
                slashes = 0;
                continue;
            }
            if (slashes > 0) result.Append('\\', slashes);
            slashes = 0;
            result.Append(c);
        }
        if (slashes > 0) result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static IntPtr BuildEnvironmentBlock()
    {
        IDictionary source = Environment.GetEnvironmentVariables();
        Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (DictionaryEntry entry in source)
        {
            string key = Convert.ToString(entry.Key);
            string value = Convert.ToString(entry.Value);
            if (String.IsNullOrEmpty(key) || value == null) continue;
            if (key.StartsWith("VANESSA_JOBRUNNER_", StringComparison.OrdinalIgnoreCase)) continue;
            values[key] = value;
        }

        List<string> entries = new List<string>();
        foreach (KeyValuePair<string, string> pair in values) entries.Add(pair.Key + "=" + pair.Value);
        entries.Sort(StringComparer.OrdinalIgnoreCase);
        string block = String.Join("\0", entries.ToArray()) + "\0\0";
        return Marshal.StringToHGlobalUni(block);
    }

    private static int Fail(string message, int exitCode)
    {
        try
        {
            Console.Error.WriteLine("VANESSA_JOB_RUNNER_ERROR: " + message + "; Win32Error=" + Marshal.GetLastWin32Error());
            Console.Error.Flush();
        }
        catch { }
        return exitCode;
    }

    private static bool JobIsEmpty(IntPtr job, int timeoutMs)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        do
        {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
            if (!QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero))
                return false;
            if (info.ActiveProcesses == 0) return true;
            Thread.Sleep(25);
        } while (DateTime.UtcNow < deadline);
        return false;
    }

    public static int Run(string executable, string[] args, string workingDirectory, string runId)
    {
        IntPtr job = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        IntPtr nullInput = IntPtr.Zero;
        PROCESS_INFORMATION processInfo = new PROCESS_INFORMATION();
        bool cancelRequested = false;
        object cancelLock = new object();

        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return Fail("CreateJobObject failed.", 126);

            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int limitsSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr limitsPtr = Marshal.AllocHGlobal(limitsSize);
            try
            {
                Marshal.StructureToPtr(limits, limitsPtr, false);
                if (!SetInformationJobObject(job, 9, limitsPtr, (uint)limitsSize)) return Fail("SetInformationJobObject failed.", 126);
            }
            finally
            {
                Marshal.FreeHGlobal(limitsPtr);
            }

            // The test runner must not share the cancellation input pipe.
            Thread cancelReader = new Thread(delegate()
            {
                try
                {
                    string line;
                    while ((line = Console.In.ReadLine()) != null)
                    {
                        if (line == "CANCEL:" + runId)
                        {
                            lock (cancelLock) cancelRequested = true;
                            return;
                        }
                    }
                }
                catch { }
            });
            cancelReader.IsBackground = true;
            cancelReader.Start();

            lock (cancelLock)
            {
                if (cancelRequested) return 130;
                // Launch may proceed only after this cancellation check.
            }

            SECURITY_ATTRIBUTES nullSecurity = new SECURITY_ATTRIBUTES();
            nullSecurity.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            nullSecurity.bInheritHandle = true;
            nullInput = CreateFile("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, ref nullSecurity, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
            if (nullInput == IntPtr.Zero || nullInput == new IntPtr(-1)) return Fail("CreateFile(NUL) failed.", 126);

            IntPtr stdIn = GetStdHandle(-10);
            IntPtr stdOut = GetStdHandle(-11);
            IntPtr stdErr = GetStdHandle(-12);
            if (stdIn != IntPtr.Zero && stdIn != new IntPtr(-1)) SetHandleInformation(stdIn, HANDLE_FLAG_INHERIT, 0);
            if (stdOut != IntPtr.Zero && stdOut != new IntPtr(-1)) SetHandleInformation(stdOut, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
            if (stdErr != IntPtr.Zero && stdErr != new IntPtr(-1)) SetHandleInformation(stdErr, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);

            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = nullInput;
            startup.hStdOutput = stdOut;
            startup.hStdError = stdErr;

            StringBuilder commandLine = new StringBuilder(QuoteArgument(executable));
            if (args != null)
            {
                for (int i = 0; i < args.Length; i++)
                {
                    commandLine.Append(' ');
                    commandLine.Append(QuoteArgument(args[i]));
                }
            }

            environment = BuildEnvironmentBlock();
            bool created = CreateProcess(executable, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                environment, workingDirectory, ref startup, out processInfo);
            if (!created) return Fail("CreateProcess for the registered runner failed.", 126);


            if (!AssignProcessToJobObject(job, processInfo.hProcess))
            {
                TerminateProcess(processInfo.hProcess, 126);
                WaitForSingleObject(processInfo.hProcess, 3000);
                return Fail("AssignProcessToJobObject failed.", 126);
            }


            lock (cancelLock)
            {
                if (cancelRequested)
                {
                    TerminateJobObject(job, 130);
                    return JobIsEmpty(job, 3000) ? 130 : 71;
                }
            }

            uint resumed = ResumeThread(processInfo.hThread);
            if (resumed == 0xFFFFFFFF)
            {
                TerminateJobObject(job, 126);
                return JobIsEmpty(job, 3000) ? Fail("ResumeThread failed.", 126) : Fail("ResumeThread failed and job emptiness could not be verified.", 71);
            }

            Console.Error.WriteLine("VANESSA_JOB_RUNNER_STARTED:" + runId);
            while (true)
            {
                lock (cancelLock)
                {
                    if (cancelRequested)
                    {
                        TerminateJobObject(job, 130);
                        return JobIsEmpty(job, 3000) ? 130 : 71;
                    }
                }
                uint waitResult = WaitForSingleObject(processInfo.hProcess, 50);
                if (waitResult == WAIT_OBJECT_0) break;
                if (waitResult == WAIT_FAILED)
                {
                    TerminateJobObject(job, 71);
                    return JobIsEmpty(job, 3000) ? 71 : 71;
                }
            }

            uint childExitCode;
            if (!GetExitCodeProcess(processInfo.hProcess, out childExitCode)) return Fail("GetExitCodeProcess failed.", 71);
            if (!JobIsEmpty(job, 1200))
            {
                // The root runner exited while one or more descendants remained.
                // Terminate those descendants and return a non-zero result; a
                // successful test run is never reported from a dirty job.
                if (!TerminateJobObject(job, 70)) return Fail("TerminateJobObject failed for surviving descendants.", 71);
                if (!JobIsEmpty(job, 3000)) return Fail("Job Object remained non-empty after termination escalation.", 71);
                return 70;
            }
            return unchecked((int)childExitCode);
        }
        catch (Exception error)
        {
            try { Console.Error.WriteLine("VANESSA_JOB_RUNNER_EXCEPTION: " + error.GetType().FullName + ": " + error.Message); Console.Error.Flush(); } catch { }
            if (job != IntPtr.Zero)
            {
                try { TerminateJobObject(job, 71); } catch { }
                try { JobIsEmpty(job, 3000); } catch { }
            }
            return 71;
        }
        finally
        {
            // KILL_ON_JOB_CLOSE is the OS-level backstop if wrapper failure or
            // external termination interrupts the verification handshake.
            if (job != IntPtr.Zero) CloseHandle(job);
            if (processInfo.hThread != IntPtr.Zero) CloseHandle(processInfo.hThread);
            if (processInfo.hProcess != IntPtr.Zero) CloseHandle(processInfo.hProcess);
            if (nullInput != IntPtr.Zero && nullInput != new IntPtr(-1)) CloseHandle(nullInput);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
        }
    }
}
'@
$rawArgs = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:VANESSA_JOBRUNNER_ARGS_B64))
$childArgs = @(ConvertFrom-Json -InputObject $rawArgs)
$exitCode = [VanessaWindowsJobRunner]::Run(
  $env:VANESSA_JOBRUNNER_EXECUTABLE,
  [string[]]$childArgs,
  $env:VANESSA_JOBRUNNER_CWD,
  $env:VANESSA_JOBRUNNER_RUN_ID
)
exit $exitCode
`;

export function buildWindowsJobRunnerEnvironment(
  executable: string,
  args: string[],
  cwd: string,
  runId: string,
): Record<string, string> {
  if (!executable || !executable.trim()) throw new Error("A child executable is required.");
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("Windows Job Object runner args must be a string array.");
  }
  if (!cwd || !path.isAbsolute(cwd)) throw new Error("Windows Job Object runner cwd must be absolute.");
  if (!runId || !/^[a-zA-Z0-9-]{1,80}$/.test(runId)) throw new Error("Invalid managed run ID.");
  return {
    VANESSA_JOBRUNNER_EXECUTABLE: executable,
    VANESSA_JOBRUNNER_ARGS_B64: Buffer.from(JSON.stringify(args), "utf8").toString("base64"),
    VANESSA_JOBRUNNER_CWD: cwd,
    VANESSA_JOBRUNNER_RUN_ID: runId,
  };
}
