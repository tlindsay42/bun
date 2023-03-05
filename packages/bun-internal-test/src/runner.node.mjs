import * as action from "@actions/core";
import { spawnSync } from "child_process";
import { fsyncSync, rmSync, writeFileSync, writeSync } from "fs";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { basename } from "path";
import { fileURLToPath } from "url";

const cwd = resolve(fileURLToPath(import.meta.url), "../../../../");
process.chdir(cwd);

const isAction = !!process.env["GITHUB_ACTION"];
const errorPattern = /error: ([\S\s]*?)(?=\n.*?at (\/.*):(\d+):(\d+))/gim;

function* findTests(dir, query) {
  for (const entry of readdirSync(resolve(dir), { encoding: "utf-8", withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      yield* findTests(path, query);
    } else if (entry.name.includes(".test.")) {
      yield path;
    }
  }
}

function dump(buf) {
  var offset = 0,
    length = buf.byteLength;
  while (offset < length) {
    try {
      const wrote = writeSync(1, buf);
      offset += wrote;
      if (offset < length) {
        try {
          fsyncSync(1);
        } catch (e) {}

        buf = buf.slice(wrote);
      }
    } catch (e) {
      if (e.code === "EAGAIN") {
        continue;
      }

      throw e;
    }
  }
}

var failingTests = [];

async function runTest(path) {
  const name = path.replace(cwd, "").slice(1);
  const {
    stdout,
    stderr,
    status: exitCode,
  } = spawnSync("bun", ["test", basename(path)], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    env: {
      ...process.env,
      FORCE_COLOR: "1",
    },
  });
  if (isAction) {
    const prefix = +exitCode === 0 ? "PASS" : `FAIL`;
    action.startGroup(`${prefix} - ${name}`);
  }

  if (+exitCode !== 0) {
    failingTests.push(name);
  }

  dump(stdout);

  if (isAction) {
    findErrors(stdout);
    dump(stderr);

    findErrors(stderr);
  } else {
    dump(stderr);
    findErrors(stderr);
  }

  if (isAction) {
    action.endGroup();
  }
}

let failed = false;

function findErrors(data) {
  const text = new StringDecoder().write(new Buffer(data.buffer));
  for (const [message, _, path, line, col] of text.matchAll(errorPattern)) {
    failed = true;
    action.error(message, {
      file: path.replace(cwd, "").slice(1),
      startLine: parseInt(line),
      startColumn: parseInt(col),
    });
  }
}

const tests = [];
for (const path of findTests(resolve(cwd, "test/bun.js"))) {
  tests.push(runTest(path).catch(console.error));
}
await Promise.allSettled(tests);

rmSync("failing-tests.txt", { force: true });
if (failingTests.length > 0) {
  writeFileSync("failing-tests.txt", failingTests.join("\n") + "\n", "utf-8");
}
process.exit(failed ? 1 : 0);