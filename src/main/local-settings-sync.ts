import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import TOML from "@iarna/toml";

const execFileAsync = promisify(execFile);
type JsonObject = Record<string, unknown>;
type Validator = (value: unknown) => boolean;
const boolean: Validator = value => typeof value === "boolean";
const text: Validator = value => typeof value === "string" && value.length <= 256 && !/[\r\n\0]/.test(value);
const oneOf = (...values: string[]): Validator => value => typeof value === "string" && values.includes(value);
const numberBetween = (min: number, max: number): Validator => value => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

// Installed Codex settings definitions distinguish configuration, global-state,
// and persisted-atom storage. Never copy either state object wholesale.
const GLOBAL_KEYS: Record<string, Validator> = {
  "notifications-sound": oneOf("default", "classic", "none", "Basso", "Glass", "Ping", "Pop", "Purr", "Tink"),
  "notifications-turn-mode": oneOf("off", "unfocused", "always"),
  "notifications-permissions-enabled": boolean,
  "notifications-questions-enabled": boolean,
  "notifications-dot-enabled": boolean,
  "electron-initial-follow-up-queue-mode": oneOf("queue", "steer", "interrupt")
};
const ATOM_KEYS: Record<string, Validator> = {
  "composer-auto-context-enabled": boolean,
  "markdownCodeBlockWordWrap": boolean,
  "show-context-window-usage": boolean,
  "show-educational-tips": boolean,
  "app-shell:right-panel-width:v3": numberBetween(100, 3000)
};
const CONFIG_KEYS: Record<string, Validator> = {
  appearanceTheme: oneOf("system", "light", "dark"),
  appearanceLightCodeThemeId: text,
  appearanceDarkCodeThemeId: text,
  appearanceDiffMarkerStyle: oneOf("color", "symbols"),
  sansFontSize: numberBetween(11, 16),
  codeFontSize: numberBetween(8, 24),
  useFontSmoothing: boolean,
  usePointerCursors: boolean,
  localeOverride: value => typeof value === "string" && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value),
  followUpQueueMode: oneOf("queue", "steer", "interrupt"),
  defaultTerminalLocation: oneOf("bottom", "right"),
  personality: oneOf("none", "friendly", "pragmatic")
};
const CONFIG_TABLES: Record<string, Record<string, Validator>> = {
  memories: { generate_memories: boolean, use_memories: boolean },
  features: { memories: boolean },
  tui: { theme: text, animations: boolean, alternate_screen: oneOf("auto", "always", "never") }
};
const RESOURCE_FILES = ["AGENTS.md", "instructions.md"];
// Codex *.rules files grant or deny execution approval; keep them account-local.
const RESOURCE_DIRECTORIES = ["skills", "prompts"];
const STATE_FILE = ".codex-global-state.json";
const FORBIDDEN_DIRECTORIES = new Set([
  ".git", ".ssh", ".aws", ".azure", ".docker", ".kube", ".gnupg", ".codex", ".venv", "node_modules", "__pycache__",
  "sessions", "archived_sessions", "memories", "auth", "credentials", "secrets", "cache"
]);

interface Change { relativePath: string; before: Buffer | null; after: Buffer }
interface BackupEntry { relativePath: string; existedBefore: boolean }
interface Manifest { version: 1; targetHome: string; sourceHome: string; createdAt: string; files: BackupEntry[] }

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function same(a: Buffer | null, b: Buffer | null): boolean {
  return a === null ? b === null : b !== null && a.equals(b);
}
function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
function overlap(a: string, b: string): boolean { return inside(a, b) || inside(b, a); }
function normalized(value: string): string {
  if (!value || value.includes("\0")) throw new Error("A valid local settings directory is required.");
  const full = path.resolve(value);
  if (process.platform === "win32" && full.slice(path.parse(full).root.length).split(/[\\/]/).some(part => /[. :]$|:/.test(part))) {
    throw new Error("Ambiguous Windows paths are not allowed for settings sync.");
  }
  return full;
}
async function statIfPresent(file: string) {
  try { return await fs.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function assertSafePath(file: string): Promise<string[]> {
  const full = normalized(file), root = path.parse(full).root;
  const entries = [root];
  let current = root;
  for (const part of full.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); entries.push(current);
  }
  const existing: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index], stat = await statIfPresent(entry);
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new Error(`Settings sync rejects links and reparse points: ${entry}`);
    if (index < entries.length - 1 && !stat.isDirectory()) throw new Error(`Settings path ancestor is not a directory: ${entry}`);
    existing.push(entry);
  }
  return existing;
}
async function assertSafePaths(files: string[]): Promise<void> {
  const existing = new Set<string>();
  for (const file of files) for (const entry of await assertSafePath(file)) existing.add(entry);
  if (process.platform !== "win32" || !existing.size) return;
  // Node exposes symbolic links/junctions; Windows attributes also reject other
  // reparse tags. Pass only quoted paths, never file contents, to PowerShell.
  const script = "$ErrorActionPreference='Stop'; while(($line=[Console]::ReadLine()) -ne $null){$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)); if(([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Settings sync rejects a reparse point.'}}";
  await new Promise<void>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    let errorText = "";
    child.stderr.on("data", chunk => { if (errorText.length < 16384) errorText += String(chunk); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`Windows settings path validation failed: ${errorText}`)));
    child.stdin.on("error", () => undefined);
    child.stdin.end([...existing].map(entry => Buffer.from(entry).toString("base64")).join("\n") + "\n");
  });
}
async function readOptional(file: string): Promise<Buffer | null> {
  const stat = await statIfPresent(file);
  if (!stat) return null;
  if (!stat.isFile()) throw new Error(`Expected a regular settings file: ${file}`);
  if (stat.nlink > 1) throw new Error(`Settings sync rejects hard-linked files: ${file}`);
  return fs.readFile(file);
}
function allowedResource(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]/), name = parts[parts.length - 1].toLowerCase();
  if (parts.some(part => FORBIDDEN_DIRECTORIES.has(part.toLowerCase()))) return false;
  return !(/^(?:\.env(?:\..*)?|\.envrc|\.netrc|\.npmrc|\.pypirc|\.git-credentials|auth(?:entication)?(?:\..*)?|oauth2?(?:\..*)?|tokens?(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|cookies?(?:\..*)?|service[-_]account(?:\..*)?|client[-_]secret(?:\..*)?|\.?mcp(?:\..*)?|\.codex-global-state\.json(?:\..*)?|history\.jsonl|session_index\.jsonl|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i.test(name)
    || /(?:^|[._-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key)(?:[._-]|$)/i.test(name)
    || /\.(?:rules|sqlite(?:\d*)?|db|pem|key|pfx|p12|ppk|jks|keystore|kdbx)(?:[-.].*)?$/i.test(name));
}
async function collectResources(sourceHome: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(relative: string): Promise<void> {
    const full = path.join(sourceHome, relative);
    await assertSafePath(full);
    const stat = await statIfPresent(full);
    if (!stat) return;
    if (stat.isDirectory()) {
      if (FORBIDDEN_DIRECTORIES.has(path.basename(relative).toLowerCase())) return;
      for (const name of (await fs.readdir(full)).sort()) await walk(path.join(relative, name));
    } else if (stat.isFile() && allowedResource(relative)) found.push(relative);
    else if (!stat.isFile()) throw new Error(`Unsupported local settings resource: ${full}`);
  }
  for (const relative of [...RESOURCE_FILES, ...RESOURCE_DIRECTORIES]) {
    await assertSafePath(path.join(sourceHome, relative));
    const stat = await statIfPresent(path.join(sourceHome, relative));
    if (stat && (RESOURCE_FILES.includes(relative) ? !stat.isFile() : !stat.isDirectory())) throw new Error(`Unexpected settings resource type: ${relative}`);
    await walk(relative);
  }
  return found;
}
function mergeKeys(target: JsonObject, source: JsonObject, keys: Record<string, Validator>): boolean {
  let changed = false;
  for (const [key, valid] of Object.entries(keys)) {
    if (Object.prototype.hasOwnProperty.call(source, key) && valid(source[key]) && !Object.is(target[key], source[key])) {
      Object.defineProperty(target, key, { value: source[key], writable: true, enumerable: true, configurable: true });
      changed = true;
    }
  }
  return changed;
}
function parseJson(bytes: Buffer | null): JsonObject {
  if (!bytes) return {};
  const parsed: unknown = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  if (!object(parsed)) throw new Error("Codex global state must be an object.");
  return parsed;
}
function mergeGlobalState(before: Buffer | null, source: Buffer): Buffer | null {
  const target = parseJson(before), from = parseJson(source);
  let changed = mergeKeys(target, from, GLOBAL_KEYS);
  const atomName = "electron-persisted-atom-state";
  if (object(from[atomName])) {
    const previous = target[atomName];
    if (previous !== undefined && !object(previous)) throw new Error("Target persisted atom state must be an object.");
    const atoms: JsonObject = object(previous) ? { ...previous } : {};
    if (mergeKeys(atoms, from[atomName], ATOM_KEYS)) {
      Object.defineProperty(target, atomName, { value: atoms, writable: true, enumerable: true, configurable: true });
      changed = true;
    }
  }
  return changed ? Buffer.from(`${JSON.stringify(target, null, 2)}\n`) : null;
}
function mergeConfig(before: Buffer | null, source: Buffer): Buffer | null {
  const target = TOML.parse(before?.toString("utf8").replace(/^\uFEFF/, "") ?? "") as JsonObject;
  const from = TOML.parse(source.toString("utf8").replace(/^\uFEFF/, "")) as JsonObject;
  let changed = mergeKeys(target, from, CONFIG_KEYS);
  for (const [table, keys] of Object.entries(CONFIG_TABLES)) {
    if (!object(from[table])) continue;
    if (target[table] !== undefined && !object(target[table])) throw new Error(`Target config table is invalid: ${table}`);
    const merged: JsonObject = object(target[table]) ? { ...target[table] } : {};
    if (mergeKeys(merged, from[table], keys)) {
      Object.defineProperty(target, table, { value: merged, writable: true, enumerable: true, configurable: true });
      changed = true;
    }
  }
  // A semantic no-op preserves comments, managed markers, and formatting exactly.
  return changed ? Buffer.from(TOML.stringify(target as TOML.JsonMap)) : null;
}
async function atomicWrite(file: string, bytes: Buffer): Promise<void> {
  await assertSafePath(file);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await assertSafePath(file);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.settings-sync-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await assertSafePath(file);
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
}
async function privateBackup(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    const literal = directory.replace(/'/g, "''");
    const script = `$ErrorActionPreference='Stop'; $p='${literal}'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[IO.Directory]::GetAccessControl($p,[Security.AccessControl.AccessControlSections]::Access); $acl.SetAccessRuleProtection($true,$false); foreach($r in @($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))){[void]$acl.RemoveAccessRuleSpecific($r)}; $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [IO.Directory]::SetAccessControl($p,$acl)`;
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true });
  }
}

async function inspectPaths(targetHome: string, sourceHome: string) {
  const target = normalized(targetHome), source = normalized(sourceHome);
  const backupRoot = path.join(path.dirname(target), "backups");
  if (overlap(source, target) || overlap(source, backupRoot)) throw new Error("Settings source, target, and backup paths must not overlap.");
  await assertSafePaths([source, target, backupRoot]);
  const sourceStat = await statIfPresent(source);
  if (!sourceStat?.isDirectory()) throw new Error("Settings source directory does not exist.");
  const targetStat = await statIfPresent(target);
  if (targetStat && !targetStat.isDirectory()) throw new Error("Settings target must be a directory.");
  const resources = await collectResources(source);
  const files = [...resources, "config.toml", STATE_FILE];
  await assertSafePaths(files.flatMap(relative => [path.join(source, relative), path.join(target, relative)]));
  for (const relative of files) {
    for (const root of [source, target]) {
      const stat = await statIfPresent(path.join(root, relative));
      if (stat && !stat.isFile()) throw new Error(`Expected a regular settings file: ${path.join(root, relative)}`);
      if (stat && stat.nlink > 1) throw new Error(`Settings sync rejects hard-linked files: ${path.join(root, relative)}`);
    }
  }
  return { target, source, backupRoot, files };
}

/** Read-only preflight for callers that will write profile config before syncing. */
export async function validateLocalSettingsSyncPaths(targetHome: string, sourceHome: string): Promise<void> {
  await inspectPaths(targetHome, sourceHome);
}

/** Missing source keys/files preserve target values; source deletions never propagate. */
export async function syncLocalSettings(targetHome: string, sourceHome: string): Promise<{ changedFiles: number; backupDirectory: string | null }> {
  const { target, source, backupRoot, files } = await inspectPaths(targetHome, sourceHome);
  const changes: Change[] = [];
  for (const relativePath of files) {
    const from = await readOptional(path.join(source, relativePath));
    if (from === null) continue;
    const before = await readOptional(path.join(target, relativePath));
    const after = relativePath === "config.toml" ? mergeConfig(before, from) : relativePath === STATE_FILE ? mergeGlobalState(before, from) : from;
    if (after !== null && !same(before, after)) changes.push({ relativePath, before, after });
  }
  if (!changes.length) return { changedFiles: 0, backupDirectory: null };
  const backupDirectory = path.join(backupRoot, `local-settings-sync-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`);
  await assertSafePaths([backupDirectory]);
  await privateBackup(backupDirectory);
  const manifest: Manifest = { version: 1, targetHome: target, sourceHome: source, createdAt: new Date().toISOString(), files: changes.map(change => ({ relativePath: change.relativePath, existedBefore: change.before !== null })) };
  // Complete before/after images and the full manifest precede every target write.
  for (const change of changes) {
    if (change.before !== null) await atomicWrite(path.join(backupDirectory, "before", change.relativePath), change.before);
    await atomicWrite(path.join(backupDirectory, "after", change.relativePath), change.after);
  }
  await atomicWrite(path.join(backupDirectory, "manifest.json"), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  try {
    await assertSafePaths(changes.map(change => path.join(target, change.relativePath)));
    for (const change of changes) {
      const file = path.join(target, change.relativePath);
      if (!same(await readOptional(file), change.before)) throw new Error(`Target settings changed during sync: ${change.relativePath}`);
      await atomicWrite(file, change.after);
    }
  } catch (error) {
    await restoreLocalSettingsSync(target, backupDirectory).catch(() => undefined);
    throw new Error(`Local settings sync failed; recovery backup: ${backupDirectory}`, { cause: error });
  }
  return { changedFiles: changes.length, backupDirectory };
}

/** Restore only this run's files; preserve later edits as reported conflicts. */
export async function restoreLocalSettingsSync(targetHome: string, backupDirectory: string): Promise<{ restoredFiles: number; conflicts: string[] }> {
  const target = normalized(targetHome), backup = normalized(backupDirectory);
  if (overlap(target, backup)) throw new Error("Backup and target must be separate directories.");
  await assertSafePaths([target, backup, path.join(backup, "manifest.json")]);
  const raw: unknown = JSON.parse((await fs.readFile(path.join(backup, "manifest.json"), "utf8")).replace(/^\uFEFF/, ""));
  if (!object(raw) || raw.version !== 1 || raw.targetHome !== target || !Array.isArray(raw.files)) throw new Error("Invalid or mismatched settings backup manifest.");
  const files: BackupEntry[] = [], seen = new Set<string>();
  for (const entry of raw.files) {
    if (!object(entry) || typeof entry.relativePath !== "string" || typeof entry.existedBefore !== "boolean") throw new Error("Invalid settings backup entry.");
    const relative = entry.relativePath;
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part === "." || part === "..") || !inside(target, path.resolve(target, relative)) || seen.has(relative)) throw new Error("Unsafe settings backup path.");
    if (![...RESOURCE_FILES, "config.toml", STATE_FILE].includes(relative) && !(RESOURCE_DIRECTORIES.some(dir => relative.startsWith(`${dir}${path.sep}`)) && allowedResource(relative))) throw new Error("Backup contains a file outside settings sync scope.");
    seen.add(relative); files.push({ relativePath: relative, existedBefore: entry.existedBefore });
  }
  const paths = files.flatMap(entry => [path.join(target, entry.relativePath), path.join(backup, "before", entry.relativePath), path.join(backup, "after", entry.relativePath)]);
  await assertSafePaths(paths);
  // Validate all images before restoring any file.
  const images = await Promise.all(files.map(async entry => {
    const after = await readOptional(path.join(backup, "after", entry.relativePath));
    const before = entry.existedBefore ? await readOptional(path.join(backup, "before", entry.relativePath)) : null;
    if (after === null || (entry.existedBefore && before === null)) throw new Error("Settings backup image is missing.");
    return { ...entry, before, after };
  }));
  let restoredFiles = 0;
  const conflicts: string[] = [];
  for (const image of images) {
    const file = path.join(target, image.relativePath), current = await readOptional(file);
    if (same(current, image.before)) continue; // Already restored or not applied.
    if (!same(current, image.after)) { conflicts.push(image.relativePath); continue; }
    if (image.before === null) { await assertSafePath(file); await fs.unlink(file); }
    else await atomicWrite(file, image.before);
    restoredFiles++;
  }
  return { restoredFiles, conflicts };
}
