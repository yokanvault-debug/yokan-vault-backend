const getRequestOrigin = (req) => {
    const origin = req.get('origin')
    if (origin) return origin

    const referer = req.get('referer')
    if (!referer) return null
    try {
        return new URL(referer).origin
    } catch (error) {
        return null
    }
}

const createCsrfProtection = (trustedOrigins) => (req, res, next) => {
    const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS'])
    if (safeMethods.has(req.method) || !req.cookies?.token) return next()

    const requestOrigin = getRequestOrigin(req)
    if (!requestOrigin || !trustedOrigins.has(requestOrigin)) {
        return res.status(403).json({ message: 'Request origin is not allowed' })
    }
    return next()
}

module.exports = { createCsrfProtection, getRequestOrigin }
