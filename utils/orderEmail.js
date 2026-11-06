const { escapeHtml } = require('./emailTemplate')
const getStorefrontUrl = require('./storefrontUrl')

const imageUrlForEmail = (image, storefrontUrl) => {
    const fallbackUrl = new URL('/images/default-product.png', storefrontUrl).toString()
    if (typeof image !== 'string' || !image.trim()) return fallbackUrl
    try {
        const url = new URL(image, storefrontUrl)
        const allowedProtocol = url.protocol === 'https:' ||
            (process.env.NODE_ENV !== 'production' && url.protocol === 'http:')
        return allowedProtocol ? url.toString() : fallbackUrl
    } catch (error) {
        return fallbackUrl
    }
}

// Never let a STORE_URL / CORS_ORIGINS misconfiguration block an order email.
const resolveStorefrontUrl = () => {
    try {
        return getStorefrontUrl()
    } catch (error) {
        console.warn('Order email: storefront URL not usable, using fallback:', error.message)
        const raw = String(process.env.STORE_URL || '').trim()
        try {
            return new URL(raw || 'http://localhost:5173').origin
        } catch (e) {
            return 'http://localhost:5173'
        }
    }
}

const createOrderDetailsHtml = (order) => {
    const storefrontUrl = resolveStorefrontUrl()
    const money = (amount) => `PHP ${Number(amount || 0).toFixed(2)}`
    const rows = (order.orderItems || []).map((item) => {
        const name = escapeHtml(item.name)
        const image = escapeHtml(imageUrlForEmail(item.image, storefrontUrl))
        const quantity = Number(item.quantity) || 0
        const price = Number(item.price) || 0
        return `<tr>
<td style="padding:10px 8px;border-bottom:1px solid #eee9e2;color:#303e4b;"><img src="${image}" width="56" height="56" alt="${name}" style="display:inline-block;width:56px;height:56px;object-fit:contain;vertical-align:middle;margin-right:10px;border:0;"><span style="display:inline-block;vertical-align:middle;">${name}</span></td>
<td align="center" style="padding:10px 8px;border-bottom:1px solid #eee9e2;color:#4b5563;">${quantity}</td>
<td align="right" style="padding:10px 8px;border-bottom:1px solid #eee9e2;color:#4b5563;">${money(price)}</td>
<td align="right" style="padding:10px 8px;border-bottom:1px solid #eee9e2;color:#4b5563;">${money(price * quantity)}</td>
</tr>`
    }).join('')
    const shippingInfo = order.shippingInfo || {}
    const shippingAddress = [
        shippingInfo.address,
        [shippingInfo.city, shippingInfo.postalCode].filter(Boolean).join(', '),
        shippingInfo.country,
        shippingInfo.phoneNo
    ].filter(Boolean).map(escapeHtml).join('<br>')
    const paymentMethod = escapeHtml(order.paymentInfo?.method || 'Not specified')

    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;border-collapse:collapse;font-size:13px;">
<tr style="background:#f5f3ef;"><th align="left" style="padding:10px 8px;color:#303e4b;">Item</th><th style="padding:10px 8px;color:#303e4b;">Qty</th><th align="right" style="padding:10px 8px;color:#303e4b;">Price</th><th align="right" style="padding:10px 8px;color:#303e4b;">Subtotal</th></tr>${rows}
</table>
<p style="margin:0;color:#4b5563;font-size:14px;line-height:1.8;">Items: ${money(order.itemsPrice)}<br>Shipping: ${money(order.shippingPrice)}<br>Tax: ${money(order.taxPrice)}<br>Payment: ${paymentMethod}</p>
<p style="margin:14px 0 0;color:#303e4b;font-size:16px;font-weight:700;">Total: ${money(order.totalPrice)}</p>
${shippingAddress ? `<p style="margin:18px 0 0;color:#4b5563;font-size:14px;line-height:1.7;"><strong>Shipping to</strong><br>${shippingAddress}</p>` : ''}`
}

module.exports = { createOrderDetailsHtml, imageUrlForEmail }
