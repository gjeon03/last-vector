import type {
  CalloutSubMessage,
  CalloutTitleMessage,
  GateNameMessage,
  LogMessage,
} from '../core/contracts.ts';
import type { Messages } from './messages.ts';

export type DomainMessage = GateNameMessage | CalloutTitleMessage | CalloutSubMessage | LogMessage;

export function renderDomainMessage(messages: Messages, message: DomainMessage): string {
  switch (message.type) {
    case 'gate-name.terminus-approach':
      return messages.events.terminusApproach;
    case 'gate-name.nadir-approach':
      return messages.events.nadirApproach;
    case 'callout-title.pointer-lock-unavailable':
      return messages.events.pointerLockUnavailable;
    case 'callout-title.camera-view':
      if (message.mode === 'cockpit') return messages.events.cockpitView;
      if (message.mode === 'far-chase') return messages.events.farChaseView;
      return messages.events.chaseView;
    case 'callout-title.engage':
      return messages.events.engage;
    case 'callout-title.hull-impact':
      return messages.events.hullImpact;
    case 'callout-title.boost-depleted':
      return messages.events.boostDepletedTitle;
    case 'callout-title.gate-cleared':
      if (message.accuracy === 'dead-centre') return messages.events.gateDeadCentre;
      if (message.accuracy === 'clean') return messages.events.gateClean;
      return messages.events.gateCleared;
    case 'callout-title.gate-missed':
      return message.blockedBy === 'shear'
        ? messages.events.gateShearBlocked
        : messages.events.gateMissed;
    case 'callout-sub.keyboard-flight-available':
      return messages.events.keyboardFlightAvailable;
    case 'callout-sub.camera-active':
      if (message.mode === 'cockpit') return messages.events.pilotCameraActive;
      if (message.mode === 'far-chase') return messages.events.distantExteriorCameraActive;
      return messages.events.exteriorCameraActive;
    case 'callout-sub.boost-recharging':
      return messages.events.boostRechargingSub;
    case 'callout-sub.gate-progress':
      if (message.courseId) {
        return messages.campaign.routes[message.courseId].gateProgress(message.remaining);
      }
      return messages.events.gateProgress(message.remaining);
    case 'callout-sub.gate-realign':
      return messages.events.gateRealign;
    case 'callout-sub.gate-shear-window':
      return messages.events.gateShearWindow;
    case 'log.pointer-lock-refused':
      return messages.events.pointerLockRefused(message.reason);
    case 'log.hull-contact':
      return messages.events.hullContact(message.percent);
    case 'log.boost-depleted':
      return messages.events.boostDepletedLog;
    case 'log.gate-cleared':
      if (message.courseId) {
        return messages.campaign.routes[message.courseId].gateClearedLog(message.gate, message.seconds);
      }
      return messages.events.gateClearedLog(message.gate, message.seconds);
    case 'log.gate-missed':
      if (message.courseId) {
        if (message.blockedBy === 'shear') {
          return messages.campaign.routes[message.courseId].gateShearBlockedLog(message.gate);
        }
        return messages.campaign.routes[message.courseId].gateMissedLog(message.gate);
      }
      return messages.events.gateMissedLog(message.gate);
    default:
      return unreachable(message);
  }
}

function unreachable(message: never): never {
  throw new Error(`Unknown domain message: ${JSON.stringify(message)}`);
}
