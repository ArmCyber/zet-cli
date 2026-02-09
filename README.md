# zet-cli

A lightweight, zero-dependency CLI framework for Node.js.

Define commands with a fluent API in a config file, run them with `zet <command>`.

## Install

```sh
npm install -g zet-cli
```

Requires Node.js >= 18.

## Getting Started

```sh
mkdir my-project && cd my-project
zet init
zet hello
# Hello from ZET!
```

`zet init` creates a `zet.config.mjs` with a sample command. Edit it to add your own.

## Quick Start

Create a `zet.config.mjs` in your project root (or use `zet init`):

```js
import zet from 'zet-cli';

zet.register('hello')
   .description('Say hello')
   .command('echo', 'Hello from zet!');

export default zet;
```

Run it:

```sh
zet hello
# Hello from zet!

zet --help
# Usage: zet <command> [options]
#
# Commands:
#   hello    Say hello
#
# Run "zet <command> --help" for more information.
```

## Configuration File

`zet` traverses up from the current directory looking for `zet.config.mjs`. The config file must `export default zet` — initialization is handled automatically.

## API Reference

### Groups

Organize commands under a prefix:

```js
const be = zet.group('be', 'Back-End services');
be.register('migrate ...').description('Run migrations').command('php', 'artisan', 'migrate', zet.rest());
be.register('seed').description('Seed database').command('php', 'artisan', 'db:seed');
```

```sh
zet be migrate --fresh
zet be seed
```

The prefix `cli` is reserved and will throw an error.

### Command Registration

Register commands on the root group or on a named group:

```js
// Root
zet.register('up').description('Start containers').command('docker', 'compose', 'up', '-d');

// Group
const be = zet.group('be', 'Back-End');
be.register('test').description('Run tests').command('phpunit');
```

### Signature Syntax

```
command-name {arg} {arg?} {arg description} {arg? description} {--option} {--option=} {--Option} {--Option=} ...
```

| Token | Meaning |
|---|---|
| `{name}` | Required positional argument |
| `{name?}` | Optional positional argument |
| `{name description}` | Required argument with description |
| `{name? description}` | Optional argument with description |
| `{--name}` | Boolean option (flag) |
| `{--name=}` | Option that accepts a value |
| `{--Name}` | Boolean option with short flag `-N` |
| `{--Preserve-Cache=}` | Value option with short flag `-PC` |
| `...` | Accept extra arguments (rest) |

**Short flags** are derived from uppercase letters at the start of hyphen-separated segments: `--Preserve-Cache` → `-PC`. The long name is always stored lowercase.

### Templates

Reuse common command prefixes:

```js
const docker = zet.template((service) => ['docker', 'compose', 'exec', '-it', service]);

zet.register('migrate ...')
   .description('Run migrations')
   .command(docker('app'), 'php', 'artisan', 'migrate', zet.rest());
```

Templates validate argument count based on `fn.length`.

### `zet.rest()`

A placeholder that expands to the extra arguments captured by `...` in the signature:

```js
zet.register('artisan ...')
   .command('php', 'artisan', zet.rest());
```

```sh
zet artisan migrate --seed   # runs: php artisan migrate --seed
```

### `zet.userPath()` / `zet.rootPath()`

Returns the user's CWD or the project root (where `zet.config.mjs` lives). Both accept an optional subpath:

```js
zet.register('info')
   .callback(() => {
     zet.line(zet.userPath());          // /home/user/project/src
     zet.line(zet.rootPath());          // /home/user/project
     zet.line(zet.rootPath('config'));   // /home/user/project/config
   });
```

### `zet.import()`

Split your config into multiple files. Imports a file relative to the project root:

```js
import zet from 'zet-cli';

await zet.import('zet/docker.config.mjs');
await zet.import('zet/deploy.config.mjs');

export default zet;
```

Each imported file registers its own commands:

```js
// zet/docker.config.mjs
import zet from 'zet-cli';

const docker = zet.template((service) => ['docker', 'compose', 'exec', '-it', service]);

zet.register('up').description('Start containers').command('docker', 'compose', 'up', '-d');
zet.register('shell').description('Open shell').command(docker('app'), 'bash');
```

To share templates, groups, or any other values between files, export them from a shared module and import where needed:

```js
// zet/shared.mjs
import zet from 'zet-cli';

export const docker = zet.template((service) => ['docker', 'compose', 'exec', '-it', service]);
export const be = zet.group('be', 'Back-End services');
```

```js
// zet/migrations.config.mjs
import { be, docker } from './shared.mjs';

be.register('migrate ...')
  .description('Run migrations')
  .command(docker('app'), 'php', 'artisan', 'migrate');
```

```js
// zet/seeds.config.mjs
import { be } from './shared.mjs';

be.register('seed').description('Seed database').command('php', 'artisan', 'db:seed');
```

Since `zet` is a singleton, groups and templates created in one file are the same instances everywhere. Just make sure to call `zet.group()` only once per prefix — create it in the shared module and import the returned object.

### Plugins

To use shared plugins published as npm packages, install them as dev dependencies:

```sh
npm install -D my-zet-plugin
```

Then import them in your config:

```js
import zet from 'zet-cli';
import 'my-zet-plugin';

export default zet;
```

Plugin packages just import `zet` and register commands — the same pattern as `zet.import()` files.

### External Scripts

For commands that need their own dependencies (e.g., a deploy script using `axios` or `ssh2`), create a standalone script and call it with `.command()`:

```js
// bin/deploy.mjs
import axios from 'axios';
// ... your deploy logic

// zet.config.mjs
import zet from 'zet-cli';
zet.register('deploy {env}')
   .description('Deploy to environment')
   .command('node', zet.rootPath('bin/deploy.mjs'), zet.rest());
export default zet;
```

```sh
zet deploy production
# runs: node /project/bin/deploy.mjs production
```

### Command Execution

**`.command(...parts)`** — Register a command that spawns a process:

```js
zet.register('up').command('docker', 'compose', 'up', '-d');
```

**`.callback(fn)`** — Register a command with a callback:

```js
zet.register('deploy {env}')
   .callback(async () => {
     const env = zet.argument('env');
     await zet.command('deploy.sh', env);
   });
```

**`zet.command(...parts)`** — Spawn a command (output visible), returns `CommandOutput`:

```js
const result = await zet.command('make', 'build');
result.throw(); // throws if failed
```

**`zet.silentCommand(...parts)`** — Spawn a command (output captured), returns `CommandOutput`:

```js
const result = await zet.silentCommand('git', 'rev-parse', 'HEAD');
zet.line(result.output.trim());
```

**`CommandOutput`** has: `code`, `output`, `stdout`, `stderr`, `success`, `failed`, `throw()`.

### Accessors

Available during callback execution:

| Method | Returns |
|---|---|
| `zet.argument(name)` | `string` or `null` |
| `zet.option('--name')` | `null`, `true` (flag), or `'value'` |
| `zet.hasOption('--name')` | `boolean` |
| `zet.hasArgument(name)` | `boolean` |

### Output Helpers

```js
zet.info('Success');     // green, stdout
zet.error('Failed');     // red, stderr
zet.warning('Careful');  // yellow, stderr
zet.line('Plain text');  // no color, stdout
zet.styledLine('<i>Deployed</i> to <b>production</b>');  // styled, stdout
```

`styledLine` supports tags: `<b>` bold, `<i>` info/green, `<w>` warning/yellow, `<e>` error/red. Combine a color with bold: `<ib>` green+bold, `<wb>` yellow+bold, `<eb>` red+bold. Closing tag must match the opening tag exactly (`<eb>...</eb>`).

Respects `NO_COLOR` env var and TTY detection.

### `zet.setAiRulesPath()` / `zet.setIdeSpecsPath()`

Configure output paths for `zet cli ai-rules` and `zet cli ide-specs`:

```js
zet.setAiRulesPath('docs/');                            // ZETCLI.md → docs/ZETCLI.md
zet.setAiRulesPath('.claude/skills/zet-crm/SKILL.md');  // custom filename
zet.setIdeSpecsPath('.types/');                         // .d.ts → .types/.zet-cli/index.d.ts
```

`setAiRulesPath` accepts a directory (appends `ZETCLI.md`) or a full filename. Both paths are relative to the project root. Call these in your `zet.config.mjs` before `export default zet`.

### Auto-generated Help

```sh
zet --help          # global help
zet <command> --help  # command-specific help
```

## Full Example

```js
import zet from 'zet-cli';

const docker = zet.template((service) => ['docker', 'compose', 'exec', '-it', service]);
const compose = zet.template(() => ['docker', 'compose']);

// Groups
const be = zet.group('be', 'Back-End services');
be.register('temp').description('smth').command(docker('zet-app'), 'php', 'artisan', 'temp');

// Root commands
zet.register('migrate {--Preserve-Cache= option desc} ...')
   .description('Run migrations')
   .command(docker('zet-app'), 'php', 'artisan', 'migrate', zet.rest());

zet.register('up')
   .description('Start all containers')
   .command(compose(), 'up', '-d');

zet.register('deploy {env} {--Force}')
   .description('Deploy to environment')
   .callback(async () => {
     const env = zet.argument('env');
     zet.info(`Deploying to ${env}...`);
     if (zet.hasOption('--force')) {
       zet.warning('Force deploy enabled');
     }
     await zet.command('deploy.sh', env);
   });

export default zet;
```

## Built-in Commands

### `zet init`

Bootstrap a new project — creates `zet.config.mjs` in the current directory with a sample command. Only checks the current directory (no parent traversal).

### `zet cli ai-rules`

Generate a `ZETCLI.md` file — a condensed AI agent reference for your project's zet commands. By default, writes `ZETCLI.md` to the project root. You can set a custom path — either a directory or a full filename:

```js
zet.setAiRulesPath('docs/');                            // → docs/ZETCLI.md
zet.setAiRulesPath('.claude/skills/zet-crm/SKILL.md');  // → .claude/skills/zet-crm/SKILL.md
```

### `zet cli ide-specs`

Generate TypeScript declarations (`.d.ts`) for IDE autocompletion. By default, writes to `.zet-cli/` in the project root (with a `.gitignore` so generated files stay out of version control).

```js
zet.setIdeSpecsPath('.types/');  // .d.ts goes to .types/.zet-cli/index.d.ts
```

### `zet cli --help`

Show available cli subcommands.

> Note: `zet --help` does not show `cli` or `init` — these are internal tooling commands.

## How It Works

1. `zet` binary traverses up from CWD to find `zet.config.mjs`
2. Sets up a module resolution hook so the config can `import zet from 'zet-cli'`
3. Imports the config, validates the default export, and runs the matched command
4. Commands run from the user's CWD — use `zet.userPath()` and `zet.rootPath()` to resolve paths

## Test

```sh
npm test
```
