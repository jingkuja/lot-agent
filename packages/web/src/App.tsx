import { useEffect, useState, useCallback } from "react";
import { Login } from "./components/Login.js";
import { Workspace } from "./pages/Workspace.js";
import { ThemeToggle } from "./components/ThemeToggle.js";
import { api, getToken, clearToken, type User } from "./api/client.js";
import "./App.css";

type View = "loading" | "login" | "ready";

export default function App() {
  const [view, setView] = useState<View>("loading");
  const [user, setUser] = useState<User | null>(null);

  // Authenticated → go straight to the workspace (agents managed inside Workspace).
  const enter = useCallback(async (u: User) => {
    setUser(u);
    setView("ready");
  }, []);

  // On mount: validate an existing token if present. With no token, check for
  // debug mode (DEBUG=1) — if on, enter login-less as the debug user.
  useEffect(() => {
    const token = getToken();
    if (!token) {
      api
        .mode()
        .then((m) => {
          if (m.debug && m.user) enter(m.user);
          else setView("login");
        })
        .catch(() => setView("login"));
      return;
    }
    api
      .me()
      .then((u) => enter(u))
      .catch(() => {
        clearToken();
        setView("login");
      });
  }, [enter]);

  // Listen for 401 unauthorized events.
  useEffect(() => {
    const handler = () => {
      setUser(null);
      setView("login");
    };
    window.addEventListener("lot:unauthorized", handler);
    return () => window.removeEventListener("lot:unauthorized", handler);
  }, []);

  const handleLogin = useCallback((u: User) => enter(u), [enter]);

  const handleLogout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // ignore logout errors
    }
    clearToken();
    setUser(null);
    setView("login");
  }, []);

  let content;
  if (view === "loading") {
    content = (
      <div className="app-loading">
        <span>加载中...</span>
      </div>
    );
  } else if (view === "ready" && user) {
    content = <Workspace user={user} onLogout={handleLogout} />;
  } else {
    content = <Login onLogin={handleLogin} />;
  }

  return (
    <>
      {content}
      <ThemeToggle />
    </>
  );
}
