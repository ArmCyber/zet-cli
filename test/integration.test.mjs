import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const BIN = join(fileURLToPath(import.meta.url), "..", "..", "bin", "zet.mjs");
const LIB = join(fileURLToPath(import.meta.url), "..", "..", "lib", "index.mjs");

function run(cwd, args = [], env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", ...env },
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (d) => stdout.push(d));
    child.stderr.on("data", (d) => stderr.push(d));
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      });
    });
  });
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "zet-integ-"));
}

function writeConfig(dir, script) {
  // Use direct path import for most tests to isolate from loader concerns
  writeFileSync(
    join(dir, "zet.config.mjs"),
    script.replace("'zet-cli'", `'${LIB}'`)
  );
}

function writeRealConfig(dir, script) {
  // Use bare 'zet-cli' import — relies on the loader hook set up by bin/zet.mjs
  writeFileSync(join(dir, "zet.config.mjs"), script);
}

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe("integration", () => {
  it("exits 1 when no config found", async () => {
    const dir = tmpDir();
    const result = await run(dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /cannot find zet\.config\.mjs/);
  });

  it("executes a simple shell command", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import zet from 'zet-cli';
zet.register('hello').command('echo', 'hello world');
export default zet;
`
    );
    const result = await run(dir, ["hello"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /hello world/);
  });

  it("passes arguments to callback", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import zet from 'zet-cli';
zet.register('greet {name}')
   .callback(() => {
     process.stdout.write('Hello ' + zet.argument('name'));
   });
export default zet;
`
    );
    const result = await run(dir, ["greet", "World"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Hello World/);
  });

  it("handles group commands", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import zet from 'zet-cli';
const be = zet.group('be', 'Back-End');
be.register('ping')
  .description('Ping backend')
  .command('echo', 'pong');
export default zet;
`
    );
    const result = await run(dir, ["be", "ping"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /pong/);
  });

  it("shows global help with --help", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import zet from 'zet-cli';
const be = zet.group('be', 'Back-End services');
be.register('temp').description('smth');
zet.register('up').description('UP All Containers');
export default zet;
`
    );
    const result = await run(dir, ["--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage: zet <command>/);
    assert.match(result.stdout, /Back-End services/);
    assert.match(result.stdout, /be temp/);
    assert.match(result.stdout, /smth/);
    assert.match(result.stdout, /up/);
    assert.match(result.stdout, /UP All Containers/);
  });

  it("shows global help with no args", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import zet from 'zet-cli';
zet.register('hello').description('Say hello');
export default zet;
`
    );
    const result = await run(dir);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage: zet <command>/);
  });

  it("shows command help with --help", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import zet from 'zet-cli';
zet.register('build {target} {--Verbose}')
   .description('Build the project');
export default zet;
`
    );
    const result = await run(dir, ["build", "--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage: zet build/);
    assert.match(result.stdout, /Build the project/);
    assert.match(result.stdout, /--verbose/);
    assert.match(result.stdout, /--help/);
  });

  it("forwards rest args with zet.rest()", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import zet from 'zet-cli';
zet.register('run ...')
   .command('echo', zet.rest());
export default zet;
`
    );
    const result = await run(dir, ["run", "a", "b", "c"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /a b c/);
  });

  it("zet.userPath() returns the user CWD", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import zet from 'zet-cli';
zet.register('cwd')
   .callback(() => {
     process.stdout.write(zet.userPath());
   });
export default zet;
`
    );
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const result = await run(sub, ["cwd"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, sub);
  });

  it("zet.rootPath() returns the project root", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import zet from 'zet-cli';
zet.register('root')
   .callback(() => {
     process.stdout.write(zet.rootPath());
   });
export default zet;
`
    );
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const result = await run(sub, ["root"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, dir);
  });

  it("zet.userPath() and zet.rootPath() join subpaths", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import zet from 'zet-cli';
zet.register('paths')
   .callback(() => {
     process.stdout.write(JSON.stringify({
       userSub: zet.userPath('test'),
       rootSub: zet.rootPath('src'),
     }));
   });
export default zet;
`
    );
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const result = await run(sub, ["paths"]);
    assert.equal(result.code, 0);
    const paths = JSON.parse(result.stdout);
    assert.equal(paths.userSub, join(sub, "test"));
    assert.equal(paths.rootSub, join(dir, "src"));
  });

  it("forwards exit codes", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import zet from 'zet-cli';
zet.register('fail')
   .callback(() => {
     zet.exit(42);
   });
export default zet;
`
    );
    const result = await run(dir, ["fail"]);
    assert.equal(result.code, 42);
  });

  it("rejects reserved 'cli' group prefix", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import zet from 'zet-cli';
zet.group('cli', 'CLI');
export default zet;
`
    );
    const result = await run(dir, ["--help"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /reserved/);
  });

  it("errors on unknown command", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import zet from 'zet-cli';
zet.register('hello').command('echo', 'hi');
export default zet;
`
    );
    const result = await run(dir, ["nonexistent"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown command/);
  });

  it("errors on missing required argument", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import zet from 'zet-cli';
zet.register('greet {name}')
   .callback(() => {});
export default zet;
`
    );
    const result = await run(dir, ["greet"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /missing required argument/);
  });

  it("handles options in callback", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import zet from 'zet-cli';
zet.register('build {--verbose} {--output=}')
   .callback(() => {
     const parts = [];
     if (zet.hasOption('--verbose')) parts.push('verbose');
     if (zet.option('--output')) parts.push('out=' + zet.option('--output'));
     process.stdout.write(parts.join(','));
   });
export default zet;
`
    );
    const result = await run(dir, ["build", "--verbose", "--output=dist"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "verbose,out=dist");
  });

  it("finds config in parent directory", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import zet from 'zet-cli';
zet.register('found').command('echo', 'found-it');
export default zet;
`
    );
    const nested = join(dir, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    const result = await run(nested, ["found"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /found-it/);
  });

  it("resolves 'zet-cli' bare import via loader hook", async () => {
    const dir = tmpDir();
    writeRealConfig(
      dir,
      `
import zet from 'zet-cli';
zet.register('ping').command('echo', 'loader-works');
export default zet;
`
    );
    const result = await run(dir, ["ping"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /loader-works/);
  });

  it("shows friendly error for duplicate command (no raw stack trace)", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import zet from 'zet-cli';
zet.register('hello').command('echo', 'hi');
zet.register('hello').command('echo', 'hi again');
export default zet;
`
    );
    const result = await run(dir, ["hello"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /zet: Duplicate command 'hello'/);
    assert.match(result.stderr, /zet\.config\.mjs/);
    assert.doesNotMatch(result.stderr, /node:internal/);
    assert.doesNotMatch(result.stderr, /lib\/index\.mjs/);
  });

  it("errors when config doesn't export default zet", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import zet from 'zet-cli';
zet.register('hello').command('echo', 'hi');
`
    );
    const result = await run(dir, ["hello"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /export default zet/);
  });

  it("template used in the middle of .command()", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import zet from 'zet-cli';
const artisan = zet.template(() => ['artisan', 'migrate']);
zet.register('migrate ...')
   .command('echo', 'exec', artisan(), zet.rest());
export default zet;
`
    );
    const result = await run(dir, ["migrate", "--seed"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /exec artisan migrate --seed/);
  });

  it("template inside another template (nested)", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import zet from 'zet-cli';
const artisan = zet.template(() => ['artisan', 'migrate']);
const docker = zet.template((service) => ['echo', 'docker', service, artisan()]);
zet.register('migrate ...')
   .command(docker('app'), zet.rest());
export default zet;
`
    );
    const result = await run(dir, ["migrate", "--seed"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /docker app artisan migrate --seed/);
  });

  it("zet.import() loads sub-config from project root", async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, "zet"));
    writeFileSync(
      join(dir, "zet", "docker.config.mjs"),
      `
import zet from '${LIB}';
zet.register('docker-ping').command('echo', 'docker-pong');
`
    );
    writeConfig(
      dir,
      `
import zet from 'zet-cli';
await zet.import('zet/docker.config.mjs');
export default zet;
`
    );
    const result = await run(dir, ["docker-ping"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /docker-pong/);
  });

  it("silentCommand captures output in callback", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import zet from 'zet-cli';
zet.register('capture')
   .callback(async () => {
     const result = await zet.silentCommand('echo', 'captured');
     process.stdout.write('GOT:' + result.output.trim());
   });
export default zet;
`
    );
    const result = await run(dir, ["capture"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "GOT:captured");
  });
});
