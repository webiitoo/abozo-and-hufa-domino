# abozo and hufa domino

Classic double-six **Draw dominoes** for 2–4 players, played online in real time.

**Play:** https://webiitoo.github.io/abozo-and-hufa-domino/

Extras for fun: sound effects, animated tiles, confetti when you win, emoji reactions and a room chat.
Sound can be muted with the 🔊 button (top right). Chat is the 💬 button (bottom right).

## How to play with friends

1. Open the game link, type your name and click **Create a room**.
2. Send the room link to your friends (the **Copy** button). They open it, type a name and click **Join**.
3. When everyone is in, the room creator presses **Start game**.

The game runs in the room creator's browser, so **the creator must keep their tab open** until you finish.
Refreshing the page is fine for anyone: the game comes back and friends reconnect automatically.

## Rules (standard Draw game)

- 28 tiles (double-six set), shuffled at the start of each round.
- 2 players get 7 tiles each; 3 or 4 players get 5 tiles each. The rest form the boneyard.
- Round 1: the player holding the highest double opens with it (if nobody has a double, the heaviest tile opens).
  Later rounds: the winner of the previous round leads with any tile.
- Play goes in turn order. A tile must match the number on one open end of the line.
- If you cannot play, you must draw from the boneyard until you can. If the boneyard is empty, you pass.
- The round ends when a player plays their last tile, or when the game is blocked (everyone passes in a row).
  In a blocked game the player with the lowest pip count wins; a tie scores nothing.
- The round winner scores the total pips left in all opponents' hands. First to 100 points wins the game.

## How it works

There is no game server. It is a static site on GitHub Pages:

- `public/engine.js` holds the rules and room state. It runs in the room creator's browser, checks every move
  and turn, and sends each player only their own tiles (opponents are tile counts).
- `public/net.js` connects the players' browsers directly with WebRTC, using the free public
  [PeerJS](https://peerjs.com) service only so the browsers can find each other.
- `public/client.js`, `sound.js`, `style.css` and `index.html` are the game screen.

Because the room creator's browser runs the game, a very determined room creator could peek at other hands
with the browser's developer tools. Some strict networks (school or office Wi-Fi) can block direct connections.

## Files

```
abozo-and-hufa-domino/
├── .github/workflows/pages.yml   # publishes public/ to GitHub Pages on every push
├── public/
│   ├── index.html
│   ├── style.css
│   ├── engine.js                 # rules, turns, scoring, hidden hands
│   ├── net.js                    # browser-to-browser networking (PeerJS)
│   ├── sound.js                  # sound effects (generated in the browser)
│   └── client.js                 # table, chat, reactions, confetti
├── server.js                     # tiny local test server (not needed online)
└── package.json
```

## Run locally

1. Install [Node.js](https://nodejs.org) 18 or newer.
2. In a terminal (PowerShell is fine), go into the project folder:
   ```bash
   cd "C:\Users\ABDELRAHMAN\OneDrive\Documents\domino-game\abozo-and-hufa-domino"
   ```
3. Install and start:
   ```bash
   npm install
   npm start
   ```
4. Open http://localhost:3000. Open the room link in a second tab to test with two players.

## Publishing

Every push to `main` publishes `public/` to GitHub Pages through the workflow in `.github/workflows/pages.yml`.
GitHub Pages must be enabled once in the repository: **Settings → Pages → Source: GitHub Actions**.
