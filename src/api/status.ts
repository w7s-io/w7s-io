import type { Context } from "hono";
import type { Env } from "../env";

type ComponentStatus =
  | "operational"
  | "degraded_performance"
  | "partial_outage"
  | "major_outage";

type ComponentDefinition = {
  id: string;
  name: string;
  group: string;
  description: string;
  url?: string;
  expectedStatuses?: number[];
  expectedText?: string;
  expectedJson?: Record<string, string | number | boolean | null>;
  slowAfterMs?: number;
};

type StatusComponent = {
  id: string;
  name: string;
  group: string;
  description: string;
  status: ComponentStatus;
  status_code: number | null;
  response_time_ms: number | null;
  checked_at: string;
  updated_at: string;
  endpoint: string;
  error?: string;
};

const STATUS_COMPONENTS: ComponentDefinition[] = [
  {
    id: "website",
    name: "W7S website",
    group: "Public delivery",
    description: "Landing page and public status surface on www.w7s.io.",
    url: "https://www.w7s.io/",
    expectedStatuses: [200]
  },
  {
    id: "docs",
    name: "Documentation",
    group: "Public delivery",
    description: "Docusaurus documentation served from www.w7s.io/docs.",
    url: "https://www.w7s.io/docs/",
    expectedStatuses: [200],
    expectedText: "Deploy From GitHub"
  },
  {
    id: "live-routing",
    name: "W7S Live routing",
    group: "Public delivery",
    description: "Public app routing on owner.w7s.cloud/repo paths.",
    url: "https://w7s-io.w7s.cloud/docs/",
    expectedStatuses: [200]
  },
  {
    id: "custom-domains",
    name: "Custom domains",
    group: "Public delivery",
    description: "Custom domain routing for W7S deployments.",
    url: "https://fullstack-example.w7s.io/",
    expectedStatuses: [200]
  },
  {
    id: "cloud-api",
    name: "W7S Cloud API",
    group: "Control plane",
    description: "Deploy intake, health checks, and platform API routing."
  },
  {
    id: "usage-observability",
    name: "Usage and observability APIs",
    group: "Control plane",
    description: "Usage limits, analytics, and log APIs with auth enforcement.",
    url: "https://w7s.cloud/api/v1/limits/w7s-io/docs",
    expectedStatuses: [401],
    expectedText: "Missing bearer token"
  },
  {
    id: "native-backends",
    name: "Native backend runtime",
    group: "Runtime features",
    description: "JavaScript and TypeScript backend request dispatch.",
    url: "https://w7s-io.w7s.cloud/example-durable-counter/value",
    expectedStatuses: [200],
    expectedText: "example-durable-counter"
  },
  {
    id: "stateful-objects",
    name: "Stateful objects",
    group: "Runtime features",
    description: "Persistent stateful coordination and storage bindings.",
    url: "https://w7s-io.w7s.cloud/example-durable-counter/value",
    expectedStatuses: [200],
    expectedText: "Counter"
  },
  {
    id: "backend-rpc",
    name: "Backend RPC",
    group: "Runtime features",
    description: "Internal backend-to-backend service calls.",
    url: "https://w7s-io.w7s.cloud/example-rpc-client/datetime",
    expectedStatuses: [200],
    expectedJson: { status: "ok" }
  },
  {
    id: "queues",
    name: "Background queues",
    group: "Runtime features",
    description: "Managed queue delivery to JavaScript and TypeScript backends.",
    url: "https://w7s-io.w7s.cloud/example-queue-worker/last",
    expectedStatuses: [200],
    expectedJson: { status: "ok" }
  },
  {
    id: "schedules",
    name: "Cron schedules",
    group: "Runtime features",
    description: "Scheduled background dispatch to deployed backends.",
    url: "https://w7s-io.w7s.cloud/example-schedules/last",
    expectedStatuses: [200],
    expectedJson: { status: "ok" }
  },
  {
    id: "workflows",
    name: "Durable workflows",
    group: "Runtime features",
    description: "Workflow instance dispatch and status retrieval.",
    url: "https://w7s-io.w7s.cloud/example-workflows/last",
    expectedStatuses: [200],
    expectedText: "example-workflows"
  }
];

const statusHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8"
};

const endpointLabel = (url?: string) => {
  if (!url) return "w7s.cloud";
  const endpoint = new URL(url);
  return endpoint.host;
};

const parseJson = (text: string) => {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const matchesExpectedJson = (
  text: string,
  expectedJson?: ComponentDefinition["expectedJson"]
) => {
  if (!expectedJson) return true;

  const body = parseJson(text);
  if (!body) return false;

  return Object.entries(expectedJson).every(([key, value]) => body[key] === value);
};

const componentStatusFor = (params: {
  definition: ComponentDefinition;
  response: Response;
  text: string;
  responseTimeMs: number;
}): ComponentStatus => {
  const statusMatches = (params.definition.expectedStatuses ?? [200]).includes(
    params.response.status
  );
  const textMatches = params.definition.expectedText
    ? params.text.includes(params.definition.expectedText)
    : true;
  const jsonMatches = matchesExpectedJson(params.text, params.definition.expectedJson);

  if (!statusMatches || !textMatches || !jsonMatches) {
    return params.response.status >= 500 ? "major_outage" : "partial_outage";
  }

  if (params.responseTimeMs > (params.definition.slowAfterMs ?? 7500)) {
    return "degraded_performance";
  }

  return "operational";
};

const selfComponent = (definition: ComponentDefinition, checkedAt: string): StatusComponent => ({
  id: definition.id,
  name: definition.name,
  group: definition.group,
  description: definition.description,
  status: "operational",
  status_code: 200,
  response_time_ms: 0,
  checked_at: checkedAt,
  updated_at: checkedAt,
  endpoint: endpointLabel(definition.url)
});

const checkComponent = async (
  definition: ComponentDefinition
): Promise<StatusComponent> => {
  const checkedAt = new Date().toISOString();
  if (!definition.url) return selfComponent(definition, checkedAt);

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(definition.url, {
      signal: controller.signal
    });
    const text = await response.text();
    const responseTimeMs = Date.now() - startedAt;

    return {
      id: definition.id,
      name: definition.name,
      group: definition.group,
      description: definition.description,
      status: componentStatusFor({ definition, response, text, responseTimeMs }),
      status_code: response.status,
      response_time_ms: responseTimeMs,
      checked_at: checkedAt,
      updated_at: checkedAt,
      endpoint: endpointLabel(definition.url)
    };
  } catch (error) {
    return {
      id: definition.id,
      name: definition.name,
      group: definition.group,
      description: definition.description,
      status: "major_outage",
      status_code: null,
      response_time_ms: null,
      checked_at: checkedAt,
      updated_at: checkedAt,
      endpoint: endpointLabel(definition.url),
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
};

const overallStatus = (components: StatusComponent[]) => {
  if (components.some((component) => component.status === "major_outage")) {
    return {
      indicator: "major",
      description: "Active outage detected"
    };
  }

  if (components.some((component) => component.status === "partial_outage")) {
    return {
      indicator: "minor",
      description: "Partial outage detected"
    };
  }

  if (components.some((component) => component.status === "degraded_performance")) {
    return {
      indicator: "minor",
      description: "Some systems degraded"
    };
  }

  return {
    indicator: "none",
    description: "All systems operational"
  };
};

const activeIncidents = (components: StatusComponent[], checkedAt: string) => {
  const impacted = components.filter((component) => component.status !== "operational");
  if (!impacted.length) return [];

  return [
    {
      id: `live-check-${checkedAt}`,
      name: "W7S component health check failing",
      status: "investigating",
      impact: impacted.some((component) => component.status === "major_outage")
        ? "major"
        : "minor",
      created_at: checkedAt,
      updated_at: checkedAt,
      components: impacted.map((component) => component.id),
      component_names: impacted.map((component) => component.name),
      incident_updates: [
        {
          status: "investigating",
          body: "One or more public W7S component checks is not passing from the status endpoint.",
          created_at: checkedAt
        }
      ]
    }
  ];
};

const statusSummary = async () => {
  const checkedAt = new Date().toISOString();
  const components = await Promise.all(STATUS_COMPONENTS.map(checkComponent));

  return {
    page: {
      id: "w7s",
      name: "W7S",
      url: "https://www.w7s.io/status",
      time_zone: "Etc/UTC",
      updated_at: checkedAt
    },
    status: overallStatus(components),
    components,
    incidents: activeIncidents(components, checkedAt),
    scheduled_maintenances: []
  };
};

export const handleStatusOptions = () =>
  new Response(null, {
    status: 204,
    headers: statusHeaders
  });

export const handleStatusGet = async (_c: Context<{ Bindings: Env }>) =>
  new Response(JSON.stringify(await statusSummary()), {
    status: 200,
    headers: statusHeaders
  });
