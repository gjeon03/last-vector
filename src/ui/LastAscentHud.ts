import type { Telemetry } from '../core/contracts.ts';
import {
  lastAscentPressureStage,
  type EscapePressureStage,
} from '../game/missions/LastAscentPressure.ts';
import type { Translator } from '../i18n/index.ts';
import type { Messages } from '../i18n/messages.ts';

function node(tag: string, className: string, text = ''): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

/** Escape-only HUD strip. It remains detached from gate-race semantics and hides exhaustively. */
export class LastAscentHud {
  readonly element: HTMLElement;

  private readonly messages: Messages;
  private readonly act: HTMLElement;
  private readonly separation: HTMLElement;
  private readonly corridors: HTMLElement;
  private readonly pressure: HTMLElement;
  private readonly shipFill: HTMLElement;
  private readonly frontFill: HTMLElement;
  private previousAct = '';
  private previousSeparation = -1;
  private previousCheckpoint = -1;
  private previousPressure: EscapePressureStage = 'nominal';

  constructor(translator: Translator) {
    this.messages = translator.messages;
    const messages = this.messages;
    this.element = node('section', 'lv-escape-hud');
    this.element.hidden = true;
    this.element.lang = translator.locale;
    this.element.setAttribute('role', 'status');

    this.act = node('div', 'lv-escape-act', messages.hud.ascentAct);
    this.act.lang = 'en';
    const separationLabel = node('span', 'lv-escape-k', messages.hud.separation);
    separationLabel.lang = 'en';
    this.separation = node('strong', 'lv-escape-v', '+0.0 KM');
    this.separation.lang = 'en';
    const separationRow = node('div', 'lv-escape-row');
    separationRow.append(separationLabel, this.separation);

    const corridorsLabel = node('span', 'lv-escape-k', messages.hud.safeCorridors);
    corridorsLabel.lang = 'en';
    this.corridors = node('strong', 'lv-escape-v', '0 / 3');
    this.corridors.lang = 'en';
    const corridorRow = node('div', 'lv-escape-row');
    corridorRow.append(corridorsLabel, this.corridors);

    const race = node('div', 'lv-escape-race');
    const front = node('div', 'lv-escape-front');
    this.frontFill = node('i', 'lv-escape-front-fill');
    front.appendChild(this.frontFill);
    const ship = node('div', 'lv-escape-ship');
    this.shipFill = node('i', 'lv-escape-ship-fill');
    ship.appendChild(this.shipFill);
    race.append(front, ship);
    this.pressure = node('div', 'lv-escape-pressure');
    this.pressure.lang = 'en';
    this.pressure.hidden = true;
    this.element.dataset.pressure = 'nominal';
    this.element.append(this.act, separationRow, corridorRow, race, this.pressure);
  }

  update(telemetry: Telemetry): void {
    const objective = telemetry.objective;
    const active = objective.kind === 'escape';
    this.element.hidden = !active;
    if (!active) return;

    const act = objective.pathProgress < 0.27
      ? this.messages.hud.ascentAct
      : objective.pathProgress < 0.76
        ? this.messages.hud.debrisAct
        : this.messages.hud.escapeAct;
    if (act !== this.previousAct) {
      this.previousAct = act;
      this.act.textContent = act;
    }

    const separationMetres = Math.max(
      0,
      (objective.pathProgress - objective.shockwaveProgress) * telemetry.courseTotal,
    );
    const separationBucket = Math.round(separationMetres / 100);
    if (separationBucket !== this.previousSeparation) {
      this.previousSeparation = separationBucket;
      this.separation.textContent = `+${(separationBucket / 10).toFixed(1)} KM`;
    }
    if (objective.checkpoint !== this.previousCheckpoint) {
      this.previousCheckpoint = objective.checkpoint;
      this.corridors.textContent = `${objective.checkpoint} / ${objective.checkpointTotal}`;
    }
    const pressure = lastAscentPressureStage(objective, this.previousPressure);
    if (pressure !== this.previousPressure) {
      this.previousPressure = pressure;
      this.element.dataset.pressure = pressure;
      this.pressure.hidden = pressure === 'nominal';
      this.pressure.textContent = pressure === 'critical'
        ? this.messages.hud.shockfrontCritical
        : pressure === 'warning'
          ? this.messages.hud.shockfrontClosing
          : '';
    }
    const ship = Math.min(1, Math.max(0, objective.pathProgress));
    const front = Math.min(1, Math.max(0, objective.shockwaveProgress));
    this.shipFill.style.transform = `scaleX(${ship.toFixed(4)})`;
    this.frontFill.style.transform = `scaleX(${front.toFixed(4)})`;
    this.element.setAttribute(
      'aria-label',
      this.messages.hud.escapeStatus(
        separationMetres,
        objective.checkpoint,
        objective.checkpointTotal,
      ),
    );
  }
}
