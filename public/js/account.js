(async function () {
  const emailBox = document.getElementById('account-email');
  const msg = document.getElementById('msg');

  const signoutBtn = document.getElementById('signout');

  const form = document.getElementById('pw-form');
  const currentEl = document.getElementById('current');
  const nextEl = document.getElementById('next');
  const pwBtn = document.getElementById('pw-btn');

  function setMessage(text, type = 'info') {
    msg.textContent = text || '';
    msg.style.color =
      type === 'error' ? '#f87171' :
      type === 'success' ? '#4ade80' :
      '#cbd5e1';
  }

  async function getMe() {
    const res = await fetch('/api/auth/me', { headers: { Accept: 'application/json' } });
    const data = await res.json().catch(() => ({}));
    return data?.user || null;
  }

  const me = await getMe();
  if (!me) {
    window.location.href = `/auth.html?returnUrl=${encodeURIComponent('/account.html')}`;
    return;
  }

  emailBox.innerHTML = `Signed in as <strong>${me.email}</strong>`;

  signoutBtn.addEventListener('click', async () => {
    try {
      await fetch('/api/auth/signout', { method: 'POST' });
    } finally {
      window.location.href = '/index.html';
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setMessage('');

    const currentPassword = currentEl.value || '';
    const newPassword = nextEl.value || '';

    if (newPassword.length < 8) {
      setMessage('New password must be at least 8 characters.', 'error');
      return;
    }

    pwBtn.disabled = true;
    const oldText = pwBtn.textContent;
    pwBtn.textContent = 'Updating...';

    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const code = data?.error || 'unknown_error';
        const friendly =
          code === 'wrong_password' ? 'Current password is incorrect.' :
          code === 'password_too_short' ? 'New password must be at least 8 characters.' :
          'Could not update password.';
        setMessage(friendly, 'error');
        return;
      }

      currentEl.value = '';
      nextEl.value = '';
      setMessage('Password updated successfully.', 'success');
    } catch {
      setMessage('Network error. Please try again.', 'error');
    } finally {
      pwBtn.disabled = false;
      pwBtn.textContent = oldText;
    }
  });
})();