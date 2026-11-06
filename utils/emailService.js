const nodemailer = require('nodemailer');
const { createEmailHtml } = require('./emailTemplate');
const { getLogoBuffer } = require('./brandAssets');

const getInlineLogoAttachment = () => ({
  filename: 'yokan-logo.png',
  content: getLogoBuffer(),
  contentType: 'image/png',
  cid: 'yokan-vault-logo',
  contentDisposition: 'inline',
});

// Reads the Mailtrap settings from either naming style, so it works with the
// original Yokan variables (EMAIL_*) and the itcp318 ones (SMTP_*).
const pick = (...names) => {
  for (const name of names) {
    if (process.env[name] && String(process.env[name]).trim()) return String(process.env[name]).trim();
  }
  return '';
};

const getConfig = () => ({
  host: pick('EMAIL_HOST', 'SMTP_HOST'),
  port: Number(pick('EMAIL_PORT', 'SMTP_PORT')) || 2525,
  user: pick('EMAIL_USER', 'SMTP_EMAIL'),
  pass: pick('EMAIL_PASS', 'SMTP_PASSWORD'),
  fromAddress: pick('EMAIL_FROM_ADDRESS', 'SMTP_FROM_EMAIL'),
  fromName: pick('EMAIL_FROM_NAME', 'SMTP_FROM_NAME') || 'Yokan Vault',
});

const missingSettings = () => {
  const cfg = getConfig();
  return [
    ['host', 'EMAIL_HOST'],
    ['user', 'EMAIL_USER'],
    ['pass', 'EMAIL_PASS'],
    ['fromAddress', 'EMAIL_FROM_ADDRESS'],
  ].filter(([key]) => !cfg[key]).map(([, label]) => label);
};

const createEmailTransporter = () => {
  const cfg = getConfig();
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,       // 2525 / 587 / 25 use STARTTLS, only 465 is implicit TLS
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
};

const emailSender = () => {
  const cfg = getConfig();
  return `"${cfg.fromName}" <${cfg.fromAddress}>`;
};

// Throws a readable error instead of silently returning false
const assertConfigured = () => {
  const missing = missingSettings();
  if (missing.length) {
    throw new Error(`Email is not configured. Missing in backend/config/.env: ${missing.join(', ')}`);
  }
};

// Called once when the server starts: tells you straight away if Mailtrap rejects the login
const verifySmtp = async () => {
  assertConfigured();
  await createEmailTransporter().verify();
  const cfg = getConfig();
  return `${cfg.host}:${cfg.port}`;
};

const sendVerificationEmail = async (toEmail, verificationUrl, firstName = '', lastName = '') => {
  assertConfigured();
  const transporter = createEmailTransporter();
  const html = createEmailHtml({
    preheader: 'Verify your email to finish setting up your account.',
    title: 'Verify your email',
    greeting: `Hello ${[firstName, lastName].filter(Boolean).join(' ') || 'there'},`,
    paragraphs: [
      'Thanks for creating a Yokan Vault account. Verify your email address to finish setting up your account.',
      'If you did not create an account, you can ignore this message.'
    ],
    action: {
      label: 'Verify email',
      url: verificationUrl
    },
    footer: 'This is an automated message from Yokan Vault.'
  })

  const info = await transporter.sendMail({
    from: emailSender(),
    to: toEmail,
    subject: 'Verify your Yokan Vault email',
    text: `Thanks for creating a Yokan Vault account. Verify your email here: ${verificationUrl}`,
    html,
    attachments: [getInlineLogoAttachment()],
  });
  console.log('Verification email sent');
  return info;
};

// generic mail (password reset, order updates). attachments: [{ filename, content }]
const sendMail = async ({ to, subject, text, html, attachments }) => {
  assertConfigured();
  const info = await createEmailTransporter().sendMail({
    from: emailSender(),
    to,
    subject,
    text,
    html,
    attachments: [getInlineLogoAttachment(), ...(attachments || [])],
  });
  console.log('Email sent');
  return info;
};

module.exports = { sendMail, sendVerificationEmail, verifySmtp, getConfig, missingSettings, getInlineLogoAttachment };
