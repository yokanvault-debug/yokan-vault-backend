const test = require('node:test')
const assert = require('node:assert/strict')
const User = require('../models/user')
const firebaseAdmin = require('../utils/firebaseAdmin')
const { loginWithUsername } = require('../controllers/firebaseauth')
const firebaseRoutes = require('../routes/firebaseauth')

const makeResponse = () => ({
    statusCode: 200,
    body: null,
    status(code) {
        this.statusCode = code
        return this
    },
    json(body) {
        this.body = body
        return this
    }
})

const invoke = async (body) => {
    const res = makeResponse()
    await loginWithUsername({ body }, res)
    return res
}

test('username login validates input before looking up an account', async () => {
    const originalFindOne = User.findOne
    let lookups = 0
    User.findOne = async () => { lookups += 1 }
    try {
        const invalid = await invoke({ username: { $ne: '' }, password: 'password' })
        assert.equal(invalid.statusCode, 400)
        assert.equal(lookups, 0)
    } finally {
        User.findOne = originalFindOne
    }
})

test('username login authenticates with Firebase and returns no account email', async () => {
    const originals = {
        findOne: User.findOne,
        isConfigured: firebaseAdmin.isFirebaseAdminConfigured,
        getFirebaseAuth: firebaseAdmin.getFirebaseAuth,
        fetch: global.fetch,
        apiKey: process.env.FIREBASE_WEB_API_KEY
    }
    const account = {
        _id: 'mongo-user',
        email: 'private@example.test',
        firebaseUid: 'firebase-user',
        deletedAt: null
    }
    let lookup
    let selection
    let firebaseRequest
    User.findOne = (filter) => {
        lookup = filter
        return {
            select: async (fields) => {
                selection = fields
                return account
            }
        }
    }
    firebaseAdmin.isFirebaseAdminConfigured = () => true
    firebaseAdmin.getFirebaseAuth = () => ({
        verifyIdToken: async (token) => {
            assert.equal(token, 'firebase-id-token')
            return { uid: 'firebase-user', email: 'private@example.test', email_verified: true }
        },
        createCustomToken: async (uid) => {
            assert.equal(uid, 'firebase-user')
            return 'test-custom-token'
        }
    })
    delete process.env.FIREBASE_WEB_API_KEY
    global.fetch = async (url, options) => {
        firebaseRequest = { url: new URL(url), options }
        return {
            ok: true,
            json: async () => ({ idToken: 'firebase-id-token' })
        }
    }

    try {
        const res = await invoke({
            username: 'collector_1',
            password: 'correct horse battery staple',
            firebaseApiKey: 'frontend-test-web-key'
        })
        assert.equal(res.statusCode, 200)
        assert.deepEqual(res.body, { customToken: 'test-custom-token' })
        assert.equal(JSON.stringify(res.body).includes(account.email), false)
        assert.deepEqual(lookup, { username: 'collector_1', deletedAt: null })
        assert.equal(selection, 'email firebaseUid')
        assert.equal(firebaseRequest.url.searchParams.get('key'), 'frontend-test-web-key')
        assert.deepEqual(JSON.parse(firebaseRequest.options.body), {
            email: account.email,
            password: 'correct horse battery staple',
            returnSecureToken: true
        })
    } finally {
        User.findOne = originals.findOne
        firebaseAdmin.isFirebaseAdminConfigured = originals.isConfigured
        firebaseAdmin.getFirebaseAuth = originals.getFirebaseAuth
        global.fetch = originals.fetch
        if (originals.apiKey === undefined) delete process.env.FIREBASE_WEB_API_KEY
        else process.env.FIREBASE_WEB_API_KEY = originals.apiKey
    }
})

test('unknown usernames and incorrect Firebase passwords return the same generic response', async () => {
    const originals = {
        findOne: User.findOne,
        isConfigured: firebaseAdmin.isFirebaseAdminConfigured,
        getFirebaseAuth: firebaseAdmin.getFirebaseAuth,
        fetch: global.fetch,
        apiKey: process.env.FIREBASE_WEB_API_KEY
    }
    User.findOne = () => ({ select: async () => ({ email: 'private@example.test', firebaseUid: 'firebase-user' }) })
    firebaseAdmin.isFirebaseAdminConfigured = () => true
    firebaseAdmin.getFirebaseAuth = () => ({})
    process.env.FIREBASE_WEB_API_KEY = 'test-web-key'
    global.fetch = async () => ({ ok: false })

    try {
        const unknown = await invoke({ username: 'unknown_1', password: 'wrong-password' })
        const incorrectPassword = await invoke({ username: 'collector_1', password: 'wrong-password' })
        assert.equal(unknown.statusCode, 401)
        assert.equal(incorrectPassword.statusCode, 401)
        assert.deepEqual(unknown.body, incorrectPassword.body)
    } finally {
        User.findOne = originals.findOne
        firebaseAdmin.isFirebaseAdminConfigured = originals.isConfigured
        firebaseAdmin.getFirebaseAuth = originals.getFirebaseAuth
        global.fetch = originals.fetch
        if (originals.apiKey === undefined) delete process.env.FIREBASE_WEB_API_KEY
        else process.env.FIREBASE_WEB_API_KEY = originals.apiKey
    }
})

test('username login is exposed through a rate-limited endpoint', () => {
    const route = firebaseRoutes.stack.find((layer) => layer.route?.path === '/login-username')
    assert.ok(route)
    assert.equal(route.route.methods.post, true)
    assert.equal(route.route.stack.length, 2)
})
