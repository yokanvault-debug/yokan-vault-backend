const Product = require('../models/product')
const Order = require('../models/order')
const cloudinary = require('cloudinary')
const APIFeatures = require('../utils/apiFeatures');
const { saveImage, deleteImage, incomingImages } = require('../utils/imageStore');
const Filter = require('bad-words');
const mongoose = require('mongoose')
const badWords = new Filter();

const moderateReviewComment = (comment) => {
    const cleanComment = badWords.clean(comment)
    if (typeof cleanComment !== 'string' || !cleanComment.trim()) {
        throw new Error('Review moderation returned an invalid comment')
    }
    return cleanComment
}

const updateProductReviewStats = (product) => {
    product.numOfReviews = product.reviews.length
    product.ratings = product.reviews.length
        ? product.reviews.reduce((total, review) => total + review.rating, 0) / product.reviews.length
        : 0
}

exports.newProduct = async (req, res, next) => {
    try {
        const imagesLinks = [];
        for (const input of incomingImages(req)) {
            imagesLinks.push(await saveImage(req, input, 'products'))
        }
        req.body.images = imagesLinks
        req.body.user = req.user._id

        // empty form values from the browser must not reach the schema as text
        if (!req.body.brand) delete req.body.brand
        if (!req.body.series) delete req.body.series
        if (req.body.dropRate === '' || req.body.dropRate === 'undefined') delete req.body.dropRate
        if (req.body.rarity === '' || req.body.rarity === 'undefined') delete req.body.rarity

        const product = await Product.create(req.body);

        return res.status(201).json({
            success: true,
            product
        })
    } catch (error) {
        console.log('newProduct failed:', error.message)
        return res.status(400).json({ success: false, message: `Product not created: ${error.message}` })
    }
}

exports.getSingleProduct = async (req, res, next) => {
    const product = await Product.findOne({ _id: req.params.id, deletedAt: null });
    if (!product) {
        return res.status(404).json({
            success: false,
            message: 'Product not found'
        })
    }
    return res.status(200).json({
        success: true,
        product
    })
}

exports.getProducts = async (req, res, next) => {
    try {
        const apiFeatures = new APIFeatures(null, req.query)
        apiFeatures.query = Product.find()
        apiFeatures.search().filter().sort()
        const [productsCount, filteredProductsCount] = await Promise.all([
            Product.countDocuments({ deletedAt: null }),
            Product.countDocuments(apiFeatures.query.getFilter())
        ])
        const { page, limit } = apiFeatures.options
        const pageCount = Math.ceil(filteredProductsCount / limit)
        const products = page > pageCount ? [] : await apiFeatures.pagination().query

        return res.status(200).json({
            success: true,
            products,
            filteredProductsCount,
            resPerPage: limit,
            productsCount,
        })
    } catch (error) {
        if (error.statusCode === 400) {
            return res.status(400).json({ success: false, message: error.message })
        }
        return next(error)
    }
}

exports.updateProduct = async (req, res, next) => {
    let product = await Product.findById(req.params.id);
    if (!product) {
        return res.status(404).json({
            success: false,
            message: 'Product not found'
        })
    }
    // new photos replace the old ones; no new photos keeps the current ones
    const incoming = incomingImages(req)
    if (incoming.length) {
        const imagesLinks = []
        for (const input of incoming) imagesLinks.push(await saveImage(req, input, 'products'))
        for (const old of product.images || []) await deleteImage(old)
        req.body.images = imagesLinks
    } else {
        delete req.body.images
    }
    product = await Product.findByIdAndUpdate(req.params.id, req.body, {
        returnDocument: 'after',
        runValidators: true,
    })
    // console.log(product)
    return res.status(200).json({
        success: true,
        product
    })
}

exports.deleteProduct = async (req, res, next) => {
    // soft delete: hidden from the shop, old orders keep their product
    const product = await Product.findOneAndUpdate({ _id: req.params.id, deletedAt: null }, { deletedAt: new Date() });
    if (!product) {
        return res.status(404).json({
            success: false,
            message: 'Product not found'
        })
    }

    return res.status(200).json({
        success: true,
        message: 'Product deleted'
    })
}

exports.getAdminProducts = async (req, res, next) => {

    // ?deleted=true lists the soft-deleted products (for the restore view)
    const filter = req.query.deleted === 'true' ? { deletedAt: { $ne: null } } : { deletedAt: null };
    const products = await Product.find(filter).sort(req.query.deleted === 'true' ? { deletedAt: -1 } : { createdAt: -1 });
    if (!products) {
        return res.status(404).json({
            success: false,
            message: 'Products not found'
        })
    }
    return res.status(200).json({
        success: true,
        products
    })

}

exports.createProductReview = async (req, res, next) => {
    const body = req.body || {}
    const { rating, comment, productId, orderId } = body
    const parsedRating = typeof rating === 'number' || (typeof rating === 'string' && /^\d+$/.test(rating))
        ? Number(rating)
        : NaN
    if (!Number.isInteger(parsedRating) || parsedRating < 1 || parsedRating > 5) {
        return res.status(400).json({ success: false, message: 'Rating must be a whole number from 1 to 5' })
    }
    if (typeof comment !== 'string' || !comment.trim() || comment.trim().length > 500) {
        return res.status(400).json({ success: false, message: 'A review comment of 1 to 500 characters is required' })
    }
    if (typeof productId !== 'string' || !mongoose.isObjectIdOrHexString(productId) ||
        typeof orderId !== 'string' || !mongoose.isObjectIdOrHexString(orderId)) {
        return res.status(400).json({ success: false, message: 'A valid delivered order and product are required' })
    }

    const product = await Product.findById(productId);
    if (!product) {
        return res.status(404).json({ success: false, message: 'Product not found' })
    }

    const deliveredOrder = await Order.findOne({
        _id: orderId,
        user: req.user._id,
        orderStatus: 'Delivered',
        inventoryReserved: { $ne: false },
        'orderItems.product': product._id
    })
    if (!deliveredOrder) {
        return res.status(403).json({ success: false, message: 'Reviews are available only for products in your delivered orders' })
    }

    let cleanComment
    try {
        cleanComment = moderateReviewComment(comment.trim())
    } catch {
        return res.status(503).json({
            success: false,
            message: 'Review moderation is temporarily unavailable. Please try again later.'
        })
    }

    product.reviews = product.reviews || []
    const reviews = product.reviews
    const existing = reviews.find(r => String(r.user?._id || r.user) === String(req.user._id))
    if (existing) {
        existing.comment = cleanComment;
        existing.originalComment = comment.trim();
        existing.rating = parsedRating;
        existing.order = deliveredOrder._id
    } else {
        product.reviews.push({
            user: req.user._id,
            name: req.user.name || req.user.displayName || 'Customer',
            rating: parsedRating,
            comment: cleanComment,
            originalComment: comment.trim(),
            order: deliveredOrder._id
        });
    }
    updateProductReviewStats(product)
    try {
        await product.save()
    } catch (error) {
        if (error.name === 'ValidationError' || error.name === 'CastError') {
            return res.status(400).json({ success: false, message: 'The review details are invalid.' })
        }
        return next(error)
    }
    return res.status(200).json({ success: true, updated: Boolean(existing), orderId: String(deliveredOrder._id) })
}

exports.getProductReviews = async (req, res, next) => {
    if (typeof req.query.id !== 'string' || !mongoose.isObjectIdOrHexString(req.query.id)) {
        return res.status(400).json({ success: false, message: 'Invalid product ID' })
    }
    const product = await Product.findById(req.query.id);
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' })
    res.status(200).json({
        success: true,
        reviews: (product.reviews || []).map(({ _id, user, name, rating, comment }) => ({
            _id,
            user,
            name,
            rating,
            comment
        }))
    })
}

exports.getAdminReviews = async (req, res, next) => {
    try {
        const products = await Product.find({ 'reviews.0': { $exists: true } })
            .select('_id name reviews')
            .select('+reviews.originalComment')
        const reviews = products.flatMap(product => (product.reviews || []).map(review => {
            const user = review.user
            return {
                _id: String(review._id),
                productId: String(product._id),
                productName: product.name,
                reviewer: user?.name || review.name || 'Customer',
                rating: review.rating,
                comment: review.comment,
                originalComment: review.originalComment || review.comment
            }
        }))
        return res.status(200).json({ success: true, reviews })
    } catch (error) {
        return next(error)
    }
}

exports.updateAdminReview = async (req, res, next) => {
    const { productId, id } = req.params
    const { rating, comment } = req.body || {}
    const parsedRating = typeof rating === 'number' || (typeof rating === 'string' && /^\d+$/.test(rating))
        ? Number(rating)
        : NaN
    if (!mongoose.isObjectIdOrHexString(productId) || !mongoose.isObjectIdOrHexString(id)) {
        return res.status(400).json({ success: false, message: 'Invalid product or review ID' })
    }
    if (!Number.isInteger(parsedRating) || parsedRating < 1 || parsedRating > 5) {
        return res.status(400).json({ success: false, message: 'Rating must be a whole number from 1 to 5' })
    }
    if (typeof comment !== 'string' || !comment.trim() || comment.trim().length > 500) {
        return res.status(400).json({ success: false, message: 'A review comment of 1 to 500 characters is required' })
    }

    let cleanComment
    try {
        cleanComment = moderateReviewComment(comment.trim())
    } catch {
        return res.status(503).json({
            success: false,
            message: 'Review moderation is temporarily unavailable. Please try again later.'
        })
    }

    const product = await Product.findById(productId)
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' })
    const review = (product.reviews || []).find(item => String(item._id) === id)
    if (!review) return res.status(404).json({ success: false, message: 'Review not found' })

    try {
        const updatedProduct = await Product.findOneAndUpdate(
            { _id: productId, 'reviews._id': id },
            {
                $set: {
                    'reviews.$.rating': parsedRating,
                    'reviews.$.comment': cleanComment,
                    'reviews.$.originalComment': comment.trim(),
                    ratings: (product.reviews.reduce((total, item) =>
                        total + (String(item._id) === id ? parsedRating : item.rating), 0)) / product.reviews.length,
                    numOfReviews: product.reviews.length
                }
            },
            { returnDocument: 'after', runValidators: true }
        )
        if (!updatedProduct) return res.status(404).json({ success: false, message: 'Review not found' })
    } catch (error) {
        if (error.name === 'ValidationError' || error.name === 'CastError') {
            return res.status(400).json({ success: false, message: 'The review details are invalid.' })
        }
        return next(error)
    }
    return res.status(200).json({ success: true })
}

exports.deleteReview = async (req, res, next) => {
    const productId = req.params.productId || req.query.productId
    const reviewId = req.params.id || req.query.id
    if (!mongoose.isObjectIdOrHexString(productId) ||
        !mongoose.isObjectIdOrHexString(reviewId)) {
        return res.status(400).json({ success: false, message: 'Invalid product or review ID' })
    }
    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' })
    const existingReviews = product.reviews || []
    const reviews = existingReviews.filter(review => review._id.toString() !== reviewId.toString());
    if (reviews.length === existingReviews.length) {
        return res.status(404).json({ success: false, message: 'Review not found' })
    }
    const numOfReviews = reviews.length;

    const ratings = reviews.length ? reviews.reduce((acc, item) => item.rating + acc, 0) / reviews.length : 0

    const updatedProduct = await Product.findByIdAndUpdate(productId, {
        $pull: { reviews: { _id: reviewId } },
        $set: { ratings, numOfReviews }
    }, {
        returnDocument: 'after',
        runValidators: true,
    })
    if (!updatedProduct) return res.status(404).json({ success: false, message: 'Product not found' })

    return res.status(200).json({
        success: true
    })
}

// Delete many products at once  =>  DELETE /api/v1/admin/products  { ids: [...] }
exports.bulkDeleteProducts = async (req, res, next) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : []
    if (!ids.length) {
        return res.status(400).json({ success: false, message: 'No products selected' })
    }
    const result = await Product.updateMany({ _id: { $in: ids }, deletedAt: null }, { deletedAt: new Date() })
    return res.status(200).json({ success: true, deleted: result.modifiedCount })
}


// Bring soft-deleted products back  =>  PUT /api/v1/admin/products/restore  { ids: [...] }
exports.restoreProducts = async (req, res, next) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : []
    if (!ids.length) {
        return res.status(400).json({ success: false, message: 'No products selected' })
    }
    const result = await Product.updateMany({ _id: { $in: ids }, deletedAt: { $ne: null } }, { deletedAt: null })
    return res.status(200).json({ success: true, restored: result.modifiedCount })
}


// What can this user do about reviews on a product?  =>  GET /api/v1/review/eligibility/:productId
exports.reviewEligibility = async (req, res, next) => {
    if (!mongoose.isObjectIdOrHexString(req.params.productId)) {
        return res.status(400).json({ success: false, message: 'Invalid product ID' })
    }
    if (req.query.orderId !== undefined && !mongoose.isObjectIdOrHexString(req.query.orderId)) {
        return res.status(400).json({ success: false, message: 'Invalid order ID' })
    }
    const product = await Product.findById(req.params.productId).select('reviews')
    if (!product) {
        return res.status(404).json({ success: false, message: 'Product not found' })
    }
    const orderFilter = {
        user: req.user._id,
        orderStatus: 'Delivered',
        inventoryReserved: { $ne: false },
        'orderItems.product': product._id
    }
    if (req.query.orderId) orderFilter._id = req.query.orderId
    const deliveredOrder = await Order.findOne(orderFilter).select('_id')
    const hasReviewed = (product.reviews || []).some(r => String(r.user?._id || r.user) === String(req.user._id))
    return res.status(200).json({
        success: true,
        canReview: Boolean(deliveredOrder),
        hasReviewed,
        orderId: deliveredOrder ? String(deliveredOrder._id) : null
    })
}

exports.reviewOrderEligibility = async (req, res) => {
    if (!mongoose.isObjectIdOrHexString(req.params.orderId)) {
        return res.status(400).json({ success: false, message: 'Invalid order ID' })
    }
    const order = await Order.findOne({
        _id: req.params.orderId,
        user: req.user._id,
        orderStatus: 'Delivered',
        inventoryReserved: { $ne: false }
    }).select('_id orderItems')
    if (!order) {
        return res.status(200).json({ success: true, products: {} })
    }

    const productIds = [...new Set(order.orderItems.map(item => String(item.product)))]
    const products = await Product.find({ _id: { $in: productIds } }).select('_id reviews')
    const reviewsByProduct = new Map(products.map(product => [
        String(product._id),
        (product.reviews || []).some(review => String(review.user?._id || review.user) === String(req.user._id))
    ]))
    const eligibility = {}
    for (const productId of productIds) {
        eligibility[productId] = {
            canReview: true,
            hasReviewed: Boolean(reviewsByProduct.get(productId)),
            orderId: String(order._id)
        }
    }
    return res.status(200).json({ success: true, products: eligibility })
}
