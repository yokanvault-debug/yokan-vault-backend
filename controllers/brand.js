const Brand = require('../models/brand')

exports.getBrands = async (req, res, next) => {
    const brands = await Brand.find().sort({ name: 1 });
    return res.status(200).json({
        success: true,
        count: brands.length,
        brands
    })
}

exports.newBrand = async (req, res, next) => {
    try {
        const brand = await Brand.create(req.body);
        return res.status(201).json({
            success: true,
            brand
        })
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.code === 11000 ? 'Brand already exists' : error.message
        })
    }
}

exports.updateBrand = async (req, res, next) => {
    let brand = await Brand.findById(req.params.id);
    if (!brand) {
        return res.status(404).json({
            success: false,
            message: 'Brand not found'
        })
    }
    try {
        brand = await Brand.findByIdAndUpdate(req.params.id, req.body, {
            returnDocument: 'after',
            runValidators: true
        })
        return res.status(200).json({
            success: true,
            brand
        })
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.code === 11000 ? 'Brand already exists' : error.message
        })
    }
}

exports.deleteBrand = async (req, res, next) => {
    const brand = await Brand.findByIdAndDelete(req.params.id);
    if (!brand) {
        return res.status(404).json({
            success: false,
            message: 'Brand not found'
        })
    }
    return res.status(200).json({
        success: true,
        message: 'Brand deleted'
    })
}
