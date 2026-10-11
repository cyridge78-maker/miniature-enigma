---
name: run-miniature-enigma
description: Run, start, test, drive, or screenshot Miniature Studio, the in-browser multitrack recording app (index.html). Use when asked to launch the app, take a screenshot, smoke-test recording / import / trim / export, or verify a change in the real UI.
---

Miniature Studio is a static, dependency-free web app (`index.html` + `app.js` + `style.css`; Web Audio + MediaRecorder). There is no build step and no test suite. Drive it with `.claude/skills/run-miniature-enigma/driver.cjs`, a Playwright script that opens `index.html` over `file://` in headless Chromium with a fake microphone.

All paths are relative to the repo root.

## Prerequisites

Playwright (global npm install) and the pre-installed Chromium at `/opt/pw-browsers/chromium` — both already present in the cloud container. Nothing to install.

```bash
ls "$(npm root -g)/playwright" /opt/pw-browsers/chromium >/dev/null && echo ok
```

## Run (agent path)

```bash
node .claude/skills/run-miniature-enigma/driver.cjs            # screenshots -> /tmp/shots
node .claude/skills/run-miniature-enigma/driver.cjs /tmp/mine  # custom screenshot dir
```

It exercises one end-to-end flow and prints `PASS`/`FAIL` per step (exit code 1 on any failure):
tap tempo (`#btn-tap`) →
record 1 s from the fake mic (with count-in) → import a generated 4 s WAV → trim its right edge by dragging → split at the playhead → delete a clip → undo/redo (buttons and Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y) → change a setting (theme) → export `mix.wav` → assert no console/page errors.

Output: `/tmp/shots/{1-initial,2-recorded,3-edited,4-settings}.png` and `/tmp/shots/mix.wav`. Open the screenshots (Read tool) — a passing run with a blank page would be a bug.

To poke at something else, copy the driver and change the middle section. Useful selectors: `#btn-record`, `#btn-play`, `#btn-import` / `#file-import` (use `setInputFiles`), `#btn-split`, `#btn-delete-clip`, `#btn-undo`, `#btn-redo`, `#btn-export`, `#btn-settings`, settings fields `#s-*`, clips `.clip` with `.handle.left` / `.handle.right`, status line `#status`.

## Run (human path)

Open `index.html` in a browser (or `npx http-server`, then http://localhost:8080). Microphone needs `localhost`/`https`/`file://`. Useless headless.

## Gotchas

- **Fake mic flags are required.** Headless Chromium has no audio input; without `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream` the record button reports "Microphone permission denied" / no device. The fake device emits periodic beeps, so recorded waveforms look like spikes.
- **Autoplay:** pass `--autoplay-policy=no-user-gesture-required`, otherwise the `AudioContext` stays suspended until a gesture.
- **Count-in eats recording time.** Default is 1 bar of 4 beats; at 120 BPM that's 2 s before any audio is kept. The driver sets 240 BPM (1 s count-in) so a 2.2 s record yields ~1.2 s of audio.
- **Clip clicks:** the clip overlay DOM is rebuilt by `renderWaves()`. Re-rendering inside `pointerdown` removes the element before `click` fires, so selecting a clip silently stopped working once; selection is restyled in place in `startDrag` for that reason. If you add handlers on `.clip`, don't re-render on pointerdown.
- **Zoom is 80 px/s by default**, so drag distances in the driver map to seconds (160 px = 2 s).
- **Project state persists** in IndexedDB per browser profile; each driver run uses a fresh context, so it always starts empty.
- **Split needs the playhead inside the selected clip**: clicking a clip selects it *and* moves the playhead there; otherwise the status line says "Move the playhead inside the selected clip to split."

## Troubleshooting

- **`Cannot find module '.../playwright'`**: global Playwright missing; `npm i -g playwright` (do not run `playwright install`; Chromium is pre-installed).
- **`browserType.launch: Executable doesn't exist`**: set `CHROMIUM_PATH=/path/to/chromium`.
- **`FAIL record creates a clip` with "Nothing recorded."**: recording was shorter than the count-in; lengthen the wait in the driver or lower the bar count in Settings.
