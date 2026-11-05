const mongoose = require('mongoose')

const pullLogSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.ObjectId, ref: 'User', required: true },
    box: { type: mongoose.Schema.ObjectId, ref: 'Product', required: true },
    order: { type: mongoose.Schema.ObjectId, ref: 'Order', required: true },
    item: { type: mongoose.Schema.ObjectId, ref: 'Product', required: true },
    rarity: {
        type: String,
        enum: ['common', 'rare', 'epic', 'legendary'],
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
})

module.exports = mongoose.model('PullLog', pullLogSchema);
