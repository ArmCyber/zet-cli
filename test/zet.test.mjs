import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  parseSignature,
  parseArgv,
  Command,
  CommandBuilder,
  Group,
  CommandOutput,
  TemplateResult,
  formatGlobalHelp,
  formatCommandHelp,
  rootGroup,
  groups,
} from "../lib/index.mjs";
import zet from "../lib/index.mjs";

// ---------------------------------------------------------------------------
// Signature Parsing
// ---------------------------------------------------------------------------

describe("parseSignature", () => {
  it("parses a simple command name", () => {
    const sig = parseSignature("up");
    assert.equal(sig.name, "up");
    assert.deepEqual(sig.args, []);
    assert.deepEqual(sig.options, []);
    assert.equal(sig.acceptsRest, false);
  });

  it("parses rest args", () => {
    const sig = parseSignature("migrate ...");
    assert.equal(sig.name, "migrate");
    assert.equal(sig.acceptsRest, true);
  });

  it("parses required argument", () => {
    const sig = parseSignature("build {target}");
    assert.equal(sig.args.length, 1);
    assert.equal(sig.args[0].name, "target");
    assert.equal(sig.args[0].required, true);
    assert.equal(sig.args[0].description, "");
  });

  it("parses optional argument", () => {
    const sig = parseSignature("build {target?}");
    assert.equal(sig.args[0].name, "target");
    assert.equal(sig.args[0].required, false);
  });

  it("parses required argument with description", () => {
    const sig = parseSignature("build {target the build target}");
    assert.equal(sig.args[0].name, "target");
    assert.equal(sig.args[0].required, true);
    assert.equal(sig.args[0].description, "the build target");
  });

  it("parses optional argument with description", () => {
    const sig = parseSignature("build {target? the build target}");
    assert.equal(sig.args[0].name, "target");
    assert.equal(sig.args[0].required, false);
    assert.equal(sig.args[0].description, "the build target");
  });

  it("parses boolean option", () => {
    const sig = parseSignature("build {--verbose}");
    assert.equal(sig.options.length, 1);
    assert.equal(sig.options[0].long, "--verbose");
    assert.equal(sig.options[0].acceptsValue, false);
    assert.equal(sig.options[0].short, null);
  });

  it("parses value option (with =)", () => {
    const sig = parseSignature("build {--output=}");
    assert.equal(sig.options[0].long, "--output");
    assert.equal(sig.options[0].acceptsValue, true);
  });

  it("parses boolean option with description", () => {
    const sig = parseSignature("build {--verbose enable verbose output}");
    assert.equal(sig.options[0].long, "--verbose");
    assert.equal(sig.options[0].acceptsValue, false);
    assert.equal(sig.options[0].description, "enable verbose output");
  });

  it("parses value option with description", () => {
    const sig = parseSignature("build {--output= the output path}");
    assert.equal(sig.options[0].long, "--output");
    assert.equal(sig.options[0].acceptsValue, true);
    assert.equal(sig.options[0].description, "the output path");
  });

  it("extracts short flag from uppercase starting letters", () => {
    const sig = parseSignature("build {--Preserve-Cache}");
    assert.equal(sig.options[0].long, "--preserve-cache");
    assert.equal(sig.options[0].short, "-PC");
  });

  it("no short flag when all lowercase", () => {
    const sig = parseSignature("build {--verbose}");
    assert.equal(sig.options[0].short, null);
  });

  it("extracts single uppercase letter as short flag", () => {
    const sig = parseSignature("build {--Verbose}");
    assert.equal(sig.options[0].long, "--verbose");
    assert.equal(sig.options[0].short, "-V");
  });

  it("rejects uppercase in middle of segment", () => {
    assert.throws(
      () => parseSignature("build {--preservE-cache}"),
      /uppercase letters are only allowed at the start/
    );
  });

  it("rejects multi-word command name", () => {
    assert.throws(
      () => parseSignature("build deploy {target}"),
      /Unexpected token/
    );
  });

  it("rejects required argument after optional", () => {
    assert.throws(
      () => parseSignature("build {a?} {b}"),
      /Required argument 'b' cannot follow an optional argument/
    );
  });

  it("rejects duplicate argument names", () => {
    assert.throws(
      () => parseSignature("build {name} {name}"),
      /Duplicate argument name/
    );
  });

  it("parses complex signature with all features", () => {
    const sig = parseSignature(
      "test {arg1 required argument} {arg2? optional argument} {--option} {--Preserve-Cache= option desc} ..."
    );
    assert.equal(sig.name, "test");
    assert.equal(sig.args.length, 2);
    assert.equal(sig.args[0].name, "arg1");
    assert.equal(sig.args[0].required, true);
    assert.equal(sig.args[0].description, "required argument");
    assert.equal(sig.args[1].name, "arg2");
    assert.equal(sig.args[1].required, false);
    assert.equal(sig.args[1].description, "optional argument");
    assert.equal(sig.options.length, 2);
    assert.equal(sig.options[0].long, "--option");
    assert.equal(sig.options[0].acceptsValue, false);
    assert.equal(sig.options[1].long, "--preserve-cache");
    assert.equal(sig.options[1].acceptsValue, true);
    assert.equal(sig.options[1].short, "-PC");
    assert.equal(sig.options[1].description, "option desc");
    assert.equal(sig.acceptsRest, true);
  });
});

// ---------------------------------------------------------------------------
// Arg Parsing
// ---------------------------------------------------------------------------

describe("parseArgv", () => {
  function makeCmd(signature) {
    const parsed = parseSignature(signature);
    const cmd = new Command(parsed.name, null, parsed);
    return cmd;
  }

  it("parses positional arguments", () => {
    const cmd = makeCmd("build {target} {mode?}");
    const result = parseArgv(["production", "fast"], cmd);
    assert.deepEqual(result.args, { target: "production", mode: "fast" });
  });

  it("handles missing optional arguments", () => {
    const cmd = makeCmd("build {target} {mode?}");
    const result = parseArgv(["production"], cmd);
    assert.deepEqual(result.args, { target: "production" });
    assert.equal(result.rest.length, 0);
  });

  it("errors on missing required argument", () => {
    const cmd = makeCmd("build {target}");
    const result = parseArgv([], cmd);
    assert.ok(result.error);
    assert.match(result.error, /missing required argument 'target'/);
  });

  it("parses long boolean option", () => {
    const cmd = makeCmd("build {--verbose}");
    const result = parseArgv(["--verbose"], cmd);
    assert.equal(result.options["--verbose"], true);
  });

  it("parses long value option with =", () => {
    const cmd = makeCmd("build {--output=}");
    const result = parseArgv(["--output=dist"], cmd);
    assert.equal(result.options["--output"], "dist");
  });

  it("parses long value option with space", () => {
    const cmd = makeCmd("build {--output=}");
    const result = parseArgv(["--output", "dist"], cmd);
    assert.equal(result.options["--output"], "dist");
  });

  it("parses short flag", () => {
    const cmd = makeCmd("build {--Verbose}");
    const result = parseArgv(["-V"], cmd);
    assert.equal(result.options["--verbose"], true);
  });

  it("parses short value flag", () => {
    const cmd = makeCmd("build {--Output=}");
    const result = parseArgv(["-O", "dist"], cmd);
    assert.equal(result.options["--output"], "dist");
  });

  it("collects rest args", () => {
    const cmd = makeCmd("run ...");
    const result = parseArgv(["a", "b", "c"], cmd);
    assert.deepEqual(result.rest, ["a", "b", "c"]);
  });

  it("errors on unexpected positional without rest", () => {
    const cmd = makeCmd("up");
    const result = parseArgv(["extra"], cmd);
    assert.ok(result.error);
    assert.match(result.error, /unexpected argument 'extra'/);
  });

  it("-- stops option parsing", () => {
    const cmd = makeCmd("run ...");
    const result = parseArgv(["--", "--not-an-option"], cmd);
    assert.deepEqual(result.rest, ["--not-an-option"]);
  });

  it("returns help flag", () => {
    const cmd = makeCmd("build");
    const result = parseArgv(["--help"], cmd);
    assert.equal(result.help, true);
  });

  it("returns help flag for -h", () => {
    const cmd = makeCmd("build");
    const result = parseArgv(["-h"], cmd);
    assert.equal(result.help, true);
  });

  it("errors on unknown option", () => {
    const cmd = makeCmd("build {--verbose}");
    const result = parseArgv(["--unknown"], cmd);
    assert.ok(result.error);
    assert.match(result.error, /unknown option/);
  });

  it("normalizes long option to lowercase", () => {
    const cmd = makeCmd("build {--Verbose}");
    const result = parseArgv(["--verbose"], cmd);
    assert.equal(result.options["--verbose"], true);
  });
});

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

describe("Group", () => {
  it("creates a group and registers commands", () => {
    const g = new Group("be", "Back-End services");
    assert.equal(g.prefix, "be");
    assert.equal(g.description, "Back-End services");
    const builder = g.register("temp");
    assert.ok(builder instanceof CommandBuilder);
    assert.ok(g.commands.has("temp"));
  });

  it("rejects duplicate command registration", () => {
    const g = new Group("test", "Test");
    g.register("cmd");
    assert.throws(() => g.register("cmd"), /Duplicate command/);
  });

  it("supports fluent chaining", () => {
    const g = new Group("test", "Test");
    const builder = g.register("cmd");
    const result = builder
      .description("desc")
      .command("echo", "hello");
    assert.ok(result instanceof CommandBuilder);
  });

  it("zet.group() rejects reserved 'cli' prefix", () => {
    assert.throws(() => zet.group("cli", "CLI"), /reserved/);
  });
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

describe("templates", () => {
  it("creates a template and returns TemplateResult", () => {
    const docker = zet.template(
      (service) => ["docker", "compose", "exec", "-it", service]
    );
    const result = docker("app");
    assert.ok(result instanceof TemplateResult);
    assert.deepEqual(result.parts, ["docker", "compose", "exec", "-it", "app"]);
  });

  it("template with no args works", () => {
    const compose = zet.template(() => ["docker", "compose"]);
    const result = compose();
    assert.deepEqual(result.parts, ["docker", "compose"]);
  });

  it("throws when too few args provided", () => {
    const tmpl = zet.template((a, b) => ["cmd", a, b]);
    assert.throws(() => tmpl("one"), /Template expects 2 arguments, got 1/);
  });

  it("throws when function returns non-array", () => {
    const tmpl = zet.template(() => "not-array");
    assert.throws(() => tmpl(), /must return an array/);
  });
});

// ---------------------------------------------------------------------------
// CommandOutput
// ---------------------------------------------------------------------------

describe("CommandOutput", () => {
  it("success when code is 0", () => {
    const out = new CommandOutput(0, null, null, null);
    assert.equal(out.code, 0);
    assert.equal(out.success, true);
    assert.equal(out.failed, false);
  });

  it("failed when code is non-zero", () => {
    const out = new CommandOutput(1, "both", "stdout", "stderr");
    assert.equal(out.code, 1);
    assert.equal(out.output, "both");
    assert.equal(out.stdout, "stdout");
    assert.equal(out.stderr, "stderr");
    assert.equal(out.success, false);
    assert.equal(out.failed, true);
  });

  it("throw() throws on failure", () => {
    const out = new CommandOutput(1, null, null, null);
    assert.throws(() => out.throw(), /exit code 1/);
  });

  it("throw() returns this on success", () => {
    const out = new CommandOutput(0, null, null, null);
    assert.equal(out.throw(), out);
  });
});

// ---------------------------------------------------------------------------
// Help Formatting
// ---------------------------------------------------------------------------

describe("help formatting", () => {
  it("formatCommandHelp includes all sections", () => {
    const sig = parseSignature(
      "migrate {direction required} {steps? number of steps} {--Verbose} {--Seed= seed file} ..."
    );
    const cmd = new Command("migrate", null, sig);
    cmd.description = "Run database migrations";
    const help = formatCommandHelp(cmd);

    assert.match(help, /Usage: zet migrate/);
    assert.match(help, /<direction>/);
    assert.match(help, /\[steps\]/);
    assert.match(help, /\[args\.\.\.\]/);
    assert.match(help, /Run database migrations/);
    assert.match(help, /Arguments:/);
    assert.match(help, /direction/);
    assert.match(help, /\(required\)/);
    assert.match(help, /steps/);
    assert.match(help, /number of steps/);
    assert.match(help, /Options:/);
    assert.match(help, /--verbose/);
    assert.match(help, /--seed <value>/);
    assert.match(help, /-V/);
    assert.match(help, /-S/);
    assert.match(help, /--help, -h/);
  });

  it("formatCommandHelp shows group prefix in usage", () => {
    const sig = parseSignature("temp");
    const group = new Group("be", "Backend");
    const cmd = new Command("temp", group, sig);
    cmd.description = "A temp command";
    const help = formatCommandHelp(cmd);

    assert.match(help, /Usage: zet be temp/);
  });
});

// ---------------------------------------------------------------------------
// rest() placeholder
// ---------------------------------------------------------------------------

describe("zet.rest()", () => {
  it("returns a RestPlaceholder instance", () => {
    const placeholder = zet.rest();
    assert.equal(placeholder.constructor.name, "RestPlaceholder");
  });
});
