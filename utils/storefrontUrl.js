const getTrustedOrigins = require('./trustedOrigins')

const getStorefrontUrl = (env = process.env) => {
    let configured = String(env.STORE_URL || '').trim()
    if (!configured) {
        if (env.NODE_ENV === 'production') {
            throw new Error('STORE_URL must be configured in production')
        }
        configured = 'http://localhost:5173'
    }

    let parsed
    try {
        parsed = new URL(configured)
    } catch (error) {
        throw new Error('STORE_URL must be a valid origin')
    }

    const normalized = configured.replace(/\/$/, '')
    if (parsed.origin !== normalized || !getTrustedOrigins(env).has(parsed.origin)) {
        throw new Error('STORE_URL must be an exact trusted origin')
    }
    return parsed.origin
}

module.exports = getStorefrontUrl
