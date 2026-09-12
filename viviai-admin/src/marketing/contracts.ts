export interface MarketingPage<T> {
  rows: T[];
  nextCursor: string | null;
}

export interface Campaign {
  resourceId: string;
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  perUserLimit: number;
  credits: number;
  totalLimit: number | null;
  status: 'active' | 'disabled' | 'archived';
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RedemptionCode {
  resourceId: string;
  id: string;
  campaignId: string;
  displayMask: string;
  status: 'active' | 'disabled';
  maxUses: number;
  usedCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface GeneratedBatch {
  resourceId: string;
  campaignId: string;
  campaignVersion: number;
  generated: number;
  codes?: Array<RedemptionCode & { code: string }>;
}

export interface Referral {
  id: string;
  inviterUserId: string;
  inviterEmail: string;
  inviteeUserId: string;
  inviteeEmail: string;
  status: 'pending' | 'rewarded';
  rewardCredits: number;
  qualifiedAt: string | null;
  rewardedAt: string | null;
  createdAt: string;
}
