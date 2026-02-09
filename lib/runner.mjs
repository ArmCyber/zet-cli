import { pathToFileURL } from "node:url";
import { formatUncaughtError } from "./index.mjs";

const configPath = process.argv[2];
process.argv = [process.argv[0], configPath, ...process.argv.slice(3)];

let mod;
try {
  mod = await import(pathToFileURL(configPath).href);
} catch (err) {
  process.stderr.write(formatUncaughtError(err));
  process.exit(1);
}

if (!mod.default || typeof mod.default.init !== "function") {
  const red = !process.env.NO_COLOR && process.stderr.isTTY ? "\x1b[31m" : "";
  const reset = red ? "\x1b[0m" : "";
  process.stderr.write(
    `\n${red}zet: config file must \`export default zet\`${reset}\n`
  );
  process.exit(1);
}

await mod.default.init();
