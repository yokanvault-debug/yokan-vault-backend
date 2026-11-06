const Order = require('../models/order');
const Product = require('../models/product');
const User = require('../models/user');
const mongoose = require('mongoose');
const crypto = require('crypto')
const emailService = require('../utils/emailService');
const { createEmailHtml } = require('../utils/emailTemplate');
const { createOrderDetailsHtml } = require('../utils/orderEmail');
const buildReceipt = require('../utils/receipt');
const { PAID_ORDER_MATCH, isEligiblePaidOrder, parseDateRange, formatMonthLabel } = require('../utils/salesReports')

const roundCurrency = (amount) => Math.round((Number(amount) + Number.EPSILON) * 100) / 100


// Create a new order   =>  /api/v1/order/new
exports.newOrder = async (req, res, next) => {
    let order
    let orderItems = []
    try {
        const body = req.body || {}
        const checkoutKey = req.get('Idempotency-Key')
        if (typeof checkoutKey !== 'string' || !/^[a-zA-Z0-9._:-]{8,128}$/.test(checkoutKey)) {
            return res.status(400).json({ message: 'A valid checkout request key is required' })
        }

        const request = normalizeCheckoutRequest(body.orderItems, body.shippingInfo)
        const checkoutRequestHash = hashCheckoutRequest(request)
        const existingOrder = await selectCheckoutHash(Order.findOne({ user: req.user._id, checkoutKey }))
        if (existingOrder) {
            if (!checkoutMatches(existingOrder, request, checkoutRequestHash)) {
                return res.status(409).json({ message: 'This checkout key was already used for a different request.' })
            }
            return existingOrder.inventoryReserved === true
                ? res.status(200).json({ success: true, order: publicOrder(existingOrder) })
                : res.status(409).json({ message: 'This checkout request is still being processed. Please retry shortly.' })
        }

        const quote = await calculateNormalizedOrder(request)
        orderItems = quote.orderItems

        try {
            order = await Order.create({
                orderItems,
                shippingInfo: quote.shippingInfo,
                itemsPrice: quote.itemsPrice,
                taxPrice: quote.taxPrice,
                shippingPrice: quote.shippingPrice,
                totalPrice: quote.totalPrice,
                paymentInfo: { method: 'Cash on Delivery', status: 'Pending' },
                checkoutKey,
                checkoutRequestHash,
                inventoryReserved: false,
                user: req.user._id
            })
        } catch (error) {
            if (error.code === 11000) {
                const duplicate = await selectCheckoutHash(Order.findOne({ user: req.user._id, checkoutKey }))
                if (duplicate && !checkoutMatches(duplicate, request, checkoutRequestHash)) {
                    return res.status(409).json({ message: 'This checkout key was already used for a different request.' })
                }
                if (duplicate && duplicate.inventoryReserved === true) {
                    return res.status(200).json({ success: true, order: publicOrder(duplicate) })
                }
                if (duplicate) {
                    return res.status(409).json({ message: 'This checkout request is still being processed. Please retry shortly.' })
                }
                if (error.keyPattern?.checkoutKey || error.keyValue?.checkoutKey) {
                    return res.status(409).json({ message: 'This checkout key is already in use. Please retry checkout.' })
                }
            }
            throw error
        }

        for (const item of orderItems) {
            const reserved = await Product.findOneAndUpdate(
                {
                    _id: item.product,
                    deletedAt: null,
                    stock: { $gte: item.quantity, $mod: [1, 0] },
                    'inventoryReservations.order': { $ne: order._id }
                },
                {
                    $inc: { stock: -item.quantity },
                    $push: { inventoryReservations: { order: order._id, quantity: item.quantity } }
                },
                { returnDocument: 'after' }
            )
            if (!reserved) {
                const error = new Error('Insufficient stock')
                error.code = 'INSUFFICIENT_STOCK'
                throw error
            }
        }

        const completedOrder = await Order.findOneAndUpdate(
            { _id: order._id, inventoryReserved: false },
            { $set: { inventoryReserved: true } },
            { returnDocument: 'after' }
        )
        if (!completedOrder) throw new Error('Order reservation could not be finalized')
        const mail = await notifyCustomer(completedOrder, 'Processing', { confirmation: true, customer: req.user })
        return res.status(201).json({ success: true, order: publicOrder(completedOrder), ...mail })
    } catch (error) {
        if (order) {
            try {
                await restoreReservedInventory(order)
                await Order.findByIdAndDelete(order._id)
            } catch (rollbackError) {
                console.error('Order inventory rollback failed:', rollbackError.code || rollbackError.name || 'unknown error')
                return res.status(500).json({ message: 'Order could not be completed. Contact support before retrying.' })
            }
        }
        if (error.code === 'INSUFFICIENT_STOCK') {
            return res.status(409).json({ message: 'There is not enough stock to complete this order. Please update your cart.' })
        }
        if (error.statusCode) return res.status(error.statusCode).json({ message: error.message })
        console.error('Order creation failed:', error.code || error.name || 'unknown error')
        return res.status(500).json({ message: 'Order could not be completed. Please try again.' })
    }
}

exports.orderQuote = async (req, res) => {
    try {
        const body = req.body || {}
        const quote = await calculateOrder(body.orderItems, body.shippingInfo)
        return res.status(200).json({
            success: true,
            orderItems: quote.orderItems,
            itemsPrice: quote.itemsPrice,
            taxPrice: quote.taxPrice,
            shippingPrice: quote.shippingPrice,
            totalPrice: quote.totalPrice
        })
    } catch (error) {
        if (error.statusCode) return res.status(error.statusCode).json({ message: error.message })
        console.error('Order quote failed:', error.code || error.name || 'unknown error')
        return res.status(500).json({ message: 'Order totals could not be calculated. Please try again.' })
    }
}

function normalizeCheckoutRequest(rawItems, rawShippingInfo) {
    if (!Array.isArray(rawItems) || !rawItems.length || rawItems.length > 50) {
        throw Object.assign(new Error('Your cart is empty or contains too many items'), { statusCode: 400 })
    }
    const shippingInfo = validateShippingInfo(rawShippingInfo)
    const seenProducts = new Set()
    const items = []
    for (const item of rawItems) {
        if (!item || typeof item !== 'object' ||
            typeof item.product !== 'string' || !mongoose.isObjectIdOrHexString(item.product)) {
            throw Object.assign(new Error('Each cart item must include a valid product ID'), { statusCode: 400 })
        }
        const productId = String(item.product).toLowerCase()
        const quantity = item.quantity
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
            throw Object.assign(new Error('Item quantities must be whole numbers from 1 to 99'), { statusCode: 400 })
        }
        if (seenProducts.has(productId)) {
            throw Object.assign(new Error('The cart contains a duplicate product'), { statusCode: 400 })
        }
        seenProducts.add(productId)
        items.push({ product: productId, quantity })
    }

    return { items, shippingInfo }
}

function hashCheckoutRequest(request) {
    const canonical = {
        items: [...request.items].sort((a, b) => a.product.localeCompare(b.product)),
        shippingInfo: request.shippingInfo
    }
    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function checkoutMatches(order, request, requestHash) {
    if (order.checkoutRequestHash) return order.checkoutRequestHash === requestHash
    let existingShipping
    try {
        existingShipping = validateShippingInfo(order.shippingInfo)
    } catch (error) {
        return false
    }
    const existingItems = (order.orderItems || [])
        .map(item => ({ product: String(item.product).toLowerCase(), quantity: item.quantity }))
        .sort((a, b) => a.product.localeCompare(b.product))
    const requestItems = [...request.items].sort((a, b) => a.product.localeCompare(b.product))
    return JSON.stringify(existingShipping) === JSON.stringify(request.shippingInfo) &&
        JSON.stringify(existingItems) === JSON.stringify(requestItems)
}

function selectCheckoutHash(query) {
    return query && typeof query.select === 'function'
        ? query.select('+checkoutRequestHash')
        : query
}

function publicOrder(order) {
    const result = typeof order.toObject === 'function' ? order.toObject() : { ...order }
    delete result.checkoutRequestHash
    return result
}

async function calculateOrder(rawItems, rawShippingInfo) {
    return calculateNormalizedOrder(normalizeCheckoutRequest(rawItems, rawShippingInfo))
}

async function calculateNormalizedOrder(request) {
    const { items, shippingInfo } = request
    const quantities = new Map(items.map(item => [item.product, item.quantity]))
    const seenProducts = new Set(items.map(item => item.product))
    const products = await Product.find({
        _id: { $in: [...seenProducts] },
        deletedAt: null
    })
    const productsById = new Map(products.map(product => [String(product._id), product]))
    if (productsById.size !== seenProducts.size) {
        throw Object.assign(
            new Error('A product in your cart is no longer available. Please refresh your cart.'),
            { statusCode: 409 }
        )
    }

    let itemsCents = 0
    const orderItems = []
    for (const productId of seenProducts) {
        const product = productsById.get(productId)
        const quantity = quantities.get(productId)
        const price = Number(product.price)
        if (!Number.isFinite(price) || price < 0 || !Number.isInteger(product.stock) || product.stock < 0) {
            throw Object.assign(
                new Error('A product in your cart has invalid price or inventory information.'),
                { statusCode: 409 }
            )
        }
        if (product.stock < quantity) {
            throw Object.assign(
                new Error('There is not enough stock to complete this order. Please update your cart.'),
                { statusCode: 409 }
            )
        }
        const priceCents = Math.round((price + Number.EPSILON) * 100)
        if (!Number.isSafeInteger(priceCents) || !Number.isSafeInteger(priceCents * quantity)) {
            throw Object.assign(new Error('A product price is outside the supported range.'), { statusCode: 400 })
        }
        itemsCents += priceCents * quantity
        orderItems.push({
            name: product.name,
            quantity,
            image: (product.images && product.images[0] && product.images[0].url) || '/images/default-product.png',
            price: priceCents / 100,
            product: product._id,
            isBlindBox: Boolean(product.isBlindBox),
            pullsRemaining: product.isBlindBox ? quantity : 0,
        })
    }
    if (!Number.isSafeInteger(itemsCents)) {
        throw Object.assign(new Error('The order total is outside the supported range.'), { statusCode: 400 })
    }
    const shippingCents = itemsCents > 20000 ? 0 : 2500
    const taxCents = Math.round(itemsCents * 0.05)
    return {
        shippingInfo,
        orderItems,
        itemsPrice: itemsCents / 100,
        taxPrice: taxCents / 100,
        shippingPrice: shippingCents / 100,
        totalPrice: (itemsCents + taxCents + shippingCents) / 100
    }
}

function validateShippingInfo(shippingInfo) {
    const fields = {
        address: 200,
        city: 100,
        phoneNo: 30,
        postalCode: 20,
        country: 100
    }
    if (!shippingInfo || typeof shippingInfo !== 'object' || Array.isArray(shippingInfo)) {
        throw Object.assign(new Error('Shipping information is required'), { statusCode: 400 })
    }
    const validated = {}
    for (const [field, maxLength] of Object.entries(fields)) {
        const value = shippingInfo[field]
        if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
            throw Object.assign(new Error('Please provide valid shipping information'), { statusCode: 400 })
        }
        validated[field] = value.trim()
    }
    return validated
}

async function restoreReservedInventory(order, verifyProducts = false) {
    for (const item of order.orderItems) {
        const result = await Product.updateOne(
            { _id: item.product, 'inventoryReservations.order': order._id },
            {
                $inc: { stock: item.quantity },
                $pull: { inventoryReservations: { order: order._id } }
            }
        )
        if (verifyProducts && result.matchedCount === 0 && !(await Product.exists({ _id: item.product }))) {
            throw new Error('A reserved product is missing; inventory restoration requires reconciliation')
        }
    }
}

async function restoreCancelledOrderInventory(order) {
    if (order.inventoryReserved !== true || order.inventoryRestoredAt) return
    await restoreReservedInventory(order, true)
    const markedOrder = await Order.updateOne(
        { _id: order._id, orderStatus: 'Cancelled', inventoryRestoredAt: { $exists: false } },
        { $set: { inventoryRestoredAt: new Date() } },
    )
    if (markedOrder.matchedCount === 0) {
        const currentOrder = await Order.findById(order._id)
        if (!currentOrder || currentOrder.orderStatus !== 'Cancelled' || !currentOrder.inventoryRestoredAt) {
            throw new Error('Cancelled order inventory restoration could not be recorded')
        }
    }
}

function validateCancellationReason(reason) {
    if (typeof reason !== 'string' || !reason.trim()) {
        return new Error('A cancellation reason is required')
    }
    if (reason.trim().length > 500) {
        return new Error('Cancellation reason cannot exceed 500 characters')
    }
    return reason.trim()
}

async function clearOrderReservationMarkers(order) {
    for (const item of order.orderItems) {
        await Product.updateOne(
            { _id: item.product, 'inventoryReservations.order': order._id },
            { $pull: { inventoryReservations: { order: order._id } } }
        )
    }
}

function hasConsumedBlindBoxPull(order) {
    return order.orderItems.some(item => item.isBlindBox && item.pullsRemaining < item.quantity)
}

function getAllowedNextStatuses(status) {
    if (status === 'Processing') return ['Shipped', 'Cancelled']
    if (status === 'Shipped') return ['Delivered']
    return []
}

function hasInvalidOrderId(req, res) {
    if (mongoose.isObjectIdOrHexString(req.params.id)) return false
    res.status(400).json({ message: 'Invalid order ID' })
    return true
}

/*
 * The MongoDB update on each product document reserves stock atomically, so
 * concurrent checkouts cannot drive stock below zero without requiring a
 * replica-set transaction. The per-order marker makes compensation idempotent.
 */

exports.myOrders = async (req, res, next) => {
    const orders = await Order.find({ user: req.user.id, inventoryReserved: { $ne: false } })
    // console.log(req.user)
    res.status(200).json({
        success: true,
        orders
    })
}

exports.getSingleOrder = async (req, res, next) => {
    if (hasInvalidOrderId(req, res)) return
    let orderQuery = Order.findById(req.params.id).populate('user', 'name email')
    if (req.user.role === 'admin') {
        orderQuery = orderQuery.populate('cancelledBy', 'name username').populate('paidBy', 'name username')
    }
    const order = await orderQuery
    if (!order || order.inventoryReserved === false) {
        return res.status(404).json({ message: 'Order not found' })
    }
    if (req.user.role !== 'admin' && String((order.user && order.user._id) || order.user) !== String(req.user._id)) {
        return res.status(404).json({ message: 'Order not found' })
    }
    res.status(200).json({
        success: true,
        order
    })
}

exports.downloadReceipt = async (req, res) => {
    try {
        if (hasInvalidOrderId(req, res)) return
        const order = await Order.findById(req.params.id).populate('user', 'name email displayName')
        if (!order || order.inventoryReserved === false) {
            return res.status(404).json({ message: 'Order not found' })
        }
        const ownerId = order.user && order.user._id
        if (req.user.role !== 'admin' && String(ownerId || order.user) !== String(req.user._id)) {
            return res.status(404).json({ message: 'Order not found' })
        }
        const customer = order.user || { name: 'Customer unavailable', email: 'Unavailable' }
        const pdf = await buildReceipt(order, customer)
        res.setHeader('Content-Type', 'application/pdf')
        res.setHeader('Content-Disposition', `attachment; filename="receipt-${order._id}.pdf"`)
        return res.status(200).send(pdf)
    } catch (error) {
        console.error('Receipt generation failed:', error.code || error.name || 'unknown error')
        return res.status(500).json({ message: 'Receipt could not be generated. Please try again.' })
    }
}

exports.allOrders = async (req, res, next) => {
    const orders = await Order.find({ inventoryReserved: { $ne: false } })
    let totalAmountCents = 0;

    orders.forEach(order => {
        if (isEligiblePaidOrder(order)) {
            totalAmountCents += Math.round((Number(order.totalPrice) + Number.EPSILON) * 100)
        }
    })

    res.status(200).json({
        success: true,
        totalAmount: totalAmountCents / 100,
        orders
    })
}

exports.deleteOrder = async (req, res, next) => {
    if (hasInvalidOrderId(req, res)) return
    const order = await Order.findOneAndDelete({
        _id: req.params.id,
        $or: [
            { orderStatus: 'Delivered' },
            {
                orderStatus: 'Cancelled',
                $or: [
                    { inventoryReserved: { $ne: true } },
                    { inventoryRestoredAt: { $exists: true } }
                ]
            }
        ]
    })

    if (!order) {
        const existing = await Order.findById(req.params.id)
        return res.status(existing ? 409 : 404).json({
            message: existing ? 'Only delivered or cancelled orders can be deleted' : 'No order found with this ID'
        })
    }
    return res.status(200).json({
        success: true
    })
}

// email the customer: item list, subtotals, grand total + PDF receipt
const notifyCustomer = async (order, newStatus, { confirmation = false, customer: orderCustomer } = {}) => {
    let emailSent = false, emailError
    try {
        const customer = orderCustomer || await User.findById(order.user)
        if (!customer?.email) {
            emailError = confirmation
                ? 'Order was created, but the customer email address is unavailable.'
                : 'Order status was updated, but the customer email address is unavailable.'
        } else {
            const money = (n) => `PHP ${Number(n || 0).toFixed(2)}`
            const customerName = customer.name || customer.displayName || ''
            const html = createEmailHtml({
                preheader: confirmation ? 'We received your Yokan Vault order.' : `Your Yokan Vault order status is ${newStatus}.`,
                title: confirmation ? 'Order confirmation' : 'Order update',
                greeting: customerName ? `Hello ${customerName},` : 'Hello,',
                paragraphs: confirmation
                    ? [`Thank you for your order. Order ${order._id} is confirmed and is being prepared.`, 'Your receipt is attached as a PDF.']
                    : [`Your order ${order._id} is now ${newStatus}.`, 'Your receipt is attached as a PDF.'],
                contentHtml: createOrderDetailsHtml(order),
            })
            const pdf = await buildReceipt(order, customer)
            await emailService.sendMail({
                to: customer.email,
                subject: confirmation ? `Yokan Vault order confirmation ${order._id}` : `Yokan Vault order ${newStatus}`,
                text: confirmation
                    ? `Thank you for your order. Order ${order._id} is confirmed. Grand total: ${money(order.totalPrice)}`
                    : `Your order ${order._id} is now ${newStatus}. Grand total: ${money(order.totalPrice)}`,
                html,
                attachments: [{ filename: `receipt-${order._id}.pdf`, content: pdf, contentType: 'application/pdf' }]
            })
            emailSent = true
        }
    } catch (error) {
        console.error('Order email failed:', error.code || error.name || 'unknown error', error.message)
        emailError = confirmation
            ? 'Order was created, but email delivery failed.'
            : 'Order status was updated, but email delivery failed.'
    }
    return { emailSent, emailError }
}

const isCashOnDeliveryOrder = (order) => (
    order.paymentInfo?.method === 'Cash on Delivery' ||
    order.paymentInfo?.status === 'Cash on Delivery' ||
    String(order.paymentInfo?.id || '').startsWith('COD-')
)

// Administrators may advance an order or confirm COD collection.
exports.updateOrder = async (req, res, next) => {
    try {
        if (hasInvalidOrderId(req, res)) return
        const fields = req.body || {}
        const allowedFields = new Set(['status', 'paymentStatus', 'cancellationReason'])
        if (!Object.keys(fields).length || Object.keys(fields).some(field => !allowedFields.has(field))) {
            return res.status(400).json({ message: 'Only order status, cancellation reason, and payment collection status can be updated' })
        }
        if (fields.status !== undefined && !['Processing', 'Shipped', 'Delivered', 'Cancelled'].includes(fields.status)) {
            return res.status(400).json({ message: 'Choose a valid status' })
        }
        if (fields.paymentStatus !== undefined && fields.paymentStatus !== 'Paid') {
            return res.status(400).json({ message: 'Payment can only be marked as collected' })
        }
        if (fields.cancellationReason !== undefined && fields.status !== 'Cancelled') {
            return res.status(400).json({ message: 'A cancellation reason can only be provided when cancelling an order' })
        }
        const cancellationReason = fields.status === 'Cancelled'
            ? validateCancellationReason(fields.cancellationReason)
            : null
        if (cancellationReason instanceof Error) {
            return res.status(400).json({ message: cancellationReason.message })
        }

        const order = await Order.findById(req.params.id)
        if (!order) return res.status(404).json({ message: 'Order not found' })
        if (fields.paymentStatus === 'Paid' && !isCashOnDeliveryOrder(order)) {
            return res.status(400).json({ message: 'Only Cash on Delivery orders can be marked as collected' })
        }
        const nextStatus = fields.status || order.orderStatus
        const statusChanged = nextStatus !== order.orderStatus
        if (order.orderStatus === 'Cancelled' && nextStatus === 'Cancelled') {
            if (fields.paymentStatus !== undefined) {
                return res.status(400).json({ message: 'A cancelled order cannot be marked as paid' })
            }
            await restoreCancelledOrderInventory(order)
            return res.status(200).json({ success: true, orderStatus: 'Cancelled' })
        }
        if (!statusChanged && fields.status !== undefined && fields.paymentStatus === undefined) {
            if (nextStatus === 'Shipped') {
                await clearOrderReservationMarkers(order)
                return res.status(200).json({ success: true, orderStatus: 'Shipped' })
            }
            return res.status(400).json({ message: `This order is already ${nextStatus.toLowerCase()}` })
        }
        if (statusChanged && !getAllowedNextStatuses(order.orderStatus).includes(nextStatus)) {
            return res.status(400).json({ message: `An order that is ${order.orderStatus.toLowerCase()} cannot move to ${nextStatus.toLowerCase()}` })
        }
        if (nextStatus === 'Cancelled' && hasConsumedBlindBoxPull(order)) {
            return res.status(409).json({ message: 'An order cannot be cancelled after a blind-box pull has been used' })
        }
        if (nextStatus === 'Cancelled' && order.paymentInfo?.status === 'Paid') {
            return res.status(409).json({ message: 'A paid order cannot be cancelled' })
        }
        if (fields.paymentStatus === 'Paid' &&
            (order.orderStatus !== 'Delivered' || nextStatus !== 'Delivered')) {
            return res.status(400).json({ message: 'Cash on Delivery can only be marked collected for a delivered order' })
        }
        if (fields.paymentStatus === 'Paid' && order.paymentInfo?.status === 'Paid' && !statusChanged) {
            return res.status(200).json({ success: true, orderStatus: order.orderStatus, paymentStatus: 'Paid', paidAt: order.paidAt, paidBy: order.paidBy })
        }
        const updates = {}
        if (statusChanged) {
            updates.orderStatus = nextStatus
            if (nextStatus === 'Delivered') updates.deliveredAt = new Date()
            if (nextStatus === 'Cancelled') {
                updates.cancellationReason = cancellationReason
                updates.cancelledAt = new Date()
                updates.cancelledBy = req.user._id
                updates.cancelledByRole = req.user.role
            }
        }
        if (fields.paymentStatus === 'Paid') {
            updates['paymentInfo.status'] = 'Paid'
            updates.paidAt = new Date()
            updates.paidBy = req.user._id
        }
        const updateFilter = { _id: order._id, orderStatus: order.orderStatus }
        if (fields.paymentStatus === 'Paid') {
            updateFilter['paymentInfo.status'] = order.paymentInfo?.status === undefined
                ? { $exists: false }
                : order.paymentInfo.status
        } else if (nextStatus === 'Cancelled') {
            updateFilter['paymentInfo.status'] = { $ne: 'Paid' }
        }
        const updatedOrder = await Order.findOneAndUpdate(
            updateFilter,
            { $set: updates },
            { returnDocument: 'after', runValidators: true }
        )
        if (!updatedOrder) {
            const latestOrder = await Order.findById(order._id)
            if (fields.paymentStatus === 'Paid' &&
                latestOrder?.orderStatus === nextStatus &&
                latestOrder.paymentInfo?.status === 'Paid') {
                return res.status(200).json({
                    success: true,
                    orderStatus: latestOrder.orderStatus,
                    paymentStatus: 'Paid'
                })
            }
            if (nextStatus === 'Cancelled' && latestOrder?.orderStatus === 'Cancelled' &&
                fields.paymentStatus === undefined) {
                await restoreCancelledOrderInventory(latestOrder)
                return res.status(200).json({ success: true, orderStatus: 'Cancelled' })
            }
            return res.status(409).json({ message: 'This order changed before the update completed. Refresh and try again.' })
        }

        if (nextStatus === 'Cancelled') {
            await restoreCancelledOrderInventory(updatedOrder)
        } else if (nextStatus === 'Shipped') {
            await clearOrderReservationMarkers(updatedOrder)
        }

        const mail = statusChanged ? await notifyCustomer(updatedOrder, nextStatus) : {}
        return res.status(200).json({
            success: true,
            orderStatus: updatedOrder.orderStatus,
            paymentStatus: updatedOrder.paymentInfo?.status,
            paidAt: updatedOrder.paidAt,
            paidBy: updatedOrder.paidBy,
            ...mail
        })
    } catch (error) {
        console.error('Order update failed:', error.code || error.name || 'unknown error')
        return res.status(500).json({ message: 'Order could not be updated. Please refresh and try again.' })
    }
}

// Customers can cancel while Processing; repeated requests safely resume any incomplete restoration.
exports.cancelOrder = async (req, res, next) => {
    try {
        if (hasInvalidOrderId(req, res)) return
        const cancellationReason = validateCancellationReason(req.body?.reason)
        if (cancellationReason instanceof Error) {
            return res.status(400).json({ message: cancellationReason.message })
        }
        const order = await Order.findById(req.params.id)
        if (!order || String(order.user) !== String(req.user._id)) {
            return res.status(404).json({ message: 'Order not found' })
        }
        if (order.orderStatus === 'Cancelled') {
            await restoreCancelledOrderInventory(order)
            return res.status(400).json({ message: 'This order has already been cancelled' })
        }
        if (order.orderStatus !== 'Processing') {
            return res.status(400).json({ message: `An order that is ${order.orderStatus.toLowerCase()} can no longer be cancelled` })
        }
        if (order.paymentInfo?.status === 'Paid') {
            return res.status(409).json({ message: 'A paid order cannot be cancelled' })
        }
        if (hasConsumedBlindBoxPull(order)) {
            return res.status(409).json({ message: 'An order cannot be cancelled after a blind-box pull has been used' })
        }
        const cancelledOrder = await Order.findOneAndUpdate(
            {
                _id: order._id,
                user: req.user._id,
                orderStatus: 'Processing',
                'paymentInfo.status': { $ne: 'Paid' }
            },
            {
                $set: {
                    orderStatus: 'Cancelled',
                    cancellationReason,
                    cancelledAt: new Date(),
                    cancelledBy: req.user._id,
                    cancelledByRole: req.user.role
                }
            },
            { returnDocument: 'after', runValidators: true }
        )
        if (!cancelledOrder) {
            return res.status(409).json({ message: 'This order changed before cancellation completed. Refresh and try again.' })
        }

        await restoreCancelledOrderInventory(cancelledOrder)
        const mail = await notifyCustomer(cancelledOrder, 'Cancelled')
        return res.status(200).json({ success: true, orderStatus: 'Cancelled', ...mail })
    } catch (error) {
        console.error('Order cancellation failed:', error.code || error.name || 'unknown error')
        return res.status(500).json({ message: 'Order cancellation could not be completed. Please retry.' })
    }
}

exports.totalOrders = async (req, res, next) => {
    const totalOrders = await Order.aggregate([
        { $match: { inventoryReserved: { $ne: false } } },
        {
            $group: {
                _id: null,
                count: { $sum: 1 }
            }
        }
    ])
    if (!totalOrders) {
        return res.status(404).json({
            message: 'error total orders',
        })
    }
    res.status(200).json({
        success: true,
        totalOrders
    })

}

exports.totalSales = async (req, res, next) => {
    const totalSales = await Order.aggregate([
        { $match: PAID_ORDER_MATCH },
        {
            $group: {
                _id: null,
                totalSales: { $sum: "$totalPrice" }
            }
        }
    ])
    if (!totalSales) {
        return res.status(404).json({
            message: 'error total sales',
        })
    }
    const roundedSales = totalSales.map((row) => ({
        ...row,
        totalSales: roundCurrency(row.totalSales)
    }))
    res.status(200).json({
        success: true,
        totalSales: roundedSales
    })
}

exports.productSales = async (req, res, next) => {
    const products = await Order.aggregate([
        { $match: PAID_ORDER_MATCH },
        { $unwind: '$orderItems' },
        {
            $group: {
                _id: '$orderItems.product',
                name: { $first: '$orderItems.name' },
                total: { $sum: { $multiply: ['$orderItems.price', '$orderItems.quantity'] } },
                quantity: { $sum: '$orderItems.quantity' }
            }
        },
        { $sort: { total: -1, _id: 1 } }
    ])
    const roundedProducts = products.map((product) => ({
        ...product,
        total: roundCurrency(product.total)
    }))
    const itemsSubtotalCents = roundedProducts.reduce((sum, product) =>
        sum + Math.round(product.total * 100), 0)
    const itemsSubtotal = itemsSubtotalCents / 100
    const totalPercentage = roundedProducts.map((product) => ({
        name: product.name,
        total: product.total,
        quantity: product.quantity,
        percent: itemsSubtotal > 0 ? Number((product.total / itemsSubtotal * 100).toFixed(2)) : 0
    }))
    return res.status(200).json({ success: true, itemsSubtotal, totalPercentage })
}

exports.customerSales = async (req, res, next) => {
    const customerSales = await Order.aggregate([
        { $match: PAID_ORDER_MATCH },
        {
            $lookup: {
                from: 'users',
                localField: 'user',
                foreignField: '_id',
                as: 'userDetails'
            },
        },
        {
            $group: {
                _id: "$user",
                total: { $sum: "$totalPrice" },
                orderCount: { $sum: 1 },
                userDetails: { $first: "$userDetails" }
            }
        },
        {
            $project: {
                _id: 0,
                userId: '$_id',
                userDetails: {
                    name: {
                        $ifNull: [
                            { $arrayElemAt: ['$userDetails.name', 0] },
                            'Customer unavailable'
                        ]
                    }
                },
                orderCount: true,
                total: true,
            }
        },
        { $sort: { total: -1, userId: 1 } },

    ])
    if (!customerSales) {
        return res.status(404).json({
            message: 'error customer sales',
        })


    }
    // return console.log(customerSales)
    const roundedCustomerSales = customerSales.map((entry) => ({
        ...entry,
        total: roundCurrency(entry.total)
    }))
    res.status(200).json({
        success: true,
        customerSales: roundedCustomerSales
    })

}

exports.salesPerMonth = async (req, res, next) => {
    let range
    try {
        range = parseDateRange(req.query)
    } catch (error) {
        return res.status(error.statusCode || 400).json({ message: error.message })
    }
    const salesPerMonth = await Order.aggregate([
        {
            $match: {
                ...PAID_ORDER_MATCH,
                paidAt: { $type: 'date', ...range }
            }
        },
        {
            $group: {
                _id: {
                    year: { $year: { date: '$paidAt', timezone: 'UTC' } },
                    month: { $month: { date: '$paidAt', timezone: 'UTC' } }
                },
                total: { $sum: "$totalPrice" },
            },
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } }
    ])
    const chronologicalSales = salesPerMonth
        .sort((a, b) => a._id.year - b._id.year || a._id.month - b._id.month)
        .map(({ _id, total }) => ({
            year: _id.year,
            monthNumber: _id.month,
            month: formatMonthLabel(_id.year, _id.month),
            total: roundCurrency(total)
        }))
    res.status(200).json({
        success: true,
        salesPerMonth: chronologicalSales
    })

}