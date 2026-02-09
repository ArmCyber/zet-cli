# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Reference

```sh
npm test                                    # run all 72 tests
node --test test/zet.test.mjs               # unit tests only
node --test test/integration.test.mjs       # integration tests only
node --test --test-name-pattern="pattern"   # run specific test by name
```

No build step. No linter. Zero dependencies. Pure ESM (.mjs only).

## Documentation

- [README.md](./README.md) — User-facing docs: API reference, signature syntax, config examples, templates, groups, plugins
- [AGENTS.md](./AGENTS.md) — Internal technical details: execution flow, internals, test structure

## Architecture

**Execution flow:** `bin/zet.mjs` finds `zet.config.mjs`, spawns `lib/runner.mjs` with ESM loader hooks, runner imports config, validates `export default zet`, calls `zet.init()`.

**Core library:** `lib/index.mjs` (~830 lines) contains the entire framework — signature parsing, argv parsing, command execution, templates, help formatting, colored output, error handling. The `zet` object is a module-level singleton (not a class).

**ESM loader:** `lib/loader.mjs` + `lib/register.mjs` resolve `import zet from 'zet-cli'` for globally installed packages. Version-detected: `--import` for Node >=20.6, `--loader` for older.

## Key Rules

- All code is `.mjs` — never use `.js`
- User-facing errors must be red with stack traces filtered to user code only (no internal frames)
- `zet` is a singleton shared across all imports — state is module-level
- Config files must `export default zet`
- The `'cli'` group prefix is reserved
