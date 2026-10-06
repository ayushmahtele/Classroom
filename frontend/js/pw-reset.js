// "Reset password" panel for My Profile (students, teachers) and My Info
// (college admins and the global admin). Asks only for the new password and
// its confirmation — not the current password. Enter moves to the next box
// and, on the last box, resets the password (see js/enter-next.js).
// Needs js/api.js.
function renderPasswordPanel(box) {
  box.innerHTML = `
    <h3 style="margin-top:0">Reset password</h3>
    <p class="pw-explain">Choose a new password for your account (at least 6 characters). You'll use it the next time you sign in.</p>
    <form class="pw-form" data-enter-next novalidate>
      <label>New password</label>
      <div class="pw-field">
        <input type="password" name="new" minlength="6" autocomplete="new-password" />
        <button type="button" class="pw-show" aria-label="Show password">Show</button>
      </div>
      <label>Confirm new password</label>
      <input type="password" name="confirm" minlength="6" autocomplete="new-password" />
      <div class="row" style="margin-top:14px"><button class="btn" type="submit">Reset password</button></div>
      <div class="error-msg" data-msg role="status"></div>
    </form>`;

  const form = box.querySelector('form');
  const msg = box.querySelector('[data-msg]');
  const say = (text, ok) => { msg.style.color = ok ? 'var(--ok)' : ''; msg.textContent = text; };

  const showBtn = box.querySelector('.pw-show');
  showBtn.addEventListener('click', () => {
    const show = form.new.type === 'password';
    form.new.type = show ? 'text' : 'password';
    form.confirm.type = form.new.type;
    showBtn.textContent = show ? 'Hide' : 'Show';
    showBtn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const nw = form.new.value;
    if (nw.length < 6) { say('New password must be at least 6 characters.'); form.new.focus(); return; }
    if (nw !== form.confirm.value) { say('New passwords do not match.'); form.confirm.focus(); return; }
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Resetting…';
    try {
      await api('/auth/me/reset-password', { method: 'POST', body: { newPassword: nw } });
      form.reset();
      say('Password reset. Use your new password next time you sign in.', true);
    } catch (err) {
      say(err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Reset password';
    }
  });
}
