(function () {
  const params = new URLSearchParams(window.location.search);
  const returnUrl = params.get('returnUrl') || '/index.html';

  const tabSignin = document.getElementById('tab-signin');
  const tabSignup = document.getElementById('tab-signup');
  const form = document.getElementById('auth-form');
  const msg = document.getElementById('msg');

  const emailEl = document.getElementById('email');
  const passEl = document.getElementById('password');
  const confirmWrap = document.getElementById('confirm-wrap');
  const confirmEl = document.getElementById('confirm');
  const submitBtn = document.getElementById('submit-btn');

  const switchText = document.getElementById('switch-text');
  const switchLink = document.getElementById('switch-link');

  let mode = 'signin'; // or 'signup'

  function setMessage(text, type = 'info') {
    msg.textContent = text || '';
    msg.style.color =
      type === 'error' ? '#f87171' :
      type === 'success' ? '#4ade80' :
      '#cbd5e1';
  }

  function setMode(next) {
    mode = next;

    const isSignup = mode === 'signup';
    confirmWrap.style.display = isSignup ? 'block' : 'none';
    submitBtn.textContent = isSignup ? 'Create Account' : 'Sign In';

    // button styling using your existing look
    tabSignin.classList.toggle('active-tab', !isSignup);
    tabSignup.classList.toggle('active-tab', isSignup);

    passEl.autocomplete = isSignup ? 'new-password' : 'current-password';

    switchText.textContent = isSignup ? 'Already have an account?' : 'Don’t have an account?';
    switchLink.textContent = isSignup ? 'Sign in' : 'Sign up';

    setMessage('');
  }

  async function redirectAfterLogin() {
    // reset the analyze gate after signup/signin (optional)
    try { localStorage.setItem('analyzeCount', '0'); } catch {}
    if (returnUrl === '/account.html') {
      window.location.href = '/index.html';
    } else {
      window.location.href = returnUrl;
    }
  }

  tabSignin.addEventListener('click', () => setMode('signin'));
  tabSignup.addEventListener('click', () => setMode('signup'));

  switchLink.addEventListener('click', (e) => {
    e.preventDefault();
    setMode(mode === 'signin' ? 'signup' : 'signin');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setMessage('');

    const email = (emailEl.value || '').trim();
    const password = passEl.value || '';
    const confirm = confirmEl.value || '';

    if (!email || !password) {
      setMessage('Please enter email and password.', 'error');
      return;
    }

    if (mode === 'signup') {
      if (password.length < 8) {
        setMessage('Password must be at least 8 characters.', 'error');
        return;
      }
      if (password !== confirm) {
        setMessage('Passwords do not match.', 'error');
        return;
      }
    }

    submitBtn.disabled = true;
    const oldText = submitBtn.textContent;
    submitBtn.textContent = mode === 'signup' ? 'Creating...' : 'Signing in...';

    try {
      const endpoint = mode === 'signup' ? '/api/auth/signup' : '/api/auth/signin';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const code = data?.error || 'unknown_error';
        const friendly =
          code === 'email_already_exists' ? 'That email is already in use.' :
          code === 'invalid_credentials' ? 'Incorrect email or password.' :
          code === 'password_too_short' ? 'Password must be at least 8 characters.' :
          'Could not continue. Please try again.';
        setMessage(friendly, 'error');
        return;
      }

      setMessage('Success! Redirecting...', 'success');
      setTimeout(redirectAfterLogin, 400);
    } catch (err) {
      setMessage('Network error. Please try again.', 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = oldText;
    }
  });

  // Default mode
  setMode('signin');
})();