import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { getRuntimePlatform } from "./paths.js";
import type { ManagedProfile, ProfileRuntimeInfo } from "../shared/types.js";

const execFileAsync = promisify(execFile);

interface ProcessRow {
  pid: number;
  command: string;
  name?: string;
  parentPid?: number;
}

async function listProcesses(): Promise<ProcessRow[]> {
  if (getRuntimePlatform() === "win32") {
    return listWindowsProcesses();
  }

  return listUnixProcesses();
}

async function listUnixProcesses(): Promise<ProcessRow[]> {
  const result = await execFileAsync("ps", ["axo", "pid=,command="], { maxBuffer: 1024 * 1024 * 4 });
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        command: match[2]
      };
    })
    .filter((row): row is ProcessRow => Boolean(row));
}

async function listWindowsProcesses(): Promise<ProcessRow[]> {
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  const result = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], { maxBuffer: 1024 * 1024 * 8 });
  if (!result.stdout.trim()) {
    return [];
  }

  const parsed = JSON.parse(result.stdout) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .map((row): ProcessRow | null => {
      if (!row || typeof row !== "object") return null;
      const item = row as { ProcessId?: unknown; ParentProcessId?: unknown; Name?: unknown; CommandLine?: unknown };
      if (typeof item.ProcessId !== "number") return null;
      return {
        pid: item.ProcessId,
        command: typeof item.CommandLine === "string" ? item.CommandLine : "",
        name: typeof item.Name === "string" ? item.Name : undefined,
        parentPid: typeof item.ParentProcessId === "number" ? item.ParentProcessId : undefined
      };
    })
    .filter((row): row is ProcessRow => Boolean(row));
}

/** Conservative preflight for replacing a profile's settings on disk. */
export function settingsSyncStopBlocker(profile: ManagedProfile, processes: readonly ProcessRow[]): string | null {
  const isCodex = (row: ProcessRow) => /^(?:chatgpt|codex)(?:\.exe)?$/i.test(row.name ?? "")
    || /(?:^|[\\/\s])(?:ChatGPT|Codex)(?:\.exe)?(?:[\s"']|$)/i.test(row.command);
  if (processes.some(row => isCodex(row) && !row.command.trim())) {
    return "Could not inspect a Codex process. Local settings were not synchronized.";
  }
  if (processes.some(row => matchesUserDataDir(row.command, profile.paths.userDataDir))) {
    return "Close this profile's Codex window with Ctrl+Q before opening it to sync local settings. Other profiles can keep running.";
  }
  const knownPid = profile.launch.lastKnownPid;
  if (knownPid && processes.some(row => isCodex(row) && (row.pid === knownPid || row.parentPid === knownPid))) {
    return "This profile still has a known desktop or backend process. Wait for it to exit before syncing local settings.";
  }
  return null;
}

export async function assertProfileStoppedForSettingsSync(profile: ManagedProfile): Promise<void> {
  let processes: ProcessRow[];
  try { processes = await listProcesses(); }
  catch { throw new Error("Could not confirm this profile is stopped. Local settings were not synchronized."); }
  const blocker = settingsSyncStopBlocker(profile, processes);
  if (blocker) throw new Error(blocker);
}

export async function getRuntimeStatus(profiles: ManagedProfile[]): Promise<ProfileRuntimeInfo[]> {
  let processes: ProcessRow[];

  try {
    processes = await listProcesses();
  } catch (error) {
    return profiles.map((profile) => ({
      profileId: profile.id,
      status: "unknown",
      pid: null,
      detail: error instanceof Error ? error.message : "Could not inspect process list."
    }));
  }

  return profiles.map((profile) => {
    const process = processes.find((row) => matchesUserDataDir(row.command, profile.paths.userDataDir));
    if (!process) {
      return {
        profileId: profile.id,
        status: "not_running",
        pid: null,
        detail: "No process found for this profile user-data-dir."
      };
    }

    return {
      profileId: profile.id,
      status: "running",
      pid: process.pid,
      detail: "Matched a Codex process by user-data-dir."
    };
  });
}

function matchesUserDataDir(command: string, userDataDir: string): boolean {
  const normalize = (value: string) => getRuntimePlatform() === "win32"
    ? path.win32.resolve(value).replace(/[\\/]+$/, "").toLowerCase()
    : path.resolve(value);
  // Electron/Node may quote either the complete argument or only its value.
  // Compare full path values so Windows case/slash variants cannot bypass the
  // stopped check, and a similarly named profile is not mistaken for this one.
  const argument = /(?:^|\s)(?:"--user-data-dir=([^"]*)"|'--user-data-dir=([^']*)'|--user-data-dir(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s"']+)))(?=\s|$)/g;
  for (const match of command.matchAll(argument)) {
    const value = match.slice(1).find(item => item !== undefined);
    if (value && normalize(value) === normalize(userDataDir)) return true;
  }
  return false;
}
