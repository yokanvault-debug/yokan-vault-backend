require('./utils/netFix')
// node check-cloudinary.js   -> tells you why Cloudinary does or doesn't work from THIS computer
require('dotenv').config({ path: './config/.env', quiet: true })
const https = require('https')
const cloudinary = require('cloudinary')
cloudinary.config({
    cloud_name: (process.env.CLOUDINARY_CLOUD_NAME || '').trim(),
    api_key: (process.env.CLOUDINARY_API_KEY || '').trim(),
    api_secret: (process.env.CLOUDINARY_API_SECRET || '').trim(),
})
const cfg = cloudinary.v2.config()
console.log('cloud name :', JSON.stringify(cfg.cloud_name))
console.log('api key    :', cfg.api_key ? cfg.api_key.slice(0, 4) + '... (' + cfg.api_key.length + ' chars)' : 'MISSING')
console.log('api secret :', cfg.api_secret ? 'set (' + cfg.api_secret.length + ' chars)' : 'MISSING')

const reach = (host) => new Promise((resolve) => {
    const req = https.get({ host, path: '/', timeout: 8000 }, (res) => { res.resume(); resolve(`reachable (HTTP ${res.statusCode})`) })
    req.on('timeout', () => { req.destroy(); resolve('TIMEOUT - blocked or no connection') })
    req.on('error', (e) => resolve(`ERROR ${e.code || ''} ${e.message || (e.errors && e.errors.map(x => x.code).join(','))}`))
})

;(async () => {
    console.log('\nnetwork test:')
    console.log('  api.cloudinary.com ->', await reach('api.cloudinary.com'))
    console.log('  res.cloudinary.com ->', await reach('res.cloudinary.com'))
    console.log('\ncredentials test:')
    try {
        await cloudinary.v2.api.ping()
        console.log('  OK: keys are valid')
        const res = await cloudinary.v2.api.resources({ max_results: 5 })
        console.log('  assets found:', res.resources.length, res.resources.map(r => r.secure_url))
    } catch (e) {
        const err = e.error || e
        console.log('  FAILED')
        console.log('  message  :', err.message || '(empty)')
        console.log('  http     :', err.http_code || e.http_code || '(no response from Cloudinary)')
        console.log('  code     :', err.code || e.code || '-', err.errors ? err.errors.map(x => x.code) : '')
        console.log('\n  no http code + empty message = the request never reached Cloudinary (network/firewall/DNS/IPv6).')
        console.log('  http 401 = wrong cloud name, API key or secret.')
    }
})()
