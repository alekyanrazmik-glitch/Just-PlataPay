#!/usr/bin/env node
/* Renders a reel project to a ready-to-upload vertical MP4.
 *
 *   node render.mjs                     # every project in reels/projects
 *   node render.mjs --project=card-declined
 *   node render.mjs --project=all --fps=60 --out=out
 *
 * The page is stepped frame by frame (REEL.seek) and each screenshot is piped
 * straight into ffmpeg, so output is deterministic and nothing touches disk
 * between the browser and the encoder.
 */

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';
import { buildVoiceTrack } from './voice.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WIDTH = 1080;
const HEIGHT = 1920;

/* ------------------------------------------------------------------- args */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = true] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const OUT_DIR = path.resolve(HERE, args.out || 'out');
const FORMAT = args.format || 'mp4';
const QUALITY = Number(args.crf || 18);
const FPS_OVERRIDE = args.fps ? Number(args.fps) : null;
const SILENT_AUDIO = args['no-audio'] ? false : true;
/* JPEG frames are ~35% faster to capture than PNG and the difference survives
   x264 unnoticed; pass --frames=png if you ever need a lossless intermediate. */
const FRAME_TYPE = args.frames === 'png' ? 'png' : 'jpeg';
const WITH_VOICE = !args['no-voice'];

/* ------------------------------------------------------------- toolchain  */

function findFfmpeg() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return 'ffmpeg'; // fall back to whatever is on PATH
}

function findChromium() {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) {
    return process.env.CHROMIUM_PATH;
  }
  // Playwright's own build first: it is pinned, so frames stay identical
  // across machines. System Chrome is only a last resort.
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  const candidates = [
    '/opt/pw-browsers/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

const FFMPEG = findFfmpeg();

/* ------------------------------------------------------------------ utils */

/* Respect ffmpeg's backpressure; the stream's error is handled once, on spawn,
   so this must not add a listener per frame. */
const writeAsync = (stream, buf) =>
  new Promise((resolve) => {
    if (stream.write(buf)) resolve();
    else stream.once('drain', resolve);
  });

function listProjects() {
  const dir = path.join(HERE, 'projects');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.basename(f, '.json'))
    .sort();
}

function ffmpegArgs(fps, outFile, voiceTrack) {
  const a = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-'];
  const withAudio = voiceTrack || (SILENT_AUDIO && FORMAT === 'mp4');
  if (voiceTrack) {
    a.push('-i', voiceTrack);
  } else if (SILENT_AUDIO && FORMAT === 'mp4') {
    a.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
  }
  if (FORMAT === 'webm') {
    a.push('-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(QUALITY + 12), '-pix_fmt', 'yuv420p');
  } else {
    a.push(
      '-c:v', 'libx264',
      '-preset', args.preset || 'slow',
      '-crf', String(QUALITY),
      '-profile:v', 'high',
      '-level', '4.1',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart'
    );
    if (withAudio) a.push('-c:a', 'aac', '-b:a', voiceTrack ? '160k' : '128k', '-shortest');
  }
  a.push('-r', String(fps), outFile);
  return a;
}

/* ----------------------------------------------------------------- render */

async function renderProject(browser, baseUrl, name) {
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });

  // Missing logo ids and script errors must stop the render: a reel that is
  // silently short a logo is worse than no reel.
  const problems = [];
  page.on('console', (msg) => {
    if (msg.text().includes('[reel]')) problems.push(msg.text());
  });
  page.on('pageerror', (err) => problems.push(String(err)));
  page.on('response', (res) => {
    if (res.status() >= 400) problems.push(`${res.status()} ${res.url()}`);
  });

  const url = new URL('/reels/src/reel.html', baseUrl);
  url.searchParams.set('project', name);
  await page.goto(url.href);

  await page.waitForFunction(
    () => document.body.dataset.ready === '1' || document.body.dataset.error,
    null,
    { timeout: 30000 }
  );
  const pageError = await page.evaluate(() => document.body.dataset.error || null);
  if (pageError) throw new Error(`${name}: stage failed to build — ${pageError}`);
  if (problems.length) {
    throw new Error(`${name}: stage reported problems —\n  ${problems.join('\n  ')}`);
  }

  const meta = await page.evaluate(() => ({
    duration: window.REEL.duration,
    fps: window.REEL.fps,
    project: window.REEL.project,
    post: window.REEL.project.post || null,
    posterAt: window.REEL.project.posterAt ?? 1.2,
  }));

  // Narration, when the project has any. A missing voice never fails a render:
  // the reel still has to ship, silent.
  let voiceTrack = null;
  if (WITH_VOICE) {
    try {
      const built = await buildVoiceTrack({
        projectName: name,
        project: meta.project,
        duration: meta.duration,
        ffmpeg: FFMPEG,
        provider: args.provider,
      });
      if (built) voiceTrack = built.track;
    } catch (err) {
      process.stdout.write(`   ! озвучка пропущена: ${err.message}\n`);
      // Surface it on the run page too: the volume check fails the build, but
      // the reason lives in another step's log where nobody looks first.
      if (process.env.GITHUB_ACTIONS) {
        process.stdout.write(`::error::озвучка ${name}: ${err.message}\n`);
      }
    }
  }

  const fps = FPS_OVERRIDE || meta.fps || 30;
  const frames = Math.max(1, Math.round(meta.duration * fps));
  const outFile = path.join(OUT_DIR, `${name}.${FORMAT}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  process.stdout.write(
    `\n▶ ${name}  ${meta.duration.toFixed(2)}s · ${fps}fps · ${frames} кадров` +
      `${voiceTrack ? ' · с озвучкой' : ''} → ${path.relative(process.cwd(), outFile)}\n`
  );

  const ff = spawn(FFMPEG, ffmpegArgs(fps, outFile, voiceTrack), { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => {
    ff.on('error', reject);
    ff.stdin.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });

  const started = Date.now();
  for (let i = 0; i < frames; i++) {
    await page.evaluate((t) => window.REEL.seek(t), i / fps);
    const buf = await page.screenshot({
      type: FRAME_TYPE,
      ...(FRAME_TYPE === 'jpeg' ? { quality: 96 } : {}),
      animations: 'disabled',
      caret: 'hide',
    });
    await writeAsync(ff.stdin, buf);
    if (i % 30 === 0 || i === frames - 1) {
      const pct = Math.round(((i + 1) / frames) * 100);
      process.stdout.write(`\r   кадр ${i + 1}/${frames}  ${pct}%   `);
    }
  }
  ff.stdin.end();
  await done;
  process.stdout.write(`\r   готово за ${((Date.now() - started) / 1000).toFixed(1)}s            \n`);

  // Cover frame for the feed preview.
  await page.evaluate((t) => window.REEL.seek(t), meta.posterAt);
  await page.screenshot({ path: path.join(OUT_DIR, `${name}-cover.jpg`), type: 'jpeg', quality: 92 });

  // Caption ready to paste next to the video.
  if (meta.post) {
    const text = [meta.post.caption || '', (meta.post.hashtags || []).join(' ')]
      .filter(Boolean)
      .join('\n\n');
    fs.writeFileSync(path.join(OUT_DIR, `${name}.txt`), text + '\n', 'utf8');
  }

  await page.close();
  return outFile;
}

/* ------------------------------------------------------------------- main */

async function main() {
  const wanted =
    !args.project || args.project === 'all' || args.all
      ? listProjects()
      : String(args.project).split(',');

  const executablePath = findChromium();
  if (!executablePath) {
    console.error(
      'Chromium не найден. Укажите путь в CHROMIUM_PATH или установите его: npx playwright install chromium'
    );
    process.exit(1);
  }

  const server = await startServer({ port: 0 });
  const browser = await chromium.launch({
    executablePath,
    args: ['--force-color-profile=srgb', '--disable-lcd-text', '--hide-scrollbars'],
  });

  try {
    for (const name of wanted) {
      if (!fs.existsSync(path.join(HERE, 'projects', `${name}.json`))) {
        throw new Error(`нет проекта reels/projects/${name}.json`);
      }
      await renderProject(browser, server.url, name);
    }
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(`\n✓ всё в ${path.relative(process.cwd(), OUT_DIR)}/`);
}

main().catch((err) => {
  console.error('\n✗', err.message);
  process.exit(1);
});
