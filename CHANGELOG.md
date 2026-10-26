# Changelog

The version shown in the app (sidebar on desktop, **More** menu on phones) comes from `package.json`. Bump `version` in `package.json` and add an entry here for every release.

## 1.2.0 — 2026-10-26

- Uploads by site admins and org admins are published right away; only member uploads go to the review queue.
- Thumbnails for every file type: image, video frame, PDF first page, audio cover art, Office documents and text. Existing items get thumbnails when an admin or the uploader opens the library.
- Preview each file (image, video, audio, PDF, text, Office thumbnail or link) before uploading.
- Compact cards: 5 per row on laptops, 3 on phones. The save button fills in when an item is saved.
- Storage and per-type totals moved to a new **Overview** page.
- The desktop sidebar expands on hover and collapses when the pointer leaves.
- Fixed: on phones, the bottom navigation bar disappeared in list view.

## 1.1.0 — 2026-10-21

- Add files and links to an existing upload: contributors can add to their own upload while it is pending or approved, and anyone can add to an approved upload. Each addition is reviewed separately and earns its contributor points.
- Upload many files or links at once, with an optional shared title and description.
- No upload size limit for any file type; `http://` links are accepted.
- Search suggestions in the library.
- Desktop sign-in page shows a short description and feature highlights.
- Uploads continue in the background with a progress tray on every page. Interrupted uploads (tab closed, phone asleep, connection lost) resume automatically from where they stopped; the screen stays awake while uploading.
- Personal Google Drives now use limited access (`drive.file`): VOICE creates its own "VOICE Media" folder on Connect and can only access files it uploads, so no Google app verification is needed. Each Google account can be connected once.
- Privacy Policy and Terms & Conditions pages, linked from sign-in and the app menu.
- Branded loading screen and skeleton placeholders while pages load.
- Points shown next to the profile, slimmer desktop sidebar, new violet "V" logo.
- Tips on the upload page for writing titles and descriptions that help preachers find content.
- Version information shown in the app.

## 1.0.0

- First release: sign-up and sign-in, site admin / org admin / user roles, admin approval for every upload, multiple Google Drives for storage, library with saved items, views, sharing and leaderboard, Vercel hosting.
