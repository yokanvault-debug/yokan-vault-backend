const assert = require('node:assert/strict')
const test = require('node:test')
const cloudinary = require('cloudinary')
const { saveImage } = require('../utils/imageStore')

test('production image uploads fail when Cloudinary is not configured', async () => {
    const previousEnv = {
        nodeEnv: process.env.NODE_ENV,
        fallback: process.env.IMAGE_FALLBACK,
    }
    const previousCloudinaryConfig = cloudinary.v2.config()

    try {
        process.env.NODE_ENV = 'production'
        process.env.IMAGE_FALLBACK = 'on'
        cloudinary.v2.config({ cloud_name: '', api_key: '', api_secret: '' })

        await assert.rejects(
            saveImage({ protocol: 'https', get: () => 'example.invalid' }, 'data:image/png;base64,aGVsbG8='),
            /Cloudinary must be configured and available for image uploads in production/
        )
    } finally {
        if (previousEnv.nodeEnv === undefined) delete process.env.NODE_ENV
        else process.env.NODE_ENV = previousEnv.nodeEnv
        if (previousEnv.fallback === undefined) delete process.env.IMAGE_FALLBACK
        else process.env.IMAGE_FALLBACK = previousEnv.fallback
        cloudinary.v2.config(previousCloudinaryConfig)
    }
})

test('production image uploads do not fall back locally when Cloudinary fails', async () => {
    const previousEnv = {
        nodeEnv: process.env.NODE_ENV,
        fallback: process.env.IMAGE_FALLBACK,
    }
    const previousCloudinaryConfig = cloudinary.v2.config()
    const previousUpload = cloudinary.v2.uploader.upload
    const uploadError = new Error('Cloudinary unavailable')

    try {
        process.env.NODE_ENV = 'production'
        process.env.IMAGE_FALLBACK = 'on'
        cloudinary.v2.config({ cloud_name: 'test', api_key: 'test', api_secret: 'test' })
        cloudinary.v2.uploader.upload = async () => {
            throw uploadError
        }

        await assert.rejects(
            saveImage({ protocol: 'https', get: () => 'example.invalid' }, 'data:image/png;base64,aGVsbG8='),
            (error) => error === uploadError
        )
    } finally {
        if (previousEnv.nodeEnv === undefined) delete process.env.NODE_ENV
        else process.env.NODE_ENV = previousEnv.nodeEnv
        if (previousEnv.fallback === undefined) delete process.env.IMAGE_FALLBACK
        else process.env.IMAGE_FALLBACK = previousEnv.fallback
        cloudinary.v2.uploader.upload = previousUpload
        cloudinary.v2.config(previousCloudinaryConfig)
    }
})
