const W7S_DEPLOY_ACTION = "w7s-io/w7s-cloud@v1";

export const minimalDeployWorkflowYaml = `name: Deploy

on:
  push:
    branches:
      - main
  workflow_dispatch:
  schedule:
    - cron: "17 9 * * *"

permissions:
  contents: read
  issues: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        if: github.event_name != 'schedule'

      - uses: w7s-io/w7s-cloud@v1
        with:
          token: \${{ github.token }}
          usage-check-only: \${{ github.event_name == 'schedule' }}`;

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export const deployWorkflowHtml = () =>
  escapeHtml(minimalDeployWorkflowYaml).replaceAll(
    W7S_DEPLOY_ACTION,
    `<strong class="workflow-action">${W7S_DEPLOY_ACTION}</strong>`
  );
