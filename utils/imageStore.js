const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const cloudinary = require('cloudinary')

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads')
fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const cloudinaryReady = () => Boolean(cloudinary.v2.config().cloud_name && cloudinary.v2.config().api_key && cloudinary.v2.config().api_secret)
const localFallbackAllowed = () => process.env.NODE_ENV !== 'production' && process.env.IMAGE_FALLBACK !== 'off'

// base URL of this API, used to build links for locally stored images
const baseUrl = (req) => process.env.API_ORIGIN || `${req.protocol}://${req.get('host')}`

const saveLocal = (req, input, folder) => {
    let buffer, ext = '.png'
    if (typeof input === 'string' && input.startsWith('data:')) {
        const match = input.match(/^data:image\/(\w+);base64,(.+)$/)
        if (!match) throw new Error('Unsupported image data')
        ext = '.' + (match[1] === 'jpeg' ? 'jpg' : match[1])
        buffer = Buffer.from(match[2], 'base64')
    } else {
        ext = path.extname(input).toLowerCase() || '.png'
        buffer = fs.readFileSync(input)
    }
    const name = `${folder}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buffer)
    return { public_id: `local/${name}`, url: `${baseUrl(req)}/uploads/${name}` }
}

// input: a data URL string or a file path (multer).  Tries Cloudinary first and
// falls back to the server's uploads folder, so an image is never silently lost.
exports.saveImage = async (req, input, folder = 'products') => {
    if (cloudinaryReady()) {
        try {
            const result = await cloudinary.v2.uploader.upload(input, { folder, width: folder === 'avatars' ? 150 : 600, crop: 'scale' })
            return { public_id: result.public_id, url: result.secure_url }
        } catch (error) {
            console.log(`Cloudinary upload failed: ${error.message}`)
            if (!localFallbackAllowed()) throw error
            console.log('Saving the image locally instead')
        }
    }
    if (!localFallbackAllowed()) {
        throw new Error('Cloudinary must be configured and available for image uploads in production')
    }
    return saveLocal(req, input, folder)
}

exports.deleteImage = async (image) => {
    if (!image || !image.public_id) return
    try {
        if (image.public_id.startsWith('local/')) {
            fs.unlink(path.join(UPLOAD_DIR, path.basename(image.public_id)), () => { })
        } else if (cloudinaryReady()) {
            await cloudinary.v2.uploader.destroy(image.public_id)
        }
    } catch (e) { /* ignore */ }
}

// pulls every new image out of a request: multer files and/or base64 strings in `field`
exports.incomingImages = (req, field = 'images') => {
    const out = []
    ;(req.files || []).forEach((f) => out.push(f.path))
    if (req.file) out.push(req.file.path)
    const body = req.body[field]
    ;(Array.isArray(body) ? body : body ? [body] : []).forEach((v) => {
        if (typeof v === 'string' && v.startsWith('data:image')) out.push(v)
    })
    return out
}
