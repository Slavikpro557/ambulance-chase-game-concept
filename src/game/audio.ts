class GameAudio {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private sirenOsc1: OscillatorNode | null = null;
  private sirenOsc2: OscillatorNode | null = null;
  private sirenGain: GainNode | null = null;
  private _muted = false;

  get muted() { return this._muted; }

  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.3;
      this.masterGain.connect(this.ctx.destination);
    } catch { /* noop */ }
  }

  toggleMute() {
    this._muted = !this._muted;
    if (this.masterGain) this.masterGain.gain.value = this._muted ? 0 : 0.3;
  }

  private tone(freq: number, duration: number, type: OscillatorType = 'sine', vol = 0.5) {
    if (!this.ctx || !this.masterGain || this._muted) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.value = vol;
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start();
    osc.stop(this.ctx.currentTime + duration);
  }

  private noise(duration: number, vol = 0.3) {
    if (!this.ctx || !this.masterGain || this._muted) return;
    const bufSize = this.ctx.sampleRate * duration;
    const buf = this.ctx.createBuffer(1, bufSize, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const gain = this.ctx.createGain();
    gain.gain.value = vol;
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 800;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    src.start();
    src.stop(this.ctx.currentTime + duration);
  }

  private sweep(from: number, to: number, duration: number, type: OscillatorType = 'sine', vol = 0.5) {
    if (!this.ctx || !this.masterGain || this._muted) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = from;
    osc.frequency.linearRampToValueAtTime(to, this.ctx.currentTime + duration);
    gain.gain.value = vol;
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start();
    osc.stop(this.ctx.currentTime + duration);
  }

  catch() { this.sweep(300, 600, 0.2, 'sine', 0.4); }

  powerup() {
    this.tone(523, 0.08, 'square', 0.3);
    setTimeout(() => this.tone(659, 0.08, 'square', 0.3), 80);
    setTimeout(() => this.tone(784, 0.12, 'square', 0.3), 160);
  }

  collision() { this.noise(0.12, 0.4); }

  fail() { this.sweep(500, 200, 0.4, 'sawtooth', 0.3); }

  win() {
    this.tone(523, 0.12, 'sine', 0.3);
    setTimeout(() => this.tone(659, 0.12, 'sine', 0.3), 120);
    setTimeout(() => this.tone(784, 0.15, 'sine', 0.3), 240);
    setTimeout(() => this.tone(1047, 0.25, 'sine', 0.4), 360);
  }

  honk() { this.tone(400, 0.15, 'square', 0.25); }

  hazardDamage() {
    if (!this.ctx || !this.masterGain || this._muted) return;
    const bufSize = this.ctx.sampleRate * 0.1;
    const buf = this.ctx.createBuffer(1, bufSize, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.3;
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.1);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 2000;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    src.start();
    src.stop(this.ctx.currentTime + 0.1);
  }

  countdown() { this.tone(800, 0.08, 'sine', 0.3); }

  siren(on: boolean) {
    if (!this.ctx || !this.masterGain) return;
    if (on && !this.sirenOsc1) {
      this.sirenGain = this.ctx.createGain();
      this.sirenGain.gain.value = this._muted ? 0 : 0.06;
      this.sirenGain.connect(this.masterGain);

      this.sirenOsc1 = this.ctx.createOscillator();
      this.sirenOsc1.type = 'sine';
      this.sirenOsc1.frequency.value = 600;
      this.sirenOsc1.connect(this.sirenGain);
      this.sirenOsc1.start();

      const lfo = this.ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 2;
      const lfoGain = this.ctx.createGain();
      lfoGain.gain.value = 200;
      lfo.connect(lfoGain);
      lfoGain.connect(this.sirenOsc1.frequency);
      lfo.start();
      this.sirenOsc2 = lfo;
    } else if (!on && this.sirenOsc1) {
      try { this.sirenOsc1.stop(); } catch { /* noop */ }
      try { this.sirenOsc2?.stop(); } catch { /* noop */ }
      this.sirenOsc1 = null;
      this.sirenOsc2 = null;
      this.sirenGain = null;
    }
  }

  playEvent(event: string) {
    switch (event) {
      case 'catch': this.catch(); break;
      case 'powerup': this.powerup(); break;
      case 'collision': this.collision(); break;
      case 'fail': this.fail(); break;
      case 'win': this.win(); break;
      case 'honk': this.honk(); break;
      case 'hazardDamage': this.hazardDamage(); break;
      case 'countdown': this.countdown(); break;
    }
  }
}

export const gameAudio = new GameAudio();
