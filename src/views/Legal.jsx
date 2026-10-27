import React, { useEffect } from 'react';
import { ArrowLeft, FileText, ShieldCheck } from 'lucide-react';
import { Logo, cx } from '../components/ui.jsx';

const UPDATED = 'October 21, 2026';
const CONTACT = import.meta.env.VITE_CONTACT_EMAIL;
const contact = CONTACT
  ? <>email <a className="font-medium text-brand-700 hover:underline" href={`mailto:${CONTACT}`}>{CONTACT}</a></>
  : 'contact a site administrator';

const PRIVACY = [
  ['overview', 'Overview', <>
    <p>Kalpa Taru (“we”, “us”) is a moderated platform where members share lectures, audio, video, documents, images and links with their community. This policy explains what information we collect, why we collect it, and the choices you have.</p>
  </>],
  ['collect', 'Information we collect', <>
    <ul>
      <li><strong>Account details</strong>: your name, email address and role. If you sign up with a password, we store only a secure one-way hash of it. If you use Google sign-in, we receive your name and verified email address from Google.</li>
      <li><strong>Content you submit</strong>: files, links, titles and descriptions, and anything you add to existing uploads.</li>
      <li><strong>Activity</strong>: what you view and save, contribution points, and moderation decisions such as approvals and rejections.</li>
      <li><strong>Technical data</strong>: a session cookie that keeps you signed in, and your IP address, which is used briefly to protect the service from abuse.</li>
    </ul>
  </>],
  ['use', 'How we use your information', <>
    <ul>
      <li>To create and secure your account and keep you signed in.</li>
      <li>To store, review, publish and deliver the content you share.</li>
      <li>To show contributors, view counts and the leaderboard.</li>
      <li>To prevent abuse, investigate problems and keep the platform safe.</li>
      <li>To send important service messages to administrators, such as storage alerts.</li>
    </ul>
    <p>We do not sell your personal information, and we do not use it for advertising.</p>
  </>],
  ['sharing', 'Who can see your content', <>
    <p>Everything you upload is reviewed by a site administrator before it is published. Once approved, public content is visible to other members together with your name, and anyone can open it through a share link. Private content is visible only to you and the administrators. Content that is pending or rejected is never published.</p>
  </>],
  ['providers', 'Service providers', <>
    <p>We rely on a few trusted providers to run Kalpa Taru, and each one processes data only to provide its service:</p>
    <ul>
      <li><strong>Vercel</strong>: website hosting.</li>
      <li><strong>Turso</strong>: database for account and catalogue information.</li>
      <li><strong>Google</strong>: Google sign-in, and Google Drive for storing uploaded files.</li>
    </ul>
    <p>We may also disclose information when the law requires it, or when it is needed to protect the rights and safety of our members.</p>
  </>],
  ['cookies', 'Cookies', <>
    <p>We use one essential, secure, HTTP-only cookie to keep you signed in. We do not use analytics, advertising or tracking cookies.</p>
  </>],
  ['retention', 'Retention and deletion', <>
    <p>We keep your account and content for as long as your account is active. Content you delete is removed from the library and from storage. To delete your account or get a copy of your data, {contact}. We may keep limited records, such as moderation logs, when we need them for security or legal reasons.</p>
  </>],
  ['rights', 'Your choices and rights', <>
    <p>You can ask to access, correct or delete your personal information, or object to how we use it. Depending on where you live, you may have further rights under local data-protection law. To make a request, {contact}.</p>
  </>],
  ['security', 'Security', <>
    <p>Data is sent over HTTPS. Passwords are hashed, storage credentials are encrypted, and files are delivered only after permission checks. No system is completely secure, so please use a strong, unique password.</p>
  </>],
  ['children', 'Children', <>
    <p>Kalpa Taru is not intended for children under 13. If you believe a child has given us personal information, {contact} and we will remove it.</p>
  </>],
  ['changes', 'Changes to this policy', <>
    <p>We may update this policy from time to time. When we do, we will change the date at the top of this page. If the changes are significant, we will let members know.</p>
  </>],
];

const TERMS = [
  ['acceptance', 'Acceptance of these terms', <>
    <p>By creating an account or using Kalpa Taru, you agree to these Terms and to our <a className="font-medium text-brand-700 hover:underline" href="#/privacy">Privacy Policy</a>. If you do not agree, please do not use the service.</p>
  </>],
  ['accounts', 'Your account', <>
    <ul>
      <li>Give accurate information, and keep your password confidential.</li>
      <li>You are responsible for all activity on your account. Tell us promptly if you suspect anyone else has used it.</li>
      <li>Each account is for one person. Administrators may change roles or suspend accounts to keep the community safe.</li>
    </ul>
  </>],
  ['content', 'Your content', <>
    <p>You keep ownership of everything you upload. By submitting content, you give Kalpa Taru a non-exclusive, royalty-free permission to store, copy, display and share it within the platform and through share links, for as long as it stays on Kalpa Taru.</p>
    <p>You confirm that you own the content or have permission to share it, and that sharing it does not violate anyone else’s rights.</p>
  </>],
  ['moderation', 'Review and moderation', <>
    <p>Every submission, including files added to existing uploads, is reviewed by an administrator before it is published. We may approve, reject or remove any content at our discretion, and we do not have to give a reason.</p>
  </>],
  ['conduct', 'Acceptable use', <>
    <p>You agree not to:</p>
    <ul>
      <li>Upload content that infringes copyright or other rights, or that is unlawful, hateful, harassing, sexually explicit or misleading.</li>
      <li>Upload malware or try to disrupt, overload or gain unauthorised access to the service.</li>
      <li>Impersonate others, post spam, or collect other members’ data.</li>
      <li>Manipulate views, points or the leaderboard.</li>
    </ul>
  </>],
  ['points', 'Points and leaderboard', <>
    <p>Contribution points recognise community participation. They have no monetary value and cannot be exchanged. We may adjust them to correct errors or abuse.</p>
  </>],
  ['copyright', 'Copyright concerns', <>
    <p>If you believe content on Kalpa Taru infringes your rights, {contact}. Include a link to the content and details of your claim. We will review the request and remove the content where appropriate.</p>
  </>],
  ['termination', 'Suspension and termination', <>
    <p>You may stop using Kalpa Taru at any time. We may suspend or close accounts that break these Terms or put the community at risk.</p>
  </>],
  ['disclaimer', 'Disclaimers', <>
    <p>Kalpa Taru is provided “as is” and “as available”. We aim to keep it running and your files safe, but we cannot guarantee uninterrupted service, and we are not responsible for content posted by members. Please keep your own copies of important files.</p>
  </>],
  ['liability', 'Limitation of liability', <>
    <p>To the extent the law allows, Kalpa Taru and its administrators are not liable for any indirect, incidental or consequential loss, or for any loss of data, that arises from your use of the service.</p>
  </>],
  ['changes', 'Changes to these terms', <>
    <p>We may update these Terms from time to time. If you continue to use Kalpa Taru after an update, you accept the new Terms. If the changes are significant, we will let members know.</p>
  </>],
  ['contact', 'Contact', <>
    <p>Questions about these Terms? Please {contact}.</p>
  </>],
];

const PAGES = {
  privacy: { title: 'Privacy Policy', icon: ShieldCheck, sections: PRIVACY },
  terms: { title: 'Terms & Conditions', icon: FileText, sections: TERMS },
};

export default function Legal({ page, signedIn }) {
  const { title, icon: Icon, sections } = PAGES[page];
  const other = page === 'privacy' ? 'terms' : 'privacy';
  useEffect(() => { window.scrollTo(0, 0); document.title = `${title} | Kalpa Taru`; return () => { document.title = 'Kalpa Taru'; }; }, [title]);
  const jump = id => event => { event.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="pt-safe sticky top-0 z-30 bg-voice text-white shadow-md">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4 sm:px-6">
          <a href="#/" aria-label="Kalpa Taru home"><Logo size="sm" light /></a>
          <div className="flex-1" />
          <a href={signedIn ? '#/library' : '#/signin'}
            className="inline-flex items-center gap-1.5 rounded-xl bg-white/15 px-3 py-1.5 text-sm font-semibold ring-1 ring-white/25 transition hover:bg-white/25">
            <ArrowLeft className="h-4 w-4" /> {signedIn ? 'Back to library' : 'Back to sign in'}
          </a>
        </div>
      </header>

      <div className="relative overflow-hidden bg-voice pb-20 pt-8 text-white">
        <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-white/10 blur-3xl" />
        <div className="relative mx-auto max-w-5xl px-4 sm:px-6">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-white/15 ring-1 ring-white/25"><Icon className="h-5 w-5" /></span>
          <h1 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">{title}</h1>
          <p className="mt-2 text-sm text-white/75">Last updated {UPDATED}</p>
        </div>
      </div>

      <div className="mx-auto -mt-12 grid max-w-5xl gap-6 px-4 pb-16 sm:px-6 lg:grid-cols-[220px_1fr]">
        <nav aria-label="On this page" className="hidden lg:block">
          <div className="card sticky top-20 p-4">
            <p className="px-2 text-xs font-semibold uppercase tracking-wider text-slate-400">On this page</p>
            <ol className="mt-2 space-y-0.5">
              {sections.map(([id, heading]) => (
                <li key={id}><a href={`#${id}`} onClick={jump(id)} className="block rounded-lg px-2 py-1.5 text-sm text-slate-600 transition hover:bg-brand-50 hover:text-brand-700">{heading}</a></li>
              ))}
            </ol>
          </div>
        </nav>

        <article className="card p-6 sm:p-10">
          {sections.map(([id, heading, body], index) => (
            <section key={id} id={id} className={cx('scroll-mt-20', index > 0 && 'mt-8 border-t border-slate-100 pt-8')}>
              <h2 className="flex items-baseline gap-3 text-lg font-semibold text-slate-900">
                <span className="text-sm font-bold text-brand-500">{String(index + 1).padStart(2, '0')}</span>{heading}
              </h2>
              <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-slate-600 [&_li]:pl-1 [&_strong]:font-semibold [&_strong]:text-slate-800 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5">
                {body}
              </div>
            </section>
          ))}
          <div className="mt-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-voice-soft p-5">
            <p className="text-sm text-slate-600">Also read our {PAGES[other].title}.</p>
            <a href={`#/${other}`} className="text-sm font-semibold text-brand-700 hover:underline">{PAGES[other].title} →</a>
          </div>
        </article>
      </div>
    </div>
  );
}

export const LEGAL_PAGES = Object.keys(PAGES);
