// Creates (or repairs) an admin you can log in with:   node seed-admin.js
//   email: admin@yokanvault.com    password: Admin#12345
// Needs config/.env (MongoDB) and the Firebase service-account json, same as the server.
require('dotenv').config({ path: './config/.env' })
const mongoose = require('mongoose')
const User = require('./models/user')
const { getFirebaseAuth, isFirebaseAdminConfigured } = require('./utils/firebaseAdmin')

const EMAIL = process.env.ADMIN_EMAIL || 'admin@yokanvault.com'
const PASSWORD = process.env.ADMIN_PASSWORD || 'Admin#12345'
const USERNAME = 'yokanadmin'

;(async () => {
    if (!isFirebaseAdminConfigured()) { console.log('Firebase Admin is not configured - see FIREBASE_SERVICE_ACCOUNT_PATH'); process.exit(1) }
    await mongoose.connect(process.env.DB_URI || process.env.MONGODB_URI)
    const auth = getFirebaseAuth()
    let fb
    try {
        fb = await auth.getUserByEmail(EMAIL)
        fb = await auth.updateUser(fb.uid, { password: PASSWORD, emailVerified: true, displayName: 'Yokan Admin' })
    } catch (e) {
        fb = await auth.createUser({ email: EMAIL, password: PASSWORD, emailVerified: true, displayName: 'Yokan Admin' })
    }
    await User.findOneAndUpdate(
        { email: EMAIL },
        { $set: { firebaseUid: fb.uid, email: EMAIL, username: USERNAME, displayName: 'Yokan Admin', name: 'Yokan Admin', role: 'admin' } },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    )
    console.log(`Admin ready  ->  ${EMAIL}  /  ${PASSWORD}`)
    process.exit(0)
})().catch((e) => { console.log('Failed:', e.message); process.exit(1) })
