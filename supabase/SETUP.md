# Supabase + Google OAuth setup for KEAL OS Web Edition

This document connects the optional account, invite, profile, cloud-file, paired-browser relay, and Friends Chat features. You need a Supabase project and a Google OAuth web client. The Supabase project URL and publishable/anon key are public browser configuration values; never put a service-role key, database password, or Google client secret in `web/config.js` or in Git.

## 1. Create the Supabase project

1. Create a new project in the Supabase dashboard.
2. Open **SQL Editor** and run the entire `supabase/schema.sql` file.
3. Confirm the tables and policies were created. The schema is written to be re-runnable for the same project.
4. Ensure the `supabase_realtime` publication is enabled for `public.keal_chat_messages` if the SQL editor reports that it could not add it automatically.

The schema creates:

- `keal_invites`: only SHA-256 email hashes; no client read policy.
- `keal_profiles`: stable Auth user UUID, generated public KEAL ID, unique nickname.
- `keal_chat_messages`: invited-members chat lobby.
- `keal_user_files`, `keal_user_settings`, `keal_installed_apps`: per-account data protected by RLS.
- private Realtime policies for each user's paired-device topic and the invited-member chat channel.

## 2. Configure Google as an Auth provider

1. In Google Cloud Console, create an OAuth client with application type **Web application**.
2. In Supabase **Authentication → Providers → Google**, enable Google and enter the Google OAuth Client ID and Client Secret there.
3. Add Supabase's callback URL shown on that provider page to the Google OAuth client's authorized redirect URIs. It is usually `https://<project-ref>.supabase.co/auth/v1/callback`.
4. In Supabase **Authentication → URL Configuration → Redirect URLs**, add the exact deployed URLs that KEAL may return to after sign-in:
   - `https://USERNAME.github.io/REPOSITORY/`
   - `https://USERNAME.github.io/REPOSITORY/client/`
   - Your Cloudflare/custom-domain root and `/client/` URLs, if used.
5. For a Google Workspace/school account, the organization's administrator may block third-party OAuth apps. Use a personal Google account if the school account denies authorization; do not try to bypass its policy.

Do not set broad wildcard redirects when exact routes are sufficient.

## 3. Add the browser-safe Supabase configuration

Open `web/config.js` and set:

```js
window.KEAL_CONFIG = {
  supabaseUrl: "https://YOUR-PROJECT-REF.supabase.co",
  supabaseAnonKey: "YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY",
  appVersion: "6.1.0"
};
```

The publishable/anon key is designed to be used in a browser. Security comes from Auth and correctly configured RLS, not from hiding that key. Never use the service-role key here.

Then run:

```sh
python scripts/build_web.py
```

Deploy the generated `public/` directory using GitHub Pages or Cloudflare Pages as described in the root README.

## 4. Invite yourself and friends without storing plaintext emails in KEAL

The invite trigger is **invite-only**. A first-time Google Auth account is accepted only if a matching SHA-256 hash exists. The trigger consumes that invite in the same transaction as account creation, so one invite creates one account. Existing accounts can sign in again using their stable Supabase Auth identity without another invite.

On a trusted local computer or Termux, run:

```sh
python scripts/invite_hash.py
```

Enter one email address when prompted. The tool prints an SQL `INSERT` containing only the lowercased email's SHA-256 digest. Copy the generated SQL into the Supabase SQL Editor and run it. Repeat for each invited friend. The entered email is not written to a project file by the helper.

Example of the resulting SQL shape (the hash below is illustrative):

```sql
insert into public.keal_invites(email_hash)
values ('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
on conflict do nothing;
```

The Auth provider itself necessarily stores the Google account's email for sign-in. KEAL's profile and Chat queries do not display or copy that email to other members. Email hashes are still pseudonymous data; keep the invite table private.

## 5. Test account creation

1. Deploy the Web Edition over HTTPS.
2. Open KEAL Account and choose **Continue with Google** using an invited address.
3. The database should create a profile with a generated `KEAL-...` ID and nickname.
4. Sign into the second device with the same Google account. Both clients should share the same account profile and the same private `keal-session:<Auth UUID>` Realtime channel.
5. Open Account on each device and verify the same public KEAL ID appears. Open Friends Chat and send a short test message.
6. Invite a second test account and verify it receives a different KEAL ID and nickname. Its files/settings/app install state must remain separate.

## 6. Security checks

- In Supabase Table Editor, verify RLS is enabled for every `keal_*` user table.
- Confirm there is no policy allowing `anon` to read invites, profiles, chat, files, or settings.
- Keep the service-role key and database credentials out of the repository and client JavaScript.
- Do not store email addresses in nickname, chat, or file metadata.
- The chat lobby is visible to all invited members. It is not a private DM system. Do not post passwords, home addresses, phone numbers, school details, or other sensitive information.
- This prototype has no moderator/admin dashboard, blocking, or reporting UI. Remove invite hashes for unused invitations through the Supabase SQL Editor; removal does not automatically delete an account that has already registered.

## 7. Troubleshooting

- **Google redirects back with an error:** check Google provider credentials, Supabase callback URL, and exact Redirect URLs, including `/client/` if sign-in begins there.
- **Invite rejected:** re-run the hash helper and compare the generated hash with `keal_invites`; email matching is lowercase + trimmed.
- **Account signed in but profile missing:** inspect Auth user creation logs and the `keal_create_profile` trigger. The profile is created by a database trigger when the Auth user is first inserted.
- **Chat loads but does not update live:** confirm `keal_chat_messages` is in `supabase_realtime`, the Realtime service is enabled, and private Realtime policies are present.
- **Remote relay is offline:** sign into the same KEAL account on both devices, ensure both are on the same hosted origin, open the Redmi controller window and Samsung `/client/` tab, and allow Realtime to connect. A browser guest ID alone cannot pair devices.
- **Cloud files fail:** check the `keal_write_file` / `keal_mkdir` functions and RLS policies. File paths and content types are intentionally restricted.
