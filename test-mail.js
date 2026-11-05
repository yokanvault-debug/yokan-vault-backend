// Sends a test email through your Mailtrap settings:  node test-mail.js you@example.com
// Open your Mailtrap inbox afterwards - the message shows up there (Mailtrap never delivers to real inboxes).
require('dotenv').config({ path: './config/.env' })
const { verifySmtp, sendVerificationEmail, getConfig, missingSettings } = require('./utils/emailService')

const to = process.argv[2] || 'test@example.com'
const cfg = getConfig()

console.log(`Mailtrap host: ${cfg.host || '(missing)'}  port: ${cfg.port}  user: ${cfg.user ? 'set' : '(missing)'}  pass: ${cfg.pass ? 'set' : '(missing)'}  from: ${cfg.fromAddress || '(missing)'}`)
const missing = missingSettings()
if (missing.length) {
    console.log(`Missing in config/.env: ${missing.join(', ')}`)
    process.exit(1)
}

verifySmtp()
    .then(() => {
        console.log('1/2 Mailtrap login accepted')
        return sendVerificationEmail(to, `${process.env.STORE_URL || 'http://localhost:5173'}/verify-email?test=1`, 'Test', 'User')
    })
    .then(() => console.log(`2/2 Test email sent to ${to} - check your Mailtrap inbox`))
    .catch(err => {
        console.log('FAILED:', err.message)
        if (/535|auth/i.test(err.message)) console.log('-> username/password are wrong: copy them again from Mailtrap > Email Testing > Inboxes > SMTP settings')
        if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(err.message)) console.log('-> cannot reach the host: check EMAIL_HOST / EMAIL_PORT (sandbox.smtp.mailtrap.io : 2525) and your internet / firewall')
        process.exit(1)
    })
