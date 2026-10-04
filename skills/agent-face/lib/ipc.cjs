'use strict';
// Client side of the face window's control channel: one JSON line out, one
// JSON line back, over a local pipe or socket.

const net = require('net');

/**
 * Send `message` to the face window at `endpoint`. Resolves with its reply;
 * rejects if nothing is listening (`err.code` is ENOENT or ECONNREFUSED) or
 * it doesn't answer within `timeoutMs`.
 */
function request(endpoint, message, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint);
    let buffer = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };
    const timer = setTimeout(() => {
      const err = new Error('the face window did not answer in time');
      err.code = 'ETIMEDOUT';
      finish(reject, err);
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        finish(resolve, JSON.parse(buffer.slice(0, newline)));
      } catch (e) {
        finish(reject, e);
      }
    });
    socket.on('error', (err) => finish(reject, err));
    socket.on('close', () => finish(reject, Object.assign(new Error('the face window closed the connection'), { code: 'ECONNRESET' })));
  });
}

module.exports = { request };
