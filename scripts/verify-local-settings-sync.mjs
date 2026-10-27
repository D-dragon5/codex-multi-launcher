import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import TOML from "@iarna/toml";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = path.join(repo, ".test-work");
await fs.mkdir(work, { recursive: true });
const temporary = await fs.mkdtemp(path.join(work, "local-settings-sync-"));
let assertions = 0;
function check(condition, message) { assertions++; assert.ok(condition, message); }
async function put(root, relative, contents) { const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, contents); }
async function get(root, relative) { return fs.readFile(path.join(root, relative), "utf8"); }
async function exists(file) { try { await fs.lstat(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
async function fixture(name) { const base = path.join(temporary, name), source = path.join(base, "source"), target = path.join(base, "profile", "codex-home"); await fs.mkdir(source, { recursive: true }); await fs.mkdir(target, { recursive: true }); return { base, source, target }; }
async function tree(root) {
  const result = {};
  async function walk(relative) { for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) { const name = path.join(relative, entry.name); if (entry.isDirectory()) await walk(name); else if (entry.isFile()) result[name] = (await fs.readFile(path.join(root, name))).toString("base64"); } }
  await walk(""); return result;
}

try {
  const sourceCode = await fs.readFile(path.join(repo, "src/main/local-settings-sync.ts"), "utf8");
  const modulePath = path.join(temporary, "local-settings-sync.mjs");
  const compiled = ts.transpileModule(sourceCode, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, esModuleInterop: true } });
  await fs.writeFile(modulePath, compiled.outputText);
  const { syncLocalSettings, restoreLocalSettingsSync, validateLocalSettingsSyncPaths } = await import(pathToFileURL(modulePath).href);

  const { source, target } = await fixture("normal");
  await put(source, "AGENTS.md", "source instructions\n");
  await put(source, "instructions.md", "personal instructions\n");
  await put(source, "skills/example/SKILL.md", "safe skill\n");
  await put(source, "skills/example/scripts/task.js", "export default 1;\n");
  await put(source, "skills/example/config.json", '{"groups":["example"],"path":"fixture-only"}\n');
  await put(source, "skills/example/config.toml", 'format = "fixture-only"\n');
  await put(source, "rules/default.rules", 'prefix_rule(pattern=["bash"], decision="allow")\n');
  await put(source, "rules/source-only.rules", 'prefix_rule(pattern=["python"], decision="allow")\n');
  await put(source, "skills/example/permissions.rules", 'prefix_rule(pattern=["node"], decision="allow")\n');
  await put(source, "prompts/review.md", "safe prompt\n");
  for (const name of ["auth.json", "mcp.json", "config.json", "memories/memory.md", "sessions/chat.jsonl", "state_5.sqlite", "skills/example/.env", "skills/example/credentials.json", "skills/example/id_ed25519", "skills/example/secret.pem", "skills/example/access_token.json", "skills/example/token.json", "skills/example/.npmrc", "skills/example/.git-credentials", "skills/example/oauth.json", "skills/example/service-account.json", "skills/example/data.db"]) await put(source, name, "SOURCE-SECRET-SENTINEL");
  await put(target, "AGENTS.md", "old target instructions\n");
  await put(target, "auth.json", "TARGET-ACCOUNT-SENTINEL");
  await put(target, "mcp.json", "TARGET-MCP-SENTINEL");
  await put(target, "skills/target-only/SKILL.md", "keep target skill\n");
  const targetRules = 'prefix_rule(pattern=["bash"], decision="deny")\n';
  await put(target, "rules/default.rules", targetRules);
  await put(source, "config.toml", `appearanceTheme = "dark"\nsansFontSize = 15\nlocaleOverride = "zh-CN"\npersonality = "friendly"\nmodel = "SOURCE-MODEL"\nmodel_provider = "SOURCE-PROVIDER"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[model_providers.source]\nbase_url = "https://source.invalid"\n[features]\nmemories = true\nshell_tool = true\n[memories]\nuse_memories = false\ngenerate_memories = true\nmax_raw_memories_for_consolidation = 999\n`);
  const originalConfig = `# TARGET-MANAGED-MARKER\nmodel = "TARGET-MODEL"\nmodel_provider = "target"\napproval_policy = "on-request"\nsandbox_mode = "read-only"\nappearanceTheme = "light"\n[model_providers.target]\nbase_url = "https://target.invalid"\nenv_key = "TARGET-KEY"\n[features]\nshell_tool = false\n[memories]\nmax_raw_memories_for_consolidation = 7\n`;
  await put(target, "config.toml", originalConfig);
  const sourceState = { "notifications-turn-mode": "always", "electron-initial-follow-up-queue-mode": "queue", "account-id": "SOURCE-ACCOUNT", "local-projects": { source: {} }, "electron-remote-control-client-enrollments": { source: {} }, unknown: true, "electron-persisted-atom-state": { "composer-auto-context-enabled": true, markdownCodeBlockWordWrap: true, "show-educational-tips": false, "sidebar-custom-sections-v3": { source: [] }, "browser-pairing": "SOURCE-BROWSER", unknown: true } };
  const targetState = { "notifications-turn-mode": "off", "account-id": "TARGET-ACCOUNT", "local-projects": { target: {} }, "electron-remote-control-client-enrollments": { target: {} }, unknown: "TARGET-UNKNOWN", "electron-persisted-atom-state": { "composer-auto-context-enabled": false, "sidebar-custom-sections-v3": { target: [] }, "browser-pairing": "TARGET-BROWSER", unknown: "TARGET-ATOM" } };
  await put(source, ".codex-global-state.json", JSON.stringify(sourceState));
  const originalState = JSON.stringify(targetState);
  await put(target, ".codex-global-state.json", originalState);
  const sourceBefore = await tree(source);
  const targetBefore = await tree(target);
  await validateLocalSettingsSyncPaths(target, source);
  assert.deepEqual(await tree(target), targetBefore); assertions++;
  check(!(await exists(path.join(path.dirname(target), "backups"))), "path preflight must not create backups/directories");
  const result = await syncLocalSettings(target, source);
  check(result.changedFiles === 9 && result.backupDirectory, "expected 7 resources plus config and merged global state");
  assert.deepEqual(await tree(source), sourceBefore); assertions++;
  check(await get(target, "auth.json") === "TARGET-ACCOUNT-SENTINEL", "target authentication must be untouched");
  check(await get(target, "mcp.json") === "TARGET-MCP-SENTINEL", "target MCP must be untouched");
  check(await get(target, "skills/target-only/SKILL.md") === "keep target skill\n", "source deletion must not delete target-only resources");
  check(await get(target, "rules/default.rules") === targetRules, "target execution approval rules must remain unchanged");
  check(!(await exists(path.join(target, "rules/source-only.rules"))), "source execution approval rules must not be introduced");
  check(!(await exists(path.join(target, "skills/example/permissions.rules"))), "execution approval rules inside a skill must not be copied");
  check(await get(target, "skills/example/config.json") === await get(source, "skills/example/config.json") && await get(target, "skills/example/config.toml") === await get(source, "skills/example/config.toml"), "ordinary skill configuration files must be copied as resources");
  for (const name of ["config.json", "memories/memory.md", "sessions/chat.jsonl", "state_5.sqlite", "skills/example/.env", "skills/example/credentials.json", "skills/example/id_ed25519", "skills/example/secret.pem", "skills/example/access_token.json", "skills/example/token.json", "skills/example/.npmrc", "skills/example/.git-credentials", "skills/example/oauth.json", "skills/example/service-account.json", "skills/example/data.db"]) check(!(await exists(path.join(target, name))), `excluded resource copied: ${name}`);
  const config = TOML.parse(await get(target, "config.toml"));
  check(config.appearanceTheme === "dark" && config.sansFontSize === 15 && config.localeOverride === "zh-CN" && config.personality === "friendly", "safe display and personality values must merge");
  check(config.model === "TARGET-MODEL" && config.model_provider === "target" && config.approval_policy === "on-request" && config.sandbox_mode === "read-only", "provider/model/permission settings must remain target values");
  check(config.model_providers.target.base_url === "https://target.invalid" && !config.model_providers.source, "source providers must not propagate");
  check(config.features.memories === true && config.features.shell_tool === false && config.memories.use_memories === false && config.memories.generate_memories === true && config.memories.max_raw_memories_for_consolidation === 7, "memory switches must merge without unrelated features/settings");
  const state = JSON.parse(await get(target, ".codex-global-state.json"));
  check(state["account-id"] === "TARGET-ACCOUNT" && state.unknown === "TARGET-UNKNOWN", "unknown/account keys must remain target values");
  assert.deepEqual(state["local-projects"], targetState["local-projects"]); assertions++;
  assert.deepEqual(state["electron-remote-control-client-enrollments"], targetState["electron-remote-control-client-enrollments"]); assertions++;
  check(state["electron-persisted-atom-state"]["browser-pairing"] === "TARGET-BROWSER" && state["electron-persisted-atom-state"].unknown === "TARGET-ATOM", "whole atom table must not copy");
  check(state["electron-persisted-atom-state"]["composer-auto-context-enabled"] === true && state["notifications-turn-mode"] === "always", "whitelisted UI values must merge");
  const manifest = JSON.parse(await get(result.backupDirectory, "manifest.json"));
  check(manifest.files.length === 9 && manifest.files.every(file => !file.relativePath.includes("auth") && !file.relativePath.endsWith(".rules")), "backup manifest must cover the complete changed set without credentials or approval rules");
  const noChange = await syncLocalSettings(target, source);
  check(noChange.changedFiles === 0 && noChange.backupDirectory === null, "identical settings must not create a backup");
  await put(target, "AGENTS.md", "later edit\n");
  await put(target, "unrelated.txt", "later unrelated file\n");
  const restored = await restoreLocalSettingsSync(target, result.backupDirectory);
  check(restored.restoredFiles === 8 && restored.conflicts.length === 1 && restored.conflicts[0] === "AGENTS.md", "restore must retain later edits as conflicts");
  check(await get(target, "AGENTS.md") === "later edit\n" && await get(target, "unrelated.txt") === "later unrelated file\n", "later changed and unrelated files must survive rollback");
  check(await get(target, "config.toml") === originalConfig && await get(target, ".codex-global-state.json") === originalState, "rollback must restore exact original config/state bytes");
  check(await get(target, "rules/default.rules") === targetRules, "rollback must not touch target execution approval rules");
  check(!(await exists(path.join(target, "instructions.md"))), "rollback must remove only newly introduced unchanged files");
  const secondRestore = await restoreLocalSettingsSync(target, result.backupDirectory);
  check(secondRestore.restoredFiles === 0 && secondRestore.conflicts.length === 1, "restore must be idempotent");

  const semantic = await fixture("semantic-noop");
  await put(semantic.source, "config.toml", "appearanceTheme = 'dark'\nmodel='ignored'\n");
  const commentConfig = "# KEEP-MANAGED-COMMENT\nappearanceTheme = \"dark\"\nmodel = \"target\"\n";
  await put(semantic.target, "config.toml", commentConfig);
  const semanticResult = await syncLocalSettings(semantic.target, semantic.source);
  check(semanticResult.changedFiles === 0 && await get(semantic.target, "config.toml") === commentConfig, "semantic no-op must preserve comments and bytes");
  await put(semantic.source, "config.toml", "appearanceTheme = { invalid = true }\nmodel_provider = 'ignored'\n");
  check((await syncLocalSettings(semantic.target, semantic.source)).changedFiles === 0, "invalid safe-field types must not copy");
  await put(semantic.source, "config.toml", "appearanceTheme = [ broken\n");
  await assert.rejects(syncLocalSettings(semantic.target, semantic.source)); assertions++;
  check(await get(semantic.target, "config.toml") === commentConfig, "malformed source TOML must leave target unchanged");
  await assert.rejects(syncLocalSettings(source, source), /overlap/); assertions++;
  await assert.rejects(syncLocalSettings(path.join(source, "child"), source), /overlap/); assertions++;
  await assert.rejects(syncLocalSettings(path.dirname(source), source), /overlap/); assertions++;
  await assert.rejects(syncLocalSettings(target, path.join(temporary, "missing-source")), /does not exist/); assertions++;
  await assert.rejects(restoreLocalSettingsSync(source, result.backupDirectory), /mismatched/); assertions++;

  const failure = await fixture("partial-failure");
  await put(failure.source, "AGENTS.md", "new agents\n");
  await put(failure.source, "instructions.md", "new instructions\n");
  await put(failure.target, "AGENTS.md", "old agents\n");
  await put(failure.target, "instructions.md", "old instructions\n");
  const rename = fs.rename;
  let injectFailure = true;
  fs.rename = async (from, to) => {
    if (injectFailure && to === path.join(failure.target, "instructions.md")) { injectFailure = false; throw new Error("fixture atomic replace failure"); }
    return rename(from, to);
  };
  try { await assert.rejects(syncLocalSettings(failure.target, failure.source), /recovery backup/); assertions++; }
  finally { fs.rename = rename; }
  check(await get(failure.target, "AGENTS.md") === "old agents\n" && await get(failure.target, "instructions.md") === "old instructions\n", "partial commit must restore already changed files");
  const failedBackups = await fs.readdir(path.join(path.dirname(failure.target), "backups"));
  const failureManifest = JSON.parse(await get(path.join(path.dirname(failure.target), "backups", failedBackups[0]), "manifest.json"));
  check(failureManifest.files.length === 2, "full recovery manifest must exist before partial commit");

  const backupFailure = await fixture("backup-failure");
  await put(backupFailure.source, "AGENTS.md", "new agents\n");
  await put(backupFailure.target, "AGENTS.md", "old agents\n");
  fs.rename = async (from, to) => {
    if (to.includes(`${path.sep}after${path.sep}`)) throw new Error("fixture backup failure");
    return rename(from, to);
  };
  try { await assert.rejects(syncLocalSettings(backupFailure.target, backupFailure.source), /fixture backup failure/); assertions++; }
  finally { fs.rename = rename; }
  check(await get(backupFailure.target, "AGENTS.md") === "old agents\n", "incomplete backup must prevent every target write");

  manifest.files.push({ relativePath: "auth.json", existedBefore: true });
  await put(result.backupDirectory, "manifest.json", JSON.stringify(manifest));
  await assert.rejects(restoreLocalSettingsSync(target, result.backupDirectory), /outside settings sync scope/); assertions++;
  check(await get(target, "auth.json") === "TARGET-ACCOUNT-SENTINEL", "restore must reject tampered manifest credential paths");

  const links = await fixture("links"), outside = path.join(links.base, "outside");
  await fs.mkdir(outside);
  await put(outside, "SKILL.md", "outside must not be read/copied\n");
  await fs.symlink(outside, path.join(links.source, "skills"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(syncLocalSettings(links.target, links.source), /links|reparse/i); assertions++;
  await fs.unlink(path.join(links.source, "skills"));
  await put(links.source, "skills/example/SKILL.md", "safe\n");
  await fs.symlink(outside, path.join(links.target, "skills"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(validateLocalSettingsSyncPaths(links.target, links.source), /links|reparse/i); assertions++;
  await assert.rejects(syncLocalSettings(links.target, links.source), /links|reparse/i); assertions++;
  check(await get(outside, "SKILL.md") === "outside must not be read/copied\n", "junction target must not change");
  const hardlinks = await fixture("hardlinks");
  await put(hardlinks.source, "config.toml", 'appearanceTheme = "dark"\n');
  await fs.link(path.join(hardlinks.source, "config.toml"), path.join(hardlinks.target, "config.toml"));
  await assert.rejects(validateLocalSettingsSyncPaths(hardlinks.target, hardlinks.source), /hard-linked/); assertions++;
  check(await get(hardlinks.source, "config.toml") === 'appearanceTheme = "dark"\n', "hard-link preflight must leave source configuration unchanged");
  console.log(`Local settings sync verification passed (${assertions} assertions; fixture directories only).`);
} finally {
  const resolved = path.resolve(temporary);
  if (!resolved.startsWith(path.resolve(work) + path.sep)) throw new Error("Refusing cleanup outside test workspace.");
  await fs.rm(resolved, { recursive: true, force: true });
}
