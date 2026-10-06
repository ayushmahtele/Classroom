// Password panel for "My Profile" (students, teachers) and "My Info" (college
// and global admins).
//  * Change password: current password + new + confirm.
//  * "Forgot your current password?": a 6-digit code is emailed to the
//    account's own email; code + new + confirm — no current password needed.
// Needs js/api.js.
function renderPasswordPanel(box, { email } = {}) {
  const e = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  box.innerHTML = `
    <h3 style="margin-top:0">Password</h3>

    <div data-mode="change">
      <form class="pw-form" data-form="change" novalidate>
        <label>Current password</label>
        <input type="password" name="current" autocomplete="current-password" />
        <label>New password</label>
        <input type="password" name="new" minlength="6" autocomplete="new-password" />
        <label>Confirm new password</label>
        <input type="password" name="confirm" minlength="6" autocomplete="new-password" />
        <div class="row" style="margin-top:14px"><button class="btn" type="submit">Change password</button></div>
        <div class="error-msg" data-msg="change" role="status"></div>
      </form>
      <p class="pw-switch">Forgot your current password?
        <button type="button" class="pw-link" data-act="forgot">Reset it with an email code</button></p>
    </div>

    <div data-mode="code" hidden>
      <div class="pw-code-box">
        <p class="pw-explain">We'll email a 6-digit code to <b>${e(email || 'your email')}</b>.
          Enter it below with your new password — your current password isn't needed.</p>
        <button class="btn" type="button" data-act="send">Send code</button>
      </div>
      <form class="pw-form" data-form="code" hidden novalidate>
        <label>6-digit code from the email</label>
        <input type="text" name="code" class="pw-code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••" />
        <label>New password</label>
        <input type="password" name="new" minlength="6" autocomplete="new-password" />
        <label>Confirm new password</label>
        <input type="password" name="confirm" minlength="6" autocomplete="new-password" />
        <div class="row" style="margin-top:14px"><button class="btn" type="submit">Save new password</button></div>
      </form>
      <div class="error-msg" data-msg="code" role="status"></div>
      <p class="pw-switch">
        <button type="button" class="pw-link" data-act="resend" hidden disabled>Resend code</button>
        <button type="button" class="pw-link muted" data-act="cancel">Cancel — I remember my password</button>
      </p>
    </div>`;

  const $ = (sel) => box.querySelector(sel);
  const changeMode = $('[data-mode="change"]');
  const codeMode = $('[data-mode="code"]');
  const changeForm = $('[data-form="change"]');
  const codeForm = $('[data-form="code"]');
  const codeMsg = $('[data-msg="code"]');
  const sendBtn = $('[data-act="send"]');
  const resendBtn = $('[data-act="resend"]');
  let timer = null;

  const say = (el, text, ok) => { el.style.color = ok ? 'var(--ok)' : ''; el.textContent = text; };

  function showMode(mode) {
    changeMode.hidden = mode !== 'change';
    codeMode.hidden = mode !== 'code';
    if (mode === 'code') {
      $('.pw-code-box').hidden = false;
      codeForm.hidden = true;
      resendBtn.hidden = true;
      say(codeMsg, '');
    } else {
      clearInterval(timer);
    }
  }

  function countdown(sec) {
    clearInterval(timer);
    let left = sec;
    const tick = () => {
      if (left <= 0) { clearInterval(timer); resendBtn.disabled = false; resendBtn.textContent = 'Resend code'; return; }
      resendBtn.disabled = true; resendBtn.textContent = `Resend code in ${left}s`; left--;
    };
    tick();
    timer = setInterval(tick, 1000);
  }

  async function sendCode(btn) {
    say(codeMsg, '');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const r = await api('/auth/me/send-reset-code', { method: 'POST' });
      $('.pw-code-box').hidden = true;
      codeForm.hidden = false;
      resendBtn.hidden = false;
      say(codeMsg, `Code sent to ${r.maskedEmail}. It expires in ${r.expiresInMinutes} minutes.`, true);
      countdown(r.resendAfter || 60);
      codeForm.querySelector('[name=code]').focus();
    } catch (err) {
      say(codeMsg, err.message);
      const m = /wait (\d+)s/.exec(err.message);
      if (btn === resendBtn) {
        if (m) countdown(+m[1]);
        else { resendBtn.disabled = false; resendBtn.textContent = 'Resend code'; }
      }
    } finally {
      if (btn === sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send code'; }
    }
  }

  $('[data-act="forgot"]').addEventListener('click', () => showMode('code'));
  $('[data-act="cancel"]').addEventListener('click', () => showMode('change'));
  sendBtn.addEventListener('click', () => sendCode(sendBtn));
  resendBtn.addEventListener('click', () => sendCode(resendBtn));
  codeForm.querySelector('[name=code]').addEventListener('input', (ev) => { ev.target.value = ev.target.value.replace(/\D/g, '').slice(0, 6); });

  changeForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = $('[data-msg="change"]');
    const cur = changeForm.current.value;
    const nw = changeForm.new.value;
    if (!cur) return say(msg, 'Enter your current password.');
    if (nw.length < 6) return say(msg, 'New password must be at least 6 characters.');
    if (nw !== changeForm.confirm.value) return say(msg, 'New passwords do not match.');
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword: cur, newPassword: nw } });
      changeForm.reset();
      say(msg, 'Password changed.', true);
    } catch (err) { say(msg, err.message); }
  });

  codeForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const code = codeForm.code.value.trim();
    const nw = codeForm.new.value;
    if (code.length !== 6) return say(codeMsg, 'Enter the 6-digit code from the email.');
    if (nw.length < 6) return say(codeMsg, 'New password must be at least 6 characters.');
    if (nw !== codeForm.confirm.value) return say(codeMsg, 'New passwords do not match.');
    const btn = codeForm.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await api('/auth/me/reset-with-code', { method: 'POST', body: { code, newPassword: nw } });
      codeForm.reset();
      showMode('change');
      say($('[data-msg="change"]'), 'Password changed. Use your new password next time you sign in.', true);
    } catch (err) {
      say(codeMsg, err.message);
    } finally { btn.disabled = false; }
  });
}
