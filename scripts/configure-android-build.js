#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(projectRoot, "capacitor.config.json");
const packagePath = join(projectRoot, "package.json");
const activityPath = join(projectRoot, "android-native", "MainActivity.kt");

function fail(message) {
  console.error(`Android configuration error: ${message}`);
  process.exitCode = 1;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} could not be read as valid JSON (${error instanceof Error ? error.message : String(error)}).`);
  }
}

function runCap(cliPath, args) {
  const result = spawnSync(cliPath, args, {
    cwd: projectRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });

  if (result.error) {
    throw new Error(`Capacitor ${args.join(" ")} failed to start (${result.error.message}).`);
  }
  if (result.status !== 0) {
    throw new Error(`Capacitor ${args.join(" ")} exited with status ${result.status ?? "unknown"}.`);
  }
}

function run() {
  try {
    if (!existsSync(configPath)) throw new Error("capacitor.config.json is missing.");
    if (!existsSync(packagePath)) throw new Error("package.json is missing.");
    if (!existsSync(activityPath)) throw new Error("android-native/MainActivity.kt is missing.");

    const config = readJson(configPath, "capacitor.config.json");
    const packageJson = readJson(packagePath, "package.json");
    const appId = config.appId;
    if (typeof appId !== "string" || !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(appId)) {
      throw new Error("appId must be a valid, fully qualified Android application ID.");
    }
    if (typeof config.appName !== "string" || config.appName.trim().length === 0) {
      throw new Error("appName must be a non-empty string.");
    }
    if (typeof config.webDir !== "string" || config.webDir.trim().length === 0 || isAbsolute(config.webDir)) {
      throw new Error("webDir must be a non-empty path relative to the project root.");
    }
    if (config.webDir.split(/[\\/]/).includes("..")) {
      throw new Error("webDir must not escape the project root.");
    }
    if (config.server?.url) {
      throw new Error("server.url must not be set for a production build; configure a local dev server only when needed.");
    }
    const hasCapAndroid = Boolean(packageJson.dependencies?.["@capacitor/android"] || packageJson.devDependencies?.["@capacitor/android"]);
    const hasCapCli = Boolean(packageJson.devDependencies?.["@capacitor/cli"] || packageJson.dependencies?.["@capacitor/cli"]);
    if (!hasCapAndroid || !hasCapCli) {
      throw new Error("package.json must declare @capacitor/android and @capacitor/cli dependencies.");
    }

    const activitySource = readFileSync(activityPath, "utf8");
    const expectedPackage = `package ${appId}`;
    if (!activitySource.split(/\r?\n/).some((line) => line.trim() === expectedPackage)) {
      throw new Error(`MainActivity.kt package must match capacitor appId (${appId}).`);
    }

    const webRoot = resolve(projectRoot, config.webDir);
    const normalizedRoot = projectRoot.endsWith(sep) ? projectRoot : `${projectRoot}${sep}`;
    if (!webRoot.startsWith(normalizedRoot) || !existsSync(join(webRoot, "index.html"))) {
      throw new Error(`${config.webDir}/index.html is missing; build the web application before configuring Android.`);
    }

    const cliPath = join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "cap.cmd" : "cap");
    if (!existsSync(cliPath)) throw new Error("Local Capacitor CLI is not installed; run npm install or npm ci first.");

    const androidProjectExists = existsSync(join(projectRoot, "android", "settings.gradle"))
      || existsSync(join(projectRoot, "android", "settings.gradle.kts"));

    if (!androidProjectExists) {
      runCap(cliPath, ["add", "android"]);
    }
    runCap(cliPath, ["sync", "android"]);

    console.log(`Android project ${androidProjectExists ? "synchronized" : "created and synchronized"} successfully for ${appId}.`);
  } catch (error) {
    fail(error instanceof Error ? error.message : "An unexpected error occurred.");
  }
}

run();
