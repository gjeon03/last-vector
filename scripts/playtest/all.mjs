import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { REPO_ROOT } from './runtime.mjs';

const started = Date.now();
const { outputRoot, forwardedArgs } = extractOutput(process.argv.slice(2));
const suites = [
  { name: 'playtest', script: 'playtest.mjs' },
  { name: 'perf-probe', script: 'perf-probe.mjs' },
  { name: 'screenshot-matrix', script: 'screenshot-matrix.mjs' },
  // Nobody has heard this build, so the offline audio measurement IS the audio quality gate —
  // and a gate that is not run does not gate. It fails the build when a gameplay-critical cue
  // has no band with positive SNR against the boost engine bed, which is the exact property that
  // went unnoticed until an outside review re-measured it.
  // --require-clean: everything this suite produces is quoted as evidence, and a green run
  // against an uncommitted tree describes no commit at all.
  { name: 'audio-probe', script: 'audio-probe.mjs', args: ['--require-clean'] },
];
const results = [];

await mkdir(outputRoot, { recursive: true });
for (const suite of suites) {
  const suiteOutput = resolve(outputRoot, suite.name);
  const script = resolve(REPO_ROOT, 'scripts/playtest', suite.script);
  const execution = await runChild(script, [...forwardedArgs, ...(suite.args ?? []), '--out', suiteOutput]);
  let report = null;
  let reportError = null;
  try {
    report = JSON.parse(await readFile(resolve(suiteOutput, 'report.json'), 'utf8'));
  } catch (error) {
    reportError = error instanceof Error ? error.message : String(error);
  }
  results.push({
    suite: suite.name,
    exitCode: execution.exitCode,
    signal: execution.signal,
    stdout: execution.stdout,
    stderr: execution.stderr,
    reportPath: relativeOutput(resolve(suiteOutput, 'report.json')),
    status: report?.status ?? 'FAIL',
    summary: report?.summary ?? null,
    reportError,
  });
}

const finished = Date.now();
const status = results.every((result) => result.status === 'PASS') ? 'PASS' : 'FAIL';
const combined = {
  schemaVersion: 1,
  suite: 'all',
  status,
  startedAt: new Date(started).toISOString(),
  finishedAt: new Date(finished).toISOString(),
  durationMs: finished - started,
  outputRoot: relativeOutput(outputRoot),
  suites: results,
};
const combinedPath = resolve(outputRoot, 'report.json');
await writeFile(combinedPath, `${JSON.stringify(combined, null, 2)}\n`, 'utf8');
process.stdout.write(`${status}: ${combinedPath}\n`);
process.exitCode = status === 'PASS' ? 0 : 1;

function extractOutput(argv) {
  const outputArgs = [];
  let output = resolve(REPO_ROOT, 'playtest-out');
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') {
      const value = argv[index + 1];
      if (value && !value.startsWith('--')) {
        output = absoluteFromRepo(value);
        index += 1;
        continue;
      }
    }
    if (arg.startsWith('--out=')) {
      output = absoluteFromRepo(arg.slice('--out='.length));
      continue;
    }
    outputArgs.push(arg);
  }
  return { outputRoot: output, forwardedArgs: outputArgs };
}

function runChild(script, args) {
  return new Promise((resolveExecution) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });
    child.once('error', (error) => {
      resolveExecution({ exitCode: null, signal: null, stdout, stderr: `${stderr}${error.message}\n` });
    });
    child.once('exit', (exitCode, signal) => {
      resolveExecution({ exitCode, signal, stdout, stderr });
    });
  });
}

function absoluteFromRepo(path) {
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

function relativeOutput(path) {
  return path.startsWith(`${REPO_ROOT}/`) ? path.slice(REPO_ROOT.length + 1) : path;
}
