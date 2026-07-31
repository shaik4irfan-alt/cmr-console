import { db, collection, doc, getDocs, query, orderBy, readChunkedDoc } from './firebase-init.js';

if (!sessionStorage.getItem('cmr_user')) window.location.replace('login.html');
document.getElementById('who').textContent = '👤 ' + sessionStorage.getItem('cmr_user');

let seasons = [];          // [{id, name}]
let selectedSeasonIds = new Set();
let seasonTEC = {};        // seasonId -> parsed TEC object (cached)
let millAgg = {};          // fciCodeOrName -> { name, district, seasons:{seasonId:{boiledDone,boiledTotal,rawDone,rawTotal}} }
let distAgg = {};

async function loadSeasonsList() {
  const snap = await getDocs(query(collection(db, 'seasons'), orderBy('createdAt', 'desc')));
  seasons = [];
  snap.forEach(d => seasons.push({ id: d.id, name: d.data().name || d.id }));
  const pick = document.getElementById('season-pick');
  pick.innerHTML = '';
  seasons.forEach(s => {
    selectedSeasonIds.add(s.id); // default: all checked
    const lbl = document.createElement('label');
    lbl.className = 'season-chip';
    lbl.innerHTML = `<input type="checkbox" checked data-season="${s.id}"> ${s.name}`;
    lbl.querySelector('input').addEventListener('change', onSeasonToggle);
    pick.appendChild(lbl);
  });
}

function onSeasonToggle(e) {
  const id = e.target.getAttribute('data-season');
  if (e.target.checked) selectedSeasonIds.add(id); else selectedSeasonIds.delete(id);
  buildAggregate();
}

async function fetchSeasonTEC(seasonId) {
  if (seasonTEC[seasonId] !== undefined) return seasonTEC[seasonId];
  const data = await readChunkedDoc(seasonId, 'tec');
  seasonTEC[seasonId] = data;
  return data;
}

async function buildAggregate() {
  millAgg = {}; distAgg = {};
  const ids = [...selectedSeasonIds];
  await Promise.all(ids.map(fetchSeasonTEC));

  for (const seasonId of ids) {
    const tec = seasonTEC[seasonId];
    if (!tec || !tec.mill_detail) continue;
    // mill_detail excludes Completed stacks in the source parser (it pushes
    // non-completed only), so use all_stacks for a true rollup when present.
    const rows = tec.all_stacks || tec.mill_detail;
    for (const r of rows) {
      const key = r.FCI_Code || (r.Mill_Clean + '|' + r.Revenue_District);
      if (!millAgg[key]) millAgg[key] = { name: r.Mill_Clean, district: r.Revenue_District, fciCode: r.FCI_Code, seasons: {} };
      if (!millAgg[key].seasons[seasonId]) millAgg[key].seasons[seasonId] = { boiledDone: 0, boiledTotal: 0, rawDone: 0, rawTotal: 0, stacks: 0 };
      const ms = millAgg[key].seasons[seasonId];
      ms.stacks++;
      if (r.riceType === 'Boiled') { ms.boiledDone += r.Del_Done || 0; ms.boiledTotal += r.Del_Total || 0; }
      else if (r.riceType === 'Raw') { ms.rawDone += r.Del_Done || 0; ms.rawTotal += r.Del_Total || 0; }

      const dKey = r.Revenue_District || 'Unknown';
      if (!distAgg[dKey]) distAgg[dKey] = { district: dKey, seasons: {}, mills: new Set() };
      distAgg[dKey].mills.add(key);
      if (!distAgg[dKey].seasons[seasonId]) distAgg[dKey].seasons[seasonId] = { boiledDone: 0, boiledTotal: 0, rawDone: 0, rawTotal: 0 };
      const ds = distAgg[dKey].seasons[seasonId];
      if (r.riceType === 'Boiled') { ds.boiledDone += r.Del_Done || 0; ds.boiledTotal += r.Del_Total || 0; }
      else if (r.riceType === 'Raw') { ds.rawDone += r.Del_Done || 0; ds.rawTotal += r.Del_Total || 0; }
    }
  }
  renderKPIs();
  renderDistTable();
  populateDistFilter();
  renderMillTable();
}

function sumAcrossSeasons(entrySeasons) {
  const t = { boiledDone: 0, boiledTotal: 0, rawDone: 0, rawTotal: 0 };
  for (const s of Object.values(entrySeasons)) {
    t.boiledDone += s.boiledDone; t.boiledTotal += s.boiledTotal;
    t.rawDone += s.rawDone; t.rawTotal += s.rawTotal;
  }
  return t;
}

function renderKPIs() {
  let boiledDone = 0, boiledTotal = 0, rawDone = 0, rawTotal = 0;
  for (const d of Object.values(distAgg)) {
    const t = sumAcrossSeasons(d.seasons);
    boiledDone += t.boiledDone; boiledTotal += t.boiledTotal;
    rawDone += t.rawDone; rawTotal += t.rawTotal;
  }
  const millsCount = Object.keys(millAgg).length;
  const el = document.getElementById('agg-kpis');
  const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : 0;
  el.innerHTML = `
    <div class="kpi c-amber"><div class="kpi-lbl">Seasons Included</div><div class="kpi-val">${selectedSeasonIds.size}</div></div>
    <div class="kpi c-blue"><div class="kpi-lbl">Mills Participating</div><div class="kpi-val">${millsCount}</div></div>
    <div class="kpi c-orange"><div class="kpi-lbl">Boiled Lots Delivered</div><div class="kpi-val">${boiledDone}</div><div class="kpi-sub">of ${boiledTotal} (${pct(boiledDone, boiledTotal)}%)</div></div>
    <div class="kpi c-teal"><div class="kpi-lbl">Raw Lots Delivered</div><div class="kpi-val">${rawDone}</div><div class="kpi-sub">of ${rawTotal} (${pct(rawDone, rawTotal)}%)</div></div>`;
}

function renderDistTable() {
  const rows = Object.values(distAgg).map(d => ({ ...d, totals: sumAcrossSeasons(d.seasons) }))
    .sort((a, b) => b.totals.boiledTotal + b.totals.rawTotal - (a.totals.boiledTotal + a.totals.rawTotal));
  let html = '<thead><tr><th>District</th><th>Mills</th><th>Boiled Delivered/Target</th><th>Raw Delivered/Target</th></tr></thead><tbody>';
  rows.forEach(d => {
    html += `<tr><td>${d.district}</td><td class="mono">${d.mills.size}</td>
      <td class="mono">${d.totals.boiledDone} / ${d.totals.boiledTotal}</td>
      <td class="mono">${d.totals.rawDone} / ${d.totals.rawTotal}</td></tr>`;
  });
  html += '</tbody>';
  document.getElementById('dist-agg-tbl').innerHTML = html;
}

function populateDistFilter() {
  const sel = document.getElementById('dist-filter');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All Districts</option>' +
    Object.keys(distAgg).sort().map(d => `<option value="${d}">${d}</option>`).join('');
  sel.value = cur;
}

window.renderMillTable = function () {
  const q = (document.getElementById('mill-srch').value || '').toLowerCase();
  const distF = document.getElementById('dist-filter').value;
  const rows = Object.entries(millAgg).map(([key, m]) => ({ key, ...m, totals: sumAcrossSeasons(m.seasons) }))
    .filter(m => (!q || (m.name || '').toLowerCase().includes(q)) && (!distF || m.district === distF))
    .sort((a, b) => (b.totals.boiledTotal + b.totals.rawTotal) - (a.totals.boiledTotal + a.totals.rawTotal));
  let html = '<thead><tr><th>Mill</th><th>District</th><th>Seasons</th><th>Boiled Delivered/Target</th><th>Raw Delivered/Target</th></tr></thead><tbody>';
  rows.forEach(m => {
    html += `<tr style="cursor:pointer" onclick="openMillDetail('${m.key.replace(/'/g, "\\'")}')">
      <td>${m.name || m.key}</td><td>${m.district || ''}</td><td class="mono">${Object.keys(m.seasons).length}</td>
      <td class="mono">${m.totals.boiledDone} / ${m.totals.boiledTotal}</td>
      <td class="mono">${m.totals.rawDone} / ${m.totals.rawTotal}</td></tr>`;
  });
  html += '</tbody>';
  document.getElementById('mill-agg-tbl').innerHTML = html;
};

window.openMillDetail = function (key) {
  const m = millAgg[key];
  if (!m) return;
  const t = sumAcrossSeasons(m.seasons);
  document.getElementById('agg-list').style.display = 'none';
  document.getElementById('agg-detail').style.display = 'block';
  let seasonCards = '';
  for (const [seasonId, s] of Object.entries(m.seasons)) {
    const seasonName = (seasons.find(x => x.id === seasonId) || {}).name || seasonId;
    seasonCards += `<div class="season-card-mini">
      <div style="font-weight:800;margin-bottom:6px">${seasonName}</div>
      <div style="font-size:12px;color:var(--muted)">Stacks: ${s.stacks}</div>
      <div style="font-size:12px">Boiled: <span class="mono">${s.boiledDone}/${s.boiledTotal}</span></div>
      <div style="font-size:12px">Raw: <span class="mono">${s.rawDone}/${s.rawTotal}</span></div>
    </div>`;
  }
  document.getElementById('agg-detail-content').innerHTML = `
    <div class="hdr-title" style="font-size:18px;margin-bottom:4px">${m.name || key}</div>
    <div class="hdr-sub" style="margin-bottom:16px">${m.district || ''} · FCI Code: ${m.fciCode || '—'}</div>
    <div class="kpi-grid">
      <div class="kpi c-orange"><div class="kpi-lbl">Boiled (Aggregate)</div><div class="kpi-val">${t.boiledDone}/${t.boiledTotal}</div></div>
      <div class="kpi c-teal"><div class="kpi-lbl">Raw (Aggregate)</div><div class="kpi-val">${t.rawDone}/${t.rawTotal}</div></div>
    </div>
    <div class="sec"><div class="sec-title">Per-Season Breakdown</div></div>
    <div class="gd-grid">${seasonCards}</div>`;
};

window.showList = function () {
  document.getElementById('agg-list').style.display = 'block';
  document.getElementById('agg-detail').style.display = 'none';
};

await loadSeasonsList();
await buildAggregate();
