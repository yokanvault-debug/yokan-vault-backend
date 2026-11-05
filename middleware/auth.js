const User = require('../models/user')
const jwt = require("jsonwebtoken")
const firebaseAdmin = require('../utils/firebaseAdmin')
const { isVerifiedFirebaseIdentity } = require('../utils/firebaseIdentity')

// 1) the shop cookie session, 2) fallback: the Firebase ID token sent as "Authorization: Bearer ..."
const userFromFirebaseBearer = async (req) => {
    const header = req.headers.authorization || ''
    const idToken = header.startsWith('Bearer ') ? header.slice(7) : null
    if (!idToken || !firebaseAdmin.isFirebaseAdminConfigured()) return null
    try {
        const decoded = await firebaseAdmin.getFirebaseAuth().verifyIdToken(idToken)
        if (!isVerifiedFirebaseIdentity(decoded)) return null
        let user = await User.findOne({ firebaseUid: decoded.uid })
        if (!user && decoded.email) user = await User.findOne({ email: decoded.email })
        return user
    } catch (error) {
        return null
    }
}

exports.isAuthenticatedUser = async (req, res, next) => {
    try {
        let user = null
        const { token } = req.cookies || {}
        if (token) {
            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET)
                user = await User.findById(decoded.id)
            } catch (e) { /* bad cookie: try the Firebase token */ }
        }
        if (!user) user = await userFromFirebaseBearer(req)

        if (!user) {
            return res.status(401).json({ message: token ? 'Your session expired, please log in again' : 'Login first to access this resource' })
        }
        if (user.deletedAt) {
            return res.status(401).json({ message: 'This account is no longer available' })
        }
        req.user = user
        next()
    } catch (error) {
        return res.status(401).json({ message: 'Please log in again' })
    }
};

exports.authorizeRoles = (...roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ message: `Role (${req.user.role}) is not allowed to acccess this resource` })
        }
        next()
    }
}
