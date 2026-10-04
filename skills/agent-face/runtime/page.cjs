'use strict';
// The face page's markup, served by main.cjs as /app/face.html. Styles and
// behaviour are in face.css and face.js.

module.exports = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src 'self' blob:; connect-src 'self'; script-src 'self'; style-src 'self'"
    />
    <title>Agent Face</title>
    <link rel="stylesheet" href="face.css" />
  </head>
  <body>
    <div id="stage">
      <img id="face" alt="" draggable="false" />
      <!-- While talking: one stacked image per mouth frame, shown one at a time. -->
      <div id="mouth"></div>
      <div id="error" hidden></div>
      <button id="mute" type="button" title="Mute voice"></button>
      <button id="close" type="button" title="Close face">×</button>
      <div id="footer">
        <div id="label"></div>
        <div id="caption" hidden></div>
      </div>
    </div>
    <script src="lipsync.js"></script>
    <script src="face.js"></script>
  </body>
</html>
`;
