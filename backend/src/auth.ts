import { Router, Request, Response, NextFunction } from "express";
import { OAuth2Client } from "google-auth-library";
import crypto from "node:crypto";
import { pool, upsertUser } from "./db.js";

export const authRouter = Router();

const FRONTEND_URL = process.env.FRONTEND_URL!;

// Google client: knows our credentials and where Google should send the user back
const google = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// ---------- Step 1: user clicks "Continue with Google" -> we redirect to Google ----------
authRouter.get("/google", (req, res) => {
  // "state" = random token we remember in the session and check on return (anti-CSRF)
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;

  const url = google.generateAuthUrl({
    scope: ["openid", "email", "profile"],
    state,
    prompt: "select_account",
  });
  // Make sure the session is stored BEFORE the browser leaves for Google
  req.session.save(() => res.redirect(url));
});

// ---------- Step 2: Google sends the user back here with ?code=...&state=... ----------
authRouter.get("/google/callback", async (req, res) => {
  try {
    const { code, state } = req.query as { code?: string; state?: string };

    // Reject if state doesn't match what we stored (forged / stale request)
    if (!code || !state || state !== req.session.oauthState) {
      return res.status(400).send("Invalid OAuth state");
    }

    // Exchange the one-time code for tokens (server-to-server, uses our client secret)
    const { tokens } = await google.getToken(code);

    // Verify the ID token's signature + audience; this proves who the user is
    const ticket = await google.verifyIdToken({
      idToken: tokens.id_token!,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const p = ticket.getPayload()!;
    if (!p.email_verified) return res.status(403).send("Google email not verified");

    // Find or create OUR user (keyed by Google's stable "sub")
    const userId = await upsertUser({
      subject: p.sub,
      email: p.email!,
      name: p.name,
      avatarUrl: p.picture,
    });

    // Fresh session id after login (prevents session fixation), then store the user id
    req.session.regenerate((err) => {
      if (err) return res.status(500).send("Session error");
      req.session.userId = userId;
      req.session.save(() => res.redirect(FRONTEND_URL)); // back to React app
    });
    // NOTE: Google tokens are discarded. Our own session cookie is the long-term login.
  } catch (e) {
    console.error(e);
    res.status(500).send("Google login failed");
  }
});

// ---------- The backend is the authority on "who is logged in" ----------
authRouter.get("/me", async (req, res) => {
  if (!req.session.userId) return res.json({ authenticated: false });
  const { rows } = await pool.query(
    "SELECT id, email, name, avatar_url AS \"avatarUrl\" FROM users WHERE id = $1",
    [req.session.userId]
  );
  if (!rows[0]) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: rows[0] });
});

// ---------- Logout: destroy server-side session + clear cookie ----------
authRouter.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("sid");
    res.json({ ok: true });
  });
});

// ---------- DEV ONLY: log in without Google so you can test in Postman ----------
if (process.env.NODE_ENV !== "production") {
  authRouter.post("/dev-login", async (req, res) => {
    const { email = "dev@example.com", name = "Dev User" } = req.body ?? {};
    const userId = await upsertUser({ subject: `dev-${email}`, email, name });
    req.session.userId = userId;
    req.session.save(() => res.json({ ok: true, userId }));
  });
}

// ---------- Middleware: guard any route that needs a logged-in user ----------
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
  next();
}
