import { useEffect, useState, useCallback } from "react";
import { Login } from "./components/Login.js";
import { ProductShell } from "./shell/ProductShell.js";
import { ThemeToggle } from "./components/ThemeToggle.js";
import { Titlebar } from "./components/Titlebar.js";
import { DownloadToast } from "./components/DownloadToast.js";
import { api, getToken, setToken, clearToken, type User } from "./api/client.js";
import { readTokenFromUrl, stripTokenFromUrl } from "./lib/url-token.js";
import "./App.css";

type View = "loading" | "login" | "ready";

const AUTO_LOGIN_FAIL = "自动登录失败，请手动登录";

export default function App() {
  const [view, setView] = useState<View>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Authenticated → go straight to the workspace (agents managed inside Workspace).
  const enter = useCallback(async (u: User) => {
    setLoginError(null);
    setUser(u);
    setView("ready");
  }, []);

  // On mount: a `?token=` deep link (tokenhub JWT) always wins — exchange it for
  // a session and enter directly. Otherwise validate an existing token; with no
  // token, check for debug mode (DEBUG=1) and enter login-less as the debug user.
  useEffect(() => {
    const urlToken = readTokenFromUrl(window.location.search);
    if (urlToken) {
      api
        .tokenLogin(urlToken)
        .then((res) => {
          setToken(res.token);
          stripTokenFromUrl();
          enter(res.user);
        })
        .catch(() => {
          stripTokenFromUrl();
          setLoginError(AUTO_LOGIN_FAIL);
          setView("login");
        });
      return;
    }
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
    content = <ProductShell user={user} onLogout={handleLogout} />;
  } else {
    content = <Login onLogin={handleLogin} initialError={loginError} />;
  }

  return (
    <div className="app-shell">
      <Titlebar />
      {content}
      <ThemeToggle />
      <DownloadToast />
    </div>
  );
}
