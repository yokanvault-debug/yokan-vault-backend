const express = require('express');
const router = express.Router();

const {
    pullBlindBox,
    getMyCollection,
} = require('../controllers/blindbox');
const { isAuthenticatedUser } = require('../middleware/auth')

router.get('/blindbox/collection', isAuthenticatedUser, getMyCollection);
router.post('/blindbox/:productId/pull', isAuthenticatedUser, pullBlindBox);

module.exports = router
