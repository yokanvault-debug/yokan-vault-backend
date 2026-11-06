const fs = require('fs')
const path = require('path')

const getLogoPaths = () => {
    const configuredPath = process.env.YOKAN_LOGO_PATH
    if (configuredPath) return [path.resolve(configuredPath)]
    return [
        path.resolve(__dirname, '..', '..', 'yokan-frontend', 'public', 'images', 'yokan-logo.png'),
        path.resolve(__dirname, '..', 'assets', 'yokan-logo.png')
    ]
}

exports.getLogoBuffer = () => {
    const logoPaths = getLogoPaths()
    for (const logoPath of logoPaths) {
        try {
            return fs.readFileSync(logoPath)
        } catch (error) {
            if (error.code !== 'ENOENT') throw error
        }
    }
    throw new Error(`Yokan logo not found at ${logoPaths.join(' or ')}. Set YOKAN_LOGO_PATH to a readable image file.`)
}
