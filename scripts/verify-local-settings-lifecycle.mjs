import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installNoDesktopFixtureGuard } from "./fixture-no-desktop.mjs";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.test-work");
await fs.mkdir(workspace, { recursive: true });
const fixture = await fs.mkdtemp(path.join(workspace, "settings-lifecycle-"));
process.env.CODEX_PROFILE_MANAGER_HOME_OVERRIDE = fixture;
process.env.CODEX_PROFILE_MANAGER_PLATFORM_OVERRIDE = "win32";
process.env.APPDATA = path.join(fixture, "AppData", "Roaming");
const desktopGuard = installNoDesktopFixtureGuard(fixture);
const source = path.join(fixture, ".codex");
await fs.mkdir(source, { recursive: true });
await fs.writeFile(path.join(source, "AGENTS.md"), "fixture local instructions");
await fs.writeFile(path.join(source, "config.toml"), 'appearanceTheme = "dark"\nmodel = "source-model"\nmodel_provider = "source-provider"\nsandbox_mode = "danger-full-access"\n');
await fs.writeFile(path.join(source, "mcp.json"), '{"doNotInherit":true}');
await fs.writeFile(path.join(source, ".codex-global-state.json"), JSON.stringify({ "notifications-turn-mode": "always", "account-id": "source-account", "thread-project-assignments": { sourceThread: "sourceProject" } }));
const executable = path.join(fixture, "ChatGPT.exe");
await fs.writeFile(executable, "not an executable: fixture only");

const service = await import("../dist-electron/main/profile-service.js");
const registry = await import("../dist-electron/main/registry.js");
const { settingsSyncStopBlocker } = await import("../dist-electron/main/runtime.js");
let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks++; }
function input(name, localSettingsSync) {
  return { name, authMode: "chatgpt_account", codexAppPath: executable, inheritDefaultConfig: true, localSettingsSync,
    provider: { type: "official_openai", displayName: "Own account", model: "target-model", reasoningEffort: "medium" } };
}
async function exists(file) { return fs.access(file).then(() => true, () => false); }
const profileUpdate = (profile, localSettingsSync) => ({ profileId: profile.id, localSettingsSync, provider: { displayName: profile.provider.displayName, baseUrl: profile.provider.baseUrl, model: profile.provider.model } });

try {
  const created = await service.createProfile(input("Enabled fixture", { enabled: true, source: { type: "default" } }));
  const target = created.profile.paths.codexHome;
  const targetConfig = await fs.readFile(path.join(target, "config.toml"), "utf8");
  check(targetConfig.includes('appearanceTheme = "dark"'), "creation should synchronize local display preferences");
  check(targetConfig.includes('model = "target-model"'), "target model must stay independent");
  check(!targetConfig.includes("source-provider") && !targetConfig.includes("danger-full-access"), "new sync must bypass legacy full config inheritance");
  check(!(await exists(path.join(target, "mcp.json"))), "legacy MCP resources must not be copied when the new option is enabled");
  check(!(await exists(path.join(target, "auth.json"))), "account profile creation must not create or copy authentication");
  const targetState = JSON.parse(await fs.readFile(path.join(target, ".codex-global-state.json"), "utf8"));
  check(targetState["notifications-turn-mode"] === "always" && !targetState["account-id"] && !targetState["thread-project-assignments"], "only local preference state should be inherited");

  const other = await service.createProfile({ ...input("Source fixture", { enabled: false, source: { type: "default" } }), inheritDefaultConfig: false });
  await fs.writeFile(path.join(other.profile.paths.codexHome, "AGENTS.md"), "other source instructions");
  await service.updateProfile(profileUpdate(created.profile, { enabled: false, source: { type: "profile", profileId: other.profile.id } }));
  const disabled = await registry.findProfile(created.profile.id);
  check(disabled.localSettingsSync.enabled === false && disabled.localSettingsSync.source.profileId === other.profile.id, "turning sync off must retain its selected source");
  await service.updateProfile(profileUpdate(created.profile, undefined));
  check((await registry.findProfile(created.profile.id)).localSettingsSync.source.profileId === other.profile.id, "unrelated edits must preserve settings sync policy");
  await assert.rejects(service.updateProfile(profileUpdate(created.profile, { enabled: true, source: { type: "profile", profileId: created.profile.id } })), /itself/); checks++;
  await service.deleteProfile(other.profile.id);
  await assert.rejects(service.updateProfile(profileUpdate(created.profile, { enabled: true, source: { type: "profile", profileId: other.profile.id } })), /unavailable/); checks++;
  const old = { ...created.profile }; delete old.localSettingsSync;
  const data = await registry.loadRegistry(); data.profiles.push({ ...old, id: "old-profile" }); await registry.saveRegistry(data);
  check((await registry.findProfile("old-profile")).localSettingsSync.enabled === false, "legacy registry entries must default to sync disabled");
  await assert.rejects(service.createProfile(input("Invalid source", { enabled: true, source: { type: "profile", profileId: "missing-profile" } })), /unavailable/); checks++;
  check(!(await service.listProfiles(true)).some(profile => profile.name === "Invalid source"), "invalid sources must be rejected before profile creation");

  const known = { ...created.profile, launch: { ...created.profile.launch, lastKnownPid: 123 } };
  check(settingsSyncStopBlocker(known, [{ pid: 12, name: "ChatGPT.exe", command: `ChatGPT.exe --user-data-dir="${known.paths.userDataDir}"` }]) !== null, "a running target must block settings replacement");
  const equivalentPath = known.paths.userDataDir.toLowerCase().replaceAll("\\", "/");
  for (const argument of [`--user-data-dir="${equivalentPath}"`, `"--user-data-dir=${equivalentPath}"`, `--user-data-dir "${equivalentPath}/"`]) {
    check(settingsSyncStopBlocker(known, [{ pid: 12, name: "ChatGPT.exe", command: `ChatGPT.exe ${argument}` }]) !== null, "equivalent Windows path arguments must block settings replacement");
  }
  check(settingsSyncStopBlocker(known, [{ pid: 12, name: "ChatGPT.exe", command: `ChatGPT.exe --user-data-dir="${known.paths.userDataDir}-another"` }]) === null, "a different profile with the same path prefix must not block settings sync");
  check(settingsSyncStopBlocker(known, [{ pid: 12, name: "ChatGPT.exe", command: "" }]) !== null, "unreadable Codex process information must not be treated as stopped");
  check(settingsSyncStopBlocker(known, [{ pid: 124, parentPid: 123, name: "codex.exe", command: "codex.exe app-server" }]) !== null, "a known orphan backend must block synchronization");
  check(settingsSyncStopBlocker(known, [{ pid: 12, name: "ChatGPT.exe", command: "ChatGPT.exe --user-data-dir=another-profile" }]) === null, "unrelated active profiles must be allowed to keep running");

  await service.updateProfile(profileUpdate(created.profile, { enabled: true, source: { type: "default" } }));
  await fs.writeFile(path.join(source, "AGENTS.md"), "updated at next startup");
  await fs.unlink(executable);
  await assert.rejects(service.openProfile(created.profile.id)); checks++;
  check((await fs.readFile(path.join(target, "AGENTS.md"), "utf8")) === "updated at next startup", "open must synchronize before attempting to launch the desktop executable");
  check(!(await exists(path.join(target, "auth.json"))), "startup sync must not write account authentication");
  await fs.writeFile(path.join(source, "config.toml"), "appearanceTheme = [broken");
  await assert.rejects(service.createProfile(input("Broken settings source", { enabled: true, source: { type: "default" } }))); checks++;
  check(!(await service.listProfiles(true)).some(profile => profile.name === "Broken settings source"), "failed settings synchronization must not leave a partially created profile in the registry");
  check(desktopGuard.stats.blockedDiscoveries > 0 && desktopGuard.stats.blockedDesktopLaunches === 0, "installed-desktop discovery must be suppressed and the fixture must stop before a desktop spawn attempt");
  console.log(`Local settings lifecycle verification passed (${checks} checks; no desktop or model request was launched).`);
} finally {
  desktopGuard.restore();
  const resolved = path.resolve(fixture);
  if (!resolved.startsWith(workspace + path.sep)) throw new Error("Refusing cleanup outside the fixture workspace.");
  await fs.rm(resolved, { recursive: true, force: true });
}
