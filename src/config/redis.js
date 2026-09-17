const Redis = require('ioredis');

// WHY keepAlive IS HERE.
//
// EPIPE on write means we wrote to a socket the other end had already closed.
// It shows up reliably right after a challenge finishes, and the reason is in
// the timing: result cards are drawn with node-canvas, which is SYNCHRONOUS
// C++ work. Two cards block the event loop for the best part of ten seconds,
// and a connection that answers nothing for ten seconds gets cut by the
// provider. The next command then writes into a dead socket.
//
// keepAlive has the OS send TCP probes so an otherwise silent connection is
// not read as abandoned. It reduces the drop; it does not cure the cause,
// which is the blocking render. Nothing is lost when it does happen — ioredis
// queues commands while it reconnects and replays them — so this is noise
// rather than damage, but noise that hides real Redis errors.
const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  keepAlive: 10000,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  reconnectOnError(err) {
    console.log('Redis reconnecting:', err.message);
    return true;
  }
});

redis.on('connect', () => {
  console.log('✅ Redis connected');
});

// A dropped connection is expected and self-healing, so it gets one line
// rather than a stack trace. Anything else still prints in full, because a
// real Redis fault must not be buried under reconnection noise.
const TRANSIENT = new Set(['EPIPE', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']);

redis.on('error', (err) => {
  if (err && TRANSIENT.has(err.code)) {
    console.warn(`⚠️ Redis connection dropped (${err.code}) — reconnecting`);
    return;
  }
  console.error('❌ Redis error:', err);
});

module.exports = redis;