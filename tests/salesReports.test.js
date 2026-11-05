const test = require('node:test')
const assert = require('node:assert/strict')
const {
    PAID_ORDER_MATCH,
    isEligiblePaidOrder,
    parseDateRange,
    formatMonthLabel
} = require('../utils/salesReports')

test('paid sales include only paid, non-cancelled and reserved or legacy orders', () => {
    assert.equal(isEligiblePaidOrder({ paymentInfo: { status: 'Paid' }, orderStatus: 'Delivered' }), true)
    assert.equal(isEligiblePaidOrder({ paymentInfo: { status: 'Pending' }, orderStatus: 'Delivered' }), false)
    assert.equal(isEligiblePaidOrder({ paymentInfo: { status: 'Paid' }, orderStatus: 'Cancelled' }), false)
    assert.equal(isEligiblePaidOrder({ paymentInfo: { status: 'Paid' }, orderStatus: 'Delivered', inventoryReserved: false }), false)
    assert.equal(isEligiblePaidOrder({ paymentInfo: { status: 'Paid' }, orderStatus: 'Delivered', inventoryReserved: true }), true)
    assert.deepEqual(PAID_ORDER_MATCH, {
        'paymentInfo.status': 'Paid',
        orderStatus: { $ne: 'Cancelled' },
        inventoryReserved: { $ne: false }
    })
})

test('date range includes UTC start and the complete selected end day', () => {
    const range = parseDateRange({ startDate: '2025-12-31', endDate: '2026-01-01' })
    assert.equal(range.$gte.toISOString(), '2025-12-31T00:00:00.000Z')
    assert.equal(range.$lt.toISOString(), '2026-01-02T00:00:00.000Z')
})

test('same-day date range spans one full UTC calendar day', () => {
    const range = parseDateRange({ startDate: '2026-04-03', endDate: '2026-04-03' })
    assert.equal(range.$gte.toISOString(), '2026-04-03T00:00:00.000Z')
    assert.equal(range.$lt.toISOString(), '2026-04-04T00:00:00.000Z')
})

test('date range accepts a single boundary and no range', () => {
    assert.deepEqual(parseDateRange({}), {})
    assert.equal(parseDateRange({ startDate: '2026-02-01' }).$gte.toISOString(), '2026-02-01T00:00:00.000Z')
    assert.equal(parseDateRange({ endDate: '2026-02-01' }).$lt.toISOString(), '2026-02-02T00:00:00.000Z')
})

test('date range rejects malformed, impossible and reversed dates', () => {
    assert.throws(() => parseDateRange({ startDate: '02/01/2026' }), { statusCode: 400 })
    assert.throws(() => parseDateRange({ endDate: '2026-02-30' }), { statusCode: 400 })
    assert.throws(() => parseDateRange({ startDate: '2026-02-02', endDate: '2026-02-01' }), { statusCode: 400 })
})

test('monthly labels retain the year and month', () => {
    assert.equal(formatMonthLabel(2025, 11), 'Nov 2025')
    assert.equal(formatMonthLabel(2026, 1), 'Jan 2026')
})
