// Fail-fast validation of critical secrets so the app never runs with
// predictable/insecure default credentials.
const REQUIRED = ['SESSION_SECRET', 'DB_PASSWORD'];
const RECOMMENDED = ['HCAPTCHA_SECRET', 'RTMP_API_PASS', 'DB_HOST', 'DB_USER', 'DB_NAME'];
const KNOWN_WEAK = {
  SESSION_SECRET: ['etoyatv_secret_key'],
  DB_PASSWORD: ['yatv_pass', ''],
  RTMP_API_PASS: ['admin']
};

function validateEnv(context = 'app') {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`[FATAL] Missing required environment variables (${context}): ${missing.join(', ')}`);
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  for (const [key, weakValues] of Object.entries(KNOWN_WEAK)) {
    if (process.env[key] !== undefined && weakValues.includes(process.env[key])) {
      // Only hard-fail on the session secret since it protects auth/crypto.
      if (key === 'SESSION_SECRET') {
        throw new Error(`${key} is set to an insecure default value; configure a strong unique secret.`);
      }
      console.warn(`[WARN] ${key} appears to use an insecure default value (${context}).`);
    }
  }

  const missingRecommended = RECOMMENDED.filter((k) => !process.env[k]);
  if (missingRecommended.length) {
    console.warn(`[WARN] Missing recommended environment variables (${context}): ${missingRecommended.join(', ')}`);
  }
}

module.exports = { validateEnv };
