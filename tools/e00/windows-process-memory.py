"""Sample Windows private commit and resident memory for an isolated process tree."""

import collections
import ctypes as c
from ctypes import wintypes as w
import json
import sys
import time


class ProcessEntry(c.Structure):
    _fields_ = (
        ("size", w.DWORD), ("usage", w.DWORD), ("pid", w.DWORD),
        ("default_heap", c.c_size_t), ("module", w.DWORD),
        ("threads", w.DWORD), ("parent", w.DWORD), ("priority", w.LONG),
        ("flags", w.DWORD), ("exe", w.WCHAR * 260),
    )


class MemoryCounters(c.Structure):
    _fields_ = (("size", w.DWORD), ("faults", w.DWORD)) + tuple(
        (name, c.c_size_t) for name in (
            "peak_working_set", "working_set", "peak_paged_pool", "paged_pool",
            "peak_nonpaged_pool", "nonpaged_pool", "pagefile", "peak_pagefile", "private_usage",
        )
    )


kernel = c.WinDLL("kernel32", use_last_error=True)


def api(name, result, *arguments):
    function = getattr(kernel, name)
    function.restype = result
    function.argtypes = arguments
    return function


snapshot = api("CreateToolhelp32Snapshot", w.HANDLE, w.DWORD, w.DWORD)
first = api("Process32FirstW", w.BOOL, w.HANDLE, c.POINTER(ProcessEntry))
next_process = api("Process32NextW", w.BOOL, w.HANDLE, c.POINTER(ProcessEntry))
open_process = api("OpenProcess", w.HANDLE, w.DWORD, w.BOOL, w.DWORD)
memory_info = api("K32GetProcessMemoryInfo", w.BOOL, w.HANDLE, c.POINTER(MemoryCounters), w.DWORD)
close_handle = api("CloseHandle", w.BOOL, w.HANDLE)


def descendants(root):
    handle = snapshot(0x00000002, 0)  # TH32CS_SNAPPROCESS
    if handle == c.c_void_p(-1).value:
        raise c.WinError(c.get_last_error())
    children = collections.defaultdict(list)
    active = set()
    entry = ProcessEntry(size=c.sizeof(ProcessEntry))
    try:
        found = first(handle, c.byref(entry))
        while found:
            children[entry.parent].append(entry.pid)
            active.add(entry.pid)
            found = next_process(handle, c.byref(entry))
    finally:
        close_handle(handle)
    if root not in active:
        return set()
    family = {root}
    pending = [root]
    while pending:
        for pid in children[pending.pop()]:
            if pid in family:
                continue
            family.add(pid)
            pending.append(pid)
    return family


def main():
    root = int(sys.argv[1])
    interval = int(sys.argv[2]) / 1000
    while True:
        now = time.monotonic()
        stamp = time.time_ns() // 1_000_000
        pids = descendants(root)
        if not pids:
            return
        private = resident = 0
        processes = []
        for pid in sorted(pids):
            process = open_process(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
            if not process:
                continue
            try:
                counters = MemoryCounters(size=c.sizeof(MemoryCounters))
                if memory_info(process, c.byref(counters), counters.size):
                    private += counters.private_usage
                    resident += counters.working_set
                    processes.append([pid, counters.private_usage, counters.working_set])
            finally:
                close_handle(process)
        if processes:
            print(json.dumps([stamp, private, resident, len(processes), len(pids), processes]), flush=True)
        time.sleep(max(0, interval - (time.monotonic() - now)))


if __name__ == "__main__":
    main()
