const User = require('../models/user');
const crypto = require('crypto')
const cloudinary = require('cloudinary')
const { saveImage, deleteImage, incomingImages } = require('../utils/imageStore')
const sendEmail = require('../utils/sendEmail')
const sendToken = require('../utils/jwtToken');
const getStorefrontUrl = require('../utils/storefrontUrl')
const { createEmailHtml } = require('../utils/emailTemplate')

exports.registerUser = async (req, res, next) => {
    const result = await cloudinary.v2.uploader.upload(req.body.avatar, {
        folder: 'avatars',
        width: 150,
        crop: "scale"
    }, (err) => {
        if (err) console.error('Legacy avatar upload failed:', err.code || err.name || 'unknown error');
    });
    const { name, email, password, } = req.body;
    const user = await User.create({
        name,
        email,
        password,
        avatar: {
            public_id: result.public_id,
            url: result.secure_url
        },
    })
    //test token
    // const token = user.getJwtToken();

    // return res.status(201).json({
    //     success: true,
    //     user,
    //     token
    // })
    sendToken(user, 200, res)
}

exports.loginUser = async (req, res, next) => {
    const { email, password } = req.body;

    // Checks if email and password is entered by user
    if (!email || !password) {
        return res.status(400).json({ error: 'Please enter email & password' })
    }


    // Finding user in database

    let user = await User.findOne({ email }).select('+password')
    if (!user) {
        return res.status(401).json({ message: 'Invalid Email or Password' })
    }


    // Checks if password is correct or not
    const isPasswordMatched = await user.comparePassword(password);


    if (!isPasswordMatched) {
        return res.status(401).json({ message: 'Invalid Email or Password' })
    }
    const token = user.getJwtToken();

    // res.status(201).json({
    //     success: true,
    //     token,
    //     user
    // });
    user = await User.findOne({ email })
    sendToken(user, 200, res)
}

exports.forgotPassword = async (req, res, next) => {
    let storeUrl
    try {
        storeUrl = getStorefrontUrl()
    } catch (error) {
        console.error('Password recovery URL configuration failed:', error.name || 'unknown error')
        return res.status(503).json({ error: 'Password recovery is unavailable' })
    }

    const user = await User.findOne({ email: req.body.email });
    if (!user) {
        return res.status(200).json({
            success: true,
            message: 'If an account exists for that email, password recovery instructions will be sent.'
        })

    }
    // Get reset token
    const resetToken = user.getResetPasswordToken();
    await user.save({ validateBeforeSave: false });
    // Create reset password url
    const resetUrl = `${storeUrl}/password/reset/${resetToken}`;
    const message = `Use this link to reset your Yokan Vault password:\n\n${resetUrl}\n\nIf you did not request a password reset, you can ignore this email.`
    try {
        await sendEmail({
            email: user.email,
            subject: 'Yokan Vault Password Recovery',
            message,
            html: createEmailHtml({
                preheader: 'Password reset instructions for your Yokan Vault account.',
                title: 'Reset your password',
                greeting: `Hello ${user.name || 'there'},`,
                paragraphs: ['Use the button below to choose a new password.', 'If you did not request a password reset, you can ignore this email.'],
                action: { label: 'Reset password', url: resetUrl },
                footer: 'This is an automated message from Yokan Vault.'
            })
        })

        res.status(200).json({
            success: true,
            message: 'If an account exists for that email, password recovery instructions will be sent.'
        })

    } catch (error) {
        user.resetPasswordToken = undefined;
        user.resetPasswordExpire = undefined;
        await user.save({ validateBeforeSave: false });
        console.error('Password recovery email failed:', error.code || error.name || 'unknown error')
        return res.status(500).json({ error: 'Password recovery email could not be sent' })

    }
}

exports.resetPassword = async (req, res, next) => {
    // Hash URL token
    const resetPasswordToken = crypto.createHash('sha256').update(req.params.token).digest('hex')
    const user = await User.findOne({
        resetPasswordToken,
        resetPasswordExpire: { $gt: Date.now() }
    }).select('+resetPasswordToken +resetPasswordExpire')

    if (!user) {
        return res.status(400).json({ message: 'Password reset token is invalid or has been expired' })

    }

    if (req.body.password !== req.body.confirmPassword) {
        return res.status(400).json({ message: 'Password does not match' })

    }

    // Setup new password
    user.password = req.body.password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    await user.save();
    const token = user.getJwtToken();
    return res.status(201).json({
        success: true,
        token,
        user
    });

}

exports.getUserProfile = async (req, res, next) => {
    const user = await User.findById(req.user.id);

    return res.status(200).json({
        success: true,
        user
    })
}

exports.updateProfile = async (req, res, next) => {
    try {
        const current = await User.findById(req.user.id)
        if (!current) {
            return res.status(404).json({ message: 'User not found' })
        }

        const newUserData = {}
        if (req.body.name) newUserData.name = req.body.name.trim()
        if (req.body.email && req.body.email !== current.email) {
            const taken = await User.exists({ email: req.body.email, _id: { $ne: current._id } })
            if (taken) {
                return res.status(400).json({ message: 'That email is already used by another account' })
            }
            newUserData.email = req.body.email.trim()
        }

        let photoWarning
        // avatar: a multipart file or a base64 data URL string
        const incoming = incomingImages(req, 'avatar')
        if (incoming.length) {
            try {
                const saved = await saveImage(req, incoming[0], 'avatars')
                await deleteImage(current.avatar)
                newUserData.avatar = saved
                newUserData.photoURL = saved.url
            } catch (uploadError) {
                console.warn('Profile avatar upload failed:', uploadError.code || uploadError.name || 'unknown error')
                photoWarning = 'Photo not saved'
            }
        }

        const user = await User.findByIdAndUpdate(req.user.id, newUserData, {
            new: true,
            runValidators: true,
        })

        return res.status(200).json({ success: true, user, warning: photoWarning })
    } catch (error) {
        console.error('Profile update failed:', error.code || error.name || 'unknown error')
        return res.status(500).json({ message: 'Profile not updated' })
    }
}

exports.updatePassword = async (req, res, next) => {
    const user = await User.findById(req.user.id).select('+password');
    // Check previous user password
    const isMatched = await user.comparePassword(req.body.oldPassword)
    if (!isMatched) {
        return res.status(400).json({ message: 'Old password is incorrect' })
    }
    user.password = req.body.password;
    await user.save();
    // const token = user.getJwtToken();

    // return res.status(201).json({
    //     success: true,
    //     user,
    //     token
    // });
    sendToken(user, 200, res)

}

exports.allUsers = async (req, res, next) => {
    const users = await User.find({ deletedAt: null });
    res.status(200).json({
        success: true,
        users
    })
}

// Soft delete: the account is disabled and hidden, orders and reviews keep pointing at it
exports.deleteUser = async (req, res, next) => {
    const user = await User.findById(req.params.id);

    if (!user || user.deletedAt) {
        return res.status(404).json({ message: `User does not found with id: ${req.params.id}` })
    }
    if (user._id.toString() === req.user._id.toString()) {
        return res.status(400).json({ message: 'You cannot delete your own account' })
    }

    user.deletedAt = new Date();
    await user.save({ validateBeforeSave: false });

    // also block the Firebase sign in
    if (user.firebaseUid) {
        try {
            const { getFirebaseAuth, isFirebaseAdminConfigured } = require('../utils/firebaseAdmin');
            if (isFirebaseAdminConfigured()) await getFirebaseAuth().updateUser(user.firebaseUid, { disabled: true });
        } catch (error) {
            console.error('Firebase account disable failed:', error.code || error.name || 'unknown error')
        }
    }
    return res.status(200).json({ success: true })
}

exports.getUserDetails = async (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Administrator access is required' })
    }

    const user = await User.findById(req.params.id);

    if (!user) {
        return res.status(404).json({ message: 'User not found' })
        // return next(new ErrorHandler(`User does not found with id: ${req.params.id}`))
    }

    res.status(200).json({
        success: true,
        user
    })
}

exports.updateUser = async (req, res, next) => {
    const newUserData = {
        name: req.body.name,
        email: req.body.email,
        role: req.body.role
    }

    const user = await User.findByIdAndUpdate(req.params.id, newUserData, {
        new: true,
        runValidators: true,
        // useFindAndModify: false
    })

    return res.status(200).json({
        success: true
    })
}

exports.logout = async (req, res, next) => {
    const secure = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true'
    res.clearCookie('token', {
        httpOnly: true,
        secure,
        sameSite: secure ? 'none' : 'lax',
        path: '/'
    })

    return res.status(200).json({
        success: true,
        message: 'Logged out'
    })
}