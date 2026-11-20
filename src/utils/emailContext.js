// src/utils/emailContext.js
//
// BB-140: request-independent context for outgoing emails. A System Admin test
// send runs the real sender inside withEmailContext({ isTest: true, ... }), so
// every email it produces gets "[TEST]" in the subject and is logged as a test
// with who triggered it, without changing each sender's signature.

const { AsyncLocalStorage } = require("async_hooks");

const store = new AsyncLocalStorage();

function withEmailContext(ctx, fn) {
  return store.run({ ...(store.getStore() || {}), ...ctx }, fn);
}

function emailContext() {
  return store.getStore() || {};
}

module.exports = { withEmailContext, emailContext };
