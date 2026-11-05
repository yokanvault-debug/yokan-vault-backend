// Makes an account an admin (or lists the accounts).
//   node make-admin.js --list                  show every account and its role
//   node make-admin.js someone@email.com       make that account an admin
//   node make-admin.js someone@email.com user  put it back to a normal user
require('dotenv').config({ path: './config/.env' })
const mongoose = require('mongoose')

const uri = process.env.DB_URI || process.env.MONGODB_URI
const [arg, roleArg] = process.argv.slice(2)

if (!uri) {
    console.log('No DB_URI / MONGODB_URI found in config/.env')
    process.exit(1)
}
if (!arg) {
    console.log('Usage: node make-admin.js --list | node make-admin.js <email> [admin|user]')
    process.exit(1)
}

mongoose.connect(uri).then(async () => {
    // raw collection: works for accounts from both the original Yokan and itcp318
    const users = mongoose.connection.collection('users')

    if (arg === '--list') {
        const all = await users.find({}, { projection: { email: 1, username: 1, role: 1 } }).toArray()
        if (!all.length) console.log('No accounts yet. Register one on the site first.')
        all.forEach(u => console.log(`${(u.role || 'user').padEnd(6)} ${u.email}${u.username ? '  (@' + u.username + ')' : ''}`))
    } else {
        const role = roleArg === 'user' ? 'user' : 'admin'
        const result = await users.updateOne({ email: arg.toLowerCase() }, { $set: { role } })
        if (!result.matchedCount) {
            console.log(`No account with the email ${arg}. Register it on the site first, then run this again.`)
        } else {
            console.log(`${arg} is now: ${role}. Log out and log in again on the site.`)
        }
    }
    await mongoose.disconnect()
}).catch(err => {
    console.log('Could not connect to MongoDB:', err.message)
    process.exit(1)
})
