import { useEffect, useState } from "react";

// Baked in at build time (see Dockerfile.frontend / docker-compose.yml).
// In Kubernetes the Ingress makes /api same-origin, so this defaults to "/api".
const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";

export default function App() {
  const [items, setItems] = useState([]);
  const [name, setName] = useState("");
  const [error, setError] = useState(null);

  async function loadItems() {
    try {
      const res = await fetch(`${API_BASE}/items`);
      if (!res.ok) throw new Error(`GET /items failed: ${res.status}`);
      setItems(await res.json());
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    loadItems();
  }, []);

  async function addItem(e) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const res = await fetch(`${API_BASE}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(`POST /items failed: ${res.status}`);
      setName("");
      await loadItems();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: 480, margin: "40px auto" }}>
      <h1>Node + React + Postgres</h1>
      <p>
        API base: <code>{API_BASE}</code>
      </p>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      <form onSubmit={addItem} style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New item name"
          style={{ flex: 1, padding: 8 }}
        />
        <button type="submit">Add</button>
      </form>
      <ul>
        {items.map((item) => (
          <li key={item.id}>{item.name}</li>
        ))}
      </ul>
    </div>
  );
}
