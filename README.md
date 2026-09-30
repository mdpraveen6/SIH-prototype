# SPARSH — Self-Supervised Perception and Autonomous Robust Safety Framework

Interactive 3D UGV autonomy dashboard prototype (SIH). **Fully standalone:** every sensor,
planner, and telemetry stream is simulated live in the browser — no backend, no ROS 2 network.

## Structure

```
SIH26/
├── frontend/  # Vite + React 18 + TypeScript + Tailwind + Three.js
```

## Run locally

```powershell
npm run install:all
npm run dev
```

- Dashboard: http://localhost:5173

## Production build / preview

```powershell
npm run build
npm run preview
```

## Deploy (frontend only)

- Vercel / Netlify: Root Directory `frontend`, Build `npm run build`, Output `dist`.

## Simulate a drive

Right-click the 3D terrain (or click the tac-map / enter X·Y) to send a goal —
A\* routes globally, MPPI tracks locally, Layer-0 shields hard blockers.
