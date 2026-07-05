// One-time import of data-export.json into the Firestore "products" collection.
// Run locally: node scripts/migrate-data-to-firestore.js
// Requires scripts/serviceAccountKey.json (Firebase Console > Project settings > Service accounts > Generate new private key).
// Never commit serviceAccountKey.json — it is already listed in .gitignore.
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const BATCH_SIZE = 400; // Firestore batch write limit is 500

async function migrate() {
  const dataPath = path.join(__dirname, '..', 'data-export.json');
  const items = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  console.log(`Importing ${items.length} products into Firestore collection "products"...`);

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = items.slice(i, i + BATCH_SIZE);
    for (const item of chunk) {
      const { id, ...rest } = item;
      const ref = db.collection('products').doc(String(id));
      batch.set(ref, rest);
    }
    await batch.commit();
    console.log(`  committed ${Math.min(i + BATCH_SIZE, items.length)}/${items.length}`);
  }
  console.log('Done.');
}

migrate().catch(err => {
  console.error(err);
  process.exit(1);
});
