import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

/** Test-only guard: prevent auto-discovery or launching an installed desktop. */
export function installNoDesktopFixtureGuard(fixture) {
  const nativeSpawn = childProcess.spawn;
  const nativeExecFileSync = childProcess.execFileSync;
  const nativeExecFile = childProcess.execFile;
  const nativeExecFileAsync = promisify(nativeExecFile);
  const stats = { blockedDiscoveries: 0, blockedDesktopLaunches: 0, controlledProcessQueries: 0 };
  let fixtureProcesses = [];
  const isProcessInspection = args => Array.isArray(args) && /Get-CimInstance\s+Win32_Process/i.test(args.join(" "));
  const processOutput = () => JSON.stringify(fixtureProcesses.map(row => ({ ProcessId: row.pid, ParentProcessId: row.parentPid ?? 0, Name: row.name ?? "", CommandLine: row.command ?? "" })));
  const previous = new Map();
  const changeEnvironment = (key, value) => { previous.set(key, process.env[key]); process.env[key] = value; };
  changeEnvironment("LOCALAPPDATA", path.join(fixture, "AppData", "Local"));
  changeEnvironment("PROGRAMFILES", path.join(fixture, "Program Files"));
  changeEnvironment("PROGRAMFILES(X86)", path.join(fixture, "Program Files (x86)"));
  if (process.platform === "win32") {
    const windowsRoot = process.env.SystemRoot || "C:\\Windows";
    changeEnvironment("PATH", [path.join(windowsRoot, "System32"), path.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0")].join(path.delimiter));
  }
  childProcess.execFileSync = function (command, args, options) {
    const script = Array.isArray(args) ? args.join(" ") : "";
    if (/Get-AppxPackage|Get-Process -Name ChatGPT,Codex/i.test(script)) {
      stats.blockedDiscoveries++;
      return options?.encoding ? "" : Buffer.alloc(0);
    }
    return nativeExecFileSync(command, args, options);
  };
  const fixtureExecFile = function (command, args, options, callback) {
    if (isProcessInspection(args)) {
      stats.controlledProcessQueries++;
      const done = typeof options === "function" ? options : callback;
      queueMicrotask(() => done?.(null, processOutput(), ""));
      return { kill() {} };
    }
    return nativeExecFile(command, args, options, callback);
  };
  fixtureExecFile[promisify.custom] = async function (command, args, options) {
    if (isProcessInspection(args)) {
      stats.controlledProcessQueries++;
      return { stdout: processOutput(), stderr: "" };
    }
    return nativeExecFileAsync(command, args, options);
  };
  childProcess.execFile = fixtureExecFile;
  childProcess.spawn = function (command, args, options) {
    // Windows path checks spawn PowerShell and remain real functional checks.
    if (!/^powershell(?:\.exe)?$/i.test(path.basename(String(command))) || options?.detached) {
      stats.blockedDesktopLaunches++;
      throw new Error(`Fixture guard blocked a desktop or unexpected executable launch: ${path.basename(String(command))}`);
    }
    return nativeSpawn(command, args, options);
  };
  syncBuiltinESMExports();
  return { stats, setFixtureCodexProcesses(rows) { fixtureProcesses = structuredClone(rows); }, restore() {
    childProcess.spawn = nativeSpawn;
    childProcess.execFileSync = nativeExecFileSync;
    childProcess.execFile = nativeExecFile;
    syncBuiltinESMExports();
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  } };
}
