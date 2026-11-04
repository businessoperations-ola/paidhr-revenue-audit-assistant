import type { ScoringConfig } from './scoring-config.js';

const signed = (n: number) => (n > 0 ? `${n}` : n < 0 ? `minus ${-n}` : '0');

/** The scoring rules in words, built from the live settings so the explanation always matches the numbers. */
export function describeScoring(c: ScoringConfig) {
  const ch = c.churn;
  const p = c.partial;
  const u = c.upsell;
  return {
    adoption: `Adoption rate is modules in use divided by modules bought. Strong is ${c.bands.adoptionStrongPct}% or more, partial ${c.bands.adoptionPartialPct}% or more, weak below that. What counts as in use is set per module under Adoption settings.`,
    churn: [
      `Adoption: up to ${ch.adoptionMax} points, more the fewer modules bought are in use`,
      `Primary admin: ${ch.adminNever} if never logged in, ${ch.adminDormant} if dormant over 30 days, ${ch.adminQuiet} if quiet over 2 weeks`,
      `Employee activity down ${ch.activityDropBigPct}% or more: ${ch.activityDropBig} (${ch.activityDropSmallPct}% or more: ${ch.activityDropSmall}). Under ${ch.lowEngagementPct}% of seats active: ${ch.lowEngagement}. Under ${ch.lowSeatPct}% of paid seats in use: ${ch.lowSeat}`,
      `Experience: NPS detractor ${ch.detractor}, CSAT under ${ch.csatLowPct}% ${ch.csatLow}, tickets past SLA ${ch.slaOne} to ${ch.slaMany}, reopened ${ch.reopened}, ${ch.openManyCount} or more open ${ch.openMany}`,
      `Commercial: HubSpot health At Risk ${ch.healthAtRisk} (Neutral ${ch.healthNeutral}), payroll late ${ch.payrollLate} or not set up ${ch.payrollNotSetUp}`,
      `Renewal within ${ch.renewalDays} days while other risks already add up to ${ch.renewalMinBase} or more: ${ch.renewal}`,
      `High is ${ch.high} or more, medium ${ch.medium} or more`,
    ],
    partialChurn: [
      `A module bought but not in use: ${p.unused}`,
      `Use fell ${p.declinePct}% or more on the month before (from at least ${p.declineMinBase} actions): ${p.decline}`,
      `Plus ${p.unhappy} if the customer is a detractor or has tickets past SLA, and ${p.renewal} if renewal is within ${p.renewalDays} days`,
      `Shown at ${p.show} or more; high at ${p.high} or more`,
    ],
    upsell: [
      `Modules purchased: up to ${u.peerCap} for how many customers have it (${u.peerFactorPct} points per 100%), ${u.adjacent} for each related module they already use (up to ${u.adjacentMax})`,
      `Modules in use: ${signed(u.adoptionStrong)} at ${u.adoptionStrongPct}% adoption or more, ${signed(u.adoptionPartial)} at ${u.adoptionPartialPct}%, ${signed(u.adoptionWeak)} below that. ${signed(u.engagement)} more when ${u.engagementPct}% of seats are active`,
      `Experience so far: NPS promoter ${signed(u.npsPromoter)}, passive ${signed(u.npsPassive)}, detractor ${signed(u.npsDetractor)}. CSAT ${u.csatHighPct}% or more ${signed(u.csatHigh)}, under ${u.csatLowPct}% ${signed(u.csatLow)}. Tickets past SLA ${signed(u.slaBreach)}, ${u.openManyCount} or more open ${signed(u.openMany)}, reopened ${signed(u.reopened)}, all recent tickets closed ${signed(u.allClosed)}`,
      'Seasonality: the full boost for each buying season while it is open, half in the weeks before it opens (set under Modules and seasons)',
      `New launch: ${signed(u.launchFirstHalf)} in the first half of the launch window, ${signed(u.launchSecondHalf)} after that`,
      `Growth plans: ${signed(u.signalFit)} for a fund raise, expansion or hiring plan that fits the module, ${signed(u.signalGeneral)} for any other, up to ${u.signalCap} in all, for ${u.signalDays} days`,
      `Hot is ${u.hot} or more, warm ${u.warm} or more, cool ${u.cool} or more. Held, not pushed: ${[c.holds.churnHigh && 'high churn risk', c.holds.atRisk && 'At Risk health', c.holds.urgentAlerts && 'urgent alerts', c.holds.detractor && 'a detractor score'].filter(Boolean).join(', ') || 'nothing'}`,
    ],
  };
}
