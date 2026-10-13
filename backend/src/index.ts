import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool, initDb } from "./db.js";
import { authRouter, requireAuth } from "./auth.js";

const app = express();
app.use(express.json());

// Sessions are stored in Postgres (table "session"), so they survive backend restarts.
const PgStore = connectPgSimple(session);
app.use(
  session({
    name: "sid",                                   // cookie name
    store: new PgStore({ pool, createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET!,           // signs the cookie
    resave: false,
    saveUninitialized: false,                      // don't create sessions for anonymous visitors
    cookie: {
      httpOnly: true,                              // JS in the browser can't read it (XSS-safe)
      sameSite: "lax",                             // sent on the redirect back from Google
      secure: process.env.NODE_ENV === "production", // HTTPS-only in production
      maxAge: 1000 * 60 * 60 * 24 * 7,             // 7 days
    },
  })
);

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api/auth", authRouter);

// Example protected route: proves the Session -> User chain works.
// Later: Session -> User -> Workspace -> Resource
app.get("/api/workspaces", requireAuth, (req, res) => {
  res.json({ userId: req.session.userId, workspaces: [] });
});

initDb().then(() =>
  app.listen(4000, () => console.log("API listening on :4000"))
);
