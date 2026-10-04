'use strict';

// Win32 bindings via koffi (an FFI library — no native build step needed).
//
// Struct layouts are defined at module load on every platform so the test
// suite can check their sizes on Linux; the DLL functions bind lazily and only
// on Windows.

const koffi = require('koffi');

const MAX_PATH = 260;
const MAX_MODULE_NAME32 = 255;

const PROCESSENTRY32W = koffi.struct('PROCESSENTRY32W', {
  dwSize: 'uint32',
  cntUsage: 'uint32',
  th32ProcessID: 'uint32',
  th32DefaultHeapID: 'uintptr_t',
  th32ModuleID: 'uint32',
  cntThreads: 'uint32',
  th32ParentProcessID: 'uint32',
  pcPriClassBase: 'int32',
  dwFlags: 'uint32',
  szExeFile: koffi.array('char16_t', MAX_PATH, 'String'),
});

const MODULEENTRY32W = koffi.struct('MODULEENTRY32W', {
  dwSize: 'uint32',
  th32ModuleID: 'uint32',
  th32ProcessID: 'uint32',
  GlblcntUsage: 'uint32',
  ProccntUsage: 'uint32',
  modBaseAddr: 'uintptr_t',
  modBaseSize: 'uint32',
  hModule: 'uintptr_t',
  szModule: koffi.array('char16_t', MAX_MODULE_NAME32 + 1, 'String'),
  szExePath: koffi.array('char16_t', MAX_PATH, 'String'),
});

const C = {
  TH32CS_SNAPPROCESS: 0x2,
  TH32CS_SNAPMODULE: 0x8,
  TH32CS_SNAPMODULE32: 0x10,
  PROCESS_VM_OPERATION: 0x8,
  PROCESS_VM_READ: 0x10,
  PROCESS_VM_WRITE: 0x20,
  PROCESS_QUERY_LIMITED_INFORMATION: 0x1000,
  STILL_ACTIVE: 259,
  ERROR_ACCESS_DENIED: 5,
};

let api = null;

function load() {
  if (api) return api;
  if (process.platform !== 'win32') {
    throw new Error('Attaching to real games needs Windows. Use the demo game on this system.');
  }
  const k32 = koffi.load('kernel32.dll');
  // Handles are declared as uintptr_t so they come back as plain integers
  // (Koffi 3 pointers are BigInt anyway) and compare cleanly against -1.
  api = {
    OpenProcess: k32.func('uintptr_t __stdcall OpenProcess(uint32_t dwDesiredAccess, bool bInheritHandle, uint32_t dwProcessId)'),
    CloseHandle: k32.func('bool __stdcall CloseHandle(uintptr_t hObject)'),
    ReadProcessMemory: k32.func('bool __stdcall ReadProcessMemory(uintptr_t hProcess, uintptr_t lpBaseAddress, _Out_ uint8_t *lpBuffer, size_t nSize, _Out_ size_t *lpNumberOfBytesRead)'),
    WriteProcessMemory: k32.func('bool __stdcall WriteProcessMemory(uintptr_t hProcess, uintptr_t lpBaseAddress, const uint8_t *lpBuffer, size_t nSize, _Out_ size_t *lpNumberOfBytesWritten)'),
    CreateToolhelp32Snapshot: k32.func('uintptr_t __stdcall CreateToolhelp32Snapshot(uint32_t dwFlags, uint32_t th32ProcessID)'),
    Process32FirstW: k32.func('bool __stdcall Process32FirstW(uintptr_t hSnapshot, _Inout_ PROCESSENTRY32W *lppe)'),
    Process32NextW: k32.func('bool __stdcall Process32NextW(uintptr_t hSnapshot, _Inout_ PROCESSENTRY32W *lppe)'),
    Module32FirstW: k32.func('bool __stdcall Module32FirstW(uintptr_t hSnapshot, _Inout_ MODULEENTRY32W *lpme)'),
    Module32NextW: k32.func('bool __stdcall Module32NextW(uintptr_t hSnapshot, _Inout_ MODULEENTRY32W *lpme)'),
    GetExitCodeProcess: k32.func('bool __stdcall GetExitCodeProcess(uintptr_t hProcess, _Out_ uint32_t *lpExitCode)'),
    IsWow64Process: k32.func('bool __stdcall IsWow64Process(uintptr_t hProcess, _Out_ bool *Wow64Process)'),
    GetLastError: k32.func('uint32_t __stdcall GetLastError()'),
  };
  // user32: which window is in front, so the overlay can hide when you alt-tab.
  const u32 = koffi.load('user32.dll');
  api.GetForegroundWindow = u32.func('uintptr_t __stdcall GetForegroundWindow()');
  api.GetWindowThreadProcessId = u32.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hWnd, _Out_ uint32_t *lpdwProcessId)');
  return api;
}

// PID of the program whose window is in front, or null if unknown.
function foregroundPid() {
  if (process.platform !== 'win32') return null;
  const k = load();
  const hwnd = k.GetForegroundWindow();
  if (!hwnd || BigInt(hwnd) === 0n) return null;
  const pid = [0];
  k.GetWindowThreadProcessId(hwnd, pid);
  return pid[0] || null;
}

function isInvalidHandle(h) {
  const v = BigInt(h);
  return v === 0n || v === 0xffffffffffffffffn || v === -1n;
}

module.exports = { load, foregroundPid, isInvalidHandle, PROCESSENTRY32W, MODULEENTRY32W, C };
