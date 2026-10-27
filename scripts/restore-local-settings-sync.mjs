import path from "node:path";
import fs from "node:fs/promises";
import { restoreLocalSettingsSync } from "../dist-electron/main/local-settings-sync.js";
import { assertProfileStoppedForSettingsSync } from "../dist-electron/main/runtime.js";
import { listProfiles } from "../dist-electron/main/registry.js";

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const positional = args.filter(arg => arg !== "--execute");
if (positional.length !== 2) {
  throw new Error("Usage: npm run restore:local-settings -- <profile-id> <backup-directory> [--execute]. Fully quit the target Codex profile first. Without --execute this only shows the restore plan.");
}
const [profileId, backupDirectory] = positional;
const profile = (await listProfiles(true)).find(item => item.id === profileId);
if (!profile) throw new Error("Managed profile not found.");
const backup = path.resolve(backupDirectory);
const manifest = JSON.parse(await fs.readFile(path.join(backup, "manifest.json"), "utf8"));
if (manifest.targetHome !== path.resolve(profile.paths.codexHome)) throw new Error("Backup belongs to another target profile.");
if (!execute) {
  console.log(JSON.stringify({ planOnly: true, profileId, targetHome: profile.paths.codexHome, backupDirectory: backup, trackedFiles: manifest.files?.length ?? 0 }));
} else {
  await assertProfileStoppedForSettingsSync(profile);
  const result = await restoreLocalSettingsSync(profile.paths.codexHome, backup);
  console.log(JSON.stringify(result));
  if (result.conflicts.length) process.exitCode = 2;
}
