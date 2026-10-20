import { ensureContext, currentContext, Mic, onContextState, setAudioSessionType, log } from '../web/audio.ts';
import { SpectrumView } from '../web/spectrum-view.ts';
import { el, $ } from '../web/ui.ts';
import { DEFAULT_CONFIG, PROFILES, describe, profileByName } from '../modem/profiles.ts';
import type { Content } from '../protocol/content.ts';
import { planSend, Transmission, type SendPlan } from './sender.ts';
import { RxSession } from './session.ts';

/**
 * End-user app: Send and Receive tabs over the modem and protocol layers. Half-duplex by design:
 * transmitting releases the microphone first (a held mic track makes iOS route output to the
 * quiet earpiece), and listening never plays anything.
 */

const PREFS_KEY = 'beep-app-prefs-v1';
const MSGID_KEY = 'beep-app-msgid-v1';

interface Prefs {
  profile: string;
  repairPct: number;
  carousel: boolean;
  levelDb: number;
}

function load<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(key);
    return s ? { ...fallback, ...JSON.parse(s) } : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode / storage blocked: preferences just are not remembered */
  }
}

const prefs: Prefs = load(PREFS_KEY, { profile: 'balanced', repairPct: 25, carousel: false, levelDb: -6 });

/**
 * Message ids are a 7-bit counter (the protocol's fragment id width). Starting from a random value
 * and persisting it makes two devices — or two page loads — unlikely to reuse an id while a
 * receiver still holds fragments of the earlier message.
 */
function nextMessageId(): number {
  const st = load<{ id: number }>(MSGID_KEY, { id: Math.floor(Math.random() * 128) });
  const id = (st.id + 1) & 127;
  store(MSGID_KEY, { id });
  return id;
}

const fmtTime = (s: number) => {
  if (!Number.isFinite(s)) return '—';
  const t = Math.max(0, Math.round(s));
  return t >= 60 ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` : `${t} s`;
};

// ---------------------------------------------------------------- audio state

let mic: Mic | null = null;
let session: RxSession | null = null;
let tx: Transmission | null = null;
let wakeLock: { release(): Promise<void> } | null = null;

async function keepAwake(on: boolean): Promise<void> {
  const nav = navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } };
  try {
    if (on && !wakeLock && nav.wakeLock) wakeLock = await nav.wakeLock.request('screen');
    if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    /* not supported or refused: the screen may sleep, which suspends audio on phones */
  }
}

// ---------------------------------------------------------------- tabs

function showTab(name: string): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const p of document.querySelectorAll<HTMLElement>('[data-panel]')) p.classList.toggle('hidden', p.dataset.panel !== name);
}

// ---------------------------------------------------------------- send

function sendPanel(): HTMLElement {
  const text = el('textarea', { placeholder: 'Type a message…', maxlength: 20000 });
  const file = el('input', { type: 'file' });
  const fileInfo = el('div', { class: 'hint' });
  let fileContent: { name: string; data: Uint8Array } | null = null;
  const modeText = el('input', { type: 'radio', name: 'mode', value: 'text', checked: true });
  const modeFile = el('input', { type: 'radio', name: 'mode', value: 'file' });
  const textBox = el('div', {}, text);
  const fileBox = el('div', { class: 'hidden' }, file, fileInfo);
  const setMode = () => {
    textBox.classList.toggle('hidden', !modeText.checked);
    fileBox.classList.toggle('hidden', modeText.checked);
    update();
  };
  modeText.addEventListener('change', setMode);
  modeFile.addEventListener('change', setMode);
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) {
      fileContent = null;
      fileInfo.textContent = '';
    } else {
      fileContent = { name: f.name.replace(/[\u0000-\u001f\u007f]/g, '_').slice(0, 120), data: new Uint8Array(await f.arrayBuffer()) };
      fileInfo.textContent = `${f.name} — ${f.size} bytes`;
    }
    update();
  });

  const d = describe(DEFAULT_CONFIG);
  const profSel = el('select', {}, ...PROFILES.map((p) => {
    const info = d.profiles.find((x) => x.name === p.name)!;
    return el('option', { value: p.name, selected: p.name === prefs.profile }, `${p.name} — ${info.netBps.toFixed(0)} b/s`);
  }));
  const profHint = el('div', { class: 'hint' });
  const repair = el('input', { type: 'number', min: 0, max: 300, step: 5, value: prefs.repairPct, style: 'width:5em' });
  const carousel = el('input', { type: 'checkbox', checked: prefs.carousel });
  const level = el('input', { type: 'range', min: -30, max: 0, step: 1, value: prefs.levelDb });
  const levelLbl = el('span', {});
  const levelWarn = el('div', { class: 'hint warn hidden' }, 'Above −1 dBFS the speaker may clip: distortion becomes audible and can leak below 17 kHz.');
  const est = el('div', { class: 'stats' });
  const btn = el('button', { class: 'big tx' }, 'Transmit');
  const status = el('div', { class: 'status' });
  const prog = el('div', { class: 'progress' }, el('div'));
  const spec = el('canvas', { class: 'spec' });
  const sgram = el('canvas', { class: 'sgram' });
  const view = new SpectrumView(spec, sgram);

  const content = (): Content | null => {
    if (modeText.checked) return text.value.length ? { kind: 'text', text: text.value } : null;
    return fileContent ? { kind: 'file', name: fileContent.name, data: fileContent.data } : null;
  };

  let plan: SendPlan | null = null;
  let timer = 0;
  const update = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      prefs.profile = profSel.value;
      prefs.repairPct = Math.max(0, Number(repair.value) || 0);
      prefs.carousel = carousel.checked;
      prefs.levelDb = Number(level.value);
      store(PREFS_KEY, prefs);
      levelLbl.textContent = `${prefs.levelDb} dBFS`;
      levelWarn.classList.toggle('hidden', prefs.levelDb <= -1);
      const p = profileByName(DEFAULT_CONFIG, profSel.value);
      const info = d.profiles.find((x) => x.name === p.name)!;
      profHint.textContent = {
        'long-range': 'Most robust: works furthest and in echoey rooms, but slow. Hold both devices still.',
        balanced: 'Good range at moderate speed. A sensible default.',
        fast: 'Shortest air time; needs the devices close together (≈ a metre or less).',
      }[p.name] ?? '';
      const c = content();
      if (!c) {
        plan = null;
        est.replaceChildren(stat('—', 'nothing to send'), stat(`${info.symbolSec * 1000 | 0} ms`, `symbol (SF${p.sf})`));
        return;
      }
      plan = planSend(c, p, 0, prefs.repairPct / 100);
      const bytes = c.kind === 'text' ? new TextEncoder().encode(c.text).length : c.data.length;
      est.replaceChildren(
        stat(`${bytes} B`, c.kind === 'text' ? `UTF-8 → ${Math.ceil(plan.contentBits / 8)} B coded` : 'file'),
        stat(String(plan.payloads.length), plan.fragmented ? `packets (k=${plan.k} + ${plan.payloads.length - plan.k} repair)` : 'packet'),
        stat(fmtTime(plan.airSec), prefs.carousel ? 'per round (repeats)' : 'air time'),
        stat(`${plan.netBps.toFixed(0)} b/s`, 'net modem rate'),
      );
      if (plan.airSec > 600) est.append(el('div', { class: 'hint warn' }, 'This will take over 10 minutes on air. Consider the fast profile with the devices close together.'));
    }, 120);
  };
  for (const i of [text, repair, carousel, level, profSel]) i.addEventListener('input', update);
  profSel.addEventListener('change', update);

  let raf = 0;
  const pumpSpectrum = () => {
    if (!tx) return;
    const buf = new Float32Array(tx.analyser.fftSize);
    tx.analyser.getFloatTimeDomainData(buf);
    view.push(buf, tx.ctx.sampleRate);
    const now = tx.ctx.currentTime;
    const cur = tx.scheduled.findIndex((s) => now >= s.start && now < s.end);
    const total = tx.plan.payloads.length;
    // packets are rendered just in time, so the end is estimated from the plan's air time
    const t0 = tx.scheduled[0]?.start ?? now;
    const left = prefs.carousel ? NaN : t0 + tx.plan.airSec - now;
    const doneFrac = prefs.carousel ? ((now - t0) % 10) / 10 : Math.min(1, Math.max(0, 1 - left / Math.max(1e-3, tx.plan.airSec)));
    (prog.firstElementChild as HTMLElement).style.width = `${Math.round(100 * doneFrac)}%`;
    const idx = cur >= 0 ? tx.scheduled[cur] : null;
    status.textContent = idx
      ? `Sending packet ${idx.index + 1}${prefs.carousel ? '' : ` of ${total}`}${idx.repair ? (tx.plan.fragmented ? ' (repair)' : ' (repeat)') : ''}${prefs.carousel ? ' — repeating until Stop' : ` · ${fmtTime(left)} left`}`
      : 'Starting…';
    raf = requestAnimationFrame(pumpSpectrum);
  };

  btn.addEventListener('click', async () => {
    if (tx) {
      tx.stop();
      return;
    }
    const c = content();
    if (!c) {
      status.textContent = 'Type a message or pick a file first.';
      return;
    }
    status.classList.remove('error');
    try {
      const ctx = await ensureContext();
      // half-duplex: never hold the mic while playing
      stopListening();
      setAudioSessionType('playback');
      const p = profileByName(DEFAULT_CONFIG, profSel.value);
      const sendPlan = planSend(c, p, nextMessageId(), prefs.repairPct / 100);
      tx = new Transmission(ctx, sendPlan, { levelDb: prefs.levelDb, carousel: prefs.carousel });
      btn.textContent = 'Stop';
      btn.classList.add('stop');
      view.resetPeak();
      view.start();
      raf = requestAnimationFrame(pumpSpectrum);
      void keepAwake(true);
      log(`transmit message #${sendPlan.options.id}: ${sendPlan.payloads.length} packets, ${sendPlan.profile.name}`);
      await tx.run();
      status.textContent = `Sent ${tx.sent} packet${tx.sent === 1 ? '' : 's'}.`;
    } catch (e) {
      status.textContent = (e as Error).message;
      status.classList.add('error');
    } finally {
      cancelAnimationFrame(raf);
      view.stop();
      tx = null;
      btn.textContent = 'Transmit';
      btn.classList.remove('stop');
      (prog.firstElementChild as HTMLElement).style.width = '0';
      void keepAwake(false);
    }
  });

  update();
  return el('section', { 'data-panel': 'send' },
    el('div', { class: 'card' },
      el('div', { class: 'row' }, el('label', {}, modeText, 'Text'), el('label', {}, modeFile, 'File')),
      textBox,
      fileBox,
    ),
    el('div', { class: 'card' },
      el('div', { class: 'row' }, el('label', {}, 'Profile', profSel)),
      profHint,
      el('div', { class: 'row' },
        el('label', { title: 'Extra erasure-coded fragments: any k of the packets rebuild the message, so receivers that miss some still finish.' }, 'Extra repair', repair, '%'),
        el('label', { title: 'Keep sending fresh repair fragments (or repeats) until you press Stop — for receivers that join late.' }, carousel, 'Keep repeating'),
      ),
      el('div', { class: 'row' }, el('label', { style: 'flex:1' }, 'Level', level), levelLbl),
      levelWarn,
      est,
    ),
    btn,
    prog,
    status,
    el('div', { class: 'card' }, el('h3', {}, 'Transmit spectrum (16–19 kHz)'), spec, sgram),
  );
}

function stat(value: string, label: string): HTMLElement {
  return el('div', { class: 'stat' }, el('b', {}, value), el('span', {}, label));
}

// ---------------------------------------------------------------- receive

let stopListening: () => void = () => undefined;

function receivePanel(): HTMLElement {
  const btn = el('button', { class: 'big' }, 'Listen');
  const status = el('div', { class: 'status' });
  const device = el('div', { class: 'hint' });
  const pill = el('span', { class: 'state-pill state-search' }, 'idle');
  const meter = el('div', { class: 'meter' }, el('div'));
  const meterLbl = el('span', { class: 'hint' });
  const prog = el('div', { class: 'progress' }, el('div'));
  const progLbl = el('div', { class: 'hint' });
  const stats = el('div', { class: 'stats' });
  const partials = el('div');
  const messages = el('div');
  const packets = el('div');
  const spec = el('canvas', { class: 'spec' });
  const sgram = el('canvas', { class: 'sgram' });
  const view = new SpectrumView(spec, sgram);
  let dirty = false;
  let raf = 0;

  const render = () => {
    raf = requestAnimationFrame(render);
    const s = session;
    if (!s) return;
    const st = s.state;
    const labels = { search: 'listening', sync: 'preamble found — syncing', header: 'reading header', payload: 'receiving packet' };
    pill.textContent = labels[st];
    pill.className = `state-pill state-${st}`;
    // meter: detection statistic from −15 dB (noise) to +15 dB over threshold
    const m = Math.min(1, Math.max(0, (s.signalDb + 15) / 30));
    (meter.firstElementChild as HTMLElement).style.width = `${Math.round(100 * m)}%`;
    meterLbl.textContent = Number.isFinite(s.signalDb) ? `preamble statistic ${s.signalDb >= 0 ? '+' : ''}${s.signalDb.toFixed(1)} dB vs threshold` : 'input is silent (mic muted or interrupted?)';
    const p = s.progress;
    (prog.firstElementChild as HTMLElement).style.width = p ? `${Math.round(100 * p.fraction)}%` : '0';
    progLbl.textContent = p ? `${p.profile}, ${p.length} B — ${Math.round(100 * p.fraction)}%` : '';
    if (!dirty) return;
    dirty = false;
    const c = s.counters;
    stats.replaceChildren(stat(String(c.packetsOk), 'packets ok'), stat(String(c.packetsFailed), 'failed (CRC)'), stat(String(c.detections), 'detections'), stat(String(c.headerFails + c.syncFails), 'sync/header fails'), stat(String(c.duplicates), 'repeats'));
    partials.replaceChildren(...[...s.partials.values()].map((q) =>
      el('div', { class: 'msg' },
        el('div', {}, `Message #${q.id}: ${q.rank} of ${q.k} fragments`),
        el('div', { class: 'progress' }, el('div', { style: `width:${Math.round((100 * q.rank) / q.k)}%` })),
        el('div', { class: 'meta' }, `${q.received} received, ${q.duplicates} duplicates — any ${q.k - q.rank} more will complete it`),
      )));
    messages.replaceChildren(...s.messages.map((msg) => messageCard(msg.content, `#${msg.id} · ${msg.at.toLocaleTimeString()}${msg.k > 1 ? ` · ${msg.fragments} fragments (k=${msg.k})` : ''}`)));
    if (!s.messages.length) messages.append(el('p', { class: 'hint' }, 'Nothing received yet.'));
    packets.replaceChildren(...s.packets.slice(0, 50).map((pk) => {
      const dg = pk.diag;
      return el('div', { class: `pkt${pk.ok ? '' : ' fail'}` },
        `${pk.ok ? '✓' : '✗'} t=${pk.time.toFixed(1)} s · ${dg.profile} · ${dg.length} B · SNR ${dg.snrDb.toFixed(1)} dB · CFO ${dg.cfoHz.toFixed(1)} Hz · ${dg.velocity.toFixed(2)} m/s · FEC fixed ${dg.correctedBits}/${dg.codedBits} bits · ${pk.note}`);
    }));
  };

  const start = async () => {
    status.classList.remove('error');
    tx?.stop();
    setAudioSessionType('play-and-record');
    mic = await Mic.acquire();
    const fs = mic.ctx.sampleRate;
    session = new RxSession(fs);
    session.onEvent = () => (dirty = true);
    const st = mic.settings();
    const raw = (k: 'echoCancellation' | 'noiseSuppression' | 'autoGainControl') => (st[k] === false ? 'off' : st[k] === true ? 'ON' : '?');
    device.textContent = `${fs} Hz · echo cancellation ${raw('echoCancellation')} · noise suppression ${raw('noiseSuppression')} · auto gain ${raw('autoGainControl')} (as reported by the browser; the bench verifies acoustically)`;
    mic.onData((c) => {
      session?.push(c.samples);
      view.push(c.samples, fs);
    });
    view.start();
    raf = requestAnimationFrame(render);
    dirty = true;
    btn.textContent = 'Stop listening';
    btn.classList.add('stop');
    status.textContent = 'Listening — every profile is recognised automatically.';
    void keepAwake(true);
  };

  stopListening = () => {
    if (!mic) return;
    mic.release();
    mic = null;
    view.stop();
    cancelAnimationFrame(raf);
    btn.textContent = 'Listen';
    btn.classList.remove('stop');
    pill.textContent = 'idle';
    pill.className = 'state-pill state-search';
    status.textContent = 'Stopped. Received messages are kept below.';
    void keepAwake(false);
  };

  btn.addEventListener('click', async () => {
    if (mic) {
      stopListening();
      return;
    }
    btn.disabled = true;
    try {
      await start();
    } catch (e) {
      status.textContent = `Microphone unavailable: ${(e as Error).message}`;
      status.classList.add('error');
    } finally {
      btn.disabled = false;
    }
  });

  return el('section', { 'data-panel': 'receive', class: 'hidden' },
    btn,
    status,
    device,
    el('div', { class: 'card' },
      el('div', { class: 'row' }, pill),
      meter,
      meterLbl,
      prog,
      progLbl,
      stats,
    ),
    el('div', { class: 'card' }, el('h3', {}, 'Messages'), partials, messages),
    el('div', { class: 'card' }, el('h3', {}, 'Band spectrum (16–19 kHz)'), spec, sgram),
    el('details', { class: 'card' }, el('summary', {}, 'Packet diagnostics'), packets),
  );
}

function messageCard(c: Content, meta: string): HTMLElement {
  if (c.kind === 'text') {
    const copy = el('button', { class: 'secondary' }, 'Copy');
    copy.addEventListener('click', () => void navigator.clipboard?.writeText(c.text).catch(() => undefined));
    return el('div', { class: 'msg' }, el('div', { class: 'text' }, c.text), el('div', { class: 'row' }, el('span', { class: 'meta' }, meta), copy));
  }
  const name = c.kind === 'file' ? c.name : 'data.bin';
  const save = el('button', {}, `Save ${name}`);
  save.addEventListener('click', () => void saveBytes(name, c.data));
  const preview = c.kind === 'bytes' ? el('div', { class: 'meta' }, Array.from(c.data.slice(0, 32), (b) => b.toString(16).padStart(2, '0')).join(' ') + (c.data.length > 32 ? ' …' : '')) : null;
  return el('div', { class: 'msg' }, el('div', { class: 'text' }, `${name} — ${c.data.length} bytes`), preview, el('div', { class: 'row' }, el('span', { class: 'meta' }, meta), save));
}

/** Share sheet where it can take files (iOS: Files/AirDrop), otherwise a download link. */
async function saveBytes(name: string, data: Uint8Array): Promise<void> {
  const blob = new Blob([data.slice().buffer as ArrayBuffer], { type: 'application/octet-stream' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  try {
    const f = new File([blob], name, { type: blob.type });
    if (nav.canShare?.({ files: [f] })) {
      await nav.share({ files: [f], title: name });
      return;
    }
  } catch {
    /* cancelled or not allowed: fall back to a download */
  }
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------------------------------------------------------------- help

function helpPanel(): HTMLElement {
  const d = describe(DEFAULT_CONFIG);
  return el('section', { 'data-panel': 'help', class: 'hidden' },
    el('div', { class: 'card' },
      el('h2', {}, 'How to use'),
      el('ol', {},
        el('li', {}, 'On the receiving device open Receive and tap Listen (allow the microphone).'),
        el('li', {}, 'On the sending device type a message or pick a file, choose a profile and tap Transmit.'),
        el('li', {}, 'Point the sender’s speaker towards the receiver and keep both still until it finishes.'),
      ),
      el('p', { class: 'hint' }, 'Any number of devices can listen at once. Fragmented messages are erasure-coded: a receiver needs any k packets, so it can miss some or join late (use “Keep repeating”).'),
    ),
    el('div', { class: 'card' },
      el('h2', {}, 'Troubleshooting'),
      el('ul', { class: 'notes' },
        el('li', {}, 'Turn the sender’s volume up. On iPhone, also flip the silent switch off: Safari may mute web audio with it on.'),
        el('li', {}, 'Nothing detected? Move closer, avoid covering the speaker or mic, and try the long-range profile.'),
        el('li', {}, 'Packets “failed (CRC)” means a packet was heard but damaged; it is never shown. Hold still: motion smears the high frequencies.'),
        el('li', {}, 'Keep this page in the foreground with the screen on; phones suspend audio in the background. If a banner says audio is paused, tap it.'),
        el('li', {}, 'Bluetooth speakers and headphones usually cut everything above ~16 kHz. Use the built-in speaker.'),
        el('li', {}, 'The signal sits at 17.1–18.4 kHz: inaudible to most adults, but children, teenagers and pets may hear it.'),
      ),
    ),
    el('div', { class: 'card' },
      el('h2', {}, 'Profiles'),
      el('table', {},
        el('tr', {}, el('th', {}, 'profile'), el('th', {}, 'symbol'), el('th', {}, 'net rate')),
        ...d.profiles.map((p) => el('tr', {}, el('td', {}, p.name), el('td', {}, `SF${p.sf}, ${(p.symbolSec * 1000).toFixed(0)} ms, code ${p.rate}`), el('td', {}, `${p.netBps.toFixed(0)} b/s`))),
      ),
      el('p', { class: 'hint' }, `Every packet starts with a ${d.preambleSec.toFixed(1)} s preamble and a short header, both in the most robust mode, so receivers need no settings.`),
      el('p', { class: 'hint' }, el('a', { href: '../bench/' }, 'Acoustic bench'), ' — measure your devices and room.'),
    ),
  );
}

// ---------------------------------------------------------------- boot

function boot(): void {
  const root = $('#root');
  root.replaceChildren(sendPanel(), receivePanel(), helpPanel());
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab!));
  const banner = $('#banner');
  // A suspended/interrupted context (backgrounding, a call, iOS audio interruptions) needs a tap.
  onContextState((s) => banner.classList.toggle('hidden', s === 'running' || s === 'closed'));
  banner.addEventListener('click', async () => {
    await currentContext()?.resume();
    banner.classList.toggle('hidden', currentContext()?.state === 'running');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wakeLock === null && (mic || tx)) void keepAwake(true);
  });
}

boot();
