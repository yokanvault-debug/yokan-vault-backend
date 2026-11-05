const mongoose = require('mongoose')

const orderSchema = mongoose.Schema({
    shippingInfo: {
        address: {
            type: String,
            required: true
        },
        city: {
            type: String,
            required: true
        },
        phoneNo: {
            type: String,
            required: true
        },
        postalCode: {
            type: String,
            required: true
        },
        country: {
            type: String,
            required: true
        }
    },
    user: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        ref: 'User'
    },
    orderItems: [
        {
            name: {
                type: String,
                required: true
            },
            quantity: {
                type: Number,
                required: true,
                min: 1,
                max: 99,
                validate: {
                    validator: Number.isInteger,
                    message: 'Order item quantity must be a whole number'
                }
            },
            image: {
                type: String,
                required: true
            },
            price: {
                type: Number,
                required: true,
                min: 0
            },
            product: {
                type: mongoose.Schema.Types.ObjectId,
                required: true,
                ref: 'Product'
            },
            pullsRemaining: {
                type: Number,
                default: 0
            },
            isBlindBox: {
                type: Boolean,
                default: false
            }
        }
    ],
    paymentInfo: {
        id: {
            type: String
        },
        method: {
            type: String,
            enum: ['Cash on Delivery']
        },
        status: {
            type: String,
            enum: ['Pending', 'Paid', 'Cash on Delivery'],
            default: 'Pending'
        }
    },
    checkoutKey: {
        type: String
    },
    checkoutRequestHash: {
        type: String,
        select: false
    },
    inventoryReserved: {
        type: Boolean
    },
    inventoryRestoredAt: {
        type: Date
    },
    cancellationReason: {
        type: String,
        trim: true,
        maxlength: 500
    },
    cancelledAt: {
        type: Date
    },
    cancelledBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    cancelledByRole: {
        type: String,
        enum: ['user', 'admin']
    },
    paidAt: {
        type: Date
    },
    paidBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },

    itemsPrice: {
        type: Number,
        required: true,
        min: 0,
        default: 0.0
    },
    taxPrice: {
        type: Number,
        required: true,
        min: 0,
        default: 0.0
    },
    shippingPrice: {
        type: Number,
        required: true,
        min: 0,
        default: 0.0
    },
    totalPrice: {
        type: Number,
        required: true,
        min: 0,
        default: 0.0
    },
    orderStatus: {
        type: String,
        required: true,
        enum: ['Processing', 'Shipped', 'Delivered', 'Cancelled'],
        default: 'Processing'
    },
    deliveredAt: {
        type: Date
    },
    createdAt: {
        type: Date,
        default: Date.now
    }

})

orderSchema.index(
    { user: 1, checkoutKey: 1 },
    {
        unique: true,
        partialFilterExpression: { checkoutKey: { $type: 'string' } },
        name: 'user_checkoutKey_unique'
    }
)

module.exports = mongoose.model('Order', orderSchema)