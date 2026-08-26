export interface MetaMessages {
  gameTitle: string;
  tagline: string;
  starName: string;
  shipName: string;
  sectorName: string;
  destinationName: string;
  documentTitle: string;
  documentDescription: string;
}

export interface LoaderMessages {
  initialising: string;
  chartingDrift: string;
  lightingCairns: string;
  spinningDrive: string;
  ready: string;
  webglRequiredTitle: string;
  webglRequiredDetail: string;
  launchFailedTitle: string;
  runtimeFailureTitle: string;
  runtimeFailureDetail: string;
  graphicsContextLostTitle: string;
  graphicsContextLostDetail: string;
}

export interface ScreenMessages {
  sector: string;
  beginRun: string;
  settings: string;
  controls: string;
  hullPrefix: string;
  primaryPrefix: string;
  navigationNominal: string;
  language: string;
  korean: string;
  english: string;
  runBriefing: string;
  transitTo: string;
  destination: string;
  markers: string;
  sources: string;
  required: string;
  corridor: string;
  primary: string;
  relay: string;
  hull: string;
  drift: string;
  field: string;
  closing: string;
  blackout: string;
  live: string;
  coreControls: string;
  briefingLine1: string;
  briefingLine2: string;
  briefingLine3: string;
  engage: string;
  back: string;
  launchSequence: string;
  go: string;
  vectorLive: string;
  flightHeld: string;
  paused: string;
  pauseDetail: string;
  resume: string;
  restart: string;
  abortRun: string;
  configuration: string;
}

/**
 * Every recognised course keeps localised telemetry copy, including dormant routes whose
 * historical facts remain readable. Player-facing stage selection is deliberately a smaller
 * active catalog owned by Courses.ts.
 */
export type CampaignMessageCourseId =
  | 'cairn-drift'
  | 'relay-harvest'
  | 'needle-grave'
  | 'wreckline'
  | 'ringfall';

export interface CampaignRouteMessages {
  /** Compact catalog label; canonical telemetry remains in the course definition. */
  name: string;
  /** Heading used by the title eyebrow and briefing. */
  sectorName: string;
  destination: string;
  terminalMarker: string;
  tagline: string;
  briefingLine1: string;
  briefingLine2: string;
  briefingLine3: string;
  gateProgress: (remaining: number) => string;
  gateClearedLog: (gate: number, seconds: number) => string;
  gateMissedLog: (gate: number) => string;
  gateShearBlockedLog: (gate: number) => string;
  radio1: string;
  radio2: string;
  radio3: string;
  radio4: string;
  radio5: string;
  lockReason: string;
  unlockNotice: string;
  objectives: {
    firstClear: string;
    highestRank: string;
    cleanClear: string;
    precision: string;
  };
}

export interface CampaignMessages {
  chapter: string;
  chapterName: string;
  stageSelection: string;
  stageObjectives: string;
  stage: string;
  locked: string;
  available: string;
  cleared: string;
  selected: string;
  complete: string;
  incomplete: string;
  nextObjective: string;
  noRank: string;
  nextStage: string;
  stageSelect: string;
  navigationFailed: string;
  storageUnavailable: string;
  routes: Record<CampaignMessageCourseId, CampaignRouteMessages>;
}

export interface ControlMessages {
  heading: string;
  or: string;
  mouse: string;
  flightKeys: string;
  mouseSteer: string;
  mouseSteerShort: string;
  throttle: string;
  roll: string;
  boost: string;
  brake: string;
  strafeHorizontal: string;
  strafeVertical: string;
  keyboardSteer: string;
  keyboardSteerShort: string;
  cameraToggle: string;
  cameraToggleShort: string;
  pause: string;
  restart: string;
  pointerLockNote: string;
}

export interface SettingMessages {
  sectionFlight: string;
  sectionDisplay: string;
  sectionImage: string;
  sectionAudio: string;
  flightAssist: string;
  flightAssistHint: string;
  defaultCamera: string;
  defaultCameraHint: string;
  mouseSensitivity: string;
  invertPitch: string;
  fieldOfView: string;
  fieldOfViewHint: string;
  cameraShake: string;
  quality: string;
  renderScale: string;
  renderScaleHint: string;
  frameCounter: string;
  motionBlur: string;
  filmGrain: string;
  chromaticAberration: string;
  masterVolume: string;
  music: string;
  arcade: string;
  standard: string;
  raw: string;
  chase: string;
  cockpit: string;
  farChase: string;
  low: string;
  medium: string;
  high: string;
  ultra: string;
  on: string;
  off: string;
}

export interface HudMessages {
  keyboardFlight: string;
  speed: string;
  throttle: string;
  hull: string;
  boost: string;
  sector: string;
  segment: string;
  elapsed: string;
  best: string;
  nextMarker: string;
  relayCharge: string;
  returnToRelay: string;
  cores: string;
  primaryCore: string;
  departure: string;
  charging: string;
  locked: string;
  metresUnit: string;
  kilometresUnit: string;
  speedUnit: string;
  gravityUnit: string;
  fps: string;
  terminus: string;
  boostCapacityTitle: string;
  meterPercent: (percent: number) => string;
  boostUsable: (seconds: number) => string;
  boostRecharging: (percent: number) => string;
  coreProgress: (collected: number, required: number) => string;
  chargeProgress: (charge: number, required: number) => string;
  coreStability: (seconds: number) => string;
  returnWindow: (seconds: number) => string;
}

export interface EventMessages {
  terminusApproach: string;
  nadirApproach: string;
  orisonApproach: string;
  pointerLockUnavailable: string;
  keyboardFlightAvailable: string;
  cockpitView: string;
  chaseView: string;
  farChaseView: string;
  pilotCameraActive: string;
  exteriorCameraActive: string;
  farExteriorCameraActive: string;
  engage: string;
  hullImpact: string;
  boostDepletedTitle: string;
  boostRechargingSub: string;
  boostDepletedLog: string;
  coreAcquired: (core: number) => string;
  relayChargeCallout: (charge: number, required: number) => string;
  coreAcquiredLog: (core: number, seconds: number) => string;
  gateDeadCentre: string;
  gateClean: string;
  gateCleared: string;
  gateMissed: string;
  gateRealign: string;
  gateShearBlocked: string;
  gateShearWindow: string;
  radio1: string;
  radio2: string;
  radio3: string;
  radio4: string;
  radio5: string;
  pointerLockRefused: (reason: string) => string;
  hullContact: (percent: number) => string;
  gateProgress: (remaining: number) => string;
  gateClearedLog: (gate: number, seconds: number) => string;
  gateMissedLog: (gate: number) => string;
}

export interface ResultMessages {
  arrivalConfirmed: string;
  runComplete: string;
  destination: string;
  rank: string;
  totalTime: string;
  newRecord: string;
  markers: string;
  marker: string;
  topSpeed: string;
  widestMarker: string;
  coresRecovered: string;
  relayCharge: string;
  hull: string;
  clean: string;
  damaged: string;
  segment: string;
  elapsed: string;
  versusBest: string;
  runAgain: string;
  newLayout: string;
  returnToTitle: string;
  missionFailed: string;
  hullBreach: string;
  time: string;
  retry: string;
  rankCodes: string;
  speedUnit: string;
  terminus: string;
  splitDelta: (delta: string) => string;
  bestComparison: (delta: string, best: string) => string;
  relayStabilised: string;
}

export interface CockpitMessages {
  attitude: string;
  vectorRange: string;
  shipSystems: string;
  energy: string;
  hull: string;
  throttle: string;
  retroBrake: string;
  hullWarning: string;
  proximityWarning: string;
  velocityUnit: string;
}

export interface A11yMessages {
  mainMenu: string;
  languageSelection: string;
  stageSelection: string;
  stageLocked: string;
  stageAvailable: string;
  stageCleared: string;
  stageSelected: string;
  runBriefing: string;
  launchCountdown: string;
  paused: string;
  settings: string;
  controls: string;
  runComplete: string;
  missionFailed: string;
  hullBreach: string;
}

export interface Messages {
  meta: MetaMessages;
  loader: LoaderMessages;
  screens: ScreenMessages;
  campaign: CampaignMessages;
  controls: ControlMessages;
  settings: SettingMessages;
  hud: HudMessages;
  events: EventMessages;
  results: ResultMessages;
  cockpit: CockpitMessages;
  a11y: A11yMessages;
}
