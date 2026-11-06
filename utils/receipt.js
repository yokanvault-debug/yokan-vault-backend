const PDFDocument = require('pdfkit')
const { getLogoBuffer } = require('./brandAssets')

const PAGE_MARGIN = 44
const HEADER_HEIGHT = 128
const FOOTER_SPACE = 62
const money = (amount) => `PHP ${Number(amount || 0).toFixed(2)}`

const drawHeader = (doc, order, logo) => {
    const pageWidth = doc.page.width
    doc.save()
    doc.rect(0, 0, pageWidth, HEADER_HEIGHT).fill('#435266')
    doc.image(logo, PAGE_MARGIN, 28, { fit: [220, 56] })
    doc.fillColor('#ffffff')
        .font('Helvetica-Bold')
        .fontSize(18)
        .text('ORDER RECEIPT', pageWidth - 235, 38, { width: 190, align: 'right' })
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#e5e7eb')
        .text(`Order #${String(order._id || '').slice(-12)}`, pageWidth - 235, 66, { width: 190, align: 'right' })
    doc.restore()
    doc.rect(0, HEADER_HEIGHT, pageWidth, 4).fill('#c4a47c')
}

const drawTableHeader = (doc, y) => {
    const width = doc.page.width - PAGE_MARGIN * 2
    doc.save()
    doc.roundedRect(PAGE_MARGIN, y, width, 28, 4).fill('#f1eee8')
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#435266')
        .text('ITEM', PAGE_MARGIN + 10, y + 9, { width: 245 })
        .text('QTY', PAGE_MARGIN + 265, y + 9, { width: 38, align: 'right' })
        .text('UNIT PRICE', PAGE_MARGIN + 315, y + 9, { width: 76, align: 'right' })
        .text('AMOUNT', PAGE_MARGIN + 400, y + 9, { width: width - 410, align: 'right' })
    doc.restore()
    return y + 28
}

const drawFirstPageDetails = (doc, order, customer) => {
    const pageWidth = doc.page.width
    const gap = 14
    const cardWidth = (pageWidth - PAGE_MARGIN * 2 - gap) / 2
    const left = PAGE_MARGIN
    const right = left + cardWidth + gap
    const top = 151
    const cardHeight = 106
    const shipping = order.shippingInfo || {}
    const address = [
        shipping.address,
        [shipping.city, shipping.postalCode].filter(Boolean).join(', '),
        shipping.country,
        shipping.phoneNo
    ].filter(Boolean)
    const paymentMethod = order.paymentInfo?.method ||
        (String(order.paymentInfo?.id || '').startsWith('COD-') ? 'Cash on Delivery' : 'Not specified')
    const orderDate = new Date(order.createdAt || Date.now()).toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC'
    })

    doc.save()
    for (const x of [left, right]) {
        doc.roundedRect(x, top, cardWidth, cardHeight, 6).fill('#f8f7f4')
    }

    doc.font('Helvetica-Bold').fontSize(8).fillColor('#9a7951')
        .text('ORDER DETAILS', left + 12, top + 12)
        .text('SHIP TO', right + 12, top + 12)

    doc.font('Helvetica').fontSize(9).fillColor('#303e4b')
        .text(`Status: ${order.orderStatus || 'Processing'}`, left + 12, top + 32, { width: cardWidth - 24 })
        .text(`Payment: ${paymentMethod} (${order.paymentInfo?.status || 'Pending'})`, left + 12, top + 48, { width: cardWidth - 24 })
        .text(`Date: ${orderDate}`, left + 12, top + 64, { width: cardWidth - 24 })
        .text(customer.name || customer.displayName || 'Customer', right + 12, top + 32, { width: cardWidth - 24 })
        .text(customer.email || '', right + 12, top + 47, { width: cardWidth - 24 })
        .text(address.join('\n') || 'Address not provided', right + 12, top + 62, {
            width: cardWidth - 24,
            height: 38,
            lineGap: 1
        })
    doc.restore()
}

const drawFooter = (doc, pageNumber, pageCount) => {
    const y = doc.page.height - 37
    doc.save()
    doc.moveTo(PAGE_MARGIN, y - 10).lineTo(doc.page.width - PAGE_MARGIN, y - 10).strokeColor('#e5e1da').stroke()
    doc.font('Helvetica').fontSize(8).fillColor('#707477')
        .text('Thank you for shopping with Yokan Vault.', PAGE_MARGIN, y, { width: 300 })
        .text('Receipt - not proof of payment', PAGE_MARGIN, y + 12, { width: 300 })
        .text(`${pageNumber} / ${pageCount}`, doc.page.width - PAGE_MARGIN - 60, y, { width: 60, align: 'right' })
    doc.restore()
}

const drawTotals = (doc, order, y) => {
    const width = 228
    const x = doc.page.width - PAGE_MARGIN - width
    const height = 112
    doc.save()
    doc.roundedRect(x, y, width, height, 6).fill('#f8f7f4')
    const labelX = x + 12
    const valueX = x + 110
    doc.font('Helvetica').fontSize(9).fillColor('#4b5563')
        .text('Items subtotal', labelX, y + 13, { width: 94 })
        .text(money(order.itemsPrice), valueX, y + 13, { width: width - 122, align: 'right' })
        .text('Shipping', labelX, y + 34, { width: 94 })
        .text(money(order.shippingPrice), valueX, y + 34, { width: width - 122, align: 'right' })
        .text('Tax', labelX, y + 55, { width: 94 })
        .text(money(order.taxPrice), valueX, y + 55, { width: width - 122, align: 'right' })
    doc.moveTo(x + 12, y + 77).lineTo(x + width - 12, y + 77).strokeColor('#d9d3c8').stroke()
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#435266')
        .text('GRAND TOTAL', labelX, y + 88, { width: 94 })
        .text(money(order.totalPrice), valueX, y + 88, { width: width - 122, align: 'right' })
    doc.restore()
    return y + height
}

const buildReceipt = (order, customer) => new Promise((resolve, reject) => {
    let logo
    try {
        logo = getLogoBuffer()
    } catch (error) {
        reject(error)
        return
    }

    const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true })
    const chunks = []
    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const pageWidth = doc.page.width
    const bottomContent = doc.page.height - PAGE_MARGIN - FOOTER_SPACE
    drawHeader(doc, order, logo)
    drawFirstPageDetails(doc, order, customer)
    let y = drawTableHeader(doc, 277)
    const items = order.orderItems || []

    items.forEach((item, index) => {
        const name = String(item.name || 'Item')
        const itemHeight = Math.max(30, doc.heightOfString(name, {
            width: 235,
            font: 'Helvetica',
            fontSize: 9
        }) + 12)

        if (y + itemHeight > bottomContent - 124) {
            doc.addPage()
            drawHeader(doc, order, logo)
            y = drawTableHeader(doc, 154)
        }

        const rowWidth = pageWidth - PAGE_MARGIN * 2
        doc.save()
        if (index % 2 === 0) doc.rect(PAGE_MARGIN, y, rowWidth, itemHeight).fill('#fcfbf9')
        doc.font('Helvetica').fontSize(9).fillColor('#303e4b')
            .text(name, PAGE_MARGIN + 10, y + 7, { width: 235 })
            .text(String(item.quantity || 0), PAGE_MARGIN + 265, y + 9, { width: 38, align: 'right' })
            .text(money(item.price), PAGE_MARGIN + 315, y + 9, { width: 76, align: 'right' })
            .text(money(Number(item.price || 0) * Number(item.quantity || 0)), PAGE_MARGIN + 400, y + 9, {
                width: rowWidth - 410,
                align: 'right'
            })
        doc.restore()
        y += itemHeight
        doc.moveTo(PAGE_MARGIN, y).lineTo(pageWidth - PAGE_MARGIN, y).strokeColor('#ece9e3').stroke()
    })

    if (y + 112 > bottomContent) {
        doc.addPage()
        drawHeader(doc, order, logo)
        y = 154
    } else {
        y += 14
    }
    drawTotals(doc, order, y)

    const pages = doc.bufferedPageRange()
    for (let index = 0; index < pages.count; index += 1) {
        doc.switchToPage(pages.start + index)
        drawFooter(doc, index + 1, pages.count)
    }
    doc.end()
})

module.exports = buildReceipt
