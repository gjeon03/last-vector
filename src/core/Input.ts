import { clamp, clamp01, deadzone, expo } from './mathx.ts';
import type { HarnessInput } from './harness.ts';

/**
 * Pilot input. Three sources are folded into one command set:
 *   pointer-locked mouse + keyboard, gamepad, and the automation harness.
 *
 * The mouse drives a *virtual stick* rather than an absolute cursor: movement deflects the
 * stick, and the stick self-centres. That is what makes mouse flight feel like a control
 * surface instead of a camera drag, and it is why the ship keeps turning while you hold a
 * deflection.
 */
export interface FlightCommand {
  pitch: number;
  yaw: number;
  roll: number;
  throttle: number;
  strafeX: number;
  strafeY: number;
  boost: boolean;
  brake: boolean;
  /** Pixels of raw mouse motion this frame, for the reticle's own inertia. */
  stickX: number;
  stickY: number;
}

const KEY_ALIASES: Record<string, string> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

const isShiftCode = (code: string): boolean => code === 'ShiftLeft' || code === 'ShiftRight';

export class Input {
  readonly command: FlightCommand = {
    pitch: 0,
    yaw: 0,
    roll: 0,
    throttle: 0.85,
    strafeX: 0,
    strafeY: 0,
    boost: false,
    brake: false,
    stickX: 0,
    stickY: 0,
  };

  sensitivity = 1;
  invertY = false;
  /** When set, the harness fully overrides the human. */
  private override: HarnessInput | null = null;

  /** Physical keyboard state observed while this window owns focus. */
  private readonly keys = new Set<string>();
  /**
   * Non-modifier keys that crossed a run/focus boundary while down. Their OS repeats are not a
   * new command: they stay quarantined until keyup, or until a fresh non-repeat keydown proves the
   * old release happened outside the page. This is what keeps menu W/S out of the countdown.
   */
  private readonly suppressedUntilKeyUp = new Set<string>();
  /**
   * Shift is also reconstructed from another key event's modifier snapshot. After a safe blur
   * clear the browser cannot enumerate held keys, but the next W keydown still arrives with
   * shiftKey=true; relying only on ShiftLeft/ShiftRight in `keys` discarded that information.
   */
  private shiftHeld = false;
  private stickX = 0;
  /** Mouse-button flight actions. See handleMouseButton for why these are not synthetic keys. */
  private mouseBoost = false;
  private mouseBrake = false;
  private stickY = 0;
  private mouseDx = 0;
  private mouseDy = 0;
  private locked = false;
  private throttle = 0.85;
  private readonly canvas: HTMLElement;
  private gamepadIndex: number | null = null;
  private disposed = false;

  onLockChange: ((locked: boolean) => void) | null = null;
  /**
   * Mouse capture was refused, with the reason if the browser gave one.
   *
   * The rejection used to be swallowed on the grounds that pointer lock "is never
   * load-bearing". That is true of the ship — keyboard and gamepad fly it — and false of the
   * player, who is left holding a mouse that does nothing with no indication why. It is also
   * how mouse flight went unexercised: four of eight reviewers could not judge the primary
   * control scheme because a silent failure looks exactly like a working one from outside.
   */
  onLockError: ((reason: string) => void) | null = null;
  /** Set once capture has been refused, so the interface can offer keyboard flight instead. */
  lockRefused = false;
  onAction: ((action: 'restart' | 'view' | 'match') => void) | null = null;

  constructor(canvas: HTMLElement) {
    this.canvas = canvas;
    window.addEventListener('keydown', this.handleKeyDown, { passive: false });
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
    document.addEventListener('pointerlockerror', this.handlePointerLockError);
    document.addEventListener('mousemove', this.handleMouseMove);
    document.addEventListener('mousedown', this.handleMouseButton);
    document.addEventListener('mouseup', this.handleMouseButton);
    window.addEventListener('gamepadconnected', this.handleGamepad);
    window.addEventListener('gamepaddisconnected', this.handleGamepadLost);
  }

  get pointerLocked(): boolean {
    return this.locked;
  }

  requestLock(): void {
    if (this.locked || this.disposed) return;
    if (!this.canvas.requestPointerLock) {
      this.reportLockError('this browser does not support mouse capture');
      return;
    }
    // Rejects in sandboxed frames, in headless drivers, when the document is not focused, and
    // when the browser applies its post-exit cooldown. Reported rather than swallowed.
    try {
      const result = this.canvas.requestPointerLock() as unknown;
      if (result instanceof Promise) {
        result.then(
          () => { this.lockRefused = false; },
          (err: unknown) => this.reportLockError(err instanceof Error ? err.message : 'mouse capture was refused'),
        );
      }
    } catch (err) {
      this.reportLockError(err instanceof Error ? err.message : 'mouse capture was refused');
    }
  }

  private reportLockError(reason: string): void {
    if (this.disposed) return;
    // One refusal, one report. Both the promise rejection and the `pointerlockerror` event fire for
    // a single rejected request, and both funnel here — measured at two log lines per refusal in
    // headless and headed Chromium. The event form exists for browsers that do not return a
    // promise, so neither path can simply be removed; the duplicate is suppressed instead.
    if (this.lockRefused) return;
    this.lockRefused = true;
    this.onLockError?.(reason);
  }

  private readonly handlePointerLockError = (): void => {
    // Older browsers signal failure only through this event; the promise form is newer.
    this.reportLockError('mouse capture was refused by the browser');
  };

  releaseLock(): void {
    if (!this.locked) return;
    document.exitPointerLock?.();
  }

  setOverride(input: HarnessInput | null): void {
    this.override = input;
    if (input === null) return;
    this.stickX = 0;
    this.stickY = 0;
  }

  /** Recentres the virtual stick; used when a run starts so leftover deflection is dropped. */
  reset(): void {
    this.stickX = 0;
    this.stickY = 0;
    this.mouseDx = 0;
    this.mouseDy = 0;
    this.mouseBoost = false;
    this.mouseBrake = false;
    /* Quarantine non-modifier menu input at the run boundary. W/S also navigate the interface,
       so an OS repeat from the same physical press must not silently preload the countdown. Shift
       is reconstructed separately from modifier snapshots on subsequent events. */
    for (const code of this.keys) {
      if (!isShiftCode(code)) this.suppressedUntilKeyUp.add(code);
    }
    this.keys.clear();
    this.shiftHeld = false;
    this.throttle = 0.85;
  }

  update(dt: number): FlightCommand {
    const c = this.command;

    if (this.override) {
      const o = this.override;
      c.pitch = clamp(o.pitch ?? 0, -1, 1);
      c.yaw = clamp(o.yaw ?? 0, -1, 1);
      c.roll = clamp(o.roll ?? 0, -1, 1);
      c.throttle = clamp01(o.throttle ?? 1);
      c.strafeX = clamp(o.strafeX ?? 0, -1, 1);
      c.strafeY = clamp(o.strafeY ?? 0, -1, 1);
      c.boost = o.boost ?? false;
      c.brake = o.brake ?? false;
      c.stickX = c.yaw;
      c.stickY = -c.pitch;
      return c;
    }

    // --- virtual stick -------------------------------------------------------------
    // Mouse deltas push the stick; it eases back to centre so the ship settles when the
    // hand stops. The recentre is slow enough that sustained turns feel supported.
    const gain = 0.0042 * this.sensitivity;
    this.stickX = clamp(this.stickX + this.mouseDx * gain, -1, 1);
    this.stickY = clamp(this.stickY + this.mouseDy * gain, -1, 1);
    const recentre = Math.exp(-dt / 0.24);
    this.stickX *= recentre;
    this.stickY *= recentre;
    c.stickX = this.stickX;
    c.stickY = this.stickY;
    this.mouseDx = 0;
    this.mouseDy = 0;

    // Positive pitch is nose-up, and the mouse produces that from `expo(-stickY)`. The
    // arrow keys had the sign the other way round, so the two pitch inputs disagreed and
    // invertY flipped both together, making it impossible to reconcile in settings.
    const keyPitch = (this.held('up') ? 1 : 0) - (this.held('down') ? 1 : 0);
    const keyYaw = (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);

    let pitch = expo(-this.stickY, 0.45) + keyPitch * 0.85;
    let yaw = expo(this.stickX, 0.45) + keyYaw * 0.85;
    let roll = (this.held('KeyD') ? 1 : 0) - (this.held('KeyA') ? 1 : 0);
    let strafeX = (this.held('KeyE') ? 1 : 0) - (this.held('KeyQ') ? 1 : 0);
    let strafeY = (this.held('KeyR') ? 1 : 0) - (this.held('KeyF') ? 1 : 0);

    // --- throttle ------------------------------------------------------------------
    const throttleRate = 1.35;
    if (this.held('KeyW')) this.throttle += throttleRate * dt;
    if (this.held('KeyS')) this.throttle -= throttleRate * dt;
    this.throttle = clamp01(this.throttle);

    let boost = this.shiftHeld || this.held('ShiftLeft') || this.held('ShiftRight') || this.mouseBoost;
    let brake = this.held('Space') || this.mouseBrake;

    // --- gamepad -------------------------------------------------------------------
    const pad = this.readGamepad();
    if (pad) {
      const ax = (i: number) => deadzone(pad.axes[i] ?? 0, 0.14);
      yaw += expo(ax(0), 0.4);
      pitch += expo(-ax(1), 0.4);
      roll += ax(2) * 0.9;
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      if (rt > 0.02 || lt > 0.02) this.throttle = clamp01(rt - lt * 0.5 + 0.5 * (1 - lt));
      boost = boost || (pad.buttons[0]?.pressed ?? false);
      brake = brake || (pad.buttons[1]?.pressed ?? false);
      strafeX += (pad.buttons[15]?.value ?? 0) - (pad.buttons[14]?.value ?? 0);
      strafeY += (pad.buttons[12]?.value ?? 0) - (pad.buttons[13]?.value ?? 0);
    }

    c.pitch = clamp(this.invertY ? -pitch : pitch, -1, 1);
    c.yaw = clamp(yaw, -1, 1);
    c.roll = clamp(roll, -1, 1);
    c.strafeX = clamp(strafeX, -1, 1);
    c.strafeY = clamp(strafeY, -1, 1);
    c.throttle = this.throttle;
    c.boost = boost;
    c.brake = brake;
    return c;
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
    document.removeEventListener('pointerlockerror', this.handlePointerLockError);
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('mousedown', this.handleMouseButton);
    document.removeEventListener('mouseup', this.handleMouseButton);
    window.removeEventListener('gamepadconnected', this.handleGamepad);
    window.removeEventListener('gamepaddisconnected', this.handleGamepadLost);
  }

  private held(code: string): boolean {
    return this.keys.has(code);
  }

  private readGamepad(): Gamepad | null {
    if (this.gamepadIndex === null || !navigator.getGamepads) return null;
    return navigator.getGamepads()[this.gamepadIndex] ?? null;
  }

  private readonly handleKeyDown = (e: KeyboardEvent): void => {
    const code = KEY_ALIASES[e.code] ?? e.code;
    const suppressed = this.suppressedUntilKeyUp.has(code);
    /* A repeat from a pre-boundary menu press stays quarantined. Conversely, a non-repeat is
       proof of a fresh press even if its earlier keyup was lost outside the window, so it safely
       retires stale suppression and restores the key without requiring an extra press. */
    if (suppressed && !e.repeat) this.suppressedUntilKeyUp.delete(code);
    if (!suppressed || !e.repeat) this.keys.add(code);
    this.shiftHeld = e.shiftKey || this.held('ShiftLeft') || this.held('ShiftRight');
    if (e.code === 'Space') e.preventDefault();
    if (e.code === 'Tab' && this.locked) e.preventDefault();
    if (e.repeat) {
      return;
    }
    // Escape is deliberately NOT handled here. The interface layer owns pause; two owners
    // means two flags, and two flags means the timer can run behind a PAUSED screen.
    if (e.code === 'KeyT') this.onAction?.('match');
    if (e.code === 'KeyV') this.onAction?.('view');
    if (e.code === 'KeyN') this.onAction?.('restart');
    // Tab is only ours while the ship is being flown. Swallowing it unconditionally, on a window
    // listener, combined with the interface layer correctly letting its range widgets own their
    // own keys, left Tab and Shift+Tab dead on all five settings sliders — 5 of 13 settings rows
    // trapped keyboard focus. Neither half was wrong alone; this is the second time in this
    // project that two independently correct changes have combined into a defect.
  };

  private readonly handleKeyUp = (e: KeyboardEvent): void => {
    const code = KEY_ALIASES[e.code] ?? e.code;
    this.keys.delete(code);
    this.suppressedUntilKeyUp.delete(code);
    /* Chromium automation can report shiftKey=false when one Shift is released even though the
       other Shift code remains down. Keep both sources: the modifier snapshot repairs state after
       blur, while the code Set preserves a separately observed left/right Shift transition. */
    this.shiftHeld = e.shiftKey || this.held('ShiftLeft') || this.held('ShiftRight');
  };

  private readonly handleBlur = (): void => {
    for (const code of this.keys) {
      if (!isShiftCode(code)) this.suppressedUntilKeyUp.add(code);
    }
    this.keys.clear();
    this.shiftHeld = false;
    this.mouseDx = 0;
    this.mouseDy = 0;
  };

  private readonly handlePointerLockChange = (): void => {
    const locked = document.pointerLockElement === this.canvas;
    if (locked === this.locked) return;
    this.locked = locked;
    if (locked) this.lockRefused = false;
    if (!locked) {
      this.mouseDx = 0;
      this.mouseDy = 0;
      /* The half of the latch fix that handleMouseButton cannot do for itself: the mouseup that
         follows a lock loss is dropped by its guard, so the release has to happen HERE, on the
         transition. A physically held keyboard boost is untouched — these are mouse-only state. */
      this.mouseBoost = false;
      this.mouseBrake = false;
    }
    this.onLockChange?.(locked);
  };

  private readonly handleMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    // Clamp per-event deltas: a dropped frame can deliver a huge accumulated movement.
    this.mouseDx += clamp(e.movementX, -180, 180);
    this.mouseDy += clamp(e.movementY, -180, 180);
  };

  /**
   * Dedicated booleans, NOT synthetic key injection. The first version pushed 'ShiftLeft'/'Space'
   * into the shared `keys` set, and the early-return above dropped the mouseup that arrives after
   * pointer lock is lost — Escape, the game's own pause gesture — so the code was never cleared:
   * hold boost, Esc to the menu, release, resume, and the ship boosts at full command
   * indefinitely with nothing held (measured 454.8 -> 774.2 m/s uncommanded). Three independent
   * reproductions, and it also arms during the countdown, so a first-run player was exposed.
   *
   * Two properties of this shape, both load-bearing:
   * - the booleans are CLEARED in handlePointerLockChange when the lock drops, so losing the lock
   *   mid-hold cannot latch anything;
   * - they are separate state OR'd into the command in update(), so clearing them cannot delete a
   *   physically held keyboard ShiftLeft. The obvious alternative — processing mouseup even when
   *   unlocked — was attacked and rejected in review for exactly that: releasing LMB over a menu
   *   would silently release a keyboard boost the player is still holding.
   */
  private readonly handleMouseButton = (e: MouseEvent): void => {
    if (!this.locked) return;
    const down = e.type === 'mousedown';
    if (e.button === 0) this.mouseBoost = down;
    if (e.button === 2) this.mouseBrake = down;
  };

  private readonly handleGamepad = (e: GamepadEvent): void => {
    this.gamepadIndex = e.gamepad.index;
  };

  private readonly handleGamepadLost = (e: GamepadEvent): void => {
    if (this.gamepadIndex === e.gamepad.index) this.gamepadIndex = null;
  };
}
