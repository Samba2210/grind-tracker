# The Great British Grind 🏃🚴🏊

A retro-arcade exercise tracker for 4 mates racing (virtually) from **Land's End to John o' Groats** (~1,407 km).

- Log runs, rides and swims; each gets a multiplier (cycle ×1, run ×4, swim ×16) so it's fair. A win at Golf with Friends is a flat +1 km. Bets name an exercise too, and the stake is scaled by its multiplier
- Profile pics act as markers on the map
- Leaderboard with levels, titles, XP bars and badges
- Finish the route → LAP 2
- Teams, and challenges: bet km that a mate can't hit a target. Winner takes the stake, and losers can go into debt
- Add a finish time to an activity to set PBs at milestone distances (5K, 10K, half marathon…), shown on the PB board in the bets tab. The fastest time in each event earns a +5 km bonus (♛), once at least 2 players have posted a time. A distance close to a milestone (−2% to +5%) has its time scaled to the exact milestone with Riegel's formula, so a 5.08 km run counts as a fair 5K
- Each team has a banner on the map at its combined distance

Tweak multipliers, player defaults and checkpoints in `config.js`.

---

## 1. Try it locally

Double-click `index.html`. It runs in **LOCAL MODE**, where data is only stored in that browser. That's fine for a test, but you need step 2 to share data between all four of you.

## 2. Set up shared data (Firebase, free, about 5 mins)

1. Go to <https://console.firebase.google.com> → **Add project** (Google Analytics is optional).
2. In the project: **Build → Firestore Database → Create database** → pick a region near you (e.g. `europe-west2` London) → start in **production mode**.
3. Open the **Rules** tab, paste the contents of `firestore.rules`, then **Publish**.
4. Project settings (⚙️) → **Your apps** → click the **`</>`** (Web) icon → register the app (no hosting needed).
5. Copy the `firebaseConfig` object it shows you and paste it into `config.js`:

   ```js
   firebase: {
     apiKey: "AIza...",
     authDomain: "your-project.firebaseapp.com",
     projectId: "your-project",
     storageBucket: "your-project.appspot.com",
     messagingSenderId: "123...",
     appId: "1:123...:web:abc..."
   },
   ```

The badge in the top right should now say **● ONLINE**, and everyone sees updates live.

> The Firebase "apiKey" isn't a secret. It's meant to be public in web apps. Access is controlled by the Firestore rules.

## 3. Host on GitHub Pages

```powershell
cd grind-tracker
git init
git add .
git commit -m "The Great British Grind"
git branch -M main
git remote add origin https://github.com/<your-username>/grind-tracker.git
git push -u origin main
```

Then on GitHub, go to the repo → **Settings → Pages** → Source: **Deploy from a branch** → `main` / `(root)` → Save.
After a minute it's live at `https://<your-username>.github.io/grind-tracker/`. Send that link to the lads.

## Notes

- **No logins.** Anyone with the link can add or delete entries. That's fine between mates, but don't post the link publicly.
- Profile pics are shrunk to 160×160 and stored in Firestore, so you don't need Firebase Storage or a paid plan.
- Changing a multiplier in `config.js` recalculates everyone's totals, including past entries.
