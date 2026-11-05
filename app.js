const express = require('express');
const mongoose = require('mongoose');
const app = express();
const cors = require('cors')
const cookieParser = require('cookie-parser')
const getTrustedOrigins = require('./utils/trustedOrigins')
const { createCsrfProtection } = require('./middleware/csrf')
const products = require('./routes/product');
const auth = require('./routes/auth');
const order = require('./routes/order');
const brand = require('./routes/brand');
const category = require('./routes/category');
const blindbox = require('./routes/blindbox');
const firebaseauth = require('./routes/firebaseauth');

const trustedOrigins = getTrustedOrigins()

app.use(cors({
    origin: (origin, callback) => callback(null, !origin || trustedOrigins.has(origin)),
    credentials: true
}));
app.use(cookieParser());
app.use(createCsrfProtection(trustedOrigins));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use('/uploads', express.static(require('path').join(__dirname, 'uploads')));
app.use('/api/v1', products);
app.use('/api/v1', auth);
app.use('/api/v1', order);
app.use('/api/v1', brand);
app.use('/api/v1', category);
app.use('/api/v1', blindbox);
// original Yokan sign up / login (Firebase) - same paths as before: /api/users/...
app.use('/api/users', firebaseauth);

// database status (shown by the indicator in the header)  =>  /api/v1/health
app.get('/api/v1/health', (req, res) => {
    const connected = mongoose.connection.readyState === 1;
    res.status(connected ? 200 : 503).json({
        status: connected ? 'connected' : 'database_disconnected'
    });
});

module.exports = app