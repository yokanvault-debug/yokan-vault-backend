const test = require('node:test')
const assert = require('node:assert/strict')
const Order = require('../models/order')
const Product = require('../models/product')
const User = require('../models/user')
const orderController = require('../controllers/order')
const productController = require('../controllers/product')
const Filter = require('bad-words')

const userId = '64b000000000000000000010'
const productId = '64b000000000000000000001'
const orderId = '64b000000000000000000020'

const makeResponse = () => ({
    statusCode: 200,
    body: null,
    status(code) {
        this.statusCode = code
        return this
    },
    json(body) {
        this.body = body
        return this
    }
})

test('customer cancellation requires a trimmed reason and stores cancellation audit fields', async () => {
    const originals = {
        findById: Order.findById,
        findOneAndUpdate: Order.findOneAndUpdate,
        orderUpdateOne: Order.updateOne,
        productUpdateOne: Product.updateOne,
        userFindById: User.findById
    }
    const order = {
        _id: orderId,
        user: userId,
        orderStatus: 'Processing',
        paymentInfo: { status: 'Pending' },
        inventoryReserved: true,
        orderItems: [{ product: productId, quantity: 2 }]
    }
    let update
    Order.findById = async () => order
    Order.findOneAndUpdate = async (_filter, updateDocument) => {
        update = updateDocument
        Object.assign(order, updateDocument.$set)
        return order
    }
    Order.updateOne = async () => ({ matchedCount: 1 })
    Product.updateOne = async () => ({ matchedCount: 1 })
    User.findById = async () => null
    try {
        const response = makeResponse()
        await orderController.cancelOrder({
            params: { id: orderId },
            body: { reason: '  Changed my mind  ' },
            user: { _id: userId, role: 'user' }
        }, response)
        assert.equal(response.statusCode, 200)
        assert.equal(update.$set.orderStatus, 'Cancelled')
        assert.equal(update.$set.cancellationReason, 'Changed my mind')
        assert.ok(update.$set.cancelledAt instanceof Date)
        assert.equal(update.$set.cancelledBy, userId)
        assert.equal(update.$set.cancelledByRole, 'user')
    } finally {
        Order.findById = originals.findById
        Order.findOneAndUpdate = originals.findOneAndUpdate
        Order.updateOne = originals.orderUpdateOne
        Product.updateOne = originals.productUpdateOne
        User.findById = originals.userFindById
    }
})

test('cancellation rejects missing, whitespace-only, and overlong reasons before database access', async () => {
    const originalFindById = Order.findById
    let reads = 0
    Order.findById = async () => {
        reads += 1
        throw new Error('Invalid cancellation should not read an order')
    }
    try {
        for (const reason of [undefined, '   ', 'x'.repeat(501)]) {
            const response = makeResponse()
            await orderController.cancelOrder({
                params: { id: orderId },
                body: { reason },
                user: { _id: userId, role: 'user' }
            }, response)
            assert.equal(response.statusCode, 400)
            assert.match(response.body.message, /reason/i)
        }
        assert.equal(reads, 0)
    } finally {
        Order.findById = originalFindById
    }
})

test('customers cannot cancel shipped, delivered, or already-cancelled orders', async () => {
    const originalFindById = Order.findById
    const originalFindOneAndUpdate = Order.findOneAndUpdate
    try {
        for (const orderStatus of ['Shipped', 'Delivered', 'Cancelled']) {
            Order.findById = async () => ({
                _id: orderId,
                user: userId,
                orderStatus,
                inventoryReserved: false,
                orderItems: []
            })
            Order.findOneAndUpdate = async () => {
                throw new Error('An ineligible order must not be updated')
            }
            const response = makeResponse()
            await orderController.cancelOrder({
                params: { id: orderId },
                body: { reason: 'No longer needed' },
                user: { _id: userId, role: 'user' }
            }, response)
            assert.equal(response.statusCode, 400)
        }
    } finally {
        Order.findById = originalFindById
        Order.findOneAndUpdate = originalFindOneAndUpdate
    }
})

test('cancellation does not restore stock when the order was never reserved', async () => {
    const originals = {
        findById: Order.findById,
        findOneAndUpdate: Order.findOneAndUpdate,
        productUpdateOne: Product.updateOne,
        userFindById: User.findById
    }
    const order = {
        _id: orderId,
        user: userId,
        orderStatus: 'Processing',
        paymentInfo: { status: 'Pending' },
        inventoryReserved: false,
        orderItems: [{ product: productId, quantity: 1 }]
    }
    Order.findById = async () => order
    Order.findOneAndUpdate = async (_filter, update) => {
        Object.assign(order, update.$set)
        return order
    }
    Product.updateOne = async () => {
        throw new Error('Unreserved inventory must not be restored')
    }
    User.findById = async () => null
    try {
        const response = makeResponse()
        await orderController.cancelOrder({
            params: { id: orderId },
            body: { reason: 'No longer needed' },
            user: { _id: userId, role: 'user' }
        }, response)
        assert.equal(response.statusCode, 200)
        assert.equal(order.inventoryRestoredAt, undefined)
    } finally {
        Order.findById = originals.findById
        Order.findOneAndUpdate = originals.findOneAndUpdate
        Product.updateOne = originals.productUpdateOne
        User.findById = originals.userFindById
    }
})

test('delivered-order review stores the order association and updates an existing customer review', async () => {
    const originals = {
        productFindById: Product.findById,
        orderFindOne: Order.findOne
    }
    const existing = { user: userId, rating: 3, comment: 'Earlier', order: '64b000000000000000000019' }
    let saved = false
    const product = {
        _id: productId,
        reviews: [existing],
        save: async () => { saved = true }
    }
    Product.findById = async () => product
    Order.findOne = async filter => {
        assert.equal(filter.user, userId)
        assert.equal(filter.orderStatus, 'Delivered')
        assert.equal(String(filter._id), orderId)
        assert.equal(String(filter['orderItems.product']), productId)
        return { _id: orderId }
    }
    try {
        const response = makeResponse()
        await productController.createProductReview({
            body: { productId, orderId, rating: 5, comment: '  Great quality  ' },
            user: { _id: userId, name: 'Customer' }
        }, response)
        assert.equal(response.statusCode, 200)
        assert.equal(response.body.updated, true)
        assert.equal(product.reviews.length, 1)
        assert.equal(existing.rating, 5)
        assert.equal(existing.comment, 'Great quality')
        assert.equal(existing.originalComment, 'Great quality')
        assert.equal(String(existing.order), orderId)
        assert.equal(saved, true)
    } finally {
        Product.findById = originals.productFindById
        Order.findOne = originals.orderFindOne
    }
})

test('admin review list includes original comments while public review responses exclude them', async () => {
    const originals = {
        productFind: Product.find,
        productFindById: Product.findById
    }
    const review = {
        _id: '64b000000000000000000099',
        user: { _id: userId, name: 'Customer', email: 'customer@example.test' },
        name: 'Customer',
        rating: 4,
        comment: 'This is ****.',
        originalComment: 'This is shit.'
    }
    const product = { _id: productId, name: 'Test product', reviews: [review] }
    const query = {
        select() { return this },
        then(resolve, reject) { return Promise.resolve([product]).then(resolve, reject) }
    }
    Product.find = () => query
    Product.findById = async () => product
    try {
        const adminResponse = makeResponse()
        await productController.getAdminReviews({}, adminResponse)
        assert.equal(adminResponse.statusCode, 200)
        assert.equal(adminResponse.body.reviews[0].originalComment, 'This is shit.')
        assert.equal(adminResponse.body.reviews[0].comment, 'This is ****.')

        const publicResponse = makeResponse()
        await productController.getProductReviews({ query: { id: productId } }, publicResponse)
        assert.equal(publicResponse.statusCode, 200)
        assert.equal(publicResponse.body.reviews[0].comment, 'This is ****.')
        assert.equal(Object.hasOwn(publicResponse.body.reviews[0], 'originalComment'), false)
    } finally {
        Product.find = originals.productFind
        Product.findById = originals.productFindById
    }
})

test('admin review edits preserve original text, re-filter public text, and recalculate product ratings', async () => {
    const originals = {
        productFindById: Product.findById,
        productFindOneAndUpdate: Product.findOneAndUpdate,
        clean: Filter.prototype.clean
    }
    const review = {
        _id: '64b000000000000000000099',
        rating: 2,
        comment: 'Old filtered text',
        originalComment: 'Old original text'
    }
    let updatedQuery
    let updatedValues
    const product = {
        _id: productId,
        reviews: [review],
    }
    Product.findById = async () => product
    Product.findOneAndUpdate = async (query, update) => {
        updatedQuery = query
        updatedValues = update.$set
        return product
    }
    Filter.prototype.clean = comment => comment.replace('badword', '*******')
    try {
        const response = makeResponse()
        await productController.updateAdminReview({
            params: { productId, id: review._id },
            body: { rating: 5, comment: 'A badword review' }
        }, response)
        assert.equal(response.statusCode, 200)
        assert.deepEqual(updatedQuery, { _id: productId, 'reviews._id': review._id })
        assert.equal(updatedValues['reviews.$.originalComment'], 'A badword review')
        assert.equal(updatedValues['reviews.$.comment'], 'A ******* review')
        assert.equal(updatedValues['reviews.$.rating'], 5)
        assert.equal(updatedValues.ratings, 5)
        assert.equal(updatedValues.numOfReviews, 1)
    } finally {
        Product.findById = originals.productFindById
        Product.findOneAndUpdate = originals.productFindOneAndUpdate
        Filter.prototype.clean = originals.clean
    }
})

test('raw review text is excluded from default product projections', () => {
    assert.equal(Product.schema.path('reviews.originalComment').options.select, false)
})

test('review validation rejects invalid rating, empty comment, and overlong comment', async () => {
    const originalProductFindById = Product.findById
    let productReads = 0
    Product.findById = async () => {
        productReads += 1
        return null
    }
    try {
        for (const body of [
            { productId, orderId, rating: 6, comment: 'Valid comment' },
            { productId, orderId, rating: 4.5, comment: 'Valid comment' },
            { productId, orderId, rating: 4, comment: '   ' },
            { productId, orderId, rating: 4, comment: { text: 'Not a string' } },
            { productId, orderId, rating: 4, comment: 'x'.repeat(501) }
        ]) {
            const response = makeResponse()
            await productController.createProductReview({ body, user: { _id: userId } }, response)
            assert.equal(response.statusCode, 400)
        }
        assert.equal(productReads, 0)
    } finally {
        Product.findById = originalProductFindById
    }
})

test('review cannot be submitted unless the customer owns a delivered order containing the product', async () => {
    const originals = {
        productFindById: Product.findById,
        orderFindOne: Order.findOne
    }
    let saved = false
    Product.findById = async () => ({
        _id: productId,
        reviews: [],
        save: async () => { saved = true }
    })
    Order.findOne = async filter => {
        assert.equal(filter.user, userId)
        assert.equal(filter.orderStatus, 'Delivered')
        return null
    }
    try {
        const response = makeResponse()
        await productController.createProductReview({
            body: { productId, orderId, rating: 4, comment: 'Good item' },
            user: { _id: userId, name: 'Customer' }
        }, response)
        assert.equal(response.statusCode, 403)
        assert.equal(saved, false)
    } finally {
        Product.findById = originals.productFindById
        Order.findOne = originals.orderFindOne
    }
})

test('cancelled and incomplete orders cannot qualify for product reviews', async () => {
    const originals = {
        productFindById: Product.findById,
        orderFindOne: Order.findOne
    }
    Product.findById = () => ({ select: async () => ({ _id: productId, reviews: [] }) })
    Order.findOne = (filter) => {
        assert.equal(filter.user, userId)
        assert.equal(filter.orderStatus, 'Delivered')
        assert.deepEqual(filter.inventoryReserved, { $ne: false })
        assert.equal(filter['orderItems.product'], productId)
        return { select: async () => null }
    }
    try {
        for (const orderStatus of ['Cancelled', 'Processing', 'Shipped']) {
            const response = makeResponse()
            await productController.reviewEligibility({
                params: { productId },
                query: { orderId },
                user: { _id: userId }
            }, response)
            assert.equal(response.statusCode, 200)
            assert.equal(response.body.canReview, false, `${orderStatus} order must not qualify`)
        }
    } finally {
        Product.findById = originals.productFindById
        Order.findOne = originals.orderFindOne
    }
})

test('reviewing another customer does not overwrite their review', async () => {
    const originals = {
        productFindById: Product.findById,
        orderFindOne: Order.findOne
    }
    const otherReview = { user: '64b000000000000000000099', rating: 2, comment: 'Existing review' }
    const product = {
        _id: productId,
        reviews: [otherReview],
        save: async () => {}
    }
    Product.findById = async () => product
    Order.findOne = async () => ({ _id: orderId })
    try {
        const response = makeResponse()
        await productController.createProductReview({
            body: { productId, orderId, rating: 5, comment: 'A new review' },
            user: { _id: userId, name: 'Customer' }
        }, response)
        assert.equal(response.statusCode, 200)
        assert.equal(response.body.updated, false)
        assert.equal(product.reviews.length, 2)
        assert.equal(otherReview.rating, 2)
        assert.equal(otherReview.comment, 'Existing review')
    } finally {
        Product.findById = originals.productFindById
        Order.findOne = originals.orderFindOne
    }
})

test('review moderation failure rejects the request without saving the unfiltered comment', async () => {
    const originals = {
        productFindById: Product.findById,
        orderFindOne: Order.findOne,
        clean: Filter.prototype.clean
    }
    let saved = false
    Product.findById = async () => ({
        _id: productId,
        reviews: [],
        save: async () => { saved = true }
    })
    Order.findOne = async () => ({ _id: orderId })
    Filter.prototype.clean = () => { throw new Error('moderation internals') }
    try {
        const response = makeResponse()
        await productController.createProductReview({
            body: { productId, orderId, rating: 4, comment: 'Unfiltered text' },
            user: { _id: userId, name: 'Customer' }
        }, response)
        assert.equal(response.statusCode, 503)
        assert.doesNotMatch(response.body.message, /moderation internals/)
        assert.equal(saved, false)
    } finally {
        Product.findById = originals.productFindById
        Order.findOne = originals.orderFindOne
        Filter.prototype.clean = originals.clean
    }
})

test('review validation errors are returned without bypassing Mongoose save validation', async () => {
    const originals = {
        productFindById: Product.findById,
        orderFindOne: Order.findOne
    }
    let saveCount = 0
    Product.findById = async () => ({
        _id: productId,
        reviews: [],
        save: async () => {
            saveCount += 1
            const error = new Error('invalid review')
            error.name = 'ValidationError'
            throw error
        }
    })
    Order.findOne = async () => ({ _id: orderId })
    try {
        const response = makeResponse()
        await productController.createProductReview({
            body: { productId, orderId, rating: 4, comment: 'Valid comment' },
            user: { _id: userId, name: 'Customer' }
        }, response)
        assert.equal(response.statusCode, 400)
        assert.equal(saveCount, 1)
    } finally {
        Product.findById = originals.productFindById
        Order.findOne = originals.orderFindOne
    }
})
