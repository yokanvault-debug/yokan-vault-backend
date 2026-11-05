const mongoose = require('mongoose')

const brandSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Please enter brand name'],
        unique: true,
        trim: true,
        maxLength: [100, 'Brand name cannot exceed 100 characters']
    },
    description: {
        type: String,
        default: ''
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
})

module.exports = mongoose.model('Brand', brandSchema);
