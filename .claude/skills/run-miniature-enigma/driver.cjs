// Smoke driver for Miniature Studio. Usage: node .claude/skills/run-miniature-enigma/driver.cjs [shotsDir]
// Loads index.html over file:// in headless Chromium with a fake microphone, exercises
// record / import / trim / move / split / delete / settings / export, saves screenshots.
const { execSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const { chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));

const root = path.resolve(__dirname, '../../..');
const shots = process.argv[2] || '/tmp/shots';
fs.mkdirSync(shots, { recursive: true });

function toneWav(seconds, rate = 44100) {            // 16-bit mono sine, written to a temp file
  const n = seconds * rate, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i * 0.05)), 44 + i * 2);
  const f = path.join(os.tmpdir(), 'studio-tone.wav'); fs.writeFileSync(f, b); return f;
}

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); if (!ok) failed++; };

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
           '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await (await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 700 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const status = () => page.textContent('#status');
  const shot = (n) => page.screenshot({ path: path.join(shots, n + '.png') });

  await page.goto('file://' + path.join(root, 'index.html'));
  await page.waitForSelector('.track');
  await shot('1-initial');

  // Tap tempo: four taps 500 ms apart should read 120 BPM.
  // Taps are scheduled inside the page: per-click round trips from Node would skew the interval.
  await page.evaluate(() => new Promise((done) => {
    let n = 0; const t0 = performance.now();
    (function tap() { document.getElementById('btn-tap').click(); if (++n === 4) return done();
      setTimeout(tap, t0 + n * 500 - performance.now()); })();
  }));
  const tapped = +(await page.inputValue('#bpm'));
  check('tap tempo sets ~120 BPM', Math.abs(tapped - 120) <= 6, `(${tapped})`);

  // Time signature: 6/8 at 120 BPM clicks every eighth (0.25 s); restore 4/4 afterwards.
  await page.selectOption('#time-sig', '6/8');
  const sig = await page.evaluate(() => ({ b: settings.beats, u: settings.beatUnit, spb: beatSeconds(), dlg: document.getElementById('s-beats').value }));
  check('time signature 6/8 sets beats, unit and click spacing', sig.b === 6 && sig.u === 8 && Math.abs(sig.spb - 0.25) < 1e-9 && sig.dlg === '6', JSON.stringify(sig));
  await page.selectOption('#time-sig', '4/4');
  check('time signature back to 4/4', await page.evaluate(() => settings.beats === 4 && settings.beatUnit === 4 && Math.abs(beatSeconds() - 60 / +document.getElementById('bpm').value) < 1e-9));

  // Count-in toggle: off then on again; the setting is shared with the dialog.
  await page.click('#btn-countin');
  check('count-in toggles off', await page.evaluate(() => settings.countInOn === false && !document.getElementById('s-countin-on').checked));
  await page.click('#btn-countin');
  check('count-in toggles back on', await page.evaluate(() => settings.countInOn === true));

  // Toolbar click-volume slider is wired to the same setting as the dialog.
  await page.locator('#click-vol').fill('0.2');
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('studio.settings')).metroVol);
  check('click volume slider persists to settings', persisted === 0.2, `(${persisted})`);

  // Record ~1s with a 240 BPM / 1-beat-bar-less count-in of 1 bar (=1s), via the fake mic.
  await page.fill('#bpm', '240'); await page.dispatchEvent('#bpm', 'change');
  await page.click('#btn-record'); await page.waitForTimeout(2200); await page.click('#btn-record');
  await page.waitForSelector('.clip', { timeout: 5000 }).catch(() => {});
  check('record creates a clip', (await page.locator('.clip').count()) === 1, await status());
  await shot('2-recorded');

  // Import a 4 s tone at the playhead, then trim its right edge by 2 s (80 px/s zoom).
  await page.setInputFiles('#file-import', toneWav(4));
  await page.waitForFunction(() => document.querySelectorAll('.clip').length === 2);
  const imported = page.locator('.clip').nth(1);
  const w0 = (await imported.boundingBox()).width;
  const h = await imported.locator('.handle.right').boundingBox();
  await page.mouse.move(h.x + 4, h.y + 20); await page.mouse.down();
  await page.mouse.move(h.x - 156, h.y + 20, { steps: 5 }); await page.mouse.up();
  const w1 = (await page.locator('.clip').nth(1).boundingBox()).width;
  check('trim shortens clip by ~2 s', Math.abs((w0 - w1) - 160) < 6, `(${Math.round(w0)} -> ${Math.round(w1)} px)`);

  // Select, seek into the clip, split, delete one half.
  await page.locator('.clip').nth(1).click({ position: { x: 60, y: 30 } });
  await page.click('#btn-split');
  check('split makes 3 clips', (await page.locator('.clip').count()) === 3, await status());
  await page.keyboard.press('Delete');
  check('delete removes selected clip', (await page.locator('.clip').count()) === 2);
  // Undo / redo: button, then keyboard shortcut.
  await page.click('#btn-undo');
  check('undo restores deleted clip', (await page.locator('.clip').count()) === 3);
  await page.click('#btn-redo');
  check('redo re-deletes it', (await page.locator('.clip').count()) === 2);
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
  check('Ctrl+Z x3 undoes delete, split and trim', (await page.locator('.clip').nth(1).boundingBox()).width > 300,
        `(${Math.round((await page.locator('.clip').nth(1).boundingBox()).width)} px)`);
  await page.keyboard.press('Control+Shift+z'); await page.keyboard.press('Control+y');
  check('Ctrl+Shift+Z / Ctrl+Y redo', (await page.locator('.clip').count()) === 3);
  await page.click('#btn-undo'); await page.click('#btn-undo'); await page.click('#btn-redo'); await page.click('#btn-redo');
  await shot('3-edited');

  // Loop: shift-drag 0.5 s .. 1.5 s on the waveform, play from the start, position must stay inside the region.
  const wb = await page.locator('.track-wave').first().boundingBox();
  await page.keyboard.down('Shift');
  await page.mouse.move(wb.x + 40, wb.y + 60); await page.mouse.down();
  await page.mouse.move(wb.x + 120, wb.y + 60, { steps: 4 }); await page.mouse.up();
  await page.keyboard.up('Shift');
  check('shift-drag sets and enables loop', await page.evaluate(() =>
    loopRegion.enabled && Math.abs(loopRegion.start - 0.5) < 0.05 && Math.abs(loopRegion.end - 1.5) < 0.05), await status());
  await page.click('#btn-rewind'); await page.click('#btn-play'); await page.waitForTimeout(2600);
  const loopPos = await page.evaluate(() => ({ pos: position(), n: transport.sources.length }));
  check('playback wraps inside the loop region', loopPos.pos >= 0.45 && loopPos.pos <= 1.55, `(pos ${loopPos.pos.toFixed(2)} s, ${loopPos.n} scheduled sources)`);
  await shot('3b-loop');
  await page.click('#btn-play');
  await page.click('#btn-loop');
  check('loop button toggles off', await page.evaluate(() => !loopRegion.enabled));

  // Settings: switch theme.
  await page.click('#btn-settings'); await page.selectOption('#s-theme', 'light');
  check('theme setting applies', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light');
  await shot('4-settings'); await page.keyboard.press('Escape');

  // Export WAV.
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  const out = path.join(shots, 'mix.wav'); await dl.saveAs(out);
  check('export produces a WAV', fs.statSync(out).size > 10000 && fs.readFileSync(out).slice(0, 4).toString() === 'RIFF',
        `(${fs.statSync(out).size} bytes)`);

  check('no console/page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(`screenshots in ${shots}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
