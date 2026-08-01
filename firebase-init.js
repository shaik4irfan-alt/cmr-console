// ============================================================
// Firebase init — shared across all pages.
// Plain ES module, loaded via <script type="module"> from the
// gstatic CDN (no npm / bundler required).
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, deleteDoc,
  query, orderBy, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyB_z5wENmr-s83bCspIHIRtkgDeic9f7mE",
  authDomain: "cmr-console.firebaseapp.com",
  projectId: "cmr-console",
  storageBucket: "cmr-console.firebasestorage.app",
  messagingSenderId: "395700441310",
  appId: "1:395700441310:web:da81da88f374602532724f",
  measurementId: "G-GG9Y70GGYN"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export {
  collection, doc, getDoc, getDocs, setDoc, deleteDoc,
  query, orderBy, serverTimestamp, writeBatch
};

// ── shared login hash (mirrors the source dashboard's hashInput) ──
export async function hashInput(user, pass) {
  const text = user + ':' + pass;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Mirrors dashboard.html's classifyOpmsDept() exactly — kept here too so
// pages that don't load the full dashboard (e.g. compare.js) can classify
// Miller Consignment rows by department the same way.
export function classifyOpmsDept(tag) {
  const t = String(tag || '').toUpperCase();
  if (!t) return 'UNKNOWN';
  if (t === 'FCI') return 'FCI';
  if (t.includes('CSC')) {
    if (t.includes('CENTRAL') || /(^|[-_])C$/.test(t)) return 'CSC-Central';
    if (t.includes('STATE') || /(^|[-_])S$/.test(t)) return 'CSC-State';
    return 'CSC-Other';
  }
  return 'OTHER';
}

// ============================================================
// Chunked read/write for large parsed datasets.
// Firestore documents cap out at ~1MB, and row counts vary
// season to season, so any JSON blob that might be big gets
// split into seasons/{seasonId}/data/{fileType}_chunk_{n} docs
// and reassembled transparently on read.
// ============================================================
const CHUNK_BYTES = 900000;               // UTF-8 bytes per chunk, safely under Firestore's 1MiB per-document limit
const MAX_BATCH_OPS = 450;                // Firestore hard cap: 500 writes per batch commit
// Kept well under both Firestore's ~10-11MiB per-commit request cap AND its
// per-connection queued-writes limit. Large files (e.g. a 28MB OPMS season)
// need 30+ chunk docs; bursting them in near-8MB batches back-to-back
// exhausted the client's write-stream queue (resource-exhausted errors),
// leaving some chunks unwritten. Smaller batches + a gap between commits
// (see BATCH_GAP_MS below) let the stream drain instead of overflowing.
const MAX_BATCH_BYTES = 3 * 1024 * 1024;
const BATCH_GAP_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

// Splits a string into chunks measured in actual UTF-8 bytes — NOT JS .length,
// which counts UTF-16 code units and undercounts multi-byte characters (e.g.
// Telugu district/mill/remarks text can appear in these files, ~3 bytes/char
// in UTF-8 vs 1 in .length). Never splits in the middle of a multi-byte
// sequence, so each chunk decodes back to valid text.
function chunkByUtf8Bytes(str, maxBytes) {
  const bytes = utf8Encoder.encode(str);
  const chunks = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + maxBytes, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xC0) === 0x80) end--; // back off continuation bytes
    const slice = bytes.subarray(start, end);
    chunks.push({ text: utf8Decoder.decode(slice), bytes: slice.length });
    start = end;
  }
  return chunks;
}

// Commits a list of {ref, data, sizeBytes} writes across as many batches as needed
// so no single commit exceeds Firestore's per-request op/byte limits.
async function commitChunked(dbRef, writes) {
  let batch = writeBatch(dbRef);
  let opCount = 0, byteCount = 0;
  let first = true;
  for (const w of writes) {
    if (opCount && (opCount >= MAX_BATCH_OPS || byteCount + w.sizeBytes > MAX_BATCH_BYTES)) {
      if (!first) await sleep(BATCH_GAP_MS);
      await batch.commit();
      first = false;
      batch = writeBatch(dbRef);
      opCount = 0; byteCount = 0;
    }
    batch.set(w.ref, w.data);
    opCount++; byteCount += w.sizeBytes;
  }
  if (opCount) {
    if (!first) await sleep(BATCH_GAP_MS);
    await batch.commit();
  }
}

async function deleteChunked(dbRef, refs) {
  for (let i = 0; i < refs.length; i += MAX_BATCH_OPS) {
    if (i > 0) await sleep(BATCH_GAP_MS);
    const batch = writeBatch(dbRef);
    refs.slice(i, i + MAX_BATCH_OPS).forEach(ref => batch.delete(ref));
    await batch.commit();
  }
}

// Writes chunks BEFORE the _meta doc, and only deletes now-orphaned old
// chunks AFTER the new _meta commit succeeds. This way, if a batch commit
// fails partway (network blip, quota), _meta still points at the last
// complete, readable chunk set instead of claiming a chunkCount whose
// later chunks were never actually written (which produced truncated
// JSON on read — see the khariff-25-26 OPMS corruption incident).
export async function writeChunkedDoc(seasonId, fileType, dataObj) {
  const json = JSON.stringify(dataObj);
  const dataCol = collection(db, 'seasons', seasonId, 'data');

  const existing = await getDocs(query(dataCol));
  const oldChunkIndices = [];
  existing.forEach(d => {
    const m = d.id.match(new RegExp('^' + fileType + '_chunk_(\\d+)$'));
    if (m) oldChunkIndices.push(parseInt(m[1], 10));
  });

  const chunks = chunkByUtf8Bytes(json, CHUNK_BYTES);
  const totalBytes = chunks.reduce((s, c) => s + c.bytes, 0);

  const chunkWrites = chunks.map((c, i) => ({
    ref: doc(dataCol, fileType + '_chunk_' + i),
    data: { fileType, i, part: c.text },
    sizeBytes: c.bytes + 150, // + doc path / protobuf envelope overhead
  }));
  await commitChunked(db, chunkWrites);

  // Only after every chunk is confirmed written does _meta advertise the new chunkCount.
  await setDoc(doc(dataCol, fileType + '_meta'), {
    fileType, chunkCount: chunks.length, updatedAt: serverTimestamp(), bytes: totalBytes,
  });

  const staleRefs = oldChunkIndices.filter(i => i >= chunks.length).map(i => doc(dataCol, fileType + '_chunk_' + i));
  if (staleRefs.length) await deleteChunked(db, staleRefs);

  return { chunkCount: chunks.length, bytes: totalBytes };
}

export async function readChunkedDoc(seasonId, fileType) {
  const dataCol = collection(db, 'seasons', seasonId, 'data');
  const metaSnap = await getDoc(doc(dataCol, fileType + '_meta'));
  if (!metaSnap.exists()) return null;
  const meta = metaSnap.data();
  const parts = new Array(meta.chunkCount);
  const gets = [];
  for (let i = 0; i < meta.chunkCount; i++) {
    gets.push(getDoc(doc(dataCol, fileType + '_chunk_' + i)).then(s => {
      parts[i] = s.exists() ? s.data().part : '';
    }));
  }
  await Promise.all(gets);
  const json = parts.join('');
  try { return JSON.parse(json); } catch (e) { console.error('readChunkedDoc parse failed for ' + fileType, e); return null; }
}

export async function deleteFileType(seasonId, fileType) {
  const dataCol = collection(db, 'seasons', seasonId, 'data');
  const existing = await getDocs(query(dataCol));
  const delRefs = [];
  existing.forEach(d => {
    if (d.id === fileType + '_meta' || d.id.startsWith(fileType + '_chunk_')) delRefs.push(d.ref);
  });
  if (delRefs.length) await deleteChunked(db, delRefs);
}

// Deletes a season entirely: every chunked-data doc under
// seasons/{seasonId}/data, then the season doc itself. Does NOT touch
// millRegistry/godownRegistry — those track a mill/godown across ALL
// seasons via a `seasons` array field, and this season's id simply
// becomes a dangling reference in that array, which is harmless (no
// code reads registry.seasons to look up season documents) rather than
// worth the extra reads/writes to scrub every registry entry.
export async function deleteSeason(seasonId) {
  const dataCol = collection(db, 'seasons', seasonId, 'data');
  const existing = await getDocs(query(dataCol));
  const delRefs = [];
  existing.forEach(d => delRefs.push(d.ref));
  if (delRefs.length) await deleteChunked(db, delRefs);
  await deleteDoc(doc(db, 'seasons', seasonId));
}

// ============================================================
// Mill / Godown master registry — keeps a physical mill/godown
// recognized as the same entity across seasons so cross-season
// aggregation is possible.
// ============================================================
export async function reconcileMillRegistry(fciCode, millName, district, seasonId) {
  if (!fciCode) return { status: 'skipped' };
  const ref = doc(db, 'millRegistry', String(fciCode));
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const data = snap.data();
    const seasons = new Set(data.seasons || []);
    seasons.add(seasonId);
    await setDoc(ref, { ...data, name: millName || data.name, district: district || data.district, seasons: [...seasons], updatedAt: serverTimestamp() }, { merge: true });
    return { status: 'known' };
  } else {
    await setDoc(ref, { fciCode: String(fciCode), name: millName || '', district: district || '', seasons: [seasonId], createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    return { status: 'new' };
  }
}

export async function reconcileGodownRegistry(code, name, agency, seasonId) {
  if (!code) return { status: 'skipped' };
  const ref = doc(db, 'godownRegistry', String(code));
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const data = snap.data();
    const seasons = new Set(data.seasons || []);
    seasons.add(seasonId);
    await setDoc(ref, { ...data, name: name || data.name, agency: agency || data.agency, seasons: [...seasons], updatedAt: serverTimestamp() }, { merge: true });
    return { status: 'known' };
  } else {
    await setDoc(ref, { code: String(code), name: name || '', agency: agency || '', seasons: [seasonId], createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    return { status: 'new' };
  }
}
