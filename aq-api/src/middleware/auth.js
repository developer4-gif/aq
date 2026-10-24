/* Authentication seam.

   Every /api/v1 route runs `authenticate(req, res, next)` and may rely on `req.user = { id, name }` afterwards;
   all data access is scoped by req.user.id. Today there is a single built-in local user (id 1).

   To plug in the OAuth app later, pass a different authenticator to createApp({ authenticate }) (see README):
     - read the session cookie / bearer token the OAuth app issued and verify it,
     - map the subject to a row with repo.upsertExternalUser(sub, name, email),
     - set req.user = { id, name } or call next(new HttpError(401, "Sign in required.")).
   Nothing else in the code needs to change. */
export const LOCAL_USER = { id: 1, name: "local" };

export function localAuth(req, _res, next) {
  req.user = LOCAL_USER;
  next();
}
