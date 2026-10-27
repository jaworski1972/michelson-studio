"use client";
import { useState } from "react";
import { Brand } from "../ui";

export default function LoginForm({ users }) {
  const [user, setUser] = useState(users[0]?.id || "");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user, password }),
    });
    if (r.ok) {
      window.location.href = "/";
    } else {
      setErr("Nieprawidłowe hasło");
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="panel login" onSubmit={submit}>
        <Brand />
        <div className="field">
          <label>Kto się loguje?</label>
          <div className="users">
            {users.map((u) => (
              <button
                type="button"
                key={u.id}
                className={`btn ${user === u.id ? "primary" : ""}`}
                onClick={() => setUser(u.id)}
              >
                {u.name}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label htmlFor="pw">Hasło</label>
          <input id="pw" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button className="btn primary block" disabled={busy || !password}>
          {busy ? <span className="spinner" /> : "Zaloguj"}
        </button>
        <div className="err">{err}</div>
      </form>
    </div>
  );
}
