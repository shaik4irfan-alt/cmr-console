import { db, collection, doc, getDocs, query, orderBy, readChunkedDoc, classifyOpmsDept } from './firebase-init.js?v=20260802a';

if (!sessionStorage.getItem('cmr_user')) window.location.replace('login.html');
document.getElementById('who').textContent = '👤 ' + sessionStorage.getItem('cmr_user');

let seasons = [];              // [{id, name}]
let selectedSeasonIds = new Set();
let natFilter = 'all';         // 'all' | 'B' | 'R'
let seasonMillCache = {};      // seasonId -> [{code,name,dist,nat,avail,boiledDso,rawDso,boiledDel,rawDel,allocatedPaddy,unallocated}]
let millAgg = {};              // code -> aggregated record across selected seasons
let activeDistrict = null;

// ── Per-season mill records — replicates the same target/delivered/
// unallocated-paddy logic already established and verified in
// dashboard.html's buildAllocFromUploads(), against that season's own
// Mill-Wise (mm) and Miller Consignment (opms) data. Kept here as a
// self-contained copy since this page doesn't load the rest of the
// dashboard — same formulas, same column sources (verified against a
// real file earlier this session), just computed per season instead of
// for the currently-open one.
async function fetchSeasonMillRecords(seasonId) {
  if (seasonMillCache[seasonId] !== undefined) return seasonMillCache[seasonId];
  const [mm, opmsRaw] = await Promise.all([
    readChunkedDoc(seasonId, 'mm'),
    readChunkedDoc(seasonId, 'opms'),
  ]);
  if (!mm) { seasonMillCache[seasonId] = []; return []; }
  const src = [...(mm.mapped || []), ...(mm.cscOnly || [])];
  const opmsAll = opmsRaw || [];

  // Per-mill delivered (accepted) — Col Z (Moisture Cut Qty), gated on
  // Stacking Date present. Boiled = FCI-department rows only (no CSC
  // Boiled target exists); Raw = all departments (FCI+CSC-Central+CSC-State).
  const delByMill = {};
  opmsAll.forEach(row => {
    const code = String(row[1] || '').trim(); if (!code) return;
    if (!row[17]) return;
    if (!delByMill[code]) delByMill[code] = { boiled: 0, raw: 0 };
    const isBoiled = row[4] && row[4].includes('PB');
    const isRaw = row[4] && row[4].includes('Raw');
    const isFci = classifyOpmsDept(row[30]) === 'FCI';
    if (isBoiled && isFci) delByMill[code].boiled += (row[25] || 0);
    if (isRaw) delByMill[code].raw += (row[25] || 0);
  });

  const records = src.map(m => {
    const rawDso = (m.bd_target || 0) + (m.csc_c_target || 0) + (m.csc_s_target || 0);
    const boiledDso = m.av_target || 0;
    const d = delByMill[m.c] || { boiled: 0, raw: 0 };
    const allocatedPaddy = (m.at_paddy || 0) + (m.au_paddy || 0) + (m.bb_paddy || 0) + (m.bc_paddy || 0)
                          + (m.csc_c_paddy || 0) + (m.csc_s_paddy || 0);
    const unallocated = (m.avail || 0) - allocatedPaddy;
    return {
      code: m.c, name: m.n, dist: m.d, nat: m.t === 'Boiled' ? 'B' : 'R',
      avail: m.avail || 0, allocatedPaddy, unallocated,
      boiledDso, rawDso, boiledDel: d.boiled, rawDel: d.raw,
      noDso: (boiledDso + rawDso) === 0,
    };
  });
  seasonMillCache[seasonId] = records;
  return records;
}

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

window.setNat = function (n) {
  natFilter = n;
  ['all', 'B', 'R'].forEach(k => {
    document.getElementById('nat-btn-' + k).style.background = (k === n) ? 'var(--accent)' : 'var(--surface)';
    document.getElementById('nat-btn-' + k).style.color = (k === n) ? '#fff' : 'var(--text)';
  });
  buildAggregate();
};

function dsoFor(rec) { return natFilter === 'B' ? rec.boiledDso : natFilter === 'R' ? rec.rawDso : rec.boiledDso + rec.rawDso; }
function delFor(rec) { return natFilter === 'B' ? rec.boiledDel : natFilter === 'R' ? rec.rawDel : rec.boiledDel + rec.rawDel; }

async function buildAggregate() {
  millAgg = {};
  const ids = [...selectedSeasonIds];
  const perSeason = await Promise.all(ids.map(fetchSeasonMillRecords));

  ids.forEach((seasonId, i) => {
    perSeason[i].forEach(rec => {
      const key = rec.code || (rec.name + '|' + rec.dist);
      if (!millAgg[key]) {
        millAgg[key] = {
          code: rec.code, name: rec.name, dist: rec.dist,
          seasons: {}, // seasonId -> rec
        };
      }
      millAgg[key].seasons[seasonId] = rec;
      // District can legitimately be reported slightly differently between
      // seasons' source files — keep the most recently seen (later season
      // in iteration order, since ids are already newest-first).
      millAgg[key].dist = rec.dist || millAgg[key].dist;
      millAgg[key].name = rec.name || millAgg[key].name;
    });
  });

  renderKPIs();
  renderDistrictTable();
  if (activeDistrict) renderMillTable(activeDistrict);
}

function millTotals(m) {
  const recs = Object.values(m.seasons);
  const avail = recs.reduce((s, r) => s + r.avail, 0);
  const dso = recs.reduce((s, r) => s + dsoFor(r), 0);
  const del = recs.reduce((s, r) => s + delFor(r), 0);
  const unallocated = recs.reduce((s, r) => s + r.unallocated, 0);
  const noDsoSeasons = Object.entries(m.seasons).filter(([, r]) => (r.boiledDso + r.rawDso) === 0).map(([sid]) => sid);
  const unallocSeasons = Object.entries(m.seasons).filter(([, r]) => r.unallocated > 500).map(([sid]) => sid);
  return { avail, dso, del, bal: Math.max(0, dso - del), unallocated, seasonCount: recs.length, noDsoSeasons, unallocSeasons };
}

function seasonName(id) { return (seasons.find(s => s.id === id) || {}).name || id; }

function renderKPIs() {
  const mills = Object.values(millAgg);
  const totalMills = mills.length;
  const multiSeason = mills.filter(m => Object.keys(m.seasons).length >= 2).length;
  let avail = 0, dso = 0, del = 0, unalloc = 0, noDsoMillCount = 0, unallocMillCount = 0;
  mills.forEach(m => {
    const t = millTotals(m);
    avail += t.avail; dso += t.dso; del += t.del; unalloc += t.unallocated;
    if (t.noDsoSeasons.length) noDsoMillCount++;
    if (t.unallocSeasons.length) unallocMillCount++;
  });
  const bal = Math.max(0, dso - del);
  const fmt = v => (v / 1000000).toFixed(2) + ' LMT'; // 1 LMT = 1,00,000 tonnes = 10,00,000 quintals
  document.getElementById('agg-kpis').innerHTML = `
    <div class="kpi c-purple"><div class="kpi-lbl">Seasons Included</div><div class="kpi-val">${selectedSeasonIds.size}</div></div>
    <div class="kpi c-blue"><div class="kpi-lbl">Total Unique Mills</div><div class="kpi-val">${totalMills}</div></div>
    <div class="kpi c-accent"><div class="kpi-lbl">Mills in 2+ Seasons</div><div class="kpi-val">${multiSeason}</div></div>
    <div class="kpi c-teal"><div class="kpi-lbl">Total Paddy Available</div><div class="kpi-val" style="font-size:18px">${fmt(avail)}</div></div>
    <div class="kpi c-green"><div class="kpi-lbl">Total DSO Allocation</div><div class="kpi-val" style="font-size:18px">${fmt(dso)}</div></div>
    <div class="kpi c-green"><div class="kpi-lbl">Total CMR Delivered</div><div class="kpi-val" style="font-size:18px">${fmt(del)}</div></div>
    <div class="kpi c-amber"><div class="kpi-lbl">Balance CMR to Deliver</div><div class="kpi-val" style="font-size:18px">${fmt(bal)}</div></div>
    <div class="kpi c-red"><div class="kpi-lbl">Mills w/ No DSO in a Season</div><div class="kpi-val">${noDsoMillCount}</div></div>
    <div class="kpi c-orange"><div class="kpi-lbl">Mills w/ Unallocated Paddy</div><div class="kpi-val">${unallocMillCount}</div></div>
  `;
}

function renderDistrictTable() {
  const byDist = {};
  Object.values(millAgg).forEach(m => {
    const dk = m.dist || 'Unknown';
    if (!byDist[dk]) byDist[dk] = { dist: dk, mills: [] };
    byDist[dk].mills.push(m);
  });
  const rows = Object.values(byDist).map(d => {
    let avail = 0, dso = 0, del = 0, multiSeason = 0;
    d.mills.forEach(m => {
      const t = millTotals(m);
      avail += t.avail; dso += t.dso; del += t.del;
      if (Object.keys(m.seasons).length >= 2) multiSeason++;
    });
    return { ...d, avail, dso, del, bal: Math.max(0, dso - del), multiSeason };
  }).sort((a, b) => b.dso - a.dso);

  const fmt = v => Math.round(v).toLocaleString('en-IN');
  let html = '<thead><tr><th>District</th><th>Mills</th><th>2+ Seasons</th><th>DSO Alloc (Qtl)</th><th>Delivered (Qtl)</th><th>Balance (Qtl)</th></tr></thead><tbody>';
  rows.forEach(d => {
    html += `<tr style="cursor:pointer" onclick="showDistrictMills('${d.dist.replace(/'/g, "\\'")}')">
      <td style="font-weight:600;color:var(--accent)">${d.dist} ↓</td>
      <td class="mono">${d.mills.length}</td>
      <td class="mono" style="color:var(--purple)">${d.multiSeason}</td>
      <td class="mono">${fmt(d.dso)}</td>
      <td class="mono" style="color:var(--green2)">${fmt(d.del)}</td>
      <td class="mono" style="color:var(--amber-text)">${fmt(d.bal)}</td></tr>`;
  });
  html += '</tbody>';
  document.getElementById('dist-agg-tbl').innerHTML = html;
}

window.showDistrictMills = function (dist) {
  activeDistrict = dist;
  document.getElementById('mill-detail-wrap').style.display = '';
  document.getElementById('mill-detail-title').textContent = dist + ' — Mills (aggregated across selected seasons)';
  renderMillTable(dist);
  document.getElementById('mill-detail-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

window.closeMillDetail = function () {
  activeDistrict = null;
  document.getElementById('mill-detail-wrap').style.display = 'none';
};

function renderMillTable(dist) {
  const fmt = v => Math.round(v).toLocaleString('en-IN');
  const mills = Object.values(millAgg).filter(m => (m.dist || 'Unknown') === dist);
  const rows = mills.map(m => ({ m, t: millTotals(m) })).sort((a, b) => b.t.dso - a.t.dso);
  let html = '<thead><tr><th>Mill</th><th>Code</th><th>Seasons</th><th>Avail Paddy</th><th>DSO Alloc</th><th>Delivered</th><th>Balance</th><th>Flags</th></tr></thead><tbody>';
  rows.forEach(({ m, t }) => {
    const seasonBadges = Object.keys(m.seasons).map(sid => `<span class="badge2" style="background:rgba(61,127,255,.1);color:var(--blue);margin-right:3px">${seasonName(sid)}</span>`).join('');
    const flags = [];
    if (t.noDsoSeasons.length) flags.push(`<span class="badge2 b-rd" title="No DSO allocation in: ${t.noDsoSeasons.map(seasonName).join(', ')}">🚫 No DSO: ${t.noDsoSeasons.map(seasonName).join(', ')}</span>`);
    if (t.unallocSeasons.length) flags.push(`<span class="badge2" style="background:rgba(245,158,11,.1);color:var(--amber-text)" title="Unallocated paddy in: ${t.unallocSeasons.map(seasonName).join(', ')}">🌾 Unalloc: ${t.unallocSeasons.map(seasonName).join(', ')}</span>`);
    html += `<tr>
      <td style="font-size:12px">${m.name || m.code}</td>
      <td class="mono" style="color:var(--accent)">${m.code || '—'}</td>
      <td>${seasonBadges}</td>
      <td class="mono">${fmt(t.avail)}</td>
      <td class="mono">${fmt(t.dso)}</td>
      <td class="mono" style="color:var(--green2)">${fmt(t.del)}</td>
      <td class="mono" style="color:var(--amber-text)">${fmt(t.bal)}</td>
      <td>${flags.join(' ') || '—'}</td></tr>`;
  });
  html += '</tbody>';
  document.getElementById('mill-agg-tbl').innerHTML = html;
}

await loadSeasonsList();
await buildAggregate();
