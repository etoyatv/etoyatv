const express = require('express');
const router = express.Router();

// NOTE: Order matters — more specific paths before the catch-all /:shortname
router.use(require('./legacy-tabs'));
router.use(require('./lifecycle'));
router.use(require('./social'));
router.use(require('./widgets'));
router.use(require('./api'));
router.use(require('./live-autopilot'));
// page.js mounts the wildcard /:shortname route — must be last
router.use(require('./page'));

module.exports = router;
