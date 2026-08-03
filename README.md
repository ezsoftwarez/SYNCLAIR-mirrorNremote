# SYNCLAIR · mirrorNremote

> Lightning-fast mirror and remote management dashboard — zero build step, instant load.

![screenshot placeholder](https://placehold.co/1200x630/0a0c10/7c3aed?text=SYNCLAIR+mirrorNremote)

## ✨ Features

- **Instant access** — single `index.html`, no build tools, no dependencies, no server required
- **Pimped-up dark UI** — glassmorphism design with animated gradient background, smooth transitions, and glow effects
- **Mirror management** — add, sync, and monitor repository mirrors with live status tracking
- **Remote management** — manage upstream connections with one-click ping and latency display
- **Activity log** — full real-time event stream with colour-coded entries
- **Global search** — fuzzy search across all mirrors and remotes
- **Keyboard shortcuts** — navigate at maximum speed (`/` search, `A` add, `R` refresh, `G D/M/R/L` go-to views, `?` help)
- **Persistent state** — all data stored in `localStorage`, survives page refresh
- **Auto-refresh** — timestamps update every 60 seconds automatically

## 🚀 Usage

Just open `index.html` in any modern browser — no installation required:

```bash
# Clone and open
git clone https://github.com/ezsoftwarez/SYNCLAIR-mirrorNremote.git
cd SYNCLAIR-mirrorNremote
open index.html          # macOS
xdg-open index.html      # Linux
start index.html         # Windows
```

Or serve it over HTTP:

```bash
npx serve .
# → http://localhost:3000
```

## ⌨️ Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `/` | Focus search |
| `A` | Add mirror / remote |
| `R` | Refresh / sync all |
| `G D` | Go to Dashboard |
| `G M` | Go to Mirrors |
| `G R` | Go to Remotes |
| `G L` | Go to Activity Log |
| `?` | Show shortcuts |
| `Esc` | Close modal |

## 🗂 Views

| View | Description |
|------|-------------|
| Dashboard | Overview stats + recent activity |
| Mirrors | Full mirror list — add, sync, delete |
| Sync History | Past sync operations |
| Remotes | Remote connections — add, ping, delete |
| Access Keys | SSH & deploy token management |
| Activity Log | Complete event stream |
| Settings | Global configuration |

## 🛠 Tech

Pure HTML + CSS + JavaScript — zero dependencies, zero build step, maximum performance.
