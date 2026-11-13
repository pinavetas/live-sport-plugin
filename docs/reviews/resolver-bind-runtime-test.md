# PR #58 — real listener verification

Base stable: 50611f7157571878e70582da310bbf2a8e538ed7, rechecked October 26, 2026.
Original Draft #58 head: de59dcacebee57b26747d440307ee26f96fe944d.
This follow-up updates that existing Draft; no deployment is performed.

The original fix defaults the standalone resolver to 127.0.0.1 while retaining
explicit HOST overrides. Its final test only searched the server source for
the listen() call. That assertion could not establish the actual bind address.

The replacement executes the real resolver server entrypoint through a Node
ESM fixture with real node:http createServer/listen and the actual env.js HOST
selection. Only the port is supplied as 0, and the provider router is replaced
with a status-only handler. Provider modules are not imported and no external
network request is made.

Four runtime cases inspect server.address(), receive HTTP 200 over loopback,
and verify the server closes: absent, empty and whitespace HOST bind to
127.0.0.1; explicit HOST=0.0.0.0 is respected. The wildcard test serves only
the empty fixture response on an ephemeral port and is immediately closed.

11 tests passed in resolverBindHost.test.js, normal process exit: seven
configuration cases plus four actual-listener cases. IPv6/LAN overrides are
configuration checks; real socket checks in this block cover IPv4 only.
No further production-source change beyond the original #58 fix was needed.

This is not a full provider-router/production startup test, PM2 deployment,
network-firewall assessment or full CI/build. Zero Bandwidth Bleed is unchanged.
