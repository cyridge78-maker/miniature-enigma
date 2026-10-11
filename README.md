# Miniature Studio

A dependency-free, in-browser multitrack recording studio (Web Audio + MediaRecorder).

Open `index.html` (or serve the folder, e.g. `npx http-server`) — microphone access needs `https` or `localhost`/`file`.

- Multitrack recording with arm / mute / solo / volume / pan per track
- Transport, click-to-seek waveforms, metronome with count-in, BPM
- Master volume + level meter, WAV export (16/24-bit, optional normalize)
- Project auto-saved in the browser (IndexedDB)
- **Settings** (⚙): input device, mono/stereo, echo cancellation / noise suppression / AGC, input monitoring,
  latency compensation, metronome (beats, count-in, volume, when active), theme, waveform zoom, follow playhead, export options

Shortcuts: `Space` play/pause, `R` record/stop, `Home` rewind.
