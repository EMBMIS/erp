// These are the terms of EMBMIS's own hosted service. If you run your own installation, you are the operator:
// replace this page with your own text and contact address before you open the app to users (DEPLOY.md).
import React from 'react'
import { Link } from 'react-router-dom'
import LegalDoc from '../components/LegalDoc'

export default function PrivacyPolicy() {
  return (
    <LegalDoc
      eyebrow="Legal"
      title="Privacy Policy"
      intro="How EMBMIS and Simeli handle information, in plain language."
      sections={[
        {
          title: 'What we collect',
          body: [
            'You need an account to use the ERP, so we store what running your business through the system requires: your name, work email, the company you belong to, and the records you and your colleagues create while using it.',
            'When you sign in with Google, we receive from Google only the profile information your Google account makes available to us — your name and email address — and we use it solely to create and identify your account.',
            'We do not sell personal information, and we do not share it with third parties for their own marketing.',
          ],
        },
        {
          title: 'Signing in with Google',
          body: [
            'You can sign in with your Google account instead of a separate password. When you choose this, Google sends us your name and email address from your Google profile. We use that information only to create or authenticate your account — we never see or store your Google password, and we do not use your Google data for any purpose other than signing you in.',
            'Google is an independent third party: the information you give Google when you sign in is handled according to Google\'s own privacy policy, and you can review what Google shares and revoke access to this app at any time from your Google Account settings (https://myaccount.google.com/permissions).',
          ],
        },
        {
          title: 'Cookies',
          body: [
            'The application uses cookies and equivalent browser storage for two purposes: keeping you signed in and keeping the app working (authentication, sessions, security), and remembering interface choices you make, such as language and dark mode.',
            'These are functional rather than advertising cookies. Your consent choice for optional, non-essential cookies is remembered in your browser and you can change it at any time by clearing this site\'s data.',
          ],
        },
        {
          title: 'AI features',
          body: [
            'The Simeli assistant can read the business records you already have access to in order to answer your questions. AI features act on company data under the same permissions you already have — they do not create a way around them.',
            'Prompts and results are processed to produce the answer you asked for and are not used to advertise to you.',
          ],
        },
        {
          title: 'Data retention and security',
          body: [
            'Business records are kept for as long as your company uses the system, and deleted at your request or per your company\'s retention policy after that.',
            'Traffic is encrypted in transit. Access to production data is restricted to the people who operate the system and need it to do their work.',
          ],
        },
        {
          title: 'Your choices',
          body: [
            'You can ask what we hold about you, ask for corrections, or ask for deletion, by writing to privacy@embmis.com or through your company administrator.',
            'If you signed in with Google and want to stop using that sign-in method, you can revoke this application\'s access at any time from your Google Account settings (https://myaccount.google.com/permissions).',
          ],
        },
      ]}
      contact={
        <>
          Questions about this policy? Write to <a href="mailto:privacy@embmis.com" className="font-medium text-brand-600 underline-offset-2 hover:underline">privacy@embmis.com</a>. See also our{' '}
          <Link to="/terms" className="font-medium text-brand-600 underline-offset-2 hover:underline">Terms of Service</Link>.
        </>
      }
    />
  )
}
