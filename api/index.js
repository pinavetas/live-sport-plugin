'use strict';

/**
 * Vercel Function entry point. vercel.json rewrites every request that is not
 * a static file in public/ to this function, which hands it to the Express app.
 *
 * The filesystem defaults must be applied before the app modules load: several
 * services resolve their data paths at require time, and on Vercel only /tmp is
 * writable.
 */
const { applyServerlessFsDefaults } = require('../src/serverless');

applyServerlessFsDefaults();

module.exports = require('../src/index');
