// One-time backfill: computes contains/may_contain for recipes that were migrated
// with those fields empty, by matching each ingredient line to its linked product/recipe
// and unioning their allergens. Only touches recipes where BOTH fields are currently
// empty, so it never overwrites existing (possibly hand-curated) allergen data.
// Run locally: node scripts/backfill-recipe-allergens.js
const admin = require('firebase-admin');

const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

function norm(s) { return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(); }
const QTY_RE = /^(.*?)\s*-\s*[\d.,\/]+\s*(?:g|kg|ml|l)\s*$/i;
function tokenScore(name, query) {
  const nTokens = norm(name).split(' ').filter(Boolean), qTokens = norm(query).split(' ').filter(Boolean);
  if (qTokens.length < 2) return 0;
  let matchedCount = 0;
  for (const qt of qTokens) {
    const found = nTokens.some(nt => nt === qt || (Math.abs(nt.length - qt.length) <= 2 && (nt.startsWith(qt) || qt.startsWith(nt))));
    if (found) matchedCount++;
  }
  if (matchedCount !== qTokens.length) return 0;
  const diff = Math.abs(nTokens.length - qTokens.length);
  if (diff > 3) return 0;
  return 1 + (1 / (1 + diff));
}

async function backfill() {
  console.log('Fetching all products/recipes from Firestore...');
  const snap = await db.collection('products').get();
  const DATA = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  console.log(`Loaded ${DATA.length} documents.`);

  const NAME_INDEX = new Map();
  DATA.forEach(rec => {
    const k = norm(rec.name || '');
    if (!NAME_INDEX.has(k)) NAME_INDEX.set(k, []);
    NAME_INDEX.get(k).push(rec);
  });

  function matchIngredientLine(line) {
    const m = line.match(QTY_RE);
    const base = (m ? m[1] : line).trim();
    if (!base) return null;
    const exact = NAME_INDEX.get(norm(base));
    if (exact && exact.length) return exact[0];
    let best = null, bestScore = 0;
    DATA.forEach(rec => {
      const s = tokenScore(rec.name, base);
      if (s > bestScore) { bestScore = s; best = rec; }
    });
    return best;
  }

  function computeAllergens(ingredientsText, selfId) {
    const lines = ingredientsText.split('\n').map(l => l.trim()).filter(Boolean);
    const contains = new Set(), mayContain = new Set();
    for (const line of lines) {
      const match = matchIngredientLine(line);
      if (match && String(match.id) !== String(selfId)) {
        (match.contains || []).forEach(a => contains.add(a));
        (match.may_contain || []).forEach(a => mayContain.add(a));
      }
    }
    return { contains: [...contains], may_contain: [...mayContain] };
  }

  const candidates = DATA.filter(r =>
    r.source === 'recipes' &&
    (!r.contains || r.contains.length === 0) &&
    (!r.may_contain || r.may_contain.length === 0) &&
    r.details && r.details.ingredients
  );
  console.log(`Found ${candidates.length} recipes with empty allergens and ingredient text.`);

  const updates = [];
  for (const r of candidates) {
    const computed = computeAllergens(r.details.ingredients, r.id);
    if (computed.contains.length || computed.may_contain.length) {
      updates.push({ id: r.id, name: r.name, ...computed });
    }
  }
  console.log(`${updates.length} recipes will be updated with computed allergens.`);

  const BATCH_SIZE = 400;
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = updates.slice(i, i + BATCH_SIZE);
    for (const u of chunk) {
      const ref = db.collection('products').doc(String(u.id));
      batch.update(ref, { contains: u.contains, may_contain: u.may_contain });
    }
    await batch.commit();
    console.log(`  committed ${Math.min(i + BATCH_SIZE, updates.length)}/${updates.length}`);
  }
  console.log('Done. Sample of updated recipes:');
  updates.slice(0, 10).forEach(u => console.log(`  - ${u.name}: contains=${JSON.stringify(u.contains)} may_contain=${JSON.stringify(u.may_contain)}`));
}

backfill().catch(err => {
  console.error(err);
  process.exit(1);
});
