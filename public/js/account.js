(async function () {
  const emailBox = document.getElementById('account-email');
  const msg = document.getElementById('msg');

  const signoutBtn = document.getElementById('signout');

  const form = document.getElementById('pw-form');
  const currentEl = document.getElementById('current');
  const nextEl = document.getElementById('next');
  const pwBtn = document.getElementById('pw-btn');

  // Optional preference controls (only used if present in the DOM)
  const prefTruckType = document.getElementById('pref-truck-type');
  const prefFuelType = document.getElementById('pref-fuel-type');
  const prefMpg = document.getElementById('pref-mpg');
  const prefThreshold = document.getElementById('pref-threshold');
  const prefTarget = document.getElementById('pref-target');
  const prefSave = document.getElementById('pref-save');
  const prefMsg = document.getElementById('pref-msg');

  function setMessage(text, type = 'info') {
    msg.textContent = text || '';
    msg.style.color =
      type === 'error' ? '#f87171' :
      type === 'success' ? '#4ade80' :
      '#cbd5e1';
  }

  function setPrefMessage(text, type = 'info') {
    if (!prefMsg) return;
    prefMsg.textContent = text || '';
    prefMsg.style.color =
      type === 'error' ? '#f87171' :
      type === 'success' ? '#4ade80' :
      '#cbd5e1';
  }

  async function getMe() {
    const res = await fetch('/api/auth/me', { headers: { Accept: 'application/json' } });
    const data = await res.json().catch(() => ({}));
    return data?.user || null;
  }

  async function loadAccount() {
  const res = await fetch('/api/auth/me', { credentials: 'include' });
  const data = await res.json();

  if (!data.user) {
    window.location.href = '/auth.html?returnUrl=' + encodeURIComponent('/account.html');
    return;
  }

  const adminLink = document.getElementById('admin-link');
  if (adminLink && data.user.is_admin) {
    adminLink.style.display = 'inline-flex';
  }
}

  const me = await getMe();
  if (!me) {
    window.location.href = `/auth.html?returnUrl=${encodeURIComponent('/account.html')}`;
    return;
  }

  emailBox.innerHTML = `Signed in as <strong>${me.email}</strong>`;

  const adminLink = document.getElementById('admin-link');
    if (adminLink && me.is_admin) {
      adminLink.style.display = 'inline-flex';
    }

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

  /* ------------------------------ Preferences ------------------------------ */

  async function loadPreferences() {
    if (!prefSave) return; // only do prefs if UI exists

    setPrefMessage('');

    try {
      const res = await fetch('/api/preferences', { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        setPrefMessage('Could not load preferences.', 'error');
        return;
      }

      const prefs = await res.json().catch(() => ({}));

      if (prefTruckType) prefTruckType.value = prefs.truck_type || '';
      if (prefFuelType) prefFuelType.value = prefs.fuel_type || '';
      if (prefMpg) prefMpg.value = prefs.default_mpg ?? '';
      if (prefThreshold) prefThreshold.value = prefs.fair_load_score_threshold ?? 75;
      if (prefTarget) prefTarget.value = prefs.target_net_per_mile ?? 2.0;
    } catch (e) {
      setPrefMessage('Network error loading preferences.', 'error');
    }
  }

  async function savePreferences() {
    if (!prefSave) return;

    setPrefMessage('');

    const payload = {
      truck_type: prefTruckType ? prefTruckType.value : '',
      fuel_type: prefFuelType ? prefFuelType.value : '',
      default_mpg: prefMpg ? Number(prefMpg.value) : undefined,
      fair_load_score_threshold: prefThreshold ? Number(prefThreshold.value) : undefined,
      target_net_per_mile: prefTarget ? Number(prefTarget.value) : undefined,
    };

    prefSave.disabled = true;
    const oldText = prefSave.textContent;
    prefSave.textContent = 'Saving...';

    try {
      const res = await fetch('/api/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPrefMessage('Could not save preferences.', 'error');
        return;
      }

      setPrefMessage('Preferences saved.', 'success');
      // If API returns normalized values, rehydrate UI
      const prefs = data?.preferences;
      if (prefs) {
        if (prefTruckType) prefTruckType.value = prefs.truck_type || '';
        if (prefFuelType) prefFuelType.value = prefs.fuel_type || '';
        if (prefMpg) prefMpg.value = prefs.default_mpg ?? '';
        if (prefThreshold) prefThreshold.value = prefs.fair_load_score_threshold ?? 75;
        if (prefTarget) prefTarget.value = prefs.target_net_per_mile ?? 2.0;
      }
    } catch (e) {
      setPrefMessage('Network error saving preferences.', 'error');
    } finally {
      prefSave.disabled = false;
      prefSave.textContent = oldText;
    }
  }

  if (prefSave) {
    await loadPreferences();
    prefSave.addEventListener('click', (e) => {
      e.preventDefault();
      savePreferences();
    });
  }
})();