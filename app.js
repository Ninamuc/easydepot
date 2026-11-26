/* EasyDepot – Oberfläche */
(function () {
  'use strict';
  const P = window.EasyParser, E = window.EasyEngine;
  const $app = document.getElementById('app');
  const KEY = 'easydepot.v1';

  // ---------- Speicher (bleibt auf diesem Gerät) ----------
  let storageOk = true;
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : { snapshots: [], depotMeta: {} };
    } catch (e) { storageOk = false; return { snapshots: [], depotMeta: {} }; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state.data)); storageOk = true; }
    catch (e) { storageOk = false; }
  }

  const state = {
    data: load(),
    view: { name: 'home' },
    chartMode: 'value',
    chartDepot: 'all',
    sort: 'value',
    pending: [],
  };

  // ---------- Format ----------
  const fmtEur = (x, d = 0) => (x == null ? '–' : x.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }) + ' €');
  const fmtNum = (x, d = 2) => (x == null ? '–' : x.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const fmtPct = (x, d = 2) => (x == null ? '–' : (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x * 100).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }) + ' %');
  const fmtSignedEur = (x) => (x == null ? '' : (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x).toLocaleString('de-DE', { maximumFractionDigits: 0 }) + ' €');
  const fmtDate = (iso) => (iso ? new Date(iso + 'T12:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '–');
  const fmtDateShort = (iso) => new Date(iso + 'T12:00').toLocaleDateString('de-DE', { day: '2-digit', month: 'short' });
  const cls = (x) => (x == null || Math.abs(x) < 0.00005 ? 'neutral' : x > 0 ? 'up' : 'down');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- PDF lesen ----------
  async function pdfLines(file) {
    if (!window.pdfjsLib) throw new Error('Der PDF-Leser konnte nicht geladen werden. Besteht eine Internetverbindung?');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const buf = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjsLib.getDocument({ data: buf, verbosity: 0 }).promise;
    return P.readDocument(doc, pdfjsLib.OPS);
  }

  async function handleFiles(files) {
    const list = [...files].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!list.length) return;
    showSheet(`<h2>PDF wird gelesen …</h2><p class="muted">${esc(list.map((f) => f.name).join(', '))}</p>`);
    const results = [];
    for (const f of list) {
      try {
        const input = await pdfLines(f);
        const r = input.lines.length > 20 ? P.parse(input) : { kind: 'error', error: 'Im PDF ist kein lesbarer Text, nur Bilder. Bitte beim Drucken „Als PDF sichern“ verwenden, nicht PDF24 oder Microsoft Print to PDF.' };
        r.fileName = f.name;
        results.push(r);
      } catch (e) {
        results.push({ kind: 'error', fileName: f.name, error: e.message || String(e) });
      }
    }
    state.pending = results;
    renderPending();
  }

  function renderPending() {
    const r = state.pending[0];
    if (!r) { closeSheet(); render(); return; }
    const more = state.pending.length > 1 ? `<span class="muted small">noch ${state.pending.length - 1} weitere</span>` : '';
    if (r.kind !== 'snapshot') {
      const msg = r.kind === 'error' ? r.error : 'Diese Art von PDF kenne ich noch nicht. Bisher kann EasyDepot die myWealth-Übersicht lesen (Seite „Anlageziel“, gedruckt mit „Als PDF sichern“).';
      const textless = r.kind === 'unknown' ? '' : '';
      showSheet(`<h2>Nicht erkannt</h2><p class="muted small">${esc(r.fileName)}</p><p>${esc(msg)}</p>${textless}
        <div class="actions">${more}<button data-act="skip">OK</button></div>`);
      return;
    }
    const allOk = r.checks.every((c) => c.ok);
    const exists = state.data.snapshots.some((s) => s.depotId === r.depotId && s.date === r.date);
    const checks = r.checks.map((c) => `<div class="check"><span class="i ${c.ok ? 'up' : 'down'}">${c.ok ? '✓' : '✗'}</span>
        <span>${esc(c.label)}${c.ok ? '' : ` – erwartet ${typeof c.expected === 'number' ? fmtEur(c.expected, 2) : esc(c.expected)}, gelesen ${typeof c.got === 'number' ? fmtEur(c.got, 2) : esc(c.got)}`}</span></div>`).join('');
    const warn = r.warnings.map((w) => `<div class="note">${esc(w)}</div>`).join('');
    showSheet(`
      <h2>${esc(r.bank)} erkannt</h2>
      <p class="muted small">${esc(r.fileName)}</p>
      <table>
        <tr><td>Stand</td><td>${fmtDate(r.date)}</td></tr>
        <tr><td>Depot</td><td>${esc(r.depotNr || '–')}${r.custodian ? `<div class="meta">${esc(r.custodian)}</div>` : ''}</td></tr>
        <tr><td>Positionen</td><td>${r.positions.length}</td></tr>
        <tr><td>Wertpapiere</td><td>${fmtEur(r.securitiesTotal, 2)}</td></tr>
        <tr><td>Konto</td><td>${fmtEur(r.cashTotal, 2)}</td></tr>
        <tr><td><b>Gesamt</b></td><td><b>${fmtEur(r.total, 2)}</b></td></tr>
        ${r.history ? `<tr><td>Verlauf</td><td>${r.history.points.length} Werte seit ${fmtDate(r.history.points[0].date)}<div class="meta">aus dem Diagramm der Seite zurückgerechnet, ca.</div></td></tr>` : ''}
        ${r.transactions?.length ? `<tr><td>Bewegungen</td><td>${r.transactions.length}${r.transactionsInfo ? ` von ${r.transactionsInfo.total}` : ''}</td></tr>` : ''}
        ${r.plan ? `<tr><td>Investmentplan</td><td>${r.plan.startAmount ? fmtEur(r.plan.startAmount) + ' ab ' + fmtDate(r.plan.startDate) : ''}${r.plan.targetReturn != null ? `<div class="meta">Ziel ${fmtNum(r.plan.targetReturn * 100, 1)} % pro Jahr</div>` : ''}</td></tr>` : ''}
      </table>
      <div class="section">${checks}</div>
      ${warn}
      ${exists ? '<div class="note">Für diesen Tag gibt es schon einen Stand. Er wird ersetzt.</div>' : ''}
      ${allOk ? '' : '<div class="note">Die Summen stimmen nicht. Bitte nur übernehmen, wenn du weißt, warum.</div>'}
      <div class="actions">${more}<button class="ghost" data-act="skip">Verwerfen</button><button data-act="accept">Übernehmen</button></div>`);
  }

  function acceptPending() {
    const r = state.pending.shift();
    const { checks, warnings, kind, ...snap } = r;
    snap.id = snap.depotId + '@' + snap.date;
    snap.importedAt = new Date().toISOString();
    // echte Daten ersetzen die Beispieldaten
    state.data.snapshots = state.data.snapshots.filter((s) => s.id !== snap.id && !s.demo).concat([snap]);
    save();
    renderPending();
  }

  // ---------- Beispieldaten (erfunden) ----------
  function makeDemo() {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const day = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return iso(d); };
    const P = [
      ['Aktien Welt ETF', 'Aktienfonds', 4200, 98.4], ['Aktien Europa ETF', 'Aktienfonds', 3100, 41.2],
      ['Schwellenländer Fonds', 'Aktienfonds', 900, 152.7], ['Staatsanleihen Euro 2028', 'Rentenfonds', 2500, 101.3],
      ['Geldmarkt Euro Fonds', 'Geldmarktfonds', 1800, 88.1], ['Mischfonds Ausgewogen', 'Mischfonds', 650, 176.0],
      ['Gold-Zertifikat', 'Sonstige Zertifikate', 400, 104.5],
    ];
    const positions = P.map(([name, category, qty, price], i) => ({ isin: 'XX00DEMO000' + i, name, category, qty, price, priceCcy: 'EUR', value: Math.round(qty * price * 100) / 100 }));
    const sec = positions.reduce((s, p) => s + p.value, 0);
    positions.forEach((p) => (p.weight = Math.round((p.value / (sec + 25000)) * 10000) / 100));
    const total = sec + 25000;
    const points = [];
    let v = total * 0.985;
    for (let n = 120; n >= 1; n--) {
      v *= 1 + (rnd() - 0.48) * 0.008;
      points.push({ date: day(n), securities: Math.round(v - 25000), cash: 25000, total: Math.round(v) });
    }
    points.push({ date: day(0), securities: Math.round(sec), cash: 25000, total: Math.round(total) });
    return {
      demo: true, source: 'mywealth', bank: 'Beispiel', custodian: 'Beispielbank', depotId: 'demo', depotNr: '0000000000',
      id: 'demo@' + day(0), date: day(0), positions, cash: [{ name: 'Euro', ccy: 'EUR', value: 25000, weight: 1 }],
      securitiesTotal: sec, cashTotal: 25000, total,
      transactions: [
        { date: day(6), type: 'Kauf', isin: positions[1].isin, name: positions[1].name, qty: 500, price: 42.0, priceCcy: 'EUR', amount: 21000 },
        { date: day(20), type: 'Verkauf', isin: positions[4].isin, name: positions[4].name, qty: -300, price: 87.9, priceCcy: 'EUR', amount: -26370 },
      ],
      history: { points, approx: true },
      plan: { startDate: day(120), startAmount: Math.round(total * 0.98 / 1000) * 1000, targetReturn: 0.045, horizonYears: 9, product: 'Beispiel-Vermögensverwaltung' },
    };
  }

  // ---------- Sheet ----------
  let sheetEl = null;
  function showSheet(html) {
    if (!sheetEl) {
      sheetEl = document.createElement('div');
      sheetEl.className = 'sheet-bg';
      sheetEl.addEventListener('click', (e) => { if (e.target === sheetEl && !state.pending.length) closeSheet(); });
      document.body.appendChild(sheetEl);
    }
    sheetEl.innerHTML = `<div class="card sheet">${html}</div>`;
  }
  function closeSheet() { if (sheetEl) { sheetEl.remove(); sheetEl = null; } }

  // ---------- Diagramm ----------
  // Interaktiv: Finger oder Maus über die Linie bewegen zeigt Datum und Wert.
  const charts = new Map();
  let chartSeq = 0;
  function chartBlock(points, mode) {
    const id = 'c' + (++chartSeq);
    charts.set(id, { points, mode });
    return `<div class="chart-wrap" data-chart="${id}">${chartSvg(points, mode)}<div class="tip" hidden></div></div>`;
  }
  function wireCharts() {
    document.querySelectorAll('[data-chart]').forEach((wrap) => {
      const c = charts.get(wrap.dataset.chart);
      const svg = wrap.querySelector('svg');
      if (!c || !svg || c.points.length < 2) return;
      const tip = wrap.querySelector('.tip');
      const cursor = svg.querySelector('.cursor');
      const dot = svg.querySelector('.cursor-dot');
      const geo = JSON.parse(svg.dataset.geo);
      const move = (ev) => {
        const r = svg.getBoundingClientRect();
        const sx = ((ev.clientX - r.left) / r.width) * geo.W;
        let best = 0, bd = Infinity;
        c.points.forEach((p, i) => { const d = Math.abs(geo.xs[i] - sx); if (d < bd) { bd = d; best = i; } });
        const p = c.points[best];
        const v = c.mode === 'value' ? p.value : p.index - 1;
        cursor.setAttribute('x1', geo.xs[best]); cursor.setAttribute('x2', geo.xs[best]); cursor.style.display = '';
        dot.setAttribute('cx', geo.xs[best]); dot.setAttribute('cy', geo.ys[best]); dot.style.display = '';
        tip.hidden = false;
        tip.innerHTML = `<b>${c.mode === 'value' ? fmtEur(p.value) : fmtPct(v)}</b><br>${fmtDate(p.date)}${p.approx ? ' · ca.' : ''}`;
        const px = (geo.xs[best] / geo.W) * r.width;
        tip.style.left = Math.min(Math.max(px - 70, 0), r.width - 140) + 'px';
      };
      const leave = () => { tip.hidden = true; cursor.style.display = 'none'; dot.style.display = 'none'; };
      svg.addEventListener('pointermove', move);
      svg.addEventListener('pointerdown', move);
      svg.addEventListener('pointerleave', leave);
    });
  }

  function chartSvg(points, mode) {
    const W = Math.round(Math.max(300, Math.min(1000, ($app.clientWidth || 960) - 40))), H = 260, L = 64, R = 16, T = 16, B = 30;
    if (!points.length) return '';
    const vals = points.map((p) => (mode === 'value' ? p.value : (p.index - 1)));
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (mode === 'perf') { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (hi - lo < 1e-9) { const pad = mode === 'value' ? Math.max(hi * 0.02, 1) : 0.01; lo -= pad; hi += pad; }
    const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
    const t0 = new Date(points[0].date).getTime(), t1 = new Date(points[points.length - 1].date).getTime();
    const x = (d) => (points.length === 1 ? (L + W - R) / 2 : L + ((new Date(d).getTime() - t0) / (t1 - t0)) * (W - L - R));
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const ticks = 4, grid = [];
    for (let i = 0; i <= ticks; i++) {
      const v = lo + ((hi - lo) * i) / ticks;
      const lbl = mode === 'value' ? (Math.abs(v) >= 1e6 ? (v / 1e6).toLocaleString('de-DE', { maximumFractionDigits: 2 }) + ' Mio.' : Math.round(v / 1000).toLocaleString('de-DE') + ' T') : fmtPct(v, 1);
      grid.push(`<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${lbl}</text>`);
    }
    if (mode === 'perf') grid.push(`<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="var(--muted)" stroke-dasharray="3 4"/>`);
    const xl = points.length === 1 ? [points[0]] : [points[0], points[Math.floor(points.length / 2)], points[points.length - 1]].filter((p, i, a) => a.indexOf(p) === i);
    const xlabels = xl.map((p) => `<text x="${x(p.date)}" y="${H - 8}" text-anchor="middle">${fmtDateShort(p.date)}</text>`).join('');
    const color = mode === 'perf' ? ((points[points.length - 1].index - 1) >= 0 ? 'var(--up)' : 'var(--down)') : 'var(--accent)';
    const val = (p) => (mode === 'value' ? p.value : p.index - 1);
    const xs = points.map((p) => +x(p.date).toFixed(1)), ys = points.map((p) => +y(val(p)).toFixed(1));
    const path = xs.map((px, i) => `${i ? 'L' : 'M'}${px},${ys[i]}`).join(' ');
    const base = mode === 'perf' ? y(0) : H - B;
    const area = points.length > 1 ? `${path} L${xs[xs.length - 1]},${base} L${xs[0]},${base} Z` : '';
    // Punkte nur für exakte Stände aus PDFs; Diagrammwerte sind nur Linie
    const dots = points.map((p, i) => (p.approx ? '' : `<circle cx="${xs[i]}" cy="${ys[i]}" r="4.5" fill="var(--card)" stroke="${color}" stroke-width="2.5"/>`)).join('');
    const geo = JSON.stringify({ W, xs, ys });
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Verlauf" data-geo='${geo}'>
      ${grid.join('')}${xlabels}
      ${points.length > 1 ? `<path d="${area}" fill="${color}" opacity=".08"/><path d="${path}" fill="none" stroke="${color}" stroke-width="2.25" stroke-linejoin="round"/>` : ''}
      ${dots}
      <line class="cursor" y1="${T}" y2="${H - B}" stroke="var(--muted)" stroke-dasharray="3 3" style="display:none"/>
      <circle class="cursor-dot" r="5" fill="${color}" style="display:none"/></svg>`;
  }

  // ---------- Bausteine ----------
  function changeChip(label, ch, emptyText) {
    if (!ch) return `<div class="chip"><div class="k">${label}</div><div class="v muted">–</div><div class="e">${emptyText}</div></div>`;
    return `<div class="chip"><div class="k">${label} (${fmtDate(ch.since)})</div><div class="v ${cls(ch.pct)}">${fmtPct(ch.pct)}</div>
      <div class="e">Vermögen ${fmtSignedEur(ch.eur)}</div></div>`;
  }
  const pill = (x) => `<span class="pill ${cls(x)}">${fmtPct(x)}</span>`;

  // ---------- Ansichten ----------
  function render() {
    charts.clear();
    renderInner();
    wireCharts();
  }
  function renderInner() {
    const model = E.buildModel(state.data.snapshots, state.data.depotMeta);
    if (!model.depots.length) {
      const s = state.view.name === 'slot' && slotList(model).find((x) => x.id === state.view.id);
      return s ? renderSlot(model, s) : renderStart(model);
    }
    if (state.view.name === 'depot') {
      const d = model.depots.find((x) => x.id === state.view.id);
      if (d) return renderDepot(model, d);
      state.view = { name: 'home' };
    }
    if (state.view.name === 'slot') {
      const s = slotList(model).find((x) => x.id === state.view.id);
      if (s && s.depot) return renderDepot(model, s.depot);
      if (s) return renderSlot(model, s);
      state.view = { name: 'home' };
    }
    if (state.view.name === 'manage') return renderManage(model);
    renderHome(model);
  }

  // Start ohne Daten: gleiche Struktur wie später, dazu Beispiel zum Ausprobieren
  function renderStart(m) {
    $app.innerHTML = `
      ${topBar()}
      ${depotTabs(m, 'home')}
      <div class="card empty">
        <h1>Alle Depots auf einen Blick</h1>
        <p>Füge eine Depot-Übersicht als PDF hinzu. EasyDepot liest die Positionen und rechnet aus, wie sich das Vermögen entwickelt, ohne dass Käufe als Gewinn zählen.</p>
        <div class="actions" style="justify-content:center">
          <button data-act="pick">PDF hinzufügen</button>
          <button class="soft" data-act="demo">Beispiel ansehen</button>
        </div>
        <p class="muted small" style="margin-top:10px">„Beispiel ansehen“ zeigt erfundene Zahlen, damit du alles ausprobieren kannst. Sie verschwinden, sobald du ein echtes PDF hinzufügst.</p>
        <div class="howto muted">
          <b>So bekommst du das PDF von myWealth</b>
          <ol>
            <li>Bei myWealth anmelden und die Seite <b>Anlageziel</b> öffnen.</li>
            <li>Bis ganz unten scrollen, damit alle Positionen geladen sind.</li>
            <li>Mac: <b>Ablage → Drucken → PDF → Als PDF sichern</b>.<br>iPad: <b>Teilen → Drucken</b>, dann oben <b>Teilen → In Dateien sichern</b>.</li>
            <li>Hier auf <b>PDF hinzufügen</b> tippen und die Datei auswählen.</li>
          </ol>
        </div>
      </div>
      ${privacyNote()}`;
  }

  function topBar(back) {
    return `<header class="top">
      ${back ? '<button class="ghost back" data-act="home">‹ Übersicht</button>' : '<div class="brand"><img src="icon.svg" alt=""><b>Easy<span>Depot</span></b></div>'}
      <button data-act="pick">PDF hinzufügen</button></header>
      ${state.data.snapshots.some((s) => s.demo) ? `<div class="note demo-bar"><span><b>Beispieldaten</b> – erfundene Zahlen zum Ausprobieren.</span><button class="ghost" data-act="undemo">Beispiel entfernen</button></div>` : ''}
      ${storageOk ? '' : '<div class="note" style="margin-bottom:12px">Dieser Browser erlaubt kein dauerhaftes Speichern. Die Daten gehen beim Schließen verloren – bitte „Sicherung speichern“ nutzen.</div>'}`;
  }
  function privacyNote() {
    return `<p class="privacy">Die PDFs werden nur auf diesem Gerät gelesen. Nichts wird hochgeladen.</p>`;
  }

  function renderHome(m) {
    const n = m.depots.length;
    const series = state.chartDepot === 'all' ? m.total : (m.depots.find((d) => d.id === state.chartDepot)?.series || m.total);
    const oldest = m.depots.reduce((a, d) => (d.latest.date < a ? d.latest.date : a), m.latestDate);
    $app.innerHTML = `
      ${topBar()}
      ${depotTabs(m, 'home')}
      <section class="card hero">
        <div class="label">Gesamtvermögen aller Depots · ${n} von ${slotList(m).length} erfasst · Stand ${fmtDate(m.latestDate)}</div>
        <div class="big">${fmtEur(m.value)}</div>
        <div class="chips">
          ${changeChip('Letzte 30 Tage', m.change30, 'braucht ältere Stände')}
          ${changeChip('Seit Beginn', m.changeStart, 'ab dem zweiten Stand')}
        </div>
        ${oldest < m.latestDate ? `<div class="note">Nicht alle Depots sind vom selben Tag. Ältester Stand: ${fmtDate(oldest)}.</div>` : ''}
      </section>

      <section class="card">
        <div class="row-between">
          <h2 style="margin:0">Verlauf</h2>
          ${modeSwitch()}
        </div>
        ${n > 1 ? `<div class="seg" style="margin-top:10px">${[['all', 'Alle'], ...m.depots.map((d) => [d.id, d.label])].map(([id, l]) => `<button class="${state.chartDepot === id ? 'on' : ''}" data-act="chartdepot" data-v="${esc(id)}">${esc(l)}</button>`).join('')}</div>` : ''}
        ${chartBlock(series, state.chartMode)}
        ${chartNote(series, m.approx)}
      </section>

      <section class="section">
        <h2>Depots</h2>
        <div class="depots">
          ${slotList(m).map(({ depot: d, ...s }) => !d ? `
            <button class="card depot placeholder" data-act="slot" data-v="${esc(s.id)}">
              <div><div class="name">${esc(s.label)}</div><div class="sub">${esc(s.sub)}</div></div>
              <div><div class="val muted">–</div><div class="chg"><span class="pill neutral">Platzhalter</span></div></div>
              <div class="sub" style="grid-column:1 / -1">Lorem ipsum dolor sit amet, consectetur.</div>
            </button>` : `
            <button class="card depot" data-act="depot" data-v="${esc(d.id)}">
              <div><div class="name">${esc(s.label)}</div><div class="sub">${esc(d.custodian || '')}${d.depotNr ? ' · ' + esc(d.depotNr) : ''}</div></div>
              <div><div class="val">${fmtEur(d.value)}</div><div class="chg">${d.change30 ? pill(d.change30.pct) + ' <span class="sub">30 Tage</span>' : d.changeStart ? pill(d.changeStart.pct) : '<span class="pill neutral">1. Stand</span>'}</div></div>
              <div class="sub">Stand ${fmtDate(d.latest.date)} · ${d.latest.positions.length} Positionen</div>
              <div class="sub" style="text-align:right">${fmtNum((d.value / m.value) * 100, 0)} % vom Gesamt</div>
              <div class="share"><i style="width:${(d.value / m.value) * 100}%"></i></div>
            </button>`).join('')}
        </div>
      </section>
      ${footerTools()}
      ${privacyNote()}`;
  }

  function renderDepot(m, d) {
    const rows = E.positionRows(d);
    const hasChange = !!d.prevSnap;
    const sorters = {
      value: (a, b) => b.value - a.value,
      up: (a, b) => (b.changePct ?? b.lastBuy?.pct ?? -9) - (a.changePct ?? a.lastBuy?.pct ?? -9),
      down: (a, b) => (a.changePct ?? a.lastBuy?.pct ?? 9) - (b.changePct ?? b.lastBuy?.pct ?? 9),
    };
    rows.sort(sorters[state.sort] || sorters.value);
    const alloc = E.allocation(d.latest);
    const colors = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];
    const tx = d.latest.transactions || [];
    const posMap = new Map(d.latest.positions.map((p) => [p.isin, p]));
    const anyBuy = rows.some((r) => r.lastBuy);

    const pl = d.plan;
    $app.innerHTML = `
      ${topBar()}
      ${depotTabs(m, d.id)}
      <section class="card hero">
        <div class="label">${esc(d.custodian || d.label)} · Depot ${esc(d.depotNr || '')} · Stand ${fmtDate(d.latest.date)}</div>
        <div class="big">${fmtEur(d.value)}</div>
        <div class="chips">
          ${changeChip('Letzte 30 Tage', d.change30, 'braucht ältere Stände')}
          ${changeChip('Seit Beginn', d.changeStart, 'ab dem zweiten Stand')}
          <div class="chip"><div class="k">Wertpapiere</div><div class="v">${fmtEur(d.latest.securitiesTotal)}</div><div class="e">${d.latest.positions.length} Positionen</div></div>
          <div class="chip"><div class="k">Konto</div><div class="v">${fmtEur(d.latest.cashTotal)}</div><div class="e">${fmtNum((d.latest.cashTotal / d.value) * 100, 1)} % vom Depot</div></div>
        </div>
      </section>

      <section class="card">
        <div class="row-between">
          <h2 style="margin:0">Verlauf</h2>
          ${modeSwitch()}
        </div>
        ${chartBlock(d.series, state.chartMode)}
        ${chartNote(d.series, d.approx)}
      </section>

      ${pl ? `<section class="card section">
        <h2>Plan und Wirklichkeit</h2>
        <div class="plan">
          <div><div class="k">Laut Plan heute</div><div class="v">${fmtEur(pl.expected)}</div>
            <div class="e">${fmtEur(pl.startAmount)} ab ${fmtDate(pl.startDate)}, ${fmtNum(pl.targetReturn * 100, 1)} % pro Jahr</div></div>
          <div><div class="k">Tatsächlich</div><div class="v">${fmtEur(pl.actual)}</div>
            <div class="e">${fmtPct(pl.sinceStartPct)} gegenüber dem Startbetrag</div></div>
          <div><div class="k">Abstand zum Plan</div><div class="v ${cls(pl.gap)}">${fmtSignedEur(pl.gap)}</div>
            <div class="e">${pl.gap < 0 ? 'liegt unter dem Plan' : 'liegt über dem Plan'}</div></div>
        </div>
        <p class="muted small" style="margin:12px 0 0">Die Zielrendite gilt laut myWealth „nach Kosten und Steuern“ und ist ein Durchschnitt über ${fmtNum(pl.horizonYears || 0, 0)} Jahre. Nach ${pl.years < 1 ? Math.round(pl.years * 12) + ' Monaten' : fmtNum(pl.years, 1) + ' Jahren'} sagt der Abstand noch wenig. Angenommen: kein Geld ein- oder ausgezahlt seit dem Start.
        ${pl.goalAmount ? `<br>Ziel im Plan: ${fmtEur(pl.goalAmount)} mit ${pl.goalAge} Jahren.` : ''}
        ${pl.product ? `<br>${esc(pl.product)}${pl.advisor ? ` · Betreuung: ${esc(pl.advisor)}` : ''}` : ''}</p>
      </section>` : ''}

      <section class="card section">
        <h2>Aufteilung</h2>
        <div class="alloc">${alloc.map((a, i) => `<i style="width:${a.share * 100}%;background:${colors[i % colors.length]}" title="${esc(a.label)}"></i>`).join('')}</div>
        <div class="legend">${alloc.map((a, i) => `<span><b style="background:${colors[i % colors.length]}"></b>${esc(a.label)} <span class="muted">${fmtNum(a.share * 100, a.share < 0.02 ? 1 : 0)} % · ${fmtEur(a.value)}</span></span>`).join('')}</div>
      </section>

      <section class="card section">
        <div class="row-between" style="margin-bottom:6px">
          <h2 style="margin:0">Positionen</h2>
          <div class="seg">
            <button class="${state.sort === 'value' ? 'on' : ''}" data-act="sort" data-v="value">Größte</button>
            <button class="${state.sort === 'up' ? 'on' : ''}" data-act="sort" data-v="up">Steigt</button>
            <button class="${state.sort === 'down' ? 'on' : ''}" data-act="sort" data-v="down">Fällt</button>
          </div>
        </div>
        ${!hasChange ? `<p class="muted small" style="margin:4px 0 8px">Erster Stand: Die Veränderung pro Position erscheint ab dem nächsten PDF.${anyBuy ? ' Bei kürzlich gekauften Positionen siehst du schon jetzt, wie sie sich seit dem Kauf entwickelt haben.' : ''}</p>` : ''}
        <table>
          <thead><tr><th>Wertpapier</th><th class="hide-sm">Stück</th><th class="hide-sm">Kurs</th><th>Wert</th><th class="hide-sm">Anteil</th><th>${hasChange ? 'Seit letztem Stand' : 'Seit Kauf'}</th></tr></thead>
          <tbody>${rows.map((r) => `
            <tr>
              <td><div class="nm">${esc(r.name)}</div><div class="meta">${esc(r.isin || '')}${r.category ? ' · ' + esc(r.category) : ''}</div></td>
              <td class="hide-sm">${fmtNum(r.qty, r.qty % 1 ? 2 : 0)}</td>
              <td class="hide-sm">${fmtNum(r.price)} ${esc(r.priceCcy === 'EUR' ? '€' : r.priceCcy)}</td>
              <td>${fmtEur(r.value)}</td>
              <td class="hide-sm">${fmtNum(r.weight, 1)} %</td>
              <td>${hasChange
                ? (r.isNew ? '<span class="pill new">neu</span>' : pill(r.changePct))
                : (r.lastBuy ? `${pill(r.lastBuy.pct)}<div class="meta">Kauf ${fmtDateShort(r.lastBuy.date)} zu ${fmtNum(r.lastBuy.price)} €</div>` : '<span class="muted">–</span>')}</td>
            </tr>`).join('')}</tbody>
        </table>
      </section>

      ${tx.length ? `<section class="card section">
        <h2>Letzte Bewegungen</h2>
        <p class="muted small" style="margin:-6px 0 6px">Was die Vermögensverwaltung zuletzt gekauft und verkauft hat${d.latest.transactionsInfo ? ` (${d.latest.transactionsInfo.shown} von ${d.latest.transactionsInfo.total} im PDF sichtbar)` : ''}.</p>
        ${tx.map((t) => {
          const isBuy = t.qty > 0 && /Kauf/i.test(t.type), isSell = t.qty < 0;
          const cur = posMap.get(t.isin);
          const since = (isBuy || isSell) && cur && t.price ? cur.price / t.price - 1 : null;
          return `<div class="tx">
            <div class="d">${fmtDate(t.date)}</div>
            <div><span class="pill ${isBuy ? 'new' : isSell ? 'neutral' : 'up'}">${esc(t.type)}</span> ${esc(t.name)}</div>
            <div class="a">${t.amount != null ? fmtEur(Math.abs(t.amount)) : ''}</div>
            <div class="x">${t.qty != null && (isBuy || isSell) ? `${fmtNum(Math.abs(t.qty), 0)} Stück zu ${fmtNum(t.price)} ${t.priceCcy === 'EUR' ? '€' : esc(t.priceCcy || '')}` : ''}${since != null ? ` · heute ${fmtNum(cur.price)} € (${fmtPct(since, 1)})` : ''}</div>
          </div>`;
        }).join('')}
      </section>` : ''}
      ${privacyNote()}`;
  }

  function renderManage(m) {
    const snaps = [...state.data.snapshots].sort((a, b) => (a.date < b.date ? 1 : -1));
    $app.innerHTML = `
      ${topBar(true)}
      <section class="card">
        <h2>Gespeicherte Stände</h2>
        <div class="snaplist">${snaps.map((s) => `
          <div class="s"><div><b>${esc(m.depots.find((d) => d.id === s.depotId)?.label || s.bank)}</b> · ${fmtDate(s.date)}
            <div class="muted small">${fmtEur(s.total)} · ${s.positions.length} Positionen · ${esc(s.fileName || '')}</div></div>
            <button class="danger" data-act="delsnap" data-v="${esc(s.id)}">Löschen</button></div>`).join('')}</div>
      </section>
      <section class="card section">
        <h2>Sicherung</h2>
        <p class="muted small">Die Daten liegen nur in diesem Browser auf diesem Gerät. Eine Sicherung ist eine kleine Datei, die du z. B. in iCloud ablegen und auf einem anderen Gerät wieder laden kannst.</p>
        <div class="actions" style="justify-content:flex-start">
          <button class="soft" data-act="backup">Sicherung speichern</button>
          <button class="soft" data-act="restore">Sicherung laden</button>
          <button class="danger" data-act="wipe">Alles löschen</button>
        </div>
      </section>`;
  }

  function modeSwitch() {
    return `<div class="seg" role="tablist">
      <button class="${state.chartMode === 'value' ? 'on' : ''}" data-act="mode" data-v="value">Vermögen €</button>
      <button class="${state.chartMode === 'perf' ? 'on' : ''}" data-act="mode" data-v="perf">Wertentwicklung %</button></div>`;
  }
  function chartNote(series, approx) {
    if (series.length < 2) return '<div class="chart-note">Ab dem zweiten Stand entsteht hier eine Kurve. Am besten einmal im Monat ein neues PDF hinzufügen.</div>';
    const what = state.chartMode === 'value'
      ? 'Vermögen in Euro, inklusive Ein- und Auszahlungen.'
      : 'Nur die Wertentwicklung: Käufe und Umschichtungen zählen hier nicht als Gewinn.';
    const src = approx ? ' Tageswerte aus dem myWealth-Diagramm zurückgerechnet (ca.), Punkte = exakte Stände aus PDFs.' : '';
    return `<div class="chart-note">${what}${src}<br><span class="small">Zum Ablesen mit dem Finger über die Linie fahren.</span></div>`;
  }
  // Die drei Depots des Schwagers – feste Reihenfolge, auch wenn noch kein PDF da ist
  const SLOTS = [
    { id: 'ing', label: 'ING', sub: 'Direkt-Depot', match: (d) => /ing/i.test(d.bank || '') },
    { id: 'hvb', label: 'HypoVereinsbank', sub: 'Vermögensverwaltung', match: (d) => /hypo|hvb|unicredit/i.test(d.bank || '') },
    { id: 'mywealth', label: 'myWealth', sub: 'Deutsche Wertpapiertreuhand', match: (d) => d.latest.source === 'mywealth' },
  ];
  const LOREM = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.';
  function slotList(m) {
    const used = new Set();
    const list = SLOTS.map((s) => {
      const d = m.depots.find((x) => !used.has(x.id) && s.match(x)) || null;
      if (d) used.add(d.id);
      return { ...s, depot: d };
    });
    for (const d of m.depots) if (!used.has(d.id)) list.push({ id: d.id, label: d.label, sub: d.custodian || '', depot: d });
    return list;
  }

  // Wechsel zwischen "Alle Depots" und den einzelnen Depots – immer sichtbar
  function depotTabs(m, currentKey) {
    const items = [{ key: 'home', label: 'Alle Depots', val: fmtEur(m.value), act: 'home' }]
      .concat(slotList(m).map((s) => s.depot
        ? { key: s.depot.id, label: s.label, val: fmtEur(s.depot.value), act: 'depot', v: s.depot.id }
        : { key: 'slot:' + s.id, label: s.label, val: 'noch leer', act: 'slot', v: s.id, empty: true }));
    return `<nav class="tabs" aria-label="Depot wählen">${items.map((t) =>
      `<button class="${t.key === currentKey ? 'on' : ''} ${t.empty ? 'empty' : ''}" data-act="${t.act}" data-v="${esc(t.v || '')}">
        <span class="t">${esc(t.label)}</span><span class="tv">${esc(t.val)}</span></button>`).join('')}</nav>`;
  }

  function renderSlot(m, s) {
    $app.innerHTML = `
      ${topBar()}
      ${depotTabs(m, 'slot:' + s.id)}
      <section class="card hero">
        <div class="label">${esc(s.label)} · ${esc(s.sub)}</div>
        <div class="big muted">noch keine Daten</div>
        <p class="muted">${LOREM}</p>
        <div class="note">Platzhalter: Das Einlesen von ${esc(s.label)}-PDFs ist noch nicht eingebaut. Dafür brauche ich eine Depotübersicht als Beispiel-PDF.</div>
      </section>
      <section class="card section">
        <h2>Positionen</h2>
        <p class="muted">${LOREM} Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.</p>
      </section>
      ${privacyNote()}`;
  }

  function footerTools() {
    return `<footer class="tools"><button class="ghost" data-act="manage">Stände & Sicherung</button></footer>`;
  }

  // ---------- Aktionen ----------
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const v = b.dataset.v;
    switch (b.dataset.act) {
      case 'pick': document.getElementById('file').click(); break;
      case 'accept': acceptPending(); break;
      case 'skip': state.pending.shift(); renderPending(); break;
      case 'mode': state.chartMode = v; render(); break;
      case 'chartdepot': state.chartDepot = v; render(); break;
      case 'depot': state.view = { name: 'depot', id: v }; state.sort = 'value'; render(); window.scrollTo(0, 0); break;
      case 'home': state.view = { name: 'home' }; render(); window.scrollTo(0, 0); break;
      case 'slot': state.view = { name: 'slot', id: v }; render(); window.scrollTo(0, 0); break;
      case 'demo': state.data.snapshots = state.data.snapshots.filter((s) => !s.demo).concat([makeDemo()]); save(); state.view = { name: 'home' }; render(); break;
      case 'undemo': state.data.snapshots = state.data.snapshots.filter((s) => !s.demo); save(); state.view = { name: 'home' }; render(); break;
      case 'manage': state.view = { name: 'manage' }; render(); window.scrollTo(0, 0); break;
      case 'sort': state.sort = v; render(); break;
      case 'delsnap':
        if (confirm('Diesen Stand löschen?')) { state.data.snapshots = state.data.snapshots.filter((s) => s.id !== v); save(); render(); }
        break;
      case 'backup': {
        const blob = new Blob([JSON.stringify(state.data, null, 1)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `EasyDepot-Sicherung-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        break;
      }
      case 'restore': document.getElementById('restore').click(); break;
      case 'wipe':
        if (confirm('Wirklich alle Stände löschen? Das lässt sich nicht rückgängig machen.')) { state.data = { snapshots: [], depotMeta: {} }; save(); state.view = { name: 'home' }; render(); }
        break;
    }
  });

  document.getElementById('file').addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
  document.getElementById('restore').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!Array.isArray(d.snapshots)) throw new Error();
      if (!confirm(`Sicherung mit ${d.snapshots.length} Ständen laden? Die aktuellen Daten werden ersetzt.`)) return;
      state.data = { snapshots: d.snapshots, depotMeta: d.depotMeta || {} }; save(); state.view = { name: 'home' }; render();
    } catch { alert('Diese Datei ist keine EasyDepot-Sicherung.'); }
  });

  // Ziehen & Ablegen (Mac)
  const drop = document.getElementById('drop');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; drop.classList.add('on'); e.preventDefault(); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) drop.classList.remove('on'); });
  window.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; drop.classList.remove('on'); if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files); });

  let rT = null, lastW = window.innerWidth;
  window.addEventListener('resize', () => {
    if (Math.abs(window.innerWidth - lastW) < 40) return;
    lastW = window.innerWidth;
    clearTimeout(rT); rT = setTimeout(() => { if (!state.pending.length) render(); }, 200);
  });

  render();
})();
