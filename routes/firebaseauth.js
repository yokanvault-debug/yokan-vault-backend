const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();

const {
    getUserProfile,
    updateUserProfile,
    checkUsername,
    loginWithUsername,
    sendVerification,
    createSession,
} = require('../controllers/firebaseauth');
const { verifyFirebaseToken, verifyFirebaseProfileToken } = require('../middleware/firebaseAuth')
const createRateLimiter = require('../middleware/rateLimit')

const verificationEmailRateLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5 })
const usernameCheckRateLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 })
const usernameLoginRateLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 })

// profile photo (jpg, jpeg, png, webp, gif up to 5 MB)
const uploadPhoto = multer({
    storage: multer.diskStorage({}),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
            return cb(null, true);
        }
        cb(new Error('Unsupported file type!'));
    },
});

// mounted at /api/users (same paths as the original Yokan)
router.get('/check-username', usernameCheckRateLimit, checkUsername);
router.post('/login-username', usernameLoginRateLimit, loginWithUsername);
router.post('/send-verification', verificationEmailRateLimit, sendVerification);
router.get('/profile', verifyFirebaseProfileToken, getUserProfile);
router.put('/profile', verifyFirebaseProfileToken, uploadPhoto.single('photo'), updateUserProfile);
router.post('/session', verifyFirebaseToken, createSession);

module.exports = router
