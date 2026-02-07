// Multiplayer state sync: serialization, deserialization, interpolation
import type {
  Keys, GameState, StateSnapshot, SnapshotEntity, SnapshotRunner,
  SnapshotPatient, SnapshotPowerUp, Ambulance, RunnerPlayer,
  Patient, PowerUp, FullSyncPayload, MultiplayerMode
} from './types';

// === KEY SERIALIZATION (1 byte) ===

export function serializeKeys(keys: Keys): number {
  return (
    (keys.up ? 1 : 0) |
    (keys.down ? 2 : 0) |
    (keys.left ? 4 : 0) |
    (keys.right ? 8 : 0) |
    (keys.space ? 16 : 0) |
    (keys.honk ? 32 : 0)
  );
}

export function deserializeKeys(byte: number): Keys {
  return {
    up: !!(byte & 1),
    down: !!(byte & 2),
    left: !!(byte & 4),
    right: !!(byte & 8),
    space: !!(byte & 16),
    honk: !!(byte & 32),
  };
}

// === SNAPSHOT CREATION ===

function snapEntity(e: Ambulance): SnapshotEntity {
  return {
    x: e.x, y: e.y, vx: e.vx, vy: e.vy, angle: e.angle,
    health: e.health, speed: e.speed, nitroTimer: e.nitroTimer,
  };
}

function snapRunner(r: RunnerPlayer): SnapshotRunner {
  return {
    x: r.x, y: r.y, vx: r.vx, vy: r.vy, angle: r.angle,
    speed: r.speed, stamina: r.stamina, playerHealth: r.playerHealth,
    invisibleTimer: r.invisibleTimer, speedBoostTimer: r.speedBoostTimer,
    caughtTimer: r.caughtTimer,
  };
}

function snapPatient(p: Patient, patients: Patient[]): SnapshotPatient {
  return {
    x: p.x, y: p.y, vx: p.vx, vy: p.vy, caught: p.caught,
    health: p.health, panicLevel: p.panicLevel, stunTimer: p.stunTimer,
    storyIdx: patients.indexOf(p),
  };
}

function snapPowerUp(pu: PowerUp): SnapshotPowerUp {
  return { x: pu.x, y: pu.y, type: pu.type, collected: pu.collected };
}

let snapshotSeq = 0;

export function createSnapshot(state: GameState): StateSnapshot {
  const mp = state.mp;
  const snap: StateSnapshot = {
    seq: snapshotSeq++,
    ts: performance.now(),
    amb1: snapEntity(state.ambulance),
    patients: state.patients.map(p => snapPatient(p, state.patients)),
    powerUps: state.powerUps.map(snapPowerUp),
    trafficCars: state.trafficCars.map(tc => ({
      x: tc.x, y: tc.y, vx: tc.vx, vy: tc.vy, angle: tc.angle,
    })),
    timeLeft: state.timeLeft,
    scores: mp?.scores ?? [state.score, 0],
    screen: state.screen,
    comboCount: state.comboCount,
    comboTimer: state.comboTimer,
    cameraShake: state.cameraShake,
    audioEvents: [...state.audioEvents],
    flashMessages: [...state.flashMessages],
  };

  // Second ambulance
  if (mp?.ambulance2) {
    snap.amb2 = snapEntity(mp.ambulance2);
  }

  // Runner (cops&robbers mode: P2 is runner)
  if (mp?.runner2) {
    snap.runner1 = snapRunner(mp.runner2);
  } else if (state.runner) {
    snap.runner1 = snapRunner(state.runner);
  }

  // Derby
  if (mp) {
    snap.derbyRound = mp.derbyRound;
    snap.derbyWins = [...mp.derbyWins] as [number, number];
  }

  return snap;
}

// === SNAPSHOT JSON (reliable for now, optimize to binary later if needed) ===

export function serializeSnapshot(snap: StateSnapshot): string {
  return JSON.stringify(snap);
}

export function deserializeSnapshot(data: string): StateSnapshot {
  return JSON.parse(data) as StateSnapshot;
}

// === INTERPOLATION ===

function lerpNum(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpEntity(a: SnapshotEntity, b: SnapshotEntity, t: number): SnapshotEntity {
  return {
    x: lerpNum(a.x, b.x, t),
    y: lerpNum(a.y, b.y, t),
    vx: lerpNum(a.vx, b.vx, t),
    vy: lerpNum(a.vy, b.vy, t),
    angle: lerpAngle(a.angle, b.angle, t),
    health: b.health,
    speed: lerpNum(a.speed, b.speed, t),
    nitroTimer: b.nitroTimer,
  };
}

function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

function lerpRunner(a: SnapshotRunner, b: SnapshotRunner, t: number): SnapshotRunner {
  return {
    x: lerpNum(a.x, b.x, t),
    y: lerpNum(a.y, b.y, t),
    vx: lerpNum(a.vx, b.vx, t),
    vy: lerpNum(a.vy, b.vy, t),
    angle: lerpAngle(a.angle, b.angle, t),
    speed: lerpNum(a.speed, b.speed, t),
    stamina: lerpNum(a.stamina, b.stamina, t),
    playerHealth: b.playerHealth,
    invisibleTimer: b.invisibleTimer,
    speedBoostTimer: b.speedBoostTimer,
    caughtTimer: b.caughtTimer,
  };
}

export function interpolateSnapshots(
  prev: StateSnapshot,
  curr: StateSnapshot,
  t: number
): StateSnapshot {
  const clamped = Math.max(0, Math.min(1, t));
  const result: StateSnapshot = {
    seq: curr.seq,
    ts: lerpNum(prev.ts, curr.ts, clamped),
    amb1: lerpEntity(prev.amb1, curr.amb1, clamped),
    patients: curr.patients.map((cp, i) => {
      const pp = prev.patients[i];
      if (!pp || cp.caught) return cp;
      return {
        ...cp,
        x: lerpNum(pp.x, cp.x, clamped),
        y: lerpNum(pp.y, cp.y, clamped),
        vx: lerpNum(pp.vx, cp.vx, clamped),
        vy: lerpNum(pp.vy, cp.vy, clamped),
      };
    }),
    powerUps: curr.powerUps,
    trafficCars: curr.trafficCars.map((ct, i) => {
      const pt = prev.trafficCars[i];
      if (!pt) return ct;
      return {
        x: lerpNum(pt.x, ct.x, clamped),
        y: lerpNum(pt.y, ct.y, clamped),
        vx: lerpNum(pt.vx, ct.vx, clamped),
        vy: lerpNum(pt.vy, ct.vy, clamped),
        angle: lerpAngle(pt.angle, ct.angle, clamped),
      };
    }),
    timeLeft: lerpNum(prev.timeLeft, curr.timeLeft, clamped),
    scores: curr.scores,
    screen: curr.screen,
    comboCount: curr.comboCount,
    comboTimer: curr.comboTimer,
    cameraShake: lerpNum(prev.cameraShake, curr.cameraShake, clamped),
    audioEvents: curr.audioEvents,
    flashMessages: curr.flashMessages,
  };

  // Lerp second ambulance
  if (prev.amb2 && curr.amb2) {
    result.amb2 = lerpEntity(prev.amb2, curr.amb2, clamped);
  } else {
    result.amb2 = curr.amb2;
  }

  // Lerp runner
  if (prev.runner1 && curr.runner1) {
    result.runner1 = lerpRunner(prev.runner1, curr.runner1, clamped);
  } else {
    result.runner1 = curr.runner1;
  }

  result.derbyRound = curr.derbyRound;
  result.derbyWins = curr.derbyWins;

  return result;
}

// === FULL SYNC (at mission start — sent reliably) ===

export function createFullSyncPayload(state: GameState): FullSyncPayload {
  const mp = state.mp;
  const payload: FullSyncPayload = {
    buildings: state.buildings,
    mission: state.mission,
    missionIndex: state.missionIndex,
    citySize: state.mission?.citySize ?? 2000,
    weather: state.weather,
    patients: state.patients,
    powerUps: state.powerUps,
    trafficCars: state.trafficCars,
    hazards: state.hazards,
    barriers: state.barriers,
    hospitalX: state.hospitalX,
    hospitalY: state.hospitalY,
    multiplayerMode: mp?.multiplayerMode ?? 'coopRescue',
    scores: mp?.scores ?? [0, 0],
    amb1: state.ambulance,
  };
  if (mp?.ambulance2) payload.amb2 = mp.ambulance2;
  if (mp?.runner2) payload.runner1 = mp.runner2;
  else if (state.runner) payload.runner1 = state.runner;
  return payload;
}

// Apply snapshot to a shadow GameState for the guest to render
export function applySnapshotToState(
  state: GameState,
  snap: StateSnapshot,
): GameState {
  const s = { ...state };

  // Ambulance 1
  s.ambulance = {
    ...s.ambulance,
    x: snap.amb1.x, y: snap.amb1.y,
    vx: snap.amb1.vx, vy: snap.amb1.vy,
    angle: snap.amb1.angle,
    health: snap.amb1.health,
    speed: snap.amb1.speed,
    nitroTimer: snap.amb1.nitroTimer,
  };

  // Ambulance 2
  if (snap.amb2 && s.mp) {
    s.mp = {
      ...s.mp,
      ambulance2: s.mp.ambulance2 ? {
        ...s.mp.ambulance2,
        x: snap.amb2.x, y: snap.amb2.y,
        vx: snap.amb2.vx, vy: snap.amb2.vy,
        angle: snap.amb2.angle,
        health: snap.amb2.health,
        speed: snap.amb2.speed,
        nitroTimer: snap.amb2.nitroTimer,
      } : null,
    };
  }

  // Runner
  if (snap.runner1 && s.mp) {
    const r = s.runner ?? s.mp.runner2;
    if (r) {
      const updatedRunner = {
        ...r,
        x: snap.runner1.x, y: snap.runner1.y,
        vx: snap.runner1.vx, vy: snap.runner1.vy,
        angle: snap.runner1.angle,
        speed: snap.runner1.speed,
        stamina: snap.runner1.stamina,
        playerHealth: snap.runner1.playerHealth,
        invisibleTimer: snap.runner1.invisibleTimer,
        speedBoostTimer: snap.runner1.speedBoostTimer,
        caughtTimer: snap.runner1.caughtTimer,
      };
      if (s.runner) s.runner = updatedRunner;
      if (s.mp.runner2) s.mp = { ...s.mp, runner2: updatedRunner };
    }
  }

  // Patients — update positions
  s.patients = s.patients.map((p, i) => {
    const sp = snap.patients[i];
    if (!sp) return p;
    return { ...p, x: sp.x, y: sp.y, vx: sp.vx, vy: sp.vy, caught: sp.caught, health: sp.health, panicLevel: sp.panicLevel, stunTimer: sp.stunTimer };
  });

  // PowerUps
  s.powerUps = s.powerUps.map((pu, i) => {
    const sp = snap.powerUps[i];
    if (!sp) return pu;
    return { ...pu, collected: sp.collected };
  });

  // Traffic cars
  s.trafficCars = s.trafficCars.map((tc, i) => {
    const st = snap.trafficCars[i];
    if (!st) return tc;
    return { ...tc, x: st.x, y: st.y, vx: st.vx, vy: st.vy, angle: st.angle };
  });

  s.timeLeft = snap.timeLeft;
  s.score = snap.scores[0];
  if (s.mp) s.mp = { ...s.mp, scores: snap.scores };
  s.screen = snap.screen;
  s.comboCount = snap.comboCount;
  s.comboTimer = snap.comboTimer;
  s.cameraShake = snap.cameraShake;
  s.audioEvents = snap.audioEvents;
  s.flashMessages = snap.flashMessages;

  // Derby
  if (snap.derbyRound !== undefined && s.mp) {
    s.mp = { ...s.mp, derbyRound: snap.derbyRound, derbyWins: snap.derbyWins ?? [0, 0] };
  }

  // Guest camera: follow own entity (P2)
  if (s.mp?.netRole === 'guest') {
    let followX = s.ambulance.x, followY = s.ambulance.y;
    if (s.mp.ambulance2) {
      followX = s.mp.ambulance2.x; followY = s.mp.ambulance2.y;
    } else if (s.mp.runner2) {
      followX = s.mp.runner2.x; followY = s.mp.runner2.y;
    }
    s.cameraX += (followX - s.cameraX) * 0.08;
    s.cameraY += (followY - s.cameraY) * 0.08;
  }

  return s;
}

// Guest applies full sync payload at game start
export function applyFullSyncPayload(
  state: GameState,
  payload: FullSyncPayload,
  multiplayerMode: MultiplayerMode,
): GameState {
  return {
    ...state,
    buildings: payload.buildings,
    buildingGrid: null, // will be rebuilt
    mission: payload.mission,
    missionIndex: payload.missionIndex,
    weather: payload.weather,
    patients: payload.patients,
    powerUps: payload.powerUps,
    trafficCars: payload.trafficCars,
    hazards: payload.hazards,
    barriers: payload.barriers,
    hospitalX: payload.hospitalX,
    hospitalY: payload.hospitalY,
    ambulance: payload.amb1,
    screen: 'playing',
    gameMode: multiplayerMode,
    mp: state.mp ? {
      ...state.mp,
      multiplayerMode,
      ambulance2: payload.amb2 ?? null,
      runner2: payload.runner1 as any ?? null,
      scores: payload.scores,
    } : undefined,
  };
}
