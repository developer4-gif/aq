# Setup
1. Google Cloud Console -> APIs & Services -> Credentials -> Create OAuth client ID (Web application)
   - Authorized JavaScript origin:  http://localhost:5173
   - Authorized redirect URI:       http://localhost:5173/api/auth/google/callback
2. Put the client id/secret in `.env` (and set a long random SESSION_SECRET)
3. `docker compose up --build`
4. Open http://localhost:5173

# Test with Postman / curl (no Google needed)
- GET  http://localhost:4000/api/health
- GET  http://localhost:4000/api/workspaces            -> 401
- POST http://localhost:4000/api/auth/dev-login        body (JSON): {"email":"a@b.com","name":"Karan"}
- GET  http://localhost:4000/api/auth/me               -> authenticated: true  (Postman keeps the cookie)
- GET  http://localhost:4000/api/workspaces            -> 200
- POST http://localhost:4000/api/auth/logout
