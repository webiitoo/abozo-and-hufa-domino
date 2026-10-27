'use strict';

// Local test server only. The game itself runs in the browser (see public/engine.js
// and public/net.js), so online it is hosted as static files on GitHub Pages.
const express = require('express');
const path = require('path');

const PORT = process.env.PORT || 3000;
const app = express();

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`abozo and hufa domino running on http://localhost:${PORT}`);
});
