/**
 * processGuards.js
 *
 * Process-level failure policy for the addon server.
 *
 * - uncaughtException is FATAL: after one, Node's state is undefined (half-run
 *   handlers, leaked sockets, broken invariants). Logging and carrying on left a
 *   zombie that PM2 / Docker never restarted. We log, set exitCode and exit on
 *   the next tick so the log line is flushed first; the process 'exit' hook in
 *   resolverManager still tears down the resolver child.
 * - unhandledRejection stays non-fatal: client disconnects abort in-flight
 *   fetches routinely, and those rejections are expected.
 * - A listen error (EADDRINUSE, EACCES...) is FATAL: without an 'error'
 *   listener the HTTP server never binds, yet cron jobs keep scraping and the
 *   supervisor sees a healthy process. Exiting lets PM2 / Docker restart it.
 */

function describe(err) {
  return err && err.stack ? err.stack : err;
}

function createUncaughtExceptionHandler({ log = console.error, exit = (code) => process.exit(code), defer = setImmediate, proc = process } = {}) {
  let exiting = false;
  return function onUncaughtException(err) {
    log('[uncaughtException] fatal, exiting so the supervisor restarts the process:', describe(err));
    if (exiting) return;
    exiting = true;
    proc.exitCode = 1;
    defer(() => exit(1));
  };
}

function createUnhandledRejectionHandler({ log = console.error } = {}) {
  return function onUnhandledRejection(reason) {
    // Client disconnects abort in-flight fetches; those rejections are expected and
    // would otherwise spam the log with AbortError stack traces.
    if (reason && (reason.name === 'AbortError' || reason.__expected)) return;
    log('[unhandledRejection]', describe(reason));
  };
}

function createServerErrorHandler({ port, host, log = console.error, exit = (code) => process.exit(code), proc = process } = {}) {
  return function onServerError(err) {
    const where = host ? `${host}:${port}` : String(port);
    if (err && err.code === 'EADDRINUSE') {
      log(`[FATAL] Port ${where} is already in use; exiting so the supervisor can restart the process.`);
    } else {
      log(`[FATAL] HTTP server error on ${where}; exiting:`, describe(err));
    }
    proc.exitCode = 1;
    exit(1);
  };
}

function installProcessHandlers(opts = {}) {
  const proc = opts.proc || process;
  proc.on('unhandledRejection', createUnhandledRejectionHandler(opts));
  proc.on('uncaughtException', createUncaughtExceptionHandler({ ...opts, proc }));
}

function attachServerErrorHandler(server, opts = {}) {
  server.on('error', createServerErrorHandler(opts));
  return server;
}

module.exports = {
  createUncaughtExceptionHandler,
  createUnhandledRejectionHandler,
  createServerErrorHandler,
  installProcessHandlers,
  attachServerErrorHandler
};
