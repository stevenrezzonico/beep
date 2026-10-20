/** Minimal DOM helpers (no framework). */

type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') e.addEventListener(k.replace(/^on/, ''), v);
    else if (k === 'class') e.className = String(v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) e.append(c);
  return e;
}

export function $(sel: string, root: ParentNode = document): HTMLElement {
  const e = root.querySelector<HTMLElement>(sel);
  if (!e) throw new Error(`missing element ${sel}`);
  return e;
}

/** Run an async click handler with the button disabled and errors shown in `status`. */
export function action(btn: HTMLButtonElement, status: HTMLElement, fn: () => Promise<void>): void {
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    status.classList.remove('error');
    try {
      await fn();
    } catch (e) {
      status.textContent = (e as Error).message;
      status.classList.add('error');
      console.error(e);
    } finally {
      btn.disabled = false;
    }
  });
}

/** Key/value table from a flat object (skips arrays/objects). */
export function kvTable(obj: Record<string, unknown>, keys?: string[]): HTMLTableElement {
  const t = el('table', { class: 'kv' });
  for (const k of keys ?? Object.keys(obj)) {
    const v = obj[k];
    if (v !== null && typeof v === 'object') continue;
    t.append(el('tr', {}, el('th', {}, k), el('td', {}, v === null || v === undefined ? '—' : String(v))));
  }
  return t;
}

export function rowsTable(items: object[], cols?: string[]): HTMLTableElement {
  const rows = items as Record<string, unknown>[];
  const t = el('table', { class: 'rows' });
  if (!rows.length) return t;
  const keys = cols ?? Object.keys(rows[0]).filter((k) => typeof rows[0][k] !== 'object');
  t.append(el('tr', {}, ...keys.map((k) => el('th', {}, k))));
  for (const r of rows) t.append(el('tr', {}, ...keys.map((k) => el('td', {}, r[k] === undefined || r[k] === null ? '—' : String(r[k])))));
  return t;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
