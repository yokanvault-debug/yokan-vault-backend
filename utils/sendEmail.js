const { sendMail } = require('./emailService');
const { createEmailHtml } = require('./emailTemplate');

// Uses the same Mailtrap settings as the verification email (EMAIL_* or SMTP_* in config/.env)
const sendEmail = async (options) => {
    await sendMail({
        to: options.email,
        subject: options.subject,
        text: options.message,
        html: options.html || createEmailHtml({
            title: options.subject || 'Yokan Vault',
            paragraphs: String(options.message || '').split(/\n{2,}/).filter(Boolean)
        }),
        attachments: options.attachments,
    });
};

module.exports = sendEmail;
