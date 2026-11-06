const fs = require('fs')
const path = require('path')

// Tries (in order): YOKAN_LOGO_PATH, the frontend's public/images logo, the backend assets copy,
// and finally a copy embedded in the code, so the logo is always found even if a path is wrong.
const getLogoPaths = () => {
    const paths = []
    if (process.env.YOKAN_LOGO_PATH) paths.push(path.resolve(process.env.YOKAN_LOGO_PATH))
    for (const frontend of ['yokan-vault-frontend', 'yokan-frontend']) {
        paths.push(path.resolve(__dirname, '..', '..', frontend, 'public', 'images', 'yokan-logo.png'))
    }
    paths.push(path.resolve(__dirname, '..', 'assets', 'yokan-logo.png'))
    return paths
}

exports.getLogoBuffer = () => {
    for (const logoPath of getLogoPaths()) {
        try {
            const buffer = fs.readFileSync(logoPath)
            if (buffer.length) return buffer
        } catch (error) { /* try the next location */ }
    }
    return Buffer.from(require('./logoData'), 'base64')
}
