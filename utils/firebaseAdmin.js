const fs = require('fs');
const path = require('path');
const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

// Looks for the Firebase service-account json in several places, because a relative
// path written in .env (like ..\..\file.json) depends on where `npm start` was run from.
const candidatePaths = () => {
  const list = [];
  const configured = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (configured) {
    const cleaned = configured.trim().replace(/^["']|["']$/g, '').replace(/\\/g, path.sep);
    list.push(path.resolve(cleaned));                        // relative to where node was started
    list.push(path.resolve(__dirname, '..', cleaned));       // relative to backend/
    list.push(path.resolve(__dirname, '..', '..', cleaned)); // relative to the project folder
  }
  list.push(path.join(__dirname, '..', 'firebaseServiceAccountKey.json'));
  list.push(path.join(__dirname, '..', 'config', 'firebaseServiceAccountKey.json'));

  // last resort: any *firebase-adminsdk*.json in backend/ or one/two folders up
  for (const dir of [path.join(__dirname, '..', 'config'), path.join(__dirname, '..'), path.join(__dirname, '..', '..'), path.join(__dirname, '..', '..', '..')]) {
    try {
      for (const file of fs.readdirSync(dir)) {
        if (/firebase-adminsdk.*\.json$/i.test(file)) list.push(path.join(dir, file));
      }
    } catch (error) { /* folder not readable, skip */ }
  }
  return list;
};

let firebaseAuth = null;
let loaded = false;

// Loaded the first time it is needed (not at require time), because server.js reads
// config/.env only after app.js and everything it requires has been loaded.
const load = () => {
  if (loaded) return;
  loaded = true;
  try {
    let serviceAccount = null;
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } else {
      const found = candidatePaths().find((file) => fs.existsSync(file));
      if (found) {
        serviceAccount = JSON.parse(fs.readFileSync(found, 'utf8'));
      }
    }
    if (serviceAccount) {
      const app = getApps()[0] || initializeApp({ credential: cert(serviceAccount) });
      firebaseAuth = getAuth(app);
      console.log('Firebase Admin ready');
    } else {
      console.log('Firebase Admin: service-account json not found. Set FIREBASE_SERVICE_ACCOUNT_PATH in config/.env');
    }
  } catch (error) {
    console.error('Firebase Admin failed to start:', error.code || error.name || 'unknown error');
  }
};

const isFirebaseAdminConfigured = () => {
  load();
  return Boolean(firebaseAuth);
};

const getFirebaseAuth = () => {
  load();
  if (!firebaseAuth) {
    throw new Error('Firebase Admin credentials are missing. Set FIREBASE_SERVICE_ACCOUNT_PATH (or FIREBASE_SERVICE_ACCOUNT_JSON) in backend/config/.env to your Yokan Vault service-account json file.');
  }
  return firebaseAuth;
};

module.exports = { getFirebaseAuth, isFirebaseAdminConfigured };
