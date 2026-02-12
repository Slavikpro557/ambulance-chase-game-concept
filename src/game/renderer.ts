import { GameState, Building, Patient, PowerUp, TrafficCar, RunnerPlayer, Ambulance, Hazard, Barrier } from './types';
import { MISSIONS } from './missions';
import { MP_MISSIONS } from './mpMissions';

/** Pick the right mission array based on game state (MP coopRescue uses MP_MISSIONS) */
function getMissionsR(state: GameState) {
  return (state.mp?.isMultiplayer && state.mp.multiplayerMode === 'coopRescue') ? MP_MISSIONS : MISSIONS;
}

// ===== HELPERS =====

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const test = line + (line ? ' ' : '') + word;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = word; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function darken(hex: string, f: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${Math.floor(r * f)},${Math.floor(g * f)},${Math.floor(b * f)})`;
}

// Scale factor for fonts: proportional to screen but with sane limits
function sf(w: number, h: number): number {
  const short = Math.min(w, h);
  return Math.max(0.65, Math.min(1.2, short / 500));
}

// ===== MAIN RENDER =====

export function render(ctx: CanvasRenderingContext2D, state: GameState) {
  const w = ctx.canvas.width, h = ctx.canvas.height, time = state.time;
  ctx.save();
  if (state.cameraShake > 0) ctx.translate((Math.random() - 0.5) * state.cameraShake * 2, (Math.random() - 0.5) * state.cameraShake * 2);
  const camX = state.cameraX - w / 2, camY = state.cameraY - h / 2;
  const isDark = state.dayTime < 0.3;
  ctx.fillStyle = isDark ? '#0a0a1a' : '#1a1a2e'; ctx.fillRect(0, 0, w, h);
  ctx.save(); ctx.translate(-camX, -camY);
  const cs = state.mission?.citySize || 2000;

  drawGround(ctx, camX, camY, w, h, isDark);
  drawRoads(ctx, cs, isDark);
  for (const b of state.buildings) {
    if (b.x + b.w < camX - 50 || b.x > camX + w + 50 || b.y + b.h < camY - 50 || b.y > camY + h + 50) continue;
    drawBuilding(ctx, b, isDark, time);
  }

  // Hazards (extremal mode)
  for (const hz of state.hazards) drawHazard(ctx, hz, time);

  // Barriers
  for (const bar of state.barriers) drawBarrier(ctx, bar, time);

  for (const pu of state.powerUps) if (!pu.collected) drawPowerUp(ctx, pu, time);
  for (const car of state.trafficCars) {
    if (car.x < camX - 80 || car.x > camX + w + 80 || car.y < camY - 80 || car.y > camY + h + 80) continue;
    drawTrafficCar(ctx, car, time);
  }

  if (state.gameMode === 'runner' || state.gameMode === 'extremal') {
    if (state.aiAmbulance) drawAmbulanceEntity(ctx, state.aiAmbulance, time);
    for (const ba of state.backupAmbulances) drawAmbulanceEntity(ctx, ba, time);
    if (state.runner) drawRunnerPlayer(ctx, state.runner, state, time);
  } else if (state.gameMode === 'copsAndRobbers') {
    // PvP: P1 ambulance, P2 runner
    drawAmbulanceEntity(ctx, state.ambulance, time);
    if (state.mp?.runner2) drawRunnerPlayer(ctx, state.mp.runner2, state, time);
    for (const p of state.patients) if (!p.caught) drawPatient(ctx, p, state, time);
  } else {
    for (const p of state.patients) if (!p.caught) drawPatient(ctx, p, state, time);
    drawAmbulanceEntity(ctx, state.ambulance, time);
    // Draw second ambulance for multiplayer modes
    if (state.mp?.ambulance2) drawAmbulanceEntity(ctx, state.mp.ambulance2, time);
  }

  for (const p of state.particles) drawParticle(ctx, p);

  // Direction arrows
  if (state.gameMode === 'ambulance' || state.gameMode === 'coopRescue' || state.gameMode === 'patientRace') {
    // Determine which ambulance is "ours" for arrow source
    const myAmb = (state.mp?.netRole === 'guest' && state.mp?.ambulance2) ? state.mp.ambulance2 : state.ambulance;
    for (const p of state.patients) {
      if (p.caught) continue;
      const px = p.x - camX, py = p.y - camY;
      if (px > 40 && px < w - 40 && py > 60 && py < h - 60) continue;
      drawDirectionArrow(ctx, myAmb, p.x, p.y, p.story.color, camX, camY);
    }
    // Arrow to opponent in PvP modes
    if (state.gameMode === 'patientRace' && state.mp?.ambulance2) {
      const opp = state.mp.netRole === 'guest' ? state.ambulance : state.mp.ambulance2;
      const ox = opp.x - camX, oy = opp.y - camY;
      if (ox < 40 || ox > w - 40 || oy < 60 || oy > h - 60) {
        drawDirectionArrow(ctx, myAmb, opp.x, opp.y, '#ef4444', camX, camY);
      }
    }
  } else if (state.gameMode === 'copsAndRobbers') {
    // Ambulance sees arrow to runner, runner sees arrow to ambulance
    if (state.mp?.netRole === 'host' && state.mp?.runner2) {
      const rx = state.mp.runner2.x - camX, ry = state.mp.runner2.y - camY;
      if (rx < 40 || rx > w - 40 || ry < 60 || ry > h - 60)
        drawDirectionArrow(ctx, state.ambulance, state.mp.runner2.x, state.mp.runner2.y, '#fbbf24', camX, camY);
    } else if (state.mp?.netRole === 'guest') {
      const ax = state.ambulance.x - camX, ay = state.ambulance.y - camY;
      if (ax < 40 || ax > w - 40 || ay < 60 || ay > h - 60) {
        const myEntity = state.mp.runner2 || state.ambulance;
        drawDirectionArrow(ctx, myEntity, state.ambulance.x, state.ambulance.y, '#ef4444', camX, camY);
      }
    }
  } else if (state.gameMode === 'demolitionDerby' && state.mp?.ambulance2) {
    const myAmb = state.mp.netRole === 'guest' ? state.mp.ambulance2 : state.ambulance;
    const opp = state.mp.netRole === 'guest' ? state.ambulance : state.mp.ambulance2;
    const ox = opp.x - camX, oy = opp.y - camY;
    if (ox < 40 || ox > w - 40 || oy < 60 || oy > h - 60) {
      drawDirectionArrow(ctx, myAmb, opp.x, opp.y, '#ef4444', camX, camY);
    }
  } else if (state.runner && state.aiAmbulance) {
    const ax2 = state.aiAmbulance.x - camX, ay2 = state.aiAmbulance.y - camY;
    if (ax2 < 40 || ax2 > w - 40 || ay2 < 60 || ay2 > h - 60)
      drawDirectionArrow(ctx, state.runner, state.aiAmbulance.x, state.aiAmbulance.y, '#ef4444', camX, camY);
    // Arrows to hazards in extremal
    if (state.gameMode === 'extremal') {
      for (const hz of state.hazards) {
        if (!hz.active || hz.neutralizeTimer > 0) continue;
        const hx = hz.x - camX, hy = hz.y - camY;
        if (hx > 40 && hx < w - 40 && hy > 60 && hy < h - 60) continue;
        const hzColor = hz.type === 'fire' ? '#f97316' : hz.type === 'electricity' ? '#fbbf24' : hz.type === 'toxic' ? '#22c55e' : '#6b7280';
        drawDirectionArrow(ctx, state.runner, hz.x, hz.y, hzColor, camX, camY);
      }
    }
  }

  if (state.weather === 'fog') drawFog(ctx, camX, camY, w, h, time);
  if (isDark) drawNightOverlay(ctx, state, camX, camY, w, h);
  ctx.restore();

  // HUD
  if (state.gameMode === 'runner' || state.gameMode === 'extremal') drawRunnerHUD(ctx, state, w, h, time);
  else drawAmbulanceHUD(ctx, state, w, h, time);
  drawMinimap(ctx, state, w, h);
  drawFlashMessages(ctx, state, w, h);

  // Dialogues
  if (state.gameMode === 'ambulance') drawPatientDialogues(ctx, state, camX, camY, w, h, time);
  else if (state.runner && state.runner.currentDialogue && state.runner.dialogueTimer > 80)
    drawRunnerDialogue(ctx, state.runner, camX, camY, w, h, time);

  // Damage vignette
  if (state.cameraShake > 1) {
    const intensity = Math.min(0.4, state.cameraShake / 20);
    const vig = ctx.createRadialGradient(w / 2, h / 2, w * 0.3, w / 2, h / 2, w * 0.7);
    vig.addColorStop(0, 'rgba(255,0,0,0)'); vig.addColorStop(1, `rgba(255,0,0,${intensity})`);
    ctx.fillStyle = vig; ctx.fillRect(0, 0, w, h);
  }

  // Blackout event vignette
  if (state.activeEvent?.type === 'blackout') {
    const blackAlpha = Math.min(0.85, 0.85 * Math.min(1, state.activeEvent.timer / 30));
    const blackVig = ctx.createRadialGradient(w / 2, h / 2, 50, w / 2, h / 2, Math.max(w, h) * 0.55);
    blackVig.addColorStop(0, 'rgba(0,0,0,0)');
    blackVig.addColorStop(1, `rgba(0,0,0,${blackAlpha})`);
    ctx.fillStyle = blackVig; ctx.fillRect(0, 0, w, h);
  }

  // Event progress bar (thin colored bar at top)
  if (state.activeEvent && state.activeEvent.timer > 0) {
    const evtColors: Record<string, string> = {
      trafficJam: '#f59e0b', roadBlock: '#ef4444', patientSprint: '#c084fc',
      policeChase: '#1e40af', earthquake: '#ef4444', blackout: '#6b7280', breakdown: '#f59e0b',
    };
    const maxTimer: Record<string, number> = {
      trafficJam: 180, roadBlock: 240, patientSprint: 180,
      policeChase: 600, earthquake: 180, blackout: 300, breakdown: 180,
    };
    const mt = maxTimer[state.activeEvent.type] || 300;
    const pct = state.activeEvent.timer / mt;
    ctx.fillStyle = evtColors[state.activeEvent.type] || '#fff';
    ctx.globalAlpha = 0.7;
    ctx.fillRect(0, 0, w * pct, 3);
    ctx.globalAlpha = 1;
  }

  // Catch flash (white overlay on patient saved)
  if (state.flashMessages.some(m => m.text.includes('спасён') && m.timer > 100)) {
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(0, 0, w, h);
  }

  ctx.restore();
}

// ===== WORLD =====

function drawGround(ctx: CanvasRenderingContext2D, camX: number, camY: number, w: number, h: number, isDark: boolean) {
  const ts = 100;
  const sx = Math.floor(camX / ts) * ts, sy = Math.floor(camY / ts) * ts;
  for (let x = sx; x < camX + w + ts; x += ts) {
    for (let y = sy; y < camY + h + ts; y += ts) {
      const even = (Math.floor(x / ts) + Math.floor(y / ts)) % 2 === 0;
      ctx.fillStyle = isDark ? (even ? '#111827' : '#0f172a') : (even ? '#374151' : '#334155');
      ctx.fillRect(x, y, ts, ts);
    }
  }
}

function drawRoads(ctx: CanvasRenderingContext2D, cs: number, isDark: boolean) {
  const bs = 320, rw = 100; // Match engine BLOCK_SIZE and ROAD_WIDTH
  ctx.fillStyle = isDark ? '#1f2937' : '#4b5563';
  for (let i = 0; i <= Math.ceil(cs / bs); i++) {
    ctx.fillRect(0, i * bs - rw / 2, cs, rw);
    ctx.fillRect(i * bs - rw / 2, 0, rw, cs);
  }
  ctx.strokeStyle = isDark ? '#374151' : '#fbbf24'; ctx.lineWidth = 2; ctx.setLineDash([15, 15]);
  for (let i = 0; i <= Math.ceil(cs / bs); i++) {
    ctx.beginPath(); ctx.moveTo(0, i * bs); ctx.lineTo(cs, i * bs); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(i * bs, 0); ctx.lineTo(i * bs, cs); ctx.stroke();
  }
  ctx.setLineDash([]);
}

function drawBuilding(ctx: CanvasRenderingContext2D, b: Building, isDark: boolean, time: number) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(b.x + 4, b.y + 4, b.w, b.h);
  ctx.fillStyle = isDark ? darken(b.color, 0.4) : b.color; ctx.fillRect(b.x, b.y, b.w, b.h);
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.3)'; ctx.lineWidth = 1; ctx.strokeRect(b.x, b.y, b.w, b.h);
  const wGap = 14, cols = Math.floor((b.w - 10) / wGap), rows = Math.floor((b.h - 10) / wGap);
  for (let r = 0; r < rows && r < 4; r++) {
    for (let c = 0; c < cols && c < 5; c++) {
      const wx = b.x + 8 + c * wGap, wy = b.y + 8 + r * wGap;
      const lit = isDark && ((c + r * 3 + Math.floor(b.x)) % 5 !== 0);
      ctx.fillStyle = lit ? '#fbbf24' : (isDark ? '#1a1a2e' : 'rgba(150,200,255,0.4)');
      ctx.fillRect(wx, wy, 8, 8);
    }
  }
  if (b.type === 'hospital') {
    ctx.fillStyle = '#fff'; const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    ctx.fillRect(cx - 15, cy - 4, 30, 8); ctx.fillRect(cx - 4, cy - 15, 8, 30);
    const glow = 0.3 + Math.sin(time * 0.05) * 0.15;
    ctx.fillStyle = `rgba(239,68,68,${glow})`; ctx.beginPath(); ctx.arc(cx, cy, 50, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 12px Arial'; ctx.textAlign = 'center'; ctx.fillText('🏥', cx, b.y - 8);
  }
  ctx.restore();
}

function drawHazard(ctx: CanvasRenderingContext2D, hz: Hazard, time: number) {
  if (hz.neutralizeTimer > 0) {
    // Neutralized — show blue shield
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = '#3b82f6';
    ctx.beginPath(); ctx.arc(hz.x, hz.y, hz.radius, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '20px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('🛡', hz.x, hz.y);
    ctx.globalAlpha = 1;
    return;
  }

  const pulse = 0.6 + Math.sin(time * 0.1) * 0.3;
  const icons: Record<string, string> = { fire: '🔥', electricity: '⚡', manhole: '🕳', construction: '🏗', toxic: '☠' };
  const colors: Record<string, string> = { fire: '#f97316', electricity: '#fbbf24', manhole: '#6b7280', construction: '#a3a3a3', toxic: '#22c55e' };
  const color = colors[hz.type] || '#fff';

  // Danger zone circle
  ctx.globalAlpha = 0.15 * pulse;
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(hz.x, hz.y, hz.radius, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash([5, 5]);
  ctx.beginPath(); ctx.arc(hz.x, hz.y, hz.radius, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);

  // Icon
  ctx.globalAlpha = 1;
  ctx.font = `${24 + Math.sin(time * 0.15) * 4}px Arial`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(icons[hz.type] || '⚠', hz.x, hz.y);

  // Cooldown indicator
  if (hz.cooldown > 0) {
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath(); ctx.arc(hz.x, hz.y, 18, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 12px Arial';
    ctx.fillText(`${Math.ceil(hz.cooldown)}`, hz.x, hz.y);
    ctx.globalAlpha = 1;
  }
}

function drawBarrier(ctx: CanvasRenderingContext2D, bar: Barrier, time: number) {
  const alpha = Math.min(1, bar.life / 3);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#f59e0b';
  ctx.beginPath(); ctx.roundRect(bar.x, bar.y, bar.w, bar.h, 4); ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(bar.x, bar.y, bar.w, bar.h, 4); ctx.stroke();
  // Stripes
  ctx.fillStyle = '#000';
  const stripeW = 8;
  for (let sx = bar.x; sx < bar.x + bar.w; sx += stripeW * 2) {
    ctx.fillRect(sx + (time % 10), bar.y, stripeW, bar.h);
  }
  ctx.font = '12px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText('🚧', bar.x + bar.w / 2, bar.y + bar.h / 2);
  ctx.globalAlpha = 1;
}

function drawTrafficCar(ctx: CanvasRenderingContext2D, car: TrafficCar, time: number) {
  ctx.save(); ctx.translate(car.x, car.y);
  const angle = Math.atan2(car.vy, car.vx);
  if (Math.abs(car.vx) + Math.abs(car.vy) > 0.1) ctx.rotate(angle);
  ctx.fillStyle = car.color;
  ctx.beginPath(); ctx.roundRect(-car.width / 2, -car.height / 2, car.width, car.height, 5); ctx.fill();
  ctx.fillStyle = 'rgba(150,200,255,0.5)'; ctx.fillRect(car.width / 2 - 10, -car.height / 2 + 3, 8, car.height - 6);
  if (car.honkTimer > 0) { ctx.fillStyle = '#fbbf24'; ctx.font = '14px Arial'; ctx.textAlign = 'center'; ctx.fillText('📯', 0, -car.height / 2 - 10 - Math.sin(time * 0.3) * 3); }
  ctx.restore();
}

function drawPowerUp(ctx: CanvasRenderingContext2D, pu: PowerUp, time: number) {
  ctx.save(); ctx.translate(pu.x, pu.y + Math.sin(time * 0.06) * 5);
  const gs = 22 + Math.sin(time * 0.08) * 5;
  const colors: Record<string, string> = { nitro: '#3b82f6', medkit: '#ef4444', megaphone: '#a855f7', coffee: '#92400e', energy: '#fbbf24', smokebomb: '#6b7280', shortcut: '#a855f7' };
  const icons: Record<string, string> = { nitro: '⚡', medkit: '➕', megaphone: '📢', coffee: '☕', energy: '⚡', smokebomb: '💨', shortcut: '🚪' };
  const color = colors[pu.type] || '#fff';
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, gs);
  grad.addColorStop(0, color + '66'); grad.addColorStop(1, color + '00');
  ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(0, 0, gs, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(0, 0, 14, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = '16px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(icons[pu.type] || '?', 0, 0);
  ctx.restore();
}

function drawPatient(ctx: CanvasRenderingContext2D, p: Patient, state: GameState, time: number) {
  ctx.save(); ctx.translate(p.x, p.y);
  const d = Math.sqrt((p.x - state.ambulance.x) ** 2 + (p.y - state.ambulance.y) ** 2);
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(0, 16, 10, 4, 0, 0, Math.PI * 2); ctx.fill();
  const phase = time * 0.2;
  const lL = Math.sin(phase) * 8, lR = Math.sin(phase + Math.PI) * 8;
  const aL = Math.sin(phase + Math.PI) * 6, aR = Math.sin(phase) * 6;
  if (p.stunTimer > 0) { ctx.globalAlpha = 0.5 + Math.sin(time * 0.5) * 0.3; for (let i = 0; i < 3; i++) { const sa = time * 0.1 + i * 2.1; ctx.fillStyle = '#fbbf24'; ctx.font = '12px Arial'; ctx.fillText('⭐', Math.cos(sa) * 15, -20 + Math.sin(sa) * 8); } }
  ctx.strokeStyle = p.story.color; ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-3, 8); ctx.lineTo(-3 + lL, 18); ctx.moveTo(3, 8); ctx.lineTo(3 + lR, 18); ctx.stroke();
  ctx.fillStyle = p.story.color; ctx.beginPath(); ctx.ellipse(0, 0, 10, 12, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.moveTo(-8, -2); ctx.lineTo(-12 + aL, 6); ctx.moveTo(8, -2); ctx.lineTo(12 + aR, 6); ctx.stroke();
  ctx.fillStyle = '#fcd34d'; ctx.beginPath(); ctx.arc(0, -16, 9, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#000'; const es = 2 + p.panicLevel * 1.5;
  ctx.beginPath(); ctx.arc(-3, -17, es, 0, Math.PI * 2); ctx.arc(3, -17, es, 0, Math.PI * 2); ctx.fill();
  if (d < 200) { ctx.fillStyle = '#ef4444'; ctx.font = `bold ${14 + p.panicLevel * 4}px Arial`; ctx.textAlign = 'center'; ctx.fillText(d < 100 ? '!!!' : d < 150 ? '!!' : '!', 0, -30 - Math.sin(time * 0.15) * 3); }
  ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(-12, -28, 24, 3);
  const hp = Math.max(0, p.health / 100);
  ctx.fillStyle = hp > 0.5 ? '#22c55e' : hp > 0.25 ? '#f59e0b' : '#ef4444';
  ctx.fillRect(-12, -28, 24 * hp, 3);
  ctx.globalAlpha = 1; ctx.restore();
}

function drawRunnerPlayer(ctx: CanvasRenderingContext2D, runner: RunnerPlayer, state: GameState, time: number) {
  ctx.save(); ctx.translate(runner.x, runner.y);
  if (runner.invisibleTimer > 0) ctx.globalAlpha = 0.3 + Math.sin(time * 0.5) * 0.2;
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(0, 18, 12, 5, 0, 0, Math.PI * 2); ctx.fill();
  const isExtremal = state.gameMode === 'extremal';
  const bodyColor = isExtremal ? '#ef4444' : '#3b82f6';
  const phase = time * (runner.sprinting ? 0.35 : 0.2);
  const lA = runner.speed > 1 ? 10 : 4;
  const lL = Math.sin(phase) * lA, lR = Math.sin(phase + Math.PI) * lA;
  const armL = Math.sin(phase + Math.PI) * 8, armR = Math.sin(phase) * 8;

  ctx.strokeStyle = bodyColor; ctx.lineWidth = 4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-4, 10); ctx.lineTo(-4 + lL, 22); ctx.moveTo(4, 10); ctx.lineTo(4 + lR, 22); ctx.stroke();
  ctx.fillStyle = bodyColor; ctx.beginPath(); ctx.ellipse(0, 0, 12, 14, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = isExtremal ? '#991b1b' : '#1d4ed8'; ctx.font = 'bold 10px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(isExtremal ? '💀' : '🏃', 0, 1);
  ctx.strokeStyle = isExtremal ? '#fca5a5' : '#60a5fa'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(-10, -2); ctx.lineTo(-14 + armL, 8); ctx.moveTo(10, -2); ctx.lineTo(14 + armR, 8); ctx.stroke();
  ctx.fillStyle = '#fcd34d'; ctx.beginPath(); ctx.arc(0, -18, 10, 0, Math.PI * 2); ctx.fill();

  const aiAmb = state.aiAmbulance;
  if (aiAmb) {
    const la = Math.atan2(aiAmb.y - runner.y, aiAmb.x - runner.x);
    const eo = Math.cos(la) * 3, eyo = Math.sin(la) * 1;
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(-3 + eo, -19 + eyo, 2.5, 0, Math.PI * 2); ctx.arc(3 + eo, -19 + eyo, 2.5, 0, Math.PI * 2); ctx.fill();
    const ad = Math.sqrt((aiAmb.x - runner.x) ** 2 + (aiAmb.y - runner.y) ** 2);
    if (ad < 200 && time % 20 < 10) { ctx.fillStyle = '#93c5fd'; ctx.beginPath(); ctx.arc(11, -18, 2.5, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(13, -14, 1.5, 0, Math.PI * 2); ctx.fill(); }
    if (ad < 120) { ctx.fillStyle = '#ef4444'; ctx.font = `bold ${16 + Math.sin(time * 0.2) * 3}px Arial`; ctx.textAlign = 'center'; ctx.fillText('!!!', 0, -34); }
  } else {
    ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(-3, -19, 2, 0, Math.PI * 2); ctx.arc(3, -19, 2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(0, -14, 3, 0, Math.PI); ctx.stroke();

  if (runner.sprinting && runner.speed > 2) { ctx.strokeStyle = 'rgba(251,191,36,0.5)'; ctx.lineWidth = 2; for (let i = 0; i < 3; i++) { const off = -10 - i * 8; ctx.beginPath(); ctx.moveTo(off - Math.cos(runner.angle) * 5, -5 + Math.sin(time * 0.3 + i) * 3); ctx.lineTo(off - Math.cos(runner.angle) * 15, -5 + Math.sin(time * 0.3 + i) * 5); ctx.stroke(); } }
  if (runner.speedBoostTimer > 0) { ctx.strokeStyle = `rgba(146,64,14,${0.3 + Math.sin(time * 0.1) * 0.2})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 20 + Math.sin(time * 0.2) * 5, 0, Math.PI * 2); ctx.stroke(); }

  // Interacting hazard glow
  if (isExtremal && runner.interactingHazard) {
    ctx.strokeStyle = `rgba(239,68,68,${0.5 + Math.sin(time * 0.3) * 0.3})`;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, 18, 0, Math.PI * 2); ctx.stroke();
  }

  ctx.globalAlpha = 1; ctx.restore();
}

function drawAmbulanceEntity(ctx: CanvasRenderingContext2D, amb: Ambulance, time: number) {
  ctx.save(); ctx.translate(amb.x, amb.y);
  if (amb.speed > 0.5) ctx.rotate(amb.angle);
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(2, 2, 24, 16, 0, 0, Math.PI * 2); ctx.fill();
  const flash = Math.floor(time * 0.15) % 2 === 0;
  if (amb.sirenOn) { const gr = 40 + Math.sin(time * 0.1) * 10; const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, gr); grad.addColorStop(0, flash ? 'rgba(239,68,68,0.15)' : 'rgba(59,130,246,0.15)'); grad.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(0, 0, gr, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.roundRect(-22, -14, 44, 28, 5); ctx.fill();
  ctx.fillStyle = '#ef4444'; ctx.fillRect(-20, -3, 40, 6); ctx.fillRect(-2, -10, 4, 20);
  ctx.fillStyle = 'rgba(150,200,255,0.7)'; ctx.fillRect(16, -10, 5, 20);
  ctx.fillStyle = flash ? '#ef4444' : '#7f1d1d'; ctx.beginPath(); ctx.arc(-8, -15, 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = flash ? '#3b82f6' : '#1e3a5f'; ctx.beginPath(); ctx.arc(8, -15, 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#1f2937'; ctx.fillRect(-18, -16, 8, 3); ctx.fillRect(-18, 13, 8, 3); ctx.fillRect(10, -16, 8, 3); ctx.fillRect(10, 13, 8, 3);
  if (amb.nitroTimer > 0) { const fl = 10 + Math.random() * 15; ctx.fillStyle = '#f97316'; ctx.beginPath(); ctx.moveTo(-22, -5); ctx.lineTo(-22 - fl, 0); ctx.lineTo(-22, 5); ctx.closePath(); ctx.fill(); }
  if (amb.megaphoneTimer > 0) { ctx.fillStyle = `rgba(168,85,247,${0.3 + Math.sin(time * 0.2) * 0.2})`; ctx.beginPath(); ctx.arc(0, 0, 30 + Math.sin(time * 0.3) * 5, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}

function drawParticle(ctx: CanvasRenderingContext2D, p: GameState['particles'][0]) {
  const alpha = p.life / p.maxLife; ctx.globalAlpha = alpha;
  if (p.type === 'heart') { ctx.font = `${p.size * 3}px Arial`; ctx.fillText('❤', p.x, p.y); }
  else if (p.type === 'star') { ctx.font = `${p.size * 3}px Arial`; ctx.fillText('⭐', p.x, p.y); }
  else if (p.type === 'smoke') { ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 + (1 - alpha) * 2), 0, Math.PI * 2); ctx.fill(); }
  else if (p.type === 'rain') { ctx.strokeStyle = p.color; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + p.vx * 2, p.y + p.vy * 2); ctx.stroke(); }
  else { ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.size * alpha, 0, Math.PI * 2); ctx.fill(); }
  ctx.globalAlpha = 1;
}

function drawDirectionArrow(ctx: CanvasRenderingContext2D, from: { x: number; y: number }, toX: number, toY: number, color: string, camX: number, camY: number) {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  const angle = Math.atan2(toY - from.y, toX - from.x);
  const d = Math.sqrt((toX - from.x) ** 2 + (toY - from.y) ** 2);
  const meters = Math.floor(d);

  // Screen coords of player (center of screen roughly)
  const fromSx = from.x - camX, fromSy = from.y - camY;
  // Direction vector in screen space
  const dx = Math.cos(angle), dy = Math.sin(angle);
  // Ray-march from player center to screen edge
  const margin = 55;
  let maxT = 9999;
  if (dx > 0.001) maxT = Math.min(maxT, (w - margin - fromSx) / dx);
  else if (dx < -0.001) maxT = Math.min(maxT, (margin - fromSx) / dx);
  if (dy > 0.001) maxT = Math.min(maxT, (h - margin - fromSy) / dy);
  else if (dy < -0.001) maxT = Math.min(maxT, (margin + 10 - fromSy) / dy);
  maxT = Math.max(30, maxT);
  const ax = fromSx + dx * maxT, ay = fromSy + dy * maxT;

  // Draw in screen space
  ctx.save();
  ctx.resetTransform();

  const pulse = 0.7 + Math.sin(Date.now() * 0.005) * 0.3;

  // Arrow triangle
  ctx.save(); ctx.translate(ax, ay); ctx.rotate(angle);
  ctx.fillStyle = color; ctx.globalAlpha = pulse;
  ctx.beginPath(); ctx.moveTo(16, 0); ctx.lineTo(-8, -10); ctx.lineTo(-4, 0); ctx.lineTo(-8, 10); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.globalAlpha = pulse * 0.7; ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();

  // Distance label behind arrow
  const labelX = ax - Math.cos(angle) * 24, labelY = ay - Math.sin(angle) * 24;
  ctx.font = 'bold 12px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const txt = `${meters}м`;
  const tw = ctx.measureText(txt).width;
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.beginPath(); ctx.roundRect(labelX - tw / 2 - 5, labelY - 9, tw + 10, 18, 5); ctx.fill();
  ctx.fillStyle = color; ctx.fillText(txt, labelX, labelY);

  ctx.restore();
}

let fogCanvas: HTMLCanvasElement | null = null;
let fogW = 0, fogH = 0;

function ensureFogCanvas(w: number, h: number): HTMLCanvasElement {
  const nw = Math.ceil(w / 100) * 100 + 400;
  const nh = Math.ceil(h / 100) * 100 + 400;
  if (fogCanvas && fogW === nw && fogH === nh) return fogCanvas;
  fogCanvas = document.createElement('canvas');
  fogCanvas.width = nw; fogCanvas.height = nh;
  fogW = nw; fogH = nh;
  const fctx = fogCanvas.getContext('2d')!;
  for (let i = 0; i < 8; i++) {
    const fx = (i * 317) % nw;
    const fy = (i * 211) % nh;
    const fr = 120 + (i % 3) * 30;
    const g = fctx.createRadialGradient(fx, fy, 0, fx, fy, fr);
    g.addColorStop(0, 'rgba(200,200,220,0.18)');
    g.addColorStop(1, 'rgba(200,200,220,0)');
    fctx.fillStyle = g;
    fctx.beginPath(); fctx.arc(fx, fy, fr, 0, Math.PI * 2); fctx.fill();
  }
  return fogCanvas;
}

function drawFog(ctx: CanvasRenderingContext2D, camX: number, camY: number, w: number, h: number, time: number) {
  const fc = ensureFogCanvas(w, h);
  const ox = (time * 0.3) % 400 - 200;
  const oy = (time * 0.2) % 400 - 200;
  ctx.globalAlpha = 0.8;
  ctx.drawImage(fc, camX + ox, camY + oy);
  ctx.globalAlpha = 1;
}

function drawNightOverlay(ctx: CanvasRenderingContext2D, state: GameState, camX: number, camY: number, w: number, h: number) {
  const fe = state.gameMode === 'runner' || state.gameMode === 'extremal' ? state.runner : state.ambulance;
  if (!fe) return;
  ctx.fillStyle = 'rgba(0,0,10,0.7)'; ctx.fillRect(camX, camY, w, h);
  ctx.save(); ctx.globalCompositeOperation = 'destination-out';
  const hx = fe.x + Math.cos(fe.angle) * 20, hy = fe.y + Math.sin(fe.angle) * 20;
  const g = ctx.createRadialGradient(hx, hy, 10, hx, hy, 200);
  g.addColorStop(0, 'rgba(0,0,0,0.9)'); g.addColorStop(0.5, 'rgba(0,0,0,0.5)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(hx, hy, 200, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// ===== HUD =====

function drawRunnerHUD(ctx: CanvasRenderingContext2D, state: GameState, w: number, h: number, time: number) {
  if (!state.runner || !state.aiAmbulance) return;
  const runner = state.runner;
  const isExtremal = state.gameMode === 'extremal';
  const s = sf(w, h);
  const pad = 10;
  const barH = Math.round(50 * s);

  // Top bar
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.beginPath(); ctx.roundRect(pad, pad, w - pad * 2, barH, 10); ctx.fill();

  const remaining = Math.max(0, state.surviveTarget - state.surviveTime);
  const tc = remaining > 20 ? '#22c55e' : remaining > 10 ? '#f59e0b' : '#ef4444';
  ctx.fillStyle = tc; ctx.font = `bold ${Math.round(20 * s)}px Arial`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(`⏱ ${Math.ceil(remaining)}с`, pad + 12, pad + barH / 2);

  ctx.fillStyle = '#fbbf24'; ctx.font = `bold ${Math.round(17 * s)}px Arial`;
  ctx.textAlign = 'center';
  ctx.fillText(`⭐${state.runnerScore}`, w / 2, pad + barH / 2);

  ctx.fillStyle = '#94a3b8'; ctx.font = `${Math.round(15 * s)}px Arial`;
  ctx.textAlign = 'right';
  ctx.fillText(`Ур.${state.runnerLevel}`, w - pad - 12, pad + barH / 2);

  // Distance
  const ambDist = Math.sqrt((state.aiAmbulance.x - runner.x) ** 2 + (state.aiAmbulance.y - runner.y) ** 2);
  const dc = ambDist > 300 ? '#22c55e' : ambDist > 150 ? '#f59e0b' : '#ef4444';
  ctx.fillStyle = dc; ctx.font = `bold ${Math.round(15 * s)}px Arial`; ctx.textAlign = 'center';
  ctx.fillText(`🚑 ${Math.floor(ambDist)}м`, w / 2, pad + barH + Math.round(20 * s));

  if (ambDist < 150) { const pulse = 0.08 + Math.sin(time * 0.2) * 0.06; ctx.fillStyle = `rgba(239,68,68,${pulse})`; ctx.fillRect(0, 0, w, h); }

  // === EXTREMAL: Player Health bar (inverted — you WANT it to go down) ===
  if (isExtremal) {
    const hpBarW = w * 0.65;
    const hpBarH = Math.round(20 * s);
    const hpBarX = (w - hpBarW) / 2;
    const hpBarY = pad + barH + Math.round(38 * s);
    const hpRatio = runner.playerHealth / runner.maxPlayerHealth;

    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.beginPath(); ctx.roundRect(hpBarX - 6, hpBarY - 6, hpBarW + 12, hpBarH + 22, 8); ctx.fill();

    ctx.fillStyle = '#94a3b8'; ctx.font = `bold ${Math.round(12 * s)}px Arial`;
    ctx.textAlign = 'center';
    ctx.fillText('💀 ЗДОРОВЬЕ (нужно обнулить!)', w / 2, hpBarY - 1);

    ctx.fillStyle = '#374151';
    ctx.beginPath(); ctx.roundRect(hpBarX, hpBarY + 10, hpBarW, hpBarH, 4); ctx.fill();

    // Health bar — green when low (good for player!)
    const hpColor = hpRatio < 0.3 ? '#22c55e' : hpRatio < 0.6 ? '#f59e0b' : '#ef4444';
    if (hpRatio > 0) {
      ctx.fillStyle = hpColor;
      ctx.beginPath(); ctx.roundRect(hpBarX, hpBarY + 10, hpBarW * hpRatio, hpBarH, 4); ctx.fill();
    }

    ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(13 * s)}px Arial`;
    ctx.fillText(`${Math.ceil(runner.playerHealth)} / ${runner.maxPlayerHealth}`, w / 2, hpBarY + 10 + hpBarH / 2);

    // Backup ambulance count
    if (state.backupAmbulances.length > 0) {
      ctx.fillStyle = '#ef4444'; ctx.font = `bold ${Math.round(13 * s)}px Arial`;
      ctx.textAlign = 'right';
      ctx.fillText(`🚑×${state.backupAmbulances.length + 1}`, w - pad - 12, pad + barH + Math.round(20 * s));
    }
  }

  // Stamina bar
  const stBarW = w * 0.55;
  const stBarH = Math.round(14 * s);
  const stBarX = (w - stBarW) / 2;
  const stBarY = h - Math.round(80 * s);

  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.beginPath(); ctx.roundRect(stBarX - 4, stBarY - Math.round(18 * s), stBarW + 8, stBarH + Math.round(24 * s), 6); ctx.fill();

  ctx.fillStyle = '#94a3b8'; ctx.font = `${Math.round(11 * s)}px Arial`; ctx.textAlign = 'center';
  ctx.fillText('ВЫНОСЛИВОСТЬ', w / 2, stBarY - Math.round(5 * s));

  ctx.fillStyle = '#374151';
  ctx.beginPath(); ctx.roundRect(stBarX, stBarY, stBarW, stBarH, 4); ctx.fill();
  const stR = runner.stamina / runner.maxStamina;
  if (stR > 0) { ctx.fillStyle = stR > 0.5 ? '#22c55e' : stR > 0.2 ? '#f59e0b' : '#ef4444'; ctx.beginPath(); ctx.roundRect(stBarX, stBarY, stBarW * stR, stBarH, 4); ctx.fill(); }

  if (runner.sprinting) { ctx.fillStyle = '#fbbf24'; ctx.font = `bold ${Math.round(13 * s)}px Arial`; ctx.fillText('⚡ СПРИНТ', w / 2, stBarY + stBarH + Math.round(14 * s)); }

  // Effects
  const effects: string[] = [];
  if (runner.smokeBombTimer > 0) effects.push(`💨${Math.ceil(runner.smokeBombTimer)}`);
  if (runner.speedBoostTimer > 0) effects.push(`☕${Math.ceil(runner.speedBoostTimer)}`);
  if (runner.invisibleTimer > 0) effects.push(`👻${Math.ceil(runner.invisibleTimer)}`);
  if (runner.dashCooldown > 0 && isExtremal) effects.push(`💀${Math.ceil(runner.dashCooldown)}`);
  if (effects.length > 0) { ctx.fillStyle = '#e2e8f0'; ctx.font = `${Math.round(13 * s)}px Arial`; ctx.textAlign = 'center'; ctx.fillText(effects.join('  '), w / 2, stBarY - Math.round(22 * s)); }
}

function drawAmbulanceHUD(ctx: CanvasRenderingContext2D, state: GameState, w: number, h: number, time: number) {
  const mission = state.mission; if (!mission) return;
  const s = sf(w, h);
  const pad = 10;
  const barH = Math.round(50 * s);

  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.beginPath(); ctx.roundRect(pad, pad, w - pad * 2, barH, 10); ctx.fill();

  const caught = state.patients.filter(p => p.caught).length;
  ctx.fillStyle = '#94a3b8'; ctx.font = `${Math.round(13 * s)}px Arial`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(`🚑 М${state.missionIndex + 1}`, pad + 12, pad + barH * 0.33);
  ctx.fillStyle = '#86efac'; ctx.fillText(`Спасено: ${caught}/${state.patientsNeeded}`, pad + 12, pad + barH * 0.72);

  ctx.fillStyle = '#fbbf24'; ctx.font = `bold ${Math.round(17 * s)}px Arial`; ctx.textAlign = 'center';
  ctx.fillText(`⭐${state.score}`, w / 2, pad + barH / 2);

  const tc = state.timeLeft > 15 ? '#22c55e' : state.timeLeft > 7 ? '#f59e0b' : '#ef4444';
  ctx.fillStyle = tc; let ts2 = Math.round(19 * s); if (state.timeLeft <= 7) ts2 += Math.sin(time * 0.3) * 2;
  ctx.font = `bold ${ts2}px Arial`; ctx.textAlign = 'right';
  ctx.fillText(`⏱${Math.ceil(Math.max(0, state.timeLeft))}с`, w - pad - 12, pad + barH * 0.4);
  ctx.fillStyle = '#22c55e'; ctx.font = `${Math.round(12 * s)}px Arial`;
  ctx.fillText(`💰${state.money}`, w - pad - 12, pad + barH * 0.75);

  if (state.comboCount > 1) { ctx.fillStyle = '#c084fc'; ctx.font = `bold ${Math.round(15 * s)}px Arial`; ctx.textAlign = 'center'; ctx.fillText(`КОМБО x${state.comboCount}!`, w / 2, pad + barH + Math.round(20 * s)); }

  // Patient health panel
  const uncaught = state.patients.filter(p => !p.caught);
  if (uncaught.length > 0) {
    const pW = Math.min(w * 0.75, 360);
    const pX = (w - pW) / 2;
    const iH = Math.round(24 * s);
    const pH = uncaught.length * iH + 10;
    const pY = h - pH - Math.round(70 * s);

    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.beginPath(); ctx.roundRect(pX - 6, pY - 6, pW + 12, pH + 6, 8); ctx.fill();
    uncaught.forEach((pt, i) => {
      const py = pY + i * iH;
      ctx.fillStyle = pt.story.color; ctx.font = `${Math.round(13 * s)}px Arial`; ctx.textAlign = 'left';
      ctx.fillText(`${pt.story.emoji} ${pt.story.name}`, pX, py + 10);
      ctx.fillStyle = '#374151'; ctx.beginPath(); ctx.roundRect(pX, py + 14, pW - 4, 5, 2); ctx.fill();
      const hv = Math.max(0, pt.health / 100);
      ctx.fillStyle = hv > 0.5 ? '#22c55e' : hv > 0.25 ? '#f59e0b' : '#ef4444';
      ctx.beginPath(); ctx.roundRect(pX, py + 14, (pW - 4) * hv, 5, 2); ctx.fill();
    });
  }

  // Ambulance HP
  const maxHP = 100 + (state.upgrades?.armor || 0) * 25;
  const hpR = state.ambulance.health / maxHP;
  if (hpR < 1) {
    ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.beginPath(); ctx.roundRect(pad, h - 50, 100, 22, 5); ctx.fill();
    ctx.fillStyle = '#94a3b8'; ctx.font = `${Math.round(11 * s)}px Arial`; ctx.textAlign = 'left'; ctx.fillText('🚑', pad + 4, h - 35);
    ctx.fillStyle = '#374151'; ctx.fillRect(pad + 22, h - 43, 72, 8);
    ctx.fillStyle = hpR > 0.5 ? '#22c55e' : '#ef4444'; ctx.fillRect(pad + 22, h - 43, 72 * hpR, 8);
  }
  if (hpR < 0.3) { const pulse = 0.05 + Math.sin(time * 0.15) * 0.05; const vig = ctx.createRadialGradient(w / 2, h / 2, w * 0.2, w / 2, h / 2, w * 0.6); vig.addColorStop(0, 'rgba(255,0,0,0)'); vig.addColorStop(1, `rgba(255,0,0,${pulse})`); ctx.fillStyle = vig; ctx.fillRect(0, 0, w, h); }
}

function drawMinimap(ctx: CanvasRenderingContext2D, state: GameState, w: number, h: number) {
  const cs = state.mission?.citySize || 2000;
  const s = sf(w, h);
  const ms = Math.round(Math.min(90, w * 0.2) * s);
  const mx = w - ms - 10, my = h - ms - Math.round(70 * s);
  const sc = ms / cs;

  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.beginPath(); ctx.roundRect(mx - 2, my - 2, ms + 4, ms + 4, 4); ctx.fill();
  for (const b of state.buildings) {
    ctx.fillStyle = b.type === 'hospital' ? 'rgba(239,68,68,0.5)' : 'rgba(100,100,120,0.3)';
    ctx.fillRect(mx + b.x * sc, my + b.y * sc, Math.max(2, b.w * sc), Math.max(2, b.h * sc));
  }

  if (state.gameMode === 'runner' || state.gameMode === 'extremal') {
    if (state.runner) { ctx.fillStyle = '#22c55e'; ctx.beginPath(); ctx.arc(mx + state.runner.x * sc, my + state.runner.y * sc, 3, 0, Math.PI * 2); ctx.fill(); }
    if (state.aiAmbulance) { ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.arc(mx + state.aiAmbulance.x * sc, my + state.aiAmbulance.y * sc, 3, 0, Math.PI * 2); ctx.fill(); }
    for (const ba of state.backupAmbulances) { ctx.fillStyle = '#f59e0b'; ctx.beginPath(); ctx.arc(mx + ba.x * sc, my + ba.y * sc, 2, 0, Math.PI * 2); ctx.fill(); }
    // Hazards on minimap
    if (state.gameMode === 'extremal') {
      for (const hz of state.hazards) {
        if (hz.neutralizeTimer > 0) continue;
        ctx.fillStyle = '#f97316'; ctx.beginPath(); ctx.arc(mx + hz.x * sc, my + hz.y * sc, 2, 0, Math.PI * 2); ctx.fill();
      }
    }
  } else {
    for (const p of state.patients) { if (p.caught) continue; ctx.fillStyle = p.story.color; ctx.beginPath(); ctx.arc(mx + p.x * sc, my + p.y * sc, 3, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(mx + state.ambulance.x * sc, my + state.ambulance.y * sc, 3, 0, Math.PI * 2); ctx.fill();
  }
}

function drawFlashMessages(ctx: CanvasRenderingContext2D, state: GameState, w: number, _h: number) {
  const s = sf(w, _h);
  state.flashMessages.forEach((msg, i) => {
    const alpha = Math.min(1, msg.timer / 30);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = msg.color; ctx.font = `bold ${Math.round(16 * s)}px Arial`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const text = ctx.measureText(msg.text).width > w - 20 ? msg.text.slice(0, 25) + '…' : msg.text;
    ctx.fillText(text, w / 2, 80 + i * Math.round(28 * s));
    ctx.globalAlpha = 1;
  });
}

function drawPatientDialogues(ctx: CanvasRenderingContext2D, state: GameState, camX: number, camY: number, w: number, h: number, time: number) {
  for (const p of state.patients) {
    if (p.caught || !p.currentDialogue || p.dialogueTimer > 100) continue;
    const sx = p.x - camX, sy = p.y - camY;
    if (sx < -50 || sx > w + 50 || sy < -50 || sy > h + 50) continue;
    const alpha = Math.min(1, (120 - p.dialogueTimer) / 30);
    ctx.globalAlpha = alpha * 0.9; ctx.font = '13px Arial';
    let text = p.currentDialogue;
    const mbw = Math.min(w * 0.45, 200);
    if (ctx.measureText(text).width > mbw - 16) { while (ctx.measureText(text + '…').width > mbw - 16 && text.length > 5) text = text.slice(0, -1); text += '…'; }
    const tw = ctx.measureText(text).width;
    const bw = tw + 16, bh = 26;
    let bx = sx - bw / 2, by = sy - 55 - Math.sin(time * 0.05) * 3;
    bx = Math.max(4, Math.min(w - bw - 4, bx));
    by = Math.max(4, Math.min(h - bh - 12, by));
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 6); ctx.fill();
    const tailX = Math.max(bx + 8, Math.min(bx + bw - 8, sx));
    ctx.beginPath(); ctx.moveTo(tailX - 4, by + bh); ctx.lineTo(tailX, by + bh + 6); ctx.lineTo(tailX + 4, by + bh); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#1f2937'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + bw / 2, by + bh / 2);
    ctx.globalAlpha = 1;
  }
}

function drawRunnerDialogue(ctx: CanvasRenderingContext2D, runner: RunnerPlayer, camX: number, camY: number, w: number, h: number, time: number) {
  const sx = runner.x - camX, sy = runner.y - camY;
  if (sx < -50 || sx > w + 50 || sy < -50 || sy > h + 50) return;
  const alpha = Math.min(1, (runner.dialogueTimer - 80) / 30);
  ctx.globalAlpha = alpha * 0.9; ctx.font = 'bold 14px Arial';
  const text = runner.currentDialogue;
  const tw = ctx.measureText(text).width;
  const bw = tw + 16, bh = 28;
  let bx = sx - bw / 2, by = sy - 60 - Math.sin(time * 0.05) * 3;
  bx = Math.max(4, Math.min(w - bw - 4, bx));
  by = Math.max(4, Math.min(h - bh - 12, by));
  ctx.fillStyle = 'rgba(59,130,246,0.95)';
  ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 6); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + bw / 2, by + bh / 2);
  ctx.globalAlpha = 1;
}

// ===== SCREEN RENDERERS =====

export function renderMenu(ctx: CanvasRenderingContext2D, w: number, h: number, time: number) {
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#0f172a'); grad.addColorStop(0.5, '#1e1b4b'); grad.addColorStop(1, '#0f172a');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);

  const s = sf(w, h);

  // City silhouette
  ctx.fillStyle = '#1e293b';
  const bc = Math.max(5, Math.floor(w / 90)); const bW = w / bc;
  for (let i = 0; i < bc; i++) {
    const bh2 = 40 + Math.sin(i * 1.5) * 30 + 20;
    ctx.fillRect(i * bW, h - bh2 - 50, bW - 4, bh2);
    ctx.fillStyle = '#fbbf24';
    for (let wy = 0; wy < bh2 - 15; wy += 12) for (let wx = 4; wx < bW - 8; wx += 12) if (Math.sin(i + wx + wy + time * 0.01) > 0.3) ctx.fillRect(i * bW + wx, h - bh2 - 50 + wy + 6, 5, 5);
    ctx.fillStyle = '#1e293b';
  }
  ctx.fillStyle = '#374151'; ctx.fillRect(0, h - 50, w, 50);
  ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 2; ctx.setLineDash([15, 15]);
  ctx.beginPath(); ctx.moveTo(0, h - 25); ctx.lineTo(w, h - 25); ctx.stroke(); ctx.setLineDash([]);

  // Animated ambulance
  const ax = ((time * 2) % (w + 200)) - 100;
  ctx.save(); ctx.translate(ax, h - 35);
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.roundRect(-22, -14, 44, 28, 5); ctx.fill();
  ctx.fillStyle = '#ef4444'; ctx.fillRect(-20, -3, 40, 6);
  const fl = Math.floor(time * 0.15) % 2 === 0;
  ctx.fillStyle = fl ? '#ef4444' : '#7f1d1d'; ctx.beginPath(); ctx.arc(-8, -15, 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = fl ? '#3b82f6' : '#1e3a5f'; ctx.beginPath(); ctx.arc(8, -15, 4, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // --- CONTENT ---
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

  // Calculate total content height to center
  const emojiS = Math.round(50 * s);
  const titleS = Math.round(36 * s);
  const subS = Math.round(22 * s);
  const tagS = Math.round(14 * s);
  const btnH = Math.round(56 * s);
  const btnGap = Math.round(14 * s);
  const totalH = emojiS + 10 + titleS + 10 + subS + 8 + tagS + 30 + btnH * 4 + btnGap * 3 + 30;
  let y = Math.max(20, (h - totalH) / 2);

  // Emoji
  ctx.font = `${emojiS}px Arial`;
  ctx.fillText('🚑', w / 2, y + emojiS / 2);
  y += emojiS + 10;

  // Title
  ctx.fillStyle = '#fff'; ctx.font = `bold ${titleS}px Arial`;
  ctx.fillText('СКОРАЯ', w / 2, y + titleS / 2);
  y += titleS + 10;

  // Subtitle
  ctx.fillStyle = '#ef4444'; ctx.font = `bold ${subS}px Arial`;
  ctx.fillText('ПОСЛЕДНИЙ ШАНС', w / 2, y + subS / 2);
  y += subS + 8;

  // Tagline
  ctx.fillStyle = '#94a3b8'; ctx.font = `${tagS}px Arial`;
  ctx.fillText('Спасай, убегай или... уничтожь себя!', w / 2, y + tagS / 2);
  y += tagS + 30;

  // Three mode buttons
  const btnW = Math.min(Math.round(320 * s), w - 32);
  const btnX = w / 2 - btnW / 2;
  const btns = [
    { label: '🚑 ВОДИТЕЛЬ СКОРОЙ', color: 'rgba(239,68,68,', desc: 'Спасай пациентов' },
    { label: '🏃 ПОБЕГ', color: 'rgba(59,130,246,', desc: 'Убеги от скорой' },
    { label: '💀 ЭКСТРЕМАЛ', color: 'rgba(168,85,247,', desc: 'Умри быстрее!' },
    { label: '🌐 МУЛЬТИПЛЕЕР', color: 'rgba(34,197,94,', desc: 'Играй с друзьями по сети!' },
  ];

  btns.forEach((btn, i) => {
    const by = y + i * (btnH + btnGap);
    const pulse = 0.8 + Math.sin(time * 0.08 + i * 1.2) * 0.2;
    ctx.fillStyle = `${btn.color}${pulse})`;
    ctx.beginPath(); ctx.roundRect(btnX, by, btnW, btnH, Math.round(14 * s)); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(18 * s)}px Arial`;
    ctx.fillText(btn.label, w / 2, by + btnH * 0.42);
    ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.font = `${Math.round(12 * s)}px Arial`;
    ctx.fillText(btn.desc, w / 2, by + btnH * 0.72);
  });

  // Controls hint
  y += btns.length * (btnH + btnGap) + 20;
  if (y < h - 30) {
    ctx.fillStyle = '#475569'; ctx.font = `${Math.round(12 * s)}px Arial`;
    ctx.fillText('WASD — движение • ПРОБЕЛ — спринт', w / 2, y);
  }
}

export function renderBriefing(ctx: CanvasRenderingContext2D, state: GameState, w: number, h: number, time: number) {
  const mission = getMissionsR(state)[state.missionIndex]; if (!mission) return;
  ctx.fillStyle = 'rgba(0,0,0,0.95)'; ctx.fillRect(0, 0, w, h);

  const s = sf(w, h);
  const maxW = Math.min(w - 32, Math.round(460 * s));
  const cx = w / 2;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

  // Calculate heights
  const missionFS = Math.round(16 * s);
  const titleFS = Math.round(28 * s);
  const descFS = Math.round(15 * s);
  const cardH = Math.round(68 * s);
  const btnH = Math.round(56 * s);

  ctx.font = `bold ${titleFS}px Arial`;
  const titleLines = wrapText(ctx, mission.title, maxW);
  ctx.font = `${descFS}px Arial`;
  const descLines = wrapText(ctx, mission.description, maxW);

  const totalH = missionFS + 30 + titleLines.length * (titleFS + 8) + 10 + descLines.length * (descFS + 6) + 20
    + mission.patients.length * (cardH + 10) + 30 + descFS + 30 + btnH;

  let y = Math.max(16, (h - totalH) / 2);

  ctx.fillStyle = '#ef4444'; ctx.font = `bold ${missionFS}px Arial`;
  ctx.fillText(`МИССИЯ ${mission.id}`, cx, y + missionFS / 2);
  y += missionFS + 30;

  ctx.fillStyle = '#fff'; ctx.font = `bold ${titleFS}px Arial`;
  for (const line of titleLines) { ctx.fillText(line, cx, y + titleFS / 2); y += titleFS + 8; }
  y += 10;

  ctx.fillStyle = '#94a3b8'; ctx.font = `${descFS}px Arial`;
  for (const line of descLines) { ctx.fillText(line, cx, y + descFS / 2); y += descFS + 6; }
  y += 20;

  // Patient cards
  const cardW = Math.min(maxW, Math.round(400 * s));
  for (const p of mission.patients) {
    const cardX = cx - cardW / 2;
    ctx.fillStyle = 'rgba(30,41,59,0.8)';
    ctx.beginPath(); ctx.roundRect(cardX, y, cardW, cardH, 12); ctx.fill();
    ctx.strokeStyle = p.color + '66'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(cardX, y, cardW, cardH, 12); ctx.stroke();

    ctx.font = `${Math.round(28 * s)}px Arial`; ctx.textAlign = 'left';
    ctx.fillText(p.emoji, cardX + 14, y + cardH / 2);
    ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(16 * s)}px Arial`;
    ctx.fillText(`${p.name}, ${p.age} лет`, cardX + Math.round(50 * s), y + cardH * 0.38);
    ctx.fillStyle = '#94a3b8'; ctx.font = `${Math.round(13 * s)}px Arial`;
    let cond = p.condition;
    const condMax = cardW - Math.round(60 * s);
    if (ctx.measureText(cond).width > condMax) { while (ctx.measureText(cond + '…').width > condMax && cond.length > 5) cond = cond.slice(0, -1); cond += '…'; }
    ctx.fillText(cond, cardX + Math.round(50 * s), y + cardH * 0.68);
    ctx.textAlign = 'center';
    y += cardH + 10;
  }
  y += 10;

  ctx.fillStyle = '#64748b'; ctx.font = `${Math.round(14 * s)}px Arial`;
  const wNames: Record<string, string> = { clear: '☀Ясно', rain: '🌧Дождь', night: '🌙Ночь', fog: '🌫Туман' };
  ctx.fillText(`${wNames[mission.weather]} • ⏱${mission.timeLimit}с • ${'⭐'.repeat(Math.min(mission.difficulty, 5))}`, cx, y);
  y += 30;

  const btnW = Math.min(Math.round(300 * s), w - 32);
  const btnY = Math.min(y, h - btnH - 20);
  const btnX = cx - btnW / 2;
  const pulse = 0.85 + Math.sin(time * 0.08) * 0.15;

  if (state.mp?.isMultiplayer) {
    // Multiplayer: show mission # / total, and different button for host vs guest
    const isHost = state.mp.netRole === 'host';
    const missionLabel = `Миссия ${state.missionIndex + 1}/${getMissionsR(state).length}`;
    ctx.fillStyle = '#60a5fa'; ctx.font = `bold ${Math.round(14 * s)}px Arial`;
    ctx.fillText(`🤝 КООП — ${missionLabel}`, cx, btnY - Math.round(18 * s));

    if (isHost) {
      ctx.fillStyle = `rgba(34,197,94,${pulse})`;
      ctx.beginPath(); ctx.roundRect(btnX, btnY, btnW, btnH, 14); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(20 * s)}px Arial`;
      ctx.fillText('🚀 НАЧАТЬ МИССИЮ', cx, btnY + btnH / 2);
    } else {
      ctx.fillStyle = 'rgba(71,85,105,0.6)';
      ctx.beginPath(); ctx.roundRect(btnX, btnY, btnW, btnH, 14); ctx.fill();
      ctx.fillStyle = '#fbbf24'; ctx.font = `bold ${Math.round(18 * s)}px Arial`;
      const dots = '.'.repeat(Math.floor(time / 30) % 4);
      ctx.fillText(`⏳ Ожидание хоста${dots}`, cx, btnY + btnH / 2);
    }
    // Ping
    if (state.mp.connected) {
      ctx.fillStyle = state.mp.ping < 50 ? '#34d399' : state.mp.ping < 100 ? '#fbbf24' : '#ef4444';
      ctx.font = `${Math.round(12 * s)}px Arial`; ctx.textAlign = 'right';
      ctx.fillText(`${state.mp.ping}ms`, w - 10, 16);
      ctx.textAlign = 'center';
    }
  } else {
    ctx.fillStyle = `rgba(239,68,68,${pulse})`;
    ctx.beginPath(); ctx.roundRect(btnX, btnY, btnW, btnH, 14); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(20 * s)}px Arial`;
    ctx.fillText('🚑 ВЫЕЗЖАЕМ!', cx, btnY + btnH / 2);
  }
}

export function renderRunnerBriefing(ctx: CanvasRenderingContext2D, state: GameState, w: number, h: number, time: number) {
  ctx.fillStyle = 'rgba(0,0,0,0.95)'; ctx.fillRect(0, 0, w, h);
  const s = sf(w, h);
  const cx = w / 2;
  const isExtremal = state.gameMode === 'extremal';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

  const levelFS = Math.round(18 * s);
  const emojiFS = Math.round(46 * s);
  const titleFS = Math.round(28 * s);
  const targetFS = Math.round(18 * s);
  const tipFS = Math.round(14 * s);
  const btnH = Math.round(56 * s);

  const tips = isExtremal ? [
    '💀 Беги к опасностям: 🔥⚡🕳🏗☠',
    '📯 Кнопка Гудок = Рывок к ближайшей опасности',
    '🚧 ИИ ставит барьеры и нейтрализует опасности',
    '🚑 На высоких уровнях — подкрепление!',
    '🏃 Машины тоже наносят урон — используй их!',
  ] : [
    '⚡ Пробел/кнопка — спринт',
    '🏢 Прячься за зданиями!',
    '💨 Дымовая бомба — скорая теряет тебя',
    '🚪 Телепорт — мгновенно перемещает далеко',
  ];

  const totalH = levelFS + 20 + emojiFS + 20 + titleFS + 16 + targetFS + 20 + tips.length * (tipFS + 10) + 30 + btnH;
  let y = Math.max(16, (h - totalH) / 2);

  ctx.fillStyle = isExtremal ? '#a855f7' : '#3b82f6'; ctx.font = `bold ${levelFS}px Arial`;
  ctx.fillText(`УРОВЕНЬ ${state.runnerLevel}`, cx, y + levelFS / 2);
  y += levelFS + 20;

  ctx.font = `${emojiFS}px Arial`;
  ctx.fillText(isExtremal ? '💀🔥' : '🏃💨', cx, y + emojiFS / 2);
  y += emojiFS + 20;

  ctx.fillStyle = '#fff'; ctx.font = `bold ${titleFS}px Arial`;
  ctx.fillText(isExtremal ? 'ЭКСТРЕМАЛ!' : 'УБЕГИ ОТ СКОРОЙ!', cx, y + titleFS / 2);
  y += titleFS + 16;

  const surviveTime = isExtremal ? 60 + state.runnerLevel * 15 : 45 + state.runnerLevel * 10;
  ctx.fillStyle = '#fbbf24'; ctx.font = `${targetFS}px Arial`;
  ctx.fillText(isExtremal ? `Обнули здоровье за ${surviveTime}с!` : `Продержись ${surviveTime} секунд`, cx, y + targetFS / 2);
  y += targetFS + 20;

  ctx.fillStyle = '#94a3b8'; ctx.font = `${tipFS}px Arial`;
  for (const tip of tips) {
    const maxTW = w - 32;
    let t = tip;
    if (ctx.measureText(t).width > maxTW) { while (ctx.measureText(t + '…').width > maxTW && t.length > 10) t = t.slice(0, -1); t += '…'; }
    ctx.fillText(t, cx, y + tipFS / 2);
    y += tipFS + 10;
  }
  y += 10;

  ctx.fillStyle = '#ef4444'; ctx.font = `${Math.round(14 * s)}px Arial`;
  ctx.fillText(`Сложность: ${'🔴'.repeat(Math.min(state.runnerLevel, 5))}`, cx, y);
  y += 30;

  const btnW = Math.min(Math.round(300 * s), w - 32);
  const btnY = Math.min(y, h - btnH - 20);
  const btnX = cx - btnW / 2;
  const pulse = 0.85 + Math.sin(time * 0.08) * 0.15;
  ctx.fillStyle = isExtremal ? `rgba(168,85,247,${pulse})` : `rgba(59,130,246,${pulse})`;
  ctx.beginPath(); ctx.roundRect(btnX, btnY, btnW, btnH, 14); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(20 * s)}px Arial`;
  ctx.fillText(isExtremal ? '💀 ВПЕРЁД!' : '🏃 ПОБЕЖАЛИ!', cx, btnY + btnH / 2);
}

export function renderSaved(ctx: CanvasRenderingContext2D, state: GameState, w: number, h: number, time: number) {
  render(ctx, state);
  ctx.fillStyle = 'rgba(0,0,0,0.82)'; ctx.fillRect(0, 0, w, h);

  const s = sf(w, h);
  const cx = w / 2;
  const maxW = Math.min(w - 32, Math.round(440 * s));
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

  const isExtremal = state.gameMode === 'extremal';
  const isRunner = state.gameMode === 'runner';

  if (isRunner || isExtremal) {
    const survived = isExtremal
      ? (state.runner?.playerHealth ?? 1) <= 0  // extremal: won by dying
      : state.surviveTime >= state.surviveTarget; // runner: survived time

    const emojiFS = Math.round(50 * s);
    const titleFS = Math.round(28 * s);
    const subFS = Math.round(16 * s);
    const scoreFS = Math.round(22 * s);
    const btnH = Math.round(56 * s);

    const totalH = emojiFS + 20 + titleFS + 16 + subFS + 16 + scoreFS + 12 + scoreFS + 40 + btnH;
    let y = Math.max(16, (h - totalH) / 2);

    ctx.font = `${emojiFS}px Arial`;
    if (isExtremal) {
      ctx.fillText(survived ? '💀🎉' : '😰', cx, y + emojiFS / 2);
    } else {
      ctx.fillText(survived ? '🎉' : '🏥', cx, y + emojiFS / 2);
    }
    y += emojiFS + 20;

    ctx.fillStyle = survived ? '#22c55e' : '#ef4444'; ctx.font = `bold ${titleFS}px Arial`;
    if (isExtremal) {
      ctx.fillText(survived ? 'ЦЕЛЬ ДОСТИГНУТА!' : 'ВАС ПОЙМАЛИ!', cx, y + titleFS / 2);
    } else {
      ctx.fillText(survived ? 'ВЫ СБЕЖАЛИ!' : 'ВАС ПОЙМАЛИ!', cx, y + titleFS / 2);
    }
    y += titleFS + 16;

    ctx.fillStyle = '#94a3b8'; ctx.font = `${subFS}px Arial`;
    const subLines = wrapText(ctx,
      isExtremal
        ? (survived ? 'Вы уничтожили себя быстрее, чем скорая успела спасти! 💀' : 'Скорая вас поймала. Вы будете жить... к сожалению 😄')
        : (survived ? 'Скорая не смогла вас догнать!' : 'Вас "спасли" вопреки вашему желанию 😄'),
      maxW);
    for (const line of subLines) { ctx.fillText(line, cx, y + subFS / 2); y += subFS + 4; }
    y += 12;

    ctx.fillStyle = '#fbbf24'; ctx.font = `bold ${scoreFS}px Arial`;
    ctx.fillText(`⏱ ${Math.floor(state.surviveTime)} секунд`, cx, y + scoreFS / 2);
    y += scoreFS + 12;

    ctx.fillStyle = '#fff'; ctx.font = `bold ${scoreFS}px Arial`;
    ctx.fillText(`⭐ ${state.runnerScore} очков`, cx, y + scoreFS / 2);
    y += scoreFS + 40;

    const btnW = Math.min(Math.round(300 * s), w - 32);
    const btnY = Math.min(y, h - btnH - 20);
    const btnX = cx - btnW / 2;
    const pulse = 0.85 + Math.sin(time * 0.08) * 0.15;
    ctx.fillStyle = survived ? `rgba(34,197,94,${pulse})` : `rgba(239,68,68,${pulse})`;
    ctx.beginPath(); ctx.roundRect(btnX, btnY, btnW, btnH, 14); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(18 * s)}px Arial`;
    ctx.fillText(survived ? '▶ СЛЕДУЮЩИЙ УРОВЕНЬ' : '🔄 ЕЩЁ РАЗ', cx, btnY + btnH / 2);

    // Back to menu button
    const menuBtnY = btnY + btnH + Math.round(12 * s);
    const menuBtnH = Math.round(42 * s);
    ctx.fillStyle = 'rgba(71,85,105,0.7)';
    ctx.beginPath(); ctx.roundRect(btnX, menuBtnY, btnW, menuBtnH, 10); ctx.fill();
    ctx.fillStyle = '#94a3b8'; ctx.font = `bold ${Math.round(15 * s)}px Arial`;
    ctx.fillText('🏠 В МЕНЮ', cx, menuBtnY + menuBtnH / 2);
  } else {
    // Ambulance mode
    const titleFS = Math.round(28 * s);
    const storyFS = Math.round(15 * s);
    const scoreFS = Math.round(20 * s);
    const btnH = Math.round(56 * s);

    let storyH = 0;
    state.patients.forEach(p => {
      ctx.font = `${storyFS}px Arial`;
      storyH += wrapText(ctx, `${p.story.emoji} ${p.story.savedText}`, maxW).length * (storyFS + 4) + 8;
    });

    const totalH = 60 + titleFS + 30 + storyH + 12 + scoreFS + 12 + storyFS + 40 + btnH;
    let y = Math.max(16, (h - totalH) / 2);

    ctx.font = `${Math.round(50 * s)}px Arial`; ctx.fillText('🎉', cx, y + 30); y += 60;
    ctx.fillStyle = '#22c55e'; ctx.font = `bold ${titleFS}px Arial`;
    ctx.fillText('МИССИЯ ВЫПОЛНЕНА!', cx, y + titleFS / 2); y += titleFS + 30;

    state.patients.forEach(p => {
      ctx.fillStyle = p.story.color; ctx.font = `${storyFS}px Arial`;
      const lines = wrapText(ctx, `${p.story.emoji} ${p.story.savedText}`, maxW);
      for (const line of lines) { ctx.fillText(line, cx, y + storyFS / 2); y += storyFS + 4; }
      y += 8;
    });
    y += 12;

    ctx.fillStyle = '#fbbf24'; ctx.font = `bold ${scoreFS}px Arial`;
    ctx.fillText(`⭐${state.score} | 💰${state.money}`, cx, y + scoreFS / 2); y += scoreFS + 12;
    ctx.fillStyle = '#86efac'; ctx.font = `${storyFS}px Arial`;
    ctx.fillText(`Спасено: ${state.totalSaved} • Репутация: ${state.reputation}%`, cx, y + storyFS / 2); y += storyFS + 40;

    const hasNext = state.missionIndex + 1 < getMissionsR(state).length;
    const btnW = Math.min(Math.round(300 * s), w - 32);
    const btnY = Math.min(y, h - btnH - 20);
    const btnX = cx - btnW / 2;
    const pulse = 0.85 + Math.sin(time * 0.08) * 0.15;
    ctx.fillStyle = hasNext ? `rgba(34,197,94,${pulse})` : `rgba(59,130,246,${pulse})`;
    ctx.beginPath(); ctx.roundRect(btnX, btnY, btnW, btnH, 14); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(18 * s)}px Arial`;
    ctx.fillText(hasNext ? '▶ ДАЛЕЕ' : '🏆 ИТОГИ', cx, btnY + btnH / 2);

    // Back to menu button
    const menuBtnY2 = btnY + btnH + Math.round(12 * s);
    const menuBtnH2 = Math.round(42 * s);
    ctx.fillStyle = 'rgba(71,85,105,0.7)';
    ctx.beginPath(); ctx.roundRect(btnX, menuBtnY2, btnW, menuBtnH2, 10); ctx.fill();
    ctx.fillStyle = '#94a3b8'; ctx.font = `bold ${Math.round(15 * s)}px Arial`;
    ctx.fillText('🏠 В МЕНЮ', cx, menuBtnY2 + menuBtnH2 / 2);
  }

  // Multiplayer: auto-restart countdown overlay
  if (state.mp?.isMultiplayer && state.mp.roundEndTime > 0) {
    const elapsed = performance.now() - state.mp.roundEndTime;
    const remaining = Math.max(0, Math.ceil((3000 - elapsed) / 1000));
    const missionNum = state.missionIndex + 2; // next mission (1-based)
    const totalMissions = getMissionsR(state).length;
    const isLastMission = state.missionIndex + 1 >= totalMissions;
    const nextLabel = isLastMission ? '🏆 Финал!' : `Миссия ${missionNum}/${totalMissions}`;
    const countFS = Math.round(18 * s);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, h - Math.round(50 * s), w, Math.round(50 * s));
    ctx.fillStyle = '#60a5fa'; ctx.font = `bold ${countFS}px Arial`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(`⏳ ${nextLabel} через ${remaining}...`, cx, h - Math.round(25 * s));
  }
}

export function renderFailed(ctx: CanvasRenderingContext2D, state: GameState, w: number, h: number, time: number) {
  render(ctx, state);
  ctx.fillStyle = 'rgba(0,0,0,0.88)'; ctx.fillRect(0, 0, w, h);

  const s = sf(w, h);
  const cx = w / 2;
  const maxW = Math.min(w - 32, Math.round(440 * s));
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

  const isExtremal = state.gameMode === 'extremal';
  const isRunner = state.gameMode === 'runner';

  const titleFS = Math.round(28 * s);
  const subFS = Math.round(16 * s);
  const scoreFS = Math.round(20 * s);
  const btnH = Math.round(56 * s);

  // Estimate height
  let estH = 60 + titleFS + 30;
  if (isExtremal || isRunner) estH += subFS * 3 + 40 + scoreFS + 40 + btnH;
  else { estH += subFS * 4 + 40 + scoreFS + 12 + subFS + 40 + btnH; }

  let y = Math.max(16, (h - estH) / 2);

  ctx.font = `${Math.round(50 * s)}px Arial`;
  ctx.fillText(isExtremal ? '😤' : '💔', cx, y + 30); y += 60;

  ctx.fillStyle = '#ef4444'; ctx.font = `bold ${titleFS}px Arial`;
  if (isExtremal) {
    const timeUp = state.timeLeft <= 0;
    ctx.fillText(timeUp ? 'ВРЕМЯ ВЫШЛО!' : 'ПОЙМАН!', cx, y + titleFS / 2);
  } else if (isRunner) {
    ctx.fillText('ПОЙМАН!', cx, y + titleFS / 2);
  } else {
    ctx.fillText('НЕ УСПЕЛИ...', cx, y + titleFS / 2);
  }
  y += titleFS + 20;

  if (isExtremal) {
    ctx.fillStyle = '#94a3b8'; ctx.font = `${subFS}px Arial`;
    const msg = state.timeLeft <= 0
      ? 'Время кончилось. Вы остались живы... к сожалению для вас!'
      : 'Скорая вас догнала и "спасла"!';
    const lines = wrapText(ctx, msg, maxW);
    for (const line of lines) { ctx.fillText(line, cx, y + subFS / 2); y += subFS + 4; }
    y += 12;
    const hp = state.runner?.playerHealth ?? 100;
    ctx.fillStyle = '#ef4444'; ctx.font = `bold ${subFS}px Arial`;
    ctx.fillText(`HP осталось: ${Math.ceil(hp)} / 100`, cx, y + subFS / 2);
    y += subFS + 20;
  } else if (!isRunner) {
    const failed = state.patients.filter(p => !p.caught);
    failed.forEach(p => {
      ctx.fillStyle = '#94a3b8'; ctx.font = `${subFS}px Arial`;
      const lines = wrapText(ctx, `${p.story.emoji} ${p.story.failedText}`, maxW);
      for (const line of lines) { ctx.fillText(line, cx, y + subFS / 2); y += subFS + 4; }
      y += 8;
    });
    if (state.currentDialogue) {
      ctx.fillStyle = '#ef4444'; ctx.font = `italic ${subFS}px Arial`;
      const dLines = wrapText(ctx, `"${state.currentDialogue}"`, maxW);
      for (const line of dLines) { ctx.fillText(line, cx, y + subFS / 2); y += subFS + 4; }
    }
  }

  y += 16;
  ctx.fillStyle = '#fbbf24'; ctx.font = `bold ${scoreFS}px Arial`;
  ctx.fillText(`⭐${isRunner || isExtremal ? state.runnerScore : state.score}`, cx, y + scoreFS / 2);
  y += scoreFS + 40;

  const btnW = Math.min(Math.round(300 * s), w - 32);
  const btnY = Math.min(y, h - btnH - 20);
  const btnX = cx - btnW / 2;
  const pulse = 0.85 + Math.sin(time * 0.08) * 0.15;
  ctx.fillStyle = `rgba(239,68,68,${pulse})`;
  ctx.beginPath(); ctx.roundRect(btnX, btnY, btnW, btnH, 14); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(18 * s)}px Arial`;
  ctx.fillText('🔄 ПОВТОРИТЬ', cx, btnY + btnH / 2);

  // Back to menu button
  const menuBtnY = btnY + btnH + Math.round(12 * s);
  const menuBtnH = Math.round(42 * s);
  const menuBtnW = btnW;
  ctx.fillStyle = 'rgba(71,85,105,0.7)';
  ctx.beginPath(); ctx.roundRect(btnX, menuBtnY, menuBtnW, menuBtnH, 10); ctx.fill();
  ctx.fillStyle = '#94a3b8'; ctx.font = `bold ${Math.round(15 * s)}px Arial`;
  ctx.fillText('🏠 В МЕНЮ', cx, menuBtnY + menuBtnH / 2);

  // Multiplayer: auto-retry countdown overlay
  if (state.mp?.isMultiplayer && state.mp.roundEndTime > 0) {
    const elapsed = performance.now() - state.mp.roundEndTime;
    const remaining = Math.max(0, Math.ceil((3000 - elapsed) / 1000));
    const missionNum = state.missionIndex + 1; // same mission (1-based)
    const totalMissions = getMissionsR(state).length;
    const countFS = Math.round(18 * s);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, h - Math.round(50 * s), w, Math.round(50 * s));
    ctx.fillStyle = '#ef4444'; ctx.font = `bold ${countFS}px Arial`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(`🔄 Повтор миссии ${missionNum}/${totalMissions} через ${remaining}...`, cx, h - Math.round(25 * s));
  }
}

export function renderUpgrade(ctx: CanvasRenderingContext2D, state: GameState, w: number, h: number, time: number) {
  // Background gradient
  const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
  bgGrad.addColorStop(0, '#0f172a'); bgGrad.addColorStop(0.5, '#1a1a3e'); bgGrad.addColorStop(1, '#0f172a');
  ctx.fillStyle = bgGrad; ctx.fillRect(0, 0, w, h);
  // Decorative grid
  ctx.strokeStyle = 'rgba(59,130,246,0.04)'; ctx.lineWidth = 1;
  for (let gx = 0; gx < w; gx += 40) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke(); }
  for (let gy = 0; gy < h; gy += 40) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke(); }

  const s = sf(w, h);
  const cx = w / 2;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

  const upgrades = [
    { key: 'engine', name: 'ДВИГАТЕЛЬ', icon: '🏎️', desc: 'Макс. скорость', color: '#ef4444', stat: '+15% скорость' },
    { key: 'tires', name: 'ШИНЫ', icon: '🛞', desc: 'Управляемость', color: '#3b82f6', stat: '+20% манёвр' },
    { key: 'siren', name: 'СИРЕНА', icon: '🚨', desc: 'Радиус очистки', color: '#a855f7', stat: '+50 радиус' },
    { key: 'armor', name: 'БРОНЯ', icon: '🛡️', desc: 'Прочность корпуса', color: '#22c55e', stat: '+25 HP' },
  ];

  const titleFS = Math.round(28 * s);
  const moneyFS = Math.round(22 * s);
  const cardH = Math.round(82 * s);
  const cardGap = Math.round(10 * s);
  const btnH = Math.round(54 * s);

  const totalH = titleFS + 16 + moneyFS + 16 + upgrades.length * (cardH + cardGap) + 16 + btnH;
  let y = Math.max(12, (h - totalH) / 2);

  // Title with glow
  ctx.shadowColor = '#3b82f6'; ctx.shadowBlur = 20;
  ctx.fillStyle = '#fff'; ctx.font = `bold ${titleFS}px Arial`;
  ctx.fillText('🔧 ГАРАЖ', cx, y + titleFS / 2);
  ctx.shadowBlur = 0;
  y += titleFS + 16;

  const coinBounce = Math.sin(time * 0.1) * 3;
  ctx.fillStyle = '#22c55e'; ctx.font = `bold ${moneyFS}px Arial`;
  ctx.fillText(`💰 ${state.money}`, cx, y + moneyFS / 2 + coinBounce);
  y += moneyFS + 16;

  const cardW = Math.min(Math.round(380 * s), w - 20);

  upgrades.forEach((upg, i) => {
    const uy = y + i * (cardH + cardGap);
    const level = state.upgrades[upg.key as keyof typeof state.upgrades];
    const cost = (level + 1) * 100;
    const maxed = level >= 3;
    const cardX = cx - cardW / 2;
    const canBuy = !maxed && state.money >= cost;

    // Card bg
    ctx.fillStyle = 'rgba(30,41,59,0.9)';
    ctx.beginPath(); ctx.roundRect(cardX, uy, cardW, cardH, 12); ctx.fill();
    // Left color stripe
    ctx.fillStyle = maxed ? '#22c55e' : upg.color;
    ctx.beginPath(); ctx.roundRect(cardX, uy, Math.round(5 * s), cardH, [12, 0, 0, 12]); ctx.fill();
    // Border
    if (canBuy) {
      ctx.strokeStyle = upg.color; ctx.lineWidth = 2; ctx.globalAlpha = 0.5 + Math.sin(time * 0.1 + i) * 0.3;
      ctx.beginPath(); ctx.roundRect(cardX, uy, cardW, cardH, 12); ctx.stroke(); ctx.globalAlpha = 1;
    } else { ctx.strokeStyle = maxed ? 'rgba(34,197,94,0.4)' : 'rgba(55,65,81,0.5)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(cardX, uy, cardW, cardH, 12); ctx.stroke(); }

    // Icon bg circle
    const iconX = cardX + Math.round(32 * s), iconY = uy + cardH * 0.42, iconR = Math.round(20 * s);
    ctx.fillStyle = `${upg.color}22`; ctx.beginPath(); ctx.arc(iconX, iconY, iconR, 0, Math.PI * 2); ctx.fill();
    ctx.font = `${Math.round(22 * s)}px Arial`; ctx.textAlign = 'center';
    ctx.fillText(upg.icon, iconX, iconY);

    // Name & desc
    const textX = cardX + Math.round(60 * s);
    ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(14 * s)}px Arial`; ctx.textAlign = 'left';
    ctx.fillText(upg.name, textX, uy + cardH * 0.26);
    ctx.fillStyle = '#94a3b8'; ctx.font = `${Math.round(11 * s)}px Arial`;
    ctx.fillText(upg.desc, textX, uy + cardH * 0.46);

    // Progress bar
    const barX = textX, barY = uy + cardH * 0.62, barW = Math.round(110 * s), barH2 = Math.round(8 * s);
    ctx.fillStyle = '#1e293b'; ctx.beginPath(); ctx.roundRect(barX, barY, barW, barH2, 4); ctx.fill();
    for (let l = 0; l < 3; l++) {
      const segX = barX + l * (barW / 3) + 1, segW = barW / 3 - 2;
      ctx.fillStyle = l < level ? upg.color : '#374151';
      ctx.beginPath(); ctx.roundRect(segX, barY + 1, segW, barH2 - 2, 3); ctx.fill();
    }
    ctx.fillStyle = '#64748b'; ctx.font = `${Math.round(10 * s)}px Arial`; ctx.textAlign = 'left';
    ctx.fillText(`${level}/3`, barX + barW + Math.round(6 * s), barY + barH2 / 2 + 1);

    // Stat text
    ctx.fillStyle = upg.color; ctx.font = `${Math.round(10 * s)}px Arial`;
    ctx.fillText(upg.stat, textX, uy + cardH * 0.85);

    // Cost badge
    ctx.textAlign = 'right';
    if (maxed) { ctx.fillStyle = '#22c55e'; ctx.font = `bold ${Math.round(13 * s)}px Arial`; ctx.fillText('✅ МАКС', cardX + cardW - Math.round(12 * s), uy + cardH / 2); }
    else { ctx.fillStyle = canBuy ? '#fbbf24' : '#ef4444'; ctx.font = `bold ${Math.round(14 * s)}px Arial`; ctx.fillText(`💰 ${cost}`, cardX + cardW - Math.round(12 * s), uy + cardH / 2); }
    ctx.textAlign = 'center';
  });

  const btnY2 = y + upgrades.length * (cardH + cardGap) + 16;
  const btnW = Math.min(Math.round(300 * s), w - 32);
  const finalBtnY = Math.min(btnY2, h - btnH - 16);
  const btnX = cx - btnW / 2;
  const pulse = 0.85 + Math.sin(time * 0.08) * 0.15;

  if (state.mp?.isMultiplayer) {
    const mp = state.mp;
    const iAmReady = mp.netRole === 'host' ? mp.hostReady : mp.guestReady;
    const otherReady = mp.netRole === 'host' ? mp.guestReady : mp.hostReady;

    // Ready button
    if (iAmReady) {
      ctx.fillStyle = 'rgba(34,197,94,0.5)';
      ctx.beginPath(); ctx.roundRect(btnX, finalBtnY, btnW, btnH, 14); ctx.fill();
      ctx.fillStyle = '#34d399'; ctx.font = `bold ${Math.round(16 * s)}px Arial`;
      const dots = '.'.repeat(Math.floor(time / 30) % 4);
      ctx.fillText(otherReady ? '✅ Оба готовы!' : `✅ Ожидание напарника${dots}`, cx, finalBtnY + btnH / 2);
    } else {
      ctx.fillStyle = `rgba(59,130,246,${pulse})`;
      ctx.beginPath(); ctx.roundRect(btnX, finalBtnY, btnW, btnH, 14); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(18 * s)}px Arial`;
      ctx.fillText('✅ ГОТОВ', cx, finalBtnY + btnH / 2);
    }

    // Mission progress + ping
    const infoFS = Math.round(12 * s);
    ctx.fillStyle = '#60a5fa'; ctx.font = `${infoFS}px Arial`;
    ctx.fillText(`Следующая: Миссия ${state.missionIndex + 1}/${getMissionsR(state).length}`, cx, finalBtnY + btnH + Math.round(16 * s));
    if (mp.connected) {
      ctx.fillStyle = mp.ping < 50 ? '#34d399' : mp.ping < 100 ? '#fbbf24' : '#ef4444';
      ctx.font = `${infoFS}px Arial`; ctx.textAlign = 'right';
      ctx.fillText(`${mp.ping}ms`, w - 10, 16);
      ctx.textAlign = 'center';
    }
  } else {
    ctx.fillStyle = `rgba(59,130,246,${pulse})`;
    ctx.beginPath(); ctx.roundRect(btnX, finalBtnY, btnW, btnH, 14); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(18 * s)}px Arial`;
    ctx.fillText('▶ ПРОДОЛЖИТЬ', cx, finalBtnY + btnH / 2);
  }
}

export function renderEnding(ctx: CanvasRenderingContext2D, state: GameState, w: number, h: number, time: number) {
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#0f172a'); grad.addColorStop(1, '#1e1b4b');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);

  const s = sf(w, h);
  const cx = w / 2;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

  const trophyFS = Math.round(60 * s);
  const titleFS = Math.round(32 * s);
  const statFS = Math.round(18 * s);
  const ratingFS = Math.round(28 * s);
  const btnH = Math.round(56 * s);

  const totalH = trophyFS + 20 + titleFS + 20 + statFS + 10 + statFS * 4 + 20 + ratingFS + 40 + btnH;
  let y = Math.max(16, (h - totalH) / 2);

  ctx.font = `${trophyFS}px Arial`; ctx.fillText('🏆', cx, y + trophyFS / 2); y += trophyFS + 20;
  ctx.fillStyle = '#fbbf24'; ctx.font = `bold ${titleFS}px Arial`; ctx.fillText('ВЫ — ГЕРОЙ!', cx, y + titleFS / 2); y += titleFS + 20;
  ctx.fillStyle = '#94a3b8'; ctx.font = `${statFS}px Arial`; ctx.fillText('Все миссии пройдены!', cx, y + statFS / 2); y += statFS + 10;
  ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(22 * s)}px Arial`; ctx.fillText(`⭐ ${state.score} очков`, cx, y + statFS / 2); y += statFS + 8;
  ctx.fillStyle = '#22c55e'; ctx.font = `${statFS}px Arial`; ctx.fillText(`💚 Спасено: ${state.totalSaved}`, cx, y + statFS / 2); y += statFS + 6;
  ctx.fillStyle = '#ef4444'; ctx.fillText(`💔 Потеряно: ${state.totalFailed}`, cx, y + statFS / 2); y += statFS + 6;
  ctx.fillStyle = '#fbbf24'; ctx.fillText(`📊 Репутация: ${state.reputation}%`, cx, y + statFS / 2); y += statFS + 20;

  let rating = '⭐';
  if (state.totalFailed === 0 && state.reputation >= 80) rating = '⭐⭐⭐⭐⭐';
  else if (state.totalFailed <= 1 && state.reputation >= 60) rating = '⭐⭐⭐⭐';
  else if (state.totalFailed <= 2) rating = '⭐⭐⭐';
  else if (state.totalFailed <= 4) rating = '⭐⭐';
  ctx.font = `${ratingFS}px Arial`; ctx.fillText(rating, cx, y + ratingFS / 2); y += ratingFS + 40;

  const btnW = Math.min(Math.round(300 * s), w - 32);
  const btnY = Math.min(y, h - btnH - 20);
  const btnX = cx - btnW / 2;
  const pulse = 0.85 + Math.sin(time * 0.08) * 0.15;
  ctx.fillStyle = `rgba(239,68,68,${pulse})`;
  ctx.beginPath(); ctx.roundRect(btnX, btnY, btnW, btnH, 14); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(18 * s)}px Arial`;
  ctx.fillText('🔄 НАЧАТЬ ЗАНОВО', cx, btnY + btnH / 2);
}

// ===== PAUSE SCREEN =====

export function renderPaused(ctx: CanvasRenderingContext2D, w: number, h: number, time: number) {
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(0, 0, w, h);

  const s = sf(w, h);
  const cx = w / 2;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

  const emojiFS = Math.round(46 * s);
  const titleFS = Math.round(32 * s);
  const btnH = Math.round(54 * s);
  const btnGap = Math.round(14 * s);
  const btnW = Math.min(Math.round(280 * s), w - 32);
  const btnX = cx - btnW / 2;

  const totalH = emojiFS + 20 + titleFS + 30 + 3 * (btnH + btnGap);
  let y = Math.max(20, (h - totalH) / 2);

  ctx.font = `${emojiFS}px Arial`;
  ctx.fillText('⏸', cx, y + emojiFS / 2);
  y += emojiFS + 20;

  ctx.fillStyle = '#fff'; ctx.font = `bold ${titleFS}px Arial`;
  ctx.fillText('ПАУЗА', cx, y + titleFS / 2);
  y += titleFS + 30;

  const btns = [
    { label: '▶ ПРОДОЛЖИТЬ', color: 'rgba(34,197,94,' },
    { label: '🔄 ЗАНОВО', color: 'rgba(59,130,246,' },
    { label: '🏠 В МЕНЮ', color: 'rgba(239,68,68,' },
  ];

  btns.forEach((btn, i) => {
    const by = y + i * (btnH + btnGap);
    const pulse = 0.8 + Math.sin(time * 0.08 + i) * 0.2;
    ctx.fillStyle = `${btn.color}${pulse})`;
    ctx.beginPath(); ctx.roundRect(btnX, by, btnW, btnH, 12); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(18 * s)}px Arial`;
    ctx.fillText(btn.label, cx, by + btnH / 2);
  });
}

export function getPauseButtonLayout(w: number, h: number): { btnX: number; btnW: number; btnH: number; btnGap: number; startY: number } {
  const s = sf(w, h);
  const emojiFS = Math.round(46 * s);
  const titleFS = Math.round(32 * s);
  const btnH = Math.round(54 * s);
  const btnGap = Math.round(14 * s);
  const btnW = Math.min(Math.round(280 * s), w - 32);
  const btnX = w / 2 - btnW / 2;
  const totalH = emojiFS + 20 + titleFS + 30 + 3 * (btnH + btnGap);
  const startY = Math.max(20, (h - totalH) / 2) + emojiFS + 20 + titleFS + 30;
  return { btnX, btnW, btnH, btnGap, startY };
}

// ===== TRANSITION OVERLAY =====

export function renderTransition(ctx: CanvasRenderingContext2D, alpha: number, w: number, h: number) {
  if (alpha <= 0) return;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 1;
}

// ===== SPEED LINES =====

export function renderSpeedLines(ctx: CanvasRenderingContext2D, w: number, h: number, speed: number, maxSpeed: number, angle: number, time: number) {
  const ratio = speed / maxSpeed;
  if (ratio < 0.7) return;
  const intensity = (ratio - 0.7) / 0.3;
  ctx.save();
  ctx.globalAlpha = intensity * 0.25;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  const cx = w / 2, cy = h / 2;
  for (let i = 0; i < 8; i++) {
    const a = angle + Math.PI + (Math.random() - 0.5) * 1.2;
    const startR = 100 + Math.random() * 100;
    const endR = startR + 80 + Math.random() * 120 + intensity * 100;
    const sx = cx + Math.cos(a) * startR;
    const sy = cy + Math.sin(a) * startR;
    const ex = cx + Math.cos(a) * endR;
    const ey = cy + Math.sin(a) * endR;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  }
  ctx.restore();
}

// ===== TUTORIAL HINT =====

export function renderTutorial(ctx: CanvasRenderingContext2D, mode: string, w: number, h: number, time: number) {
  if (time > 300) return; // Only show for first 5 seconds
  const alpha = time < 250 ? 0.85 : (300 - time) / 50 * 0.85;
  if (alpha <= 0) return;

  const s = sf(w, h);
  ctx.save();
  ctx.globalAlpha = alpha;

  const text = mode === 'ambulance'
    ? 'WASD — движение  |  Догони пациентов!'
    : mode === 'runner'
      ? 'WASD — движение  |  ПРОБЕЛ — спринт  |  Убегай!'
      : 'WASD — движение  |  ПРОБЕЛ — рывок  |  Беги к опасностям!';

  const fs = Math.round(14 * s);
  ctx.font = `bold ${fs}px Arial`;
  const tw = ctx.measureText(text).width;
  const bw = tw + 32, bh = fs + 20;
  const bx = (w - bw) / 2, by = 60;

  ctx.fillStyle = 'rgba(0,0,0,0.8)';
  ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 8); ctx.fill();
  ctx.fillStyle = '#fbbf24';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, by + bh / 2);

  ctx.restore();
}

// ===== ORIENTATION HINT =====

export function renderOrientationHint(ctx: CanvasRenderingContext2D, w: number, h: number) {
  if (w >= h * 1.1) return; // Already landscape-ish
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.fillRect(0, 0, w, h);
  const s = sf(w, h);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `${Math.round(40 * s)}px Arial`;
  ctx.fillText('📱', w / 2, h / 2 - 40);
  ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(18 * s)}px Arial`;
  ctx.fillText('Поверните устройство', w / 2, h / 2 + 20);
  ctx.fillStyle = '#94a3b8'; ctx.font = `${Math.round(14 * s)}px Arial`;
  ctx.fillText('Горизонтальная ориентация', w / 2, h / 2 + 50);
  ctx.fillText('рекомендуется для игры', w / 2, h / 2 + 70);

  ctx.fillStyle = '#475569'; ctx.font = `${Math.round(12 * s)}px Arial`;
  ctx.fillText('Нажмите чтобы продолжить', w / 2, h * 0.85);
  ctx.restore();
}

// ===== MENU WITH SAVE INDICATOR =====

export function renderMenuWithSave(ctx: CanvasRenderingContext2D, w: number, h: number, time: number, hasSave: boolean) {
  renderMenu(ctx, w, h, time);
  if (hasSave) {
    const s = sf(w, h);
    ctx.save();
    ctx.fillStyle = 'rgba(34,197,94,0.7)';
    ctx.font = `${Math.round(12 * s)}px Arial`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('💾 Есть сохранение', w / 2, 20);
    ctx.restore();
  }
}

// ===== MULTIPLAYER MENU =====

export function renderMultiplayerMenu(ctx: CanvasRenderingContext2D, w: number, h: number, time: number) {
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#0f172a'); grad.addColorStop(0.5, '#064e3b'); grad.addColorStop(1, '#0f172a');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);

  const s = sf(w, h);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

  const emojiS = Math.round(50 * s);
  const titleS = Math.round(32 * s);
  const subS = Math.round(16 * s);
  const btnH = Math.round(56 * s);
  const btnGap = Math.round(14 * s);

  const totalH = emojiS + 10 + titleS + 15 + subS + 30 + btnH * 3 + btnGap * 2;
  let y = Math.max(20, (h - totalH) / 2);

  ctx.font = `${emojiS}px Arial`;
  ctx.fillText('🌐', w / 2, y + emojiS / 2);
  y += emojiS + 10;

  ctx.fillStyle = '#34d399'; ctx.font = `bold ${titleS}px Arial`;
  ctx.fillText('МУЛЬТИПЛЕЕР', w / 2, y + titleS / 2);
  y += titleS + 15;

  ctx.fillStyle = '#94a3b8'; ctx.font = `${subS}px Arial`;
  ctx.fillText('Онлайн P2P — код комнаты', w / 2, y + subS / 2);
  y += subS + 30;

  const btnW = Math.min(Math.round(320 * s), w - 32);
  const btnX = w / 2 - btnW / 2;

  const btns = [
    { label: '🏠 СОЗДАТЬ ИГРУ (Хост)', color: 'rgba(34,197,94,', desc: 'Создать и ждать игрока' },
    { label: '🔗 ПОДКЛЮЧИТЬСЯ (Гость)', color: 'rgba(59,130,246,', desc: 'Ввести код хоста' },
    { label: '◀ НАЗАД', color: 'rgba(100,116,139,', desc: '' },
  ];

  btns.forEach((btn, i) => {
    const by = y + i * (btnH + btnGap);
    const pulse = 0.8 + Math.sin(time * 0.08 + i * 1.2) * 0.2;
    ctx.fillStyle = `${btn.color}${pulse})`;
    ctx.beginPath(); ctx.roundRect(btnX, by, btnW, btnH, Math.round(14 * s)); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(16 * s)}px Arial`;
    ctx.fillText(btn.label, w / 2, by + btnH * 0.42);
    if (btn.desc) {
      ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.font = `${Math.round(11 * s)}px Arial`;
      ctx.fillText(btn.desc, w / 2, by + btnH * 0.72);
    }
  });
}

export function getMultiplayerMenuLayout(w: number, h: number) {
  const s = sf(w, h);
  const emojiS = Math.round(50 * s);
  const titleS = Math.round(32 * s);
  const subS = Math.round(16 * s);
  const btnH = Math.round(56 * s);
  const btnGap = Math.round(14 * s);
  const totalH = emojiS + 10 + titleS + 15 + subS + 30 + btnH * 3 + btnGap * 2;
  const startY = Math.max(20, (h - totalH) / 2) + emojiS + 10 + titleS + 15 + subS + 30;
  const btnW = Math.min(Math.round(320 * s), w - 32);
  const btnX = w / 2 - btnW / 2;
  return { btnX, btnW, btnH, btnGap, startY };
}

// ===== LOBBY =====

export function renderLobby(ctx: CanvasRenderingContext2D, state: GameState, w: number, h: number, time: number) {
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#0f172a'); grad.addColorStop(0.5, '#1e1b4b'); grad.addColorStop(1, '#0f172a');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);

  const s = sf(w, h);
  const mp = state.mp;
  if (!mp) return;

  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

  const titleS = Math.round(28 * s);
  const textS = Math.round(16 * s);
  const smallS = Math.round(13 * s);
  const btnH = Math.round(50 * s);
  const btnGap = Math.round(12 * s);
  const btnW = Math.min(Math.round(340 * s), w - 24);
  const btnX = w / 2 - btnW / 2;

  let y = Math.round(30 * s);

  // Header
  ctx.fillStyle = '#34d399'; ctx.font = `bold ${titleS}px Arial`;
  const roleText = mp.netRole === 'host' ? '🏠 ХОСТ' : '🔗 ГОСТЬ';
  ctx.fillText(roleText, w / 2, y + titleS / 2);
  y += titleS + 20;

  // Connection status
  const statusColors: Record<string, string> = {
    hostWaiting: '#fbbf24', guestEnterCode: '#60a5fa',
    connected: '#34d399', modeSelect: '#34d399',
  };
  const statusTexts: Record<string, string> = {
    hostWaiting: '⏳ Ожидание игрока...',
    guestEnterCode: '🔗 Введите код комнаты',
    connected: '✅ Подключено!',
    modeSelect: '🎮 Выбор режима',
  };
  const statusColor = statusColors[mp.lobbyScreen] || '#94a3b8';
  const statusText = statusTexts[mp.lobbyScreen] || mp.lobbyScreen;
  ctx.fillStyle = statusColor; ctx.font = `bold ${textS}px Arial`;
  ctx.fillText(statusText, w / 2, y + textS / 2);
  y += textS + 20;

  // Ping
  if (mp.connected) {
    ctx.fillStyle = mp.ping < 50 ? '#34d399' : mp.ping < 100 ? '#fbbf24' : '#ef4444';
    ctx.font = `${smallS}px Arial`;
    ctx.fillText(`Ping: ${mp.ping}ms`, w / 2, y);
    y += smallS + 15;
  }

  // Host waiting: show room code prominently
  if (mp.lobbyScreen === 'hostWaiting' && mp.roomCode) {
    ctx.fillStyle = '#94a3b8'; ctx.font = `${smallS}px Arial`;
    ctx.fillText('Код комнаты (скажите другу):', w / 2, y);
    y += smallS + 15;

    // Room code — large characters with spacing
    const codeBoxH = Math.round(70 * s);
    ctx.fillStyle = 'rgba(30,41,59,0.9)';
    ctx.beginPath(); ctx.roundRect(btnX, y, btnW, codeBoxH, 12); ctx.fill();
    ctx.strokeStyle = '#34d399'; ctx.lineWidth = 2; ctx.stroke();

    // Draw each character of the room code with spacing
    const charSize = Math.round(38 * s);
    const code = mp.roomCode;
    const charSpacing = Math.round(16 * s);
    const totalCodeW = code.length * charSize + (code.length - 1) * charSpacing;
    let cx = w / 2 - totalCodeW / 2 + charSize / 2;
    ctx.fillStyle = '#34d399'; ctx.font = `bold ${charSize}px monospace`;
    for (let i = 0; i < code.length; i++) {
      ctx.fillText(code[i], cx, y + codeBoxH / 2);
      cx += charSize + charSpacing;
    }
    y += codeBoxH + 15;

    // Copy button
    const cpyH = Math.round(44 * s);
    ctx.fillStyle = 'rgba(34,197,94,0.8)';
    ctx.beginPath(); ctx.roundRect(btnX, y, btnW, cpyH, 10); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(14 * s)}px Arial`;
    const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    ctx.fillText(isMobile && navigator.share ? '📤 ПОДЕЛИТЬСЯ КОДОМ' : '📋 КОПИРОВАТЬ КОД', w / 2, y + cpyH / 2);
    y += cpyH + 20;

    // Waiting animation
    const dots = '.'.repeat(1 + Math.floor(time * 0.05) % 3);
    ctx.fillStyle = '#fbbf24'; ctx.font = `${textS}px Arial`;
    ctx.fillText(`Ожидание игрока${dots}`, w / 2, y + textS / 2);
    y += textS + 15;
  }

  // Host waiting but no code yet (loading)
  if (mp.lobbyScreen === 'hostWaiting' && !mp.roomCode) {
    const dots = '.'.repeat(1 + Math.floor(time * 0.05) % 3);
    ctx.fillStyle = '#fbbf24'; ctx.font = `${textS}px Arial`;
    ctx.fillText(`Создание комнаты${dots}`, w / 2, y + textS / 2);
    y += textS + 15;
  }

  // Guest: Canvas-based code input with on-screen keyboard
  if (mp.lobbyScreen === 'guestEnterCode') {
    ctx.fillStyle = '#94a3b8'; ctx.font = `${smallS}px Arial`;
    ctx.fillText('Введите код комнаты:', w / 2, y);
    y += smallS + 15;

    // 6 input boxes
    const boxSize = Math.round(44 * s);
    const boxGap = Math.round(8 * s);
    const totalBoxW = 6 * boxSize + 5 * boxGap;
    const boxStartX = w / 2 - totalBoxW / 2;
    const inputCode = mp.inputCode || '';

    for (let i = 0; i < 6; i++) {
      const bx = boxStartX + i * (boxSize + boxGap);
      // Active box blinks
      const isActive = i === inputCode.length;
      ctx.fillStyle = isActive ? 'rgba(59,130,246,0.3)' : 'rgba(30,41,59,0.9)';
      ctx.beginPath(); ctx.roundRect(bx, y, boxSize, boxSize, 8); ctx.fill();
      ctx.strokeStyle = isActive ? '#60a5fa' : '#475569';
      ctx.lineWidth = isActive ? 2 : 1;
      ctx.stroke();

      if (i < inputCode.length) {
        ctx.fillStyle = '#34d399'; ctx.font = `bold ${Math.round(26 * s)}px monospace`;
        ctx.fillText(inputCode[i], bx + boxSize / 2, y + boxSize / 2);
      } else if (isActive) {
        // Blinking cursor
        if (Math.floor(time * 0.06) % 2 === 0) {
          ctx.fillStyle = '#60a5fa';
          ctx.fillRect(bx + boxSize / 2 - 1, y + boxSize * 0.25, 2, boxSize * 0.5);
        }
      }
    }
    y += boxSize + 15;

    // Backspace button
    if (inputCode.length > 0) {
      const backBtnW = Math.round(60 * s);
      const backBtnH = Math.round(38 * s);
      const backBtnX = w / 2 + totalBoxW / 2 - backBtnW;
      ctx.fillStyle = 'rgba(239,68,68,0.6)';
      ctx.beginPath(); ctx.roundRect(backBtnX, y, backBtnW, backBtnH, 6); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(14 * s)}px Arial`;
      ctx.fillText('⌫', backBtnX + backBtnW / 2, y + backBtnH / 2);
    }
    y += Math.round(38 * s) + 12;

    // On-screen keyboard
    const kbChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const kbCols = 8;
    const kbRows = Math.ceil(kbChars.length / kbCols);
    const kbBtnS = Math.round(38 * s);
    const kbGap = Math.round(6 * s);
    const kbTotalW = kbCols * kbBtnS + (kbCols - 1) * kbGap;
    const kbStartX = w / 2 - kbTotalW / 2;

    for (let r = 0; r < kbRows; r++) {
      for (let c = 0; c < kbCols; c++) {
        const idx = r * kbCols + c;
        if (idx >= kbChars.length) break;
        const bx = kbStartX + c * (kbBtnS + kbGap);
        const by = y + r * (kbBtnS + kbGap);
        ctx.fillStyle = inputCode.length >= 6 ? 'rgba(51,65,85,0.3)' : 'rgba(51,65,85,0.8)';
        ctx.beginPath(); ctx.roundRect(bx, by, kbBtnS, kbBtnS, 6); ctx.fill();
        ctx.fillStyle = inputCode.length >= 6 ? 'rgba(255,255,255,0.3)' : '#e2e8f0';
        ctx.font = `bold ${Math.round(16 * s)}px monospace`;
        ctx.fillText(kbChars[idx], bx + kbBtnS / 2, by + kbBtnS / 2);
      }
    }
    y += kbRows * (kbBtnS + kbGap) + 10;

    // Error message
    if (mp.inputError) {
      ctx.fillStyle = '#ef4444'; ctx.font = `bold ${Math.round(14 * s)}px Arial`;
      ctx.fillText(mp.inputError, w / 2, y);
      y += Math.round(18 * s);
    }

    // Status: connecting
    if (inputCode.length === 6) {
      const dots = '.'.repeat(1 + Math.floor(time * 0.05) % 3);
      ctx.fillStyle = '#fbbf24'; ctx.font = `${textS}px Arial`;
      ctx.fillText(`Подключение${dots}`, w / 2, y);
      y += textS + 10;
    }

    // Hint for desktop
    ctx.fillStyle = '#64748b'; ctx.font = `${Math.round(11 * s)}px Arial`;
    ctx.fillText('или набирайте на клавиатуре', w / 2, y);
    y += Math.round(15 * s);
  }

  // Mode select (host only when connected)
  if (mp.lobbyScreen === 'modeSelect' || mp.lobbyScreen === 'connected') {
    ctx.fillStyle = '#94a3b8'; ctx.font = `${smallS}px Arial`;
    ctx.fillText(mp.netRole === 'host' ? 'Выберите режим:' : 'Хост выбирает режим...', w / 2, y);
    y += smallS + 15;

    const modes = [
      { id: 'coopRescue', label: '🤝 Совместное спасение', desc: 'Две скорых — спасайте вместе!', color: 'rgba(34,197,94,' },
      { id: 'copsAndRobbers', label: '🚔 Погоня', desc: 'Скорая VS Бегун — PvP!', color: 'rgba(239,68,68,' },
      { id: 'demolitionDerby', label: '💥 Дерби', desc: 'Таранное безумие на арене!', color: 'rgba(251,191,36,' },
      { id: 'patientRace', label: '🏁 Гонка за пациентами', desc: 'Кто больше поймает — тот и крут!', color: 'rgba(168,85,247,' },
    ];

    const modeBtnH = Math.round(52 * s);
    modes.forEach((mode, i) => {
      const by = y + i * (modeBtnH + btnGap);
      const pulse = 0.75 + Math.sin(time * 0.06 + i) * 0.2;
      const isHost = mp.netRole === 'host';
      ctx.fillStyle = `${mode.color}${isHost ? pulse : 0.3})`;
      ctx.beginPath(); ctx.roundRect(btnX, by, btnW, modeBtnH, 10); ctx.fill();
      if (mp.multiplayerMode === mode.id) {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      }
      ctx.fillStyle = isHost ? '#fff' : 'rgba(255,255,255,0.5)';
      ctx.font = `bold ${Math.round(14 * s)}px Arial`;
      ctx.fillText(mode.label, w / 2, by + modeBtnH * 0.38);
      ctx.fillStyle = isHost ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.3)';
      ctx.font = `${Math.round(11 * s)}px Arial`;
      ctx.fillText(mode.desc, w / 2, by + modeBtnH * 0.72);
    });
    y += modes.length * (modeBtnH + btnGap) + 10;

    // START button (host only)
    if (mp.netRole === 'host') {
      const startPulse = 0.85 + Math.sin(time * 0.1) * 0.15;
      ctx.fillStyle = `rgba(34,197,94,${startPulse})`;
      ctx.beginPath(); ctx.roundRect(btnX, y, btnW, btnH, 12); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(18 * s)}px Arial`;
      ctx.fillText('🚀 СТАРТ!', w / 2, y + btnH / 2);
      y += btnH + 10;
    }
  }

  // Back button at bottom
  const backY = h - btnH - Math.round(15 * s);
  ctx.fillStyle = 'rgba(100,116,139,0.6)';
  ctx.beginPath(); ctx.roundRect(btnX, backY, btnW, Math.round(40 * s), 8); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = `bold ${Math.round(14 * s)}px Arial`;
  ctx.fillText('◀ НАЗАД В МЕНЮ', w / 2, backY + Math.round(20 * s));
}

export function getLobbyLayout(w: number, h: number) {
  const s = sf(w, h);
  const btnH = Math.round(50 * s);
  const btnGap = Math.round(12 * s);
  const btnW = Math.min(Math.round(340 * s), w - 24);
  const btnX = w / 2 - btnW / 2;
  const smallS = Math.round(13 * s);
  const titleS = Math.round(28 * s);
  const textS = Math.round(16 * s);
  const backBtnH = Math.round(40 * s);
  const backY = h - btnH - Math.round(15 * s);
  return { btnX, btnW, btnH, btnGap, smallS, titleS, textS, backY, backBtnH, s };
}

// ===== MULTIPLAYER HUD =====

export function drawMultiplayerHUD(ctx: CanvasRenderingContext2D, state: GameState, w: number, h: number, time: number) {
  const mp = state.mp;
  if (!mp) return;
  const s = sf(w, h);

  // Mission indicator + Ping (top-right)
  ctx.save();
  const infoFS = Math.round(12 * s);
  ctx.font = `${infoFS}px Arial`;
  ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  // Mission number
  ctx.fillStyle = '#60a5fa';
  ctx.fillText(`Миссия ${state.missionIndex + 1}/${getMissionsR(state).length}`, w - 10, 10);
  // Ping
  ctx.fillStyle = mp.ping < 50 ? '#34d399' : mp.ping < 100 ? '#fbbf24' : '#ef4444';
  ctx.fillText(`${mp.ping}ms`, w - 10, 10 + infoFS + 4);

  // Player labels
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.font = `bold ${Math.round(12 * s)}px Arial`;

  // P1 label
  const amb1 = state.ambulance;
  const camX = state.cameraX - w / 2, camY = state.cameraY - h / 2;
  const p1x = amb1.x - camX, p1y = amb1.y - camY;
  if (p1x > 0 && p1x < w && p1y > 0 && p1y < h) {
    ctx.fillStyle = 'rgba(239,68,68,0.9)';
    ctx.fillText(mp.localPlayer.id === 0 ? 'P1 (Вы)' : 'P1', p1x, p1y - 30);
  }

  // P2 label
  const amb2 = mp.ambulance2;
  if (amb2) {
    const p2x = amb2.x - camX, p2y = amb2.y - camY;
    if (p2x > 0 && p2x < w && p2y > 0 && p2y < h) {
      ctx.fillStyle = 'rgba(59,130,246,0.9)';
      ctx.fillText(mp.localPlayer.id === 1 ? 'P2 (Вы)' : 'P2', p2x, p2y - 30);
    }
  }

  // Runner label (cops&robbers)
  const runner2 = mp.runner2;
  if (runner2) {
    const rx = runner2.x - camX, ry = runner2.y - camY;
    if (rx > 0 && rx < w && ry > 0 && ry < h) {
      ctx.fillStyle = 'rgba(251,191,36,0.9)';
      ctx.fillText(mp.localPlayer.id === 1 ? 'Бегун (Вы)' : 'Бегун', rx, ry - 30);
    }
  }

  // Scores bar (bottom center for multiplayer)
  if (mp.multiplayerMode === 'patientRace' || mp.multiplayerMode === 'demolitionDerby') {
    const barW = Math.round(200 * s);
    const barH = Math.round(28 * s);
    const barX = w / 2 - barW / 2;
    const barY = h - barH - Math.round(10 * s);
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.beginPath(); ctx.roundRect(barX, barY, barW, barH, 6); ctx.fill();

    ctx.font = `bold ${Math.round(14 * s)}px Arial`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ef4444';
    ctx.fillText(`P1: ${mp.scores[0]}`, barX + 10, barY + barH / 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#60a5fa';
    ctx.fillText(`P2: ${mp.scores[1]}`, barX + barW - 10, barY + barH / 2);
  }

  // Derby round indicator
  if (mp.multiplayerMode === 'demolitionDerby') {
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = '#fbbf24'; ctx.font = `bold ${Math.round(14 * s)}px Arial`;
    ctx.fillText(`Раунд ${mp.derbyRound}/3  [${mp.derbyWins[0]}-${mp.derbyWins[1]}]`, w / 2, Math.round(35 * s));
  }

  // Disconnect overlay
  if (mp.disconnected) {
    ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.fillRect(0, 0, w, h);

    // Icon + title
    ctx.fillStyle = '#ef4444'; ctx.font = `bold ${Math.round(28 * s)}px Arial`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('⚠ Соединение потеряно', w / 2, h / 2 - Math.round(50 * s));

    ctx.fillStyle = '#94a3b8'; ctx.font = `${Math.round(16 * s)}px Arial`;
    ctx.fillText('Другой игрок отключился от игры', w / 2, h / 2 - Math.round(20 * s));

    // "В МЕНЮ" button
    const btnW = Math.min(Math.round(260 * s), w - 40);
    const btnH = Math.round(52 * s);
    const btnX = w / 2 - btnW / 2;
    const btnY = h / 2 + Math.round(20 * s);
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.roundRect(btnX, btnY, btnW, btnH, Math.round(10 * s));
    ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(20 * s)}px Arial`;
    ctx.fillText('В ГЛАВНОЕ МЕНЮ', w / 2, btnY + btnH / 2);
  }

  ctx.restore();
}

export { MISSIONS };
