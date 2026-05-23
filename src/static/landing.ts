import { deployWorkflowHtml } from "./deployWorkflow";

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
        background: #f7f7f4;
        color: #171717;
      }
      main {
        width: min(880px, calc(100vw - 40px));
        margin: 0 auto;
        padding: 52px 0;
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
      pre {
        margin: 24px 0 0;
        overflow-x: auto;
        border: 1px solid #d4d4d4;
        border-radius: 8px;
        padding: 16px;
        background: #111815;
        color: #ecf5ee;
      }
      pre code {
        border: 0;
        padding: 0;
        background: transparent;
        color: inherit;
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
        font-size: 14px;
      }
      .workflow-action {
        color: #76f0b8;
        font-weight: 800;
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
        pre {
          border-color: #344038;
          background: #0b0f0d;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>W7S</h1>
      <p>Add this GitHub Actions workflow to any repo and push to <code>main</code>. W7S verifies the deploy with the repo's GitHub token and serves it at <code>&lt;owner&gt;.w7s.cloud/&lt;repo&gt;/</code>.</p>
      <pre><code>${deployWorkflowHtml()}</code></pre>
    </main>
  </body>
</html>`;
