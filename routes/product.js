const express = require('express');
const router = express.Router();
const upload = require("../utils/multer");

const {
    newProduct,
    getSingleProduct,
    getProducts,
    updateProduct,
    deleteProduct,
    getAdminProducts,
    createProductReview,
    getProductReviews,
    deleteReview,
    bulkDeleteProducts,
    restoreProducts,
    reviewEligibility,
    reviewOrderEligibility,

} = require('../controllers/product');
const { isAuthenticatedUser, authorizeRoles } = require('../middleware/auth')


router.post('/admin/product/new', isAuthenticatedUser, authorizeRoles('admin'), upload.array('images', 10), newProduct);
router.get('/product/:id', getSingleProduct)
router.get('/products', getProducts)
router.put('/admin/product/:id', isAuthenticatedUser, authorizeRoles('admin'), upload.array('images', 10), updateProduct);
router.delete('/admin/product/:id', isAuthenticatedUser, authorizeRoles('admin'), deleteProduct);
router.get('/review/eligibility/:productId', isAuthenticatedUser, reviewEligibility);
router.get('/review/eligibility/order/:orderId', isAuthenticatedUser, reviewOrderEligibility);
router.put('/admin/products/restore', isAuthenticatedUser, authorizeRoles('admin'), restoreProducts);
router.delete('/admin/products', isAuthenticatedUser, authorizeRoles('admin'), bulkDeleteProducts);
router.get('/admin/products', isAuthenticatedUser, authorizeRoles('admin'), getAdminProducts)
router.put('/review', isAuthenticatedUser, createProductReview);
router.get('/reviews', isAuthenticatedUser, getProductReviews)
router.delete('/reviews', isAuthenticatedUser, authorizeRoles('admin'), deleteReview)
module.exports = router;