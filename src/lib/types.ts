export interface Position {
  symbol: string;
  label: string;
  quantity: number;
  avgCost: number;
  stopLoss: number;
  takeProfit: number;
  takeProfit2: number;
  entryDate: string;
  notes: string;
  status: "active" | "closed";
}

export interface CopyPortfolioPosition {
  symbol: string;
  label: string;
}

export interface CopyPortfolio {
  trader: string;
  totalAllocated: number;
  currentValue?: number;
  currentPnl?: number;
  currentPnlPct?: number;
  currency: string;
  note: string;
  positions: CopyPortfolioPosition[];
}

export interface SmartPortfolio {
  name: string;
  label: string;
  currentValue: number;
  currentPnl: number;
  currentPnlPct: number;
}

export interface ClosedPosition {
  symbol: string;
  label: string;
  closeDate: string;
  closePrice: number;
  pnl: number;
  pnlPct?: number;
  reason: string;
}

export interface WarTrigger {
  label: string;
  state: "met" | "not_met";
  detail: string;
}

export interface WarStatus {
  status: string;
  statusKey: string;
  description: string;
  triggers: WarTrigger[];
  deploymentLocked: boolean;
  deploymentAmountAED: number;
}

export interface ActionItem {
  label: string;
  priority: "high" | "medium" | "low" | "critical";
  done: boolean;
}

export interface Event {
  date: string;
  label: string;
  symbol: string;
  type: string;
  priority?: string;
}

export interface ManualInput {
  lastUpdated: string;
  equity: {
    beginningRealized: number;
    endingRealized: number;
    endingUnrealized: number;
    cashIdle: number;
    periodPnl: number;
    statementPeriod: string;
  };
  strategistNote: {
    title: string;
    body: string;
    edition?: string;
  };
  positions: Position[];
  copyPortfolio: CopyPortfolio;
  smartPortfolios?: SmartPortfolio[];
  closedPositions: ClosedPosition[];
  warStatus: WarStatus;
  actionItems: ActionItem[];
  events: Event[];
  marketSymbols: string[];
}

export interface MarketData {
  symbol: string;
  price: number;
  changePercent: number;
  sma50?: number;
  sma200?: number;
  rsi14?: number;
  trend?: string;
}

export interface PositionWithLive extends Position {
  livePrice: number;
  changePercent: number;
  currentValue: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  sma50?: number;
  sma200?: number;
  rsi14?: number;
}

export interface Flag {
  severity: "critical" | "watch" | "ok";
  title: string;
  pnlPercent?: number;
}
