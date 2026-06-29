const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const smtpOptions = {
  host: process.env.SMTP_HOST || 'localhost',
  port: process.env.SMTP_PORT || 1025,
  secure: process.env.SMTP_PORT == 465, // true for 465, false for other ports
  ignoreTLS: process.env.SMTP_PORT == 1025,
};

if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  smtpOptions.auth = {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  };
}

const transporter = nodemailer.createTransport(smtpOptions);

const emailsDir = path.join(__dirname, 'emails');
if (!fs.existsSync(emailsDir)){
  fs.mkdirSync(emailsDir, { recursive: true });
}

async function sendEmailFallback(to, subject, text, html) {
  const content = `Date: ${new Date().toISOString()}\nTo: ${to}\nSubject: ${subject}\n\nTEXT:\n${text}\n\nHTML:\n${html}\n-------------------------------------------------\n`;
  const filePath = path.join(emailsDir, 'last_email.txt');
  fs.appendFileSync(filePath, content);
  console.log(`[EMAIL LOG]: Email to ${to} with subject "${subject}" logged to ${filePath}`);
}

async function sendVerificationEmail(email, username, token) {
  const appUrl = process.env.APP_URL || 'http://localhost:3001';
  const verificationLink = `${appUrl}/register/verify?token=${token}`;
  const subject = 'Подтверждение регистрации на ЭтоЯTV';
  const text = `Здравствуйте, ${username}!\n\nДля завершения регистрации на ЭтоЯTV перейдите по следующей ссылке:\n${verificationLink}\n\nЕсли вы не регистрировались на нашем сайте, просто проигнорируйте это письмо.`;
  const html = `<p>Здравствуйте, <b>${username}</b>!</p><p>Для завершения регистрации на ЭтоЯTV перейдите по следующей ссылке:</p><p><a href="${verificationLink}">${verificationLink}</a></p><p>Если вы не регистрировались на нашем сайте, просто проигнорируйте это письмо.</p>`;

  try {
    await transporter.sendMail({
      from: `"ЭтоЯTV" <${process.env.SMTP_USER || 'noreply@etoyatv.ru'}>`,
      to: email,
      subject: subject,
      text: text,
      html: html,
    });
    console.log(`Verification email sent to ${email} via SMTP.`);
  } catch (err) {
    console.error('SMTP failed, logging email locally:', err.message);
  }
  // Always log locally for development convenience
  await sendEmailFallback(email, subject, text, html);
}

async function sendPasswordResetEmail(email, username, token) {
  const appUrl = process.env.APP_URL || 'http://localhost:3001';
  const resetLink = `${appUrl}/reset-password?token=${token}&email=${encodeURIComponent(email)}`;
  const subject = 'Восстановление пароля на ЭтоЯTV';
  const text = `Здравствуйте, ${username}!\n\nВы запросили восстановление пароля на ЭтоЯTV.\nДля изменения пароля перейдите по следующей ссылке:\n${resetLink}\n\nЕсли вы не запрашивали восстановление пароля, просто проигнорируйте это письмо. (Ссылка действительна 1 час).`;
  const html = `<p>Здравствуйте, <b>${username}</b>!</p><p>Вы запросили восстановление пароля на ЭтоЯTV.</p><p>Для изменения пароля перейдите по следующей ссылке:</p><p><a href="${resetLink}">${resetLink}</a></p><p>Если вы не запрашивали восстановление пароля, просто проигнорируйте это письмо. (Ссылка действительна 1 час).</p>`;

  try {
    await transporter.sendMail({
      from: `"ЭтоЯTV" <${process.env.SMTP_USER || 'noreply@etoyatv.ru'}>`,
      to: email,
      subject: subject,
      text: text,
      html: html,
    });
    console.log(`Password reset email sent to ${email} via SMTP.`);
  } catch (err) {
    console.error('SMTP failed, logging email locally:', err.message);
  }
  // Always log locally for development convenience
  await sendEmailFallback(email, subject, text, html);
}

async function sendEmailChangeVerificationCode(email, username, code) {
  const subject = 'Подтверждение смены email на ЭтоЯTV';
  const text = `Здравствуйте, ${username}!\n\nДля подтверждения смены E-Mail адреса на ЭтоЯTV введите следующий код подтверждения:\n\n${code}\n\nКод действителен 15 минут. Если вы не запрашивали смену почты, просто проигнорируйте это письмо.`;
  const html = `<p>Здравствуйте, <b>${username}</b>!</p><p>Для подтверждения смены E-Mail адреса на ЭтоЯTV введите следующий код подтверждения:</p><h2 style="font-size: 24px; color: #6fdeee;">${code}</h2><p>Код действителен 15 минут. Если вы не запрашивали смену почты, просто проигнорируйте это письмо.</p>`;

  try {
    await transporter.sendMail({
      from: `"ЭтоЯTV" <${process.env.SMTP_USER || 'noreply@etoyatv.ru'}>`,
      to: email,
      subject: subject,
      text: text,
      html: html,
    });
    console.log(`Email change verification code sent to ${email} via SMTP.`);
  } catch (err) {
    console.error('SMTP failed, logging email locally:', err.message);
  }
  // Always log locally for development convenience
  await sendEmailFallback(email, subject, text, html);
}

async function sendChannelTransferEmail(email, username, channelName, transferLink) {
  const subject = 'Подтверждение передачи владения телеканалом на ЭтоЯTV';
  const text = `Здравствуйте, ${username}!\n\nВы запросили передачу владения телеканалом "${channelName}".\nДля подтверждения этого действия перейдите по следующей ссылке:\n${transferLink}\n\nЕсли вы не запрашивали передачу владения, срочно смените пароль и проигнорируйте это письмо.`;
  const html = `<p>Здравствуйте, <b>${username}</b>!</p><p>Вы запросили передачу владения телеканалом "<b>${channelName}</b>".</p><p>Для подтверждения этого действия перейдите по следующей ссылке:</p><p><a href="${transferLink}">${transferLink}</a></p><p>Если вы не запрашивали передачу владения, срочно смените пароль и проигнорируйте это письмо.</p>`;

  try {
    await transporter.sendMail({
      from: `"ЭтоЯTV" <${process.env.SMTP_USER || 'noreply@etoyatv.ru'}>`,
      to: email,
      subject: subject,
      text: text,
      html: html,
    });
    console.log(`Channel transfer email sent to ${email} via SMTP.`);
  } catch (err) {
    console.error('SMTP failed, logging email locally:', err.message);
  }
  await sendEmailFallback(email, subject, text, html);
}

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendEmailChangeVerificationCode,
  sendChannelTransferEmail
};

