import { useRef, useEffect, useCallback, useState } from 'react';
import { GameState, Upgrades, GameMode, MultiplayerState, MultiplayerMode, Keys } from './game/types';
import { createInitialState, createInitialStateWithSave, startMission, startRunnerLevel, updateGame, applyUpgrade, saveProgress, loadProgress, MISSIONS } from './game/engine';
import { render, renderMenu, renderBriefing, renderRunnerBriefing, renderSaved, renderFailed, renderUpgrade, renderEnding, renderPaused, getPauseButtonLayout, renderTransition, renderSpeedLines, renderTutorial, renderOrientationHint, renderMultiplayerMenu, getMultiplayerMenuLayout, renderLobby, getLobbyLayout, drawMultiplayerHUD } from './game/renderer';
import { gameAudio } from './game/audio';
import { GameNetwork, NetMessage } from './game/net';
import { serializeKeys, deserializeKeys, createSnapshot, serializeSnapshot, deserializeSnapshot, createFullSyncPayload, applySnapshotToState, applyFullSyncPayload, interpolateSnapshots } from './game/netSync';
import { MP_MISSIONS } from './game/mpMissions';

/** Get the right mission array based on whether we're in multiplayer coopRescue */
function getMissions(state: GameState): typeof MISSIONS {
  return (state.mp?.isMultiplayer && state.mp.multiplayerMode === 'coopRescue') ? MP_MISSIONS : MISSIONS;
}

interface JoystickState {
  active: boolean; startX: number; startY: number;
  currentX: number; currentY: number; touchId: number | null;
}

function sfCalc(w: number, h: number): number {
  return Math.max(0.65, Math.min(1.2, Math.min(w, h) / 500));
}

function vibrate(ms: number | number[]) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

function createDefaultKeys(): Keys {
  return { up: false, down: false, left: false, right: false, space: false, honk: false };
}

function createMultiplayerState(role: 'host' | 'guest'): MultiplayerState {
  return {
    isMultiplayer: true,
    netRole: role,
    multiplayerMode: 'coopRescue',
    lobbyScreen: role === 'host' ? 'hostWaiting' : 'guestEnterCode',
    localPlayer: { id: role === 'host' ? 0 : 1, role, name: role === 'host' ? 'Хост' : 'Гость', keys: createDefaultKeys() },
    remotePlayer: { id: role === 'host' ? 1 : 0, role: role === 'host' ? 'guest' : 'host', name: role === 'host' ? 'Гость' : 'Хост', keys: createDefaultKeys() },
    ambulance2: null,
    runner2: null,
    scores: [0, 0],
    roomCode: '',
    inputCode: '',
    inputError: '',
    ping: 0,
    connected: false,
    prevSnapshot: null,
    currSnapshot: null,
    interpolationT: 0,
    snapshotTime: 0,
    derbyRound: 1,
    derbyWins: [0, 0],
    disconnected: false,
    disconnectTimer: 0,
    roundEndTime: 0,
    rematchRequested: false,
    remoteRematchRequested: false,
    guestUpgrades: { engine: 0, tires: 0, siren: 0, armor: 0 },
    guestMoney: 0,
    hostReady: false,
    guestReady: false,
  };
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const copyInputRef = useRef<HTMLInputElement>(null);
  const stateRef = useRef<GameState>(createInitialStateWithSave());
  const animRef = useRef<number>(0);
  const lastTimeRef = useRef(0);
  const joystickRef = useRef<JoystickState>({ active: false, startX: 0, startY: 0, currentX: 0, currentY: 0, touchId: null });
  const isMobileRef = useRef(false);
  const audioInitRef = useRef(false);
  const orientationDismissedRef = useRef(false);
  const lastCountdownRef = useRef(0);
  const networkRef = useRef<GameNetwork | null>(null);
  const snapshotFrameRef = useRef(0);
  const [, setForceUpdate] = useState(0);

  useEffect(() => { isMobileRef.current = 'ontouchstart' in window || navigator.maxTouchPoints > 0; }, []);

  const initAudio = useCallback(() => {
    if (!audioInitRef.current) {
      gameAudio.init();
      audioInitRef.current = true;
    }
  }, []);

  // === MULTIPLAYER: Network callbacks ===
  const setupNetworkCallbacks = useCallback((net: GameNetwork) => {
    net.onStateChange = (connState) => {
      const s = stateRef.current;
      if (!s.mp) return;
      if (connState === 'connected') {
        stateRef.current = { ...s, mp: { ...s.mp, connected: true, lobbyScreen: 'modeSelect' } };
        setForceUpdate(v => v + 1);
      } else if (connState === 'disconnected') {
        stateRef.current = { ...s, mp: { ...s.mp, disconnected: true } };
        setForceUpdate(v => v + 1);
      }
    };

    net.onMessage = (msg: NetMessage) => {
      const s = stateRef.current;
      if (!s.mp) return;

      switch (msg.type) {
        case 'keys': {
          // Host receives guest's keys (data is [keyByte] array or Uint8Array)
          if (s.mp.netRole === 'host' && msg.data) {
            const arr = msg.data as number[] | Uint8Array;
            const keyByte = arr[0];
            if (typeof keyByte === 'number') {
              const keys = deserializeKeys(keyByte);
              s.mp.remotePlayer.keys = keys;
            }
          }
          break;
        }
        case 'snapshot': {
          // Guest receives state snapshot (data is string)
          if (s.mp.netRole === 'guest') {
            try {
              const snapData = typeof msg.data === 'string' ? msg.data : String(msg.data);
              const snap = deserializeSnapshot(snapData);
              const prevSnap = s.mp.currSnapshot;
              stateRef.current = {
                ...s,
                mp: { ...s.mp, prevSnapshot: prevSnap, currSnapshot: snap, snapshotTime: performance.now(), interpolationT: 0 },
              };
            } catch { /* ignore bad snapshots */ }
          }
          break;
        }
        case 'fullSync': {
          // Guest receives full game state (new round or initial sync)
          if (s.mp.netRole === 'guest') {
            try {
              const payload = msg.data as any;
              // Round end — guest shows saved/failed screen, host will auto-restart
              if (payload.roundEnd) {
                stateRef.current = {
                  ...s,
                  screen: payload.roundEnd as 'saved' | 'failed',
                  missionIndex: payload.missionIndex ?? s.missionIndex,
                  mp: { ...s.mp, roundEndTime: performance.now() },
                };
                gameAudio.siren(false);
                setForceUpdate(v => v + 1);
                break;
              }
              // Victory — all missions completed
              if (payload.victory) {
                stateRef.current = {
                  ...s,
                  screen: 'lobby',
                  missionIndex: 0,
                  mp: { ...s.mp, lobbyScreen: 'modeSelect', roundEndTime: 0 },
                };
                s.flashMessages.push({ text: '🏆 Все миссии пройдены! Победа!', timer: 300, color: '#fbbf24' });
                setForceUpdate(v => v + 1);
                break;
              }
              const newState = applyFullSyncPayload(s, payload, s.mp.multiplayerMode);
              stateRef.current = newState;
              setForceUpdate(v => v + 1);
              // Send ACK so host knows fullSync was received
              net.sendReliable({ type: 'syncAck', seq: 0, ts: performance.now(), data: { buildings: payload.buildings?.length ?? 0 } });
            } catch (err) {
              console.error('Failed to apply full sync:', err);
            }
          }
          break;
        }
        case 'start': {
          // Guest: game is starting
          if (s.mp.netRole === 'guest') {
            stateRef.current = { ...s, screen: 'playing' };
            gameAudio.siren(true);
            setForceUpdate(v => v + 1);
          }
          break;
        }
        case 'modeSelect': {
          // Guest: host selected a mode
          if (s.mp.netRole === 'guest') {
            stateRef.current = { ...s, mp: { ...s.mp, multiplayerMode: msg.data as MultiplayerMode, lobbyScreen: 'modeSelect' } };
            setForceUpdate(v => v + 1);
          }
          break;
        }
        case 'rematch': {
          if (s.mp) {
            stateRef.current = { ...s, mp: { ...s.mp, remoteRematchRequested: true } };
            setForceUpdate(v => v + 1);
          }
          break;
        }
        case 'briefing': {
          // Guest: host sent briefing → show briefing screen
          if (s.mp.netRole === 'guest') {
            const d = msg.data as { missionIndex: number };
            stateRef.current = {
              ...s,
              screen: 'briefing',
              missionIndex: d.missionIndex,
              mp: { ...s.mp, hostReady: false, guestReady: false },
            };
            setForceUpdate(v => v + 1);
          }
          break;
        }
        case 'upgrade': {
          // Guest: host sent upgrade screen data
          if (s.mp.netRole === 'guest') {
            const d = msg.data as { missionIndex: number; guestMoney: number; guestUpgrades: import('./game/types').Upgrades };
            stateRef.current = {
              ...s,
              screen: 'upgrade',
              missionIndex: d.missionIndex,
              // Guest uses their own money/upgrades stored on host and synced here
              money: d.guestMoney,
              upgrades: d.guestUpgrades,
              mp: { ...s.mp, hostReady: false, guestReady: false, guestMoney: d.guestMoney, guestUpgrades: d.guestUpgrades },
            };
            setForceUpdate(v => v + 1);
          }
          break;
        }
        case 'upgradeChoice': {
          // Host: guest selected an upgrade
          if (s.mp.netRole === 'host' && s.mp) {
            const upgradeKey = msg.data as keyof import('./game/types').Upgrades;
            const gu = { ...s.mp.guestUpgrades };
            const level = gu[upgradeKey];
            const cost = (level + 1) * 100;
            if (level < 3 && s.mp.guestMoney >= cost) {
              gu[upgradeKey] = level + 1;
              const newGuestMoney = s.mp.guestMoney - cost;
              stateRef.current = {
                ...s,
                mp: { ...s.mp, guestUpgrades: gu, guestMoney: newGuestMoney },
              };
              // Confirm update back to guest
              networkRef.current?.sendReliable({
                type: 'upgrade', seq: 0, ts: performance.now(),
                data: { missionIndex: s.missionIndex, guestMoney: newGuestMoney, guestUpgrades: gu },
              });
              setForceUpdate(v => v + 1);
            }
          }
          break;
        }
        case 'ready': {
          // Remote player is ready (on briefing or upgrade screen)
          if (s.mp) {
            const isRemoteHost = s.mp.netRole === 'guest'; // if we're guest, remote is host
            let newMp: typeof s.mp;
            if (isRemoteHost) {
              newMp = { ...s.mp, hostReady: true };
            } else {
              newMp = { ...s.mp, guestReady: true };
            }
            stateRef.current = { ...s, mp: newMp };

            // Host: if on upgrade screen and both ready → go to briefing
            if (s.mp.netRole === 'host' && s.screen === 'upgrade' && newMp.hostReady && newMp.guestReady) {
              stateRef.current = {
                ...stateRef.current,
                screen: 'briefing',
                mp: { ...newMp, hostReady: false, guestReady: false },
              };
              const net2 = networkRef.current;
              net2?.sendReliable({ type: 'briefing', seq: 0, ts: performance.now(), data: { missionIndex: s.missionIndex } });
            }
            setForceUpdate(v => v + 1);
          }
          break;
        }
      }
    };

    // Update ping periodically
    const pingUpdater = setInterval(() => {
      const s = stateRef.current;
      if (s.mp && net.isConnected) {
        stateRef.current = { ...s, mp: { ...s.mp, ping: net.ping } };
      }
    }, 2000);

    // Store cleanup for this interval
    const origDestroy = net.destroy.bind(net);
    net.destroy = () => { clearInterval(pingUpdater); origDestroy(); };
  }, []);

  // === MULTIPLAYER: Start game (host) ===
  const startMultiplayerGame = useCallback((overrideMissionIdx?: number) => {
    const s = stateRef.current;
    if (!s.mp || s.mp.netRole !== 'host') return;
    const net = networkRef.current;
    if (!net?.isConnected) return;

    // Start a mission using the multiplayer mode
    const mode = s.mp.multiplayerMode;
    const missionIdx = overrideMissionIdx ?? s.missionIndex;
    let newState: GameState;

    if (mode === 'copsAndRobbers') {
      // P1 is ambulance, P2 is runner
      newState = startMission(s, missionIdx);
      newState.gameMode = mode;
    } else {
      // All other modes: start as ambulance mode mission
      newState = startMission(s, missionIdx);
      newState.gameMode = mode;
    }

    // If all missions done, return to lobby with victory message
    if (newState.screen === 'ending') {
      stateRef.current = {
        ...s,
        screen: 'lobby',
        missionIndex: 0,
        mp: { ...s.mp, lobbyScreen: 'modeSelect', roundEndTime: 0 },
      };
      s.flashMessages.push({ text: '🏆 Все миссии пройдены! Победа!', timer: 300, color: '#fbbf24' });
      net.sendReliable({ type: 'fullSync', seq: 0, ts: performance.now(), data: { victory: true } });
      setForceUpdate(v => v + 1);
      return;
    }

    // Create second ambulance or runner for MP (apply guest upgrades)
    if (mode === 'coopRescue' || mode === 'demolitionDerby' || mode === 'patientRace') {
      const gu = s.mp.guestUpgrades;
      const amb2 = { ...newState.ambulance };
      amb2.x += 80;
      amb2.y += 80;
      amb2.angle = 0;
      // Apply guest's own upgrades to amb2
      amb2.maxSpeed = 5 + gu.engine * 1.2;
      amb2.acceleration = 0.4 + gu.engine * 0.1;
      amb2.handling = 0.92 + gu.tires * 0.015;
      amb2.health = 100 + gu.armor * 25;
      newState.mp = { ...s.mp, ambulance2: amb2, scores: [0, 0] };
    } else if (mode === 'copsAndRobbers') {
      // P2 is a runner
      const runner2 = {
        x: newState.ambulance.x + 300, y: newState.ambulance.y + 300,
        vx: 0, vy: 0, angle: 0,
        stamina: 100, maxStamina: 100, sprinting: false, speed: 0,
        smokeBombTimer: 0, invisibleTimer: 0, speedBoostTimer: 0,
        dialogueTimer: 0, currentDialogue: '', caughtTimer: 0,
        playerHealth: 100, maxPlayerHealth: 100,
        interactingHazard: false, dashCooldown: 0,
      };
      newState.mp = { ...s.mp, runner2: runner2, ambulance2: null, scores: [0, 0] };
    }

    if (!newState.mp) newState.mp = s.mp;
    newState.screen = 'playing';

    stateRef.current = newState;
    gameAudio.siren(true);

    // Send full sync to guest with retry
    const payload = createFullSyncPayload(newState);
    let syncAcked = false;
    const sendFullSync = () => {
      net.sendReliable({ type: 'fullSync', seq: 0, ts: performance.now(), data: payload });
    };
    sendFullSync();
    // Retry fullSync 3 times if no ACK (500ms, 1s, 2s)
    const retryTimers = [
      setTimeout(() => { if (!syncAcked) sendFullSync(); }, 500),
      setTimeout(() => { if (!syncAcked) sendFullSync(); }, 1200),
      setTimeout(() => { if (!syncAcked) sendFullSync(); }, 2500),
    ];
    // Listen for ACK (handled in message handler, set flag via closure)
    const origHandler = net.onMessage;
    net.onMessage = (msg) => {
      if (msg.type === 'syncAck') { syncAcked = true; retryTimers.forEach(t => clearTimeout(t)); net.onMessage = origHandler; }
      if (origHandler) origHandler(msg);
    };
    // Tell guest to start (after short delay to let fullSync arrive first)
    setTimeout(() => {
      net.sendReliable({ type: 'start', seq: 0, ts: performance.now(), data: null });
    }, 150);

    setForceUpdate(v => v + 1);
  }, []);

  const handleAction = useCallback((clickX?: number, clickY?: number) => {
    initAudio();
    const state = stateRef.current;
    const canvas = canvasRef.current;

    // Check for "back to menu" button on saved/failed screens
    const isMenuBtn = (cx: number | undefined, cy: number | undefined, w: number, h: number): boolean => {
      if (cx === undefined || cy === undefined) return false;
      const s = sfCalc(w, h);
      const btnH = Math.round(56 * s);
      const btnW = Math.min(Math.round(300 * s), w - 32);
      const btnX = w / 2 - btnW / 2;
      // Menu button is below primary button
      const menuBtnGap = Math.round(12 * s);
      const menuBtnH = Math.round(42 * s);
      // We need the primary button Y to compute menu button Y
      // Simple heuristic: menu button is in the lower portion of screen
      const menuBtnY = h - btnH - 20 + btnH + menuBtnGap;
      return cx >= btnX && cx <= btnX + btnW && cy >= menuBtnY - 30 && cy <= menuBtnY + menuBtnH + 10;
    };

    // Multiplayer disconnect: click anywhere on ANY screen → return to menu
    if (state.mp?.disconnected) {
      gameAudio.siren(false);
      networkRef.current?.destroy();
      networkRef.current = null;
      stateRef.current = createInitialStateWithSave();
      setForceUpdate(v => v + 1);
      return;
    }

    switch (state.screen) {
      case 'menu': {
        if (canvas && clickX !== undefined && clickY !== undefined) {
          const w = canvas.width, h = canvas.height;
          const s = sfCalc(w, h);

          const emojiS = Math.round(50 * s);
          const titleS = Math.round(36 * s);
          const subS = Math.round(22 * s);
          const tagS = Math.round(14 * s);
          const btnH = Math.round(56 * s);
          const btnGap = Math.round(14 * s);
          const totalH = emojiS + 10 + titleS + 10 + subS + 8 + tagS + 30 + btnH * 4 + btnGap * 3 + 30;
          const startY = Math.max(20, (h - totalH) / 2);
          const buttonsY = startY + emojiS + 10 + titleS + 10 + subS + 8 + tagS + 30;

          const btnW = Math.min(Math.round(320 * s), w - 32);
          const btnX = w / 2 - btnW / 2;

          // 4 buttons: ambulance, runner, extremal, multiplayer
          let pickedIdx = -1;
          for (let i = 0; i < 4; i++) {
            const by = buttonsY + i * (btnH + btnGap);
            if (clickX >= btnX && clickX <= btnX + btnW && clickY >= by && clickY <= by + btnH) {
              pickedIdx = i; break;
            }
          }
          if (pickedIdx < 0) return;

          // Request fullscreen on mobile
          if (isMobileRef.current) {
            try { document.documentElement.requestFullscreen?.(); } catch { /* noop */ }
          }

          if (pickedIdx === 3) {
            // Multiplayer menu
            stateRef.current = { ...state, screen: 'multiplayerMenu' };
          } else {
            const modes: GameMode[] = ['ambulance', 'runner', 'extremal'];
            const picked = modes[pickedIdx];
            if (picked === 'ambulance') {
              stateRef.current = { ...state, gameMode: 'ambulance', screen: 'briefing' };
            } else {
              stateRef.current = { ...state, gameMode: picked, screen: 'briefing', runnerLevel: state.runnerLevel || 1, runnerScore: 0 };
            }
          }
        } else {
          return;
        }
        break;
      }
      case 'briefing': {
        if (state.mp?.isMultiplayer) {
          // Multiplayer: only host can start from briefing
          if (state.mp.netRole === 'host') {
            startMultiplayerGame(state.missionIndex);
          }
          // Guest: do nothing on click (waits for host)
        } else {
          // Solo mode
          if (state.gameMode === 'runner' || state.gameMode === 'extremal') {
            stateRef.current = startRunnerLevel(state);
          } else {
            stateRef.current = startMission(state, state.missionIndex);
          }
          gameAudio.siren(true);
        }
        break;
      }
      case 'paused': {
        if (canvas && clickX !== undefined && clickY !== undefined) {
          const w = canvas.width, h = canvas.height;
          const layout = getPauseButtonLayout(w, h);
          for (let i = 0; i < 3; i++) {
            const by = layout.startY + i * (layout.btnH + layout.btnGap);
            if (clickX >= layout.btnX && clickX <= layout.btnX + layout.btnW && clickY >= by && clickY <= by + layout.btnH) {
              if (i === 0) { // Resume
                stateRef.current = { ...state, screen: 'playing' };
                gameAudio.siren(true);
              } else if (i === 1) { // Restart
                if (state.gameMode === 'runner' || state.gameMode === 'extremal') {
                  stateRef.current = startRunnerLevel(state);
                } else {
                  stateRef.current = startMission(state, state.missionIndex);
                }
                gameAudio.siren(true);
              } else { // Menu
                gameAudio.siren(false);
                stateRef.current = createInitialStateWithSave();
              }
              break;
            }
          }
        } else {
          stateRef.current = { ...state, screen: 'playing' };
          gameAudio.siren(true);
        }
        break;
      }
      case 'saved': {
        // Check for menu button click
        if (canvas && clickX !== undefined && clickY !== undefined) {
          if (isMenuBtn(clickX, clickY, canvas.width, canvas.height)) {
            gameAudio.siren(false);
            saveProgress(state);
            if (state.mp) { networkRef.current?.destroy(); networkRef.current = null; }
            stateRef.current = createInitialStateWithSave();
            break;
          }
        }
        gameAudio.siren(false);
        // Multiplayer: wait for auto-return (game loop handles it after 3s)
        if (state.mp?.isMultiplayer) {
          break; // do nothing on click — auto-returns to lobby
        }
        saveProgress(state);
        if (state.gameMode === 'runner' || state.gameMode === 'extremal') {
          const isExtremal = state.gameMode === 'extremal';
          const won = isExtremal
            ? (state.runner?.playerHealth ?? 1) <= 0
            : state.surviveTime >= state.surviveTarget;
          if (won) {
            stateRef.current = { ...state, screen: 'briefing' };
          } else {
            stateRef.current = startRunnerLevel(state);
          }
        } else {
          const nextIdx = state.missionIndex + 1;
          if (nextIdx < MISSIONS.length) {
            stateRef.current = { ...state, screen: 'upgrade', missionIndex: nextIdx };
          } else {
            stateRef.current = { ...state, screen: 'ending' };
          }
        }
        break;
      }
      case 'failed': {
        // Check for menu button click (solo only)
        if (!state.mp && canvas && clickX !== undefined && clickY !== undefined) {
          if (isMenuBtn(clickX, clickY, canvas.width, canvas.height)) {
            gameAudio.siren(false);
            stateRef.current = createInitialStateWithSave();
            break;
          }
        }
        gameAudio.siren(false);
        // Multiplayer: wait for auto-return (game loop handles it after 3s)
        if (state.mp?.isMultiplayer) {
          break; // do nothing on click — auto-returns to lobby
        }
        if (state.gameMode === 'runner' || state.gameMode === 'extremal') {
          stateRef.current = startRunnerLevel(state);
        } else {
          stateRef.current = startMission(state, state.missionIndex);
        }
        break;
      }
      case 'upgrade': {
        if (canvas && clickX !== undefined && clickY !== undefined) {
          const upgradeKeys: (keyof Upgrades)[] = ['engine', 'tires', 'siren', 'armor'];
          const w = canvas.width, h = canvas.height;
          const s = sfCalc(w, h);

          const titleFS = Math.round(28 * s);
          const moneyFS = Math.round(22 * s);
          const cardH = Math.round(70 * s);
          const cardGap = Math.round(12 * s);
          const btnH = Math.round(54 * s);

          const totalH = titleFS + 20 + moneyFS + 20 + upgradeKeys.length * (cardH + cardGap) + 20 + btnH;
          const startY = Math.max(16, (h - totalH) / 2);
          const cardsY = startY + titleFS + 20 + moneyFS + 20;

          const cardW = Math.min(Math.round(380 * s), w - 24);
          const cardX = w / 2 - cardW / 2;

          for (let i = 0; i < upgradeKeys.length; i++) {
            const cy = cardsY + i * (cardH + cardGap);
            if (clickX >= cardX && clickX <= cardX + cardW && clickY >= cy && clickY <= cy + cardH) {
              if (state.mp?.isMultiplayer && state.mp.netRole === 'guest') {
                // Guest: send upgrade choice to host
                networkRef.current?.sendReliable({
                  type: 'upgradeChoice', seq: 0, ts: performance.now(), data: upgradeKeys[i],
                });
                gameAudio.powerup();
              } else {
                // Solo or Host: apply upgrade locally
                const newState = applyUpgrade(state, upgradeKeys[i]);
                if (newState !== state) gameAudio.powerup();
                stateRef.current = newState;
                if (!state.mp) saveProgress(newState);
              }
              setForceUpdate(v => v + 1);
              return;
            }
          }
          // "ПРОДОЛЖИТЬ" / "ГОТОВ" button
          const btnTop = cardsY + upgradeKeys.length * (cardH + cardGap);
          if (clickY >= btnTop) {
            if (state.mp?.isMultiplayer) {
              // Multiplayer: mark self as ready
              const mp = state.mp;
              const net = networkRef.current;
              if (mp.netRole === 'host') {
                stateRef.current = { ...state, mp: { ...mp, hostReady: true } };
                net?.sendReliable({ type: 'ready', seq: 0, ts: performance.now(), data: null });
                // If both ready → go to briefing
                if (mp.guestReady) {
                  stateRef.current = { ...stateRef.current, screen: 'briefing', mp: { ...stateRef.current.mp!, hostReady: false, guestReady: false } };
                  net?.sendReliable({ type: 'briefing', seq: 0, ts: performance.now(), data: { missionIndex: state.missionIndex } });
                }
              } else {
                stateRef.current = { ...state, mp: { ...mp, guestReady: true } };
                net?.sendReliable({ type: 'ready', seq: 0, ts: performance.now(), data: null });
                // If both ready → host will transition (guest just waits)
              }
              setForceUpdate(v => v + 1);
            } else {
              stateRef.current = { ...state, screen: 'briefing' };
            }
          }
        } else if (!state.mp) {
          stateRef.current = { ...state, screen: 'briefing' };
        }
        break;
      }
      case 'multiplayerMenu': {
        if (canvas && clickX !== undefined && clickY !== undefined) {
          const w = canvas.width, h = canvas.height;
          const layout = getMultiplayerMenuLayout(w, h);
          for (let i = 0; i < 3; i++) {
            const by = layout.startY + i * (layout.btnH + layout.btnGap);
            if (clickX >= layout.btnX && clickX <= layout.btnX + layout.btnW && clickY >= by && clickY <= by + layout.btnH) {
              if (i === 0) {
                // Host — create room via PeerJS
                const mpState = createMultiplayerState('host');
                stateRef.current = { ...state, screen: 'lobby', mp: mpState };
                const net = new GameNetwork();
                networkRef.current = net;
                setupNetworkCallbacks(net);
                net.createRoom().then(roomCode => {
                  const s = stateRef.current;
                  if (s.mp) {
                    stateRef.current = { ...s, mp: { ...s.mp, roomCode } };
                    setForceUpdate(v => v + 1);
                  }
                }).catch(err => {
                  console.error('Failed to create room:', err);
                });
              } else if (i === 1) {
                // Guest — enter room code
                const mpState = createMultiplayerState('guest');
                stateRef.current = { ...state, screen: 'lobby', mp: mpState };
                networkRef.current = new GameNetwork();
                setupNetworkCallbacks(networkRef.current);
              } else {
                // Back
                stateRef.current = { ...state, screen: 'menu' };
              }
              break;
            }
          }
        }
        break;
      }
      case 'lobby': {
        if (!canvas || clickX === undefined || clickY === undefined) break;
        const mp = state.mp;
        if (!mp) break;
        const w = canvas.width, h = canvas.height;
        const layout = getLobbyLayout(w, h);

        // Back button (always at bottom)
        if (clickY >= layout.backY && clickY <= layout.backY + layout.backBtnH &&
            clickX >= layout.btnX && clickX <= layout.btnX + layout.btnW) {
          networkRef.current?.destroy();
          networkRef.current = null;
          stateRef.current = createInitialStateWithSave();
          break;
        }

        // Host waiting: copy room code button
        if (mp.lobbyScreen === 'hostWaiting' && mp.roomCode) {
          let y = Math.round(30 * layout.s) + layout.titleS + 20 + layout.textS + 20;
          y += layout.smallS + 15; // label
          y += Math.round(70 * layout.s) + 15; // room code display
          const cpyH = Math.round(44 * layout.s);
          if (clickY >= y && clickY <= y + cpyH &&
              clickX >= layout.btnX && clickX <= layout.btnX + layout.btnW) {
            // Multi-strategy copy for iOS/Android/Desktop
            const code = mp.roomCode;
            let copied = false;
            // Strategy 1: Native share (works perfectly on iOS/Android)
            if (navigator.share) {
              navigator.share({ text: code }).catch(() => {});
              copied = true;
            }
            // Strategy 2: Hidden input select+copy (iOS Safari compatible)
            if (!copied && copyInputRef.current) {
              const inp = copyInputRef.current;
              inp.value = code;
              inp.style.display = 'block';
              inp.focus();
              inp.setSelectionRange(0, code.length);
              try { copied = document.execCommand('copy'); } catch {}
              inp.style.display = 'none';
            }
            // Strategy 3: Clipboard API
            if (!copied) {
              try { navigator.clipboard?.writeText(code).catch(() => {}); } catch {}
            }
            // Visual feedback
            stateRef.current.flashMessages.push({ text: '✅ Код скопирован!', timer: 120, color: '#34d399' });
            break;
          }
        }

        // Guest: Canvas-based room code input
        if (mp.lobbyScreen === 'guestEnterCode') {
          let y = Math.round(30 * layout.s) + layout.titleS + 20 + layout.textS + 20;
          y += layout.smallS + 15;
          // Code input boxes area
          const boxSize = Math.round(44 * layout.s);
          const boxGap = Math.round(8 * layout.s);
          const totalBoxW = 6 * boxSize + 5 * boxGap;
          const boxStartX = w / 2 - totalBoxW / 2;
          y += boxSize + 15; // skip past boxes

          // Backspace button
          const backBtnW = Math.round(60 * layout.s);
          const backBtnH = Math.round(38 * layout.s);
          const backBtnX = w / 2 + totalBoxW / 2 - backBtnW;
          if (mp.inputCode.length > 0 &&
              clickX >= backBtnX && clickX <= backBtnX + backBtnW &&
              clickY >= y && clickY <= y + backBtnH) {
            stateRef.current = { ...state, mp: { ...mp, inputCode: mp.inputCode.slice(0, -1), inputError: '' } };
            setForceUpdate(v => v + 1);
            break;
          }
          y += backBtnH + 12;

          // On-screen keyboard (4 rows of 8 chars)
          const kbChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
          const kbCols = 8;
          const kbRows = Math.ceil(kbChars.length / kbCols);
          const kbBtnS = Math.round(38 * layout.s);
          const kbGap = Math.round(6 * layout.s);
          const kbTotalW = kbCols * kbBtnS + (kbCols - 1) * kbGap;
          const kbStartX = w / 2 - kbTotalW / 2;

          for (let r = 0; r < kbRows; r++) {
            for (let c = 0; c < kbCols; c++) {
              const idx = r * kbCols + c;
              if (idx >= kbChars.length) break;
              const bx = kbStartX + c * (kbBtnS + kbGap);
              const by = y + r * (kbBtnS + kbGap);
              if (clickX >= bx && clickX <= bx + kbBtnS && clickY >= by && clickY <= by + kbBtnS) {
                if (mp.inputCode.length < 6) {
                  const newCode = mp.inputCode + kbChars[idx];
                  stateRef.current = { ...state, mp: { ...mp, inputCode: newCode, inputError: '' } };
                  setForceUpdate(v => v + 1);
                  // Auto-connect when 6 chars entered
                  if (newCode.length === 6 && networkRef.current) {
                    networkRef.current.joinRoom(newCode).catch((err) => {
                      const s2 = stateRef.current;
                      if (s2.mp) {
                        const errMsg = networkRef.current?.lastError || err?.message || 'Комната не найдена';
                        stateRef.current = { ...s2, mp: { ...s2.mp, inputCode: '', inputError: errMsg } };
                        setForceUpdate(v => v + 1);
                      }
                    });
                  }
                }
                break;
              }
            }
          }
          break;
        }

        // Mode select buttons (host only)
        if ((mp.lobbyScreen === 'modeSelect' || mp.lobbyScreen === 'connected') && mp.netRole === 'host') {
          let y = Math.round(30 * layout.s) + layout.titleS + 20 + layout.textS + 20;
          if (mp.connected) y += layout.smallS + 15; // ping
          y += layout.smallS + 15; // "Choose mode" label

          const modes: MultiplayerMode[] = ['coopRescue', 'copsAndRobbers', 'demolitionDerby', 'patientRace'];
          const modeBtnH = Math.round(52 * layout.s);
          for (let i = 0; i < modes.length; i++) {
            const by = y + i * (modeBtnH + layout.btnGap);
            if (clickX >= layout.btnX && clickX <= layout.btnX + layout.btnW && clickY >= by && clickY <= by + modeBtnH) {
              stateRef.current = { ...state, mp: { ...mp, multiplayerMode: modes[i] } };
              // Notify guest of mode selection
              networkRef.current?.sendReliable({
                type: 'modeSelect', seq: 0, ts: performance.now(), data: modes[i],
              });
              setForceUpdate(v => v + 1);
              break;
            }
          }

          // START button → go to briefing (not directly to game)
          const startY = y + modes.length * (modeBtnH + layout.btnGap) + 10;
          if (clickY >= startY && clickY <= startY + layout.btnH &&
              clickX >= layout.btnX && clickX <= layout.btnX + layout.btnW) {
            // Go to briefing screen, notify guest
            stateRef.current = {
              ...state,
              screen: 'briefing',
              missionIndex: state.missionIndex || 0,
              mp: { ...mp, hostReady: false, guestReady: false },
            };
            networkRef.current?.sendReliable({
              type: 'briefing', seq: 0, ts: performance.now(),
              data: { missionIndex: state.missionIndex || 0 },
            });
            setForceUpdate(v => v + 1);
          }
        }

        break;
      }
      case 'ending': {
        stateRef.current = createInitialState();
        break;
      }
    }
    setForceUpdate(v => v + 1);
  }, [initAudio]);

  // Keyboard
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      initAudio();
      const state = stateRef.current;

      // Lobby: typing room code (desktop keyboard)
      if (state.screen === 'lobby' && state.mp?.lobbyScreen === 'guestEnterCode') {
        const validChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const ch = e.key.toUpperCase();
        if (ch === 'BACKSPACE' && state.mp.inputCode.length > 0) {
          e.preventDefault();
          stateRef.current = { ...state, mp: { ...state.mp, inputCode: state.mp.inputCode.slice(0, -1), inputError: '' } };
          setForceUpdate(v => v + 1);
          return;
        }
        if (ch.length === 1 && validChars.includes(ch) && state.mp.inputCode.length < 6) {
          e.preventDefault();
          const newCode = state.mp.inputCode + ch;
          stateRef.current = { ...state, mp: { ...state.mp, inputCode: newCode, inputError: '' } };
          setForceUpdate(v => v + 1);
          // Auto-connect at 6 chars
          if (newCode.length === 6 && networkRef.current) {
            networkRef.current.joinRoom(newCode).catch((err) => {
              const s2 = stateRef.current;
              if (s2.mp) {
                const errMsg = networkRef.current?.lastError || err?.message || 'Комната не найдена';
                stateRef.current = { ...s2, mp: { ...s2.mp, inputCode: '', inputError: errMsg } };
                setForceUpdate(v => v + 1);
              }
            });
          }
          return;
        }
        if (ch === 'ESCAPE') {
          networkRef.current?.destroy();
          networkRef.current = null;
          stateRef.current = createInitialStateWithSave();
          setForceUpdate(v => v + 1);
          return;
        }
        return; // don't process game keys while typing
      }

      const keys = state.keys;
      switch (e.key) {
        case 'ArrowUp': case 'w': case 'W': case 'ц': case 'Ц': keys.up = true; e.preventDefault(); break;
        case 'ArrowDown': case 's': case 'S': case 'ы': case 'Ы': keys.down = true; e.preventDefault(); break;
        case 'ArrowLeft': case 'a': case 'A': case 'ф': case 'Ф': keys.left = true; e.preventDefault(); break;
        case 'ArrowRight': case 'd': case 'D': case 'в': case 'В': keys.right = true; e.preventDefault(); break;
        case ' ':
          e.preventDefault();
          if (state.screen === 'playing') keys.space = true;
          else handleAction();
          break;
        case 'h': case 'H': case 'р': case 'Р': keys.honk = true; break;
        case 'Escape':
          e.preventDefault();
          if (state.mp?.disconnected) {
            // Disconnected on ANY screen — Escape goes to menu
            gameAudio.siren(false);
            networkRef.current?.destroy();
            networkRef.current = null;
            stateRef.current = createInitialStateWithSave();
            setForceUpdate(v => v + 1);
          } else if (state.screen === 'playing') {
            stateRef.current = { ...state, screen: 'paused' };
            gameAudio.siren(false);
            setForceUpdate(v => v + 1);
          } else if (state.screen === 'paused') {
            stateRef.current = { ...state, screen: 'playing' };
            gameAudio.siren(true);
            setForceUpdate(v => v + 1);
          }
          break;
        case 'm': case 'M': case 'ь': case 'Ь':
          gameAudio.toggleMute();
          break;
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      const keys = stateRef.current.keys;
      switch (e.key) {
        case 'ArrowUp': case 'w': case 'W': case 'ц': case 'Ц': keys.up = false; break;
        case 'ArrowDown': case 's': case 'S': case 'ы': case 'Ы': keys.down = false; break;
        case 'ArrowLeft': case 'a': case 'A': case 'ф': case 'Ф': keys.left = false; break;
        case 'ArrowRight': case 'd': case 'D': case 'в': case 'В': keys.right = false; break;
        case ' ': keys.space = false; break;
        case 'h': case 'H': case 'р': case 'Р': keys.honk = false; break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => { window.removeEventListener('keydown', handleKeyDown); window.removeEventListener('keyup', handleKeyUp); };
  }, [handleAction, initAudio]);

  // Touch
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const JOY_RADIUS = 60, JOY_DEAD = 10;

    const handleTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      initAudio();
      const state = stateRef.current;

      // Dismiss orientation hint
      if (!orientationDismissedRef.current && isMobileRef.current && canvas.height > canvas.width * 1.1) {
        orientationDismissedRef.current = true;
        return;
      }

      if (state.screen !== 'playing') {
        const rect = canvas.getBoundingClientRect();
        const touch = e.changedTouches[0];
        const x = (touch.clientX - rect.left) * (canvas.width / rect.width);
        const y = (touch.clientY - rect.top) * (canvas.height / rect.height);
        handleAction(x, y);
        return;
      }
      const rect = canvas.getBoundingClientRect();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        const tx = touch.clientX - rect.left, ty = touch.clientY - rect.top;

        // Check pause button (top-right corner)
        if (tx > rect.width - 60 && ty < 60) {
          stateRef.current = { ...state, screen: 'paused' };
          gameAudio.siren(false);
          setForceUpdate(v => v + 1);
          return;
        }

        if (tx > rect.width * 0.6) {
          if (ty < rect.height * 0.45) state.keys.space = true;
          else state.keys.honk = true;
        } else if (!joystickRef.current.active) {
          joystickRef.current = { active: true, startX: tx, startY: ty, currentX: tx, currentY: ty, touchId: touch.identifier };
        }
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      if (stateRef.current.screen !== 'playing') return;
      const rect = canvas.getBoundingClientRect();
      const joy = joystickRef.current;
      const keys = stateRef.current.keys;
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        if (joy.active && touch.identifier === joy.touchId) {
          const tx = touch.clientX - rect.left, ty = touch.clientY - rect.top;
          const dx = tx - joy.startX, dy = ty - joy.startY;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d > JOY_RADIUS) { joy.currentX = joy.startX + (dx / d) * JOY_RADIUS; joy.currentY = joy.startY + (dy / d) * JOY_RADIUS; }
          else { joy.currentX = tx; joy.currentY = ty; }
          const jdx = joy.currentX - joy.startX, jdy = joy.currentY - joy.startY;
          keys.up = jdy < -JOY_DEAD; keys.down = jdy > JOY_DEAD;
          keys.left = jdx < -JOY_DEAD; keys.right = jdx > JOY_DEAD;
        }
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      e.preventDefault();
      const keys = stateRef.current.keys;
      const joy = joystickRef.current;
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        if (joy.active && touch.identifier === joy.touchId) {
          joy.active = false; joy.touchId = null;
          keys.up = false; keys.down = false; keys.left = false; keys.right = false;
        } else { keys.space = false; keys.honk = false; }
      }
    };

    canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
    canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
    canvas.addEventListener('touchend', handleTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', handleTouchEnd, { passive: false });
    return () => {
      canvas.removeEventListener('touchstart', handleTouchStart);
      canvas.removeEventListener('touchmove', handleTouchMove);
      canvas.removeEventListener('touchend', handleTouchEnd);
      canvas.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [handleAction, initAudio]);

  // Joystick overlay + pause button
  const drawJoystick = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    if (!isMobileRef.current) return;
    const state = stateRef.current;
    if (state.screen !== 'playing') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = w / rect.width, scaleY = h / rect.height;
    const joy = joystickRef.current;
    const isExtremal = state.gameMode === 'extremal';
    const isRunner = state.gameMode === 'runner' || isExtremal;

    // Pause button (top-right)
    const pauseX = w - 35 * scaleX, pauseY = 35 * scaleY;
    ctx.beginPath(); ctx.arc(pauseX, pauseY, 22 * scaleX, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = `bold ${14 * scaleX}px Arial`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('⏸', pauseX, pauseY);

    if (joy.active) {
      const bx = joy.startX * scaleX, by = joy.startY * scaleY;
      const kx = joy.currentX * scaleX, ky = joy.currentY * scaleY;
      const r = 60 * scaleX;
      ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(kx, ky);
      ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 3; ctx.stroke();
      ctx.beginPath(); ctx.arc(kx, ky, 20 * scaleX, 0, Math.PI * 2);
      const grad = ctx.createRadialGradient(kx, ky, 0, kx, ky, 20 * scaleX);
      grad.addColorStop(0, 'rgba(255,255,255,0.5)'); grad.addColorStop(1, 'rgba(255,255,255,0.15)');
      ctx.fillStyle = grad; ctx.fill();
    } else {
      const hx = 80 * scaleX, hy = h - 110 * scaleY;
      ctx.beginPath(); ctx.arc(hx, hy, 45 * scaleX, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.04)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 2; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.font = `${14 * scaleX}px Arial`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('▲', hx, hy - 22 * scaleY); ctx.fillText('▼', hx, hy + 22 * scaleY);
      ctx.fillText('◄', hx - 22 * scaleX, hy); ctx.fillText('►', hx + 22 * scaleX, hy);
    }

    const btnSize = 44 * scaleX;

    // Sprint button - higher up
    const tbx = w - 75 * scaleX, tby = h - 210 * scaleY;
    ctx.beginPath(); ctx.arc(tbx, tby, btnSize, 0, Math.PI * 2);
    ctx.fillStyle = state.keys.space
      ? (isRunner ? 'rgba(251,191,36,0.5)' : 'rgba(0,150,255,0.5)')
      : (isRunner ? 'rgba(200,150,0,0.15)' : 'rgba(0,100,200,0.15)');
    ctx.fill();
    ctx.strokeStyle = isRunner ? 'rgba(251,191,36,0.4)' : 'rgba(0,150,255,0.4)';
    ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.font = `bold ${18 * scaleX}px Arial`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(isRunner ? '⚡' : '📢', tbx, tby);
    ctx.font = `${10 * scaleX}px Arial`; ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.fillText(isRunner ? 'СПРИНТ' : 'СИРЕНА', tbx, tby + btnSize + 12);

    // Honk/Dash button - lower
    const bbx = w - 75 * scaleX, bby = h - 80 * scaleY;
    ctx.beginPath(); ctx.arc(bbx, bby, btnSize, 0, Math.PI * 2);
    ctx.fillStyle = state.keys.honk
      ? (isExtremal ? 'rgba(239,68,68,0.5)' : 'rgba(255,200,0,0.4)')
      : (isExtremal ? 'rgba(150,0,0,0.15)' : 'rgba(200,150,0,0.1)');
    ctx.fill();
    ctx.strokeStyle = isExtremal ? 'rgba(239,68,68,0.3)' : 'rgba(255,200,0,0.3)';
    ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.font = `bold ${18 * scaleX}px Arial`;
    ctx.fillText(isExtremal ? '💀' : '📯', bbx, bby);
    ctx.font = `${10 * scaleX}px Arial`; ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.fillText(isExtremal ? 'РЫВОК' : 'ГУДОК', bbx, bby + btnSize + 12);

    ctx.textBaseline = 'alphabetic';
  }, []);

  // Game loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resizeCanvas = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    const gameLoop = (timestamp: number) => {
      if (!lastTimeRef.current) lastTimeRef.current = timestamp;
      const elapsed = timestamp - lastTimeRef.current;
      lastTimeRef.current = timestamp;
      const dt = Math.min(elapsed / 1000, 0.05);

      const prevScreen = stateRef.current.screen;
      const isMP = !!stateRef.current.mp?.isMultiplayer;
      const isHost = stateRef.current.mp?.netRole === 'host';
      const isGuest = stateRef.current.mp?.netRole === 'guest';
      const net = networkRef.current;

      if (stateRef.current.screen === 'playing') {
        // Stop simulation if multiplayer peer disconnected
        const mpDisconnected = stateRef.current.mp?.disconnected;

        if ((!isMP || isHost) && !mpDisconnected) {
          // Solo or Host: run simulation
          const prevMoney = stateRef.current.money;
          stateRef.current = updateGame(stateRef.current, dt);

          // Host MP: mirror money gains to guest
          if (isHost && stateRef.current.mp) {
            const moneyDelta = stateRef.current.money - prevMoney;
            if (moneyDelta > 0) {
              stateRef.current = {
                ...stateRef.current,
                mp: { ...stateRef.current.mp, guestMoney: stateRef.current.mp.guestMoney + moneyDelta },
              };
            }
          }

          // Host: notify guest of round end so they see saved/failed screen too
          if (isHost && net?.isConnected && prevScreen === 'playing' && stateRef.current.screen !== 'playing') {
            const endScreen = stateRef.current.screen; // 'saved' or 'failed'
            net.sendReliable({ type: 'fullSync', seq: 0, ts: performance.now(), data: { roundEnd: endScreen, missionIndex: stateRef.current.missionIndex } });
          }

          // Host: send snapshot every 6th frame (~10/sec) to avoid buffer overflow
          if (isHost && net?.isConnected && stateRef.current.screen === 'playing') {
            snapshotFrameRef.current++;
            if (snapshotFrameRef.current % 6 === 0) {
              const snap = createSnapshot(stateRef.current);
              const snapStr = serializeSnapshot(snap);
              net.sendReliable({ type: 'snapshot', seq: 0, ts: performance.now(), data: snapStr });
            }
          }
        } else if (isGuest && stateRef.current.mp && !mpDisconnected) {
          // Guest: interpolate between snapshots, send keys (every 3rd frame = ~20/sec)
          const mp = stateRef.current.mp;
          if (net?.isConnected) {
            snapshotFrameRef.current++;
            if (snapshotFrameRef.current % 3 === 0) {
              net.sendKeys(serializeKeys(stateRef.current.keys));
            }
          }

          // Interpolate
          if (mp.prevSnapshot && mp.currSnapshot) {
            const elapsed = performance.now() - mp.snapshotTime;
            const snapInterval = 100; // ~10Hz = 100ms between snapshots
            const t = Math.min(1.0, elapsed / snapInterval);
            const interpolated = interpolateSnapshots(mp.prevSnapshot, mp.currSnapshot, t);
            stateRef.current = applySnapshotToState(stateRef.current, interpolated);
          } else if (mp.currSnapshot) {
            stateRef.current = applySnapshotToState(stateRef.current, mp.currSnapshot);
          }

          // Increment time for rendering
          stateRef.current = { ...stateRef.current, time: (stateRef.current.time || 0) + 1 };
        }
      }

      // Multiplayer campaign: auto-transition after saved/failed (3 sec)
      if (isMP && (stateRef.current.screen === 'saved' || stateRef.current.screen === 'failed')) {
        if (!stateRef.current.mp?.roundEndTime) {
          stateRef.current = {
            ...stateRef.current,
            mp: { ...stateRef.current.mp!, roundEndTime: performance.now() },
          };
        } else if (performance.now() - stateRef.current.mp.roundEndTime > 3000) {
          gameAudio.siren(false);
          if (isHost && net?.isConnected) {
            const wasSaved = stateRef.current.screen === 'saved';
            const currentMission = stateRef.current.missionIndex;
            const mp = stateRef.current.mp!;

            if (wasSaved) {
              // Success → advance mission index and go to UPGRADE screen
              const nextMission = currentMission + 1;
              // Check if all missions done
              if (nextMission >= getMissions(stateRef.current).length) {
                // Victory!
                stateRef.current = {
                  ...stateRef.current,
                  screen: 'lobby',
                  missionIndex: 0,
                  mp: { ...mp, lobbyScreen: 'modeSelect', roundEndTime: 0 },
                };
                stateRef.current.flashMessages.push({ text: '🏆 Все миссии пройдены! Победа!', timer: 300, color: '#fbbf24' });
                net.sendReliable({ type: 'fullSync', seq: 0, ts: performance.now(), data: { victory: true } });
              } else {
                // Go to upgrade screen
                stateRef.current = {
                  ...stateRef.current,
                  screen: 'upgrade',
                  missionIndex: nextMission,
                  mp: { ...mp, roundEndTime: 0, hostReady: false, guestReady: false },
                };
                net.sendReliable({
                  type: 'upgrade', seq: 0, ts: performance.now(),
                  data: { missionIndex: nextMission, guestMoney: mp.guestMoney, guestUpgrades: mp.guestUpgrades },
                });
              }
            } else {
              // Failed → go to BRIEFING for same mission (retry)
              stateRef.current = {
                ...stateRef.current,
                screen: 'briefing',
                mp: { ...mp, roundEndTime: 0, hostReady: false, guestReady: false },
              };
              net.sendReliable({
                type: 'briefing', seq: 0, ts: performance.now(),
                data: { missionIndex: currentMission },
              });
            }
            setForceUpdate(v => v + 1);
          }
          // Guest: handled by receiving 'upgrade' or 'briefing' message from host
        }
      }

      // Process audio events
      const audioEvents = stateRef.current.audioEvents;
      if (audioEvents && audioEvents.length > 0) {
        for (const ev of audioEvents) {
          gameAudio.playEvent(ev);
          // Haptic feedback
          if (isMobileRef.current) {
            if (ev === 'collision' || ev === 'hazardDamage') vibrate(50);
            else if (ev === 'catch') vibrate([30, 20, 30]);
            else if (ev === 'fail') vibrate([50, 30, 50, 30, 100]);
            else if (ev === 'win') vibrate([30, 20, 30, 20, 30]);
          }
        }
        stateRef.current = { ...stateRef.current, audioEvents: [] };
      }

      // Countdown beep
      if (stateRef.current.screen === 'playing' && stateRef.current.timeLeft <= 5 && stateRef.current.timeLeft > 0) {
        const sec = Math.ceil(stateRef.current.timeLeft);
        if (sec !== lastCountdownRef.current) {
          lastCountdownRef.current = sec;
          gameAudio.countdown();
        }
      }

      // Stop siren on screen change away from playing
      if (prevScreen === 'playing' && stateRef.current.screen !== 'playing') {
        gameAudio.siren(false);
      }

      const w = canvas.width, h = canvas.height;
      const time = stateRef.current.time || Math.floor(timestamp / 16);
      ctx.clearRect(0, 0, w, h);

      switch (stateRef.current.screen) {
        case 'menu': {
          const hasSave = !!loadProgress();
          renderMenu(ctx, w, h, time);
          if (hasSave) {
            const s = sfCalc(w, h);
            ctx.fillStyle = 'rgba(34,197,94,0.8)';
            ctx.font = `${Math.round(12 * s)}px Arial`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('💾 Прогресс сохранён', w / 2, 20);
          }
          break;
        }
        case 'briefing':
          if (stateRef.current.gameMode === 'runner' || stateRef.current.gameMode === 'extremal')
            renderRunnerBriefing(ctx, stateRef.current, w, h, time);
          else renderBriefing(ctx, stateRef.current, w, h, time);
          break;
        case 'playing': {
          render(ctx, stateRef.current);

          // Speed lines effect
          const entity = stateRef.current.gameMode === 'ambulance' ? stateRef.current.ambulance : stateRef.current.runner;
          if (entity) {
            const maxSpd = stateRef.current.gameMode === 'ambulance'
              ? stateRef.current.ambulance.maxSpeed * (stateRef.current.ambulance.nitroTimer > 0 ? 1.6 : 1)
              : 3.5 * 1.6 * 1.3;
            renderSpeedLines(ctx, w, h, entity.speed, maxSpd, entity.angle, time);
          }

          // Tutorial hint
          if (!stateRef.current.tutorialShown) {
            renderTutorial(ctx, stateRef.current.gameMode, w, h, time);
            if (time > 300) {
              stateRef.current = { ...stateRef.current, tutorialShown: true };
            }
          }

          drawJoystick(ctx, w, h);

          // Multiplayer HUD
          if (stateRef.current.mp?.isMultiplayer) {
            drawMultiplayerHUD(ctx, stateRef.current, w, h, time);
          }

          // Transition overlay
          renderTransition(ctx, stateRef.current.transitionAlpha, w, h);

          // Orientation hint for mobile portrait
          if (isMobileRef.current && !orientationDismissedRef.current && h > w * 1.3) {
            renderOrientationHint(ctx, w, h);
          }
          break;
        }
        case 'paused': render(ctx, stateRef.current); renderPaused(ctx, w, h, time); break;
        case 'saved': renderSaved(ctx, stateRef.current, w, h, time); break;
        case 'failed': renderFailed(ctx, stateRef.current, w, h, time); break;
        case 'upgrade': renderUpgrade(ctx, stateRef.current, w, h, time); break;
        case 'ending': renderEnding(ctx, stateRef.current, w, h, time); break;
        case 'multiplayerMenu': renderMultiplayerMenu(ctx, w, h, time); break;
        case 'lobby': renderLobby(ctx, stateRef.current, w, h, time); break;
      }

      // Disconnect overlay on any screen (not just playing)
      if (stateRef.current.mp?.disconnected && stateRef.current.screen !== 'playing') {
        const ds = sfCalc(w, h);
        ctx.fillStyle = 'rgba(0,0,0,0.85)'; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#ef4444'; ctx.font = `bold ${Math.round(28 * ds)}px Arial`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('⚠ Соединение потеряно', w / 2, h / 2 - Math.round(40 * ds));
        ctx.fillStyle = '#94a3b8'; ctx.font = `${Math.round(16 * ds)}px Arial`;
        ctx.fillText('Нажмите чтобы выйти в меню', w / 2, h / 2);
        const dbW = Math.min(Math.round(260 * ds), w - 40);
        const dbH = Math.round(52 * ds);
        const dbX = w / 2 - dbW / 2, dbY = h / 2 + Math.round(30 * ds);
        ctx.fillStyle = '#ef4444';
        ctx.beginPath(); ctx.roundRect(dbX, dbY, dbW, dbH, 10); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(18 * ds)}px Arial`;
        ctx.fillText('В ГЛАВНОЕ МЕНЮ', w / 2, dbY + dbH / 2);
      }

      animRef.current = requestAnimationFrame(gameLoop);
    };
    animRef.current = requestAnimationFrame(gameLoop);
    return () => { cancelAnimationFrame(animRef.current); window.removeEventListener('resize', resizeCanvas); };
  }, [drawJoystick]);

  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || isMobileRef.current) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    handleAction(x, y);
  }, [handleAction]);

  // Mobile HTML overlay for room code input (Canvas touch is unreliable on iOS)
  const state = stateRef.current;
  const showMobileCodeInput = isMobileRef.current && state.screen === 'lobby' && state.mp?.lobbyScreen === 'guestEnterCode';
  const showMobileHostCode = isMobileRef.current && state.screen === 'lobby' && state.mp?.lobbyScreen === 'hostWaiting' && !!state.mp?.roomCode;
  const mobileInputCode = state.mp?.inputCode || '';
  const mobileInputError = state.mp?.inputError || '';
  const mobileRoomCode = state.mp?.roomCode || '';

  const handleMobileKeyPress = useCallback((ch: string) => {
    const s = stateRef.current;
    if (!s.mp) return;
    if (ch === 'DEL') {
      if (s.mp.inputCode.length > 0) {
        stateRef.current = { ...s, mp: { ...s.mp, inputCode: s.mp.inputCode.slice(0, -1), inputError: '' } };
        setForceUpdate(v => v + 1);
      }
      return;
    }
    if (ch === 'BACK') {
      networkRef.current?.destroy();
      networkRef.current = null;
      stateRef.current = createInitialStateWithSave();
      setForceUpdate(v => v + 1);
      return;
    }
    if (s.mp.inputCode.length < 6) {
      const newCode = s.mp.inputCode + ch;
      stateRef.current = { ...s, mp: { ...s.mp, inputCode: newCode, inputError: '' } };
      setForceUpdate(v => v + 1);
      if (newCode.length === 6 && networkRef.current) {
        networkRef.current.joinRoom(newCode).catch((err) => {
          const s2 = stateRef.current;
          if (s2.mp) {
            const errMsg = networkRef.current?.lastError || err?.message || 'Комната не найдена';
            stateRef.current = { ...s2, mp: { ...s2.mp, inputCode: '', inputError: errMsg } };
            setForceUpdate(v => v + 1);
          }
        });
      }
    }
  }, []);

  const pasteInputRef = useRef<HTMLInputElement>(null);

  const processPastedText = useCallback((text: string) => {
    if (!text) return;
    const validChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const cleaned = text.toUpperCase().split('').filter(c => validChars.includes(c)).join('').slice(0, 6);
    if (cleaned.length === 0) return;
    const s2 = stateRef.current;
    if (!s2.mp) return;
    stateRef.current = { ...s2, mp: { ...s2.mp, inputCode: cleaned, inputError: '' } };
    setForceUpdate(v => v + 1);
    if (cleaned.length === 6 && networkRef.current) {
      networkRef.current.joinRoom(cleaned).catch((err) => {
        const s3 = stateRef.current;
        if (s3.mp) {
          const errMsg = networkRef.current?.lastError || err?.message || 'Комната не найдена';
          stateRef.current = { ...s3, mp: { ...s3.mp, inputCode: '', inputError: errMsg } };
          setForceUpdate(v => v + 1);
        }
      });
    }
  }, []);

  const handleMobilePaste = useCallback(async () => {
    const s = stateRef.current;
    if (!s.mp) return;
    // Strategy 1: Clipboard API (works on most Android, some iOS)
    try {
      if (navigator.clipboard?.readText) {
        const text = await navigator.clipboard.readText();
        if (text) { processPastedText(text); return; }
      }
    } catch { /* not allowed */ }
    // Strategy 2: Focus a real visible input so user can long-press → paste
    // On iOS, programmatic paste doesn't work — we need to show an input
    if (pasteInputRef.current) {
      const inp = pasteInputRef.current;
      inp.value = '';
      inp.focus();
      // On iOS the keyboard will appear and user can paste manually
      // We listen for input event to catch the paste
    }
  }, [processPastedText]);

  const handleMobileCopy = useCallback(() => {
    const code = stateRef.current.mp?.roomCode;
    if (!code) return;
    if (navigator.share) {
      navigator.share({ text: code }).catch(() => {});
    } else if (copyInputRef.current) {
      const inp = copyInputRef.current;
      inp.value = code;
      inp.style.display = 'block';
      inp.focus();
      inp.setSelectionRange(0, code.length);
      try { document.execCommand('copy'); } catch {}
      inp.style.display = 'none';
    }
  }, []);

  const handleMobileBack = useCallback(() => {
    networkRef.current?.destroy();
    networkRef.current = null;
    stateRef.current = createInitialStateWithSave();
    setForceUpdate(v => v + 1);
  }, []);

  const kbChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  return (
    <div className="w-screen h-screen overflow-hidden bg-black select-none">
      <canvas ref={canvasRef} className="block w-full h-full" onClick={handleCanvasClick} style={{ touchAction: 'none' }} />
      {/* Hidden input for iOS clipboard copy */}
      <input
        ref={copyInputRef}
        readOnly
        style={{ position: 'fixed', top: '-9999px', left: '-9999px', opacity: 0, display: 'none', fontSize: '16px' }}
        aria-hidden="true"
      />
      {/* Mobile HTML overlay: Guest code input */}
      {showMobileCodeInput && (
        <div style={{
          position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', background: 'rgba(15,23,42,0.97)',
          zIndex: 100, padding: '16px', gap: '12px',
        }}>
          <div style={{ color: '#60a5fa', fontSize: '22px', fontWeight: 'bold' }}>🔗 Введите код комнаты</div>
          {/* Code display boxes */}
          <div style={{ display: 'flex', gap: '8px' }}>
            {[0,1,2,3,4,5].map(i => (
              <div key={i} style={{
                width: '44px', height: '52px', borderRadius: '8px',
                background: i === mobileInputCode.length ? 'rgba(59,130,246,0.3)' : 'rgba(30,41,59,0.9)',
                border: i === mobileInputCode.length ? '2px solid #60a5fa' : '1px solid #475569',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#34d399', fontSize: '26px', fontWeight: 'bold', fontFamily: 'monospace',
              }}>
                {mobileInputCode[i] || ''}
              </div>
            ))}
          </div>
          {/* Error */}
          {mobileInputError && <div style={{ color: '#ef4444', fontSize: '14px', fontWeight: 'bold' }}>{mobileInputError}</div>}
          {/* Connecting status */}
          {mobileInputCode.length === 6 && !mobileInputError && (
            <div style={{ color: '#fbbf24', fontSize: '16px' }}>Подключение...</div>
          )}
          {/* On-screen keyboard */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: '6px',
            maxWidth: '360px', width: '100%',
          }}>
            {kbChars.split('').map(ch => (
              <button key={ch} onClick={() => handleMobileKeyPress(ch)} style={{
                padding: '12px 0', borderRadius: '6px', border: 'none',
                background: mobileInputCode.length >= 6 ? 'rgba(51,65,85,0.3)' : 'rgba(51,65,85,0.9)',
                color: mobileInputCode.length >= 6 ? 'rgba(255,255,255,0.3)' : '#e2e8f0',
                fontSize: '16px', fontWeight: 'bold', fontFamily: 'monospace',
                cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
                touchAction: 'manipulation',
              }}>{ch}</button>
            ))}
          </div>
          {/* Paste input field — visible, user can tap and paste */}
          <div style={{ display: 'flex', gap: '6px', width: '100%', maxWidth: '360px', alignItems: 'center' }}>
            <input
              ref={pasteInputRef}
              type="text"
              inputMode="text"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="Вставь код сюда"
              maxLength={6}
              style={{
                flex: 2, padding: '12px', borderRadius: '8px', border: '2px solid #3b82f6',
                background: 'rgba(30,41,59,0.95)', color: '#34d399', fontSize: '18px',
                fontWeight: 'bold', fontFamily: 'monospace', textAlign: 'center',
                outline: 'none', letterSpacing: '4px',
              }}
              onInput={(e) => {
                const val = (e.target as HTMLInputElement).value;
                processPastedText(val);
                (e.target as HTMLInputElement).value = '';
              }}
            />
            <button onClick={handleMobilePaste} style={{
              flex: 1, padding: '12px', borderRadius: '8px', border: 'none',
              background: 'rgba(59,130,246,0.7)', color: '#fff', fontSize: '14px',
              fontWeight: 'bold', cursor: 'pointer', touchAction: 'manipulation',
            }}>📋</button>
          </div>
          {/* Backspace + Back buttons */}
          <div style={{ display: 'flex', gap: '8px', width: '100%', maxWidth: '360px' }}>
            <button onClick={() => handleMobileKeyPress('DEL')} style={{
              flex: 1, padding: '12px', borderRadius: '8px', border: 'none',
              background: 'rgba(239,68,68,0.6)', color: '#fff', fontSize: '14px',
              fontWeight: 'bold', cursor: 'pointer', touchAction: 'manipulation',
            }}>⌫ Удалить</button>
            <button onClick={() => handleMobileKeyPress('BACK')} style={{
              flex: 1, padding: '12px', borderRadius: '8px', border: 'none',
              background: 'rgba(100,116,139,0.6)', color: '#fff', fontSize: '14px',
              fontWeight: 'bold', cursor: 'pointer', touchAction: 'manipulation',
            }}>◀ Назад</button>
          </div>
        </div>
      )}
      {/* Mobile HTML overlay: Host room code display */}
      {showMobileHostCode && (
        <div style={{
          position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', background: 'rgba(15,23,42,0.97)',
          zIndex: 100, padding: '16px', gap: '16px',
        }}>
          <div style={{ color: '#fbbf24', fontSize: '22px', fontWeight: 'bold' }}>🏠 Код комнаты</div>
          <div style={{ color: '#94a3b8', fontSize: '14px' }}>Скажите код другу:</div>
          {/* Large room code */}
          <div style={{
            display: 'flex', gap: '12px', padding: '16px 24px',
            background: 'rgba(30,41,59,0.9)', borderRadius: '12px',
            border: '2px solid #34d399',
          }}>
            {mobileRoomCode.split('').map((ch, i) => (
              <span key={i} style={{
                color: '#34d399', fontSize: '36px', fontWeight: 'bold', fontFamily: 'monospace',
              }}>{ch}</span>
            ))}
          </div>
          {/* Share / Copy button */}
          <button onClick={handleMobileCopy} style={{
            padding: '14px 32px', borderRadius: '10px', border: 'none',
            background: 'rgba(34,197,94,0.8)', color: '#fff', fontSize: '16px',
            fontWeight: 'bold', cursor: 'pointer', touchAction: 'manipulation',
            width: '100%', maxWidth: '300px',
          }}>{navigator.share ? '📤 Поделиться кодом' : '📋 Копировать код'}</button>
          {/* Waiting animation */}
          <div style={{ color: '#fbbf24', fontSize: '16px' }}>⏳ Ожидание игрока...</div>
          {/* Back button */}
          <button onClick={handleMobileBack} style={{
            padding: '12px 32px', borderRadius: '8px', border: 'none',
            background: 'rgba(100,116,139,0.6)', color: '#fff', fontSize: '14px',
            fontWeight: 'bold', cursor: 'pointer', touchAction: 'manipulation',
            width: '100%', maxWidth: '300px',
          }}>◀ Назад в меню</button>
        </div>
      )}
    </div>
  );
}
