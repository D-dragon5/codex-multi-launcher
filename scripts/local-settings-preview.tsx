// Development-only renderer preview. No Electron, filesystem, network API, or accounts.
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "../src/renderer/App";
import "../src/renderer/styles.css";
import type { CodexApi, ManagedProfile } from "../src/shared/types";

function profile(id: string, name: string): ManagedProfile {
  return { id, name, status: "active", paths: { codexAppPath: "Preview/ChatGPT.exe", codexHome: `Preview/${id}/codex-home`, userDataDir: `Preview/${id}/user-data`, launcherPath: `Preview/${id}.cmd` },
    auth: { mode: "chatgpt_account" }, provider: { type: "official_openai", id: "openai", displayName: "ChatGPT 账号", wireApi: "responses", envKeyName: "OPENAI_API_KEY", model: "preview-model", reasoningEffort: "medium" },
    appearance: { iconBackgroundColor: id === "plus" ? "#F59E0B" : "#34C759" },
    launch: { lastLaunchedAt: null, lastKnownPid: null, lastKnownUserDataDir: `Preview/${id}/user-data` },
    timestamps: { createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z" },
    localSettingsSync: { enabled: false, source: { type: "default" } } };
}
let profiles = [profile("pro", "示例 Pro"), profile("plus", "示例 Plus")];
const appInfo = { name: "设置同步预览", version: "0.1.9-local", author: "Preview", authorUrl: "https://github.com/JqyModi", repositoryUrl: "https://github.com/JqyModi/codex-multi-launcher", releasesUrl: "https://github.com/JqyModi/codex-multi-launcher/releases", issuesUrl: "https://github.com/JqyModi/codex-multi-launcher/issues", sponsorUrl: "", productPageUrl: "" };
const mock: Partial<CodexApi> = {
  getAppInfo: async () => appInfo,
  getAnnouncement: async () => ({ item: null, source: "none", fetchedAt: new Date().toISOString() }),
  checkForUpdates: async () => ({ status: "up_to_date", currentVersion: "0.1.9-local", latestVersion: "0.1.9-local" }),
  onUpdateEvent: () => () => {},
  getEnvironmentReport: async () => ({ codexAppPath: "Preview/ChatGPT.exe", codexExecutablePath: "Preview/ChatGPT.exe", codexAppExists: true, codexExecutableExists: true, codexCliPath: null, codexCliVersion: null, nodePath: null, nodeVersion: null, checks: [] }),
  listProfiles: async () => structuredClone(profiles),
  getRuntimeStatus: async () => profiles.map(item => ({ profileId: item.id, status: "not_running", pid: null, detail: "模拟数据" })),
  listConfigBackups: async () => [],
  updateProfile: async input => {
    const item = profiles.find(value => value.id === input.profileId)!;
    item.localSettingsSync = structuredClone(input.localSettingsSync ?? item.localSettingsSync);
    return { profile: structuredClone(item), configPath: "Preview/config.toml", launcherPath: item.paths.launcherPath };
  },
  createProfile: async input => {
    const item = profile(`preview-${profiles.length}`, input.name);
    item.localSettingsSync = structuredClone(input.localSettingsSync ?? item.localSettingsSync);
    profiles = [...profiles, item];
    return { profile: item, configPath: "Preview/config.toml", launcherPath: item.paths.launcherPath };
  },
  openProfile: async () => ({ pid: null })
};
window.codexProfileManager = new Proxy(mock, { get: (target, key) => Reflect.get(target, key) ?? (async () => { throw new Error("此预览不执行真实操作。"); }) }) as CodexApi;
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
