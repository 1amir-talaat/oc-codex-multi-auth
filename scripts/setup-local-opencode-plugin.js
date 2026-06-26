#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInstaller } from "./install-oc-codex-multi-auth-core.js";

const PACKAGE_NAME = "oc-codex-multi-auth";
const LEGACY_PACKAGE_NAME = "oc-chatgpt-multi-auth";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

function printHelp() {
	console.log(`Usage: node scripts/setup-local-opencode-plugin.js [options]\n\n` +
		"Sets up a fresh or existing OpenCode install to use this local checkout.\n\n" +
		"Options:\n" +
		"  --dry-run              Show what would change without writing\n" +
		"  --skip-npm-install     Do not run npm install in this plugin repo\n" +
		"  --skip-build           Do not run npm run build in this plugin repo\n" +
		"  --skip-opencode-npm    Do not run npm install in ~/.config/opencode\n" +
		"  --modern               Use compact modern OpenCode config (default)\n" +
		"  --full                 Use full model catalog config\n" +
		"  --legacy               Use legacy explicit model config\n" +
		"  -h, --help             Show this help\n");
}

function parseArgs(argv) {
	const args = new Set(argv);
	if (args.has("--help") || args.has("-h")) return { help: true };
	const modes = ["--modern", "--full", "--legacy"].filter((flag) => args.has(flag));
	if (modes.length > 1) {
		throw new Error("Choose only one of --modern, --full, or --legacy.");
	}
	for (const arg of args) {
		if (![
			"--dry-run",
			"--skip-npm-install",
			"--skip-build",
			"--skip-opencode-npm",
			"--modern",
			"--full",
			"--legacy",
		].includes(arg)) {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	return {
		help: false,
		dryRun: args.has("--dry-run"),
		skipNpmInstall: args.has("--skip-npm-install"),
		skipBuild: args.has("--skip-build"),
		skipOpencodeNpm: args.has("--skip-opencode-npm"),
		mode: args.has("--full") ? "--full" : args.has("--legacy") ? "--legacy" : "--modern",
	};
}

function log(message) {
	console.log(message);
}

function commandExists(command) {
	return new Promise((resolveExists) => {
		const child = spawn(command, ["--version"], { stdio: "ignore" });
		child.on("error", () => resolveExists(false));
		child.on("close", (code) => resolveExists(code === 0));
	});
}

async function run(command, args, options = {}) {
	if (options.dryRun) {
		log(`[dry-run] Would run: ${command} ${args.join(" ")} (${options.cwd ?? process.cwd()})`);
		return;
	}
	await new Promise((resolveRun, rejectRun) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			stdio: "inherit",
			env: process.env,
		});
		child.on("error", rejectRun);
		child.on("close", (code) => {
			if (code === 0) resolveRun();
			else rejectRun(new Error(`${command} ${args.join(" ")} exited with ${code}`));
		});
	});
}

async function readJsonIfExists(path) {
	if (!existsSync(path)) return undefined;
	return JSON.parse(stripJsonComments(await readFile(path, "utf8")));
}

function stripJsonComments(content) {
	let output = "";
	let inString = false;
	let stringQuote = "";
	let escaped = false;
	for (let index = 0; index < content.length; index += 1) {
		const char = content[index];
		const next = content[index + 1];
		if (inString) {
			output += char;
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === stringQuote) {
				inString = false;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			inString = true;
			stringQuote = char;
			output += char;
			continue;
		}
		if (char === "/" && next === "/") {
			while (index < content.length && content[index] !== "\n") index += 1;
			output += "\n";
			continue;
		}
		if (char === "/" && next === "*") {
			index += 2;
			while (index < content.length && !(content[index] === "*" && content[index + 1] === "/")) index += 1;
			index += 1;
			continue;
		}
		output += char;
	}
	return output;
}

function formatJson(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function isManagedPluginEntry(entry) {
	if (typeof entry !== "string") return false;
	const normalized = entry.trim().toLowerCase().replace(/\\/g, "/");
	return normalized === PACKAGE_NAME ||
		normalized.startsWith(`${PACKAGE_NAME}@`) ||
		normalized === LEGACY_PACKAGE_NAME ||
		normalized.startsWith(`${LEGACY_PACKAGE_NAME}@`) ||
		normalized.endsWith(`/${PACKAGE_NAME}`) ||
		normalized.endsWith(`/${LEGACY_PACKAGE_NAME}`) ||
		normalized.endsWith(`/${PACKAGE_NAME}/dist/index.js`) ||
		normalized.endsWith(`/${PACKAGE_NAME}/dist/tui.js`) ||
		normalized.endsWith("/oc-codex-multi-auth/dist/index.js") ||
		normalized.endsWith("/oc-codex-multi-auth/dist/tui.js");
}

function withOnlyLocalPlugin(existingPlugin, localPluginUrl) {
	const entries = Array.isArray(existingPlugin) ? existingPlugin : [];
	const filtered = entries.filter((entry) => !isManagedPluginEntry(entry));
	return [...filtered, localPluginUrl];
}

async function patchPluginConfig(path, localPluginUrl, dryRun) {
	const config = await readJsonIfExists(path) ?? {};
	config.plugin = withOnlyLocalPlugin(config.plugin, localPluginUrl);
	if (dryRun) {
		log(`[dry-run] Would write ${path} with plugin ${localPluginUrl}`);
		return;
	}
	await writeFile(path, formatJson(config));
	log(`Pinned ${path} to ${localPluginUrl}`);
}

async function patchOpencodePackage(configDir, dryRun) {
	const packagePath = resolve(configDir, "package.json");
	const packageJson = await readJsonIfExists(packagePath) ?? {};
	const dependencies = packageJson.dependencies && typeof packageJson.dependencies === "object"
		? { ...packageJson.dependencies }
		: {};
	const relativeRepo = relative(configDir, repoRoot).replace(/\\/g, "/");
	dependencies[PACKAGE_NAME] = `file:${relativeRepo.startsWith(".") ? relativeRepo : `./${relativeRepo}`}`;
	packageJson.dependencies = dependencies;
	if (dryRun) {
		log(`[dry-run] Would write ${packagePath} with ${PACKAGE_NAME}: ${dependencies[PACKAGE_NAME]}`);
		return;
	}
	await writeFile(packagePath, formatJson(packageJson));
	log(`Pinned ${PACKAGE_NAME} dependency in ${packagePath} to ${dependencies[PACKAGE_NAME]}`);
}

async function clearOpencodePluginCache(homeDir, dryRun) {
	const cacheRoot = resolve(homeDir, ".cache", "opencode");
	const paths = [
		resolve(cacheRoot, "node_modules", PACKAGE_NAME),
		resolve(cacheRoot, "node_modules", LEGACY_PACKAGE_NAME),
		resolve(cacheRoot, "packages", PACKAGE_NAME),
		resolve(cacheRoot, "packages", `${PACKAGE_NAME}@latest`),
		resolve(cacheRoot, "packages", LEGACY_PACKAGE_NAME),
		resolve(cacheRoot, "packages", `${LEGACY_PACKAGE_NAME}@latest`),
		resolve(cacheRoot, "bun.lock"),
	];
	for (const cachePath of paths) {
		if (dryRun) {
			log(`[dry-run] Would remove ${cachePath}`);
		} else {
			await rm(cachePath, { recursive: true, force: true });
		}
	}
	if (!dryRun) log("Cleared OpenCode plugin cache for local setup.");
}

async function main() {
	const parsed = parseArgs(process.argv.slice(2));
	if (parsed.help) {
		printHelp();
		return;
	}

	const homeDir = process.env.HOME || homedir();
	const configDir = resolve(homeDir, ".config", "opencode");
	const opencodeConfigPath = resolve(configDir, "opencode.json");
	const opencodeJsoncConfigPath = resolve(configDir, "opencode.jsonc");
	const tuiConfigPath = resolve(configDir, "tui.json");
	const indexDistPath = resolve(repoRoot, "dist", "index.js");
	const tuiDistPath = resolve(repoRoot, "dist", "tui.js");
	const indexPluginUrl = pathToFileURL(indexDistPath).href;
	const tuiPluginUrl = pathToFileURL(tuiDistPath).href;

	if (!existsSync(resolve(repoRoot, "package.json"))) {
		throw new Error(`Could not find package.json at ${repoRoot}. Run this script from the cloned ${PACKAGE_NAME} repo.`);
	}
	if (!(await commandExists("npm"))) {
		throw new Error("npm is required for local setup but was not found on PATH.");
	}

	if (!parsed.skipNpmInstall) {
		await run("npm", ["install"], { cwd: repoRoot, dryRun: parsed.dryRun });
	}
	if (!parsed.skipBuild) {
		await run("npm", ["run", "build"], { cwd: repoRoot, dryRun: parsed.dryRun });
	}
	if (!parsed.dryRun && (!existsSync(indexDistPath) || !existsSync(tuiDistPath))) {
		throw new Error("dist/index.js or dist/tui.js is missing. Run npm run build first.");
	}

	if (!parsed.dryRun) await mkdir(configDir, { recursive: true });

	await runInstaller([parsed.mode, parsed.dryRun ? "--dry-run" : ""].filter(Boolean), {
		env: process.env,
	});

	await patchPluginConfig(opencodeConfigPath, indexPluginUrl, parsed.dryRun);
	if (existsSync(opencodeJsoncConfigPath)) {
		await patchPluginConfig(opencodeJsoncConfigPath, indexPluginUrl, parsed.dryRun);
	}
	await patchPluginConfig(tuiConfigPath, tuiPluginUrl, parsed.dryRun);
	await patchOpencodePackage(configDir, parsed.dryRun);
	if (!parsed.skipOpencodeNpm) {
		await run("npm", ["install"], { cwd: configDir, dryRun: parsed.dryRun });
	}
	await clearOpencodePluginCache(homeDir, parsed.dryRun);

	log("\nLocal OpenCode setup complete.");
	log(`Provider plugin: ${indexPluginUrl}`);
	log(`TUI plugin:      ${tuiPluginUrl}`);
	log("Restart OpenCode for changes to take effect.");
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Local setup failed: ${message}`);
	process.exit(1);
});
