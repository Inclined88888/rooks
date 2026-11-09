"""Windows processes for the Room (design 0011, sections 1 and 3): jobs, ConPTY terminals and CreateProcessW.

Pure ctypes, so there is no wheel to freeze: the app imports rooks_try, and the desktop sidecar bundles it.

- `Job`: a Windows job object, kill on close and never a breakaway flag. Every process in it ends when the job is ended
  (`terminate`) or its last handle closes. `pids()` lists what is in it (busy means a program other than the shell).
- `spawn(argv, env, cwd, jobs=..., conpty=...)`: CreateProcessW with one attribute list holding the job list, the
  handles the child may inherit (exactly those, never the rest of a threaded server's) and, for a terminal, the
  pseudo console. The process is in its job from its first instruction, so nothing it starts can slip out first. We do
  not use pywinpty: it creates the process itself, so the shell could start children before it joins a job.
- `ConPty`: two pipes and a pseudo console. `Terminal` puts a shell on one, in a job of its own.
- `MarkPipe`: a named pipe only the person can open, the side channel a Room shell writes its exit code to after each
  command when ConPTY drops the in-band marker (it re-renders the screen and drops escape sequences it does not know).

Importable everywhere; everything that touches Windows raises `OSError` elsewhere.
"""

from __future__ import annotations

import os
import re
import struct
import subprocess
import sys
import threading
import time
import uuid

WINDOWS = os.name == "nt"  # the real system, not sys.platform (tests set that to see Windows words)
TOO_OLD = "This version of Windows is too old for terminals in the Room."
HUNG_UP = 129  # what a hung-up shell shows, as on POSIX (128 + SIGHUP)
STILL_ACTIVE = 259
STATUS_CONTROL_C_EXIT = 0xC000013A

PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x20002
PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x2000D
PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x20016
EXTENDED_STARTUPINFO_PRESENT = 0x00080000
CREATE_UNICODE_ENVIRONMENT = 0x00000400
CREATE_NO_WINDOW = 0x08000000
STARTF_USESTDHANDLES = 0x00000100
JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x00000800          # never set
JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x00001000   # never set
JobObjectBasicProcessIdList = 3
JobObjectBasicUIRestrictions = 4
JobObjectExtendedLimitInformation = 9
ERROR_BROKEN_PIPE = 109
ERROR_MORE_DATA = 234
ERROR_PIPE_CONNECTED = 535
ERROR_NO_DATA = 232
WAIT_OBJECT_0 = 0
# The C runtime's descriptor flags in STARTUPINFO.lpReserved2 (how Chromium finds --remote-debugging-pipe at fds 3, 4)
FOPEN = 0x01
FPIPE = 0x08
FDEV = 0x40
# JOB_OBJECT_UILIMIT_*: what a Room job's programs may not touch outside the job (design 0011, section 3)
UILIMIT_HANDLES = 0x01
UILIMIT_READCLIPBOARD = 0x02
UILIMIT_WRITECLIPBOARD = 0x04
UILIMIT_SYSTEMPARAMETERS = 0x08
UILIMIT_DISPLAYSETTINGS = 0x10
UILIMIT_GLOBALATOMS = 0x20
UILIMIT_DESKTOP = 0x40
UILIMIT_EXITWINDOWS = 0x80
WAIT_TIMEOUT = 0x102
INFINITE = 0xFFFFFFFF

if WINDOWS:  # pragma: no cover - exercised by the Windows jobs in CI
    import ctypes
    from ctypes import wintypes as wt

    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _adv = ctypes.WinDLL("advapi32", use_last_error=True)
    HANDLE = wt.HANDLE
    DWORD = wt.DWORD
    BOOL = wt.BOOL
    SIZE_T = ctypes.c_size_t
    LPVOID = ctypes.c_void_p
    INVALID_HANDLE = ctypes.c_void_p(-1).value

    class COORD(ctypes.Structure):
        _fields_ = [("X", ctypes.c_short), ("Y", ctypes.c_short)]

    class STARTUPINFOW(ctypes.Structure):
        _fields_ = [("cb", DWORD), ("lpReserved", wt.LPWSTR), ("lpDesktop", wt.LPWSTR), ("lpTitle", wt.LPWSTR),
                    ("dwX", DWORD), ("dwY", DWORD), ("dwXSize", DWORD), ("dwYSize", DWORD),
                    ("dwXCountChars", DWORD), ("dwYCountChars", DWORD), ("dwFillAttribute", DWORD),
                    ("dwFlags", DWORD), ("wShowWindow", wt.WORD), ("cbReserved2", wt.WORD),
                    ("lpReserved2", LPVOID), ("hStdInput", HANDLE), ("hStdOutput", HANDLE), ("hStdError", HANDLE)]

    class STARTUPINFOEXW(ctypes.Structure):
        _fields_ = [("StartupInfo", STARTUPINFOW), ("lpAttributeList", LPVOID)]

    class PROCESS_INFORMATION(ctypes.Structure):
        _fields_ = [("hProcess", HANDLE), ("hThread", HANDLE), ("dwProcessId", DWORD), ("dwThreadId", DWORD)]

    class SECURITY_ATTRIBUTES(ctypes.Structure):
        _fields_ = [("nLength", DWORD), ("lpSecurityDescriptor", LPVOID), ("bInheritHandle", BOOL)]

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [(n, ctypes.c_ulonglong) for n in ("ReadOperationCount", "WriteOperationCount",
                                                      "OtherOperationCount", "ReadTransferCount",
                                                      "WriteTransferCount", "OtherTransferCount")]

    class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", DWORD), ("MinimumWorkingSetSize", SIZE_T), ("MaximumWorkingSetSize", SIZE_T),
                    ("ActiveProcessLimit", DWORD), ("Affinity", SIZE_T), ("PriorityClass", DWORD),
                    ("SchedulingClass", DWORD)]

    class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION), ("IoInfo", IO_COUNTERS),
                    ("ProcessMemoryLimit", SIZE_T), ("JobMemoryLimit", SIZE_T), ("PeakProcessMemoryUsed", SIZE_T),
                    ("PeakJobMemoryUsed", SIZE_T)]

    class _MemCounters(ctypes.Structure):  # PROCESS_MEMORY_COUNTERS
        _fields_ = [("cb", DWORD), ("PageFaultCount", DWORD), ("PeakWorkingSetSize", SIZE_T),
                    ("WorkingSetSize", SIZE_T), ("QuotaPeakPagedPoolUsage", SIZE_T), ("QuotaPagedPoolUsage", SIZE_T),
                    ("QuotaPeakNonPagedPoolUsage", SIZE_T), ("QuotaNonPagedPoolUsage", SIZE_T),
                    ("PagefileUsage", SIZE_T), ("PeakPagefileUsage", SIZE_T)]

    class JOBOBJECT_BASIC_UI_RESTRICTIONS(ctypes.Structure):
        _fields_ = [("UIRestrictionsClass", DWORD)]

    def _fn(dll, name, res, *args, optional=False):
        try:
            f = getattr(dll, name)
        except AttributeError:
            if optional:
                return None
            raise
        f.restype = res
        f.argtypes = list(args)
        return f

    CloseHandle = _fn(_k32, "CloseHandle", BOOL, HANDLE)
    CreatePipe = _fn(_k32, "CreatePipe", BOOL, ctypes.POINTER(HANDLE), ctypes.POINTER(HANDLE), LPVOID, DWORD)
    ReadFile = _fn(_k32, "ReadFile", BOOL, HANDLE, LPVOID, DWORD, ctypes.POINTER(DWORD), LPVOID)
    WriteFile = _fn(_k32, "WriteFile", BOOL, HANDLE, LPVOID, DWORD, ctypes.POINTER(DWORD), LPVOID)
    InitializeProcThreadAttributeList = _fn(_k32, "InitializeProcThreadAttributeList", BOOL, LPVOID, DWORD, DWORD,
                                            ctypes.POINTER(SIZE_T))
    UpdateProcThreadAttribute = _fn(_k32, "UpdateProcThreadAttribute", BOOL, LPVOID, DWORD, SIZE_T, LPVOID, SIZE_T,
                                    LPVOID, LPVOID)
    DeleteProcThreadAttributeList = _fn(_k32, "DeleteProcThreadAttributeList", None, LPVOID)
    CreateProcessW = _fn(_k32, "CreateProcessW", BOOL, wt.LPCWSTR, LPVOID, LPVOID, LPVOID, BOOL, DWORD, LPVOID,
                         wt.LPCWSTR, LPVOID, ctypes.POINTER(PROCESS_INFORMATION))
    WaitForSingleObject = _fn(_k32, "WaitForSingleObject", DWORD, HANDLE, DWORD)
    GetExitCodeProcess = _fn(_k32, "GetExitCodeProcess", BOOL, HANDLE, ctypes.POINTER(DWORD))
    TerminateProcess = _fn(_k32, "TerminateProcess", BOOL, HANDLE, wt.UINT)
    OpenProcess = _fn(_k32, "OpenProcess", HANDLE, DWORD, BOOL, DWORD)
    GetCurrentProcess = _fn(_k32, "GetCurrentProcess", HANDLE)
    CreateJobObjectW = _fn(_k32, "CreateJobObjectW", HANDLE, LPVOID, wt.LPCWSTR)
    SetInformationJobObject = _fn(_k32, "SetInformationJobObject", BOOL, HANDLE, ctypes.c_int, LPVOID, DWORD)
    QueryInformationJobObject = _fn(_k32, "QueryInformationJobObject", BOOL, HANDLE, ctypes.c_int, LPVOID, DWORD,
                                    ctypes.POINTER(DWORD))
    TerminateJobObject = _fn(_k32, "TerminateJobObject", BOOL, HANDLE, wt.UINT)
    AssignProcessToJobObject = _fn(_k32, "AssignProcessToJobObject", BOOL, HANDLE, HANDLE)
    IsProcessInJob = _fn(_k32, "IsProcessInJob", BOOL, HANDLE, HANDLE, ctypes.POINTER(BOOL))
    CreatePseudoConsole = _fn(_k32, "CreatePseudoConsole", ctypes.c_long, COORD, HANDLE, HANDLE, DWORD,
                              ctypes.POINTER(LPVOID), optional=True)
    ResizePseudoConsole = _fn(_k32, "ResizePseudoConsole", ctypes.c_long, LPVOID, COORD, optional=True)
    ClosePseudoConsole = _fn(_k32, "ClosePseudoConsole", None, LPVOID, optional=True)
    CreateNamedPipeW = _fn(_k32, "CreateNamedPipeW", HANDLE, wt.LPCWSTR, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD,
                           LPVOID)
    ConnectNamedPipe = _fn(_k32, "ConnectNamedPipe", BOOL, HANDLE, LPVOID)
    DisconnectNamedPipe = _fn(_k32, "DisconnectNamedPipe", BOOL, HANDLE)
    CreateFileW = _fn(_k32, "CreateFileW", HANDLE, wt.LPCWSTR, DWORD, DWORD, LPVOID, DWORD, DWORD, HANDLE)
    LocalFree = _fn(_k32, "LocalFree", LPVOID, LPVOID)
    OpenProcessToken = _fn(_adv, "OpenProcessToken", BOOL, HANDLE, DWORD, ctypes.POINTER(HANDLE))
    GetTokenInformation = _fn(_adv, "GetTokenInformation", BOOL, HANDLE, ctypes.c_int, LPVOID, DWORD,
                              ctypes.POINTER(DWORD))
    ConvertSidToStringSidW = _fn(_adv, "ConvertSidToStringSidW", BOOL, LPVOID, ctypes.POINTER(wt.LPWSTR))
    K32GetProcessMemoryInfo = _fn(_k32, "K32GetProcessMemoryInfo", BOOL, HANDLE, LPVOID, DWORD, optional=True)
    _iphlp = ctypes.WinDLL("iphlpapi", use_last_error=True)
    GetExtendedTcpTable = _fn(_iphlp, "GetExtendedTcpTable", DWORD, LPVOID, ctypes.POINTER(DWORD), BOOL, wt.ULONG,
                              ctypes.c_int, wt.ULONG)
    ConvertSDDL = _fn(_adv, "ConvertStringSecurityDescriptorToSecurityDescriptorW", BOOL, wt.LPCWSTR, DWORD,
                      ctypes.POINTER(LPVOID), LPVOID)


def _need_windows() -> None:
    if not WINDOWS:
        raise OSError("Windows only")


def _err(what: str) -> OSError:
    code = ctypes.get_last_error()
    return OSError(code, f"{what} failed ({code})")


def _ok_handle(h) -> bool:
    return h not in (None, 0, INVALID_HANDLE)


def _close(h) -> None:
    if _ok_handle(h):
        CloseHandle(h)


def conpty_available() -> bool:
    """Whether this Windows has pseudo consoles (Windows 10 1809 and later)."""
    return WINDOWS and CreatePseudoConsole is not None and ClosePseudoConsole is not None


# --- jobs ------------------------------------------------------------------------------------------------------------------
class Job:
    """A job object. Kill on close; breakaway is never allowed, so nothing in it can leave it. Optional: a memory limit
    for the whole job and UI limits (JOB_OBJECT_UILIMIT_* flags)."""

    def __init__(self, memory_limit: int | None = None, ui_limits: int = 0) -> None:
        _need_windows()
        self.handle = CreateJobObjectW(None, None)
        if not _ok_handle(self.handle):
            raise _err("CreateJobObjectW")
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if memory_limit:
            info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY
            info.JobMemoryLimit = int(memory_limit)
        if not SetInformationJobObject(self.handle, JobObjectExtendedLimitInformation, ctypes.byref(info),
                                       ctypes.sizeof(info)):
            err = _err("SetInformationJobObject")
            self.close()
            raise err
        if ui_limits:
            ui = JOBOBJECT_BASIC_UI_RESTRICTIONS(int(ui_limits))
            if not SetInformationJobObject(self.handle, JobObjectBasicUIRestrictions, ctypes.byref(ui),
                                           ctypes.sizeof(ui)):
                err = _err("SetInformationJobObject (UI limits)")
                self.close()
                raise err
        self._lock = threading.Lock()

    def limit_flags(self) -> int:
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        if not QueryInformationJobObject(self.handle, JobObjectExtendedLimitInformation, ctypes.byref(info),
                                         ctypes.sizeof(info), None):
            raise _err("QueryInformationJobObject")
        return int(info.BasicLimitInformation.LimitFlags)

    def pids(self) -> list[int]:
        """The processes in this job now (nested jobs' included)."""
        h = self.handle
        if not _ok_handle(h):
            return []
        n = 64
        while n <= 65536:
            class _List(ctypes.Structure):
                _fields_ = [("Assigned", DWORD), ("InList", DWORD), ("Ids", SIZE_T * n)]

            lst = _List()
            if QueryInformationJobObject(h, JobObjectBasicProcessIdList, ctypes.byref(lst), ctypes.sizeof(lst), None):
                return [int(p) for p in lst.Ids[: lst.InList]]
            if ctypes.get_last_error() != ERROR_MORE_DATA:
                return []
            n *= 4
        return []

    def memory(self) -> int:
        """The working set of every process in this job now, in bytes (what the memory watchdog reads on Windows). A
        process that cannot be opened is left out."""
        if K32GetProcessMemoryInfo is None:
            return 0
        total = 0
        for pid in self.pids():
            h = OpenProcess(0x1000 | 0x0010, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ
            if not _ok_handle(h):
                h = OpenProcess(0x1000, False, pid)
            if not _ok_handle(h):
                continue
            try:
                counters = _MemCounters()
                counters.cb = ctypes.sizeof(counters)
                if K32GetProcessMemoryInfo(h, ctypes.byref(counters), ctypes.sizeof(counters)):
                    total += int(counters.WorkingSetSize)
            finally:
                CloseHandle(h)
        return total

    def contains(self, process_handle) -> bool:
        inside = BOOL(False)
        if not IsProcessInJob(process_handle, self.handle, ctypes.byref(inside)):
            raise _err("IsProcessInJob")
        return bool(inside.value)

    def holds(self, pid: int) -> bool | None:
        """Whether the process with this id is in this job now (None when it has ended or cannot be opened)."""
        h = OpenProcess(0x1000, False, int(pid))  # PROCESS_QUERY_LIMITED_INFORMATION
        if not _ok_handle(h):
            return None
        try:
            return self.contains(h)
        except OSError:
            return None
        finally:
            CloseHandle(h)

    def terminate(self, code: int = HUNG_UP) -> None:
        h = self.handle
        if _ok_handle(h):
            TerminateJobObject(h, int(code))

    def close(self) -> None:
        """Close our handle: with kill on close, whatever is still in the job ends now."""
        h, self.handle = getattr(self, "handle", None), None
        _close(h)


# --- processes -------------------------------------------------------------------------------------------------------------
class Process:
    """A process spawn() started: Popen's pid, poll, wait, returncode and kill. The exit code is Windows' own DWORD."""

    def __init__(self, handle, pid: int) -> None:
        self.handle = handle
        self.pid = int(pid)
        self.returncode: int | None = None

    def poll(self) -> int | None:
        if self.returncode is None and _ok_handle(self.handle):
            if WaitForSingleObject(self.handle, 0) == WAIT_OBJECT_0:
                code = DWORD(0)
                if GetExitCodeProcess(self.handle, ctypes.byref(code)):
                    self.returncode = int(code.value)
        return self.returncode

    def wait(self, timeout: float | None = None) -> int:
        if self.returncode is None and _ok_handle(self.handle):
            ms = INFINITE if timeout is None else max(0, int(timeout * 1000))
            if WaitForSingleObject(self.handle, ms) == WAIT_TIMEOUT:
                raise subprocess.TimeoutExpired(str(self.pid), timeout or 0)
        code = self.poll()
        return -1 if code is None else code

    def kill(self, code: int = 1) -> None:
        if self.returncode is None and _ok_handle(self.handle):
            TerminateProcess(self.handle, int(code))

    def close(self) -> None:
        h, self.handle = self.handle, None
        _close(h)


def _env_block(env: dict[str, str]):
    items = sorted(((str(k), str(v)) for k, v in env.items() if k and "=" not in str(k)[1:] and "\0" not in str(v)),
                   key=lambda kv: kv[0].upper())
    text = "".join(f"{k}={v}\0" for k, v in items) + "\0"
    return (ctypes.c_wchar * len(text))(*text)


def spawn(argv: list[str], env: dict[str, str] | None = None, cwd: str | None = None, *, jobs: tuple | list = (),
          conpty: "ConPty | None" = None, inherit: tuple | list = (), flags: int = 0,
          std: tuple | None = None, crt_block: bytes | None = None) -> Process:
    """CreateProcessW with one attribute list: the job list (in that order, so a later job nests in an earlier one),
    exactly the handles `inherit` names, and the pseudo console. With a pseudo console the standard handles are set to
    nothing, so a parent whose own output is redirected does not pass its pipes in place of the console."""
    _need_windows()
    count = (1 if jobs else 0) + (1 if inherit else 0) + (1 if conpty is not None else 0)
    size = SIZE_T(0)
    InitializeProcThreadAttributeList(None, max(count, 1), 0, ctypes.byref(size))
    attrs = ctypes.create_string_buffer(max(size.value, 64))
    if not InitializeProcThreadAttributeList(attrs, max(count, 1), 0, ctypes.byref(size)):
        raise _err("InitializeProcThreadAttributeList")
    keep: list = []
    try:
        if jobs:
            arr = (HANDLE * len(jobs))(*[j.handle for j in jobs])
            keep.append(arr)
            if not UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, ctypes.cast(arr, LPVOID),
                                             ctypes.sizeof(arr), None, None):
                raise _err("UpdateProcThreadAttribute (jobs)")
        if inherit:
            inherit = list(dict.fromkeys(int(h) for h in inherit))  # a handle listed twice fails CreateProcessW
            arr = (HANDLE * len(inherit))(*inherit)
            keep.append(arr)
            if not UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, ctypes.cast(arr, LPVOID),
                                             ctypes.sizeof(arr), None, None):
                raise _err("UpdateProcThreadAttribute (handles)")
        if conpty is not None:  # the value is the pseudo console handle itself, not a pointer to it
            if not UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, conpty.hpc,
                                             ctypes.sizeof(LPVOID), None, None):
                raise _err("UpdateProcThreadAttribute (pseudo console)")
        si = STARTUPINFOEXW()
        si.StartupInfo.cb = ctypes.sizeof(STARTUPINFOEXW)
        si.lpAttributeList = ctypes.cast(attrs, LPVOID)
        if conpty is not None or std is not None:
            si.StartupInfo.dwFlags |= STARTF_USESTDHANDLES
            if std is not None:
                si.StartupInfo.hStdInput, si.StartupInfo.hStdOutput, si.StartupInfo.hStdError = std
        if crt_block is not None:
            block = ctypes.create_string_buffer(crt_block, len(crt_block))
            keep.append(block)
            si.StartupInfo.cbReserved2 = len(crt_block)
            si.StartupInfo.lpReserved2 = ctypes.cast(block, LPVOID)
        cmd = ctypes.create_unicode_buffer(subprocess.list2cmdline([str(a) for a in argv]))
        block_env = _env_block(env if env is not None else dict(os.environ))
        pi = PROCESS_INFORMATION()
        ok = CreateProcessW(None, ctypes.cast(cmd, LPVOID), None, None, bool(inherit),
                            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | int(flags),
                            ctypes.cast(block_env, LPVOID), cwd, ctypes.byref(si), ctypes.byref(pi))
        if not ok:
            raise _err("CreateProcessW")
        _close(pi.hThread)
        return Process(pi.hProcess, pi.dwProcessId)
    finally:
        DeleteProcThreadAttributeList(attrs)


# --- the C runtime's descriptors, and a browser on its pipe ------------------------------------------------------------
def crt_block(entries, pointer: int | None = None) -> bytes:
    """STARTUPINFO.lpReserved2 as the C runtime reads it at startup to rebuild its descriptors (what Node does to give
    Puppeteer a browser's pipe): an int count, then one flag byte per descriptor, then one HANDLE per descriptor, with
    no padding between them. `entries` is (flags, handle) for fds 0, 1, 2, ... in order."""
    pointer = pointer or struct.calcsize("P")
    entries = [(int(f), int(h)) for f, h in entries]
    return (struct.pack("<i", len(entries)) + bytes(f & 0xFF for f, _ in entries)
            + b"".join((h & ((1 << (8 * pointer)) - 1)).to_bytes(pointer, "little") for _, h in entries))


class PipedProcess:
    """A program started with the DevTools pipe at C runtime fds 3 (it reads) and 4 (it writes), NUL at 0 and 1, a pipe
    for what it prints at 2, in `job` from its first instruction and inheriting nothing else. `rfd` and `wfd` are our
    ends as C runtime descriptors (os.read and os.write work on them); `err` is the read end of its output."""

    def __init__(self, argv: list[str], env: dict[str, str], cwd: str, job: Job, flags: int = CREATE_NO_WINDOW) -> None:
        _need_windows()
        import msvcrt

        to_r, to_w = os.pipe()
        fr_r, fr_w = os.pipe()
        err_r, err_w = os.pipe()
        nul = os.open(os.devnull, os.O_RDWR)
        theirs = (nul, to_r, fr_w, err_w)
        try:
            h = {fd: msvcrt.get_osfhandle(fd) for fd in theirs}
            for handle in h.values():
                os.set_handle_inheritable(handle, True)
            block = crt_block([(FOPEN | FDEV, h[nul]), (FOPEN | FDEV, h[nul]), (FOPEN | FPIPE, h[err_w]),
                               (FOPEN | FPIPE, h[to_r]), (FOPEN | FPIPE, h[fr_w])])
            self.proc = spawn(argv, env, cwd, jobs=[job], inherit=list(h.values()), flags=flags,
                              std=(h[nul], h[nul], h[err_w]), crt_block=block)
        except BaseException:
            for fd in (to_w, fr_r, err_r):
                os.close(fd)
            raise
        finally:
            for fd in theirs:  # the child has its own copies now; ours would keep the pipes open forever
                try:
                    os.close(fd)
                except OSError:
                    pass
        self.rfd, self.wfd, self.err = fr_r, to_w, err_r
        self.pid = self.proc.pid


TCP_LISTEN = 2


def _listeners(family: int) -> list[tuple[int, int]]:
    """(port, owning pid) of every listening TCP socket of one address family (GetExtendedTcpTable)."""
    size = DWORD(0)
    GetExtendedTcpTable(None, ctypes.byref(size), False, family, 3, 0)  # TCP_TABLE_OWNER_PID_LISTENER
    for _ in range(4):
        buf = ctypes.create_string_buffer(max(size.value, 4) + 4096)
        size = DWORD(len(buf))
        rc = GetExtendedTcpTable(buf, ctypes.byref(size), False, family, 3, 0)
        if rc == 0:
            break
        if rc != 122:  # ERROR_INSUFFICIENT_BUFFER: the table grew, try again
            return []
    else:
        return []
    raw = buf.raw
    (n,) = struct.unpack_from("<I", raw, 0)
    out = []
    if family == 2:  # MIB_TCPROW_OWNER_PID: state, local addr, local port, remote addr, remote port, pid
        for i in range(n):
            state, _la, lport, _ra, _rp, pid = struct.unpack_from("<6I", raw, 4 + 24 * i)
            out.append((((lport & 0xFF) << 8) | ((lport >> 8) & 0xFF), pid))
    else:  # MIB_TCP6ROW_OWNER_PID: local addr[16], scope, port, remote addr[16], scope, port, state, pid
        for i in range(n):
            lport, = struct.unpack_from("<I", raw, 4 + 56 * i + 20)
            pid, = struct.unpack_from("<I", raw, 4 + 56 * i + 52)
            out.append((((lport & 0xFF) << 8) | ((lport >> 8) & 0xFF), pid))
    return out


def listening_ports(pids) -> set[int]:
    """The TCP ports that any of these processes listens on (IPv4 and IPv6)."""
    _need_windows()
    want = {int(p) for p in pids}
    return {port for family in (2, 23) for port, pid in _listeners(family) if pid in want}


# --- pseudo consoles -------------------------------------------------------------------------------------------------------
def _coord(cols: int, rows: int):
    return COORD(max(2, min(int(cols), 1000)), max(2, min(int(rows), 500)))


class ConPty:
    """A pseudo console on two pipes. We write the shell's input to `_in` and read its screen from `_out`; the far ends
    are the console's and our copies of them are closed at once."""

    def __init__(self, cols: int = 80, rows: int = 24) -> None:
        if not conpty_available():
            raise OSError(TOO_OLD)
        in_r, in_w, out_r, out_w = HANDLE(), HANDLE(), HANDLE(), HANDLE()
        if not CreatePipe(ctypes.byref(in_r), ctypes.byref(in_w), None, 0):
            raise _err("CreatePipe")
        if not CreatePipe(ctypes.byref(out_r), ctypes.byref(out_w), None, 0):
            err = _err("CreatePipe")
            _close(in_r.value), _close(in_w.value)
            raise err
        hpc = LPVOID()
        hr = CreatePseudoConsole(_coord(cols, rows), in_r, out_w, 0, ctypes.byref(hpc))
        _close(in_r.value)
        _close(out_w.value)
        if hr != 0:
            _close(in_w.value), _close(out_r.value)
            raise OSError(hr & 0xFFFFFFFF, f"CreatePseudoConsole failed (0x{hr & 0xFFFFFFFF:08x})")
        self.hpc = hpc.value
        self._in = in_w.value
        self._out = out_r.value
        self._lock = threading.Lock()

    def read(self, n: int = 65536) -> bytes:
        """What the console drew next; b"" once it is closed (the read end saw a broken pipe). Blocks."""
        h = self._out
        if not _ok_handle(h):
            return b""
        buf = ctypes.create_string_buffer(n)
        while True:
            got = DWORD(0)
            if not ReadFile(h, buf, n, ctypes.byref(got), None):
                return b""
            if got.value:  # a successful read of nothing is not the end: read again
                return buf.raw[: got.value]

    def write(self, data: bytes) -> None:
        h = self._in
        view = memoryview(bytes(data))
        while view:
            if not _ok_handle(h):
                raise OSError(ERROR_BROKEN_PIPE, "The terminal has ended")
            chunk = bytes(view[:65536])
            done = DWORD(0)
            if not WriteFile(h, chunk, len(chunk), ctypes.byref(done), None):
                raise _err("WriteFile")
            view = view[done.value:]

    def resize(self, cols: int, rows: int) -> None:
        with self._lock:
            if self.hpc:
                ResizePseudoConsole(self.hpc, _coord(cols, rows))

    def close_console(self) -> None:
        """ClosePseudoConsole: the console sends its clients CTRL_CLOSE_EVENT and exits, and the read end then sees a
        broken pipe. Older builds block here until the output is read, so the reader keeps draining meanwhile."""
        with self._lock:
            hpc, self.hpc = self.hpc, None
        if hpc:
            ClosePseudoConsole(hpc)

    def close_pipes(self) -> None:
        """Our pipe ends, once the reader has seen the end (closing a handle under a blocked read can hang)."""
        i, self._in = self._in, None
        o, self._out = self._out, None
        _close(i)
        _close(o)


# What a console draws that is not text: escape sequences (CSI, OSC to its end, two byte escapes)
_NOT_TEXT = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[ -~]|[\x00-\x20]")


class Terminal:
    """A shell on a pseudo console, in a job of its own (nested in `parent` when given). `end()` hangs it up: the
    console is closed on a worker thread while the reader drains, and after `grace` seconds whatever is left in the job
    is ended with code 129.

    A size asked for while the shell is still starting can be lost (seen on windows-2022: a page's first resize, sent
    as the shell started, left PowerShell at 80 columns). So the last size asked for is given again once the shell
    first draws text of its own."""

    def __init__(self, argv: list[str], env: dict[str, str], cwd: str, cols: int = 80, rows: int = 24,
                 parent: Job | None = None) -> None:
        self.job = Job()
        try:
            self.pty = ConPty(cols, rows)
        except OSError:
            self.job.close()
            raise
        try:
            self.proc = spawn(argv, env, cwd, jobs=[parent, self.job] if parent is not None else [self.job],
                              conpty=self.pty)
        except OSError:
            self.pty.close_console()
            self.pty.close_pipes()
            self.job.close()
            raise
        self.pid = self.proc.pid
        self._closer: threading.Thread | None = None
        self._asked: tuple[int, int] | None = None  # the last size asked for
        self._drawn = False                          # the shell has drawn text of its own

    def read(self, n: int = 65536) -> bytes:
        data = self.pty.read(n)
        if data and not self._drawn and _NOT_TEXT.sub(b"", data):
            self._drawn = True
            asked = self._asked
            if asked is not None:
                self.pty.resize(*asked)
        return data

    def write(self, data: bytes) -> None:
        self.pty.write(data)

    def resize(self, cols: int, rows: int) -> None:
        self._asked = (int(cols), int(rows))
        self.pty.resize(cols, rows)

    def pids(self) -> list[int]:
        return self.job.pids()

    def close_console_async(self) -> None:
        if self._closer is None:
            self._closer = threading.Thread(target=self.pty.close_console, name="conpty-close", daemon=True)
            self._closer.start()

    def end(self, grace: float = 3.0, code: int = HUNG_UP) -> int | None:
        """Hang the terminal up and wait for its shell: CTRL_CLOSE_EVENT first, then after `grace` the job ends with
        `code`. Anything the shell started that is still in the job ends too. Returns the shell's exit code."""
        self.close_console_async()
        try:
            self.proc.wait(grace)
        except subprocess.TimeoutExpired:
            pass
        self.job.terminate(code)  # the shell if it is still there, and every program it left behind
        try:
            self.proc.wait(5)
        except subprocess.TimeoutExpired:
            pass
        return self.proc.poll()

    def kill_now(self, code: int = HUNG_UP) -> None:
        self.job.terminate(code)
        self.close_console_async()

    def close(self, reader: threading.Thread | None = None, timeout: float = 3.0) -> None:
        """Free the handles once the reader is done (it sees a broken pipe when the console closes)."""
        if reader is not None and reader is not threading.current_thread():
            reader.join(timeout)
            if reader.is_alive():  # never close a handle under a blocked read: leave it to the process's end
                return
        if self._closer is not None:
            self._closer.join(timeout)
        self.pty.close_pipes()
        self.job.close()
        self.proc.close()


# --- the exit code side channel -------------------------------------------------------------------------------------------
def _user_sid() -> str:
    tok = HANDLE()
    if not OpenProcessToken(GetCurrentProcess(), 0x0008, ctypes.byref(tok)):  # TOKEN_QUERY
        raise _err("OpenProcessToken")
    try:
        size = DWORD(0)
        GetTokenInformation(tok, 1, None, 0, ctypes.byref(size))  # TokenUser
        buf = ctypes.create_string_buffer(max(size.value, 64))
        if not GetTokenInformation(tok, 1, buf, len(buf), ctypes.byref(size)):
            raise _err("GetTokenInformation")
        sid = ctypes.cast(buf, ctypes.POINTER(LPVOID))[0]  # TOKEN_USER.User.Sid is the first field
        text = wt.LPWSTR()
        if not ConvertSidToStringSidW(sid, ctypes.byref(text)):
            raise _err("ConvertSidToStringSidW")
        try:
            return str(text.value)
        finally:
            LocalFree(ctypes.cast(text, LPVOID))
    finally:
        _close(tok.value)


def person_only_sddl() -> str:
    """A protected DACL that lets the person's own account, and nothing else, open the object."""
    return f"D:P(A;;GA;;;{_user_sid()})"


class MarkPipe:
    """A named pipe the Room's shell writes "code;nonce;seq" to after each command. Inbound only, local clients only,
    the first instance ours (so nothing can have made it first), and a DACL for the person alone. A program running
    as the person could find it and write to it: the same strength as the nonce on POSIX, and said under Advanced.
    The next instance is listening before a connected one is read, so two prompts in a row are both taken."""

    INSTANCES = 4

    def __init__(self, on_line) -> None:
        _need_windows()
        self.name = f"rooks-mark-{uuid.uuid4().hex}"
        self.path = rf"\\.\pipe\{self.name}"
        self._on_line = on_line
        self._stop = threading.Event()
        sd = LPVOID()
        if not ConvertSDDL(person_only_sddl(), 1, ctypes.byref(sd), None):
            raise _err("ConvertStringSecurityDescriptorToSecurityDescriptorW")
        self._sd = sd
        self._sa = SECURITY_ATTRIBUTES(ctypes.sizeof(SECURITY_ATTRIBUTES), sd, False)
        try:
            self._h = self._instance(first=True)
        except OSError:
            LocalFree(sd)
            raise
        self._thread = threading.Thread(target=self._serve, name="room-mark-pipe", daemon=True)
        self._thread.start()

    def _instance(self, first: bool = False):
        # PIPE_ACCESS_INBOUND (| FILE_FLAG_FIRST_PIPE_INSTANCE); byte mode, blocking, PIPE_REJECT_REMOTE_CLIENTS
        h = CreateNamedPipeW(self.path, 0x00000001 | (0x00080000 if first else 0), 0x00000008, self.INSTANCES, 4096,
                             4096, 0, ctypes.byref(self._sa))
        if not _ok_handle(h):
            raise _err("CreateNamedPipeW")
        return h

    def _serve(self) -> None:
        buf = ctypes.create_string_buffer(4096)
        while not self._stop.is_set():
            h = self._h
            # A client that connected, wrote and closed before we asked gives ERROR_NO_DATA: its line is still there
            if not ConnectNamedPipe(h, None) and ctypes.get_last_error() not in (ERROR_PIPE_CONNECTED, ERROR_NO_DATA):
                if self._stop.is_set():
                    break
                DisconnectNamedPipe(h)
                time.sleep(0.05)
                continue
            if self._stop.is_set():
                break
            try:  # the next one listens before this one is read
                self._h = self._instance()
            except OSError:
                self._h = None
            data = b""
            while len(data) < 4096:
                got = DWORD(0)
                if not ReadFile(h, buf, len(buf), ctypes.byref(got), None) or not got.value:
                    break
                data += buf.raw[: got.value]
            DisconnectNamedPipe(h)
            _close(h)
            for line in data.decode("ascii", "replace").splitlines():
                if line.strip() and not self._stop.is_set():
                    try:
                        self._on_line(line.strip())
                    except Exception:  # noqa: BLE001 - one bad line never stops the channel
                        pass
            if self._h is None:  # no instance could be made: the channel ends here (the in-band marker remains)
                return

    def close(self) -> None:
        if self._stop.is_set():
            return
        self._stop.set()
        # wake a blocked ConnectNamedPipe by connecting to it ourselves
        h = CreateFileW(self.path, 0x40000000, 0, None, 3, 0, None)  # GENERIC_WRITE, OPEN_EXISTING
        _close(h)
        self._thread.join(2)
        if not self._thread.is_alive():
            last, self._h = self._h, None
            _close(last)
            LocalFree(self._sd)


def write_mark(name: str, line: str, timeout: float = 2.0) -> None:
    """Write one line to a MarkPipe by its short name (what a Room shell does; for tests). Waits while every instance
    is busy, as PowerShell's Connect does."""
    _need_windows()
    path = rf"\\.\pipe\{name}"
    deadline = time.monotonic() + timeout
    while True:
        try:
            with open(path, "wb", buffering=0) as f:
                f.write((line.rstrip("\n") + "\n").encode("ascii"))
            return
        except OSError:
            if time.monotonic() > deadline:
                raise
            time.sleep(0.02)


def alive(pid: int) -> bool:
    """Whether a process with this id is still running on Windows."""
    _need_windows()
    h = OpenProcess(0x00100000 | 0x1000, False, int(pid))  # SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION
    if not _ok_handle(h):
        return False
    try:
        return WaitForSingleObject(h, 0) == WAIT_TIMEOUT
    finally:
        CloseHandle(h)
