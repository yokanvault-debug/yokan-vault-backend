const PAID_ORDER_MATCH = {
    'paymentInfo.status': 'Paid',
    orderStatus: { $ne: 'Cancelled' },
    inventoryReserved: { $ne: false }
}

const isEligiblePaidOrder = (order) => Boolean(
    order &&
    order.paymentInfo?.status === 'Paid' &&
    order.orderStatus !== 'Cancelled' &&
    order.inventoryReserved !== false
)

const parseUtcDate = (value, fieldName) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw Object.assign(new Error(`${fieldName} must use YYYY-MM-DD format`), { statusCode: 400 })
    }
    const date = new Date(`${value}T00:00:00.000Z`)
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        throw Object.assign(new Error(`${fieldName} is not a valid calendar date`), { statusCode: 400 })
    }
    return date
}

const parseDateRange = (query = {}) => {
    const { startDate, endDate } = query
    const hasStart = startDate !== undefined && startDate !== ''
    const hasEnd = endDate !== undefined && endDate !== ''
    if (!hasStart && !hasEnd) return {}

    const range = {}
    if (hasStart) range.$gte = parseUtcDate(startDate, 'startDate')
    if (hasEnd) {
        const end = parseUtcDate(endDate, 'endDate')
        end.setUTCDate(end.getUTCDate() + 1)
        range.$lt = end
    }
    if (hasStart && hasEnd && startDate > endDate) {
        throw Object.assign(new Error('startDate must be on or before endDate'), { statusCode: 400 })
    }
    return range
}

const formatMonthLabel = (year, month) => {
    const date = new Date(Date.UTC(year, month - 1, 1))
    return `${date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${year}`
}

module.exports = { PAID_ORDER_MATCH, isEligiblePaidOrder, parseDateRange, formatMonthLabel }
