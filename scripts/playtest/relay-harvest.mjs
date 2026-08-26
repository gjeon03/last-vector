#!/usr/bin/env node

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  callHarness,
  runManagedSuite,
  verify,
  waitForHarness,
} from './runtime.mjs';

const REQUIRED_METHODS = [
  'ready',
  'startRun',
  'phase',
  'result',
  'telemetry',
  'course',
  'catalog',
  'installProgress',
  'setInput',
  'setAutopilot',
  'step',
  'stepSimulation',
  'setSettings',
  'present',
  'profile',
  'errors',
];

await runManagedSuite({
  suite: 'relay-harvest',
  argv: process.argv.slice(2),
  requiredMethods: REQUIRED_METHODS,
  execute: runRelayHarvest,
});

async function runRelayHarvest({ report, session, options }) {
  const page = session.page;
  const captures = resolve(options.out, 'screenshots');
  await mkdir(captures, { recursive: true });

  await report.check({
    id: 'RELAY.boot-catalog',
    name: 'The two-chapter product boots BLACKOUT RELAY canonically',
    assertion: 'CAIRN unlock facts authorize relay-harvest; active order has exactly two missions and layout=0 is reproducible.',
  }, async () => {
    await callHarness(page, 'installProgress', [{
      version: 2,
      selectedMission: 'relay-harvest',
      missions: {
        'cairn-drift': {
          cleared: true,
          clearedAt: 1,
          highestRank: 'A',
          cleanClear: true,
          mastery: { precision: true },
        },
      },
      dormantCourses: {},
    }]);
    const url = new URL(page.url());
    url.searchParams.set('mission', 'relay-harvest');
    url.searchParams.set('layout', '0');
    url.searchParams.set('seed', String(options.seed));
    url.searchParams.delete('course');
    const response = await page.goto(url.href, { waitUntil: 'load', timeout: options.timeoutMs });
    verify(response?.ok(), 'Relay document failed to reload.', { status: response?.status() });
    verify(await waitForHarness(page, options.timeoutMs), 'Relay harness did not install.');
    await callHarness(page, 'ready', [], options.timeoutMs);
    const course = await callHarness(page, 'course');
    const catalog = await callHarness(page, 'catalog');
    verify(JSON.stringify(catalog.order) === JSON.stringify(['cairn-drift', 'relay-harvest']),
      'Active mission order is not exactly the approved two chapters.', { catalog });
    verify(course.courseId === 'relay-harvest', 'Relay runtime was not selected.', { course });
    verify(new URL(page.url()).searchParams.get('layout') === '0', 'Layout URL is not canonical.', { url: page.url() });
    verify(course.recordId.includes('-layout-rh1-'), 'PB record does not include layout signature.', { course });
    return { course, order: catalog.order, url: page.url() };
  });

  await report.check({
    id: 'RELAY.initial-state',
    name: 'Ten visible physical sources project into a clean collection HUD',
    assertion: 'Before launch the objective exposes ten distinct unstable sources, requires all ten, and renders ten status pips.',
  }, async () => {
    const telemetry = await callHarness(page, 'telemetry');
    const objective = telemetry.objective;
    const dom = await page.evaluate(() => ({
      pips: document.querySelectorAll('.lv-collection-source').length,
      status: document.querySelector('.lv-collection-summary')?.textContent ?? '',
      oldCopy: document.body.textContent?.match(/LAST ASCENT|DEAD SIGNAL|FIRE/g) ?? [],
    }));
    verify(objective.kind === 'collection', 'Objective is not collection.', { objective });
    verify(objective.sources.length === 10 && new Set(objective.sources.map((source) => source.id)).size === 10,
      'Objective does not expose ten unique sources.', { objective });
    verify(objective.collected === 0 && objective.required === 10 && objective.chargeRequired === 100,
      'Initial charge contract is wrong.', { objective });
    verify(dom.pips === 10, 'HUD does not contain ten fixed source pips.', dom);
    verify(dom.oldCopy.length === 0, 'Rejected mission copy remains in the live product.', dom);
    return { objective, dom };
  });

  const firstRun = await report.check({
    id: 'RELAY.collection-60hz',
    name: 'Production flight sweeps ten sources and returns to the relay',
    assertion: 'The real 60 Hz ship/autopilot path collects all ten cores, reaches charge 100, then returns to RELAY HEART before the window closes.',
  }, async () => {
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setInput', [{ boost: true }]);
    await callHarness(page, 'setAutopilot', [true, { skill: 1 }]);
    // Capture both sides of the first pickup. The approach has to prove there is a physical
    // object to fly through; the next beat has to explain what that action accomplished.
    await callHarness(page, 'stepSimulation', [450, 1 / 60], options.timeoutMs);
    // Fast simulation intentionally skips intermediate camera frames. Cycle exterior modes once
    // so the captured pose matches the 60 Hz live camera rather than a seven-second-old boom.
    await callHarness(page, 'setSettings', [{ cameraMode: 'far-chase' }]);
    await callHarness(page, 'step', [1, 1 / 60]);
    await callHarness(page, 'setSettings', [{ cameraMode: 'chase' }]);
    await callHarness(page, 'step', [1, 1 / 60]);
    await callHarness(page, 'present');
    // `stepSimulation` advances game time synchronously, while screen fades intentionally use
    // wall time. Let the title/countdown veil leave the compositor before judging the world.
    await page.waitForTimeout(450);
    const approachCapture = resolve(captures, '01-relay-approach.png');
    await page.screenshot({ path: approachCapture });
    report.addArtifact('screenshot', approachCapture, { state: 'relay-approach' });
    await callHarness(page, 'stepSimulation', [150, 1 / 60], options.timeoutMs);
    await callHarness(page, 'setSettings', [{ cameraMode: 'far-chase' }]);
    await callHarness(page, 'step', [1, 1 / 60]);
    await callHarness(page, 'setSettings', [{ cameraMode: 'chase' }]);
    await callHarness(page, 'step', [1, 1 / 60]);
    await callHarness(page, 'present');
    const pickupCapture = resolve(captures, '02-relay-pickup.png');
    await page.screenshot({ path: pickupCapture });
    report.addArtifact('screenshot', pickupCapture, { state: 'relay-pickup' });
    for (let chunk = 0; chunk < 24 && await callHarness(page, 'phase') === 'flying'; chunk++) {
      await callHarness(page, 'stepSimulation', [600, 1 / 60], options.timeoutMs);
    }
    const phase = await callHarness(page, 'phase');
    const result = await callHarness(page, 'result');
    const telemetry = await callHarness(page, 'telemetry');
    verify(phase === 'finished', 'Relay reference flight did not finish.', { phase, result, objective: telemetry.objective });
    verify(result?.kind === 'collection', 'Result is not collection.', { result });
    verify(result.collected === 10 && result.required === 10 && result.charge === 100,
      'Ten-core sweep did not finish at the exact threshold.', { result });
    verify(telemetry.objective.sources.filter((source) => source.collected).length === 10,
      'Telemetry did not preserve all ten collected sources.', { objective: telemetry.objective });
    // The result view has a 340 ms entrance. An immediate screenshot records the transparent
    // first frame and can make a valid result screen look absent.
    await page.waitForTimeout(450);
    const resultCapture = resolve(captures, '03-relay-result.png');
    await page.screenshot({ path: resultCapture });
    report.addArtifact('screenshot', resultCapture, { state: 'relay-result' });
    return { result, objective: telemetry.objective, course: await callHarness(page, 'course') };
  });

  await report.check({
    id: 'RELAY.result-ui',
    name: 'Result exposes replay and explicit reroll choices',
    assertion: 'The collection result shows charge/core/PB facts and separate RUN AGAIN and NEW LAYOUT actions without horizontal overflow.',
  }, async () => {
    verify(firstRun.ok, 'Collection run prerequisite failed.', firstRun);
    const dom = await page.evaluate(() => ({
      actions: [...document.querySelectorAll('[data-action]')].map((node) => node.getAttribute('data-action')),
      text: document.querySelector('.lv-results')?.textContent ?? document.body.textContent ?? '',
      width: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    verify(dom.actions.includes('run-again') && dom.actions.includes('new-layout'),
      'Result actions are missing replay or reroll.', dom);
    verify(/RELAY CHARGE/u.test(dom.text) && /CORES RECOVERED/u.test(dom.text),
      'Collection result facts are missing.', dom);
    verify(dom.width <= dom.clientWidth + 1, 'Result overflows horizontally.', dom);
    return dom;
  });

  await report.check({
    id: 'RELAY.same-layout-retry',
    name: 'RUN AGAIN retains the same learnable layout and PB partition',
    assertion: 'Result replay resets collection state in memory without changing URL layout or record ID.',
  }, async () => {
    const before = await callHarness(page, 'course');
    await page.locator('[data-action="run-again"]').click();
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    const after = await callHarness(page, 'course');
    const objective = (await callHarness(page, 'telemetry')).objective;
    verify(after.recordId === before.recordId, 'RUN AGAIN changed the PB partition.', { before, after });
    verify(new URL(page.url()).searchParams.get('layout') === '0', 'RUN AGAIN changed layout URL.', { url: page.url() });
    verify(objective.kind === 'collection' && objective.collected === 0 && objective.charge === 0,
      'RUN AGAIN did not reset objective state.', { objective });
    return { before, after, objective };
  });

  await report.check({
    id: 'RELAY.new-layout',
    name: 'NEW LAYOUT changes geometry and PB partition deliberately',
    assertion: 'After another clear, NEW LAYOUT performs a full canonical reload to a different validated index and record ID.',
  }, async () => {
    await callHarness(page, 'setInput', [{ boost: true }]);
    await callHarness(page, 'setAutopilot', [true, { skill: 1 }]);
    for (let chunk = 0; chunk < 26 && await callHarness(page, 'phase') === 'flying'; chunk++) {
      await callHarness(page, 'stepSimulation', [600, 1 / 60], options.timeoutMs);
    }
    verify(await callHarness(page, 'phase') === 'finished', 'Second same-layout run did not finish.');
    const before = await callHarness(page, 'course');
    await Promise.all([
      page.waitForLoadState('load'),
      page.locator('[data-action="new-layout"]').click(),
    ]);
    verify(await waitForHarness(page, options.timeoutMs), 'Harness did not return after NEW LAYOUT.');
    await callHarness(page, 'ready', [], options.timeoutMs);
    const after = await callHarness(page, 'course');
    const layout = new URL(page.url()).searchParams.get('layout');
    verify(layout !== '0', 'NEW LAYOUT retained the old validated index.', { layout, url: page.url() });
    verify(after.recordId !== before.recordId, 'NEW LAYOUT retained the old PB partition.', { before, after });
    return { before, after, layout, url: page.url() };
  });

  await report.check({
    id: 'RELAY.performance',
    name: 'The ten-source relay field stays inside the live frame budget',
    assertion: 'At high quality and the requested pixel ratio, a live three-second all-source run sustains at least 55 fps, p95 <= 22 ms, no late long-frame burst, and stable full render scale.',
  }, async () => {
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setInput', [{ throttle: 1 }]);
    const sample = await callHarness(page, 'profile', [3], options.timeoutMs + 10_000);
    verify(sample.fps >= 55, `Relay profile fell to ${sample.fps.toFixed(2)} fps.`, sample);
    verify(sample.p95FrameMs <= 22, `Relay p95 is ${sample.p95FrameMs.toFixed(2)} ms.`, sample);
    verify(sample.longFrames <= 2, `Relay emitted ${sample.longFrames} long frames.`, sample);
    verify(sample.renderScale >= 0.9, `Relay render scale fell to ${sample.renderScale}.`, sample);
    return sample;
  });
}
