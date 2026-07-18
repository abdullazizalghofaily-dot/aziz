// One-time setup: creates a dedicated Firebase Auth account for a menu editor
// and marks it as authorized via menuEditors/{uid}. Credentials are passed in,
// never hardcoded, so they don't end up in source control.
// Run locally: node scripts/create-chef-john.js <email> <password> ["Display Name"]
const admin = require('firebase-admin');

const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

async function main() {
  const [email, password, displayName = 'Chef John'] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: node create-chef-john.js <email> <password> ["Display Name"]');
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
  await admin.firestore().collection('menuEditors').doc(user.uid).set({ name: displayName, email });
  console.log('menuEditors doc written for uid', user.uid);
}

main().catch(err => { console.error(err); process.exit(1); });
