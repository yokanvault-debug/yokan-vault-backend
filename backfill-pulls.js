// node backfill-pulls.js
// Gives blind-box pulls to orders that were placed BEFORE the pull counter existed
// (their items have pullsRemaining = 0). Safe to run more than once.
require('./utils/netFix')
require('dotenv').config({ path: './config/.env', quiet: true })
const mongoose = require('mongoose')
const Order = require('./models/order')
const Product = require('./models/product')
const PullLog = require('./models/pulllog')

;(async () => {
    await mongoose.connect(process.env.DB_URI || process.env.MONGODB_URI)
    let changed = 0
    const orders = await Order.find({ orderStatus: { $ne: 'Cancelled' } })
    for (const order of orders) {
        let dirty = false
        for (const item of order.orderItems) {
            const box = await Product.findById(item.product).select('isBlindBox')
            if (!box || !box.isBlindBox) continue
            const used = await PullLog.countDocuments({ order: order._id, box: box._id })
            const left = Math.max(Number(item.quantity) - used, 0)
            if (item.pullsRemaining !== left) { item.pullsRemaining = left; dirty = true }
        }
        if (dirty) { await order.save({ validateBeforeSave: false }); changed++ }
    }
    console.log(`Updated ${changed} order(s).`)
    process.exit(0)
})().catch((e) => { console.log('Failed:', e.message); process.exit(1) })
