# AGENTS.md

Technical reference for AI agents working on this codebase. See [README.md](./README.md) for user-facing API reference, signature syntax, and usage examples.

## Project

zet-cli — a zero-dependency ESM CLI framework for Node.js (>=18.19). Users install globally, create `zet.config.mjs`, define commands via fluent API, run with `zet <command>`.

## Commands

```sh
npm test                                    # run all tests (92 tests)
node --test test/zet.test.mjs               # unit tests only
node --test test/integration.test.mjs       # integration tests only
node --test --test-name-pattern="pattern"   # run tests matching pattern
```

No build step, no linter. Pure ESM (`.mjs` only, no `.js`).

## Architecture

### Execution flow

```
bin/zet.mjs  →  spawns child process  →  lib/runner.mjs  →  imports user's zet.config.mjs  →  calls zet.init()
```

1. **`bin/zet.mjs`** — CLI entry point. Walks up from CWD to find `zet.config.mjs`. Detects Node version to pick ESM loader strategy (`--import` + `register.mjs` for Node >=18.19 and >=20.6, `--loader` + `loader.mjs` for older). Warns on unsupported versions below 18.19. Spawns `runner.mjs` as child process with `ZET_ROOT_DIR` env var set to config's parent directory. CWD stays as user's CWD.

2. **`lib/loader.mjs`** — ESM resolve hook. Maps bare specifier `'zet-cli'` to `./index.mjs` so user configs can `import zet from 'zet-cli'` even when the package is globally installed.

3. **`lib/register.mjs`** — Calls `module.register()` to load `loader.mjs` (Node >=20.6 API).

4. **`lib/runner.mjs`** — Dynamically imports the config file, validates that it `export default`s an object with an `init` method (the zet singleton), then calls `init()`.

5. **`lib/index.mjs`** — The entire framework (~830 lines). Exports the `zet` singleton as default and internals as named exports for testing.

### Key internals in lib/index.mjs

- **`zet` singleton** — Plain object (not a class). Module-level state: `rootGroup`, `groups` Map, `parsedArgs`, `parsedOptions`, `restArgs`, `matchedCommand`.
- **`parseSignature(sig)`** — Tokenizes signature strings like `'deploy {env} {--Force} ...'` using `TOKEN_RE = /\{[^}]+\}|\.\.\.|[^\s{}]+/g`. Returns `{ name, args, options, acceptsRest }`.
- **Short flags** — Derived from uppercase starts of hyphen-separated segments: `--Preserve-Cache` → `-PC`. Long name always stored lowercase.
- **`parseArgv(argv, cmd)`** — Parses CLI args against a command's signature. Unknown options pass through to rest when `acceptsRest` is true.
- **`flattenParts(parts)`** — Recursively flattens command parts: expands `TemplateResult`, `RestPlaceholder`, and arrays into a flat string array for spawning.
- **`CommandOutput`** — Has `code`, `output` (combined), `stdout`, `stderr`, `success` (getter), `failed` (getter), `throw()`.
- **`CommandBuilder`** — Fluent builder with `.description()`, `.command(...parts)`, `.callback(fn)`. Returned by `group.register()` / `zet.register()`.
- **`Group`** — Named command groups with a prefix. `rootGroup` is the unnamed default.
- **`TemplateResult`** / **`RestPlaceholder`** — Sentinel wrappers for `flattenParts` to recognize and expand.
- **`RESERVED_NAMES`** — `new Set(["publish", "init"])`. Blocked in both `zet.group()` and `zet.register()`.
- **Error handling** — `process.on('uncaughtException')` and `process.on('unhandledRejection')` format errors with red message + dimmed user-only stack frames (filters out `PKG_ROOT_URL` and `node:` frames).
- **Color** — `outAnsi()` (stdout) and `errAnsi()` (stderr) check TTY per-stream. Respects `NO_COLOR` env var.

### zet API surface

| Method | Purpose |
|---|---|
| `zet.register(sig)` | Register root command, returns `CommandBuilder` |
| `zet.group(prefix, desc)` | Create named group, returns `Group` |
| `zet.template(fn)` | Create reusable command prefix, returns template function |
| `zet.rest()` | Returns `RestPlaceholder` for `...` expansion |
| `zet.import(path)` | Import sub-config relative to project root |
| `zet.argument(name)` | Get parsed arg value |
| `zet.option('--name')` | Get parsed option value |
| `zet.hasArgument(name)` / `zet.hasOption('--name')` | Check existence |
| `zet.userPath(sub?)` / `zet.rootPath(sub?)` | CWD / project root path helpers |
| `zet.command(...parts)` | Spawn with inherited stdio |
| `zet.silentCommand(...parts)` | Spawn with piped stdio |
| `zet.info/error/warning/line(msg)` | Colored output helpers |
| `zet.styledLine(msg)` | Styled output with tags: `<b>` bold, `<i>` info/green, `<w>` warning/yellow, `<e>` error/red |
| `zet.setAiPublishPath(path)` | Set output path for `zet publish ai` |
| `zet.setIdePublishPath(path)` | Set output path for `zet publish ide` |
| `zet.exit(code)` | Exit process |

## Built-in CLI Commands

Handled separately from user-registered commands:

- **`zet init`** — Handled in `bin/zet.mjs` before config search. Writes `zet.config.mjs` with a hello template. Checks CWD only (no parent traversal).
- **`zet publish <subcommand>`** — Handled in `init()` inside `lib/index.mjs`, which delegates to `lib/cli.mjs`. Intercepted before group/root command lookup. Config is loaded at this point, so `setAiPublishPath()`/`setIdePublishPath()` paths are available.
  - `zet publish ai` — Writes `zet-cli.md` (AI agent reference)
  - `zet publish ide` — Generates TypeScript `.d.ts` declarations
  - `zet publish --help` — Shows publish subcommands

**Important:** When `lib/index.mjs` API changes, the `zet publish ide` output and `zet publish ai` content must be updated in `lib/cli.mjs`.

`zet --help` does NOT show `publish` or `init`. Only `zet publish --help` shows publish subcommands.

**Reserved names:** Never use `init` or `publish` as group prefixes or ungrouped command names — they are reserved for built-in commands. Both `zet.group()` and `zet.register()` will throw if given a reserved name.

**Name conflicts:** A root command and a group cannot share the same name. Registration will throw if a command is registered with an existing group's name or vice versa. Use distinct names or nest the command inside the group.

## Tests

- **`test/zet.test.mjs`** — Unit tests. Imports internals directly from `lib/index.mjs`. Tests `parseSignature`, `parseArgv`, `Group`, templates, `CommandOutput`, help formatting.
- **`test/integration.test.mjs`** — Spawns actual `bin/zet.mjs` against temp directories with generated `zet.config.mjs` files. Uses `writeConfig()` (replaces `'zet-cli'` with direct lib path) and `writeRealConfig()` (uses bare specifier to test loader hook). All integration tests set `NO_COLOR=1`.

## Conventions

- Zero dependencies. Node built-ins only.
- All files are `.mjs` (ESM). No CommonJS.
- `zet` is a singleton — the same object is shared across all imports.
- User config files must `export default zet` (runner validates this).
- Errors shown to users must be red, with stack traces filtered to user code only.
