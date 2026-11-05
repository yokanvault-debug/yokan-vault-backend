const createRateLimiter = ({ windowMs, max }) => {
    const requests = new Map()

    return (req, res, next) => {
        const key = req.ip || req.socket?.remoteAddress || 'unknown'
        const now = Date.now()
        const current = requests.get(key)
        const entry = !current || current.resetAt <= now
            ? { count: 0, resetAt: now + windowMs }
            : current

        if (entry.count >= max) {
            res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)))
            return res.status(429).json({ message: 'Too many requests. Please try again later.' })
        }

        entry.count += 1
        requests.set(key, entry)
        if (requests.size > 10_000) {
            for (const [client, record] of requests) {
                if (record.resetAt <= now) requests.delete(client)
            }
        }
        next()
    }
}

module.exports = createRateLimiter
