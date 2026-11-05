const Category = require('../models/category')

exports.getCategories = async (req, res, next) => {
    const categories = await Category.find().sort({ name: 1 });
    return res.status(200).json({
        success: true,
        count: categories.length,
        categories
    })
}

exports.newCategory = async (req, res, next) => {
    try {
        const category = await Category.create(req.body);
        return res.status(201).json({
            success: true,
            category
        })
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.code === 11000 ? 'Category already exists' : error.message
        })
    }
}

exports.updateCategory = async (req, res, next) => {
    let category = await Category.findById(req.params.id);
    if (!category) {
        return res.status(404).json({
            success: false,
            message: 'Category not found'
        })
    }
    try {
        category = await Category.findByIdAndUpdate(req.params.id, req.body, {
            new: true,
            runValidators: true
        })
        return res.status(200).json({
            success: true,
            category
        })
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.code === 11000 ? 'Category already exists' : error.message
        })
    }
}

exports.deleteCategory = async (req, res, next) => {
    const category = await Category.findByIdAndDelete(req.params.id);
    if (!category) {
        return res.status(404).json({
            success: false,
            message: 'Category not found'
        })
    }
    return res.status(200).json({
        success: true,
        message: 'Category deleted'
    })
}
