const getTrustedOrigins = (env = process.env) => {
    const configured = String(env.CORS_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean)

    if (!configured.length) {
        if (env.NODE_ENV === 'production') {
            throw new Error('CORS_ORIGINS must contain the trusted frontend origins in production')
        }
        configured.push('http://localhost:5173')
    }

    return new Set(configured.map((origin) => {
        let parsed
        try {
            parsed = new URL(origin)
        } catch (error) {
            throw new Error('CORS_ORIGINS must contain valid origins')
        }
        if (parsed.origin !== origin || (env.NODE_ENV === 'production' && parsed.protocol !== 'https:')) {
            throw new Error('CORS_ORIGINS must contain exact origins and use HTTPS in production')
        }
        return origin
    }))
}

module.exports = getTrustedOrigins
