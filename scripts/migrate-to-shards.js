// One-time migration: populates catalogSnapshot/shard_0..19 from the current
// products collection, so index.html can read 20 documents instead of the
// entire ~9000-document collection on every visit.
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const NUM_SHARDS = 20;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, label) {
  const delays = [3000, 6000, 12000, 24000, 48000, 60000, 60000, 60000];
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
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

async function main() {
  console.log('Fetching full products collection (paginated)...');
  const items = await fetchAllPaged(300);
  console.log(`Loaded ${items.length} items.`);

  const shards = Array.from({ length: NUM_SHARDS }, () => []);
  items.forEach((item, i) => shards[i % NUM_SHARDS].push(item));

  for (let i = 0; i < NUM_SHARDS; i++) {
    await withRetry(() => db.collection('catalogSnapshot').doc('shard_' + i).set({ items: shards[i] }), `write shard_${i}`);
    console.log(`Wrote shard_${i}: ${shards[i].length} items`);
    await sleep(500);
  }
  console.log('Done.');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
