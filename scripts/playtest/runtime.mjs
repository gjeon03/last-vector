import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const DEFAULTS = {
  dist: resolve(REPO_ROOT, 'dist'),
  headed: false,
  maxSimSeconds: 300,
  port: 0,
  positions: [0, 0.25, 0.5, 0.75, 1],
  profileSeconds: 10,
  quality: 'high',
  seed: 1337,
  timeoutMs: 45_000,
  url: null,
  vantages: null,
  viewport: { width: 1920, height: 1080 },
  // The backing store the game actually allocates is viewport x deviceScaleFactor, and this was
  // pinned at 1 for four rounds of review — so every frame-time figure ever produced for this
  // project described a configuration the game does not ship in on any Retina or 4K display.
  deviceScaleFactor: 1,
};

export function criterion(id, coverage, note) {
  return { id, coverage, note };
}

export function parseOptions(suite, argv) {
  const options = {
    ...DEFAULTS,
    out: resolve(REPO_ROOT, 'playtest-out', suite),
    positions: [...DEFAULTS.positions],
    viewport: { ...DEFAULTS.viewport },
  };

  const args = argv.filter((arg) => arg !== '--');
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const [flag, inlineValue] = arg.split('=', 2);
    const takeValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      index += 1;
      if (index >= args.length || args[index].startsWith('--')) {
        throw new Error(`${flag} requires a value`);
      }
      return args[index];
    };

    switch (flag) {
      case '--dist':
        options.dist = resolveFromRepo(takeValue());
        break;
      case '--headed':
        options.headed = true;
        break;
      case '--max-sim-seconds':
        options.maxSimSeconds = parsePositiveNumber(flag, takeValue());
        break;
      case '--device-scale-factor':
        options.deviceScaleFactor = parsePositiveNumber(flag, takeValue());
        break;
      case '--out':
        options.out = resolveFromRepo(takeValue());
        break;
      case '--port':
        options.port = parseInteger(flag, takeValue(), 0, 65_535);
        break;
      case '--positions':
        options.positions = parsePositions(takeValue());
        break;
      case '--profile-seconds':
        options.profileSeconds = parsePositiveNumber(flag, takeValue());
        break;
      case '--quality': {
        const quality = takeValue();
        if (!['low', 'medium', 'high', 'ultra'].includes(quality)) {
          throw new Error('--quality must be low, medium, high, or ultra');
        }
        options.quality = quality;
        break;
      }
      case '--seed':
        options.seed = parseInteger(flag, takeValue(), 0, 0xffff_ffff);
        break;
      case '--timeout-ms':
        options.timeoutMs = parseInteger(flag, takeValue(), 1, 300_000);
        break;
      case '--url':
        options.url = validateLoopbackUrl(takeValue()).href;
        break;
      case '--vantages':
        options.vantages = takeValue().split(',').map((value) => value.trim()).filter(Boolean);
        if (options.vantages.length === 0) throw new Error('--vantages cannot be empty');
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  return options;
}

export async function runManagedSuite({ suite, argv, requiredMethods, execute }) {
  let options;
  let parseError = null;
  try {
    options = parseOptions(suite, argv);
  } catch (error) {
    options = parseOptions(suite, []);
    parseError = normaliseError(error);
  }

  const report = new Report(suite, options);
  await mkdir(options.out, { recursive: true });

  if (parseError) {
    report.addFailure({
      id: 'SETUP.arguments',
      name: 'Command-line arguments are valid',
      criteria: [],
      assertion: 'Every option is recognised and has a valid, in-range value.',
      error: parseError,
      evidence: { argv },
    });
  }

  const session = await openSession(report, options, requiredMethods);
  try {
    await execute({ report, session, options });
  } catch (error) {
    report.addFailure({
      id: 'SUITE.unhandled',
      name: `${suite} suite completed its checks`,
      criteria: [],
      assertion: 'The suite body completes without escaping its per-check error boundary.',
      error: normaliseError(error),
      evidence: null,
    });
  }

  await addRuntimeChecks(report, session);
  await closeSession(session);
  await report.write();

  process.stdout.write(`${report.status}: ${report.reportPath}\n`);
  process.exitCode = report.status === 'PASS' ? 0 : 1;
  return report.data;
}

export class Report {
  constructor(suite, options) {
    this.started = Date.now();
    this.reportPath = resolve(options.out, 'report.json');
    this.data = {
      schemaVersion: 1,
      suite,
      status: 'RUNNING',
      startedAt: new Date(this.started).toISOString(),
      finishedAt: null,
      durationMs: null,
      environment: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        viewport: options.viewport,
        target: null,
        browser: null,
      },
      configuration: {
        dist: toRepoRelative(options.dist),
        headed: options.headed,
        maxSimSeconds: options.maxSimSeconds,
        output: toRepoRelative(options.out),
        positions: options.positions,
        profileSeconds: options.profileSeconds,
        quality: options.quality,
        seed: options.seed,
        timeoutMs: options.timeoutMs,
        url: options.url,
        vantages: options.vantages,
      },
      summary: { passed: 0, failed: 0, total: 0 },
      checks: [],
      observations: {
        consoleErrors: [],
        externalRequests: [],
        pageErrors: [],
        requests: [],
        staticServer: [],
      },
      artifacts: [],
    };
  }

  get status() {
    return this.data.status;
  }

  async check({ id, name, criteria = [], assertion }, operation) {
    try {
      const evidence = await operation();
      this.addPass({ id, name, criteria, assertion, evidence: evidence ?? null });
      return { ok: true, evidence: evidence ?? null, error: null };
    } catch (error) {
      const normalised = normaliseError(error);
      this.addFailure({
        id,
        name,
        criteria,
        assertion,
        evidence: normalised.evidence ?? null,
        error: normalised,
      });
      return { ok: false, evidence: normalised.evidence ?? null, error: normalised };
    }
  }

  addPass({ id, name, criteria = [], assertion, evidence }) {
    this.data.checks.push({
      id,
      name,
      criteria,
      status: 'PASS',
      assertion,
      evidence: evidence ?? null,
      error: null,
    });
  }

  addFailure({ id, name, criteria = [], assertion, evidence, error }) {
    this.data.checks.push({
      id,
      name,
      criteria,
      status: 'FAIL',
      assertion,
      evidence: evidence ?? null,
      error: normaliseError(error),
    });
  }

  addArtifact(kind, path, metadata = {}) {
    this.data.artifacts.push({ kind, path: toRepoRelative(path), ...metadata });
  }

  async write() {
    const finished = Date.now();
    const passed = this.data.checks.filter((check) => check.status === 'PASS').length;
    const failed = this.data.checks.filter((check) => check.status === 'FAIL').length;
    this.data.status = failed === 0 ? 'PASS' : 'FAIL';
    this.data.finishedAt = new Date(finished).toISOString();
    this.data.durationMs = finished - this.started;
    this.data.summary = { passed, failed, total: passed + failed };
    await mkdir(dirname(this.reportPath), { recursive: true });
    this.addArtifact('report', this.reportPath);
    await writeFile(this.reportPath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
  }
}

export function verify(condition, message, evidence = null) {
  if (condition) return;
  const error = new Error(message);
  error.name = 'AssertionError';
  error.evidence = evidence;
  throw error;
}

export async function invokeHarness(page, method, args = [], timeoutMs = 15_000) {
  if (!page) {
    return {
      ok: false,
      value: null,
      error: { name: 'HarnessUnavailable', message: 'Browser page is unavailable.' },
    };
  }

  return page.evaluate(async ({ requestedMethod, requestedArgs, callTimeoutMs }) => {
    const api = window.__LV;
    if (!api) {
      return {
        ok: false,
        value: null,
        error: {
          name: 'HarnessUnavailable',
          message: 'window.__LV is missing. The game must install the automation API before playtests run.',
        },
      };
    }

    const member = api[requestedMethod];
    if (typeof member !== 'function') {
      return {
        ok: false,
        value: null,
        error: {
          name: 'HarnessCapabilityMissing',
          message: `window.__LV.${requestedMethod} is not implemented.`,
        },
      };
    }

    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = window.setTimeout(() => {
          reject(new Error(`window.__LV.${requestedMethod} timed out after ${callTimeoutMs} ms`));
        }, callTimeoutMs);
      });
      const value = await Promise.race([
        Promise.resolve(member.apply(api, requestedArgs)),
        timeout,
      ]);
      return { ok: true, value: value ?? null, error: null };
    } catch (error) {
      return {
        ok: false,
        value: null,
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    } finally {
      window.clearTimeout(timer);
    }
  }, { requestedMethod: method, requestedArgs: args, callTimeoutMs: timeoutMs });
}

export async function callHarness(page, method, args = [], timeoutMs = 15_000) {
  const outcome = await invokeHarness(page, method, args, timeoutMs);
  if (!outcome.ok) {
    const error = new Error(outcome.error.message);
    error.name = outcome.error.name;
    error.evidence = { method, args, harnessError: outcome.error };
    throw error;
  }
  return outcome.value;
}

export async function inspectHarness(page, requiredMethods) {
  if (!page) {
    return {
      present: false,
      version: null,
      seed: null,
      methods: Object.fromEntries(requiredMethods.map((method) => [method, false])),
      missing: [...requiredMethods],
    };
  }

  return page.evaluate((methods) => {
    const api = window.__LV;
    const capabilities = Object.fromEntries(
      methods.map((method) => [method, typeof api?.[method] === 'function']),
    );
    return {
      present: Boolean(api),
      version: typeof api?.version === 'string' ? api.version : null,
      seed: Number.isInteger(api?.seed) ? api.seed : null,
      methods: capabilities,
      missing: methods.filter((method) => !capabilities[method]),
    };
  }, requiredMethods);
}

export async function waitForHarness(page, timeoutMs = 45_000) {
  if (!page) return false;
  try {
    await page.waitForFunction(
      () => Boolean(window.__LV),
      undefined,
      { timeout: timeoutMs },
    );
    return true;
  } catch (error) {
    if (error?.name === 'TimeoutError') return false;
    throw error;
  }
}

export async function reloadHarness(page, timeoutMs) {
  verify(page, 'Browser page is unavailable.');
  const response = await page.reload({ waitUntil: 'load', timeout: timeoutMs });
  verify(response && response.ok(), 'Reload did not return a successful document response.', {
    status: response?.status() ?? null,
  });
  await waitForHarness(page, timeoutMs);
  await callHarness(page, 'ready', [], timeoutMs);
}

export function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function resolveFromRepo(path) {
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

function parsePositiveNumber(flag, value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${flag} must be a positive number`);
  }
  return number;
}

function parseInteger(flag, value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${flag} must be an integer from ${minimum} through ${maximum}`);
  }
  return number;
}

function parsePositions(value) {
  const positions = value.split(',').map((entry) => Number(entry.trim()));
  if (positions.length === 0 || positions.some((position) => !Number.isFinite(position))) {
    throw new Error('--positions must be a comma-separated list of numbers');
  }
  if (positions.some((position) => position < 0 || position > 1)) {
    throw new Error('--positions values must be between 0 and 1');
  }
  return positions;
}

function validateLoopbackUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`--url is not a valid URL: ${value}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('--url must use http or https');
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error('--url must target localhost, 127.0.0.1, or ::1');
  }
  return url;
}

async function openSession(report, options, requiredMethods) {
  const session = {
    browser: null,
    context: null,
    page: null,
    target: null,
    observations: report.data.observations,
  };

  const targetOutcome = await report.check({
    id: 'M1.static-host',
    name: 'Built game is served by the zero-logic static server',
    criteria: [criterion('M1', 'full', 'Proves dist output loads through scripts/static-server.mjs.')],
    assertion: 'Without --url, scripts/static-server.mjs returns dist/index.html with HTTP 200 and HTML content; --url runs cannot claim M1.',
  }, async () => {
    session.target = await createTarget(options, session.observations.staticServer);
    report.data.environment.target = session.target.metadata;
    verify(session.target.mode === 'static', '--url selected a pre-existing server, so this run does not prove static hosting.', session.target.metadata);
    verify(options.dist === resolve(REPO_ROOT, 'dist'), '--dist selected a diagnostic fixture or alternate root, so this run does not prove the production dist/ build.', session.target.metadata);
    verify(session.target.response.status === 200, 'Static server did not return HTTP 200 for the entry document.', session.target.response);
    verify(session.target.response.contentType.includes('text/html'), 'Static entry document did not have an HTML content type.', session.target.response);
    return session.target.metadata;
  });

  if (!session.target) {
    report.addFailure({
      id: 'SETUP.target',
      name: 'Local target is reachable',
      criteria: [],
      assertion: 'The configured static build or --url endpoint responds on a loopback address.',
      error: targetOutcome.error,
      evidence: targetOutcome.evidence,
    });
    return session;
  }

  const dependencyOutcome = await report.check({
    id: 'SETUP.playwright',
    name: 'Playwright Chromium driver is available',
    criteria: [],
    assertion: 'The playwright package imports and launches Chromium at the configured 1920x1080 viewport.',
  }, async () => {
    let playwright;
    try {
      playwright = await import('playwright');
    } catch (error) {
      const wrapped = new Error('Could not import playwright. Run pnpm install, then pnpm exec playwright install chromium once.');
      wrapped.cause = error;
      throw wrapped;
    }

    try {
      session.browser = await playwright.chromium.launch({
        headless: !options.headed,
        args: process.platform === 'darwin'
          ? ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
          : [],
      });
    } catch (error) {
      const wrapped = new Error('Could not launch Chromium. Run pnpm exec playwright install chromium once.');
      wrapped.cause = error;
      throw wrapped;
    }
    report.data.environment.browser = {
      engine: 'chromium',
      version: session.browser.version(),
      headless: !options.headed,
    };
    return report.data.environment.browser;
  });

  if (!dependencyOutcome.ok) return session;

  const pageOutcome = await report.check({
    id: 'SETUP.page-load',
    name: 'Game document loads in Chromium',
    criteria: [],
    assertion: 'Chromium receives a successful main-document response and reaches the load event.',
  }, async () => {
    session.context = await session.browser.newContext({
      viewport: options.viewport,
      deviceScaleFactor: options.deviceScaleFactor,
      serviceWorkers: 'block',
    });
    await installNetworkBoundary(session.context, session.observations);
    session.page = await session.context.newPage();
    installPageObservers(session.page, session.observations);
    const gameUrl = new URL(session.target.url);
    gameUrl.searchParams.set('seed', String(options.seed));
    const response = await session.page.goto(gameUrl.href, {
      waitUntil: 'load',
      timeout: options.timeoutMs,
    });
    verify(response && response.ok(), 'Main document returned a non-success status.', {
      status: response?.status() ?? null,
      url: session.target.url,
    });
    return { status: response.status(), url: response.url() };
  });

  if (!pageOutcome.ok) return session;

  await report.check({
    id: 'API.contract',
    name: 'Required window.__LV capabilities are installed',
    criteria: [],
    assertion: `window.__LV exists, has a string version, reports seed ${options.seed}, and implements: ${requiredMethods.join(', ')}.`,
  }, async () => {
    await waitForHarness(session.page, options.timeoutMs);
    const inspection = await inspectHarness(session.page, requiredMethods);
    verify(inspection.present, 'window.__LV is missing.', inspection);
    verify(Boolean(inspection.version), 'window.__LV.version is missing or is not a string.', inspection);
    verify(inspection.seed === options.seed, `window.__LV.seed does not match requested seed ${options.seed}.`, inspection);
    verify(inspection.missing.length === 0, `Missing automation capabilities: ${inspection.missing.join(', ')}`, inspection);
    return inspection;
  });

  return session;
}

async function createTarget(options, serverLog) {
  if (options.url) {
    const response = await fetchLocalDocument(options.url, options.timeoutMs);
    return {
      mode: 'url',
      url: options.url,
      response,
      process: null,
      metadata: {
        mode: 'url',
        url: options.url,
        staticRoot: null,
        command: null,
        response,
      },
    };
  }

  const port = options.port || await availablePort();
  const serverPath = resolve(REPO_ROOT, 'scripts/static-server.mjs');
  const child = spawn(process.execPath, [serverPath, options.dist, String(port)], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => serverLog.push({ stream: 'stdout', text: chunk.toString().trim() }));
  child.stderr.on('data', (chunk) => serverLog.push({ stream: 'stderr', text: chunk.toString().trim() }));

  const url = `http://127.0.0.1:${port}/`;
  try {
    const response = await fetchLocalDocument(url, options.timeoutMs, child);
    return {
      mode: 'static',
      url,
      response,
      process: child,
      metadata: {
        mode: 'static',
        url,
        staticRoot: toRepoRelative(options.dist),
        command: `node scripts/static-server.mjs ${shellDisplay(options.dist)} ${port}`,
        response,
      },
    };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

async function fetchLocalDocument(url, timeoutMs, child = null) {
  validateLoopbackUrl(url);
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`Static server exited before becoming ready (exit ${child.exitCode}).`);
    }
    try {
      const response = await fetch(url, { redirect: 'manual' });
      const bytes = Buffer.from(await response.arrayBuffer());
      return {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  }
  const detail = lastError instanceof Error ? ` ${lastError.message}` : '';
  throw new Error(`Local target did not respond within ${timeoutMs} ms.${detail}`);
}

async function installNetworkBoundary(context, observations) {
  context.on('request', (request) => {
    observations.requests.push({ method: request.method(), resourceType: request.resourceType(), url: request.url() });
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (isAllowedRuntimeUrl(request.url())) {
      await route.continue();
      return;
    }
    const record = { method: request.method(), resourceType: request.resourceType(), url: request.url() };
    observations.externalRequests.push(record);
    await route.abort('blockedbyclient');
  });
}

function installPageObservers(page, observations) {
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    observations.consoleErrors.push({
      text: message.text(),
      location: message.location(),
    });
  });
  page.on('pageerror', (error) => {
    observations.pageErrors.push({ name: error.name, message: error.message });
  });
}

async function addRuntimeChecks(report, session) {
  await report.check({
    id: 'M5.runtime-errors',
    name: 'Browser and game error channels stay empty',
    criteria: [criterion('M5', 'partial', 'Covers console, uncaught page errors, and __LV.errors(); FPS is covered by perf-probe.')],
    assertion: 'No console errors, uncaught page errors, or game error-boundary errors are observed during the suite.',
  }, async () => {
    verify(session.page, 'Browser page is unavailable, so runtime error channels could not be inspected.');
    const gameErrors = await callHarness(session.page, 'errors');
    const evidence = {
      consoleErrors: session.observations.consoleErrors,
      pageErrors: session.observations.pageErrors,
      gameErrors,
    };
    verify(Array.isArray(gameErrors), 'window.__LV.errors() did not return an array.', evidence);
    verify(session.observations.consoleErrors.length === 0, 'Console errors were captured.', evidence);
    verify(session.observations.pageErrors.length === 0, 'Uncaught page errors were captured.', evidence);
    verify(gameErrors.length === 0, 'The game error boundary captured errors.', evidence);
    return evidence;
  });

  await report.check({
    id: 'M6.localhost-only',
    name: 'Runtime traffic stays on localhost',
    criteria: [criterion('M6', 'full', 'Intercepts every browser-context request and blocks any non-local URL.')],
    assertion: 'All HTTP(S) and WebSocket requests target localhost, 127.0.0.1, or ::1; data/blob/about URLs remain browser-local.',
  }, async () => {
    verify(session.context, 'Browser context is unavailable, so network locality could not be measured.');
    const evidence = {
      requestCount: session.observations.requests.length,
      externalRequests: session.observations.externalRequests,
    };
    verify(session.observations.externalRequests.length === 0, 'External runtime requests were attempted and blocked.', evidence);
    return evidence;
  });
}

async function closeSession(session) {
  try {
    await session.context?.close();
  } catch {
    // Cleanup cannot replace the structured evidence already collected.
  }
  try {
    await session.browser?.close();
  } catch {
    // Cleanup cannot replace the structured evidence already collected.
  }
  if (session.target?.process) await stopChild(session.target.process);
}

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port === null) reject(new Error('Could not allocate a loopback port.'));
        else resolvePort(port);
      });
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    delay(2_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function isAllowedRuntimeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (['data:', 'blob:', 'about:'].includes(url.protocol)) return true;
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return false;
  return isLoopbackHostname(url.hostname);
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

function shellDisplay(path) {
  const display = toRepoRelative(path);
  return /\s/.test(display) ? JSON.stringify(display) : display;
}

function toRepoRelative(path) {
  if (!path) return path;
  const local = relative(REPO_ROOT, path);
  return local && !local.startsWith('..') && !isAbsolute(local) ? local : path;
}

function normaliseError(error) {
  if (!error) return { name: 'Error', message: 'Unknown error' };
  if (typeof error === 'string') return { name: 'Error', message: error };
  return {
    name: typeof error.name === 'string' ? error.name : 'Error',
    message: typeof error.message === 'string' ? error.message : String(error),
    ...(error.evidence !== undefined ? { evidence: error.evidence } : {}),
    ...(error.cause instanceof Error
      ? { cause: error.cause.message }
      : typeof error.cause === 'string'
        ? { cause: error.cause }
        : {}),
  };
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
