// WebRTC P2P networking for multiplayer via PeerJS Cloud signaling
// Players exchange a short 6-char room code instead of long SDP blobs

import Peer, { DataConnection } from 'peerjs';

const PEER_PREFIX = 'ambchase-';
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const CONNECT_TIMEOUT = 15000; // 15 seconds

function log(...args: unknown[]) {
  console.log('[NET]', ...args);
}

function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
  }
  return code;
}

// Fetch fresh TURN credentials from Cloudflare (free, no signup)
async function fetchTurnServers(): Promise<RTCIceServer[]> {
  // Always include STUN
  const servers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];

  try {
    const res = await fetch('https://speed.cloudflare.com/turn-creds', { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      if (data.username && data.credential && data.urls) {
        servers.push({
          urls: data.urls,
          username: data.username,
          credential: data.credential,
        });
        log('Got Cloudflare TURN credentials');
      }
    }
  } catch (e) {
    log('Cloudflare TURN fetch failed, using STUN only:', e);
  }

  // OpenRelay free TURN (staticauth — no API key needed)
  servers.push(
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  );

  return servers;
}

export type NetMessageType =
  | 'keys'           // guest→host: input each frame
  | 'snapshot'       // host→guest: state snapshot
  | 'fullSync'       // host→guest: full game state at mission start
  | 'start'          // host→guest: game is starting
  | 'ping'           // both: latency measurement
  | 'pong'           // both: latency response
  | 'modeSelect'     // host→guest: selected multiplayer mode
  | 'rematch'        // both: request rematch
  | 'chat'           // both: lobby chat message
  | 'briefing'       // host→guest: show briefing for mission N
  | 'upgrade'        // host→guest: show upgrade screen with data
  | 'upgradeChoice'  // guest→host: guest selected an upgrade
  | 'ready';         // both: player is ready (briefing/upgrade)

export interface NetMessage {
  type: NetMessageType;
  seq: number;
  ts: number;
  data: unknown;
}

export type ConnectionState = 'idle' | 'offering' | 'answering' | 'connecting' | 'connected' | 'disconnected';

export class GameNetwork {
  private peer: Peer | null = null;
  private dataConn: DataConnection | null = null;
  private seq = 0;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private lastPingSent = 0;
  private lastPongReceived = 0;
  private iceServers: RTCIceServer[] = [];

  public state: ConnectionState = 'idle';
  public ping = 0;
  public lastError = '';
  public onMessage: ((msg: NetMessage) => void) | null = null;
  public onStateChange: ((state: ConnectionState) => void) | null = null;

  private setState(s: ConnectionState) {
    if (this.state === s) return;
    log('State:', this.state, '→', s);
    this.state = s;
    this.onStateChange?.(s);
  }

  // Pre-fetch TURN credentials
  private async ensureIceServers() {
    if (this.iceServers.length > 0) return;
    this.iceServers = await fetchTurnServers();
    log('ICE servers ready:', this.iceServers.length);
  }

  // === HOST: Create room ===
  async createRoom(): Promise<string> {
    await this.ensureIceServers();
    const roomCode = generateRoomCode();
    const peerId = PEER_PREFIX + roomCode;

    this.setState('offering');
    log('Creating room:', roomCode, 'peerId:', peerId);

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        log('Create room timeout');
        this.lastError = 'Таймаут создания комнаты';
        this.peer?.destroy();
        this.setState('disconnected');
        reject(new Error('Timeout'));
      }, CONNECT_TIMEOUT);

      this.peer = new Peer(peerId, {
        config: { iceServers: this.iceServers },
        debug: 2, // errors + warnings
      });

      this.peer.on('open', (id) => {
        clearTimeout(timeout);
        log('Peer open, id:', id);
        resolve(roomCode);
      });

      this.peer.on('error', (err: any) => {
        log('Peer error:', err.type, err.message || err);
        if (err.type === 'unavailable-id') {
          this.peer?.destroy();
          this.peer = null;
          clearTimeout(timeout);
          this.createRoom().then(resolve).catch(reject);
          return;
        }
        clearTimeout(timeout);
        this.lastError = `Ошибка: ${err.type || err.message || 'unknown'}`;
        this.setState('disconnected');
        reject(err);
      });

      this.peer.on('connection', (conn: DataConnection) => {
        log('Host: incoming connection from', conn.peer);
        this.handleConnection(conn, true);
      });

      this.peer.on('disconnected', () => {
        log('Peer disconnected from signaling server');
        // Try to reconnect to signaling server
        if (this.peer && !this.peer.destroyed) {
          log('Attempting reconnect...');
          this.peer.reconnect();
        }
      });
    });
  }

  // === GUEST: Join room ===
  async joinRoom(roomCode: string): Promise<void> {
    await this.ensureIceServers();
    const code = roomCode.toUpperCase().trim();
    const peerId = PEER_PREFIX + code;

    this.setState('answering');
    log('Joining room:', code, 'peerId:', peerId);

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        log('Join room timeout — peer-unavailable or connection stalled');
        this.lastError = 'Комната не найдена или таймаут';
        this.peer?.destroy();
        this.setState('disconnected');
        reject(new Error('Комната не найдена'));
      }, CONNECT_TIMEOUT);

      this.peer = new Peer({
        config: { iceServers: this.iceServers },
        debug: 2,
      });

      this.peer.on('open', (myId) => {
        log('Guest peer open, myId:', myId, '— connecting to:', peerId);
        const conn = this.peer!.connect(peerId, {
          reliable: true,
          serialization: 'json',
        });

        conn.on('open', () => {
          clearTimeout(timeout);
          log('Guest: DataConnection OPEN');
          resolve();
        });

        conn.on('error', (err: any) => {
          log('Guest: DataConnection error:', err);
          clearTimeout(timeout);
          this.lastError = 'Ошибка соединения';
          this.setState('disconnected');
          reject(new Error('Connection error'));
        });

        this.handleConnection(conn, false);
      });

      this.peer.on('error', (err: any) => {
        log('Guest peer error:', err.type, err.message || err);
        clearTimeout(timeout);
        if (err.type === 'peer-unavailable') {
          this.lastError = 'Комната не найдена';
          this.setState('disconnected');
          reject(new Error('Комната не найдена'));
          return;
        }
        this.lastError = `Ошибка: ${err.type || err.message || 'unknown'}`;
        this.setState('disconnected');
        reject(err);
      });
    });
  }

  // === Handle PeerJS connection (both host and guest) ===
  private handleConnection(conn: DataConnection, isHost: boolean) {
    this.dataConn = conn;
    this.setState('connecting');

    conn.on('open', () => {
      log(isHost ? 'Host' : 'Guest', ': reliable channel OPEN');
      this.setupReliableChannel(conn);
      this.setState('connected');
      this.startPing();
    });

    conn.on('close', () => {
      log('DataConnection closed');
      // Only disconnect if we were connected (ignore during setup)
      if (this.state === 'connected') {
        this.setState('disconnected');
        this.stopPing();
      }
    });

    conn.on('error', (err) => {
      log('DataConnection error:', err);
      // Don't immediately disconnect on non-fatal errors
      if (this.state === 'connected') {
        // Check if channel is actually dead
        if (!this.dataConn?.open) {
          this.setState('disconnected');
          this.stopPing();
        }
      } else {
        this.setState('disconnected');
        this.stopPing();
      }
    });
  }

  // === Reliable channel (PeerJS DataConnection) ===
  private setupReliableChannel(conn: DataConnection) {
    conn.on('data', (rawData: unknown) => {
      try {
        let msg: NetMessage;
        if (typeof rawData === 'object' && rawData !== null && 'type' in (rawData as any)) {
          // PeerJS json serialization already parsed it
          msg = rawData as NetMessage;
        } else if (typeof rawData === 'string') {
          msg = JSON.parse(rawData);
        } else if (rawData instanceof ArrayBuffer) {
          msg = JSON.parse(new TextDecoder().decode(rawData));
        } else if (rawData instanceof Uint8Array) {
          msg = JSON.parse(new TextDecoder().decode(rawData));
        } else {
          msg = JSON.parse(JSON.stringify(rawData));
        }

        if (msg.type === 'pong') {
          this.ping = Math.round((performance.now() - this.lastPingSent) / 2);
          this.lastPongReceived = performance.now();
          return;
        }
        if (msg.type === 'ping') {
          this.sendReliable({ type: 'pong', seq: msg.seq, ts: performance.now(), data: null });
          return;
        }
        this.onMessage?.(msg);
      } catch (e) {
        log('Parse error:', e, 'rawData type:', typeof rawData);
      }
    });
  }

  // === Send methods ===

  sendReliable(msg: NetMessage) {
    if (!this.dataConn?.open) return;
    // Buffer overflow protection: skip non-critical messages if buffer is full
    try {
      const dc = (this.dataConn as any)._dc || (this.dataConn as any).dataChannel;
      if (dc && dc.bufferedAmount > 64 * 1024) {
        // Buffer > 64KB — skip snapshots and keys, keep critical messages
        if (msg.type === 'snapshot' || msg.type === 'keys') return;
      }
    } catch { /* ignore */ }
    try {
      this.dataConn.send(msg);
    } catch { /* channel closed */ }
  }

  sendUnreliable(msg: NetMessage) {
    // For now, just use reliable channel (simpler, works everywhere)
    this.sendReliable(msg);
  }

  sendBinary(data: Uint8Array) {
    // Send as typed message on reliable channel
    if (!this.dataConn?.open) return;
    const type = data[0];
    if (type === 0x01) {
      // Keys
      this.sendReliable({ type: 'keys', seq: this.seq++, ts: performance.now(), data: Array.from(data.slice(1)) });
    } else if (type === 0x02) {
      // Snapshot — send as string for efficiency
      this.sendReliable({ type: 'snapshot', seq: this.seq++, ts: performance.now(), data: new TextDecoder().decode(data.slice(1)) });
    }
  }

  sendKeys(keysByte: number) {
    this.sendReliable({ type: 'keys', seq: this.seq++, ts: performance.now(), data: [keysByte] });
  }

  sendSnapshot(data: Uint8Array) {
    const str = new TextDecoder().decode(data);
    this.sendReliable({ type: 'snapshot', seq: this.seq++, ts: performance.now(), data: str });
  }

  // === Ping ===
  private startPing() {
    this.stopPing();
    this.lastPongReceived = performance.now();
    this.pingInterval = setInterval(() => {
      // Check for dead connection: no pong in 10 seconds
      if (this.lastPongReceived > 0 && performance.now() - this.lastPongReceived > 10000) {
        log('No pong for 10s — connection dead');
        this.setState('disconnected');
        this.stopPing();
        return;
      }
      this.lastPingSent = performance.now();
      this.sendReliable({ type: 'ping', seq: this.seq++, ts: this.lastPingSent, data: null });
    }, 2000);
  }

  private stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  // === Cleanup ===
  destroy() {
    this.stopPing();
    this.dataConn?.close();
    this.peer?.destroy();
    this.peer = null;
    this.dataConn = null;
    this.setState('idle');
  }

  get isConnected(): boolean {
    return this.state === 'connected';
  }
}
