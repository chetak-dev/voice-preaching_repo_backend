# Changelog

The version shown in the app (sidebar on desktop, **More** menu on phones) comes from `package.json`. Bump `version` in `package.json` and add an entry here for every release.

## 1.7.16

- The searching spinner stays centred in the search box instead of slipping down while you type.

## 1.7.15

- View counts now count every time content is opened, not just once per member. Existing views are kept.

## 1.7.14

- Shared-link page invites visitors to explore the whole Kalpa Taru library.

## 1.7.13

- The logo now reads "Spiritual Content Hub" under Kalpa Taru, spread to the same width as the name.

## 1.7.12

- Share to Kalpa Taru from other apps on Android: once the app is installed, pick Kalpa Taru in any app's share menu and the shared files or links open on the Contribute page, ready for a title and description.

## 1.7.11

- Uploads can be cancelled after they start: **Cancel** on the Contribute page, an ? on each item, and **Cancel** / ? in the upload tray. Anything already sent is discarded and nothing appears in the library.

## 1.7.10

- Phones: the sort box (**Newest**) is no longer cut off in the library toolbar.
- List view: type badge on the left and share/save/remove buttons at the bottom right of each row.

## 1.7.9

- Removed the **Continue listening** card from the top of the library.

## 1.7.8

- Shared links: anyone can view **and download** approved public content without an account. Private and pending content stays protected.
- Duplicates: site admins can select several copies (or **Select all extra copies**) and remove them at once.
- Phones: full-width search with fully visible suggestions; type, sort and list/grid sit in one row below it.
- Edit your name from the profile menu (or the pencil in **More** on phones); every card shows the new name.
- Faster search (parallel queries, caching, an index). Choose **Title & description** (default) or **Inside files too**.
- Slides now preview with real layout and colours, in the correct order, skipping hidden slides.
## 1.7.7

- New site-admin-only **Duplicates** page listing uploads that share the same file or link, with preview and remove.
- Contribute: **Put everything in one card** switch uploads several files/links as a single card (first item is the cover).
- Preview: **Choose files** lets people download only the files they need from a card.
- Admins can **Merge cards**: move separately uploaded cards (and their files) into one card. Uploaders are notified.

## 1.7.6

- Edit details now shows only title and description (existing tags are kept).

## 1.7.5

- Duplicate warning before upload: if a file or link is already in Kalpa Taru, a prompt lists the duplicates before anything is sent, with **Remove** or **Upload anyway**. Submitting waits for the check to finish so the warning is never skipped.
- Duplicate warning in the review queue: matching submissions show a "Possible duplicate" note linking to the existing item, and Approve (single or bulk) asks for confirmation first.
- Fixed the duplicate note on the upload form showing question marks instead of quotes.

## 1.7.4

- Storage: "Files stored" now opens a list of everything on that Drive, including items the library hides (pending, rejected, private and added files). Each can be removed, so a Drive can be emptied and then deleted.
- Items on a disconnected Drive can now be removed (the record is removed; the file stays in that Drive).
- Upload form simplified to title and description only; the tags panel and the storage destination dropdown are gone (uploads go to storage automatically).
- Phone More menu: close button, Back button closes it, page behind no longer scrolls, and it shows as a centred panel on tablets and landscape screens.
- Members page is responsive: cards on phones and tablets, the table on larger screens.

## 1.7.3

- Storage: every Drive now shows a delete icon. It only works when no items are stored on that Drive; otherwise it is greyed out and explains why. Removing asks for confirmation in a dialog.

## 1.7.2

- Profile menu and Sign out moved to the top right. On desktop, a top bar shows points, notifications and the profile menu (name, email, role, theme, Sign out); on phones the avatar at the top right opens the same menu.

## 1.7.1

- Removed the Filters button from the library. Tapping a tag in a preview still filters the library, with a Clear button.

## 1.7.0

- Tags: language, speaker, Gita verses and topics on uploads and in **Edit**; verses in titles are detected automatically.
- Library filters (language, chapter, speaker, topic), clickable tags, and paging (24 at a time with infinite scroll).
- Search inside PDFs, Office and text documents, with matching snippets.
- Duplicate warnings for files and links already in the library.
- Content requests with upvotes, "Upload for this", and automatic fulfilment on approval.
- In-app notifications with a bell and unread badge.
- Offline downloads for audio and video, and an offline Downloads screen.
- Dark mode (Light / Dark / System).
- Admin analytics on the Overview page.
- Automatic nightly database backups to Google Drive (set `CRON_SECRET`), **Back up now** on Storage, and `npm run restore-backup`.
- More compact desktop sidebar.

## 1.6.0

- Library sorting (Newest, Most viewed, A–Z, Oldest), remembered per device.
- "Recently added" and "Most viewed" rows on the library home once there are 8+ items.
- Bulk reject in the review queue (one shared note for all selected items).
- Admins can edit an item's title and description from its preview.
- Contributors can withdraw their own pending submissions.
- New media player: play button on audio/video cards, custom seek bar, ±15s skip, speed, minimise, and lock-screen / headphone controls.
- Cleaner automatic titles from file names (dates, IDs, IMG/VID/WA prefixes and "(1)" are removed; verse references are kept).
- Installable app (PWA) with an **Install app** button and iPhone instructions.
- Share links (`/s/<id>`) show a rich preview (title, description, thumbnail) in WhatsApp and other apps. Only approved public items are revealed.
- Admin alerts when a Google Drive is 90% full or more.
- Removed leftover "VOICE"/"content hub" wording.

## 1.5.6

- "Kalpa Taru" now uses the Poppins font (replacing Cinzel).

## 1.5.5

- "Kalpa Taru" now uses the classical Cinzel typeface.
- The name and "ISKCON Brahmapur" are smaller, centred next to the logo with a small gap, and the same width as each other.

## 1.5.4

- Refined the logo text: "Kalpa Taru" is a little smaller and less heavy, and "ISKCON Brahmapur" has natural letter spacing instead of stretched spacing. Both lines still match the logo's height and each other's width.

## 1.5.3

- Larger "Kalpa Taru" and "ISKCON Brahmapur" next to the logo, so the two lines fill the logo's height with only a small gap between them.

## 1.5.2

- The two text lines next to the logo now span exactly the logo's height: the top of "Kalpa Taru" lines up with the top of the logo and the bottom of "ISKCON Brahmapur" with its bottom.

## 1.5.1

- The loading screen shows only the Kalpa Taru name.
- "ISKCON Brahmapur" sits under the name as a small, spaced capital line that is exactly as wide as the name, so it lines up with the logo.

## 1.5.0 — 2026-10-27

- Google Drive uploads are now sorted into **Images**, **Videos**, **Audios** and **Documents** subfolders inside the app's Drive folder (**VOICE Media** or **Kalpa Taru Media**). Each subfolder is created automatically the first time that type is uploaded. Files uploaded earlier stay where they are and keep working. If a subfolder can't be prepared, the upload goes into the main folder instead of failing.

## 1.4.0 — 2026-10-27

- **Removing content is now site-admin only and deliberate.** Members and org admins can no longer delete anything, including their own pending submissions. A site admin must write a reason (at least 5 characters) and type REMOVE to confirm. The reason is saved in the activity log.
- **Storage info is for admins only.** The Overview page (storage use and sizes by type) is hidden from members, and the server no longer sends storage figures or sizes to them.
- **Sign out is a proper button** in the desktop sidebar and the phone menu.
- "ISKCON Brahmapur" appears under the Kalpa Taru name (sidebar, phone header, sign-in page, loading screen), and "Made with ❤ by ISKCON Brahmapur" sits above the Privacy and Terms links.
- Content cards show the upload time only on wide screens, so the uploader name has room.

## 1.3.1 — 2026-10-27

- Content cards: the view count, share and save buttons now sit together, smaller, on the bottom line, so the title gets the full card width.

## 1.3.0 — 2026-10-27

- Renamed the app to **Kalpa Taru**, with a new wish-fulfilling tree logo (app icon, favicon, sign-in page, sidebar, loading screen). The "Content Hub" tagline is removed; the app is simply Kalpa Taru.
- Newly connected Google Drives get a **Kalpa Taru Media** folder. Drives connected earlier keep using their **VOICE Media** folder, including after a reconnect.

## 1.2.2 — 2026-10-26

- Phones show 2 cards per row, with the type label, share button and view count visible again.

## 1.2.1 — 2026-10-26

- Full preview before download: PDFs show every page (also on phones), Word documents show their text, PowerPoint shows each slide, Excel shows each sheet as a table, text files show their content, and videos, audio and YouTube links play inside the preview.
- Removed the preview from the upload screen; files waiting to upload still show a small thumbnail.

## 1.2.0 — 2026-10-26

- Uploads by site admins and org admins are published right away; only member uploads go to the review queue.
- Thumbnails for every file type: image, video frame, PDF first page, audio cover art, Office documents and text. Existing items get thumbnails when an admin or the uploader opens the library.
- Preview each file (image, video, audio, PDF, text, Office thumbnail or link) before uploading.
- Compact cards: 5 per row on laptops, 3 on phones (2 from 1.2.2). The save button fills in when an item is saved.
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
