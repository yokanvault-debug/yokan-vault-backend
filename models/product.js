const mongoose = require('mongoose')

const productSchema = new mongoose.Schema({
    deletedAt: {
        type: Date,
        default: null
    },
    name: {
        type: String,
        required: [true, 'Please enter product name'],
        trim: true,
        maxLength: [100, 'Product name cannot exceed 100 characters']
    },
    price: {
        type: Number,
        required: [true, 'Please enter product price'],
        min: [0, 'Product price cannot be negative'],
        maxLength: [5, 'Product name cannot exceed 5 characters'],
        default: 0.0
    },
    description: {
        type: String,
        required: [true, 'Please enter product description'],
    },
    ratings: {
        type: Number,
        default: 0
    },

    images: [
        {
            public_id: {
                type: String,
                required: true
            },
            url: {
                type: String,
                required: true
            },
        }
    ],
    category: {
        type: String,
        required: [true, 'Please select category for this product']
    },
    brand: {
        type: String,
        default: ''
    },
    rarity: {
        type: String,
        enum: {
            values: ['common', 'rare', 'epic', 'legendary'],
            message: 'Please select correct rarity for product'
        },
        default: 'common'
    },
    series: {
        type: String,
        trim: true,
        default: ''
    },
    isBlindBox: {
        type: Boolean,
        default: false
    },
    dropRate: {
        type: Number,
        min: 0,
        max: 100,
        default: 0
    },
    pullOdds: [
        {
            _id: false,
            rarity: {
                type: String,
                enum: ['common', 'rare', 'epic', 'legendary'],
                required: true
            },
            probability: {
                type: Number,
                min: 0,
                max: 100,
                required: true
            }
        }
    ],
    seller: {
        type: String,
        required: [true, 'Please enter product seller']
    },
    stock: {
        type: Number,
        required: [true, 'Please enter product stock'],
        min: [0, 'Product stock cannot be negative'],
        validate: {
            validator: Number.isInteger,
            message: 'Product stock must be a whole number'
        },
        maxLength: [5, 'Product name cannot exceed 5 characters'],
        default: 0
    },
    inventoryReservations: [
        {
            _id: false,
            order: {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'Order',
                required: true
            },
            quantity: {
                type: Number,
                required: true,
                min: 1
            }
        }
    ],
    numOfReviews: {
        type: Number,
        default: 0
    },
    reviews: [
        {
            user: {
                type: mongoose.Schema.ObjectId,
                ref: 'User',
                required: true
            },
            name: {
                type: String,
                required: true
            },
            rating: {
                type: Number,
                required: true,
                min: 1,
                max: 5,
                validate: {
                    validator: Number.isInteger,
                    message: 'Review rating must be a whole number'
                }
            },
            comment: {
                type: String,
                required: true,
                trim: true,
                maxlength: 500
            },
            originalComment: {
                type: String,
                maxlength: 500,
                select: false
            },
            order: {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'Order'
            }
        }
    ],
    user: {
        type: mongoose.Schema.ObjectId,
        ref: 'User',
    },
    // numOfReviews: {
    //     type: Number,
    //     default: 0
    // },
    // reviews: [
    //     {
    //         user: {
    //             type: mongoose.Schema.ObjectId,
    //             ref: 'User',
    //             required: true
    //         },
    //         name: {
    //             type: String,
    //             required: true
    //         },
    //         rating: {
    //             type: Number,
    //             required: true
    //         },
    //         comment: {
    //             type: String,
    //             required: true
    //         }
    //     }
    // ],
    // user: {
    //     type: mongoose.Schema.ObjectId,
    //     ref: 'User',

    // },
    createdAt: {
        type: Date,
        default: Date.now
    }
})

productSchema.pre('validate', function () {
    if (this.isBlindBox && !this.series) {
        this.invalidate('series', 'Blind boxes must be associated with a collectible series.')
    }
    if (this.isBlindBox && this.pullOdds && this.pullOdds.length) {
        const total = this.pullOdds.reduce((acc, entry) => acc + entry.probability, 0)
        if (Math.abs(total - 100) > 0.01) {
            this.invalidate('pullOdds', 'Blind box rarity probabilities must total 100%.')
        }
    }
})

module.exports = mongoose.model('Product', productSchema);