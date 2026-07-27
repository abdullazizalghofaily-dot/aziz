// One-time setup: creates a dedicated Firebase Auth account for a
// procurement/warehouse staff member and marks it as authorized via
// warehouseStaff/{uid}. Credentials are passed in, never hardcoded, so they
// don't end up in source control.
// Run locally: node scripts/create-warehouse-staff.js <email> <password> ["Display Name"]
const admin = require('firebase-admin');

const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

async function main() {
  const [email, password, displayName = 'Warehouse Staff'] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: node create-warehouse-staff.js <email> <password> ["Display Name"]');
    process.exit(1);
  }

  let user;
  try {
    user = await admin.auth().getUserByEmail(email);
    console.log('User already exists:', user.uid);
  } catch (e) {
    user = await admin.auth().createUser({ email, password, displayName });
    console.log('Created user:', user.uid);
  }
  await admin.firestore().collection('warehouseStaff').doc(user.uid).set({ name: displayName, email });
  console.log('warehouseStaff doc written for uid', user.uid);
}

main().catch(err => { console.error(err); process.exit(1); });
