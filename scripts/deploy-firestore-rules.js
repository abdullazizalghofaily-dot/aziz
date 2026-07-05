// Deploys firestore.rules directly via the Firebase Rules API,
// bypassing `firebase deploy` (which needs serviceusage.services.get,
// a permission this project's default service account may lack).
const { GoogleAuth } = require('google-auth-library');
const fs = require('fs');
const path = require('path');
const https = require('https');

const KEY_PATH = path.join(__dirname, 'serviceAccountKey.json');
const PROJECT_ID = require(KEY_PATH).project_id;
const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');

function req(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const u = new URL(url);
    const options = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const r = https.request(options, res => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(chunks); } catch (e) { parsed = chunks; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  const auth = new GoogleAuth({ keyFile: KEY_PATH, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();

  const rulesContent = fs.readFileSync(RULES_PATH, 'utf8');

  console.log('Creating ruleset...');
  const createRuleset = await req('POST', `https://firebaserules.googleapis.com/v1/projects/${PROJECT_ID}/rulesets`, token, {
    source: { files: [{ name: 'firestore.rules', content: rulesContent }] }
  });
  console.log('createRuleset status:', createRuleset.status);
  if (createRuleset.status >= 300) {
    console.log(JSON.stringify(createRuleset.body, null, 2));
    process.exit(1);
  }
  const rulesetName = createRuleset.body.name;
  console.log('Ruleset created:', rulesetName);

  const releaseName = `projects/${PROJECT_ID}/releases/cloud.firestore`;
  console.log('Updating release...');
  let releaseRes = await req('PATCH', `https://firebaserules.googleapis.com/v1/${releaseName}`, token, {
    release: { name: releaseName, rulesetName }
  });
  if (releaseRes.status === 404 || releaseRes.status >= 400) {
    console.log('Patch failed (status ' + releaseRes.status + '), trying create...');
    releaseRes = await req('POST', `https://firebaserules.googleapis.com/v1/projects/${PROJECT_ID}/releases`, token, {
      name: releaseName, rulesetName
    });
  }
  console.log('release status:', releaseRes.status, JSON.stringify(releaseRes.body).slice(0, 400));
}

main().catch(err => { console.error(err); process.exit(1); });
