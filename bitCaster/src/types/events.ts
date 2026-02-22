// Domain Events for bitCaster

// User Events
export interface UserRegistered { userId: string; registeredDate: string }
export interface UserProfileUpdated { userId: string; displayName?: string; avatarUrl?: string }

// Wallet Events
export interface DepositReceived { userId: string; amountSats: number; txId?: string; lightningInvoice?: string; date: string }
export interface WithdrawalRequested { userId: string; amountSats: number; destinationAddress?: string; lightningInvoice?: string; date: string }
export interface WithdrawalCompleted { userId: string; amountSats: number; txId?: string; date: string }

// Market Lifecycle Events
export interface MarketCreated { marketId: string; creatorId: string; title: string; description: string; type: 'yesno' | 'categorical'; outcomes?: { id: string; label: string }[]; closingDate: string; creatorFeePercent: number; initialLiquiditySats: number; categoryTags: string[]; date: string }
export interface MarketApproved { marketId: string; approvedDate: string }
export interface MarketRejected { marketId: string; rejectedDate: string; rejectionReason: string }
export interface MarketResolved { marketId: string; winningOutcomeId: string; resolvedDate: string }
export interface MarketCancelled { marketId: string; cancelledDate: string; cancellationReason: string; refundedSats: number }

// Trading Events
export interface Bought { tradeId: string; userId: string; marketId: string; outcomeId?: string; side: 'yes' | 'no'; amountSats: number; price: number; shares: number; date: string }
export interface Sold { tradeId: string; userId: string; marketId: string; outcomeId?: string; side: 'yes' | 'no'; amountSats: number; price: number; shares: number; date: string }
export interface LiquidityDeposited { userId: string; marketId: string; amountSats: number; date: string }

// Settlement Events
export interface PayoutClaimed { userId: string; marketId: string; positionId: string; amountSats: number; date: string }
export interface CreatorFeeClaimed { userId: string; marketId: string; amountSats: number; date: string }

// Social Events
export interface MarketLiked { userId: string; marketId: string; date: string }
export interface CommentPosted { commentId: string; userId: string; marketId: string; content: string; date: string }

// Union Type
export type DomainEvent =
  | { type: 'UserRegistered'; payload: UserRegistered }
  | { type: 'UserProfileUpdated'; payload: UserProfileUpdated }
  | { type: 'DepositReceived'; payload: DepositReceived }
  | { type: 'WithdrawalRequested'; payload: WithdrawalRequested }
  | { type: 'WithdrawalCompleted'; payload: WithdrawalCompleted }
  | { type: 'MarketCreated'; payload: MarketCreated }
  | { type: 'MarketApproved'; payload: MarketApproved }
  | { type: 'MarketRejected'; payload: MarketRejected }
  | { type: 'MarketResolved'; payload: MarketResolved }
  | { type: 'MarketCancelled'; payload: MarketCancelled }
  | { type: 'Bought'; payload: Bought }
  | { type: 'Sold'; payload: Sold }
  | { type: 'LiquidityDeposited'; payload: LiquidityDeposited }
  | { type: 'PayoutClaimed'; payload: PayoutClaimed }
  | { type: 'CreatorFeeClaimed'; payload: CreatorFeeClaimed }
  | { type: 'MarketLiked'; payload: MarketLiked }
  | { type: 'CommentPosted'; payload: CommentPosted }
