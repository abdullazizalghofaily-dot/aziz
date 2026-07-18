// One-time seed: writes the parsed TERRACE_CYCLE_MENU JSON into Firestore
// collection "menu" (docs: breakfast, lunch, dinner). Re-run any time to
// replace the menu wholesale (same operation Chef John's upload UI performs).
// Run locally: node scripts/seed-menu-data.js /path/to/menu-parsed.json
const admin = require('firebase-admin');
const fs = require('fs');

const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function main() {
  const jsonPath = process.argv[2];
  if (!jsonPath) {
    console.error('Usage: node seed-menu-data.js /path/to/menu-parsed.json');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  for (const meal of ['breakfast', 'lunch', 'dinner']) {
    if (!data[meal]) { console.warn(`No data for ${meal}, skipping`); continue; }
    await db.collection('menu').doc(meal).set(data[meal]);
    console.log(`Wrote menu/${meal}: ${data[meal].dates.length} dates, ${data[meal].rows.length} rows`);
  }
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
