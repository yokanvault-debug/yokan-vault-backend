const hasFirebaseIdentity = (decoded) => Boolean(
    decoded &&
    typeof decoded.uid === 'string' &&
    decoded.uid &&
    typeof decoded.email === 'string' &&
    decoded.email.trim()
)

const isVerifiedFirebaseIdentity = (decoded) => {
    if (!hasFirebaseIdentity(decoded)) return false
    return decoded.email_verified === true || decoded.firebase?.sign_in_provider === 'google.com'
}

module.exports = { hasFirebaseIdentity, isVerifiedFirebaseIdentity }
