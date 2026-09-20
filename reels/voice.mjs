/* Voice-over track builder.
 *
 * A reel's narration lives next to its scenes: every scene may carry a `voice`
 * field, and the line is timed from that scene's start. This module turns those
 * lines into one WAV the renderer muxes into the MP4.
 *
 *   node voice.mjs --project=<name>            # build the track
 *   node voice.mjs --project=<name> --check    # only report timing, synthesize nothing
 *
 * Providers, picked with --provider (or VOICE_PROVIDER):
 *   file        pre-recorded audio from reels/voice/<project>/01.wav, 02.wav …
 *               (a human voice always beats a synthetic one — this is the path
 *               to use once someone records the lines)
 *   elevenlabs  needs ELEVENLABS_API_KEY; voice id from brand.json or --voice-id
 *   openai      needs OPENAI_API_KEY
 *
 * Synthesized audio is cached in reels/.voice-cache/ keyed by the text, so
 * rebuilding a reel after a copy change only pays for the lines that changed.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, '.voice-cache');
const SOURCE = path.join(HERE, 'voice');

/* ------------------------------------------------------------------- lines */

/** Every narration line with its absolute start second. */
export function collectLines(project) {
  const lines = [];
  let at = 0;
  for (const scene of project.scenes || []) {
    const dur = scene.duration || 3;
    if (scene.voice) {
      const items =
        typeof scene.voice === 'string' ? [{ at: 0.15, text: scene.voice }] : scene.voice;
      for (const item of items) {
        lines.push({
          at: +(at + (item.at ?? 0.15)).toFixed(3),
          text: String(item.text || '').trim(),
          sceneEnd: at + dur,
          sceneType: scene.type,
        });
      }
    }
    at += dur;
  }
  // a top-level list can add lines that do not belong to one scene
  for (const item of project.voiceover || []) {
    lines.push({
      at: Number(item.at) || 0,
      text: String(item.text || '').trim(),
      sceneEnd: at,
      sceneType: 'voiceover',
    });
  }
  return lines.filter((l) => l.text).sort((a, b) => a.at - b.at);
}

/* Rough Russian narration timing: syllables at a calm reel pace, plus a beat
   for every sentence end. Only used to warn before anything is synthesized. */
export function estimateSeconds(text) {
  const syllables = (text.match(/[аеёиоуыэюяАЕЁИОУЫЭЮЯaeiouyAEIOUY]/g) || []).length;
  const pauses = (text.match(/[.!?…]/g) || []).length;
  return +(syllables / 5.6 + pauses * 0.28 + 0.2).toFixed(2);
}

/** A numbered sheet to read from, written next to where recordings go. */
export function writeScript(projectName, lines) {
  const dir = path.join(SOURCE, projectName);
  fs.mkdirSync(dir, { recursive: true });
  const body = lines
    .map((line, i) => {
      const n = String(i + 1).padStart(2, '0');
      return `${n}.  (${line.at}s, есть ${line.room}s)  →  ${n}.wav\n    ${line.text}`;
    })
    .join('\n\n');
  const file = path.join(dir, 'script.txt');
  fs.writeFileSync(
    file,
    `Реплики для ролика «${projectName}»\n` +
      `Запишите каждую отдельным файлом с этим номером в этой папке.\n` +
      `В скобках — на какой секунде реплика звучит и сколько секунд на неё есть.\n\n${body}\n`,
    'utf8'
  );
  return file;
}

/** Warn where a line cannot fit the scene it belongs to. */
export function checkTiming(lines) {
  return lines.map((line) => {
    const need = estimateSeconds(line.text);
    const room = +(line.sceneEnd - line.at).toFixed(2);
    return { ...line, need, room, tight: need > room };
  });
}

/* --------------------------------------------------------------- providers */

const providers = {
  /** Pre-recorded files: reels/voice/<project>/01.wav, 02.wav, … in line order. */
  async file({ projectName, index }) {
    const dir = path.join(SOURCE, projectName);
    const stem = String(index + 1).padStart(2, '0');
    for (const ext of ['wav', 'mp3', 'm4a', 'aac', 'ogg']) {
      const candidate = path.join(dir, `${stem}.${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(
      `нет файла для реплики ${stem} — положите reels/voice/${projectName}/${stem}.wav`
    );
  },

  async elevenlabs({ text, settings }) {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new Error('нет ELEVENLABS_API_KEY');
    const voiceId = settings.voiceId || 'XrExE9yKIg1WjnnlVkGX';
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: settings.model || 'eleven_multilingual_v2',
          voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.15 },
        }),
      }
    );
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  },

  async openai({ text, settings }) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('нет OPENAI_API_KEY');
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: settings.model || 'gpt-4o-mini-tts',
        voice: settings.voiceId || 'onyx',
        input: text,
        response_format: 'mp3',
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  },
};

/* ------------------------------------------------------------------- build */

const run = (bin, args) =>
  new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `${bin} ${code}`))));
  });

const probeDuration = (ffmpeg, file) =>
  new Promise((resolve) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-i', file]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => {
      const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(err);
      resolve(m ? +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]) : 0);
    });
  });

/**
 * Build one WAV holding every line at its own second.
 * Returns { track, lines } or null when the project has no narration.
 */
export async function buildVoiceTrack({ projectName, project, duration, ffmpeg, provider, quiet }) {
  const lines = checkTiming(collectLines(project));
  if (!lines.length) return null;

  const settings = { ...(project.voiceSettings || {}) };
  const name = provider || process.env.VOICE_PROVIDER || settings.provider || 'file';
  const make = providers[name];
  if (!make) throw new Error(`неизвестный провайдер озвучки: ${name}`);

  fs.mkdirSync(CACHE, { recursive: true });
  const clips = [];
  for (const [index, line] of lines.entries()) {
    const key = crypto
      .createHash('sha1')
      .update([name, settings.voiceId, settings.model, line.text].join('\u0000'))
      .digest('hex')
      .slice(0, 16);
    const cached = path.join(CACHE, `${name}-${key}.wav`);

    if (!fs.existsSync(cached)) {
      const produced = await make({ text: line.text, settings, projectName, index });
      // a provider returns either a path to an existing file or raw audio bytes
      const src = Buffer.isBuffer(produced) ? path.join(CACHE, `${name}-${key}.raw`) : produced;
      if (Buffer.isBuffer(produced)) fs.writeFileSync(src, produced);
      await run(ffmpeg, ['-y', '-loglevel', 'error', '-i', src, '-ac', '1', '-ar', '44100', cached]);
      if (Buffer.isBuffer(produced)) fs.unlinkSync(src);
    }
    clips.push({ ...line, file: cached, actual: await probeDuration(ffmpeg, cached) });
  }

  // Report where the recorded line really does not fit its scene.
  for (const clip of clips) {
    if (clip.actual > clip.room + 0.15 && !quiet) {
      process.stdout.write(
        `   ! реплика на ${clip.at}s длиннее сцены: ${clip.actual.toFixed(2)}s против ${clip.room}s — «${clip.text.slice(0, 48)}…»\n`
      );
    }
  }

  const track = path.join(CACHE, `${projectName}-track.wav`);
  const args = ['-y', '-loglevel', 'error'];
  for (const clip of clips) args.push('-i', clip.file);
  const delays = clips
    .map((clip, i) => `[${i}:a]adelay=${Math.round(clip.at * 1000)}:all=1[d${i}]`)
    .join(';');
  const mixIn = clips.map((_, i) => `[d${i}]`).join('');
  args.push(
    '-filter_complex',
    `${delays};${mixIn}amix=inputs=${clips.length}:normalize=0:dropout_transition=0[m];` +
      // -16 LUFS is what the platforms normalise speech towards anyway.
      // loudnorm runs at its own rate, so resample first and pad after: the
      // track must end up a touch LONGER than the video, because the mux uses
      // -shortest and would otherwise clip the last frames off the reel.
      `[m]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100,apad,atrim=0:${(duration + 0.3).toFixed(3)}[out]`,
    '-map',
    '[out]',
    '-ac',
    '2',
    track
  );
  await run(ffmpeg, args);
  return { track, lines: clips };
}

/* -------------------------------------------------------------------- cli  */

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, v = true] = a.replace(/^--/, '').split('=');
      return [k, v];
    })
  );
  const names = args.project && args.project !== 'all'
    ? String(args.project).split(',')
    : fs.readdirSync(path.join(HERE, 'projects')).filter((f) => f.endsWith('.json')).map((f) => path.basename(f, '.json'));

  for (const projectName of names) {
    const project = JSON.parse(
      fs.readFileSync(path.join(HERE, 'projects', `${projectName}.json`), 'utf8')
    );
    const duration = (project.scenes || []).reduce((sum, s) => sum + (s.duration || 3), 0);
    const lines = checkTiming(collectLines(project));
    console.log(`\n${projectName} — ${lines.length} реплик, ${duration.toFixed(1)}s`);
    for (const line of lines) {
      const flag = line.tight ? '  ✗ не влезает' : '';
      console.log(
        `  ${String(line.at).padStart(6)}s  ~${line.need}s / ${line.room}s${flag}\n          ${line.text}`
      );
    }
    if (lines.length) console.log(`  → ${path.relative(process.cwd(), writeScript(projectName, lines))}`);
    if (args.check) continue;

    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    let ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    try { ffmpeg = require('ffmpeg-static') || ffmpeg; } catch {}
    const built = await buildVoiceTrack({
      projectName,
      project,
      duration,
      ffmpeg,
      provider: args.provider,
    });
    console.log(built ? `  → ${path.relative(process.cwd(), built.track)}` : '  нет реплик');
  }
}
