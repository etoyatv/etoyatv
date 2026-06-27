const axios = require('axios');

/**
 * Verifies hCaptcha token using the official API.
 * @param {string} token - The hCaptcha response token from client.
 * @returns {Promise<boolean>}
 */
async function verifyHCaptcha(token) {
  if (!token) {
    return false;
  }
  try {
    const secret = process.env.HCAPTCHA_SECRET || 'ES_f8e28b74d0d8462d93b32f755a7dcfb7';
    
    // We send verification request via POST with form URL encoded params
    const response = await axios.post(
      'https://hcaptcha.com/siteverify',
      new URLSearchParams({
        secret: secret,
        response: token
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    
    return !!(response.data && response.data.success);
  } catch (error) {
    console.error('Error verifying hCaptcha:', error);
    return false;
  }
}

module.exports = { verifyHCaptcha };
