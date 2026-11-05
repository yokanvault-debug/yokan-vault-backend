const sendToken = (user, statusCode, res) => {

    // Create Jwt token
    const token = user.getJwtToken();
    // console.log("token1", token)
    // Options for cookie
    const options = {
        expires: new Date(
            Date.now() + process.env.COOKIE_EXPIRES_TIME * 24 * 60 * 60 * 1000
        ),
        // domain: ".localhost",
        httpOnly: true,
        // https (Render) needs Secure + SameSite=None for a frontend on another domain; plain http localhost needs neither
        secure: process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true',
        sameSite: process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true' ? 'none' : 'lax',

    }
    res.status(statusCode).cookie('token', token, options).json({
        success: true,
        // token,
        user
    })

}

module.exports = sendToken;