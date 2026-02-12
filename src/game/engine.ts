import { GameState, Patient, TrafficCar, Building, PowerUp, Particle, Ambulance, Upgrades, RunnerPlayer, GameMode, Hazard, Barrier, HazardType, SaveData, DynamicEvent, DynamicEventType } from './types';
import { MISSIONS } from './missions';
import { SpatialGrid } from './spatial';

const CATCH_DISTANCE = 50;
const ROAD_WIDTH = 100; // Consistent road width everywhere
const BLOCK_SIZE = 320;  // Bigger blocks = more space

function dist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function resolveRectCollision(
  ex: number, ey: number, ew: number, eh: number,
  bx: number, by: number, bw: number, bh: number
): { dx: number; dy: number; hit: boolean } {
  const ox1 = (ex + ew) - bx;
  const ox2 = (bx + bw) - ex;
  const oy1 = (ey + eh) - by;
  const oy2 = (by + bh) - ey;
  if (ox1 <= 0 || ox2 <= 0 || oy1 <= 0 || oy2 <= 0) return { dx: 0, dy: 0, hit: false };
  const mx = ox1 < ox2 ? -ox1 : ox2;
  const my = oy1 < oy2 ? -oy1 : oy2;
  if (Math.abs(mx) < Math.abs(my)) return { dx: mx, dy: 0, hit: true };
  return { dx: 0, dy: my, hit: true };
}

function isInsideBuilding(x: number, y: number, buildings: Building[], margin: number): boolean {
  for (const b of buildings) {
    if (x >= b.x - margin && x <= b.x + b.w + margin && y >= b.y - margin && y <= b.y + b.h + margin) return true;
  }
  return false;
}

function isInsideBarrier(x: number, y: number, barriers: Barrier[], margin: number): boolean {
  for (const b of barriers) {
    if (x >= b.x - margin && x <= b.x + b.w + margin && y >= b.y - margin && y <= b.y + b.h + margin) return true;
  }
  return false;
}

// Check if a path between two points is clear of buildings (used by AI navigation)
function isPathClear(x1: number, y1: number, x2: number, y2: number, buildings: Building[], margin: number): boolean {
  const steps = Math.ceil(dist(x1, y1, x2, y2) / 20);
  for (let i = 0; i <= steps; i++) {
    const t = i / Math.max(1, steps);
    const px = x1 + (x2 - x1) * t;
    const py = y1 + (y2 - y1) * t;
    if (isInsideBuilding(px, py, buildings, margin)) return false;
  }
  return true;
}
// isPathClear is used by navigateAI for line-of-sight checks

function createAmbulance(upgrades: Upgrades): Ambulance {
  return {
    x: 0, y: 0, vx: 0, vy: 0, angle: 0,
    health: 100 + upgrades.armor * 25,
    nitroTimer: 0, megaphoneTimer: 0, coffeeTimer: 0,
    speed: 0, maxSpeed: 5 + upgrades.engine * 1.2,
    acceleration: 0.4 + upgrades.engine * 0.1,
    handling: 0.92 + upgrades.tires * 0.015, sirenOn: true,
  };
}

function createRunner(x: number, y: number, isExtremal: boolean): RunnerPlayer {
  return {
    x, y, vx: 0, vy: 0, angle: 0,
    stamina: 100, maxStamina: 100, sprinting: false, speed: 0,
    smokeBombTimer: 0, invisibleTimer: 0, speedBoostTimer: 0,
    dialogueTimer: 60, currentDialogue: '', caughtTimer: 0,
    playerHealth: isExtremal ? 100 : 999,
    maxPlayerHealth: 100,
    interactingHazard: false,
    dashCooldown: 0,
  };
}

function createAIAmbulance(x: number, y: number, difficulty: number, isExtremal: boolean): Ambulance {
  const boost = isExtremal ? 0.3 : 0;
  return {
    x, y, vx: 0, vy: 0, angle: 0, health: 999,
    nitroTimer: 0, megaphoneTimer: 0, coffeeTimer: 0, speed: 0,
    maxSpeed: 3.5 + difficulty * 0.4 + boost,
    acceleration: 0.3 + difficulty * 0.05 + boost * 0.5,
    handling: 0.93, sirenOn: true,
  };
}

function findRoadPosition(citySize: number, buildings: Building[]): { x: number; y: number } {
  const bs = BLOCK_SIZE;
  const gridCount = Math.ceil(citySize / bs);
  // Try multiple strategies: road centers, intersections, random road spots
  for (let attempt = 0; attempt < 80; attempt++) {
    let x: number, y: number;
    if (attempt < 20) {
      // Strategy 1: On road center lines
      const ri = Math.floor(Math.random() * (gridCount + 1));
      const rc = ri * bs;
      if (Math.random() < 0.5) {
        x = 100 + Math.random() * (citySize - 200);
        y = rc;
      } else {
        x = rc;
        y = 100 + Math.random() * (citySize - 200);
      }
    } else if (attempt < 40) {
      // Strategy 2: Near intersections (safest open spots)
      const rx = Math.floor(Math.random() * (gridCount + 1));
      const ry = Math.floor(Math.random() * (gridCount + 1));
      x = rx * bs + (Math.random() - 0.5) * 40;
      y = ry * bs + (Math.random() - 0.5) * 40;
    } else {
      // Strategy 3: Random but check clearance
      x = 80 + Math.random() * (citySize - 160);
      y = 80 + Math.random() * (citySize - 160);
    }
    if (!isInsideBuilding(x, y, buildings, 30)) return { x, y };
  }
  // Fallback: center of map (always a road intersection)
  return { x: citySize / 2, y: citySize / 2 };
}

function rectsOverlap(ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number, gap: number): boolean {
  return ax < bx + bw + gap && ax + aw + gap > bx && ay < by + bh + gap && ay + ah + gap > by;
}

function generateBuildings(citySize: number): Building[] {
  const buildings: Building[] = [];
  const bs = BLOCK_SIZE;
  const rw = ROAD_WIDTH;
  const halfRw = rw / 2;
  const colors = ['#4a5568', '#2d3748', '#553c9a', '#744210', '#285e61', '#702459', '#1a365d'];
  const types: Building['type'][] = ['house', 'shop', 'office', 'house', 'house'];

  for (let bx = 0; bx < citySize; bx += bs) {
    for (let by = 0; by < citySize; by += bs) {
      // Inner area: well inside the block, away from roads
      const ix = bx + halfRw + 10;
      const iy = by + halfRw + 10;
      const iw = bs - rw - 20;
      const ih = bs - rw - 20;
      if (iw <= 40 || ih <= 40) continue;

      // Place 1-2 buildings per block (less dense = more playable)
      const count = 1 + Math.floor(Math.random() * 2);
      const blockBuildings: Building[] = [];

      for (let i = 0; i < count; i++) {
        // Try to place without overlapping other buildings in this block
        for (let attempt = 0; attempt < 10; attempt++) {
          const w = 50 + Math.random() * 50;
          const h = 50 + Math.random() * 50;
          const x = ix + Math.random() * Math.max(0, iw - w);
          const y = iy + Math.random() * Math.max(0, ih - h);

          // Check no overlap with other buildings in this block (min 25px gap)
          let overlaps = false;
          for (const ob of blockBuildings) {
            if (rectsOverlap(x, y, w, h, ob.x, ob.y, ob.w, ob.h, 25)) {
              overlaps = true;
              break;
            }
          }
          if (!overlaps) {
            const building: Building = {
              x, y, w, h,
              color: colors[Math.floor(Math.random() * colors.length)],
              type: types[Math.floor(Math.random() * types.length)],
              windows: 2 + Math.floor(Math.random() * 6),
            };
            blockBuildings.push(building);
            buildings.push(building);
            break;
          }
        }
      }
    }
  }

  // Hospital at center
  const hs = 80;
  const cr = Math.round(citySize / 2 / bs) * bs;
  buildings.push({
    x: cr + halfRw + 20, y: cr + halfRw + 20, w: hs, h: hs,
    color: '#dc2626', type: 'hospital', windows: 8,
  });

  return buildings;
}

function generateTraffic(citySize: number, density: number, buildings: Building[]): TrafficCar[] {
  const cars: TrafficCar[] = [];
  const count = Math.floor(density * 25);
  const cc = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#6b7280'];
  const bs = BLOCK_SIZE;
  const laneOffset = 18; // offset from road center for lanes
  for (let i = 0; i < count; i++) {
    const horiz = Math.random() < 0.5;
    const lane = Math.floor(Math.random() * Math.floor(citySize / bs));
    const rc = lane * bs;
    const side = Math.random() < 0.5 ? -laneOffset : laneOffset;
    const x = horiz ? (100 + Math.random() * (citySize - 200)) : rc + side;
    const y = horiz ? rc + side : (100 + Math.random() * (citySize - 200));
    if (isInsideBuilding(x, y, buildings, 25)) continue;
    cars.push({
      x, y,
      vx: horiz ? (Math.random() < 0.5 ? 1 : -1) * (1 + Math.random() * 1.5) : 0,
      vy: horiz ? 0 : (Math.random() < 0.5 ? 1 : -1) * (1 + Math.random() * 1.5),
      angle: 0, color: cc[Math.floor(Math.random() * cc.length)],
      width: 50, height: 28, lane, honkTimer: 0,
    });
  }
  return cars;
}

function generatePowerUps(citySize: number, count: number, buildings: Building[], mode: GameMode): PowerUp[] {
  const pus: PowerUp[] = [];
  const types: PowerUp['type'][] = mode === 'ambulance'
    ? ['nitro', 'medkit', 'megaphone', 'coffee']
    : ['energy', 'smokebomb', 'shortcut', 'coffee'];
  for (let i = 0; i < count; i++) {
    const pos = findRoadPosition(citySize, buildings);
    pus.push({ x: pos.x, y: pos.y, type: types[Math.floor(Math.random() * types.length)], collected: false });
  }
  return pus;
}

function generateHazards(citySize: number, level: number, buildings: Building[]): Hazard[] {
  const hazards: Hazard[] = [];
  const count = 5 + level * 2;
  const types: HazardType[] = ['fire', 'electricity', 'manhole', 'construction', 'toxic'];
  const configs: Record<HazardType, { dps: number; radius: number; burst: number }> = {
    fire: { dps: 12, radius: 50, burst: 5 },
    electricity: { dps: 0, radius: 40, burst: 30 },
    manhole: { dps: 0, radius: 35, burst: 25 },
    construction: { dps: 8, radius: 55, burst: 10 },
    toxic: { dps: 15, radius: 45, burst: 3 },
  };
  for (let i = 0; i < count; i++) {
    const pos = findRoadPosition(citySize, buildings);
    const type = types[Math.floor(Math.random() * types.length)];
    const cfg = configs[type];
    hazards.push({
      x: pos.x, y: pos.y, type, active: true,
      neutralizeTimer: 0, cooldown: 0,
      dps: cfg.dps, radius: cfg.radius, burstDamage: cfg.burst,
    });
  }
  return hazards;
}

function spawnParticles(x: number, y: number, color: string, count: number, ptype: Particle['type'] = 'spark'): Particle[] {
  const ps: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 1 + Math.random() * 3;
    ps.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 30 + Math.random() * 30, maxLife: 60, color, size: 2 + Math.random() * 4, type: ptype });
  }
  return ps;
}

export function createInitialState(): GameState {
  const upgrades: Upgrades = { engine: 0, tires: 0, siren: 0, armor: 0 };
  return {
    screen: 'menu', gameMode: 'ambulance',
    ambulance: createAmbulance(upgrades),
    patients: [], trafficCars: [], buildings: [], buildingGrid: null, powerUps: [], particles: [],
    runner: null, aiAmbulance: null,
    surviveTime: 0, surviveTarget: 60, runnerScore: 0, runnerLevel: 1,
    hazards: [], barriers: [],
    aiBarrierCooldown: 0, aiNeutralizeCooldown: 0,
    aiBackupTimer: 0, backupAmbulances: [],
    mission: null, missionIndex: 0,
    score: 0, totalSaved: 0, totalFailed: 0,
    reputation: 50, money: 0, upgrades,
    timeLeft: 0, cameraX: 0, cameraY: 0, cameraShake: 0,
    currentDialogue: '', dialogueTimer: 0,
    weather: 'clear', dayTime: 0.7,
    comboCount: 0, comboTimer: 0,
    patientsCaughtThisMission: 0, patientsNeeded: 1,
    flashMessages: [], hospitalX: 0, hospitalY: 0,
    keys: { up: false, down: false, left: false, right: false, space: false, honk: false },
    time: 0, collisionCooldown: 0,
    aiStuckTimer: 0, aiAvoidAngle: 0, aiLastX: 0, aiLastY: 0,
    transitionAlpha: 0, tutorialShown: false, audioEvents: [],
    activeEvent: null, eventCooldown: 0,
    nearMissCombo: 0, nearMissTimer: 0,
    driftTimer: 0, isDrifting: false,
  };
}

// ============ SAVE / LOAD ============

export function saveProgress(state: GameState): void {
  const data: SaveData = {
    version: 1, gameMode: state.gameMode,
    missionIndex: state.missionIndex, score: state.score,
    money: state.money, upgrades: state.upgrades,
    totalSaved: state.totalSaved, totalFailed: state.totalFailed,
    reputation: state.reputation, runnerLevel: state.runnerLevel,
    runnerScore: state.runnerScore, tutorialShown: state.tutorialShown,
  };
  try { localStorage.setItem('ambulance-save', JSON.stringify(data)); } catch { /* noop */ }
}

export function loadProgress(): SaveData | null {
  try {
    const raw = localStorage.getItem('ambulance-save');
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data && data.version === 1) return data as SaveData;
    return null;
  } catch { return null; }
}

export function clearProgress(): void {
  try { localStorage.removeItem('ambulance-save'); } catch { /* noop */ }
}

export function createInitialStateWithSave(): GameState {
  const base = createInitialState();
  const saved = loadProgress();
  if (saved) {
    return {
      ...base,
      gameMode: saved.gameMode,
      missionIndex: saved.missionIndex,
      score: saved.score,
      money: saved.money,
      upgrades: saved.upgrades,
      totalSaved: saved.totalSaved,
      totalFailed: saved.totalFailed,
      reputation: saved.reputation,
      runnerLevel: saved.runnerLevel,
      runnerScore: saved.runnerScore,
      tutorialShown: saved.tutorialShown,
    };
  }
  return base;
}

// ============ RUNNER DIALOGUES ============

const RUNNER_DIALOGUES = [
  'Я здоров! Отстаньте!', 'Не догоните!', 'Мне не нужна помощь!',
  'Ещё чуть-чуть...', 'Вы меня не поймаете!', 'Свободу пациентам!',
  'Нет! Только не уколы!', 'Ненавижу больницы!', 'Адреналин!!!',
];

const EXTREMAL_DIALOGUES = [
  'Мне всё равно!', 'Попробуй спаси!', 'Огонь? Отлично!',
  'Не остановите меня!', 'Ещё один удар...', 'Почти готово!',
  'Больше опасностей!', 'Скорая? Ха-ха!', 'Я неудержим!',
  'Провода? Идеально!', 'Люк? Прыгаю!', 'Ловите меня!',
];

// ============ RUNNER MODE ============

export function startRunnerLevel(state: GameState): GameState {
  const level = state.runnerLevel;
  const isExtremal = state.gameMode === 'extremal';
  const cs = 2400 + level * 300; // Bigger maps = more room to run
  const buildings = generateBuildings(cs);

  const runnerPos = findRoadPosition(cs, buildings);
  const runner = createRunner(runnerPos.x, runnerPos.y, isExtremal);

  let ambPos = findRoadPosition(cs, buildings);
  let attempts = 0;
  while (dist(ambPos.x, ambPos.y, runnerPos.x, runnerPos.y) < 500 && attempts < 20) {
    ambPos = findRoadPosition(cs, buildings); attempts++;
  }
  const aiAmb = createAIAmbulance(ambPos.x, ambPos.y, level, isExtremal);

  const traffic = generateTraffic(cs, 0.3 + level * 0.1, buildings);
  const powerUps = isExtremal ? [] : generatePowerUps(cs, 12 + level * 3, buildings, 'runner');
  const hazards = isExtremal ? generateHazards(cs, level, buildings) : [];

  const weathers: GameState['weather'][] = ['clear', 'clear', 'rain', 'night', 'fog'];
  const weather = weathers[Math.min(level - 1, weathers.length - 1)] || 'clear';
  const surviveTarget = isExtremal ? 60 + level * 15 : 45 + level * 10;

  const buildingGrid = new SpatialGrid(buildings);
  return {
    ...state, screen: 'playing',
    runner, aiAmbulance: aiAmb, buildings, buildingGrid, trafficCars: traffic,
    powerUps, particles: [], patients: [],
    hazards, barriers: [],
    aiBarrierCooldown: 0, aiNeutralizeCooldown: 0,
    aiBackupTimer: isExtremal ? 30 + level * 5 : 999,
    backupAmbulances: [],
    weather, dayTime: weather === 'night' ? 0.15 : 0.8,
    surviveTime: 0, surviveTarget, timeLeft: surviveTarget,
    cameraX: runnerPos.x, cameraY: runnerPos.y, cameraShake: 0,
    flashMessages: [{
      text: isExtremal ? `Ур.${level}: Уничтожь себя!` : `Ур.${level}: Убеги!`,
      timer: 120, color: isExtremal ? '#ef4444' : '#fbbf24'
    }],
    time: 0, collisionCooldown: 0,
    aiStuckTimer: 0, aiAvoidAngle: 0, aiLastX: ambPos.x, aiLastY: ambPos.y,
    transitionAlpha: 1, audioEvents: [],
    mission: {
      id: level, title: isExtremal ? `Экстремал #${level}` : `Побег #${level}`,
      description: '', type: 'chase', patients: [], weather,
      timeLimit: surviveTarget, citySize: cs, trafficDensity: 0.3, difficulty: level,
    },
  };
}

function navigateAI(
  amb: Ambulance, targetX: number, targetY: number, buildings: Building[],
  barriers: Barrier[], state: GameState, dt: number, levelBoost: number, isLost: boolean
): { amb: Ambulance; stuckTimer: number; avoidAngle: number; lastX: number; lastY: number } {
  const cs = state.mission?.citySize || 2000;
  let aiStuckTimer = state.aiStuckTimer;
  let aiAvoidAngle = state.aiAvoidAngle;

  // Stuck detection
  if (state.time % 30 === 0) {
    const movedDist = dist(amb.x, amb.y, state.aiLastX, state.aiLastY);
    if (movedDist < 15) {
      aiStuckTimer = 60;
      const toTarget = Math.atan2(targetY - amb.y, targetX - amb.x);
      const pA = toTarget + Math.PI / 2, pB = toTarget - Math.PI / 2;
      const testD = 100;
      const bA = isInsideBuilding(amb.x + Math.cos(pA) * testD, amb.y + Math.sin(pA) * testD, buildings, 25);
      const bB = isInsideBuilding(amb.x + Math.cos(pB) * testD, amb.y + Math.sin(pB) * testD, buildings, 25);
      aiAvoidAngle = bA && !bB ? pB : !bA && bB ? pA : Math.random() < 0.5 ? pA : pB;
    }
  }
  if (aiStuckTimer > 0) aiStuckTimer--;

  let steerAngle: number;
  if (isLost) {
    if (state.time % 60 === 0) aiAvoidAngle = Math.random() * Math.PI * 2;
    steerAngle = aiAvoidAngle;
  } else if (aiStuckTimer > 0) {
    steerAngle = aiAvoidAngle;
  } else {
    const toAngle = Math.atan2(targetY - amb.y, targetX - amb.x);
    const lookAhead = 100; // Further lookahead
    const ax = amb.x + Math.cos(toAngle) * lookAhead;
    const ay = amb.y + Math.sin(toAngle) * lookAhead;
    // Also check a closer point
    const ax2 = amb.x + Math.cos(toAngle) * 40;
    const ay2 = amb.y + Math.sin(toAngle) * 40;
    const blocked = isInsideBuilding(ax, ay, buildings, 35) || isInsideBarrier(ax, ay, barriers, 10)
      || isInsideBuilding(ax2, ay2, buildings, 35) || isInsideBarrier(ax2, ay2, barriers, 10);
    if (blocked) {
      let bestAngle = toAngle, bestScore = -Infinity;
      for (let i = -6; i <= 6; i++) {
        if (i === 0) continue;
        const ta = toAngle + i * (Math.PI / 8); // finer search (22.5° steps)
        const tx = amb.x + Math.cos(ta) * lookAhead;
        const ty = amb.y + Math.sin(ta) * lookAhead;
        const tx2 = amb.x + Math.cos(ta) * 40;
        const ty2 = amb.y + Math.sin(ta) * 40;
        if (!isInsideBuilding(tx, ty, buildings, 35) && !isInsideBarrier(tx, ty, barriers, 10)
          && !isInsideBuilding(tx2, ty2, buildings, 35) && !isInsideBarrier(tx2, ty2, barriers, 10)) {
          const score = 10 - Math.abs(i);
          if (score > bestScore) { bestScore = score; bestAngle = ta; }
        }
      }
      steerAngle = bestAngle;
    } else {
      steerAngle = toAngle;
    }
  }

  const chaseAccel = amb.acceleration * levelBoost * (aiStuckTimer > 0 ? 1.5 : 1.0);
  amb.vx += Math.cos(steerAngle) * chaseAccel;
  amb.vy += Math.sin(steerAngle) * chaseAccel;
  amb.vx *= amb.handling; amb.vy *= amb.handling;

  const spd = Math.sqrt(amb.vx ** 2 + amb.vy ** 2);
  const maxSpd = amb.maxSpeed * levelBoost;
  if (spd > maxSpd) { amb.vx = (amb.vx / spd) * maxSpd; amb.vy = (amb.vy / spd) * maxSpd; }
  if (spd > 0.5) amb.angle = Math.atan2(amb.vy, amb.vx);
  amb.speed = spd;

  let nx = amb.x + amb.vx * dt * 60;
  let ny = amb.y + amb.vy * dt * 60;

  // Collisions
  let hitWall = false;
  for (let pass = 0; pass < 4; pass++) {
    let resolved = true;
    for (const b of buildings) {
      if (Math.abs(nx - b.x - b.w / 2) > b.w / 2 + 30 && Math.abs(ny - b.y - b.h / 2) > b.h / 2 + 20) continue;
      const r = resolveRectCollision(nx - 22, ny - 14, 44, 28, b.x, b.y, b.w, b.h);
      if (r.hit) { nx += r.dx * 1.1; ny += r.dy * 1.1; resolved = false; hitWall = true; if (r.dx !== 0) amb.vx = 0; if (r.dy !== 0) amb.vy = 0; }
    }
    // Barriers don't block AI ambulance — AI can drive through its own barriers
    if (resolved) break;
  }
  if (hitWall && aiStuckTimer <= 0) {
    const ma = Math.atan2(amb.vy, amb.vx);
    const pa = ma + (Math.random() < 0.5 ? Math.PI / 2 : -Math.PI / 2);
    amb.vx += Math.cos(pa) * 1.5; amb.vy += Math.sin(pa) * 1.5;
  }

  amb.x = clamp(nx, 30, cs - 30);
  amb.y = clamp(ny, 30, cs - 30);

  const lx = state.time % 30 === 0 ? amb.x : state.aiLastX;
  const ly = state.time % 30 === 0 ? amb.y : state.aiLastY;

  return { amb, stuckTimer: aiStuckTimer, avoidAngle: aiAvoidAngle, lastX: lx, lastY: ly };
}

function updateRunnerMode(state: GameState, dt: number): GameState {
  const s = { ...state };
  const runner = { ...state.runner! };
  const aiAmb = { ...state.aiAmbulance! };
  const cs = state.mission?.citySize || 2000;
  const isExtremal = state.gameMode === 'extremal';
  let newParticles = [...state.particles];
  const audio: string[] = [];

  s.time = state.time + 1;
  s.surviveTime = state.surviveTime + dt;
  s.timeLeft = Math.max(0, state.surviveTarget - s.surviveTime);

  // === RUNNER MOVEMENT ===
  const keys = state.keys;
  const isSprinting = keys.space && runner.stamina > 5;
  runner.sprinting = isSprinting;

  const baseSpeed = isExtremal ? 3.8 : 3.5;
  const sprintMult = isSprinting ? 1.6 : 1.0;
  const boostMult = runner.speedBoostTimer > 0 ? 1.3 : 1.0;
  const moveSpeed = baseSpeed * sprintMult * boostMult;

  const accel = 0.5;
  if (keys.up) runner.vy -= accel;
  if (keys.down) runner.vy += accel;
  if (keys.left) runner.vx -= accel;
  if (keys.right) runner.vx += accel;
  runner.vx *= 0.88; runner.vy *= 0.88;

  const spd = Math.sqrt(runner.vx ** 2 + runner.vy ** 2);
  if (spd > moveSpeed) { runner.vx = (runner.vx / spd) * moveSpeed; runner.vy = (runner.vy / spd) * moveSpeed; }
  if (spd > 0.3) runner.angle = Math.atan2(runner.vy, runner.vx);
  runner.speed = spd;

  if (isSprinting) runner.stamina = Math.max(0, runner.stamina - 25 * dt);
  else runner.stamina = Math.min(runner.maxStamina, runner.stamina + 12 * dt);

  let nrx = runner.x + runner.vx;
  let nry = runner.y + runner.vy;

  // Building collision
  const nearRunnerBuildings = state.buildingGrid ? state.buildingGrid.queryNear(nrx, nry, 60) : state.buildings;
  for (let pass = 0; pass < 3; pass++) {
    let resolved = true;
    for (const b of nearRunnerBuildings) {
      if (Math.abs(nrx - b.x - b.w / 2) > b.w / 2 + 15 && Math.abs(nry - b.y - b.h / 2) > b.h / 2 + 15) continue;
      const r = resolveRectCollision(nrx - 8, nry - 8, 16, 16, b.x, b.y, b.w, b.h);
      if (r.hit) { nrx += r.dx; nry += r.dy; resolved = false; if (r.dx !== 0) runner.vx = 0; if (r.dy !== 0) runner.vy = 0; }
    }
    if (resolved) break;
  }

  // Barrier collision for player
  for (const bar of state.barriers) {
    const r = resolveRectCollision(nrx - 8, nry - 8, 16, 16, bar.x, bar.y, bar.w, bar.h);
    if (r.hit) { nrx += r.dx; nry += r.dy; if (r.dx !== 0) runner.vx *= -0.5; if (r.dy !== 0) runner.vy *= -0.5; }
  }

  nrx = clamp(nrx, 30, cs - 30);
  nry = clamp(nry, 30, cs - 30);
  runner.x = nrx; runner.y = nry;

  // Timers
  if (runner.smokeBombTimer > 0) runner.smokeBombTimer -= dt;
  if (runner.invisibleTimer > 0) runner.invisibleTimer -= dt;
  if (runner.speedBoostTimer > 0) runner.speedBoostTimer -= dt;
  if (runner.caughtTimer > 0) runner.caughtTimer -= dt;
  if (runner.dashCooldown > 0) runner.dashCooldown -= dt;

  // Dialogue
  runner.dialogueTimer -= 1;
  if (runner.dialogueTimer <= 0) {
    const dialogues = isExtremal ? EXTREMAL_DIALOGUES : RUNNER_DIALOGUES;
    runner.currentDialogue = dialogues[Math.floor(Math.random() * dialogues.length)];
    runner.dialogueTimer = 120 + Math.random() * 200;
  }

  // Sprint particles
  if (isSprinting && s.time % 3 === 0) {
    newParticles.push({ x: nrx - Math.cos(runner.angle) * 10, y: nry - Math.sin(runner.angle) * 10, vx: -runner.vx * 0.3, vy: -runner.vy * 0.3, life: 20, maxLife: 20, color: '#fbbf24', size: 3, type: 'smoke' });
  }
  if (runner.smokeBombTimer > 0 && s.time % 2 === 0) {
    newParticles.push({ x: nrx + (Math.random() - 0.5) * 60, y: nry + (Math.random() - 0.5) * 60, vx: (Math.random() - 0.5) * 2, vy: (Math.random() - 0.5) * 2, life: 30, maxLife: 30, color: 'rgba(100,100,100,0.5)', size: 8 + Math.random() * 8, type: 'smoke' });
  }

  // === EXTREMAL: HAZARD INTERACTION ===
  runner.interactingHazard = false;
  if (isExtremal) {
    s.hazards = state.hazards.map(hz => {
      const h = { ...hz };
      if (h.neutralizeTimer > 0) { h.neutralizeTimer -= dt; h.active = false; return h; }
      h.active = true;
      if (h.cooldown > 0) { h.cooldown -= dt; return h; }

      const d = dist(h.x, h.y, runner.x, runner.y);
      if (d < h.radius && h.active) {
        runner.interactingHazard = true;

        if (h.type === 'electricity' || h.type === 'manhole') {
          // Burst damage with cooldown
          runner.playerHealth -= h.burstDamage;
          h.cooldown = h.type === 'electricity' ? 3 : 5;
          s.cameraShake = Math.max(s.cameraShake, 8);
          newParticles.push(...spawnParticles(h.x, h.y, h.type === 'electricity' ? '#fbbf24' : '#6b7280', 15));
          audio.push('hazardDamage');
          s.flashMessages = [...(s.flashMessages || []), {
            text: h.type === 'electricity' ? '⚡ УДАР ТОКОМ! -30HP' : '🕳 УПАЛ В ЛЮК! -25HP',
            timer: 60, color: '#ef4444'
          }];
          if (h.type === 'manhole') {
            // Teleport nearby
            runner.x += (Math.random() - 0.5) * 200;
            runner.y += (Math.random() - 0.5) * 200;
          }
        } else {
          // DPS damage
          const dmg = h.dps * dt;
          runner.playerHealth -= dmg;
          if (s.time % 10 === 0) {
            newParticles.push(...spawnParticles(runner.x, runner.y, h.type === 'fire' ? '#f97316' : h.type === 'toxic' ? '#22c55e' : '#fbbf24', 3));
          }
        }
      }
      return h;
    });

    // Dash to nearest hazard with honk button
    if (keys.honk && runner.dashCooldown <= 0) {
      let nearestHz: Hazard | null = null;
      let nearestDist = Infinity;
      for (const h of s.hazards) {
        if (!h.active || h.cooldown > 0 || h.neutralizeTimer > 0) continue;
        const d = dist(h.x, h.y, runner.x, runner.y);
        if (d < 200 && d < nearestDist) { nearestDist = d; nearestHz = h; }
      }
      if (nearestHz) {
        const dashAngle = Math.atan2(nearestHz.y - runner.y, nearestHz.x - runner.x);
        runner.vx = Math.cos(dashAngle) * 8;
        runner.vy = Math.sin(dashAngle) * 8;
        runner.dashCooldown = 3;
        runner.stamina = Math.max(0, runner.stamina - 20);
        s.flashMessages = [...(s.flashMessages || []), { text: '💀 РЫВОК К ОПАСНОСТИ!', timer: 40, color: '#ef4444' }];
        newParticles.push(...spawnParticles(runner.x, runner.y, '#ef4444', 10));
      }
    }

    // Traffic damage for extremal
    for (const car of state.trafficCars) {
      const d = dist(car.x, car.y, runner.x, runner.y);
      if (d < 30) {
        runner.playerHealth -= 15;
        runner.vx += (runner.x - car.x) * 0.3;
        runner.vy += (runner.y - car.y) * 0.3;
        s.cameraShake = Math.max(s.cameraShake, 6);
        newParticles.push(...spawnParticles(runner.x, runner.y, '#ef4444', 8));
        s.flashMessages = [...(s.flashMessages || []), { text: '🚗 СБИТ МАШИНОЙ! -15HP', timer: 50, color: '#ef4444' }];
      }
    }

    runner.playerHealth = Math.max(0, runner.playerHealth);
  }

  s.runner = runner;

  // === AI AMBULANCE ===
  const levelBoost = 1 + state.surviveTime * 0.003;
  const isLost = runner.smokeBombTimer > 0;
  const targetX = isLost ? aiAmb.x + (Math.random() - 0.5) * 200 : runner.x;
  const targetY = isLost ? aiAmb.y + (Math.random() - 0.5) * 200 : runner.y;

  const navResult = navigateAI(aiAmb, targetX, targetY, state.buildings, state.barriers, state, dt, levelBoost, isLost);
  const updatedAmb = navResult.amb;
  s.aiStuckTimer = navResult.stuckTimer;
  s.aiAvoidAngle = navResult.avoidAngle;
  s.aiLastX = navResult.lastX;
  s.aiLastY = navResult.lastY;

  // Siren particles
  if (s.time % 4 === 0) {
    const flash = s.time % 8 < 4;
    newParticles.push({ x: updatedAmb.x, y: updatedAmb.y - 15, vx: 0, vy: -1, life: 15, maxLife: 15, color: flash ? '#ef4444' : '#3b82f6', size: 3, type: 'spark' });
  }
  s.aiAmbulance = updatedAmb;

  // === EXTREMAL AI ABILITIES ===
  if (isExtremal) {
    // 1. Deploy barriers to block path to hazards
    let aiBarrierCD = state.aiBarrierCooldown > 0 ? state.aiBarrierCooldown - dt : 0;
    if (aiBarrierCD <= 0 && runner.interactingHazard) {
      // Find nearest hazard to player and put barrier between them
      let nearestHz: Hazard | null = null;
      let nd = Infinity;
      for (const h of s.hazards) {
        if (!h.active) continue;
        const d = dist(h.x, h.y, runner.x, runner.y);
        if (d < nd) { nd = d; nearestHz = h; }
      }
      if (nearestHz) {
        const midX = (runner.x + nearestHz.x) / 2;
        const midY = (runner.y + nearestHz.y) / 2;
        if (!isInsideBuilding(midX, midY, state.buildings, 5)) {
          s.barriers = [...state.barriers, { x: midX - 30, y: midY - 8, w: 60, h: 16, life: 12 }];
          aiBarrierCD = 12 - Math.min(state.runnerLevel, 6);
          newParticles.push(...spawnParticles(midX, midY, '#f59e0b', 8));
          s.flashMessages = [...(s.flashMessages || []), { text: '🚧 ИИ поставил барьер!', timer: 60, color: '#f59e0b' }];
        }
      }
    }
    s.aiBarrierCooldown = aiBarrierCD;

    // 2. Neutralize hazards player is heading towards
    let aiNeutCD = state.aiNeutralizeCooldown > 0 ? state.aiNeutralizeCooldown - dt : 0;
    if (aiNeutCD <= 0) {
      // Find hazard player is closest to
      for (const h of s.hazards) {
        if (!h.active || h.neutralizeTimer > 0) continue;
        const d = dist(h.x, h.y, runner.x, runner.y);
        const ambD = dist(h.x, h.y, updatedAmb.x, updatedAmb.y);
        if (d < 120 && ambD < 300) {
          h.neutralizeTimer = 8;
          aiNeutCD = 15 - Math.min(state.runnerLevel * 0.5, 5);
          newParticles.push(...spawnParticles(h.x, h.y, '#3b82f6', 12));
          s.flashMessages = [...(s.flashMessages || []), { text: '🛡 ИИ нейтрализовал опасность!', timer: 60, color: '#3b82f6' }];
          break;
        }
      }
    }
    s.aiNeutralizeCooldown = aiNeutCD;

    // 3. Backup ambulances
    let backupTimer = state.aiBackupTimer > 0 ? state.aiBackupTimer - dt : 0;
    if (backupTimer <= 0 && state.backupAmbulances.length < Math.min(state.runnerLevel - 1, 3)) {
      let bPos = findRoadPosition(cs, state.buildings);
      let att = 0;
      while (dist(bPos.x, bPos.y, runner.x, runner.y) < 400 && att < 10) { bPos = findRoadPosition(cs, state.buildings); att++; }
      const backup = createAIAmbulance(bPos.x, bPos.y, state.runnerLevel, true);
      backup.maxSpeed *= 0.85;
      s.backupAmbulances = [...state.backupAmbulances, backup];
      backupTimer = 30 + state.runnerLevel * 5;
      s.flashMessages = [...(s.flashMessages || []), { text: '🚑 ПОДКРЕПЛЕНИЕ ПРИБЫЛО!', timer: 80, color: '#ef4444' }];
    }
    s.aiBackupTimer = backupTimer;

    // Update backup ambulances
    s.backupAmbulances = state.backupAmbulances.map(ba => {
      const baCopy = { ...ba };
      const toAngle = Math.atan2(runner.y - baCopy.y, runner.x - baCopy.x);
      baCopy.vx += Math.cos(toAngle) * baCopy.acceleration * levelBoost;
      baCopy.vy += Math.sin(toAngle) * baCopy.acceleration * levelBoost;
      baCopy.vx *= baCopy.handling; baCopy.vy *= baCopy.handling;
      const bSpd = Math.sqrt(baCopy.vx ** 2 + baCopy.vy ** 2);
      if (bSpd > baCopy.maxSpeed * levelBoost) { baCopy.vx = (baCopy.vx / bSpd) * baCopy.maxSpeed * levelBoost; baCopy.vy = (baCopy.vy / bSpd) * baCopy.maxSpeed * levelBoost; }
      if (bSpd > 0.5) baCopy.angle = Math.atan2(baCopy.vy, baCopy.vx);
      baCopy.speed = bSpd;
      baCopy.x += baCopy.vx; baCopy.y += baCopy.vy;
      // Simple building collision
      const nearBaBuildings = state.buildingGrid ? state.buildingGrid.queryNear(baCopy.x, baCopy.y, 60) : state.buildings;
      for (const b of nearBaBuildings) {
        const r = resolveRectCollision(baCopy.x - 22, baCopy.y - 14, 44, 28, b.x, b.y, b.w, b.h);
        if (r.hit) { baCopy.x += r.dx; baCopy.y += r.dy; if (r.dx !== 0) baCopy.vx = 0; if (r.dy !== 0) baCopy.vy = 0; }
      }
      baCopy.x = clamp(baCopy.x, 30, cs - 30);
      baCopy.y = clamp(baCopy.y, 30, cs - 30);
      return baCopy;
    });

    // Barrier decay
    s.barriers = state.barriers.map(b => ({ ...b, life: b.life - dt })).filter(b => b.life > 0);
  }

  // === CHECK CATCH ===
  const ambDist = dist(updatedAmb.x, updatedAmb.y, runner.x, runner.y);
  const catchDist = runner.invisibleTimer > 0 ? 25 : 45;
  if (ambDist < catchDist && runner.caughtTimer <= 0) {
    if (isExtremal) {
      s.screen = 'failed';
      s.flashMessages = [...(s.flashMessages || []), { text: 'Скорая вас поймала!', timer: 120, color: '#ef4444' }];
      audio.push('fail');
    } else {
      s.screen = 'saved';
      audio.push('catch');
    }
    s.cameraShake = 15;
    s.runnerScore += Math.floor(s.surviveTime * 10);
    newParticles.push(...spawnParticles(runner.x, runner.y, '#ef4444', 20, 'heart'));
  }

  // Check backup ambulance catch (extremal)
  if (isExtremal) {
    for (const ba of s.backupAmbulances) {
      if (dist(ba.x, ba.y, runner.x, runner.y) < catchDist) {
        s.screen = 'failed';
        s.cameraShake = 15;
        newParticles.push(...spawnParticles(runner.x, runner.y, '#ef4444', 20, 'heart'));
        break;
      }
    }
  }

  // === EXTREMAL WIN: Health reached 0 ===
  if (isExtremal && runner.playerHealth <= 0 && s.screen === 'playing') {
    s.screen = 'saved'; // Player "won" by dying
    s.runnerScore += Math.floor((state.surviveTarget - s.surviveTime) * 30) + state.runnerLevel * 200;
    s.runnerLevel += 1;
    newParticles.push(...spawnParticles(runner.x, runner.y, '#ef4444', 30, 'star'));
    s.flashMessages = [...(s.flashMessages || []), { text: '💀 ЦЕЛЬ ДОСТИГНУТА!', timer: 120, color: '#22c55e' }];
    audio.push('win');
  }

  // === NORMAL RUNNER WIN: Time survived ===
  if (!isExtremal && s.surviveTime >= state.surviveTarget && s.screen === 'playing') {
    s.screen = 'saved';
    s.runnerScore += Math.floor(s.surviveTime * 20) + state.runnerLevel * 100;
    s.runnerLevel += 1;
    newParticles.push(...spawnParticles(runner.x, runner.y, '#22c55e', 30, 'star'));
    audio.push('win');
  }

  // === EXTREMAL LOSE: Time ran out (you survived against your will) ===
  if (isExtremal && s.timeLeft <= 0 && s.screen === 'playing') {
    s.screen = 'failed';
    s.flashMessages = [...(s.flashMessages || []), { text: 'Время вышло! Вы выжили... к сожалению', timer: 120, color: '#ef4444' }];
    audio.push('fail');
  }

  // === POWERUPS (normal runner only) ===
  if (!isExtremal) {
    s.powerUps = state.powerUps.map(pu => {
      if (pu.collected) return pu;
      const d = dist(pu.x, pu.y, runner.x, runner.y);
      if (d < 40) {
        switch (pu.type) {
          case 'energy': runner.stamina = runner.maxStamina; s.flashMessages = [...(s.flashMessages || []), { text: '⚡ Энергия!', timer: 60, color: '#fbbf24' }]; break;
          case 'smokebomb': runner.smokeBombTimer = 5; s.flashMessages = [...(s.flashMessages || []), { text: '💨 Дым!', timer: 60, color: '#6b7280' }]; break;
          case 'shortcut': { const np2 = findRoadPosition(cs, state.buildings); runner.x = np2.x; runner.y = np2.y; runner.invisibleTimer = 2; s.flashMessages = [...(s.flashMessages || []), { text: '🚪 Телепорт!', timer: 60, color: '#a855f7' }]; break; }
          case 'coffee': runner.speedBoostTimer = 6; s.flashMessages = [...(s.flashMessages || []), { text: '☕ Скорость!', timer: 60, color: '#92400e' }]; break;
        }
        s.runnerScore += 50;
        audio.push('powerup');
        newParticles.push(...spawnParticles(pu.x, pu.y, '#fbbf24', 10));
        return { ...pu, collected: true };
      }
      return pu;
    });
  }

  // === TRAFFIC ===
  s.trafficCars = state.trafficCars.map(car => {
    const c = { ...car };
    c.x += c.vx; c.y += c.vy;
    if (c.x < -200) c.x = cs + 200; if (c.x > cs + 200) c.x = -200;
    if (c.y < -200) c.y = cs + 200; if (c.y > cs + 200) c.y = -200;
    const nearCarBldgs = state.buildingGrid ? state.buildingGrid.queryNear(c.x, c.y, 50) : state.buildings;
    for (const b of nearCarBldgs) {
      const r = resolveRectCollision(c.x - c.width / 2, c.y - c.height / 2, c.width, c.height, b.x, b.y, b.w, b.h);
      if (r.hit) { c.x += r.dx; c.y += r.dy; if (r.dx !== 0) c.vx = -c.vx; if (r.dy !== 0) c.vy = -c.vy; }
    }
    const d = dist(c.x, c.y, updatedAmb.x, updatedAmb.y);
    if (d < 120) { const dx = c.x - updatedAmb.x; const dy = c.y - updatedAmb.y; const len = Math.sqrt(dx * dx + dy * dy) || 1; c.x += (dx / len) * 2; c.y += (dy / len) * 2; }
    if (!isExtremal) {
      const rd = dist(c.x, c.y, runner.x, runner.y);
      if (rd < 25) { runner.vx += (runner.x - c.x) * 0.15; runner.vy += (runner.y - c.y) * 0.15; runner.stamina = Math.max(0, runner.stamina - 10); s.cameraShake = Math.max(s.cameraShake, 4); }
    }
    return c;
  });

  // Camera
  s.cameraX += (runner.x - s.cameraX) * 0.08;
  s.cameraY += (runner.y - s.cameraY) * 0.08;
  if (s.cameraShake > 0) { s.cameraShake *= 0.9; if (s.cameraShake < 0.3) s.cameraShake = 0; }

  // === RUNNER RANDOM EVENTS ===
  const rSpd = Math.sqrt(runner.vx ** 2 + runner.vy ** 2);
  // Sprint bonus points
  if (runner.sprinting && rSpd > 3 && s.time % 90 === 0) {
    s.runnerScore += 15;
    newParticles.push(...spawnParticles(runner.x, runner.y, '#fbbf24', 3, 'star'));
  }
  // Close call bonus (near ambulance at high speed)
  if (state.aiAmbulance) {
    const ambDist = dist(runner.x, runner.y, state.aiAmbulance.x, state.aiAmbulance.y);
    if (ambDist > 50 && ambDist < 100 && rSpd > 2 && s.time % 120 === 0) {
      s.runnerScore += 40;
      s.flashMessages = [...(s.flashMessages || []), { text: '😱 Почти поймали! +40', timer: 50, color: '#ef4444' }];
      newParticles.push(...spawnParticles(runner.x, runner.y, '#ef4444', 5, 'spark'));
    }
  }
  // Random events every ~8 sec
  if (s.time % 480 === 240 && s.screen === 'playing' && !isExtremal) {
    const roll = Math.random();
    if (roll < 0.3) {
      runner.stamina = Math.min(runner.maxStamina, runner.stamina + runner.maxStamina * 0.3);
      s.flashMessages = [...(s.flashMessages || []), { text: '💨 Второе дыхание!', timer: 70, color: '#22c55e' }];
    } else if (roll < 0.5) {
      s.runnerScore += 30;
      s.flashMessages = [...(s.flashMessages || []), { text: '🌟 Адреналин! +30', timer: 60, color: '#fbbf24' }];
    }
  }
  // Extremal mode: random spawn new hazard
  if (isExtremal && s.time % 600 === 0 && s.hazards.length < 12) {
    const hTypes: HazardType[] = ['fire', 'electricity', 'manhole', 'construction', 'toxic'];
    const ht = hTypes[Math.floor(Math.random() * hTypes.length)];
    const hp = findRoadPosition(cs, state.buildings);
    const dmg = ht === 'fire' ? 8 : ht === 'electricity' ? 12 : ht === 'toxic' ? 6 : 4;
    const rad = ht === 'toxic' ? 50 : ht === 'fire' ? 40 : 35;
    s.hazards = [...s.hazards, { x: hp.x, y: hp.y, type: ht, active: true, neutralizeTimer: 0, cooldown: 0, dps: dmg, radius: rad, burstDamage: ht === 'electricity' ? 15 : ht === 'manhole' ? 20 : 0 }];
    s.flashMessages = [...(s.flashMessages || []), { text: '⚠️ Новая опасность!', timer: 80, color: '#f97316' }];
  }

  // Particles
  newParticles = newParticles.map(p => ({ ...p, x: p.x + p.vx, y: p.y + p.vy, life: p.life - 1, vy: p.type === 'rain' ? p.vy : p.vy + 0.03, vx: p.vx * 0.99 })).filter(p => p.life > 0);
  if (state.weather === 'rain' && s.time % 2 === 0) {
    for (let i = 0; i < 5; i++) newParticles.push({ x: s.cameraX + (Math.random() - 0.5) * 1200, y: s.cameraY - 400, vx: -1, vy: 8 + Math.random() * 4, life: 60, maxLife: 60, color: 'rgba(150,200,255,0.3)', size: 1, type: 'rain' });
  }

  // Hazard ambient particles
  if (isExtremal && s.time % 5 === 0) {
    for (const h of s.hazards) {
      if (!h.active || h.neutralizeTimer > 0) continue;
      const color = h.type === 'fire' ? '#f97316' : h.type === 'electricity' ? '#fbbf24' : h.type === 'toxic' ? '#22c55e' : '#6b7280';
      newParticles.push({ x: h.x + (Math.random() - 0.5) * 20, y: h.y - 10, vx: (Math.random() - 0.5) * 1, vy: -1 - Math.random(), life: 25, maxLife: 25, color, size: 3 + Math.random() * 3, type: 'smoke' });
    }
  }

  s.particles = newParticles;
  s.flashMessages = (s.flashMessages || []).map(m => ({ ...m, timer: m.timer - 1 })).filter(m => m.timer > 0);
  s.runner = runner;
  if (s.transitionAlpha > 0) s.transitionAlpha = Math.max(0, s.transitionAlpha - 0.04);
  s.audioEvents = audio;
  return s;
}

// ============ AMBULANCE MODE ============

export function startMission(state: GameState, missionIdx: number): GameState {
  const mission = MISSIONS[missionIdx];
  if (!mission) return { ...state, screen: 'ending' };
  const cs = mission.citySize;
  const buildings = generateBuildings(cs);
  const amb = createAmbulance(state.upgrades);
  const ambPos = findRoadPosition(cs, buildings);
  amb.x = ambPos.x; amb.y = ambPos.y;

  const patients: Patient[] = mission.patients.map((story) => {
    let pos = findRoadPosition(cs, buildings);
    let att = 0;
    while (dist(pos.x, pos.y, amb.x, amb.y) < 300 && att < 20) { pos = findRoadPosition(cs, buildings); att++; }
    return { x: pos.x, y: pos.y, vx: 0, vy: 0, angle: Math.random() * Math.PI * 2, story, health: 100, caught: false, dialogueTimer: 60 + Math.random() * 120, currentDialogue: '', panicLevel: 0, stunTimer: 0 };
  });

  const buildingGrid = new SpatialGrid(buildings);
  return {
    ...state, screen: 'playing', gameMode: 'ambulance',
    ambulance: amb, patients, trafficCars: generateTraffic(cs, mission.trafficDensity, buildings),
    buildings, buildingGrid, powerUps: generatePowerUps(cs, 6 + mission.difficulty * 2, buildings, 'ambulance'),
    particles: [], mission, missionIndex: missionIdx,
    timeLeft: mission.timeLimit, weather: mission.weather,
    dayTime: mission.weather === 'night' ? 0.15 : 0.8,
    cameraX: amb.x, cameraY: amb.y, cameraShake: 0,
    currentDialogue: '', dialogueTimer: 0,
    comboCount: 0, comboTimer: 0,
    patientsCaughtThisMission: 0, patientsNeeded: mission.patients.length,
    flashMessages: [{ text: mission.title, timer: 120, color: '#fbbf24' }],
    hospitalX: cs / 2, hospitalY: cs / 2,
    time: 0, collisionCooldown: 0,
    runner: null, aiAmbulance: null,
    hazards: [], barriers: [], backupAmbulances: [],
    aiBarrierCooldown: 0, aiNeutralizeCooldown: 0, aiBackupTimer: 999,
    transitionAlpha: 1, audioEvents: [],
    activeEvent: null, eventCooldown: 0,
    nearMissCombo: 0, nearMissTimer: 0,
    driftTimer: 0, isDrifting: false,
  };
}

// ============ DYNAMIC EVENTS SYSTEM ============

function processDynamicEvents(s: GameState, amb: Ambulance, audio: string[], newP: Particle[]): void {
  const cs = s.mission?.citySize || 2000;

  // Tick active event
  if (s.activeEvent) {
    s.activeEvent = { ...s.activeEvent, timer: s.activeEvent.timer - 1 };

    // Apply active event effects
    switch (s.activeEvent.type) {
      case 'trafficJam': {
        // Steer nearby cars toward jam point
        const jx = s.activeEvent.x, jy = s.activeEvent.y;
        s.trafficCars = s.trafficCars.map(c => {
          const d = dist(c.x, c.y, jx, jy);
          if (d < 400 && d > 30) {
            const dx = jx - c.x, dy = jy - c.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
            return { ...c, vx: c.vx * 0.95 + (dx / len) * 0.4, vy: c.vy * 0.95 + (dy / len) * 0.4 };
          }
          return c;
        });
        break;
      }
      case 'patientSprint': {
        const pidx = s.activeEvent.data?.patIdx;
        if (pidx !== undefined && s.patients[pidx] && !s.patients[pidx].caught) {
          s.patients = s.patients.map((p, i) => i === pidx ? { ...p, panicLevel: 1 } : p);
        }
        break;
      }
      case 'policeChase': {
        const cidx = s.activeEvent.data?.carIdx;
        if (cidx !== undefined && s.trafficCars[cidx]) {
          const c = { ...s.trafficCars[cidx] };
          const dx = amb.x - c.x, dy = amb.y - c.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
          c.vx = (dx / len) * 4; c.vy = (dy / len) * 4;
          c.color = '#1e40af';
          const d = dist(c.x, c.y, amb.x, amb.y);
          if (d < 40 && s.activeEvent.timer > 60) {
            s.timeLeft -= 3;
            s.cameraShake = Math.max(s.cameraShake, 12);
            s.flashMessages = [...(s.flashMessages || []), { text: '🚔 Штраф! -3 сек', timer: 60, color: '#ef4444' }];
            audio.push('collision');
            s.activeEvent = { ...s.activeEvent, timer: 60 }; // end soon after penalty
          }
          s.trafficCars = s.trafficCars.map((tc, i) => i === cidx ? c : tc);
        }
        break;
      }
      case 'earthquake': {
        s.cameraShake = Math.max(s.cameraShake, 6 + Math.sin(s.time * 0.3) * 4);
        break;
      }
    }

    if (s.activeEvent.timer <= 0) {
      // Cleanup: restore police car color
      if (s.activeEvent.type === 'policeChase' && s.activeEvent.data?.carIdx !== undefined) {
        const cidx = s.activeEvent.data.carIdx;
        const colors = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b'];
        if (s.trafficCars[cidx]) s.trafficCars = s.trafficCars.map((c, i) => i === cidx ? { ...c, color: colors[Math.floor(Math.random() * colors.length)] } : c);
      }
      s.activeEvent = null;
      s.eventCooldown = 180; // 3 sec cooldown between events
    }
    return;
  }

  // Cooldown
  if (s.eventCooldown > 0) { s.eventCooldown--; return; }

  // Roll for event every ~4 seconds (was 8) with 70% chance (was 55%)
  if (s.time % 240 !== 120) return;
  if (Math.random() > 0.70) return;

  const roll = Math.random();
  if (roll < 0.18) {
    // Traffic Jam — cars cluster ahead, blocking path
    const tx = clamp(amb.x + Math.cos(amb.angle) * 300, 100, cs - 100);
    const ty = clamp(amb.y + Math.sin(amb.angle) * 300, 100, cs - 100);
    s.activeEvent = { type: 'trafficJam', timer: 240, x: tx, y: ty };
    s.flashMessages = [...(s.flashMessages || []), { text: '🚗🚗🚗 ПРОБКА ВПЕРЕДИ!', timer: 150, color: '#f59e0b' }];
    s.cameraShake = 4;
    audio.push('event');
  } else if (roll < 0.32) {
    // Road Block — barrier on path
    const tx = clamp(amb.x + Math.cos(amb.angle) * 200, 100, cs - 100);
    const ty = clamp(amb.y + Math.sin(amb.angle) * 200, 100, cs - 100);
    s.barriers = [...(s.barriers || []), { x: tx - 50, y: ty - 15, w: 100, h: 30, health: 80, type: 'construction' as HazardType }];
    s.activeEvent = { type: 'roadBlock', timer: 300, x: tx, y: ty };
    s.flashMessages = [...(s.flashMessages || []), { text: '🚧🚧 ДОРОГА ПЕРЕКРЫТА!', timer: 150, color: '#ef4444' }];
    s.cameraShake = 8;
    newP.push(...spawnParticles(tx, ty, '#ef4444', 12, 'spark'));
    audio.push('event');
  } else if (roll < 0.46) {
    // Patient Sprint — patient panics and runs 2x speed
    const uncaught = s.patients.filter(p => !p.caught);
    if (uncaught.length > 0) {
      const p = uncaught[Math.floor(Math.random() * uncaught.length)];
      const pidx = s.patients.indexOf(p);
      s.activeEvent = { type: 'patientSprint', timer: 240, x: p.x, y: p.y, data: { patIdx: pidx } };
      s.flashMessages = [...(s.flashMessages || []), { text: `⚡ ${p.story.emoji} ${p.story.name} УБЕГАЕТ!`, timer: 120, color: '#c084fc' }];
      newP.push(...spawnParticles(p.x, p.y, '#c084fc', 10, 'spark'));
      s.cameraShake = 3;
      audio.push('event');
    }
  } else if (roll < 0.58) {
    // Police Chase — car turns police and hunts you
    if (s.trafficCars.length > 0) {
      let nearest = 0, minD = Infinity;
      s.trafficCars.forEach((c, i) => { const d = dist(c.x, c.y, amb.x, amb.y); if (d < minD) { minD = d; nearest = i; } });
      s.activeEvent = { type: 'policeChase', timer: 480, x: 0, y: 0, data: { carIdx: nearest } };
      s.trafficCars = s.trafficCars.map((c, i) => i === nearest ? { ...c, color: '#1e40af' } : c);
      s.flashMessages = [...(s.flashMessages || []), { text: '🚔🚔 ПОЛИЦИЯ ГОНИТСЯ!', timer: 150, color: '#3b82f6' }];
      s.cameraShake = 6;
      audio.push('police');
    }
  } else if (roll < 0.70) {
    // Earthquake — massive shake, danger
    s.activeEvent = { type: 'earthquake', timer: 180, x: 0, y: 0 };
    s.cameraShake = 20;
    s.flashMessages = [...(s.flashMessages || []), { text: '🌍💥 ЗЕМЛЕТРЯСЕНИЕ!', timer: 150, color: '#ef4444' }];
    newP.push(...spawnParticles(amb.x, amb.y, '#ef4444', 25, 'spark'));
    newP.push(...spawnParticles(amb.x - 100, amb.y - 100, '#fbbf24', 15, 'smoke'));
    audio.push('event');
  } else if (roll < 0.84) {
    // Blackout — screen goes very dark
    s.activeEvent = { type: 'blackout', timer: 360, x: 0, y: 0 };
    s.flashMessages = [...(s.flashMessages || []), { text: '💡⚫ БЛЭКАУТ! ТЕМНОТА!', timer: 150, color: '#374151' }];
    s.cameraShake = 5;
    audio.push('event');
  } else {
    // Breakdown — ambulance slows to crawl
    s.activeEvent = { type: 'breakdown', timer: 240, x: 0, y: 0 };
    s.flashMessages = [...(s.flashMessages || []), { text: '🔧💨 ПОЛОМКА! СКОРОСТЬ x0.5!', timer: 150, color: '#f59e0b' }];
    s.cameraShake = 8;
    newP.push(...spawnParticles(amb.x, amb.y, '#6b7280', 15, 'smoke'));
    audio.push('event');
  }
}

// ============ NEAR-MISS SYSTEM ============

function processNearMiss(s: GameState, amb: Ambulance, spd: number, audio: string[], newP: Particle[]): void {
  if (s.nearMissTimer > 0) { s.nearMissTimer--; }

  let gotNearMiss = false;
  for (const tc of s.trafficCars) {
    const td = dist(tc.x, tc.y, amb.x, amb.y);
    if (td > 25 && td < 55 && spd > 3) {
      gotNearMiss = true;
      break;
    }
  }

  if (gotNearMiss && s.nearMissTimer <= 0) {
    s.nearMissCombo++;
    s.nearMissTimer = 30;
    const bonus = 50 * s.nearMissCombo;
    s.score += bonus;
    s.money += Math.floor(bonus / 5);
    newP.push(...spawnParticles(amb.x, amb.y, '#a855f7', 5, 'spark'));
    const comboText = s.nearMissCombo > 1 ? ` x${s.nearMissCombo}!` : '!';
    s.flashMessages = [...(s.flashMessages || []), { text: `😎 МАСТЕРСТВО +${bonus}${comboText}`, timer: 45, color: '#a855f7' }];
    audio.push('nearmiss');
  }

  // Reset combo after 3 seconds of no near-miss
  if (!gotNearMiss && s.nearMissCombo > 0 && s.time % 180 === 0) {
    s.nearMissCombo = 0;
  }
}

// ============ DRIFT SYSTEM ============

function processDrift(s: GameState, amb: Ambulance, prevAngle: number, spd: number, maxSpd: number, audio: string[], newP: Particle[]): void {
  const angleDelta = Math.abs(amb.angle - prevAngle);
  const normalized = angleDelta > Math.PI ? Math.PI * 2 - angleDelta : angleDelta;

  if (spd > maxSpd * 0.55 && normalized > 0.12) {
    s.driftTimer = Math.min(60, (s.driftTimer || 0) + 2);
    s.isDrifting = true;
    if (s.time % 2 === 0) {
      newP.push({ x: amb.x - Math.cos(amb.angle) * 15, y: amb.y - Math.sin(amb.angle) * 15, vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3, life: 60, maxLife: 60, color: 'rgba(80,80,80,0.6)', size: 4, type: 'smoke' });
    }
  } else {
    if (s.driftTimer > 15) {
      const boost = 1 + Math.min(s.driftTimer, 45) * 0.015;
      amb.vx *= boost; amb.vy *= boost;
      const pts = Math.floor(s.driftTimer * 2);
      s.score += pts;
      s.flashMessages = [...(s.flashMessages || []), { text: `🏎 ДРИФТ! +${pts}`, timer: 45, color: '#f59e0b' }];
      newP.push(...spawnParticles(amb.x, amb.y, '#f59e0b', 8, 'spark'));
      audio.push('nearmiss');
    }
    s.driftTimer = 0;
    s.isDrifting = false;
  }
}

function updateAmbulanceMode(state: GameState, dt: number): GameState {
  if (!state.mission) return state;
  const s = { ...state };
  const mission = state.mission;
  const cs = mission.citySize;
  s.time = state.time + 1;
  const audio: string[] = [];

  const amb = { ...state.ambulance };
  const prevAngle = amb.angle;
  const nitroActive = amb.nitroTimer > 0;
  const coffeeActive = amb.coffeeTimer > 0;
  const breakdownActive = s.activeEvent?.type === 'breakdown';
  const accel = amb.acceleration * (nitroActive ? 2.0 : 1.0) * (breakdownActive ? 0.5 : 1.0);
  const maxSpd = amb.maxSpeed * (nitroActive ? 1.6 : 1.0) * (breakdownActive ? 0.5 : 1.0);
  const friction = coffeeActive ? 0.96 : amb.handling;
  const wf = state.weather === 'rain' ? 0.985 : 1.0;

  const keys = state.keys;
  if (keys.up) amb.vy -= accel;
  if (keys.down) amb.vy += accel;
  if (keys.left) amb.vx -= accel;
  if (keys.right) amb.vx += accel;
  amb.vx *= friction * wf; amb.vy *= friction * wf;

  const spd = Math.sqrt(amb.vx ** 2 + amb.vy ** 2);
  if (spd > maxSpd) { amb.vx = (amb.vx / spd) * maxSpd; amb.vy = (amb.vy / spd) * maxSpd; }
  if (spd > 0.5) amb.angle = Math.atan2(amb.vy, amb.vx);
  amb.speed = spd;

  let nx = amb.x + amb.vx, ny = amb.y + amb.vy;
  let hitB = false;
  let colCD = state.collisionCooldown > 0 ? state.collisionCooldown - 1 : 0;
  let newP = [...state.particles];

  const nearAmbBuildings = state.buildingGrid ? state.buildingGrid.queryNear(nx, ny, 60) : state.buildings;
  for (let pass = 0; pass < 3; pass++) {
    let resolved = true;
    for (const b of nearAmbBuildings) {
      if (Math.abs(nx - b.x - b.w / 2) > b.w / 2 + 25 && Math.abs(ny - b.y - b.h / 2) > b.h / 2 + 20) continue;
      const r = resolveRectCollision(nx - 20, ny - 14, 40, 28, b.x, b.y, b.w, b.h);
      if (r.hit) { nx += r.dx; ny += r.dy; hitB = true; resolved = false; if (r.dx !== 0) amb.vx = -amb.vx * 0.2; if (r.dy !== 0) amb.vy = -amb.vy * 0.2; }
    }
    if (resolved) break;
  }
  if (hitB && colCD <= 0 && spd > 2) { amb.health -= Math.floor(spd * 1.5); s.cameraShake = Math.min(12, spd * 2); newP.push(...spawnParticles(nx, ny, '#fbbf24', 6)); colCD = 15; audio.push('collision'); }
  s.collisionCooldown = colCD;
  amb.x = clamp(nx, 30, cs - 30); amb.y = clamp(ny, 30, cs - 30);
  if (amb.nitroTimer > 0) amb.nitroTimer -= dt;
  if (amb.megaphoneTimer > 0) amb.megaphoneTimer -= dt;
  if (amb.coffeeTimer > 0) amb.coffeeTimer -= dt;
  s.ambulance = amb;

  if (spd > 3 && s.time % 3 === 0) newP.push(...spawnParticles(nx - Math.cos(amb.angle) * 20, ny - Math.sin(amb.angle) * 20, nitroActive ? '#3b82f6' : '#9ca3af', 1, 'smoke'));

  // Traffic
  s.trafficCars = state.trafficCars.map((car, i) => {
    const c = { ...car };
    c.x += c.vx; c.y += c.vy;
    if (c.x < -200) c.x = cs + 200; if (c.x > cs + 200) c.x = -200;
    if (c.y < -200) c.y = cs + 200; if (c.y > cs + 200) c.y = -200;
    const nearCarBldgs2 = state.buildingGrid ? state.buildingGrid.queryNear(c.x, c.y, 50) : state.buildings;
    for (const b of nearCarBldgs2) {
      const r = resolveRectCollision(c.x - c.width / 2, c.y - c.height / 2, c.width, c.height, b.x, b.y, b.w, b.h);
      if (r.hit) { c.x += r.dx; c.y += r.dy; if (r.dx !== 0) c.vx = -c.vx; if (r.dy !== 0) c.vy = -c.vy; }
    }
    const d = dist(c.x, c.y, amb.x, amb.y);
    if (d < 150 + state.upgrades.siren * 50 && amb.sirenOn) { const dx = c.x - amb.x; const dy = c.y - amb.y; const len = Math.sqrt(dx * dx + dy * dy) || 1; c.x += (dx / len) * 2; c.y += (dy / len) * 2; if (c.honkTimer <= 0) c.honkTimer = 30; }
    // Aggressive blockers: ~17% of cars steer toward player
    if (i % 6 === 0 && d < 300 && d > 40) { const dx = amb.x - c.x; const dy = amb.y - c.y; const len = Math.sqrt(dx * dx + dy * dy) || 1; c.vx += (dx / len) * 0.25; c.vy += (dy / len) * 0.25; }
    if (c.honkTimer > 0) c.honkTimer--;
    // Honk when close
    if (d < 100 && c.honkTimer <= 0) c.honkTimer = 60;
    if (d < 35) { amb.vx += (amb.x - c.x) * 0.08; amb.vy += (amb.y - c.y) * 0.08; c.vx -= (amb.x - c.x) * 0.04; c.vy -= (amb.y - c.y) * 0.04; if (colCD <= 0) { amb.health -= 1; s.cameraShake = Math.max(s.cameraShake, 3); s.collisionCooldown = 10; } }
    return c;
  });

  // Spawn extra traffic when time is low (urgency)
  if (s.timeLeft < 15 && s.time % 120 === 0 && s.trafficCars.length < 45) {
    const pos = findRoadPosition(cs, state.buildings);
    const cc = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b'];
    const horiz = Math.random() < 0.5;
    s.trafficCars = [...s.trafficCars, { x: pos.x, y: pos.y, vx: horiz ? (Math.random() < 0.5 ? 1 : -1) * 2.5 : 0, vy: horiz ? 0 : (Math.random() < 0.5 ? 1 : -1) * 2.5, angle: 0, color: cc[Math.floor(Math.random() * cc.length)], width: 50, height: 28, lane: 0, honkTimer: 0 }];
  }

  // Patients
  s.patients = state.patients.map(p => {
    if (p.caught) return p;
    const pat = { ...p };
    const d = dist(pat.x, pat.y, amb.x, amb.y);
    pat.panicLevel = clamp(pat.panicLevel + (d < 200 ? 0.02 : -0.01), 0, 1);
    if (pat.stunTimer > 0) { pat.stunTimer -= dt; pat.vx *= 0.9; pat.vy *= 0.9; pat.x += pat.vx; pat.y += pat.vy; return pat; }

    // Patient sprint event: double speed
    const sprintMult = (s.activeEvent?.type === 'patientSprint' && s.activeEvent.data?.patIdx === state.patients.indexOf(p)) ? 2.0 : 1.0;
    const pSpd = (1.5 + pat.story.speed * (mission.difficulty * 0.12)) * (1 + pat.panicLevel * 1.2) * sprintMult;
    pat.dialogueTimer -= 1;
    // More frequent dialogue when health is low (calling for help)
    const maxDialogueWait = pat.health < 40 ? 60 + Math.random() * 60 : 120 + Math.random() * 180;
    if (pat.dialogueTimer <= 0) { pat.currentDialogue = pat.health < 30 ? 'Помогите...' : pat.story.dialogue[Math.floor(Math.random() * pat.story.dialogue.length)]; pat.dialogueTimer = maxDialogueWait; }
    // Hiding: high panic + far from ambulance = stop moving
    if (pat.panicLevel > 0.7 && d > 350 && Math.random() < 0.003) {
      pat.stunTimer = 2.5; pat.currentDialogue = 'Спрячусь здесь...'; pat.dialogueTimer = 90;
      return pat;
    }
    if (d < 250) { pat.angle = Math.atan2(pat.y - amb.y, pat.x - amb.x) + (Math.random() - 0.5) * pat.story.erratic; }
    else if (Math.random() < 0.02) { pat.angle += (Math.random() - 0.5) * 2; }

    let dx2 = pat.x + Math.cos(pat.angle) * pSpd, dy2 = pat.y + Math.sin(pat.angle) * pSpd;
    let patHit = false;
    const nearPatBldgs = state.buildingGrid ? state.buildingGrid.queryNear(dx2, dy2, 50) : state.buildings;
    for (let pass = 0; pass < 3; pass++) {
      let resolved = true;
      for (const b of nearPatBldgs) {
        if (Math.abs(dx2 - b.x - b.w / 2) > b.w / 2 + 15 && Math.abs(dy2 - b.y - b.h / 2) > b.h / 2 + 15) continue;
        const r = resolveRectCollision(dx2 - 10, dy2 - 10, 20, 20, b.x, b.y, b.w, b.h);
        if (r.hit) { dx2 += r.dx * 1.1; dy2 += r.dy * 1.1; patHit = true; resolved = false; }
      }
      if (resolved) break;
    }
    if (patHit) pat.angle += (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 2 + Math.random() * 0.5);
    pat.vx = dx2 - pat.x; pat.vy = dy2 - pat.y;
    pat.x = dx2; pat.y = dy2;
    if (pat.x < 50 || pat.x > cs - 50) { pat.angle = Math.PI - pat.angle; pat.x = clamp(pat.x, 50, cs - 50); }
    if (pat.y < 50 || pat.y > cs - 50) { pat.angle = -pat.angle; pat.y = clamp(pat.y, 50, cs - 50); }
    pat.health -= 0.008 * (1 + mission.difficulty * 0.4);
    return pat;
  });

  // Catches
  s.patients = s.patients.map(p => {
    if (p.caught) return p;
    const d = dist(p.x, p.y, amb.x, amb.y);
    if (d < CATCH_DISTANCE) {
      s.patientsCaughtThisMission++; s.totalSaved++; s.comboCount++; s.comboTimer = 180;
      s.score += 200 * mission.difficulty + Math.floor(s.timeLeft * 10 * (1 + s.comboCount * 0.5));
      s.money += 50 + mission.difficulty * 20;
      s.reputation = clamp(s.reputation + 5, 0, 100);
      newP.push(...spawnParticles(p.x, p.y, '#22c55e', 20, 'heart'), ...spawnParticles(p.x, p.y, '#fbbf24', 15, 'star'));
      s.flashMessages = [...(s.flashMessages || []), { text: `${p.story.emoji} ${p.story.name} спасён(а)!`, timer: 120, color: '#22c55e' }];
      audio.push('catch');
      return { ...p, caught: true };
    }
    return p;
  });

  if (keys.space && amb.megaphoneTimer > 0) {
    s.patients = s.patients.map(p => { if (p.caught) return p; return dist(p.x, p.y, amb.x, amb.y) < 200 ? { ...p, stunTimer: 3 } : p; });
    if (s.time % 5 === 0) newP.push(...spawnParticles(amb.x, amb.y, '#a855f7', 3));
  }

  if (s.patients.every(p => p.caught)) { s.screen = 'saved'; audio.push('win'); }
  else if (s.patients.some(p => !p.caught && p.health <= 0)) {
    const dp = s.patients.find(p => !p.caught && p.health <= 0);
    s.screen = 'failed'; s.totalFailed++; s.reputation = clamp(s.reputation - 10, 0, 100);
    if (dp) s.currentDialogue = dp.story.failedText;
    audio.push('fail');
  }
  if (amb.health <= 0) { s.screen = 'failed'; s.totalFailed++; s.reputation = clamp(s.reputation - 15, 0, 100); s.currentDialogue = 'Скорая разбита...'; newP.push(...spawnParticles(amb.x, amb.y, '#ef4444', 30)); audio.push('fail'); }

  // Powerups
  s.powerUps = state.powerUps.map(pu => {
    if (pu.collected) return pu;
    const d = dist(pu.x, pu.y, amb.x, amb.y);
    if (d < 45) {
      switch (pu.type) {
        case 'nitro': s.ambulance.nitroTimer = 5; s.flashMessages = [...(s.flashMessages || []), { text: '⚡ НИТРО!', timer: 60, color: '#3b82f6' }]; break;
        case 'medkit': s.timeLeft += 8; s.flashMessages = [...(s.flashMessages || []), { text: '➕ +8 сек!', timer: 60, color: '#ef4444' }]; break;
        case 'megaphone': s.ambulance.megaphoneTimer = 10; s.flashMessages = [...(s.flashMessages || []), { text: '📢 Мегафон!', timer: 90, color: '#a855f7' }]; break;
        case 'coffee': s.ambulance.coffeeTimer = 8; s.flashMessages = [...(s.flashMessages || []), { text: '☕ Кофе!', timer: 60, color: '#92400e' }]; break;
      }
      newP.push(...spawnParticles(pu.x, pu.y, '#fbbf24', 10));
      audio.push('powerup');
      return { ...pu, collected: true };
    }
    return pu;
  });

  // === DYNAMIC EVENTS + NEAR-MISS + DRIFT ===
  // Speed bonus (kept simple)
  if (spd > maxSpd * 0.7 && s.time % 120 === 0 && !hitB) {
    s.score += 50;
    newP.push(...spawnParticles(amb.x, amb.y, '#fbbf24', 5, 'star'));
    s.flashMessages = [...(s.flashMessages || []), { text: '⚡ Бонус за скорость!', timer: 60, color: '#fbbf24' }];
  }
  // Combo streak reward
  if (s.comboCount >= 3 && s.comboTimer === 179) {
    s.timeLeft += 3; s.money += 30;
    s.flashMessages = [...(s.flashMessages || []), { text: `🔥 КОМБО x${s.comboCount}! +3сек +💰30`, timer: 90, color: '#c084fc' }];
  }
  // Dynamic events system
  processDynamicEvents(s, amb, audio, newP);
  // Near-miss combo
  processNearMiss(s, amb, spd, audio, newP);
  // Drift mechanic
  processDrift(s, amb, prevAngle, spd, maxSpd, audio, newP);

  s.timeLeft -= dt;
  if (s.timeLeft <= 0 && s.screen === 'playing') { s.timeLeft = 0; s.screen = 'failed'; s.totalFailed++; s.reputation = clamp(s.reputation - 10, 0, 100); s.currentDialogue = 'Время вышло...'; audio.push('fail'); }
  if (s.comboTimer > 0) s.comboTimer -= 1; else s.comboCount = 0;

  s.cameraX += (amb.x - s.cameraX) * 0.08;
  s.cameraY += (amb.y - s.cameraY) * 0.08;
  if (s.cameraShake > 0) { s.cameraShake *= 0.9; if (s.cameraShake < 0.3) s.cameraShake = 0; }

  newP = newP.map(p => ({ ...p, x: p.x + p.vx, y: p.y + p.vy, life: p.life - 1, vy: p.type === 'rain' ? p.vy : p.vy + 0.03, vx: p.vx * 0.99 })).filter(p => p.life > 0);
  if (state.weather === 'rain' && s.time % 2 === 0) for (let i = 0; i < 5; i++) newP.push({ x: s.cameraX + (Math.random() - 0.5) * 1200, y: s.cameraY - 400, vx: -1, vy: 8 + Math.random() * 4, life: 60, maxLife: 60, color: 'rgba(150,200,255,0.3)', size: 1, type: 'rain' });

  s.particles = newP;
  s.flashMessages = (s.flashMessages || []).map(m => ({ ...m, timer: m.timer - 1 })).filter(m => m.timer > 0);
  if (s.transitionAlpha > 0) s.transitionAlpha = Math.max(0, s.transitionAlpha - 0.04);
  s.audioEvents = audio;
  return s;
}

// === MULTIPLAYER UPDATE FUNCTIONS ===

// Helper: update ambulance physics given keys (reused by MP modes)
function updateAmbulancePhysics(
  amb: Ambulance, keys: import('./types').Keys, state: GameState, dt: number,
  audio: string[], newP: Particle[]
): { amb: Ambulance; hitB: boolean } {
  const mission = state.mission;
  const cs = mission?.citySize || 2000;
  const nitroActive = amb.nitroTimer > 0;
  const coffeeActive = amb.coffeeTimer > 0;
  const accel = amb.acceleration * (nitroActive ? 2.0 : 1.0);
  const maxSpd = amb.maxSpeed * (nitroActive ? 1.6 : 1.0);
  const friction = coffeeActive ? 0.96 : amb.handling;
  const wf = state.weather === 'rain' ? 0.985 : 1.0;

  if (keys.up) amb.vy -= accel;
  if (keys.down) amb.vy += accel;
  if (keys.left) amb.vx -= accel;
  if (keys.right) amb.vx += accel;
  amb.vx *= friction * wf; amb.vy *= friction * wf;

  const spd = Math.sqrt(amb.vx ** 2 + amb.vy ** 2);
  if (spd > maxSpd) { amb.vx = (amb.vx / spd) * maxSpd; amb.vy = (amb.vy / spd) * maxSpd; }
  if (spd > 0.5) amb.angle = Math.atan2(amb.vy, amb.vx);
  amb.speed = spd;

  let nx = amb.x + amb.vx, ny = amb.y + amb.vy;
  let hitB = false;
  const nearBuildings = state.buildingGrid ? state.buildingGrid.queryNear(nx, ny, 60) : state.buildings;
  for (let pass = 0; pass < 3; pass++) {
    let resolved = true;
    for (const b of nearBuildings) {
      if (Math.abs(nx - b.x - b.w / 2) > b.w / 2 + 25 && Math.abs(ny - b.y - b.h / 2) > b.h / 2 + 20) continue;
      const r = resolveRectCollision(nx - 20, ny - 14, 40, 28, b.x, b.y, b.w, b.h);
      if (r.hit) { nx += r.dx; ny += r.dy; hitB = true; resolved = false; if (r.dx !== 0) amb.vx = -amb.vx * 0.2; if (r.dy !== 0) amb.vy = -amb.vy * 0.2; }
    }
    if (resolved) break;
  }
  if (hitB && spd > 2) { amb.health -= Math.floor(spd * 1.5); newP.push(...spawnParticles(nx, ny, '#fbbf24', 6)); audio.push('collision'); }

  amb.x = clamp(nx, 30, cs - 30); amb.y = clamp(ny, 30, cs - 30);
  if (amb.nitroTimer > 0) amb.nitroTimer -= dt;
  if (amb.megaphoneTimer > 0) amb.megaphoneTimer -= dt;
  if (amb.coffeeTimer > 0) amb.coffeeTimer -= dt;

  return { amb, hitB };
}

// Helper: update runner physics given keys
function updateRunnerPhysics(
  runner: import('./types').RunnerPlayer, keys: import('./types').Keys, state: GameState, dt: number
): import('./types').RunnerPlayer {
  const cs = state.mission?.citySize || 2000;
  const isSprinting = keys.space && runner.stamina > 5;
  runner.sprinting = isSprinting;
  const baseSpeed = 3.5;
  const sprintMult = isSprinting ? 1.6 : 1.0;
  const boostMult = runner.speedBoostTimer > 0 ? 1.3 : 1.0;
  const moveSpeed = baseSpeed * sprintMult * boostMult;
  const accel = 0.5;
  if (keys.up) runner.vy -= accel;
  if (keys.down) runner.vy += accel;
  if (keys.left) runner.vx -= accel;
  if (keys.right) runner.vx += accel;
  runner.vx *= 0.88; runner.vy *= 0.88;
  const spd = Math.sqrt(runner.vx ** 2 + runner.vy ** 2);
  if (spd > moveSpeed) { runner.vx = (runner.vx / spd) * moveSpeed; runner.vy = (runner.vy / spd) * moveSpeed; }
  if (spd > 0.3) runner.angle = Math.atan2(runner.vy, runner.vx);
  runner.speed = spd;
  if (isSprinting) runner.stamina = Math.max(0, runner.stamina - 25 * dt);
  else runner.stamina = Math.min(runner.maxStamina, runner.stamina + 12 * dt);
  let nrx = runner.x + runner.vx, nry = runner.y + runner.vy;
  const nearBldgs = state.buildingGrid ? state.buildingGrid.queryNear(nrx, nry, 60) : state.buildings;
  for (let pass = 0; pass < 3; pass++) {
    let resolved = true;
    for (const b of nearBldgs) {
      if (Math.abs(nrx - b.x - b.w / 2) > b.w / 2 + 15 && Math.abs(nry - b.y - b.h / 2) > b.h / 2 + 15) continue;
      const r = resolveRectCollision(nrx - 8, nry - 8, 16, 16, b.x, b.y, b.w, b.h);
      if (r.hit) { nrx += r.dx; nry += r.dy; resolved = false; if (r.dx !== 0) runner.vx = 0; if (r.dy !== 0) runner.vy = 0; }
    }
    if (resolved) break;
  }
  runner.x = clamp(nrx, 30, cs - 30); runner.y = clamp(nry, 30, cs - 30);
  if (runner.smokeBombTimer > 0) runner.smokeBombTimer -= dt;
  if (runner.invisibleTimer > 0) runner.invisibleTimer -= dt;
  if (runner.speedBoostTimer > 0) runner.speedBoostTimer -= dt;
  if (runner.caughtTimer > 0) runner.caughtTimer -= dt;
  if (runner.dashCooldown > 0) runner.dashCooldown -= dt;
  return runner;
}

// Helper: ambulance-ambulance collision
function resolveAmbulanceCollision(a1: Ambulance, a2: Ambulance, damageMultiplier: number, audio: string[], newP: Particle[]) {
  const d = dist(a1.x, a1.y, a2.x, a2.y);
  if (d < 50 && d > 0) {
    const nx = (a2.x - a1.x) / d;
    const ny = (a2.y - a1.y) / d;
    const relVx = a1.vx - a2.vx;
    const relVy = a1.vy - a2.vy;
    const relSpeed = relVx * nx + relVy * ny;
    if (relSpeed > 0) {
      const impulse = relSpeed * 0.5;
      a1.vx -= impulse * nx; a1.vy -= impulse * ny;
      a2.vx += impulse * nx; a2.vy += impulse * ny;
      // Push apart
      const overlap = 50 - d;
      a1.x -= nx * overlap * 0.5; a1.y -= ny * overlap * 0.5;
      a2.x += nx * overlap * 0.5; a2.y += ny * overlap * 0.5;
      // Damage
      const dmg = Math.floor(relSpeed * damageMultiplier);
      if (dmg > 0) {
        a1.health -= dmg; a2.health -= dmg;
        newP.push(...spawnParticles((a1.x + a2.x) / 2, (a1.y + a2.y) / 2, '#fbbf24', 10));
        audio.push('collision');
      }
    }
  }
}

// CO-OP RESCUE: Two ambulances saving patients together
function updateCoopRescue(state: GameState, dt: number): GameState {
  if (!state.mission || !state.mp) return state;
  const s = { ...state };
  const mp = { ...state.mp };
  const mission = state.mission;
  const cs = mission.citySize;
  s.time = state.time + 1;
  const audio: string[] = [];
  let newP = [...state.particles];

  // Update both ambulances
  const k1 = state.keys; // Host keys (P1)
  const k2 = mp.remotePlayer.keys; // Guest keys (P2)

  const amb1 = { ...state.ambulance };
  const { amb: updatedAmb1 } = updateAmbulancePhysics(amb1, k1, state, dt, audio, newP);
  s.ambulance = updatedAmb1;

  const amb2 = { ...(mp.ambulance2 || state.ambulance) };
  const { amb: updatedAmb2 } = updateAmbulancePhysics(amb2, k2, state, dt, audio, newP);

  // Ambulance-ambulance collision (no damage, just push)
  resolveAmbulanceCollision(updatedAmb1, updatedAmb2, 0, audio, newP);
  s.ambulance = updatedAmb1;
  mp.ambulance2 = updatedAmb2;

  // Traffic
  s.trafficCars = state.trafficCars.map(car => {
    const c = { ...car };
    c.x += c.vx; c.y += c.vy;
    if (c.x < -200) c.x = cs + 200; if (c.x > cs + 200) c.x = -200;
    if (c.y < -200) c.y = cs + 200; if (c.y > cs + 200) c.y = -200;
    return c;
  });

  // Patients (flee from nearest ambulance)
  s.patients = state.patients.map(p => {
    if (p.caught) return p;
    const pat = { ...p };
    const d1 = dist(pat.x, pat.y, updatedAmb1.x, updatedAmb1.y);
    const d2 = dist(pat.x, pat.y, updatedAmb2.x, updatedAmb2.y);
    const nearestAmb = d1 < d2 ? updatedAmb1 : updatedAmb2;
    const nearD = Math.min(d1, d2);
    pat.panicLevel = clamp(pat.panicLevel + (nearD < 200 ? 0.02 : -0.01), 0, 1);
    if (pat.stunTimer > 0) { pat.stunTimer -= dt; pat.vx *= 0.9; pat.vy *= 0.9; pat.x += pat.vx; pat.y += pat.vy; return pat; }
    const pSpd = (1.5 + pat.story.speed * (mission.difficulty * 0.12)) * (1 + pat.panicLevel * 1.2);
    if (nearD < 250) { pat.angle = Math.atan2(pat.y - nearestAmb.y, pat.x - nearestAmb.x) + (Math.random() - 0.5) * pat.story.erratic; }
    else if (Math.random() < 0.02) { pat.angle += (Math.random() - 0.5) * 2; }
    pat.x += Math.cos(pat.angle) * pSpd; pat.y += Math.sin(pat.angle) * pSpd;
    pat.x = clamp(pat.x, 50, cs - 50); pat.y = clamp(pat.y, 50, cs - 50);
    pat.health -= 0.008 * (1 + mission.difficulty * 0.4);
    return pat;
  });

  // Catches from both ambulances
  let score1 = mp.scores[0], score2 = mp.scores[1];
  s.patients = s.patients.map(p => {
    if (p.caught) return p;
    const d1 = dist(p.x, p.y, updatedAmb1.x, updatedAmb1.y);
    const d2 = dist(p.x, p.y, updatedAmb2.x, updatedAmb2.y);
    if (d1 < CATCH_DISTANCE) {
      s.totalSaved++; score1 += 200; s.money += 50;
      newP.push(...spawnParticles(p.x, p.y, '#22c55e', 20, 'heart'));
      s.flashMessages = [...(s.flashMessages || []), { text: `P1: ${p.story.emoji} ${p.story.name} спасён(а)!`, timer: 120, color: '#ef4444' }];
      audio.push('catch');
      return { ...p, caught: true };
    }
    if (d2 < CATCH_DISTANCE) {
      s.totalSaved++; score2 += 200; s.money += 50;
      newP.push(...spawnParticles(p.x, p.y, '#22c55e', 20, 'heart'));
      s.flashMessages = [...(s.flashMessages || []), { text: `P2: ${p.story.emoji} ${p.story.name} спасён(а)!`, timer: 120, color: '#60a5fa' }];
      audio.push('catch');
      return { ...p, caught: true };
    }
    return p;
  });
  mp.scores = [score1, score2];
  s.score = score1 + score2;

  // Powerups (both can pick up)
  s.powerUps = state.powerUps.map(pu => {
    if (pu.collected) return pu;
    const d1 = dist(pu.x, pu.y, updatedAmb1.x, updatedAmb1.y);
    const d2 = dist(pu.x, pu.y, updatedAmb2.x, updatedAmb2.y);
    if (d1 < 45 || d2 < 45) {
      const target = d1 < d2 ? updatedAmb1 : updatedAmb2;
      if (pu.type === 'nitro') target.nitroTimer = 5;
      else if (pu.type === 'medkit') s.timeLeft += 8;
      else if (pu.type === 'megaphone') target.megaphoneTimer = 10;
      else if (pu.type === 'coffee') target.coffeeTimer = 8;
      newP.push(...spawnParticles(pu.x, pu.y, '#fbbf24', 10));
      audio.push('powerup');
      return { ...pu, collected: true };
    }
    return pu;
  });

  // Dynamic events + near-miss + drift (coop)
  processDynamicEvents(s, updatedAmb1, audio, newP);
  const spd1 = Math.sqrt(updatedAmb1.vx ** 2 + updatedAmb1.vy ** 2);
  processNearMiss(s, updatedAmb1, spd1, audio, newP);

  // Win/lose conditions
  if (s.patients.every(p => p.caught)) { s.screen = 'saved'; audio.push('win'); }
  else if (s.patients.some(p => !p.caught && p.health <= 0)) { s.screen = 'failed'; audio.push('fail'); }
  if (updatedAmb1.health <= 0 && updatedAmb2.health <= 0) { s.screen = 'failed'; audio.push('fail'); }

  s.timeLeft -= dt;
  if (s.timeLeft <= 0 && s.screen === 'playing') { s.timeLeft = 0; s.screen = 'failed'; audio.push('fail'); }

  s.cameraX += (updatedAmb1.x - s.cameraX) * 0.08;
  s.cameraY += (updatedAmb1.y - s.cameraY) * 0.08;
  if (s.cameraShake > 0) { s.cameraShake *= 0.9; if (s.cameraShake < 0.3) s.cameraShake = 0; }

  newP = newP.map(p => ({ ...p, x: p.x + p.vx, y: p.y + p.vy, life: p.life - 1, vy: p.type === 'rain' ? p.vy : p.vy + 0.03, vx: p.vx * 0.99 })).filter(p => p.life > 0);
  s.particles = newP;
  s.flashMessages = (s.flashMessages || []).map(m => ({ ...m, timer: m.timer - 1 })).filter(m => m.timer > 0);
  if (s.transitionAlpha > 0) s.transitionAlpha = Math.max(0, s.transitionAlpha - 0.04);
  s.mp = mp;
  s.audioEvents = audio;
  return s;
}

// COPS & ROBBERS: P1 ambulance chases P2 runner
function updateCopsAndRobbers(state: GameState, dt: number): GameState {
  if (!state.mission || !state.mp) return state;
  const s = { ...state };
  const mp = { ...state.mp };
  const cs = state.mission.citySize;
  s.time = state.time + 1;
  const audio: string[] = [];
  let newP = [...state.particles];

  // P1: ambulance (host keys)
  const amb = { ...state.ambulance };
  const { amb: updatedAmb } = updateAmbulancePhysics(amb, state.keys, state, dt, audio, newP);
  s.ambulance = updatedAmb;

  // P2: runner (guest keys)
  let runner = { ...(mp.runner2!) };
  runner = updateRunnerPhysics(runner, mp.remotePlayer.keys, state, dt);
  mp.runner2 = runner;

  // Traffic
  s.trafficCars = state.trafficCars.map(car => {
    const c = { ...car }; c.x += c.vx; c.y += c.vy;
    if (c.x < -200) c.x = cs + 200; if (c.x > cs + 200) c.x = -200;
    if (c.y < -200) c.y = cs + 200; if (c.y > cs + 200) c.y = -200;
    return c;
  });

  // Catch detection: ambulance catches runner
  const catchD = dist(updatedAmb.x, updatedAmb.y, runner.x, runner.y);
  if (catchD < CATCH_DISTANCE && runner.caughtTimer <= 0 && runner.invisibleTimer <= 0) {
    mp.scores = [mp.scores[0] + 1, mp.scores[1]];
    s.flashMessages = [...(s.flashMessages || []), { text: '🚔 ПОЙМАЛ! Скорая победила!', timer: 150, color: '#ef4444' }];
    newP.push(...spawnParticles(runner.x, runner.y, '#ef4444', 30, 'star'));
    audio.push('catch');
    s.screen = 'saved'; // ambulance won
  }

  // Bonus patients for ambulance to collect (extra score)
  s.patients = state.patients.map(p => {
    if (p.caught) return p;
    const d = dist(p.x, p.y, updatedAmb.x, updatedAmb.y);
    if (d < CATCH_DISTANCE) {
      mp.scores = [mp.scores[0] + 100, mp.scores[1]];
      newP.push(...spawnParticles(p.x, p.y, '#22c55e', 10, 'heart'));
      audio.push('powerup');
      return { ...p, caught: true };
    }
    return p;
  });

  // Powerups for runner
  s.powerUps = state.powerUps.map(pu => {
    if (pu.collected) return pu;
    const dr = dist(pu.x, pu.y, runner.x, runner.y);
    if (dr < 35) {
      if (pu.type === 'smokebomb') runner.invisibleTimer = 3;
      else if (pu.type === 'energy') runner.speedBoostTimer = 4;
      else if (pu.type === 'coffee') runner.speedBoostTimer = 3;
      else if (pu.type === 'nitro') { updatedAmb.nitroTimer = 5; } // ambulance powerup
      newP.push(...spawnParticles(pu.x, pu.y, '#fbbf24', 8));
      audio.push('powerup');
      return { ...pu, collected: true };
    }
    return pu;
  });

  s.timeLeft -= dt;
  if (s.timeLeft <= 0 && s.screen === 'playing') {
    s.timeLeft = 0;
    mp.scores = [mp.scores[0], mp.scores[1] + 1];
    s.flashMessages = [...(s.flashMessages || []), { text: '🏃 Время вышло! Бегун выиграл!', timer: 150, color: '#60a5fa' }];
    audio.push('win');
    s.screen = 'saved';
  }

  // Camera follows ambulance (host perspective)
  s.cameraX += (updatedAmb.x - s.cameraX) * 0.08;
  s.cameraY += (updatedAmb.y - s.cameraY) * 0.08;
  if (s.cameraShake > 0) { s.cameraShake *= 0.9; if (s.cameraShake < 0.3) s.cameraShake = 0; }

  newP = newP.map(p => ({ ...p, x: p.x + p.vx, y: p.y + p.vy, life: p.life - 1, vy: p.type === 'rain' ? p.vy : p.vy + 0.03, vx: p.vx * 0.99 })).filter(p => p.life > 0);
  s.particles = newP;
  s.flashMessages = (s.flashMessages || []).map(m => ({ ...m, timer: m.timer - 1 })).filter(m => m.timer > 0);
  if (s.transitionAlpha > 0) s.transitionAlpha = Math.max(0, s.transitionAlpha - 0.04);
  s.mp = mp;
  s.audioEvents = audio;
  return s;
}

// DEMOLITION DERBY: Two ambulances ram each other, HP combat
function updateDemolitionDerby(state: GameState, dt: number): GameState {
  if (!state.mission || !state.mp) return state;
  const s = { ...state };
  const mp = { ...state.mp };
  const cs = state.mission.citySize;
  s.time = state.time + 1;
  const audio: string[] = [];
  let newP = [...state.particles];

  // Both ambulances
  const amb1 = { ...state.ambulance };
  const { amb: a1 } = updateAmbulancePhysics(amb1, state.keys, state, dt, audio, newP);

  const amb2 = { ...(mp.ambulance2 || state.ambulance) };
  const { amb: a2 } = updateAmbulancePhysics(amb2, mp.remotePlayer.keys, state, dt, audio, newP);

  // High-damage ambulance-ambulance collision
  resolveAmbulanceCollision(a1, a2, 2.0, audio, newP);
  s.ambulance = a1;
  mp.ambulance2 = a2;

  // Traffic
  s.trafficCars = state.trafficCars.map(car => {
    const c = { ...car }; c.x += c.vx; c.y += c.vy;
    if (c.x < -200) c.x = cs + 200; if (c.x > cs + 200) c.x = -200;
    if (c.y < -200) c.y = cs + 200; if (c.y > cs + 200) c.y = -200;
    // Collision with ambulances
    const d1 = dist(c.x, c.y, a1.x, a1.y);
    if (d1 < 35) { a1.vx += (a1.x - c.x) * 0.05; a1.vy += (a1.y - c.y) * 0.05; }
    const d2 = dist(c.x, c.y, a2.x, a2.y);
    if (d2 < 35) { a2.vx += (a2.x - c.x) * 0.05; a2.vy += (a2.y - c.y) * 0.05; }
    return c;
  });

  // Powerups: nitro + medkit
  s.powerUps = state.powerUps.map(pu => {
    if (pu.collected) return pu;
    const d1 = dist(pu.x, pu.y, a1.x, a1.y);
    const d2 = dist(pu.x, pu.y, a2.x, a2.y);
    if (d1 < 45) {
      if (pu.type === 'nitro') a1.nitroTimer = 5;
      else if (pu.type === 'medkit') a1.health = Math.min(a1.health + 30, 100 + state.upgrades.armor * 25);
      newP.push(...spawnParticles(pu.x, pu.y, '#fbbf24', 8)); audio.push('powerup');
      return { ...pu, collected: true };
    }
    if (d2 < 45) {
      if (pu.type === 'nitro') a2.nitroTimer = 5;
      else if (pu.type === 'medkit') a2.health = Math.min(a2.health + 30, 100 + state.upgrades.armor * 25);
      newP.push(...spawnParticles(pu.x, pu.y, '#fbbf24', 8)); audio.push('powerup');
      return { ...pu, collected: true };
    }
    return pu;
  });

  // Win condition: opponent HP <= 0
  if (a1.health <= 0 && s.screen === 'playing') {
    mp.derbyWins = [mp.derbyWins[0], mp.derbyWins[1] + 1];
    s.flashMessages = [...(s.flashMessages || []), { text: '💥 P2 выиграл раунд!', timer: 120, color: '#60a5fa' }];
    newP.push(...spawnParticles(a1.x, a1.y, '#ef4444', 40));
    audio.push('fail');
    if (mp.derbyWins[1] >= 2) { s.screen = 'saved'; } else { mp.derbyRound++; s.screen = 'saved'; }
  }
  if (a2.health <= 0 && s.screen === 'playing') {
    mp.derbyWins = [mp.derbyWins[0] + 1, mp.derbyWins[1]];
    s.flashMessages = [...(s.flashMessages || []), { text: '💥 P1 выиграл раунд!', timer: 120, color: '#ef4444' }];
    newP.push(...spawnParticles(a2.x, a2.y, '#ef4444', 40));
    audio.push('win');
    if (mp.derbyWins[0] >= 2) { s.screen = 'saved'; } else { mp.derbyRound++; s.screen = 'saved'; }
  }

  mp.scores = [Math.round(a1.health), Math.round(a2.health)];

  s.cameraX += (a1.x - s.cameraX) * 0.08;
  s.cameraY += (a1.y - s.cameraY) * 0.08;
  s.cameraShake = Math.max(s.cameraShake * 0.9, 0);

  newP = newP.map(p => ({ ...p, x: p.x + p.vx, y: p.y + p.vy, life: p.life - 1, vy: p.type === 'rain' ? p.vy : p.vy + 0.03, vx: p.vx * 0.99 })).filter(p => p.life > 0);
  s.particles = newP;
  s.flashMessages = (s.flashMessages || []).map(m => ({ ...m, timer: m.timer - 1 })).filter(m => m.timer > 0);
  if (s.transitionAlpha > 0) s.transitionAlpha = Math.max(0, s.transitionAlpha - 0.04);
  s.mp = mp;
  s.audioEvents = audio;
  return s;
}

// PATIENT RACE: Two ambulances compete to catch more patients
function updatePatientRace(state: GameState, dt: number): GameState {
  if (!state.mission || !state.mp) return state;
  const s = { ...state };
  const mp = { ...state.mp };
  const mission = state.mission;
  const cs = mission.citySize;
  s.time = state.time + 1;
  const audio: string[] = [];
  let newP = [...state.particles];

  // Both ambulances
  const amb1 = { ...state.ambulance };
  const { amb: a1 } = updateAmbulancePhysics(amb1, state.keys, state, dt, audio, newP);

  const amb2 = { ...(mp.ambulance2 || state.ambulance) };
  const { amb: a2 } = updateAmbulancePhysics(amb2, mp.remotePlayer.keys, state, dt, audio, newP);

  // Ambulance collision: blocking (slow down, no big damage)
  resolveAmbulanceCollision(a1, a2, 0.5, audio, newP);
  s.ambulance = a1;
  mp.ambulance2 = a2;

  // Traffic
  s.trafficCars = state.trafficCars.map(car => {
    const c = { ...car }; c.x += c.vx; c.y += c.vy;
    if (c.x < -200) c.x = cs + 200; if (c.x > cs + 200) c.x = -200;
    if (c.y < -200) c.y = cs + 200; if (c.y > cs + 200) c.y = -200;
    return c;
  });

  // Patients flee from nearest ambulance
  s.patients = state.patients.map(p => {
    if (p.caught) return p;
    const pat = { ...p };
    const d1 = dist(pat.x, pat.y, a1.x, a1.y);
    const d2 = dist(pat.x, pat.y, a2.x, a2.y);
    const nearestAmb = d1 < d2 ? a1 : a2;
    const nearD = Math.min(d1, d2);
    pat.panicLevel = clamp(pat.panicLevel + (nearD < 200 ? 0.02 : -0.01), 0, 1);
    if (pat.stunTimer > 0) { pat.stunTimer -= dt; pat.vx *= 0.9; pat.vy *= 0.9; pat.x += pat.vx; pat.y += pat.vy; return pat; }
    const pSpd = (1.5 + pat.story.speed * (mission.difficulty * 0.12)) * (1 + pat.panicLevel * 1.2);
    if (nearD < 250) { pat.angle = Math.atan2(pat.y - nearestAmb.y, pat.x - nearestAmb.x) + (Math.random() - 0.5) * pat.story.erratic; }
    else if (Math.random() < 0.02) { pat.angle += (Math.random() - 0.5) * 2; }
    pat.x += Math.cos(pat.angle) * pSpd; pat.y += Math.sin(pat.angle) * pSpd;
    pat.x = clamp(pat.x, 50, cs - 50); pat.y = clamp(pat.y, 50, cs - 50);
    return pat;
  });

  // Exclusive catches
  let score1 = mp.scores[0], score2 = mp.scores[1];
  s.patients = s.patients.map(p => {
    if (p.caught) return p;
    const d1 = dist(p.x, p.y, a1.x, a1.y);
    const d2 = dist(p.x, p.y, a2.x, a2.y);
    // First one to reach catches
    if (d1 < CATCH_DISTANCE && d1 <= d2) {
      score1 += 1;
      newP.push(...spawnParticles(p.x, p.y, '#ef4444', 15, 'heart'));
      s.flashMessages = [...(s.flashMessages || []), { text: `🔴 P1: ${p.story.name}!`, timer: 90, color: '#ef4444' }];
      audio.push('catch');
      return { ...p, caught: true };
    }
    if (d2 < CATCH_DISTANCE && d2 < d1) {
      score2 += 1;
      newP.push(...spawnParticles(p.x, p.y, '#60a5fa', 15, 'heart'));
      s.flashMessages = [...(s.flashMessages || []), { text: `🔵 P2: ${p.story.name}!`, timer: 90, color: '#60a5fa' }];
      audio.push('catch');
      return { ...p, caught: true };
    }
    return p;
  });
  mp.scores = [score1, score2];
  s.score = score1 + score2;

  // Powerups
  s.powerUps = state.powerUps.map(pu => {
    if (pu.collected) return pu;
    const d1 = dist(pu.x, pu.y, a1.x, a1.y);
    const d2 = dist(pu.x, pu.y, a2.x, a2.y);
    if (d1 < 45 || d2 < 45) {
      const target = d1 < d2 ? a1 : a2;
      if (pu.type === 'nitro') target.nitroTimer = 5;
      else if (pu.type === 'medkit') s.timeLeft += 5;
      else if (pu.type === 'megaphone') target.megaphoneTimer = 8;
      newP.push(...spawnParticles(pu.x, pu.y, '#fbbf24', 8)); audio.push('powerup');
      return { ...pu, collected: true };
    }
    return pu;
  });

  s.timeLeft -= dt;
  if (s.timeLeft <= 0 && s.screen === 'playing') {
    s.timeLeft = 0;
    const winner = score1 > score2 ? 'P1' : score2 > score1 ? 'P2' : 'Ничья';
    s.flashMessages = [...(s.flashMessages || []), { text: `🏁 ${winner} победил! [${score1}-${score2}]`, timer: 180, color: '#fbbf24' }];
    audio.push(score1 >= score2 ? 'win' : 'fail');
    s.screen = 'saved';
  }

  // All patients caught = early end
  if (s.patients.every(p => p.caught) && s.screen === 'playing') {
    const winner = score1 > score2 ? 'P1' : score2 > score1 ? 'P2' : 'Ничья';
    s.flashMessages = [...(s.flashMessages || []), { text: `🏁 ${winner} победил! [${score1}-${score2}]`, timer: 180, color: '#fbbf24' }];
    audio.push(score1 >= score2 ? 'win' : 'fail');
    s.screen = 'saved';
  }

  s.cameraX += (a1.x - s.cameraX) * 0.08;
  s.cameraY += (a1.y - s.cameraY) * 0.08;
  if (s.cameraShake > 0) { s.cameraShake *= 0.9; if (s.cameraShake < 0.3) s.cameraShake = 0; }

  newP = newP.map(p => ({ ...p, x: p.x + p.vx, y: p.y + p.vy, life: p.life - 1, vy: p.type === 'rain' ? p.vy : p.vy + 0.03, vx: p.vx * 0.99 })).filter(p => p.life > 0);
  s.particles = newP;
  s.flashMessages = (s.flashMessages || []).map(m => ({ ...m, timer: m.timer - 1 })).filter(m => m.timer > 0);
  if (s.transitionAlpha > 0) s.transitionAlpha = Math.max(0, s.transitionAlpha - 0.04);
  s.mp = mp;
  s.audioEvents = audio;
  return s;
}

export function updateGame(state: GameState, dt: number): GameState {
  if (state.screen !== 'playing') return state;

  // Multiplayer modes
  if (state.mp?.isMultiplayer) {
    switch (state.gameMode) {
      case 'coopRescue': return updateCoopRescue(state, dt);
      case 'copsAndRobbers': return updateCopsAndRobbers(state, dt);
      case 'demolitionDerby': return updateDemolitionDerby(state, dt);
      case 'patientRace': return updatePatientRace(state, dt);
    }
  }

  // Solo modes
  if (state.gameMode === 'runner' || state.gameMode === 'extremal') return updateRunnerMode(state, dt);
  return updateAmbulanceMode(state, dt);
}

export function applyUpgrade(state: GameState, type: keyof Upgrades): GameState {
  const cost = (state.upgrades[type] + 1) * 100;
  if (state.money < cost || state.upgrades[type] >= 3) return state;
  return { ...state, money: state.money - cost, upgrades: { ...state.upgrades, [type]: state.upgrades[type] + 1 } };
}

export { MISSIONS };
