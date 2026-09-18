/* Deterministic reel engine.
 *
 * Nothing here uses CSS transitions, CSS animations or requestAnimationFrame
 * timing: the whole reel is a pure function of time. `REEL.seek(t)` writes the
 * exact frame for second `t`, which is what lets the renderer screenshot frame
 * by frame and get identical output on every machine.
 */

const STAGE_W = 1080;
const STAGE_H = 1920;

/* ---------------------------------------------------------------- easings */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

const ease = {
  linear: (t) => t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  outQuint: (t) => 1 - Math.pow(1 - t, 5),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outBack: (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.4 * Math.pow(t - 1, 2),
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -9 * t)),
};

/** Progress of element `i` in a staggered group, in [0,1]. */
function stagger(local, i, { delay = 0, step = 0.09, dur = 0.62 } = {}) {
  return clamp01((local - delay - i * step) / dur);
}

/* ------------------------------------------------------------------- text */

/* Tiny markup so project files stay plain text:
 *   *word*  -> accent colour
 *   |       -> line break
 *   ~word~  -> struck through / dimmed
 */
function parseMarkup(text) {
  return String(text)
    .split('|')
    .map((line) => {
      const tokens = [];
      // `glue` keeps punctuation that hugged the previous word — the » in
      // «Карта *отклонена*» — from drifting off on its own space.
      let spaceBefore = true;
      // split into styled runs first, so *два слова* works as one accent run
      for (const run of line.trim().split(/(\*[^*]+\*|~[^~]+~)/g)) {
        if (!run) continue;
        const accent = run.startsWith('*') && run.endsWith('*') && run.length > 2;
        const strike = run.startsWith('~') && run.endsWith('~') && run.length > 2;
        const body = accent || strike ? run.slice(1, -1) : run;
        const words = body.split(/\s+/).filter(Boolean);
        words.forEach((word, i) => {
          const glue = i === 0 && !spaceBefore && !/^\s/.test(run);
          tokens.push({ text: word, accent, strike, glue });
        });
        if (words.length) spaceBefore = /\s$/.test(run);
      }
      return tokens;
    });
}

function buildWords(host, text) {
  const words = [];
  for (const line of parseMarkup(text)) {
    const lineEl = document.createElement('div');
    line.forEach((token, index) => {
      if (index > 0 && !token.glue) lineEl.appendChild(document.createTextNode(' '));
      const w = document.createElement('span');
      w.className = 'word';
      let slot = w;
      if (token.accent) {
        slot = w.appendChild(document.createElement('em'));
      } else if (token.strike) {
        slot = w.appendChild(document.createElement('span'));
        slot.className = 'strike';
      }
      slot.textContent = token.text;
      lineEl.appendChild(w);
      words.push(w);
    });
    host.appendChild(lineEl);
  }
  return words;
}

/** Word-by-word rise used by every headline in the kit. */
function animateWords(words, local, opts = {}) {
  const { delay = 0, step = 0.055, dur = 0.55, rise = 46 } = opts;
  words.forEach((w, i) => {
    const p = ease.outQuint(stagger(local, i, { delay, step, dur }));
    w.style.opacity = p;
    w.style.transform = `translate3d(0, ${(1 - p) * rise}px, 0)`;
    w.style.filter = p > 0.99 ? 'none' : `blur(${(1 - p) * 9}px)`;
  });
}

/* ------------------------------------------------------------------ logos */

/** Chip element with the logo cropped to its artwork and optically sized. */
function makeChip(entry, size, root) {
  const chip = document.createElement('div');
  // Half of the marks are pure black, so a dark tile would swallow them: the
  // tile follows the artwork instead of the other way round.
  chip.className = `chip ${entry.lum >= 0.72 ? 'on-dark' : 'on-light'}`;
  chip.style.width = `${size}px`;
  chip.style.height = `${size}px`;
  chip.style.setProperty('--brand', entry.color);
  chip.style.boxShadow = `0 ${size * 0.13}px ${size * 0.34}px -${size * 0.16}px ${entry.color}59`;

  const art = document.createElement('div');
  const trim = entry.trim;
  const ratio = trim.ratio || 1;
  // Equal-area sizing: wide logos get wider but not taller, so a grid of very
  // different marks still reads as one rhythm.
  const base = size * 0.6;
  let w = base * Math.sqrt(ratio);
  let h = base / Math.sqrt(ratio);
  const max = size * 0.8;
  const over = Math.max(w / max, h / max, 1);
  w /= over;
  h /= over;

  const px = trim.w >= 0.999 ? 50 : (trim.x / (1 - trim.w)) * 100;
  const py = trim.h >= 0.999 ? 50 : (trim.y / (1 - trim.h)) * 100;

  Object.assign(art.style, {
    width: `${w}px`,
    height: `${h}px`,
    backgroundImage: `url("${root}${encodeURIComponent(entry.file)}")`,
    backgroundSize: `${100 / trim.w}% ${100 / trim.h}%`,
    backgroundPosition: `${px}% ${py}%`,
    backgroundRepeat: 'no-repeat',
  });
  chip.appendChild(art);
  return chip;
}

/* ----------------------------------------------------------------- scenes */

const scenes = {
  /* Opening hook: kicker + big headline + supporting line. */
  hook(def, ctx) {
    const el = document.createElement('div');
    el.className = 'scene scene-hook';
    el.style.justifyContent = 'center';

    let kicker = null;
    if (def.kicker) {
      kicker = document.createElement('div');
      kicker.className = 'kicker';
      kicker.textContent = def.kicker;
      el.appendChild(kicker);
    }

    const title = document.createElement('div');
    title.className = `title${def.size === 'small' ? ' is-small' : def.size === 'tiny' ? ' is-tiny' : ''}`;
    title.style.marginTop = def.kicker ? '46px' : '0';
    const words = buildWords(title, def.title || '');
    el.appendChild(title);

    let sub = null;
    if (def.sub) {
      sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = def.sub;
      el.appendChild(sub);
    }

    return {
      el,
      update(local) {
        if (kicker) {
          const p = ease.outBack(clamp01(local / 0.5));
          kicker.style.opacity = clamp01(local / 0.32);
          kicker.style.transform = `translate3d(0, ${(1 - p) * 26}px, 0)`;
        }
        animateWords(words, local, { delay: def.kicker ? 0.16 : 0.04 });
        if (sub) {
          const p = ease.outCubic(clamp01((local - 0.55) / 0.6));
          sub.style.opacity = p;
          sub.style.transform = `translate3d(0, ${(1 - p) * 24}px, 0)`;
        }
      },
    };
  },

  /* Endless logo marquee — the "we cover everything" b-roll. */
  ticker(def, ctx) {
    const el = document.createElement('div');
    el.className = 'scene scene-ticker';
    el.style.padding = '0';

    const wrap = document.createElement('div');
    wrap.className = 'ticker-wrap';
    const rows = [];
    const perRow = def.perRow || 9;
    const pool = ctx.pick(def.logos, (def.rows || 4) * perRow);

    for (let r = 0; r < (def.rows || 4); r++) {
      const row = document.createElement('div');
      row.className = 'ticker-row';
      const slice = [];
      for (let i = 0; i < perRow; i++) slice.push(pool[(r * perRow + i) % pool.length]);
      // duplicated twice so the translate can wrap seamlessly
      for (const entry of slice.concat(slice)) row.appendChild(makeChip(entry, 210, ctx.root));
      wrap.appendChild(row);
      rows.push({ el: row, span: (210 + 34) * slice.length, dir: r % 2 ? -1 : 1 });
    }
    el.appendChild(wrap);

    const veil = document.createElement('div');
    veil.className = 'ticker-veil';
    el.appendChild(veil);

    let caption = null;
    let words = [];
    if (def.title) {
      caption = document.createElement('div');
      caption.className = 'scene';
      caption.style.opacity = '1';
      caption.style.visibility = 'visible';
      caption.style.justifyContent = 'center';
      caption.style.alignItems = 'center';
      caption.style.textAlign = 'center';
      const title = document.createElement('div');
      title.className = `title${def.size === 'tiny' ? ' is-tiny' : ' is-small'}`;
      title.style.textShadow = '0 24px 80px rgba(0,0,0,0.85)';
      words = buildWords(title, def.title);
      caption.appendChild(title);
      el.appendChild(caption);
    }

    const speed = def.speed || 130;
    return {
      el,
      update(local) {
        for (const row of rows) {
          const shift = ((local * speed) % row.span) * row.dir;
          const base = row.dir < 0 ? 0 : -row.span;
          row.el.style.transform = `translate3d(${base + shift}px, 0, 0)`;
        }
        if (words.length) animateWords(words, local, { delay: 0.1, step: 0.05 });
      },
    };
  },

  /* Grid of logos popping in, with a counting headline. */
  logoGrid(def, ctx) {
    const el = document.createElement('div');
    el.className = 'scene scene-grid';

    const head = document.createElement('div');
    head.style.textAlign = 'center';
    const counter = document.createElement('div');
    counter.className = 'counter';
    const cap = document.createElement('div');
    cap.className = 'sub';
    cap.style.marginTop = '4px';
    cap.style.fontSize = '46px';
    cap.style.fontWeight = '700';
    cap.style.color = 'var(--ink)';
    cap.textContent = def.caption || '';
    head.appendChild(counter);
    head.appendChild(cap);
    el.appendChild(head);

    const cols = def.cols || 4;
    const grid = document.createElement('div');
    grid.className = 'grid';
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    const cells = def.rows ? cols * def.rows : cols * 5;
    const chipSize = (STAGE_W - 168 - (cols - 1) * 30) / cols;
    const pool = ctx.pick(def.logos, cells);
    const chips = pool.map((entry) => {
      const chip = makeChip(entry, chipSize, ctx.root);
      chip.style.width = '100%';
      chip.style.height = 'auto';
      grid.appendChild(chip);
      return chip;
    });
    el.appendChild(grid);

    const target = def.count || 100;
    return {
      el,
      update(local, dur) {
        const cp = ease.outExpo(clamp01((local - 0.1) / Math.max(dur - 0.9, 0.6)));
        counter.textContent = `${Math.round(target * cp)}+`;
        counter.style.opacity = clamp01(local / 0.3);
        cap.style.opacity = ease.outCubic(clamp01((local - 0.25) / 0.5));
        chips.forEach((chip, i) => {
          // diagonal wave so the grid fills like a wipe, not row by row
          const order = (i % cols) + Math.floor(i / cols);
          const p = ease.outBack(stagger(local, order, { delay: 0.18, step: 0.055, dur: 0.5 }));
          chip.style.opacity = clamp01(p * 1.6);
          chip.style.transform = `scale(${lerp(0.55, 1, p)}) translate3d(0, ${(1 - p) * 30}px, 0)`;
        });
      },
    };
  },

  /* Numbered list: top-N services, one row at a time. */
  list(def, ctx) {
    const el = document.createElement('div');
    el.className = 'scene scene-list';

    const head = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'title is-tiny';
    const words = buildWords(title, def.title || '');
    head.appendChild(title);
    el.appendChild(head);

    const rows = document.createElement('div');
    rows.className = 'rows';
    const items = (def.items || []).map((item, i) => {
      const row = document.createElement('div');
      row.className = 'row';

      const rank = document.createElement('div');
      rank.className = 'rank';
      rank.textContent = `${i + 1}`;
      row.appendChild(rank);

      const entry = ctx.logo(item.logo);
      if (entry) row.appendChild(makeChip(entry, 124, ctx.root));

      const meta = document.createElement('div');
      meta.className = 'meta';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = item.name || (entry ? entry.id : '');
      meta.appendChild(name);
      if (item.note) {
        const note = document.createElement('div');
        note.className = 'note';
        note.textContent = item.note;
        meta.appendChild(note);
      }
      row.appendChild(meta);

      const tick = document.createElement('div');
      tick.className = 'tick';
      tick.textContent = '✓';
      row.appendChild(tick);

      rows.appendChild(row);
      return row;
    });
    el.appendChild(rows);

    return {
      el,
      update(local) {
        animateWords(words, local, { delay: 0, step: 0.05 });
        items.forEach((row, i) => {
          const p = ease.outQuint(stagger(local, i, { delay: 0.34, step: 0.16, dur: 0.6 }));
          row.style.opacity = clamp01(p * 1.4);
          row.style.transform = `translate3d(${(1 - p) * 90}px, 0, 0) scale(${lerp(0.96, 1, p)})`;
        });
      },
    };
  },

  /* Numbered how-it-works steps. */
  steps(def, ctx) {
    const el = document.createElement('div');
    el.className = 'scene scene-steps';

    const title = document.createElement('div');
    title.className = 'title is-tiny';
    const words = buildWords(title, def.title || '');
    el.appendChild(title);

    const list = document.createElement('div');
    list.className = 'steps';
    const items = (def.items || []).map((item, i) => {
      const step = document.createElement('div');
      step.className = 'step';
      const num = document.createElement('div');
      num.className = 'num';
      num.textContent = `${i + 1}`;
      const body = document.createElement('div');
      body.className = 'body';
      const head = document.createElement('div');
      head.className = 'head';
      head.textContent = item.head || '';
      body.appendChild(head);
      if (item.desc) {
        const desc = document.createElement('div');
        desc.className = 'desc';
        desc.textContent = item.desc;
        body.appendChild(desc);
      }
      step.appendChild(num);
      step.appendChild(body);
      list.appendChild(step);
      return step;
    });
    el.appendChild(list);

    return {
      el,
      update(local) {
        animateWords(words, local, { step: 0.05 });
        items.forEach((step, i) => {
          const p = ease.outQuint(stagger(local, i, { delay: 0.32, step: 0.3, dur: 0.65 }));
          step.style.opacity = clamp01(p * 1.5);
          step.style.transform = `translate3d(0, ${(1 - p) * 56}px, 0)`;
        });
      },
    };
  },

  /* Messenger dialogue — the format that sells this service best. */
  chat(def, ctx) {
    const el = document.createElement('div');
    el.className = 'scene scene-chat';

    let words = [];
    if (def.title) {
      const title = document.createElement('div');
      title.className = 'title is-tiny';
      words = buildWords(title, def.title);
      el.appendChild(title);
    }

    const chat = document.createElement('div');
    chat.className = 'chat';
    const bubbles = (def.messages || []).map((m) => {
      const b = document.createElement('div');
      b.className = `bubble ${m.from === 'me' ? 'me' : 'them'}`;
      b.textContent = m.text || '';
      if (m.small) {
        const s = document.createElement('span');
        s.className = 'small';
        s.textContent = m.small;
        b.appendChild(s);
      }
      chat.appendChild(b);
      return b;
    });
    el.appendChild(chat);

    const step = def.step || 0.62;
    return {
      el,
      update(local) {
        if (words.length) animateWords(words, local, { step: 0.05 });
        bubbles.forEach((b, i) => {
          const p = ease.outBack(stagger(local, i, { delay: def.title ? 0.4 : 0.15, step, dur: 0.42 }));
          const side = b.classList.contains('me') ? 1 : -1;
          b.style.opacity = clamp01(p * 2);
          b.style.transform = `translate3d(${(1 - p) * 40 * side}px, ${(1 - p) * 22}px, 0) scale(${lerp(0.9, 1, p)})`;
        });
      },
    };
  },

  /* Before / after pair. */
  beforeAfter(def, ctx) {
    const el = document.createElement('div');
    el.className = 'scene scene-pair';

    let words = [];
    if (def.title) {
      const title = document.createElement('div');
      title.className = 'title is-tiny';
      words = buildWords(title, def.title);
      el.appendChild(title);
    }

    const pair = document.createElement('div');
    pair.className = 'pair';
    const panes = [
      { data: def.before, cls: 'bad' },
      { data: def.after, cls: 'good' },
    ].map(({ data, cls }) => {
      const pane = document.createElement('div');
      pane.className = `pane ${cls}`;
      const tag = document.createElement('div');
      tag.className = 'tag';
      tag.textContent = data.tag || '';
      const line = document.createElement('div');
      line.className = 'line';
      line.textContent = data.line || '';
      pane.appendChild(tag);
      pane.appendChild(line);
      if (data.hint) {
        const hint = document.createElement('div');
        hint.className = 'hint';
        hint.textContent = data.hint;
        pane.appendChild(hint);
      }
      pair.appendChild(pane);
      return pane;
    });
    el.appendChild(pair);

    return {
      el,
      update(local) {
        if (words.length) animateWords(words, local, { step: 0.05 });
        panes.forEach((pane, i) => {
          const p = ease.outQuint(stagger(local, i, { delay: 0.3, step: 0.55, dur: 0.6 }));
          pane.style.opacity = clamp01(p * 1.5);
          pane.style.transform = `translate3d(0, ${(1 - p) * 60}px, 0) scale(${lerp(0.95, 1, p)})`;
        });
      },
    };
  },

  /* Closing card. */
  cta(def, ctx) {
    const el = document.createElement('div');
    el.className = 'scene cta';

    const lockup = document.createElement('div');
    lockup.className = 'lockup';
    lockup.innerHTML =
      `<span class="just">${ctx.brand.prefix || 'Just'}</span>` +
      `<span>${ctx.brand.name || 'PlataPay'}</span>` +
      `<span class="dot"></span>`;
    el.appendChild(lockup);

    const title = document.createElement('div');
    title.className = 'title is-small';
    const words = buildWords(title, def.title || '');
    el.appendChild(title);

    let sub = null;
    if (def.sub) {
      sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = def.sub;
      el.appendChild(sub);
    }

    const handle = document.createElement('div');
    handle.className = 'handle';
    handle.textContent = def.handle || ctx.brand.handle || '';
    el.appendChild(handle);

    return {
      el,
      update(local) {
        const lp = ease.outBack(clamp01(local / 0.55));
        lockup.style.opacity = clamp01(local / 0.3);
        lockup.style.transform = `scale(${lerp(0.86, 1, lp)})`;
        animateWords(words, local, { delay: 0.22, step: 0.05 });
        if (sub) {
          const p = ease.outCubic(clamp01((local - 0.6) / 0.5));
          sub.style.opacity = p;
          sub.style.transform = `translate3d(0, ${(1 - p) * 20}px, 0)`;
        }
        // gentle breathing pulse so the last frames never look frozen
        const hp = ease.outBack(clamp01((local - 0.8) / 0.55));
        const pulse = 1 + 0.018 * Math.sin(Math.max(local - 1.2, 0) * 3.4);
        handle.style.opacity = clamp01((local - 0.8) / 0.3);
        handle.style.transform = `scale(${lerp(0.8, 1, hp) * pulse})`;
      },
    };
  },
};

/* ------------------------------------------------------------------ build */

class Reel {
  constructor(stage, catalog) {
    this.stage = stage;
    this.catalog = catalog;
    this.byId = new Map(catalog.map((e) => [e.id.toLowerCase(), e]));
    this.root = stage.dataset.root || '../../';
    this.duration = 0;
  }

  logo(id) {
    if (!id) return null;
    const hit = this.byId.get(String(id).toLowerCase());
    if (!hit) console.warn('[reel] unknown logo:', id);
    return hit || null;
  }

  /** Resolve a logo list: explicit ids, or a deterministic slice of the catalogue. */
  pick(ids, count) {
    let pool = [];
    if (Array.isArray(ids) && ids.length) {
      pool = ids.map((id) => this.logo(id)).filter(Boolean);
    } else {
      pool = this.catalog.slice();
      // deterministic shuffle so reruns produce byte-identical frames
      let seed = 20260918;
      for (let i = pool.length - 1; i > 0; i--) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const j = seed % (i + 1);
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
    }
    if (!pool.length) return [];
    const out = [];
    for (let i = 0; i < count; i++) out.push(pool[i % pool.length]);
    return out;
  }

  load(project) {
    this.project = project;
    this.brand = project.brand || {};
    const theme = project.theme || {};
    for (const [key, value] of Object.entries(theme)) {
      this.stage.style.setProperty(`--${key}`, value);
    }

    this.stage.innerHTML = '';

    const glow = document.createElement('div');
    glow.className = 'bg-glow';
    const grid = document.createElement('div');
    grid.className = 'bg-grid';
    const vignette = document.createElement('div');
    vignette.className = 'bg-vignette';
    const grain = document.createElement('div');
    grain.className = 'bg-grain';
    this.stage.append(glow, grid, vignette, grain);
    this.backdrop = { glow, grid };

    const ctx = {
      root: this.root,
      brand: this.brand,
      logo: (id) => this.logo(id),
      pick: (ids, n) => this.pick(ids, n),
    };

    let at = 0;
    const list = project.scenes || [];
    this.timeline = list.map((def, i) => {
      const factory = scenes[def.type];
      if (!factory) throw new Error(`unknown scene type: ${def.type}`);
      const built = factory(def, ctx);
      this.stage.appendChild(built.el);
      const entry = {
        def,
        built,
        start: at,
        dur: def.duration || 3,
        // Reels loop: fading the first scene in from nothing and the last one
        // out to nothing would put half a second of blank between repeats, so
        // the ends of the reel hold and only the cuts inside it cross-fade.
        fadeIn: def.fadeIn ?? (i === 0 ? 0 : 0.3),
        fadeOut: def.fadeOut ?? (i === list.length - 1 ? 0 : 0.28),
      };
      at += entry.dur;
      return entry;
    });
    this.duration = at;

    if (project.progressBar) {
      this.progress = document.createElement('div');
      this.progress.className = 'progress';
      this.stage.appendChild(this.progress);
    }

    this.seek(0);
    return this;
  }

  seek(t) {
    const time = Math.max(0, Math.min(t, this.duration));

    // slow global drift keeps the backdrop alive between cuts
    const d = time / Math.max(this.duration, 1);
    this.backdrop.glow.style.transform =
      `translate3d(${Math.sin(time * 0.35) * 46}px, ${Math.cos(time * 0.28) * 40}px, 0) scale(${1.04 + d * 0.06})`;
    this.backdrop.grid.style.transform = `translate3d(0, ${-time * 9}px, 0)`;

    for (const s of this.timeline) {
      const local = time - s.start;
      const live = local >= -0.001 && local <= s.dur + 0.001;
      s.built.el.classList.toggle('is-live', live);
      if (!live) {
        s.built.el.style.opacity = '0';
        continue;
      }
      const fin = s.fadeIn > 0 ? ease.outCubic(clamp01(local / s.fadeIn)) : 1;
      const fout = s.fadeOut > 0 ? ease.inOutCubic(clamp01((s.dur - local) / s.fadeOut)) : 1;
      const k = Math.min(fin, fout);
      s.built.el.style.opacity = k;
      s.built.el.style.transform = `scale(${lerp(1.035, 1, fin) * lerp(0.985, 1, fout)})`;
      s.built.update(local, s.dur);
    }

    if (this.progress) this.progress.style.width = `${d * STAGE_W}px`;
  }
}

async function boot() {
  const stage = document.getElementById('stage');
  const catalog = await fetch('./catalog.json').then((r) => r.json());
  const reel = new Reel(stage, catalog);

  const params = new URLSearchParams(location.search);
  const name = params.get('project') || 'services-100';
  const [brand, project] = await Promise.all([
    fetch('../brand.json').then((r) => r.json()),
    fetch(`../projects/${name}.json`).then((r) => r.json()),
  ]);
  // brand.json holds the shared identity; a project may override any of it
  project.brand = { ...brand, ...(project.brand || {}) };
  project.theme = { ...(brand.theme || {}), ...(project.theme || {}) };
  reel.load(project);

  await document.fonts.ready;
  // decode every logo up front so no frame is ever captured mid-load
  await Promise.all(
    Array.from(stage.querySelectorAll('div')).map((el) => {
      const url = /url\("(.+?)"\)/.exec(el.style.backgroundImage || '');
      if (!url) return null;
      const img = new Image();
      img.src = url[1];
      return img.decode().catch(() => {});
    })
  );

  window.REEL = {
    seek: (t) => reel.seek(t),
    duration: reel.duration,
    fps: project.fps || 30,
    project,
    stage,
  };
  document.body.dataset.ready = '1';
}

boot().catch((err) => {
  document.body.dataset.error = String(err && err.message ? err.message : err);
  console.error(err);
});
