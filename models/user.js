const mongoose = require('mongoose');
const validator = require('validator');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto')

// One user collection for both ways in:
//  - original Yokan accounts (Firebase: firebaseUid, username, displayName, photoURL)
//  - itcp318 accounts (name, password, avatar)
// The fields that only belong to one of them are optional for the other.
const isFirebaseUser = function () { return Boolean(this.firebaseUid) }

const userSchema = new mongoose.Schema({
    firebaseUid: {
        type: String,
        unique: true,
        sparse: true
    },
    username: {
        type: String,
        unique: true,
        sparse: true
    },
    displayName: {
        type: String
    },
    photoURL: {
        type: String,
        default: '/images/default-avatar.png'
    },
    name: {
        type: String,
        required: [function () { return !isFirebaseUser.call(this) }, 'Please enter your name'],
        maxLength: [30, 'Your name cannot exceed 30 characters']
    },
    email: {
        type: String,
        required: [true, 'Please enter your email'],
        unique: true,
        validate: [validator.isEmail, 'Please enter valid email address']
    },
    password: {
        type: String,
        required: [function () { return !isFirebaseUser.call(this) }, 'Please enter your password'],
        minlength: [6, 'Your password must be longer than 6 characters'],
        select: false
    },
    avatar: {
        public_id: {
            type: String,
            default: ''
        },
        url: {
            type: String,
            default: '/images/default-avatar.png'
        }
    },
    role: {
        type: String,
        enum: ['user', 'admin'],
        default: 'user'
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    deletedAt: {
        type: Date,
        default: null
    },
    resetPasswordToken: {
        type: String,
        select: false
    },
    resetPasswordExpire: {
        type: Date,
        select: false
    }
})
userSchema.set('toJSON', {
    transform: (_doc, ret) => {
        delete ret.password
        delete ret.resetPasswordToken
        delete ret.resetPasswordExpire
        return ret
    }
})
userSchema.pre('save', async function () {
    if (!this.isModified('password') || !this.password) {
        return;
    }
    this.password = await bcrypt.hash(this.password, 10)
});

userSchema.methods.getJwtToken = function () {
    return jwt.sign({ id: this._id }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_TIME
    });
}

userSchema.methods.comparePassword = async function (enteredPassword) {
    return await bcrypt.compare(enteredPassword, this.password)
}

userSchema.methods.getResetPasswordToken = function () {
    // Generate token
    const resetToken = crypto.randomBytes(20).toString('hex');

    // Hash and set to resetPasswordToken
    this.resetPasswordToken = crypto.createHash('sha256').update(resetToken).digest('hex')

    // Set token expire time
    this.resetPasswordExpire = Date.now() + 30 * 60 * 1000

    return resetToken

}

module.exports = mongoose.model('User', userSchema);
