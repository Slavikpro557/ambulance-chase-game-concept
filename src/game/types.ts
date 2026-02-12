import type { SpatialGrid } from './spatial';

export interface Vec2 { x: number; y: number; }

export interface Entity extends Vec2 {
  vx: number; vy: number; angle: number;
}

export type Weather = 'clear' | 'rain' | 'night' | 'fog';
export type MissionType = 'chase' | 'deliver' | 'multi' | 'boss';
export type GameScreen = 'menu' | 'modeSelect' | 'briefing' | 'playing' | 'paused' | 'saved' | 'failed' | 'upgrade' | 'ending' | 'multiplayerMenu' | 'lobby';
export type GameMode = 'ambulance' | 'runner' | 'extremal' | 'coopRescue' | 'copsAndRobbers' | 'demolitionDerby' | 'patientRace';
export type MultiplayerMode = 'coopRescue' | 'copsAndRobbers' | 'demolitionDerby' | 'patientRace';
export type NetRole = 'host' | 'guest';
export type LobbyScreen = 'hostWaiting' | 'guestEnterCode' | 'connected' | 'modeSelect';

export interface PatientStory {
  name: string; age: number; condition: string; emoji: string;
  dialogue: string[]; savedText: string; failedText: string;
  color: string; speed: number; erratic: number;
}

export interface Mission {
  id: number; title: string; description: string; type: MissionType;
  patients: PatientStory[]; weather: Weather; timeLimit: number;
  citySize: number; trafficDensity: number; difficulty: number;
}

export interface Patient extends Entity {
  story: PatientStory; health: number; caught: boolean;
  dialogueTimer: number; currentDialogue: string;
  panicLevel: number; stunTimer: number;
}

export interface TrafficCar extends Entity {
  color: string; width: number; height: number;
  lane: number; honkTimer: number;
}

export interface Building {
  x: number; y: number; w: number; h: number;
  color: string; type: 'house' | 'hospital' | 'shop' | 'park' | 'office';
  windows: number;
}

export interface PowerUp {
  x: number; y: number;
  type: 'nitro' | 'medkit' | 'megaphone' | 'coffee' | 'energy' | 'smokebomb' | 'shortcut';
  collected: boolean;
}

// === EXTREMAL MODE ===
export type HazardType = 'fire' | 'electricity' | 'manhole' | 'construction' | 'toxic';

export interface Hazard {
  x: number; y: number;
  type: HazardType;
  active: boolean;
  neutralizeTimer: number;
  cooldown: number;
  dps: number;
  radius: number;
  burstDamage: number;
}

export interface Barrier {
  x: number; y: number;
  w: number; h: number;
  life: number;
}

export interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; maxLife: number; color: string;
  size: number; type: 'spark' | 'smoke' | 'rain' | 'heart' | 'star' | 'text';
  text?: string;
}

export interface Ambulance extends Entity {
  health: number; nitroTimer: number; megaphoneTimer: number;
  coffeeTimer: number; speed: number; maxSpeed: number;
  acceleration: number; handling: number; sirenOn: boolean;
}

export interface RunnerPlayer extends Entity {
  stamina: number; maxStamina: number; sprinting: boolean; speed: number;
  smokeBombTimer: number; invisibleTimer: number; speedBoostTimer: number;
  dialogueTimer: number; currentDialogue: string; caughtTimer: number;
  playerHealth: number;
  maxPlayerHealth: number;
  interactingHazard: boolean;
  dashCooldown: number;
}

export interface Upgrades {
  engine: number; tires: number; siren: number; armor: number;
}

export interface SaveData {
  version: number;
  gameMode: GameMode;
  missionIndex: number;
  score: number;
  money: number;
  upgrades: Upgrades;
  totalSaved: number;
  totalFailed: number;
  reputation: number;
  runnerLevel: number;
  runnerScore: number;
  tutorialShown: boolean;
}

export type DynamicEventType =
  | 'trafficJam' | 'roadBlock' | 'patientSprint' | 'policeChase'
  | 'earthquake' | 'blackout' | 'breakdown';

export interface DynamicEvent {
  type: DynamicEventType;
  timer: number;
  x: number; y: number;
  data?: any;
}

export interface GameState {
  screen: GameScreen;
  gameMode: GameMode;

  ambulance: Ambulance;
  patients: Patient[];
  trafficCars: TrafficCar[];
  buildings: Building[];
  buildingGrid: SpatialGrid | null;
  powerUps: PowerUp[];
  particles: Particle[];

  // Runner mode
  runner: RunnerPlayer | null;
  aiAmbulance: Ambulance | null;
  surviveTime: number;
  surviveTarget: number;
  runnerScore: number;
  runnerLevel: number;

  // Extremal mode
  hazards: Hazard[];
  barriers: Barrier[];
  aiBarrierCooldown: number;
  aiNeutralizeCooldown: number;
  aiBackupTimer: number;
  backupAmbulances: Ambulance[];

  mission: Mission | null;
  missionIndex: number;

  score: number;
  totalSaved: number;
  totalFailed: number;
  reputation: number;
  money: number;
  upgrades: Upgrades;

  timeLeft: number;
  cameraX: number; cameraY: number; cameraShake: number;
  currentDialogue: string; dialogueTimer: number;
  weather: Weather; dayTime: number;
  comboCount: number; comboTimer: number;
  patientsCaughtThisMission: number; patientsNeeded: number;
  flashMessages: { text: string; timer: number; color: string }[];
  hospitalX: number; hospitalY: number;

  keys: Keys;
  time: number;
  collisionCooldown: number;

  aiStuckTimer: number; aiAvoidAngle: number;
  aiLastX: number; aiLastY: number;

  // UI state
  transitionAlpha: number;
  tutorialShown: boolean;

  // Audio events (consumed by App.tsx each frame)
  audioEvents: string[];

  // Dynamic events system
  activeEvent: DynamicEvent | null;
  eventCooldown: number;

  // Near-miss combo
  nearMissCombo: number;
  nearMissTimer: number;

  // Drift mechanic
  driftTimer: number;
  isDrifting: boolean;

  // Multiplayer (undefined = solo mode)
  mp?: MultiplayerState;
}

export interface Keys {
  up: boolean; down: boolean; left: boolean; right: boolean;
  space: boolean; honk: boolean;
}

// === MULTIPLAYER ===

export interface NetPlayer {
  id: 0 | 1;
  role: NetRole;
  name: string;
  keys: Keys;
}

export interface SnapshotEntity {
  x: number; y: number; vx: number; vy: number; angle: number;
  health: number; speed: number; nitroTimer: number;
}

export interface SnapshotRunner {
  x: number; y: number; vx: number; vy: number; angle: number;
  speed: number; stamina: number; playerHealth: number;
  invisibleTimer: number; speedBoostTimer: number; caughtTimer: number;
}

export interface SnapshotPatient {
  x: number; y: number; vx: number; vy: number; caught: boolean; caughtBy?: 0 | 1;
  health: number; panicLevel: number; stunTimer: number;
  storyIdx: number;
}

export interface SnapshotPowerUp {
  x: number; y: number; type: PowerUp['type']; collected: boolean;
}

export interface StateSnapshot {
  seq: number;
  ts: number;
  amb1: SnapshotEntity;
  amb2?: SnapshotEntity;
  runner1?: SnapshotRunner;
  patients: SnapshotPatient[];
  powerUps: SnapshotPowerUp[];
  trafficCars: { x: number; y: number; vx: number; vy: number; angle: number }[];
  timeLeft: number;
  scores: [number, number];
  screen: GameScreen;
  comboCount: number;
  comboTimer: number;
  cameraShake: number;
  audioEvents: string[];
  flashMessages: { text: string; timer: number; color: string }[];
  // Derby specific
  derbyRound?: number;
  derbyWins?: [number, number];
  // Dynamic gameplay
  activeEvent?: { type: string; timer: number; x: number; y: number } | null;
  nearMissCombo?: number;
  isDrifting?: boolean;
}

export interface MultiplayerState {
  isMultiplayer: boolean;
  netRole: NetRole;
  multiplayerMode: MultiplayerMode;
  lobbyScreen: LobbyScreen;
  localPlayer: NetPlayer;
  remotePlayer: NetPlayer;
  // Second ambulance (for coop, derby, race)
  ambulance2: Ambulance | null;
  // Second runner (for cops&robbers where P2 is runner)
  runner2: RunnerPlayer | null;
  scores: [number, number];
  roomCode: string;
  inputCode: string; // guest typing room code on canvas
  inputError: string; // error message for guest
  ping: number;
  connected: boolean;
  // Snapshot interpolation (guest only)
  prevSnapshot: StateSnapshot | null;
  currSnapshot: StateSnapshot | null;
  interpolationT: number;
  snapshotTime: number;
  // Derby
  derbyRound: number;
  derbyWins: [number, number];
  // Disconnect
  disconnected: boolean;
  disconnectTimer: number;
  // Round end auto-return to lobby
  roundEndTime: number;
  // Rematch
  rematchRequested: boolean;
  remoteRematchRequested: boolean;
  // Campaign progression (each player has own upgrades/money)
  guestUpgrades: Upgrades;
  guestMoney: number;
  hostReady: boolean;
  guestReady: boolean;
}

export interface FullSyncPayload {
  buildings: Building[];
  mission: Mission | null;
  missionIndex: number;
  citySize: number;
  weather: Weather;
  patients: Patient[];
  powerUps: PowerUp[];
  trafficCars: TrafficCar[];
  hazards: Hazard[];
  barriers: Barrier[];
  hospitalX: number;
  hospitalY: number;
  multiplayerMode: MultiplayerMode;
  scores: [number, number];
  amb1: Ambulance;
  amb2?: Ambulance;
  runner1?: RunnerPlayer;
}
