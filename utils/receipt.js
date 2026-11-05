const PDFDocument = require('pdfkit');

const money = (n) => `PHP ${Number(n || 0).toFixed(2)}`;

// Builds the PDF receipt in memory and resolves with a Buffer (used as an email attachment)
const buildReceipt = (order, customer) => new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(22).text('YOKAN VAULT', { align: 'center' });
    doc.fontSize(11).fillColor('#666').text('Order receipt - not proof of payment', { align: 'center' }).fillColor('#000').moveDown();
    doc.fontSize(11)
        .text(`Order ID: ${order._id}`)
        .text(`Customer: ${customer.name || customer.displayName || customer.email}`)
        .text(`Email: ${customer.email}`)
        .text(`Status: ${order.orderStatus}`)
        .text(`Payment method: ${order.paymentInfo?.method || (String(order.paymentInfo?.id || '').startsWith('COD-') ? 'Cash on Delivery' : 'Not specified')}`)
        .text(`Payment status: ${order.paymentInfo?.status || 'Pending'}`)
        .text(`Date: ${new Date(order.createdAt || Date.now()).toISOString()}`)
        .moveDown();

    const x = [50, 300, 370, 450];
    let y = doc.y;
    doc.font('Helvetica-Bold');
    ['Item', 'Qty', 'Price', 'Subtotal'].forEach((h, i) => doc.text(h, x[i], y));
    doc.font('Helvetica');
    y += 20;
    order.orderItems.forEach((item) => {
        doc.text(String(item.name).slice(0, 38), x[0], y, { width: 240 });
        doc.text(String(item.quantity), x[1], y);
        doc.text(money(item.price), x[2], y);
        doc.text(money(item.price * item.quantity), x[3], y);
        y += 20;
    });
    doc.moveTo(50, y).lineTo(550, y).stroke();
    y += 10;
    doc.text(`Items subtotal: ${money(order.itemsPrice)}`, 330, y); y += 16;
    doc.text(`Shipping: ${money(order.shippingPrice)}`, 330, y); y += 16;
    doc.text(`Tax: ${money(order.taxPrice)}`, 330, y); y += 20;
    doc.font('Helvetica-Bold').fontSize(13).text(`Grand total: ${money(order.totalPrice)}`, 330, y);
    doc.end();
});

module.exports = buildReceipt;
