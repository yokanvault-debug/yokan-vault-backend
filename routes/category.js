const express = require('express');
const router = express.Router();

const {
    getCategories,
    newCategory,
    updateCategory,
    deleteCategory,
} = require('../controllers/category');
const { isAuthenticatedUser, authorizeRoles } = require('../middleware/auth')

router.get('/categories', getCategories);
router.post('/admin/category/new', isAuthenticatedUser, authorizeRoles('admin'), newCategory);
router.route('/admin/category/:id')
    .put(isAuthenticatedUser, authorizeRoles('admin'), updateCategory)
    .delete(isAuthenticatedUser, authorizeRoles('admin'), deleteCategory);

module.exports = router
