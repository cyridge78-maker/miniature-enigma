'use strict';
/* Miniature Studio: multitrack recorder built on Web Audio + MediaRecorder. No dependencies. */

// ---------- Settings ----------
const DEFAULTS = {
  inputId: '', channels: 1, echo: false, noise: false, agc: false, monitor: false, latency: 0,
  beats: 4, countIn: 1, metroVol: 0.5, metroRec: true, metroPlay: false,
  theme: 'dark', zoom: 80, autoscroll: true, bits: 16, normalize: false,
};
let settings = loadSettings();
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('studio.settings') || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings() {
  try { localStorage.setItem('studio.settings', JSON.stringify(settings)); } catch { /* storage unavailable */ }
}

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
const setStatus = (msg) => { $('status').textContent = msg; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function fmtTime(t) {
  t = Math.max(0, t);
  const m = Math.floor(t / 60), s = t - m * 60;
  return String(m).padStart(2, '0') + ':' + s.toFixed(3).padStart(6, '0');
}
function editingText() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' && el.type !== 'range' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA');
}

// ---------- WAV encoding ----------
function encodeWav(channels, sampleRate, bits) {
  const n = channels[0].length, nch = channels.length, bytes = bits / 8;
  const buf = new ArrayBuffer(44 + n * nch * bytes), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * nch * bytes, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, bits === 32 ? 3 : 1, true); v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nch * bytes, true);
  v.setUint16(32, nch * bytes, true); v.setUint16(34, bits, true);
  str(36, 'data'); v.setUint32(40, n * nch * bytes, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      const x = clamp(channels[c][i], -1, 1);
      if (bits === 32) { v.setFloat32(o, channels[c][i], true); }
      else if (bits === 16) { v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
      else {
        const s = Math.round(x < 0 ? x * 0x800000 : x * 0x7fffff);
        v.setUint8(o, s & 255); v.setUint8(o + 1, (s >> 8) & 255); v.setUint8(o + 2, (s >> 16) & 255);
      }
      o += bytes;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}
const bufferToWav = (b, bits) =>
  encodeWav(Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i)), b.sampleRate, bits);

// ---------- Project persistence (IndexedDB) ----------
const db = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('miniature-studio', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('project');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async get() {
    const d = await this.open();
    return new Promise((res, rej) => {
      const q = d.transaction('project').objectStore('project').get('main');
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
  },
  async put(value) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction('project', 'readwrite');
      t.objectStore('project').put(value, 'main');
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  },
};
let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await db.put({
        bpm: +$('bpm').value,
        master: +$('master-vol').value,
        tracks: tracks.map((t) => ({
          name: t.name, vol: t.vol, pan: t.pan, mute: t.mute, solo: t.solo,
          clips: t.clips.map((c) => ({ start: c.start, off: c.off, dur: c.dur, blob: c.blob })),
        })),
      });
    } catch (e) { setStatus('Could not save project: ' + e.message); }
  }, 500);
}

// ---------- Audio engine ----------
const ctx = new (window.AudioContext || window.webkitAudioContext)();
const master = ctx.createGain();
const analyser = ctx.createAnalyser();
analyser.fftSize = 1024;
master.connect(analyser);
analyser.connect(ctx.destination);

/** @type {{id:number,name:string,vol:number,pan:number,mute:boolean,solo:boolean,armed:boolean,clips:{start:number,buffer:AudioBuffer,blob:Blob}[],gain:GainNode,panner:StereoPannerNode,el?:HTMLElement}[]} */
let tracks = [];
let nextTrackId = 1;

function createTrack(data = {}) {
  const t = {
    id: nextTrackId++, name: data.name || `Track ${nextTrackId - 1}`,
    vol: data.vol ?? 0.8, pan: data.pan ?? 0, mute: !!data.mute, solo: !!data.solo, armed: false, clips: [],
    gain: ctx.createGain(), panner: ctx.createStereoPanner(),
  };
  t.gain.connect(t.panner); t.panner.connect(master);
  tracks.push(t);
  applyMix();
  return t;
}
function effectiveVol(t, anySolo) {
  return (anySolo ? t.solo : !t.mute) ? t.vol : 0;
}
function applyMix() {
  const anySolo = tracks.some((t) => t.solo);
  for (const t of tracks) {
    t.gain.gain.setTargetAtTime(effectiveVol(t, anySolo), ctx.currentTime, 0.01);
    t.panner.pan.setTargetAtTime(t.pan, ctx.currentTime, 0.01);
  }
  master.gain.setTargetAtTime(+$('master-vol').value, ctx.currentTime, 0.01);
}
const projectEnd = () => Math.max(0, ...tracks.flatMap((t) => t.clips.map((c) => c.start + c.dur)));

// ---------- Transport ----------
const transport = { state: 'stopped', pos: 0, pos0: 0, t0: 0, sources: [], metroTimer: 0, nextBeat: 0 };
const position = () => (transport.state === 'stopped' ? transport.pos : transport.pos0 + (ctx.currentTime - transport.t0));

function startSources(pos0, t0) {
  for (const t of tracks) {
    for (const c of t.clips) {
      const when = t0 + (c.start - pos0);
      const offset = Math.max(0, ctx.currentTime - when);
      if (offset >= c.dur) continue;
      const src = ctx.createBufferSource();
      src.buffer = c.buffer; src.connect(t.gain);
      src.start(Math.max(when, ctx.currentTime), c.off + offset, c.dur - offset);
      transport.sources.push(src);
    }
  }
}
function stopSources() {
  for (const s of transport.sources) { try { s.stop(); } catch { /* already stopped */ } s.disconnect(); }
  transport.sources = [];
}

function click(time, accent) {
  const osc = ctx.createOscillator(), g = ctx.createGain();
  osc.frequency.value = accent ? 1600 : 1000;
  g.gain.setValueAtTime(settings.metroVol, time);
  g.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
  osc.connect(g); g.connect(ctx.destination);
  osc.start(time); osc.stop(time + 0.06);
}
/** Click grid is anchored at pos0; negative beat indices are the count-in. */
function startMetronome(withCountIn, pos0, t0, spb, enabled) {
  stopMetronome();
  if (!enabled && !withCountIn) return;
  const countBeats = withCountIn ? settings.countIn * settings.beats : 0;
  transport.nextBeat = -countBeats;
  const tick = () => {
    while (true) {
      const j = transport.nextBeat, time = t0 + j * spb;
      if (time > ctx.currentTime + 0.12) break;
      if (j < 0 || enabled) {
        const bar = ((j % settings.beats) + settings.beats) % settings.beats;
        if (time >= ctx.currentTime) click(time, bar === 0);
      }
      transport.nextBeat++;
    }
  };
  tick();
  transport.metroTimer = setInterval(tick, 25);
}
function stopMetronome() { clearInterval(transport.metroTimer); transport.metroTimer = 0; }

async function begin(mode, countInSec = 0) {
  await ctx.resume();
  const spb = 60 / clamp(+$('bpm').value || 120, 30, 300);
  transport.pos0 = transport.pos;
  transport.t0 = ctx.currentTime + 0.05 + countInSec;
  transport.state = mode;
  startSources(transport.pos0, transport.t0);
  startMetronome(countInSec > 0, transport.pos0, transport.t0, spb,
    mode === 'recording' ? settings.metroRec : settings.metroPlay);
  updateButtons();
}
async function play() {
  if (transport.state === 'recording') return;
  if (transport.state === 'playing') return pause();
  await begin('playing');
}
function pause() {
  transport.pos = position();
  stopSources(); stopMetronome();
  transport.state = 'stopped';
  updateButtons();
}
function stop() {
  if (transport.state === 'recording') return stopRecording();
  pause();
  transport.pos = 0;
  scheduleScroll(true);
}

// ---------- Clips ----------
const MIN_CLIP = 0.02;
/** A clip is a non-destructive window (off, dur) onto its buffer, placed at `start` on the timeline. */
const makeClip = (start, buffer, blob) => ({ start, buffer, blob, off: 0, dur: buffer.duration });
let selected = null; // {track, clip}
const findTrack = (clip) => tracks.find((t) => t.clips.includes(clip));

// Undo/redo: snapshots of every track's clip list (clips are small objects sharing immutable buffers).
const history = { undo: [], redo: [] };
const HISTORY_LIMIT = 100;
const snapshot = () => tracks.map((t) => ({ track: t, clips: t.clips.map((c) => ({ ...c })) }));
function checkpoint(snap = snapshot()) {
  history.undo.push(snap);
  if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
  history.redo = [];
  updateHistoryButtons();
}
function resetHistory() { history.undo = []; history.redo = []; selected = null; updateHistoryButtons(); }
function restore(snap) {
  for (const e of snap) if (tracks.includes(e.track)) e.track.clips = e.clips.map((c) => ({ ...c }));
  selected = null; renderWaves(); refreshPlayback(); scheduleSave(); updateHistoryButtons();
}
function undo() {
  if (!history.undo.length || transport.state === 'recording') return;
  history.redo.push(snapshot()); restore(history.undo.pop());
  setStatus('Undo.');
}
function redo() {
  if (!history.redo.length || transport.state === 'recording') return;
  history.undo.push(snapshot()); restore(history.redo.pop());
  setStatus('Redo.');
}
function updateHistoryButtons() {
  $('btn-undo').disabled = !history.undo.length;
  $('btn-redo').disabled = !history.redo.length;
}

function refreshPlayback() {
  if (transport.state !== 'playing') return;
  stopSources(); stopMetronome(); transport.pos = position(); begin('playing');
}
function deleteSelected() {
  if (!selected || transport.state === 'recording') return;
  const t = findTrack(selected.clip);
  if (t) checkpoint();
  if (t) t.clips = t.clips.filter((c) => c !== selected.clip);
  selected = null; renderWaves(); refreshPlayback(); scheduleSave();
}
function splitSelected() {
  if (!selected || transport.state === 'recording') { setStatus('Select a clip first.'); return; }
  const { clip } = selected, t = findTrack(clip), at = position() - clip.start;
  if (!t || at < MIN_CLIP || at > clip.dur - MIN_CLIP) { setStatus('Move the playhead inside the selected clip to split.'); return; }
  checkpoint();
  const right = { ...clip, start: clip.start + at, off: clip.off + at, dur: clip.dur - at };
  clip.dur = at;
  t.clips.push(right); selected = { track: t, clip: right };
  renderWaves(); refreshPlayback(); scheduleSave();
}
async function importFiles(files) {
  const track = tracks.find((t) => t.armed) || tracks[0] || createTrack();
  let at = position();
  let before = snapshot(); // checkpointed once, on the first successful decode
  for (const f of files) {
    try {
      const buffer = await ctx.decodeAudioData(await f.arrayBuffer());
      const clip = makeClip(at, buffer, bufferToWav(buffer, 16));
      if (before) { checkpoint(before); before = null; }
      track.clips.push(clip); selected = { track, clip };
      setStatus(`Imported “${f.name}” (${buffer.duration.toFixed(2)} s) onto “${track.name}”.`);
      at += buffer.duration;
    } catch {
      setStatus(`Could not decode “${f.name}”: unsupported audio file.`);
    }
  }
  renderTracks(); refreshPlayback(); scheduleSave();
}

/** Drag a clip body to move it, or its edges to trim. */
function startDrag(e, track, clip, mode) {
  e.preventDefault(); e.stopPropagation();
  if (transport.state === 'recording') return;
  selected = { track, clip };
  // Restyle in place: re-rendering here would replace the element and swallow the click.
  document.querySelectorAll('.clip.selected').forEach((n) => n.classList.remove('selected'));
  e.currentTarget.closest('.clip').classList.add('selected');
  const before = snapshot();
  const x0 = e.clientX, orig = { start: clip.start, off: clip.off, dur: clip.dur }, z = settings.zoom;
  let moved = false;
  const move = (ev) => {
    const d = (ev.clientX - x0) / z;
    if (Math.abs(ev.clientX - x0) > 2) moved = true;
    if (!moved) return;
    if (mode === 'move') clip.start = Math.max(0, orig.start + d);
    else if (mode === 'left') {
      const dd = clamp(d, -Math.min(orig.off, orig.start), orig.dur - MIN_CLIP);
      clip.start = orig.start + dd; clip.off = orig.off + dd; clip.dur = orig.dur - dd;
    } else {
      clip.dur = clamp(orig.dur + d, MIN_CLIP, clip.buffer.duration - orig.off);
    }
    renderWaves();
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    if (moved) { checkpoint(before); refreshPlayback(); scheduleSave(); renderWaves(); }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// ---------- Recording ----------
const rec = { stream: null, recorder: null, chunks: [], track: null, pos0: 0, countIn: 0, monitorNodes: [] };

async function getStream() {
  const audio = {
    channelCount: settings.channels, echoCancellation: settings.echo,
    noiseSuppression: settings.noise, autoGainControl: settings.agc,
  };
  if (settings.inputId) audio.deviceId = { exact: settings.inputId };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio });
  } catch (e) {
    if (e.name === 'OverconstrainedError' && settings.inputId) {
      setStatus('Selected input unavailable; using default.');
      settings.inputId = ''; saveSettings();
      delete audio.deviceId;
      return navigator.mediaDevices.getUserMedia({ audio });
    }
    throw e;
  }
}

async function startRecording() {
  if (transport.state === 'recording') return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    setStatus('Recording is not supported in this browser.'); return;
  }
  if (transport.state === 'playing') pause();
  let track = tracks.find((t) => t.armed);
  if (!track) { track = tracks[0] || createTrack(); track.armed = true; renderTracks(); }
  try {
    rec.stream = await getStream();
  } catch (e) {
    setStatus(e.name === 'NotAllowedError' ? 'Microphone permission denied.' : 'Could not open input: ' + e.message);
    return;
  }
  populateDevices();
  rec.track = track; rec.chunks = [];
  rec.countIn = settings.countIn * settings.beats * (60 / clamp(+$('bpm').value || 120, 30, 300));
  rec.recorder = new MediaRecorder(rec.stream);
  rec.recorder.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
  rec.recorder.onstop = finishRecording;
  if (settings.monitor) {
    const src = ctx.createMediaStreamSource(rec.stream);
    src.connect(ctx.destination);
    rec.monitorNodes = [src];
  }
  rec.pos0 = transport.pos;
  rec.recorder.start();
  await begin('recording', rec.countIn);
  setStatus(`Recording to “${track.name}”…`);
}

function stopRecording() {
  if (transport.state !== 'recording') return;
  const pos = position();
  stopSources(); stopMetronome();
  transport.pos = Math.max(rec.pos0, pos);
  transport.state = 'stopped';
  updateButtons();
  rec.recorder.stop();
  rec.stream.getTracks().forEach((t) => t.stop());
  rec.monitorNodes.forEach((n) => n.disconnect());
  rec.monitorNodes = [];
}

async function finishRecording() {
  try {
    const blob = new Blob(rec.chunks, { type: rec.recorder.mimeType });
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    // Recorder started at the beginning of the count-in; drop that plus input latency.
    const trim = Math.round((rec.countIn + settings.latency / 1000) * decoded.sampleRate);
    const len = decoded.length - trim;
    if (len < decoded.sampleRate * 0.02) { setStatus('Nothing recorded.'); return; }
    const out = ctx.createBuffer(decoded.numberOfChannels, len, decoded.sampleRate);
    for (let c = 0; c < out.numberOfChannels; c++) out.copyToChannel(decoded.getChannelData(c).subarray(trim), c);
    checkpoint();
    rec.track.clips.push(makeClip(rec.pos0, out, bufferToWav(out, 32)));
    setStatus(`Recorded ${out.duration.toFixed(2)} s on “${rec.track.name}”.`);
    renderWaves(); scheduleSave();
  } catch (e) {
    setStatus('Could not process recording: ' + e.message);
  }
}

// ---------- Export ----------
async function exportWav() {
  const end = projectEnd();
  if (!end) { setStatus('Nothing to export.'); return; }
  const sr = ctx.sampleRate;
  const off = new OfflineAudioContext(2, Math.ceil((end + 0.1) * sr), sr);
  const m = off.createGain(); m.gain.value = +$('master-vol').value; m.connect(off.destination);
  const anySolo = tracks.some((t) => t.solo);
  for (const t of tracks) {
    const g = off.createGain(); g.gain.value = effectiveVol(t, anySolo);
    const p = off.createStereoPanner(); p.pan.value = t.pan;
    g.connect(p); p.connect(m);
    for (const c of t.clips) {
      const s = off.createBufferSource(); s.buffer = c.buffer; s.connect(g); s.start(c.start, c.off, c.dur);
    }
  }
  setStatus('Rendering…');
  const rendered = await off.startRendering();
  const chans = [rendered.getChannelData(0), rendered.getChannelData(1)];
  if (settings.normalize) {
    let peak = 0;
    for (const ch of chans) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
    if (peak > 0) for (const ch of chans) for (let i = 0; i < ch.length; i++) ch[i] /= peak * 1.0233; // ≈ -0.2 dBFS
  }
  const url = URL.createObjectURL(encodeWav(chans, sr, settings.bits));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'mix.wav' });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  setStatus('Exported mix.wav');
}

// ---------- UI: tracks ----------
function button(label, title, onclick, cls = '') {
  const b = document.createElement('button');
  b.textContent = label; b.title = title; b.className = cls; b.onclick = onclick;
  return b;
}
function slider(label, min, max, step, value, oninput) {
  const l = document.createElement('label'), i = document.createElement('input');
  i.type = 'range'; i.min = min; i.max = max; i.step = step; i.value = value;
  i.oninput = () => oninput(+i.value);
  l.append(label, i);
  return l;
}

function renderTracks() {
  const host = $('tracks');
  host.textContent = '';
  for (const t of tracks) {
    const el = document.createElement('div');
    el.className = 'track' + (t.armed ? ' armed' : '');
    const head = document.createElement('div'); head.className = 'track-head';
    const name = Object.assign(document.createElement('input'), { type: 'text', value: t.name });
    name.oninput = () => { t.name = name.value; scheduleSave(); };
    const row = document.createElement('div'); row.className = 'row';
    const arm = button('R', 'Arm for recording', () => {
      const was = t.armed; tracks.forEach((x) => (x.armed = false)); t.armed = !was; renderTracks();
    }, t.armed ? 'rec active' : '');
    const mute = button('M', 'Mute', () => { t.mute = !t.mute; applyMix(); renderTracks(); scheduleSave(); }, t.mute ? 'active' : '');
    const solo = button('S', 'Solo', () => { t.solo = !t.solo; applyMix(); renderTracks(); scheduleSave(); }, t.solo ? 'active' : '');
    const clear = button('Clear', 'Remove all recordings on this track', () => {
      if (!t.clips.length) return;
      checkpoint(); t.clips = []; selected = null; renderWaves(); scheduleSave();
    });
    const del = button('🗑', 'Delete track', () => {
      t.gain.disconnect(); t.panner.disconnect();
      tracks = tracks.filter((x) => x !== t); resetHistory(); renderTracks(); scheduleSave();
    }, 'danger');
    row.append(arm, mute, solo, clear, del);
    head.append(name, row,
      slider('Vol', 0, 1.5, 0.01, t.vol, (v) => { t.vol = v; applyMix(); scheduleSave(); }),
      slider('Pan', -1, 1, 0.01, t.pan, (v) => { t.pan = v; applyMix(); scheduleSave(); }));

    const wave = document.createElement('div'); wave.className = 'track-wave';
    const canvas = document.createElement('canvas');
    const ph = document.createElement('div'); ph.className = 'playhead';
    const overlay = document.createElement('div'); overlay.className = 'clips';
    wave.append(canvas, overlay, ph);
    wave.onclick = (e) => {
      if (selected) { selected = null; renderWaves(); }
      if (transport.state === 'recording') return;
      const x = e.clientX - canvas.getBoundingClientRect().left;
      const p = Math.max(0, x / settings.zoom);
      if (transport.state === 'playing') { stopSources(); stopMetronome(); transport.pos = p; begin('playing'); }
      else transport.pos = p;
    };
    wave.onscroll = () => syncScroll(wave);
    el.append(head, wave);
    host.appendChild(el);
    t.el = el; t.overlay = overlay; t.canvas = canvas; t.playhead = ph; t.wave = wave;
  }
  renderWaves();
}

let syncing = false;
function syncScroll(src) {
  if (syncing) return;
  syncing = true;
  for (const t of tracks) if (t.wave !== src) t.wave.scrollLeft = src.scrollLeft;
  syncing = false;
}
function scheduleScroll(reset) { if (reset) for (const t of tracks) t.wave.scrollLeft = 0; }

function renderWaves() {
  const z = settings.zoom;
  const width = Math.min(30000, Math.ceil(Math.max(30, projectEnd() + 10, position() + 10) * z));
  const cs = getComputedStyle(document.documentElement);
  const color = cs.getPropertyValue('--wave').trim(), grid = cs.getPropertyValue('--border').trim();
  for (const t of tracks) {
    const c = t.canvas; c.width = width; c.height = 96;
    const g = c.getContext('2d');
    g.strokeStyle = grid; g.lineWidth = 1; g.beginPath();
    for (let s = 0; s * z < width; s++) { g.moveTo(s * z + .5, 0); g.lineTo(s * z + .5, s % 5 ? 6 : 14); }
    g.moveTo(0, 48.5); g.lineTo(width, 48.5); g.stroke();
    g.fillStyle = color;
    t.overlay.textContent = '';
    for (const clip of t.clips) {
      const data = clip.buffer.getChannelData(0), x0 = clip.start * z, w = Math.max(0, Math.min(width - x0, clip.dur * z));
      const per = clip.buffer.sampleRate / z, base = clip.off * clip.buffer.sampleRate;
      g.globalAlpha = 0.15; g.fillRect(x0, 0, w, 96); g.globalAlpha = 1;
      const el = document.createElement('div');
      el.className = 'clip' + (selected?.clip === clip ? ' selected' : '');
      el.style.left = x0 + 'px'; el.style.width = w + 'px';
      el.title = 'Drag to move · drag edges to trim · Delete removes';
      el.onpointerdown = (e) => startDrag(e, t, clip, 'move');
      el.onclick = (e) => { // selecting a clip also moves the playhead to the click
        e.stopPropagation();
        if (transport.state === 'recording') return;
        transport.pos = Math.max(0, (e.clientX - t.canvas.getBoundingClientRect().left) / settings.zoom);
        refreshPlayback();
      };
      for (const side of ['left', 'right']) {
        const h = document.createElement('div'); h.className = 'handle ' + side;
        h.onpointerdown = (e) => startDrag(e, t, clip, side);
        el.appendChild(h);
      }
      t.overlay.appendChild(el);
      for (let x = 0; x < w; x++) {
        let mn = 0, mx = 0;
        const a = Math.floor(base + x * per), b = Math.min(data.length, Math.floor(base + (x + 1) * per) + 1);
        for (let i = a; i < b; i++) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
        g.fillRect(x0 + x, 48 - mx * 44, 1, Math.max(1, (mx - mn) * 44));
      }
    }
  }
}

function updateButtons() {
  $('btn-play').textContent = transport.state === 'playing' ? '⏸' : '▶';
  $('btn-record').classList.toggle('active', transport.state === 'recording');
  $('btn-metro').setAttribute('aria-pressed', String(settings.metroRec || settings.metroPlay));
}

// ---------- Frame loop ----------
const meterCtx = $('master-meter').getContext('2d');
const meterData = new Float32Array(analyser.fftSize);
let meterLevel = 0;
function frame() {
  const pos = position();
  $('time').textContent = fmtTime(pos);
  for (const t of tracks) {
    t.playhead.style.left = pos * settings.zoom + 'px';
  }
  if (settings.autoscroll && transport.state !== 'stopped' && tracks[0]) {
    const w = tracks[0].wave, x = pos * settings.zoom;
    if (x > w.scrollLeft + w.clientWidth - 40 || x < w.scrollLeft) w.scrollLeft = Math.max(0, x - 40);
  }
  analyser.getFloatTimeDomainData(meterData);
  let peak = 0;
  for (let i = 0; i < meterData.length; i++) peak = Math.max(peak, Math.abs(meterData[i]));
  meterLevel = Math.max(peak, meterLevel * 0.92);
  const W = meterCtx.canvas.width, H = meterCtx.canvas.height;
  meterCtx.clearRect(0, 0, W, H);
  meterCtx.fillStyle = meterLevel > 0.98 ? '#ff4d4f' : '#5ad1a0';
  meterCtx.fillRect(0, 0, Math.min(1, meterLevel) * W, H);
  requestAnimationFrame(frame);
}

// ---------- Settings dialog ----------
const bindings = [
  ['s-input', 'inputId', 'value'], ['s-channels', 'channels', 'num'], ['s-echo', 'echo', 'check'],
  ['s-noise', 'noise', 'check'], ['s-agc', 'agc', 'check'], ['s-monitor', 'monitor', 'check'],
  ['s-latency', 'latency', 'num'], ['s-beats', 'beats', 'num'], ['s-countin', 'countIn', 'num'],
  ['s-metro-vol', 'metroVol', 'num'], ['s-metro-rec', 'metroRec', 'check'], ['s-metro-play', 'metroPlay', 'check'],
  ['s-theme', 'theme', 'value'], ['s-zoom', 'zoom', 'num'], ['s-autoscroll', 'autoscroll', 'check'],
  ['s-bits', 'bits', 'num'], ['s-normalize', 'normalize', 'check'],
];
function syncSettingsUI() {
  for (const [id, key, kind] of bindings) {
    const el = $(id);
    if (kind === 'check') el.checked = settings[key]; else el.value = settings[key];
  }
  $('click-vol').value = settings.metroVol;
}
function applySettings() {
  document.documentElement.dataset.theme = settings.theme;
  updateButtons();
}
for (const [id, key, kind] of bindings) {
  $(id).addEventListener('change', () => {
    const el = $(id);
    let v = kind === 'check' ? el.checked : kind === 'num' ? Number(el.value) : el.value;
    if (kind === 'num' && !Number.isFinite(v)) v = DEFAULTS[key];
    const lim = { latency: [0, 500], beats: [1, 12], countIn: [0, 4], zoom: [10, 400], metroVol: [0, 1] }[key];
    if (lim) v = clamp(v, ...lim);
    settings[key] = v; saveSettings(); applySettings();
    if (key === 'zoom' || key === 'theme') renderWaves();
    syncSettingsUI();
  });
}
async function populateDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const sel = $('s-input');
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  sel.textContent = '';
  const labelled = devs.some((d) => d.label);
  sel.add(new Option(labelled ? 'Default' : 'Default (record once to list devices)', ''));
  devs.forEach((d, i) => d.deviceId && d.deviceId !== 'default' &&
    sel.add(new Option(d.label || `Microphone ${i + 1}`, d.deviceId)));
  sel.value = settings.inputId;
}

// ---------- Wiring ----------
$('btn-play').onclick = play;
$('btn-stop').onclick = stop;
$('btn-record').onclick = () => (transport.state === 'recording' ? stopRecording() : startRecording());
$('btn-rewind').onclick = () => {
  if (transport.state === 'recording') return;
  const playing = transport.state === 'playing';
  if (playing) { stopSources(); stopMetronome(); }
  transport.pos = 0; scheduleScroll(true);
  if (playing) begin('playing');
};
$('btn-metro').onclick = () => {
  const on = !(settings.metroRec || settings.metroPlay);
  settings.metroRec = settings.metroPlay = on; saveSettings(); syncSettingsUI(); updateButtons();
};
$('btn-import').onclick = () => $('file-import').click();
$('file-import').onchange = (e) => { importFiles([...e.target.files]); e.target.value = ''; };
$('btn-split').onclick = splitSelected;
$('btn-undo').onclick = undo;
$('btn-redo').onclick = redo;
$('btn-delete-clip').onclick = deleteSelected;
$('btn-add-track').onclick = () => { createTrack(); renderTracks(); scheduleSave(); };
$('btn-clear').onclick = () => {
  if (!tracks.length || !confirm('Delete all tracks and recordings?')) return;
  stop();
  tracks.forEach((t) => { t.gain.disconnect(); t.panner.disconnect(); });
  tracks = []; createTrack(); resetHistory(); renderTracks(); scheduleSave();
};
$('btn-export').onclick = () => exportWav().catch((e) => setStatus('Export failed: ' + e.message));
$('btn-settings').onclick = async () => { syncSettingsUI(); $('settings').showModal(); await populateDevices(); };
$('s-reset').onclick = () => { settings = { ...DEFAULTS }; saveSettings(); applySettings(); syncSettingsUI(); renderWaves(); };
$('master-vol').oninput = () => { applyMix(); scheduleSave(); };
$('bpm').onchange = () => {
  $('bpm').value = clamp(+$('bpm').value || 120, 30, 300);
  if (transport.state === 'playing') { stopSources(); stopMetronome(); transport.pos = position(); begin('playing'); }
  scheduleSave();
};
// Tap tempo: average of the last few intervals; a pause over 2 s starts a new count.
const taps = [];
function tapTempo() {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
  taps.push(now);
  if (taps.length > 8) taps.shift();
  if (taps.length < 2) { setStatus('Tap again to set the tempo…'); return; }
  const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
  const bpm = Math.round(clamp(60000 / avg, 30, 300));
  $('bpm').value = bpm;
  $('bpm').dispatchEvent(new Event('change'));
  setStatus(`Tempo: ${bpm} BPM`);
}
$('btn-tap').onclick = tapTempo;
// Toolbar click volume shares settings.metroVol with the dialog; clicks read it when scheduled, so it is live.
$('click-vol').oninput = () => { settings.metroVol = +$('click-vol').value; saveSettings(); syncSettingsUI(); };
document.addEventListener('keydown', (e) => {
  if (editingText() || $('settings').open) return;
  if ((e.metaKey || e.ctrlKey) && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (k === 'y') { e.preventDefault(); redo(); }
    return;
  }
  if (e.metaKey || e.ctrlKey) return;
  if (e.code === 'Space') { e.preventDefault(); play(); }
  else if (e.key === 'r' || e.key === 'R') $('btn-record').click();
  else if (e.key === 't' || e.key === 'T') tapTempo();
  else if (e.key === 's' || e.key === 'S') splitSelected();
  else if (e.code === 'Delete' || e.code === 'Backspace') deleteSelected();
  else if (e.code === 'Home') $('btn-rewind').click();
});

// ---------- Boot ----------
(async function init() {
  applySettings(); syncSettingsUI();
  try {
    const saved = await db.get();
    if (saved) {
      $('bpm').value = saved.bpm || 120;
      $('master-vol').value = saved.master ?? 1;
      for (const td of saved.tracks) {
        const t = createTrack(td);
        for (const c of td.clips) {
          try {
            const clip = makeClip(c.start, await ctx.decodeAudioData(await c.blob.arrayBuffer()), c.blob);
            clip.off = clamp(c.off ?? 0, 0, clip.buffer.duration);
            clip.dur = clamp(c.dur ?? clip.buffer.duration, 0, clip.buffer.duration - clip.off);
            t.clips.push(clip);
          }
          catch { /* skip undecodable clip */ }
        }
      }
    }
  } catch (e) { setStatus('Could not load saved project: ' + e.message); }
  if (!tracks.length) createTrack();
  applyMix();
  renderTracks();
  updateButtons(); updateHistoryButtons();
  requestAnimationFrame(frame);
})();
