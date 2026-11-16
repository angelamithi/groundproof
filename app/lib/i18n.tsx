'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

const en = {
  tagline: 'Get paid to verify the real world around you.',
  signIn: 'Sign in with Google',
  signOut: 'Sign out',
  register: 'Join as a worker',
  registering: 'Joining…',
  openTasks: 'Tasks near you',
  noTasks: 'No open tasks right now. Check back soon.',
  away: 'away',
  slotsLeft: 'slots left',
  pay: 'Pay',
  claim: 'Take this task',
  claiming: 'Reserving…',
  claimedHint: 'Reserved for you. Go to the location and capture proof before the time runs out.',
  capture: 'Take photo',
  retake: 'Remove',
  submit: 'Submit proof',
  submitting: 'Encrypting, uploading and submitting…',
  submitted: 'Submitted. Waiting for the customer to review.',
  approved: 'Approved and paid. Great work!',
  rejectedPending: 'The customer rejected this. You can dispute it or accept.',
  dispute: 'Dispute',
  accept: 'Accept rejection',
  disputed: 'Disputed. A verifier will review your proof.',
  rejected: 'Rejected.',
  expired: 'Time ran out for this claim.',
  collect: 'Collect payment',
  collectHint: 'The customer did not respond in time, so you can collect your payment.',
  tooFar: 'You seem to be too far from the task location. Move closer and retake the photos.',
  needPhoto: 'Take at least one photo.',
  locating: 'Getting your location…',
  locationNeeded: 'Location access is needed to take tasks.',
  wallet: 'Earnings',
  tasks: 'Tasks',
  balance: 'Balance',
  completed: 'Completed',
  strikes: 'Strikes',
  level: 'Level',
  banned: 'Your account is suspended.',
  cashOut: 'To cash out, send your balance to an exchange or off-ramp that supports this stablecoin.',
  setupMissing: 'App not configured. Missing:',
  instructions: 'Instructions',
  deadline: 'Deadline',
  // task-kind forms
  kind0: 'Business check',
  kind1: 'Price photo',
  kind2: 'Language task',
  businessExists: 'Is the business open and operating here?',
  businessName: 'Name on the sign',
  openingHours: 'Opening hours (if shown)',
  prices: 'Items and prices (one per line, e.g. "Bread 400g - 65")',
  answer: 'Your answer',
  notes: 'Notes (optional)',
  yes: 'Yes',
  no: 'No',
  withdraw: 'Withdraw',
  withdrawHint: 'Send your earnings to an exchange or wallet that accepts USDC on the Sui network.',
  toAddress: 'Destination address (Sui network)',
  amount: 'Amount (USDC)',
  max: 'Max',
  review: 'Review',
  confirmSend: 'Confirm and send',
  sending: 'Sending…',
  cancel: 'Cancel',
  youSend: 'You are sending',
  to: 'to',
  checkNetwork: 'I selected the Sui network as the deposit network. Funds sent on the wrong network can be lost.',
  sent: 'Sent!',
  viewTx: 'View transaction',
  badAddress: 'Enter a full Sui address: 0x followed by 64 letters/numbers.',
  ownAddress: 'That is your own Groundproof address.',
  badAmount: 'Enter an amount above 0 and no more than your balance.',
  noFees: 'No fee: Groundproof pays the network cost.',
};

const sw: typeof en = {
  tagline: 'Lipwa kwa kuthibitisha mambo halisi yanayokuzunguka.',
  signIn: 'Ingia na Google',
  signOut: 'Toka',
  register: 'Jiunge kama mfanyakazi',
  registering: 'Inajiunga…',
  openTasks: 'Kazi karibu nawe',
  noTasks: 'Hakuna kazi kwa sasa. Rudi baadaye.',
  away: 'mbali',
  slotsLeft: 'nafasi zimebaki',
  pay: 'Malipo',
  claim: 'Chukua kazi hii',
  claiming: 'Inahifadhi…',
  claimedHint: 'Imehifadhiwa kwako. Nenda mahali hapo upige picha kabla muda haujaisha.',
  capture: 'Piga picha',
  retake: 'Ondoa',
  submit: 'Tuma ushahidi',
  submitting: 'Inasimba, inapakia na kutuma…',
  submitted: 'Imetumwa. Inasubiri mteja akague.',
  approved: 'Imekubaliwa na umelipwa. Kazi nzuri!',
  rejectedPending: 'Mteja amekataa. Unaweza kupinga au kukubali.',
  dispute: 'Pinga',
  accept: 'Kubali kukataliwa',
  disputed: 'Umepinga. Mthibitishaji atakagua ushahidi wako.',
  rejected: 'Imekataliwa.',
  expired: 'Muda wa kazi hii umeisha.',
  collect: 'Chukua malipo',
  collectHint: 'Mteja hakujibu kwa wakati, kwa hiyo unaweza kuchukua malipo yako.',
  tooFar: 'Unaonekana uko mbali sana na mahali pa kazi. Sogea karibu upige picha tena.',
  needPhoto: 'Piga angalau picha moja.',
  locating: 'Inatafuta mahali ulipo…',
  locationNeeded: 'Ruhusa ya mahali inahitajika kuchukua kazi.',
  wallet: 'Mapato',
  tasks: 'Kazi',
  balance: 'Salio',
  completed: 'Zilizokamilika',
  strikes: 'Makosa',
  level: 'Kiwango',
  banned: 'Akaunti yako imesimamishwa.',
  cashOut: 'Kutoa pesa, tuma salio lako kwa soko au huduma inayokubali sarafu hii.',
  setupMissing: 'Programu haijawekwa. Inakosa:',
  instructions: 'Maelekezo',
  deadline: 'Mwisho',
  kind0: 'Kuthibitisha biashara',
  kind1: 'Picha ya bei',
  kind2: 'Kazi ya lugha',
  businessExists: 'Je, biashara iko wazi na inafanya kazi hapa?',
  businessName: 'Jina lililo kwenye bango',
  openingHours: 'Saa za kufungua (kama zimeandikwa)',
  prices: 'Bidhaa na bei (moja kwa kila mstari, mf. "Mkate 400g - 65")',
  answer: 'Jibu lako',
  notes: 'Maelezo (si lazima)',
  yes: 'Ndiyo',
  no: 'Hapana',
  withdraw: 'Toa pesa',
  withdrawHint: 'Tuma mapato yako kwa soko au pochi inayokubali USDC kwenye mtandao wa Sui.',
  toAddress: 'Anwani ya kupokea (mtandao wa Sui)',
  amount: 'Kiasi (USDC)',
  max: 'Zote',
  review: 'Kagua',
  confirmSend: 'Thibitisha na utume',
  sending: 'Inatuma…',
  cancel: 'Ghairi',
  youSend: 'Unatuma',
  to: 'kwa',
  checkNetwork: 'Nimechagua mtandao wa Sui kama mtandao wa kupokea. Pesa zikitumwa kwenye mtandao mbaya zinaweza kupotea.',
  sent: 'Imetumwa!',
  viewTx: 'Angalia muamala',
  badAddress: 'Weka anwani kamili ya Sui: 0x ikifuatiwa na herufi/nambari 64.',
  ownAddress: 'Hiyo ni anwani yako mwenyewe ya Groundproof.',
  badAmount: 'Weka kiasi zaidi ya 0 na kisichozidi salio lako.',
  noFees: 'Hakuna ada: Groundproof inalipa gharama ya mtandao.',
};

export type Key = keyof typeof en;
type Lang = 'en' | 'sw';

const I18n = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: (k: Key) => string }>({
  lang: 'en',
  setLang: () => {},
  t: (k) => en[k],
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>('en');
  useEffect(() => {
    try {
      const saved = localStorage.getItem('gp-lang');
      if (saved === 'sw' || saved === 'en') setLangState(saved);
    } catch {}
  }, []);
  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem('gp-lang', l);
    } catch {}
  };
  const dict = lang === 'sw' ? sw : en;
  return <I18n.Provider value={{ lang, setLang, t: (k) => dict[k] ?? en[k] }}>{children}</I18n.Provider>;
}

export const useT = () => useContext(I18n);
