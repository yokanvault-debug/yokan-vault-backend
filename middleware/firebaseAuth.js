const firebaseAdmin = require('../utils/firebaseAdmin');
const User = require('../models/user');
const { isVerifiedFirebaseIdentity, hasFirebaseIdentity } = require('../utils/firebaseIdentity');

// Original Yokan sign-in: the browser sends the Firebase ID token as "Authorization: Bearer <token>"
const verifyFirebaseToken = (allowUnverifiedProfile = false) => async (req, res, next) => {
    const authorization = req.headers.authorization || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;

    if (!token) {
        return res.status(401).json({ message: 'No token provided, unauthorized.' });
    }

    if (!firebaseAdmin.isFirebaseAdminConfigured()) {
        return res.status(503).json({ message: 'Authentication is unavailable until the Firebase Admin credentials are configured (FIREBASE_SERVICE_ACCOUNT_PATH).' });
    }

    try {
        const decoded = await firebaseAdmin.getFirebaseAuth().verifyIdToken(token);
        if (allowUnverifiedProfile ? !hasFirebaseIdentity(decoded) : !isVerifiedFirebaseIdentity(decoded)) {
            return res.status(403).json({ message: 'Please verify your email address to access this resource.' });
        }
        req.firebaseToken = decoded;

        // find the profile by Firebase uid, then by email (accounts made before), else create it
        let user = await User.findOne({ firebaseUid: decoded.uid });
        if (!user && decoded.email) {
            user = await User.findOne({ email: decoded.email });
            if (user) {
                if (!isVerifiedFirebaseIdentity(decoded)) {
                    return res.status(403).json({ message: 'Verify your email before linking this existing account.' });
                }
                user.firebaseUid = decoded.uid;
                await user.save({ validateBeforeSave: false });
            }
        }

        if (!user) {
            const displayName = decoded.name || (decoded.email ? decoded.email.split('@')[0] : 'Collector');
            const photo = decoded.picture || '/images/default-avatar.png';
            user = await User.create({
                firebaseUid: decoded.uid,
                email: decoded.email,
                displayName,
                name: displayName.slice(0, 30),
                photoURL: photo,
                avatar: { public_id: '', url: photo },
                role: 'user'
            });
        }

        if (user.deletedAt) {
            return res.status(403).json({ message: 'This account has been removed.' });
        }

        req.mongoUser = user;
        req.user = user;

        // profiles without a username can only use the endpoints that finish the profile
        const exemptUrls = ['/api/users/profile', '/api/users/check-username'];
        const isExempt = exemptUrls.some(url => req.originalUrl.startsWith(url));
        if (!user.username && !isExempt) {
            return res.status(403).json({ message: 'Profile completion required.', needsProfileCompletion: true });
        }

        next();
    } catch (error) {
        console.error('Firebase token verification failed:', error.code || error.name || 'unknown error');
        return res.status(401).json({ message: 'Invalid or expired token.' });
    }
};

exports.verifyFirebaseToken = verifyFirebaseToken(false);
exports.verifyFirebaseProfileToken = verifyFirebaseToken(true);
