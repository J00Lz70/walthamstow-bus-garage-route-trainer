# Walthamstow Route Trainer

Route learning aid for new drivers at Stagecoach London's Walthamstow Avenue (AW) garage. It covers every route the garage runs: **379, 385, 397, W5, W11, W12, W16 and W19**.

For each route you get stops and stop letters in both directions, learning by section, cover-and-reveal, drills, a map, turn-by-turn directions with a map that faces the way you're driving, progress tracking and live TfL service updates.

**W19** has hand-written road names, turns and hazard notes for each section. **The other routes** are built automatically:
- **Stops, letters and the route line** come from TfL.
- **Road names, named turns and hazard notes** come from OpenStreetMap, matched to TfL's route line. That covers the road at every stop, turns such as "Turn left into Hoe Street" with roundabouts, and sections named after their main roads.
- **Section hazard notes** list what the map records: height and width limits, bus gates, level crossings, roundabouts, mini roundabouts, speed humps and cushions, 20 mph roads, schools, hospitals, markets, stations and bus stations, plus counts of traffic lights and zebra crossings.
- **Stops near a junction or a change of road** are marked "confirm road on drive". If a route's line doesn't match the map well enough, the app doesn't use the map data for that route. The workflow summary then flags it with ⚠.

It comes as:

- **A web app** hosted free on GitHub Pages. It installs from Chrome on Android and from Edge or Chrome on Windows, and works offline.
- **An Android app** (`Walthamstow-Route-Trainer.apk`) to install directly on a phone.
- **A Windows app** (`Walthamstow-Route-Trainer-Setup.exe`).

Both installable apps open the hosted web app. When you change anything in `web/`, every installed copy picks up the change the next time it opens, with no reinstall.

**Live bus info.** Every 15 minutes, a GitHub workflow downloads each route's stops, letters, route line and service status from TfL and republishes the app. If TfL changes a route's stops, the app picks up the new list and shows what changed under Driver notes for 4 weeks. The app also checks TfL itself when it opens, every 10 minutes while open, and when you tap Refresh. With no signal, it shows the last update it received.

**Changing the route list.** The routes come from `web/data/garage.json`. To add or remove a route, edit that file on GitHub (open it, click the pencil, change the `routes` list, then **Commit changes**). The app updates within a few minutes.

---

## One-time setup (about 15 minutes)

### 1. Put the files on GitHub
1. Sign in at github.com (create a free account if you don't have one).
2. Click **+** (top right) → **New repository**. Name it `walthamstow-route-trainer` and choose **Public**. Free GitHub Pages hosting needs a public repository. The trainer has no private data. Click **Create repository**.
3. On the new repository page, click **uploading an existing file**. Drag in **everything inside** this folder, including the `.github` folder. On a Mac, press Cmd+Shift+. in Finder to show hidden folders like `.github`. Click **Commit changes**.

### 2. Turn on the website
1. In the repository, go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Go to the **Actions** tab. If asked, click **I understand my workflows, go ahead and enable them**.
4. Click **Publish app** → **Run workflow** → **Run workflow**. This first run also downloads all the routes from TfL and matches them to OpenStreetMap.
5. After five to ten minutes the run shows a green tick. Your app is live at
   `https://YOUR-USERNAME.github.io/walthamstow-route-trainer/`

### 3. Add the Android signing key (recommended)
Open `android-signing-secrets.txt`. It comes separately from this folder, so don't upload it. In the repository, go to **Settings → Secrets and variables → Actions → New repository secret** and add the four secrets listed in that file.

Without them the Android app still builds, but each new APK would need the old one uninstalled first, which erases drill progress.

### 4. Build the Android and Windows apps
1. **Actions** tab → **Build Android and Windows apps** → **Run workflow**.
2. It takes about 10 minutes. When it finishes, open the **Releases** section on the repository's main page (right-hand side). The latest release has both files.

The **Driver notes** tab in the app also links to this downloads page.

---

## Installing

**Android (APK):** open the release page on your phone and download `Walthamstow-Route-Trainer.apk`. Open it and allow installs from your browser if Android asks.
Alternatively, open the web app address in Chrome and tap **Install app** (or ⋮ → **Add to Home screen → Install**).

**Windows:** download and run `Walthamstow-Route-Trainer-Setup.exe`. The installer isn't code-signed, so Windows SmartScreen may warn you. Choose **More info → Run anyway**.
Alternatively, open the web app address in Edge or Chrome and click **Install app** (or the install icon in the address bar).

---

## Updating

| What changed | What to do | What users see |
|---|---|---|
| The trainer itself (stops, notes, layout) | Replace `web/index.html` in the repository (Add file → Upload files). The web app republishes automatically. | Installed apps show the new version the next time they open. A long-open app shows a **Reload now** bar. |
| TfL service info and stop lists | Nothing. The **Publish app** workflow refreshes them every 15 minutes. | New stops and status appear automatically. |
| Which routes the garage runs | Edit `web/data/garage.json`. | New routes appear in the route bar at the top. |
| The Android or Windows wrapper (rare) | Run **Build Android and Windows apps** again. | Install the new APK or .exe over the old one. |

**Checking the road matching:** open the latest **Publish app** run in the Actions tab. Its summary lists each route with how much of its line matched the map, how many stops got a road name, and how many turns and hazards it found. A route marked ⚠ didn't match well enough. The app shows that route without road names, and you can send me that summary.

**Map data credit:** road names, turns and hazards are © OpenStreetMap contributors, under the Open Database Licence. The app credits this on every route that uses it.

**Keeping the automatic refresh running:** GitHub pauses scheduled workflows in repositories with no activity for 60 days. It emails you first. If it happens, open **Actions → Publish app** and click **Enable workflow**.

**TfL API key (optional):** the refresh works without one. If TfL ever starts refusing requests, register for a free key at api-portal.tfl.gov.uk and add it as a repository secret named `TFL_APP_KEY`.

**Using a different web address:** to host the web app somewhere other than GitHub Pages, go to **Settings → Secrets and variables → Actions → Variables** and add a variable named `APP_URL`, then rebuild the apps.

## What's in this folder

| Path | What it is |
|---|---|
| `web/` | The app: `index.html`, the offline worker `sw.js`, the install manifest and icons |
| `web/data/garage.json` | The garage's route list |
| `web/data/routes/` | Stops and route lines per route, downloaded from TfL (created by the workflow) |
| `scripts/fetch-tfl.mjs` | Downloads route data and status from TfL |
| `scripts/enrich-osm.mjs` | Matches each route to OpenStreetMap for road names, turns and hazards |
| `web/data/osm/` | Road names, turns and hazards per route (created by the workflow) |
| `android/` | Android wrapper (a full-screen web view with an offline copy of the app) |
| `desktop/` | Windows wrapper (Electron) with an offline copy of the app |
| `.github/workflows/pages.yml` | Refreshes TfL data and publishes `web/` to GitHub Pages: on every change and every 15 minutes |
| `.github/workflows/apps.yml` | Builds the APK and Windows installer and attaches them to a release |
| `scripts/app-url.sh` | Works out the web app address for the builds |

For study before you drive. Never look at a phone while driving. Your trainer, duty card and garage notices take priority over this app.
