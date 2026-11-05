const cloudinary = require('cloudinary')
const { saveImage, deleteImage } = require('../utils/imageStore')
const User = require('../models/user')
const sendToken = require('../utils/jwtToken')
const firebaseAdmin = require('../utils/firebaseAdmin')
const emailService = require('../utils/emailService')
const { hasFirebaseIdentity, isVerifiedFirebaseIdentity } = require('../utils/firebaseIdentity')
const getStorefrontUrl = require('../utils/storefrontUrl')

// Current profile  =>  GET /api/users/profile
exports.getUserProfile = async (req, res, next) => {
    return res.status(200).json(req.mongoUser)
}

// Finish / edit the profile (username, name, photo)  =>  PUT /api/users/profile
exports.updateUserProfile = async (req, res, next) => {
    try {
        const { displayName, username } = req.body;
        const user = await User.findById(req.mongoUser._id);

        if (displayName) {
            user.displayName = displayName;
            user.name = displayName.slice(0, 30);
        }
        if (username) user.username = username;

        let photoWarning;
        if (req.file) {
            try {
                const saved = await saveImage(req, req.file.path, 'avatars');
                await deleteImage(user.avatar);
                user.photoURL = saved.url;
                user.avatar = saved;
            } catch (uploadError) {
                console.warn('Firebase profile avatar upload failed:', uploadError.code || uploadError.name || 'unknown error');
                photoWarning = 'Photo not saved';
            }
        }

        await user.save({ validateBeforeSave: false });
        return res.status(200).json({ message: 'Profile updated successfully', user, warning: photoWarning })
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ message: 'Username is already taken' })
        }
        console.error('Firebase profile update failed:', error.code || error.name || 'unknown error')
        return res.status(500).json({ message: 'Profile update failed' })
    }
}

// Is the username free?  =>  GET /api/users/check-username?username=...
exports.checkUsername = async (req, res, next) => {
    const { username } = req.query;
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
        return res.status(400).json({ message: 'Enter a valid username' });
    }
    const user = await User.findOne({ username });
    return res.status(200).json({ available: !user })
}

exports.loginWithUsername = async (req, res) => {
    const { username, password } = req.body || {}
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,30}$/.test(username) ||
        typeof password !== 'string' || !password || password.length > 4096 ||
        (req.body.firebaseApiKey !== undefined &&
            (typeof req.body.firebaseApiKey !== 'string' || req.body.firebaseApiKey.length > 256))) {
        return res.status(400).json({ message: 'Enter a valid username and password' })
    }

    const apiKey = process.env.FIREBASE_WEB_API_KEY || req.body.firebaseApiKey
    if (!apiKey || !firebaseAdmin.isFirebaseAdminConfigured()) {
        return res.status(503).json({ message: 'Username sign-in is temporarily unavailable' })
    }

    try {
        const user = await User.findOne({ username, deletedAt: null }).select('email firebaseUid')
        if (!user || !user.firebaseUid) {
            return res.status(401).json({ message: 'Invalid username or password' })
        }

        const signInUrl = new URL('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword')
        signInUrl.searchParams.set('key', apiKey)

        let firebaseResponse
        try {
            firebaseResponse = await fetch(signInUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: user.email,
                    password,
                    returnSecureToken: true
                })
            })
        } catch (error) {
            console.error('Username sign-in request failed:', error.code || error.name || 'unknown error')
            return res.status(503).json({ message: 'Authentication service is temporarily unavailable' })
        }

        if (!firebaseResponse.ok) {
            return res.status(401).json({ message: 'Invalid username or password' })
        }

        const firebaseResult = await firebaseResponse.json()
        if (typeof firebaseResult.idToken !== 'string') {
            console.error('Username sign-in response was incomplete')
            return res.status(503).json({ message: 'Authentication service is temporarily unavailable' })
        }

        let decoded
        try {
            decoded = await firebaseAdmin.getFirebaseAuth().verifyIdToken(firebaseResult.idToken)
        } catch (error) {
            console.error('Username sign-in token verification failed:', error.code || error.name || 'unknown error')
            return res.status(401).json({ message: 'Invalid username or password' })
        }

        if (decoded.uid !== user.firebaseUid || !isVerifiedFirebaseIdentity(decoded)) {
            return res.status(403).json({ message: 'Please verify your email address to login.' })
        }

        const customToken = await firebaseAdmin.getFirebaseAuth().createCustomToken(decoded.uid)
        return res.status(200).json({ customToken })
    } catch (error) {
        console.error('Username sign-in failed:', error.code || error.name || 'unknown error')
        return res.status(503).json({ message: 'Username sign-in is temporarily unavailable' })
    }
}

// Verification email through Mailtrap  =>  POST /api/users/send-verification
exports.sendVerification = async (req, res, next) => {
    const authorization = req.headers.authorization || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Authentication is required' });

    let decoded;
    try {
        decoded = await firebaseAdmin.getFirebaseAuth().verifyIdToken(token);
    } catch (error) {
        console.warn('Verification email authentication failed:', error.code || error.name || 'unknown error');
        return res.status(401).json({ message: 'Authentication is required' });
    }
    if (!hasFirebaseIdentity(decoded) || decoded.firebase?.sign_in_provider !== 'password') {
        return res.status(403).json({ message: 'Email verification is not available for this account' });
    }
    if (decoded.email_verified === true) {
        return res.status(200).json({ message: 'If the account can be verified, an email will be sent.' });
    }

    const { firstName = '', lastName = '' } = req.body || {};
    if (typeof firstName !== 'string' || typeof lastName !== 'string' ||
        firstName.length > 50 || lastName.length > 50) {
        return res.status(400).json({ message: 'Please provide valid registration details' });
    }

    let verificationUrl;
    try {
        const rawVerificationUrl = await firebaseAdmin.getFirebaseAuth().generateEmailVerificationLink(decoded.email);
        // point the Firebase link to our own verify-email page
        const urlObj = new URL(rawVerificationUrl);
        const storeUrl = getStorefrontUrl();
        verificationUrl = `${storeUrl}/verify-email${urlObj.search}`;
    } catch (error) {
        console.error('Verification link creation failed:', error.code || error.name || 'unknown error')
        return res.status(500).json({ message: 'Could not create the verification link' })
    }

    try {
        await emailService.sendVerificationEmail(decoded.email, verificationUrl, firstName, lastName);
        return res.status(200).json({ message: 'If the account can be verified, an email will be sent.' })
    } catch (error) {
        console.error('Verification email delivery failed:', error.code || error.name || 'unknown error')
        return res.status(500).json({ message: 'Verification email could not be sent' })
    }
}

// Turns a signed-in Firebase user into the itcp318 cookie session  =>  POST /api/users/session
// (so cart, orders and the admin pages keep working with isAuthenticatedUser)
exports.createSession = async (req, res, next) => {
    const decoded = req.firebaseToken;
    if (!isVerifiedFirebaseIdentity(decoded)) {
        return res.status(403).json({ message: 'Please verify your email address to login.' })
    }

    sendToken(req.mongoUser, 200, res)
}
