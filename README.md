# Tetra Pak Vocabulary Lab

A static English–Vietnamese technical vocabulary trainer for packaging, mechanical, electrical and control systems.

## Project structure

```text
index.html             Main interface
style.css              Presentation and responsive layout
app.js                 Learning logic, local progress and Supabase sync
vocabulary.json        Vocabulary data; edit this file to add terms
SUPABASE_SETUP.sql     Database table and row-level security policies
README.md              Setup and maintenance guide
```

The initial dataset preserves the original 400 entries: 100 terms in each of four categories. The app reads them from `vocabulary.json`; it does not contain a second hard-coded copy.

## 1. Publish with GitHub Pages

1. Create a GitHub repository, for example `tetrapak-vocabulary-lab`.
2. Upload **the contents of this project folder** to the repository root. `index.html`, `app.js`, `style.css` and `vocabulary.json` must be beside one another.
3. Open the repository's **Settings → Pages**.
4. Under **Build and deployment**, select **Deploy from a branch**.
5. Select the `main` branch and `/(root)`, then save.
6. Open the published URL shown in the Pages settings. A project site commonly has the form `https://YOUR-USERNAME.github.io/REPOSITORY-NAME/`.

The app uses relative paths (`./app.js`, `./style.css`, `./vocabulary.json`) so it works under a project-site subpath. GitHub Pages publishes the contents of the selected branch/folder; each commit to that source updates the site.

Official guide: https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site

## 2. Configure Supabase cloud progress

The app uses your existing Supabase project and the `public.vocab_progress` table.

1. Open the Supabase project and go to **SQL Editor**.
2. Run the contents of `SUPABASE_SETUP.sql`. The script creates the table, enables Row Level Security (RLS), and creates policies so each signed-in user can access only their own row.
3. In your Supabase project, copy the **Project URL** and the **Publishable key**. Use the publishable key (typically starts with `sb_publishable_`). A legacy `anon` key can work, but Supabase recommends moving to publishable keys.
4. Open the deployed vocabulary app, go to **My progress → Cloud sync**, paste the Project URL and publishable key, then click **Save connection**.
5. Create an account or log in. If email confirmation is enabled, confirm the message sent by Supabase before logging in.
6. In Supabase Auth URL configuration, set the Site URL to the deployed GitHub Pages URL. Add that URL to the redirect allow-list if your Auth configuration requires it.

**Key security:** a publishable key is intended for browser apps and is not a password. RLS policies are what restrict user data. Never paste a Supabase `secret` or legacy `service_role` key into this website, `app.js`, GitHub, or a browser. Do not disable RLS on `vocab_progress`.

Supabase references:
- API key guidance: https://supabase.com/docs/guides/getting-started/api-keys
- Row Level Security: https://supabase.com/docs/guides/database/postgres/row-level-security
- Auth: https://supabase.com/docs/guides/auth

## 3. Add vocabulary later

Edit only `vocabulary.json` for ordinary vocabulary additions. Keep the JSON valid, then commit the updated file to GitHub. GitHub Pages will publish the change.

Each term must have these fields:

```json
{
  "id": "TP-PNE-001",
  "en": "Pneumatic fitting",
  "vi": "Đầu nối khí nén",
  "category": "Pneumatic"
}
```

Required fields:

| Field | Purpose | Rule |
|---|---|---|
| `id` | Permanent identifier | Unique; never change or reuse it after publishing |
| `en` | English term | Non-empty string |
| `vi` | Vietnamese meaning | Non-empty string |
| `category` | Category/filter | Non-empty string; new categories appear automatically |

Optional fields may be added when reliable information is available: `subcategory`, `pronunciation`, `definition`, `example`, `difficulty`, `source`, and `dateAdded`. The current interface displays the English term, Vietnamese meaning and category; the extra fields provide room for future features.

For new entries, use an ID prefix that identifies the category or topic (for example `TP-PNE-001` for Pneumatic, `TP-SAF-001` for Safety, or `TP-PKG-001` for Packaging). Choose the next unused number for that prefix. Do not generate IDs from array position or row number. Do not renumber existing entries.

The existing 400 entries retain a `legacyId` field solely for migrating progress from the previous numeric-ID version. Do not edit or reuse those values. New entries do not need a `legacyId`.

Example: append a new object inside the `terms` array, add a comma after the previous object, and increment `datasetVersion` near the top of the file.

## 4. Progress and backups

- Progress is saved locally in the current browser first.
- When signed in to Supabase, progress is synchronized to that user's cloud row.
- The **Export progress** button downloads a JSON backup.
- **Import progress** can restore a backup. It also maps the previous trainer's numeric IDs to the permanent IDs in the current dataset when possible.
- Cloud records created by the previous numeric-ID version are migrated when the app loads them and then saved back using permanent IDs.

A GitHub Pages site is public on the internet. Do not put confidential factory information, internal manuals, private machine settings, personal data, or proprietary company material into `vocabulary.json` or any other published file.

## 5. Data validation notes

- `vocabulary.json` must be valid UTF-8 JSON with a top-level `terms` array.
- Every term must have a unique `id`, plus `en`, `vi`, and `category`.
- Keep the data file and app files in the same published folder.
- The browser needs an internet connection to load the app files, fetch the vocabulary dataset on a fresh page load, and use Supabase cloud sync. Learning progress is retained in local storage on that browser, but the app is not configured as an offline-first installable PWA.

This is an independent study aid. It is not an official Tetra Pak training resource.
