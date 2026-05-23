export const landingHtml = () => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>W7S</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f7f7f4;
        color: #171717;
      }
      main {
        width: min(720px, calc(100vw - 40px));
      }
      h1 {
        margin: 0 0 12px;
        font-size: 44px;
        line-height: 1;
        letter-spacing: 0;
      }
      p {
        margin: 0;
        color: #525252;
        font-size: 18px;
        line-height: 1.6;
      }
      code {
        border: 1px solid #d4d4d4;
        border-radius: 6px;
        padding: 2px 6px;
        background: #fff;
      }
      @media (prefers-color-scheme: dark) {
        body {
          background: #111;
          color: #fafafa;
        }
        p {
          color: #c7c7c7;
        }
        code {
          background: #1b1b1b;
          border-color: #333;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>W7S</h1>
      <p>Minimal deploy core is online. Use <code>POST /api/v1/deploy</code> to publish repo apps to <code>w7s.cloud</code>.</p>
    </main>
  </body>
</html>`;

