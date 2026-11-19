// =====================================================================
// landing.js - makes the sign-in section of index.html work.
//
// Flow:
//   page loads      -> if a valid admin cookie exists, show the Maintain buttons
//   user submits    -> signIn() -> show the Maintain buttons
//   user clicks Log out -> signOut() (cookies removed) -> hide the buttons again
// =====================================================================
import { currentAdmin, signIn, signOut } from './auth.js';

// Small shortcut for document.getElementById
const $ = (id) => document.getElementById(id);

// Everything that only exists for a signed-in admin.
const MAINTAIN_BUTTONS = ['maintain-users', 'maintain-goals', 'maintain-tasks', 'logout-button'];

// Show or hide the signed-in UI. Pass an admin object ({ email }) or null.
function render(admin) {
  const signedIn = Boolean(admin);
  $('signed-out').hidden = signedIn;   // login form is visible only when signed out
  $('signed-in').hidden = !signedIn;
  // Reveal (or hide again) each maintain button + the logout button.
  for (const id of MAINTAIN_BUTTONS) $(id).hidden = !signedIn;
  $('welcome').textContent = signedIn ? `Signed in as ${admin.email}.` : '';
}

// Show an error under the form (or clear it when message is empty).
function showError(message) {
  const box = $('login-error');
  box.textContent = message || '';
  box.hidden = !message;
}

// ---- Sign in ----
$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();               // stay on the page instead of reloading
  showError('');
  const email = $('user_email').value.trim();
  const password = $('user_password').value;
  if (!email || !password) { showError('Enter your e-mail and password.'); return; }

  const button = $('login-button');
  button.disabled = true;               // prevent double-clicks while we wait
  button.textContent = 'Signing in…';
  try {
    const admin = await signIn(email, password);
    $('user_password').value = '';      // never leave the password sitting in the form
    render(admin);
  } catch (error) {
    showError(error.message || 'Could not sign in. Check your connection and try again.');
  } finally {
    button.disabled = false;
    button.textContent = 'Sign in';
  }
});

// ---- Log out: removes the cookies and hides the buttons ----
$('logout-button').addEventListener('click', async () => {
  await signOut();
  render(null);
  $('user_email').focus();              // put the cursor back in the form
});

// ---- On page load: restore the signed-in state from the cookie, if any ----
currentAdmin().then(render).catch(() => render(null)); // offline or not signed in: show the form
