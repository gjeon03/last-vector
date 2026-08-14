/**
 * Public surface of the audio subsystem.
 *
 * The game only ever needs `AudioEngine`; everything else is exported so the offline
 * measurement harness can render the production graph without a parallel implementation.
 */

export {
  AudioEngine,
  createAudioGraph,
  MENU_DUCK_DEPTH,
  MENU_MUSIC_DEPTH,
  UI_DUCK_DEPTH,
} from './AudioEngine.ts';
export type { AudioEngineOptions, AudioGraph } from './AudioEngine.ts';

export { EngineLayer } from './engineLayer.ts';
export type { EngineLayerOptions } from './engineLayer.ts';

export { SfxKit } from './sfx.ts';
export type { SfxKitOptions } from './sfx.ts';

export { MusicBed } from './music.ts';
export type { MusicBedOptions } from './music.ts';

export { createUiAudio, SILENT_UI_AUDIO } from './uiAudio.ts';
export type { UiAudioBus } from './uiAudio.ts';

export {
  clamp,
  clamp01,
  createComb,
  createLfo,
  createLimiterCurve,
  createNoiseBuffer,
  createNoiseSource,
  createReverbIR,
  createRng,
  createSaturationCurve,
  disconnectAll,
  NodeLedger,
  rampTo,
  startNoise,
} from './nodes.ts';
export type { CombUnit, LfoUnit, NoiseColour, NoiseSource } from './nodes.ts';
