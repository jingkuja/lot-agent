import { useEffect, useState, useCallback } from "react";
import { Login } from "./components/Login.js";
import { Home } from "./pages/Home.js";
import { Workspace } from "./pages/Workspace.js";
import { api, getToken, clearToken, type User, type Agent } from "./api/client.js";
import "./App.css";

type View = "loading" | "login" | "home" | "workspace";

export default function App() {
  const [view, setView] = useState<View>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);

  // On mount: validate token if present
  useEffect(() => {
    const token = getToken();
    if (!token) {
      setView("login");
      return;
    }
    api.me()
      .then((u) => {
        setUser(u);
        setView("home");
      })
      .catch(() => {
        clearToken();
        setView("login");
      });
  }, []);

  // Listen for 401 unauthorized events
  useEffect(() => {
    const handler = () => {
      setUser(null);
      setSelectedAgent(null);
      setView("login");
    };
    window.addEventListener("lot:unauthorized", handler);
    return () => window.removeEventListener("lot:unauthorized", handler);
  }, []);

  const handleLogin = useCallback((u: User) => {
    setUser(u);
    setView("home");
  }, []);

  const handlePick = useCallback((agent: Agent) => {
    setSelectedAgent(agent);
    setView("workspace");
  }, []);

  const handleBack = useCallback(() => {
    setSelectedAgent(null);
    setView("home");
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // ignore logout errors
    }
    clearToken();
    setUser(null);
    setSelectedAgent(null);
    setView("login");
  }, []);

  if (view === "loading") {
    return (
      <div className="app-loading">
        <span>加载中...</span>
      </div>
    );
  }

  if (view === "login") {
    return <Login onLogin={handleLogin} />;
  }

  if (view === "home" && user) {
    return (
      <div className="app">
        <div className="app-home-header">
          <span className="app-home-brand">Lot Agent</span>
          <div className="app-home-user">
            <span>{user.email}</span>
            <button className="btn-logout" onClick={handleLogout}>退出</button>
          </div>
        </div>
        <Home onPick={handlePick} />
      </div>
    );
  }

  if (view === "workspace" && user && selectedAgent) {
    return (
      <Workspace
        initialAgent={selectedAgent}
        user={user}
        onBack={handleBack}
        onLogout={handleLogout}
      />
    );
  }

  // Fallback: back to login
  return <Login onLogin={handleLogin} />;
}
