const express = require('express');
const router = express.Router();

router.use(require('./translate'));
router.use(require('./users'));
router.use(require('./panel-stats'));
router.use(require('./rtmp'));
router.use(require('./recording'));
router.use(require('./misc'));

module.exports = router;
