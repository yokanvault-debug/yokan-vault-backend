const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const createEmailHtml = ({
    preheader = '',
    title,
    greeting = '',
    paragraphs = [],
    contentHtml = '',
    action = null,
    footer = 'Thank you for choosing Yokan Vault.'
}) => {
    const safeTitle = escapeHtml(title || 'Yokan Vault')
    const safePreheader = escapeHtml(preheader)
    const safeGreeting = escapeHtml(greeting)
    const safeParagraphs = paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('')
    const safeFooter = escapeHtml(footer)
    const actionMarkup = action && action.url && action.label
        ? `<p style="margin:24px 0;text-align:center;"><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:12px 22px;background:#c4a47c;border-radius:6px;color:#ffffff;font-weight:600;text-decoration:none;">${escapeHtml(action.label)}</a></p>`
        : ''

    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f8fcff;font-family:Arial,Helvetica,sans-serif;color:#303e4b;">
  <div style="display:none;max-height:0;overflow:hidden;">${safePreheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fcff;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e8edf1;border-radius:10px;overflow:hidden;">
        <tr><td style="padding:14px 28px;background:#435266;color:#ffffff;font-size:20px;font-weight:700;letter-spacing:1px;">YOKAN VAULT</td></tr>
        <tr><td style="padding:28px;font-size:15px;line-height:1.6;">
          <h1 style="margin:0 0 18px;font-size:22px;line-height:1.3;color:#303e4b;">${safeTitle}</h1>
          ${safeGreeting ? `<p style="margin:0 0 14px;">${safeGreeting}</p>` : ''}
          ${safeParagraphs}
          ${actionMarkup}
          ${contentHtml}
        </td></tr>
        <tr><td style="padding:14px 28px;border-top:1px solid #e8edf1;color:#707477;font-size:12px;line-height:1.5;">${safeFooter}</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}

module.exports = { createEmailHtml, escapeHtml }
