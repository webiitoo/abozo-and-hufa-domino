# abozo and hufa domino

Classic double-six **Draw dominoes** for 2–4 players, played online in real time.

Extras for fun: sound effects, animated tiles, confetti when you win, emoji reactions and a room chat.
Sound can be muted with the 🔊 button (top right). Chat is the 💬 button (bottom right).

## Files

```
abozo-and-hufa-domino/
├── package.json        # dependencies and start script
├── server.js           # Express + Socket.io server, all game logic
├── .gitignore
└── public/
    ├── index.html      # page layout
    ├── style.css       # design and animations
    ├── sound.js        # sound effects (generated in the browser, no audio files)
    └── client.js       # browser code: table, chat, reactions, confetti
```

## Rules (standard Draw game)

- 28 tiles (double-six set), shuffled by the server.
- 2 players get 7 tiles each; 3 or 4 players get 5 tiles each. The rest form the boneyard.
- Round 1: the player holding the highest double opens with it (if nobody has a double, the heaviest tile opens).
  Later rounds: the winner of the previous round leads with any tile.
- Play goes in turn order. A tile must match the number on one open end of the line.
- If you cannot play, you must draw from the boneyard until you can. If the boneyard is empty, you pass.
- The round ends when a player plays their last tile ("domino"), or when the game is blocked (everyone passes in a row).
  In a blocked game the player with the lowest pip count wins; a tie scores nothing.
- The round winner scores the total pips left in all opponents' hands. First to 100 points wins the game.

The server shuffles, deals, validates every move and enforces turns. Each player only ever receives
their own tiles; opponents are shown as tile counts. Hands are revealed only after a round ends, for scoring.

## Run locally

1. Install [Node.js](https://nodejs.org) 18 or newer.
2. In a terminal (PowerShell is fine), go into the project folder:
   ```bash
   cd "C:\Users\ABDELRAHMAN\OneDrive\Documents\domino-game\abozo-and-hufa-domino"
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start the server:
   ```bash
   npm start
   ```
5. Open http://localhost:3000, type a name and click **Create room**.
6. To test alone, open the share link in a second browser tab (each tab is a separate player), join, then click **Start game** in the first tab.

Friends on the same Wi-Fi can join using your computer's local IP, for example `http://192.168.1.20:3000/?room=ABCDE`
(find your IP with `ipconfig` on Windows). For play over the internet, deploy it as below.

## Deploy for free on Render

1. Create a free account at https://github.com and a new repository, then upload all the project files
   (everything except `node_modules`). Or from the project folder:
   ```bash
   git init
   git add .
   git commit -m "abozo and hufa domino"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/abozo-and-hufa-domino.git
   git push -u origin main
   ```
2. Create a free account at https://render.com and sign in with GitHub.
3. Click **New +** → **Web Service** and select your repository.
4. Fill in:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Click **Create Web Service**. After a few minutes you get a URL such as `https://abozo-and-hufa-domino.onrender.com`.
6. Open the URL, create a room, and send the share link to your friends.

Notes for the free tier:
- The server sleeps after about 15 minutes without visitors; the first visit after that takes up to a minute to wake it.
- Rooms are kept in memory, so a restart or sleep clears them. Just create a new room.
- Render sets the `PORT` variable itself; `server.js` already reads it.

About Glitch: Glitch stopped hosting projects in July 2025, so it can no longer be used. Other free options that
work the same way (Node web service with WebSockets) are Railway and Koyeb: use `npm install` to build and `npm start` to run.

## Notes

- A refresh or short connection drop keeps your seat; the page rejoins automatically.
- If a player leaves in the middle of a round, the game waits for them on their turn.
- Rooms with nobody connected are removed after 10 minutes.
