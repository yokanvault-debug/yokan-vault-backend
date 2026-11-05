// node restore-user.js someone@example.com
// Brings back a user that was removed from the admin Users list (soft delete):
// clears deletedAt in MongoDB and re-enables the Firebase account.
require('./utils/netFix')
require('dotenv').config({ path: './config/.env', quiet: true })
const mongoose = require('mongoose')
const User = require('./models/user')
const { getFirebaseAuth, isFirebaseAdminConfigured } = require('./utils/firebaseAdmin')

const email = (process.argv[2] || '').trim().toLowerCase()
;(async () => {
    if (!email) { console.log('Usage: node restore-user.js someone@example.com'); process.exit(1) }
    await mongoose.connect(process.env.DB_URI || process.env.MONGODB_URI)
    const user = await User.findOne({ email })
    if (!user) { console.log('No user with that email in MongoDB'); process.exit(1) }
    user.deletedAt = null
    await user.save({ validateBeforeSave: false })
    console.log('MongoDB: deletedAt cleared')
    if (isFirebaseAdminConfigured()) {
        try {
            const auth = getFirebaseAuth()
            const fb = user.firebaseUid ? await auth.getUser(user.firebaseUid) : await auth.getUserByEmail(email)
            await auth.updateUser(fb.uid, { disabled: false })
            console.log('Firebase: account enabled')
        } catch (e) { console.log('Firebase: could not enable the account:', e.message) }
    } else {
        console.log('Firebase Admin not configured: enable the account in the Firebase console instead')
    }
    process.exit(0)
})().catch((e) => { console.log('Failed:', e.message); process.exit(1) })
