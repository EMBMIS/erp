// These are the terms of EMBMIS's own hosted service. If you run your own installation, you are the operator:
// replace this page with your own text and contact address before you open the app to users (DEPLOY.md).
import React from 'react'
import { Link } from 'react-router-dom'
import LegalDoc from '../components/LegalDoc'

export default function TermsOfService() {
  return (
    <LegalDoc
      eyebrow="Legal"
      title="Terms of Service"
      intro="The ground rules for using EMBMIS and Simeli."
      sections={[
        {
          title: 'Acceptance',
          body: [
            'By creating an account or using the application you agree to these terms on behalf of yourself and, if you are an administrator, your organisation.',
            'Use of the product may also be governed by a separate subscription agreement signed with your company; where that agreement exists, it takes precedence over these terms.',
          ],
        },
        {
          title: 'Accounts and your data',
          body: [
            'You are responsible for the activity that happens under your account and for keeping your credentials safe.',
            'You keep the rights to the business data you enter. You grant us the limited right to store and process it in order to run the service for you.',
          ],
        },
        {
          title: 'Acceptable use',
          body: [
            'Do not use the service to break the law, to attack the service or other users, or to knowingly feed it malicious content.',
            'We may suspend accounts or companies that do, in proportion to the problem.',
          ],
        },
        {
          title: 'AI features',
          body: [
            'The Simeli assistant provides operational suggestions based on your data. It is a tool, not a decision-maker: verify anything consequential before acting on it, and remember that an AI answer is not professional legal, financial or tax advice.',
          ],
        },
        {
          title: 'Availability and liability',
          body: [
            'We aim for the service to be available and correct, but it is provided as is where the law allows, and we do not accept liability for indirect or consequential loss arising from its use.',
            'Nothing here limits liability that cannot lawfully be limited.',
          ],
        },
        {
          title: 'Changes',
          body: [
            'We may update these terms as the product changes. The current version is always this page, and continued use after a change means you accept it.',
          ],
        },
      ]}
      contact={
        <>
          Questions about these terms? Write to <a href="mailto:legal@embmis.com" className="font-medium text-brand-600 underline-offset-2 hover:underline">legal@embmis.com</a>. See also our{' '}
          <Link to="/privacy" className="font-medium text-brand-600 underline-offset-2 hover:underline">Privacy Policy</Link>.
        </>
      }
    />
  )
}
