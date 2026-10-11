# Miniature Studio

A dependency-free, in-browser multitrack recording studio (Web Audio + MediaRecorder).

Open `index.html` (or serve the folder, e.g. `npx http-server`) — microphone access needs `https` or `localhost`/`file`.

- Multitrack recording with arm / mute / solo / volume / pan per track
- Transport, click-to-seek waveforms, metronome with a count-in toggle (toolbar `1·2·3`), BPM (with **Tap** tempo, `T`, and a click-volume slider in the toolbar)
- **Import audio** (any format the browser can decode) onto the armed track at the playhead
- **Clip editing** (non-destructive): drag a clip to move it, drag its edges to trim, ✂ Split at the playhead (`S`), `Delete` removes the selected clip
- **Undo / redo** for clip edits (record, import, trim, move, split, delete, clear track): `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` or `Ctrl+Y`, up to 100 steps (history is not kept across reloads)
- **Loop region:** shift-drag on a waveform to set it, 🔁 / `L` toggles repeat playback (saved with the project; playback only, not recording)
- Master volume + level meter, WAV export (16/24-bit, optional normalize)
- Project auto-saved in the browser (IndexedDB)
- **Settings** (⚙): input device, mono/stereo, echo cancellation / noise suppression / AGC, input monitoring,
  latency compensation, metronome (beats, count-in, volume, when active), theme, waveform zoom, follow playhead, export options

Shortcuts: `Space` play/pause, `R` record/stop, `T` tap tempo, `L` loop, `Home` rewind, `S` split selected clip, `Delete` delete selected clip.
