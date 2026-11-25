/* EasyDepot – Rechenlogik
 * Wertentwicklung aus Kursen, nicht aus dem Depotwert:
 * Ein Kauf über 100.000 € erhöht den Wert, aber nicht die Rendite.
 */
(function (root) {
  'use strict';

  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

  // Rendite eines Depots zwischen zwei Ständen, nur aus Kursbewegungen der gehaltenen Positionen.
  function periodReturn(s0, s1) {
    if (!s0.total) return 0;
    const now = new Map(s1.positions.map((p) => [p.isin || p.name, p]));
    let gain = 0;
    for (const p0 of s0.positions) {
      const key = p0.isin || p0.name;
      let p1Price = now.get(key)?.price;
      if (p1Price == null) {
        // inzwischen verkauft: Verkaufskurs aus den Transaktionen, sonst 0 % annehmen
        const sale = (s1.transactions || [])
          .filter((t) => t.isin === p0.isin && t.qty < 0 && t.date > s0.date && t.date <= s1.date && t.price)
          .sort(byDate).pop();
        p1Price = sale ? sale.price : p0.price;
      }
      if (p0.price) gain += p0.value * (p1Price / p0.price - 1);
    }
    return gain / s0.total;
  }

  // Verlauf eines Depots: exakte Stände aus PDFs plus ungefähre Tageswerte aus Diagrammen (myWealth).
  // Zwischen zwei exakten Ständen zählt die Kursentwicklung der Positionen,
  // bei Diagrammwerten das Verhältnis der Werte (setzt voraus: keine Ein-/Auszahlungen dazwischen).
  function depotSeries(snaps) {
    const s = [...snaps].sort(byDate);
    const pts = new Map();
    for (const snap of s) {
      for (const h of snap.history?.points || []) pts.set(h.date, { date: h.date, value: h.total, securities: h.securities, cash: h.cash, approx: true });
    }
    for (const snap of s) pts.set(snap.date, { date: snap.date, value: snap.total, securities: snap.securitiesTotal, cash: snap.cashTotal, approx: false, snap });
    const list = [...pts.values()].sort(byDate);
    let idx = 1;
    for (let i = 0; i < list.length; i++) {
      if (i > 0) {
        const a = list[i - 1], b = list[i];
        if (a.snap && b.snap) idx *= 1 + periodReturn(a.snap, b.snap);
        else if (a.value > 0) idx *= b.value / a.value;
      }
      list[i].index = idx;
    }
    return list;
  }

  // Veränderung seit einem Stichtag (letzter Punkt am oder vor dem Tag)
  function changeSince(series, isoDate) {
    if (series.length < 2) return null;
    const last = series[series.length - 1];
    const base = [...series].reverse().find((p) => p.date <= isoDate && p !== last);
    if (!base) return null;
    return { pct: last.index / base.index - 1, eur: last.value - base.value, since: base.date };
  }
  function daysBefore(iso, n) {
    const d = new Date(iso + 'T12:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10);
  }

  // Ist-Stand gegen den Investmentplan (Startbetrag mit Zielrendite hochgerechnet)
  function planCompare(depot) {
    const plan = depot.latest.plan;
    if (!plan || !plan.startAmount || !plan.startDate || plan.targetReturn == null) return null;
    const years = (new Date(depot.latest.date) - new Date(plan.startDate)) / (365.25 * 864e5);
    if (years < 0) return null;
    const expected = plan.startAmount * Math.pow(1 + plan.targetReturn, years);
    return {
      ...plan,
      years,
      expected,
      actual: depot.value,
      gap: depot.value - expected,
      sinceStartPct: depot.value / plan.startAmount - 1,
    };
  }

  function buildModel(snapshots, depotMeta) {
    const groups = new Map();
    for (const s of snapshots) {
      if (!groups.has(s.depotId)) groups.set(s.depotId, []);
      groups.get(s.depotId).push(s);
    }
    const depots = [];
    for (const [id, snaps] of groups) {
      const series = depotSeries(snaps);
      const sorted = [...snaps].sort(byDate);
      const latest = sorted[sorted.length - 1];
      const prevSnap = sorted[sorted.length - 2] || null;
      const last = series[series.length - 1];
      const d = {
        id,
        label: depotMeta?.[id]?.label || defaultLabel(latest),
        bank: latest.bank,
        custodian: latest.custodian,
        depotNr: latest.depotNr,
        series,
        latest,
        prevSnap,
        value: latest.total,
        approx: series.some((p) => p.approx),
        change30: changeSince(series, daysBefore(last.date, 30)),
        changeStart: series.length > 1 ? changeSince(series, series[0].date) : null,
      };
      d.plan = planCompare(d);
      depots.push(d);
    }
    depots.sort((a, b) => b.value - a.value);

    // Gesamt: alle Stichtage, jedes Depot mit seinem letzten bekannten Stand
    const dates = [...new Set(depots.flatMap((d) => d.series.map((p) => p.date)))].sort();
    const total = [];
    let idx = 1;
    let prevAt = null;
    for (const d of dates) {
      const at = depots.map((dp) => {
        const pts = dp.series.filter((p) => p.date <= d);
        return pts.length ? pts[pts.length - 1] : null;
      });
      const value = at.reduce((s, p) => s + (p ? p.value : 0), 0);
      if (prevAt) {
        let base = 0, gain = 0;
        at.forEach((p, i) => {
          const q = prevAt[i];
          if (p && q) { base += q.value; gain += q.value * (p.index / q.index - 1); }
        });
        if (base) idx *= 1 + gain / base;
      }
      total.push({ date: d, value, index: idx, complete: at.every(Boolean), approx: at.some((p) => p && p.approx) });
      prevAt = at;
    }
    const latestDate = dates[dates.length - 1] || null;
    return {
      depots,
      total,
      value: depots.reduce((s, d) => s + d.value, 0),
      latestDate,
      approx: depots.some((d) => d.approx),
      change30: latestDate ? changeSince(total, daysBefore(latestDate, 30)) : null,
      changeStart: total.length > 1 ? changeSince(total, total[0].date) : null,
    };
  }

  function defaultLabel(s) {
    if (s.source === 'mywealth') return 'myWealth';
    return s.bank || 'Depot';
  }

  // Positionen eines Depots mit Veränderung gegenüber dem vorigen Stand und seit letztem Kauf
  function positionRows(depot) {
    const s = depot.latest;
    const prev = depot.prevSnap;
    const prevMap = new Map((prev?.positions || []).map((p) => [p.isin || p.name, p]));
    return s.positions.map((p) => {
      const q = prevMap.get(p.isin || p.name);
      const lastBuy = (s.transactions || [])
        .filter((t) => t.isin && t.isin === p.isin && t.qty > 0 && t.price && /Kauf/i.test(t.type))
        .sort(byDate).pop() || null;
      return {
        ...p,
        changePct: q && q.price ? p.price / q.price - 1 : null,
        isNew: prev ? !q : false,
        lastBuy: lastBuy ? { date: lastBuy.date, price: lastBuy.price, pct: p.price / lastBuy.price - 1 } : null,
      };
    });
  }

  // Grobe Aufteilung für "Teil Aktien, teil Geld"
  function assetClass(p) {
    const c = (p.category || '').toLowerCase();
    const n = (p.name || '').toLowerCase();
    if (/gold/.test(n)) return 'Gold';
    if (/aktien|branchen|themen|equity|etf/.test(c)) return 'Aktien';
    if (/geldmarkt|renten|anleihe|bond/.test(c) || /bundesrepublik|anleihe|bond/.test(n)) return 'Anleihen & Geldmarkt';
    if (/misch|multidirektional/.test(c)) return 'Mischfonds';
    return 'Sonstiges';
  }
  function allocation(snap) {
    const m = new Map();
    for (const p of snap.positions) m.set(assetClass(p), (m.get(assetClass(p)) || 0) + p.value);
    if (snap.cashTotal) m.set('Konto', (m.get('Konto') || 0) + snap.cashTotal);
    const total = [...m.values()].reduce((a, b) => a + b, 0) || 1;
    const order = ['Aktien', 'Mischfonds', 'Anleihen & Geldmarkt', 'Gold', 'Sonstiges', 'Konto'];
    return order.filter((k) => m.has(k)).map((k) => ({ label: k, value: m.get(k), share: m.get(k) / total }));
  }

  const api = { buildModel, periodReturn, positionRows, allocation, assetClass, changeSince };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EasyEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
