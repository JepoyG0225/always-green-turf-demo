# Always Green Turf Demo — Project Rules

## Navigation Rule (IMPORTANT)
Whenever a new HTML page is created that is part of the site navigation, **always update the nav menu in ALL existing HTML pages** — both the desktop nav (`#nav .n-links`) and the mobile nav (`#nMob .n-mob-list`).

Current HTML pages that each contain a nav:
- index.html
- about.html
- artificial-lawns.html
- pet-turf.html
- whole-yard-renovations.html
- financing.html
- process.html
- service-areas.html
- service-areas-map.html

## Deployment
- This project is deployed on **Vercel** via manual `vercel --prod` (no auto GitHub deploy connected).
- Always run `vercel --prod` after pushing to GitHub to update the live site.
- Live URL: https://always-green-turf-demo.vercel.app

## Assets
- Pet turf images: `assets/pet turf/`
- Certifications: `assets/certifiications/` (note double-i typo — keep as-is to avoid broken references)

## Design System
- Font: Poppins (Google Fonts)
- Green palette: `--g1` through `--g6` (dark to light green)
- Gold accent: `--gold: #c9a24a`
- All pages share the same CSS variables and component classes (navbar, hero, stats-bar, section, feat-grid, etc.)
