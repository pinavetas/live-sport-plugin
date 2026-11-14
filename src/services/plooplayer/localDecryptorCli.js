#!/usr/bin/env node
'use strict';

// Entry point of the Plooplayer local decryptor (see localDecryptor.js).
//   node src/services/plooplayer/localDecryptorCli.js        from a checkout
//   node ploo-decryptor.js                                   the bundle served by GET /plooplayer/decryptor.js
// PORT (default 8090) and HOST (default 127.0.0.1; 0.0.0.0 to serve a LAN) are read from the environment.
require('./localDecryptor').main();
