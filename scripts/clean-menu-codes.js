// Strips any trailing " (XX, YY, ...)" allergen-code groups (one or more,
// however many got appended) from every menu cell, restoring the original
// clean dish name text. Run this before re-applying match-menu-allergens.js
// to guarantee a pristine starting point.
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const CODE_GROUP_RE = /\s*\(([A-Z]{2}(?:,\s*[A-Z]{2})*)\)\s*$/;

function stripCodes(s) {
  let out = (s || '').trim();
  let m;
  while ((m = out.match(CODE_GROUP_RE))) {
    out = out.slice(0, m.index).trim();
  }
  return out;
}

async function main() {
  const menuDocs = ['breakfast', 'lunch', 'dinner'];
  for (const docId of menuDocs) {
    const d = await db.collection('menu').doc(docId).get();
    const data = d.data();
    let changedCount = 0;
    const newRows = (data.rows || []).map(row => {
      const newValues = {};
      Object.entries(row.values || {}).forEach(([date, v]) => {
        const cleaned = stripCodes(v);
        if (cleaned !== (v || '').trim()) changedCount++;
        newValues[date] = cleaned;
      });
      return { ...row, values: newValues };
    });
    await db.collection('menu').doc(docId).set({ ...data, rows: newRows });
    console.log(`${docId}: cleaned ${changedCount} cells`);
    await new Promise(r => setTimeout(r, 400));
  }
  console.log('Done.');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
