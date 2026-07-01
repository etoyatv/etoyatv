const crypto = require('crypto');

function encryptUser(userObj) {
  if (!userObj) return '';
  try {
    const secret = process.env.SESSION_SECRET || 'etoyatv_secret_key';
    const key = crypto.createHash('sha256').update(secret).digest();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(JSON.stringify(userObj), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  } catch (e) {
    console.error('Error encrypting user data:', e);
    return '';
  }
}

function decryptUser(encryptedText) {
  if (!encryptedText) return null;
  try {
    const secret = process.env.SESSION_SECRET || 'etoyatv_secret_key';
    const key = crypto.createHash('sha256').update(secret).digest();
    const parts = encryptedText.split(':');
    if (parts.length !== 2) return null;
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  } catch (e) {
    console.error('Failed to decrypt user data:', e.message);
    return null;
  }
}

module.exports = {
  encryptUser,
  decryptUser
};
