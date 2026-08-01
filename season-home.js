import { db, collection, doc, getDocs, setDoc, query, orderBy, serverTimestamp, deleteSeason } from './firebase-init.js';

if (!sessionStorage.getItem('cmr_user')) window.location.replace('login.html');
document.getElementById('who').textContent = '👤 ' + sessionStorage.getItem('cmr_user');
window.logout = function () { sessionStorage.clear(); window.location.href = 'login.html'; };

window.openNewSeasonModal = function () { document.getElementById('new-season-modal').classList.add('open'); };
window.closeNewSeasonModal = function () {
  document.getElementById('new-season-modal').classList.remove('open');
  document.getElementById('ns-err').textContent = '';
};

window.createSeason = async function () {
  const name = document.getElementById('ns-name').value.trim();
  const start = document.getElementById('ns-start').value;
  const end = document.getElementById('ns-end').value;
  const err = document.getElementById('ns-err');
  if (!name) { err.textContent = 'Season name is required.'; return; }
  const id = (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'season') + '-' + Date.now().toString(36);
  await setDoc(doc(db, 'seasons', id), {
    name, startDate: start || null, endDate: end || null,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    kpi: { stacksTotal: 0, deliveredPct: 0, millsCount: 0 }
  });
  window.location.href = 'dashboard.html?season=' + encodeURIComponent(id);
};

async function loadSeasons() {
  const grid = document.getElementById('season-grid');
  const empty = document.getElementById('empty-msg');
  grid.innerHTML = '';
  const snap = await getDocs(query(collection(db, 'seasons'), orderBy('createdAt', 'desc')));
  if (snap.empty) { empty.style.display = 'block'; return; }
  empty.style.display = 'none';
  snap.forEach(d => {
    const s = d.data();
    const kpi = s.kpi || {};
    const dateStr = [s.startDate, s.endDate].filter(Boolean).join(' → ') || 'Dates not set';
    const card = document.createElement('div');
    card.className = 'season-card';
    card.onclick = () => window.location.href = 'dashboard.html?season=' + encodeURIComponent(d.id);
    card.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:4px">
        <div class="hdr-title" style="font-size:16px">${s.name || d.id}</div>
        <button class="hdr-btn" style="background:#dc2626;color:#fff;font-size:11px;padding:4px 10px;flex-shrink:0" onclick="event.stopPropagation();deleteSeasonPrompt('${d.id}','${(s.name||d.id).replace(/'/g,"\\'")}')" title="Delete this season">🗑</button>
      </div>
      <div class="hdr-sub" style="margin-bottom:12px">${dateStr}</div>
      <div style="display:flex;gap:14px">
        <div><div class="kpi-val" style="font-size:18px;color:var(--green2)">${kpi.deliveredPct || 0}%</div><div class="kpi-lbl">CMR Delivered</div></div>
        <div><div class="kpi-val" style="font-size:18px;color:var(--blue)">${kpi.millsCount || 0}</div><div class="kpi-lbl">Mills</div></div>
        <div><div class="kpi-val" style="font-size:18px;color:var(--accent)">${kpi.stacksTotal || 0}</div><div class="kpi-lbl">Stacks</div></div>
      </div>`;
    grid.appendChild(card);
  });
}
window.deleteSeasonPrompt = async function (seasonId, seasonName) {
  if (!confirm('Delete season "' + seasonName + '"?\n\nThis permanently removes all uploaded data for this season (TEC, Waiting List, Mill Wise, District Wise, Miller Consignment) — it cannot be undone.')) return;
  try {
    await deleteSeason(seasonId);
    loadSeasons();
  } catch (e) {
    console.error('Delete season failed', e);
    alert('Failed to delete season: ' + e.message);
  }
};

loadSeasons();
