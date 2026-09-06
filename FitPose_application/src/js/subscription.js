import { Auth, Store } from './store.js';

export const PREMIUM_FEATURES = {
  aiSchedule: 'AI Schedule Builder',
  personalizedPlan: 'Personalized Weekly & Monthly Plans',
  advancedInsights: 'Advanced Progress Insights',
  scheduleModify: 'AI Schedule Modification',
  goalPlanning: 'AI Goal Planning',
  premiumWorkouts: 'Premium Workout Programs',
};

function data() { return Store.get(); }
export function getMembership() {
  const m = data().membership || { plan: 'free', isPremium: false, startedAt: null, expiresAt: null, demo: false };
  return { ...m, isPremium: m.plan === 'premium' && m.isPremium === true };
}
export function isPremium() { return getMembership().isPremium; }
export function activateDemoPremium() {
  const d = data();
  d.membership = { plan: 'premium', isPremium: true, startedAt: new Date().toISOString(), expiresAt: null, demo: true };
  Store.save(d);
  return d.membership;
}
export function cancelSubscription() {
  const d = data();
  d.membership = { plan: 'free', isPremium: false, startedAt: null, expiresAt: null, demo: false };
  Store.save(d);
  return d.membership;
}
export function requirePremium(feature = 'this feature') {
  if (!Auth.isLoggedIn()) { window.show?.('login'); return false; }
  if (isPremium()) return true;
  window.openPremiumGate?.(feature);
  return false;
}
