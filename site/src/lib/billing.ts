/**
 * Kimochi Cloud's prices as the site shows them, and starting a purchase. The amounts must match
 * the Stripe prices the Kimochi server is set up with (lookup keys
 * kimochi_cloud_monthly / _yearly / _lifetime); Stripe Checkout always charges its own price.
 * Monthly and yearly lead with a monthly price ($6, $5) and lifetime with its one payment ($125);
 * the yearly note under the price always says it is billed as $60 a year, so no one reads "$5 a
 * month" as the monthly plan. Keep FAQ (src/content/faq.js), JSON-LD (src/lib/seo.js) and public/llms.txt in step.
 */
import { api, type Choice } from './api'

export const TRIAL_DAYS = 14

export interface PriceInfo {
  choice: Choice
  label: string
  /** The big number. */
  amount: string
  /** After the big number: "/ month", "once". */
  per: string
  /** The line under it. */
  note: string
}

export const PRICES: Record<Choice, PriceInfo> = {
  monthly: { choice: 'monthly', label: 'Monthly', amount: '$6', per: 'a month', note: 'Billed monthly. Cancel any time.' },
  yearly: { choice: 'yearly', label: 'Yearly', amount: '$5', per: 'a month', note: 'Billed $60 a year. Two months free.' },
  lifetime: { choice: 'lifetime', label: 'Lifetime', amount: '$125', per: 'once', note: 'Pay once, keep Kimochi Cloud for good.' }
}

/**
 * Every price in one plain sentence, rendered as static text under the plan cards so crawlers and
 * screen readers get all three without the toggle. Bump PRICES_AS_OF when the prices are checked
 * or changed.
 */
export const PRICES_AS_OF = 'October 2026'
export const PRICE_SUMMARY = `As of ${PRICES_AS_OF}, Kimochi is free, and Kimochi Cloud costs US$6 a month, US$60 a year or US$125 once for lifetime, with a ${TRIAL_DAYS}-day free trial on the monthly and yearly plans.`

export const CHOICES: Choice[] = ['monthly', 'yearly', 'lifetime']

export function isChoice(v: unknown): v is Choice {
  return v === 'monthly' || v === 'yearly' || v === 'lifetime'
}

/** The call to action for a choice: a trial when one is on offer, else buying it. */
export function ctaLabel(choice: Choice, trialAvailable: boolean): string {
  if (choice === 'lifetime') return 'Buy lifetime'
  return trialAvailable ? `Start ${TRIAL_DAYS}-day free trial` : 'Subscribe'
}

/** The account page URL that starts checkout for `choice` once someone is signed in. */
export function checkoutPath(choice: Choice): string {
  return `/account?start=${choice}`
}

/** Sends the browser to Stripe Checkout. Throws ApiError when the server refuses. */
export async function goToCheckout(choice: Choice, returnTo: 'home' | 'account'): Promise<void> {
  window.location.assign(await api.checkout(choice, returnTo))
}

/** Sends the browser to the Stripe Customer Portal. */
export async function goToPortal(): Promise<void> {
  window.location.assign(await api.billingPortal())
}
