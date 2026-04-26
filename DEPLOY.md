# C&G Brief v2 Deployment Guide

This is a rebuilt Next.js 14 trading dashboard with live market data fetched from Yahoo Finance.

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Local development**
   ```bash
   npm run dev
   ```
   Open http://localhost:3000

3. **Build verification**
   ```bash
   npm run build
   ```
   The build must complete without TypeScript errors.

## Deployment to Vercel

1. **Initialize GitHub repository** (if not already done)
   ```bash
   git remote add origin https://github.com/digital-spit/cg-brief-v2.git
   git push -u origin main
   ```
   Note: You may need to create the repository on GitHub first if it doesn't exist.

2. **Deploy to Vercel**
   ```bash
   vercel --prod
   ```
   This will automatically detect Next.js and deploy to production.

3. **Post-deployment**
   - The live site will be available at https://cg-brief-v2.vercel.app
   - Market data caches for 5 minutes (ISR revalidation)
   - Data is read from `src/data/manual-input.json`

## Environment Variables

**No environment variables are required** — all configuration is in `src/data/manual-input.json`.

## Data Updates

To update the dashboard data:

1. Edit `src/data/manual-input.json` with latest position, war status, and event data
2. Commit and push to GitHub
3. Vercel will auto-deploy within seconds

## Key Features

- **Server-Side Rendering**: All market data fetches happen at build time + ISR
- **Dark Theme**: Tailwind CSS with gray-950 base
- **Live Prices**: Yahoo Finance API for real-time market data
- **Technical Indicators**: RSI14, SMA50/200, trend analysis
- **Portfolio Dashboard**: Position tracking, P&L, flags, catalysts
- **Responsive**: Mobile-first design (1 col on mobile, 3 on desktop)

## Troubleshooting

**Build fails with TypeScript errors:**
- Check `tsconfig.json` is valid
- Ensure all imports use correct paths (e.g., `@/lib/types`)
- Run `npm install` again if dependencies are missing

**Market data not fetching:**
- Yahoo Finance API is public, no auth required
- If a symbol fails to fetch, it displays "—" instead of price
- Check `src/lib/market.ts` for fetch error logs during build

**Data not updating:**
- Remember to run `npm run build` after editing `manual-input.json`
- Vercel ISR revalidates every 5 minutes
- Force refresh with `ctrl+shift+r` to bypass browser cache

## Contact

Built by Khaled Halwani (khaled.halwani@gmail.com)
