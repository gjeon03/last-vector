/**
 * The narrow audio surface the interface layer is allowed to touch.
 *
 * The screens, HUD and settings panels should not be able to fire `gatePass` or drive the engine
 * model — they need four verbs and nothing else. Handing them named verbs instead of the raw
 * `AudioBus` keeps `SfxEvent` out of the UI layer entirely and makes the wiring impossible to get
 * subtly wrong.
 *
 * Every method is safe to call before `unlock()`, before the AudioContext exists, and after
 * `dispose()`. Nothing here throws and nothing here returns a promise, so the UI can call it
 * straight from an event handler without ceremony.
 */

import type { AudioBus } from '../core/contracts.ts';

export interface UiAudioBus {
  /**
   * Call from the first pointer or key event on any screen. Browsers refuse to start an
   * AudioContext outside a gesture, so this is what actually brings the whole subsystem up.
   * Idempotent and safe to call on every interaction.
   */
  unlock(): void;
  /** Focus or pointer moved onto an interactive element. */
  hover(): void;
  /** Confirm / activate. */
  click(): void;
  /** Cancel / go back / close. */
  back(): void;
}

/**
 * Wraps a full `AudioBus` as the restricted UI surface. `unlock()` deliberately swallows its
 * promise: the UI has nothing useful to do with the result, and an unhandled rejection in a
 * click handler would be a worse outcome than silence.
 */
export const createUiAudio = (bus: AudioBus): UiAudioBus => ({
  unlock: () => {
    void bus.unlock().catch(() => {
      /* audio is a garnish; a browser that refuses us must not break the interface */
    });
  },
  hover: () => bus.play('uiHover'),
  click: () => bus.play('uiClick'),
  back: () => bus.play('uiBack'),
});

/** A do-nothing surface, for tests and for any screen constructed before audio exists. */
export const SILENT_UI_AUDIO: UiAudioBus = {
  unlock: () => {},
  hover: () => {},
  click: () => {},
  back: () => {},
};
