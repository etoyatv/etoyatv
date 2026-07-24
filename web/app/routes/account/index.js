const express = require('express');
const router = express.Router();

// privacy.js exports shared helper functions (not a router) — imported by each submodule as needed

router.use(require('./profile-pages'));
router.use(require('./settings'));
router.use(require('./twofa'));
router.use(require('./friends'));
router.use(require('./messages'));
router.use(require('./invites'));
router.use(require('./profile-comments'));
router.use(require('./boosty'));
router.use(require('./export'));

module.exports = router;
