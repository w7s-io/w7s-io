import { minimalDeployWorkflowYaml } from "./deployWorkflow";

const EXAMPLE_REPO_SLUG = "example-fullstack-ts";
const EXAMPLE_TEMPLATE_URL = "https://github.com/w7s-io/example-fullstack-ts/";

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export const orgDeployHelpHtml = (params: { host: string; orgSlug: string }) => {
  const host = escapeHtml(params.host);
  const orgSlug = escapeHtml(params.orgSlug);
  const rootUrl = `https://${host}/`;
  const exampleUrl = `https://${host}/${EXAMPLE_REPO_SLUG}/`;
  const exampleRepoPath = `${orgSlug}/${EXAMPLE_REPO_SLUG}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Deploy to W7S</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f6f8f5;
        color: #18201b;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        min-height: 100vh;
        background:
          linear-gradient(180deg, rgba(31, 122, 90, 0.08), transparent 260px),
          #f6f8f5;
      }
      main {
        width: min(920px, calc(100vw - 40px));
        margin: 0 auto;
        padding: 52px 0;
      }
      header {
        margin-bottom: 28px;
      }
      .eyebrow {
        margin: 0 0 12px;
        color: #1f7a5a;
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      h1 {
        margin: 0;
        max-width: 720px;
        font-size: clamp(34px, 8vw, 58px);
        line-height: 1.02;
        letter-spacing: 0;
      }
      h2 {
        margin: 0 0 12px;
        font-size: 20px;
        line-height: 1.2;
        letter-spacing: 0;
      }
      p, li {
        color: #46534b;
        font-size: 16px;
        line-height: 1.6;
      }
      p {
        margin: 0;
      }
      a {
        color: #0f6f55;
        font-weight: 650;
        text-decoration-thickness: 1px;
        text-underline-offset: 3px;
      }
      code {
        border: 1px solid #d9dfd8;
        border-radius: 6px;
        padding: 2px 6px;
        background: #ffffff;
        color: #1d2822;
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
        font-size: 0.92em;
      }
      pre {
        margin: 14px 0 0;
        overflow-x: auto;
        border: 1px solid #d9dfd8;
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
        font-size: 14px;
      }
      .intro {
        max-width: 740px;
        margin-top: 18px;
      }
      .grid {
        display: grid;
        grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
        gap: 18px;
        align-items: start;
      }
      section {
        border: 1px solid #dfe5dd;
        border-radius: 8px;
        padding: 22px;
        background: rgba(255, 255, 255, 0.72);
      }
      ol {
        margin: 0;
        padding-left: 20px;
      }
      li + li {
        margin-top: 8px;
      }
      .stack {
        display: grid;
        gap: 18px;
      }
      .url {
        display: block;
        margin-top: 14px;
        width: fit-content;
      }
      @media (max-width: 760px) {
        main {
          width: min(100% - 28px, 920px);
          padding: 34px 0;
        }
        .grid {
          grid-template-columns: 1fr;
        }
        section {
          padding: 18px;
        }
      }
      @media (prefers-color-scheme: dark) {
        :root {
          background: #101411;
          color: #f3f6f3;
        }
        body {
          background:
            linear-gradient(180deg, rgba(46, 172, 124, 0.12), transparent 260px),
            #101411;
        }
        .eyebrow, a {
          color: #73d7aa;
        }
        p, li {
          color: #c1cbc4;
        }
        section {
          border-color: #2a342d;
          background: rgba(22, 28, 24, 0.78);
        }
        code {
          border-color: #344038;
          background: #161c18;
          color: #eff7f1;
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
      <header>
        <p class="eyebrow">W7S</p>
        <h1>This space is ready for an app.</h1>
        <p class="intro">Nothing is deployed at <code>${rootUrl}</code> yet. Deploy a GitHub repo and W7S will serve it at <a href="${exampleUrl}">${exampleUrl}</a>.</p>
      </header>

      <div class="grid">
        <div class="stack">
          <section>
            <h2>Fastest path</h2>
            <ol>
              <li>Clone <a href="${EXAMPLE_TEMPLATE_URL}">w7s-io/example-fullstack-ts</a> into <code>github.com/${exampleRepoPath}</code>.</li>
              <li>Enable GitHub Actions for that repo.</li>
              <li>Push to <code>main</code>. The app should deploy in less than a minute.</li>
            </ol>
            <a class="url" href="${exampleUrl}">${exampleUrl}</a>
          </section>

          <section>
            <h2>Custom domain</h2>
            <p>Add a root <code>CNAME</code> file with one hostname, such as <code>app.example.com</code>. After deploy, create a proxied DNS <code>CNAME</code> for that host pointing to <code>w7s.cloud</code>. To lock the domain, add TXT <code>_w7s.example.com</code> with your GitHub owner or <code>owner/repo</code>.</p>
          </section>
        </div>

        <section>
          <h2>GitHub Action</h2>
          <p>Add this workflow as <code>.github/workflows/deploy.yml</code>. That is all W7S needs to verify deploy access with the repo's GitHub token.</p>
          <pre><code>${escapeHtml(minimalDeployWorkflowYaml)}</code></pre>
        </section>
      </div>
    </main>
  </body>
</html>`;
};
