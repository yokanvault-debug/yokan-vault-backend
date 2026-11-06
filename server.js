require('./utils/netFix')
const dotenv = require('dotenv');
const path = require('path')
dotenv.config({ path: path.join(__dirname, 'config', '.env') })

const app = require('./app');
const connectDatabase = require('./config/database')
const cloudinary = require('cloudinary');
const { verifySmtp } = require('./utils/emailService');
const { isFirebaseAdminConfigured } = require('./utils/firebaseAdmin');

connectDatabase();
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
})
const cloudinaryName = cloudinary.v2.config().cloud_name
const cloudinaryStatus = cloudinaryName
    ? `configured (${cloudinaryName})`
    : process.env.NODE_ENV === 'production'
        ? 'NOT configured - image uploads will fail'
        : 'NOT configured - images will be saved locally'
console.log('Cloudinary:', cloudinaryStatus)

app.listen(process.env.PORT, () => {
    console.log(`server started on port:' ${process.env.PORT} in ${process.env.NODE_ENV} mode`);

    // startup checks: tells you right away if Firebase or Mailtrap are not set up
    isFirebaseAdminConfigured();
    verifySmtp()
        .then((where) => console.log(`SMTP ready - Mailtrap login accepted (${where})`))
        .catch((error) => console.error('SMTP check failed:', error.code || error.name || 'unknown error', error.message));
});