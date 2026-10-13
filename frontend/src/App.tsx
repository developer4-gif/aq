import { useEffect, useState } from "react";

type User = { id: string; name: string; email: string; avatarUrl?: string };

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // On load, ask the BACKEND who we are (frontend never decides on its own)
  useEffect(() => {
    fetch("/api/auth/me", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setUser(d.authenticated ? d.user : null))
      .finally(() => setLoading(false));
  }, []);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    setUser(null);
  };

  if (loading) return <p>Loading…</p>;

  // Not logged in -> full-page navigation to backend, which redirects to Google
  if (!user)
    return (
      <div style={{ padding: 40 }}>
        <h1>Welcome</h1>
        <a href="/api/auth/google"><button>Continue with Google</button></a>
      </div>
    );

  // Logged in (this is where the protected workspace route will go later)
  return (
    <div style={{ padding: 40 }}>
      <h1>Hi {user.name}</h1>
      <p>{user.email}</p>
      <button onClick={logout}>Logout</button>
    </div>
  );
}
