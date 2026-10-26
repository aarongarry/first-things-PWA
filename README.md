# First Things

## App Summary

First Things is an app that helps people finish important tasks before getting distracted by their phones. Our main audience is college students who want to make progress on school and personal goals but end up spending more time scrolling than they planned. The app lets users set bigger goals and break them down into smaller tasks for the day. An AI helper named George guides users through setup and helps them choose manageable next steps. As users complete tasks, they earn short breaks to spend on distracting apps. Our current version saves tasks and goals in Supabase so they are still there after a page refresh. Phone verification, George’s responses, photo checks, calendar connections, and app blocking are still simulated in this prototype, but saving and loading task data uses the database.

## ERD

![First Things ERD showing the user, goal, task, and daily tables](docs/erd.png)

## Tech Stack

Font end - HTML, CSS, JS
Backend - Supabase
Databse - Supabase

This tech stack works best for us because we all know and understand HTML CSS and JS. Supabase can do both the backend and the databse so that made things simple and allowed us to focus on the product and not put too much time into development. Supabase could handle most things for us. 

## How to Get It Running

1. **Get a copy of the code.** On this GitHub repository’s page, select **Code → Download ZIP**, then unzip it. You can also clone the repository. Open the project folder in VS Code or another editor.

2. **Check the Supabase configuration.** Open [`docs/supabase-config.js`](docs/supabase-config.js). The team’s project URL and public key are already filled in. To use that project, leave them as they are and make sure `USE_SUPABASE` is `true`.

   To use your own Supabase project instead, run all of [`supabase/setup.sql`](supabase/setup.sql) in that project’s **SQL Editor**. Wait for the success message, then go to **Authentication → Sign In / Providers**, turn on **Allow anonymous sign-ins**, and click **Save changes**. Copy the project URL and publishable key from the project overview into these lines:

   ```js
   export const SUPABASE_URL = "YOUR_PROJECT_URL";
   export const SUPABASE_KEY = "YOUR_PUBLISHABLE_OR_ANON_KEY";
   export const USE_SUPABASE = true;
   ```

   Use the publishable key or legacy anon key, not a secret or service-role key. The setup script creates the ERD tables if needed and installs the functions that save and load data. It also sets the database permissions for this app.

3. **Start a local server.** 
Using liver server, open the index.html file.

4. **Complete the demo setup.** Enter a name and a sample phone number with 10–15 digits. Use **123456** for the confirmation code; no text message is sent. Follow George’s setup prompts, add a goal, choose your preferences, and finish onboarding. The calendar connection can be skipped.

5. **Check the connection.** At the top of the app, wait for **“Saved to Supabase.”** If it says anonymous sign-ins are disabled, enable that setting and click **Retry**. If it says `first_things_load` is missing, run the full setup SQL and retry.

## Verifying the Vertical Slice

Our vertical slice is **adding a task and keeping it after a page refresh**.

1. Finish onboarding and open the **Today** screen.
2. Click the **+** button next to **Today’s list**.
3. Enter a recognizable task name.
4. Confirm that the task appears in the list and wait for **“Saved to Supabase.”**
5. Refresh the browser. The same task should still appear.
6. Check off the task, wait for the saved message again, and refresh once more. It should still be marked completed.


For a before-and-after comparison, set `USE_SUPABASE` to `false`, save the file, and refresh. Add a new task and refresh again: the task disappears. Set the switch back to `true` and refresh to load the database tasks again.
