/* EasyDepot – PDF-Leser
 * Läuft im Browser (window.EasyParser) und in Node (module.exports) für Tests.
 * Eingabe ist immer ein Array von Textzeilen über alle Seiten.
 */
(function (root) {
  'use strict';

  // ---------- Hilfen ----------
  const ISIN_RE = /\b([A-Z]{2}[A-Z0-9]{9}\d)\b/;
  const QTY_RE = /^-?[\d.]+,\d+$/;                 // 8.800,00
  const MONEY_RE = /^(-?[\d.]+,\d+)\s*([A-Z]{3})$/; // 86,01 EUR
  const PCT_RE = /^(-?[\d.]+,\d+)\s*%$/;           // 15,38 %
  const DATE_RE = /^(\d{2})\.(\d{2})\.(\d{4})$/;    // 20.11.2026

  function num(s) {
    const m = String(s).match(/-?[\d.]+,\d+|-?\d+/);
    if (!m) return NaN;
    return parseFloat(m[0].replace(/\./g, '').replace(',', '.'));
  }
  function money(s) {
    const m = String(s).match(MONEY_RE);
    return m ? { value: num(m[1]), ccy: m[2] } : null;
  }
  function isoDate(s) {
    const m = String(s).match(DATE_RE);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  }
  function joinName(lines) {
    let out = '';
    for (const l of lines) {
      if (!out) out = l;
      else if (/[A-Za-zÄÖÜäöüß]-$/.test(out)) out += l;   // "All-" + "World" -> "All-World"
      else out += ' ' + l;
    }
    return out.replace(/\s+/g, ' ').trim();
  }
  const round2 = (x) => Math.round(x * 100) / 100;

  // ---------- Erkennung ----------
  function detect(lines) {
    const text = lines.join('\n');
    if (/wertpapiertreuhand\.de\/mywealth/i.test(text) && /Gesamt Wertpapiere/.test(text)) return 'mywealth';
    return null;
  }

  // ---------- myWealth (Deutsche Wertpapiertreuhand, Webseite gedruckt) ----------
  function parseMyWealth(rawLines, pages) {
    const warnings = [];

    // 1) Kopf- und Fußzeilen des Browserdrucks entfernen, Druckzeitpunkt merken
    let printedAt = null, pageTitle = null;
    const PRINT_TS = /^(\d{2})\.(\d{2})\.(\d{2}), (\d{2}):(\d{2})$/;
    for (let i = 0; i < rawLines.length; i++) {
      const m = rawLines[i].match(PRINT_TS);
      if (m) {
        printedAt = `20${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}`;
        pageTitle = rawLines[i + 1] || null;
        break;
      }
    }
    const lines = rawLines.filter((l) =>
      !PRINT_TS.test(l) &&
      !/^https?:\/\//.test(l) &&
      !/^\d+\/\d+$/.test(l) &&
      !(pageTitle && l === pageTitle)
    );

    // 2) Kopf: Anlagestrategie, Depot, Konto
    const head = {};
    const iStrat = lines.indexOf('Anlagestrategie');
    if (iStrat >= 0) {
      head.total = money(lines[iStrat + 1])?.value;
      head.strategy = lines[iStrat + 2];
      let j = iStrat + 3;
      let dm = lines[j].match(/^Depot\s*(\d+)?$/);
      if (dm) {
        head.depotNr = dm[1] || lines[++j];
        head.securities = money(lines[++j])?.value;
        j++;
      }
      let km = (lines[j] || '').match(/^Konto\s*(\d+)?$/);
      if (km) {
        head.kontoNr = km[1] || lines[++j];
        head.cash = money(lines[++j])?.value;
      }
    }
    if (!head.depotNr) {
      const m = lines.join(' ').match(/Depot\s+(\d{6,})/);
      if (m) head.depotNr = m[1];
    }

    // 3) Positionen: von der ersten Tabellenüberschrift bis "Geldkonten"
    const iPosStart = lines.indexOf('Bezeichnung');
    const iPosEnd = lines.indexOf('Geldkonten', iPosStart);
    const TABLE_HEAD = new Set(['Bezeichnung', 'Nennwert', 'Marktkurs', 'Wert', 'Gewichtung']);
    let securitiesTotal = null;
    const posLines = [];
    for (let i = iPosStart; i >= 0 && i < iPosEnd; i++) {
      const l = lines[i];
      if (TABLE_HEAD.has(l)) continue;
      if (l === 'Gesamt Wertpapiere') {       // klebt im Druck auf jeder Seite
        securitiesTotal = money(lines[i + 1])?.value ?? securitiesTotal;
        i += 2;
        continue;
      }
      posLines.push(l);
    }

    // Zeilen zu Tabellenzeilen bündeln: Text … Stück, Kurs, Wert, Gewicht
    const rows = [];
    let text = [];
    for (let i = 0; i < posLines.length; i++) {
      const a = posLines[i], b = posLines[i + 1], c = posLines[i + 2], d = posLines[i + 3];
      if (QTY_RE.test(a) && money(b) && money(c) && PCT_RE.test(d || '')) {
        rows.push({ text, qty: num(a), price: money(b), value: money(c).value, weight: num(d) });
        text = [];
        i += 3;
      } else {
        text.push(a);
      }
    }
    if (text.length) rows.push({ text, orphan: true });

    // Seitenumbruch: Zeile ohne ISIN -> ISIN steht am Anfang der nächsten Zeile
    const CAT_RE = /(fonds|Fonds)$|^(Ausland|Inland|Multidirektionale|Gemischte|Sonstige|Offene)$/;
    for (let r = 0; r < rows.length - 1; r++) {
      const row = rows[r];
      if (row.orphan || row.text.some((l) => ISIN_RE.test(l))) continue;
      const next = rows[r + 1];
      if (next.text.length && ISIN_RE.test(next.text[0])) {
        let k = 1;
        while (k < next.text.length && k <= 3 && CAT_RE.test(next.text[k])) k++;
        row.text = row.text.concat(next.text.slice(0, k));
        next.text = next.text.slice(k);
      }
    }

    const positions = [];
    for (const row of rows) {
      if (row.orphan) { if (row.text.length) warnings.push('Unzugeordneter Text in der Positionstabelle: ' + row.text.join(' ')); continue; }
      const iIsin = row.text.findIndex((l) => ISIN_RE.test(l));
      if (iIsin < 0) { warnings.push('Position ohne ISIN: ' + joinName(row.text)); }
      const isin = iIsin >= 0 ? row.text[iIsin].match(ISIN_RE)[1] : null;
      const nameLines = iIsin >= 0 ? row.text.slice(0, iIsin) : row.text;
      const afterPipe = iIsin >= 0 ? row.text[iIsin].split('|')[1]?.trim() : '';
      const catLines = iIsin >= 0 ? row.text.slice(iIsin + 1) : [];
      positions.push({
        isin,
        name: joinName(nameLines),
        category: joinName([afterPipe, ...catLines].filter(Boolean)) || null,
        qty: row.qty,
        price: row.price.value,
        priceCcy: row.price.ccy,
        value: row.value,
        weight: row.weight,
      });
    }

    // 4) Geldkonten
    const cash = [];
    let cashTotal = null;
    const iCashTot = lines.indexOf('Gesamt Geldkonten', iPosEnd);
    if (iPosEnd >= 0 && iCashTot > 0) {
      cashTotal = money(lines[iCashTot + 1])?.value ?? null;
      const seg = lines.slice(iPosEnd + 1, iCashTot).filter((l) => !['Währung', 'Saldo', 'Gewichtung'].includes(l));
      for (let i = 0; i + 3 < seg.length + 1; i++) {
        if (/^[A-Z]{3}$/.test(seg[i + 1] || '') && money(seg[i + 2] || '') && PCT_RE.test(seg[i + 3] || '')) {
          cash.push({ name: seg[i], ccy: seg[i + 1], value: money(seg[i + 2]).value, weight: num(seg[i + 3]) });
          i += 3;
        }
      }
    }
    let total = null;
    const iTot = lines.indexOf('Gesamtes Portfolio');
    if (iTot >= 0) total = money(lines[iTot + 1])?.value ?? null;

    // 5) Transaktionen im Depot (nur die im Druck sichtbaren)
    const TX_HEAD = new Set(['Transaktionen', 'Suchen', 'Valutadatum', 'Transaktionsart', 'ISIN', 'Wertpapier',
      'Einheit', 'Anzahl', 'Marktkurs', 'Handel', 'Markt', 'Verwendungszweck', 'Buchungswert', 'Euro']);
    const iTx1 = lines.indexOf('Transaktionen');
    const iKonto2 = lines.findIndex((l, i) => i > iTx1 && /^IBAN\b/.test(l));
    const iTx2 = iKonto2 > 0 ? lines.indexOf('Transaktionen', iKonto2) : -1;
    let txCountInfo = null;

    function txSegment(from, to) {
      const seg = [];
      for (let i = from; i >= 0 && i < to; i++) {
        const l = lines[i];
        if (TX_HEAD.has(l)) continue;
        const m = l.match(/^(\d+) bis (\d+) von (\d+)$/);
        if (m) { txCountInfo = txCountInfo || { shown: +m[2], total: +m[3] }; continue; }
        if (/^\d+$/.test(l)) continue;                    // Seitengrößen-Auswahl "10"
        if (/^(\d{1,2}\. [A-Za-zäöü]+|[\d,]+ Mio\.|\d{1,3}(\.\d{3})+)$/.test(l)) continue; // Achsen des Verlaufsdiagramms
        seg.push(l);
      }
      return seg;
    }

    const transactions = [];
    if (iTx1 >= 0) {
      const end = iKonto2 > 0 ? lines.findIndex((l, i) => i > iTx1 && /^Konto\s*\d*$/.test(l)) : lines.length;
      const seg = txSegment(iTx1, end > 0 ? end : lines.length);
      let cur = null;
      for (let i = 0; i < seg.length; i++) {
        const l = seg[i];
        if (DATE_RE.test(l)) {
          cur = { date: isoDate(l), typeLines: [], isin: null, nameLines: [], unit: null, qty: null, price: null, priceCcy: null, amount: null };
          transactions.push(cur);
          continue;
        }
        if (!cur) continue;
        if (cur.amount !== null) { cur.nameLines.push(l); continue; } // Namensrest nach Seitenumbruch
        if (!cur.isin) {
          const m = l.match(ISIN_RE);
          if (m && l.trim() === m[1]) cur.isin = m[1]; else cur.typeLines.push(l);
          continue;
        }
        if (cur.unit === null) {
          if (/^(Stücke|Stück|Nominal)$/.test(l)) cur.unit = l; else cur.nameLines.push(l);
          continue;
        }
        if (cur.qty === null && QTY_RE.test(l)) { cur.qty = num(l); continue; }
        if (cur.price === null && money(l)) { const p = money(l); cur.price = p.value; cur.priceCcy = p.ccy; continue; }
        if (cur.amount === null && QTY_RE.test(l)) { cur.amount = num(l); continue; }
        cur.nameLines.push(l);
      }
    }
    // Vorzeichen nach Art setzen – das Minuszeichen ist im Druck nicht immer lesbar
    const tx = transactions.map((t) => {
      const type = joinName(t.typeLines);
      const sign = /Verkauf|Abgang|Auslieferung/i.test(type) ? -1 : /Kauf|Zugang|Einlieferung/i.test(type) ? 1 : 0;
      const abs = (x) => (x == null ? null : Math.abs(x));
      return {
        date: t.date,
        type,
        isin: t.isin,
        name: joinName(t.nameLines),
        qty: sign ? sign * abs(t.qty) : abs(t.qty),
        price: t.price,
        priceCcy: t.priceCcy,
        amount: sign ? sign * abs(t.amount) : abs(t.amount),
      };
    });

    // 6) Kontobewegungen (für Ein- und Auszahlungen)
    const cashTx = [];
    if (iTx2 >= 0) {
      const seg = txSegment(iTx2, lines.length);
      let cur = null;
      for (const l of seg) {
        if (DATE_RE.test(l)) { cur = { date: isoDate(l), type: null, text: [], amount: null }; cashTx.push(cur); continue; }
        if (!cur) continue;
        if (cur.type === null) { cur.type = l; continue; }
        const m = money(l);
        if (m && m.ccy === 'EUR' && /EUR$/.test(l)) { if (cur.amount === null) cur.amount = m.value; continue; }
        cur.text.push(l);
      }
    }

    // 7) Prüfungen
    const sumPos = round2(positions.reduce((s, p) => s + p.value, 0));
    const sumCash = round2(cash.reduce((s, c) => s + c.value, 0));
    const checks = [];
    if (securitiesTotal != null) {
      const diff = round2(securitiesTotal - sumPos);
      checks.push({ ok: Math.abs(diff) < 1, label: 'Summe der Positionen', expected: securitiesTotal, got: sumPos, diff });
    }
    if (cashTotal != null) {
      checks.push({ ok: Math.abs(cashTotal - sumCash) < 1, label: 'Summe der Geldkonten', expected: cashTotal, got: sumCash, diff: round2(cashTotal - sumCash) });
    }
    if (total != null) {
      const got = round2(sumPos + sumCash);
      checks.push({ ok: Math.abs(total - got) < 1, label: 'Gesamtes Portfolio', expected: total, got, diff: round2(total - got) });
    }
    if (!positions.length) checks.push({ ok: false, label: 'Positionen gefunden', expected: '≥ 1', got: 0 });

    const date = printedAt ? printedAt.slice(0, 10) : null;
    if (!date) warnings.push('Kein Druckdatum gefunden – bitte Stand prüfen.');

    // 8) Investmentplan der Vermögensverwaltung
    const plan = parsePlan(lines);

    // 9) Verlauf aus den Diagrammen "Depot" und "Konto" zurückrechnen
    let history = null;
    if (pages && date) {
      try {
        history = chartHistory(pages, date, securitiesTotal ?? sumPos, cashTotal ?? sumCash, warnings);
      } catch (e) {
        warnings.push('Verlauf konnte nicht gelesen werden.');
      }
    }

    return {
      kind: 'snapshot',
      source: 'mywealth',
      bank: 'myWealth',
      custodian: head.strategy || null,
      depotId: 'mywealth-' + (head.depotNr || 'unbekannt'),
      depotNr: head.depotNr || null,
      date,
      printedAt,
      positions,
      cash,
      securitiesTotal: securitiesTotal ?? sumPos,
      cashTotal: cashTotal ?? sumCash,
      total: total ?? round2(sumPos + sumCash),
      transactions: tx,
      transactionsInfo: txCountInfo,
      cashTransactions: cashTx.map((c) => ({ date: c.date, type: c.type, text: joinName(c.text), amount: c.amount })),
      plan,
      history,
      checks,
      warnings,
    };
  }

  // ---------- Investmentplan ----------
  const MONTHS = { januar: 1, februar: 2, märz: 3, maerz: 3, april: 4, mai: 5, juni: 6, juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12 };
  function longDate(s) {
    const m = String(s).match(/^(\d{1,2})\.\s*([A-Za-zÄÖÜäöü]+)\s+(\d{4})$/);
    const mo = m && MONTHS[m[2].toLowerCase()];
    return mo ? `${m[3]}-${String(mo).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
  }
  function parsePlan(lines) {
    const after = (label) => { const i = lines.indexOf(label); return i >= 0 ? lines[i + 1] : null; };
    const plan = {};
    plan.goalName = after('Ziel') && lines.indexOf('Zieldefinition') >= 0 ? lines[lines.indexOf('Zieldefinition') + 2] || null : null;
    const z = lines.map((l) => l.match(/^Meine Zuversicht ([\d.,]+) EUR mit (\d+) Jahren/)).find(Boolean);
    if (z) { plan.goalAmount = num(z[1]); plan.goalAge = +z[2]; }
    const sd = after('Startdatum'); if (sd) plan.startDate = longDate(sd);
    const sb = after('Startbetrag'); if (sb && money(sb)) plan.startAmount = money(sb).value;
    const hz = after('Anlagehorizont'); if (hz && /Jahr/.test(hz)) plan.horizonYears = num(hz);
    const zr = lines.findIndex((l) => /^Ø Zielrendite/.test(l));
    if (zr >= 0 && PCT_RE.test(lines[zr + 1] || '')) plan.targetReturn = num(lines[zr + 1]) / 100;
    plan.priority = after('Priorität von Risiko und Rendite');
    const ip = lines.indexOf('Produkt'); if (ip >= 0) plan.product = lines[ip + 1];
    const ib = lines.indexOf('Betreuung');
    if (ib >= 0) { plan.advisor = lines[ib + 1]; plan.advisorRole = lines[ib + 2]; }
    return plan.startAmount || plan.targetReturn ? plan : null;
  }

  // ---------- Verlauf aus Diagrammen ----------
  // Die Webseite zeichnet den Wert von Depot und Konto als Linie. Aus den Achsenbeschriftungen
  // lässt sich jeder Punkt in Datum und Euro zurückrechnen (Werte "ca.", auf ±0,1 % genau).
  function axisValue(s) {
    const m = s.match(/^([\d.,]+)( Mio\.)?$/);
    if (!m) return null;
    const v = m[2] ? num(m[1]) * 1e6 : parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
    return isFinite(v) ? v : null;
  }
  function fit(xs, ys) {
    const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
    const b = sxy / sxx;
    const a = my - b * mx;
    const res = Math.max(...xs.map((x, i) => Math.abs(a + b * x - ys[i])));
    return { a, b, res };
  }
  function findCharts(pages, printDate) {
    const py = +printDate.slice(0, 4), pm = +printDate.slice(5, 7);
    const charts = [];
    pages.forEach((pg, pageNo) => {
      for (const path of pg.paths || []) {
        const pts = path.pts;
        if (pts.length < 30) continue;
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
        if (maxX - minX < 300) continue;
        if (pts.some((p, i) => i && p[0] < pts[i - 1][0] - 0.01)) continue;
        // Datumsachse unter dem Diagramm: "17. August"
        const dl = pg.lines.filter((l) => /^\d{1,2}\. [A-Za-zÄÖÜäöü]+$/.test(l.s) && MONTHS[l.s.split(' ')[1].toLowerCase()] &&
          l.y < minY + 2 && l.y > minY - 40 && l.x > minX - 40 && l.xEnd < maxX + 40);
        // Wertachse links: "0", "500.000", "1,5 Mio."
        const vl = pg.lines.filter((l) => l.xEnd <= minX + 2 && l.xEnd > minX - 60 && l.y > minY - 30 && l.y < maxY + 400 && axisValue(l.s) != null);
        if (dl.length < 2 || vl.length < 3) continue;
        // Jahr bestimmen: Monate nach dem Druckmonat gehören ins Vorjahr
        const dx = [], dt = [];
        for (const l of dl) {
          const [d, mn] = l.s.split(' ');
          const mo = MONTHS[mn.toLowerCase()];
          const yr = mo > pm ? py - 1 : py;
          dx.push((l.x + l.xEnd) / 2);
          dt.push(Date.UTC(yr, mo - 1, parseInt(d, 10)) / 864e5);
        }
        const tx = fit(dx, dt);
        const vy = fit(vl.map((l) => l.y + 0.35 * (l.h || 8)), vl.map((l) => axisValue(l.s)));
        if (tx.res > 2 || vy.res > Math.abs(vy.b) * 3) continue;
        // Welches Diagramm? Überschrift direkt darüber: "Depot …" / "Konto …", sonst Gesamtwert
        const above = pg.lines.filter((l) => l.y > maxY && l.y < maxY + 150).sort((a, b) => a.y - b.y).slice(0, 5).map((l) => l.s);
        const kind = above.some((s) => /^Konto\b/.test(s)) ? 'cash' : above.some((s) => /^Depot\b/.test(s)) ? 'securities' : 'total';
        charts.push({
          kind,
          pageNo,
          points: pts.map(([x, y]) => {
            const day = Math.round(tx.a + tx.b * x);
            return { date: new Date(day * 864e5).toISOString().slice(0, 10), value: vy.a + vy.b * y };
          }),
        });
      }
    });
    return charts;
  }
  function chartHistory(pages, printDate, secNow, cashNow, warnings) {
    const charts = findCharts(pages, printDate);
    if (!charts.length) return null;
    const dedupe = (pts) => { const m = new Map(); for (const p of pts) if (p.date <= printDate) m.set(p.date, p.value); return m; };
    const pick = (k) => charts.find((c) => c.kind === k);
    const cTot = pick('total'), cDep = pick('securities'), cKon = pick('cash');
    // Feinabgleich: der letzte Punkt muss dem heutigen exakten Wert entsprechen
    function calibrated(chart, now, label) {
      if (!chart) return null;
      const m = dedupe(chart.points);
      const last = [...m.values()].pop();
      if (now > 1000 && last > 0) {
        if (Math.abs(last / now - 1) < 0.03) { const f = now / last; for (const [d, v] of m) m.set(d, v * f); }
        else warnings.push(`Der Verlauf (${label}) passt nicht genau zum heutigen Wert und ist nur grob.`);
      }
      return m;
    }
    const tot = calibrated(cTot, secNow + cashNow, 'Gesamt');
    const dep = calibrated(cDep, secNow, 'Depot') || new Map();
    const kon = calibrated(cKon, cashNow, 'Konto') || new Map();
    const dates = [...new Set([...(tot ? tot.keys() : []), ...dep.keys(), ...kon.keys()])].sort();
    let lastK = 0, lastD = 0, lastT = 0;
    const out = [];
    for (const d of dates) {
      if (dep.has(d)) lastD = Math.max(0, dep.get(d));
      if (kon.has(d)) lastK = Math.max(0, kon.get(d));
      if (tot && tot.has(d)) lastT = Math.max(0, tot.get(d));
      out.push({ date: d, securities: Math.round(lastD), cash: Math.round(lastK), total: Math.round(tot ? lastT : lastD + lastK) });
    }
    const max = Math.max(...out.map((p) => p.total));
    const first = out.findIndex((p) => p.total > max * 0.05);   // vor der ersten Einzahlung ist alles 0
    const h = first >= 0 ? out.slice(first) : [];
    // heutigen exakten Stand anhängen
    if (h.length && h[h.length - 1].date !== printDate) h.push({ date: printDate, securities: Math.round(secNow), cash: Math.round(cashNow), total: Math.round(secNow + cashNow) });
    return h.length >= 3 ? { points: h, approx: true, source: 'Diagramm' } : null;
  }

  function parse(input) {
    const lines = Array.isArray(input) ? input : input.lines;
    const pages = Array.isArray(input) ? null : input.pages;
    const kind = detect(lines);
    if (kind === 'mywealth') return parseMyWealth(lines, pages);
    return { kind: 'unknown', checks: [{ ok: false, label: 'Dokument erkannt' }], warnings: ['Dieses PDF kenne ich noch nicht.'] };
  }

  // Textzeilen aus pdf.js-TextContent bauen (Browser und Node identisch)
  function itemsToLineObjs(items) {
    const out = [];
    let cur = null;
    for (const it of items) {
      if (!it.str) continue;
      const x = it.transform[4], y = it.transform[5];
      const gap = cur ? x - cur.xEnd : 0;
      if (!cur || Math.abs(y - cur.y) > 2 || gap > 12 || gap < -5) {
        if (cur) out.push(cur);
        cur = { y, x, xEnd: x, s: '', h: Math.hypot(it.transform[2], it.transform[3]) };
      }
      cur.s += it.str;
      if (it.str.trim()) cur.xEnd = x + (it.width || 0);   // Leerzeichen-Items sind im Druck oft riesig breit
      else cur.xEnd = Math.max(cur.xEnd, x);
    }
    if (cur) out.push(cur);
    return out.map((l) => ({ ...l, s: fixGlyphs(l.s).replace(/[\s  ]+/g, ' ').trim() })).filter((l) => l.s);
  }
  function itemsToLines(items) { return itemsToLineObjs(items).map((l) => l.s); }

  // Linienzüge einer Seite aus der pdf.js-Operatorliste (in Seitenkoordinaten)
  function extractPaths(opList, OPS) {
    const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const paths = [];
    const tp = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i], args = opList.argsArray[i];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform) ctm = mul(ctm, args);
      else if (fn === OPS.constructPath) {
        const [ops, coords] = args;
        let k = 0, cur = null;
        for (const op of ops) {
          if (op === OPS.moveTo) { if (cur && cur.length > 1) paths.push({ pts: cur }); cur = [tp(coords[k], coords[k + 1])]; k += 2; }
          else if (op === OPS.lineTo) { (cur = cur || []).push(tp(coords[k], coords[k + 1])); k += 2; }
          else if (op === OPS.curveTo) { (cur = cur || []).push(tp(coords[k + 4], coords[k + 5])); k += 6; }
          else if (op === OPS.curveTo2 || op === OPS.curveTo3) { (cur = cur || []).push(tp(coords[k + 2], coords[k + 3])); k += 4; }
          else if (op === OPS.rectangle) { k += 4; }
        }
        if (cur && cur.length > 1) paths.push({ pts: cur });
      }
    }
    return paths;
  }

  // Ein ganzes PDF lesen (pdf.js-Dokument) -> { lines, pages }
  async function readDocument(doc, OPS) {
    const pages = [];
    let lines = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      const objs = itemsToLineObjs(tc.items);
      let paths = [];
      try { paths = extractPaths(await page.getOperatorList(), OPS); } catch (e) { /* ohne Diagramme weiter */ }
      pages.push({ lines: objs, paths });
      lines = lines.concat(objs.map((l) => l.s));
    }
    return { lines, pages };
  }

  // Die myWealth-Webschrift legt einige Zeichen im Private-Use-Bereich ab.
  // Ermittelt am Druck vom 25.11.2026; unbekannte Zeichen werden entfernt.
  const PUA_MAP = { '': '(', '': ')', '': '-', '': ':', '': '+' };
  function fixGlyphs(s) {
    return s
      .replace(/[-]/g, (c) => PUA_MAP[c] ?? '')
      .replace(/[−‐‑–]/g, '-')
      .replace(/­/g, '');
  }

  const api = { parse, detect, parseMyWealth, itemsToLines, itemsToLineObjs, extractPaths, readDocument, _num: num };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EasyParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
