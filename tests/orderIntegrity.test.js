const test = require('node:test')
const assert = require('node:assert/strict')
const Order = require('../models/order')
const Product = require('../models/product')
const User = require('../models/user')
const orderController = require('../controllers/order')
const { PAID_ORDER_MATCH } = require('../utils/salesReports')

const productId = '64b000000000000000000001'
const userId = '64b000000000000000000010'
const shippingInfo = {
    address: '1 Test Street',
    city: 'Test City',
    phoneNo: '0000000000',
    postalCode: '0000',
    country: 'Test'
}

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

const makeRequest = ({ key = 'checkout-key-0001', quantity = 1, user = userId, items, shipping = shippingInfo } = {}) => ({
    body: {
        orderItems: items || [{ product: productId, quantity, price: 0.01 }],
        shippingInfo: shipping,
        totalPrice: 0.01,
        itemsPrice: 0.01,
        taxPrice: 0,
        shippingPrice: 0
    },
    user: { _id: user },
    get: (name) => name === 'Idempotency-Key' ? key : undefined
})

const installCheckoutMocks = ({
    stock = 10,
    price = 40.25,
    failFinalize = false,
    failCreate = false,
    secondProduct = null,
    reservationFailureId = null,
    reservationGate = null
} = {}) => {
    const originals = {
        orderFindOne: Order.findOne,
        orderCreate: Order.create,
        orderFindOneAndUpdate: Order.findOneAndUpdate,
        orderFindByIdAndDelete: Order.findByIdAndDelete,
        productFind: Product.find,
        productFindOneAndUpdate: Product.findOneAndUpdate,
        productUpdateOne: Product.updateOne
    }
    const product = {
        _id: productId,
        name: 'Collector card',
        price,
        stock,
        deletedAt: null,
        images: [{ url: '/card.png' }],
        isBlindBox: false,
        inventoryReservations: []
    }
    const inventoryProducts = new Map([[productId, product]])
    if (secondProduct) {
        inventoryProducts.set(secondProduct._id, {
            ...product,
            ...secondProduct,
            inventoryReservations: []
        })
    }
    const orders = []
    const inventoryRestorations = []

    Order.findOne = async ({ user: owner, checkoutKey }) =>
        orders.find(order => String(order.user) === String(owner) && order.checkoutKey === checkoutKey) || null
    Order.create = async (data) => {
        if (failCreate) throw new Error('simulated order write failure')
        if (orders.some(order => String(order.user) === String(data.user) && order.checkoutKey === data.checkoutKey)) {
            const error = new Error('duplicate key')
            error.code = 11000
            throw error
        }
        const order = { ...data, _id: `order-${orders.length + 1}` }
        orders.push(order)
        return order
    }
    Order.findOneAndUpdate = async (filter, update) => {
        const order = orders.find(item => item._id === filter._id)
        if (!order || order.inventoryReserved !== filter.inventoryReserved || failFinalize) return null
        Object.assign(order, update.$set)
        return { ...order }
    }
    Order.findByIdAndDelete = async (id) => {
        const index = orders.findIndex(order => order._id === id)
        return index < 0 ? null : orders.splice(index, 1)[0]
    }
    Product.find = async (filter) => {
        const requested = filter._id.$in.map(String)
        return requested
            .map(id => inventoryProducts.get(id))
            .filter(item => item && item.deletedAt === null)
            .map(item => ({ ...item }))
    }
    Product.findOneAndUpdate = async (filter, update) => {
        if (reservationGate) {
            reservationGate.signalEntered()
            await reservationGate.promise
        }
        const target = inventoryProducts.get(String(filter._id))
        const quantity = -update.$inc.stock
        const orderId = update.$push.inventoryReservations.order
        const hasReservation = target?.inventoryReservations.some(item => item.order === orderId)
        if (!target || target._id === reservationFailureId || target.deletedAt !== null ||
            target.stock < quantity || !Number.isInteger(target.stock) || hasReservation) {
            return null
        }
        target.stock += update.$inc.stock
        target.inventoryReservations.push({ order: orderId, quantity: update.$push.inventoryReservations.quantity })
        return { ...target }
    }
    Product.updateOne = async (filter, update) => {
        inventoryRestorations.push({ filter, update })
        const target = inventoryProducts.get(String(filter._id))
        if (!target) return { matchedCount: 0, modifiedCount: 0 }
        const index = target.inventoryReservations.findIndex(item =>
            String(item.order) === String(filter['inventoryReservations.order'])
        )
        if (index < 0) return { matchedCount: 0, modifiedCount: 0 }
        target.stock = target.stock + (update.$inc?.stock || 0)
        target.inventoryReservations.splice(index, 1)
        return { matchedCount: 1, modifiedCount: 1 }
    }

    return {
        product,
        inventoryProducts,
        orders,
        inventoryRestorations,
        restore() {
            Order.findOne = originals.orderFindOne
            Order.create = originals.orderCreate
            Order.findOneAndUpdate = originals.orderFindOneAndUpdate
            Order.findByIdAndDelete = originals.orderFindByIdAndDelete
            Product.find = originals.productFind
            Product.findOneAndUpdate = originals.productFindOneAndUpdate
            Product.updateOne = originals.productUpdateOne
        }
    }
}

test('checkout creation uses database snapshots and server-calculated money fields', async () => {
    const mocks = installCheckoutMocks()
    try {
        const res = makeResponse()
        await orderController.newOrder(makeRequest(), res)
        assert.equal(res.statusCode, 201)
        assert.equal(res.body.order.orderItems[0].price, 40.25)
        assert.equal(res.body.order.itemsPrice, 40.25)
        assert.equal(res.body.order.taxPrice, 2.01)
        assert.equal(res.body.order.shippingPrice, 25)
        assert.equal(res.body.order.totalPrice, 67.26)
        assert.deepEqual(res.body.order.paymentInfo, { method: 'Cash on Delivery', status: 'Pending' })
        assert.equal(res.body.order.paidAt, undefined)
        assert.equal(res.body.order.paidBy, undefined)
        assert.equal(mocks.product.stock, 9)
    } finally {
        mocks.restore()
    }
})

test('tax rounding uses cents consistently and shipping remains free above the existing threshold', async () => {
    const mocks = installCheckoutMocks({ price: 200.01 })
    try {
        const res = makeResponse()
        await orderController.orderQuote(makeRequest(), res)
        assert.equal(res.statusCode, 200)
        assert.equal(res.body.itemsPrice, 200.01)
        assert.equal(res.body.taxPrice, 10)
        assert.equal(res.body.shippingPrice, 0)
        assert.equal(res.body.totalPrice, 210.01)
    } finally {
        mocks.restore()
    }

    const decimalMocks = installCheckoutMocks({ price: 0.1 })
    try {
        const res = makeResponse()
        await orderController.orderQuote(makeRequest({ quantity: 3 }), res)
        assert.equal(res.body.itemsPrice, 0.3)
        assert.equal(res.body.taxPrice, 0.02)
        assert.equal(res.body.totalPrice, 25.32)
    } finally {
        decimalMocks.restore()
    }
})

test('product prices at half-cent boundaries round consistently to currency cents', async () => {
    const mocks = installCheckoutMocks({ price: 1.005 })
    try {
        const res = makeResponse()
        await orderController.orderQuote(makeRequest(), res)
        assert.equal(res.statusCode, 200)
        assert.equal(res.body.itemsPrice, 1.01)
        assert.equal(res.body.taxPrice, 0.05)
        assert.equal(res.body.totalPrice, 26.06)
    } finally {
        mocks.restore()
    }
})

test('missing and malformed checkout keys are rejected before writes', async () => {
    const mocks = installCheckoutMocks()
    try {
        for (const key of [undefined, 'short', 'bad key value']) {
            const req = makeRequest({ key })
            req.get = () => key
            const res = makeResponse()
            await orderController.newOrder(req, res)
            assert.equal(res.statusCode, 400)
        }
        assert.equal(mocks.orders.length, 0)
        assert.equal(mocks.product.stock, 10)
    } finally {
        mocks.restore()
    }
})

test('invalid product IDs and zero, fractional, negative, or excessive quantities are rejected', async () => {
    const mocks = installCheckoutMocks()
    try {
        const invalidItems = [
            [{ product: 'not-an-object-id', quantity: 1 }],
            [{ product: productId, quantity: 0 }],
            [{ product: productId, quantity: 1.5 }],
            [{ product: productId, quantity: -1 }],
            [{ product: productId, quantity: 100 }]
        ]
        for (const [index, orderItems] of invalidItems.entries()) {
            const res = makeResponse()
            await orderController.orderQuote(makeRequest({ items: orderItems }), res)
            assert.equal(res.statusCode, 400, `invalid item case ${index}`)
        }
        assert.equal(mocks.product.stock, 10)
    } finally {
        mocks.restore()
    }
})

test('checkout rejects missing, blank, and overlong shipping fields before reading products', async () => {
    const originalFind = Product.find
    Product.find = () => { throw new Error('Invalid shipping data reached product lookup') }
    try {
        const invalidShipping = [
            { ...shippingInfo, address: '   ' },
            { ...shippingInfo, city: 'x'.repeat(101) },
            { ...shippingInfo, phoneNo: undefined },
            { ...shippingInfo, postalCode: 'x'.repeat(21) },
            { ...shippingInfo, country: '' }
        ]
        for (const shipping of invalidShipping) {
            const res = makeResponse()
            await orderController.orderQuote(makeRequest({ shipping }), res)
            assert.equal(res.statusCode, 400)
            assert.match(res.body.message, /shipping/i)
        }
    } finally {
        Product.find = originalFind
    }
})

test('same idempotency key and payload return the original order without a second reservation', async () => {
    const mocks = installCheckoutMocks()
    try {
        const first = makeResponse()
        const retry = makeResponse()
        await orderController.newOrder(makeRequest(), first)
        await orderController.newOrder(makeRequest(), retry)
        assert.equal(first.statusCode, 201)
        assert.equal(retry.statusCode, 200)
        assert.equal(retry.body.order._id, first.body.order._id)
        assert.equal(Object.hasOwn(retry.body.order, 'checkoutRequestHash'), false)
        assert.equal(mocks.orders.length, 1)
        assert.equal(mocks.product.stock, 9)
    } finally {
        mocks.restore()
    }
})

test('retry while the first request is reserving stock does not create another order', async () => {
    let releaseReservation
    let signalReservation
    const reservationGate = {
        promise: new Promise(resolve => { releaseReservation = resolve }),
        signalEntered: () => signalReservation()
    }
    const reservationStarted = new Promise(resolve => { signalReservation = resolve })
    const mocks = installCheckoutMocks({ reservationGate })
    try {
        const first = makeResponse()
        const firstRequest = orderController.newOrder(makeRequest(), first)
        await reservationStarted
        const retry = makeResponse()
        await orderController.newOrder(makeRequest(), retry)
        assert.equal(retry.statusCode, 409)
        assert.equal(mocks.orders.length, 1)
        releaseReservation()
        await firstRequest
        assert.equal(first.statusCode, 201)
        const completedRetry = makeResponse()
        await orderController.newOrder(makeRequest(), completedRetry)
        assert.equal(completedRetry.statusCode, 200)
        assert.equal(mocks.orders.length, 1)
        assert.equal(mocks.product.stock, 9)
    } finally {
        releaseReservation?.()
        mocks.restore()
    }
})

test('reusing a checkout key with different items or shipping is rejected', async () => {
    const mocks = installCheckoutMocks()
    try {
        const first = makeResponse()
        await orderController.newOrder(makeRequest(), first)
        const conflicting = makeResponse()
        await orderController.newOrder(makeRequest({
            quantity: 2,
            shipping: { ...shippingInfo, city: 'Other City' }
        }), conflicting)
        assert.equal(conflicting.statusCode, 409)
        assert.match(conflicting.body.message, /different request/)
        assert.equal(mocks.product.stock, 9)
    } finally {
        mocks.restore()
    }
})

test('failure reserving one product compensates earlier product reservations', async () => {
    const secondProductId = '64b000000000000000000002'
    const mocks = installCheckoutMocks({
        secondProduct: {
            _id: secondProductId,
            name: 'Second collector card',
            stock: 4,
            price: 10,
            images: [{ url: '/second.png' }],
            isBlindBox: false,
            deletedAt: null
        },
        reservationFailureId: secondProductId
    })
    try {
        const res = makeResponse()
        await orderController.newOrder(makeRequest({
            items: [
                { product: productId, quantity: 2 },
                { product: secondProductId, quantity: 1 }
            ]
        }), res)
        assert.equal(res.statusCode, 409)
        assert.equal(mocks.product.stock, 10)
        assert.equal(mocks.inventoryProducts.get(secondProductId).stock, 4)
        assert.equal(mocks.product.inventoryReservations.length, 0)
        assert.equal(mocks.orders.length, 0)
    } finally {
        mocks.restore()
    }
})

test('a failed finalization compensates the reservation and removes the incomplete order', async () => {
    const mocks = installCheckoutMocks({ failFinalize: true })
    try {
        const res = makeResponse()
        await orderController.newOrder(makeRequest(), res)
        assert.equal(res.statusCode, 500)
        assert.equal(mocks.inventoryRestorations.length, 1)
        assert.deepEqual(mocks.inventoryRestorations[0].filter, {
            _id: productId,
            'inventoryReservations.order': 'order-1'
        })
        assert.deepEqual(mocks.product.inventoryReservations, [])
        assert.deepEqual(mocks.inventoryRestorations[0].update.$inc, { stock: 1 })
        assert.equal(mocks.product.stock, 10)
        assert.equal(mocks.product.inventoryReservations.length, 0)
        assert.equal(mocks.orders.length, 0)
    } finally {
        mocks.restore()
    }
})

test('a later item reservation failure restores earlier reservations before failing checkout', async () => {
    const secondProductId = '64b000000000000000000002'
    const mocks = installCheckoutMocks({
        secondProduct: { _id: secondProductId, name: 'Second card', stock: 3 },
        reservationFailureId: secondProductId
    })
    try {
        const res = makeResponse()
        await orderController.newOrder(makeRequest({
            items: [
                { product: productId, quantity: 2 },
                { product: secondProductId, quantity: 1 }
            ]
        }), res)
        assert.equal(res.statusCode, 409)
        assert.equal(mocks.inventoryProducts.get(productId).stock, 10)
        assert.equal(mocks.inventoryProducts.get(secondProductId).stock, 3)
        assert.deepEqual(mocks.inventoryProducts.get(productId).inventoryReservations, [])
        assert.deepEqual(mocks.inventoryProducts.get(secondProductId).inventoryReservations, [])
        assert.equal(mocks.orders.length, 0)
    } finally {
        mocks.restore()
    }
})

test('order-write failure leaves stock unchanged', async () => {
    const mocks = installCheckoutMocks({ failCreate: true })
    try {
        const res = makeResponse()
        await orderController.newOrder(makeRequest(), res)
        assert.equal(res.statusCode, 500)
        assert.equal(mocks.product.stock, 10)
        assert.equal(mocks.product.inventoryReservations.length, 0)
    } finally {
        mocks.restore()
    }
})

test('simultaneous reservations cannot oversell the same stock in the mocked atomic update', async () => {
    const mocks = installCheckoutMocks({ stock: 1 })
    try {
        const responses = [makeResponse(), makeResponse()]
        await Promise.all([
            orderController.newOrder(makeRequest({ key: 'checkout-key-0001', user: userId }), responses[0]),
            orderController.newOrder(makeRequest({ key: 'checkout-key-0002', user: '64b000000000000000000011' }), responses[1])
        ])
        assert.deepEqual(responses.map(res => res.statusCode).sort(), [201, 409])
        assert.equal(mocks.product.stock, 0)
        assert.ok(mocks.product.stock >= 0)
        assert.equal(mocks.orders.length, 1)
        assert.equal(mocks.product.inventoryReservations.length, 1)
    } finally {
        mocks.restore()
    }
})

test('checkout-key uniqueness is scoped to a user and ignores legacy orders without keys', () => {
    const indexes = Order.schema.indexes()
    const checkoutIndex = indexes.find(([keys]) => keys.user === 1 && keys.checkoutKey === 1)
    assert.ok(checkoutIndex)
    assert.equal(checkoutIndex[1].unique, true)
    assert.deepEqual(checkoutIndex[1].partialFilterExpression, { checkoutKey: { $type: 'string' } })
    assert.equal(indexes.some(([keys]) => keys.checkoutKey === 1 && !keys.user), false)
    assert.equal(Order.schema.path('checkoutRequestHash').options.select, false)
})

test('order and product schemas reject negative prices, fractional stock, and invalid quantities', () => {
    const stockValidators = Product.schema.path('stock').validators
    const priceValidators = Product.schema.path('price').validators
    const quantityValidators = Order.schema.path('orderItems').schema.path('quantity').validators
    assert.ok(stockValidators.some(validator => validator.type === 'min'))
    assert.ok(stockValidators.some(validator => validator.validator(1.5) === false))
    assert.ok(priceValidators.some(validator => validator.type === 'min'))
    assert.ok(quantityValidators.some(validator => validator.type === 'min'))
    assert.ok(quantityValidators.some(validator => validator.type === 'max'))
    assert.ok(quantityValidators.some(validator => validator.validator(1.5) === false))
})

test('customer cannot cancel another user order', async () => {
    const originalFindById = Order.findById
    const originalFindOneAndUpdate = Order.findOneAndUpdate
    const originalUpdateOne = Order.updateOne
    Order.findById = async () => ({
        _id: '64b000000000000000000037',
        user: '64b000000000000000000099',
        orderStatus: 'Processing',
        paymentInfo: { status: 'Pending' }
    })
    Order.findOneAndUpdate = async () => {
        throw new Error('unauthorized update attempted')
    }
    Order.updateOne = originalUpdateOne
    try {
        const res = makeResponse()
        await orderController.cancelOrder({
            params: { id: '64b000000000000000000037' },
            body: { reason: 'No longer needed' },
            user: { _id: userId }
        }, res)
        assert.equal(res.statusCode, 404)
    } finally {
        Order.findById = originalFindById
        Order.findOneAndUpdate = originalFindOneAndUpdate
        Order.updateOne = originalUpdateOne
    }
})

test('concurrent cancellation restores inventory at most once and remains retryable', async () => {
    const originalOrderFindById = Order.findById
    const originalOrderFindOneAndUpdate = Order.findOneAndUpdate
    const originalOrderUpdateOne = Order.updateOne
    const originalProductUpdateOne = Product.updateOne
    const originalUserFindById = User.findById
    const order = {
        _id: '64b000000000000000000038',
        user: userId,
        orderStatus: 'Processing',
        paymentInfo: { status: 'Pending' },
        inventoryReserved: true,
        orderItems: [{ product: productId, quantity: 2 }],
        inventoryRestoredAt: undefined
    }
    const inventory = {
        stock: 3,
        reservations: [{ order: order._id, quantity: 2 }]
    }
    let restoredStockIncrements = 0
    Order.findById = async () => ({ ...order, paymentInfo: { ...order.paymentInfo } })
    Order.findOneAndUpdate = async (filter, update) => {
        if (order.orderStatus !== filter.orderStatus) return null
        Object.assign(order, update.$set)
        return { ...order, paymentInfo: { ...order.paymentInfo } }
    }
    Order.updateOne = async (filter, update) => {
        if (order.orderStatus !== filter.orderStatus || order.inventoryRestoredAt) {
            return { matchedCount: 0 }
        }
        order.inventoryRestoredAt = update.$set.inventoryRestoredAt
        return { matchedCount: 1 }
    }
    Product.updateOne = async (filter, update) => {
        const index = inventory.reservations.findIndex(item =>
            item.order === filter['inventoryReservations.order']
        )
        if (index < 0) return { matchedCount: 0 }
        inventory.stock += update.$inc.stock
        restoredStockIncrements += update.$inc.stock
        inventory.reservations.splice(index, 1)
        return { matchedCount: 1 }
    }
    User.findById = async () => null
    const req = () => ({ params: { id: order._id }, body: { reason: 'No longer needed' }, user: { _id: userId, role: 'user' } })
    try {
        const responses = [makeResponse(), makeResponse()]
        await Promise.all(responses.map(res => orderController.cancelOrder(req(), res)))
        assert.deepEqual(responses.map(res => res.statusCode).sort(), [200, 409])
        assert.equal(inventory.stock, 5)
        assert.equal(restoredStockIncrements, 2)
        assert.equal(inventory.reservations.length, 0)

        const retry = makeResponse()
        await orderController.cancelOrder(req(), retry)
        assert.equal(retry.statusCode, 400)
        assert.match(retry.body.message, /already been cancelled/)
        assert.equal(inventory.stock, 5)
        assert.equal(restoredStockIncrements, 2)
    } finally {
        Order.findById = originalOrderFindById
        Order.findOneAndUpdate = originalOrderFindOneAndUpdate
        Order.updateOne = originalOrderUpdateOne
        Product.updateOne = originalProductUpdateOne
        User.findById = originalUserFindById
    }
})

test('monthly reports use paidAt and sort across November 2025 through February 2026', async () => {
    const originalAggregate = Order.aggregate
    let pipeline
    Order.aggregate = async (value) => {
        pipeline = value
        return [
            { _id: { year: 2026, month: 2 }, total: 40 },
            { _id: { year: 2026, month: 1 }, total: 30 },
            { _id: { year: 2025, month: 11 }, total: 10 },
            { _id: { year: 2025, month: 12 }, total: 20 }
        ]
    }
    try {
        const res = makeResponse()
        await orderController.salesPerMonth({
            query: { startDate: '2025-11-01', endDate: '2026-02-28' }
        }, res)
        assert.deepEqual(pipeline[0].$match['paymentInfo.status'], 'Paid')
        assert.deepEqual(pipeline[0].$match.orderStatus, { $ne: 'Cancelled' })
        assert.deepEqual(pipeline[0].$match.inventoryReserved, { $ne: false })
        assert.deepEqual(pipeline[0].$match.paidAt, {
            $type: 'date',
            $gte: new Date('2025-11-01T00:00:00.000Z'),
            $lt: new Date('2026-03-01T00:00:00.000Z')
        })
        assert.deepEqual(pipeline[1].$group._id, {
            year: { $year: { date: '$paidAt', timezone: 'UTC' } },
            month: { $month: { date: '$paidAt', timezone: 'UTC' } }
        })
        assert.deepEqual(res.body.salesPerMonth.map(month => month.month), [
            'Nov 2025', 'Dec 2025', 'Jan 2026', 'Feb 2026'
        ])
        assert.deepEqual(res.body.salesPerMonth.map(month => [month.year, month.monthNumber]), [
            [2025, 11], [2025, 12], [2026, 1], [2026, 2]
        ])
        assert.deepEqual(pipeline[2].$sort, { '_id.year': 1, '_id.month': 1 })
    } finally {
        Order.aggregate = originalAggregate
    }
})

test('monthly report rejects invalid ranges before querying sales', async () => {
    const originalAggregate = Order.aggregate
    Order.aggregate = () => { throw new Error('Invalid date range reached the database') }
    try {
        for (const query of [
            { startDate: '2026-02-30' },
            { startDate: '2026-03-02', endDate: '2026-03-01' }
        ]) {
            const res = makeResponse()
            await orderController.salesPerMonth({ query }, res)
            assert.equal(res.statusCode, 400)
        }
    } finally {
        Order.aggregate = originalAggregate
    }
})

test('monthly report keeps the same month distinct across different years', async () => {
    const originalAggregate = Order.aggregate
    let pipeline
    Order.aggregate = async value => {
        pipeline = value
        return [
            { _id: { year: 2026, month: 1 }, total: 80 },
            { _id: { year: 2025, month: 1 }, total: 50 }
        ]
    }
    try {
        const res = makeResponse()
        await orderController.salesPerMonth({ query: {} }, res)
        assert.deepEqual(res.body.salesPerMonth.map(row => row.month), ['Jan 2025', 'Jan 2026'])
        assert.deepEqual(pipeline[0].$match.paidAt, { $type: 'date' })
        assert.equal(JSON.stringify(pipeline).includes('deliveredAt'), false)
        assert.equal(JSON.stringify(pipeline).includes('createdAt'), false)
    } finally {
        Order.aggregate = originalAggregate
    }
})

test('paid dashboard totals exclude unpaid and cancelled orders and round to cents', async () => {
    const originalFind = Order.find
    const originalAggregate = Order.aggregate
    const pipelines = []
    Order.find = async () => [
        { totalPrice: 0.1, paymentInfo: { status: 'Paid' }, orderStatus: 'Delivered' },
        { totalPrice: 0.2, paymentInfo: { status: 'Paid' }, orderStatus: 'Delivered' },
        { totalPrice: 99, paymentInfo: { status: 'Pending' }, orderStatus: 'Delivered' },
        { totalPrice: 99, paymentInfo: { status: 'Paid' }, orderStatus: 'Cancelled' }
    ]
    Order.aggregate = async (pipeline) => {
        pipelines.push(pipeline)
        if (pipeline.some(stage => stage.$lookup)) return [{
            userId,
            total: 0.30000000000000004,
            orderCount: 2,
            userDetails: { name: 'Customer' }
        }]
        if (pipeline.some(stage => stage.$unwind)) return [{
            _id: productId,
            name: 'Collector card',
            total: 0.30000000000000004,
            quantity: 3
        }]
        return [{ _id: null, totalSales: 0.30000000000000004 }]
    }
    try {
        const allOrdersRes = makeResponse()
        await orderController.allOrders({}, allOrdersRes)
        assert.equal(allOrdersRes.body.totalAmount, 0.3)
        assert.equal(allOrdersRes.body.orders.length, 4)

        const totalSalesRes = makeResponse()
        await orderController.totalSales({}, totalSalesRes)
        assert.equal(totalSalesRes.body.totalSales[0].totalSales, 0.3)

        const productSalesRes = makeResponse()
        await orderController.productSales({}, productSalesRes)
        assert.equal(productSalesRes.body.itemsSubtotal, 0.3)
        assert.equal(productSalesRes.body.totalPercentage[0].total, 0.3)

        const customerSalesRes = makeResponse()
        await orderController.customerSales({}, customerSalesRes)
        assert.equal(customerSalesRes.body.customerSales[0].total, 0.3)
        assert.equal(customerSalesRes.body.customerSales[0].orderCount, 2)

        const productPipeline = pipelines.find(pipeline => pipeline.some(stage => stage.$unwind))
        const productGroup = productPipeline.find(stage => stage.$group).$group
        assert.equal(productGroup._id, '$orderItems.product')
        assert.deepEqual(productGroup.total, { $sum: { $multiply: ['$orderItems.price', '$orderItems.quantity'] } })
        assert.deepEqual(productGroup.quantity, { $sum: '$orderItems.quantity' })

        const customerPipeline = pipelines.find(pipeline => pipeline.some(stage => stage.$lookup))
        const customerGroup = customerPipeline.find(stage => stage.$group).$group
        assert.equal(customerGroup._id, '$user')
        assert.deepEqual(customerGroup.total, { $sum: '$totalPrice' })
        assert.deepEqual(customerGroup.orderCount, { $sum: 1 })
        assert.ok(customerPipeline.some(stage => JSON.stringify(stage).includes('Customer unavailable')))
        const paidPipelines = pipelines.filter(pipeline =>
            pipeline.some(stage => stage.$match?.['paymentInfo.status'] === 'Paid'))
        assert.equal(paidPipelines.length, 3)
        for (const pipeline of paidPipelines) {
            const match = pipeline.find(stage => stage.$match).$match
            assert.deepEqual(match, PAID_ORDER_MATCH)
        }
    } finally {
        Order.find = originalFind
        Order.aggregate = originalAggregate
    }
})

test('paid COD confirmation is idempotent and does not replace the first paid timestamp', async () => {
    const originalFindById = Order.findById
    const originalFindOneAndUpdate = Order.findOneAndUpdate
    const paidAt = new Date('2026-01-02T03:04:05.000Z')
    const order = {
        _id: '64b000000000000000000039',
        orderStatus: 'Delivered',
        paymentInfo: { method: 'Cash on Delivery', status: 'Paid' },
        paidAt,
        orderItems: []
    }
    let writes = 0
    Order.findById = async () => order
    Order.findOneAndUpdate = async () => {
        writes += 1
        return order
    }
    try {
        const res = makeResponse()
        await orderController.updateOrder({
            params: { id: order._id },
            body: { paymentStatus: 'Paid' }
        }, res)
        assert.equal(res.statusCode, 200)
        assert.equal(writes, 0)
        assert.equal(order.paidAt, paidAt)
    } finally {
        Order.findById = originalFindById
        Order.findOneAndUpdate = originalFindOneAndUpdate
    }
})

test('simultaneous COD confirmations preserve one paid timestamp', async () => {
    const originalFindById = Order.findById
    const originalFindOneAndUpdate = Order.findOneAndUpdate
    const order = {
        _id: '64b000000000000000000040',
        orderStatus: 'Delivered',
        paymentInfo: { method: 'Cash on Delivery', status: 'Pending' },
        orderItems: []
    }
    let writes = 0
    Order.findById = async () => ({
        ...order,
        paymentInfo: { ...order.paymentInfo }
    })
    Order.findOneAndUpdate = async (filter, update) => {
        if (filter['paymentInfo.status'] !== order.paymentInfo.status ||
            filter.orderStatus !== order.orderStatus) return null
        writes += 1
        Object.assign(order, update.$set)
        order.paymentInfo.status = update.$set['paymentInfo.status']
        return { ...order, paymentInfo: { ...order.paymentInfo } }
    }
    try {
        const responses = [makeResponse(), makeResponse()]
        await Promise.all(responses.map(res => orderController.updateOrder({
            params: { id: order._id },
            user: { _id: userId, role: 'admin' },
            body: { paymentStatus: 'Paid' }
        }, res)))
        assert.deepEqual(responses.map(res => res.statusCode), [200, 200])
        assert.equal(writes, 1)
        assert.equal(order.paymentInfo.status, 'Paid')
        assert.ok(order.paidAt instanceof Date)
    } finally {
        Order.findById = originalFindById
        Order.findOneAndUpdate = originalFindOneAndUpdate
    }
})

test('delivery transition keeps COD payment pending', async () => {
    const originalFindById = Order.findById
    const originalFindOneAndUpdate = Order.findOneAndUpdate
    const originalUserFindById = User.findById
    const order = {
        _id: '64b000000000000000000041',
        orderStatus: 'Shipped',
        paymentInfo: { method: 'Cash on Delivery', status: 'Pending' },
        orderItems: []
    }
    let update
    Order.findById = async () => order
    User.findById = async () => null
    Order.findOneAndUpdate = async (_filter, updateDocument) => {
        update = updateDocument
        return { ...order, ...updateDocument.$set }
    }
    try {
        const res = makeResponse()
        await orderController.updateOrder({
            params: { id: order._id },
            body: { status: 'Delivered' }
        }, res)
        assert.equal(res.statusCode, 200)
        assert.equal(res.body.paymentStatus, 'Pending')
        assert.ok(update.$set.deliveredAt instanceof Date)
        assert.equal(update.$set.paidAt, undefined)
        assert.equal(res.body.paidAt, undefined)
    } finally {
        Order.findById = originalFindById
        Order.findOneAndUpdate = originalFindOneAndUpdate
        User.findById = originalUserFindById
    }
})

test('delivery and COD collection cannot be confirmed in the same request', async () => {
    const originalFindById = Order.findById
    const originalFindOneAndUpdate = Order.findOneAndUpdate
    Order.findById = async () => ({
        _id: '64b000000000000000000042',
        orderStatus: 'Shipped',
        paymentInfo: { method: 'Cash on Delivery', status: 'Pending' },
        orderItems: []
    })
    Order.findOneAndUpdate = async () => {
        throw new Error('delivery/payment update must be rejected')
    }
    try {
        const res = makeResponse()
        await orderController.updateOrder({
            params: { id: '64b000000000000000000042' },
            body: { status: 'Delivered', paymentStatus: 'Paid' }
        }, res)
        assert.equal(res.statusCode, 400)
        assert.match(res.body.message, /only be marked collected for a delivered order/)
    } finally {
        Order.findById = originalFindById
        Order.findOneAndUpdate = originalFindOneAndUpdate
    }
})

test('unavailable product prevents order creation and stock reservation', async () => {
    const mocks = installCheckoutMocks()
    const originalFind = Product.find
    Product.find = async () => []
    try {
        const res = makeResponse()
        await orderController.newOrder(makeRequest(), res)
        assert.equal(res.statusCode, 409)
        assert.equal(mocks.orders.length, 0)
        assert.equal(mocks.product.stock, 10)
    } finally {
        Product.find = originalFind
        mocks.restore()
    }
})

test('insufficient stock rejects checkout before creating an order or changing inventory', async () => {
    const mocks = installCheckoutMocks({ stock: 1 })
    try {
        const res = makeResponse()
        await orderController.newOrder(makeRequest({ quantity: 2 }), res)
        assert.equal(res.statusCode, 409)
        assert.match(res.body.message, /not enough stock/i)
        assert.equal(mocks.orders.length, 0)
        assert.equal(mocks.product.stock, 1)
        assert.deepEqual(mocks.product.inventoryReservations, [])
    } finally {
        mocks.restore()
    }
})

test('order endpoints reject malformed IDs before database access', async () => {
    const originals = {
        findById: Order.findById,
        findOneAndUpdate: Order.findOneAndUpdate,
        findOneAndDelete: Order.findOneAndDelete
    }
    Order.findById = () => { throw new Error('Malformed order ID reached the database') }
    Order.findOneAndUpdate = () => { throw new Error('Malformed order ID reached the database') }
    Order.findOneAndDelete = () => { throw new Error('Malformed order ID reached the database') }
    const req = {
        params: { id: 'not-an-order-id' },
        body: { status: 'Shipped', reason: 'Reason' },
        user: { _id: userId, role: 'admin' }
    }
    try {
        for (const controller of [
            orderController.getSingleOrder,
            orderController.downloadReceipt,
            orderController.deleteOrder,
            orderController.updateOrder,
            orderController.cancelOrder
        ]) {
            const res = makeResponse()
            await controller(req, res)
            assert.equal(res.statusCode, 400, `${controller.name} should reject malformed IDs`)
            assert.match(res.body.message, /invalid order id/i)
        }
    } finally {
        Order.findById = originals.findById
        Order.findOneAndUpdate = originals.findOneAndUpdate
        Order.findOneAndDelete = originals.findOneAndDelete
    }
})

test('customers cannot retrieve another customer order', async () => {
    const originalFindById = Order.findById
    const privateOrder = {
        _id: '64b000000000000000000036',
        user: '64b000000000000000000099',
        inventoryReserved: true
    }
    Order.findById = () => ({
        populate() { return Promise.resolve(privateOrder) }
    })
    try {
        const res = makeResponse()
        await orderController.getSingleOrder({
            params: { id: privateOrder._id },
            user: { _id: userId, role: 'user' }
        }, res)
        assert.equal(res.statusCode, 404)
        assert.equal(res.body.message, 'Order not found')
    } finally {
        Order.findById = originalFindById
    }
})

test('admin order updates reject client-controlled totals and payment fields', async () => {
    const originalFindById = Order.findById
    Order.findById = () => { throw new Error('Rejected order fields reached the database') }
    try {
        for (const body of [
            { totalPrice: 1 },
            { paymentInfo: { status: 'Paid' } },
            { user: '64b000000000000000000099' },
            { itemsPrice: 0, status: 'Shipped' }
        ]) {
            const res = makeResponse()
            await orderController.updateOrder({
                params: { id: '64b000000000000000000043' },
                body,
                user: { _id: userId, role: 'admin' }
            }, res)
            assert.equal(res.statusCode, 400)
        }
    } finally {
        Order.findById = originalFindById
    }
})
