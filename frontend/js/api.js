// Point this at your deployed backend URL if the frontend is hosted
// separately (e.g. on Vercel while the backend runs on Render).
// Leave as '' when frontend + backend are served by the same Express app.
window.API_BASE = '';

const Session = {
  get token() { return localStorage.getItem('pq_token'); },
  set token(v) { v ? localStorage.setItem('pq_token', v) : localStorage.removeItem('pq_token'); },
  get user() {
    try { return JSON.parse(localStorage.getItem('pq_user') || 'null'); } catch { return null; }
  },
  set user(v) { v ? localStorage.setItem('pq_user', JSON.stringify(v)) : localStorage.removeItem('pq_user'); },
  clear() { this.token = null; this.user = null; },
  requireRole(role) {
    const u = this.user;
    if (!this.token || !u || u.role !== role) {
      window.location.href = 'index.html';
      return null;
    }
    return u;
  }
};

async function api(path, { method = 'GET', body, isForm = false } = {}) {
  const headers = {};
  if (Session.token) headers['Authorization'] = `Bearer ${Session.token}`;
  if (!isForm) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${window.API_BASE}/api${path}`, {
    method,
    headers,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined
  });

  let data = null;
  try { data = await res.json(); } catch { /* no body */ }

  if (!res.ok) {
    // 401 on a normal request = expired session -> back to login.
    // But a wrong password on the login form is also a 401 and must NOT
    // reload the page, otherwise the error message never gets shown.
    if (res.status === 401 && !path.startsWith('/auth/login')) {
      Session.clear();
      window.location.href = 'index.html';
    }
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data;
}

function logout() {
  Session.clear();
  window.location.href = 'index.html';
}

function fmtDate(d) {
  if (!d) return '-';
  return new Date(d).toLocaleString();
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
