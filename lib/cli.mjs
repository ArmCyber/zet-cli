import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// CLI help
// ---------------------------------------------------------------------------

const CLI_HELP = `Usage: zet cli <command>

Commands:
  ai-rules     Generate zet-cli.md (AI agent documentation)
  ide-specs    Generate TypeScript declarations for IDE support

Output paths are configurable in zet.config.mjs:
  zet.setAiRulesPath('docs/')       zet-cli.md → docs/zet-cli.md
  zet.setIdeSpecsPath('.types/')   .d.ts → .types/.zet-cli/index.d.ts (default: .zet-cli/)
`;

// ---------------------------------------------------------------------------
// zet-cli.md content
// ---------------------------------------------------------------------------

const ZETCLI_MD = `# ZET CLI Usage

AI agent reference for zet-cli projects.

## Config File

\`\`\`js
import zet from 'zet-cli';

// register commands here

export default zet;
\`\`\`

Config file must be named \`zet.config.mjs\` and \`export default zet\`.

## Signature Syntax

\`\`\`
command-name {arg} {arg?} {arg desc} {--option} {--option=} {--Option} {--Opt-Name=} ...
\`\`\`

| Token | Meaning |
|---|---|
| \`{name}\` | Required positional argument |
| \`{name?}\` | Optional positional argument |
| \`{name description}\` | Required argument with description |
| \`{name? description}\` | Optional argument with description |
| \`{--name}\` | Boolean option (flag) |
| \`{--name=}\` | Option that accepts a value |
| \`{--Name}\` | Boolean option with short flag \`-N\` |
| \`{--Preserve-Cache=}\` | Value option with short flag \`-PC\` |
| \`...\` | Accept extra arguments (rest) |

Short flags are derived from uppercase letters at the start of hyphen-separated segments.

## API

### Registration

- \`zet.register(signature)\` → \`CommandBuilder\` — Register a root command
- \`zet.group(prefix, description)\` → \`Group\` — Create a command group
- \`group.register(signature)\` → \`CommandBuilder\` — Register a command in a group

### CommandBuilder (fluent)

- \`.description(text)\` → \`this\`
- \`.command(...parts)\` → \`this\` — Spawn a process
- \`.callback(fn)\` → \`this\` — Run a callback (\`fn\` can be async)

### Templates

- \`zet.template(fn)\` → template function — \`fn\` receives args, returns \`string[]\`
- Call the returned function to get a \`TemplateResult\` for use in \`.command()\`

### Placeholders

- \`zet.rest()\` — Expands to extra arguments captured by \`...\` in the signature

### Runtime Accessors

- \`zet.argument(name)\` → \`string | null\`
- \`zet.option('--name')\` → \`string | true | null\`
- \`zet.hasArgument(name)\` → \`boolean\`
- \`zet.hasOption('--name')\` → \`boolean\`

### Path Helpers

- \`zet.userPath(subpath?)\` → \`string\` — CWD or CWD + subpath
- \`zet.rootPath(subpath?)\` → \`string\` — Project root or root + subpath

### Command Execution

- \`await zet.command(...parts)\` → \`CommandOutput\` — Spawn with inherited stdio
- \`await zet.silentCommand(...parts)\` → \`CommandOutput\` — Spawn with piped stdio

### CommandOutput

- \`.code\` — Exit code
- \`.output\` — Combined stdout+stderr (silent only)
- \`.stdout\` / \`.stderr\` — Separated output (silent only)
- \`.success\` / \`.failed\` — Boolean getters
- \`.throw()\` — Throw if failed, return \`this\` if success

### Output Helpers

- \`zet.info(msg)\` — Green, stdout
- \`zet.error(msg)\` — Red, stderr
- \`zet.warning(msg)\` — Yellow, stderr
- \`zet.line(msg)\` — No color, stdout

### Import & Process

- \`await zet.import(path)\` — Import sub-config relative to project root
- \`zet.exit(code?)\` — Exit process

### CLI Config

- \`zet.setAiRulesPath(path)\` — Set output path for \`zet cli ai-rules\` (relative to project root). If path ends with \`.md\` or \`.mdc\`, writes to that file directly; otherwise writes \`zet-cli.md\` inside the directory.
- \`zet.setIdeSpecsPath(path)\` — Set output path for \`zet cli ide-specs\` (relative to project root)

## Groups

The prefix \`cli\` is reserved. Groups organize commands under a prefix:

\`\`\`js
const be = zet.group('be', 'Back-End');
be.register('migrate ...').description('Run migrations').command('php', 'artisan', 'migrate', zet.rest());
\`\`\`

\`\`\`sh
zet be migrate --fresh
\`\`\`
`;

// ---------------------------------------------------------------------------
// TypeScript declarations content
// ---------------------------------------------------------------------------

const DTS_CONTENT = `declare module "zet-cli" {
  interface CommandOutput {
    code: number;
    output: string | null;
    stdout: string | null;
    stderr: string | null;
    readonly success: boolean;
    readonly failed: boolean;
    throw(): this;
  }

  interface Group {
    readonly prefix: string;
    readonly description: string;
    register(signature: string): CommandBuilder;
  }

  interface CommandBuilder {
    description(text: string): this;
    command(...parts: any[]): this;
    callback(fn: () => void | Promise<void>): this;
  }

  interface TemplateResult {
    readonly parts: string[];
  }

  interface Zet {
    group(prefix: string, description: string): Group;
    template(fn: (...args: string[]) => any[]): (...args: string[]) => TemplateResult;
    rest(): { readonly _brand: unique symbol };
    import(path: string): Promise<any>;
    register(signature: string): CommandBuilder;
    setAiRulesPath(path: string): void;
    setIdeSpecsPath(path: string): void;
    argument(name: string): string | null;
    option(name: string): string | true | null;
    hasOption(name: string): boolean;
    hasArgument(name: string): boolean;
    userPath(subpath?: string): string;
    rootPath(subpath?: string): string;
    info(msg: string): void;
    error(msg: string): void;
    warning(msg: string): void;
    line(msg: string): void;
    exit(code?: number): never;
    command(...parts: any[]): Promise<CommandOutput>;
    silentCommand(...parts: any[]): Promise<CommandOutput>;
  }

  const zet: Zet;
  export default zet;
}
`;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function isMarkdownFile(p) {
  const lower = p.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".mdc");
}

function handleAiRules(projectRoot, config) {
  let filePath;

  if (config.aiRulesPath) {
    const resolved = join(projectRoot, config.aiRulesPath);
    if (isMarkdownFile(config.aiRulesPath)) {
      filePath = resolved;
      mkdirSync(dirname(filePath), { recursive: true });
    } else {
      mkdirSync(resolved, { recursive: true });
      filePath = join(resolved, "zet-cli.md");
    }
  } else {
    filePath = join(projectRoot, "zet-cli.md");
  }

  writeFileSync(filePath, ZETCLI_MD);
  process.stdout.write(`Created ${filePath}\n`);
}

function handleIdeSpecs(projectRoot, config) {
  let dtsDir;
  let writeGitignore = false;

  if (config.ideSpecsPath) {
    dtsDir = join(projectRoot, config.ideSpecsPath, ".zet-cli");
  } else {
    dtsDir = join(projectRoot, ".zet-cli");
    writeGitignore = true;
  }

  if (existsSync(dtsDir)) {
    rmSync(dtsDir, { recursive: true });
  }
  mkdirSync(dtsDir, { recursive: true });

  writeFileSync(join(dtsDir, "index.d.ts"), DTS_CONTENT);

  if (writeGitignore) {
    writeFileSync(join(dtsDir, ".gitignore"), "*\n!.gitignore\n");
  }

  process.stdout.write(`Created TypeScript declarations at ${join(dtsDir, "index.d.ts")}\n`);
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function handleCli(argv, projectRoot, config) {
  const subcommand = argv[0];

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    process.stdout.write(CLI_HELP);
    return;
  }

  if (subcommand === "ai-rules") {
    handleAiRules(projectRoot, config);
    return;
  }

  if (subcommand === "ide-specs") {
    handleIdeSpecs(projectRoot, config);
    return;
  }

  process.stderr.write(`zet: unknown cli command '${subcommand}'\n`);
  process.stderr.write(`\n${CLI_HELP}`);
  process.exit(1);
}
