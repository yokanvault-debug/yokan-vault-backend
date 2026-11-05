const express = require('express')
const router = express.Router();

const { cancelOrder, newOrder, orderQuote, downloadReceipt, productSales,
	myOrders,
	getSingleOrder,

	deleteOrder,
	allOrders,
	updateOrder,
	totalOrders,
	totalSales,
	customerSales,
	salesPerMonth,


} = require('../controllers/order')
const { isAuthenticatedUser, authorizeRoles } = require('../middleware/auth')

router.post('/order/new', isAuthenticatedUser, newOrder);
router.post('/order/quote', isAuthenticatedUser, orderQuote);
router.get('/orders/me', isAuthenticatedUser, myOrders);
router.put('/order/:id/cancel', isAuthenticatedUser, cancelOrder);
router.get('/order/:id', isAuthenticatedUser, getSingleOrder);
router.get('/order/:id/receipt', isAuthenticatedUser, downloadReceipt);
router.get('/admin/orders/', isAuthenticatedUser, authorizeRoles('admin'), allOrders);
// // router.route('/admin/order/:id').delete(isAuthenticatedUser, deleteOrder);
router.route('/admin/order/:id').put(isAuthenticatedUser, authorizeRoles('admin'), updateOrder).delete(isAuthenticatedUser, authorizeRoles('admin'), deleteOrder);
router.get('/admin/total-orders', isAuthenticatedUser, authorizeRoles('admin'), totalOrders);
router.get('/admin/total-sales', isAuthenticatedUser, authorizeRoles('admin'), totalSales);
router.get('/admin/product-sales', isAuthenticatedUser, authorizeRoles('admin'), productSales);
router.get('/admin/customer-sales', isAuthenticatedUser, authorizeRoles('admin'), customerSales);
router.get('/admin/sales-per-month', isAuthenticatedUser, authorizeRoles('admin'), salesPerMonth);
module.exports = router;