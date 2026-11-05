const test = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const express = require('express')
const cookieParser = require('cookie-parser')
const jwt = require('jsonwebtoken')
const cloudinary = require('cloudinary')
const User = require('../models/user')
const Product = require('../models/product')
const Order = require('../models/order')
const firebaseAdmin = require('../utils/firebaseAdmin')
const productRoutes = require('../routes/product')
const authRoutes = require('../routes/auth')
const orderRoutes = require('../routes/order')
const { isAuthenticatedUser } = require('../middleware/auth')
const { verifyFirebaseToken, verifyFirebaseProfileToken } = require('../middleware/firebaseAuth')
const { sendVerification } = require('../controllers/firebaseauth')
const authController = require('../controllers/auth')
const emailService = require('../utils/emailService')
const APIFeatures = require('../utils/apiFeatures')
const createRateLimiter = require('../middleware/rateLimit')
const getTrustedOrigins = require('../utils/trustedOrigins')
const getStorefrontUrl = require('../utils/storefrontUrl')
const { createCsrfProtection } = require('../middleware/csrf')
const { PAID_ORDER_MATCH } = require('../utils/salesReports')

const response = () => ({
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
        this.statusCode = code
        return this
    },
    json(body) {
        this.body = body
        return this
    },
    set(name, value) {
        this.headers[name] = value
        return this
    }
})

const invoke = async (handler, req) => {
    const res = response()
    let calledNext = false
    await handler(req, res, () => { calledNext = true })
    return { res, calledNext }
}

const startApi = async () => {
    const app = express()
    app.use(cookieParser())
    app.use(express.json())
    app.use('/api/v1', productRoutes)
    app.use('/api/v1', authRoutes)
    app.use('/api/v1', orderRoutes)
    const server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    return {
        origin: `http://127.0.0.1:${server.address().port}/api/v1`,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve())
        })
    }
}

const withAuthMocks = async (fn) => {
    const originalJwtSecret = process.env.JWT_SECRET
    const originalFindById = User.findById
    const originalFindOne = User.findOne
    const originalProductCreate = Product.create
    const originalOrderAggregate = Order.aggregate
    const originalOrderFind = Order.find
    const users = {
        regular: { _id: 'regular', role: 'user', deletedAt: null },
        admin: { _id: 'admin', role: 'admin', deletedAt: null }
    }
    const aggregates = []
    let createCount = 0

    process.env.JWT_SECRET = 'test-secret'
    User.findById = async (id) => users[id] || { _id: id, name: 'Private user', email: 'private@example.test' }
    User.findOne = async () => null
    Product.create = async (data) => {
        createCount += 1
        return { _id: 'product-test', ...data }
    }
    Order.aggregate = async (pipeline) => {
        aggregates.push(pipeline)
        return []
    }
    Order.find = async () => []

    try {
        await fn({
            users,
            aggregates,
            get createCount() { return createCount },
            tokenFor: (id) => jwt.sign({ id }, 'test-secret')
        })
    } finally {
        if (originalJwtSecret === undefined) delete process.env.JWT_SECRET
        else process.env.JWT_SECRET = originalJwtSecret
        User.findById = originalFindById
        User.findOne = originalFindOne
        Product.create = originalProductCreate
        Order.aggregate = originalOrderAggregate
        Order.find = originalOrderFind
    }
}

test('product creation is admin-only while admins retain create access', async () => {
    await withAuthMocks(async (context) => {
        const api = await startApi()
        try {
            const regularResponse = await fetch(`${api.origin}/admin/product/new`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    cookie: `token=${context.tokenFor('regular')}`
                },
                body: JSON.stringify({ name: 'Forbidden product' })
            })
            assert.equal(regularResponse.status, 403)
            assert.equal(context.createCount, 0)

            const adminResponse = await fetch(`${api.origin}/admin/product/new`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    cookie: `token=${context.tokenFor('admin')}`
                },
                body: JSON.stringify({ name: 'Admin product' })
            })
            assert.equal(adminResponse.status, 201)
            assert.equal(context.createCount, 1)
        } finally {
            await api.close()
        }
    })
})

test('only admins can update products or delete reviews', async () => {
    const originals = {
        findById: Product.findById,
        findByIdAndUpdate: Product.findByIdAndUpdate
    }
    const productId = '64b000000000000000000001'
    const reviewId = '64b000000000000000000002'
    const product = {
        _id: productId,
        images: [],
        reviews: [{ _id: { toString: () => reviewId }, rating: 4, user: 'regular' }],
        ratings: 4,
        numOfReviews: 1
    }
    let updateCount = 0
    Product.findById = async () => product
    Product.findByIdAndUpdate = async (_id, update) => {
        updateCount += 1
        Object.assign(product, update)
        return product
    }
    try {
        await withAuthMocks(async (context) => {
            const api = await startApi()
            try {
                const customerUpdate = await fetch(`${api.origin}/admin/product/${productId}`, {
                    method: 'PUT',
                    headers: {
                        'content-type': 'application/json',
                        cookie: `token=${context.tokenFor('regular')}`
                    },
                    body: JSON.stringify({ name: 'Customer edit' })
                })
                assert.equal(customerUpdate.status, 403)
                assert.equal(updateCount, 0)

                const adminUpdate = await fetch(`${api.origin}/admin/product/${productId}`, {
                    method: 'PUT',
                    headers: {
                        'content-type': 'application/json',
                        cookie: `token=${context.tokenFor('admin')}`
                    },
                    body: JSON.stringify({ name: 'Admin edit' })
                })
                assert.equal(adminUpdate.status, 200)
                assert.equal(product.name, 'Admin edit')

                const customerDelete = await fetch(`${api.origin}/reviews?id=${reviewId}&productId=${productId}`, {
                    method: 'DELETE',
                    headers: { cookie: `token=${context.tokenFor('regular')}` }
                })
                assert.equal(customerDelete.status, 403)
                assert.equal(updateCount, 1)

                const adminDelete = await fetch(`${api.origin}/reviews?id=${reviewId}&productId=${productId}`, {
                    method: 'DELETE',
                    headers: { cookie: `token=${context.tokenFor('admin')}` }
                })
                assert.equal(adminDelete.status, 200)
                assert.equal(product.reviews.length, 0)
                assert.equal(product.numOfReviews, 0)
                assert.equal(product.ratings, 0)
                assert.equal(updateCount, 2)
            } finally {
                await api.close()
            }
        })
    } finally {
        Product.findById = originals.findById
        Product.findByIdAndUpdate = originals.findByIdAndUpdate
    }
})

test('unverified Firebase bearer tokens cannot reach protected routes or link legacy accounts', async () => {
    const originalConfigured = firebaseAdmin.isFirebaseAdminConfigured
    const originalGetAuth = firebaseAdmin.getFirebaseAuth
    const originalFindOne = User.findOne
    let lookupCount = 0
    const unverified = {
        uid: 'unverified-id',
        email: 'legacy@example.test',
        email_verified: false,
        firebase: { sign_in_provider: 'password' }
    }
    firebaseAdmin.isFirebaseAdminConfigured = () => true
    firebaseAdmin.getFirebaseAuth = () => ({ verifyIdToken: async () => unverified })
    User.findOne = async (query) => {
        lookupCount += 1
        return query.firebaseUid ? null : { _id: 'legacy', email: unverified.email, role: 'admin' }
    }
    try {
        const protectedResult = await invoke(isAuthenticatedUser, {
            headers: { authorization: 'Bearer test-token' },
            cookies: {}
        })
        assert.equal(protectedResult.res.statusCode, 401)
        assert.equal(lookupCount, 0)

        const profileResult = await invoke(verifyFirebaseProfileToken, {
            headers: { authorization: 'Bearer test-token' },
            originalUrl: '/api/users/profile'
        })
        assert.equal(profileResult.res.statusCode, 403)
        assert.equal(lookupCount, 2)
    } finally {
        firebaseAdmin.isFirebaseAdminConfigured = originalConfigured
        firebaseAdmin.getFirebaseAuth = originalGetAuth
        User.findOne = originalFindOne
    }
})

test('verified Firebase identities and Google provider verification remain supported', async () => {
    const originalConfigured = firebaseAdmin.isFirebaseAdminConfigured
    const originalGetAuth = firebaseAdmin.getFirebaseAuth
    const originalFindOne = User.findOne
    const user = { _id: 'firebase-user', role: 'user', username: 'collector', deletedAt: null }
    const identities = {
        verified: {
            uid: 'firebase-user',
            email: 'collector@example.test',
            email_verified: true,
            firebase: { sign_in_provider: 'password' }
        },
        google: {
            uid: 'google-user',
            email: 'google@example.test',
            email_verified: false,
            firebase: { sign_in_provider: 'google.com' }
        }
    }
    firebaseAdmin.isFirebaseAdminConfigured = () => true
    firebaseAdmin.getFirebaseAuth = () => ({
        verifyIdToken: async (token) => identities[token]
    })
    User.findOne = async (query) => query.firebaseUid ? user : null
    try {
        for (const token of ['verified', 'google']) {
            const result = await invoke(verifyFirebaseToken, {
                headers: { authorization: `Bearer ${token}` },
                originalUrl: '/api/v1/orders/me'
            })
            assert.equal(result.calledNext, true)
            assert.equal(result.res.statusCode, 200)
        }
    } finally {
        firebaseAdmin.isFirebaseAdminConfigured = originalConfigured
        firebaseAdmin.getFirebaseAuth = originalGetAuth
        User.findOne = originalFindOne
    }
})

test('unverified tokens cannot link legacy email accounts; verified tokens can', async () => {
    const originalConfigured = firebaseAdmin.isFirebaseAdminConfigured
    const originalGetAuth = firebaseAdmin.getFirebaseAuth
    const originalFindOne = User.findOne
    let saves = 0
    let decoded = {
        uid: 'new-firebase-id',
        email: 'legacy@example.test',
        email_verified: false,
        firebase: { sign_in_provider: 'password' }
    }
    const legacyUser = {
        _id: 'legacy-user',
        username: 'legacy',
        role: 'user',
        save: async () => { saves += 1 }
    }
    firebaseAdmin.isFirebaseAdminConfigured = () => true
    firebaseAdmin.getFirebaseAuth = () => ({ verifyIdToken: async () => decoded })
    User.findOne = async (query) => query.firebaseUid ? null : legacyUser
    try {
        const blocked = await invoke(verifyFirebaseProfileToken, {
            headers: { authorization: 'Bearer test-token' },
            originalUrl: '/api/users/profile'
        })
        assert.equal(blocked.res.statusCode, 403)
        assert.equal(saves, 0)

        decoded = { ...decoded, email_verified: true }
        const allowed = await invoke(verifyFirebaseToken, {
            headers: { authorization: 'Bearer test-token' },
            originalUrl: '/api/v1/orders/me'
        })
        assert.equal(allowed.calledNext, true)
        assert.equal(saves, 1)
        assert.equal(legacyUser.firebaseUid, decoded.uid)
    } finally {
        firebaseAdmin.isFirebaseAdminConfigured = originalConfigured
        firebaseAdmin.getFirebaseAuth = originalGetAuth
        User.findOne = originalFindOne
    }
})

test('user detail endpoint denies regular users and preserves admin access', async () => {
    await withAuthMocks(async ({ tokenFor }) => {
        const api = await startApi()
        try {
            const blocked = await fetch(`${api.origin}/admin/user/target`, {
                headers: { cookie: `token=${tokenFor('regular')}` }
            })
            assert.equal(blocked.status, 403)

            const allowed = await fetch(`${api.origin}/admin/user/target`, {
                headers: { cookie: `token=${tokenFor('admin')}` }
            })
            assert.equal(allowed.status, 200)
            assert.equal((await allowed.json()).user.email, 'private@example.test')
        } finally {
            await api.close()
        }
    })
})

test('sales endpoints require admin access and report routes use paid-order filters', async () => {
    await withAuthMocks(async ({ tokenFor, aggregates }) => {
        const api = await startApi()
        try {
            const paths = [
                '/admin/orders/',
                '/admin/total-orders',
                '/admin/total-sales',
                '/admin/product-sales',
                '/admin/customer-sales',
                '/admin/sales-per-month'
            ]
            for (const path of paths) {
                const anonymous = await fetch(`${api.origin}${path}`)
                assert.equal(anonymous.status, 401, path)

                const regular = await fetch(`${api.origin}${path}`, {
                    headers: { cookie: `token=${tokenFor('regular')}` }
                })
                assert.equal(regular.status, 403, path)

                const admin = await fetch(`${api.origin}${path}`, {
                    headers: { cookie: `token=${tokenFor('admin')}` }
                })
                assert.equal(admin.status, 200, path)
            }
            assert.equal(aggregates.length, 5)
            const paidReportPipelines = aggregates.filter(pipeline =>
                pipeline.some(stage => stage.$match?.['paymentInfo.status'] === 'Paid'))
            assert.equal(paidReportPipelines.length, 4)
            for (const pipeline of paidReportPipelines) {
                const match = pipeline.find((stage) => stage.$match)?.$match
                assert.deepEqual(match['paymentInfo.status'], PAID_ORDER_MATCH['paymentInfo.status'])
                assert.deepEqual(match.orderStatus, PAID_ORDER_MATCH.orderStatus)
                assert.deepEqual(match.inventoryReserved, PAID_ORDER_MATCH.inventoryReserved)
            }
        } finally {
            await api.close()
        }
    })
})

test('regular users cannot mutate orders through administrative routes', async () => {
    await withAuthMocks(async ({ tokenFor }) => {
        const api = await startApi()
        try {
            const anonymous = await fetch(`${api.origin}/admin/order/order-test`, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ status: 'Shipped' })
            })
            assert.equal(anonymous.status, 401)

            const regular = await fetch(`${api.origin}/admin/order/order-test`, {
                method: 'PUT',
                headers: {
                    'content-type': 'application/json',
                    cookie: `token=${tokenFor('regular')}`
                },
                body: JSON.stringify({ status: 'Shipped' })
            })
            assert.equal(regular.status, 403)
        } finally {
            await api.close()
        }
    })
})

test('the legacy duplicate product-sales endpoint has been removed', () => {
    const productRoute = productRoutes.stack.find((layer) => layer.route?.path === '/admin/product-sales')
    const orderRoute = orderRoutes.stack.filter((layer) => layer.route?.path === '/admin/product-sales')
    assert.equal(productRoute, undefined)
    assert.equal(orderRoute.length, 1)
})

test('registration does not log the request body or password', async () => {
    const originalUpload = cloudinary.v2.uploader.upload
    const originalCreate = User.create
    const originalCookieExpires = process.env.COOKIE_EXPIRES_TIME
    const originalLog = console.log
    const originalWarn = console.warn
    const originalError = console.error
    const entries = []
    cloudinary.v2.uploader.upload = async () => ({ public_id: 'avatar-id', secure_url: 'https://example.test/avatar.png' })
    User.create = async () => ({ getJwtToken: () => 'test-only-token' })
    process.env.COOKIE_EXPIRES_TIME = '1'
    console.log = (...args) => entries.push(args.join(' '))
    console.warn = (...args) => entries.push(args.join(' '))
    console.error = (...args) => entries.push(args.join(' '))
    const res = response()
    res.cookie = () => res
    try {
        await authController.registerUser({
            body: { name: 'Test', email: 'test@example.test', password: 'do-not-log-this', avatar: 'data:image/png;base64,AA==' }
        }, res)
        assert.equal(entries.length, 0)
        assert.equal(JSON.stringify(entries).includes('do-not-log-this'), false)
    } finally {
        cloudinary.v2.uploader.upload = originalUpload
        User.create = originalCreate
        if (originalCookieExpires === undefined) delete process.env.COOKIE_EXPIRES_TIME
        else process.env.COOKIE_EXPIRES_TIME = originalCookieExpires
        console.log = originalLog
        console.warn = originalWarn
        console.error = originalError
    }
})

test('password recovery response does not reveal whether an email is registered', async () => {
    const originalFindOne = User.findOne
    const originalEnv = {
        NODE_ENV: process.env.NODE_ENV,
        STORE_URL: process.env.STORE_URL,
        CORS_ORIGINS: process.env.CORS_ORIGINS
    }
    process.env.NODE_ENV = 'test'
    process.env.STORE_URL = 'http://localhost:5173'
    delete process.env.CORS_ORIGINS
    User.findOne = async () => null
    try {
        const res = response()
        await authController.forgotPassword({ body: { email: 'unknown@example.test' } }, res)
        assert.equal(res.statusCode, 200)
        assert.equal(
            res.body.message,
            'If an account exists for that email, password recovery instructions will be sent.'
        )
    } finally {
        User.findOne = originalFindOne
        for (const [key, value] of Object.entries(originalEnv)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
})

test('storefront links require an explicitly configured trusted origin in production', () => {
    assert.throws(
        () => getStorefrontUrl({ NODE_ENV: 'production', CORS_ORIGINS: 'https://vault.example' }),
        /STORE_URL must be configured/
    )
    assert.throws(
        () => getStorefrontUrl({
            NODE_ENV: 'production',
            CORS_ORIGINS: 'https://vault.example',
            STORE_URL: 'https://other.example'
        }),
        /exact trusted origin/
    )
    assert.equal(getStorefrontUrl({
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://vault.example',
        STORE_URL: 'https://vault.example'
    }), 'https://vault.example')
})

test('serialized user records omit passwords and password-reset tokens', () => {
    const user = new User({
        name: 'Test User',
        email: 'test@example.test',
        password: 'stored-hash',
        resetPasswordToken: 'reset-hash',
        resetPasswordExpire: new Date()
    })
    const serialized = JSON.parse(JSON.stringify(user))
    assert.equal(serialized.password, undefined)
    assert.equal(serialized.resetPasswordToken, undefined)
    assert.equal(serialized.resetPasswordExpire, undefined)
})

test('verification email requires a Firebase token and uses its email identity', async () => {
    const originalGetAuth = firebaseAdmin.getFirebaseAuth
    const originalSend = emailService.sendVerificationEmail
    const sent = []
    firebaseAdmin.getFirebaseAuth = () => ({
        verifyIdToken: async (token) => {
            if (token !== 'valid-registration-token') throw Object.assign(new Error('not valid'), { code: 'auth/invalid-id-token' })
            return {
                uid: 'registration-user',
                email: 'verified-owner@example.test',
                email_verified: false,
                firebase: { sign_in_provider: 'password' }
            }
        },
        generateEmailVerificationLink: async (email) => `https://firebase.example.test/verify?email=${encodeURIComponent(email)}`
    })
    emailService.sendVerificationEmail = async (...args) => { sent.push(args) }
    try {
        const anonymous = await invoke(sendVerification, { headers: {}, body: { email: 'victim@example.test' } })
        assert.equal(anonymous.res.statusCode, 401)
        assert.equal(sent.length, 0)

        const authenticated = await invoke(sendVerification, {
            headers: { authorization: 'Bearer valid-registration-token' },
            body: { email: 'victim@example.test', firstName: '<img>', lastName: 'Collector' }
        })
        assert.equal(authenticated.res.statusCode, 200)
        assert.equal(authenticated.res.body.message, 'If the account can be verified, an email will be sent.')
        assert.equal(sent[0][0], 'verified-owner@example.test')
        assert.equal(sent[0][2], '<img>')
    } finally {
        firebaseAdmin.getFirebaseAuth = originalGetAuth
        emailService.sendVerificationEmail = originalSend
    }
})

test('verification HTML escapes names and URLs without sending a message', async () => {
    const nodemailer = require('nodemailer')
    const originalCreateTransport = nodemailer.createTransport
    let message
    nodemailer.createTransport = () => ({
        sendMail: async (options) => { message = options; return { messageId: 'mock-only' } }
    })
    const oldEnv = {
        EMAIL_HOST: process.env.EMAIL_HOST,
        EMAIL_USER: process.env.EMAIL_USER,
        EMAIL_PASS: process.env.EMAIL_PASS,
        EMAIL_FROM_ADDRESS: process.env.EMAIL_FROM_ADDRESS
    }
    Object.assign(process.env, {
        EMAIL_HOST: 'mail.example.test',
        EMAIL_USER: 'test-user',
        EMAIL_PASS: 'test-password',
        EMAIL_FROM_ADDRESS: 'no-reply@example.test'
    })
    try {
        await emailService.sendVerificationEmail('test@example.test', 'https://example.test/?x="><script>', '<img>', 'Name')
        assert.match(message.html, /&lt;img&gt;/)
        assert.match(message.html, /&quot;&gt;&lt;script&gt;/)
        assert.doesNotMatch(message.html, /<img>/)
        assert.doesNotMatch(message.html, /<script>/)
    } finally {
        nodemailer.createTransport = originalCreateTransport
        for (const [key, value] of Object.entries(oldEnv)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
})

test('verification email limiter returns 429 after the configured request count', async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 })
    const first = await invoke(limiter, { ip: 'test-client' })
    const second = await invoke(limiter, { ip: 'test-client' })
    assert.equal(first.calledNext, true)
    assert.equal(second.res.statusCode, 429)
    assert.ok(second.res.headers['Retry-After'])
})

test('username checks validate input and no longer expose emails by username', async () => {
    const firebaseRoutes = require('../routes/firebaseauth')
    assert.equal(
        firebaseRoutes.stack.some((layer) => layer.route?.path === '/email-by-username/:username'),
        false
    )
    const originalFindOne = User.findOne
    let lookupCount = 0
    User.findOne = async () => {
        lookupCount += 1
        return null
    }
    try {
        const controller = require('../controllers/firebaseauth').checkUsername
        const invalid = await invoke(controller, { query: { username: { $ne: '' } } })
        assert.equal(invalid.res.statusCode, 400)
        assert.equal(lookupCount, 0)

        const valid = await invoke(controller, { query: { username: 'collector_1' } })
        assert.equal(valid.res.statusCode, 200)
        assert.deepEqual(valid.res.body, { available: true })
    } finally {
        User.findOne = originalFindOne
    }
})

test('catalog inputs are bounded, allow listed, and search text is literal', () => {
    const queryCalls = { filters: [], sorts: [], limits: [], skips: [] }
    const query = {
        find(filter) { queryCalls.filters.push(filter); return this },
        sort(sort) { queryCalls.sorts.push(sort); return this },
        limit(limit) { queryCalls.limits.push(limit); return this },
        skip(skip) { queryCalls.skips.push(skip); return this }
    }
    const features = new APIFeatures(query, {
        keyword: 'card.*',
        page: '2',
        limit: '8',
        sort: '-ratings,-numOfReviews',
        'price[gte]': '10',
        'price[lte]': '100',
        category: 'Cards,Figures',
        rarity: 'rare',
        minRating: '4',
        minReviews: '2'
    }).search().filter().sort().pagination()
    assert.equal(features.options.page, 2)
    assert.equal(features.options.limit, 8)
    assert.equal(queryCalls.filters[0].name.$regex, 'card\\.\\*')
    assert.deepEqual(queryCalls.filters[1].category, { $in: ['Cards', 'Figures'] })
    assert.deepEqual(queryCalls.filters[1].price, { $gte: 10, $lte: 100 })
    assert.equal(queryCalls.filters[1].rarity, 'rare')
    assert.deepEqual(queryCalls.filters[1].ratings, { $gte: 4 })
    assert.deepEqual(queryCalls.filters[1].numOfReviews, { $gte: 2 })
    assert.deepEqual(queryCalls.sorts, ['-ratings -numOfReviews'])
    assert.deepEqual(queryCalls.limits, [8])
    assert.deepEqual(queryCalls.skips, [8])

    for (const input of [
        { page: '-1' },
        { page: '1.2' },
        { limit: '51' },
        { limit: 'Infinity' },
        { sort: '$where' },
        { rarity: 'impossible' },
        { minRating: '6' },
        { minRating: 'not-a-number' },
        { minReviews: '1.5' },
        { 'price[gte]': '-1' },
        { 'price[lte]': '1000000001' },
        { 'price[gte]': '200', 'price[lte]': '10' },
        { keyword: 'x'.repeat(101) },
        { operator: { $ne: '' } }
    ]) {
        assert.throws(() => new APIFeatures(query, input), { statusCode: 400 })
    }
})

test('catalog controller rejects invalid pagination before database work', async () => {
    const originalFind = Product.find
    const originalCountDocuments = Product.countDocuments
    Product.find = () => { throw new Error('Invalid query reached Product.find') }
    Product.countDocuments = () => { throw new Error('Invalid query reached countDocuments') }
    try {
        const handler = require('../controllers/product').getProducts
        const res = response()
        await handler({ query: { limit: '1000000' } }, res, (error) => { throw error })
        assert.equal(res.statusCode, 400)
    } finally {
        Product.find = originalFind
        Product.countDocuments = originalCountDocuments
    }
})

test('cookie-authenticated mutations enforce trusted request origins', async () => {
    const trusted = getTrustedOrigins({ NODE_ENV: 'production', CORS_ORIGINS: 'https://vault.example.test,https://admin.example.test' })
    assert.equal(trusted.has('https://vault.example.test'), true)
    assert.throws(() => getTrustedOrigins({ NODE_ENV: 'production', CORS_ORIGINS: '' }))
    assert.throws(() => getTrustedOrigins({ NODE_ENV: 'production', CORS_ORIGINS: 'http://vault.example.test' }))

    const csrf = createCsrfProtection(trusted)
    const blocked = await invoke(csrf, {
        method: 'POST',
        cookies: { token: 'cookie-session' },
        get: (name) => name === 'origin' ? 'https://attacker.example.test' : undefined
    })
    assert.equal(blocked.res.statusCode, 403)

    const allowed = await invoke(csrf, {
        method: 'POST',
        cookies: { token: 'cookie-session' },
        get: (name) => name === 'origin' ? 'https://vault.example.test' : undefined
    })
    assert.equal(allowed.calledNext, true)

    const bearerOnly = await invoke(csrf, {
        method: 'POST',
        cookies: {},
        get: () => undefined
    })
    assert.equal(bearerOnly.calledNext, true)
})
