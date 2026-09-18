const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

function allowedEmails() {
  return (process.env.ALLOWED_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// Invitados de solo lectura: ven el corcho de otra persona sin poder
// tocarlo. Formato: READONLY_GUESTS="invitado@mail.com:dueño@mail.com,..."
function readonlyGuestsMap() {
  const map = new Map();
  for (const pair of (process.env.READONLY_GUESTS || "").split(",")) {
    const [guest, owner] = pair.split(":").map((s) => (s || "").trim().toLowerCase());
    if (guest && owner) map.set(guest, owner);
  }
  return map;
}

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

function configurePassport() {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: `${process.env.APP_URL}/auth/google/callback`,
      },
      (accessToken, refreshToken, profile, done) => {
        const email = ((profile.emails && profile.emails[0] && profile.emails[0].value) || "").toLowerCase();
        const allowed = allowedEmails();
        // Lista vacia = login abierto a cualquier cuenta de Google. Si se
        // quiere volver a restringir, alcanza con setear ALLOWED_EMAILS.
        if (!email || (allowed.length && !allowed.includes(email))) {
          return done(null, false);
        }
        const guestOf = readonlyGuestsMap().get(email);
        const user = {
          email,
          name: profile.displayName || email,
          picture: (profile.photos && profile.photos[0] && profile.photos[0].value) || "",
          boardOwner: guestOf || email,
          readOnly: !!guestOf,
        };
        return done(null, user);
      }
    )
  );
}

function ensureAuthApi(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  res.status(401).json({ error: "no autenticado" });
}

function ensureAuthPage(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  res.redirect("/login");
}

function ensureWriteAccess(req, res, next) {
  if (req.user && req.user.readOnly) {
    return res.status(403).json({ error: "acceso de solo lectura" });
  }
  next();
}

module.exports = {
  passport,
  configurePassport,
  ensureAuthApi,
  ensureAuthPage,
  ensureWriteAccess,
  readonlyGuestsMap,
};
