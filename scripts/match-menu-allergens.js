// Matches Terrace Cycle Menu dish names (Firestore 'menu' collection:
// breakfast/lunch/dinner docs) to catalog recipes/products, and appends
// allergen abbreviation codes in parentheses to each matched dish name.
//
// SAFETY DESIGN: three confidence tiers.
//   - HIGH  (auto-applied): exact or near-exact name match. Baked into the
//     menu text directly.
//   - MEDIUM (needs human confirmation): a plausible but not certain match.
//     NOT applied automatically — written to the review Excel with the
//     suggested match so a human confirms before it's ever shown on a real
//     menu (a wrong guess here could under-report a real allergen).
//   - NONE: no candidate found. Written to the Excel blank for manual entry.
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const DRY_RUN = !process.argv.includes('--apply');

const CODE = {
  'Gluten':'GL','Tree nuts':'TN','Peanuts':'PN','Eggs':'EG','Milk':'MI','Fish':'FI',
  'Crustaceans':'CR','Molluscs':'MO','Celery':'CE','Mustard':'MU','Sesame':'SE',
  'Soya':'SO','Sulphites':'SU','Lupin':'LU'
};
const CODE_ORDER = Object.keys(CODE);

function norm(s) { return (s||'').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(); }
function tokens(s) { return norm(s).split(' ').filter(Boolean); }
function collapsedNoSpace(s) { return norm(s).replace(/\s+/g, ''); }

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1);
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i-1] === b[j-1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j-1] + 1, prev[j-1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

function codesFor(rec) {
  const contains = rec.contains || [];
  return CODE_ORDER.filter(a => contains.includes(a)).map(a => CODE[a]);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function withRetry(fn, label) {
  const delays = [3000, 6000, 12000, 24000, 48000, 60000, 60000, 60000];
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (i >= delays.length) throw e;
      console.log(`  ${label} hit "${e.message}" — retrying in ${delays[i]}ms (attempt ${i + 1}/${delays.length})`);
      await sleep(delays[i]);
    }
  }
}
async function fetchAllPaged(pageSize) {
  const items = [];
  let lastDoc = null;
  for (;;) {
    let q = db.collection('products').orderBy(admin.firestore.FieldPath.documentId()).limit(pageSize);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await withRetry(() => q.get(), 'page fetch');
    if (snap.empty) break;
    snap.docs.forEach(d => items.push({ id: d.id, ...d.data() }));
    lastDoc = snap.docs[snap.docs.length - 1];
    console.log(`  fetched page: ${snap.docs.length} docs (total so far: ${items.length})`);
    if (snap.docs.length < pageSize) break;
    await sleep(500);
  }
  return items;
}

const CACHE_PATH = '/tmp/claude-0/-home-user-aziz/8e941f65-efbc-56d6-94db-b8f8de39ea42/scratchpad/products-cache.json';

async function main() {
  const fsSync = require('fs');
  let items;
  if (fsSync.existsSync(CACHE_PATH)) {
    console.log('Using local products cache:', CACHE_PATH);
    items = JSON.parse(fsSync.readFileSync(CACHE_PATH, 'utf8'));
  } else {
    console.log('Loading full products collection (paginated)...');
    items = await fetchAllPaged(300);
    fsSync.writeFileSync(CACHE_PATH, JSON.stringify(items));
    console.log('Cached to', CACHE_PATH);
  }
  console.log(`Loaded ${items.length} items.`);

  // inverted token index for candidate blocking
  const tokenIndex = new Map(); // token -> Set(itemIndex)
  const itemTokens = items.map(it => new Set(tokens(it.name || '')));
  const itemNorm = items.map(it => norm(it.name || ''));
  const itemNoSpace = items.map(it => collapsedNoSpace(it.name || ''));
  itemTokens.forEach((tset, idx) => {
    tset.forEach(t => {
      if (!tokenIndex.has(t)) tokenIndex.set(t, new Set());
      tokenIndex.get(t).add(idx);
    });
  });
  const exactIndex = new Map();
  items.forEach((it, idx) => { const k = norm(it.name||''); if (k && !exactIndex.has(k)) exactIndex.set(k, idx); });

  console.log('Loading menu collection...');
  const menuDocs = ['breakfast', 'lunch', 'dinner'];
  const menuData = {};
  for (const id of menuDocs) {
    const d = await withRetry(() => db.collection('menu').doc(id).get(), `menu/${id} fetch`);
    menuData[id] = d.data();
    await sleep(400);
  }

  // collect unique dish name strings across all menus
  const dishInfo = new Map(); // name -> {docs:Set, cats:Set}
  menuDocs.forEach(docId => {
    (menuData[docId].rows || []).forEach(row => {
      Object.values(row.values || {}).forEach(v => {
        const name = (v || '').trim();
        if (!name) return;
        if (!dishInfo.has(name)) dishInfo.set(name, { docs: new Set(), cats: new Set() });
        dishInfo.get(name).docs.add(docId);
        dishInfo.get(name).cats.add(`${row.category}/${row.station}`);
      });
    });
  });
  console.log('Unique dish names:', dishInfo.size);

  function findBestMatch(dishName) {
    const qNorm = norm(dishName);
    const qNoSpace = collapsedNoSpace(dishName);
    const qTokens = tokens(dishName);

    // exact match
    if (exactIndex.has(qNorm)) return { idx: exactIndex.get(qNorm), tier: 'HIGH', reason: 'exact' };

    // candidate pool via shared tokens
    const poolSet = new Set();
    qTokens.forEach(t => { const s = tokenIndex.get(t); if (s) s.forEach(i => poolSet.add(i)); });
    // also add candidates with same first-3-chars (typo fallback) if pool is small
    if (poolSet.size < 20) {
      const prefix = qNoSpace.slice(0, 3);
      if (prefix.length === 3) {
        itemNoSpace.forEach((ns, idx) => { if (ns.slice(0,3) === prefix) poolSet.add(idx); });
      }
    }
    if (poolSet.size === 0) return null;

    let best = null, bestScore = -1;
    for (const idx of poolSet) {
      const cTokens = itemTokens[idx];
      let overlap = 0;
      qTokens.forEach(t => { if (cTokens.has(t)) overlap++; });
      const jaccard = overlap / (qTokens.length + cTokens.size - overlap || 1);
      const dist = levenshtein(qNoSpace, itemNoSpace[idx]);
      const maxLen = Math.max(qNoSpace.length, itemNoSpace[idx].length, 1);
      const levRatio = 1 - dist / maxLen;
      const combined = Math.max(jaccard, levRatio);
      if (combined > bestScore) { bestScore = combined; best = idx; }
    }
    if (best === null) return null;
    let tier;
    if (bestScore >= 0.92) tier = 'HIGH';
    else if (bestScore >= 0.55) tier = 'MEDIUM';
    else return null;
    return { idx: best, tier, reason: `score=${bestScore.toFixed(2)}` };
  }

  const results = new Map(); // dishName -> {tier, rec, codes}
  let high = 0, medium = 0, none = 0;
  for (const [name] of dishInfo) {
    const m = findBestMatch(name);
    if (!m) { none++; results.set(name, { tier: 'NONE' }); continue; }
    const rec = items[m.idx];
    const codes = codesFor(rec);
    if (m.tier === 'HIGH') high++; else medium++;
    results.set(name, { tier: m.tier, rec, codes, reason: m.reason });
  }
  console.log(`HIGH: ${high}  MEDIUM: ${medium}  NONE: ${none}`);

  // Apply HIGH-confidence matches to the menu docs
  let updatedDocs = 0;
  for (const docId of menuDocs) {
    const data = menuData[docId];
    let changed = false;
    const newRows = (data.rows || []).map(row => {
      const newValues = {};
      let rowChanged = false;
      Object.entries(row.values || {}).forEach(([date, v]) => {
        const name = (v || '').trim();
        if (!name) { newValues[date] = v; return; }
        const r = results.get(name);
        if (r && r.tier === 'HIGH' && r.codes && r.codes.length) {
          newValues[date] = `${name} (${r.codes.join(', ')})`;
          rowChanged = true;
        } else {
          newValues[date] = v;
        }
      });
      if (rowChanged) changed = true;
      return rowChanged ? { ...row, values: newValues } : row;
    });
    if (changed) {
      updatedDocs++;
      if (!DRY_RUN) {
        await withRetry(() => db.collection('menu').doc(docId).set({ ...data, rows: newRows }), `menu/${docId} write`);
        await sleep(400);
      }
    }
  }
  console.log('Menu docs updated:', updatedDocs, DRY_RUN ? '(DRY RUN, not written)' : '(WRITTEN)');

  // Build report / Excel input data
  const fs = require('fs');
  const reviewRows = [];
  const noneRows = [];
  for (const [name, info] of dishInfo) {
    const r = results.get(name);
    if (r.tier === 'MEDIUM') {
      reviewRows.push({
        dishName: name,
        categories: [...info.cats].join(' | '),
        suggestedMatch: r.rec.name,
        suggestedCodes: r.codes.join(', '),
        confidence: r.reason
      });
    } else if (r.tier === 'NONE') {
      noneRows.push({ dishName: name, categories: [...info.cats].join(' | ') });
    }
  }
  fs.writeFileSync('/tmp/claude-0/-home-user-aziz/8e941f65-efbc-56d6-94db-b8f8de39ea42/scratchpad/menu-match-review.json',
    JSON.stringify({ high, medium, none, reviewRows, noneRows }, null, 2));
  console.log('Report written. reviewRows:', reviewRows.length, 'noneRows:', noneRows.length);

  console.log('\n=== Sample HIGH matches (20) ===');
  let shown = 0;
  for (const [name, r] of results) {
    if (r.tier === 'HIGH' && shown < 20) { console.log(`"${name}" -> "${r.rec.name}" codes=[${r.codes.join(',')}]`); shown++; }
  }
  console.log('\n=== Sample MEDIUM matches (needs review, 20) ===');
  shown = 0;
  for (const [name, r] of results) {
    if (r.tier === 'MEDIUM' && shown < 20) { console.log(`"${name}" -> "${r.rec.name}" (${r.reason}) codes=[${r.codes.join(',')}]`); shown++; }
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
