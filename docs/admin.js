// =====================================================================
// admin.js - the "Maintain Users / Goals / Tasks" screens.
//
// Each table is described once in ENTITIES below (its columns, form fields, and how
// to load / save / delete). One generic set of functions then draws the table and
// handles Add (Create), the list itself (Read), Edit (Update) and Delete.
//
//   Create -> "Add" button   -> form dialog -> save()
//   Read   -> table          -> load()
//   Update -> "Edit" button  -> same form, prefilled -> save()
//   Delete -> "Delete" button-> confirmation dialog -> remove()
//
// All data goes through the admin_* SQL functions (supabase/admin.sql), which refuse
// anyone who is not an admin, so these screens are safe even if someone opens the
// page without logging in.
// =====================================================================
import { currentAdmin, signOut, rpc, adminFunction } from './auth.js';

const $ = (id) => document.getElementById(id);

// ---------- Tiny helper for building HTML safely ----------
// h('td', {class: 'x'}, 'text') creates <td class="x">text</td>.
// Text is added as a text node (never as HTML), so a name like "<script>" is just
// shown as text and cannot run code.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);   // onclick -> click
    else if (value === true) el.setAttribute(key, '');                    // boolean attribute
    else if (value !== false && value != null) el.setAttribute(key, value);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

// ---------- The three tables ----------
const ENTITIES = {
  // ===== USERS (the "user" table + the login e-mail from Supabase Auth) =====
  users: {
    title: 'Users',
    singular: 'user',
    // [column heading, function that returns the cell text for a row]
    columns: [
      ['Name', (r) => r.name || '—'],
      ['E-mail', (r) => r.email || '— (phone sign-in)'],
      ['Phone', (r) => r.phone_number],
      ['Role', (r) => (r.is_admin ? 'Admin' : 'User')],
      ['Goals', (r) => r.goal_count],
      ['Tasks', (r) => r.task_count],
    ],
    load: () => rpc('admin_list_users'),
    describe: (r) => r.name || r.phone_number,
    // Form fields. row = null when adding a new user.
    fields(row) {
      // Phone-only app users have no e-mail login, so e-mail/password cannot be changed.
      const hasLogin = !row || Boolean(row.email);
      return [
        { name: 'name', label: 'Name', type: 'text', value: row?.name, autocomplete: 'off' },
        { name: 'phone', label: 'Phone number', type: 'tel', value: row?.phone_number, required: true, autocomplete: 'off' },
        {
          name: 'email', label: 'E-mail (used to sign in)', type: 'email', value: row?.email,
          required: !row, disabled: !hasLogin, autocomplete: 'off',
          hint: hasLogin ? null : 'This user signs in with a phone number, so there is no e-mail login to change.',
        },
        {
          name: 'password', label: row ? 'New password' : 'Password', type: 'password',
          required: !row, disabled: !hasLogin, minlength: 8, autocomplete: 'new-password',
          hint: row ? 'Leave blank to keep the current password.' : 'At least 8 characters.',
        },
      ];
    },
    async save(values, row) {
      if (!row) {
        // New user: the Edge Function creates the login, then the matching row.
        await adminFunction({ action: 'create', email: values.email, password: values.password, name: values.name, phone: values.phone });
        return 'User created.';
      }
      // Existing user: name + phone live in the table...
      await rpc('admin_save_user', { p_id: row.id, p_name: values.name, p_phone: values.phone });
      // ...while e-mail + password belong to the login, so only send what changed.
      const emailChanged = values.email && values.email.toLowerCase() !== (row.email || '').toLowerCase();
      if (emailChanged || values.password) {
        await adminFunction({
          action: 'update', auth_user_id: row.auth_user_id,
          email: emailChanged ? values.email : undefined, password: values.password || undefined,
        });
      }
      return 'User saved.';
    },
    remove: (row) => adminFunction({ action: 'delete', id: row.id }),
  },

  // ===== GOALS =====
  goals: {
    title: 'Goals',
    singular: 'goal',
    columns: [
      ['Goal', (r) => r.goal_name],
      ['User', (r) => r.user_name],
      ['Target date', (r) => r.goal_date || '—'],
      ['Tasks', (r) => r.task_count],
    ],
    load: () => rpc('admin_list_goals'),
    describe: (r) => r.goal_name,
    // The "User" drop-down needs the list of users.
    lookups: async () => ({ users: await rpc('admin_list_users') }),
    fields(row, lookups) {
      return [
        {
          name: 'user_id', label: 'User', type: 'select', required: true,
          options: lookups.users.map((u) => ({ value: u.id, label: u.name || u.phone_number })),
          value: row?.user_id,
          disabled: Boolean(row),                       // a goal's owner is fixed once created
          hint: row ? 'A goal stays with the user who created it.' : null,
        },
        { name: 'name', label: 'Goal', type: 'text', value: row?.goal_name, required: true, autocomplete: 'off' },
        { name: 'date', label: 'Target date (optional)', type: 'date', value: row?.goal_date },
      ];
    },
    async save(values, row) {
      await rpc('admin_save_goal', {
        p_id: row ? row.id : null,
        p_user_id: Number(row ? row.user_id : values.user_id),
        p_name: values.name,
        p_date: values.date || null,
      });
      return row ? 'Goal saved.' : 'Goal created.';
    },
    remove: (row) => rpc('admin_delete_goal', { p_id: row.id }),
    deleteNote: 'Its tasks will be deleted too.',
  },

  // ===== TASKS =====
  tasks: {
    title: 'Tasks',
    singular: 'task',
    columns: [
      ['Task', (r) => r.task_name],
      ['Goal', (r) => r.goal_name],
      ['User', (r) => r.user_name],
      ['Photo needed', (r) => (r.requires_photo ? 'Yes' : 'No')],
      ['Done', (r) => (r.is_completed ? 'Yes' : 'No')],
    ],
    load: () => rpc('admin_list_tasks'),
    describe: (r) => r.task_name,
    // The "Goal" drop-down needs the list of goals.
    lookups: async () => ({ goals: await rpc('admin_list_goals') }),
    fields(row, lookups) {
      const options = lookups.goals.map((g) => ({ value: g.id, label: `${g.goal_name} (${g.user_name})` }));
      // A task the app left "Unassigned" has no goal in the list; keep it selectable.
      if (row && !options.some((o) => o.value === row.goal_id)) {
        options.unshift({ value: row.goal_id, label: `${row.goal_name} (${row.user_name})` });
      }
      return [
        { name: 'goal_id', label: 'Goal', type: 'select', required: true, options, value: row?.goal_id },
        { name: 'name', label: 'Task', type: 'text', value: row?.task_name, required: true, autocomplete: 'off' },
        { name: 'requires_photo', label: 'Requires a photo to finish', type: 'checkbox', value: row?.requires_photo },
        { name: 'is_completed', label: 'Completed', type: 'checkbox', value: row?.is_completed },
      ];
    },
    async save(values, row) {
      await rpc('admin_save_task', {
        p_id: row ? row.id : null,
        p_goal_id: Number(values.goal_id),
        p_name: values.name,
        p_requires_photo: values.requires_photo,
        p_is_completed: values.is_completed,
      });
      return row ? 'Task saved.' : 'Task created.';
    },
    remove: (row) => rpc('admin_delete_task', { p_id: row.id }),
  },
};

// ---------- State ----------
let currentName = 'users';   // which table is showing
let rows = [];               // the rows currently displayed
let editing = null;          // { entity, row, fields } while the form dialog is open
let deleting = null;         // { entity, row } while the delete dialog is open

// ---------- Messages ----------
let messageTimer;
// Show a short message under the tabs. Success messages disappear after a few seconds.
function flash(text, isError = false) {
  const box = $('message');
  box.textContent = text;
  box.classList.toggle('is-error', isError);
  box.hidden = false;
  clearTimeout(messageTimer);
  if (!isError) messageTimer = setTimeout(() => { box.hidden = true; }, 4000);
}

// If the session ended (or the account is not an admin) go back to the landing page.
function handleError(error) {
  if (/Admin access required|JWT|not authenticated/i.test(error.message)) {
    location.replace('./');
    return;
  }
  flash(error.message || 'Something went wrong. Please try again.', true);
}

// ---------- Reading + drawing the table ----------
async function refresh() {
  const entity = ENTITIES[currentName];
  const view = $('view');
  view.setAttribute('aria-busy', 'true');
  try {
    rows = await entity.load();                         // READ
  } catch (error) {
    view.replaceChildren(h('p', { class: 'empty' }, 'Could not load this table.'));
    view.setAttribute('aria-busy', 'false');
    handleError(error);
    return;
  }

  // Header row of the table
  const head = h('tr', {}, ...entity.columns.map(([label]) => h('th', { scope: 'col' }, label)), h('th', { scope: 'col' }, 'Actions'));

  // One <tr> per record, with Edit and Delete buttons
  const body = rows.map((row) => h('tr', {},
    ...entity.columns.map(([, cell]) => h('td', {}, String(cell(row) ?? ''))),
    h('td', { class: 'actions' },
      // aria-label says WHICH record, so screen-reader users hear "Edit Study for exam" not just "Edit"
      h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'aria-label': `Edit ${entity.describe(row)}`, onclick: () => openForm(entity, row) }, 'Edit'),
      h('button', { class: 'btn btn-danger btn-small', type: 'button', 'aria-label': `Delete ${entity.describe(row)}`, onclick: () => openDelete(entity, row) }, 'Delete'),
    ),
  ));

  view.replaceChildren(
    h('div', { class: 'toolbar' },
      h('h2', {}, entity.title),
      h('button', { class: 'btn', type: 'button', onclick: () => openForm(entity, null) }, `Add ${entity.singular}`),   // CREATE
    ),
    rows.length
      ? h('div', { class: 'table-wrap' }, h('table', {},
          h('caption', {}, `${rows.length} ${rows.length === 1 ? entity.singular : entity.title.toLowerCase()}`),
          h('thead', {}, head), h('tbody', {}, body)))
      : h('p', { class: 'empty' }, `No ${entity.title.toLowerCase()} yet. Use “Add ${entity.singular}” to create one.`),
  );
  view.setAttribute('aria-busy', 'false');
}

// Switch tables based on the address (#users / #goals / #tasks).
function route() {
  const wanted = location.hash.replace('#', '');
  currentName = ENTITIES[wanted] ? wanted : 'users';
  for (const name of Object.keys(ENTITIES)) {
    const tab = $(`tab-${name}`);
    if (name === currentName) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  $('message').hidden = true;
  refresh();
}

// ---------- Add / Edit form ----------
// Builds one form control from a field description.
function buildField(field) {
  const id = `field-${field.name}`;
  if (field.type === 'checkbox') {
    return h('div', { class: 'field check' },
      h('input', { id, name: field.name, type: 'checkbox', checked: Boolean(field.value) }),
      h('label', { for: id }, field.label));
  }
  let control;
  if (field.type === 'select') {
    control = h('select', { id, name: field.name, required: field.required, disabled: field.disabled },
      h('option', { value: '' }, 'Choose…'),
      ...field.options.map((o) => h('option', { value: String(o.value), selected: String(o.value) === String(field.value) }, o.label)));
  } else {
    control = h('input', {
      id, name: field.name, type: field.type, required: field.required, disabled: field.disabled,
      minlength: field.minlength, autocomplete: field.autocomplete, value: field.value ?? '',
    });
  }
  return h('div', { class: 'field' },
    h('label', { for: id }, field.label), control,
    field.hint ? h('p', { class: 'hint', id: `${id}-hint` }, field.hint) : null);
}

// Open the dialog. row = null means "add", otherwise "edit that row".
async function openForm(entity, row) {
  $('form-error').hidden = true;
  let lookups = {};
  try {
    if (entity.lookups) lookups = await entity.lookups();   // e.g. the list of users for the goal form
  } catch (error) { handleError(error); return; }

  const fields = entity.fields(row, lookups);
  editing = { entity, row, fields };
  $('form-title').textContent = `${row ? 'Edit' : 'Add'} ${entity.singular}`;
  $('form-fields').replaceChildren(...fields.map(buildField));
  $('form-dialog').showModal();
  $('form-fields').querySelector('input:not([disabled]), select:not([disabled])')?.focus();
}

// Pull the typed values out of the form.
function readValues(fields, form) {
  const values = {};
  for (const field of fields) {
    const el = form.elements[field.name];
    if (!el || el.disabled) continue;                       // disabled controls are not editable
    values[field.name] = field.type === 'checkbox' ? el.checked
      : field.type === 'password' ? el.value                // never trim passwords
      : el.value.trim();
  }
  return values;
}

// Save (CREATE or UPDATE)
$('record-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;                       // browser shows which field is missing
  const save = $('form-save');
  save.disabled = true;                                     // stop double submits
  $('form-error').hidden = true;
  try {
    const message = await editing.entity.save(readValues(editing.fields, form), editing.row);
    $('form-dialog').close();
    flash(message);
    await refresh();
  } catch (error) {
    $('form-error').textContent = error.message || 'Could not save. Please try again.';
    $('form-error').hidden = false;
  } finally {
    save.disabled = false;
  }
});
$('form-cancel').addEventListener('click', () => $('form-dialog').close());

// ---------- Delete ----------
function openDelete(entity, row) {
  deleting = { entity, row };
  $('delete-error').hidden = true;
  $('delete-text').textContent =
    `“${entity.describe(row)}” will be deleted permanently. ${entity.deleteNote || ''} This cannot be undone.`
      .replace('  ', ' ');
  $('delete-dialog').showModal();
  $('delete-cancel').focus();                               // safest default focus
}
$('delete-cancel').addEventListener('click', () => $('delete-dialog').close());
$('delete-confirm').addEventListener('click', async () => {
  const button = $('delete-confirm');
  button.disabled = true;
  try {
    await deleting.entity.remove(deleting.row);            // DELETE
    $('delete-dialog').close();
    flash('Deleted.');
    await refresh();
  } catch (error) {
    $('delete-error').textContent = error.message || 'Could not delete. Please try again.';
    $('delete-error').hidden = false;
  } finally {
    button.disabled = false;
  }
});

// ---------- Log out ----------
// signOut() removes the cookies; then we return to the landing page, where the
// Maintain buttons are hidden again.
$('logout-button').addEventListener('click', async () => {
  await signOut();
  location.replace('./');
});

// ---------- Start ----------
window.addEventListener('hashchange', route);
(async () => {
  let admin = null;
  try { admin = await currentAdmin(); } catch { /* treated as not signed in */ }
  if (!admin) { location.replace('./'); return; }           // not an admin: back to the landing page
  $('admin-email').textContent = admin.email;
  route();
})();
