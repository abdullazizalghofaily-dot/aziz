// One-time migration: populates catalogSnapshot/shard_0..19 from the current
// products collection, so index.html can read 20 documents instead of the
// entire ~9000-document collection on every visit.
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const NUM_SHARDS = 20;

async function main() {
  console.log('Fetching full products collection...');
  const snap = await db.collection('products').get();
  const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  console.log(`Loaded ${items.length} items.`);

  const shards = Array.from({ length: NUM_SHARDS }, () => []);
  items.forEach((item, i) => shards[i % NUM_SHARDS].push(item));

  for (let i = 0; i < NUM_SHARDS; i++) {
    await db.collection('catalogSnapshot').doc('shard_' + i).set({ items: shards[i] });
    console.log(`Wrote shard_${i}: ${shards[i].length} items`);
  }
  console.log('Done.');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
