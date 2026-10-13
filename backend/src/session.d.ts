import "express-session";
declare module "express-session" {
  interface SessionData {
    userId?: string;      // set after successful login = "this browser is logged in as this user"
    oauthState?: string;  // random value to protect the Google redirect from CSRF
  }
}
