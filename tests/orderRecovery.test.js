const test = require('node:test')
const assert = require('node:assert/strict')
const Order = require('../models/order')
const Product = require('../models/product')
const orderController = require('../controllers/order')
const buildReceipt = require('../utils/receipt')
const { createEmailHtml, escapeHtml } = require('../utils/emailTemplate')
const { getInlineLogoAttachment } = require('../utils/emailService')
const { createOrderDetailsHtml, imageUrlForEmail } = require('../utils/orderEmail')

const productId = '64b000000000000000000001'

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

test('order quote uses current product prices, not client price or totals', async () => {
    const originalFind = Product.find
    Product.find = async () => [{
        _id: productId,
        name: 'Collector card',
        price: 40.25,
        stock: 5,
        images: [{ url: '/card.png' }],
        isBlindBox: false
    }]
    try {
        const response = makeResponse()
        await orderController.orderQuote({
            body: {
                orderItems: [{ product: productId, quantity: 2, price: 0 }],
                shippingInfo: {
                    address: '1 Test Street',
                    city: 'Test City',
                    phoneNo: '0000000000',
                    postalCode: '0000',
                    country: 'Test'
                },
                totalPrice: 1
            }
        }, response)
        assert.equal(response.statusCode, 200)
        assert.equal(response.body.itemsPrice, 80.5)
        assert.equal(response.body.taxPrice, 4.03)
        assert.equal(response.body.shippingPrice, 25)
        assert.equal(response.body.totalPrice, 109.53)
        assert.equal(response.body.orderItems[0].price, 40.25)
    } finally {
        Product.find = originalFind
    }
})

test('processing orders cannot transition directly to delivered', async () => {
    const originalFindById = Order.findById
    const originalFindOneAndUpdate = Order.findOneAndUpdate
    Order.findById = async () => ({
        _id: '64b000000000000000000002',
        orderStatus: 'Processing',
        paymentInfo: { method: 'Cash on Delivery', status: 'Pending' },
        orderItems: []
    })
    Order.findOneAndUpdate = async () => {
        throw new Error('Invalid transition must not update the order')
    }
    try {
        const response = makeResponse()
        await orderController.updateOrder({
            params: { id: '64b000000000000000000002' },
            body: { status: 'Delivered' }
        }, response)
        assert.equal(response.statusCode, 400)
        assert.match(response.body.message, /cannot move to delivered/)
    } finally {
        Order.findById = originalFindById
        Order.findOneAndUpdate = originalFindOneAndUpdate
    }
})

test('COD collection is only accepted after delivery and records paidAt', async () => {
    const originalFindById = Order.findById
    const originalFindOneAndUpdate = Order.findOneAndUpdate
    const order = {
        _id: '64b000000000000000000003',
        orderStatus: 'Delivered',
        paymentInfo: { method: 'Cash on Delivery', status: 'Pending' },
        orderItems: []
    }
    let update
    Order.findById = async () => order
    Order.findOneAndUpdate = async (_filter, updateDocument) => {
        update = updateDocument
        return {
            ...order,
            paymentInfo: { ...order.paymentInfo, status: updateDocument.$set['paymentInfo.status'] },
            paidAt: updateDocument.$set.paidAt
        }
    }
    try {
        const response = makeResponse()
        await orderController.updateOrder({
            params: { id: order._id },
            user: { _id: '64b000000000000000000099', role: 'admin' },
            body: { paymentStatus: 'Paid' }
        }, response)
        assert.equal(response.statusCode, 200)
        assert.equal(response.body.paymentStatus, 'Paid')
        assert.ok(update.$set.paidAt instanceof Date)
        assert.equal(update.$set.paidBy, '64b000000000000000000099')
    } finally {
        Order.findById = originalFindById
        Order.findOneAndUpdate = originalFindOneAndUpdate
    }
})

test('COD collection is rejected before delivery', async () => {
    const originalFindById = Order.findById
    const originalFindOneAndUpdate = Order.findOneAndUpdate
    Order.findById = async () => ({
        _id: '64b000000000000000000004',
        orderStatus: 'Shipped',
        paymentInfo: { method: 'Cash on Delivery', status: 'Pending' },
        orderItems: []
    })
    Order.findOneAndUpdate = async () => {
        throw new Error('Payment must not be updated before delivery')
    }
    try {
        const response = makeResponse()
        await orderController.updateOrder({
            params: { id: '64b000000000000000000004' },
            body: { paymentStatus: 'Paid' }
        }, response)
        assert.equal(response.statusCode, 400)
        assert.match(response.body.message, /only be marked collected for a delivered order/)
    } finally {
        Order.findById = originalFindById
        Order.findOneAndUpdate = originalFindOneAndUpdate
    }
})

test('checkout key index is unique per user and partial for legacy orders', () => {
    const index = Order.schema.indexes().find(([keys]) => keys.user === 1 && keys.checkoutKey === 1)
    assert.ok(index)
    assert.equal(index[1].unique, true)
    assert.deepEqual(index[1].partialFilterExpression, { checkoutKey: { $type: 'string' } })
})

test('receipt creates a readable PDF and email content escapes user-provided text', async () => {
    const pdf = await buildReceipt({
        _id: '64b000000000000000000005',
        orderStatus: 'Delivered',
        paymentInfo: { method: 'Cash on Delivery', status: 'Pending' },
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
        orderItems: [{ name: 'Collector card', quantity: 2, price: 40.25 }],
        itemsPrice: 80.5,
        shippingPrice: 25,
        taxPrice: 4.03,
        totalPrice: 109.53
    }, { name: 'Test customer', email: 'test@example.invalid' })
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
    assert.equal(escapeHtml('<script>&'), '&lt;script&gt;&amp;')
    assert.match(createEmailHtml({ title: '<title>', paragraphs: ['<body>'] }), /&lt;title&gt;/)
    assert.doesNotMatch(createEmailHtml({ title: '<title>', paragraphs: ['<body>'] }), /<body>/)
})

test('shared email template uses the storefront palette and a simple responsive layout', () => {
    const html = createEmailHtml({
        preheader: 'A short preview',
        title: 'Verify your email',
        greeting: 'Hello <Collector>',
        paragraphs: ['Please verify your account.'],
        action: { label: 'Verify email', url: 'https://example.invalid/verify?name="A"' }
    })

    assert.match(html, /background:#f8fcff/)
    assert.match(html, /background:#435266/)
    assert.match(html, /background:#c4a47c/)
    assert.match(html, /max-width:600px/)
    assert.match(html, /src="cid:yokan-vault-logo"/)
    assert.match(html, /Verify email/)
    assert.match(html, /Hello &lt;Collector&gt;/)
    assert.match(html, /&quot;A&quot;/)
    assert.doesNotMatch(html, /#a855f7|#06b6d4|font-size:28px/)
})

test('email logo is attached inline from the frontend logo asset', () => {
    const logo = getInlineLogoAttachment()
    assert.equal(logo.filename, 'yokan-logo.png')
    assert.equal(logo.cid, 'yokan-vault-logo')
    assert.equal(logo.contentType, 'image/png')
    assert.equal(logo.contentDisposition, 'inline')
    assert.ok(Buffer.isBuffer(logo.content))
    assert.ok(logo.content.length > 0)
})

test('order email includes safe product images, prices, and shipping details', () => {
    const storefront = 'https://shop.example.invalid'
    const content = createOrderDetailsHtml({
        orderItems: [{
            name: '<Collector card>',
            image: 'https://res.cloudinary.com/demo/image/upload/card.png',
            quantity: 2,
            price: 40
        }],
        itemsPrice: 80,
        shippingPrice: 25,
        taxPrice: 4,
        totalPrice: 109,
        paymentInfo: { method: 'Cash on Delivery' },
        shippingInfo: {
            address: '<1 Test Street>',
            city: 'Test City',
            postalCode: '0000',
            country: 'Test',
            phoneNo: '0000000000'
        }
    })

    assert.match(content, /https:\/\/res\.cloudinary\.com\/demo\/image\/upload\/card\.png/)
    assert.match(content, /&lt;Collector card&gt;/)
    assert.match(content, /Subtotal/)
    assert.match(content, /PHP 80\.00/)
    assert.match(content, /Cash on Delivery/)
    assert.match(content, /&lt;1 Test Street&gt;/)
    assert.equal(imageUrlForEmail('javascript:alert(1)', storefront), `${storefront}/images/default-product.png`)
})
