import { spawn as nodeSpawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Color helpers (respects NO_COLOR and TTY)
// ---------------------------------------------------------------------------

const noColor = !!process.env.NO_COLOR;

function outAnsi(code) {
  return !noColor && process.stdout.isTTY ? `\x1b[${code}m` : "";
}

function errAnsi(code) {
  return !noColor && process.stderr.isTTY ? `\x1b[${code}m` : "";
}

// ---------------------------------------------------------------------------
// Uncaught error handler — friendly output for config-time errors
// ---------------------------------------------------------------------------

const PKG_ROOT_URL = new URL("../", import.meta.url).href;

function formatUncaughtError(err) {
  const red = errAnsi("31");
  const dim = errAnsi("2");
  const reset = errAnsi("0");

  let output = `\n${red}zet: ${err.message}${reset}\n`;

  if (err.stack) {
    const stackLines = err.stack.split("\n").slice(1);
    const userLines = stackLines.filter((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("at ")) return false;
      if (trimmed.includes(PKG_ROOT_URL)) return false;
      if (trimmed.includes("node:")) return false;
      return true;
    });

    if (userLines.length > 0) {
      output += "\n";
      for (const line of userLines) {
        output += `${dim}${line}${reset}\n`;
      }
    }
  }

  return output;
}

process.on("uncaughtException", (err) => {
  process.stderr.write(formatUncaughtError(err));
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  process.stderr.write(formatUncaughtError(err));
  process.exit(1);
});

// ---------------------------------------------------------------------------
// CommandOutput
// ---------------------------------------------------------------------------

class CommandOutput {
  constructor(code, output, stdout, stderr) {
    this.code = code;
    this.output = output;
    this.stdout = stdout;
    this.stderr = stderr;
  }

  get success() {
    return this.code === 0;
  }

  get failed() {
    return this.code !== 0;
  }

  throw() {
    if (this.failed) {
      throw new Error(`Command failed with exit code ${this.code}`);
    }
    return this;
  }
}

// ---------------------------------------------------------------------------
// TemplateResult — wrapper so .command() can recognize and spread it
// ---------------------------------------------------------------------------

class TemplateResult {
  constructor(parts) {
    this.parts = parts;
  }
}

// ---------------------------------------------------------------------------
// RestPlaceholder — sentinel returned by zet.rest()
// ---------------------------------------------------------------------------

class RestPlaceholder {}

const REST_PLACEHOLDER = new RestPlaceholder();

// ---------------------------------------------------------------------------
// Signature parsing
// ---------------------------------------------------------------------------

const TOKEN_RE = /\{[^}]+\}|\.\.\.|[^\s{}]+/g;

function validateOptionName(raw) {
  // raw without leading --
  const name = raw.replace(/^--/, "");
  const segments = name.split("-");
  for (const seg of segments) {
    if (seg.length === 0) continue;
    // First char may be uppercase
    // Rest must be lowercase or digits
    for (let i = 1; i < seg.length; i++) {
      if (seg[i] >= "A" && seg[i] <= "Z") {
        throw new Error(
          `Invalid option name '--${name}': uppercase letters are only allowed at the start of hyphen-separated segments`
        );
      }
    }
  }
}

function extractShortFlag(name) {
  // name is without --, e.g. "Preserve-Cache"
  const segments = name.split("-");
  let short = "";
  for (const seg of segments) {
    if (seg.length > 0 && seg[0] >= "A" && seg[0] <= "Z") {
      short += seg[0];
    }
  }
  return short.length > 0 ? `-${short}` : null;
}

function parseSignature(signature) {
  const tokens = signature.match(TOKEN_RE);
  if (!tokens || tokens.length === 0) {
    throw new Error("Empty signature");
  }

  const name = tokens[0];
  const args = [];
  const options = [];
  let acceptsRest = false;

  let seenOptional = false;

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];

    if (tok === "...") {
      acceptsRest = true;
      continue;
    }

    if (tok.startsWith("{") && tok.endsWith("}")) {
      const inner = tok.slice(1, -1).trim();

      if (inner.startsWith("--")) {
        // Option
        const m = inner.match(/^--([a-zA-Z][\w-]*)([=])?\s*([\s\S]*)?$/);
        if (!m) throw new Error(`Invalid option syntax: ${tok}`);
        const rawName = m[1];
        const hasEquals = !!m[2];
        const desc = (m[3] || "").trim();

        validateOptionName(rawName);

        const longName = rawName.toLowerCase();
        const shortFlag = extractShortFlag(rawName);

        options.push({
          long: `--${longName}`,
          short: shortFlag,
          acceptsValue: hasEquals,
          description: desc,
        });
      } else {
        // Argument
        const m = inner.match(/^([a-zA-Z]\w*)(\?)?\s*([\s\S]*)?$/);
        if (!m) throw new Error(`Invalid argument syntax: ${tok}`);
        const argName = m[1];
        const optional = !!m[2];
        const desc = (m[3] || "").trim();

        if (!optional && seenOptional) {
          throw new Error(
            `Required argument '${argName}' cannot follow an optional argument`
          );
        }
        if (optional) seenOptional = true;

        args.push({
          name: argName,
          required: !optional,
          description: desc,
        });
      }
    } else {
      // Bare word after command name — multi-word command names not allowed
      throw new Error(
        `Unexpected token '${tok}' in signature — command names must be a single word`
      );
    }
  }

  // Check for duplicate names
  const allNames = new Set();
  for (const a of args) {
    if (allNames.has(a.name)) {
      throw new Error(`Duplicate argument name '${a.name}'`);
    }
    allNames.add(a.name);
  }
  for (const o of options) {
    if (allNames.has(o.long)) {
      throw new Error(`Duplicate option name '${o.long}'`);
    }
    allNames.add(o.long);
  }

  return { name, args, options, acceptsRest };
}

// ---------------------------------------------------------------------------
// Command, CommandBuilder, Group
// ---------------------------------------------------------------------------

class Command {
  constructor(name, group, signature) {
    this.name = name;
    this.group = group;
    this.signature = signature;
    this.description = "";
    this.type = null; // 'command' or 'callback'
    this.parts = null;
    this.callback = null;
  }
}

class CommandBuilder {
  constructor(cmd) {
    this._cmd = cmd;
  }

  description(text) {
    this._cmd.description = text;
    return this;
  }

  command(...parts) {
    this._cmd.type = "command";
    this._cmd.parts = parts;
    return this;
  }

  callback(fn) {
    this._cmd.type = "callback";
    this._cmd.callback = fn;
    return this;
  }
}

class Group {
  constructor(prefix, description) {
    this.prefix = prefix;
    this.description = description;
    this.commands = new Map();
  }

  register(signature) {
    const parsed = parseSignature(signature);

    if (this.commands.has(parsed.name)) {
      throw new Error(
        `Duplicate command '${parsed.name}' in group '${this.prefix || "root"}'`
      );
    }

    const cmd = new Command(parsed.name, this, parsed);
    this.commands.set(parsed.name, cmd);
    return new CommandBuilder(cmd);
  }
}

// ---------------------------------------------------------------------------
// Singleton zet object
// ---------------------------------------------------------------------------

const rootGroup = new Group("", "Commands");
const groups = new Map();

let parsedArgs = {};
let parsedOptions = {};
let restArgs = [];
let matchedCommand = null;

function flattenParts(parts) {
  const result = [];
  for (const part of parts) {
    if (part instanceof TemplateResult) {
      result.push(...flattenParts(part.parts));
    } else if (part instanceof RestPlaceholder) {
      result.push(...restArgs);
    } else if (Array.isArray(part)) {
      result.push(...flattenParts(part));
    } else {
      result.push(String(part));
    }
  }
  return result;
}

function spawnCommand(parts, options) {
  return new Promise((resolve) => {
    const flat = flattenParts(parts);
    const [cmd, ...args] = flat;
    const child = nodeSpawn(cmd, args, options);

    if (options.stdio === "pipe") {
      const allChunks = [];
      const outChunks = [];
      const errChunks = [];
      child.stdout.on("data", (d) => { allChunks.push(d); outChunks.push(d); });
      child.stderr.on("data", (d) => { allChunks.push(d); errChunks.push(d); });
      child.on("close", (code) => {
        resolve(new CommandOutput(
          code ?? 1,
          Buffer.concat(allChunks).toString(),
          Buffer.concat(outChunks).toString(),
          Buffer.concat(errChunks).toString(),
        ));
      });
    } else {
      child.on("close", (code) => {
        resolve(new CommandOutput(code ?? 1, null, null, null));
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Help formatting
// ---------------------------------------------------------------------------

function formatGlobalHelp() {
  const lines = [];
  lines.push("Usage: zet <command> [options]");
  lines.push("");

  // Collect all groups with commands
  const sections = [];

  for (const [, g] of groups) {
    if (g.commands.size > 0) {
      const entries = [];
      for (const [, cmd] of g.commands) {
        const label = `${g.prefix} ${cmd.name}`;
        entries.push({ label, description: cmd.description });
      }
      sections.push({ title: g.description || g.prefix, entries });
    }
  }

  // Root commands
  if (rootGroup.commands.size > 0) {
    const entries = [];
    for (const [, cmd] of rootGroup.commands) {
      let label = cmd.name;
      if (cmd.signature.acceptsRest) label += " ...";
      entries.push({ label, description: cmd.description });
    }
    sections.push({ title: "Commands", entries });
  }

  // Find max label width
  let maxWidth = 0;
  for (const section of sections) {
    for (const e of section.entries) {
      if (e.label.length > maxWidth) maxWidth = e.label.length;
    }
  }

  for (const section of sections) {
    lines.push(`${section.title}:`);
    for (const e of section.entries) {
      const padding = " ".repeat(maxWidth - e.label.length + 4);
      lines.push(`  ${e.label}${padding}${e.description}`);
    }
    lines.push("");
  }

  lines.push(`Run "zet <command> --help" for more information.`);
  return lines.join("\n");
}

function formatCommandHelp(cmd) {
  const sig = cmd.signature;
  const lines = [];

  // Usage line
  let usage = "Usage: zet ";
  if (cmd.group && cmd.group.prefix) {
    usage += `${cmd.group.prefix} `;
  }
  usage += cmd.name;
  if (sig.args.length > 0) {
    const argParts = sig.args.map((a) =>
      a.required ? `<${a.name}>` : `[${a.name}]`
    );
    usage += ` ${argParts.join(" ")}`;
  }
  if (sig.acceptsRest) usage += " [args...]";
  if (sig.options.length > 0) usage += " [options]";
  lines.push(usage);

  if (cmd.description) {
    lines.push("");
    lines.push(`  ${cmd.description}`);
  }

  // Arguments
  if (sig.args.length > 0) {
    lines.push("");
    lines.push("Arguments:");
    let maxWidth = 0;
    for (const a of sig.args) {
      if (a.name.length > maxWidth) maxWidth = a.name.length;
    }
    // Account for " (required)" suffix
    for (const a of sig.args) {
      const suffix = a.required ? " (required)" : "";
      const desc = a.description || "";
      const padding = " ".repeat(maxWidth - a.name.length + 4);
      lines.push(`  ${a.name}${padding}${desc}${suffix}`);
    }
  }

  // Options
  lines.push("");
  lines.push("Options:");
  const optEntries = [];
  for (const o of sig.options) {
    let label = o.long;
    if (o.acceptsValue) label += " <value>";
    if (o.short) label += `, ${o.short}`;
    optEntries.push({ label, description: o.description || "" });
  }
  optEntries.push({ label: "--help, -h", description: "Show help" });

  let maxOptWidth = 0;
  for (const e of optEntries) {
    if (e.label.length > maxOptWidth) maxOptWidth = e.label.length;
  }
  for (const e of optEntries) {
    const padding = " ".repeat(maxOptWidth - e.label.length + 4);
    lines.push(`  ${e.label}${padding}${e.description}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

function parseArgv(argv, cmd) {
  const sig = cmd.signature;
  const args = {};
  const opts = {};
  const rest = [];

  // Build option lookup maps
  const longMap = new Map(); // --name → option def
  const shortMap = new Map(); // -X → option def
  for (const o of sig.options) {
    longMap.set(o.long, o);
    if (o.short) shortMap.set(o.short, o);
  }

  let positionalIndex = 0;
  let stopParsing = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (!stopParsing && token === "--") {
      stopParsing = true;
      continue;
    }

    if (!stopParsing && (token === "--help" || token === "-h")) {
      return { help: true };
    }

    if (!stopParsing && token.startsWith("--")) {
      // Long option
      let name, value;
      const eqIdx = token.indexOf("=");
      if (eqIdx !== -1) {
        name = token.slice(0, eqIdx);
        value = token.slice(eqIdx + 1);
      } else {
        name = token;
        value = undefined;
      }

      const normalizedName = `--${name.slice(2).toLowerCase()}`;
      const optDef = longMap.get(normalizedName);
      if (!optDef) {
        if (sig.acceptsRest) {
          rest.push(token);
          continue;
        }
        return {
          error: `unknown option '${name}'`,
          cmd,
        };
      }

      if (optDef.acceptsValue) {
        if (value !== undefined) {
          opts[optDef.long] = value;
        } else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
          opts[optDef.long] = argv[++i];
        } else {
          return {
            error: `option '${optDef.long}' requires a value`,
            cmd,
          };
        }
      } else {
        if (value !== undefined) {
          return {
            error: `option '${optDef.long}' does not accept a value`,
            cmd,
          };
        }
        opts[optDef.long] = true;
      }
      continue;
    }

    if (!stopParsing && token.startsWith("-") && token.length > 1 && !token.startsWith("--")) {
      // Short option
      const optDef = shortMap.get(token);
      if (!optDef) {
        if (sig.acceptsRest) {
          rest.push(token);
          continue;
        }
        return {
          error: `unknown option '${token}'`,
          cmd,
        };
      }

      if (optDef.acceptsValue) {
        if (i + 1 < argv.length) {
          opts[optDef.long] = argv[++i];
        } else {
          return {
            error: `option '${optDef.long}' requires a value`,
            cmd,
          };
        }
      } else {
        opts[optDef.long] = true;
      }
      continue;
    }

    // Positional
    if (positionalIndex < sig.args.length) {
      args[sig.args[positionalIndex].name] = token;
      positionalIndex++;
    } else if (sig.acceptsRest) {
      rest.push(token);
    } else {
      return {
        error: `unexpected argument '${token}' for command '${cmd.name}'`,
        cmd,
      };
    }
  }

  // Validate required args
  for (let j = 0; j < sig.args.length; j++) {
    if (sig.args[j].required && !(sig.args[j].name in args)) {
      return {
        error: `missing required argument '${sig.args[j].name}'`,
        cmd,
      };
    }
  }

  return { args, options: opts, rest };
}

function formatUsageLine(cmd) {
  const sig = cmd.signature;
  let usage = "Usage: zet ";
  if (cmd.group && cmd.group.prefix) {
    usage += `${cmd.group.prefix} `;
  }
  usage += cmd.name;
  for (const a of sig.args) {
    usage += a.required ? ` <${a.name}>` : ` [${a.name}]`;
  }
  if (sig.acceptsRest) usage += " [args...]";
  if (sig.options.length > 0) usage += " [options]";
  return usage;
}

// ---------------------------------------------------------------------------
// The zet singleton
// ---------------------------------------------------------------------------

const zet = {
  // --- Registration ---
  group(prefix, description) {
    if (prefix === "cli") {
      throw new Error("The group prefix 'cli' is reserved");
    }
    if (groups.has(prefix)) {
      throw new Error(`Group '${prefix}' already exists`);
    }
    const g = new Group(prefix, description);
    groups.set(prefix, g);
    return g;
  },

  template(fn) {
    return function (...args) {
      if (fn.length > 0 && args.length < fn.length) {
        throw new Error(
          `Template expects ${fn.length} arguments, got ${args.length}`
        );
      }
      const result = fn(...args);
      if (!Array.isArray(result)) {
        throw new Error("Template function must return an array");
      }
      return new TemplateResult(result);
    };
  },

  // --- Placeholders ---
  rest() {
    return REST_PLACEHOLDER;
  },

  // --- Import sub-config relative to project root ---
  async import(path) {
    const rootDir = process.env.ZET_ROOT_DIR || process.cwd();
    const fullPath = join(rootDir, path);
    return import(pathToFileURL(fullPath).href);
  },

  // --- Registration shortcut (root group) ---
  register(signature) {
    return rootGroup.register(signature);
  },

  // --- Runtime accessors ---
  argument(name) {
    return parsedArgs[name] ?? null;
  },

  option(name) {
    return parsedOptions[name] ?? null;
  },

  hasOption(name) {
    return name in parsedOptions;
  },

  hasArgument(name) {
    return name in parsedArgs;
  },

  userPath(subpath) {
    const base = process.cwd();
    if (subpath === undefined) return base;
    if (subpath === "/") return base + "/";
    return join(base, subpath);
  },

  rootPath(subpath) {
    const base = process.env.ZET_ROOT_DIR || process.cwd();
    if (subpath === undefined) return base;
    if (subpath === "/") return base + "/";
    return join(base, subpath);
  },

  // --- Output helpers ---
  info(msg) {
    process.stdout.write(`${outAnsi("32")}${msg}${outAnsi("0")}\n`);
  },

  error(msg) {
    process.stderr.write(`${errAnsi("31")}${msg}${errAnsi("0")}\n`);
  },

  warning(msg) {
    process.stderr.write(`${errAnsi("33")}${msg}${errAnsi("0")}\n`);
  },

  line(msg) {
    process.stdout.write(`${msg}\n`);
  },

  // --- Process control ---
  exit(code = 0) {
    process.exit(code);
  },

  async command(...parts) {
    return spawnCommand(parts, { stdio: "inherit" });
  },

  async silentCommand(...parts) {
    return spawnCommand(parts, { stdio: "pipe" });
  },

  // --- Lifecycle ---
  async init() {
    const argv = process.argv.slice(2);

    // No args or --help → global help
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
      process.stdout.write(formatGlobalHelp() + "\n");
      process.exit(0);
    }

    // Command resolution
    let targetCmd = null;
    let remainingArgv = [];

    const firstArg = argv[0];

    // Check group prefixes first
    if (groups.has(firstArg)) {
      const group = groups.get(firstArg);
      if (argv.length < 2) {
        process.stderr.write(`${errAnsi("31")}zet: missing command for group '${firstArg}'${errAnsi("0")}\n`);
        process.exit(1);
      }
      const cmdName = argv[1];

      // --help for the group itself
      if (cmdName === "--help" || cmdName === "-h") {
        process.stdout.write(formatGlobalHelp() + "\n");
        process.exit(0);
      }

      targetCmd = group.commands.get(cmdName);
      if (!targetCmd) {
        process.stderr.write(
          `${errAnsi("31")}zet: unknown command '${firstArg} ${cmdName}'${errAnsi("0")}\n`
        );
        process.exit(1);
      }
      remainingArgv = argv.slice(2);
    } else {
      // Root group
      targetCmd = rootGroup.commands.get(firstArg);
      if (!targetCmd) {
        process.stderr.write(`${errAnsi("31")}zet: unknown command '${firstArg}'${errAnsi("0")}\n`);
        process.exit(1);
      }
      remainingArgv = argv.slice(1);
    }

    matchedCommand = targetCmd;

    // Parse arguments
    const result = parseArgv(remainingArgv, targetCmd);

    if (result.help) {
      process.stdout.write(formatCommandHelp(targetCmd) + "\n");
      process.exit(0);
    }

    if (result.error) {
      process.stderr.write(`${errAnsi("31")}zet: ${result.error}${errAnsi("0")}\n`);
      process.stderr.write(`\n${formatUsageLine(result.cmd)}\n`);
      process.exit(1);
    }

    parsedArgs = result.args;
    parsedOptions = result.options;
    restArgs = result.rest;

    // Execute
    if (targetCmd.type === "command") {
      const flat = flattenParts(targetCmd.parts);
      const [cmd, ...args] = flat;
      const child = nodeSpawn(cmd, args, { stdio: "inherit" });
      child.on("close", (code) => {
        process.exit(code ?? 1);
      });
    } else if (targetCmd.type === "callback") {
      try {
        await targetCmd.callback();
      } catch (err) {
        process.stderr.write(formatUncaughtError(err));
        process.exit(1);
      }
    } else {
      process.stderr.write(`${errAnsi("31")}zet: command '${targetCmd.name}' has no action defined${errAnsi("0")}\n`);
      process.exit(1);
    }
  },
};

// Export internals for testing
export { parseSignature, parseArgv, Command, CommandBuilder, Group, CommandOutput, TemplateResult, RestPlaceholder, formatGlobalHelp, formatCommandHelp, formatUncaughtError, rootGroup, groups };
export default zet;
