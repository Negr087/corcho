const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

function allowedEmails() {
  return (process.env.ALLOWED_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
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
        if (!email || !allowedEmails().includes(email)) {
          return done(null, false);
        }
        const user = {
          email,
          name: profile.displayName || email,
          picture: (profile.photos && profile.photos[0] && profile.photos[0].value) || "",
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

module.exports = { passport, configurePassport, ensureAuthApi, ensureAuthPage };
