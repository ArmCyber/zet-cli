#!/usr/bin/env node

import { existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONFIG_NAMES = ["zet.config.mjs"];

// ---------------------------------------------------------------------------
// zet init — handled before config search (no config exists yet)
// ---------------------------------------------------------------------------

const cliArgs = process.argv.slice(2);
if (cliArgs[0] === "init") {
  const configFile = join(process.cwd(), "zet.config.mjs");
  if (existsSync(configFile)) {
    process.stderr.write("zet is already initialized in this directory\n");
    process.exit(1);
  }
  writeFileSync(
    configFile,
    `import zet from 'zet-cli';

zet.register('hello')
   .description('Say hello')
   .command('echo', 'Hello from ZET!');

export default zet;
`
  );
  process.stdout.write("Created zet.config.mjs\n");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Config search
// ---------------------------------------------------------------------------

function findConfig(startDir) {
  let dir = startDir;
  while (true) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const configPath = findConfig(process.cwd());

if (!configPath) {
  process.stderr.write(
    "zet: cannot find zet.config.mjs in the current or any parent directory\n"
  );
  process.exit(1);
}

// Register a module resolution hook so configs can `import zet from 'zet-cli'`
const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const [major, minor] = process.versions.node.split(".").map(Number);

if (major < 18 || (major === 18 && minor < 19)) {
  const y = !process.env.NO_COLOR && process.stderr.isTTY ? "\x1b[1;33m" : "";
  const r = y ? "\x1b[0m" : "";
  process.stderr.write(
    `${y}zet: Node.js ${process.versions.node} is not supported and may cause unexpected behavior. Upgrade to Node.js 18.19 or later.${r}\n`
  );
}

const nodeArgs = [];

if (major > 20 || (major === 20 && minor >= 6) || (major === 18 && minor >= 19)) {
  nodeArgs.push(
    "--import",
    pathToFileURL(join(pkgRoot, "lib", "register.mjs")).href
  );
} else {
  nodeArgs.push(
    "--loader",
    pathToFileURL(join(pkgRoot, "lib", "loader.mjs")).href
  );
}

const runnerPath = join(pkgRoot, "lib", "runner.mjs");
const projectRoot = dirname(configPath);

const child = spawn(
  process.execPath,
  [...nodeArgs, runnerPath, configPath, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      ZET_ROOT_DIR: projectRoot,
    },
  }
);

child.on("close", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});
