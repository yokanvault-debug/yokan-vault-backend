const express = require('express');
const router = express.Router();

const {
    getBrands,
    newBrand,
    updateBrand,
    deleteBrand,
} = require('../controllers/brand');
const { isAuthenticatedUser, authorizeRoles } = require('../middleware/auth')

router.get('/brands', getBrands);
router.post('/admin/brand/new', isAuthenticatedUser, authorizeRoles('admin'), newBrand);
router.route('/admin/brand/:id')
    .put(isAuthenticatedUser, authorizeRoles('admin'), updateBrand)
    .delete(isAuthenticatedUser, authorizeRoles('admin'), deleteBrand);

module.exports = router
