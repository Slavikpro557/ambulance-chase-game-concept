// WebRTC P2P networking for multiplayer via PeerJS Cloud signaling
// Players exchange a short 6-char room code instead of long SDP blobs

import Peer, { DataConnection } from 'peerjs';

const PEER_PREFIX = 'ambchase-';
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
  }
  return code;
}

export type NetMessageType =
  | 'keys'        // guest→host: input each frame (1 byte)
  | 'snapshot'    // host→guest: state snapshot (~300 bytes, 20Hz)
  | 'fullSync'    // host→guest: full game state at mission start
  | 'start'       // host→guest: game is starting
  | 'ping'        // both: latency measurement
  | 'pong'        // both: latency response
  | 'modeSelect'  // host→guest: selected multiplayer mode
  | 'rematch'     // both: request rematch
  | 'chat';       // both: lobby chat message

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
  private unreliableChannel: RTCDataChannel | null = null;
  private seq = 0;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private lastPingSent = 0;
  private reliableOpen = false;

  public state: ConnectionState = 'idle';
  public ping = 0;
  public onMessage: ((msg: NetMessage) => void) | null = null;
  public onStateChange: ((state: ConnectionState) => void) | null = null;

  private setState(s: ConnectionState) {
    if (this.state === s) return;
    this.state = s;
    this.onStateChange?.(s);
  }

  // === HOST: Create room ===
  async createRoom(): Promise<string> {
    const roomCode = generateRoomCode();
    const peerId = PEER_PREFIX + roomCode;

    this.setState('offering');

    return new Promise<string>((resolve, reject) => {
      this.peer = new Peer(peerId, {
        config: {
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        }
      });

      this.peer.on('open', () => {
        resolve(roomCode);
      });

      this.peer.on('error', (err: any) => {
        if (err.type === 'unavailable-id') {
          // Room code collision — retry with new code
          this.peer?.destroy();
          this.peer = null;
          this.createRoom().then(resolve).catch(reject);
          return;
        }
        this.setState('disconnected');
        reject(err);
      });

      // When guest connects
      this.peer.on('connection', (conn: DataConnection) => {
        this.handleConnection(conn, true);
      });
    });
  }

  // === GUEST: Join room ===
  async joinRoom(roomCode: string): Promise<void> {
    const peerId = PEER_PREFIX + roomCode.toUpperCase().trim();

    this.setState('answering');

    return new Promise<void>((resolve, reject) => {
      this.peer = new Peer({
        config: {
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        }
      });

      this.peer.on('open', () => {
        const conn = this.peer!.connect(peerId, {
          reliable: true,
          serialization: 'none', // we handle serialization ourselves
        });
        this.handleConnection(conn, false);
        resolve();
      });

      this.peer.on('error', (err: any) => {
        if (err.type === 'peer-unavailable') {
          this.setState('disconnected');
          reject(new Error('Комната не найдена. Проверьте код.'));
          return;
        }
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
      this.reliableOpen = true;
      this.setupReliableChannel(conn);

      // Access the underlying RTCPeerConnection for unreliable channel
      const pc = (conn as any).peerConnection as RTCPeerConnection | undefined;
      if (!pc) {
        // Fallback: if peerConnection not accessible, use reliable for everything
        this.setState('connected');
        this.startPing();
        return;
      }

      if (isHost) {
        // Host creates unreliable channel (in-band SCTP negotiation)
        const unreliable = pc.createDataChannel('unreliable', {
          ordered: false,
          maxRetransmits: 0,
        });
        this.setupUnreliableChannel(unreliable);
      } else {
        // Guest listens for unreliable channel from host
        pc.ondatachannel = (e) => {
          if (e.channel.label === 'unreliable') {
            this.setupUnreliableChannel(e.channel);
          }
        };
        // Fallback: if unreliable channel doesn't arrive within 3s, connect without it
        setTimeout(() => {
          if (!this.unreliableChannel && this.reliableOpen) {
            this.setState('connected');
            this.startPing();
          }
        }, 3000);
      }
    });

    conn.on('close', () => {
      this.setState('disconnected');
      this.stopPing();
    });

    conn.on('error', () => {
      this.setState('disconnected');
      this.stopPing();
    });
  }

  // === Reliable channel (PeerJS DataConnection) ===
  private setupReliableChannel(conn: DataConnection) {
    conn.on('data', (rawData: unknown) => {
      try {
        const str = typeof rawData === 'string' ? rawData : String(rawData);
        const msg: NetMessage = JSON.parse(str);
        if (msg.type === 'pong') {
          this.ping = Math.round((performance.now() - this.lastPingSent) / 2);
          return;
        }
        if (msg.type === 'ping') {
          this.sendReliable({ type: 'pong', seq: msg.seq, ts: performance.now(), data: null });
          return;
        }
        this.onMessage?.(msg);
      } catch { /* ignore parse errors */ }
    });
  }

  // === Unreliable channel (raw RTCDataChannel) ===
  private setupUnreliableChannel(channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      this.unreliableChannel = channel;
      this.checkBothChannelsOpen();
    };

    // If channel is already open
    if (channel.readyState === 'open') {
      this.unreliableChannel = channel;
      this.checkBothChannelsOpen();
    }

    channel.onmessage = (e) => {
      try {
        if (e.data instanceof ArrayBuffer) {
          this.handleBinary(new Uint8Array(e.data));
        } else if (e.data instanceof Blob) {
          e.data.arrayBuffer().then(buf => this.handleBinary(new Uint8Array(buf)));
        }
      } catch { /* ignore */ }
    };

    channel.onclose = () => {
      this.unreliableChannel = null;
    };
  }

  private checkBothChannelsOpen() {
    if (this.reliableOpen && this.unreliableChannel?.readyState === 'open') {
      this.setState('connected');
      this.startPing();
    }
  }

  // === Binary message handling ===
  private handleBinary(data: Uint8Array) {
    const type = data[0];
    if (type === 0x01) {
      this.onMessage?.({ type: 'keys', seq: this.seq++, ts: performance.now(), data: data.slice(1) });
    } else if (type === 0x02) {
      this.onMessage?.({ type: 'snapshot', seq: this.seq++, ts: performance.now(), data: data.slice(1) });
    }
  }

  // === Send methods ===

  sendReliable(msg: NetMessage) {
    if (!this.dataConn?.open) return;
    try {
      this.dataConn.send(JSON.stringify(msg));
    } catch { /* channel closed */ }
  }

  sendUnreliable(msg: NetMessage) {
    // Fallback to reliable if unreliable not available
    if (this.unreliableChannel?.readyState === 'open') {
      try { this.unreliableChannel.send(JSON.stringify(msg)); } catch { /* */ }
    } else {
      this.sendReliable(msg);
    }
  }

  sendBinary(data: Uint8Array) {
    if (this.unreliableChannel?.readyState === 'open') {
      try { this.unreliableChannel.send(data.buffer); } catch { /* */ }
    } else if (this.dataConn?.open) {
      // Fallback: send as base64 on reliable channel
      try {
        const b64 = btoa(String.fromCharCode(...data));
        this.dataConn.send(JSON.stringify({ type: 'binary', seq: this.seq++, ts: performance.now(), data: b64 }));
      } catch { /* */ }
    }
  }

  sendKeys(keysByte: number) {
    const buf = new Uint8Array(2);
    buf[0] = 0x01;
    buf[1] = keysByte;
    this.sendBinary(buf);
  }

  sendSnapshot(data: Uint8Array) {
    const buf = new Uint8Array(1 + data.length);
    buf[0] = 0x02;
    buf.set(data, 1);
    this.sendBinary(buf);
  }

  // === Ping ===
  private startPing() {
    this.stopPing();
    this.pingInterval = setInterval(() => {
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
    this.unreliableChannel?.close();
    this.dataConn?.close();
    this.peer?.destroy();
    this.peer = null;
    this.dataConn = null;
    this.unreliableChannel = null;
    this.reliableOpen = false;
    this.setState('idle');
  }

  get isConnected(): boolean {
    return this.state === 'connected';
  }
}
