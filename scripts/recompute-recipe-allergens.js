// Recomputes contains/may_contain for every recipe from its ingredient list.
// SAFETY DESIGN: union-only. We only ADD allergens discovered from resolved
// ingredients; we never remove an allergen that was already recorded. Legacy
// ingredient text uses inconsistent brand-suffix conventions vs the catalog
// (e.g. "Onion, White, Diced" vs catalog "Onion White", or ingredient text
// carrying a brand the catalog entry doesn't, and vice versa), so exact-name
// matching alone misses many lines. A fuzzy fallback (token subset / high
// overlap) recovers most of those. Because we only ever add, an imperfect
// fuzzy match can at worst tag an extra allergen that isn't really needed
// (over-cautious) but can never silently drop a real one.
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const DRY_RUN = !process.argv.includes('--apply');

function norm(s) { return (s||'').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(); }
const QTY_RE = /^(.*?)\s*-\s*[\d.,\/]+\s*(?:g|kg|ml|l)\s*$/i;
const STOPWORDS = new Set(['diced','chopped','sliced','sanitized','peeled','trimmed','whole','fresh','ground','minced','crushed','grated','shredded','cubed','julienned']);

function tokens(s) {
  return norm(s).split(' ').filter(w => w && !STOPWORDS.has(w));
}

function buildIndex(items) {
  const exact = new Map();
  const tokenIndex = []; // {tokenSet, rec}
  items.forEach(rec => {
    const k = norm(rec.name || '');
    if (k && !exact.has(k)) exact.set(k, rec);
    const t = new Set(tokens(rec.name || ''));
    if (t.size) tokenIndex.push({ tokenSet: t, rec });
  });
  return { exact, tokenIndex };
}

function fuzzyMatch(queryTokens, tokenIndex) {
  if (queryTokens.size === 0) return null;
  let best = null, bestScore = -1;
  for (const { tokenSet, rec } of tokenIndex) {
    let overlap = 0;
    for (const t of queryTokens) if (tokenSet.has(t)) overlap++;
    const isSubsetEitherWay = overlap === queryTokens.size || overlap === tokenSet.size;
    const jaccard = overlap / (queryTokens.size + tokenSet.size - overlap);
    if (!isSubsetEitherWay && jaccard < 0.75) continue;
    // score: prefer subset matches, then closest size (fewest extra tokens), then higher jaccard
    const sizeDiff = Math.abs(queryTokens.size - tokenSet.size);
    const score = (isSubsetEitherWay ? 100 : 0) + jaccard * 10 - sizeDiff;
    if (score > bestScore) { bestScore = score; best = rec; }
  }
  return best;
}

function resolveLine(line, index) {
  const m = line.match(QTY_RE);
  const base = (m ? m[1] : line).trim();
  const k = norm(base);
  let rec = index.exact.get(k);
  let method = 'exact';
  if (!rec) {
    rec = fuzzyMatch(new Set(tokens(base)), index.tokenIndex);
    method = 'fuzzy';
  }
  return rec ? { contains: rec.contains || [], may_contain: rec.may_contain || [], matchedName: rec.name, method } : null;
}

function computeNewAllergens(ingredientsText, index) {
  const lines = (ingredientsText || '').split('\n').map(s => s.trim()).filter(Boolean);
  const containsSet = new Set(), maySet = new Set();
  const unresolved = [];
  const fuzzyMatches = [];
  lines.forEach(line => {
    const rec = resolveLine(line, index);
    if (!rec) { unresolved.push(line); return; }
    if (rec.method === 'fuzzy') fuzzyMatches.push({ line, matchedName: rec.matchedName });
    rec.contains.forEach(a => containsSet.add(a));
    rec.may_contain.forEach(a => maySet.add(a));
  });
  return { containsSet, maySet, unresolved, fuzzyMatches };
}

async function main() {
  console.log('Loading full products collection...');
  const snap = await db.collection('products').get();
  const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  console.log(`Loaded ${items.length} items.`);
  const index = buildIndex(items);

  const recipes = items.filter(it => it.source === 'recipes');
  console.log(`Recipes to process: ${recipes.length}`);

  let addedTo = 0, unchanged = 0, noIngredients = 0;
  const unresolvedMap = new Map();
  const additions = [];
  const fuzzySample = [];

  for (const r of recipes) {
    const ingredientsText = r.details && r.details.ingredients;
    if (!ingredientsText) { noIngredients++; continue; }
    const { containsSet, maySet, unresolved, fuzzyMatches } = computeNewAllergens(ingredientsText, index);
    unresolved.forEach(line => unresolvedMap.set(line, (unresolvedMap.get(line)||0) + 1));
    fuzzyMatches.forEach(fm => { if (fuzzySample.length < 200) fuzzySample.push(fm); });

    const existingContains = new Set(r.contains || []);
    const existingMay = new Set(r.may_contain || []);
    const newContainsAdds = [...containsSet].filter(a => !existingContains.has(a));
    const finalContains = [...new Set([...existingContains, ...containsSet])];
    const finalMay = [...new Set([...existingMay, ...maySet])].filter(a => !finalContains.includes(a));

    if (newContainsAdds.length > 0) {
      addedTo++;
      additions.push({ id: r.id, name: r.name, before: r.contains, added: newContainsAdds, after: finalContains });
      if (!DRY_RUN) {
        await db.collection('products').doc(r.id).update({ contains: finalContains, may_contain: finalMay });
      }
    } else {
      unchanged++;
    }
  }

  console.log('\n=== SUMMARY (union-only: never removes existing allergens) ===');
  console.log('Total recipes:', recipes.length);
  console.log('No ingredients field:', noIngredients);
  console.log('Unchanged (nothing new found):', unchanged);
  console.log('Recipes with NEW allergens added:', addedTo);
  console.log('Mode:', DRY_RUN ? 'DRY RUN (no writes)' : 'APPLIED');

  console.log('\n=== Sample of additions (up to 50) ===');
  additions.slice(0, 50).forEach(c => console.log(`${c.id} | ${c.name} | before=[${c.before}] +added=[${c.added}] => after=[${c.after}]`));

  console.log('\n=== Sample fuzzy matches used (up to 40, for sanity-check) ===');
  fuzzySample.slice(0, 40).forEach(fm => console.log(`"${fm.line}"  ->  "${fm.matchedName}"`));

  const unresolvedSorted = [...unresolvedMap.entries()].sort((a,b)=>b[1]-a[1]);
  console.log('\n=== Unique unresolved ingredient lines even after fuzzy matching:', unresolvedSorted.length, '===');
  unresolvedSorted.slice(0, 60).forEach(([line,count]) => console.log(`(${count}x) ${line}`));

  require('fs').writeFileSync('/tmp/claude-0/-home-user-aziz/8e941f65-efbc-56d6-94db-b8f8de39ea42/scratchpad/recompute-report2.json', JSON.stringify({
    totalRecipes: recipes.length, noIngredients, unchanged, addedTo,
    additions, fuzzySample, unresolved: unresolvedSorted
  }, null, 2));
  console.log('\nFull report written to scratchpad/recompute-report2.json');

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
