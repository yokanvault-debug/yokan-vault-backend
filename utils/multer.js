const multer = require("multer");
const path = require("path");

module.exports = multer({
    limits: { fieldSize: 100 * 1024 * 1024, fileSize: 10 * 1024 * 1024 },
    storage: multer.diskStorage({}),
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) {
            return cb(null, true);
        }
        cb(new Error("Unsupported file type! Use jpg, png, webp or gif."));
    },
});
