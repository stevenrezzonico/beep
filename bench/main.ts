import { ensureContext, currentContext, Mic, play, onContextState, onLog, audioLog, setAudioSessionType, audioSessionSupported, log } from '../web/audio.ts';
import { collectDeviceInfo, type DeviceRecord } from '../web/device-info.ts';
import { SpectrumView } from '../web/spectrum-view.ts';
import { linePlot, type Series } from '../web/plot.ts';
import { shareOrDownload, copyText, downloadJson, download } from '../web/export.ts';
import { el, $, action, kvTable, rowsTable, sleep } from '../web/ui.ts';
import { probeMicApi, type MicApiReport, type MicApiVariant } from './mic-api.ts';
import { aecSignal, analyzeAec, aecLayout, remoteMicSignal, analyzeRemoteMic, remoteMicLayout, micVerdict, type AecResult, type RemoteMicResult, type MicVerdict } from './tests/miccheck.ts';
import { freqRespSignal, analyzeFreqResp, freqRespLayout, type FreqRespResult } from './tests/freqresp.ts';
import { echoSignal, analyzeEcho, echoLayout, type EchoResult, type MeasuredIr } from './tests/echo.ts';
import { distanceSignal, analyzeDistance, distanceLayout, fitDistance, distanceCsv, type DistanceRow } from './tests/distance.ts';
import { dopplerSignal, analyzeDoppler, dopplerLayout, type DopplerResult } from './tests/doppler.ts';
import { audibilitySignal, leakage, imdRecordSignal, analyzeImd, AUDIBILITY_DEFAULTS, type AudibilityCase, type LeakageReport, type ImdResult } from './tests/audibility.ts';
import { berModem, BER_DEFAULTS, type BerResult } from './tests/ber.ts';
import type { Verdict } from './tests/common.ts';

// ---------------------------------------------------------------- state

interface Results {
  version: 1;
  device: DeviceRecord | null;
  micApi: MicApiReport[];
  aec: AecResult[];
  micRemote: RemoteMicResult[];
  verdict: MicVerdict | null;
  freqresp: FreqRespResult[];
  echo: EchoResult[];
  irs: MeasuredIr[];
  distance: DistanceRow[];
  doppler: DopplerResult[];
  audibility: { leakage: LeakageReport[]; imd: ImdResult[] };
  ber: (BerResult & { distanceM?: number })[];
}

const STORE_KEY = 'beep-bench-results-v1';
const SETTINGS_KEY = 'beep-bench-settings-v1';

function emptyResults(): Results {
  return { version: 1, device: null, micApi: [], aec: [], micRemote: [], verdict: null, freqresp: [], echo: [], irs: [], distance: [], doppler: [], audibility: { leakage: [], imd: [] }, ber: [] };
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(key);
    return s ? { ...fallback, ...JSON.parse(s) } : fallback;
  } catch {
    return fallback;
  }
}

const results: Results = loadJson(STORE_KEY, emptyResults());

function save(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(results));
  } catch {
    /* storage unavailable or full: results stay in memory, export still works */
  }
}

interface Settings {
  label: string;
  gainDb: number;
  /** Seconds the receiver waits for the operator to press Play on the other device. */
  startWindow: number;
  variant: MicApiVariant;
  /** 'switch' = playback for TX, play-and-record for RX (where navigator.audioSession exists). */
  sessionPolicy: 'switch' | 'leave';
}

const settings: Settings = loadJson(SETTINGS_KEY, {
  label: '',
  gainDb: -6,
  startWindow: 8,
  variant: { audioSession: 'unset', order: 'context-first', explicitVideoFalse: false },
  sessionPolicy: 'switch',
});

function saveSettings(): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- audio plumbing

let mic: Mic | null = null;
let live: SpectrumView | null = null;
let liveOff: (() => void) | null = null;

async function getMic(): Promise<Mic> {
  if (mic?.active) return mic;
  if (settings.sessionPolicy === 'switch') setAudioSessionType('play-and-record');
  else if (settings.variant.audioSession !== 'unset') setAudioSessionType(settings.variant.audioSession);
  mic = await Mic.acquire({ order: settings.variant.order, explicitVideoFalse: settings.variant.explicitVideoFalse });
  updateDevice();
  return mic;
}

function releaseMic(): void {
  stopLive();
  mic?.release();
  mic = null;
}

/** Half-duplex transmit: no mic track may be held while we play (iOS earpiece routing). */
async function transmit(x: Float32Array): Promise<void> {
  releaseMic();
  if (settings.sessionPolicy === 'switch') setAudioSessionType('playback');
  const pb = await play(x, { gainDb: settings.gainDb });
  await pb.ended;
}

function startLive(canvasSpec: HTMLCanvasElement, canvasSg: HTMLCanvasElement): Promise<void> {
  return getMic().then((m) => {
    live ??= new SpectrumView(canvasSpec, canvasSg);
    liveOff?.();
    liveOff = m.onData((c) => live!.push(c.samples, m.ctx.sampleRate));
    live.start();
  });
}

function stopLive(): void {
  liveOff?.();
  liveOff = null;
  live?.stop();
  const b = document.getElementById('live-btn');
  if (b) b.textContent = 'Start live view';
}

async function fs(): Promise<number> {
  return (await ensureContext()).sampleRate;
}

function updateDevice(): void {
  results.device = { ...collectDeviceInfo(settings.label, mic?.settings()), micVerdict: results.verdict ?? undefined };
  save();
  const box = document.getElementById('device-box');
  if (box) box.replaceChildren(kvTable(results.device as unknown as Record<string, unknown>));
  const ms = document.getElementById('mic-settings');
  if (ms && mic) ms.textContent = JSON.stringify(mic.settings(), null, 1);
}

// ---------------------------------------------------------------- generic TX/RX card

interface TestCardSpec {
  id: string;
  title: string;
  intro: string;
  signal: (fs: number) => Float32Array;
  /** Seconds of signal (from the layout, so both devices agree without generating it). */
  duration: () => number;
  analyze: (rec: Float32Array, fs: number) => void;
  extra?: HTMLElement[];
}

function progressBar(): { root: HTMLElement; set: (p: number) => void } {
  const inner = el('div');
  const root = el('div', { class: 'progress' }, inner);
  return { root, set: (p) => (inner.style.width = `${Math.round(100 * Math.min(1, p))}%`) };
}

function testCard(spec: TestCardSpec): { card: HTMLElement; out: HTMLElement; status: HTMLElement } {
  const status = el('div', { class: 'status' });
  const out = el('div');
  const prog = progressBar();
  const rec = el('button', {}, 'Record (RX)');
  const tx = el('button', { class: 'tx' }, 'Play (TX)');
  const stop = el('button', { class: 'secondary' }, 'Stop');
  let abort: AbortController | null = null;
  stop.addEventListener('click', () => abort?.abort());
  action(rec, status, async () => {
    const m = await getMic();
    const dur = settings.startWindow + spec.duration() + 1;
    abort = new AbortController();
    const t0 = performance.now();
    status.textContent = `Recording ${dur.toFixed(0)} s — press Play on the other device now`;
    const x = await m.record(dur, (p) => {
      prog.set(p);
      const left = dur - (performance.now() - t0) / 1000;
      status.textContent = `Recording… ${Math.max(0, left).toFixed(0)} s left — press Play on the other device`;
    }, abort.signal);
    abort = null;
    if (!liveOff) releaseMic();
    status.textContent = 'Analysing…';
    await sleep(20);
    spec.analyze(x, m.ctx.sampleRate);
    status.textContent = `Done (${(x.length / m.ctx.sampleRate).toFixed(1)} s analysed).`;
    save();
  });
  action(tx, status, async () => {
    const f = await fs();
    status.textContent = `Playing ${spec.duration().toFixed(1)} s…`;
    await transmit(spec.signal(f));
    status.textContent = 'Played.';
  });
  const card = el('details', { class: 'card', id: spec.id },
    el('summary', {}, spec.title),
    el('p', { class: 'muted' }, spec.intro),
    ...(spec.extra ?? []),
    el('div', { class: 'row' }, rec, tx, stop),
    prog.root,
    status,
    out,
  );
  return { card, out, status };
}

function pill(v: Verdict, label: string): HTMLElement {
  return el('span', { class: `verdict v-${v}` }, `${label}: ${v}`);
}

function notes(list: string[]): HTMLElement {
  return el('ul', { class: 'notes' }, ...list.map((n) => el('li', {}, n)));
}

function canvas(cls = 'plot'): HTMLCanvasElement {
  return el('canvas', { class: cls === 'plot' ? 'plot hidden' : cls });
}

// ---------------------------------------------------------------- sections

function header(): HTMLElement {
  const status = el('div', { class: 'status' });
  const enable = el('button', {}, 'Enable audio');
  action(enable, status, async () => {
    const c = await ensureContext();
    status.textContent = `Audio running at ${c.sampleRate} Hz.`;
    updateDevice();
  });
  const label = el('input', { type: 'text', placeholder: 'device name, e.g. "iPhone 13 / Safari"', value: settings.label });
  label.addEventListener('change', () => {
    settings.label = label.value;
    saveSettings();
    updateDevice();
  });
  const gain = el('input', { type: 'range', min: -40, max: 0, step: 1, value: settings.gainDb });
  const gainLbl = el('span', {}, `${settings.gainDb} dB`);
  gain.addEventListener('input', () => {
    settings.gainDb = Number(gain.value);
    gainLbl.textContent = `${settings.gainDb} dB`;
    saveSettings();
  });
  const win = el('input', { type: 'number', min: 2, max: 60, step: 1, value: settings.startWindow, style: 'width:5em' });
  win.addEventListener('change', () => {
    settings.startWindow = Math.max(2, Number(win.value) || 8);
    saveSettings();
  });
  const policy = el('select', {},
    el('option', { value: 'switch', selected: settings.sessionPolicy === 'switch' }, 'switch (playback for TX, play-and-record for RX)'),
    el('option', { value: 'leave', selected: settings.sessionPolicy === 'leave' }, 'leave as selected in mic variant'),
  );
  policy.addEventListener('change', () => {
    settings.sessionPolicy = policy.value as Settings['sessionPolicy'];
    saveSettings();
  });
  const spec = canvas('spec');
  const sg = canvas('sgram');
  const liveBtn = el('button', { class: 'secondary', id: 'live-btn' }, 'Start live view');
  action(liveBtn, status, async () => {
    if (liveOff) {
      releaseMic();
      return;
    }
    await startLive(spec, sg);
    liveBtn.textContent = 'Stop live view';
  });
  return el('div', {},
    el('div', { class: 'card' },
      el('div', { class: 'row' }, enable, liveBtn),
      el('div', { class: 'row' }, el('label', {}, 'Device', label)),
      el('div', { class: 'row' }, el('label', {}, 'TX level'), gain, gainLbl),
      el('div', { class: 'row' }, el('label', {}, 'RX start window', win, 's')),
      audioSessionSupported() ? el('div', { class: 'row' }, el('label', {}, 'audioSession', policy)) : el('p', { class: 'muted' }, 'navigator.audioSession not available on this browser.'),
      status,
      el('p', { class: 'muted' }, 'Live band view (16–19 kHz; dashed lines at 17.0 and 18.5 kHz). The live view holds the mic — it is released automatically before any Play.'),
      spec,
      el('div', { style: 'height:6px' }),
      sg,
    ),
  );
}

function micCheckSection(): HTMLElement {
  const status = el('div', { class: 'status' });
  const v = settings.variant;
  const sel = (opts: [string, string][], cur: string, set: (s: string) => void) => {
    const s = el('select', {}, ...opts.map(([val, txt]) => el('option', { value: val, selected: val === cur }, txt)));
    s.addEventListener('change', () => {
      set(s.value);
      saveSettings();
    });
    return s;
  };
  const sessSel = sel([['unset', 'unset'], ['auto', 'auto'], ['play-and-record', 'play-and-record'], ['playback', 'playback']], v.audioSession, (s) => (v.audioSession = s as MicApiVariant['audioSession']));
  const orderSel = sel([['context-first', 'AudioContext first'], ['mic-first', 'mic first']], v.order, (s) => (v.order = s as MicApiVariant['order']));
  const vid = el('input', { type: 'checkbox', checked: v.explicitVideoFalse });
  vid.addEventListener('change', () => {
    v.explicitVideoFalse = vid.checked;
    saveSettings();
  });
  const apiOut = el('div');
  const probe = el('button', {}, 'Probe mic API');
  action(probe, status, async () => {
    releaseMic();
    const r = await probeMicApi({ ...v });
    results.micApi.push(r);
    save();
    status.textContent = r.error ? `Probe failed: ${r.error}` : 'API probe done.';
    renderApi();
  });
  const renderApi = () => {
    const rows = results.micApi.map((r) => ({
      session: r.variant.audioSession, order: r.variant.order, videoFalse: r.variant.explicitVideoFalse,
      ec: String(r.settings.echoCancellation), ns: String(r.settings.noiseSuppression), agc: String(r.settings.autoGainControl),
      applyThrew: r.applyConstraints.threw ?? 'no', changed: r.applyConstraints.changed.join(' ') || '—', sr: r.contextSampleRate, err: r.error ?? '',
    }));
    apiOut.replaceChildren(el('div', { class: 'table-wrap' }, rowsTable(rows)));
  };
  renderApi();

  // (a) AEC self-test
  const aecOut = el('div');
  const aecBtn = el('button', {}, 'Run AEC self-test (this device)');
  const aecProg = progressBar();
  action(aecBtn, status, async () => {
    stopLive();
    const m = await getMic();
    const f = m.ctx.sampleRate;
    const x = aecSignal(f);
    const lead = 0.5;
    const dur = aecLayout().total + lead + 1;
    status.textContent = 'Self-test: playing and recording…';
    const t0 = m.ctx.currentTime;
    const recP = m.record(dur, aecProg.set);
    await sleep(lead * 1000);
    // full duplex on purpose: this test measures what the device does to its own playback
    const pb = await play(x, { gainDb: settings.gainDb });
    const outLat = (m.ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0;
    const expectedStart = pb.startTime - t0 + outLat + (m.ctx.baseLatency ?? 0);
    const rec = await recP;
    releaseMic();
    const r = analyzeAec(rec, f, expectedStart);
    results.aec.push(r);
    updateVerdict();
    status.textContent = 'AEC self-test done.';
    renderAec();
  });
  const renderAec = () => {
    const r = results.aec.at(-1);
    if (!r) return;
    aecOut.replaceChildren(
      el('div', { class: 'row' }, pill(r.aecOff, 'AEC off'), pill(r.lowpass === 'yes' ? 'no' : r.lowpass === 'no' ? 'yes' : 'unknown', 'band not low-passed')),
      kvTable(r as unknown as Record<string, unknown>, ['markerFound', 'onsetDb', 'steadyDb', 'dropDb', 'modulationDb', 'toneSnrDb', 'ambientLowDensityDb', 'ambientBandDensityDb']),
      notes(r.notes),
    );
  };
  renderAec();

  // (b)+(c) remote AGC / NS
  const remote = testCard({
    id: 'mic-remote',
    title: 'AGC + noise suppression (two devices)',
    intro: 'The other device sends a tone at −30/−20/−10/0 dB steps, then a 10 s steady tone. Linear steps mean no AGC; a fading/gated long tone means noise suppression.',
    signal: (f) => remoteMicSignal(f),
    duration: () => remoteMicLayout().total,
    analyze: (rec, f) => {
      const r = analyzeRemoteMic(rec, f);
      results.micRemote.push(r);
      updateVerdict();
      renderRemote();
    },
  });
  const renderRemote = () => {
    const r = results.micRemote.at(-1);
    if (!r) return;
    remote.out.replaceChildren(
      el('div', { class: 'row' }, pill(r.agcOff, 'AGC off'), pill(r.nsOff, 'NS off')),
      kvTable(r as unknown as Record<string, unknown>, ['agcSlope', 'maxPumpDb', 'noiseDb', 'nsDecayDb', 'nsGatedFraction', 'nsStdDb', 'nsSnrDb']),
      el('div', { class: 'table-wrap' }, rowsTable(r.steps)),
      notes(r.notes),
    );
  };
  renderRemote();

  const verdictBox = el('div', { id: 'verdict-box' });
  const renderVerdict = () => {
    const vd = results.verdict;
    if (!vd) {
      verdictBox.replaceChildren(el('p', { class: 'muted' }, 'No empirical results yet.'));
      return;
    }
    verdictBox.replaceChildren(
      el('div', { class: 'row' }, pill(vd.aecOff, 'AEC off'), pill(vd.agcOff, 'AGC off'), pill(vd.nsOff, 'NS off'), pill(vd.lowpass === 'yes' ? 'no' : vd.lowpass === 'no' ? 'yes' : 'unknown', 'full band')),
      notes(vd.consequences),
    );
  };
  const updateVerdict = () => {
    const lastApi = results.micApi.filter((r) => !r.error).at(-1);
    const api = mic?.settings() ?? lastApi?.settings;
    results.verdict = micVerdict(results.aec.at(-1), results.micRemote.at(-1), api ? {
      echoCancellation: api.echoCancellation as boolean | undefined,
      noiseSuppression: api.noiseSuppression as boolean | undefined,
      autoGainControl: api.autoGainControl as boolean | undefined,
    } : undefined);
    updateDevice();
    renderVerdict();
  };
  renderVerdict();

  return el('details', { class: 'card', id: 'mic-check', open: true },
    el('summary', {}, '1. Mic-processing check (run first)'),
    el('p', { class: 'muted' }, 'The API can say "off" while processing is still on (WebKit). Variants below apply to every mic acquisition on this page.'),
    el('div', { class: 'row' }, el('label', {}, 'audioSession', sessSel), el('label', {}, 'order', orderSel), el('label', {}, vid, 'video:false')),
    el('h3', {}, 'API layer'),
    el('div', { class: 'row' }, probe),
    apiOut,
    el('pre', { id: 'mic-settings' }, ''),
    el('h3', {}, 'AEC self-test'),
    el('p', { class: 'muted' }, 'This device plays a 6 s 17.75 kHz tone and a 16–19 kHz sweep while recording itself, then listens to 2 s of room noise.'),
    el('div', { class: 'row' }, aecBtn),
    aecProg.root,
    aecOut,
    remote.card,
    el('h3', {}, 'Verdict (saved with the device record)'),
    verdictBox,
    status,
  );
}

function freqRespSection(): HTMLElement {
  const plot = canvas();
  const t = testCard({
    id: 'freqresp',
    title: '2. Frequency response & level',
    intro: '31 stepped tones 16–19 kHz, 1.2 s silence (noise floor), then a 3 s sweep. Gives level, noise and SNR per frequency and the best 1.5 kHz sub-band.',
    signal: (f) => freqRespSignal(f),
    duration: () => freqRespLayout().total,
    analyze: (rec, f) => {
      results.freqresp.push(analyzeFreqResp(rec, f));
      render();
    },
    extra: [plot],
  });
  const render = () => {
    const r = results.freqresp.at(-1);
    if (!r) return;
    const series: Series[] = [
      { name: 'level', points: r.points.map((p) => ({ x: p.freq, y: p.levelDb })) },
      { name: 'sweep', points: r.sweep.map((p) => ({ x: p.freq, y: p.levelDb })), dashed: true },
      { name: 'noise', points: r.points.map((p) => ({ x: p.freq, y: p.noiseDb })) },
    ];
    linePlot(plot, series, { xLabel: 'Hz', yLabel: 'dBFS', vlines: [17000, 18500] });
    t.out.replaceChildren(
      kvTable({
        'default band min SNR (dB)': r.defaultBand.minSnrDb,
        'default band mean SNR (dB)': r.defaultBand.meanSnrDb,
        'best 1.5 kHz sub-band': `${r.bestSubBand.fLow}–${r.bestSubBand.fHigh} Hz`,
        'best sub-band min/mean SNR': `${r.bestSubBand.minSnrDb} / ${r.bestSubBand.meanSnrDb} dB`,
        'in-band noise (17–18.5 kHz)': `${r.inBandNoiseDb} dBFS (${r.inBandNoiseDensityDb} dBFS/Hz)`,
      }),
      el('div', { class: 'table-wrap' }, rowsTable(r.points)),
    );
  };
  render();
  return t.card;
}

function echoSection(): HTMLElement {
  const plot = canvas();
  const exportBtn = el('button', { class: 'secondary' }, 'Export IR (JSON for sim/ir/)');
  exportBtn.addEventListener('click', () => {
    const ir = results.irs.at(-1);
    if (!ir) return;
    const name = `ir-${(settings.label || 'device').replace(/\W+/g, '_')}-${ir.meta.date.slice(0, 10)}.json`;
    downloadJson(name, ir);
  });
  const t = testCard({
    id: 'echo',
    title: '3. Echo / reverb',
    intro: 'Four 20 ms in-band chirps, 1.2 s apart. Matched filtering gives the in-band impulse response; Schroeder integration gives decay times. Informs symbol length and guard interval.',
    signal: (f) => echoSignal(f),
    duration: () => echoLayout().total,
    analyze: (rec, f) => {
      const { result, ir } = analyzeEcho(rec, f);
      ir.meta.device = settings.label;
      results.echo.push(result);
      results.irs.push(ir);
      if (results.irs.length > 4) results.irs.shift(); // keep storage bounded; export each one you want
      render();
    },
    extra: [plot, el('div', { class: 'row' }, exportBtn)],
  });
  const render = () => {
    const r = results.echo.at(-1);
    if (!r) return;
    linePlot(plot, [
      { name: 'envelope', points: r.envelope.map((p) => ({ x: p.t * 1000, y: p.db })) },
      { name: 'Schroeder EDC', points: r.edc.map((p) => ({ x: p.t * 1000, y: p.db })) },
    ], { xLabel: 'ms after direct', yLabel: 'dB', yMin: -60, yMax: 3, hlines: [-20, -30] });
    t.out.replaceChildren(kvTable(r as unknown as Record<string, unknown>, ['burstsUsed', 'peakToNoiseDb', 'edtSec', 'rt60FromT20', 'rt60FromT30', 'tMinus20', 'tMinus30', 'drrDb']));
  };
  render();
  return t.card;
}

function distanceSection(): HTMLElement {
  const dist = el('input', { type: 'number', min: 0.1, step: 0.1, value: 1, style: 'width:6em' });
  const plot = canvas();
  const exportCsv = el('button', { class: 'secondary' }, 'Export CSV');
  exportCsv.addEventListener('click', () => download(`distance-${Date.now()}.csv`, distanceCsv(results.distance), 'text/csv'));
  const undo = el('button', { class: 'secondary' }, 'Delete last row');
  undo.addEventListener('click', () => {
    results.distance.pop();
    save();
    render();
  });
  const t = testCard({
    id: 'distance',
    title: '4. Attenuation vs distance',
    intro: 'Enter the distance, Record on the receiver, Play on the sender; repeat at several distances (e.g. 0.5, 1, 2, 4, 8 m). Fits L(d) = L0 − 20·log10(d) − α·d.',
    signal: (f) => distanceSignal(f),
    duration: () => distanceLayout().total,
    analyze: (rec, f) => {
      results.distance.push(analyzeDistance(rec, f, Number(dist.value)));
      render();
    },
    extra: [el('div', { class: 'row' }, el('label', {}, 'Distance', dist, 'm'), undo, exportCsv), plot],
  });
  const render = () => {
    const rows = results.distance;
    const fit = fitDistance(rows, 0);
    const series: Series[] = [
      { name: 'measured', points: rows.map((r) => ({ x: r.distanceM, y: r.levelDb })), dots: true },
      { name: 'noise', points: rows.map((r) => ({ x: r.distanceM, y: r.noiseDb })), dots: true },
    ];
    const f = fit.spreadingPlusAbsorption;
    if (f && rows.length) {
      const dmax = Math.max(...rows.map((r) => r.distanceM)) * 1.5;
      const pts = [];
      for (let d = 0.1; d <= dmax; d *= 1.1) pts.push({ x: d, y: f.L0 - 20 * Math.log10(d) - f.alphaDbPerM * d });
      series.push({ name: 'fit', points: pts, dashed: true });
    }
    if (rows.length) linePlot(plot, series, { xLabel: 'm', yLabel: 'dBFS' });
    t.out.replaceChildren(
      kvTable({
        'rows used': fit.rowsUsed,
        'α (dB/m)': f?.alphaDbPerM ?? null,
        'L0 (dBFS @ 1 m, no absorption)': f?.L0 ?? null,
        'fit rms (dB)': f?.rmsDb ?? null,
        'free path-loss exponent n': fit.freeExponent?.n ?? null,
        'range at 0 dB tone SNR (m)': fit.rangeAtSnr?.distanceM ?? null,
      }),
      el('div', { class: 'table-wrap' }, rowsTable(rows.map((r) => ({ distanceM: r.distanceM, levelDb: r.levelDb, noiseDb: r.noiseDb, snrDb: r.snrDb, tones: r.tones.map((x) => `${x.freq}:${x.snrDb}`).join(' ') })))),
    );
  };
  render();
  return t.card;
}

function dopplerSection(): HTMLElement {
  const plot = canvas();
  const plot2 = canvas();
  const t = testCard({
    id: 'doppler',
    title: '5. Doppler / motion',
    intro: 'A 15 s steady 17.75 kHz tone; slowly move one device (walk, swing it in your hand). Reports frequency and level stability.',
    signal: (f) => dopplerSignal(f),
    duration: () => dopplerLayout().total,
    analyze: (rec, f) => {
      results.doppler.push(analyzeDoppler(rec, f));
      render();
    },
    extra: [plot, plot2],
  });
  const render = () => {
    const r = results.doppler.at(-1);
    if (!r) return;
    linePlot(plot, [{ name: 'freq', points: r.series.map((p) => ({ x: p.t, y: p.freq - 17750 })) }], { xLabel: 's', yLabel: 'Hz offset' });
    linePlot(plot2, [{ name: 'level', points: r.series.map((p) => ({ x: p.t, y: p.levelDb })) }], { xLabel: 's', yLabel: 'dBFS' });
    t.out.replaceChildren(kvTable(r as unknown as Record<string, unknown>, ['meanOffsetHz', 'clockPpm', 'freqStdHz', 'maxDevHz', 'peakToPeakHz', 'maxSpeedMs', 'maxSlewHzPerS', 'levelStdDb', 'levelRangeDb', 'framesUsed']));
  };
  render();
  return t.card;
}

function audibilitySection(): HTMLElement {
  const status = el('div', { class: 'status' });
  const plot = canvas();
  const table = el('div');
  const cases: [AudibilityCase, string][] = [
    ['A', 'A: continuous phase + ramps'],
    ['A2', "A′: + smoothed transitions"],
    ['B', 'B: hard-gated, phase resets'],
    ['imd', 'Two tones 17.0+18.0 kHz'],
    ['ref', 'Single 17.75 kHz tone'],
  ];
  const buttons = cases.map(([c, label]) => {
    const b = el('button', { class: c === 'B' ? 'tx' : 'secondary' }, label);
    action(b, status, async () => {
      const f = await fs();
      status.textContent = `Playing ${label} (${AUDIBILITY_DEFAULTS.durSec} s)… listen for clicks, ticks, buzz or a low tone.`;
      await transmit(audibilitySignal(f, c));
      status.textContent = `Played ${label}.`;
    });
    return b;
  });
  const showSpectra = el('button', {}, 'Show computed TX spectra');
  action(showSpectra, status, async () => {
    const f = currentContext()?.sampleRate ?? 48000;
    const reps = (['A', 'A2', 'B', 'imd'] as AudibilityCase[]).map((c) => leakage(audibilitySignal(f, c), f, c));
    results.audibility.leakage = reps;
    save();
    render();
  });
  const imdOut = el('div');
  const imdBtn = el('button', {}, 'Record own two-tone output (measured IMD)');
  action(imdBtn, status, async () => {
    stopLive();
    const m = await getMic();
    const f = m.ctx.sampleRate;
    const x = imdRecordSignal(f);
    const t0 = m.ctx.currentTime;
    const recP = m.record(x.length / f + 1.5);
    await sleep(500);
    const pb = await play(x, { gainDb: settings.gainDb });
    const rec = await recP;
    releaseMic();
    const r = analyzeImd(rec, f, AUDIBILITY_DEFAULTS, pb.startTime - t0);
    results.audibility.imd.push(r);
    save();
    renderImd();
  });
  const imdPlot = canvas();
  const renderImd = () => {
    const r = results.audibility.imd.at(-1);
    if (!r) return;
    linePlot(imdPlot, [{ name: 'recorded', points: r.spectrum.map((p) => ({ x: p.freq, y: p.db })) }], { xLabel: 'Hz', yLabel: 'dBFS', yMin: -140, yMax: 0, vlines: [1000, 17000] });
    imdOut.replaceChildren(kvTable({ tones: r.toneDb.join(' / '), 'difference tone 1 kHz (dBFS)': r.diffDb, 'difference tone (dBc)': r.diffDbc, 'noise near 1 kHz (dBFS/bin)': r.noiseNearDiffDb, '2f1−f2 (dBFS)': r.im3LowDb, markerFound: r.markerFound }));
  };
  const render = () => {
    const reps = results.audibility.leakage;
    if (!reps.length) return;
    linePlot(plot, reps.filter((r) => r.case !== 'imd').map((r) => ({ name: r.case, points: r.spectrum.map((p) => ({ x: p.freq, y: p.db })) })), { xLabel: 'Hz', yLabel: 'dB', yMin: -140, yMax: 0, vlines: [17000, 18500] });
    table.replaceChildren(el('div', { class: 'table-wrap' }, rowsTable(reps.map((r) => ({ case: r.case, 'below 17 kHz (dBc)': r.belowBandDbc, 'worst line < 16.9 kHz (dBc)': r.worstBelowDbc, '< 16 kHz (dBc)': r.audibleDbc })))));
  };
  render();
  renderImd();
  return el('details', { class: 'card', id: 'audibility' },
    el('summary', {}, '6. Audibility (local A/B)'),
    el('p', { class: 'muted' }, 'Same random tone-hop stream (25 ms symbols) rendered three ways. Ask listeners of different ages; children and teenagers hear 17 kHz. The computed spectra show what goes into the speaker; the speaker itself adds intermodulation, which only the recording shows.'),
    el('div', { class: 'row' }, ...buttons),
    el('div', { class: 'row' }, showSpectra),
    plot,
    table,
    el('h3', {}, 'Measured speaker IMD'),
    el('div', { class: 'row' }, imdBtn),
    imdPlot,
    imdOut,
    status,
  );
}

function berSection(): HTMLElement {
  const modem = berModem;
  const profSel = el('select', {}, ...modem.profiles().map((p) => el('option', { value: p.id }, `${p.label}${p.netBps ? ` — ${p.netBps.toFixed(0)} b/s net` : p.rawBps ? ` — ${p.rawBps.toFixed(0)} b/s raw` : ''}`)));
  const packets = el('input', { type: 'number', min: 1, max: 200, value: BER_DEFAULTS.packets, style: 'width:5em' });
  const bytes = el('input', { type: 'number', min: 3, max: 256, value: BER_DEFAULTS.payloadBytes, style: 'width:5em' });
  const seed = el('input', { type: 'number', min: 0, value: BER_DEFAULTS.seed, style: 'width:5em' });
  const dist = el('input', { type: 'number', min: 0, step: 0.1, value: 1, style: 'width:5em' });
  const dur = el('span', { class: 'muted' });
  const opts = () => ({ packets: Number(packets.value), payloadBytes: Number(bytes.value), seed: Number(seed.value) });
  const showDur = () => (dur.textContent = `≈ ${modem.durationSec(profSel.value, opts()).toFixed(1)} s of audio`);
  for (const i of [profSel, packets, bytes]) i.addEventListener('change', showDur);
  showDur();
  const t = testCard({
    id: 'ber-card',
    title: '7. Modem BER/PER',
    intro:
      'Known pseudo-random payload; both devices must use the same profile, packet count, size and seed. "Modem" profiles run the full modem (sync, FEC, CRC): PER is what users see, raw BER is the channel error rate before FEC, and corrupt must stay 0. "Uncoded" rows compare bare modulations with marker timing.',
    signal: (f) => modem.txSignal(f, profSel.value, opts()),
    duration: () => modem.durationSec(profSel.value, opts()),
    analyze: (rec, f) => {
      results.ber.push({ ...modem.analyze(rec, f, profSel.value, opts()), distanceM: Number(dist.value) });
      render();
    },
    extra: [el('div', { class: 'row' }, el('label', {}, 'Profile', profSel), el('label', {}, 'Packets', packets), el('label', {}, 'Bytes', bytes), el('label', {}, 'Seed', seed), el('label', {}, 'Distance', dist, 'm'), dur)],
  });
  const render = () => {
    t.out.replaceChildren(
      el('div', { class: 'table-wrap' },
        rowsTable(results.ber.map((r) => ({
          profile: r.profile,
          distanceM: r.distanceM,
          sent: r.packetsSent,
          detected: r.packetsDetected,
          ok: r.packetsOk,
          per: r.per.toFixed(3),
          ber: Number.isFinite(r.ber) ? r.ber.toExponential(2) : '—',
          rawBer: r.rawBer === undefined ? '—' : r.rawBer.toExponential(2),
          corrupt: r.corrupt ?? '—',
          snrDb: r.meanSnrDb?.toFixed(1),
        })))),
    );
  };
  render();
  return t.card;
}

function exportSection(): HTMLElement {
  const status = el('div', { class: 'status' });
  const all = el('button', {}, 'Export all results (JSON)');
  action(all, status, async () => {
    updateDevice();
    const name = `beep-bench-${(settings.label || 'device').replace(/\W+/g, '_')}-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.json`;
    const how = await shareOrDownload(name, JSON.stringify({ ...results, log: audioLog }, null, 1));
    status.textContent = how === 'shared' ? 'Shared.' : `Downloaded ${name}.`;
  });
  const copy = el('button', { class: 'secondary' }, 'Copy JSON');
  action(copy, status, async () => {
    updateDevice();
    status.textContent = (await copyText(JSON.stringify(results))) ? 'Copied to clipboard.' : 'Copy failed.';
  });
  const clear = el('button', { class: 'secondary' }, 'Clear results');
  clear.addEventListener('click', () => {
    if (!confirm('Delete all stored bench results on this device?')) return;
    Object.assign(results, emptyResults());
    save();
    location.reload();
  });
  const logBox = el('pre', { id: 'log' }, audioLog.join('\n'));
  onLog((line) => {
    logBox.textContent += (logBox.textContent ? '\n' : '') + line;
    logBox.scrollTop = logBox.scrollHeight;
  });
  return el('div', {},
    el('details', { class: 'card' }, el('summary', {}, 'Device info'), el('div', { id: 'device-box' })),
    el('details', { class: 'card' }, el('summary', {}, 'Log'), logBox),
    el('div', { class: 'card' }, el('div', { class: 'row' }, all, copy, clear), status),
  );
}

// ---------------------------------------------------------------- boot

function boot(): void {
  const root = $('#root');
  root.append(header(), micCheckSection(), freqRespSection(), echoSection(), distanceSection(), dopplerSection(), audibilitySection(), berSection(), exportSection());
  updateDevice();
  const banner = $('#banner');
  onContextState((s) => banner.classList.toggle('hidden', s === 'running'));
  banner.addEventListener('click', async () => {
    await ensureContext();
    banner.classList.toggle('hidden', currentContext()?.state === 'running');
  });
  window.addEventListener('pagehide', () => releaseMic());
  log(`bench loaded: ${navigator.userAgent}`);
}

boot();
