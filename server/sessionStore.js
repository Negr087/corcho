const session = require("express-session");
const { getSession, setSession, destroySession, pruneExpiredSessions } = require("./db");

const DEFAULT_MAX_AGE = 24 * 60 * 60 * 1000;

class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    const timer = setInterval(() => pruneExpiredSessions(), 60 * 60 * 1000);
    if (timer.unref) timer.unref();
  }

  get(sid, cb) {
    try {
      const row = getSession(sid);
      if (!row) return cb(null, null);
      if (row.expires < Date.now()) {
        destroySession(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.sess));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      const maxAge = sess.cookie && typeof sess.cookie.maxAge === "number" ? sess.cookie.maxAge : DEFAULT_MAX_AGE;
      setSession(sid, JSON.stringify(sess), Date.now() + maxAge);
      cb && cb();
    } catch (err) {
      cb && cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      destroySession(sid);
      cb && cb();
    } catch (err) {
      cb && cb(err);
    }
  }

  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }
}

module.exports = SqliteSessionStore;
