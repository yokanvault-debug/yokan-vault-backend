const ALLOWED_QUERY_KEYS = new Set([
    'keyword',
    'page',
    'limit',
    'sort',
    'price[gte]',
    'price[lte]',
    'category',
    'rarity',
    'minRating',
    'minReviews'
])
const SORTABLE_FIELDS = new Set(['name', 'price', 'ratings', 'numOfReviews', 'createdAt'])
const RARITIES = new Set(['common', 'rare', 'epic', 'legendary'])
const DEFAULT_PAGE_SIZE = 4
const MAX_PAGE_SIZE = 50
const MAX_PAGE = 1_000_000

const invalidQuery = (message) => Object.assign(new Error(message), { statusCode: 400 })

const scalar = (query, key) => {
    const value = query[key]
    if (value !== undefined && typeof value !== 'string') {
        throw invalidQuery(`Invalid ${key} query parameter`)
    }
    return value
}

const parseNumber = (query, key, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {}) => {
    const value = scalar(query, key)
    if (value === undefined) return undefined
    const number = Number(value)
    if (!value.trim() || !Number.isFinite(number) || number < min || number > max ||
        (integer && !Number.isInteger(number))) {
        throw invalidQuery(`Invalid ${key} query parameter`)
    }
    return number
}

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

class APIFeatures {
    constructor(query, queryStr = {}) {
        for (const key of Object.keys(queryStr)) {
            if (!ALLOWED_QUERY_KEYS.has(key)) throw invalidQuery(`Unsupported ${key} query parameter`)
        }

        const keyword = scalar(queryStr, 'keyword') || ''
        if (keyword.length > 100) throw invalidQuery('keyword cannot exceed 100 characters')

        const page = parseNumber(queryStr, 'page', { min: 1, max: MAX_PAGE, integer: true }) || 1
        const limit = parseNumber(queryStr, 'limit', { min: 1, max: MAX_PAGE_SIZE, integer: true }) || DEFAULT_PAGE_SIZE
        const minPrice = parseNumber(queryStr, 'price[gte]', { max: 1_000_000_000 })
        const maxPrice = parseNumber(queryStr, 'price[lte]', { max: 1_000_000_000 })
        if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
            throw invalidQuery('price[gte] cannot exceed price[lte]')
        }

        const categoryValue = scalar(queryStr, 'category')
        const categories = categoryValue
            ? categoryValue.split(',').map((category) => category.trim()).filter(Boolean)
            : []
        if (categories.length > 20 || categories.some((category) => category.length > 100)) {
            throw invalidQuery('Invalid category query parameter')
        }

        const rarity = scalar(queryStr, 'rarity')
        if (rarity !== undefined && !RARITIES.has(rarity)) throw invalidQuery('Invalid rarity query parameter')

        const minRating = parseNumber(queryStr, 'minRating', { max: 5 })
        const minReviews = parseNumber(queryStr, 'minReviews', { max: 1_000_000_000, integer: true })
        const sortValue = scalar(queryStr, 'sort')
        const sortFields = sortValue ? sortValue.split(',').map((field) => field.trim()) : []
        if (sortFields.length > 3 || sortFields.some((field) => {
            const name = field.startsWith('-') ? field.slice(1) : field
            return !SORTABLE_FIELDS.has(name)
        })) {
            throw invalidQuery('Invalid sort query parameter')
        }

        this.query = query
        this.options = { keyword, page, limit, minPrice, maxPrice, categories, rarity, minRating, minReviews, sortFields }
    }

    search() {
        const { keyword } = this.options
        const filter = keyword
            ? { name: { $regex: escapeRegex(keyword), $options: 'i' }, deletedAt: null }
            : { deletedAt: null }
        this.query = this.query.find(filter)
        return this
    }

    filter() {
        const { minPrice, maxPrice, categories, rarity, minRating, minReviews } = this.options
        const filters = {}
        if (minPrice !== undefined || maxPrice !== undefined) {
            filters.price = {}
            if (minPrice !== undefined) filters.price.$gte = minPrice
            if (maxPrice !== undefined) filters.price.$lte = maxPrice
        }
        if (categories.length) filters.category = { $in: categories }
        if (rarity !== undefined) filters.rarity = rarity
        if (minRating !== undefined) filters.ratings = { $gte: minRating }
        if (minReviews !== undefined) filters.numOfReviews = { $gte: minReviews }
        this.query = this.query.find(filters)
        return this
    }

    sort() {
        const { sortFields } = this.options
        if (sortFields.length) this.query = this.query.sort(sortFields.join(' '))
        return this
    }

    pagination() {
        const { page, limit } = this.options
        this.query = this.query.limit(limit).skip(limit * (page - 1))
        return this
    }
}

module.exports = APIFeatures
